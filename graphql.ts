// A small GraphQL engine for exactly the documents gh and github-mcp-server
// send: operations with variables, aliases, inline fragments, enum/list/object
// argument values, introspection for the types the checks probe, the issue /
// pull-request reads, cursor pagination, and the five mutations. It executes
// against the same Forge store as REST, so ids and numbers agree across
// surfaces.

import { ForgeError, LOGIN, type Forge, type IssueState, type PullState, type RepoState } from './store.ts';

// ---------------------------------------------------------------- global ids

/** An opaque, stable global id for a forge object (never the plain number). */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

/** Decode a global id back to its kind and parts; null when it is not one of ours. */
export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2 || parts[0] === '') return null;
    return { kind: parts[0]!, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

export const repoGlobalId = (repo: RepoState): string => globalId('Repository', repo.id);
export const issueGlobalId = (repo: RepoState, issue: IssueState): string => globalId('Issue', repo.id, issue.number);
export const pullGlobalId = (repo: RepoState, pull: PullState): string => globalId('PullRequest', repo.id, pull.number);
export const commentGlobalId = (repo: RepoState, issue: IssueState, commentId: number): string =>
  globalId('IssueComment', repo.id, issue.number, commentId);

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(c)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const escaped = source[j + 1]!;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j]!)) j += 1;
      const text = source.slice(i, j);
      tokens.push(text.includes('.') ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number.parseInt(text, 10) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- parser

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: Map<string, ValueNode>;
  selection: SelectionNode[] | null;
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

export interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

interface FragmentNode {
  typeCondition: string;
  selection: SelectionNode[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}'`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({
          type: keyword === 'mutation' ? 'mutation' : 'query',
          name,
          selection: this.parseSelectionSet(),
        });
      } else if (keyword === 'fragment') {
        const fragName = this.expectName();
        const onKeyword = this.expectName();
        if (onKeyword !== 'on') throw new Error('expected `on` in a fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected definition ${JSON.stringify(keyword)}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    for (;;) {
      if (this.skipPunct(')')) return;
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseArguments(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    this.expectPunct('(');
    for (;;) {
      if (this.skipPunct(')')) return args;
      const name = this.expectName();
      this.expectPunct(':');
      args.set(name, this.parseValue());
    }
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      for (;;) {
        if (this.peek().kind === 'punct' && this.peek().value === ']') {
          this.next();
          return { kind: 'list', items };
        }
        items.push(this.parseValue());
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      for (;;) {
        if (this.peek().kind === 'punct' && this.peek().value === '}') {
          this.next();
          return { kind: 'object', fields };
        }
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      if (token.kind === 'spread') {
        this.next();
        const next = this.peek();
        if (next.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.expectName() });
        }
        continue;
      }
      let name = this.expectName();
      let alias: string | null = null;
      if (this.skipPunct(':')) {
        alias = name;
        name = this.expectName();
      }
      const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : new Map<string, ValueNode>();
      this.skipDirectives();
      const selection =
        this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', field: { alias, name, args, selection } });
    }
  }
}

// ---------------------------------------------------------------- values

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, node] of field.args) out[name] = valueOf(node, variables);
  return out;
}

// ---------------------------------------------------------------- schema surface

/** The fields each type lists for introspection (and the unknown-field check). */
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url',
  ],
  RepositoryOwner: ['login', 'id'],
  Ref: ['name', 'target'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'labels', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url', 'repository'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'mergedAt', 'mergeCommit', 'createdAt', 'updatedAt', 'author', 'url',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Commit: ['oid', 'id'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'url'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'type', 'args', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  __TypeKind: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'],
};

const OBJECT_TYPES = new Set(Object.keys(TYPE_FIELDS));

// ---------------------------------------------------------------- executor

/** A typed value in the result tree. */
interface GqlObject {
  __type: string;
  data: Record<string, unknown>;
}

function gqlObj(type: string, data: Record<string, unknown>): GqlObject {
  return { __type: type, data };
}

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string; path: Array<string | number> }>;
}

class GqlFieldError extends Error {}

function isGqlObject(value: unknown): value is GqlObject {
  return typeof value === 'object' && value !== null && '__type' in value && 'data' in value;
}

