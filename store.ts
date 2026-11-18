// The forge's state and domain logic: repositories (with their own git object
// stores and refs), labels, issues, pull requests and comments, all in memory.
// Everything observable is deterministic: ids come from counters and every
// timestamp from a logical clock (a fixed epoch plus a per-operation tick), so
// two runs of the same request sequence produce byte-identical state.

import {
  EMPTY_TREE_OID,
  buildCommit,
  buildTreeFromMap,
  collectReachable,
  diffMaps,
  flattenTree,
  isAncestor,
  isOid,
  lineDelta,
  mergeBase,
  mergeMaps,
  parseCommit,
  parseTree,
  peelToCommit,
  putObject,
  type FlatTree,
  type GitObject,
  type ObjectStore,
} from './gitobj.ts';

/** The login the trial's token names (wire.ts's seeded scenario viewer). */
export const LOGIN = 'adaiversen';
/** The viewer's numeric user id in the seeded scenario. */
export const VIEWER_ID = 1000;
/** The default branch every repository is born with. */
export const DEFAULT_BRANCH = 'main';

/** The logical clock's epoch: 2025-01-01T00:00:00Z. */
const EPOCH_SEC = 1_735_689_600;

/** A domain failure with the HTTP status the surface should answer. */
export class ForgeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface LabelState {
  name: string;
  color: string;
}

export interface CommentState {
  id: number;
  body: string;
  createdAt: string;
}

export interface IssueState {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentState[];
  createdAt: string;
  updatedAt: string;
}

export interface PullState {
  id: number;
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RepoState {
  id: number;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  objects: ObjectStore;
  refs: Map<string, string>;
  labels: Map<string, LabelState>;
  issues: Map<number, IssueState>;
  pulls: Map<number, PullState>;
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
}

/** The whole forge: every repository the token's login owns, plus the counters. */
export class Forge {
  readonly repos = new Map<string, RepoState>();
  private repoSeq = 0;
  private issueSeq = 0;
  private commentSeq = 0;
  private pullSeq = 0;
  private clockSeq = 0;
  requestSeq = 0;

  /** The next logical timestamp, in seconds (never the wall clock). */
  tickSec(): number {
    const value = EPOCH_SEC + this.clockSeq;
    this.clockSeq += 1;
    return value;
  }

  /** The next logical timestamp as an ISO string. */
  tickIso(): string {
    return new Date(this.tickSec() * 1000).toISOString();
  }

  /** A deterministic per-request id (headers only; never scored). */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `forge-${this.requestSeq.toString(36)}`;
  }

  // ------------------------------------------------------------ repositories

