// SPEC addenda A (date ranges, academic year, activity), B (missing data) and C (scheduled fetch) against a real mongod.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo } from './helpers/mongo.js';
import { startApp } from './helpers/app.js';
import { insertStudents, prNode } from './helpers/fixtures.js';
import { fakeSleep, mockGitHub } from './helpers/github.js';
import { collections, ensureIndexes } from '../src/db.js';
import { refreshAggregates, upsertPRs } from '../src/ingest.js';
import { invalidateContext } from '../src/classify.js';
import {
  addMonths, dayStart, defaultAcademicYear, effectiveAcademicYear, ensureAcademicYear, presets, resolveRange, zoned, zonedTime,
} from '../src/dates.js';
import { registerHandler, startRunner, unregisterHandler, whenIdle } from '../src/jobs.js';
import { sync as realSync } from '../src/jobHandlers.js';
import { ensureSchedule, loadSchedule, nextRunAfter, pauseSchedule, tick, updateSchedule, validateSchedule } from '../src/scheduler.js';

let mongo;
before(async () => { mongo = await startMongo(); });
after(async () => { await mongo?.stop(); });

async function freshDb() {
  const db = mongo.client.db(`r_${Math.random().toString(16).slice(2, 10)}`);
  await ensureIndexes(db);
  invalidateContext();
  return db;
}
const AY = 'from=2026-07-01&to=2027-06-30';

// ------------------------------------------------------------------ pure date helpers

test('dates: IST wall clock, day bounds, academic year, presets', () => {
  // 2026-10-31 19:00 UTC is 2026-11-01 00:30 in India, a Sunday
  assert.deepEqual(zoned(new Date('2026-10-31T19:00:00Z'), 'Asia/Kolkata'), { year: 2026, month: 11, day: 1, hour: 0, minute: 30, second: 0, dow: 7, ymd: '2026-11-01' });
  assert.equal(dayStart('2026-07-01', 'Asia/Kolkata').toISOString(), '2026-06-30T18:30:00.000Z');
  assert.equal(zonedTime('2026-11-20', 2, 30, 'Asia/Kolkata').toISOString(), '2026-11-19T21:00:00.000Z');
  assert.equal(zonedTime('2026-03-29', 3, 0, 'Europe/Berlin').toISOString(), '2026-03-29T01:00:00.000Z', 'works across a DST change too');
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');

  assert.deepEqual(defaultAcademicYear(new Date('2026-11-19T12:00:00Z'), 'Asia/Kolkata'), { label: '2026-27', start: '2026-07-01', end: '2027-06-30' });
  assert.equal(defaultAcademicYear(new Date('2027-06-30T18:29:00Z'), 'Asia/Kolkata').label, '2026-27', '23:59 IST on 30 June');
  assert.equal(defaultAcademicYear(new Date('2027-06-30T18:30:00Z'), 'Asia/Kolkata').label, '2027-28', '00:00 IST on 1 July');

  // the stored year is over and nobody edited it: the default moves on by itself, the old year becomes a preset
  const rolled = effectiveAcademicYear({ current: { label: '2026-27', start: '2026-07-01', end: '2027-06-30' }, history: [] }, new Date('2027-08-01T00:00:00Z'), 'Asia/Kolkata');
  assert.deepEqual([rolled.current.label, rolled.history.map((a) => a.label)], ['2027-28', ['2026-27']]);

  const now = new Date('2026-11-19T12:00:00Z');
  const ay = effectiveAcademicYear({ current: defaultAcademicYear(now), history: [{ label: '2025-26', start: '2025-07-01', end: '2026-06-30' }] }, now, 'Asia/Kolkata');
  assert.deepEqual(presets(ay, now, 'Asia/Kolkata'), [
    { key: 'ay', label: 'AY 2026-27', from: '2026-07-01', to: '2027-06-30' },
    { key: 'ay-2025-26', label: 'AY 2025-26', from: '2025-07-01', to: '2026-06-30' },
    { key: '30d', label: 'Last 30 days', from: '2026-10-21', to: '2026-11-19' },
    { key: '90d', label: 'Last 90 days', from: '2026-08-22', to: '2026-11-19' },
    { key: '12m', label: 'Last 12 months', from: '2025-11-20', to: '2026-11-19' },
    { key: 'all', label: 'All time', from: null, to: null },
  ]);
  const def = resolveRange({}, ay, now, 'Asia/Kolkata');
  assert.deepEqual([def.preset, def.start.toISOString(), def.end.toISOString(), def.all], ['ay', '2026-06-30T18:30:00.000Z', '2027-06-30T18:30:00.000Z', false],
    'from 1 July 00:00 IST inclusive to 1 July 00:00 IST exclusive');
  assert.deepEqual([resolveRange({ range: 'all' }, ay, now).all, resolveRange({ range: 'ay-2025-26' }, ay, now).from], [true, '2025-07-01']);
  assert.equal(resolveRange({ from: '2025-07-01', to: '2026-06-30' }, ay, now).preset, 'ay-2025-26', 'explicit dates that equal a preset are recognised');
  assert.deepEqual([resolveRange({ from: '2026-08-01' }, ay, now).label, resolveRange({ from: '2026-08-01' }, ay, now).end], ['Custom range', null]);
  for (const bad of [{ from: '2026-13-01' }, { to: 'tomorrow' }, { from: '2026-08-02', to: '2026-08-01' }, { range: 'nope' }, { from: '2026-02-30' }]) {
    assert.throws(() => resolveRange(bad, ay, now), /invalid/);
  }
});

