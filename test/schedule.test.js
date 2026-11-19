// SPEC addenda B and C, second pass: recovery rules, settings-driven concurrency, cancel during a long wait,
// concurrent triggers, missing-data details. Real mongod, mocked GitHub.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo } from './helpers/mongo.js';
import { startApp } from './helpers/app.js';
import { insertStudents, prNode } from './helpers/fixtures.js';
import { fakeSleep, json, mockGitHub } from './helpers/github.js';
import { collections, ensureIndexes } from '../src/db.js';
import { invalidateContext } from '../src/classify.js';
import { refreshAggregates, upsertPRs } from '../src/ingest.js';
import { parseCsv } from '../src/csv.js';
import { MISSING_FILTERS, MISSING_KEYS, missingOf } from '../src/routes/common.js';
import { registerHandler, startRunner, unregisterHandler, whenIdle } from '../src/jobs.js';
import { sync as realSync } from '../src/jobHandlers.js';
import { ensureSchedule, loadSchedule, pauseSchedule, resumeSchedule, startScheduler, tick, updateSchedule } from '../src/scheduler.js';

let mongo;
before(async () => { mongo = await startMongo(); });
after(async () => { await mongo?.stop(); });

async function freshDb() {
  const db = mongo.client.db(`s_${Math.random().toString(16).slice(2, 10)}`);
  await ensureIndexes(db);
  invalidateContext();
  return db;
}
const at = (iso) => ({ now: new Date(iso), tz: 'Asia/Kolkata' });
const EMPTY = { students: 0, ok: 0, failed: 0, prs: 0, renamed: 0, notFound: 0 };
const cutOff = (id, params, createdAt, extra = {}) => ({ _id: id, type: 'sync', runner: 'app', status: 'running', params, createdAt, startedAt: createdAt, finishedAt: null,
  progress: { done: 1, total: 9 }, summary: null, log: [], error: null, ...extra });

// ------------------------------------------------------------------ addendum C: recovery after a restart

test('scheduler recovery: same selection as the cut-off run, once, never in a loop, not while paused, not for an old run', async () => {
  const db = await freshDb();
  const c = collections(db);
  const runs = [];
  registerHandler('sync', async (d, params) => { runs.push(params); return EMPTY; });
  try {
    await ensureSchedule(db, { ...at('2026-11-19T10:00:00Z'), concurrency: 5 }); // next run 21:00Z

    // a manual full refresh of one campus was running when the pod died
    const started = new Date('2026-11-19T11:00:00Z');
    await c.jobs.insertOne(cutOff('cut000000001', { trigger: 'manual', full: true, campus: 'RU', batch: 2025, concurrency: 5 }, started));
    await startRunner(db);
    assert.deepEqual([(await c.jobs.findOne({ _id: 'cut000000001' })).status, (await c.jobs.findOne({ _id: 'cut000000001' })).error], ['error', 'interrupted']);

    // paused: nothing starts by itself
    await pauseSchedule(db, { note: 'hold' }, at('2026-11-19T11:01:00Z'));
    assert.deepEqual(await tick(db, at('2026-11-19T11:02:00Z')), { fired: null, why: 'paused' });
    await resumeSchedule(db, at('2026-11-19T11:03:00Z'));

    const rec = await tick(db, at('2026-11-19T11:04:00Z'));
    assert.equal(rec.why, 'recovery');
    await whenIdle(db);
    assert.deepEqual(runs, [{ trigger: 'recovery', full: true, concurrency: 5, recovers: 'cut000000001', campus: 'RU', batch: 2025, resumeSince: started }]);
    assert.equal((await c.jobs.findOne({ _id: 'cut000000001' })).recoveredBy, rec.fired);
    assert.deepEqual(await tick(db, at('2026-11-19T11:05:00Z')), { fired: null, why: 'not due' }, 'once');
    assert.equal((await loadSchedule(db)).nextRunAt.toISOString(), '2026-11-19T21:00:00.000Z', 'the nightly slot is untouched');

    // the recovery run is cut off as well (a pod that keeps dying): it is NOT started a third time
    await c.jobs.insertOne(cutOff('rec000000002', { trigger: 'recovery', full: true, recovers: 'x' }, new Date('2026-11-19T11:06:00Z')));
    await startRunner(db);
    assert.deepEqual(await tick(db, at('2026-11-19T11:07:00Z')), { fired: null, why: 'not due' }, 'no recovery of a recovery');
    assert.equal(runs.length, 1);
    // ... the next nightly run is the retry
    const night = await tick(db, at('2026-11-19T21:00:10Z'));
    assert.equal(night.why, 'schedule');
    await whenIdle(db);
    assert.deepEqual(runs.at(-1), { trigger: 'schedule', full: false, concurrency: 5 });

    // an interrupted run that is not the newest sync job is history, not something to recover
    await c.jobs.insertOne(cutOff('old000000003', { trigger: 'manual' }, new Date('2026-11-01T00:00:00Z'), { status: 'error', error: 'interrupted', finishedAt: new Date('2026-11-01T00:01:00Z') }));
    assert.deepEqual(await tick(db, at('2026-11-19T22:00:00Z')), { fired: null, why: 'not due' });

    // cut off AND the nightly run is due: one run, not two; an unfiltered full refresh stays full
    await c.jobs.insertOne(cutOff('cut000000004', { trigger: 'manual', full: true }, new Date('2026-11-20T20:00:00Z')));
    await startRunner(db);
    const both = await tick(db, at('2026-11-20T21:00:05Z'));
    assert.equal(both.why, 'schedule');
    await whenIdle(db);
    assert.deepEqual(runs.at(-1), { trigger: 'schedule', full: true, concurrency: 5, recovers: 'cut000000004' });
    assert.deepEqual(await tick(db, at('2026-11-20T21:00:35Z')), { fired: null, why: 'not due' });
    assert.equal(runs.length, 3);

    // a run the admin was cancelling when the pod died is cancelled, and is not started again
    await c.jobs.insertOne(cutOff('can000000006', { trigger: 'manual', full: true }, new Date('2026-11-20T22:00:00Z'), { cancelRequested: true }));
    await startRunner(db);
    assert.deepEqual([(await c.jobs.findOne({ _id: 'can000000006' })).status, (await c.jobs.findOne({ _id: 'can000000006' })).error], ['cancelled', null]);
    assert.deepEqual(await tick(db, at('2026-11-20T22:01:00Z')), { fired: null, why: 'not due' });

    // a schedule that is switched off recovers nothing
    await c.jobs.insertOne(cutOff('cut000000005', { trigger: 'manual' }, new Date('2026-11-21T01:00:00Z')));
    await startRunner(db);
    await updateSchedule(db, { enabled: false }, at('2026-11-21T01:01:00Z'));
    assert.deepEqual(await tick(db, at('2026-11-21T01:02:00Z')), { fired: null, why: 'disabled' });
    assert.equal(runs.length, 3);
  } finally { await whenIdle(db); unregisterHandler('sync'); }
});

