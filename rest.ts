// GitHub REST v3 surface (/api/v3), per sdk/conformance/checks-rest.ts.
// Every reply is JSON with a non-empty X-GitHub-Request-Id; unknown routes
// are JSON 404s; malformed JSON bodies are 400s; a missing or wrong token is
// 401; a repo under another owner is 404, never 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  absoluteUrl,
  b64decode,
  b64encode,
  parseJsonBody,
  queryOf,
  readBody,
  requireAuth,
  sendError,
  sendJson,
  splitPath,
} from './common.ts';
import {
  FORGE_EPOCH,
  blobId,
  parseCommit,
  type Forge,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

const FIXED_TIME = '2025-01-01T00:00:00Z';

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`R:${repo.id}`, 'utf8').toString('base64'),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    fork: false,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
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
    locked: false,
    user: { login: forge.viewerLogin, id: 1000, type: 'User' },
    labels: issue.labels.map((name) => ({ name, color: 'ededed', description: '' })),
    comments: issue.comments.length,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullJson(forge: Forge, repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + pr.number,
    node_id: forge.pullNodeId(repo, pr),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    user: { login: forge.viewerLogin, id: 1000, type: 'User' },
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    merged: pr.merged,
    mergeable: true,
    merged_at: pr.merged ? pr.mergedAt : null,
    merge_commit_sha: pr.merged ? pr.mergeCommitSha : null,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    html_url: `https://example.invalid/${repo.fullName}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pr.number}`,
  };
}

