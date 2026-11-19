// GitHub client (SPEC section 4): GraphQL PR search ported from legacy/fetch_prs.py + two REST user lookups.
//
//   fetchUserPRs(username, {since?, ...opts}) -> { nodes, count, error, fatal, rateLimit }   never throws for GitHub-side failures
//   getUser(login, opts) / getUserById(id, opts) -> { login, id, name } | null (404)        throws when GitHub cannot be reached
//
// opts: { fetch = global fetch, token = GITHUB_TOKEN, sleep = real sleep, now = () => new Date(), log = () => {} }
// Every wait goes through opts.sleep(ms), so tests inject a fake and never wait.

export const GRAPHQL_URL = 'https://api.github.com/graphql';
export const REST_URL = 'https://api.github.com';
/**
 * Base URL of the GitHub API. GITHUB_API_URL overrides it (GitHub Enterprise, or a local fake server in
 * integration tests): REST calls go to `<base>/...`, GraphQL to `<base>/graphql`. Read at call time.
 */
export function apiBase() {
  const v = String(process.env.GITHUB_API_URL ?? '').trim().replace(/\/+$/, '');
  return v || REST_URL;
}
export const USER_AGENT = 'nst-oss-status';

export const PAGE_SIZES = [50, 20, 8, 3]; // GitHub answers 502 when a query is too heavy: pages shrink on failure
export const SEARCH_CAP = 1000;           // a GitHub search never returns more than 1000 results
export const RATE_LIMIT_FLOOR = 100;      // sleep until the reset when fewer points than this remain
export const FIRST_YEAR = 2015;           // same lower bound as the legacy fetcher for the created: split
const PAGE_PAUSE_MS = 300;
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_RATE_SLEEP_MS = 65 * 60 * 1000;

// Same fields as legacy/fetch_prs.py, plus updatedAt, the PR's databaseId (stable across repo renames) and the author's login / databaseId.
export const PR_FIELDS = `issueCount pageInfo{hasNextPage endCursor}
 nodes{... on PullRequest{databaseId url number title state isDraft createdAt updatedAt mergedAt closedAt additions deletions changedFiles
  author{login ... on User{databaseId}}
  comments{totalCount} reviews{totalCount}
  repository{nameWithOwner isFork isArchived isPrivate stargazerCount forkCount description createdAt
   owner{login __typename} primaryLanguage{name} licenseInfo{spdxId}}}}`;

export const SEARCH_QUERY = `query($q: String!, $first: Int!, $after: String) {
 s: search(query: $q, type: ISSUE, first: $first, after: $after) {${PR_FIELDS}}
 rateLimit{remaining resetAt}
}`;

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const isValidLogin = (s) => typeof s === 'string' && LOGIN_RE.test(s);

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveOpts(opts = {}) {
  return {
    fetch: opts.fetch ?? globalThis.fetch,
    token: opts.token ?? process.env.GITHUB_TOKEN ?? '',
    sleep: opts.sleep ?? realSleep,
    now: opts.now ?? (() => new Date()),
    log: opts.log ?? (() => {}),
  };
}

function headers(o, extra = {}) {
  const h = { 'User-Agent': USER_AGENT, ...extra };
  if (o.token) h.Authorization = `bearer ${o.token}`;
  return h;
}

const header = (res, name) => res?.headers?.get?.(name) ?? null;
const short = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? null)).slice(0, 200);

/** Milliseconds to wait when a response says the rate limit is exhausted (primary limit via x-ratelimit-*), else 0. */
function rateResetWait(res, o) {
  if (header(res, 'x-ratelimit-remaining') !== '0') return 0;
  const reset = Number(header(res, 'x-ratelimit-reset'));
  if (!Number.isFinite(reset) || reset <= 0) return 0;
  return Math.min(Math.max(reset * 1000 - o.now().getTime(), 0) + 5000, MAX_RATE_SLEEP_MS);
}

/**
 * One GraphQL call with the legacy retry policy. Returns the parsed body ({data, errors}); never throws.
 *   HTTP error   wait Retry-After, else 4s x attempt for 502/504, else 30s x attempt
 *   data:null with a rate limit / timeout / "went wrong" error   wait 30s x attempt
 *   network error / bad JSON   wait 15s x attempt
 * 401 is not retried (bad or missing token): `fatal: true` is set on the result.
 */
