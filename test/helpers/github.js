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
