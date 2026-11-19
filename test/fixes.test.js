// Regression tests for the review findings on fetching, importing and security hardening.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { startMongo } from './helpers/mongo.js';
import { startApp, TEST_PASSWORD } from './helpers/app.js';
import { insertStudents, prNode } from './helpers/fixtures.js';
import { fakeSleep, mockGitHub } from './helpers/github.js';
import { collections, ensureIndexes } from '../src/db.js';
import { refreshAggregates, upsertPRs } from '../src/ingest.js';
import { invalidateContext } from '../src/classify.js';
import { adminProblem, loadConfig } from '../src/config.js';
import { enqueue, registerHandler, whenIdle } from '../src/jobs.js';
import { sync } from '../src/jobHandlers.js';
import { bucketOf, clientIp, isPrivateAddress } from '../src/limits.js';
import { GLOBAL_SLOW_AFTER, GLOBAL_SLOW_MS } from '../src/auth.js';
import { importLegacy } from '../scripts/import_legacy.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NOW = new Date('2026-11-19T21:00:00Z');
const LAST = new Date('2026-11-18T21:00:00Z');
const EIGHT_DAYS_AGO = new Date(NOW.getTime() - 8 * 86400000);

let mongo;
before(async () => { mongo = await startMongo(); });
after(async () => { await mongo?.stop(); });

async function freshDb() {
  const db = mongo.client.db(`f_${Math.random().toString(16).slice(2, 10)}`);
  await ensureIndexes(db);
  invalidateContext();
  return db;
}
function ctxOf() {
  const lines = [];
  return { lines, log: (l) => lines.push(l), progress() {} };
}
function harness(users) {
  const gh = mockGitHub({ users });
  return { gh, opts: { fetch: gh.fetch, token: 'test-token', sleep: fakeSleep(), now: () => NOW, concurrency: 1 } };
}
const author = (login, id) => ({ login, databaseId: id });

// ------------------------------------------------------------------ high: stale urls after a rename / transfer

test('full fetch: a renamed account and transferred repos are not counted twice; overrides follow the PR and the repo', async () => {
  const db = await freshDb();
  const c = collections(db);
  const [alice] = await insertStudents(db, [{ username: 'alice', githubId: 7, loginCheckedAt: EIGHT_DAYS_AGO, lastSyncedAt: LAST }]);
  const at = { createdAt: '2026-03-01T10:00:00Z', mergedAt: '2026-03-02T10:00:00Z', updatedAt: '2026-03-02T10:00:00Z' };
  const A = author('alice', 7);
  // stored the legacy way (no GitHub id): matched later by number + creation time
  await upsertPRs(db, alice, [
    prNode({ repo: 'alice/site', number: 1, ownerType: 'User', stars: 2, author: A, ...at }),
    prNode({ repo: 'oldorg/proj', number: 5, stars: 5000, author: A, ...at, createdAt: '2026-03-03T10:00:00Z' }),
    prNode({ repo: 'oldorg/tool', number: 9, stars: 300, author: A, ...at, createdAt: '2026-03-04T10:00:00Z' }),
    prNode({ repo: 'oldorg/deleted', number: 2, stars: 900, author: A, ...at, createdAt: '2026-03-05T10:00:00Z' }),
  ]);
  await c.prs.updateOne({ _id: 'https://github.com/oldorg/proj/pull/5' }, { $set: { override: 'open_source', overrideNote: 'checked by hand', overrideAt: LAST } });
  await c.repos.updateOne({ _id: 'oldorg/tool' }, { $set: { override: 'exclude', overrideNote: 'tutorial', overrideAt: LAST } });
  await refreshAggregates(db);
  assert.deepEqual([(await c.students.findOne({ _id: 'alice' })).stats.totalPrs, (await c.students.findOne({ _id: 'alice' })).stats.osMerged], [4, 3]);

  // GitHub now: the account is alice-dev, the org repos moved to neworg, oldorg/deleted is gone
  const N = author('alice-dev', 7);
  const { gh, opts } = harness([{ login: 'alice-dev', id: 7, prs: [
    { ...prNode({ repo: 'alice-dev/site', number: 1, ownerType: 'User', stars: 2, author: N, ...at }), databaseId: 101 },
    { ...prNode({ repo: 'neworg/proj', number: 5, stars: 5000, author: N, ...at, createdAt: '2026-03-03T10:00:00Z' }), databaseId: 102 },
    { ...prNode({ repo: 'neworg/tool', number: 9, stars: 300, author: N, ...at, createdAt: '2026-03-04T10:00:00Z' }), databaseId: 103 },
  ] }]);
  const ctx = ctxOf();
  const summary = await sync(db, {}, ctx, opts);
  assert.deepEqual({ ok: summary.ok, renamed: summary.renamed, moved: summary.prsMoved, removed: summary.prsRemoved }, { ok: 1, renamed: 1, moved: 3, removed: 1 });
  assert.ok(gh.graphql().some((x) => x.q === 'author:alice-dev type:pr'));

  const prs = await c.prs.find({ author: 'alice' }).sort({ number: 1 }).toArray();
  assert.deepEqual(prs.map((p) => p._id), [
    'https://github.com/alice-dev/site/pull/1', 'https://github.com/neworg/tool/pull/9'.replace('tool/pull/9', 'proj/pull/5'), 'https://github.com/neworg/tool/pull/9',
  ].sort((a, b) => Number(a.split('/').pop()) - Number(b.split('/').pop())), 'no PR is stored under its old url');
  assert.deepEqual(prs.map((p) => p.ghId), [101, 102, 103]);
  const s = await c.students.findOne({ _id: 'alice' });
  assert.deepEqual([s.username, s.stats.totalPrs, s.stats.osMerged, s.stats.byCategory.own_repo], ['alice-dev', 3, 1, 1], 'totals are not doubled');
  const moved = await c.prs.findOne({ _id: 'https://github.com/neworg/proj/pull/5' });
  assert.deepEqual([moved.override, moved.overrideNote, moved.category], ['open_source', 'checked by hand', 'open_source'], 'the PR decision moved with the PR');
  const tool = await c.repos.findOne({ _id: 'neworg/tool' });
  assert.deepEqual([tool.override, tool.overrideNote, tool.category, (await c.prs.findOne({ number: 9 })).category], ['exclude', 'tutorial', 'low_signal', 'low_signal'],
    'the repo decision moved with the repo');
  for (const old of ['oldorg/proj', 'oldorg/tool', 'oldorg/deleted', 'alice/site']) {
    assert.equal((await c.repos.findOne({ _id: old })).stats.prs, 0, `${old} is no longer listed`);
  }

  // a second full fetch changes nothing
  const again = await sync(db, { full: true }, ctxOf(), opts);
  assert.deepEqual([again.prsMoved ?? 0, again.prsRemoved ?? 0, await c.prs.countDocuments({})], [0, 0, 3]);
});

