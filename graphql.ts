// GitHub GraphQL v4 (/api/graphql), for the documents gh and
// github-mcp-server send. A small parser + resolvers over the same store
// REST uses, so every mutation reads back identically over REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  parseJsonBody,
  readBody,
  requireAuth,
  sendError,
  sendJson,
} from './common.ts';
import {
  parseCommit,
  type Forge,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// Minimal GraphQL parser (documents the suite sends: named operations,
// variables, aliases, inline fragments, literal/enum/list/object arguments).
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; type: string; selection: SelectionNode[] };

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: { name: string; type: string; defaultValue: ValueNode | null }[];
  selection: SelectionNode[];
}

class Lexer {
  pos = 0;
  src: string;
  constructor(src: string) {
    this.src = src;
  }
  skipWs(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') this.pos += 1;
      else if (c === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
      } else break;
    }
  }
  peek(): string {
    this.skipWs();
    return this.src[this.pos] ?? '';
  }
  next(): string {
    this.skipWs();
    return this.src[this.pos++] ?? '';
  }
  readName(): string {
    this.skipWs();
    let s = '';
    while (this.pos < this.src.length && /[_A-Za-z0-9]/.test(this.src[this.pos])) s += this.src[this.pos++];
    return s;
  }
  readString(): string {
    // Assumes the current char is '"'.
    this.pos += 1;
    let out = '';
    while (this.pos < this.src.length) {
      const c = this.src[this.pos++];
      if (c === '"') break;
      if (c === '\\') {
        const e = this.src[this.pos++];
        out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
      } else out += c;
    }
    return out;
  }
  readNumber(): string {
    this.skipWs();
    let s = '';
    while (this.pos < this.src.length && /[0-9eE.+-]/.test(this.src[this.pos])) s += this.src[this.pos++];
    return s;
  }
}

function parseValue(lx: Lexer): ValueNode {
  const c = lx.peek();
  if (c === '$') {
    lx.next();
    return { kind: 'variable', name: lx.readName() };
  }
  if (c === '"') return { kind: 'string', value: lx.readString() };
  if (c === '[') {
    lx.next();
    const values: ValueNode[] = [];
    while (lx.peek() !== ']') values.push(parseValue(lx));
    lx.next();
    return { kind: 'list', values };
  }
  if (c === '{') {
    lx.next();
    const fields: { name: string; value: ValueNode }[] = [];
    while (lx.peek() !== '}') {
      const name = lx.readName();
      if (lx.next() !== ':') throw new Error('expected : in object value');
      fields.push({ name, value: parseValue(lx) });
    }
    lx.next();
    return { kind: 'object', fields };
  }
  if (c === '-' || /[0-9]/.test(c)) {
    const n = lx.readNumber();
    return n.includes('.') || n.includes('e') || n.includes('E')
      ? { kind: 'float', value: Number(n) }
      : { kind: 'int', value: Number(n) };
  }
  const name = lx.readName();
  if (name === 'true') return { kind: 'boolean', value: true };
  if (name === 'false') return { kind: 'boolean', value: false };
  if (name === 'null') return { kind: 'null' };
  return { kind: 'enum', value: name };
}

