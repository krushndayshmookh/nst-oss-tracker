// Public frontend logic of addenda D, E (mix bar) and F that runs without a browser: the pure helpers of
// public/js/pages/campus-common.js on fixtures shaped like GET /api/campuses and GET /api/activity, and the wiring
// of the Campuses routes. Rendering was checked in headless Chromium (1280 / 375 px, light / dark).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const common = await import('../public/js/pages/campus-common.js');
const { scaleOf, rate, pctVal, groupedRows, campusCsv, campusMonthSeries, yearMetric, cohortLabel, campusColor, CAMPUS_SORT_DEFAULT } = common;
const read = (p) => fs.readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8');

const block = (campus, year, students, withOsMerged, osMerged, extra = {}) => ({
  campus, year, batch: null, students, withAnyPr: withOsMerged, withOsPr: withOsMerged, withOsMerged, withMajorMerged: 0,
  totalPrs: osMerged, osPrs: osMerged, osMerged, osMajorMerged: 0,
  withOsMergedPct: students ? Math.round((withOsMerged * 1000) / students) / 10 : null,
  osMergedPer100: students ? Math.round((osMerged * 1000) / students) / 10 : null,
  smallCohort: students > 0 && students < 30, ...extra,
});
const campuses = {
  smallCohortBelow: 30,
  campuses: [{ campus: 'ADYPU', students: 1000 }, { campus: 'RU', students: 1500 }, { campus: 'SMRU', students: 50 }, { campus: 'Unknown', students: 5, smallCohort: true }],
  rows: [
    block('ADYPU', '1st year', 600, 6, 12), block('ADYPU', '2nd year', 400, 40, 100),
    block('RU', '1st year', 500, 50, 60), block('RU', '2nd year', 990, 20, 300), block('RU', 'Unknown', 10, 9, 90),
    block('SMRU', '1st year', 50, 10, 11),
    block('Unknown', 'Unknown', 5, 5, 50),
  ],
  totals: [block('ADYPU', 'All', 1000, 46, 112), block('RU', 'All', 1500, 79, 450), block('SMRU', 'All', 50, 10, 11), block('Unknown', 'All', 5, 5, 50)],
  total: block('All', 'All', 2555, 140, 623),
};
const key = (r) => `${r.campus}/${r.year}${r._kind ? `/${r._kind}` : ''}`;

test('scale: per 100 students is the default; only share and raw are accepted from the address', () => {
  assert.equal(scaleOf({}), 'per100');
  assert.equal(scaleOf({ scale: 'share' }), 'share');
  assert.equal(scaleOf({ scale: 'raw' }), 'raw');
  assert.equal(scaleOf({ scale: 'per1000' }), 'per100');
  assert.equal(CAMPUS_SORT_DEFAULT, 'mergedPct');
});

test('rate formatters: one decimal, a dash (never NaN or Infinity) for a missing rate', () => {
  assert.equal(rate(73.9), '73.9');
  assert.equal(rate(60), '60');
  assert.equal(rate(null), '—');
  assert.equal(rate(undefined), '—');
  assert.equal(pctVal(7.6), '7.6%');
  assert.equal(pctVal(0), '0%');
  assert.equal(pctVal(null), '—');
});

test('campus × year rows: default sort is the rate, groups keep their subtotal, Unknown stays last', () => {
  const rows = groupedRows(campuses, {}).map(key);
  assert.deepEqual(rows, [
    'SMRU/1st year/group', 'SMRU/All/subtotal', // 20%
    'RU/1st year/group', 'RU/2nd year', 'RU/Unknown', 'RU/All/subtotal', // 5.3%; Unknown year last although its rate is the highest
    'ADYPU/2nd year/group', 'ADYPU/1st year', 'ADYPU/All/subtotal', // 4.6%
    'Unknown/Unknown/group', 'Unknown/All/subtotal', // 100%, still last
    'All/All/total',
  ]);
  const asc = groupedRows(campuses, { order: 'asc' }).map(key);
  assert.deepEqual(asc.filter((k) => k.endsWith('subtotal')), ['ADYPU/All/subtotal', 'RU/All/subtotal', 'SMRU/All/subtotal', 'Unknown/All/subtotal']);
  assert.equal(asc.at(-1), 'All/All/total');
});