test('startScheduler: the first tick on boot is the catch-up, exactly one run for many missed days; stop() ends the ticking', async () => {
  const db = await freshDb();
  const c = collections(db);
  const runs = [];
  registerHandler('sync', async (d, params) => { runs.push(params); return EMPTY; });
  let sched;
  try {
    await ensureSchedule(db, { concurrency: 2 });
    await c.settings.updateOne({ _id: 'schedule' }, { $set: { nextRunAt: new Date(Date.now() - 5 * 86400000) } });
    const lines = [];
    sched = await startScheduler(db, { intervalMs: 20, concurrency: 2, log: (l) => lines.push(l) });
    await whenIdle(db);
    await new Promise((r) => setTimeout(r, 150)); // several more ticks
    await whenIdle(db);
    assert.deepEqual(runs, [{ trigger: 'catchup', full: false, concurrency: 2 }]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /started sync job .* \(catchup\)/);
    const s = await loadSchedule(db);
    assert.ok(s.nextRunAt > new Date() && s.nextRunAt.getTime() - Date.now() <= 86400000, 'next run within a day');
    sched.stop();
    // the result of the run is copied to the schedule by a later tick
    await tick(db, {});
    assert.equal((await loadSchedule(db)).lastRunStatus, 'done');
  } finally { sched?.stop(); await whenIdle(db); unregisterHandler('sync'); }
});

// ------------------------------------------------------------------ addendum C: the sync handler