/** Look a repo up by owner/name, answering 404 (never 403) when absent. */
function lookupRepo(
  forge: Forge,
  res: ServerResponse,
  owner: string,
  name: string,
): Repo | null {
  const repo = forge.getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

/** Count differing lines between two texts via LCS (files in the suite are small). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lcs = dp[0][0];
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

function paginate<T>(items: T[], req: IncomingMessage, res: ServerResponse, path: string): T[] {
  const q = queryOf(req);
  const perPage = Math.max(1, Math.min(100, Number(q.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(q.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage < items.length) {
    const next = new URLSearchParams(q);
    next.set('page', String(page + 1));
    next.set('per_page', String(perPage));
    const link = `<${absoluteUrl(req, `${path}?${next.toString()}`)}>; rel="next"`;
    res.setHeader('Link', link);
  }
  return slice;
}

/** Handle one REST request. Returns true when handled. */
export async function handleRest(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const pathname = url.pathname;
  if (!pathname.startsWith('/api/v3')) return false;
  const method = req.method ?? 'GET';
  const seg = splitPath(pathname); // ['api','v3',...]

  // The API root and meta are public; everything else needs the token.
  const isRoot = seg.length === 2 || (seg.length === 3 && seg[2] === '');
  if (isRoot && method === 'GET') {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (seg.length === 3 && seg[2] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return true;
  }

  if (!requireAuth(req, res, forge)) return true;

  let body: unknown = null;
  let bodyRaw = Buffer.alloc(0);
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    bodyRaw = await readBody(req);
    if (bodyRaw.length > 0) {
      try {
        body = parseJsonBody(bodyRaw);
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
    }
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  // GET /user: the token owner's login.
  if (seg.length === 3 && seg[2] === 'user' && method === 'GET') {
    sendJson(res, 200, {
      login: forge.viewerLogin,
      id: 1000,
      node_id: Buffer.from('U:1000', 'utf8').toString('base64'),
      type: 'User',
      name: 'ada iversen',
      email: 'adaiversen@example.invalid',
    });
    return true;
  }

  // POST /user/repos
  if (seg.length === 3 && seg[2] === 'user' && false) return true; // unreachable guard
  if (seg.length === 4 && seg[2] === 'user' && seg[3] === 'repos') {
    if (method === 'POST') {
      const name = str(b.name);
      if (name === '') {
        sendError(res, 422, 'Validation Failed');
        return true;
      }
      const existing = forge.getRepo(forge.viewerLogin, name);
      if (existing) {
        sendError(res, 422, 'Repository already exists.');
        return true;
      }
      const repo = forge.createRepo(name, str(b.description), b.private === true);
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    if (method === 'GET') {
      const all = forge.listViewerRepos().sort((x, y) => x.id - y.id);
      const page = paginate(all, req, res, pathname);
      sendJson(res, 200, page.map((r) => repoJson(r)));
      return true;
    }
  }

  // /repos/{owner}/{repo}...
  if (seg.length >= 4 && seg[2] === 'repos') {
    const owner = seg[3];
    const name = seg[4];
    const repo = lookupRepo(forge, res, owner, name);
    if (!repo) return true;

    // GET/PATCH/DELETE /repos/{o}/{r}
    if (seg.length === 5) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.private === 'boolean') repo.isPrivate = b.private;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        forge.deleteRepo(repo);
        res.writeHead(204, { 'x-github-request-id': `req-del-${repo.id}` });
        res.end();
        return true;
      }
    }

    const sub = seg[5];

    // GET /repos/{o}/{r}/branches/{branch}
    if (sub === 'branches' && seg.length === 7 && method === 'GET') {
      const branch = seg[6];
      const tip = repo.tip(branch);
      if (!tip) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
      return true;
    }

    // GET /repos/{o}/{r}/branches
    if (sub === 'branches' && method === 'GET') {
      const out: Record<string, unknown>[] = [];
      for (const [ref, oid] of [...repo.refs.entries()].sort()) {
        if (!ref.startsWith('refs/heads/')) continue;
        out.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
      }
      sendJson(res, 200, out);
      return true;
    }

    // GET /repos/{o}/{r}/commits
    if (sub === 'commits' && method === 'GET') {
      const q = queryOf(req);
      const shaParam = q.get('sha');
      let tip: string | undefined;
      if (shaParam) {
        tip = repo.tip(shaParam) ?? (repo.getObject(shaParam)?.type === 'commit' ? shaParam : undefined);
      } else {
        tip = repo.tip(repo.defaultBranch);
      }
      if (!tip) {
        sendJson(res, 200, []);
        return true;
      }
      const commits = repo.reachableCommits(tip).map((oid) => {
        const info = parseCommit(repo.getObject(oid)?.body ?? Buffer.alloc(0));
        return {
          sha: oid,
          commit: {
            message: info.message.replace(/\n$/, ''),
            author: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: FIXED_TIME },
            committer: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: FIXED_TIME },
          },
          author: { login: forge.viewerLogin, id: 1000, type: 'User' },
          parents: info.parents.map((p) => ({ sha: p })),
        };
      });
      const page = paginate(commits, req, res, pathname);
      sendJson(res, 200, page);
      return true;
    }

    // POST /repos/{o}/{r}/git/refs
    if (sub === 'git' && seg[6] === 'refs' && method === 'POST') {
      const ref = str(b.ref);
      const sha = str(b.sha);
      if (!ref.startsWith('refs/heads/') || !repo.getObject(sha)) {
        sendError(res, 422, 'Validation Failed');
        return true;
      }
      if (repo.refs.has(ref)) {
        sendError(res, 422, 'Reference already exists');
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${repo.fullName}/git/refs/${encodeURIComponent(ref)}` });
      return true;
    }

    // GET /repos/{o}/{r}/git/refs/heads/{branch}
    if (sub === 'git' && seg[6] === 'refs' && seg[7] === 'heads' && seg.length === 9 && method === 'GET') {
      const branch = seg[8];
      const tip = repo.tip(branch);
      if (!tip) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' } });
      return true;
    }

    // /repos/{o}/{r}/contents/{path...}
    if (sub === 'contents') {
      const path = seg.slice(6).join('/');
      const q = queryOf(req);
      const refParam = q.get('ref');
      const branch = refParam ?? repo.defaultBranch;
      const tip = repo.tip(branch);
      if (method === 'GET') {
        if (!tip) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const treeOid = parseCommit(repo.getObject(tip)?.body ?? Buffer.alloc(0)).tree;
        const files = repo.filesOfTree(treeOid);
        if (files.has(path)) {
          const blobOid = files.get(path) as string;
          const content = repo.getObject(blobOid)?.body ?? Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: content.length,
            name: path.split('/').pop(),
            path,
            content: b64encode(content),
            sha: blobOid,
            url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
          });
          return true;
        }
        // Directory listing: direct children of `path`.
        const prefix = path === '' ? '' : `${path}/`;
        const children = new Map<string, { type: string; name: string; path: string; sha: string }>();
        for (const [p, oid] of files) {
          if (!p.startsWith(prefix)) continue;
          const rest = p.slice(prefix.length);
          const slash = rest.indexOf('/');
          if (slash < 0) {
            children.set(rest, { type: 'file', name: rest, path: p, sha: oid });
          } else {
            const dir = rest.slice(0, slash);
            if (!children.has(dir)) {
              // The dir's tree oid: recompute from the subtree.
              const subFiles = new Map<string, string>();
              for (const [p2, o2] of files) {
                if (p2.startsWith(`${prefix}${dir}/`)) subFiles.set(p2.slice(prefix.length + dir.length + 1), o2);
              }
              children.set(dir, { type: 'dir', name: dir, path: `${prefix}${dir}`, sha: repo.treeFromFiles(subFiles) });
            }
          }
        }
        if (children.size === 0) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, [...children.values()].sort((a, c) => (a.name < c.name ? -1 : 1)));
        return true;
      }
      if (method === 'PUT') {
        const content = b64decode(str(b.content));
        const message = str(b.message) || `Update ${path}`;
        const shaGiven = typeof b.sha === 'string' ? (b.sha as string) : undefined;
        const targetBranch = typeof b.branch === 'string' ? (b.branch as string) : branch;
        const currentTip = repo.tip(targetBranch);
        const currentFiles = currentTip
          ? repo.filesOfTree(parseCommit(repo.getObject(currentTip)?.body ?? Buffer.alloc(0)).tree)
          : new Map<string, string>();
        const currentBlob = currentFiles.get(path);
        if (currentBlob) {
          if (shaGiven === undefined) {
            sendError(res, 422, 'Validation Failed');
            return true;
          }
          if (shaGiven.toLowerCase() !== currentBlob.toLowerCase()) {
            sendError(res, 409, 'Conflict');
            return true;
          }
        } else if (shaGiven !== undefined) {
          sendError(res, 409, 'Conflict');
          return true;
        }
        const newBlob = blobId(content);
        repo.putObject('blob', content);
        const nextFiles = new Map(currentFiles);
        nextFiles.set(path, newBlob);
        const tree = repo.treeFromFiles(nextFiles);
        const parents = currentTip ? [currentTip] : [];
        const commit = repo.makeCommit(tree, parents, message);
        repo.setTip(targetBranch, commit);
        sendJson(res, currentBlob ? 200 : 201, {
          content: { name: path.split('/').pop(), path, sha: newBlob, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: commit, message },
        });
        return true;
      }
      if (method === 'DELETE') {
        const shaGiven = typeof b.sha === 'string' ? (b.sha as string) : undefined;
        const currentTip = repo.tip(branch);
        if (!currentTip) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const currentFiles = repo.filesOfTree(parseCommit(repo.getObject(currentTip)?.body ?? Buffer.alloc(0)).tree);
        const currentBlob = currentFiles.get(path);
        if (!currentBlob) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (shaGiven !== undefined && shaGiven.toLowerCase() !== currentBlob.toLowerCase()) {
          sendError(res, 409, 'Conflict');
          return true;
        }
        const nextFiles = new Map(currentFiles);
        nextFiles.delete(path);
        const tree = repo.treeFromFiles(nextFiles);
        const commit = repo.makeCommit(tree, [currentTip], str(b.message) || `Delete ${path}`);
        repo.setTip(branch, commit);
        sendJson(res, 200, { commit: { sha: commit, message: str(b.message) || `Delete ${path}` } });
        return true;
      }
    }

    // POST /repos/{o}/{r}/labels
    if (sub === 'labels' && method === 'POST') {
      const name = str(b.name);
      if (name === '') {
        sendError(res, 422, 'Validation Failed');
        return true;
      }
      const existing = repo.labels.get(name);
      if (existing) {
        sendJson(res, 201, { name: existing.name, color: existing.color, description: existing.description });
        return true;
      }
      const label = { name, color: typeof b.color === 'string' ? (b.color as string) : 'ededed', description: typeof b.description === 'string' ? (b.description as string) : '' };
      repo.labels.set(name, label);
      sendJson(res, 201, { name: label.name, color: label.color, description: label.description });
      return true;
    }
    if (sub === 'labels' && method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description })));
      return true;
    }

    // /repos/{o}/{r}/issues...
    if (sub === 'issues') {
      // POST /issues, GET /issues
      if (seg.length === 6) {
        if (method === 'POST') {
          const labels = Array.isArray(b.labels) ? (b.labels as unknown[]).map(String) : [];
          for (const l of labels) {
            if (!repo.labels.has(l)) {
              sendError(res, 422, `Validation Failed: label "${l}" does not exist`);
              return true;
            }
          }
          const issue: Issue = {
            number: repo.nextNumber,
            title: str(b.title),
            body: typeof b.body === 'string' ? (b.body as string) : '',
            state: 'open',
            labels,
            comments: [],
            seq: repo.seq,
          };
          repo.seq += 1;
          repo.nextNumber += 1;
          repo.issues.set(issue.number, issue);
          sendJson(res, 201, issueJson(forge, repo, issue));
          return true;
        }
        if (method === 'GET') {
          const q = queryOf(req);
          const state = q.get('state') ?? 'open';
          const sort = q.get('sort') ?? 'created';
          const direction = q.get('direction') ?? 'desc';
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          list.sort((a, c) => (sort === 'created' && direction === 'asc' ? a.seq - c.seq : c.seq - a.seq));
          const page = paginate(list, req, res, pathname);
          sendJson(res, 200, page.map((i) => issueJson(forge, repo, i)));
          return true;
        }
      }
      const num = Number(seg[6]);
      const issue = repo.issues.get(num);
      // /issues/{n}/comments
      if (seg.length === 8 && seg[7] === 'comments') {
        if (!issue) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (method === 'POST') {
          const comment = { id: repo.nextCommentId, body: str(b.body), userLogin: forge.viewerLogin };
          repo.nextCommentId += 1;
          issue.comments.push(comment);
          sendJson(res, 201, {
            id: comment.id,
            node_id: forge.commentNodeId(repo, comment),
            body: comment.body,
            user: { login: comment.userLogin, id: 1000, type: 'User' },
            created_at: FIXED_TIME,
            updated_at: FIXED_TIME,
          });
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({
            id: c.id,
            node_id: forge.commentNodeId(repo, c),
            body: c.body,
            user: { login: c.userLogin, id: 1000, type: 'User' },
            created_at: FIXED_TIME,
            updated_at: FIXED_TIME,
          })));
          return true;
        }
      }
      // /issues/{n}
      if (seg.length === 7) {
        if (!issue) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(forge, repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          sendJson(res, 200, issueJson(forge, repo, issue));
          return true;
        }
      }
    }

    // /repos/{o}/{r}/pulls...
    if (sub === 'pulls') {
      if (seg.length === 6) {
        if (method === 'POST') {
          const head = str(b.head);
          const base = str(b.base) || repo.defaultBranch;
          const headSha = repo.tip(head);
          const baseSha = repo.tip(base);
          if (!headSha || !baseSha) {
            sendError(res, 422, 'Validation Failed');
            return true;
          }
          const pr: PullRequest = {
            number: repo.nextNumber,
            title: str(b.title),
            body: typeof b.body === 'string' ? (b.body as string) : '',
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
          sendJson(res, 201, pullJson(forge, repo, pr));
          return true;
        }
        if (method === 'GET') {
          const q = queryOf(req);
          const state = q.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, c) => c.seq - a.seq);
          const page = paginate(list, req, res, pathname);
          sendJson(res, 200, page.map((p) => pullJson(forge, repo, p)));
          return true;
        }
      }
      const num = Number(seg[6]);
      const pr = repo.pulls.get(num);
      // PUT /pulls/{n}/merge
      if (seg.length === 8 && seg[7] === 'merge') {
        if (method !== 'PUT') {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (!pr) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (pr.merged || pr.state === 'closed') {
          sendError(res, 405, 'Pull Request is already merged');
          return true;
        }
        const baseTip = repo.tip(pr.baseRef);
        if (!baseTip) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        // Conflict: the base moved since the PR opened, and the new base
        // changed a file this PR also changes (three-way check).
        if (baseTip !== pr.baseSha) {
          const baseInfo = parseCommit(repo.getObject(pr.baseSha)?.body ?? Buffer.alloc(0));
          const newBaseInfo = parseCommit(repo.getObject(baseTip)?.body ?? Buffer.alloc(0));
          const headInfo = parseCommit(repo.getObject(pr.headSha)?.body ?? Buffer.alloc(0));
          const prChanges = repo.diffTrees(baseInfo.tree, headInfo.tree).map((d) => d.path);
          const baseChanges = repo.diffTrees(baseInfo.tree, newBaseInfo.tree);
          const baseChanged = new Map(baseChanges.map((d) => [d.path, d.newOid]));
          const oldBaseFiles = repo.filesOfTree(baseInfo.tree);
          let conflict = false;
          for (const p of prChanges) {
            if (baseChanged.has(p) && baseChanged.get(p) !== oldBaseFiles.get(p)) {
              conflict = true;
              break;
            }
          }
          if (conflict) {
            sendError(res, 405, 'Pull Request is not mergeable');
            return true;
          }
        }
        const headInfo = parseCommit(repo.getObject(pr.headSha)?.body ?? Buffer.alloc(0));
        const mergeCommit = repo.makeCommit(headInfo.tree, [baseTip], `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}`);
        repo.setTip(pr.baseRef, mergeCommit);
        pr.state = 'closed';
        pr.merged = true;
        pr.mergedAt = FIXED_TIME;
        pr.mergeCommitSha = mergeCommit;
        sendJson(res, 200, { sha: mergeCommit, merged: true, message: 'Pull Request successfully merged' });
        return true;
      }
      // GET /pulls/{n}/files
      if (seg.length === 8 && seg[7] === 'files') {
        if (!pr) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const baseInfo = parseCommit(repo.getObject(pr.baseSha)?.body ?? Buffer.alloc(0));
        const headInfo = parseCommit(repo.getObject(pr.headSha)?.body ?? Buffer.alloc(0));
        const baseFiles = repo.filesOfTree(baseInfo.tree);
        const headFiles = repo.filesOfTree(headInfo.tree);
        const diffs = repo.diffTrees(baseInfo.tree, headInfo.tree);
        const out = diffs.map((d) => {
          const oldText = d.oldOid ? (repo.getObject(d.oldOid)?.body.toString('utf8') ?? '') : '';
          const newText = d.newOid ? (repo.getObject(d.newOid)?.body.toString('utf8') ?? '') : '';
          const { additions, deletions } = lineDiff(oldText, newText);
          const status = d.oldOid === null ? 'added' : d.newOid === null ? 'removed' : 'modified';
          return {
            sha: d.newOid ?? d.oldOid ?? '',
            filename: d.path,
            status,
            additions,
            deletions,
            changes: additions + deletions,
            blob_url: '',
            raw_url: '',
            contents_url: '',
            patch: '',
          };
        });
        sendJson(res, 200, out);
        return true;
      }
      // GET /pulls/{n}
      if (seg.length === 7 && method === 'GET') {
        if (!pr) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, pullJson(forge, repo, pr));
        return true;
      }
    }
  }

  // Unknown route under /api/v3: JSON 404.
  sendError(res, 404, 'Not Found');
  return true;
}
