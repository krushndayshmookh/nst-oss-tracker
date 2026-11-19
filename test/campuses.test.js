// SPEC addenda D (per-100-students rates, cohorts) and F (GET /api/campuses, GET /api/campuses/:campus) against a real mongod.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo } from './helpers/mongo.js';
import { startApp } from './helpers/app.js';
import { insertStudents, prNode } from './helpers/fixtures.js';
import { collections, ensureIndexes } from '../src/db.js';
import { refreshAggregates, upsertPRs } from '../src/ingest.js';
import { invalidateContext, yearLabel } from '../src/classify.js';
import { addDays, ensureAcademicYear, resolveRange, zoned } from '../src/dates.js';
import { activity } from '../src/ranged.js';
import { SMALL_COHORT, byCampusOrder, campusNamed, distributionOf, isSmall, previousRange, rate } from '../src/campuses.js';

let mongo;
let db;
let app;
const today = zoned(new Date()).ymd;
const day = (n) => addDays(today, n);
const ist = (ymd, hm = '12:00') => new Date(`${ymd}T${hm}:00+05:30`).toISOString();
// the range under test is the last 10 days; the equal-length period before it is days -19 … -10
const RANGE = `from=${day(-9)}&to=${today}`;
const IN = day(-1); // every event of the range happens on one day, so in one month
const BEFORE = day(-12);
const COUNTS = ['students', 'withAnyPr', 'withOsPr', 'withOsMerged', 'withMajorMerged', 'totalPrs', 'osPrs', 'osMerged', 'osMajorMerged'];
const sum = (list, f) => list.reduce((n, x) => n + f(x), 0);
const get = async (p) => { const r = await app.get(p); assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.body)}`); return r.body; };

let seq = 0;
const AIRFLOW = { repo: 'apache/airflow', stars: 5000 }; // major
const BLOCKS = { repo: 'sugar/blocks', stars: 300 }; // established
const SMALL = { repo: 'small/org', stars: 60 }; // emerging
const TINY = { repo: 'tiny/lib', stars: 3 }; // low signal: not open source
/** `n` PRs in `repo` opened at `opened` and merged at `merged` (still open when `merged` is null). */
const prs = (n, repo, opened, merged) => Array.from({ length: n }, () => prNode({ ...repo, number: ++seq, state: merged ? 'MERGED' : 'OPEN',
  createdAt: ist(opened, '10:00'), mergedAt: merged ? ist(merged, '11:00') : null }));

before(async () => {
  mongo = await startMongo();
  db = mongo.db;
  await ensureIndexes(db);
  invalidateContext();
  const [r1, r2, , r4, a1, a2, s1, u1] = await insertStudents(db, [
    { username: 'r1', name: 'R One', campus: 'RU', batch: 2025 },
    { username: 'r2', name: 'R Two', campus: 'RU', batch: 2025 },
    { username: 'r3', name: 'R Idle', campus: 'RU', batch: 2025 },
    { username: 'r4', name: 'R Four', campus: 'RU', batch: 2026 },
    { username: 'a1', name: 'A One', campus: 'ADYPU', batch: 2025 },
    { username: 'a2', name: 'A Two', campus: 'ADYPU', batch: 2025 },
    { username: 's1', name: 'S One', campus: 'SVYASA', batch: 2026 },
    { username: 'u1', name: 'U One', campus: 'Unknown', batch: null },
    { username: 'gone', name: 'Inactive', campus: 'SMRU', batch: 2025, active: false },
  ]);
  await upsertPRs(db, r1, [...prs(12, AIRFLOW, IN, IN), ...prs(1, SMALL, IN, null), ...prs(3, AIRFLOW, BEFORE, BEFORE)]);
  await upsertPRs(db, r2, [...prs(1, BLOCKS, IN, IN), ...prs(1, AIRFLOW, BEFORE, IN)]); // the second one: opened before the range, merged inside it
  await upsertPRs(db, r4, [...prs(1, SMALL, IN, IN), ...prs(1, TINY, IN, null)]);
  await upsertPRs(db, a1, [...prs(5, BLOCKS, IN, IN), ...prs(10, BLOCKS, BEFORE, BEFORE)]);
  await upsertPRs(db, a2, prs(1, AIRFLOW, IN, null));
  await upsertPRs(db, s1, prs(1, AIRFLOW, IN, IN));
  await upsertPRs(db, u1, prs(1, AIRFLOW, IN, IN));
  await refreshAggregates(db);
  await ensureAcademicYear(db);
  app = await startApp(db);
});
after(async () => { await app?.close(); await mongo?.stop(); });

test('rates: count / students x 100 with one decimal; an empty cohort has no rate', () => {
  assert.deepEqual([rate(187, 1504), rate(1, 3), rate(2, 3), rate(69, 240), rate(0, 49), rate(7, 7), rate(15, 4)], [12.4, 33.3, 66.7, 28.8, 0, 100, 375]);
  assert.deepEqual([rate(5, 0), rate(0, 0), rate(undefined, 0), rate(3, undefined)], [null, null, null, null], 'null, never 0, Infinity or NaN');
  assert.equal(rate(undefined, 10), 0);
  assert.deepEqual([isSmall(0), isSmall(1), isSmall(SMALL_COHORT - 1), isSmall(SMALL_COHORT)], [false, true, true, false]);
  assert.deepEqual(['SMRU', 'Unknown', 'RU', 'SVYASA', 'ADYPU'].sort(byCampusOrder), ['ADYPU', 'RU', 'SVYASA', 'SMRU', 'Unknown']);
  assert.deepEqual([campusNamed('ru'), campusNamed(' Svyasa '), campusNamed('unknown'), campusNamed('nope'), campusNamed('')], ['RU', 'SVYASA', 'Unknown', null, null]);
});

test('distribution: buckets sum to contributors, median, share of the top 10 %', () => {
  assert.deepEqual(distributionOf([]), { contributors: 0, buckets: { 1: 0, '2-4': 0, '5-9': 0, '10+': 0 }, median: null, max: 0,
    top10PctStudents: 0, top10PctMerged: 0, top10PctShare: null });
  assert.deepEqual(distributionOf([1, 12, 2]), { contributors: 3, buckets: { 1: 1, '2-4': 1, '5-9': 0, '10+': 1 }, median: 2, max: 12,
    top10PctStudents: 1, top10PctMerged: 12, top10PctShare: 80 });
  // 21 contributors: the top 10 % are ceil(2.1) = 3 students
  const many = distributionOf([30, 20, 10, 9, 5, 4, 4, 2, ...Array(13).fill(1)]);
  assert.deepEqual([many.contributors, many.buckets, many.median, many.top10PctStudents, many.top10PctMerged, many.top10PctShare],
    [21, { 1: 13, '2-4': 3, '5-9': 2, '10+': 3 }, 1, 3, 60, 61.9]);
  assert.equal(distributionOf([1, 2, 4, 9]).median, 3, 'an even number of contributors: the mean of the two in the middle');
});

test('previous period: the same number of days right before the range, cut at today when the range ends later', () => {
  const now = new Date('2026-11-19T12:00:00Z');
  const tz = 'Asia/Kolkata';
  const ay = { current: { label: '2026-27', start: '2026-07-01', end: '2027-06-30' }, history: [] };
  const prev = (q) => { const p = previousRange(resolveRange(q, ay, now, tz), now, tz); return p && [p.from, p.to, p.days]; };
  assert.deepEqual(prev({}), ['2026-02-09', '2026-06-30', 142], 'AY 2026-27 on 19 Nov = 1 Jul – 19 Nov = 142 days');
  assert.deepEqual(prev({ range: '30d' }), ['2026-09-21', '2026-10-20', 30]);
  assert.deepEqual(prev({ from: '2025-07-01', to: '2026-06-30' }), ['2024-07-01', '2025-06-30', 365]);
  assert.deepEqual(prev({ from: '2026-11-19' }), ['2026-11-18', '2026-11-18', 1], 'open end = until today');
  assert.deepEqual([prev({ range: 'all' }), prev({ to: '2026-08-01' }), prev({ from: '2026-12-01', to: '2026-12-31' })], [null, null, null],
    'all time, no start, or not begun yet: nothing to compare with');
  const p = previousRange(resolveRange({ range: '30d' }, ay, now, tz), now, tz);
  assert.deepEqual([p.start.toISOString(), p.end.toISOString()], ['2026-09-20T18:30:00.000Z', '2026-10-20T18:30:00.000Z'], 'IST day bounds; ends where the range begins');
});

test('GET /api/campuses: rows, subtotals, rates, tier and category mix, funnel, distribution, top orgs / repos', async () => {
  const body = await get(`/api/campuses?${RANGE}`);
  assert.deepEqual(Object.keys(body), ['range', 'previousRange', 'smallCohortBelow', 'campuses', 'rows', 'totals', 'total', 'sharedOrgs']);
  assert.deepEqual([body.range.from, body.range.to, body.smallCohortBelow], [day(-9), today, 30]);
  // scorecard list: the four campuses always (SMRU has no active student), Unknown last because it has one
  assert.deepEqual(body.campuses, [{ campus: 'ADYPU', students: 2, smallCohort: true }, { campus: 'RU', students: 4, smallCohort: true },
    { campus: 'SVYASA', students: 1, smallCohort: true }, { campus: 'SMRU', students: 0, smallCohort: false }, { campus: 'Unknown', students: 1, smallCohort: true }]);
  assert.deepEqual(body.totals.map((t) => t.campus), ['ADYPU', 'RU', 'SVYASA', 'Unknown'], 'only campuses with students; Unknown last');
  assert.deepEqual(body.rows.map((r) => [r.campus, r.year, r.batch, r.students]),
    [['ADYPU', yearLabel(2025), 2025, 2], ['RU', yearLabel(2026), 2026, 1], ['RU', yearLabel(2025), 2025, 3], ['SVYASA', yearLabel(2026), 2026, 1], ['Unknown', 'Unknown', null, 1]]);

  const ru = body.totals.find((t) => t.campus === 'RU');
  assert.deepEqual(Object.keys(ru), ['campus', 'year', 'batch', ...COUNTS, 'byCategory', 'smallCohort',
    'withAnyPrPct', 'withOsPrPct', 'withOsMergedPct', 'withMajorMergedPct', 'totalPrsPer100', 'osPrsPer100', 'osMergedPer100', 'osMajorMergedPer100',
    'tierMix', 'funnel', 'distribution', 'previous', 'delta', 'topOrgs', 'topRepos']);
  assert.deepEqual(COUNTS.map((k) => ru[k]), [4, 3, 3, 3, 2, 16, 15, 15, 13],
    'r1: 13 opened, 12 merged; r2: 1 opened, 2 merged (one opened before the range); r4: 2 opened (one not open source), 1 merged; r3 idle');
  assert.deepEqual([ru.withAnyPrPct, ru.withOsPrPct, ru.withOsMergedPct, ru.withMajorMergedPct, ru.totalPrsPer100, ru.osPrsPer100, ru.osMergedPer100, ru.osMajorMergedPer100],
    [75, 75, 75, 50, 400, 375, 375, 325]);
  assert.deepEqual(ru.byCategory, { open_source: 15, practice: 0, nst_internal: 0, peer_repo: 0, own_repo: 0, low_signal: 1 });
  assert.deepEqual(ru.tierMix, { opened: { major: 12, established: 1, emerging: 2 }, merged: { major: 13, established: 1, emerging: 1 } });
  assert.deepEqual(ru.funnel, [
    { key: 'tracked', label: 'Tracked students', count: 4, pct: 100 }, { key: 'anyPr', label: 'Any PR', count: 3, pct: 75 },
    { key: 'osPr', label: 'Open-source PR', count: 3, pct: 75 }, { key: 'osMerged', label: 'Merged open-source PR', count: 3, pct: 75 },
    { key: 'majorMerged', label: 'Merged in a major project', count: 2, pct: 50 }]);
  assert.deepEqual(ru.distribution, { contributors: 3, buckets: { 1: 1, '2-4': 1, '5-9': 0, '10+': 1 }, median: 2, max: 12,
    top10PctStudents: 1, top10PctMerged: 12, top10PctShare: 80 });
  assert.deepEqual(ru.topOrgs, [{ login: 'apache', osPrs: 12, osMerged: 13, students: 2 }, { login: 'small', osPrs: 2, osMerged: 1, students: 2 },
    { login: 'sugar', osPrs: 1, osMerged: 1, students: 1 }]);
  assert.deepEqual(ru.topRepos, [{ name: 'apache/airflow', stars: 5000, tier: 'major', osPrs: 12, osMerged: 13, students: 2 },
    { name: 'small/org', stars: 60, tier: 'emerging', osPrs: 2, osMerged: 1, students: 2 }, { name: 'sugar/blocks', stars: 300, tier: 'established', osPrs: 1, osMerged: 1, students: 1 }]);

  // year-wise rows of a campus use their own cohort
  const first = body.rows.find((r) => r.campus === 'RU' && r.batch === 2026);
  assert.deepEqual([first.students, first.osMerged, first.osMergedPer100, first.withOsMergedPct, first.totalPrsPer100, first.distribution.buckets], [1, 1, 100, 100, 200, { 1: 1, '2-4': 0, '5-9': 0, '10+': 0 }]);
  const second = body.rows.find((r) => r.campus === 'RU' && r.batch === 2025);
  assert.deepEqual([second.students, second.osMerged, second.osMergedPer100, second.withOsMergedPct, second.withAnyPrPct], [3, 14, 466.7, 66.7, 66.7]);

  // subtotals = sums of rows; total = sum of the campus totals; every block is consistent in itself
  for (const t of body.totals) {
    const rows = body.rows.filter((r) => r.campus === t.campus);
    for (const k of COUNTS) assert.equal(t[k], sum(rows, (r) => r[k]), `${t.campus} ${k}`);
    for (const k of Object.keys(t.byCategory)) assert.equal(t.byCategory[k], sum(rows, (r) => r.byCategory[k]), `${t.campus} ${k}`);
    for (const k of ['major', 'established', 'emerging']) assert.equal(t.tierMix.merged[k], sum(rows, (r) => r.tierMix.merged[k]), `${t.campus} ${k}`);
  }
  for (const k of COUNTS) assert.equal(body.total[k], sum(body.totals, (t) => t[k]), `total ${k}`);
  for (const b of [...body.rows, ...body.totals, body.total]) {
    const where = `${b.campus} ${b.year}`;
    assert.equal(sum(Object.values(b.distribution.buckets), (n) => n), b.distribution.contributors, where);
    assert.equal(b.distribution.contributors, b.withOsMerged, where);
    assert.equal(sum(Object.values(b.tierMix.merged), (n) => n), b.osMerged, where);
    assert.equal(sum(Object.values(b.tierMix.opened), (n) => n), b.osPrs, where);
    assert.equal(sum(Object.values(b.byCategory), (n) => n), b.totalPrs, where);
    assert.equal(b.osMergedPer100, Math.round((b.osMerged * 1000) / b.students) / 10, where);
    assert.equal(b.withOsMergedPct, Math.round((b.withOsMerged * 1000) / b.students) / 10, where);
  }
  assert.deepEqual(COUNTS.map((k) => body.total[k]), [8, 7, 7, 6, 4, 24, 23, 22, 15]);
  assert.deepEqual(body.total.topOrgs.map((o) => [o.login, o.osPrs, o.osMerged, o.students]), [['apache', 15, 15, 5], ['sugar', 6, 6, 2], ['small', 2, 1, 2]]);

  // orgs shared by two or more campuses: the Unknown campus does not count, an org of one campus is not listed
  assert.deepEqual(body.sharedOrgs, [
    { login: 'apache', campuses: 3, osPrs: 14, osMerged: 14, students: 4, byCampus: [{ campus: 'ADYPU', osPrs: 1, osMerged: 0, students: 1 },
      { campus: 'RU', osPrs: 12, osMerged: 13, students: 2 }, { campus: 'SVYASA', osPrs: 1, osMerged: 1, students: 1 }] },
    { login: 'sugar', campuses: 2, osPrs: 6, osMerged: 6, students: 2, byCampus: [{ campus: 'ADYPU', osPrs: 5, osMerged: 5, students: 1 }, { campus: 'RU', osPrs: 1, osMerged: 1, students: 1 }] },
  ]);
});

test('GET /api/campuses: campus totals equal the overview for the same range (custom range, default AY, 90 days, all time)', async () => {
  for (const q of [RANGE, '', 'range=90d', 'range=all']) {
    const body = await get(`/api/campuses?${q}`);
    const o = await get(`/api/overview?${q}`);
    const of = (b, ov) => assert.deepEqual(
      [b.students, b.withAnyPr, b.withOsPr, b.withOsMerged, b.withMajorMerged, b.totalPrs, b.osPrs, b.osMerged, b.osMajorMerged, b.byCategory, b.tierMix.merged],
      [ov.students.tracked, ov.students.withAnyPr, ov.students.withOsPr, ov.students.withOsMerged, ov.students.withMajorMerged,
        ov.prs.total, ov.prs.osPrs, ov.prs.osMerged, ov.prs.osMergedByTier.major, ov.prs.byCategory, ov.prs.osMergedByTier], `${q} ${b.campus}`);
    of(body.total, o);
    assert.deepEqual(body.total.topOrgs.map((x) => [x.login, x.osMerged, x.students]), o.topOrgs.slice(0, 5).map((x) => [x.login, x.osMerged, x.students]), q);
    for (const t of body.totals) of(t, await get(`/api/overview?${q}&campus=${t.campus}`));
    for (const k of COUNTS) assert.equal(body.total[k], sum(body.totals, (t) => t[k]), `${q} ${k}`);
  }
  // all time counts everything, the earlier period included
  const all = await get('/api/campuses?range=all');
  assert.deepEqual([all.total.osMerged, all.total.osPrs, all.total.totalPrs, all.range.preset], [22 + 13, 23 + 14, 24 + 14, 'all']);
  assert.deepEqual([all.previousRange, all.total.previous, all.total.delta, all.totals[0].previous, all.totals[0].delta], [null, null, null, null, null], 'nothing to compare all time with');
});

test('GET /api/campuses: previous-period numbers and deltas', async () => {
  const body = await get(`/api/campuses?${RANGE}`);
  assert.deepEqual(body.previousRange, { from: day(-19), to: day(-10), days: 10 });
  const ru = body.totals.find((t) => t.campus === 'RU');
  assert.deepEqual(ru.previous, { students: 4, withAnyPr: 2, withOsPr: 2, withOsMerged: 1, withMajorMerged: 1, totalPrs: 4, osPrs: 4, osMerged: 3, osMajorMerged: 3,
    withOsMergedPct: 25, osPrsPer100: 100, osMergedPer100: 75, osMajorMergedPer100: 75 }, 'r1: 3 opened and merged; r2: one opened');
  assert.deepEqual(ru.delta, { osMerged: 12, osMergedPct: 400, osPrs: 11, osMajorMerged: 10, withOsMerged: 2, withOsMergedPct: 50, osMergedPer100: 300 });
  const adypu = body.totals.find((t) => t.campus === 'ADYPU');
  assert.deepEqual([adypu.osMerged, adypu.previous.osMerged, adypu.delta.osMerged, adypu.delta.osMergedPct, adypu.delta.osMergedPer100, adypu.delta.withOsMergedPct],
    [5, 10, -5, -50, -250, 0], 'fewer merges than in the period before');
  const svyasa = body.totals.find((t) => t.campus === 'SVYASA');
  assert.deepEqual([svyasa.previous.osMerged, svyasa.delta.osMerged, svyasa.delta.osMergedPct], [0, 1, null], 'no relative change from zero');
  assert.deepEqual([body.total.previous.osMerged, body.total.delta.osMerged, body.total.previous.students], [13, 9, 8]);
  // the previous block is what the overview says for that period
  const before = await get(`/api/overview?from=${day(-19)}&to=${day(-10)}&campus=RU`);
  assert.deepEqual([ru.previous.withAnyPr, ru.previous.withOsMerged, ru.previous.totalPrs, ru.previous.osPrs, ru.previous.osMerged],
    [before.students.withAnyPr, before.students.withOsMerged, before.prs.total, before.prs.osPrs, before.prs.osMerged]);
});

test('GET /api/campuses/:campus: profile blocks, top students, 404 for an unknown campus, empty campus without NaN', async () => {
  const list = await get(`/api/campuses?${RANGE}`);
  const body = await get(`/api/campuses/ru?${RANGE}`);
  assert.deepEqual(Object.keys(body), ['range', 'previousRange', 'smallCohortBelow', 'campus', 'totals', 'overall', 'years', 'monthly', 'topStudents', 'topRepos', 'topOrgs', 'sharedOrgs']);
  assert.equal(body.campus, 'RU', 'canonical spelling');
  const { topOrgs, topRepos, ...totals } = list.totals.find((t) => t.campus === 'RU');
  assert.deepEqual(body.totals, totals);
  assert.deepEqual([body.topOrgs, body.topRepos], [topOrgs, topRepos]);
  assert.deepEqual(body.years, list.rows.filter((r) => r.campus === 'RU'));
  assert.deepEqual([body.overall.campus, body.overall.students, body.overall.osMergedPer100, 'funnel' in body.overall, 'topOrgs' in body.overall], ['All', 8, 275, false, false]);
  assert.deepEqual(body.topStudents.map((s) => [s.username, s.name, s.campus, s.stats.osMerged, s.stats.osPrs]),
    [['r1', 'R One', 'RU', 12, 13], ['r2', 'R Two', 'RU', 2, 1], ['r4', 'R Four', 'RU', 1, 1]], 'ranged stats, students with a merged open-source PR only');
  assert.deepEqual(Object.keys(body.topStudents[0]), ['username', 'name', 'campus', 'batch', 'year', 'stats'], 'the public student shape');
  assert.deepEqual(body.sharedOrgs.map((o) => o.login), ['apache', 'sugar']);
  assert.deepEqual((await get(`/api/campuses/SVYASA?${RANGE}`)).sharedOrgs.map((o) => o.login), ['apache']);
  const month = body.monthly.find((m) => m.month === IN.slice(0, 7));
  assert.deepEqual([month.osMerged, month.osMergedPer100, month.allOpened], [15, 375, 16]);
  assert.equal(sum(body.monthly, (m) => m.osMerged), 15);

  // all time: the precomputed stats
  const all = await get('/api/campuses/RU?range=all');
  assert.deepEqual([all.totals.osMerged, all.totals.previous, all.topStudents.map((s) => [s.username, s.stats.osMerged])], [18, null, [['r1', 15], ['r2', 2], ['r4', 1]]]);

  // a campus of the list without (active) students: zeros and null rates
  const smru = await get(`/api/campuses/SMRU?${RANGE}`);
  assert.deepEqual([smru.campus, smru.totals.students, smru.totals.smallCohort, smru.years, smru.topStudents, smru.topOrgs, smru.topRepos, smru.sharedOrgs], ['SMRU', 0, false, [], [], [], [], []]);
  assert.deepEqual([smru.totals.withAnyPrPct, smru.totals.withOsMergedPct, smru.totals.osMergedPer100, smru.totals.osPrsPer100, smru.totals.osMajorMergedPer100], [null, null, null, null, null]);
  assert.deepEqual(smru.totals.funnel.map((f) => [f.count, f.pct]), Array(5).fill([0, null]));
  assert.deepEqual([smru.totals.previous.osMergedPer100, smru.totals.delta.osMergedPer100, smru.totals.delta.withOsMergedPct, smru.totals.delta.osMerged, smru.totals.distribution.median],
    [null, null, null, 0, null]);
  assert.ok(smru.monthly.length >= 1 && smru.monthly.every((m) => m.osMergedPer100 === null && m.osMerged === 0));
  assert.ok(!/NaN|Infinity/.test(JSON.stringify(smru)));

  const missing = await app.get('/api/campuses/nowhere');
  assert.deepEqual([missing.status, missing.body.error.code], [404, 'not_found']);
  assert.equal((await app.get('/api/campuses/RU?from=2026-13-01')).status, 400);
  // nothing private leaks through the new endpoints
  assert.ok(!/private note|test sheet|enrolmentNo|email/.test(JSON.stringify([list, body])));
});

test('GET /api/activity: cohorts and per-100 rates per campus and month; filters change the denominator', async () => {
  const month = IN.slice(0, 7);
  const a = await get(`/api/activity?${RANGE}&category=all`);
  assert.deepEqual(a.cohorts, [{ campus: 'ADYPU', students: 2, smallCohort: true }, { campus: 'RU', students: 4, smallCohort: true },
    { campus: 'SVYASA', students: 1, smallCohort: true }, { campus: 'Unknown', students: 1, smallCohort: true }]);
  assert.equal(a.smallCohortBelow, 30);
  assert.deepEqual(a.byCampusMonth.map((r) => r.campus), ['ADYPU', 'RU', 'SVYASA', 'Unknown'], 'campus order, Unknown last');
  assert.deepEqual(a.byCampusMonth.find((r) => r.campus === 'RU'),
    { campus: 'RU', month, opened: 16, merged: 15, students: 4, per100Opened: 400, per100Merged: 375, activeStudents: 3, activePct: 75 });
  assert.deepEqual(a.byCampusMonth.find((r) => r.campus === 'ADYPU'),
    { campus: 'ADYPU', month, opened: 6, merged: 5, students: 2, per100Opened: 300, per100Merged: 250, activeStudents: 2, activePct: 100 });
  for (const r of a.byCampusMonth) {
    assert.deepEqual([r.per100Opened, r.per100Merged, r.activePct], [r.opened, r.merged, r.activeStudents].map((n) => Math.round((n * 1000) / r.students) / 10), r.campus);
  }
  assert.equal(a.byMonth.find((m) => m.month === month).activeStudents, sum(a.byCampusMonth, (r) => r.activeStudents), 'campus values add up to the month');

  // default category (open source): r4's low-signal PR is gone, the cohort stays
  const os = (await get(`/api/activity?${RANGE}`)).byCampusMonth.find((r) => r.campus === 'RU');
  assert.deepEqual([os.opened, os.students, os.per100Opened, os.activeStudents], [15, 4, 375, 3]);

  // year filter: the cohort is the first-year students of each campus
  const firstYear = await get(`/api/activity?${RANGE}&category=all&batch=2026`);
  assert.deepEqual(firstYear.cohorts.map((x) => [x.campus, x.students]), [['RU', 1], ['SVYASA', 1]]);
  assert.deepEqual(firstYear.byCampusMonth.find((r) => r.campus === 'RU'),
    { campus: 'RU', month, opened: 2, merged: 1, students: 1, per100Opened: 200, per100Merged: 100, activeStudents: 1, activePct: 100 });
  const byYear = await get(`/api/activity?${RANGE}&category=all&year=${encodeURIComponent(yearLabel(2025))}`);
  assert.deepEqual(byYear.cohorts.map((x) => [x.campus, x.students]), [['ADYPU', 2], ['RU', 3]]);
  assert.deepEqual([byYear.byCampusMonth.find((r) => r.campus === 'RU').per100Opened, byYear.byCampusMonth.find((r) => r.campus === 'RU').activePct], [466.7, 66.7]);
  // campus filter: one cohort; an author filter keeps the campus cohort as denominator
  const one = await get(`/api/activity?${RANGE}&category=all&campus=ADYPU`);
  assert.deepEqual([one.cohorts, one.byCampusMonth.length], [[{ campus: 'ADYPU', students: 2, smallCohort: true }], 1]);
  const author = await get(`/api/activity?${RANGE}&category=all&author=r1`);
  assert.deepEqual(author.byCampusMonth, [{ campus: 'RU', month, opened: 13, merged: 12, students: 4, per100Opened: 325, per100Merged: 300, activeStudents: 1, activePct: 25 }]);

  // a campus whose cohort is empty (a student deactivated or moved while its PRs are still being rewritten): null, not Infinity
  const range = resolveRange({ from: day(-9), to: today }, { current: { label: 'x', start: day(-9), end: today }, history: [] });
  const direct = await activity(db, { match: {}, range, cohorts: new Map([['RU', 4], ['ADYPU', 0]]) });
  const empty = direct.byCampusMonth.find((r) => r.campus === 'ADYPU');
  assert.deepEqual([empty.opened, empty.students, empty.per100Opened, empty.per100Merged, empty.activeStudents, empty.activePct], [6, 0, null, null, 2, null]);
  assert.deepEqual(direct.byCampusMonth.find((r) => r.campus === 'SVYASA').per100Merged, null, 'a campus missing from the cohorts');
  assert.ok(!/NaN|Infinity/.test(JSON.stringify(direct)));
  // without cohorts the rows keep the addendum A shape
  const plain = await activity(db, { match: {}, range });
  assert.deepEqual(plain.byCampusMonth.find((r) => r.campus === 'RU'), { campus: 'RU', month, opened: 16, merged: 15 });
  // the route lists such a campus with a cohort of 0
  await collections(db).students.updateOne({ _id: 's1' }, { $set: { active: false } });
  try {
    const drift = await get(`/api/activity?${RANGE}&category=all`);
    assert.deepEqual(drift.cohorts.find((x) => x.campus === 'SVYASA'), { campus: 'SVYASA', students: 0, smallCohort: false });
    assert.deepEqual(drift.byCampusMonth.find((r) => r.campus === 'SVYASA'), { campus: 'SVYASA', month, opened: 1, merged: 1, students: 0, per100Opened: null, per100Merged: null, activeStudents: 1, activePct: null });
  } finally { await collections(db).students.updateOne({ _id: 's1' }, { $set: { active: true } }); }
});

test('campus endpoints are cached like every public response and dropped on an admin write', async () => {
  const cached = await startApp(db, { publicCacheMs: 60000 });
  try {
    const read = async (p) => { const r = await cached.get(p); return [r.headers.get('x-cache'), r.body.total?.osMerged ?? r.body.totals?.osMerged]; };
    assert.deepEqual(await read(`/api/campuses?${RANGE}`), ['miss', 22]);
    assert.deepEqual(await read(`/api/campuses?${RANGE}`), ['hit', 22]);
    assert.deepEqual(await read(`/api/campuses/RU?${RANGE}`), ['miss', 15]);
    assert.deepEqual(await read(`/api/campuses/RU?${RANGE}`), ['hit', 15]);
    assert.deepEqual(await read(`/api/campuses/ADYPU?${RANGE}`), ['miss', 5], 'another campus is another entry');
    await cached.login();
    assert.equal((await cached.patch('/api/admin/students/r4', { campus: 'ADYPU' })).status, 200);
    cached.clearCookie();
    assert.deepEqual(await read(`/api/campuses/RU?${RANGE}`), ['miss', 14], 'r4 moved to another campus');
    assert.deepEqual(await read(`/api/campuses/ADYPU?${RANGE}`), ['miss', 6]);
    const moved = (await cached.get(`/api/campuses?${RANGE}`)).body;
    assert.deepEqual(moved.campuses.map((x) => x.students), [3, 3, 1, 0, 1]);
    assert.deepEqual(moved.totals.find((t) => t.campus === 'ADYPU').tierMix.merged, { major: 0, established: 5, emerging: 1 }, 'the open-source work follows the student');
  } finally {
    await cached.login();
    await cached.patch('/api/admin/students/r4', { campus: 'RU' });
    await cached.close();
  }
});