function parseSelectionSet(lx: Lexer): SelectionNode[] {
  if (lx.next() !== '{') throw new Error('expected {');
  const sels: SelectionNode[] = [];
  while (lx.peek() !== '}') {
    if (lx.peek() === '.') {
      // ... on Type { ... } (inline fragment) or ...Name (named fragment ref).
      lx.next();
      lx.next();
      lx.next();
      const word = lx.readName();
      const type = word === 'on' ? lx.readName() : word;
      sels.push({ kind: 'fragment', type, selection: parseSelectionSet(lx) });
      continue;
    }
    const first = lx.readName();
    let alias: string | null = null;
    let name = first;
    if (lx.peek() === ':') {
      lx.next();
      alias = first;
      name = lx.readName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (lx.peek() === '(') {
      lx.next();
      while (lx.peek() !== ')') {
        const argName = lx.readName();
        if (lx.next() !== ':') throw new Error('expected : in argument');
        args.push({ name: argName, value: parseValue(lx) });
      }
      lx.next();
    }
    let selection: SelectionNode[] | null = null;
    if (lx.peek() === '{') selection = parseSelectionSet(lx);
    sels.push({ kind: 'field', field: { alias, name, args, selection } });
  }
  lx.next();
  return sels;
}

function parseType(lx: Lexer): string {
  let t = '';
  const c = lx.peek();
  if (c === '[') {
    lx.next();
    t = `[${parseType(lx)}]`;
    if (lx.next() !== ']') throw new Error('expected ] in type');
  } else {
    t = lx.readName();
  }
  if (lx.peek() === '!') {
    lx.next();
    t += '!';
  }
  return t;
}

export function parseDocument(src: string): Operation[] {
  const lx = new Lexer(src);
  const ops: Operation[] = [];
  while (lx.peek() !== '') {
    const c = lx.peek();
    let kind: 'query' | 'mutation' = 'query';
    if (c === '{') {
      ops.push({ kind: 'query', name: null, varDefs: [], selection: parseSelectionSet(lx) });
      continue;
    }
    const kw = lx.readName();
    if (kw === 'query' || kw === 'mutation') {
      kind = kw;
    } else if (kw === 'fragment') {
      // Named fragments are not sent by the suite; skip one if present.
      lx.readName();
      if (lx.peek() === '{') parseSelectionSet(lx);
      continue;
    } else {
      throw new Error(`unexpected document keyword ${kw}`);
    }
    let name: string | null = null;
    if (/[_A-Za-z]/.test(lx.peek())) name = lx.readName();
    const varDefs: Operation['varDefs'] = [];
    if (lx.peek() === '(') {
      lx.next();
      while (lx.peek() !== ')') {
        if (lx.peek() === '$') lx.next();
        const vname = lx.readName();
        if (lx.next() !== ':') throw new Error('expected : in variable definition');
        const type = parseType(lx);
        let defaultValue: ValueNode | null = null;
        if (lx.peek() === '=') {
          lx.next();
          defaultValue = parseValue(lx);
        }
        varDefs.push({ name: vname, type, defaultValue });
      }
      lx.next();
    }
    ops.push({ kind, name, varDefs, selection: parseSelectionSet(lx) });
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Value resolution
// ---------------------------------------------------------------------------

type Vars = Record<string, unknown>;

function evalValue(node: ValueNode, vars: Vars): unknown {
  switch (node.kind) {
    case 'variable': {
      const v = vars[node.name];
      return v === undefined ? null : v;
    }
    case 'string':
    case 'enum':
      return node.value;
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((v) => evalValue(v, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = evalValue(f.value, vars);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, vars: Vars): unknown {
  const a = field.args.find((x) => x.name === name);
  return a === undefined ? undefined : evalValue(a.value, vars);
}

// ---------------------------------------------------------------------------
// Introspection tables
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'url', 'createdAt', 'updatedAt', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface Ctx {
  forge: Forge;
  vars: Vars;
  errors: { message: string }[];
}

function cursorOf(seq: number): string {
  return Buffer.from(`c:${seq}`, 'utf8').toString('base64');
}

function seqOfCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^c:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function nodesSelection(field: FieldNode): SelectionNode[] {
  const nodesField = (field.selection ?? []).find((s) => s.kind === 'field' && s.field.name === 'nodes');
  return nodesField && nodesField.kind === 'field' ? (nodesField.field.selection ?? []) : [];
}

function checkConnectionFields(ctx: Ctx, field: FieldNode, type: string): void {
  for (const sel of field.selection ?? []) {
    if (sel.kind !== 'field') continue;
    if (!['nodes', 'pageInfo', 'totalCount'].includes(sel.field.name)) {
      ctx.errors.push({ message: `Cannot query field "${sel.field.name}" on type "${type}".` });
    }
  }
}

function resolveUser(ctx: Ctx, login: string, sels: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind !== 'field') continue;
    const f = sel.field;
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'login': out[key] = login; break;
      case 'id': out[key] = Buffer.from(`U:${login}`, 'utf8').toString('base64'); break;
      case 'name': out[key] = login; break;
      case 'email': out[key] = `${login}@example.invalid`; break;
      default:
        ctx.errors.push({ message: `Cannot query field "${f.name}" on type "User".` });
        break;
    }
  }
  return out;
}

function resolveIssues(ctx: Ctx, repo: Repo, field: FieldNode): Record<string, unknown> {
  checkConnectionFields(ctx, field, 'IssueConnection');
  const first = argValue(field, 'first', ctx.vars) as number | undefined;
  const states = argValue(field, 'states', ctx.vars) as string[] | undefined;
  const orderBy = argValue(field, 'orderBy', ctx.vars) as { field?: string; direction?: string } | undefined;
  const after = argValue(field, 'after', ctx.vars) as string | null | undefined;
  let list = [...repo.issues.values()];
  if (states && states.length > 0) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const dir = orderBy?.direction === 'ASC' ? 1 : -1;
  list.sort((a, b) => (a.seq - b.seq) * dir);
  const afterSeq = seqOfCursor(after);
  if (afterSeq !== null) {
    list = list.filter((i) => (dir === 1 ? i.seq > afterSeq : i.seq < afterSeq));
  }
  const total = list.length;
  const limited = typeof first === 'number' ? list.slice(0, first) : list;
  const nodeSels = nodesSelection(field);
  const nodes = limited.map((i) => resolveIssue(ctx, repo, i, nodeSels));
  const hasNext = limited.length < total;
  const endCursor = limited.length > 0 ? cursorOf(limited[limited.length - 1].seq) : null;
  return {
    nodes,
    totalCount: repo.issues.size,
    pageInfo: { hasNextPage: hasNext, hasPreviousPage: false, startCursor: limited.length > 0 ? cursorOf(limited[0].seq) : null, endCursor },
  };
}

function resolveIssue(ctx: Ctx, repo: Repo, issue: Issue, sels: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind !== 'field') continue;
    const f = sel.field;
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id': out[key] = ctx.forge.issueNodeId(repo, issue); break;
      case 'number': out[key] = issue.number; break;
      case 'title': out[key] = issue.title; break;
      case 'state': out[key] = issue.state.toUpperCase(); break;
      case 'body': out[key] = issue.body; break;
      case 'url': out[key] = `https://example.invalid/${repo.fullName}/issues/${issue.number}`; break;
      case 'createdAt': case 'updatedAt': out[key] = '2025-01-01T00:00:00Z'; break;
      case 'author': out[key] = resolveUser(ctx, ctx.forge.viewerLogin, f.selection ?? []); break;
      default:
        ctx.errors.push({ message: `Cannot query field "${f.name}" on type "Issue".` });
        break;
    }
  }
  return out;
}