test('full fetch: nothing is removed when GitHub returns nothing or far too little', async () => {
  const db = await freshDb();
  const c = collections(db);
  const [carol, dan] = await insertStudents(db, [
    { username: 'carol', githubId: 9, loginCheckedAt: NOW, lastSyncedAt: LAST },
    { username: 'dan', githubId: 10, loginCheckedAt: NOW, lastSyncedAt: LAST },
  ]);
  await upsertPRs(db, carol, [prNode({ repo: 'apache/airflow', number: 1 }), prNode({ repo: 'apache/airflow', number: 2 })]);
  await upsertPRs(db, dan, Array.from({ length: 50 }, (_, i) => prNode({ repo: 'apache/airflow', number: 100 + i })));
  // carol: the account exists but the search answers with zero results; dan: 2 of 50 come back
  const { opts } = harness([{ login: 'carol', id: 9, prs: [] }, { login: 'dan', id: 10, prs: [prNode({ repo: 'apache/airflow', number: 100 }), prNode({ repo: 'apache/airflow', number: 101 })] }]);
  const ctx = ctxOf();
  const summary = await sync(db, { full: true }, ctx, opts);
  assert.equal(summary.ok, 2);
  assert.deepEqual([await c.prs.countDocuments({ author: 'carol' }), await c.prs.countDocuments({ author: 'dan' })], [2, 50]);
  assert.equal(ctx.lines.filter((l) => /stale PRs are not removed/.test(l)).length, 2);
});

// ------------------------------------------------------------------ high: stale student snapshot