test('sync handler: concurrency comes from the job params (the schedule setting); resumeSince skips students already done', async () => {
  const db = await freshDb();
  const c = collections(db);
  const NOW = new Date('2026-11-19T21:00:00Z');
  const N = 12;
  await insertStudents(db, Array.from({ length: N }, (_, i) => ({ username: `p${i}`, githubId: 500 + i, loginCheckedAt: NOW, lastSyncedAt: new Date('2026-11-18T21:00:00Z') })));
  const gh = mockGitHub({ users: Array.from({ length: N }, (_, i) => ({ login: `p${i}`, id: 500 + i, prs: [] })) });
  let inflight = 0;
  let max = 0;
  gh.intercept = async () => { inflight++; max = Math.max(max, inflight); await new Promise((r) => setTimeout(r, 15)); inflight--; return undefined; };
  const opts = { fetch: gh.fetch, token: 't', sleep: fakeSleep(), now: () => NOW };
  for (const n of [1, 3, 5]) {
    max = 0;
    const s = await realSync(db, { concurrency: n }, {}, opts);
    assert.deepEqual([s.studentsChecked, max], [N, n], `concurrency ${n}`);
  }

  // through the API: the job gets the concurrency stored in the schedule, and the handler uses it
  registerHandler('sync', (d, params, ctx) => realSync(d, params, ctx, opts));
  const app = await startApp(db);
  try {
    await app.login();
    assert.equal((await app.put('/api/admin/schedule', { concurrency: 4 })).status, 200);
    max = 0;
    const t = await app.post('/api/admin/jobs/sync', {});
    await whenIdle(db);
    const job = await c.jobs.findOne({ _id: t.body.job.id });
    assert.deepEqual([job.params.concurrency, job.params.full, job.params.trigger, job.status, max], [4, false, 'manual', 'done', 4]);
    for (const k of ['studentsChecked', 'studentsFailed', 'prsNew', 'prsUpdated', 'newMerged', 'rateLimitRemaining', 'durationMs']) assert.ok(k in job.summary, k);
    // GET schedule: settings + running + the last 14 sync runs with their summaries (newest first), no log
    for (let i = 0; i < 15; i++) await c.jobs.insertOne({ _id: `hist${i}`, type: 'sync', runner: 'app', status: 'done', params: { trigger: 'schedule' }, createdAt: new Date(Date.UTC(2026, 9, 1 + i)),
      startedAt: null, finishedAt: new Date(Date.UTC(2026, 9, 1 + i, 1)), progress: { done: 1, total: 1 }, summary: { studentsChecked: i }, log: ['x'], error: null });
    await c.jobs.insertOne({ _id: 'notsync', type: 'reclassify', runner: 'app', status: 'done', params: {}, createdAt: new Date(), finishedAt: new Date(), progress: { done: 0, total: 0 }, summary: {}, log: [], error: null });
    const view = (await app.get('/api/admin/schedule')).body;
    assert.equal(view.runs.length, 14);
    assert.equal(view.runs[0].id, job._id);
    assert.deepEqual(view.runs.slice(1, 3).map((r) => [r.id, r.summary.studentsChecked]), [['hist14', 14], ['hist13', 13]]);
    assert.ok(view.runs.every((r) => r.type === 'sync' && r.log === undefined));
    assert.equal(view.running, null);
  } finally { await whenIdle(db); await app.close(); unregisterHandler('sync'); }

  // a recovery run leaves alone whoever the cut-off run already finished
  const cutStart = new Date('2026-11-19T20:30:00Z');
  await c.students.updateMany({}, { $set: { lastSyncedAt: new Date('2026-11-18T21:00:00Z') } });
  await c.students.updateMany({ _id: { $in: ['p0', 'p1', 'p2'] } }, { $set: { lastSyncedAt: new Date('2026-11-19T20:31:00Z') } });
  await c.students.updateOne({ _id: 'p3' }, { $set: { lastSyncedAt: new Date('2026-11-19T20:31:00Z'), backfill: { status: 'running', at: cutStart } } }); // was in flight
  const calls = gh.graphql().length;
  const s = await realSync(db, { full: true, resumeSince: cutStart, concurrency: 2 }, {}, opts);
  assert.deepEqual([s.alreadyDone, s.studentsChecked, s.students, gh.graphql().length - calls], [3, N - 3, N, N - 3]);
  assert.equal((await c.students.findOne({ _id: 'p3' })).backfill.status, 'done');
});