function prMergeable(ctx: Ctx, repo: Repo, pr: PullRequest): string {
  const baseTip = repo.tip(pr.baseRef);
  if (!baseTip || baseTip === pr.baseSha) return 'MERGEABLE';
  const baseInfo = parseCommit(repo.getObject(pr.baseSha)?.body ?? Buffer.alloc(0));
  const newBaseInfo = parseCommit(repo.getObject(baseTip)?.body ?? Buffer.alloc(0));
  const headInfo = parseCommit(repo.getObject(pr.headSha)?.body ?? Buffer.alloc(0));
  const prChanges = repo.diffTrees(baseInfo.tree, headInfo.tree).map((d) => d.path);
  const baseChanges = repo.diffTrees(baseInfo.tree, newBaseInfo.tree);
  const baseChanged = new Map(baseChanges.map((d) => [d.path, d.newOid]));
  const oldBaseFiles = repo.filesOfTree(baseInfo.tree);
  for (const p of prChanges) {
    if (baseChanged.has(p) && baseChanged.get(p) !== oldBaseFiles.get(p)) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function resolvePull(ctx: Ctx, repo: Repo, pr: PullRequest, sels: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind !== 'field') continue;
    const f = sel.field;
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id': out[key] = ctx.forge.pullNodeId(repo, pr); break;
      case 'number': out[key] = pr.number; break;
      case 'title': out[key] = pr.title; break;
      case 'body': out[key] = pr.body; break;
      case 'state': out[key] = pr.merged ? 'MERGED' : pr.state.toUpperCase(); break;
      case 'merged': out[key] = pr.merged; break;
      case 'headRefName': out[key] = pr.headRef; break;
      case 'baseRefName': out[key] = pr.baseRef; break;
      case 'mergeable': out[key] = prMergeable(ctx, repo, pr); break;
      case 'url': out[key] = `https://example.invalid/${repo.fullName}/pull/${pr.number}`; break;
      case 'createdAt': case 'updatedAt': out[key] = '2025-01-01T00:00:00Z'; break;
      case 'author': out[key] = resolveUser(ctx, ctx.forge.viewerLogin, f.selection ?? []); break;
      case 'files': {
        const first = argValue(f, 'first', ctx.vars) as number | undefined;
        const baseInfo = parseCommit(repo.getObject(pr.baseSha)?.body ?? Buffer.alloc(0));
        const headInfo = parseCommit(repo.getObject(pr.headSha)?.body ?? Buffer.alloc(0));
        const diffs = repo.diffTrees(baseInfo.tree, headInfo.tree);
        const fileSels = nodesSelection(f);
        const countLines = (oid: string | null): number => {
          if (!oid) return 0;
          const obj = repo.getObject(oid);
          if (!obj) return 0;
          const text = obj.body.toString('utf8');
          return text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        };
        const nodes = (typeof first === 'number' ? diffs.slice(0, first) : diffs).map((d) => {
          const out: Record<string, unknown> = {};
          const sels = fileSels.length > 0 ? fileSels : [{ kind: 'field', field: { alias: null, name: 'path', args: [], selection: null } } as SelectionNode];
          for (const sel of sels) {
            if (sel.kind !== 'field') continue;
            const key = sel.field.alias ?? sel.field.name;
            if (sel.field.name === 'path') out[key] = d.path;
            else if (sel.field.name === 'additions') out[key] = countLines(d.newOid);
            else if (sel.field.name === 'deletions') out[key] = countLines(d.oldOid);
            else if (sel.field.name === 'changeType') out[key] = d.oldOid === null ? 'ADDED' : d.newOid === null ? 'DELETED' : 'MODIFIED';
            else ctx.errors.push({ message: `Cannot query field "${sel.field.name}" on type "PullRequestChangedFile".` });
          }
          return out;
        });
        out[key] = { nodes, totalCount: diffs.length };
        break;
      }
      default:
        ctx.errors.push({ message: `Cannot query field "${f.name}" on type "PullRequest".` });
        break;
    }
  }
  return out;
}

