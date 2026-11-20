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
import { activity } from '../src/ranged.js';
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
    assert.deepEqual(Object.keys(a), ['range', 'tz', 'metric', 'totals', 'byMonth', 'byWeek', 'byWeekday', 'byHour', 'heatmap', 'byCampusMonth', 'cohorts', 'smallCohortBelow', 'busiest', 'byDate']);
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
    assert.deepEqual(a.byCampusMonth.map(({ campus, month, opened, merged }) => ({ campus, month, opened, merged })), [{ campus: 'ADYPU', month: '2026-11', opened: 1, merged: 0 }, { campus: 'RU', month: '2026-07', opened: 0, merged: 1 },
      { campus: 'RU', month: '2026-09', opened: 1, merged: 0 }, { campus: 'RU', month: '2027-06', opened: 1, merged: 1 }]);
    // addendum D: rates on the cohort (2 RU students, 1 ADYPU)
    assert.deepEqual(a.cohorts, [{ campus: 'ADYPU', students: 1, smallCohort: true }, { campus: 'RU', students: 2, smallCohort: true }]);
    assert.deepEqual(a.byCampusMonth[1], { campus: 'RU', month: '2026-07', opened: 0, merged: 1, students: 2, per100Opened: 0, per100Merged: 50, activeStudents: 1, activePct: 50 });
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
    // Term A overlaps the year it replaces: that is a correction of the current year, not a new year, so the replaced
    // one does not become a preset (see "academic year: a correction ..." in test/review2.test.js)
    const before = meta.academicYear.history.map((a) => a.label);
    assert.deepEqual([put.status, put.body.academicYear.current, put.body.academicYear.history.map((a) => a.label)], [200, custom, before]);
    assert.deepEqual((await get('/api/admin/academic-year')).academicYear.current, custom);
    app.clearCookie();
    const moved = await get('/api/overview');
    assert.deepEqual([moved.range.label, moved.range.from, moved.prs.total, moved.prs.merged], ['AY Term A', '2026-08-01', 2, 0], 'only #4 and #6 were opened in the new year, nothing merged');
    const meta2 = await get('/api/meta');
    assert.deepEqual(meta2.presets.slice(0, 2).map((p) => [p.key, p.label]), [['ay', 'AY Term A'], [`ay-${before[0]}`, `AY ${before[0]}`]]);
    assert.equal((await app.get(`/api/overview?range=ay-${cur.label}`)).status, 400, 'the replaced year is not a preset');
    assert.equal((await get(`/api/overview?range=ay-${before[0]}`)).range.to, '2026-06-30', 'the year before stays reachable as a preset');
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
    assert.deepEqual([s.paused, s.pausedUntil, s.pauseNote, s.nextRunAt.toISOString()], [false, null, '', '2026-11-23T21:00:00.000Z'],
      'the slot 2.5 hours after the catch-up is skipped: one run, not two back to back');
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
    await db.collection('settings').deleteOne({ _id: 'schedule' }); // the app may have created it with the real clock
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

// ------------------------------------------------------------------ addendum A: independent verification (DATES-BACKEND)

const IST = 5.5 * 3600e3;
/** ISO instant of a wall-clock time in India, e.g. ist('2026-08-10', '23:50'). */
const ist = (ymd, hm = '12:00') => new Date(`${ymd}T${hm}:00+05:30`).toISOString();
const sum = (list, key) => list.reduce((n, x) => n + x[key], 0);

