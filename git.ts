// Git smart HTTP: protocol v2 + v0 upload-pack, v0 receive-pack, packfile
// read/write with delta resolution, shallow fetch. No git binary anywhere:
// pkt-lines, packfiles and object walks are implemented here on node:zlib
// and node:crypto, per sdk/conformance/checks-git.ts and git-client.ts.

import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, requireAuth, sendJson } from './common.ts';
import {
  objectId,
  parseCommit,
  parseTree,
  type Forge,
  type GitObject,
  type ObjType,
  type Repo,
} from './store.ts';

const ZERO_OID = '0'.repeat(40);
const AGENT = 'forge/1.0';

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

type PktItem = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Parse pkt-lines from `buf` starting at `start`. Returns items and the offset past them. */
export function parsePktLines(buf: Buffer, start = 0): { items: PktItem[]; offset: number; error?: string } {
  const items: PktItem[] = [];
  let i = start;
  while (i + 4 <= buf.length) {
    const head = buf.toString('ascii', i, i + 4);
    if (head === '0000') {
      items.push({ kind: 'flush' });
      i += 4;
      continue;
    }
    if (head === '0001') {
      items.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (head === '0002') {
      items.push({ kind: 'end' });
      i += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || len > 65520) {
      return { items, offset: i, error: `bad pkt-line length ${JSON.stringify(head)}` };
    }
    if (i + len > buf.length) {
      return { items, offset: i, error: 'truncated pkt-line' };
    }
    items.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  if (i !== buf.length) return { items, offset: i, error: 'trailing bytes in pkt-line stream' };
  return { items, offset: i };
}

/** Parse pkt-lines until the first flush; returns the data lines and the offset after the flush. */
function parseUntilFlush(buf: Buffer): { lines: string[]; offset: number; error?: string } {
  const parsed = parsePktLines(buf);
  if (parsed.error) return { lines: [], offset: 0, error: parsed.error };
  const lines: string[] = [];
  let offset = 0;
  for (const item of parsed.items) {
    if (item.kind === 'flush') {
      // Recompute the byte offset of the flush end by re-walking.
      let j = 0;
      for (const it of parsed.items) {
        if (it.kind === 'data') j += it.payload.length + 4;
        else j += 4;
        if (it === item) break;
      }
      offset = j;
      return { lines, offset };
    }
    if (item.kind === 'data') lines.push(item.payload.toString('utf8'));
  }
  return { lines, offset: buf.length };
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const PACK_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Inflate one zlib stream at the start of `buf`; returns the data and bytes consumed. */
function inflateOne(buf: Buffer, expectedSize: number): { data: Buffer; consumed: number } {
  const r = inflateSync(buf, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  if (r.buffer.length !== expectedSize) {
    throw new Error(`pack entry inflated to ${r.buffer.length} bytes, expected ${expectedSize}`);
  }
  const consumed = r.engine?.bytesWritten;
  if (typeof consumed === 'number' && consumed > 0 && consumed <= buf.length) {
    return { data: r.buffer, consumed };
  }
  // Fallback: binary-search the smallest prefix that inflates to the size.
  let lo = 1;
  let hi = buf.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      const out = inflateSync(buf.subarray(0, mid));
      if (out.length === expectedSize) hi = mid;
      else lo = mid + 1;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(buf.subarray(0, lo)), consumed: lo };
}

function readVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = buf[pos] & 0x7f;
  let next = pos + 1;
  let shift = 7;
  while (buf[pos] & 0x80) {
    value |= (buf[next] & 0x7f) << shift;
    shift += 7;
    pos = next;
    next += 1;
  }
  return { value, next };
}

/** Apply a git delta to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVar = (): number => {
    let v = 0;
    let shift = 0;
    while (true) {
      const b = delta[pos++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return v;
  };
  const srcSize = readVar();
  const tgtSize = readVar();
  if (srcSize !== base.length) throw new Error('delta source size does not match base length');
  const parts: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) offset |= delta[pos++] << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) size |= delta[pos++] << (8 * i);
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
      total += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== tgtSize) throw new Error('delta output size mismatch');
  return out;
}

export interface PackEntry {
  type: ObjType;
  body: Buffer;
  oid: string;
}

/** Parse a whole packfile. `resolveBase` supplies objects the pack references but does not carry. */
export function readPack(buf: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  const actual = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest('hex');
  if (trailer !== actual) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, string>();
  let pos = 12;
  const end = buf.length - 20;
  // First pass: read raw entries, remembering offsets for OFS_DELTA.
  const raw: { offset: number; type: ObjType | 'ofs' | 'ref'; size: number; body: Buffer; baseOid?: string; baseOffset?: number }[] = [];
  for (let n = 0; n < count; n += 1) {
    const entryOffset = pos;
    let byte = buf[pos++];
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[pos++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // OFS_DELTA: negative offset varint.
      let b = buf[pos++];
      let off = b & 0x7f;
      while (b & 0x80) {
        b = buf[pos++];
        off = ((off + 1) << 7) | (b & 0x7f);
      }
      const baseOffset = entryOffset - off;
      const { data, consumed } = inflateOne(buf.subarray(pos), size);
      pos += consumed;
      raw.push({ offset: entryOffset, type: 'ofs', size, body: data, baseOffset });
    } else if (typeCode === 7) {
      const baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const { data, consumed } = inflateOne(buf.subarray(pos), size);
      pos += consumed;
      raw.push({ offset: entryOffset, type: 'ref', size, body: data, baseOid });
    } else {
      const type = PACK_TYPE[typeCode];
      if (!type) throw new Error(`unknown pack entry type ${typeCode}`);
      const { data, consumed } = inflateOne(buf.subarray(pos), size);
      pos += consumed;
      const oid = objectId(type, data);
      objects.set(oid, { type, body: data });
      byOffset.set(entryOffset, oid);
      raw.push({ offset: entryOffset, type, size, body: data });
    }
  }
  if (pos !== end) throw new Error('pack has stray bytes before the trailer');
  // Second pass: resolve deltas (recursively, with cycle detection).
  const resolve = (entry: (typeof raw)[number], seen: Set<number>): GitObject => {
    if (entry.type !== 'ofs' && entry.type !== 'ref') {
      return { type: entry.type as ObjType, body: entry.body };
    }
    if (seen.has(entry.offset)) throw new Error('pack delta cycle');
    seen.add(entry.offset);
    let base: GitObject | undefined;
    if (entry.type === 'ofs') {
      const baseOid = byOffset.get(entry.baseOffset as number);
      if (baseOid) base = objects.get(baseOid);
      if (!base) {
        const baseEntry = raw.find((e) => e.offset === (entry.baseOffset as number));
        if (baseEntry) base = resolve(baseEntry, seen);
      }
    } else {
      base = objects.get(entry.baseOid as string) ?? resolveBase?.(entry.baseOid as string);
      if (!base) {
        const baseEntry = raw.find((e) => e.type !== 'ofs' && e.type !== 'ref' && objectId(e.type as ObjType, e.body) === entry.baseOid);
        if (baseEntry) base = resolve(baseEntry, seen);
      }
    }
    if (!base) throw new Error(`delta base ${entry.type === 'ref' ? entry.baseOid : entry.baseOffset} not found`);
    const body = applyDelta(base.body, entry.body);
    return { type: base.type, body };
  };
  for (const entry of raw) {
    if (entry.type === 'ofs' || entry.type === 'ref') {
      const obj = resolve(entry, new Set());
      const oid = objectId(obj.type, obj.body);
      if (!objects.has(oid)) objects.set(oid, obj);
      byOffset.set(entry.offset, oid);
    }
  }
  if (objects.size !== count && raw.filter((e) => e.type === 'ofs' || e.type === 'ref').length > 0) {
    // Deltas may duplicate objects already present; the count check is on entries.
  }
  return objects;
}

/** Write a packfile (version 2, no deltas) for the given objects. */
export function writePack(entries: { type: ObjType; body: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  parts.push(head);
  for (const e of entries) {
    const code = PACK_TYPE_CODE[e.type];
    const size = e.body.length;
    const headerBytes: number[] = [];
    let b = (code << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) b |= 0x80;
    headerBytes.push(b);
    while (rest > 0) {
      let nb = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) nb |= 0x80;
      headerBytes.push(nb);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(e.body, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Split pack bytes into sideband band-1 pkt-lines (payload ≤ 65515 data bytes). */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < pack.length; i += 65515) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + 65515));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

// ---------------------------------------------------------------------------
// Reachability / fetch planning
// ---------------------------------------------------------------------------

interface FetchPlan {
  objects: { type: ObjType; body: Buffer }[];
  shallowOut: string[];
  unshallowOut: string[];
}

function collectFetchObjects(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowIn: string[],
  deepen: number | undefined,
): FetchPlan {
  // Held commits: reachable from haves without crossing a shallow boundary.
  // Held objects: those commits plus their trees and blobs — an incremental
  // fetch must not re-send anything the client already holds.
  const held = new Set<string>();
  const heldObjects = new Set<string>();
  const shallowSet = new Set(shallowIn);
  const walkHeld = (start: string): void => {
    const stack = [start];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (held.has(oid)) continue;
      const obj = repo.getObject(oid);
      if (!obj || obj.type !== 'commit') continue;
      held.add(oid);
      heldObjects.add(oid);
      const info = parseCommit(obj.body);
      const addTreeHeld = (treeOid: string): void => {
        if (heldObjects.has(treeOid)) return;
        const tree = repo.getObject(treeOid);
        if (!tree) return;
        heldObjects.add(treeOid);
        for (const e of parseTree(tree.body)) {
          if (e.mode === '40000') addTreeHeld(e.oid);
          else if (e.mode !== '160000') heldObjects.add(e.oid);
        }
      };
      addTreeHeld(info.tree);
      if (shallowSet.has(oid)) continue; // boundary: parents are not held
      for (const p of info.parents) stack.push(p);
    }
  };
  for (const h of haves) walkHeld(h);

  // BFS from wants by generation distance.
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const w of wants) {
    if (!dist.has(w)) {
      dist.set(w, 0);
      queue.push(w);
    }
  }
  const included = new Set<string>();
  const tagObjects = new Set<string>();
  const boundary = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const d = dist.get(oid) as number;
    const obj = repo.getObject(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      tagObjects.add(oid);
      // Walk the tag target at the same distance.
      const target = parseTagTarget(obj.body);
      if (target && !dist.has(target)) {
        dist.set(target, d);
        queue.push(target);
      }
      continue;
    }
    if (obj.type !== 'commit') continue;
    if (held.has(oid)) {
      // Held: do not send, but still descend when the fetch goes deeper
      // (a held want with deepen > 1 must yield its parent).
      if (deepen !== undefined && d + 1 < deepen) {
        for (const p of parseCommit(obj.body).parents) {
          if (!dist.has(p)) {
            dist.set(p, d + 1);
            queue.push(p);
          }
        }
      }
      continue;
    }
    if (deepen !== undefined && d >= deepen) continue;
    included.add(oid);
    if (deepen !== undefined && d === deepen - 1) boundary.add(oid);
    for (const p of parseCommit(obj.body).parents) {
      if (!dist.has(p)) {
        dist.set(p, d + 1);
        queue.push(p);
      }
    }
  }

  const objects: { type: ObjType; body: Buffer }[] = [];
  const seen = new Set<string>();
  const addObject = (oid: string): void => {
    if (seen.has(oid)) return;
    if (heldObjects.has(oid)) return;
    const obj = repo.getObject(oid);
    if (!obj) return;
    seen.add(oid);
    objects.push(obj);
  };
  for (const oid of tagObjects) addObject(oid);
  for (const oid of included) {
    addObject(oid);
    const info = parseCommit(repo.getObject(oid)?.body ?? Buffer.alloc(0));
    const addTree = (treeOid: string): void => {
      addObject(treeOid);
      const tree = repo.getObject(treeOid);
      if (!tree) return;
      for (const e of parseTree(tree.body)) {
        if (e.mode === '40000') addTree(e.oid);
        else if (e.mode !== '160000') addObject(e.oid);
      }
    };
    addTree(info.tree);
  }

  // New shallow boundaries, and old ones that are now interior.
  const shallowOut = [...boundary].sort();
  const unshallowOut: string[] = [];
  for (const b of shallowIn) {
    if (boundary.has(b)) continue;
    const d = dist.get(b);
    if (d === undefined) continue;
    if (deepen === undefined) {
      // A full fetch completes every old boundary it reaches.
      if (included.has(b) || held.has(b)) unshallowOut.push(b);
    } else if (d < deepen - 1) {
      unshallowOut.push(b);
    }
  }
  return { objects, shallowOut, unshallowOut: unshallowOut.sort() };
}

