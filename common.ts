// Shared HTTP helpers for the forge's surfaces: JSON answers, auth, bodies.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Forge } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestSeq = 0;

/** Deterministic per-run request id (no clock, no randomness). */
export function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq}`;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Read the whole request body as a Buffer. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; returns null when the body is empty, and throws on bad JSON. */
export function parseJsonBody(buf: Buffer): unknown {
  const text = buf.toString('utf8').trim();
  if (text === '') return null;
  return JSON.parse(text);
}

export interface Auth {
  ok: boolean;
  token: string;
}

/** The suite's bearer token is the one in MAKEFUN_SHOP_TOKEN. */
export function checkAuth(req: IncomingMessage, forge: Forge): Auth {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = req.headers.authorization ?? '';
  const m = /^Bearer (.+)$/.exec(header);
  if (!m || expected === '' || m[1] !== expected) return { ok: false, token: '' };
  return { ok: true, token: m[1] };
}

/** Require auth; answers 401 itself when it fails. */
export function requireAuth(req: IncomingMessage, res: ServerResponse, forge: Forge): boolean {
  if (!checkAuth(req, forge).ok) {
    sendError(res, 401, 'Requires authentication');
    return false;
  }
  return true;
}

/** Split a pathname into decoded segments. */
export function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
}

/** Parse a URL query string into a map. */
export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Absolute same-origin URL for a Link header, from the Host header. */
export function absoluteUrl(req: IncomingMessage, path: string): string {
  const host = req.headers.host ?? 'localhost';
  const proto = 'http';
  return `${proto}://${host}${path}`;
}

/** Base64 that tolerates the newlines GitHub puts in content bodies. */
export function b64decode(s: string): Buffer {
  return Buffer.from(s.replace(/\s+/g, ''), 'base64');
}

/** GitHub-style base64 content: 60-char lines. */
export function b64encode(buf: Buffer): string {
  const b64 = buf.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 60) lines.push(b64.slice(i, i + 60));
  return `${lines.join('\n')}\n`;
}