test('ranges: rolling presets cut at IST midnight; opened vs merged decide every ranged number, list order and filter', async () => {
  const db = await freshDb();
  const now = new Date();
  const today = zoned(now).ymd;
  const day = (n) => new Date(new Date(`${today}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
  const [amy, bob, cat, dan] = await insertStudents(db, [
    { username: 'amy', name: 'Amy', campus: 'RU', batch: 2025 },
    { username: 'bob', name: 'Bob', campus: 'ADYPU', batch: 2026 },
    { username: 'cat', name: 'Cat', campus: 'SMRU', batch: 2024 },
    { username: 'dan', name: 'Dan', campus: 'RU', batch: null },
  ]);
  const pr = (repo, number, createdAt, mergedAt, extra = {}) => prNode({ repo, number, createdAt, mergedAt, state: mergedAt ? 'MERGED' : 'OPEN', ...extra });
  await upsertPRs(db, amy, [
    pr('apache/airflow', 1, ist(day(-89), '00:10'), null),                       // first minutes of the 90-day window
    pr('apache/airflow', 2, ist(day(-90), '23:50'), null),                       // ten minutes before it
    pr('apache/kafka', 3, ist(day(-200)), ist(day(-29), '00:05')),               // opened long ago, merged inside the 30-day window
    pr('apache/kafka', 4, ist(day(-200)), ist(day(-30), '23:55')),               // merged five minutes before it
  ]);
  await upsertPRs(db, bob, [
    pr('numpy/numpy', 5, ist(day(-10)), ist(day(-9))),
    pr('numpy/numpy', 6, ist(day(-8)), null, { state: 'CLOSED', closedAt: ist(day(-7)) }),
    pr('tiny/lib', 7, ist(day(-5)), ist(day(-5), '13:00'), { stars: 3 }),         // low signal
  ]);
  await upsertPRs(db, cat, [pr('numpy/numpy', 8, ist(day(-400)), ist(day(-399)))]); // outside every rolling window
  await upsertPRs(db, dan, [pr('apache/airflow', 9, ist(day(-3)), null)]);
  await refreshAggregates(db);
  await ensureAcademicYear(db);
  const app = await startApp(db);
  const get = async (p) => { const r = await app.get(p); assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.body)}`); return r.body; };
  try {
    // ---- presets: echo and boundaries
    const d90 = await get('/api/overview?range=90d');
    assert.deepEqual(d90.range, { from: day(-89), to: today, label: 'Last 90 days', preset: '90d' });
    assert.deepEqual([d90.prs.total, d90.prs.merged, d90.prs.osPrs, d90.prs.osMerged], [5, 4, 4, 3], 'opened: #1 #5 #6 #7 #9 (#2 is 20 minutes too early); merged: #3 #4 #5 #7');
    const d30 = await get('/api/overview?range=30d');
    assert.deepEqual([d30.range.from, d30.range.preset, d30.prs.total, d30.prs.merged, d30.prs.osMerged], [day(-29), '30d', 4, 3, 2], '#4 was merged at 23:55 the day before the window');
    assert.deepEqual(d30.prs.byState, { open: 1, merged: 2, closed: 1 }, 'states of the PRs opened in the range');
    assert.deepEqual(d30.students, { tracked: 4, withAnyPr: 3, withOsPr: 3, withOsMerged: 2, withMajorMerged: 2 }, 'amy counts through a merge of an older PR');
    const m12 = await get('/api/overview?range=12m');
    assert.deepEqual([m12.range.preset, m12.range.to, m12.prs.total, m12.prs.merged], ['12m', today, 8, 4]);
    assert.equal((await get(`/api/overview?from=${day(-89)}&to=${today}`)).range.preset, '90d', 'the same dates typed by hand are recognised as the preset');
    assert.deepEqual((await get('/api/overview?range=all')).range, { from: null, to: null, label: 'All time', preset: 'all' });
    assert.deepEqual((await get('/api/overview?range=ay')).range, (await get('/api/overview')).range, 'range=ay is the default');
    for (const bad of ['from=1969-12-31', 'to=2200-01-01', 'from=0050-01-01', 'from=2026-7-1', 'range=ALL']) {
      const r = await app.get(`/api/activity?${bad}`);
      assert.deepEqual([r.status, r.body.error.code], [400, 'bad_request'], bad);
    }
    // every endpoint echoes the resolved range
    for (const p of ['overview', 'campuses', 'activity', 'students', 'students/amy', 'prs', 'repos', 'repos/apache/airflow', 'orgs', 'orgs/apache']) {
      assert.deepEqual((await get(`/api/${p}?range=30d`)).range, d30.range, p);
      assert.equal((await get(`/api/${p}`)).range.preset, 'ay', `${p}: no parameters = current academic year`);
    }

    // ---- students: ranged numbers, order and hasOs
    const st = await get('/api/students?range=30d');
    assert.deepEqual(st.items.map((s) => [s.username, s.stats.osMerged, s.stats.osPrs, s.stats.totalPrs, s.stats.mergedPrs, s.stats.osRepos, s.stats.osOrgs]),
      [['bob', 1, 2, 3, 2, 1, 1], ['amy', 1, 0, 0, 1, 1, 1], ['dan', 0, 1, 1, 0, 1, 1], ['cat', 0, 0, 0, 0, 0, 0]]);
    assert.deepEqual([st.items[1].stats.firstPrAt, st.items[1].stats.lastPrAt, st.items[1].stats.lastOsMergedAt], [null, null, ist(day(-29), '00:05')], 'nothing opened in the range, one merge');
    assert.deepEqual((await get('/api/students?range=30d&hasOs=1')).items.map((s) => s.username), ['bob', 'amy', 'dan'], 'a merge in the range is open-source activity');
    assert.deepEqual((await get('/api/students?range=30d&sort=osPrs&order=asc')).items.map((s) => s.stats.osPrs), [0, 0, 1, 2]);
    assert.deepEqual((await get('/api/students?range=30d&sort=totalPrs')).items.map((s) => s.username), ['bob', 'dan', 'amy', 'cat']);
    assert.deepEqual((await get('/api/students?range=30d&sort=lastPrAt')).items.map((s) => s.username).slice(0, 2), ['dan', 'bob']);
    assert.deepEqual((await get('/api/students?range=30d&campus=RU&hasOs=1')).items.map((s) => s.username), ['amy', 'dan']);
    assert.deepEqual((await get('/api/students?range=30d&year=Unknown')).items.map((s) => s.username), ['dan']);
    // the year label is derived from the batch as of today, whatever the range; the batch travels with it
    for (const range of ['range=30d', 'range=all', 'from=2024-07-01&to=2025-06-30']) {
      const items = (await get(`/api/students?${range}&sort=name`)).items;
      assert.deepEqual(items.map((s) => [s.batch, s.year]), [amy, bob, cat, dan].map((s) => [s.batch, yearLabelOf(s.batch, now)]), range);
    }
    // all time: the precomputed stats, and the sort direction is honoured for every sort key
    for (const [key, values] of [['osPrs', [1, 1, 2, 4]], ['osMerged', [0, 1, 1, 2]], ['totalPrs', [1, 1, 3, 4]]]) {
      assert.deepEqual((await get(`/api/students?range=all&sort=${key}&order=asc`)).items.map((s) => s.stats[key]), values, `${key} asc`);
      assert.deepEqual((await get(`/api/students?range=all&sort=${key}`)).items.map((s) => s.stats[key]), [...values].reverse(), `${key} desc`);
    }

    // ---- repos / orgs: ranged numbers drive membership, order and filters
    const names = async (q) => (await get(`/api/repos?${q}`)).items.map((r) => [r.name, r.stats.prs, r.stats.merged]);
    assert.deepEqual(await names('range=30d&category=all'), [['numpy/numpy', 2, 1], ['apache/airflow', 1, 0], ['tiny/lib', 1, 1], ['apache/kafka', 0, 1]]);
    assert.deepEqual(await names('range=30d&category=all&sort=merged&order=asc'), [['apache/airflow', 1, 0], ['numpy/numpy', 2, 1], ['tiny/lib', 1, 1], ['apache/kafka', 0, 1]]);
    assert.deepEqual(await names('range=30d'), [['numpy/numpy', 2, 1], ['apache/airflow', 1, 0], ['apache/kafka', 0, 1]], 'open source by default');
    assert.deepEqual(await names('range=30d&owner=APACHE&sort=merged'), [['apache/kafka', 0, 1], ['apache/airflow', 1, 0]]);
    assert.deepEqual(await names('range=30d&q=kafka'), [['apache/kafka', 0, 1]]);
    assert.deepEqual((await get('/api/repos?range=all&category=all&sort=prs&order=asc')).items.map((r) => r.stats.prs), [1, 2, 3, 3], 'all time, ascending');
    assert.deepEqual((await get('/api/repos?range=all&category=all&sort=prs')).items.map((r) => r.stats.prs), [3, 3, 2, 1]);
    const orgs = async (q) => (await get(`/api/orgs?${q}`)).items.map((o) => [o.login, o.stats.osPrs, o.stats.osMerged, o.stats.prs, o.stats.repos, o.stats.students]);
    assert.deepEqual(await orgs('range=30d'), [['numpy', 2, 1, 2, 1, 1], ['apache', 1, 1, 1, 2, 2]], 'a tie on osMerged: the one with more PRs in the range first');
    assert.deepEqual(await orgs('range=30d&sort=osPrs'), [['numpy', 2, 1, 2, 1, 1], ['apache', 1, 1, 1, 2, 2]]);
    assert.deepEqual((await orgs('range=30d&category=all&sort=students&order=asc')).map((o) => o[0]), ['numpy', 'tiny', 'apache']);
    assert.deepEqual((await orgs('range=30d&category=low_signal')).map((o) => o[0]), ['tiny']);
    assert.deepEqual((await get('/api/orgs?range=all&category=all&sort=prs&order=asc')).items.map((o) => o.stats.prs), [1, 3, 5]);
    const kafka = await get('/api/repos/apache/kafka?range=30d');
    assert.deepEqual([kafka.repo.stats.prs, kafka.repo.stats.merged, kafka.owner.stats.osPrs, kafka.owner.stats.osMerged, kafka.prs.items.map((p) => p.number)], [0, 1, 1, 1, [3]]);
    assert.deepEqual(kafka.students.map((s) => [s.username, s.prs, s.merged, s.stats.osMerged]), [['amy', 0, 1, 1]], 'contributors carry their ranged stats');
    const apache = await get('/api/orgs/apache?range=30d');
    assert.deepEqual([apache.org.stats.repos, apache.repos.map((r) => [r.name, r.stats.prs, r.stats.merged]), apache.students.map((s) => s.username)],
      [2, [['apache/airflow', 1, 0], ['apache/kafka', 0, 1]], ['amy', 'dan']]);
    assert.deepEqual((await get('/api/orgs/apache?range=all')).org.stats.prs, 5);

    // ---- campuses + cohort filters of the overview
    const camp = await get('/api/campuses?range=30d');
    assert.deepEqual(camp.totals.map((t) => [t.campus, t.students, t.withAnyPr, t.withOsMerged, t.totalPrs, t.osPrs, t.osMerged]),
      [['ADYPU', 1, 1, 1, 3, 2, 1], ['RU', 2, 2, 1, 1, 1, 1], ['SMRU', 1, 0, 0, 0, 0, 0]]);
    assert.deepEqual([camp.total.totalPrs, camp.total.osMerged, sum(camp.rows, 'osMerged'), camp.rows.length], [d30.prs.total, d30.prs.osMerged, d30.prs.osMerged, 4]);
    const ru = await get('/api/overview?range=30d&campus=RU');
    assert.deepEqual([ru.students, ru.prs.total, ru.prs.merged, ru.topStudents.map((s) => s.username)], [{ tracked: 2, withAnyPr: 2, withOsPr: 2, withOsMerged: 1, withMajorMerged: 1 }, 1, 1, ['amy']]);

    // ---- PR lists and both CSV exports follow the same rule
    const numbers = async (q) => (await get(`/api/prs?category=all&${q}`)).items.map((p) => p.number).sort();
    assert.deepEqual(await numbers('range=30d'), [3, 5, 6, 7, 9]);
    assert.deepEqual(await numbers('range=30d&state=merged'), [3, 5, 7]);
    assert.deepEqual(await numbers('range=30d&state=closed'), [6]);
    assert.deepEqual((await get('/api/prs?category=all&range=30d&sort=mergedAt&order=asc')).items.map((p) => p.number), [3, 5, 7], 'sorting by merge date lists merged PRs only');
    const lines = async (p) => (await app.get(p, { raw: true })).text.trim().split('\n');
    const prCsv = await lines('/api/export/prs.csv?category=all&range=30d');
    assert.deepEqual(prCsv.slice(1).map((l) => Number(/\/pull\/(\d+)/.exec(l)[1])).sort(), [3, 5, 6, 7, 9]);
    assert.equal((await lines('/api/export/prs.csv?category=all&range=30d&state=merged')).length, 1 + 3);
    assert.equal((await lines('/api/export/prs.csv?category=all&range=all')).length, 1 + 9);
    assert.equal((await lines('/api/export/prs.csv?category=all')).length, 1 + (await get('/api/prs?category=all')).total, 'no parameters: the current academic year');
    const stCsv = await lines('/api/export/students.csv?range=30d&campus=ADYPU');
    assert.equal(stCsv.length, 2);
    assert.match(stCsv[1], /^bob,Bob,ADYPU,2026,[^,]+,3,2,2,1,0,1,1,1,0,0,0,0,1,/, 'total 3, merged 2, os 2, os merged 1, os open 0, major 1, 1 repo, 1 org, low signal 1');
    assert.match((await lines('/api/export/students.csv?range=all&campus=ADYPU'))[1], /^bob,Bob,ADYPU,2026,[^,]+,3,2,2,1,/);
    assert.equal((await app.get('/api/export/students.csv?from=nope')).status, 400);

    // ---- a deactivated student leaves every ranged number
    await app.login();
    assert.equal((await app.patch('/api/admin/students/bob', { active: false })).status, 200);
    await whenIdle(db);
    app.clearCookie();
    const after = await get('/api/overview?range=30d');
    assert.deepEqual([after.students.tracked, after.students.withAnyPr, after.prs.total, after.prs.merged], [3, 2, 1, 1]);
    assert.deepEqual((await get('/api/activity?range=30d&category=all')).totals, { opened: 1, merged: 1, activeStudents: 2 });
    assert.deepEqual((await get('/api/students?range=30d')).items.map((s) => s.username), ['amy', 'dan', 'cat']);
    assert.deepEqual(await names('range=30d&category=all'), [['apache/airflow', 1, 0], ['apache/kafka', 0, 1]]);
  } finally { await whenIdle(db); await app.close(); }
});