/** Resolve one field on one object; returns a scalar, a GqlObject, an array, or null. */
function resolveField(ctx: ExecContext, type: string, source: GqlObject, field: FieldNode): unknown {
  const forge = ctx.forge;
  const data = source.data;
  const args = argsOf(field, ctx.variables);
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

  switch (type) {
    case 'Query': {
      if (field.name === 'viewer') return gqlObj('User', { login: LOGIN });
      if (field.name === 'repository') {
        const repo = forge.repoOrNull(str(args.owner), str(args.name));
        return repo === null ? null : repoObject(repo);
      }
      if (field.name === 'node') return nodeById(ctx, str(args.id));
      if (field.name === '__type') return typeObject(str(args.name));
      if (field.name === '__schema') return null;
      break;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(forge, str(input.repositoryId));
        const issue = forge.createIssue(repo, { title: str(input.title), body: str(input.body) });
        return gqlObj('CreateIssuePayload', { issue: issueObject(repo, issue) });
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueByGlobalId(forge, str(input.issueId));
        if (found === null) throw new GqlFieldError(`issue ${str(input.issueId)} not found`);
        found.issue.state = 'closed';
        return gqlObj('CloseIssuePayload', { issue: issueObject(found.repo, found.issue) });
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(forge, str(input.repositoryId));
        try {
          const pull = forge.createPull(repo, {
            title: str(input.title),
            body: str(input.body),
            head: str(input.headRefName),
            base: str(input.baseRefName),
          });
          return gqlObj('CreatePullRequestPayload', { pullRequest: pullObject(repo, pull) });
        } catch (error) {
          if (error instanceof ForgeError) throw new GqlFieldError(error.message);
          throw error;
        }
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = pullByGlobalId(forge, str(input.pullRequestId));
        if (found === null) throw new GqlFieldError(`pull request ${str(input.pullRequestId)} not found`);
        try {
          forge.mergePull(found.repo, found.pull);
        } catch (error) {
          if (error instanceof ForgeError) throw new GqlFieldError(error.message);
          throw error;
        }
        return gqlObj('MergePullRequestPayload', { pullRequest: pullObject(found.repo, found.pull) });
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueByGlobalId(forge, str(input.subjectId));
        if (found === null) throw new GqlFieldError(`subject ${str(input.subjectId)} not found`);
        const comment = forge.addComment(found.repo, found.issue, str(input.body));
        return gqlObj('AddCommentPayload', {
          commentEdge: gqlObj('IssueCommentEdge', {
            node: gqlObj('IssueComment', { id: commentGlobalId(found.repo, found.issue, comment.id), body: comment.body }),
          }),
        });
      }
      break;
    }
    case 'User':
    case 'RepositoryOwner': {
      if (field.name === 'login') return str(data.login ?? LOGIN);
      if (field.name === 'id') return globalId('User', 1000);
      if (field.name === 'name') return LOGIN;
      break;
    }
    case 'Repository': {
      const repo = data.repo as RepoState;
      switch (field.name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${LOGIN}/${repo.name}`;
        case 'owner':
          return gqlObj('RepositoryOwner', { login: LOGIN });
        case 'defaultBranchRef':
          return gqlObj('Ref', { name: repo.defaultBranch });
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.isPrivate;
        case 'createdAt':
          return repo.createdAt;
        case 'updatedAt':
          return repo.updatedAt;
        case 'issue': {
          const issue = repo.issues.get(num(args.number));
          return issue === undefined ? null : issueObject(repo, issue);
        }
        case 'issues':
          return issuesConnection(repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.get(num(args.number));
          return pull === undefined ? null : pullObject(repo, pull);
        }
        case 'pullRequests': {
          const all = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
          const first = typeof args.first === 'number' ? args.first : all.length;
          return gqlObj('PullRequestConnection', {
            nodes: all.slice(0, first).map((pull) => pullObject(repo, pull)),
            totalCount: all.length,
          });
        }
      }
      break;
    }
    case 'Ref': {
      if (field.name === 'name') return str(data.name);
      break;
    }
    case 'Issue': {
      const issue = data.issue as IssueState;
      switch (field.name) {
        case 'id':
          return issueGlobalId(data.repo as RepoState, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
      }
      break;
    }
    case 'PullRequest': {
      const repo = data.repo as RepoState;
      const pull = data.pull as PullState;
      switch (field.name) {
        case 'id':
          return pullGlobalId(repo, pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable':
          if (pull.state !== 'open') return 'UNKNOWN';
          return forge.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
        case 'mergedAt':
          return pull.mergedAt;
        case 'mergeCommit':
          return pull.mergeCommitSha === null ? null : gqlObj('Commit', { oid: pull.mergeCommitSha });
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'files': {
          const changes = forge.pullChanges(repo, pull);
          const first = typeof args.first === 'number' ? args.first : changes.length;
          return gqlObj('PullRequestChangedFileConnection', {
            nodes: changes.slice(0, first).map((change) =>
              gqlObj('PullRequestChangedFile', { path: change.filename, additions: change.additions, deletions: change.deletions }),
            ),
            totalCount: changes.length,
          });
        }
      }
      break;
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return str(data.path);
      if (field.name === 'additions') return num(data.additions);
      if (field.name === 'deletions') return num(data.deletions);
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      if (field.name === 'nodes') return data.nodes as unknown[];
      if (field.name === 'totalCount') return num(data.totalCount);
      if (field.name === 'pageInfo') return data.pageInfo as unknown;
      if (field.name === 'edges') return [];
      break;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return data.hasNextPage === true;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'endCursor') return (data.endCursor as string | null) ?? null;
      if (field.name === 'startCursor') return (data.startCursor as string | null) ?? null;
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return data.issue as unknown;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return data.pullRequest as unknown;
      break;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return data.commentEdge as unknown;
      if (field.name === 'subject') return null;
      break;
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return data.node as unknown;
      if (field.name === 'cursor') return '';
      break;
    }
    case 'IssueComment': {
      if (field.name === 'id') return str(data.id);
      if (field.name === 'body') return str(data.body);
      break;
    }
    case 'Commit': {
      if (field.name === 'oid') return str(data.oid);
      if (field.name === 'id') return globalId('Commit', str(data.oid));
      break;
    }
    case '__Type': {
      if (field.name === 'name') return (data.name as string | null) ?? null;
      if (field.name === 'kind') return str(data.kind);
      if (field.name === 'fields') {
        const names = data.fieldNames as string[] | undefined;
        return names === undefined ? null : names.map((name) => gqlObj('__Field', { name }));
      }
      if (field.name === 'enumValues') {
        const names = data.enumNames as string[] | undefined;
        return names === undefined ? null : names.map((name) => gqlObj('__EnumValue', { name }));
      }
      if (field.name === 'possibleTypes' || field.name === 'inputFields') return null;
      if (field.name === 'ofType') return null;
      break;
    }
    case '__Field':
    case '__EnumValue':
    case '__InputValue': {
      if (field.name === 'name') return str(data.name);
      if (field.name === 'isDeprecated') return false;
      break;
    }
  }
  // A field the type does not hold: a GraphQL error naming it, value null.
  ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${type}'`, path: [] });
  return null;
}

