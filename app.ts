// The forge's HTTP surface: the env's health probe, REST v3 under /api/v3, git
// smart HTTP at /{owner}/{repo}.git, GraphQL at /api/graphql and MCP at /mcp,
// all over one in-memory Forge. Every surface takes the trial's bearer token.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, ForgeError, LOGIN, VIEWER_ID, type RepoState } from './store.ts';
import { hashObject, parseCommit } from './gitobj.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json';
const INSTALLED_VERSION = 'makefun-forge/1.0.0';

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  raw?: Buffer;
  contentType?: string;
}

function jsonReply(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return { status, body, headers };
}

function errorReply(status: number, message: string): Reply {
  return jsonReply(status, { message });
}

/** The whole application: one Forge behind one HTTP server. */
export function createApp(): Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const server = createServer((req, res) => {
    handle(forge, token, req, res).catch(() => {
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': JSON_TYPE, 'x-github-request-id': forge.nextRequestId() });
        }
        res.end(JSON.stringify({ message: 'Internal Server Error' }));
      } catch {
        // The socket is gone; nothing more to do.
      }
    });
  });
  return server;
}

async function handle(forge: Forge, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  if (method === 'GET' && path === '/healthz') {
    return send(res, jsonReply(200, { ok: true }), forge);
  }

  const authed = token === '' || req.headers.authorization === `Bearer ${token}`;

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    if (!authed) return send(res, errorReply(401, 'Bad credentials'), forge);
    const owner = decodeURIComponent(gitMatch[1]!);
    const repoName = decodeURIComponent(gitMatch[2]!);
    const endpoint = gitMatch[3]!;
    if (method === 'GET' && endpoint === 'info/refs') {
      const service = url.searchParams.get('service') ?? '';
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const answer = infoRefs(forge, owner, repoName, service, v2);
      return sendRaw(res, answer.status, answer.contentType, answer.body, forge);
    }
    if (method === 'POST' && (endpoint === 'git-upload-pack' || endpoint === 'git-receive-pack')) {
      const body = await readBody(req);
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const answer =
        endpoint === 'git-upload-pack'
          ? uploadPack(forge, owner, repoName, body, v2)
          : receivePack(forge, owner, repoName, body);
      return sendRaw(res, answer.status, answer.contentType, answer.body, forge);
    }
    return send(res, errorReply(404, 'Not Found'), forge);
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') return send(res, errorReply(404, 'Not Found'), forge);
    if (!authed) return send(res, errorReply(401, 'Bad credentials'), forge);
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return send(res, jsonReply(400, { errors: [{ message: 'Malformed JSON' }] }), forge);
    }
    if (Array.isArray(parsed)) {
      const answers = parsed.map((entry) => executeGraphQL(forge, (entry ?? {}) as Record<string, unknown>));
      return send(res, jsonReply(200, answers), forge);
    }
    const answer = executeGraphQL(forge, (parsed ?? {}) as Record<string, unknown>);
    return send(res, jsonReply(200, answer), forge);
  }

  if (path === '/mcp') {
    if (method !== 'POST') return send(res, errorReply(405, 'Method Not Allowed'), forge);
    const body = (await readBody(req)).toString('utf8');
    let parses = true;
    try {
      JSON.parse(body);
    } catch {
      parses = false;
    }
    if (!parses) {
      const answer = handleMcp(forge, body);
      return send(res, { status: answer.status, body: answer.body }, forge);
    }
    if (!authed) return send(res, errorReply(401, 'Bad credentials'), forge);
    const answer = handleMcp(forge, body);
    if (answer.body === null) {
      res.writeHead(answer.status, { 'x-github-request-id': forge.nextRequestId() });
      res.end();
      return;
    }
    return send(res, { status: answer.status, body: answer.body }, forge);
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authed) return send(res, errorReply(401, 'Bad credentials'), forge);
    const reply = await rest(forge, method, url, req);
    return send(res, reply, forge);
  }

  return send(res, errorReply(404, 'Not Found'), forge);
}