test('sync handler: cancel cuts a long rate-limit wait short and ends the run as cancelled', async () => {
  const db = await freshDb();
  const c = collections(db);
  await insertStudents(db, ['w0', 'w1', 'w2'].map((username, i) => ({ username, githubId: 700 + i, loginCheckedAt: new Date(), lastSyncedAt: new Date(Date.now() - 86400000 + i) })));
  const gh = mockGitHub({ users: ['w0', 'w1', 'w2'].map((login, i) => ({ login, id: 700 + i,
    prs: [prNode({ repo: 'apache/airflow', number: 800 + i, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })] })) });
  gh.rateLimit = { remaining: 3, resetAt: new Date(Date.now() + 50 * 60 * 1000).toISOString() }; // the client sleeps ~50 minutes after every page
  let cancelled = false;
  const log = [];
  const ctx = { log: (l) => log.push(l), progress() {}, isCancelled: async () => cancelled };
  const t0 = Date.now();
  setTimeout(() => { cancelled = true; }, 300);
  const s = await realSync(db, { concurrency: 1 }, ctx, { fetch: gh.fetch, token: 't' }); // real sleep: the handler's cancellable one
  assert.ok(Date.now() - t0 < 6000, `ended ${Date.now() - t0} ms after start instead of sleeping for the rate limit`);
  assert.deepEqual([s.cancelled, s.studentsChecked, s.ok], [true, 1, 1]);
  assert.ok(log.some((l) => /rate limit: 3 left, sleeping/.test(l)));
  assert.equal(await c.prs.countDocuments({}), 1, 'the student in flight was saved');
  assert.equal(await c.students.countDocuments({ lastSyncedAt: { $gte: new Date(t0) } }), 1);
});

