# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/bingx12/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/bingx12/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process, stdlib only. One in-memory store serves all four surfaces the suite drives as a client:

- **git smart HTTP** — real pack protocol: receive-pack / upload-pack, packfile read/write (v2/v3, OFS + REF deltas, trailer SHA-1), v2 `fetch`/`ls-refs` with shallow/deepen, v0 advertisements, sideband reports, fast-forward enforcement, non-fast-forward refusals.
- **REST v3** (`/api/v3`) — repositories, branches, commits, contents (create/update/delete with sha checks), issues, labels, comments, pull requests (squash merge, mergeability), exact GitHub statuses (201/200/204/400/401/404/405/409/422) and `X-GitHub-Request-Id` on every reply.
- **GraphQL** (`/api/graphql`) — the documents `gh` and `github-mcp-server` send: `viewer`, `repository` (fields, issues connection with `states`/`orderBy`/cursor pagination, pull requests, `pullRequest(number:).files`), `node(id:)` Relay round-trip, `__type` introspection, `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` / `addComment`, batched operations, unknown-field errors as HTTP 200 with an `errors` array.
- **MCP** (`/mcp`) — JSON-RPC 2.0, `server/discover` (modern era) and legacy `initialize`, 9 tools (`create_repo`, `get_repo`, `list_repos`, `create_issue`, `get_issue`, `list_issues`, `create_pull_request`, `get_pull_request`, `merge_pull_request`), byte-stable `tools/list`, `-32601`/`-32602`/`-32700` error codes, 401 without a token.

Deterministic: the viewer and every fixture identity derive from the suite's fixed scenario seed (the same xorshift64\* Rng the kit's `wire.ts` uses), and the state export is byte-identical across replay runs. No git binary, no package manager, no outside service, no UI.

## Run it

```sh
# Node 22, stdlib only — no install step.
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`, and exits when the suite reports done. The forge reads the bearer token from `MAKEFUN_SHOP_TOKEN`.

## Layout

| File | What it holds |
| --- | --- |
| `main.ts` | Lifecycle: bind, register, poll `/done`, exit. |
| `app.ts` | Router: healthz → git → REST → GraphQL → MCP → JSON 404. |
| `store.ts` | In-memory store: git objects (sha1, blob/tree/commit), refs, issues, PRs, seeded viewer derivation. |
| `git.ts` | Smart HTTP: pkt-lines, pack read/write, fetch planning, v0/v2 advertisements, receive-pack. |
| `rest.ts` | REST v3 surface. |
| `graphql.ts` | GraphQL parser + resolvers + introspection. |
| `mcp.ts` | MCP JSON-RPC tools. |
| `common.ts` | JSON replies, auth, body parsing. |

## Local grade

Against the kit's local runner (`grade-local --driver process`, Node 22.21.0), all three practice trials pass **120/120 conformance** (git 30/30, repos 15/15, issues 15/15, pulls 20/20, graphql 20/20, mcp 15/15, protocol 5/5), perf 145–148/200, total score ≈ 942–948.

Built for the make.fun "Build a GitHub-compatible git forge" bounty, $500 in USDC. Entries close 2026-11-21T06:30:00Z.

---

<sub>Entered on [make.fun](https://make.fun/?ref=k6eq9xtw&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
