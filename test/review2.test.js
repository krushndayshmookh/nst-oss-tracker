// Regression tests for the second review of addenda A-C: bounded caches, unambiguous cache keys, cache invalidation
// only by real admin writes, academic-year corrections, scheduler slots, PR explorer sort. Real mongod.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import http from 'node:http';
import express from 'express';
import { startMongo } from './helpers/mongo.js';
import { startApp, testConfig } from './helpers/app.js';
import { insertStudents, prNode } from './helpers/fixtures.js';
import { collections, ensureIndexes } from '../src/db.js';
import { refreshAggregates, upsertPRs } from '../src/ingest.js';
import { invalidateContext } from '../src/classify.js';
import { createCache, generation, invalidateAll } from '../src/cache.js';
import { ensureAcademicYear } from '../src/dates.js';
import { addDays } from '../src/dates.js';
import { groupStats } from '../src/ranged.js';
import { publicRouter } from '../src/routes/public.js';
import { registerHandler, startRunner, unregisterHandler, whenIdle } from '../src/jobs.js';
import { ensureSchedule, loadSchedule, tick, updateSchedule } from '../src/scheduler.js';

let mongo;
before(async () => { mongo = await startMongo(); });
after(async () => { await mongo?.stop(); });

async function freshDb() {
  const db = mongo.client.db(`v_${Math.random().toString(16).slice(2, 10)}`);
  await ensureIndexes(db);
  invalidateContext();
  return db;
}
const at = (iso) => ({ now: new Date(iso), tz: 'Asia/Kolkata' });
const EMPTY = { students: 0, ok: 0, failed: 0, prs: 0, renamed: 0, notFound: 0 };

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const heapMb = () => { gc(); gc(); return process.memoryUsage().heapUsed / 1048576; };

// ------------------------------------------------------------------ cache.js

test('cache: bounded by entries and by bytes, least recently used goes first, generation changes on invalidateAll', () => {
  const c = createCache({ ttlMs: 1000, max: 3, maxBytes: 100 });
  c.set('a', 'x'.repeat(10)); // 20 bytes
  c.set('b', 'x'.repeat(10));
  c.set('c', 'x'.repeat(10));
  assert.equal(c.get('a').length, 10); // a is the most recently used now
  c.set('d', 'x'.repeat(10));
  assert.deepEqual([c.get('a') !== undefined, c.get('b'), c.size, c.bytes], [true, undefined, 3, 60], 'the entry limit drops the least recently used');
  c.set('e', 'x'.repeat(40)); // 80 bytes: only one 20-byte entry fits beside it
  assert.deepEqual([c.size, c.bytes, c.get('e').length, c.get('a') !== undefined], [2, 100, 40, true], 'the byte limit drops entries until the total fits');
  c.set('huge', 'x'.repeat(51));
  assert.deepEqual([c.get('huge'), c.size], [undefined, 2], 'a value larger than the whole budget is not stored (and evicts nothing)');
  c.set('a', 'y');
  assert.equal(c.bytes, 82, 'replacing a key replaces its weight');
  const g = generation();
  invalidateAll();
  assert.deepEqual([generation(), c.size, c.bytes], [g + 1, 0, 0]);
});

// ------------------------------------------------------------------ [high] memory stays bounded for any number of custom ranges