test('jobs API: simultaneous triggers start exactly one sync; trigger validation; a queued sync can be cancelled; filters select students', async () => {
  const db = await freshDb();
  const c = collections(db);
  await insertStudents(db, [
    { username: 'a1', campus: 'RU', batch: 2025 }, { username: 'a2', campus: 'RU', batch: 2024 }, { username: 'a3', campus: 'ADYPU', batch: 2025 },
    { username: 'a4', campus: 'RU', batch: 2025, active: false }, { username: 'A5-Renamed', _id: 'a5', campus: 'RU', batch: 2025 },
  ].map((s) => ({ ...s, githubId: 1, loginCheckedAt: new Date() })));
  const seen = [];
  const gh = mockGitHub({ users: [] });
  gh.intercept = async (call) => { if (call.kind === 'graphql') seen.push(/author:(\S+)/.exec(call.q)[1]); return undefined; };
  let hold = null;
  registerHandler('sync', async (d, params, ctx) => { await hold; return realSync(d, params, ctx, { fetch: gh.fetch, token: 't', sleep: fakeSleep() }); });
  registerHandler('reclassify', async () => { await hold; return {}; });
  const app = await startApp(db);
  let release = () => {};
  try {
    await app.login();
    for (const body of [{ users: 'a1' }, { users: ['not a login!'] }, { users: [5] }, { full: 'true' }, { campus: 'Mars' }, { batch: 1999 }, { batch: 'x' }]) {
      assert.equal((await app.post('/api/admin/jobs/sync', body)).status, 400, JSON.stringify(body));
    }
    assert.equal(await c.jobs.countDocuments({}), 0);

    hold = new Promise((r) => { release = r; });
    const res = await Promise.all(Array.from({ length: 6 }, () => app.post('/api/admin/jobs/sync', {})));
    assert.deepEqual(res.map((r) => r.status).sort(), [202, 409, 409, 409, 409, 409]);
    const id = res.find((r) => r.status === 202).body.job.id;
    assert.ok(res.filter((r) => r.status === 409).every((r) => r.body.error.jobId === id && r.body.error.code === 'conflict'));
    assert.equal(await c.jobs.countDocuments({ type: 'sync' }), 1);
    release();
    await whenIdle(db);
    assert.deepEqual(seen.sort(), ['A5-Renamed', 'a1', 'a2', 'a3'], 'no filter: every active student');

    const run = async (body) => {
      seen.length = 0;
      const r = await app.post('/api/admin/jobs/sync', body);
      assert.equal(r.status, 202, JSON.stringify(body));
      await whenIdle(db);
      const job = await c.jobs.findOne({ _id: r.body.job.id });
      return { job, seen: [...seen].sort() };
    };
    assert.deepEqual((await run({ campus: 'ru' })).seen, ['A5-Renamed', 'a1', 'a2']);
    assert.deepEqual((await run({ batch: 2025 })).seen, ['A5-Renamed', 'a1', 'a3']);
    assert.deepEqual((await run({ campus: 'RU', batch: '2025' })).seen, ['A5-Renamed', 'a1']);
    const byUser = await run({ users: ['A2', '@a5-renamed', 'https://github.com/a4', 'stranger'], full: true });
    assert.deepEqual(byUser.seen, ['A5-Renamed', 'a2'], 'users by login (case-insensitive, also a renamed one); inactive and unknown ones are reported');
    assert.deepEqual([byUser.job.params.full, byUser.job.summary.unknown.sort(), byUser.job.summary.studentsChecked], [true, ['a4', 'stranger'], 2]);
    assert.equal((await run({})).job.params.full, false, 'incremental by default');
    // incremental = only what changed since each student's own last sync; full = no `updated:` window
    seen.length = 0;
    const qs = [];
    gh.intercept = async (call) => { if (call.kind === 'graphql') qs.push(call.q); return undefined; };
    await c.students.updateOne({ _id: 'a1' }, { $set: { lastSyncedAt: new Date('2026-11-01T12:00:00Z') } }); // "paused for days": the window still starts at the last sync
    await app.post('/api/admin/jobs/sync', { users: ['a1'] }); await whenIdle(db);
    await app.post('/api/admin/jobs/sync', { users: ['a1'], full: true }); await whenIdle(db);
    assert.deepEqual(qs.filter((q) => /author:a1 /.test(`${q} `)).slice(0, 2), ['author:a1 type:pr updated:>=2026-10-30', 'author:a1 type:pr']);

    // a sync queued behind another job is cancelled at once; the trigger is free again
    hold = new Promise((r) => { release = r; });
    const blocker = await app.post('/api/admin/jobs/reclassify', {});
    await new Promise((r) => setTimeout(r, 50));
    const queued = await app.post('/api/admin/jobs/sync', {});
    assert.equal((await c.jobs.findOne({ _id: queued.body.job.id })).status, 'queued');
    assert.equal((await app.post('/api/admin/jobs/sync', {})).status, 409, 'a queued sync blocks a second one too');
    const cancel = await app.post(`/api/admin/jobs/${queued.body.job.id}/cancel`);
    assert.deepEqual([cancel.status, cancel.body.job.status], [200, 'cancelled']);
    const again = await app.post('/api/admin/jobs/sync', {});
    assert.equal(again.status, 202);
    release();
    await whenIdle(db);
    assert.deepEqual([(await c.jobs.findOne({ _id: queued.body.job.id })).status, (await c.jobs.findOne({ _id: again.body.job.id })).status, (await c.jobs.findOne({ _id: blocker.body.job.id })).status],
      ['cancelled', 'done', 'done'], 'the cancelled one never ran');

    // public meta: only a successful sync moves lastSyncAt
    const meta1 = (await app.get('/api/meta')).body.lastSyncAt;
    assert.equal(meta1, (await c.jobs.findOne({ _id: again.body.job.id })).finishedAt.toISOString());
    await c.jobs.insertOne({ _id: 'later-cancelled', type: 'sync', runner: 'app', status: 'cancelled', params: {}, createdAt: new Date(), finishedAt: new Date(Date.now() + 5000), progress: {}, summary: {}, log: [], error: null });
    await c.jobs.insertOne({ _id: 'later-error', type: 'sync', runner: 'app', status: 'error', params: {}, createdAt: new Date(), finishedAt: new Date(Date.now() + 6000), progress: {}, summary: null, log: [], error: 'x' });
    assert.equal((await app.get('/api/meta')).body.lastSyncAt, meta1);
    // pause with an end: the flag is on until then, off afterwards even before the scheduler ticks
    const p = await app.post('/api/admin/schedule/pause', { until: new Date(Date.now() + 400).toISOString(), note: 'n'.repeat(300) });
    assert.deepEqual([p.status, p.body.schedule.paused, (await app.get('/api/meta')).body.updatesPaused], [200, true, true]);
    assert.equal((await app.post('/api/admin/schedule/pause', { note: 'n'.repeat(301) })).status, 400);
    assert.equal((await app.post('/api/admin/schedule/pause', { until: 'tomorrow-ish' })).status, 400);
    await new Promise((r) => setTimeout(r, 450));
    assert.deepEqual([(await app.get('/api/meta')).body.updatesPaused, (await app.get('/api/admin/schedule')).body.schedule.paused], [false, false]);
    // PUT validation
    for (const body of [{}, { dailyAt: '24:00' }, { dailyAt: 230 }, { enabled: 'yes' }, { fullRefreshDay: 7 }, { fullRefreshDay: '1' }, { concurrency: 0 }, { concurrency: 2.5 }, { concurrency: 17 }]) {
      assert.equal((await app.put('/api/admin/schedule', body)).status, 400, JSON.stringify(body));
    }
    const off = await app.put('/api/admin/schedule', { enabled: false });
    assert.deepEqual([off.body.schedule.enabled, off.body.schedule.nextRunAt], [false, null]);
    const on = await app.put('/api/admin/schedule', { enabled: true, dailyAt: '23:59', fullRefreshDay: 6 });
    assert.deepEqual([on.body.schedule.enabled, on.body.schedule.fullRefreshDay, typeof on.body.schedule.nextRunAt], [true, 6, 'string']);
  } finally { release(); await whenIdle(db); await app.close(); unregisterHandler('sync'); unregisterHandler('reclassify'); }
});

