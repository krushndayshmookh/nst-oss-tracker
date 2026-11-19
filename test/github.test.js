// src/github.js against an in-memory GitHub (global fetch is never used: the sandbox cannot reach the API).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSleep, json, mockGitHub } from './helpers/github.js';
import { prNode } from './helpers/fixtures.js';
import { fetchUserPRs, getUser, getUserById, gql, isValidLogin, SEARCH_QUERY } from '../src/github.js';

const NOW = new Date('2026-11-19T12:00:00Z');
const AUTHOR = { login: 'Alice', databaseId: 42 };

/** n PR nodes of one author, one per day going back from `from`. */
function prs(n, { repo = 'apache/airflow', from = '2026-11-01T10:00:00Z', stepHours = 24, start = 1 } = {}) {
  const t0 = new Date(from).getTime();
  return Array.from({ length: n }, (_, i) => {
    const createdAt = new Date(t0 - i * stepHours * 3600 * 1000).toISOString();
    return prNode({ repo, number: start + i, createdAt, updatedAt: createdAt, state: 'OPEN', author: AUTHOR });
  });
}
function setup(users) {
  const gh = mockGitHub({ users });
  const sleep = fakeSleep();
  return { gh, sleep, opts: { fetch: gh.fetch, token: 'test-token', sleep, now: () => NOW } };
}

test('query: same fields as the legacy fetcher plus updatedAt and the author id', () => {
  for (const f of ['issueCount', 'pageInfo{hasNextPage endCursor}', 'url number title state isDraft createdAt updatedAt mergedAt closedAt additions deletions changedFiles',
    'author{login ... on User{databaseId}}', 'comments{totalCount}', 'reviews{totalCount}',
    'repository{nameWithOwner isFork isArchived isPrivate stargazerCount forkCount description createdAt',
    'owner{login __typename}', 'primaryLanguage{name}', 'licenseInfo{spdxId}', 'type: ISSUE', 'rateLimit{remaining resetAt}']) {
    assert.ok(SEARCH_QUERY.includes(f), `query lacks ${f}`);
  }
});

test('fetchUserPRs: pages through all results, 50 at a time', async () => {
  const { gh, sleep, opts } = setup([{ login: 'Alice', id: 42, prs: prs(120) }]);
  const res = await fetchUserPRs('alice', opts);
  assert.equal(res.error, '');
  assert.equal(res.count, 120);
  assert.equal(res.nodes.length, 120);
  assert.equal(new Set(res.nodes.map((n) => n.url)).size, 120);
  assert.deepEqual(res.rateLimit, gh.rateLimit);
  const calls = gh.graphql();
  assert.deepEqual(calls.map((c) => [c.first, c.after]), [[50, null], [50, '50'], [50, '100']]);
  assert.ok(calls.every((c) => c.q === 'author:alice type:pr'));
  assert.equal(calls[0].headers.authorization, 'bearer test-token');
  assert.equal(calls[0].headers['user-agent'], 'nst-oss-status');
  assert.deepEqual(sleep.calls, [300, 300], 'short pause between pages only');
});

test('fetchUserPRs: `since` becomes an updated:>= filter', async () => {
  const list = prs(10); // one per day, newest 2026-11-01
  const { gh, opts } = setup([{ login: 'Alice', id: 42, prs: list }]);
  const res = await fetchUserPRs('Alice', { ...opts, since: new Date('2026-10-29T23:10:00Z') });
  assert.equal(gh.graphql()[0].q, 'author:Alice type:pr updated:>=2026-10-29');
  assert.equal(res.error, '');
  assert.deepEqual(res.nodes.map((n) => n.createdAt.slice(0, 10)), ['2026-11-01', '2026-10-31', '2026-10-30', '2026-10-29']);
});

test('fetchUserPRs: 502 shrinks the page (50 -> 20) after three short retries and still returns everything', async () => {
  const { gh, sleep, opts } = setup([{ login: 'Alice', id: 42, prs: prs(45) }]);
  gh.intercept = (c) => (c.kind === 'graphql' && c.first > 20 ? new Response('Bad Gateway', { status: 502 }) : undefined);
  const res = await fetchUserPRs('alice', opts);
  assert.equal(res.error, '');
  assert.equal(res.nodes.length, 45);
  const calls = gh.graphql().map((c) => [c.first, c.after]);
  // every page: 3 attempts at 50 (4s, 8s, 12s backoff), then 20 works
  assert.deepEqual(calls.slice(0, 4), [[50, null], [50, null], [50, null], [20, null]]);
  assert.deepEqual(calls.slice(4, 8), [[50, '20'], [50, '20'], [50, '20'], [20, '20']]);
  assert.deepEqual(sleep.calls.slice(0, 4), [4000, 8000, 12000, 300]);
  assert.equal(calls.length, 12);
});