function resolveRepository(ctx: Ctx, repo: Repo, sels: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind !== 'field') continue;
    const f = sel.field;
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id': out[key] = ctx.forge.repoNodeId(repo); break;
      case 'databaseId': out[key] = repo.id; break;
      case 'name': out[key] = repo.name; break;
      case 'nameWithOwner': out[key] = repo.fullName; break;
      case 'description': out[key] = repo.description; break;
      case 'url': out[key] = `https://example.invalid/${repo.fullName}`; break;
      case 'createdAt': case 'updatedAt': out[key] = '2025-01-01T00:00:00Z'; break;
      case 'owner': out[key] = resolveUser(ctx, repo.owner, f.selection ?? []); break;
      case 'defaultBranchRef': {
        const tip = repo.tip(repo.defaultBranch);
        out[key] = tip ? { name: repo.defaultBranch } : null;
        break;
      }
      case 'viewerPermission': out[key] = 'ADMIN'; break;
      case 'hasIssuesEnabled': out[key] = true; break;
      case 'issue': {
        const num = argValue(f, 'number', ctx.vars) as number | undefined;
        const issue = num === undefined ? undefined : repo.issues.get(num);
        out[key] = issue ? resolveIssue(ctx, repo, issue, f.selection ?? []) : null;
        break;
      }
      case 'issues': out[key] = resolveIssues(ctx, repo, f); break;
      case 'pullRequests': {
        checkConnectionFields(ctx, f, 'PullRequestConnection');
        const first = argValue(f, 'first', ctx.vars) as number | undefined;
        let list = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq);
        if (typeof first === 'number') list = list.slice(0, first);
        const nodeSels = nodesSelection(f);
        out[key] = { nodes: list.map((p) => resolvePull(ctx, repo, p, nodeSels)), totalCount: repo.pulls.size };
        break;
      }
      case 'pullRequest': {
        const num = argValue(f, 'number', ctx.vars) as number | undefined;
        const pr = num === undefined ? undefined : repo.pulls.get(num);
        out[key] = pr ? resolvePull(ctx, repo, pr, f.selection ?? []) : null;
        break;
      }
      default:
        ctx.errors.push({ message: `Cannot query field "${f.name}" on type "Repository".` });
        break;
    }
  }
  return out;
}