test('public API: 200 distinct custom ranges do not pin a whole-dataset map each (heap stays bounded)', async () => {
  const db = await freshDb();
  const [ann] = await insertStudents(db, [{ username: 'ann', campus: 'RU', batch: 2025 }]);
  const N = 1500; // one PR in each of 1,500 repositories: every ranged /api/repos builds a 1,500-row map
  await upsertPRs(db, ann, Array.from({ length: N }, (_, i) => prNode({ repo: `org${i}/repo${i}`, number: i + 1, createdAt: '2026-08-01T10:00:00Z', mergedAt: '2026-08-02T10:00:00Z' })));
  await refreshAggregates(db);
  await ensureAcademicYear(db);

  const one = await groupStats(db, { by: 'repoLc', range: { start: new Date('2020-01-01'), end: null, all: false } });
  assert.equal(one.size, N);
  assert.deepEqual(Object.keys(one.values().next().value).sort(), ['_id', 'campuses', 'closed', 'firstPrAt', 'lastPrAt', 'merged', 'open', 'opened', 'students'],
    'a repo row carries only what repoStats() reads');
  const author = (await groupStats(db, { by: 'author', range: { start: new Date('2020-01-01'), end: null, all: false } })).get('ann');
  assert.deepEqual([author.opened, author.osRepos, author.osOrgs, 'campuses' in author, 'students' in author], [N, N, N, false, false]);

  const app = await startApp(db, { publicCacheMs: 60000 });
  try {
    const first = await app.get('/api/repos?from=2015-01-01&category=all');
    assert.deepEqual([first.status, first.body.total], [200, N]);
    const before = heapMb();
    for (let i = 1; i <= 200; i++) {
      const r = await app.get(`/api/repos?from=${addDays('2015-01-01', i)}&category=all`);
      assert.equal(r.status, 200);
      if (i % 3 === 0) assert.equal((await app.get(`/api/students?from=${addDays('2015-01-01', i)}`)).status, 200);
      if (i % 7 === 0) assert.equal((await app.get(`/api/orgs?from=${addDays('2015-01-01', i)}&category=all`)).status, 200);
    }
    const grown = heapMb() - before;
    // before the fix every range kept its 1,500-row map for 60 s: about 1.5 MB each here, some 300 MB over the loop
    assert.ok(grown < 60, `heap grew by ${grown.toFixed(1)} MB over 200 distinct ranges`);

    // paging inside one custom range and the presets still reuse the aggregated numbers (they are the common case)
    const page2 = await app.get(`/api/repos?from=${addDays('2015-01-01', 200)}&category=all&page=2`);
    assert.deepEqual([page2.status, page2.body.total, page2.headers.get('x-cache')], [200, N, 'miss']);
  } finally { await app.close(); }
});

// ------------------------------------------------------------------ [medium] cache key

test('public cache: free text that contains "&from=..." cannot answer a different request', async () => {
  const db = await freshDb();
  const [ann] = await insertStudents(db, [{ username: 'ann', name: 'Ann A', campus: 'RU', batch: 2025 }]);
  await upsertPRs(db, ann, [prNode({ repo: 'apache/airflow', number: 1, createdAt: '2025-08-01T10:00:00Z', mergedAt: '2025-08-02T10:00:00Z' })]);
  await refreshAggregates(db);
  await ensureAcademicYear(db, new Date('2026-11-19T12:00:00Z'));
  const app = await startApp(db, { publicCacheMs: 60000 });
  try {
    // the attacker: one parameter `q` whose text looks like more parameters (default range, finds nothing)
    const poison = await app.get(`/api/students?q=${encodeURIComponent('a&from=2025-07-01&to=2026-06-30')}`);
    assert.deepEqual([poison.status, poison.body.total, poison.headers.get('x-cache')], [200, 0, 'miss']);
    // the visitor: the genuine request with those parameters
    const real = await app.get('/api/students?q=a&from=2025-07-01&to=2026-06-30');
    assert.deepEqual([real.headers.get('x-cache'), real.body.total, real.body.range.from, real.body.items[0].stats.osMerged], ['miss', 1, '2025-07-01', 1]);
    assert.equal((await app.get('/api/students?q=a&from=2025-07-01&to=2026-06-30')).headers.get('x-cache'), 'hit');

    for (const [bad, good] of [
      [`/api/activity?author=${encodeURIComponent('ann&metric=merged')}`, '/api/activity?author=ann&metric=merged'],
      [`/api/prs?q=${encodeURIComponent('airflow&range=all&page=2')}`, '/api/prs?q=airflow&range=all&page=2'],
      [`/api/repos?q=${encodeURIComponent('airflow&range=all')}`, '/api/repos?q=airflow&range=all'],
      [`/api/orgs?q=${encodeURIComponent('apache&range=all')}`, '/api/orgs?q=apache&range=all'],
    ]) {
      assert.equal((await app.get(bad)).status, 200, bad);
      assert.equal((await app.get(good)).headers.get('x-cache'), 'miss', good);
    }
    assert.equal((await app.get('/api/repos?q=airflow&range=all')).body.total, 1);
    // unknown parameters and the order of parameters still share one entry
    assert.equal((await app.get('/api/students?to=2026-06-30&utm=x&from=2025-07-01&q=a')).headers.get('x-cache'), 'hit');
  } finally { await app.close(); }
});