test('fetchUserPRs: shrinks down to 3 and reports an error (no throw, partial nodes kept) when nothing works', async () => {
  const { gh, sleep, opts } = setup([{ login: 'Alice', id: 42, prs: prs(60) }]);
  let failing = false;
  gh.intercept = (c) => {
    if (c.kind !== 'graphql') return undefined;
    if (c.after) failing = true; // first page fine, second page always 504
    return failing ? new Response('Gateway Timeout', { status: 504 }) : undefined;
  };
  const res = await fetchUserPRs('alice', opts);
  assert.match(res.error, /gave up.*504/);
  assert.equal(res.fatal, false);
  assert.equal(res.count, 60);
  assert.equal(res.nodes.length, 50, 'first page is kept');
  assert.deepEqual(gh.graphql().slice(1).map((c) => c.first), [50, 50, 50, 20, 20, 20, 8, 8, 8, 3, 3, 3]);
  assert.ok(sleep.calls.every((ms) => ms <= 12000));
});

test('gql: honours Retry-After, retries rate-limit bodies, gives up after `attempts`', async () => {
  const sleep = fakeSleep();
  const answers = [
    new Response('slow down', { status: 403, headers: { 'retry-after': '7' } }),
    json({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }),
    new Response('boom', { status: 500 }),
    json({ data: { ok: 1 } }),
  ];
  let n = 0;
  const fetch = async () => answers[n++];
  const d = await gql('{ok}', {}, { fetch, token: 't', sleep });
  assert.deepEqual(d, { data: { ok: 1 } });
  assert.deepEqual(sleep.calls, [7000, 60000, 90000]);

  const sleep2 = fakeSleep();
  const d2 = await gql('{ok}', {}, { fetch: async () => { throw new Error('ECONNRESET'); }, token: 't', sleep: sleep2, attempts: 3 });
  assert.equal(d2.data, null);
  assert.match(d2.errors[0].message, /gave up.*ECONNRESET/);
  assert.deepEqual(sleep2.calls, [15000, 30000, 45000]);
});

test('gql: a primary rate limit (403, x-ratelimit-remaining 0) sleeps until the reset', async () => {
  const sleep = fakeSleep();
  const reset = Math.floor(NOW.getTime() / 1000) + 600;
  const answers = [
    new Response('rate limited', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }),
    json({ data: { ok: 1 } }),
  ];
  let n = 0;
  await gql('{ok}', {}, { fetch: async () => answers[n++], token: 't', sleep, now: () => NOW });
  assert.deepEqual(sleep.calls, [605000]);
});

test('fetchUserPRs: sleeps until the reset when fewer than 100 rate-limit points remain', async () => {
  const { gh, sleep, opts } = setup([{ login: 'Alice', id: 42, prs: prs(60) }]);
  gh.rateLimit = { remaining: 99, resetAt: new Date(NOW.getTime() + 10 * 60 * 1000).toISOString() };
  gh.intercept = (c) => { if (c.after) gh.rateLimit = { remaining: 4999, resetAt: gh.rateLimit.resetAt }; };
  const res = await fetchUserPRs('alice', opts);
  assert.equal(res.error, '');
  assert.equal(res.nodes.length, 60);
  assert.deepEqual(sleep.calls, [605000, 300], 'slept 10 min (+5 s) after page 1, not after page 2');
  assert.equal(res.rateLimit.remaining, 4999);

  // exactly 100 left is still fine
  const b = setup([{ login: 'Alice', id: 42, prs: prs(3) }]);
  b.gh.rateLimit = { remaining: 100, resetAt: gh.rateLimit.resetAt };
  await fetchUserPRs('alice', b.opts);
  assert.deepEqual(b.sleep.calls, []);
});

test('fetchUserPRs: more than 1000 results are split by created: year', async () => {
  // 1,300 PRs, one every 12 hours back from Nov 2026: 2026 and 2025 both hold several hundred
  const list = prs(1300, { stepHours: 12 });
  const { gh, opts } = setup([{ login: 'Alice', id: 42, prs: list }]);
  const res = await fetchUserPRs('alice', opts);
  assert.equal(res.error, '');
  assert.equal(res.count, 1300);
  assert.equal(res.nodes.length, 1300);
  assert.equal(new Set(res.nodes.map((n) => n.url)).size, 1300, 'no duplicates between the capped pass and the yearly passes');
  const queries = [...new Set(gh.graphql().map((c) => c.q))];
  assert.equal(queries[0], 'author:alice type:pr');
  assert.ok(queries.includes('author:alice type:pr created:2015-01-01..2015-12-31'));
  assert.ok(queries.includes('author:alice type:pr created:2026-01-01..2026-12-31'));
  assert.ok(queries.includes('author:alice type:pr created:2027-01-01..2027-12-31'), 'covers the year after the current one');
  assert.equal(queries.length, 1 + (2027 - 2015 + 1));
});