function resolveTypeField(ctx: Ctx, field: FieldNode): Record<string, unknown> | null {
  const name = argValue(field, 'name', ctx.vars) as string | undefined;
  if (!name) return null;
  const out: Record<string, unknown> = { name, kind: TYPE_ENUMS[name] ? 'ENUM' : 'OBJECT' };
  const sub = field.selection ?? [];
  for (const sel of sub) {
    if (sel.kind !== 'field') continue;
    if (sel.field.name === 'fields') {
      const names = TYPE_FIELDS[name] ?? [];
      out[sel.field.alias ?? 'fields'] = names.map((n) => ({ name: n }));
    } else if (sel.field.name === 'enumValues') {
      const vals = TYPE_ENUMS[name] ?? [];
      out[sel.field.alias ?? 'enumValues'] = vals.map((n) => ({ name: n }));
    } else if (sel.field.name === 'name') {
      out[sel.field.alias ?? 'name'] = name;
    } else if (sel.field.name === 'kind') {
      out[sel.field.alias ?? 'kind'] = out.kind;
    }
  }
  return out;
}

function resolveNode(ctx: Ctx, id: string, sels: SelectionNode[]): Record<string, unknown> | null {
  const d = ctx.forge.decodeNodeId(id);
  if (!d) return null;
  if (d.kind === 'R') {
    for (const repo of ctx.forge.repos.values()) {
      if (repo.id !== d.repoId) continue;
      const out: Record<string, unknown> = { id };
      for (const sel of sels) {
        if (sel.kind === 'fragment') {
          if (sel.type === 'Repository') {
            Object.assign(out, resolveRepository(ctx, repo, sel.selection));
          }
          continue;
        }
        if (sel.field.name === 'id') out[sel.field.alias ?? 'id'] = id;
        else if (sel.field.name === '__typename') out[sel.field.alias ?? '__typename'] = 'Repository';
      }
      return out;
    }
    return null;
  }
  if (d.kind === 'I' || d.kind === 'P') {
    for (const repo of ctx.forge.repos.values()) {
      if (repo.id !== d.repoId) continue;
      const out: Record<string, unknown> = { id };
      for (const sel of sels) {
        if (sel.kind === 'fragment') continue;
        if (sel.field.name === 'id') out[sel.field.alias ?? 'id'] = id;
      }
      return out;
    }
  }
  return null;
}