test('sync: an admin edit, deactivation or purge made while the run is in flight is not undone', async () => {
  const db = await freshDb();
  const c = collections(db);
  const [bob, zed] = await insertStudents(db, [
    { username: 'bob', campus: 'RU', batch: 2025, githubId: 21, loginCheckedAt: NOW, lastSyncedAt: LAST },
    { username: 'zed', campus: 'RU', batch: 2025, githubId: 22, loginCheckedAt: NOW, lastSyncedAt: new Date(LAST.getTime() + 1000) },
  ]);
  const bobPr = prNode({ repo: 'org/x', number: 1, stars: 900, state: 'OPEN', createdAt: '2026-11-18T00:00:00Z', updatedAt: '2026-11-18T00:00:00Z', author: author('bob', 21) });
  await upsertPRs(db, bob, [bobPr]);
  await upsertPRs(db, zed, [prNode({ repo: 'org/x', number: 2, stars: 900, author: author('zed', 22), updatedAt: '2026-11-18T00:00:00Z' })]);
  await refreshAggregates(db);

  const { gh, opts } = harness([
    { login: 'bob', id: 21, prs: [{ ...bobPr, state: 'MERGED', mergedAt: '2026-11-19T10:00:00Z', closedAt: '2026-11-19T10:00:00Z', updatedAt: '2026-11-19T10:00:00Z' }] },
    { login: 'zed', id: 22, prs: [prNode({ repo: 'org/x', number: 3, stars: 900, author: author('zed', 22), createdAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-19T00:00:00Z' })] },
  ]);
  // The run already holds its (now stale) student documents when the admin acts, exactly like a long nightly run.
  gh.intercept = async (call) => {
    if (call.kind !== 'graphql') return undefined;
    if (/author:bob\b/.test(call.q)) { // PATCH /students/bob {active:false, campus:'ADYPU'}
      await c.students.updateOne({ _id: 'bob' }, { $set: { active: false, campus: 'ADYPU' } });
      await c.prs.updateMany({ author: 'bob' }, { $set: { active: false, campus: 'ADYPU' } });
    }
    if (/author:zed\b/.test(call.q)) { // DELETE /students/zed?purge=1
      await c.prs.deleteMany({ author: 'zed' });
      await c.students.deleteOne({ _id: 'zed' });
    }
    return undefined;
  };
  const ctx = ctxOf();
  await sync(db, {}, ctx, opts);

  const pr = await c.prs.findOne({ _id: bobPr.url });
  assert.deepEqual([pr.state, pr.active, pr.campus], ['merged', false, 'ADYPU'], 'the fetched change is stored, the deactivation and the campus edit survive');
  assert.equal((await c.students.findOne({ _id: 'bob' })).active, false);
  assert.equal(await c.prs.countDocuments({ author: 'zed' }), 0, 'no orphan PRs for a student purged mid-run');
  assert.equal(await c.students.countDocuments({ _id: 'zed' }), 0);
  assert.equal((await c.repos.findOne({ _id: 'org/x' })).stats.prs, 0, 'nothing of the deactivated or purged students is public');
  assert.ok(ctx.lines.some((l) => /zed: removed while the run was in flight/.test(l)));
});

// ------------------------------------------------------------------ high: re-running the import

test('import_legacy: a re-run never puts old file contents over synced data', async () => {
  const db = await freshDb();
  const c = collections(db);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oss-reimport-'));
  try {
    await mkdir(path.join(dir, 'raw'));
    await writeFile(path.join(dir, 'students.csv'),
      'campus,year,batch,name,github_username,github_profile,email,enrolment_no,name_source,sources,notes\nRU,2nd year,2025,Asha,asha,,,,sheet,Sheet,\n');
    const legacy = prNode({ repo: 'org/x', number: 1, stars: 900, state: 'OPEN', createdAt: '2026-10-01T10:00:00Z' });
    await writeFile(path.join(dir, 'raw', 'asha.json'), JSON.stringify({ user: 'asha', count: 1, prs: [legacy], error: '' }));
    await importLegacy(db, { data: dir });
    const first = await c.prs.findOne({ _id: legacy.url });
    assert.deepEqual([first.state, first.stars, first.tier, first.updatedAt], ['open', 900, 'established', null]);

    // a sync sees the PR merged and the repo at 1200 stars
    const asha = await c.students.findOne({ _id: 'asha' });
    await upsertPRs(db, asha, [{ ...legacy, state: 'MERGED', mergedAt: '2026-11-10T10:00:00Z', closedAt: '2026-11-10T10:00:00Z', updatedAt: '2026-11-10T10:00:00Z',
      repository: { ...legacy.repository, stargazerCount: 1200 }, author: author('asha', 77) }]);
    await refreshAggregates(db);
    assert.equal((await c.students.findOne({ _id: 'asha' })).stats.osMerged, 1);

    await importLegacy(db, { data: dir });
    const pr = await c.prs.findOne({ _id: legacy.url });
    assert.deepEqual([pr.state, pr.stars, pr.tier, pr.updatedAt?.toISOString()], ['merged', 1200, 'major', '2026-11-10T10:00:00.000Z']);
    assert.equal((await c.repos.findOne({ _id: 'org/x' })).stars, 1200);
    const after2 = await c.students.findOne({ _id: 'asha' });
    assert.deepEqual([after2.stats.osMerged, after2.stats.osMajorMerged, after2.githubId], [1, 1, 77]);
    assert.equal(await c.prs.countDocuments({}), 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ medium: star changes on unchanged PRs

test('sync (incremental): fresh repo stars are kept even when the PR itself did not change', async () => {
  const db = await freshDb();
  const c = collections(db);
  const [eve] = await insertStudents(db, [{ username: 'eve', githubId: 31, loginCheckedAt: NOW, lastSyncedAt: LAST }]);
  const E = author('eve', 31);
  const big = prNode({ repo: 'org/x', number: 1, stars: 900, updatedAt: '2026-11-18T00:00:00Z', createdAt: '2026-11-17T00:00:00Z', mergedAt: '2026-11-18T00:00:00Z', author: E });
  const small = prNode({ repo: 'org/small', number: 2, stars: 40, updatedAt: '2026-11-18T00:00:00Z', createdAt: '2026-11-17T00:00:00Z', mergedAt: '2026-11-18T00:00:00Z', author: E });
  const older = prNode({ repo: 'org/small', number: 3, stars: 40, updatedAt: '2026-01-02T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', mergedAt: '2026-01-02T00:00:00Z', author: E });
  await upsertPRs(db, eve, [big, small, older]);
  await refreshAggregates(db);
  assert.deepEqual([(await c.prs.findOne({ number: 1 })).tier, (await c.prs.findOne({ number: 2 })).category, (await c.students.findOne({ _id: 'eve' })).stats.osMerged], ['established', 'low_signal', 1]);

  const stars = (node, n) => ({ ...node, repository: { ...node.repository, stargazerCount: n } });
  const { opts } = harness([{ login: 'eve', id: 31, prs: [{ ...stars(big, 1500), title: 'MUST NOT BE WRITTEN' }, stars(small, 60), stars(older, 60)] }]);
  const summary = await sync(db, {}, ctxOf(), opts);
  assert.deepEqual([summary.prs, summary.prsNew, summary.prsUpdated], [0, 0, 0], 'no PR counts as changed');

  const one = await c.prs.findOne({ number: 1 });
  assert.deepEqual([one.stars, one.tier, one.title], [1500, 'major', 'Fix a thing'], 'the repo crossed the major threshold; the unchanged PR text is left alone');
  assert.equal((await c.repos.findOne({ _id: 'org/x' })).stars, 1500);
  assert.deepEqual([(await c.repos.findOne({ _id: 'org/small' })).stars, (await c.repos.findOne({ _id: 'org/small' })).category], [60, 'open_source']);
  assert.deepEqual((await c.prs.find({ repoLc: 'org/small' }).toArray()).map((p) => p.category), ['open_source', 'open_source'], 'also the PR outside the sync window');
  const s = (await c.students.findOne({ _id: 'eve' })).stats;
  assert.deepEqual([s.osMerged, s.osMajorMerged], [3, 1]);
});

// ------------------------------------------------------------------ medium: students without a GitHub id

test('sync: a student without githubId whose login no longer exists is flagged instead of syncing nothing forever', async () => {
  const db = await freshDb();
  const c = collections(db);
  await insertStudents(db, [
    { username: 'renamed-away', lastSyncedAt: LAST },                       // imported: githubId null, never checked
    { username: 'still-here', lastSyncedAt: new Date(LAST.getTime() + 1000) },
  ]);
  const { gh, opts } = harness([{ login: 'still-here', id: 55, prs: [] }]);
  const ctx = ctxOf();
  const first = await sync(db, {}, ctx, opts);
  assert.deepEqual({ ok: first.ok, notFound: first.notFound, failed: first.failed }, { ok: 1, notFound: 1, failed: 0 });
  const gone = await c.students.findOne({ _id: 'renamed-away' });
  assert.deepEqual([gone.backfill.status, gone.backfill.error, gone.unresolvedSince?.toISOString(), gone.lastSyncedAt.toISOString()],
    ['error', 'not_found', NOW.toISOString(), LAST.toISOString()]);
  const here = await c.students.findOne({ _id: 'still-here' });
  assert.deepEqual([here.githubId, here.loginCheckedAt.toISOString(), here.backfill.status], [55, NOW.toISOString(), 'done']);
  assert.ok(!gh.graphql().some((x) => /renamed-away/.test(x.q)), 'no search for an account that does not exist');

  // the next night: the missing account is skipped, the resolved one is not looked up again for 7 days
  gh.calls.length = 0;
  const second = await sync(db, {}, ctxOf(), opts);
  assert.deepEqual([second.skipped, second.ok, gh.rest().length], [1, 1, 0]);
});

// ------------------------------------------------------------------ medium: login limiter

test('login limit: keyed on the visitor address behind the CDN; nobody is locked out by someone else', async () => {
  const db = await freshDb();
  const sleep = fakeSleep();
  const app = await startApp(db, { clientIpHeader: 'cf-connecting-ip' }, { authOptions: { sleep } });
  const login = (ip, password = 'wrong') => app.request('POST', '/api/admin/login', { password }, { headers: { 'cf-connecting-ip': ip, 'x-forwarded-for': '172.70.1.1' } });
  try {
    for (let i = 0; i < 10; i++) assert.equal((await login('203.0.113.9')).status, 401);
    const blocked = await login('203.0.113.9', TEST_PASSWORD);
    assert.deepEqual([blocked.status, blocked.body.error.code], [429, 'rate_limited'], 'the guessing address is blocked');
    assert.equal((await login('198.51.100.7', TEST_PASSWORD)).status, 200, 'an admin on another address still gets in');
    app.clearCookie();
    // IPv6: one bucket per /64
    for (let i = 0; i < 10; i++) assert.equal((await login(`2001:db8:1:2::${i + 1}`)).status, 401);
    assert.equal((await login('2001:db8:1:2:aaaa::1')).status, 429);
    assert.equal(sleep.calls.length, 0, 'no slow-down below the global budget');

    // guessing spread over many addresses: nobody is blocked, every attempt (right or wrong) is answered slowly
    for (let i = 0; i < GLOBAL_SLOW_AFTER - 20; i++) assert.equal((await login(`192.0.2.${i + 1}`)).status, 401);
    assert.equal(sleep.calls.length, 0);
    assert.equal((await login('192.0.2.200')).status, 401);
    assert.deepEqual(sleep.calls, [GLOBAL_SLOW_MS]);
    assert.equal((await login('198.51.100.8', TEST_PASSWORD)).status, 200, 'the right password still works, just slower');
    assert.equal(sleep.calls.length, 2);
  } finally { await app.close(); }

  // helpers
  assert.equal(isPrivateAddress('10.42.0.7') && isPrivateAddress('::ffff:10.42.0.7') && isPrivateAddress('127.0.0.1') && isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('203.0.113.9') || isPrivateAddress('2001:db8::1'), false);
  assert.equal(bucketOf('2001:db8:1:2:3:4:5:6'), bucketOf('2001:0db8:0001:0002::1'));
  // the header is ignored when the request did not come through the in-cluster proxy
  const direct = { socket: { remoteAddress: '203.0.113.50' }, headers: { 'cf-connecting-ip': '198.51.100.7' }, ip: '203.0.113.50' };
  assert.equal(clientIp(direct, { clientIpHeader: 'cf-connecting-ip' }), '203.0.113.50');
  assert.equal(clientIp({ ...direct, socket: { remoteAddress: '10.42.0.7' } }, { clientIpHeader: 'cf-connecting-ip' }), '198.51.100.7');
  assert.equal(clientIp({ ...direct, socket: { remoteAddress: '10.42.0.7' } }, {}), '203.0.113.50');
});

// ------------------------------------------------------------------ low: sessions and secrets

test('admin secrets: weak or placeholder values keep the admin area closed in production; rotating the password ends sessions', async () => {
  const strong = { production: true, adminPassword: 'a-long-random-admin-pw', sessionSecret: 'x'.repeat(32), sessionSecretSet: true };
  assert.equal(adminProblem(strong), '');
  assert.match(adminProblem({ ...strong, adminPassword: 'CHANGE-ME' }), /placeholder/);
  assert.match(adminProblem({ ...strong, adminPassword: 'short' }), /at least 16/);
  assert.match(adminProblem({ ...strong, sessionSecret: 'CHANGE-ME-CHANGE-ME-CHANGE-ME-CHANGE-ME' }), /placeholder/);
  assert.match(adminProblem({ ...strong, sessionSecret: 'tooshort' }), /at least 32/);
  assert.match(adminProblem({ ...strong, sessionSecretSet: false }), /SESSION_SECRET is unset/);
  assert.equal(adminProblem({ ...strong, production: false, adminPassword: 'dev', sessionSecret: 'dev' }), '', 'development is not restricted');
  assert.match(loadConfig({ NODE_ENV: 'production', ADMIN_PASSWORD: 'CHANGE-ME', SESSION_SECRET: 'CHANGE-ME' }).adminProblem, /placeholder/);

  const db = await freshDb();
  const weak = await startApp(db, { ...strong, adminPassword: 'CHANGE-ME' });
  try {
    assert.deepEqual((await weak.get('/api/admin/me')).body, { admin: false, configured: false });
    const r = await weak.login('CHANGE-ME');
    assert.deepEqual([r.status, r.body.error.code, r.headers.get('set-cookie')], [503, 'unavailable', null]);
    assert.equal((await weak.get('/api/meta')).status, 200, 'the public site keeps working');
  } finally { await weak.close(); }

  const one = await startApp(db, { sessionSecret: 'same-session-secret' });
  const two = await startApp(db, { sessionSecret: 'same-session-secret', adminPassword: 'a new password after rotation' });
  try {
    await one.login();
    assert.equal((await one.get('/api/admin/students')).status, 200);
    two.setCookie(one.getCookie());
    const stale = await two.get('/api/admin/students');
    assert.deepEqual([stale.status, stale.body.error.code], [401, 'unauthorized'], 'a cookie signed before the password changed is refused');
    assert.deepEqual((await two.get('/api/admin/me')).body, { admin: false, configured: true });
  } finally { await one.close(); await two.close(); }
});

// ------------------------------------------------------------------ low: headers, private notes, Unknown year

test('security headers; admin notes stay private; year=Unknown matches the campus table', async () => {
  const db = await freshDb();
  const c = collections(db);
  const [ann] = await insertStudents(db, [
    { username: 'ann', name: 'Ann', campus: 'RU', batch: 2025 },
    { username: 'nobatch', campus: 'RU', batch: null },
    { username: 'incoming', campus: 'RU', batch: 2030 },     // a batch that has not started: labelled Unknown
  ]);
  await upsertPRs(db, ann, [prNode({ repo: 'apache/airflow', number: 1 }), prNode({ repo: 'tiny/lib', number: 2, stars: 5 })]);
  await refreshAggregates(db);
  const app = await startApp(db);
  try {
    for (const p of ['/', '/admin', '/api/meta', '/api/nope']) {
      const res = await app.get(p, { raw: true });
      const csp = res.headers.get('content-security-policy');
      assert.match(csp, /default-src 'self'/, p);
      assert.match(csp, /script-src 'self'(;|$)/, p);
      assert.match(csp, /object-src 'none'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.equal(res.headers.get('strict-transport-security'), null, 'HSTS only in production');
    }

    await app.login();
    assert.equal((await app.post('/api/admin/prs/override', { url: 'https://github.com/apache/airflow/pull/1', override: 'not_open_source', note: 'copied PR' })).body.pr.overrideNote, 'copied PR');
    assert.equal((await app.post('/api/admin/repos/override', { repo: 'tiny/lib', override: 'include', note: 'friend of the dean' })).body.repo.overrideNote, 'friend of the dean');
    assert.equal((await app.post('/api/admin/owners/override', { login: 'apache', override: 'exclude', note: 'spam' })).body.org.overrideNote, 'spam');
    const paths = ['/api/prs?category=all&range=all', '/api/repos?category=all&range=all', '/api/orgs?category=all&range=all', '/api/students/ann?range=all',
      '/api/repos/tiny/lib?range=all', '/api/orgs/apache?range=all', '/api/repos/apache/airflow', '/api/prs?category=all'];
    const asAdmin = JSON.stringify(await Promise.all(paths.map(async (p) => (await app.get(p)).body)));
    for (const note of ['copied PR', 'friend of the dean', 'spam']) assert.ok(asAdmin.includes(note), `an admin sees "${note}"`);
    app.clearCookie();
    const asPublic = await Promise.all(paths.map(async (p) => (await app.get(p)).body));
    for (const note of ['copied PR', 'friend of the dean', 'spam']) assert.ok(!JSON.stringify(asPublic).includes(note), `"${note}" is not public`);
    const pr = asPublic[0].items.find((p) => p.number === 1);
    assert.deepEqual([pr.override, pr.overrideNote], ['not_open_source', null], 'the decision itself stays visible, its reason does not');

    // 'Unknown' = no batch or a future batch, in the label and in the filter alike
    const unknown = (await app.get('/api/students?year=Unknown&range=all')).body;
    assert.deepEqual(unknown.items.map((s) => s.username).sort(), ['incoming', 'nobatch']);
    assert.ok(unknown.items.every((s) => s.year === 'Unknown'));
    const row = (await app.get('/api/campuses')).body.rows.find((r) => r.campus === 'RU' && r.year === 'Unknown');
    assert.equal(row.students, unknown.total, 'the campus table and the filtered list add up');
    assert.deepEqual((await app.get('/api/students?year=Unknown&batch=2030&range=all')).body.items.map((s) => s.username), ['incoming']);
    assert.deepEqual((await app.get('/api/students?year=Unknown&q=nob&range=all')).body.items.map((s) => s.username), ['nobatch'], 'the search still narrows it');
    assert.equal((await app.get('/api/students?year=Unknown&batch=2025')).body.total, 0);
  } finally { await app.close(); }

  // the frontend refuses to turn anything but https:// into an external link
  const ui = await readFile(path.join(ROOT, 'public/js/lib/ui.js'), 'utf8');
  assert.match(ui, /export function safeUrl/);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(ui.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'no HTML injection sinks in the UI library');
});

// ------------------------------------------------------------------ medium: public endpoints are bounded

test('public API: request budget per visitor, export budget, search length cap, no body parsing', async () => {
  const db = await freshDb();
  await insertStudents(db, [{ username: 'ann' }]);
  const app = await startApp(db, { rateLimitPerMin: 5, exportLimitPerMin: 1, clientIpHeader: 'cf-connecting-ip' });
  const from = (ip, p) => app.get(p, { headers: { 'cf-connecting-ip': ip }, raw: true });
  try {
    assert.equal((await from('203.0.113.1', '/api/export/students.csv')).status, 200);
    const again = await from('203.0.113.1', '/api/export/students.csv');
    assert.equal(again.status, 429, 'second export within the minute');
    assert.ok(Number(again.headers.get('retry-after')) > 0);
    for (let i = 0; i < 3; i++) assert.equal((await from('203.0.113.1', '/api/meta')).status, 200);
    const limited = await from('203.0.113.1', '/api/meta');
    assert.equal(limited.status, 429);
    assert.equal(JSON.parse(limited.text).error.code, 'rate_limited');
    assert.equal((await from('203.0.113.2', '/api/meta')).status, 200, 'another visitor is not affected');
    for (let i = 0; i < 10; i++) assert.equal((await from('203.0.113.1', '/api/health')).status, 200, 'health probes are never limited');
    await app.login();
    for (let i = 0; i < 10; i++) assert.equal((await app.get('/api/meta', { headers: { 'cf-connecting-ip': '203.0.113.1' } })).status, 200, 'a logged-in admin is not limited');
  } finally { await app.close(); }

  const open = await startApp(db, { maxConcurrentExports: 0 });
  try {
    const busy = await open.get('/api/export/prs.csv');
    assert.deepEqual([busy.status, busy.body.error.code, busy.headers.get('retry-after')], [429, 'rate_limited', '5'], 'exports beyond the concurrency cap are refused');
    for (const p of ['/api/students', '/api/prs', '/api/repos', '/api/orgs']) {
      assert.equal((await open.get(`${p}?q=${'a'.repeat(101)}`)).status, 400, `${p}: q is capped`);
      assert.equal((await open.get(`${p}?q=${'a'.repeat(100)}`)).status, 200);
    }
    // an anonymous client cannot make the server parse a large body: only the admin API reads bodies, 100 kB at most
    const big = JSON.stringify({ password: 'x'.repeat(200 * 1024) });
    const login = await open.request('POST', '/api/admin/login', big);
    assert.deepEqual([login.status, login.body.error.message], [413, 'request body too large']);
    const bulk = await open.request('POST', '/api/admin/students/bulk', JSON.stringify({ csv: 'x'.repeat(200 * 1024) }));
    assert.equal(bulk.status, 413, 'the 5 MB allowance of the bulk upload needs a login first');
    await open.login();
    const ok = await open.request('POST', '/api/admin/students/bulk', JSON.stringify({ csv: `github_username,notes\nbulk-user,${'x'.repeat(1000)}\n${'\n'.repeat(200 * 1024)}` }));
    assert.equal(ok.status, 200);
    await whenIdle(db);
  } finally { await open.close(); }
});

test('public API: identical queries are served from memory for 60 s and dropped on an admin write or a job end', async () => {
  const db = await freshDb();
  const [ann] = await insertStudents(db, [{ username: 'ann', campus: 'RU', batch: 2025 }]);
  await upsertPRs(db, ann, [prNode({ repo: 'apache/airflow', number: 1 })]);
  await refreshAggregates(db);
  registerHandler('backfill', async () => ({}));
  const app = await startApp(db, { publicCacheMs: 60000 });
  const merged = async (extra = '') => { const r = await app.get(`/api/overview?range=all${extra}`); return [r.headers.get('x-cache'), r.body.prs.osMerged]; };
  try {
    assert.deepEqual(await merged(), ['miss', 1]);
    assert.deepEqual(await merged(), ['hit', 1]);
    assert.deepEqual(await merged('&cachebuster=123'), ['hit', 1], 'unknown parameters do not create new cache entries');
    assert.deepEqual(await merged('&campus=RU'), ['miss', 1]);

    // changed behind the cache's back: still the cached answer
    await collections(db).prs.updateOne({ number: 1 }, { $set: { category: 'low_signal', tier: null } });
    assert.deepEqual(await merged(), ['hit', 1]);
    // any admin write drops the cache
    await app.login();
    assert.equal((await app.post('/api/admin/students', { username: 'newbie', campus: 'RU', batch: 2026 })).status, 201);
    app.clearCookie();
    // adding a student queues a backfill: wait for it, a job that ends while a response is being computed keeps that
    // response out of the cache (it may predate the job's writes)
    await whenIdle(db);
    assert.deepEqual(await merged(), ['miss', 0]);
    assert.deepEqual(await merged(), ['hit', 0]);
    // so does the end of a job
    await collections(db).prs.updateOne({ number: 1 }, { $set: { category: 'open_source', tier: 'major' } });
    assert.deepEqual(await merged(), ['hit', 0]);
    await enqueue(db, 'reclassify', {});
    await whenIdle(db);
    assert.deepEqual(await merged(), ['miss', 1]);
    // a logged-in admin always reads fresh data and never fills the cache
    await app.login();
    const fresh = await app.get('/api/overview?range=all');
    assert.deepEqual([fresh.headers.get('x-cache'), fresh.headers.get('cache-control')], [null, 'private, no-store']);
    // errors are not cached
    app.clearCookie();
    assert.equal((await app.get('/api/students/nobody')).status, 404);
    assert.equal((await app.get('/api/students/nobody')).headers.get('x-cache'), null);
  } finally { await app.close(); }
});

// ------------------------------------------------------------------ medium / low: manifests

test('k8s manifests: MongoDB needs credentials, only labelled pods reach it, pods are hardened, the CronJob is gone', async () => {
  const k8s = (f) => readFile(path.join(ROOT, 'k8s', f), 'utf8');
  const mongo10 = await k8s('10-mongo.yaml');
  const app20 = await k8s('20-app.yaml');
  assert.match(mongo10, /MONGO_INITDB_ROOT_USERNAME/);
  assert.match(mongo10, /MONGO_INITDB_ROOT_PASSWORD[\s\S]*secretKeyRef/);
  assert.match(mongo10, /createUser\(\{ user: 'oss_status'[\s\S]*readWrite/);
  assert.ok(!/podSelector: \{\}/.test(mongo10), 'the mongo policy does not admit every pod of the namespace');
  assert.match(mongo10, /oss-status\/mongo-client: "true"/);
  assert.match(mongo10, /image: mongo:\d+\.\d+\.\d+/, 'mongo is pinned to a patch release');
  assert.ok(!/value: mongodb:\/\/mongo:27017/.test(app20), 'the app connects with credentials from the Secret');
  assert.match(app20, /policyTypes: \["Egress"\]/);
  assert.match(app20, /CLIENT_IP_HEADER/);
  for (const [name, text] of [['10-mongo.yaml', mongo10], ['20-app.yaml', app20], ['50-job-import.yaml.example', await k8s('50-job-import.yaml.example')]]) {
    assert.match(text, /automountServiceAccountToken: false/, name);
    assert.match(text, /seccompProfile:\s+type: RuntimeDefault/, name);
  }
  assert.equal(existsSync(path.join(ROOT, 'k8s', '40-cronjob-sync.yaml')), false);
  assert.equal(existsSync(path.join(ROOT, 'k8s', '40-cronjob-sync.yaml.disabled')), true);
  assert.ok(!/cronjob/i.test((await k8s('kustomization.yaml')).replace(/^#.*$/gm, '')));
  const secret = await k8s('secret.example.yaml');
  for (const key of ['MONGO_ROOT_PASSWORD', 'MONGO_APP_PASSWORD', 'MONGODB_URI', 'ADMIN_PASSWORD', 'SESSION_SECRET']) assert.match(secret, new RegExp(key));
});
