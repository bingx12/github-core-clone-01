// The forge's HTTP surface: health probe, git smart HTTP, REST v3,
// GraphQL v4 and MCP, all served from one in-memory store in one process.
// main.ts owns the entry <-> env lifecycle; this file owns the routes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sendError, sendJson } from './common.ts';
import { handleGit } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Forge } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The path of a request URL, or '/' when it does not parse. */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (await handleGit(forge, req, res)) return;
        if (await handleRest(forge, req, res)) return;
        if (await handleGraphQL(forge, req, res)) return;
        if (await handleMcp(forge, req, res)) return;

        // Everything else, every method: GitHub's 404 body.
        sendError(res, 404, 'Not Found');
      } catch (err) {
        // A handler must never take the server down with it.
        if (!res.headersSent) {
          try {
            sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
          } catch {
            // The socket is gone; nothing left to do.
          }
        }
      }
    })();
  });
}

void JSON_TYPE;