function parseTagTarget(body: Buffer): string | null {
  const text = body.toString('utf8');
  const m = /^object ([0-9a-f]{40})$/m.exec(text);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

function refLines(repo: Repo): { oid: string; ref: string; peeled?: string }[] {
  const out: { oid: string; ref: string; peeled?: string }[] = [];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ref, oid] of refs) {
    const entry: { oid: string; ref: string; peeled?: string } = { oid, ref };
    const obj = repo.getObject(oid);
    if (obj?.type === 'tag') {
      const target = parseTagTarget(obj.body);
      if (target) entry.peeled = target;
    }
    out.push(entry);
  }
  return out;
}

const UPLOAD_V0_CAPS = `side-band-64k agent=${AGENT} symref=HEAD:refs/heads/main object-format=sha1`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} object-format=sha1`;

function advertiseV0(repo: Repo, service: 'upload' | 'receive'): Buffer {
  const caps = service === 'upload' ? UPLOAD_V0_CAPS : RECEIVE_CAPS;
  const name = service === 'upload' ? 'git-upload-pack' : 'git-receive-pack';
  const parts: Buffer[] = [pktLine(`# service=${name}\n`), pktFlush()];
  const refs = refLines(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headTip = repo.tip(repo.defaultBranch);
    if (headTip) {
      parts.push(pktLine(`${headTip} HEAD\0${caps}\n`));
      for (const r of refs) {
        parts.push(pktLine(`${r.oid} ${r.ref}\n`));
        if (r.peeled) parts.push(pktLine(`${r.peeled} ${r.ref}^{}\n`));
      }
    } else {
      // No default-branch tip: the capabilities ride on the first ref line.
      refs.forEach((r, idx) => {
        parts.push(pktLine(idx === 0 ? `${r.oid} ${r.ref}\0${caps}\n` : `${r.oid} ${r.ref}\n`));
        if (r.peeled) parts.push(pktLine(`${r.peeled} ${r.ref}^{}\n`));
      });
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function advertiseV2(): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ];
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function sendGit(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const a of args) {
    if (a === 'peel') peel = true;
    else if (a === 'symrefs') symrefs = true;
    else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  const refs = refLines(repo);
  const headTip = repo.tip(repo.defaultBranch);
  const matchPrefix = (ref: string): boolean => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
  if (refs.length === 0) {
    // Unborn HEAD only; no refs/ line is reported for an empty repo.
    if (prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p))) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
  } else {
    if (prefixes.length === 0 && headTip) {
      parts.push(pktLine(`${headTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
    for (const r of refs) {
      if (!matchPrefix(r.ref)) continue;
      let line = `${r.oid} ${r.ref}`;
      if (peel && r.peeled) line += ` peeled:${r.peeled}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchResponse(repo: Repo, args: string[], v2: boolean): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | undefined;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) shallow.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) deepen = Number(a.slice(7).trim());
  }
  const plan = collectFetchObjects(repo, wants, haves, shallow, deepen);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (v2) {
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktFlush());
    if (plan.shallowOut.length > 0 || plan.unshallowOut.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of plan.shallowOut) parts.push(pktLine(`shallow ${s}\n`));
      for (const u of plan.unshallowOut) parts.push(pktLine(`unshallow ${u}\n`));
      parts.push(pktFlush());
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(pack));
    parts.push(pktFlush());
  } else {
    parts.push(pktLine('NAK\n'));
    for (const s of plan.shallowOut) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of plan.unshallowOut) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(...sidebandPack(pack));
    parts.push(pktFlush());
  }
  return Buffer.concat(parts);
}

