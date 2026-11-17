// The forge's store: git objects, repositories, issues, pull requests, labels.
// Everything lives in memory; nothing here reads a clock or randomness, so two
// runs driven with the same requests leave the same state.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// The viewer: the suite's token names a fixed, seeded user. The scenario seed
// and its name tables are published in the kit (sdk/conformance/wire.ts) and
// never change between trials, so the viewer login is derived here with the
// same tiny PRNG rather than guessed from the opaque token.
// ---------------------------------------------------------------------------

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(n: number): number {
    if (n === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % n);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % n;
    }
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.nextInt(arr.length)] as T;
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
] as const;
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
] as const;

/** The login the suite's token names: the first user of the fixed scenario. */
export function deriveViewerLogin(): string {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  return `${first}${last}`.replace(/[^a-z0-9-]/g, '');
}

export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
// Fixed timestamp for every commit the forge itself authors (REST contents,
// squash merges): keeps commit ids deterministic across runs.
export const FORGE_EPOCH = 1735689600; // 2025-01-01T00:00:00Z
export const FORGE_AUTHOR = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${FORGE_EPOCH} +0000`;

// ---------------------------------------------------------------------------
// Git objects
// ---------------------------------------------------------------------------

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id of a git object: sha1("<type> <len>\0" + body). */
export function objectId(type: ObjType, body: Buffer): string {
  const head = Buffer.from(`${type} ${body.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, body]));
}

export function blobId(content: Buffer): string {
  return objectId('blob', content);
}

export interface GitObject {
  type: ObjType;
  body: Buffer;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's body into its fields. */
export function parseCommit(body: Buffer): CommitInfo {
  const text = body.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd < 0 ? text : text.slice(0, headEnd);
  const message = headEnd < 0 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Encode a commit object body. */
export function encodeCommit(c: CommitInfo): Buffer {
  const lines = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.author}`, `committer ${c.committer}`, '', c.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's body. */
export function parseTree(body: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    const nul = body.indexOf(0x00, sp);
    const mode = body.toString('utf8', i, sp);
    const name = body.toString('utf8', sp + 1, nul);
    const oid = body.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

/** Encode a tree object body. Entries are sorted git-style (dirs as name + '/'). */
export function encodeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Repository model
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number; // creation order, for stable sorting
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string;
  mergeCommitSha: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string; // base tip when the PR was opened
  seq: number;
}

export class Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>(); // full refname -> oid
  issues = new Map<number, Issue>();
  pulls = new Map<number, PullRequest>();
  labels = new Map<string, Label>();
  nextNumber = 1; // shared issue + PR counter, GitHub-style
  nextCommentId = 1;
  seq = 0; // creation order counter for issues/PRs

  constructor(id: number, name: string, owner: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.name = name;
    this.owner = owner;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = 'main';
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  refName(branch: string): string {
    return `refs/heads/${branch}`;
  }

  tip(branch: string): string | undefined {
    return this.refs.get(this.refName(branch));
  }

  setTip(branch: string, oid: string): void {
    this.refs.set(this.refName(branch), oid);
  }

  putObject(type: ObjType, body: Buffer): string {
    const oid = objectId(type, body);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, body });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Flat path -> blob oid map for the tree at `treeOid` (empty tree when missing). */
  filesOfTree(treeOid: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (oid: string, prefix: string): void => {
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'tree') return;
      for (const e of parseTree(obj.body)) {
        const path = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.mode === '40000') walk(e.oid, path);
        else out.set(path, e.oid);
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) a tree object from a flat path -> blob oid map. */
  treeFromFiles(files: Map<string, string>): string {
    const build = (paths: Map<string, string>, prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, Map<string, string>>();
      for (const [path, oid] of paths) {
        const rest = prefix ? path.slice(prefix.length + 1) : path;
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: '100644', name: rest, oid });
        } else {
          const dir = rest.slice(0, slash);
          let sub = dirs.get(dir);
          if (!sub) {
            sub = new Map();
            dirs.set(dir, sub);
          }
          sub.set(path, oid);
        }
      }
      for (const [dir, sub] of dirs) {
        const subPrefix = prefix ? `${prefix}/${dir}` : dir;
        entries.push({ mode: '40000', name: dir, oid: build(sub, subPrefix) });
      }
      const body = encodeTree(entries);
      return this.putObject('tree', body);
    };
    return build(files, '');
  }

  /** Create a commit on top of `parents` with the given tree and message. */
  makeCommit(tree: string, parents: string[], message: string): string {
    const body = encodeCommit({
      tree,
      parents,
      author: FORGE_AUTHOR,
      committer: FORGE_AUTHOR,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    return this.putObject('commit', body);
  }

  /** All commit oids reachable from `tipOid`, tip-first, parents after. */
  reachableCommits(tipOid: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tipOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(oid);
      const info = parseCommit(obj.body);
      // Push in reverse so the first parent is visited first.
      for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i]);
    }
    return out;
  }

  /** True when `ancestor` is reachable from `tip` (or equal). */
  isAncestor(ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    return this.reachableCommits(tip).includes(ancestor);
  }

  /** Diff two trees: changed paths with old/new blob oids. */
  diffTrees(baseTree: string, headTree: string): { path: string; oldOid: string | null; newOid: string | null }[] {
    const base = this.filesOfTree(baseTree);
    const head = this.filesOfTree(headTree);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: { path: string; oldOid: string | null; newOid: string | null }[] = [];
    for (const path of [...paths].sort()) {
      const o = base.get(path) ?? null;
      const n = head.get(path) ?? null;
      if (o !== n) out.push({ path, oldOid: o, newOid: n });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// The forge: all repositories, one viewer.
// ---------------------------------------------------------------------------

export class Forge {
  viewerLogin: string;
  repos = new Map<string, Repo>(); // "owner/name" -> Repo
  nextRepoId = 1;

  constructor() {
    this.viewerLogin = deriveViewerLogin();
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo = new Repo(this.nextRepoId, name, this.viewerLogin, description, isPrivate);
    this.nextRepoId += 1;
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.fullName);
  }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === this.viewerLogin);
  }

  /** Opaque, stable GraphQL id for a repo (never the bare numeric id). */
  repoNodeId(repo: Repo): string {
    return Buffer.from(`R:${repo.id}`, 'utf8').toString('base64');
  }

  issueNodeId(repo: Repo, issue: Issue): string {
    return Buffer.from(`I:${repo.id}:${issue.number}`, 'utf8').toString('base64');
  }

  pullNodeId(repo: Repo, pr: PullRequest): string {
    return Buffer.from(`P:${repo.id}:${pr.number}`, 'utf8').toString('base64');
  }

  commentNodeId(repo: Repo, comment: IssueComment): string {
    return Buffer.from(`C:${repo.id}:${comment.id}`, 'utf8').toString('base64');
  }

  /** Decode a GraphQL node id back to its kind and coordinates. */
  decodeNodeId(id: string): { kind: string; repoId: number; number: number } | null {
    try {
      const text = Buffer.from(id, 'base64').toString('utf8');
      const m = /^([RIPC]):(\d+)(?::(\d+))?$/.exec(text);
      if (!m) return null;
      return { kind: m[1], repoId: Number(m[2]), number: m[3] === undefined ? 0 : Number(m[3]) };
    } catch {
      return null;
    }
  }

  repoByNodeId(id: string): Repo | null {
    const d = this.decodeNodeId(id);
    if (!d || d.kind !== 'R') return null;
    for (const r of this.repos.values()) if (r.id === d.repoId) return r;
    return null;
  }
}