/** The squash merge shared by REST and GraphQL: returns the merge commit or an error. */
export function squashMerge(forge: Forge, repo: Repo, pr: PullRequest): { ok: true; sha: string } | { ok: false; status: number; message: string } {
  if (pr.merged || pr.state === 'closed') return { ok: false, status: 405, message: 'Pull Request is already merged' };
  const baseTip = repo.tip(pr.baseRef);
  if (!baseTip) return { ok: false, status: 404, message: 'Not Found' };
  if (baseTip !== pr.baseSha) {
    const baseInfo = parseCommit(repo.getObject(pr.baseSha)?.body ?? Buffer.alloc(0));
    const newBaseInfo = parseCommit(repo.getObject(baseTip)?.body ?? Buffer.alloc(0));
    const headInfo = parseCommit(repo.getObject(pr.headSha)?.body ?? Buffer.alloc(0));
    const prChanges = repo.diffTrees(baseInfo.tree, headInfo.tree).map((x) => x.path);
    const baseChanges = repo.diffTrees(baseInfo.tree, newBaseInfo.tree);
    const baseChanged = new Map(baseChanges.map((x) => [x.path, x.newOid]));
    const oldBaseFiles = repo.filesOfTree(baseInfo.tree);
    for (const p of prChanges) {
      if (baseChanged.has(p) && baseChanged.get(p) !== oldBaseFiles.get(p)) {
        return { ok: false, status: 405, message: 'Pull Request is not mergeable' };
      }
    }
  }
  const headInfo = parseCommit(repo.getObject(pr.headSha)?.body ?? Buffer.alloc(0));
  const mergeCommit = repo.makeCommit(headInfo.tree, [baseTip], `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}`);
  repo.setTip(pr.baseRef, mergeCommit);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = '2025-01-01T00:00:00Z';
  pr.mergeCommitSha = mergeCommit;
  return { ok: true, sha: mergeCommit };
}