  createRepo(name: string, isPrivate: boolean, description: string): RepoState {
    if (this.repos.has(name)) {
      throw new ForgeError(422, 'Repository creation failed.');
    }
    this.repoSeq += 1;
    const now = this.tickIso();
    const repo: RepoState = {
      id: this.repoSeq,
      name,
      isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.repos.set(name, repo);
    return repo;
  }

  /** A repository by owner/name; any owner but the token's login is a 404. */
  repo(owner: string, name: string): RepoState {
    if (owner !== LOGIN) throw new ForgeError(404, 'Not Found');
    const repo = this.repos.get(name);
    if (repo === undefined) throw new ForgeError(404, 'Not Found');
    return repo;
  }

  repoOrNull(owner: string, name: string): RepoState | null {
    if (owner !== LOGIN) return null;
    return this.repos.get(name) ?? null;
  }

  deleteRepo(owner: string, name: string): void {
    this.repo(owner, name);
    this.repos.delete(name);
  }

  /** The REST repository object. */
  repoJson(repo: RepoState): Record<string, unknown> {
    return {
      id: repo.id,
      name: repo.name,
      full_name: `${LOGIN}/${repo.name}`,
      owner: { login: LOGIN, id: VIEWER_ID, type: 'User' },
      private: repo.isPrivate,
      description: repo.description,
      default_branch: repo.defaultBranch,
      created_at: repo.createdAt,
      updated_at: repo.updatedAt,
      html_url: `/${LOGIN}/${repo.name}`,
      url: `/api/v3/repos/${LOGIN}/${repo.name}`,
    };
  }

  // ------------------------------------------------------------ refs and trees

  /** The full ref name of a branch. */
  branchRef(branch: string): string {
    return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
  }

  /** The tip commit oid of a branch, or null when the branch does not exist. */
  branchTip(repo: RepoState, branch: string): string | null {
    return repo.refs.get(this.branchRef(branch)) ?? null;
  }

  /** Resolve a ref-ish (branch name, full ref, or commit id) to a commit oid. */
  resolveCommit(repo: RepoState, ref: string): string | null {
    const direct = repo.refs.get(this.branchRef(ref)) ?? repo.refs.get(ref);
    if (direct !== undefined) return peelToCommit(repo.objects, direct);
    if (isOid(ref)) return peelToCommit(repo.objects, ref);
    return null;
  }

  /** The flattened tree at a commit (the empty tree for an unborn/missing commit). */
  treeMapAt(repo: RepoState, commitOid: string | null): FlatTree {
    if (commitOid === null) return new Map();
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return new Map();
    return flattenTree(repo.objects, parseCommit(object.data).tree);
  }

  /** The forge's commit identity line for a logical timestamp. */
  private identityLine(sec: number): string {
    return `${LOGIN} <${LOGIN}@example.invalid> ${sec} +0000`;
  }

  /**
   * Commit a set of path changes (Buffer content, or null to delete) onto a
   * branch, creating the branch from the default branch's tip (or unborn) when
   * it does not exist yet. Answers the new commit's id.
   */
  commitChanges(repo: RepoState, branch: string, changes: ReadonlyMap<string, Buffer | null>, message: string): string {
    const ref = this.branchRef(branch);
    let parent = repo.refs.get(ref) ?? null;
    if (parent === null && ref !== this.branchRef(repo.defaultBranch)) {
      parent = repo.refs.get(this.branchRef(repo.defaultBranch)) ?? null;
    }
    const parentCommit = parent === null ? null : peelToCommit(repo.objects, parent);
    const files = this.treeMapAt(repo, parentCommit);
    for (const [path, content] of changes) {
      if (content === null) files.delete(path);
      else files.set(path, { mode: '100644', oid: putObject(repo.objects, 'blob', content) });
    }
    const tree = files.size === 0 ? this.emptyTree(repo) : buildTreeFromMap(repo.objects, files);
    const sec = this.tickSec();
    const line = this.identityLine(sec);
    const commit = putObject(
      repo.objects,
      'commit',
      buildCommit({
        tree,
        parents: parentCommit === null ? [] : [parentCommit],
        message: message.endsWith('\n') ? message : `${message}\n`,
        authorLine: line,
        committerLine: line,
      }),
    );
    repo.refs.set(ref, commit);
    repo.updatedAt = this.tickIso();
    return commit;
  }

  private emptyTree(repo: RepoState): string {
    if (!repo.objects.has(EMPTY_TREE_OID)) repo.objects.set(EMPTY_TREE_OID, { type: 'tree', data: Buffer.alloc(0) });
    return EMPTY_TREE_OID;
  }

  /** Create or move a ref through the Git Data API's rules (the target must exist). */
  setRef(repo: RepoState, ref: string, oid: string): void {
    if (!repo.objects.has(oid)) throw new ForgeError(422, 'Object does not exist');
    repo.refs.set(ref, oid);
  }

  // ------------------------------------------------------------ contents API

  /** One contents read: a file, a directory listing, or null when absent. */
  contentsAt(
    repo: RepoState,
    path: string,
    ref: string | undefined,
  ): { kind: 'file'; sha: string; size: number; data: Buffer } | { kind: 'dir'; entries: Array<{ type: string; name: string; path: string; sha: string }> } | null {
    const commit = ref === undefined ? this.branchTip(repo, repo.defaultBranch) : this.resolveCommit(repo, ref);
    if (commit === null) return null;
    const files = this.treeMapAt(repo, commit);
    const clean = path.replace(/^\/+|\/+$/g, '');
    if (clean !== '') {
      const file = files.get(clean);
      if (file !== undefined) {
        const blob = repo.objects.get(file.oid);
        if (blob === undefined) return null;
        return { kind: 'file', sha: file.oid, size: blob.data.length, data: blob.data };
      }
    }
    const prefix = clean === '' ? '' : `${clean}/`;
    const entries = new Map<string, { type: string; name: string; path: string; sha: string }>();
    for (const [filePath, entry] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.set(rest, { type: 'file', name: rest, path: filePath, sha: entry.oid });
      } else {
        const dirName = rest.slice(0, slash);
        if (!entries.has(dirName)) {
          entries.set(dirName, { type: 'dir', name: dirName, path: `${prefix}${dirName}`, sha: this.dirSha(repo, commit, `${prefix}${dirName}`) });
        }
      }
    }
    if (clean === '' || entries.size > 0) return { kind: 'dir', entries: [...entries.values()] };
    return null;
  }

