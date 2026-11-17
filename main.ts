// Entry lifecycle: bind an ephemeral port, hand it to the env, wait for done.
// The env owns port 8080; this process never binds it. Everything here is
// stdlib: the server itself lives in app.ts, this file only drives the
// register-then-poll handshake the suite expects.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set\n');
  process.exit(1);
}

// One HTTP round trip may take at most this long before it is abandoned.
const ROUND_TIMEOUT_MS = 30_000;
// Backoff between failed rounds: starts here, doubles, never passes the cap.
const BACKOFF_FIRST_MS = 250;
const BACKOFF_CAP_MS = 2_000;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(round: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_FIRST_MS * 2 ** Math.min(round, 8));
}

async function postPort(port: number): Promise<'ok' | 'fatal' | 'retry'> {
  try {
    const reply = await fetch(`${envOrigin}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(ROUND_TIMEOUT_MS),
    });
    // 200 registers us; 409 means another entry registered first and this
    // process simply keeps waiting like any other.
    if (reply.status === 200 || reply.status === 409) return 'ok';
    // 400/405 are contract errors: retrying cannot fix them.
    if (reply.status === 400 || reply.status === 405) return 'fatal';
    return 'retry';
  } catch {
    // The env may still be starting, or the round timed out: retry.
    return 'retry';
  }
}

async function register(port: number): Promise<void> {
  for (let round = 0; ; round += 1) {
    const outcome = await postPort(port);
    if (outcome === 'ok') return;
    if (outcome === 'fatal') throw new Error('register was refused');
    await wait(backoffMs(round));
  }
}

async function pollDone(): Promise<void> {
  for (let round = 0; ; round += 1) {
    try {
      const reply = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(ROUND_TIMEOUT_MS),
      });
      if (reply.ok) {
        const body = (await reply.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // No answer yet, or the round timed out: the trial is not done.
    }
    await wait(backoffMs(round));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind a TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);
  await register(bound.port);
  process.stdout.write('[entry] registered; waiting for done\n');
  await pollDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
