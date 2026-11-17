// Model Context Protocol (/mcp) over Streamable HTTP: JSON-RPC 2.0.
// Modern era via server/discover (revision 2026-07-28), legacy handshake via
// initialize for older revisions. Tools act on the same store as REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, readBody, requireAuth, sendJson } from './common.ts';
import { squashMerge } from './graphql.ts';
import {
  parseCommit,
  type Forge,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

const PROTOCOL_VERSION = '2026-07-28';
const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
      owner: { type: 'string', description: 'The owner login (the viewer).' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'list_repos',
    description: 'List the viewer repositories.',
    properties: {},
    required: [],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'integer', description: 'The issue number.' },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'get_pull_request',
    description: 'Get one pull request by number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolJson(t: ToolDef): Record<string, unknown> {
  return {
    name: t.name,
    description: t.description,
    inputSchema: {
      type: 'object',
      properties: t.properties,
      required: t.required,
    },
  };
}

interface RpcError {
  code: number;
  message: string;
}

function rpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(res: ServerResponse, status: number, id: unknown, err: RpcError): void {
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: err });
}

function toolText(payload: unknown): { content: { type: 'text'; text: string }[]; structuredContent: unknown } {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload };
}

function toolErrorText(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: forge.repoNodeId(repo),
    name: repo.name,
    full_name: repo.fullName,
    owner: repo.owner,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    node_id: forge.issueNodeId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullJson(forge: Forge, repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + pr.number,
    node_id: forge.pullNodeId(repo, pr),
    number: pr.number,
    pull_number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    head: pr.headRef,
    base: pr.baseRef,
    head_ref: pr.headRef,
    base_ref: pr.baseRef,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pr.number}`,
  };
}

function lookup(forge: Forge, args: Record<string, unknown>): Repo | null {
  const owner = String(args.owner ?? forge.viewerLogin);
  const repo = String(args.repo ?? args.repository ?? '');
  if (repo === '') return null;
  return forge.getRepo(owner, repo) ?? null;
}

function callTool(
  forge: Forge,
  name: string,
  args: Record<string, unknown>,
): { result: unknown } | { rpcError: RpcError } | { toolError: string } {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const find = (wanted: string): boolean => norm === wanted || norm.endsWith(wanted);
  const missing = (tool: ToolDef): string[] =>
    tool.required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');

  if (find('createrepo')) {
    const tool = TOOLS[0];
    const miss = missing(tool);
    if (miss.length > 0) return { rpcError: { code: -32602, message: `Missing required argument(s): ${miss.join(', ')}` } };
    const repoName = String(args.name);
    if (forge.getRepo(forge.viewerLogin, repoName)) {
      return { toolError: `Repository ${forge.viewerLogin}/${repoName} already exists` };
    }
    const repo = forge.createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
    return { result: toolText(repoJson(forge, repo)) };
  }
  if (find('getrepo')) {
    const tool = TOOLS[1];
    const miss = missing(tool);
    if (miss.length > 0) return { rpcError: { code: -32602, message: `Missing required argument(s): ${miss.join(', ')}` } };
    const repo = lookup(forge, args);
    if (!repo) return { toolError: `Repository ${args.owner}/${args.repo} not found` };
    return { result: toolText(repoJson(forge, repo)) };
  }
  if (find('listrepos')) {
    const repos = forge.listViewerRepos().map((r) => repoJson(forge, r));
    return { result: toolText({ repos, repositories: repos }) };
  }
  if (find('createissue')) {
    const tool = TOOLS[3];
    const miss = missing(tool);
    if (miss.length > 0) return { rpcError: { code: -32602, message: `Missing required argument(s): ${miss.join(', ')}` } };
    const repo = lookup(forge, args);
    if (!repo) return { toolError: `Repository ${args.owner}/${args.repo} not found` };
    const issue: Issue = {
      number: repo.nextNumber,
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      comments: [],
      seq: repo.seq,
    };
    repo.seq += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return { result: toolText(issueJson(forge, repo, issue)) };
  }
  if (find('getissue')) {
    const tool = TOOLS[4];
    const miss = missing(tool);
    if (miss.length > 0) return { rpcError: { code: -32602, message: `Missing required argument(s): ${miss.join(', ')}` } };
    const repo = lookup(forge, args);
    if (!repo) return { toolError: `Repository ${args.owner}/${args.repo} not found` };
    const num = Number(args.issue_number ?? args.number);
    const issue = repo.issues.get(num);
    if (!issue) return { toolError: `Issue ${num} not found` };
    return { result: toolText(issueJson(forge, repo, issue)) };
  }
  if (find('listissues')) {
    const tool = TOOLS[5];
    const miss = missing(tool);
    if (miss.length > 0) return { rpcError: { code: -32602, message: `Missing required argument(s): ${miss.join(', ')}` } };
    const repo = lookup(forge, args);
    if (!repo) return { toolError: `Repository ${args.owner}/${args.repo} not found` };
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => b.seq - a.seq);
    const arr = list.map((i) => issueJson(forge, repo, i));
    return { result: toolText(arr) };
  }
  if (find('createpullrequest')) {
    const tool = TOOLS[6];
    const miss = missing(tool);
    if (miss.length > 0) return { rpcError: { code: -32602, message: `Missing required argument(s): ${miss.join(', ')}` } };
    const repo = lookup(forge, args);
    if (!repo) return { toolError: `Repository ${args.owner}/${args.repo} not found` };
    const head = String(args.head);
    const base = String(args.base);
    const headSha = repo.tip(head);
    const baseSha = repo.tip(base);
    if (!headSha || !baseSha) return { toolError: `Branch ${!headSha ? head : base} not found` };
    const pr: PullRequest = {
      number: repo.nextNumber,
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      merged: false,
      mergedAt: '',
      mergeCommitSha: '',
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      seq: repo.seq,
    };
    repo.seq += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pr.number, pr);
    return { result: toolText(pullJson(forge, repo, pr)) };
  }
  if (find('getpullrequest')) {
    const tool = TOOLS[7];
    const miss = missing(tool);
    if (miss.length > 0) return { rpcError: { code: -32602, message: `Missing required argument(s): ${miss.join(', ')}` } };
    const repo = lookup(forge, args);
    if (!repo) return { toolError: `Repository ${args.owner}/${args.repo} not found` };
    const num = Number(args.pull_number ?? args.number);
    const pr = repo.pulls.get(num);
    if (!pr) return { toolError: `Pull request ${num} not found` };
    return { result: toolText(pullJson(forge, repo, pr)) };
  }
  if (find('mergepullrequest')) {
    const tool = TOOLS[8];
    const miss = missing(tool);
    if (miss.length > 0) return { rpcError: { code: -32602, message: `Missing required argument(s): ${miss.join(', ')}` } };
    const repo = lookup(forge, args);
    if (!repo) return { toolError: `Repository ${args.owner}/${args.repo} not found` };
    const num = Number(args.pull_number ?? args.number);
    const pr = repo.pulls.get(num);
    if (!pr) return { toolError: `Pull request ${num} not found` };
    const result = squashMerge(forge, repo, pr);
    if (!result.ok) return { toolError: result.message };
    return { result: toolText({ number: pr.number, pull_number: pr.number, merged: true, state: 'closed', sha: result.sha }) };
  }
  return { rpcError: { code: -32601, message: `Method not found: ${name}` } };
}

export async function handleMcp(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (url.pathname !== '/mcp') return false;
  const method = req.method ?? 'GET';
  if (method === 'DELETE') {
    // Legacy session close: best-effort, no content.
    res.writeHead(204);
    res.end();
    return true;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (!requireAuth(req, res, forge)) return true;
  const raw = await readBody(req);
  let payload: unknown;
  try {
    payload = parseJsonBody(raw);
  } catch {
    rpcError(res, 400, null, { code: -32700, message: 'Parse error' });
    return true;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    rpcError(res, 400, null, { code: -32700, message: 'Parse error' });
    return true;
  }
  const msg = payload as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = msg.id ?? null;
  const rpcMethod = typeof msg.method === 'string' ? msg.method : '';
  const params = (msg.params ?? {}) as Record<string, unknown>;

  // Notifications (no id): acknowledge with 202 and no body.
  if (msg.id === undefined) {
    res.writeHead(202);
    res.end();
    return true;
  }

  switch (rpcMethod) {
    case 'server/discover': {
      rpcResult(res, id, {
        supportedVersions: [PROTOCOL_VERSION, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
      });
      return true;
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
      const negotiated = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : PROTOCOL_VERSION;
      rpcResult(res, id, {
        protocolVersion: negotiated,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
      });
      return true;
    }
    case 'ping': {
      rpcResult(res, id, {});
      return true;
    }
    case 'tools/list': {
      rpcResult(res, id, { tools: TOOLS.map(toolJson) });
      return true;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const outcome = callTool(forge, name, args);
      if ('rpcError' in outcome) {
        rpcError(res, 200, id, outcome.rpcError);
        return true;
      }
      if ('toolError' in outcome) {
        rpcResult(res, id, toolErrorText(outcome.toolError));
        return true;
      }
      rpcResult(res, id, outcome.result);
      return true;
    }
    default: {
      rpcError(res, 200, id, { code: -32601, message: `Method not found: ${rpcMethod}` });
      return true;
    }
  }
}

// Referenced to keep the import used by the shared merge path.
void parseCommit;