// ------------------------------------------------------------------ addendum B

test('missing data: the Mongo filter and the per-row list agree for every key on awkward documents; counts add up', async () => {
  const db = await freshDb();
  const c = collections(db);
  const base = { name: 'N', nameSource: 'sheet', campus: 'RU', batch: 2025, email: 'e@x.example', enrolmentNo: 'E', githubId: 9 };
  const variants = [
    {}, { batch: null }, { campus: 'Unknown' }, { campus: '' }, { campus: null }, { name: '', nameSource: '' }, { name: null }, { email: '' }, { email: null },
    { enrolmentNo: '' }, { enrolmentNo: null }, { nameSource: 'github profile' }, { nameSource: '' }, { githubId: null },
    { unresolvedSince: new Date() }, { backfill: { status: 'error', at: new Date(), error: 'not_found' } }, { backfill: { status: 'error', at: new Date(), error: 'http 502' } },
    { batch: null, campus: 'Unknown', name: '', nameSource: '', email: '', enrolmentNo: '', githubId: null, unresolvedSince: new Date() },
  ];
  await insertStudents(db, variants.map((v, i) => ({ username: `v${String(i).padStart(2, '0')}`, ...base, ...v })));
  // fields that are absent altogether (older documents)
  await c.students.updateOne({ _id: 'v00' }, { $unset: { email: '', enrolmentNo: '', nameSource: '', githubId: '', batch: '', campus: '', name: '' } });
  const all = await c.students.find({}).toArray();
  for (const k of MISSING_KEYS) {
    const viaFilter = (await c.students.find(MISSING_FILTERS[k]).toArray()).map((s) => s._id).sort();
    const viaRow = all.filter((s) => missingOf(s).includes(k)).map((s) => s._id).sort();
    assert.deepEqual(viaFilter, viaRow, k);
    assert.ok(viaFilter.length >= 2, `${k} has cases`);
  }
  assert.deepEqual(missingOf(all.find((s) => s._id === 'v16')), [], 'a fetch error that is not "not found" is not missing data');
  const app = await startApp(db);
  try {
    await app.login();
    const res = (await app.get('/api/admin/students?limit=100')).body;
    for (const k of MISSING_KEYS) {
      const filtered = (await app.get(`/api/admin/students?limit=100&missing=${k}`)).body;
      assert.equal(filtered.total, res.missingCounts[k], k);
      assert.ok(filtered.items.every((s) => s.missing.includes(k)), k);
      assert.deepEqual(filtered.missingCounts, res.missingCounts);
    }
    const any = (await app.get('/api/admin/students?limit=100&missing=any')).body;
    assert.equal(any.total, res.missingCounts.any);
    assert.equal(res.items.filter((s) => s.missing.length).length, res.missingCounts.any);
    assert.equal((await app.get('/api/admin/students?missing=any&campus=ADYPU')).body.total, 0, 'AND with the cohort filters');
    assert.equal((await app.get('/api/admin/students?missing=email,enrolmentNo&limit=100')).body.total,
      all.filter((s) => missingOf(s).some((k) => k === 'email' || k === 'enrolmentNo')).length);
    assert.equal((await app.get('/api/admin/students?missing=,')).status, 200, 'an empty list is no filter');
    assert.equal((await app.get('/api/admin/students?missing=batch,nope')).status, 400);
    app.clearCookie();
    assert.equal((await app.get('/api/admin/students?missing=any')).status, 401);
  } finally { await app.close(); }
});