function repoObject(repo: RepoState): GqlObject {
  return gqlObj('Repository', { repo });
}

function issueObject(repo: RepoState, issue: IssueState): GqlObject {
  return gqlObj('Issue', { repo, issue });
}

function pullObject(repo: RepoState, pull: PullState): GqlObject {
  return gqlObj('PullRequest', { repo, pull });
}

function typeObject(name: string): GqlObject | null {
  if (ENUM_VALUES[name] !== undefined) {
    return gqlObj('__Type', { name, kind: 'ENUM', enumNames: ENUM_VALUES[name] });
  }
  if (OBJECT_TYPES.has(name)) {
    return gqlObj('__Type', { name, kind: 'OBJECT', fieldNames: TYPE_FIELDS[name] });
  }
  if (name === 'String' || name === 'Int' || name === 'Boolean' || name === 'ID' || name === 'Float') {
    return gqlObj('__Type', { name, kind: 'SCALAR' });
  }
  return null;
}

function repoByGlobalId(forge: Forge, id: string): RepoState {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository') throw new GqlFieldError(`repository id ${id} is not valid`);
  const dbId = Number(parsed.parts[0]);
  for (const repo of forge.repos.values()) if (repo.id === dbId) return repo;
  throw new GqlFieldError(`repository ${id} not found`);
}

function issueByGlobalId(forge: Forge, id: string): { repo: RepoState; issue: IssueState } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  const repo = repoByGlobalId(forge, globalId('Repository', parsed.parts[0]!));
  const issue = repo.issues.get(Number(parsed.parts[1]));
  return issue === undefined ? null : { repo, issue };
}