function handleUploadPack(repo: Repo, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  const parsed = parsePktLines(body);
  if (parsed.error) {
    sendGit(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad pkt-line stream\n'));
    return;
  }
  const lines = parsed.items.filter((i) => i.kind === 'data').map((i) => (i as { payload: Buffer }).payload.toString('utf8'));
  if (isV2) {
    const first = (lines[0] ?? '').trim();
    const command = first.startsWith('command=') ? first.slice('command='.length) : first;
    const args = lines.slice(1).map((l) => l.replace(/\n$/, ''));
    if (command === 'ls-refs') {
      sendGit(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, args));
      return;
    }
    if (command === 'fetch') {
      sendGit(res, 200, 'application/x-git-upload-pack-result', fetchResponse(repo, args, true));
      return;
    }
    sendGit(res, 400, 'text/plain; charset=utf-8', Buffer.from(`unknown v2 command ${command}\n`));
    return;
  }
  // v0: section 1 = wants, section 2 = haves + done.
  const sections: string[][] = [[]];
  for (const item of parsed.items) {
    if (item.kind === 'flush') {
      sections.push([]);
      continue;
    }
    if (item.kind === 'data') sections[sections.length - 1].push(item.payload.toString('utf8').replace(/\n$/, ''));
  }
  const args = [...(sections[0] ?? []), ...(sections[1] ?? [])];
  // Strip capabilities from the first want line.
  const cleaned = args.map((a) => {
    if (a.startsWith('want ')) {
      const rest = a.slice(5);
      const sp = rest.indexOf(' ');
      return sp < 0 ? a : `want ${rest.slice(0, sp)}`;
    }
    return a;
  });
  sendGit(res, 200, 'application/x-git-upload-pack-result', fetchResponse(repo, cleaned, false));
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const report: { ref: string; ok: boolean; reason: string }[] = [];
  let unpackOk = true;
  let commands: PushCommand[] = [];
  let packOffset = 0;
  let parseError: string | undefined;
  // Commands are pkt-lines up to the first flush; the pack follows raw.
  {
    let i = 0;
    const lines: string[] = [];
    let ok = true;
    while (i + 4 <= body.length) {
      const head = body.toString('ascii', i, i + 4);
      if (head === '0000') {
        i += 4;
        break;
      }
      const len = parseInt(head, 16);
      if (!Number.isFinite(len) || len < 4 || i + len > body.length) {
        ok = false;
        break;
      }
      lines.push(body.toString('utf8', i + 4, i + len));
      i += len;
    }
    if (!ok) {
      parseError = 'bad pkt-line stream in command list';
    } else {
      packOffset = i;
      for (let n = 0; n < lines.length; n += 1) {
        let line = lines[n].replace(/\n$/, '');
        if (n === 0) {
          const nul = line.indexOf('\0');
          if (nul >= 0) line = line.slice(0, nul);
        }
        const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
        if (!m) {
          parseError = `bad command line ${JSON.stringify(line)}`;
          break;
        }
        commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
      }
    }
  }
  const sideband = true; // we always advertise side-band-64k; report inside band 1.
  const finish = (): void => {
    const text = [
      unpackOk ? 'unpack ok' : 'unpack failed',
      ...report.map((r) => (r.ok ? `ok ${r.ref}` : `ng ${r.ref} ${r.reason}`)),
    ].join('\n');
    const parts: Buffer[] = [];
    if (sideband) {
      for (const line of text.split('\n')) parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(`${line}\n`, 'utf8')])));
      parts.push(pktFlush());
    } else {
      for (const line of text.split('\n')) parts.push(pktLine(`${line}\n`));
      parts.push(pktFlush());
    }
    sendGit(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
  };

  if (parseError || commands.length === 0) {
    unpackOk = false;
    if (commands.length === 0 && !parseError) {
      // A bare command list with no pack: nothing to apply; still report.
      finish();
      return;
    }
    finish();
    return;
  }

  // Unpack: a pack follows the command list unless the list is delete-only.
  const hasNonDelete = commands.some((c) => c.newOid !== ZERO_OID);
  if (hasNonDelete && packOffset < body.length) {
    try {
      const pack = readPack(body.subarray(packOffset), (oid) => repo.getObject(oid));
      for (const [oid, obj] of pack) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      finish();
      return;
    }
  }

  // Apply ref updates, one report line each.
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined || current !== cmd.oldOid) {
        report.push({ ref: cmd.ref, ok: false, reason: 'failed' });
      } else {
        repo.refs.delete(cmd.ref);
        report.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    const newObj = repo.getObject(cmd.newOid);
    if (!newObj || (newObj.type !== 'commit' && newObj.type !== 'tag')) {
      report.push({ ref: cmd.ref, ok: false, reason: 'failed' });
      continue;
    }
    if (current === undefined) {
      if (cmd.oldOid !== ZERO_OID) {
        report.push({ ref: cmd.ref, ok: false, reason: 'failed' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      report.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (current !== cmd.oldOid) {
      report.push({ ref: cmd.ref, ok: false, reason: 'failed' });
      continue;
    }
    // Fast-forward check (tags are not fast-forward-checked: a tag update
    // to a new object is allowed when the old tip matches).
    if (newObj.type === 'commit' && !repo.isAncestor(current, cmd.newOid)) {
      report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    report.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  finish();
}

/** Handle one git smart-HTTP request. Returns true when handled. */
export async function handleGit(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const pathname = url.pathname;
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (!m) return false;
  const owner = decodeURIComponent(m[1]);
  const name = decodeURIComponent(m[2]);
  const action = m[3];
  const repo = forge.getRepo(owner, name);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  if (!requireAuth(req, res, forge)) return true;
  const method = req.method ?? 'GET';

  if (action === 'info/refs' && method === 'GET') {
    const service = url.searchParams.get('service');
    if (service === 'git-upload-pack') {
      if ((req.headers['git-protocol'] ?? '') === 'version=2') {
        sendGit(res, 200, 'application/x-git-upload-pack-advertisement', advertiseV2());
      } else {
        sendGit(res, 200, 'application/x-git-upload-pack-advertisement', advertiseV0(repo, 'upload'));
      }
      return true;
    }
    if (service === 'git-receive-pack') {
      sendGit(res, 200, 'application/x-git-receive-pack-advertisement', advertiseV0(repo, 'receive'));
      return true;
    }
    sendJson(res, 400, { message: 'Not Found' });
    return true;
  }

  if (action === 'git-upload-pack' && method === 'POST') {
    const body = await readBody(req);
    handleUploadPack(repo, req, res, body);
    return true;
  }
  if (action === 'git-receive-pack' && method === 'POST') {
    const body = await readBody(req);
    handleReceivePack(repo, req, res, body);
    return true;
  }
  sendJson(res, 404, { message: 'Not Found' });
  return true;
}