// ------------------------------------------------------------------ [medium] who may flush the cache

test('public cache: only a successful write of a logged-in admin drops it', async () => {
  const db = await freshDb();
  await insertStudents(db, [{ username: 'ann', campus: 'RU', batch: 2025 }]);
  await ensureAcademicYear(db);
  const app = await startApp(db, { publicCacheMs: 60000 });
  const cached = async () => (await app.get('/api/overview')).headers.get('x-cache');
  try {
    assert.equal(await cached(), 'miss');
    assert.equal(await cached(), 'hit');
    const anonymous = [
      ['logout without the CSRF header', () => app.request('POST', '/api/admin/logout', {}, { csrf: false }), 403],
      ['logout without a session', () => app.post('/api/admin/logout'), null],
      ['login with a wrong password', () => app.login('nope nope nope'), 401],
      ['write without a session', () => app.patch('/api/admin/students/zzz', { name: 'x' }), 401],
      ['delete without a session', () => app.del('/api/admin/students/ann'), null],
      ['sync trigger without a session', () => app.post('/api/admin/jobs/sync', {}), 401],
    ];
    for (const [what, call, status] of anonymous) {
      const r = await call();
      if (status) assert.equal(r.status, status, what);
      assert.equal(await cached(), 'hit', `${what} must not flush the public cache`);
    }
    assert.equal((await collections(db).students.findOne({ _id: 'ann' })).active, true);

    assert.equal((await app.login()).status, 200);
    app.clearCookie();
    assert.equal(await cached(), 'hit', 'logging in changes no data');

    await app.login();
    const cookie = app.getCookie();
    assert.equal((await app.patch('/api/admin/students/ann', { batch: 1800 })).status, 400);
    assert.equal((await app.patch('/api/admin/students/nobody', { name: 'x' })).status, 404);
    app.clearCookie();
    assert.equal(await cached(), 'hit', 'an admin write that was refused changes nothing either');

    app.setCookie(cookie);
    assert.equal((await app.patch('/api/admin/students/ann', { name: 'Ann' })).status, 200);
    app.clearCookie();
    assert.equal(await cached(), 'miss', 'a real admin write drops the cache');
  } finally { await app.close(); }
});

// ------------------------------------------------------------------ [low] a body computed before an invalidation is not stored after it