function pullByGlobalId(forge: Forge, id: string): { repo: RepoState; pull: PullState } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  const repo = repoByGlobalId(forge, globalId('Repository', parsed.parts[0]!));
  const pull = repo.pulls.get(Number(parsed.parts[1]));
  return pull === undefined ? null : { repo, pull };
}

function nodeById(ctx: ExecContext, id: string): GqlObject | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  try {
    if (parsed.kind === 'Repository') return repoObject(repoByGlobalId(ctx.forge, id));
    if (parsed.kind === 'Issue') {
      const found = issueByGlobalId(ctx.forge, id);
      return found === null ? null : issueObject(found.repo, found.issue);
    }
    if (parsed.kind === 'PullRequest') {
      const found = pullByGlobalId(ctx.forge, id);
      return found === null ? null : pullObject(found.repo, found.pull);
    }
  } catch {
    return null;
  }
  return null;
}

/** repository.issues as a connection: states filter, orderBy, first/after cursor paging. */
function issuesConnection(repo: RepoState, args: Record<string, unknown>): GqlObject {
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  let descending = false;
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  if (orderBy !== undefined && orderBy !== null && typeof orderBy === 'object') {
    descending = String(orderBy.direction ?? 'ASC') === 'DESC';
  }
  issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  let start = 0;
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    const cursor = parseCursor(after);
    if (cursor !== null) {
      const index = issues.findIndex((issue) => issue.number === cursor);
      if (index >= 0) start = index + 1;
    }
  }
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const page = issues.slice(start, start + first);
  const hasNextPage = start + page.length < issues.length;
  const endCursor = page.length > 0 ? makeCursor(page[page.length - 1]!.number) : null;
  return gqlObj('IssueConnection', {
    nodes: page.map((issue) => issueObject(repo, issue)),
    totalCount: issues.length,
    pageInfo: gqlObj('PageInfo', {
      hasNextPage,
      endCursor,
      startCursor: page.length > 0 ? makeCursor(page[0]!.number) : null,
    }),
  });
}

function makeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function parseCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/** Execute a selection set against a typed source object. */
function execSelectionSet(ctx: ExecContext, type: string, source: GqlObject, selections: readonly SelectionNode[], path: Array<string | number>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === type) {
        Object.assign(out, execSelectionSet(ctx, type, source, selection.selection, path));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === type) {
        Object.assign(out, execSelectionSet(ctx, type, source, fragment.selection, path));
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = type;
      continue;
    }
    const fieldType = field.name === '__type' && type === 'Query' ? '__Type' : null;
    let value: unknown;
    try {
      value = resolveField(ctx, type, source, field);
    } catch (error) {
      if (error instanceof GqlFieldError) {
        ctx.errors.push({ message: error.message, path: [...path, key] });
        out[key] = null;
        continue;
      }
      throw error;
    }
    out[key] = completeValue(ctx, value, field, fieldType, [...path, key]);
  }
  return out;
}

/** Apply a field's sub-selection to its resolved value. */
function completeValue(ctx: ExecContext, value: unknown, field: FieldNode, forcedType: string | null, path: Array<string | number>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item, index) => completeValue(ctx, item, field, forcedType, [...path, index]));
  }
  if (isGqlObject(value)) {
    if (field.selection === null) return null;
    return execSelectionSet(ctx, forcedType ?? value.__type, value, field.selection, path);
  }
  return value;
}

/** Execute one GraphQL operation body ({query, variables, operationName}) and answer the envelope. */
export function executeGraphQL(
  forge: Forge,
  body: { query?: unknown; variables?: unknown; operationName?: unknown },
): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as Record<string, unknown>;
  let document: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    document = new Parser(query).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'parse error' }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation =
    document.operations.find((candidate) => candidate.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in the document' }] };
  const ctx: ExecContext = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root = gqlObj(rootType, {});
  try {
    const data = execSelectionSet(ctx, rootType, root, operation.selection, []);
    const envelope: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) envelope.errors = ctx.errors;
    return envelope;
  } catch (error) {
    return {
      data: null,
      errors: [{ message: error instanceof Error ? error.message : 'execution error' }],
    };
  }
}