test('fetchUserPRs: a single year above 1000 is split by month; `since` is kept in the split queries', async () => {
  const list = prs(1500, { stepHours: 4, from: '2026-11-01T10:00:00Z' }); // 250 days, all in 2026
  const { gh, opts } = setup([{ login: 'Alice', id: 42, prs: list }]);
  const res = await fetchUserPRs('alice', { ...opts, since: new Date('2026-01-01T00:00:00Z') });
  assert.equal(res.error, '');
  assert.equal(res.nodes.length, 1500);
  const queries = new Set(gh.graphql().map((c) => c.q));
  assert.ok(queries.has('author:alice type:pr updated:>=2026-01-01 created:2026-02-01..2026-02-28'));
  assert.ok(queries.has('author:alice type:pr updated:>=2026-01-01 created:2026-12-01..2026-12-31'));
});

test('fetchUserPRs: an unknown login is simply an empty result', async () => {
  const { opts } = setup([]);
  assert.deepEqual(await fetchUserPRs('ghost', opts), { nodes: [], count: 0, error: '', fatal: false, rateLimit: { remaining: 4900, resetAt: '2030-01-01T00:00:00Z' } });
});

test('fetchUserPRs: never throws; bad login, missing token and 401 are reported', async () => {
  const { gh, sleep, opts } = setup([]);
  for (const bad of ['a b', 'x" OR author:y', '', '-lead', 'a'.repeat(40), null]) {
    const r = await fetchUserPRs(bad, opts);
    assert.match(r.error, /invalid GitHub login/);
  }
  assert.equal(gh.calls.length, 0, 'invalid logins never reach GitHub');
  assert.ok(isValidLogin('Krushn-Dayshmookh') && isValidLogin('a') && !isValidLogin('a_b'));

  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    const r = await fetchUserPRs('alice', { fetch: gh.fetch, sleep });
    assert.equal(r.error, 'GITHUB_TOKEN is not set');
    assert.equal(r.fatal, true);
  } finally {
    if (saved !== undefined) process.env.GITHUB_TOKEN = saved;
  }

  gh.intercept = () => json({ message: 'Bad credentials' }, { status: 401 });
  const r = await fetchUserPRs('alice', opts);
  assert.match(r.error, /401/);
  assert.equal(r.fatal, true);
  assert.equal(gh.graphql().length, 1, '401 is not retried');
  assert.deepEqual(sleep.calls, []);

  const r2 = await fetchUserPRs('alice', { ...opts, fetch: async () => json({ data: null, errors: [{ message: 'Something odd' }] }) });
  assert.match(r2.error, /Something odd/);
});

test('fetchUserPRs: null / empty nodes are dropped', async () => {
  const [a, b] = prs(2);
  const fetch = async () => json({ data: { s: { issueCount: 4, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [a, null, {}, b] }, rateLimit: { remaining: 4000, resetAt: null } } });
  const r = await fetchUserPRs('alice', { fetch, token: 't', sleep: fakeSleep() });
  assert.deepEqual(r.nodes.map((n) => n.url), [a.url, b.url]);
});

test('getUser / getUserById: user object or null on 404', async () => {
  const { gh, sleep, opts } = setup([{ login: 'Alice', id: 42, name: 'Alice A' }, { login: 'bob', id: 7 }]);
  assert.deepEqual(await getUser('alice', opts), { login: 'Alice', id: 42, name: 'Alice A' });
  assert.deepEqual(await getUser('bob', opts), { login: 'bob', id: 7, name: null });
  assert.equal(await getUser('ghost', opts), null);
  assert.equal(await getUser('not a login', opts), null);
  assert.deepEqual(await getUserById(42, opts), { login: 'Alice', id: 42, name: 'Alice A' });
  assert.equal(await getUserById(999, opts), null);
  assert.equal(await getUserById(null, opts), null);
  assert.deepEqual(gh.rest().map((c) => c.path), ['/users/alice', '/users/bob', '/users/ghost', '/user/42', '/user/999']);
  assert.equal(gh.rest()[0].headers.authorization, 'bearer test-token');

  // works without a token (unauthenticated REST), retries a 5xx, throws when GitHub stays down
  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    let n = 0;
    gh.intercept = () => (n++ === 0 ? new Response('oops', { status: 503 }) : undefined);
    assert.equal((await getUser('alice', { fetch: gh.fetch, sleep })).id, 42);
    assert.equal(gh.rest().at(-1).headers.authorization, undefined);
  } finally {
    if (saved !== undefined) process.env.GITHUB_TOKEN = saved;
  }
  gh.intercept = () => new Response('oops', { status: 503 });
  await assert.rejects(getUser('alice', opts), /http 503/);
  await assert.rejects(getUserById(42, { ...opts, fetch: async () => { throw new Error('offline'); } }), /offline/);
});