function executeOperation(ctx: Ctx, op: Operation): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const isMutation = op.kind === 'mutation';
  for (const sel of op.selection) {
    if (sel.kind !== 'field') continue;
    const f = sel.field;
    const key = f.alias ?? f.name;
    if (!isMutation) {
      switch (f.name) {
        case 'viewer':
          data[key] = resolveUser(ctx, ctx.forge.viewerLogin, f.selection ?? []);
          break;
        case 'repository': {
          const owner = argValue(f, 'owner', ctx.vars) as string | undefined;
          const name = argValue(f, 'name', ctx.vars) as string | undefined;
          const repo = owner !== undefined && name !== undefined ? ctx.forge.getRepo(owner, name) : undefined;
          data[key] = repo ? resolveRepository(ctx, repo, f.selection ?? []) : null;
          break;
        }
        case 'node': {
          const id = argValue(f, 'id', ctx.vars) as string | undefined;
          data[key] = id === undefined ? null : resolveNode(ctx, id, f.selection ?? []);
          break;
        }
        case '__type':
          data[key] = resolveTypeField(ctx, f);
          break;
        default:
          ctx.errors.push({ message: `Cannot query field "${f.name}" on type "Query".` });
          break;
      }
    } else {
      const input = argValue(f, 'input', ctx.vars) as Record<string, unknown> | undefined ?? {};
      switch (f.name) {
        case 'createIssue': {
          const repo = ctx.forge.repoByNodeId(String(input.repositoryId ?? ''));
          if (!repo) {
            ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
            break;
          }
          const issue: Issue = {
            number: repo.nextNumber,
            title: String(input.title ?? ''),
            body: typeof input.body === 'string' ? input.body : '',
            state: 'open',
            labels: [],
            comments: [],
            seq: repo.seq,
          };
          repo.seq += 1;
          repo.nextNumber += 1;
          repo.issues.set(issue.number, issue);
          data[key] = { issue: { number: issue.number, id: ctx.forge.issueNodeId(repo, issue) } };
          break;
        }
        case 'closeIssue': {
          const d = ctx.forge.decodeNodeId(String(input.issueId ?? ''));
          let found: { repo: Repo; issue: Issue } | null = null;
          if (d && d.kind === 'I') {
            for (const repo of ctx.forge.repos.values()) {
              if (repo.id !== d.repoId) continue;
              const issue = repo.issues.get(d.number);
              if (issue) found = { repo, issue };
            }
          }
          if (!found) {
            ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
            break;
          }
          found.issue.state = 'closed';
          data[key] = { issue: { number: found.issue.number, id: ctx.forge.issueNodeId(found.repo, found.issue), state: 'CLOSED' } };
          break;
        }
        case 'createPullRequest': {
          const repo = ctx.forge.repoByNodeId(String(input.repositoryId ?? ''));
          if (!repo) {
            ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
            break;
          }
          const head = String(input.headRefName ?? '');
          const base = String(input.baseRefName ?? '');
          const headSha = repo.tip(head);
          const baseSha = repo.tip(base);
          if (!headSha || !baseSha) {
            ctx.errors.push({ message: 'Validation Failed' });
            break;
          }
          const pr: PullRequest = {
            number: repo.nextNumber,
            title: String(input.title ?? ''),
            body: typeof input.body === 'string' ? input.body : '',
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
          data[key] = { pullRequest: { number: pr.number, id: ctx.forge.pullNodeId(repo, pr), state: 'OPEN', headRefName: head, baseRefName: base } };
          break;
        }
        case 'mergePullRequest': {
          const d = ctx.forge.decodeNodeId(String(input.pullRequestId ?? ''));
          let found: { repo: Repo; pr: PullRequest } | null = null;
          if (d && d.kind === 'P') {
            for (const repo of ctx.forge.repos.values()) {
              if (repo.id !== d.repoId) continue;
              const pr = repo.pulls.get(d.number);
              if (pr) found = { repo, pr };
            }
          }
          if (!found) {
            ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
            break;
          }
          const result = squashMerge(ctx.forge, found.repo, found.pr);
          if (!result.ok) {
            ctx.errors.push({ message: result.message });
            break;
          }
          data[key] = { pullRequest: { number: found.pr.number, merged: true, state: 'MERGED' } };
          break;
        }
        case 'addComment': {
          const d = ctx.forge.decodeNodeId(String(input.subjectId ?? ''));
          let found: { repo: Repo; issue: Issue } | null = null;
          if (d && d.kind === 'I') {
            for (const repo of ctx.forge.repos.values()) {
              if (repo.id !== d.repoId) continue;
              const issue = repo.issues.get(d.number);
              if (issue) found = { repo, issue };
            }
          }
          if (!found) {
            ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
            break;
          }
          const comment = { id: found.repo.nextCommentId, body: String(input.body ?? ''), userLogin: ctx.forge.viewerLogin };
          found.repo.nextCommentId += 1;
          found.issue.comments.push(comment);
          data[key] = { commentEdge: { node: { id: ctx.forge.commentNodeId(found.repo, comment), body: comment.body } } };
          break;
        }
        default:
          ctx.errors.push({ message: `Cannot query field "${f.name}" on type "Mutation".` });
          break;
      }
    }
  }
  return data;
}

export async function handleGraphQL(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (url.pathname !== '/api/graphql') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendError(res, 404, 'Not Found');
    return true;
  }
  if (!requireAuth(req, res, forge)) return true;
  const raw = await readBody(req);
  let payload: unknown;
  try {
    payload = parseJsonBody(raw);
  } catch {
    sendError(res, 400, 'Problems parsing JSON');
    return true;
  }
  const runOne = (op: { query?: unknown; variables?: unknown }): Record<string, unknown> => {
    const ctx: Ctx = { forge, vars: {}, errors: [] };
    const query = typeof op.query === 'string' ? op.query : '';
    const vars = (op.variables ?? {}) as Vars;
    ctx.vars = vars;
    let data: Record<string, unknown> = {};
    try {
      const ops = parseDocument(query);
      const opToRun = ops[0];
      if (!opToRun) {
        ctx.errors.push({ message: 'No operation provided.' });
      } else {
        data = executeOperation(ctx, opToRun);
      }
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
    }
    const out: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) out.errors = ctx.errors;
    return out;
  };
  if (Array.isArray(payload)) {
    sendJson(res, 200, payload.map((p) => runOne(p as { query?: unknown; variables?: unknown })));
    return true;
  }
  sendJson(res, 200, runOne(payload as { query?: unknown; variables?: unknown }));
  return true;
}