test('missing data: inline PATCH rules, bulk CSV upsert details, the exported CSV uploads again unchanged', async () => {
  const db = await freshDb();
  const c = collections(db);
  registerHandler('backfill', async () => ({}));
  const docs = await insertStudents(db, [
    { username: 'Mover', name: 'Mover', campus: 'Unknown', batch: null, githubId: 1 },
    { username: 'NewLogin', _id: 'oldlogin', name: '', campus: 'RU', batch: 2025, githubId: 2 },
    { username: 'gone', name: '=Gone, "Quoted" Name', campus: 'RU', batch: 2024, active: false, email: 'g@x.example', enrolmentNo: 'E9', notes: 'line one\nline two' },
  ]);
  await upsertPRs(db, docs[0], [prNode({ repo: 'apache/airflow', number: 1 })]);
  await refreshAggregates(db);
  const app = await startApp(db);
  try {
    await app.login();
    // PATCH: every editable field, one at a time
    const patch = (body) => app.patch('/api/admin/students/mover', body);
    for (const body of [{ batch: 2014 }, { batch: 2036 }, { batch: 2025.5 }, { batch: '25' }, { batch: true }, { batch: [2025] }, { campus: 'Mars' }, { campus: '' }, { campus: null },
      { name: 'x'.repeat(201) }, { name: { a: 1 } }, { email: 'e'.repeat(201) }, { enrolmentNo: 'n'.repeat(101) }, { active: 'no' }, {}, { unknownField: 1 }]) {
      assert.equal((await patch(body)).status, 400, JSON.stringify(body));
    }
    assert.deepEqual((await c.students.findOne({ _id: 'mover' }, { projection: { campus: 1, batch: 1, name: 1, _id: 0 } })), { campus: 'Unknown', batch: null, name: 'Mover' }, 'a rejected edit changes nothing');
    const ok = await patch({ campus: 'adypu', batch: '2026', email: ' m@x.example ', enrolmentNo: 'E1', name: 'Mover Renamed' });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.body.student.campus, ok.body.student.batch, ok.body.student.email, ok.body.student.enrolmentNo, ok.body.student.name, ok.body.student.nameSource, ok.body.student.missing],
      ['ADYPU', 2026, 'm@x.example', 'E1', 'Mover Renamed', 'sheet', []]);
    assert.deepEqual((await c.prs.findOne({ author: 'mover' }, { projection: { campus: 1, batch: 1, _id: 0 } })), { campus: 'ADYPU', batch: 2026 }, 'the cohort on the PRs follows');
    assert.equal((await patch({ name: '' })).body.student.nameSource, '', 'clearing the name clears its source');
    assert.deepEqual((await patch({ batch: null })).body.student.missing, ['batch', 'name', 'nameUnofficial']);
    assert.equal((await app.patch('/api/admin/students/nobody', { batch: 2025 })).status, 404);
    assert.equal((await app.patch('/api/admin/students/NEWLOGIN', { name: 'By Current Login' })).body.student.name, 'By Current Login', 'found by the current login of a renamed account');

    // bulk: matched on _id or current login, case-insensitive; duplicates in the file; a bad cell rejects only its row
    const bulk = await app.post('/api/admin/students/bulk', { csv: [
      'github_username,name,campus,batch,email,enrolment_no,notes',
      'MOVER,Mover Again,RU,2025,,,',
      'https://github.com/newlogin,,,2024,n@x.example,,',
      'mover,Second Row Ignored,,,,,',
      'gone,,,2099,,,',
      'gone,,SVYASA,,,,',
      ',No Login,RU,2025,,,',
    ].join('\n') });
    assert.equal(bulk.status, 200);
    assert.deepEqual(bulk.body.results.map((r) => [r.row, r.username, r.status]),
      [[1, 'Mover', 'updated'], [2, 'NewLogin', 'updated'], [3, 'mover', 'exists'], [4, 'gone', 'invalid'], [5, 'gone', 'updated'], [6, '', 'invalid']]);
    assert.equal(bulk.body.job, null, 'no backfill when nobody was added');
    const mover = await c.students.findOne({ _id: 'mover' });
    assert.deepEqual([mover.name, mover.nameSource, mover.campus, mover.batch, mover.email, mover.enrolmentNo], ['Mover Again', 'sheet', 'RU', 2025, 'm@x.example', 'E1']);
    assert.deepEqual((await c.prs.findOne({ author: 'mover' }, { projection: { campus: 1, batch: 1, _id: 0 } })), { campus: 'RU', batch: 2025 });
    assert.equal((await app.get('/api/overview?range=all&campus=RU')).status, 200);
    const renamed = await c.students.findOne({ _id: 'oldlogin' });
    assert.deepEqual([renamed.batch, renamed.email, renamed.name, renamed.username], [2024, 'n@x.example', 'By Current Login', 'NewLogin']);
    const gone = await c.students.findOne({ _id: 'gone' });
    assert.deepEqual([gone.campus, gone.batch, gone.active], ['SVYASA', 2024, false], 'an update never reactivates or erases');
    assert.equal(await c.students.countDocuments({}), 3);

    // export of the filtered list: the rows of the filter, parseable, and a no-op when uploaded again
    const list = (await app.get('/api/admin/students?limit=100&active=false')).body;
    const csv = await app.get('/api/admin/export/students.csv?active=false', { raw: true });
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    const rows = parseCsv(csv.text);
    assert.deepEqual(rows.map((r) => r.github_username), list.items.map((s) => s.username));
    assert.deepEqual([rows[0].name, rows[0].notes, rows[0].campus, rows[0].batch, rows[0].active, rows[0].missing], ['\'=Gone, "Quoted" Name', 'line one\nline two', 'SVYASA', '2024', 'false', 'githubId']);
    const whole = await app.get('/api/admin/export/students.csv?sort=username', { raw: true });
    assert.equal(parseCsv(whole.text).length, 3);
    const before = await c.students.find({}).sort({ _id: 1 }).toArray();
    const again = await app.post('/api/admin/students/bulk', { csv: whole.text });
    assert.deepEqual([again.body.added, again.body.updated, again.body.exists, again.body.invalid], [0, 0, 3, 0], JSON.stringify(again.body.results));
    assert.deepEqual(await c.students.find({}).sort({ _id: 1 }).toArray(), before);
    assert.equal((await app.get('/api/admin/export/students.csv?missing=bogus')).status, 400);
  } finally { await whenIdle(db); await app.close(); unregisterHandler('backfill'); }
});

