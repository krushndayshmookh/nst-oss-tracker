// In-memory GitHub for tests: a `fetch` replacement that answers the GraphQL PR search and the two REST user lookups.
//   const gh = mockGitHub({ users: [{ login, id, name, prs: [nodes] }] });
//   gh.fetch(url, init)   drop-in for global fetch        gh.calls   [{ kind:'graphql'|'rest', q, first, after, path, headers }]
//   gh.intercept = (call) => Response | undefined          return a Response to override one answer (502, rate limit, ...)
//   gh.rateLimit = { remaining, resetAt }                  what the next GraphQL answers report
// Search semantics follow GitHub: `author:` is case-insensitive, unknown logins give 0 results, `updated:>=` and
// `created:A..B` filter, newest first, and a single search never pages past 1000 results.
export function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function mockGitHub({ users = [], cap = 1000 } = {}) {
  const gh = {
    users: new Map(),
    calls: [],
    intercept: null,
    rateLimit: { remaining: 4900, resetAt: '2030-01-01T00:00:00Z' },
    addUser(u) { gh.users.set(u.login.toLowerCase(), { name: null, prs: [], ...u }); return gh; },
    removeUser(login) { gh.users.delete(login.toLowerCase()); return gh; },
    graphql() { return gh.calls.filter((c) => c.kind === 'graphql'); },
    rest() { return gh.calls.filter((c) => c.kind === 'rest'); },
  };
  for (const u of users) gh.addUser(u);

  function search(q) {
    const author = /author:(\S+)/.exec(q)?.[1]?.toLowerCase();
    const updated = /updated:>=(\d{4}-\d{2}-\d{2})/.exec(q)?.[1];
    const created = /created:(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/.exec(q);
    let list = gh.users.get(author)?.prs ?? [];
    if (updated) list = list.filter((n) => (n.updatedAt || n.createdAt).slice(0, 10) >= updated);
    if (created) list = list.filter((n) => n.createdAt.slice(0, 10) >= created[1] && n.createdAt.slice(0, 10) <= created[2]);
    return [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  gh.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (u.pathname === '/graphql') {
      const body = JSON.parse(init.body);
      const { q, first, after } = body.variables;
      const call = { kind: 'graphql', q, first, after: after ?? null, headers, query: body.query };
      gh.calls.push(call);
      const forced = await gh.intercept?.(call);
      if (forced) return forced;
      const all = search(q);
      const visible = all.slice(0, cap);
      const start = after ? Number(after) : 0;
      const end = Math.min(start + first, visible.length);
      return json({ data: {
        s: { issueCount: all.length, pageInfo: { hasNextPage: end < visible.length, endCursor: String(end) }, nodes: visible.slice(start, end) },
        rateLimit: gh.rateLimit,
      } });
    }
    const call = { kind: 'rest', path: u.pathname, headers };
    gh.calls.push(call);
    const forced = await gh.intercept?.(call);
    if (forced) return forced;
    let user = null;
    let m;
    if ((m = /^\/users\/([^/]+)$/.exec(u.pathname))) user = gh.users.get(decodeURIComponent(m[1]).toLowerCase());
    else if ((m = /^\/user\/(\d+)$/.exec(u.pathname))) user = [...gh.users.values()].find((x) => x.id === Number(m[1]));
    if (!user) return json({ message: 'Not Found' }, { status: 404 });
    return json({ login: user.login, id: user.id, name: user.name, type: 'User' });
  };
  return gh;
}

/** Records the requested waits instead of waiting. */
export function fakeSleep() {
  const sleep = async (ms) => { sleep.calls.push(ms); };
  sleep.calls = [];
  return sleep;
}

// ---------- SPEC addendum I: issue and review searches ----------
// Users may carry `issues: [issueNodes]` and `reviews: [reviewed PR nodes]` next to `prs`. The two contribution searches
//   `author:<u> type:issue …`  and  `reviewed-by:<u> type:pr -author:<u> …`
// are answered from those lists (same updated: / created: filters, paging and cap as PR searches; `-author:` drops the
// user's own PRs). They are recorded in `gh.contribCalls` (not in `gh.calls`) and go through `gh.contribIntercept`
// (not `gh.intercept`), so tests written for the PR search see exactly the calls they saw before.
const prOnlyMockGitHub = mockGitHub;
const isContribSearch = (q) => /(^|\s)type:issue(\s|$)/.test(q) || /(^|\s)reviewed-by:/.test(q);

function contribSearch(gh, q) {
  const updated = /updated:>=(\d{4}-\d{2}-\d{2})/.exec(q)?.[1];
  const created = /created:(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/.exec(q);
  const reviewer = /(?:^|\s)reviewed-by:(\S+)/.exec(q)?.[1]?.toLowerCase();
  let list;
  if (reviewer) {
    const notAuthor = /(?:^|\s)-author:(\S+)/.exec(q)?.[1]?.toLowerCase();
    list = (gh.users.get(reviewer)?.reviews ?? []).filter((n) => !notAuthor || String(n.author?.login ?? '').toLowerCase() !== notAuthor);
  } else {
    const author = /(?:^|\s)author:(\S+)/.exec(q)?.[1]?.toLowerCase();
    list = gh.users.get(author)?.issues ?? [];
  }
  if (updated) list = list.filter((n) => (n.updatedAt || n.createdAt).slice(0, 10) >= updated);
  if (created) list = list.filter((n) => n.createdAt.slice(0, 10) >= created[1] && n.createdAt.slice(0, 10) <= created[2]);
  return [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// eslint-disable-next-line no-func-assign
mockGitHub = function mockGitHubWithContributions(spec = {}) {
  const gh = prOnlyMockGitHub(spec);
  const cap = spec.cap ?? 1000;
  const prFetch = gh.fetch;
  gh.contribCalls = [];
  gh.contribIntercept = null;
  gh.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname !== '/graphql') return prFetch(url, init);
    const body = JSON.parse(init.body);
    const { q, first, after } = body.variables;
    if (!isContribSearch(q)) return prFetch(url, init);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const call = { kind: 'graphql', q, first, after: after ?? null, headers, query: body.query };
    gh.contribCalls.push(call);
    const forced = await gh.contribIntercept?.(call);
    if (forced) return forced;
    const all = contribSearch(gh, q);
    const visible = all.slice(0, cap);
    const start = after ? Number(after) : 0;
    const end = Math.min(start + first, visible.length);
    return json({ data: {
      s: { issueCount: all.length, pageInfo: { hasNextPage: end < visible.length, endCursor: String(end) }, nodes: visible.slice(start, end) },
      rateLimit: gh.rateLimit,
    } });
  };
  return gh;
};

/** Raw issue node as returned by fetchUserIssues. `repo` is 'owner/name'. */
export function issueNode({ repo = 'apache/airflow', number, title = 'Crash on start', state = 'OPEN', stateReason = null,
  createdAt = '2026-10-01T10:00:00Z', updatedAt, closedAt, comments = 1, stars = 5000, ownerType = 'Organization',
  isFork = false, isPrivate = false, author = { login: 'alice', databaseId: 42 }, databaseId } = {}) {
  number ??= 5000 + Math.floor(Math.random() * 1e6);
  return {
    databaseId: databaseId ?? number * 10, url: `https://github.com/${repo}/issues/${number}`, number, title, state, stateReason,
    createdAt, updatedAt: updatedAt ?? createdAt, closedAt: closedAt ?? (state === 'CLOSED' ? createdAt : null),
    author, comments: { totalCount: comments },
    repository: contribRepo(repo, { stars, ownerType, isFork, isPrivate }),
  };
}

/** Raw reviewed-PR node as returned by fetchUserReviews. `reviews` = [{ state, submittedAt, url? }]. */
export function reviewNode({ repo = 'apache/airflow', number, title = 'Fix scheduler race', state = 'OPEN', createdAt = '2026-10-01T10:00:00Z',
  updatedAt, mergedAt = null, closedAt = null, prAuthor = 'someone', reviews = [{ state: 'APPROVED', submittedAt: '2026-10-02T10:00:00Z' }],
  totalCount, stars = 5000, ownerType = 'Organization', isFork = false, isPrivate = false } = {}) {
  number ??= 7000 + Math.floor(Math.random() * 1e6);
  const url = `https://github.com/${repo}/pull/${number}`;
  return {
    databaseId: number * 10, url, number, title, state, createdAt, updatedAt: updatedAt ?? createdAt, mergedAt, closedAt,
    author: prAuthor === null ? null : { login: prAuthor },
    reviews: { totalCount: totalCount ?? reviews.length,
      nodes: reviews.map((v, i) => ({ url: `${url}#pullrequestreview-${number * 100 + i}`, ...v })) },
    repository: contribRepo(repo, { stars, ownerType, isFork, isPrivate }),
  };
}

function contribRepo(repo, { stars, ownerType, isFork, isPrivate }) {
  return {
    nameWithOwner: repo, isFork, isArchived: false, isPrivate, stargazerCount: stars, forkCount: 3, description: `${repo} description`,
    createdAt: '2020-01-01T00:00:00Z', owner: { login: repo.split('/')[0], __typename: ownerType },
    primaryLanguage: { name: 'Go' }, licenseInfo: { spdxId: 'Apache-2.0' },
    languages: { totalSize: 100, edges: [{ size: 100, node: { name: 'Go' } }] }, repositoryTopics: { nodes: [{ topic: { name: 'Scheduler' } }] },
  };
}