test('campus × year rows: sorting by a count, by campus, and rate mode picking the rate field', () => {
  const byMerged = groupedRows(campuses, { sort: 'osMerged' }).filter((r) => r._kind === 'subtotal').map((r) => r.campus);
  assert.deepEqual(byMerged, ['RU', 'ADYPU', 'SMRU', 'Unknown']);
  const roster = groupedRows(campuses, { sort: 'campus', order: 'asc' }).map(key);
  assert.deepEqual(roster.slice(0, 3), ['ADYPU/1st year/group', 'ADYPU/2nd year', 'ADYPU/All/subtotal']);
  const data = { ...campuses, totals: campuses.totals.map((t) => ({ ...t, withAnyPrPct: { ADYPU: 1, RU: 3, SMRU: 2, Unknown: 9 }[t.campus] })) };
  const rateOrder = groupedRows(data, { sort: 'anyPr', rateMode: true }).filter((r) => r._kind === 'subtotal').map((r) => r.campus);
  assert.deepEqual(rateOrder, ['RU', 'SMRU', 'ADYPU', 'Unknown']);
  assert.equal(groupedRows(campuses, { total: false }).some((r) => r._kind === 'total'), false);
});

test('CSV of the comparison: counts and rates, subtotals and the grand total, roster order', () => {
  const lines = campusCsv(campuses).split('\n');
  assert.equal(lines.length, 1 + 7 + 4 + 1);
  const head = lines[0].split(',');
  for (const col of ['campus', 'year', 'students', 'withOsMerged', 'withOsMergedPct', 'osMerged', 'osMergedPer100', 'smallCohort']) assert.ok(head.includes(col), col);
  const cell = (line, col) => line.split(',')[head.indexOf(col)];
  assert.equal(cell(lines[1], 'campus'), 'ADYPU');
  assert.equal(cell(lines[1], 'osMergedPer100'), '2');
  const ruTotal = lines.find((l) => l.startsWith('RU,All years'));
  assert.equal(cell(ruTotal, 'students'), '1500');
  assert.equal(cell(ruTotal, 'osMergedPer100'), '30');
  assert.equal(cell(lines.find((l) => l.startsWith('RU,Unknown')), 'smallCohort'), 'yes');
  assert.ok(lines.at(-1).startsWith('All campuses,All years'));
});

const activity = {
  byMonth: [{ month: '2026-09' }, { month: '2026-10' }],
  byCampusMonth: [
    { campus: 'RU', month: '2026-10', opened: 559, merged: 287, students: 1504, per100Opened: 37.2, per100Merged: 19.1, activeStudents: 93, activePct: 6.2 },
    { campus: 'SMRU', month: '2026-10', opened: 1, merged: 0, students: 49, per100Opened: 2, per100Merged: 0, activeStudents: 1, activePct: 2 },
    { campus: 'Unknown', month: '2026-10', opened: 1, merged: 0, students: 5, per100Opened: 20, per100Merged: 0, activeStudents: 1, activePct: 20 },
    { campus: 'GHOST', month: '2026-09', opened: 4, merged: 1, students: 0, per100Opened: null, per100Merged: null, activeStudents: 2, activePct: null },
  ],
  cohorts: [
    { campus: 'RU', students: 1504, smallCohort: false }, { campus: 'SMRU', students: 49, smallCohort: false },
    { campus: 'GHOST', students: 0, smallCohort: false }, { campus: 'Unknown', students: 5, smallCohort: true },
  ],
};

test('campuses by month: per 100 by default, zero-filled months, no rate for an empty cohort, Unknown left out', () => {
  const s = campusMonthSeries(activity, { scale: 'per100', metric: 'opened' });
  assert.deepEqual(s.input.labels, ['2026-09', '2026-10']);
  assert.deepEqual(s.input.series.map((x) => x.label), ['RU (1,504)', 'SMRU (49)', 'GHOST (0)']);
  assert.deepEqual(s.input.series[0].data, [0, 37.2]);
  assert.deepEqual(s.input.series[1].data, [0, 2]);
  assert.deepEqual(s.input.series[2].data, [null, null], 'a cohort of 0 students has no rate');
  assert.match(s.unit, /per 100 tracked students/);
  assert.equal(s.input.tooltipLabel(0, 1), 'RU · 37.2 per 100 · 559 opened · 1,504 students');
  assert.equal(s.input.tooltipLabel(0, 0), 'RU · 0 per 100 · 0 opened · 1,504 students');
  assert.equal(s.input.format(12.5), '12.5');
  const merged = campusMonthSeries(activity, { scale: 'per100', metric: 'merged' });
  assert.deepEqual(merged.input.series[0].data, [0, 19.1]);
});