// ---------------------------------------------------------------- plumbing

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, reply: Reply, forge: Forge): void {
  const headers: Record<string, string> = {
    'x-github-request-id': forge.nextRequestId(),
    ...(reply.headers ?? {}),
  };
  if (reply.raw !== undefined) {
    res.writeHead(reply.status, { 'content-type': reply.contentType ?? JSON_TYPE, ...headers });
    res.end(reply.raw);
    return;
  }
  if (reply.status === 204 || reply.body === undefined) {
    res.writeHead(reply.status, headers);
    res.end();
    return;
  }
  const text = JSON.stringify(reply.body);
  res.writeHead(reply.status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, forge: Forge): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': forge.nextRequestId(),
  });
  res.end(body);
}

// ---------------------------------------------------------------- REST v3

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

function strField(body: Json, name: string): string {
  const value = body[name];
  return typeof value === 'string' ? value : '';
}

async function rest(forge: Forge, method: string, url: URL, req: IncomingMessage): Promise<Reply> {
  const segments = url.pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => decodeURIComponent(segment));
  // segments[0] === 'api', segments[1] === 'v3'
  const tail = segments.slice(2);

  let body: Json = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const raw = await readBody(req);
    if (raw.length > 0) {
      try {
        body = asRecord(JSON.parse(raw.toString('utf8')));
      } catch {
        if (method !== 'DELETE') return errorReply(400, 'Malformed JSON');
      }
    }
  }

  try {
    return routeRest(forge, method, tail, url, req, body);
  } catch (error) {
    if (error instanceof ForgeError) {
      if (error.status === 422 && tail.join('/') === 'user/repos') {
        return jsonReply(422, {
          message: 'Repository creation failed.',
          errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
        });
      }
      return errorReply(error.status, error.message);
    }
    throw error;
  }
}