  /** The tree id of a directory inside a commit (for directory listings' sha). */
  private dirSha(repo: RepoState, commitOid: string, dirPath: string): string {
    let treeOid = parseCommit(repo.objects.get(commitOid)!.data).tree;
    for (const segment of dirPath.split('/')) {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return EMPTY_TREE_OID;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
      if (entry === undefined) return EMPTY_TREE_OID;
      treeOid = entry.oid;
    }
    return treeOid;
  }

  // ------------------------------------------------------------ issues

  createIssue(repo: RepoState, input: { title: string; body: string; labels?: readonly string[] }): IssueState {
    const labels = input.labels ?? [];
    for (const name of labels) {
      if (!repo.labels.has(name)) throw new ForgeError(422, `Label '${name}' does not exist`);
    }
    this.issueSeq += 1;
    const now = this.tickIso();
    const issue: IssueState = {
      id: this.issueSeq,
      number: repo.nextNumber,
      title: input.title,
      body: input.body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: now,
      updatedAt: now,
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  issue(repo: RepoState, number: number): IssueState {
    const issue = repo.issues.get(number);
    if (issue === undefined) throw new ForgeError(404, 'Not Found');
    return issue;
  }

  addComment(repo: RepoState, issue: IssueState, body: string): CommentState {
    this.commentSeq += 1;
    const comment: CommentState = { id: this.commentSeq, body, createdAt: this.tickIso() };
    issue.comments.push(comment);
    issue.updatedAt = this.tickIso();
    return comment;
  }

  labelJson(label: LabelState): Record<string, unknown> {
    return { name: label.name, color: label.color, default: false };
  }

  issueJson(repo: RepoState, issue: IssueState): Record<string, unknown> {
    void repo;
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
      user: { login: LOGIN, id: VIEWER_ID },
      comments: issue.comments.length,
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
    };
  }

  commentJson(comment: CommentState): Record<string, unknown> {
    return {
      id: comment.id,
      body: comment.body,
      user: { login: LOGIN, id: VIEWER_ID },
      created_at: comment.createdAt,
      updated_at: comment.createdAt,
    };
  }

  // ------------------------------------------------------------ pull requests

  createPull(
    repo: RepoState,
    input: { title: string; body: string; head: string; base: string },
  ): PullState {
    const head = stripOwnerPrefix(input.head);
    const base = stripOwnerPrefix(input.base);
    const headTip = this.branchTip(repo, head);
    if (headTip === null) throw new ForgeError(422, `Head ref '${head}' does not exist`);
    const baseTip = this.branchTip(repo, base);
    if (baseTip === null) throw new ForgeError(422, `Base ref '${base}' does not exist`);
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
        throw new ForgeError(422, `A pull request already exists for ${LOGIN}:${head} -> ${base}`);
      }
    }
    this.pullSeq += 1;
    const now = this.tickIso();
    const pull: PullState = {
      id: this.pullSeq,
      number: repo.nextNumber,
      title: input.title,
      body: input.body,
      headRef: head,
      baseRef: base,
      headSha: headTip,
      baseSha: baseTip,
      state: 'open',
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  pull(repo: RepoState, number: number): PullState {
    const pull = repo.pulls.get(number);
    if (pull === undefined) throw new ForgeError(404, 'Not Found');
    return pull;
  }

  /** The changed files of a pull request: merge-base tree versus head tree. */
  pullChanges(repo: RepoState, pull: PullState): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const base = mergeBase(repo.objects, baseTip, headTip) ?? baseTip;
    const baseFiles = this.treeMapAt(repo, base);
    const headFiles = this.treeMapAt(repo, headTip);
    return diffMaps(baseFiles, headFiles).map((change) => {
      const oldData = change.oldOid === null ? null : (repo.objects.get(change.oldOid)?.data ?? null);
      const newData = change.newOid === null ? null : (repo.objects.get(change.newOid)?.data ?? null);
      const delta = lineDelta(oldData, newData);
      return {
        filename: change.path,
        status: change.status === 'modified' ? 'modified' : change.status,
        additions: delta.additions,
        deletions: delta.deletions,
        changes: delta.additions + delta.deletions,
      };
    });
  }