/** The year label a batch has today (independent of src/classify.js): the academic year starts on 1 July in India. */
function yearLabelOf(batch, now) {
  if (batch === null) return 'Unknown';
  const d = new Date(now.getTime() + IST);
  const y = (d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1) - batch + 1;
  return y < 1 ? 'Unknown' : y > 4 ? 'alumni' : ['1st year', '2nd year', '3rd year', '4th year'][y - 1];
}

test('activity: every bucket in IST, zero-filled axes, filters, metric, long and open ranges', async () => {
  const db = await freshDb();
  const [amy, bob] = await insertStudents(db, [
    { username: 'amy', name: 'Amy', campus: 'RU', batch: 2025 },
    { username: 'bob', name: 'Bob', campus: 'ADYPU', batch: 2026 },
  ]);
  const pr = (repo, number, createdAt, mergedAt, extra = {}) => prNode({ repo, number, createdAt, mergedAt, state: mergedAt ? 'MERGED' : 'OPEN', ...extra });
  await upsertPRs(db, amy, [
    pr('apache/airflow', 1, '2026-08-02T19:00:00Z', '2026-08-09T18:29:59Z'), // opened Mon 3 Aug 00:30 IST (Sunday in UTC); merged Sun 9 Aug 23:59:59 IST
    pr('apache/airflow', 2, '2026-08-09T18:30:00Z', '2026-08-31T18:45:00Z'), // opened Mon 10 Aug 00:00 IST sharp; merged Tue 1 Sep 00:15 IST (31 Aug in UTC)
    pr('apache/kafka', 3, '2026-08-12T04:00:00Z', null),                     // Wed 12 Aug 09:30 IST
    pr('nst-sdc/site', 4, '2026-08-12T04:10:00Z', '2026-08-12T05:00:00Z'),   // NST internal, same hour
    pr('apache/kafka', 5, '2019-03-05T06:00:00Z', '2019-03-06T06:00:00Z'),   // years earlier
  ]);
  await upsertPRs(db, bob, [
    pr('apache/airflow', 6, '2026-08-12T04:20:00Z', '2026-08-14T12:00:00Z'), // Wed 09:50 IST; merged Fri 14 Aug 17:30 IST
    pr('apache/airflow', 7, '2026-09-30T18:29:00Z', null),                   // Wed 30 Sep 23:59 IST
  ]);
  await refreshAggregates(db);
  await ensureAcademicYear(db);
  const app = await startApp(db);
  const get = async (p) => { const r = await app.get(p); assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.body)}`); return r.body; };
  const AUG = 'from=2026-08-01&to=2026-09-30';
  try {
    const a = await get(`/api/activity?${AUG}&category=all`);
    assert.deepEqual([a.tz, a.metric, a.range.label], ['Asia/Kolkata', 'opened', 'Custom range']);
    assert.deepEqual(a.totals, { opened: 6, merged: 4, activeStudents: 2 });
    assert.deepEqual(a.byMonth, [{ month: '2026-08', opened: 5, merged: 3, activeStudents: 2 }, { month: '2026-09', opened: 1, merged: 1, activeStudents: 2 }],
      'the merge at 00:15 IST on 1 September belongs to September');
    // every sub-series adds up to the totals, and the totals equal the overview of the same range
    const o = await get(`/api/overview?${AUG}`);
    assert.deepEqual([o.prs.total, o.prs.merged], [a.totals.opened, a.totals.merged]);
    assert.deepEqual([sum(o.monthly, 'allOpened'), o.monthly.map((m) => m.month)], [6, ['2026-08', '2026-09']]);
    for (const key of ['byMonth', 'byWeek', 'byDate', 'byWeekday', 'byHour', 'heatmap', 'byCampusMonth']) {
      assert.deepEqual([sum(a[key], 'opened'), sum(a[key], 'merged')], [6, 4], key);
    }
    // days: all 61 of them, in order, zero-filled
    assert.equal(a.byDate.length, 61);
    assert.deepEqual([a.byDate[0].date, a.byDate.at(-1).date], ['2026-08-01', '2026-09-30']);
    assert.ok(a.byDate.every((d, i) => i === 0 || new Date(`${d.date}T00:00:00Z`) - new Date(`${a.byDate[i - 1].date}T00:00:00Z`) === 86400e3), 'consecutive days');
    assert.deepEqual(a.byDate.filter((d) => d.opened || d.merged), [
      { date: '2026-08-03', opened: 1, merged: 0 }, { date: '2026-08-09', opened: 0, merged: 1 }, { date: '2026-08-10', opened: 1, merged: 0 },
      { date: '2026-08-12', opened: 3, merged: 1 }, { date: '2026-08-14', opened: 0, merged: 1 }, { date: '2026-09-01', opened: 0, merged: 1 }, { date: '2026-09-30', opened: 1, merged: 0 },
    ]);
    // weeks start on Monday: 23:59:59 on Sunday and 00:00:00 on Monday fall into different weeks
    assert.deepEqual([a.byWeek[0].weekStart, a.byWeek.at(-1).weekStart, a.byWeek.length], ['2026-07-27', '2026-09-28', 10], 'the first week holds 1 August, a Saturday');
    assert.deepEqual(a.byWeek.filter((w) => w.opened || w.merged), [
      { weekStart: '2026-08-03', opened: 1, merged: 1 }, { weekStart: '2026-08-10', opened: 4, merged: 2 },
      { weekStart: '2026-08-31', opened: 0, merged: 1 }, { weekStart: '2026-09-28', opened: 1, merged: 0 },
    ]);
    // weekdays: Monday = 1 … Sunday = 7
    assert.deepEqual(a.byWeekday, [
      { dow: 1, opened: 2, merged: 0 }, { dow: 2, opened: 0, merged: 1 }, { dow: 3, opened: 4, merged: 1 }, { dow: 4, opened: 0, merged: 0 },
      { dow: 5, opened: 0, merged: 1 }, { dow: 6, opened: 0, merged: 0 }, { dow: 7, opened: 0, merged: 1 },
    ]);
    assert.deepEqual(a.byHour.map((x) => x.hour), Array.from({ length: 24 }, (_, i) => i));
    assert.deepEqual(a.byHour.filter((x) => x.opened || x.merged), [
      { hour: 0, opened: 2, merged: 1 }, { hour: 9, opened: 3, merged: 0 }, { hour: 10, opened: 0, merged: 1 }, { hour: 17, opened: 0, merged: 1 }, { hour: 23, opened: 1, merged: 1 },
    ]);
    assert.deepEqual(a.heatmap.map((x) => [x.dow, x.hour]), Array.from({ length: 168 }, (_, i) => [Math.floor(i / 24) + 1, i % 24]), '7 x 24 cells, Monday first, hour 0 first');
    assert.deepEqual(a.heatmap.filter((x) => x.opened || x.merged), [
      { dow: 1, hour: 0, opened: 2, merged: 0 }, { dow: 2, hour: 0, opened: 0, merged: 1 }, { dow: 3, hour: 9, opened: 3, merged: 0 }, { dow: 3, hour: 10, opened: 0, merged: 1 },
      { dow: 3, hour: 23, opened: 1, merged: 0 }, { dow: 5, hour: 17, opened: 0, merged: 1 }, { dow: 7, hour: 23, opened: 0, merged: 1 },
    ]);
    assert.deepEqual(a.byCampusMonth.map(({ campus, month, opened, merged }) => ({ campus, month, opened, merged })), [
      { campus: 'ADYPU', month: '2026-08', opened: 1, merged: 1 }, { campus: 'ADYPU', month: '2026-09', opened: 1, merged: 0 },
      { campus: 'RU', month: '2026-08', opened: 4, merged: 2 }, { campus: 'RU', month: '2026-09', opened: 0, merged: 1 },
    ]);
    assert.deepEqual(a.busiest, { day: { date: '2026-08-12', count: 3 }, week: { weekStart: '2026-08-10', count: 4 }, month: { month: '2026-08', count: 5 } });
    const merged = await get(`/api/activity?${AUG}&category=all&metric=merged`);
    assert.deepEqual(merged.busiest, { day: { date: '2026-08-09', count: 1 }, week: { weekStart: '2026-08-10', count: 2 }, month: { month: '2026-08', count: 3 } }, 'ties go to the earliest');
    assert.deepEqual({ ...merged, metric: 0, busiest: 0 }, { ...a, metric: 0, busiest: 0 }, 'the metric only changes the busiest callouts');

    // filters
    const totals = async (q) => (await get(`/api/activity?${AUG}&${q}`)).totals;
    assert.deepEqual(await totals(''), { opened: 5, merged: 3, activeStudents: 2 }, 'open source unless asked otherwise');
    assert.deepEqual(await totals('category=nst_internal'), { opened: 1, merged: 1, activeStudents: 1 });
    assert.deepEqual(await totals('category=all&campus=ADYPU'), { opened: 2, merged: 1, activeStudents: 1 });
    assert.deepEqual(await totals('category=all&batch=2025'), { opened: 4, merged: 3, activeStudents: 1 });
    assert.deepEqual(await totals(`category=all&year=${encodeURIComponent(yearLabelOf(2026, new Date()))}`), { opened: 2, merged: 1, activeStudents: 1 });
    assert.deepEqual(await totals('category=all&campus=ADYPU&batch=2025'), { opened: 0, merged: 0, activeStudents: 0 });
    assert.deepEqual(await totals('category=all&author=Amy'), { opened: 4, merged: 3, activeStudents: 1 });
    assert.deepEqual(await totals('repo=Apache/Kafka'), { opened: 1, merged: 0, activeStudents: 1 });
    assert.deepEqual(await totals('category=all&owner=NST-SDC'), { opened: 1, merged: 1, activeStudents: 1 });
    assert.deepEqual(await totals('owner=apache&author=bob&campus=ADYPU&batch=2026'), { opened: 2, merged: 1, activeStudents: 1 });
    assert.deepEqual(await totals('author=nobody'), { opened: 0, merged: 0, activeStudents: 0 });
    const empty = await get(`/api/activity?${AUG}&author=nobody`);
    assert.deepEqual([empty.byDate.length, empty.byMonth.length, sum(empty.byDate, 'opened'), empty.busiest], [61, 2, 0, { day: null, week: null, month: null }], 'no events: the axes are still complete');
    for (const bad of ['category=fun', 'campus=Mars', 'year=5th%20year', 'batch=soon', 'metric=closed']) assert.equal((await app.get(`/api/activity?${bad}`)).status, 400, bad);

    // 800 days at most are listed day by day
    const d800 = await get('/api/activity?from=2024-07-23&to=2026-09-30&category=all');
    assert.deepEqual(['truncated' in d800, d800.byDate.length, sum(d800.byDate, 'opened')], [false, 800, 6]);
    const d801 = await get('/api/activity?from=2024-07-22&to=2026-09-30&category=all');
    assert.deepEqual([d801.truncated, 'byDate' in d801, d801.totals.opened, sum(d801.byMonth, 'opened'), d801.byMonth[0].month], [true, false, 6, 6, '2026-08'], 'longer: no day list, months from the first event');

    // a range that starts long before the data: the month and week axes begin at the first event, nothing is cut off
    const far = await get('/api/activity?from=1970-01-01&to=2026-12-31&category=all');
    assert.deepEqual([far.truncated, far.totals, far.byMonth[0], sum(far.byMonth, 'opened'), sum(far.byMonth, 'merged'), sum(far.byWeek, 'opened'), far.byWeek[0].weekStart],
      [true, { opened: 7, merged: 5, activeStudents: 2 }, { month: '2019-03', opened: 1, merged: 1, activeStudents: 1 }, 7, 5, 7, '2019-03-04']);
    const all = await get('/api/activity?range=all&category=all');
    assert.deepEqual([all.totals, all.byMonth[0].month, sum(all.byMonth, 'merged'), all.truncated], [far.totals, '2019-03', 5, true]);
    const farOverview = await get('/api/overview?from=1970-01-01&to=2026-12-31');
    assert.deepEqual([farOverview.prs.total, farOverview.monthly.length <= 120, sum(farOverview.monthly, 'allOpened'), farOverview.monthly.find((m) => m.month === '2026-08').osMerged],
      [7, true, 7, 2], 'the monthly series keeps the latest 120 months, where the data is');
    // open-ended ranges
    const since = await get('/api/activity?from=2026-09-01&category=all');
    assert.deepEqual([since.range, since.totals, since.byDate[0].date, since.byMonth[0].month], [{ from: '2026-09-01', to: null, label: 'Custom range', preset: null }, { opened: 1, merged: 1, activeStudents: 2 }, '2026-09-01', '2026-09']);
    const until = await get('/api/activity?to=2019-12-31&category=all');
    assert.deepEqual([until.totals, until.byDate[0], until.byDate.at(-1).date, until.byMonth.length], [{ opened: 1, merged: 1, activeStudents: 1 }, { date: '2019-03-05', opened: 1, merged: 0 }, '2019-12-31', 10]);
    // a single IST day
    assert.deepEqual((await get('/api/activity?from=2026-08-10&to=2026-08-10&category=all')).byDate, [{ date: '2026-08-10', opened: 1, merged: 0 }], '18:29:59 UTC the evening before is still 9 August');
    assert.deepEqual((await get('/api/activity?from=2026-08-09&to=2026-08-09&category=all')).byDate, [{ date: '2026-08-09', opened: 0, merged: 1 }]);
  } finally { await app.close(); }

  // the zero-filled axes of a range that ends in the future stop at today (unless something is dated later); another zone moves the buckets
  const range = resolveRange({ from: '2026-08-01', to: '2027-06-30' }, { current: defaultAcademicYear(new Date('2026-10-05T00:00:00Z')), history: [] }, new Date('2026-10-05T00:00:00Z'), 'Asia/Kolkata');
  const early = await activity(db, { match: {}, range, tz: 'Asia/Kolkata', now: new Date('2026-09-10T12:00:00Z') });
  assert.deepEqual([early.byDate.at(-1).date, early.byMonth.at(-1).month, early.byDate.length], ['2026-09-30', '2026-09', 61], 'a PR dated after "now" extends the axes to its day');
  const later = await activity(db, { match: {}, range, tz: 'Asia/Kolkata', now: new Date('2026-10-05T00:00:00Z') });
  assert.deepEqual([later.byDate.at(-1).date, later.byMonth.map((m) => m.month), later.byWeek.at(-1).weekStart], ['2026-10-05', ['2026-08', '2026-09', '2026-10'], '2026-10-05']);
  const utcRange = resolveRange({ from: '2026-08-01', to: '2026-09-30' }, { current: defaultAcademicYear(), history: [] }, new Date(), 'UTC');
  const utc = await activity(db, { match: {}, range: utcRange, tz: 'UTC', now: new Date('2026-12-01T00:00:00Z') });
  assert.deepEqual([utc.totals.opened, utc.byWeekday.find((d) => d.dow === 7).opened, utc.byHour.find((x) => x.hour === 19).opened, utc.byMonth[0].merged],
    [6, 2, 1, 4], 'in UTC PRs #1 and #2 were opened on Sundays (#1 at 19:00) and PR #2 was merged in August');
});

test('ranged responses are cached for identical queries and dropped on an admin write', async () => {
  const db = await freshDb();
  const today = zoned(new Date()).ymd;
  const [ann] = await insertStudents(db, [{ username: 'ann', campus: 'RU', batch: 2025 }]);
  await upsertPRs(db, ann, [prNode({ repo: 'apache/airflow', number: 1, createdAt: ist(today, '00:01'), mergedAt: ist(today, '00:02') })]);
  await refreshAggregates(db);
  await ensureAcademicYear(db);
  registerHandler('backfill', async () => ({}));
  const app = await startApp(db, { publicCacheMs: 60000 });
  const read = async (p) => { const r = await app.get(p); return [r.headers.get('x-cache'), r.body.prs?.osMerged ?? r.body.totals?.merged ?? r.body.items?.[0]?.stats.osMerged]; };
  try {
    for (const p of ['/api/overview', '/api/activity', '/api/students', '/api/overview?range=30d']) {
      assert.deepEqual(await read(p), ['miss', 1], p);
      assert.deepEqual(await read(p), ['hit', 1], p);
    }
    assert.deepEqual(await read(`/api/overview?from=${today}&to=${today}`), ['miss', 1], 'another range is another entry');
    await collections(db).prs.updateOne({ number: 1 }, { $set: { category: 'low_signal', tier: null } });
    assert.deepEqual(await read('/api/overview'), ['hit', 1], 'changed behind the back of the cache');
    assert.deepEqual(await read('/api/campuses'), ['miss', undefined]);
    assert.equal((await app.get('/api/campuses')).body.total.osMerged, 1, 'a new query still reuses the per-student numbers aggregated for the range');
    await app.login();
    assert.equal((await app.post('/api/admin/students', { username: 'newbie', campus: 'RU', batch: 2026 })).status, 201);
    await whenIdle(db); // the backfill this queues (and anything it triggers) clears the cache again when it ends
    app.clearCookie();
    for (const p of ['/api/overview', '/api/activity', '/api/students', '/api/overview?range=30d']) assert.deepEqual(await read(p), ['miss', 0], `${p} after an admin write`);
    assert.equal((await app.get('/api/campuses')).body.total.osMerged, 0);
    // moving the academic year is an admin write too: the default range of a cached query follows at once
    assert.equal((await app.get('/api/overview')).headers.get('x-cache'), 'hit');
    await app.login();
    assert.equal((await app.put('/api/admin/academic-year', { label: 'Term B', start: '2026-07-15', end: '2027-07-14' })).status, 200);
    app.clearCookie();
    const moved = await app.get('/api/overview');
    assert.deepEqual([moved.headers.get('x-cache'), moved.body.range.label, moved.body.range.from], ['miss', 'AY Term B', '2026-07-15']);
  } finally { await whenIdle(db); await app.close(); unregisterHandler('backfill'); }
});