test('campuses by month: share of students active, raw counts, and the Unknown campus on request', () => {
  const share = campusMonthSeries(activity, { scale: 'share', metric: 'opened', unknown: true });
  assert.deepEqual(share.input.series.map((x) => x.label), ['RU (1,504)', 'SMRU (49)', 'GHOST (0)', 'Unknown (5, small cohort)']);
  assert.deepEqual(share.input.series[0].data, [0, 6.2]);
  assert.equal(share.input.series[3].dashed, true, 'a small cohort is drawn dashed');
  assert.equal(share.input.series[0].dashed, false);
  assert.equal(share.input.format(6.2), '6.2%');
  assert.match(share.input.tooltipLabel(0, 1), /^RU · 6\.2% active \(93 students\) · 559 opened · 1,504 students$/);
  assert.match(share.input.tooltipLabel(3, 1), /small cohort/);
  const raw = campusMonthSeries(activity, { scale: 'raw', metric: 'opened' });
  assert.deepEqual(raw.input.series[0].data, [0, 559]);
  assert.deepEqual(raw.input.series[2].data, [4, 0], 'raw counts need no cohort');
  assert.equal(raw.input.format, null);
  assert.equal(raw.input.tooltipLabel(0, 1), 'RU · 559 opened · 37.2 per 100 · 1,504 students');
});

test('campuses by month: a server without cohorts falls back to counts; nothing to draw gives null', () => {
  const old = { byMonth: activity.byMonth, byCampusMonth: [{ campus: 'RU', month: '2026-10', opened: 5, merged: 2 }] };
  const s = campusMonthSeries(old, { scale: 'per100', metric: 'opened' });
  assert.equal(s.mode, 'raw');
  assert.deepEqual(s.input.series.map((x) => [x.label, x.data]), [['RU', [0, 5]]]);
  assert.equal(campusMonthSeries({ byMonth: [], byCampusMonth: [], cohorts: [] }), null);
  assert.equal(campusMonthSeries(null), null);
});

test('year-wise metric follows the scale; campus labels and colours are stable', () => {
  const r = { osMergedPer100: 60, osMerged: 345, withOsMergedPct: 5.2, withOsMerged: 1 };
  assert.equal(yearMetric('per100').value(r), 60);
  assert.equal(yearMetric('share').value(r), 5.2);
  assert.equal(yearMetric('share').note(r), '1 student');
  assert.equal(yearMetric('raw').value(r), 345);
  assert.equal(cohortLabel({ campus: 'RU', students: 1504 }), 'RU (1,504)');
  assert.equal(campusColor('RU'), campusColor('RU', 3));
  assert.notEqual(campusColor('ADYPU'), campusColor('SVYASA'));
  assert.equal(campusColor('Unknown'), 'other');
});

test('wiring: Campuses nav item, both routes, shared mix bar and its legend', () => {
  const html = read('index.html');
  assert.match(html, /<a data-nav href="#\/campuses">Campuses<\/a>/);
  const app = read('js/app.js');
  assert.match(app, /path: '\/campuses', page: \(\) => import\('\.\/pages\/campuses\.js'\)/);
  assert.match(app, /path: '\/campuses\/:campus', page: \(\) => import\('\.\/pages\/campus\.js'\)/);
  const ui = read('js/lib/ui.js');
  assert.match(ui, /export function mixBar\(byCategory, \{ merged = null/);
  assert.match(ui, /export function mixLegend\(/);
  assert.match(ui, /export \{ mixBar as categoryBar \}/);
  // no page keeps its own copy of the bar, and every table with a Mix column has the legend above it
  for (const f of fs.readdirSync(new URL('../public/js/pages/', import.meta.url))) {
    const src = read(`js/pages/${f}`);
    assert.doesNotMatch(src, /class: \[?'mix'/, `${f} builds its own mix bar`);
    if (/label: 'Mix'/.test(src) && f !== 'campus-common.js') assert.match(src, /mixLegend\(\)/, `${f} has a Mix column without the legend`);
  }
});