  /** Whether merging the pull request's head into its base conflicts. */
  pullConflicts(repo: RepoState, pull: PullState): boolean {
    return this.tryMergeTrees(repo, pull) === null;
  }

  /** The merged tree for a pull request, or null on conflict. */
  private tryMergeTrees(repo: RepoState, pull: PullState): FlatTree | null {
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseTip = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const base = mergeBase(repo.objects, baseTip, headTip);
    if (base === null) return null;
    const { merged } = mergeMaps(this.treeMapAt(repo, base), this.treeMapAt(repo, baseTip), this.treeMapAt(repo, headTip));
    return merged;
  }

  /**
   * Squash-merge a pull request: one commit with the head's merged tree on top
   * of the base branch's tip. 404 unknown (the caller checks), 405 on conflict
   * or when already merged.
   */
  mergePull(repo: RepoState, pull: PullState): { sha: string } {
    if (pull.merged) throw new ForgeError(405, 'Pull Request is not mergeable');
    const mergedTree = this.tryMergeTrees(repo, pull);
    if (mergedTree === null) throw new ForgeError(405, 'Pull Request is not mergeable');
    const baseRef = this.branchRef(pull.baseRef);
    const baseTip = repo.refs.get(baseRef);
    if (baseTip === undefined) throw new ForgeError(405, 'Pull Request is not mergeable');
    const tree = mergedTree.size === 0 ? this.emptyTree(repo) : buildTreeFromMap(repo.objects, mergedTree);
    const sec = this.tickSec();
    const line = this.identityLine(sec);
    const message = `${pull.title} (#${pull.number})\n`;
    const commit = putObject(
      repo.objects,
      'commit',
      buildCommit({ tree, parents: [baseTip], message, authorLine: line, committerLine: line }),
    );
    repo.refs.set(baseRef, commit);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = commit;
    pull.mergedAt = this.tickIso();
    pull.updatedAt = pull.mergedAt;
    repo.updatedAt = pull.mergedAt;
    return { sha: commit };
  }

  pullJson(repo: RepoState, pull: PullState): Record<string, unknown> {
    const headSha = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseSha = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    return {
      id: pull.id,
      number: pull.number,
      state: pull.state,
      title: pull.title,
      body: pull.body,
      head: { ref: pull.headRef, sha: headSha, label: `${LOGIN}:${pull.headRef}` },
      base: { ref: pull.baseRef, sha: baseSha, label: `${LOGIN}:${pull.baseRef}` },
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      user: { login: LOGIN, id: VIEWER_ID },
      created_at: pull.createdAt,
      updated_at: pull.updatedAt,
    };
  }

  // ------------------------------------------------------------ reachability for the git surface

  /** Objects of `repo` reachable from the given ref tips (for advertisements' closures). */
  reachable(repo: RepoState, roots: Iterable<string>): Set<string> {
    return collectReachable(repo.objects, roots, { allowMissing: true });
  }

  isAncestor(repo: RepoState, ancestor: string, descendant: string): boolean {
    return isAncestor(repo.objects, ancestor, descendant);
  }
}

/** `owner:branch` (a cross-fork head) down to the branch name this forge hosts. */
function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}

export type { GitObject };