test('public cache: a response computed across an invalidation is served but not stored', async () => {
  const db = await freshDb();
  await insertStudents(db, [{ username: 'ann', campus: 'RU', batch: 2025 }]);
  await ensureAcademicYear(db);
  const real = createCache({ ttlMs: 60000 });
  let interfere = 1;
  // the admin write lands after the request resolved its default range and before its body is ready
  const cache = { ...real, get: real.get, set: real.set, enabled: true,
    async memo(key, fn) { const v = await real.memo(key, fn); if (key === 'ay' && interfere-- > 0) invalidateAll(); return v; } };
  const app = express();
  app.set('query parser', 'simple');
  app.use('/api', publicRouter({ db, config: testConfig({ publicCacheMs: 60000 }), auth: null, cache }));
  const server = await new Promise((resolve) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
  const get = async (p) => { const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`); await r.text(); return [r.status, r.headers.get('x-cache')]; };
  try {
    assert.deepEqual(await get('/api/overview'), [200, 'miss']);
    assert.deepEqual(await get('/api/overview'), [200, 'miss'], 'the first body may predate the write: it was not kept');
    assert.deepEqual(await get('/api/overview'), [200, 'hit']);
  } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
});

// ------------------------------------------------------------------ [medium] academic year: correction vs new year

test('academic year: a correction replaces the current year, only a later year moves it to the history, history is editable', async () => {
  const db = await freshDb();
  await ensureAcademicYear(db, new Date('2026-11-19T12:00:00Z'));
  const app = await startApp(db);
  const labels = (ay) => [ay.current.label, ...ay.history.map((a) => a.label)];
  const put = async (body, status = 200) => { const r = await app.put('/api/admin/academic-year', body); assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  const presetKeys = async () => (await app.get('/api/meta')).body.presets.map((p) => p.key).filter((k) => k.startsWith('ay'));
  try {
    await app.login();
    assert.deepEqual(labels((await app.get('/api/admin/academic-year')).body.academicYear), ['2026-27', '2025-26']);

    // a typo in the label, then the fix: no "AY 2026-72" chip stays behind
    assert.deepEqual(labels((await put({ label: '2026-72', start: '2026-07-01', end: '2027-06-30' })).academicYear), ['2026-72', '2025-26']);
    assert.deepEqual(labels((await put({ label: '2026-27', start: '2026-07-01', end: '2027-06-30' })).academicYear), ['2026-27', '2025-26']);
    assert.deepEqual(await presetKeys(), ['ay', 'ay-2025-26']);

    // a moved start or end date under a new label, trying a year and going back: all corrections
    await put({ label: '2026-27 (aug)', start: '2026-08-01', end: '2027-06-30' });
    await put({ label: 'Trial', start: '2026-07-01', end: '2027-05-31' });
    assert.deepEqual(labels((await put({ label: '2026-27', start: '2026-07-01', end: '2027-06-30' })).academicYear), ['2026-27', '2025-26']);

    // the year after: the old one becomes a preset; saving the same year again does not duplicate anything
    assert.deepEqual(labels((await put({ label: '2027-28', start: '2027-07-01', end: '2028-06-30' })).academicYear), ['2027-28', '2026-27', '2025-26']);
    assert.deepEqual(labels((await put({ label: '2027-28', start: '2027-07-01', end: '2028-06-30' })).academicYear), ['2027-28', '2026-27', '2025-26']);
    assert.deepEqual(await presetKeys(), ['ay', 'ay-2026-27', 'ay-2025-26']);

    // going back to a year of the history: it is the current year again, not also a preset of the past
    assert.deepEqual(labels((await put({ label: '2026-27', start: '2026-07-01', end: '2027-06-30' })).academicYear), ['2026-27', '2025-26']);

    // the history can be edited (remove or fix an entry) with the same validation as the current year
    const cur = { label: '2026-27', start: '2026-07-01', end: '2027-06-30' };
    for (const history of ['x', [{ label: '', start: '2025-07-01', end: '2026-06-30' }], [{ label: 'a', start: '2026-06-30', end: '2025-07-01' }],
      [{ label: '2026-27', start: '2025-07-01', end: '2026-06-30' }], [{ label: 'a', start: '2024-07-01', end: '2025-06-30' }, { label: 'a', start: '2025-07-01', end: '2026-06-30' }],
      Array.from({ length: 11 }, (_, i) => ({ label: `y${i}`, start: `${2000 + i}-07-01`, end: `${2001 + i}-06-30` }))]) {
      await put({ ...cur, history }, 400);
    }
    const two = await put({ ...cur, history: [{ label: '2024-25', start: '2024-07-01', end: '2025-06-30' }, { label: '2025-26', start: '2025-07-01', end: '2026-06-30' }] });
    assert.deepEqual(labels(two.academicYear), ['2026-27', '2025-26', '2024-25'], 'newest first');
    assert.deepEqual(labels((await put({ ...cur, history: [] })).academicYear), ['2026-27']);
    assert.deepEqual(await presetKeys(), ['ay']);
    assert.deepEqual(labels((await put(cur)).academicYear), ['2026-27'], 'without `history` the stored history is kept as it is');
  } finally { await app.close(); }
});

// ------------------------------------------------------------------ [low] PR explorer: sort by merge date inside a range

test('GET /api/prs: sort=mergedAt applies the range to the merge date, like state=merged', async () => {
  const db = await freshDb();
  const [ann] = await insertStudents(db, [{ username: 'ann', campus: 'RU', batch: 2025 }]);
  await upsertPRs(db, ann, [
    prNode({ repo: 'apache/airflow', number: 1, createdAt: '2026-03-01T10:00:00Z', mergedAt: '2026-03-05T10:00:00Z' }), // opened and merged inside
    prNode({ repo: 'apache/airflow', number: 2, createdAt: '2026-06-01T10:00:00Z', mergedAt: '2026-11-05T10:00:00Z' }), // opened inside, merged after
    prNode({ repo: 'apache/airflow', number: 3, createdAt: '2025-05-01T10:00:00Z', mergedAt: '2025-08-01T10:00:00Z' }), // opened before, merged inside
    prNode({ repo: 'apache/airflow', number: 4, createdAt: '2026-04-01T10:00:00Z', state: 'OPEN' }),
  ]);
  await refreshAggregates(db);
  await ensureAcademicYear(db);
  const app = await startApp(db);
  const R = 'from=2025-07-01&to=2026-06-30';
  const numbers = async (q) => { const r = await app.get(`/api/prs?${R}&${q}`); assert.equal(r.status, 200); return [r.body.total, r.body.items.map((p) => p.number)]; };
  try {
    assert.deepEqual(await numbers('sort=mergedAt'), [2, [1, 3]], 'merged in the range, newest merge first; #2 was merged after it');
    assert.deepEqual(await numbers('sort=mergedAt'), await numbers('sort=mergedAt&state=merged'));
    assert.deepEqual(await numbers('sort=mergedAt&order=asc'), [2, [3, 1]]);
    assert.deepEqual(await numbers('sort=mergedAt&state=open'), [1, [4]], 'an explicit state wins');
    assert.deepEqual((await numbers('sort=createdAt'))[0], 4, 'without a state: opened or merged in the range');
  } finally { await app.close(); }
});

// ------------------------------------------------------------------ [low] scheduler

test('scheduler: the weekly full refresh belongs to the slot, not to the moment it fires; at most one a week', async () => {
  const db = await freshDb();
  const c = collections(db);
  const runs = [];
  registerHandler('sync', async (d, params) => { runs.push(params); return EMPTY; });
  try {
    // daily at 23:50 IST (18:20 UTC), full refresh on Sunday. 22 Nov 2026 is a Sunday.
    await ensureSchedule(db, { ...at('2026-11-21T00:00:00Z'), concurrency: 2 });
    await updateSchedule(db, { dailyAt: '23:50', fullRefreshDay: 0 }, at('2026-11-21T00:00:00Z'));
    assert.equal((await loadSchedule(db)).nextRunAt.toISOString(), '2026-11-21T18:20:00.000Z', 'Saturday 23:50 IST');

    // Saturday's slot is missed and caught up early on Sunday (IST): an ordinary run, Sunday's own slot is the full one
    assert.equal((await tick(db, at('2026-11-21T20:30:00Z'))).why, 'catchup'); // Sunday 02:00 IST
    await whenIdle(db);
    assert.deepEqual([runs.at(-1).full, (await loadSchedule(db)).nextRunAt.toISOString()], [false, '2026-11-22T18:20:00.000Z']);

    // Sunday's slot is blocked by a manual sync until Monday 00:10 IST: the run that then starts is still Sunday's
    await c.jobs.insertOne({ _id: 'manual000001', type: 'sync', runner: 'cli', status: 'running', params: {}, createdAt: new Date('2026-11-22T18:00:00Z'), startedAt: new Date() });
    assert.deepEqual(await tick(db, at('2026-11-22T18:20:10Z')), { fired: null, why: 'a sync is already queued or running' });
    await c.jobs.updateOne({ _id: 'manual000001' }, { $set: { status: 'done' } });
    assert.equal((await tick(db, at('2026-11-22T18:40:00Z'))).why, 'schedule'); // Monday 00:10 IST
    await whenIdle(db);
    assert.deepEqual([runs.at(-1).full, (await loadSchedule(db)).lastFullRefreshYmd], [true, '2026-11-22']);
    assert.equal(runs.filter((r) => r.full).length, 1);

    // the rest of the week is incremental, also when the admin moves the full-refresh day to a day that is still ahead
    await updateSchedule(db, { fullRefreshDay: 2 }, at('2026-11-23T00:00:00Z'));
    for (const t of ['2026-11-23T18:20:05Z', '2026-11-24T18:20:05Z', '2026-11-25T18:20:05Z']) { assert.equal((await tick(db, at(t))).why, 'schedule'); await whenIdle(db); }
    assert.equal(runs.filter((r) => r.full).length, 1, 'Tuesday 24 Nov is two days after the last full refresh');
    // a week later it runs again; a downtime over the full-refresh day is made up by the one catch-up run
    await c.settings.updateOne({ _id: 'schedule' }, { $set: { nextRunAt: new Date('2026-11-30T18:20:00Z') } }); // Monday's slot
    assert.equal((await tick(db, at('2026-12-02T10:00:00Z'))).why, 'catchup'); // Wednesday: Monday's and Tuesday's slots were missed
    await whenIdle(db);
    assert.deepEqual([runs.at(-1).full, (await loadSchedule(db)).lastFullRefreshYmd], [true, '2026-12-01']);
  } finally { await whenIdle(db); unregisterHandler('sync'); }
});

test('scheduler: a catch-up shortly before the daily time is the only run; a failed enqueue gives the slot back', async () => {
  const db = await freshDb();
  const c = collections(db);
  const runs = [];
  registerHandler('sync', async (d, params) => { runs.push(params); return EMPTY; });
  try {
    // next run 18 Nov 02:30 IST (17 Nov 21:00 UTC); the app is down until 19 Nov 02:20 IST
    await ensureSchedule(db, { ...at('2026-11-17T10:00:00Z'), concurrency: 2 });
    assert.equal((await tick(db, at('2026-11-18T20:50:00Z'))).why, 'catchup');
    await whenIdle(db);
    assert.equal((await loadSchedule(db)).nextRunAt.toISOString(), '2026-11-19T21:00:00.000Z', 'the slot 10 minutes later is covered by the catch-up');
    assert.deepEqual(await tick(db, at('2026-11-18T21:00:10Z')), { fired: null, why: 'not due' });
    assert.equal(runs.length, 1);
    // a catch-up far from the daily time leaves the next slot alone
    await c.settings.updateOne({ _id: 'schedule' }, { $set: { nextRunAt: new Date('2026-11-19T21:00:00Z') } });
    assert.equal((await tick(db, at('2026-11-20T08:00:00Z'))).why, 'catchup');
    await whenIdle(db);
    assert.equal((await loadSchedule(db)).nextRunAt.toISOString(), '2026-11-20T21:00:00.000Z');

    // the insert of the job fails: the slot is still due and fires on the next tick
    const before = await loadSchedule(db);
    let fail = true;
    const flaky = async (...args) => { if (fail) throw new Error('mongo hiccup'); const { enqueue } = await import('../src/jobs.js'); return enqueue(...args); };
    await assert.rejects(tick(db, { ...at('2026-11-20T21:00:05Z'), enqueueJob: flaky }), /mongo hiccup/);
    const mid = await loadSchedule(db);
    assert.deepEqual([mid.nextRunAt.toISOString(), mid.lastRunAt?.toISOString(), mid.lastRunJobId], [before.nextRunAt.toISOString(), before.lastRunAt?.toISOString(), before.lastRunJobId],
      'nothing ran: next run, last run and last job are as before');
    fail = false;
    assert.equal((await tick(db, { ...at('2026-11-20T21:00:35Z'), enqueueJob: flaky })).why, 'schedule');
    await whenIdle(db);
    assert.deepEqual([runs.length, (await loadSchedule(db)).nextRunAt.toISOString()], [3, '2026-11-21T21:00:00.000Z']);
  } finally { await whenIdle(db); unregisterHandler('sync'); }
});

test('scheduler and "Fetch now" share one lock: a manual trigger during the scheduler\'s enqueue gets 409', async () => {
  const db = await freshDb();
  let release = () => {};
  const held = new Promise((r) => { release = r; });
  registerHandler('sync', async () => { await held; return EMPTY; });
  const app = await startApp(db);
  try {
    await app.login();
    await ensureSchedule(db, { ...at('2026-11-19T10:00:00Z'), concurrency: 2 });
    const { enqueue } = await import('../src/jobs.js');
    let inEnqueue = () => {};
    const reached = new Promise((r) => { inEnqueue = r; });
    // the scheduler has passed its "no sync active" check and is about to insert its job
    const slow = async (...args) => { inEnqueue(); await new Promise((r) => setTimeout(r, 150)); return enqueue(...args); };
    const ticking = tick(db, { ...at('2026-11-19T21:00:05Z'), enqueueJob: slow });
    await reached;
    const manual = await app.post('/api/admin/jobs/sync', {});
    const fired = await ticking;
    assert.equal(fired.why, 'schedule');
    assert.deepEqual([manual.status, manual.body.error.jobId], [409, fired.fired]);
    assert.equal(await collections(db).jobs.countDocuments({ type: 'sync' }), 1);
  } finally { release(); await whenIdle(db); await app.close(); unregisterHandler('sync'); }
});

// ------------------------------------------------------------------ [low] interrupted fetch: all-time stats are refreshed on boot

test('startRunner: after a fetch that died with the process the precomputed stats are refreshed', async () => {
  const db = await freshDb();
  const c = collections(db);
  const [ann] = await insertStudents(db, [{ username: 'ann', campus: 'RU', batch: 2025 }]);
  // the sync saved this student's PR and was killed before its closing refreshAggregates
  await upsertPRs(db, ann, [prNode({ repo: 'apache/airflow', number: 1, createdAt: '2026-08-01T10:00:00Z', mergedAt: '2026-08-02T10:00:00Z' })]);
  assert.equal((await c.students.findOne({ _id: 'ann' })).stats.osMerged, 0);
  await c.jobs.insertOne({ _id: 'cut000000009', type: 'sync', runner: 'app', status: 'running', params: { trigger: 'manual' }, createdAt: new Date(), startedAt: new Date(),
    finishedAt: null, progress: { done: 1, total: 9 }, summary: null, log: [], error: null });
  await startRunner(db);
  await whenIdle(db);
  assert.deepEqual([(await c.jobs.findOne({ _id: 'cut000000009' })).error, (await c.students.findOne({ _id: 'ann' })).stats.osMerged,
    (await c.repos.findOne({ _id: 'apache/airflow' })).stats.merged], ['interrupted', 1, 1]);
});