function routeRest(forge: Forge, method: string, tail: string[], url: URL, req: IncomingMessage, body: Json): Reply {
  const query = url.searchParams;

  if (tail.length === 0) {
    if (method === 'GET') {
      return jsonReply(
        200,
        {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          issue_url: '/api/v3/repos/{owner}/{repo}/issues',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
    }
    return errorReply(404, 'Not Found');
  }

  if (tail[0] === 'meta' && tail.length === 1) {
    if (method === 'GET') return jsonReply(200, { installed_version: INSTALLED_VERSION, verifiable_password_authentication: false });
    return errorReply(404, 'Not Found');
  }

  if (tail[0] === 'user' && tail.length === 1) {
    if (method === 'GET') return jsonReply(200, { login: LOGIN, id: VIEWER_ID, type: 'User' });
    return errorReply(404, 'Not Found');
  }

  if (tail[0] === 'user' && tail[1] === 'repos' && tail.length === 2) {
    if (method === 'POST') {
      const name = strField(body, 'name');
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return errorReply(422, 'Repository creation failed.');
      const repo = forge.createRepo(name, body.private === true, strField(body, 'description'));
      return jsonReply(201, forge.repoJson(repo));
    }
    if (method === 'GET') {
      const perPage = clampInt(query.get('per_page'), 30, 1, 100);
      const page = clampInt(query.get('page'), 1, 1, 1_000_000);
      const all = [...forge.repos.values()].sort((a, b) => a.id - b.id);
      const items = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (page * perPage < all.length) {
        const host = req.headers.host ?? 'localhost';
        const next = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        const lastPage = Math.ceil(all.length / perPage);
        const last = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${lastPage}`;
        headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
      }
      return jsonReply(200, items.map((repo) => forge.repoJson(repo)), headers);
    }
    return errorReply(404, 'Not Found');
  }

  if (tail[0] === 'repos' && tail.length >= 3) {
    const repo = forge.repo(tail[1]!, tail[2]!);
    return routeRepo(forge, repo, method, tail.slice(3), query, body);
  }

  return errorReply(404, 'Not Found');
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function routeRepo(forge: Forge, repo: RepoState, method: string, tail: string[], query: URLSearchParams, body: Json): Reply {
  // The repository itself.
  if (tail.length === 0) {
    if (method === 'GET') return jsonReply(200, forge.repoJson(repo));
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      repo.updatedAt = forge.tickIso();
      return jsonReply(200, forge.repoJson(repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(LOGIN, repo.name);
      return { status: 204 };
    }
    return errorReply(404, 'Not Found');
  }

  const [head, ...rest] = tail as [string, ...string[]];

  if (head === 'contents') return routeContents(forge, repo, method, rest.join('/'), query, body);
  if (head === 'labels') return routeLabels(forge, repo, method, body);
  if (head === 'issues') return routeIssues(forge, repo, method, rest, query, body);
  if (head === 'pulls') return routePulls(forge, repo, method, rest, query, body);
  if (head === 'branches') return routeBranches(forge, repo, method, rest);
  if (head === 'commits') return routeCommits(forge, repo, method, rest, query);
  if (head === 'git') return routeGitData(forge, repo, method, rest, body);

  return errorReply(404, 'Not Found');
}

// ---------------------------------------------------------------- contents

function routeContents(forge: Forge, repo: RepoState, method: string, path: string, query: URLSearchParams, body: Json): Reply {
  if (method === 'GET') {
    const ref = query.get('ref') ?? undefined;
    const found = forge.contentsAt(repo, path, ref);
    if (found === null) return errorReply(404, 'Not Found');
    if (found.kind === 'dir') {
      return jsonReply(
        200,
        found.entries.map((entry) => ({ type: entry.type, name: entry.name, path: entry.path, sha: entry.sha })),
      );
    }
    const name = path.split('/').pop() ?? path;
    return jsonReply(200, {
      type: 'file',
      name,
      path,
      sha: found.sha,
      size: found.size,
      encoding: 'base64',
      content: found.data.toString('base64'),
    });
  }
  if (method === 'PUT') {
    const content = Buffer.from(strField(body, 'content').replace(/[\r\n\t ]+/g, ''), 'base64');
    const branch = strField(body, 'branch') || repo.defaultBranch;
    const message = strField(body, 'message') || 'Update file';
    const existing = forge.contentsAt(repo, path, branch);
    const existed = existing !== null && existing.kind === 'file';
    if (existed && typeof body.sha === 'string' && body.sha !== '' && body.sha !== (existing as { sha: string }).sha) {
      return errorReply(409, 'Conflict: the sha does not match the current content');
    }
    const commit = forge.commitChanges(repo, branch, new Map([[path, content]]), message);
    const blobSha = hashObject('blob', content);
    return jsonReply(existed ? 200 : 201, {
      content: { type: 'file', name: path.split('/').pop() ?? path, path, sha: blobSha, encoding: 'base64' },
      commit: { sha: commit },
    });
  }
  if (method === 'DELETE') {
    const branch = strField(body, 'branch') || repo.defaultBranch;
    const existing = forge.contentsAt(repo, path, branch);
    if (existing === null || existing.kind !== 'file') return errorReply(404, 'Not Found');
    const message = strField(body, 'message') || 'Delete file';
    const commit = forge.commitChanges(repo, branch, new Map([[path, null]]), message);
    return jsonReply(200, { content: null, commit: { sha: commit } });
  }
  return errorReply(404, 'Not Found');
}

// ---------------------------------------------------------------- labels and issues

function routeLabels(forge: Forge, repo: RepoState, method: string, body: Json): Reply {
  if (method === 'GET') {
    return jsonReply(200, [...repo.labels.values()].map((label) => forge.labelJson(label)));
  }
  if (method === 'POST') {
    const name = strField(body, 'name');
    if (name === '') return errorReply(422, 'Validation Failed: name is required');
    if (repo.labels.has(name)) return errorReply(422, 'Validation Failed: name has already been taken');
    const label = { name, color: strField(body, 'color') || 'ededed' };
    repo.labels.set(name, label);
    return jsonReply(201, forge.labelJson(label));
  }
  return errorReply(404, 'Not Found');
}

function labelNamesOf(body: Json): string[] {
  const labels = body.labels;
  if (!Array.isArray(labels)) return [];
  const names: string[] = [];
  for (const entry of labels) {
    if (typeof entry === 'string') names.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as Json).name === 'string') {
      names.push((entry as Json).name as string);
    }
  }
  return names;
}

function routeIssues(forge: Forge, repo: RepoState, method: string, tail: string[], query: URLSearchParams, body: Json): Reply {
  if (tail.length === 0) {
    if (method === 'POST') {
      const issue = forge.createIssue(repo, {
        title: strField(body, 'title'),
        body: strField(body, 'body'),
        labels: labelNamesOf(body),
      });
      return jsonReply(201, forge.issueJson(repo, issue));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const perPage = clampInt(query.get('per_page'), 30, 1, 100);
      const page = clampInt(query.get('page'), 1, 1, 1_000_000);
      issues = issues.slice((page - 1) * perPage, page * perPage);
      return jsonReply(200, issues.map((issue) => forge.issueJson(repo, issue)));
    }
    return errorReply(404, 'Not Found');
  }

  const number = Number.parseInt(tail[0]!, 10);
  if (!Number.isInteger(number)) return errorReply(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (issue === undefined) return errorReply(404, 'Not Found');

  if (tail.length === 1) {
    if (method === 'GET') return jsonReply(200, forge.issueJson(repo, issue));
    if (method === 'PATCH') {
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (Array.isArray(body.labels)) {
        const names = labelNamesOf(body);
        for (const name of names) {
          if (!repo.labels.has(name)) return errorReply(422, `Label '${name}' does not exist`);
        }
        issue.labels = names;
      }
      issue.updatedAt = forge.tickIso();
      return jsonReply(200, forge.issueJson(repo, issue));
    }
    return errorReply(404, 'Not Found');
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      const comment = forge.addComment(repo, issue, strField(body, 'body'));
      return jsonReply(201, forge.commentJson(comment));
    }
    if (method === 'GET') {
      return jsonReply(200, issue.comments.map((comment) => forge.commentJson(comment)));
    }
  }
  return errorReply(404, 'Not Found');
}

// ---------------------------------------------------------------- pull requests

function routePulls(forge: Forge, repo: RepoState, method: string, tail: string[], query: URLSearchParams, body: Json): Reply {
  if (tail.length === 0) {
    if (method === 'POST') {
      const pull = forge.createPull(repo, {
        title: strField(body, 'title'),
        body: strField(body, 'body'),
        head: strField(body, 'head'),
        base: strField(body, 'base') || repo.defaultBranch,
      });
      return jsonReply(201, forge.pullJson(repo, pull));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      const perPage = clampInt(query.get('per_page'), 30, 1, 100);
      const page = clampInt(query.get('page'), 1, 1, 1_000_000);
      pulls = pulls.slice((page - 1) * perPage, page * perPage);
      return jsonReply(200, pulls.map((pull) => forge.pullJson(repo, pull)));
    }
    return errorReply(404, 'Not Found');
  }

  const number = Number.parseInt(tail[0]!, 10);
  if (!Number.isInteger(number)) return errorReply(404, 'Not Found');
  const pull = repo.pulls.get(number);

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) return errorReply(404, 'Not Found');
    const { sha } = forge.mergePull(repo, pull);
    return jsonReply(200, { sha, merged: true, message: 'Pull Request successfully merged' });
  }
  if (pull === undefined) return errorReply(404, 'Not Found');
  if (tail.length === 1 && method === 'GET') return jsonReply(200, forge.pullJson(repo, pull));
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    return jsonReply(200, forge.pullChanges(repo, pull));
  }
  return errorReply(404, 'Not Found');
}

// ---------------------------------------------------------------- branches, commits, git data

function routeBranches(forge: Forge, repo: RepoState, method: string, tail: string[]): Reply {
  void forge;
  if (method !== 'GET') return errorReply(404, 'Not Found');
  if (tail.length === 0) {
    const branches: Array<{ name: string; commit: { sha: string } }> = [];
    for (const [ref, oid] of repo.refs) {
      if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
    }
    branches.sort((a, b) => (a.name < b.name ? -1 : 1));
    return jsonReply(200, branches);
  }
  const name = tail.join('/');
  const tip = repo.refs.get(`refs/heads/${name}`);
  if (tip === undefined) return errorReply(404, 'Not Found');
  return jsonReply(200, { name, commit: { sha: tip } });
}

function routeCommits(forge: Forge, repo: RepoState, method: string, tail: string[], query: URLSearchParams): Reply {
  if (method !== 'GET') return errorReply(404, 'Not Found');
  if (tail.length === 1) {
    const oid = tail[0]!;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return errorReply(404, 'Not Found');
    return jsonReply(200, commitJson(repo, oid));
  }
  const ref = query.get('sha') ?? repo.defaultBranch;
  const tip = forge.resolveCommit(repo, ref);
  if (tip === null) return jsonReply(200, []);
  const perPage = clampInt(query.get('per_page'), 30, 1, 100);
  const commits: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0 && commits.length < perPage) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    commits.push(commitJson(repo, oid));
    for (const parent of commitViewOf(repo, oid).parents) queue.push(parent);
  }
  return jsonReply(200, commits);
}

function commitViewOf(repo: RepoState, oid: string): { tree: string; parents: string[]; author: string; committer: string; message: string; time: number } {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return { tree: '', parents: [], author: '', committer: '', message: '', time: 0 };
  return parseCommit(object.data);
}

function commitJson(repo: RepoState, oid: string): Record<string, unknown> {
  const view = commitViewOf(repo, oid);
  const ident = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
    if (match === null) return { name: line, email: '', date: new Date(0).toISOString() };
    return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  return {
    sha: oid,
    commit: {
      message: view.message.replace(/\n$/, ''),
      tree: { sha: view.tree },
      author: ident(view.author),
      committer: ident(view.committer),
    },
    parents: view.parents.map((parent) => ({ sha: parent })),
  };
}

function routeGitData(forge: Forge, repo: RepoState, method: string, tail: string[], body: Json): Reply {
  void forge;
  if (tail[0] === 'refs') {
    if (method === 'POST' && tail.length === 1) {
      const ref = strField(body, 'ref');
      const sha = strField(body, 'sha');
      if (!ref.startsWith('refs/') || sha === '') return errorReply(422, 'Validation Failed');
      if (repo.refs.has(ref)) return errorReply(422, 'Reference already exists');
      forge.setRef(repo, ref, sha);
      return jsonReply(201, { ref, object: { sha, type: 'commit' } });
    }
    if (method === 'GET') {
      if (tail.length === 1) {
        const all = [...repo.refs.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }));
        return jsonReply(200, all);
      }
      const ref = `refs/${tail.slice(1).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return errorReply(404, 'Not Found');
      return jsonReply(200, { ref, object: { sha, type: 'commit' } });
    }
  }
  if (tail[0] === 'ref' && method === 'GET') {
    const ref = tail.slice(1).join('/');
    const sha = repo.refs.get(ref.startsWith('refs/') ? ref : `refs/${ref}`);
    if (sha === undefined) return errorReply(404, 'Not Found');
    return jsonReply(200, { ref: ref.startsWith('refs/') ? ref : `refs/${ref}`, object: { sha, type: 'commit' } });
  }
  return errorReply(404, 'Not Found');
}