// ------------------------------------------------------------------ ranged API

test('ranges: IST boundaries, opened vs merged in range, default = academic year, activity analytics', async () => {
  const db = await freshDb();
  const c = collections(db);
  const [s1, s2] = await insertStudents(db, [
    { username: 'one', name: 'One', campus: 'RU', batch: 2025 },
    { username: 'two', name: 'Two', campus: 'ADYPU', batch: 2026 },
    { username: 'idle', name: 'Idle', campus: 'RU', batch: 2025 },
  ]);
  const pr = (number, createdAt, mergedAt, extra = {}) => prNode({ repo: 'apache/airflow', number, createdAt, mergedAt, state: mergedAt ? 'MERGED' : 'OPEN', ...extra });
  await upsertPRs(db, s1, [
    pr(1, '2026-05-10T10:00:00Z', '2026-07-02T05:00:00Z'),            // opened before the year, merged inside it
    pr(2, '2027-06-30T18:00:00Z', '2027-06-30T18:20:00Z'),            // merged 30 Jun 2027 23:50 IST: inside AY 2026-27
    pr(5, '2025-12-01T10:00:00Z', '2025-12-05T10:00:00Z'),            // the year before
    pr(6, '2026-09-10T10:00:00Z', null, { repo: 'tiny/lib', stars: 3 }), // not open source
  ]);
  await upsertPRs(db, s2, [
    pr(3, '2027-06-30T18:35:00Z', '2027-06-30T18:40:00Z'),            // merged 1 Jul 2027 00:10 IST: outside
    pr(4, '2026-10-31T19:00:00Z', null),                               // opened Sunday 1 Nov 2026 00:30 IST (Saturday 31 Oct in UTC)
  ]);
  await refreshAggregates(db);
  await ensureAcademicYear(db);
  const app = await startApp(db);
  const get = async (p) => { const r = await app.get(p); assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.body)}`); return r.body; };
  try {
    // ---- meta
    const meta = await get('/api/meta');
    assert.equal(meta.tz, 'Asia/Kolkata');
    assert.equal(meta.academicYear.current.label, defaultAcademicYear().label);
    assert.deepEqual(meta.presets.map((p) => p.key).filter((k) => !k.startsWith('ay-')), ['ay', '30d', '90d', '12m', 'all']);
    assert.equal(meta.updatesPaused, false);

    // ---- overview: explicit AY 2026-27
    const o = await get(`/api/overview?${AY}`);
    assert.deepEqual([o.range.from, o.range.to], ['2026-07-01', '2027-06-30']);
    assert.deepEqual([o.prs.total, o.prs.merged, o.prs.osPrs, o.prs.osMerged, o.prs.osOpen], [3, 2, 2, 2, 1],
      'opened in range: #2 #4 #6; merged in range: #1 (opened earlier) and #2; #3 falls on 1 July IST');
    assert.deepEqual(o.prs.byCategory.low_signal, 1);
    assert.deepEqual(o.students, { tracked: 3, withAnyPr: 2, withOsPr: 2, withOsMerged: 1, withMajorMerged: 1 });
    assert.deepEqual(o.topStudents.map((s) => [s.username, s.stats.osMerged, s.stats.osPrs]), [['one', 2, 1]]);
    assert.deepEqual(o.topRepos, [{ name: 'apache/airflow', stars: 5000, tier: 'major', osPrs: 2, osMerged: 2, students: 2 }]);
    assert.equal(o.monthly[0].month, '2026-07');
    assert.deepEqual(o.monthly.find((m) => m.month === '2026-11'), { month: '2026-11', osOpened: 1, osMerged: 0, allOpened: 1 }, 'bucketed in IST: 31 Oct 19:00 UTC is November');
    assert.deepEqual(o.monthly.find((m) => m.month === '2026-10'), { month: '2026-10', osOpened: 0, osMerged: 0, allOpened: 0 });
    // one more day lets the 1 July PR in
    const wider = await get('/api/overview?from=2026-07-01&to=2027-07-01');
    assert.deepEqual([wider.prs.total, wider.prs.merged], [4, 3]);
    // the year before
    const prev = await get('/api/overview?from=2025-07-01&to=2026-06-30');
    assert.deepEqual([prev.prs.total, prev.prs.merged, prev.students.withOsMerged], [2, 1, 1], 'opened: #5 and #1; merged: #5 only');
    // all time agrees with the precomputed stats
    const all = await get('/api/overview?range=all');
    assert.deepEqual([all.prs.total, all.prs.merged, all.prs.osMerged, all.students.withOsMerged], [6, 4, 4, 2]);

    // ---- no parameters = the current academic year
    const def = await get('/api/overview');
    assert.equal(def.range.preset, 'ay');
    const cur = meta.academicYear.current;
    assert.deepEqual([def.range.from, def.range.to, def.range.label], [cur.start, cur.end, `AY ${cur.label}`]);

    // ---- students
    const st = await get(`/api/students?${AY}`);
    assert.deepEqual(st.range.from, '2026-07-01');
    assert.deepEqual(st.items.map((s) => [s.username, s.stats.osMerged, s.stats.osPrs, s.stats.totalPrs, s.stats.mergedPrs]), [['one', 2, 1, 2, 2], ['two', 0, 1, 1, 0], ['idle', 0, 0, 0, 0]]);
    assert.deepEqual(st.items[0].stats.byCategory, { open_source: 1, practice: 0, nst_internal: 0, peer_repo: 0, own_repo: 0, low_signal: 1 });
    assert.equal(st.items[0].stats.lastOsMergedAt, '2027-06-30T18:20:00.000Z');
    assert.deepEqual((await get(`/api/students?${AY}&sort=totalPrs&order=asc`)).items.map((s) => s.username), ['idle', 'two', 'one']);
    assert.deepEqual((await get(`/api/students?${AY}&sort=name`)).items.map((s) => s.name), ['Idle', 'One', 'Two']);
    assert.deepEqual((await get(`/api/students?${AY}&hasOs=1&limit=1&page=2`)).items.map((s) => s.username), ['two']);
    assert.equal((await get(`/api/students?${AY}&hasOs=1`)).total, 2);
    assert.deepEqual((await get('/api/students?from=2025-07-01&to=2026-06-30')).items.map((s) => [s.username, s.stats.osMerged, s.stats.osPrs]), [['one', 1, 2], ['idle', 0, 0], ['two', 0, 0]]);
    const prof = await get(`/api/students/one?${AY}`);
    assert.deepEqual([prof.student.stats.osMerged, prof.student.stats.totalPrs, prof.prs.total], [2, 2, 3], 'the PR list holds everything opened or merged in the range');
    assert.deepEqual(prof.repos.map((r) => [r.name, r.prs, r.merged]), [['apache/airflow', 1, 2], ['tiny/lib', 1, 0]]);
    assert.equal((await get('/api/students/one?range=all')).student.stats.totalPrs, 4);

    // ---- PRs: merged ones by merge date, others by creation date
    const numbers = async (q) => (await get(`/api/prs?category=all&${q}`)).items.map((p) => p.number).sort();
    assert.deepEqual(await numbers(`${AY}&state=merged`), [1, 2]);
    assert.deepEqual(await numbers(`${AY}&state=open`), [4, 6]);
    assert.deepEqual(await numbers(AY), [1, 2, 4, 6]);
    assert.deepEqual(await numbers('range=all'), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(await numbers('from=2027-07-01'), [3]);
    assert.deepEqual(await numbers('to=2025-12-31'), [5]);
    assert.deepEqual(await numbers(`${AY}&q=airflow`), [1, 2, 4], 'the search and the range filter combine');
    assert.equal((await app.get('/api/prs?from=2026-08-02&to=2026-08-01')).status, 400);
    assert.equal((await app.get('/api/overview?range=nope')).status, 400);

    // ---- repos / orgs / campuses
    const repos = await get(`/api/repos?category=all&${AY}`);
    assert.deepEqual(repos.items.map((r) => [r.name, r.stats.prs, r.stats.merged, r.stats.open, r.stats.students]), [['apache/airflow', 2, 2, 1, 2], ['tiny/lib', 1, 0, 1, 1]]);
    assert.deepEqual((await get('/api/repos?category=all&from=2020-01-01&to=2020-12-31')).items, []);
    const repo = await get(`/api/repos/apache/airflow?${AY}`);
    assert.deepEqual([repo.repo.stats.prs, repo.repo.stats.merged, repo.owner.stats.osMerged, repo.prs.total], [2, 2, 2, 3]);
    assert.deepEqual(repo.students.map((s) => [s.username, s.prs, s.merged]), [['one', 1, 2], ['two', 1, 0]]);
    const orgs = await get(`/api/orgs?${AY}`);
    assert.deepEqual(orgs.items.map((x) => [x.login, x.stats.osPrs, x.stats.osMerged, x.stats.repos]), [['apache', 2, 2, 1]]);
    assert.deepEqual((await get(`/api/orgs?category=all&${AY}`)).items.map((x) => x.login), ['apache', 'tiny']);
    const org = await get(`/api/orgs/apache?${AY}`);
    assert.deepEqual([org.org.stats.osMerged, org.repos.map((r) => r.stats.merged), org.students.length], [2, [2], 2]);
    const campuses = await get(`/api/campuses?${AY}`);
    assert.deepEqual([campuses.total.students, campuses.total.withAnyPr, campuses.total.withOsMerged, campuses.total.osMerged, campuses.total.totalPrs], [3, 2, 1, 2, 3]);
    assert.equal(campuses.rows.find((r) => r.campus === 'ADYPU').osPrs, 1);

    // ---- CSV exports respect the range
    const csv = (await app.get(`/api/export/prs.csv?category=all&${AY}`, { raw: true })).text.trim().split('\n');
    assert.equal(csv.length, 1 + 4);
    assert.ok(csv.slice(1).every((l) => l.includes(',One,') || l.includes(',Two,')), 'author names are filled in');
    const studentsCsv = (await app.get(`/api/export/students.csv?${AY}`, { raw: true })).text.trim().split('\n');
    assert.match(studentsCsv[1], /^one,One,RU,2025,[^,]+,2,2,1,2,/);

    // ---- activity
    const a = await get(`/api/activity?${AY}&category=all`);
    assert.deepEqual(Object.keys(a), ['range', 'tz', 'metric', 'totals', 'byMonth', 'byWeek', 'byWeekday', 'byHour', 'heatmap', 'byCampusMonth', 'busiest', 'byDate']);
    assert.deepEqual(a.totals, { opened: 3, merged: 2, activeStudents: 2 });
    assert.deepEqual([a.byMonth[0].month, a.byMonth.at(-1).month, a.byMonth.length], ['2026-07', '2027-06', 12]);
    assert.deepEqual(a.byMonth.find((m) => m.month === '2026-11'), { month: '2026-11', opened: 1, merged: 0, activeStudents: 1 });
    assert.deepEqual(a.byMonth.find((m) => m.month === '2026-07'), { month: '2026-07', opened: 0, merged: 1, activeStudents: 1 });
    assert.deepEqual(a.byMonth.find((m) => m.month === '2026-08'), { month: '2026-08', opened: 0, merged: 0, activeStudents: 0 }, 'zero-filled');
    assert.equal(a.byDate.length, 365, 'every day of the range');
    assert.deepEqual([a.byDate[0], a.byDate.at(-1)], [{ date: '2026-07-01', opened: 0, merged: 0 }, { date: '2027-06-30', opened: 1, merged: 1 }]);
    assert.deepEqual(a.byDate.find((d) => d.date === '2026-11-01'), { date: '2026-11-01', opened: 1, merged: 0 });
    assert.deepEqual(a.byDate.find((d) => d.date === '2026-10-31'), { date: '2026-10-31', opened: 0, merged: 0 }, 'not the UTC day');
    assert.deepEqual(a.byWeekday.map((d) => d.opened), [0, 0, 1, 1, 0, 0, 1], 'Wed 30 Jun 2027, Thu 10 Sep 2026, Sun 1 Nov 2026 (IST)');
    assert.deepEqual(a.byHour.filter((x) => x.opened).map((x) => x.hour), [0, 15, 23], '00:30, 15:30 and 23:30 IST');
    assert.equal(a.heatmap.length, 7 * 24);
    assert.deepEqual(a.heatmap.find((x) => x.dow === 7 && x.hour === 0), { dow: 7, hour: 0, opened: 1, merged: 0 });
    assert.deepEqual(a.heatmap.find((x) => x.dow === 6 && x.hour === 19), { dow: 6, hour: 19, opened: 0, merged: 0 }, 'the UTC cell stays empty');
    assert.ok(a.byWeek.every((w, i, arr) => new Date(`${w.weekStart}T00:00:00Z`).getUTCDay() === 1 && (i === 0 || arr[i - 1].weekStart < w.weekStart)), 'weeks start on Monday');
    assert.deepEqual(a.byWeek.find((w) => w.weekStart === '2026-10-26'), { weekStart: '2026-10-26', opened: 1, merged: 0 });
    assert.deepEqual(a.byCampusMonth, [{ campus: 'ADYPU', month: '2026-11', opened: 1, merged: 0 }, { campus: 'RU', month: '2026-07', opened: 0, merged: 1 },
      { campus: 'RU', month: '2026-09', opened: 1, merged: 0 }, { campus: 'RU', month: '2027-06', opened: 1, merged: 1 }]);
    assert.deepEqual(a.busiest, { day: { date: '2026-09-10', count: 1 }, week: { weekStart: '2026-09-07', count: 1 }, month: { month: '2026-09', count: 1 } });
    const m = await get(`/api/activity?${AY}&metric=merged`);
    assert.deepEqual([m.metric, m.totals.merged, m.totals.opened, m.busiest.day], ['merged', 2, 2, { date: '2026-07-02', count: 1 }], 'default category is open source');
    assert.deepEqual((await get(`/api/activity?${AY}&author=TWO&category=all`)).totals, { opened: 1, merged: 0, activeStudents: 1 });
    assert.deepEqual((await get(`/api/activity?${AY}&repo=tiny/lib&category=all`)).totals, { opened: 1, merged: 0, activeStudents: 1 });
    assert.deepEqual((await get(`/api/activity?${AY}&owner=Apache&campus=RU`)).totals, { opened: 1, merged: 2, activeStudents: 1 });
    const long = await get('/api/activity?from=2020-01-01&to=2027-07-01&category=all');
    assert.deepEqual([long.truncated, 'byDate' in long, long.totals.opened], [true, false, 6], 'more than 800 days: no day-by-day list');
    assert.equal((await app.get('/api/activity?metric=closed')).status, 400);

    // ---- the admin moves the academic year: the default range of every endpoint follows
    await app.login();
    for (const bad of [{ label: '', start: '2026-08-01', end: '2027-03-31' }, { label: 'x', start: '2027-03-31', end: '2026-08-01' },
      { label: 'x', start: '2026-01-01', end: '2027-06-30' }, { label: 'x', start: '2026-08-01', end: 'soon' }]) {
      assert.equal((await app.put('/api/admin/academic-year', bad)).status, 400, JSON.stringify(bad));
    }
    const today = zoned(new Date()).ymd;
    const custom = { label: 'Term A', start: '2026-08-01', end: today > '2027-03-31' ? today : '2027-03-31' };
    const put = await app.put('/api/admin/academic-year', custom);
    assert.deepEqual([put.status, put.body.academicYear.current, put.body.academicYear.history[0].label], [200, custom, cur.label]);
    assert.deepEqual((await get('/api/admin/academic-year')).academicYear.current, custom);
    app.clearCookie();
    const moved = await get('/api/overview');
    assert.deepEqual([moved.range.label, moved.range.from, moved.prs.total, moved.prs.merged], ['AY Term A', '2026-08-01', 2, 0], 'only #4 and #6 were opened in the new year, nothing merged');
    const meta2 = await get('/api/meta');
    assert.deepEqual(meta2.presets.slice(0, 2).map((p) => [p.key, p.label]), [['ay', 'AY Term A'], [`ay-${cur.label}`, `AY ${cur.label}`]]);
    assert.equal((await get(`/api/overview?range=ay-${cur.label}`)).range.from, cur.start, 'the previous year stays reachable as a preset');
    assert.equal((await get('/api/students')).range.label, 'AY Term A');
  } finally { await app.close(); }
});

// ------------------------------------------------------------------ addendum B

test('admin students: missing-data filter, counts, validation, bulk update of existing students, CSV of the filtered list', async () => {
  const db = await freshDb();
  const c = collections(db);
  registerHandler('backfill', async () => ({}));
  await insertStudents(db, [
    { username: 'complete', name: 'Complete', nameSource: 'sheet', campus: 'RU', batch: 2025, email: 'c@x.example', enrolmentNo: 'E1', githubId: 1 },
    { username: 'nobatch', name: 'No Batch', nameSource: 'sheet', campus: 'RU', batch: null, email: 'n@x.example', enrolmentNo: 'E2', githubId: 2 },
    { username: 'nocampus', name: 'No Campus', nameSource: 'sheet', campus: 'Unknown', batch: 2025, email: 'm@x.example', enrolmentNo: 'E3', githubId: 3 },
    { username: 'noname', name: '', campus: 'RU', batch: 2025, email: 'o@x.example', enrolmentNo: 'E4', githubId: 4 },
    { username: 'nocontact', name: 'Profile Name', nameSource: 'github profile', campus: 'RU', batch: 2025, email: '', enrolmentNo: '', githubId: 5 },
    { username: 'ghost', name: 'Ghost', nameSource: 'sheet', campus: 'RU', batch: 2025, email: 'g@x.example', enrolmentNo: 'E6', githubId: null,
      unresolvedSince: new Date('2026-11-01T00:00:00Z'), backfill: { status: 'error', at: new Date(), error: 'not_found' } },
  ]);
  const app = await startApp(db);
  try {
    await app.login();
    const names = async (q) => (await app.get(`/api/admin/students?sort=username&${q}`)).body.items.map((s) => s.username);
    assert.deepEqual(await names('missing=batch'), ['nobatch']);
    assert.deepEqual(await names('missing=campus'), ['nocampus']);
    assert.deepEqual(await names('missing=name'), ['noname']);
    assert.deepEqual(await names('missing=email'), ['nocontact']);
    assert.deepEqual(await names('missing=enrolmentNo'), ['nocontact']);
    assert.deepEqual(await names('missing=nameUnofficial'), ['nocontact', 'noname']);
    assert.deepEqual(await names('missing=githubId'), ['ghost']);
    assert.deepEqual(await names('missing=unresolved'), ['ghost']);
    assert.deepEqual(await names('missing=batch,campus'), ['nobatch', 'nocampus'], 'OR-combined');
    assert.deepEqual(await names('missing=any'), ['ghost', 'nobatch', 'nocampus', 'nocontact', 'noname']);
    assert.deepEqual(await names('missing=any&q=no%20b'), ['nobatch'], 'combines with the normal filters');
    assert.equal((await app.get('/api/admin/students?missing=shoe-size')).status, 400);

    const list = (await app.get('/api/admin/students?missing=batch')).body;
    assert.deepEqual(list.missingCounts, { batch: 1, campus: 1, name: 1, email: 1, enrolmentNo: 1, nameUnofficial: 2, githubId: 1, unresolved: 1, any: 5 }, 'independent of the active filter');
    assert.deepEqual(list.items[0].missing, ['batch']);
    const ghost = (await app.get('/api/admin/students?q=ghost')).body.items[0];
    assert.deepEqual([ghost.missing, ghost.unresolvedSince], [['githubId', 'unresolved'], '2026-11-01T00:00:00.000Z']);
    assert.ok(!JSON.stringify((await app.get('/api/students?range=all')).body).includes('unresolved'), 'not on the public API');

    // inline edits: validation
    for (const [body, ok] of [[{ batch: 2014 }, false], [{ batch: 2036 }, false], [{ batch: 'soon' }, false], [{ campus: 'Mars' }, false], [{ campus: '' }, false],
      [{ batch: 2015 }, true], [{ batch: 2035 }, true], [{ batch: null }, true], [{ campus: 'svyasa', batch: 2026 }, true]]) {
      assert.equal((await app.patch('/api/admin/students/nobatch', body)).status, ok ? 200 : 400, JSON.stringify(body));
    }
    assert.deepEqual(await names('missing=batch'), []);
    assert.equal((await app.get('/api/admin/students?missing=batch')).body.missingCounts.batch, 0);

    // bulk upload: existing students are updated from the filled-in columns, never erased
    const bulk = await app.post('/api/admin/students/bulk', { csv: [
      'github_username,name,campus,batch,email,enrolment_no',
      'NoContact,Real Name,,,real@x.example,E5',
      'noname,Now Named,,,,',
      'complete,Complete,RU,2025,,',
      'brand-new,New Kid,RU,2026,,',
      'nocampus,,Mars,,,',
    ].join('\n') });
    assert.deepEqual(bulk.body.results.map((r) => [r.username, r.status]), [['nocontact', 'updated'], ['noname', 'updated'], ['complete', 'exists'], ['brand-new', 'added'], ['nocampus', 'invalid']]);
    assert.deepEqual([bulk.body.added, bulk.body.updated, bulk.body.exists, bulk.body.invalid], [1, 2, 1, 1]);
    const nc = await c.students.findOne({ _id: 'nocontact' });
    assert.deepEqual([nc.name, nc.nameSource, nc.email, nc.enrolmentNo, nc.campus, nc.batch], ['Real Name', 'sheet', 'real@x.example', 'E5', 'RU', 2025]);
    assert.deepEqual([(await c.students.findOne({ _id: 'noname' })).name, (await c.students.findOne({ _id: 'complete' })).email], ['Now Named', 'c@x.example']);
    assert.equal((await app.get('/api/admin/students')).body.missingCounts.name, 0);
    await whenIdle(db);

    // CSV of the current filtered admin list (admin only)
    const csv = await app.get('/api/admin/export/students.csv?missing=unresolved', { raw: true });
    assert.match(csv.headers.get('content-disposition'), /students-admin\.csv/);
    const lines = csv.text.trim().split('\n');
    assert.equal(lines[0].split(',').slice(0, 9).join(','), 'campus,year,batch,name,github_username,github_profile,email,enrolment_no,name_source');
    assert.equal(lines.length, 2);
    assert.match(lines[1], /^RU,[^,]+,2025,Ghost,ghost,https:\/\/github\.com\/ghost,g@x\.example,E6,sheet,/);
    app.clearCookie();
    assert.equal((await app.get('/api/admin/export/students.csv')).status, 401);
  } finally { await app.close(); unregisterHandler('backfill'); }
});

// ------------------------------------------------------------------ addendum C

test('scheduler: fires once at the right IST time, not while paused, auto-resume, catch-up once, weekly full refresh', async () => {
  const db = await freshDb();
  const c = collections(db);
  const runs = [];
  registerHandler('sync', async (d, params) => { runs.push(params); return { students: 0, ok: 0, failed: 0, prs: 0, renamed: 0, notFound: 0 }; });
  try {
    assert.equal(nextRunAfter(new Date('2026-11-19T20:59:59Z'), '02:30', 'Asia/Kolkata').toISOString(), '2026-11-19T21:00:00.000Z', '02:30 IST = 21:00 UTC the day before');
    assert.equal(nextRunAfter(new Date('2026-11-19T21:00:00Z'), '02:30', 'Asia/Kolkata').toISOString(), '2026-11-20T21:00:00.000Z');
    const at = (iso) => ({ now: new Date(iso), tz: 'Asia/Kolkata' });
    const s0 = await ensureSchedule(db, { ...at('2026-11-19T10:00:00Z'), concurrency: 4 });
    assert.deepEqual([s0.enabled, s0.paused, s0.dailyAt, s0.fullRefreshDay, s0.concurrency, s0.nextRunAt.toISOString()], [true, false, '02:30', null, 4, '2026-11-19T21:00:00.000Z']);

    assert.deepEqual(await tick(db, at('2026-11-19T20:59:30Z')), { fired: null, why: 'not due' });
    const fired = await tick(db, at('2026-11-19T21:00:10Z'));
    assert.equal(fired.why, 'schedule');
    assert.deepEqual(await tick(db, at('2026-11-19T21:00:40Z')), { fired: null, why: 'not due' }, 'one run per slot');
    await whenIdle(db);
    assert.deepEqual(runs, [{ trigger: 'schedule', full: false, concurrency: 4 }]);
    let s = await loadSchedule(db);
    assert.deepEqual([s.nextRunAt.toISOString(), s.lastRunAt.toISOString(), s.lastRunJobId], ['2026-11-20T21:00:00.000Z', '2026-11-19T21:00:10.000Z', fired.fired]);
    await tick(db, at('2026-11-19T21:01:10Z'));
    assert.equal((await loadSchedule(db)).lastRunStatus, 'done', 'the result of the run is recorded');

    // paused until 23 Nov (00:00 IST): the slots of the 20th, 21st and 22nd pass, then exactly one catch-up run
    await pauseSchedule(db, { until: zonedTime('2026-11-23', 0, 0, 'Asia/Kolkata'), note: 'exam week' }, at('2026-11-20T10:00:00Z'));
    for (const t of ['2026-11-20T21:00:10Z', '2026-11-21T21:00:10Z', '2026-11-22T18:29:00Z']) assert.deepEqual(await tick(db, at(t)), { fired: null, why: 'paused' });
    const resumed = await tick(db, at('2026-11-22T18:30:10Z'));
    assert.equal(resumed.why, 'catchup', 'auto-resume at pausedUntil');
    s = await loadSchedule(db);
    assert.deepEqual([s.paused, s.pausedUntil, s.pauseNote, s.nextRunAt.toISOString()], [false, null, '', '2026-11-22T21:00:00.000Z']);
    assert.equal((await tick(db, at('2026-11-22T18:30:40Z'))).fired, null, 'never more than once');
    await whenIdle(db);
    assert.equal(runs.length, 2);

    // the app was down for days: one catch-up run on boot
    await c.settings.updateOne({ _id: 'schedule' }, { $set: { nextRunAt: new Date('2026-11-25T21:00:00Z') } });
    const boot = await tick(db, at('2026-11-29T05:00:00Z'));
    assert.equal(boot.why, 'catchup');
    assert.equal((await loadSchedule(db)).nextRunAt.toISOString(), '2026-11-29T21:00:00.000Z');
    assert.equal((await tick(db, at('2026-11-29T05:00:30Z'))).fired, null);
    await whenIdle(db);
    assert.equal(runs.length, 3);

    // weekly full refresh: 02:30 IST on Monday 30 Nov 2026 (the tick happens Sunday 21:00 UTC)
    assert.equal(validateSchedule({ fullRefreshDay: 7 }).error !== undefined && validateSchedule({ dailyAt: '25:00' }).error !== undefined
      && validateSchedule({ concurrency: 0 }).error !== undefined && validateSchedule({}).error !== undefined, true);
    await updateSchedule(db, validateSchedule({ fullRefreshDay: 1, concurrency: 3 }).value, at('2026-11-29T06:00:00Z'));
    assert.equal((await tick(db, at('2026-11-29T21:00:05Z'))).why, 'schedule');
    await whenIdle(db);
    assert.deepEqual(runs.at(-1), { trigger: 'schedule', full: true, concurrency: 3 });
    assert.equal((await tick(db, at('2026-11-30T21:00:05Z'))).why, 'schedule');
    await whenIdle(db);
    assert.equal(runs.at(-1).full, false, 'Tuesday is an ordinary incremental run');

    // a new time of day moves the next run; switching the schedule off stops it
    s = await updateSchedule(db, { dailyAt: '06:00' }, at('2026-12-01T00:00:00Z'));
    assert.equal(s.nextRunAt.toISOString(), '2026-12-01T00:30:00.000Z');
    s = await updateSchedule(db, { enabled: false }, at('2026-12-01T00:10:00Z'));
    assert.equal(s.nextRunAt, null);
    assert.deepEqual(await tick(db, at('2026-12-05T00:00:00Z')), { fired: null, why: 'disabled' });
    assert.equal(runs.length, 5);
  } finally { await whenIdle(db); unregisterHandler('sync'); }
});

test('scheduler + jobs API: 409 on a concurrent sync, cancel keeps what was saved, a run cut off by a restart is recovered once', async () => {
  const db = await freshDb();
  const c = collections(db);
  const NOW = new Date('2026-11-19T21:00:00Z');
  const LAST = new Date('2026-11-18T21:00:00Z');
  await insertStudents(db, Array.from({ length: 4 }, (_, i) => ({ username: `s${i}`, githubId: 200 + i, loginCheckedAt: NOW, lastSyncedAt: new Date(LAST.getTime() + i * 1000) })));
  const gh = mockGitHub({ users: Array.from({ length: 4 }, (_, i) => ({ login: `s${i}`, id: 200 + i,
    prs: [prNode({ repo: 'apache/airflow', number: 300 + i, author: { login: `s${i}`, databaseId: 200 + i }, createdAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-19T00:00:00Z' })] })) });
  let gate = null; // lets the test hold the run at the second student
  let release = () => {};
  let atSecond = () => {};
  const reached = new Promise((r) => { atSecond = r; });
  gh.intercept = async (call) => {
    if (call.kind === 'graphql' && /author:s1\b/.test(call.q) && gate) { atSecond(); await gate; }
    return undefined;
  };
  registerHandler('sync', (d, params, ctx) => realSync(d, { ...params, concurrency: 1 }, ctx, { fetch: gh.fetch, token: 't', sleep: fakeSleep(), now: () => NOW }));
  const app = await startApp(db);
  try {
    await app.login();
    gate = new Promise((r) => { release = r; });
    const first = await app.post('/api/admin/jobs/sync', { campus: 'RU', batch: 2025 });
    assert.equal(first.status, 202);
    await reached;

    // while it runs: a second trigger is refused with the id of the running job, and the scheduler waits
    const second = await app.post('/api/admin/jobs/sync', { full: true });
    assert.deepEqual([second.status, second.body.error.code, second.body.error.jobId], [409, 'conflict', first.body.job.id]);
    await ensureSchedule(db, { now: new Date('2026-11-19T10:00:00Z') });
    assert.deepEqual(await tick(db, { now: new Date('2026-11-19T21:00:10Z') }), { fired: null, why: 'a sync is already queued or running' });
    const view = (await app.get('/api/admin/schedule')).body;
    assert.deepEqual([view.running.id, view.running.status, view.schedule.enabled, view.tz], [first.body.job.id, 'running', true, 'Asia/Kolkata']);

    // cancel mid-run
    const cancel = await app.post(`/api/admin/jobs/${first.body.job.id}/cancel`);
    assert.deepEqual([cancel.status, cancel.body.job.cancelRequested], [200, true]);
    release();
    gate = null;
    await whenIdle(db);
    const job = (await app.get(`/api/admin/jobs/${first.body.job.id}`)).body.job;
    assert.deepEqual([job.status, job.params.campus, job.params.batch, job.params.trigger, job.summary.cancelled, job.summary.studentsChecked], ['cancelled', 'RU', 2025, 'manual', true, 2]);
    assert.equal(await c.prs.countDocuments({}), 2, 'what was fetched before the cancel is kept');
    assert.equal((await c.students.findOne({ _id: 's0' })).stats.osMerged, 1, 'and counted');
    assert.equal((await c.students.findOne({ _id: 's3' })).lastSyncedAt.getTime(), LAST.getTime() + 3000, 'the others are simply not synced yet');
    assert.equal((await app.post(`/api/admin/jobs/${first.body.job.id}/cancel`)).status, 409, 'already finished');
    assert.equal((await app.post('/api/admin/jobs/nope/cancel')).status, 404);
    assert.ok((await app.get('/api/admin/jobs?status=cancelled')).body.items.some((j) => j.id === first.body.job.id));

    // the deferred nightly run starts now that nothing is running, and picks up the students left over
    const due = await tick(db, { now: new Date('2026-11-19T21:02:00Z') });
    assert.equal(due.why, 'schedule');
    await whenIdle(db);
    assert.equal(await c.prs.countDocuments({}), 4);
    const done = (await app.get(`/api/admin/jobs/${due.fired}`)).body.job;
    assert.deepEqual([done.status, done.summary.studentsChecked, done.summary.prsNew, done.summary.newMerged, typeof done.summary.durationMs, done.summary.rateLimitRemaining],
      ['done', 4, 2, 2, 'number', 4900]);

    // schedule API
    assert.equal((await app.put('/api/admin/schedule', { dailyAt: '2:30' })).status, 400);
    assert.equal((await app.put('/api/admin/schedule', { concurrency: 99 })).status, 400);
    const put = await app.put('/api/admin/schedule', { dailyAt: '03:15', fullRefreshDay: 0, concurrency: 5 });
    assert.deepEqual([put.status, put.body.schedule.dailyAt, put.body.schedule.fullRefreshDay, put.body.schedule.concurrency], [200, '03:15', 0, 5]);
    assert.equal(zoned(new Date(put.body.schedule.nextRunAt)).hour * 100 + zoned(new Date(put.body.schedule.nextRunAt)).minute, 315, 'next run at 03:15 IST');
    assert.equal(put.body.runs.length, 2);
    assert.equal((await app.post('/api/admin/schedule/pause', { until: '2020-01-01' })).status, 400, 'a pause must end in the future');
    const paused = await app.post('/api/admin/schedule/pause', { note: 'GitHub outage' });
    assert.deepEqual([paused.body.schedule.paused, paused.body.schedule.pausedUntil, paused.body.schedule.pauseNote], [true, null, 'GitHub outage']);
    assert.equal((await app.get('/api/meta')).body.updatesPaused, true);
    assert.deepEqual(await tick(db, { now: new Date('2030-01-01T00:00:00Z') }), { fired: null, why: 'paused' });
    const resumed = await app.post('/api/admin/schedule/resume');
    assert.deepEqual([resumed.body.schedule.paused, (await app.get('/api/meta')).body.updatesPaused], [false, false]);
    assert.equal(new Date((await app.get('/api/meta')).body.lastSyncAt).getTime(), new Date(done.finishedAt).getTime(), 'lastSyncAt = finish time of the last successful sync');
    app.clearCookie();
    assert.equal((await app.get('/api/admin/schedule')).status, 401);

    // restart during a scheduled run: startRunner marks it interrupted, the next tick starts it again, once
    await c.jobs.insertOne({ _id: 'cutoff000001', type: 'sync', runner: 'app', status: 'running', params: { trigger: 'schedule' }, createdAt: new Date(), startedAt: new Date(), finishedAt: null,
      progress: { done: 10, total: 100 }, summary: null, log: [], error: null });
    await c.settings.updateOne({ _id: 'schedule' }, { $set: { lastRunJobId: 'cutoff000001', lastRunStatus: 'running', nextRunAt: new Date('2031-01-01T00:00:00Z') } });
    await startRunner(db);
    assert.deepEqual([(await c.jobs.findOne({ _id: 'cutoff000001' })).status, (await c.jobs.findOne({ _id: 'cutoff000001' })).error], ['error', 'interrupted']);
    const recovery = await tick(db, { now: new Date('2026-11-20T00:00:00Z') });
    assert.equal(recovery.why, 'recovery');
    await whenIdle(db);
    assert.equal((await c.jobs.findOne({ _id: recovery.fired })).params.trigger, 'recovery');
    assert.deepEqual(await tick(db, { now: new Date('2026-11-20T00:01:00Z') }), { fired: null, why: 'not due' }, 'recovered once');
  } finally { release(); await whenIdle(db); await app.close(); unregisterHandler('sync'); }
});
