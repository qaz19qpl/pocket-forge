// The MCP endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP, speaking the
// 2026-07-28 revision through server/discover (and the legacy initialize
// handshake). The tools act on the same Forge store as REST and GraphQL.

import { ForgeError, LOGIN, type Forge, type RepoState } from './store.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function stringProp(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

/** The tool list: built once, so two tools/list answers are byte-identical. */
const TOOLS: ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The repository name.'),
        description: stringProp('The repository description.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The issue title.'),
        body: stringProp('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        state: stringProp('Filter by state: open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The pull request title.'),
        body: stringProp('The pull request body.'),
        head: stringProp('The head branch name.'),
        base: stringProp('The base branch name.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

interface JsonRpcRequest {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpAnswer {
  status: number;
  /** The JSON body to send; null answers with an empty body (notifications). */
  body: Record<string, unknown> | unknown[] | null;
}

/** Handle one raw POST /mcp body (auth is the caller's job). */
export function handleMcp(forge: Forge, rawBody: string): McpAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (Array.isArray(parsed)) {
    const answers: unknown[] = [];
    for (const entry of parsed) {
      const answer = handleOne(forge, entry as JsonRpcRequest);
      if (answer !== null) answers.push(answer);
    }
    return { status: 200, body: answers };
  }
  const answer = handleOne(forge, parsed as JsonRpcRequest);
  if (answer === null) return { status: 202, body: null };
  return { status: 200, body: answer };
}

function handleOne(forge: Forge, request: JsonRpcRequest): Record<string, unknown> | null {
  const isNotification = request.id === undefined || request.id === null;
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;

  const result = (value: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result: value });
  const failure = (code: number, message: string): Record<string, unknown> => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });

  switch (method) {
    case 'server/discover':
      return result({
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return result({ protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      return callTool(forge, name, args, result, failure);
    }
    default:
      if (isNotification) return null;
      return failure(-32601, `Method not found: ${method}`);
  }
}

function toolSuccess(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

type Reply = (value: unknown) => Record<string, unknown>;
type Fail = (code: number, message: string) => Record<string, unknown>;

function callTool(forge: Forge, name: string, args: Record<string, unknown>, result: Reply, failure: Fail): Record<string, unknown> {
  const tool = TOOLS_BY_NAME.get(name);
  if (tool === undefined) return failure(-32602, `Tool ${name} not found`);
  const schema = tool.inputSchema as { required?: string[] };
  for (const required of schema.required ?? []) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return failure(-32602, `Missing required argument: ${required}`);
    }
  }
  try {
    return result(toolSuccess(runTool(forge, name, args)));
  } catch (error) {
    if (error instanceof ForgeError) return result(toolFailure(error.message));
    if (error instanceof Error) return result(toolFailure(error.message));
    return result(toolFailure('tool failed'));
  }
}

/** Owner/repo arguments, with a full_name fallback. */
function repoArgs(forge: Forge, args: Record<string, unknown>): RepoState {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [namedOwner, namedRepo] = args.full_name.split('/', 2);
    if (owner === '') owner = namedOwner ?? '';
    if (repo === '') repo = namedRepo ?? '';
  }
  return forge.repo(owner, repo);
}

function runTool(forge: Forge, name: string, args: Record<string, unknown>): unknown {
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name);
      if (repoName === '') throw new ForgeError(422, 'name is required');
      const repo = forge.createRepo(repoName, args.private === true, str(args.description));
      return forge.repoJson(repo);
    }
    case 'get_repo': {
      return forge.repoJson(repoArgs(forge, args));
    }
    case 'create_issue': {
      const repo = repoArgs(forge, args);
      const issue = forge.createIssue(repo, { title: str(args.title), body: str(args.body) });
      return forge.issueJson(repo, issue);
    }
    case 'list_issues': {
      const repo = repoArgs(forge, args);
      const state = str(args.state) || 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number);
      return issues.map((issue) => forge.issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const repo = repoArgs(forge, args);
      const pull = forge.createPull(repo, {
        title: str(args.title),
        body: str(args.body),
        head: str(args.head),
        base: str(args.base),
      });
      return forge.pullJson(repo, pull);
    }
    case 'merge_pull_request': {
      const repo = repoArgs(forge, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = forge.pull(repo, number);
      const { sha } = forge.mergePull(repo, pull);
      return { ...forge.pullJson(repo, pull), sha, merged: true };
    }
    default:
      throw new ForgeError(404, `Tool ${name} not found`);
  }
}

export { LOGIN };