test('fetchers: unresolvedSince is set when the account is gone, kept on later runs, cleared when it resolves; an unverifiable empty result clears nothing', async () => {
  const db = await freshDb();
  const c = collections(db);
  const T1 = new Date('2026-11-10T00:00:00Z');
  const T2 = new Date('2026-11-19T00:00:00Z');
  await insertStudents(db, [
    { username: 'vanished', githubId: 31, loginCheckedAt: null },            // id known, account deleted
    { username: 'typo', githubId: null, loginCheckedAt: null },              // never resolved
    { username: 'fine', githubId: null, loginCheckedAt: null },
  ]);
  const gh = mockGitHub({ users: [{ login: 'fine', id: 33, prs: [] }] });
  let clock = T1;
  const opts = { fetch: gh.fetch, token: 't', sleep: fakeSleep(), now: () => clock };
  const get = async (id) => c.students.findOne({ _id: id });
  let s = await realSync(db, {}, {}, opts);
  assert.deepEqual([s.notFound, s.ok], [2, 1]);
  assert.deepEqual([(await get('vanished')).unresolvedSince?.toISOString(), (await get('typo')).unresolvedSince?.toISOString(), (await get('fine')).unresolvedSince, (await get('fine')).githubId],
    [T1.toISOString(), T1.toISOString(), undefined, 33]);
  assert.deepEqual([(await get('vanished')).backfill.error, (await get('typo')).backfill.error], ['not_found', 'not_found']);

  // later runs skip them (no --users) or look again (--users): the date of the first miss is kept
  clock = T2;
  s = await realSync(db, {}, {}, opts);
  assert.equal(s.skipped, 2);
  s = await realSync(db, { users: ['vanished', 'typo'] }, {}, opts);
  assert.equal(s.notFound, 2);
  assert.deepEqual([(await get('vanished')).unresolvedSince.toISOString(), (await get('typo')).unresolvedSince.toISOString()], [T1.toISOString(), T1.toISOString()]);

  // GitHub cannot be asked (REST down), the search is empty: that proves nothing, the flag stays
  gh.addUser({ login: 'typo', id: 32, prs: [] });
  gh.intercept = async (call) => (call.kind === 'rest' ? json({ message: 'boom' }, { status: 500 }) : undefined);
  await c.students.updateOne({ _id: 'typo' }, { $set: { loginCheckedAt: T2 } }); // the weekly lookup is not due: only the full fetch asks
  s = await realSync(db, { users: ['typo'], full: true }, {}, opts);
  assert.equal((await get('typo')).unresolvedSince?.toISOString(), T1.toISOString(), 'not cleared by an unverified empty result');

  // the accounts exist (again): cleared, id remembered
  gh.intercept = null;
  gh.addUser({ login: 'vanished', id: 31, prs: [] });
  s = await realSync(db, { users: ['vanished', 'typo'], full: true }, {}, opts);
  assert.deepEqual([s.ok, s.notFound], [2, 0]);
  assert.deepEqual([(await get('vanished')).unresolvedSince, (await get('typo')).unresolvedSince, (await get('typo')).githubId, (await get('typo')).backfill.status], [undefined, undefined, 32, 'done']);
  const app = await startApp(db);
  try {
    await app.login();
    assert.equal((await app.get('/api/admin/students?missing=unresolved')).body.total, 0);
  } finally { await app.close(); }
});