export async function gql(query, variables = {}, opts = {}) {
  const o = resolveOpts(opts);
  const attempts = opts.attempts ?? 8;
  const body = JSON.stringify({ query, variables });
  let last = 'gave up';
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res;
    try {
      res = await o.fetch(`${apiBase()}/graphql`, {
        method: 'POST', body, headers: headers(o, { 'Content-Type': 'application/json' }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      last = `network error: ${e?.message || e}`;
      o.log(`  err ${e?.message || e}`);
      await o.sleep(15_000 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      last = `http ${res.status}`;
      if (res.status === 401) return { data: null, errors: [{ message: 'http 401: bad credentials (check GITHUB_TOKEN)' }], fatal: true, status: 401 };
      const retryAfter = Number.parseInt(header(res, 'retry-after') ?? '', 10);
      const wait = (retryAfter > 0 ? retryAfter * 1000 : 0) || rateResetWait(res, o) ||
        ([502, 504].includes(res.status) ? 4000 * (attempt + 1) : 30_000 * (attempt + 1));
      o.log(`  http ${res.status} sleep ${Math.round(wait / 1000)}s`);
      await o.sleep(wait);
      continue;
    }
    let d;
    try {
      d = await res.json();
    } catch (e) {
      last = `bad response body: ${e?.message || e}`;
      await o.sleep(15_000 * (attempt + 1));
      continue;
    }
    if ((d?.data === null || d?.data === undefined) && d?.errors) {
      const msg = short(d.errors);
      if (/rate limit|timeout|went wrong/i.test(msg)) {
        last = msg;
        o.log(`  retry: ${msg}`);
        await o.sleep(rateResetWait(res, o) || 30_000 * (attempt + 1));
        continue;
      }
    }
    return d ?? { data: null, errors: [{ message: 'empty response' }] };
  }
  return { data: null, errors: [{ message: `gave up: ${last}` }] };
}

/** Sleeps until the GraphQL rate limit resets when fewer than RATE_LIMIT_FLOOR points remain. */
async function respectRateLimit(rl, o) {
  if (!rl || !Number.isFinite(rl.remaining) || rl.remaining >= RATE_LIMIT_FLOOR) return;
  const reset = rl.resetAt ? new Date(rl.resetAt).getTime() : NaN;
  const wait = Number.isFinite(reset)
    ? Math.min(Math.max(reset - o.now().getTime(), 0) + 5000, MAX_RATE_SLEEP_MS)
    : 600_000; // legacy fallback: ten minutes
  o.log(`  rate limit: ${rl.remaining} left, sleeping ${Math.round(wait / 1000)}s`);
  await o.sleep(wait);
}

/**
 * All results of one search query (GitHub caps a search at 1000).
 * Returns { nodes, count, error, fatal, rateLimit }; on error the nodes fetched so far are kept.
 */
export async function pageAll(q, opts = {}) {
  const o = resolveOpts(opts);
  const inner = { ...opts, ...o, attempts: 3 };
  const nodes = [];
  let after = null;
  let count = 0;
  let rateLimit = null;
  for (;;) {
    let s = null;
    let d = null;
    for (const first of PAGE_SIZES) {
      d = await gql(SEARCH_QUERY, { q, first, after }, inner);
      s = d?.data?.s ?? null;
      if (d?.data?.rateLimit) rateLimit = d.data.rateLimit;
      if (s || d?.fatal) break;
    }
    if (!s) return { nodes, count, error: short(d?.errors) || 'no data', fatal: Boolean(d?.fatal), rateLimit };
    count = Number(s.issueCount) || 0;
    for (const n of s.nodes || []) if (n && n.url) nodes.push(n);
    await respectRateLimit(rateLimit, o);
    if (!s.pageInfo?.hasNextPage) return { nodes, count, error: '', fatal: false, rateLimit };
    after = s.pageInfo.endCursor;
    await o.sleep(PAGE_PAUSE_MS);
  }
}

const day = (d) => d.toISOString().slice(0, 10);
const pad = (n) => String(n).padStart(2, '0');

/**
 * Every pull request authored by `username` (optionally only those updated since `since`).
 * -> { nodes: [rawPRNode], count, error: '' | string, fatal: boolean, rateLimit: {remaining, resetAt} | null }
 * `count` is GitHub's issueCount for the whole query. Never throws for GitHub-side failures: a non-empty `error`
 * means the result may be partial. Above 1000 results the query is split by `created:` year (and by month when a
 * single year still exceeds the cap).
 */
export async function fetchUserPRs(username, opts = {}) {
  const o = resolveOpts(opts);
  const out = (nodes, count, error, extra = {}) => ({ nodes, count, error, fatal: false, rateLimit: null, ...extra });
  if (!isValidLogin(username)) return out([], 0, `invalid GitHub login: ${short(String(username))}`);
  if (typeof o.fetch !== 'function') return out([], 0, 'fetch is not available');
  if (!o.token) return out([], 0, 'GITHUB_TOKEN is not set', { fatal: true });
  const since = opts.since ? new Date(opts.since) : null;
  if (since && Number.isNaN(since.getTime())) return out([], 0, 'invalid since date');
  const call = { ...opts, ...o };

  try {
    const q = `author:${username} type:pr${since ? ` updated:>=${day(since)}` : ''}`;
    const byUrl = new Map();
    const add = (list) => { for (const n of list) if (!byUrl.has(n.url)) byUrl.set(n.url, n); };
    const first = await pageAll(q, call);
    add(first.nodes);
    let { error, fatal, rateLimit } = first;
    const count = first.count;

    if (count > SEARCH_CAP && !fatal) { // split by year to get past the 1000-result cap
      const lastYear = o.now().getUTCFullYear() + 1;
      for (let y = FIRST_YEAR; y <= lastYear && !fatal; y++) {
        const r = await pageAll(`${q} created:${y}-01-01..${y}-12-31`, call);
        add(r.nodes);
        error ||= r.error; fatal ||= r.fatal; rateLimit = r.rateLimit ?? rateLimit;
        if (r.count <= SEARCH_CAP || r.error) continue;
        for (let m = 1; m <= 12 && !fatal; m++) {
          const end = new Date(Date.UTC(y, m, 0)).getUTCDate();
          const mr = await pageAll(`${q} created:${y}-${pad(m)}-01..${y}-${pad(m)}-${pad(end)}`, call);
          add(mr.nodes);
          error ||= mr.error; fatal ||= mr.fatal; rateLimit = mr.rateLimit ?? rateLimit;
          if (!mr.error && mr.count > SEARCH_CAP) error ||= `more than ${SEARCH_CAP} PRs created in ${y}-${pad(m)}: result is partial`;
        }
      }
    }
    return { nodes: [...byUrl.values()], count, error, fatal, rateLimit };
  } catch (e) {
    return out([], 0, `unexpected error: ${e?.message || e}`);
  }
}

// ---------- REST: user lookups ----------

async function restUser(path, opts) {
  const o = resolveOpts(opts);
  if (typeof o.fetch !== 'function') throw new Error('fetch is not available');
  const attempts = opts?.attempts ?? 4;
  let last = 'gave up';
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res;
    try {
      res = await o.fetch(`${apiBase()}${path}`, {
        headers: headers(o, { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      last = `network error: ${e?.message || e}`;
      if (attempt < attempts - 1) await o.sleep(3000 * (attempt + 1));
      continue;
    }
    if (res.status === 404) return null;
    if (res.ok) {
      const u = await res.json();
      if (!u || typeof u.login !== 'string') throw new Error('GitHub returned an unexpected user object');
      return { login: u.login, id: Number.isFinite(u.id) ? u.id : null, name: typeof u.name === 'string' ? u.name : null };
    }
    last = `http ${res.status}`;
    if (res.status === 401) throw new Error('GitHub: http 401: bad credentials (check GITHUB_TOKEN)');
    if (attempt === attempts - 1) break;
    const retryAfter = Number.parseInt(header(res, 'retry-after') ?? '', 10);
    const limited = res.status === 403 || res.status === 429;
    if (!limited && res.status < 500) break; // other 4xx: retrying will not help
    const wait = (retryAfter > 0 ? retryAfter * 1000 : 0) || (limited ? rateResetWait(res, o) : 0) || (limited ? 30_000 : 3000) * (attempt + 1);
    o.log(`  http ${res.status} on ${path}, sleep ${Math.round(wait / 1000)}s`);
    await o.sleep(wait);
  }
  throw new Error(`GitHub: ${last} for ${path}`);
}

/** REST GET /users/:login -> { login, id, name } | null on 404 (also for strings that cannot be a login). */
export async function getUser(login, opts = {}) {
  if (!isValidLogin(login)) return null;
  return restUser(`/users/${encodeURIComponent(login)}`, opts);
}

/** REST GET /user/:id -> { login, id, name } | null on 404. Resolves the current login of a renamed account. */
export async function getUserById(id, opts = {}) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return restUser(`/user/${n}`, opts);
}

export default { fetchUserPRs, getUser, getUserById, gql, pageAll, isValidLogin };
