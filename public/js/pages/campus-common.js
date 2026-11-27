// Shared by every side-by-side campus comparison (SPEC addenda D and F): the scale toggle, the campus × year
// table, the campus-by-month series and the HTML bar blocks of the Campuses pages.
// Not a page: nothing routes here. Campuses differ a lot in size, so the default everywhere is a rate on the
// number of tracked students, and every label says which unit it shows and how large the cohort is.

import { setQuery } from '../lib/router.js';
import { h, table, segmented, mixBar, fmt, TIERS, TIER_LABELS, CATEGORIES, CATEGORY_LABELS } from '../lib/ui.js';
import { yearLabel, campusLink } from './common.js';

/* ───────────── scale: per 100 students | share of students | raw counts ───────────── */

export const SCALES = [
  { value: 'per100', label: 'Per 100 students', title: 'Counts divided by the number of tracked students, times 100' },
  { value: 'share', label: 'Share of students', title: 'Share of the tracked students of each campus' },
  { value: 'raw', label: 'Raw counts', title: 'Plain counts, not adjusted for the size of a campus' },
];

/** The scale in the hash query (`?scale=share|raw`); anything else is the default, per 100 students. */
export const scaleOf = (query = {}) => (query.scale === 'share' || query.scale === 'raw' ? query.scale : 'per100');

/**
 * The toggle. Every toggle on a page writes the same `scale` query key, so the comparisons on a page never
 * disagree about their unit. `name` keeps the button names unique (the router gives focus back by name).
 * `labels` renames an option for a block where the word fits better, e.g. { share: 'Share active' }.
 */
export function scaleToggle(ctx, name, { labels = {}, two = null } = {}) {
  const scale = scaleOf(ctx.query);
  // `two: [rateLabel, rawLabel]`: a block with one rate view (a table, a funnel) offers rates or counts only
  const options = two
    ? [{ value: 'per100', label: two[0], title: 'Adjusted for the number of tracked students' }, { ...SCALES[2], label: two[1] }]
    : SCALES.map((o) => ({ ...o, label: labels[o.value] || o.label }));
  return segmented({
    name: `scale-${name}`, label: 'Unit', options,
    value: two && scale === 'share' ? 'per100' : scale,
    onChange: (v) => setQuery({ scale: v === 'per100' ? '' : v }),
  });
}

/** Short unit for a value axis; the full sentence stands above the chart. */
export const AXIS = { per100: 'Per 100 students', share: '% of students', raw: 'Count' };

/* ───────────── small formatters ───────────── */

const ONE = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 });
const DASH = '—';
/** 73.9 → '73.9'; null → '—'. For per-100 rates (the API rounds them to one decimal). */
export const rate = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? DASH : ONE.format(Number(v)));
/** 7.6 → '7.6%'; null → '—'. For percentages the API already computed. */
export const pctVal = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? DASH : `${ONE.format(Number(v))}%`);
const signed = (v, f = rate) => (v > 0 ? `+${f(v)}` : v < 0 ? `−${f(Math.abs(v))}` : f(v));

/** One fixed colour slot per campus, the same in every chart. Unknown takes the neutral "other" colour. */
const CAMPUS_SLOT = { ADYPU: 1, RU: 2, SVYASA: 3, SMRU: 4 };
export const campusColor = (campus, index = 0) => (campus === 'Unknown' ? 'other' : CAMPUS_SLOT[campus] || ((index % 5) + 1));

/** "small cohort" marker: rates of a group below `smallCohortBelow` students swing widely. */
export function smallMark(row, below = 30) {
  return row && row.smallCohort
    ? h('span', { class: 'small-cohort', title: `Fewer than ${below} tracked students: one student moves this rate a lot` }, 'small cohort')
    : null;
}

/** "RU (1,504)" as text; with `small` it reads "Unknown (5, small cohort)". */
export const cohortLabel = (c) => `${c.campus} (${fmt.num(c.students)}${c.smallCohort ? ', small cohort' : ''})`;

/** The checkbox that brings the Unknown campus into the charts (`?unknown=1`), or null when it has no students. */
export function unknownToggle(ctx, campuses) {
  const u = (campuses || []).find((c) => c.campus === 'Unknown' && c.students > 0);
  if (!u) return null;
  const id = 'f-unknown';
  return h('span', { class: 'form-row-inline check-inline' },
    h('input', { type: 'checkbox', id, name: 'unknown', checked: ctx.query.unknown === '1', onChange: (e) => setQuery({ unknown: e.target.checked ? '1' : '' }) }),
    h('label', { for: id }, `Include the ${fmt.num(u.students)} students without a campus in the charts`));
}

/* ───────────── campus × year table ───────────── */

const YEAR_ORDER = ['1st year', '2nd year', '3rd year', '4th year', 'alumni', 'Unknown'];
const yearRank = (y) => { const i = YEAR_ORDER.indexOf(y); return i === -1 ? YEAR_ORDER.length - 1 : i; };

// column id → the field it sorts on (raw mode, rate mode)
const SORT_FIELDS = {
  students: ['students', 'students'],
  anyPr: ['withAnyPr', 'withAnyPrPct'],
  osPr: ['withOsPr', 'withOsPrPct'],
  merged: ['withOsMerged', 'withOsMerged'],
  mergedPct: ['withOsMergedPct', 'withOsMergedPct'],
  major: ['withMajorMerged', 'withMajorMergedPct'],
  osPrs: ['osPrs', 'osPrsPer100'],
  osMerged: ['osMerged', 'osMerged'],
  per100: ['osMergedPer100', 'osMergedPer100'],
  majorMerged: ['osMajorMerged', 'osMajorMergedPer100'],
  totalPrs: ['totalPrs', 'totalPrsPer100'],
};
export const CAMPUS_SORT_DEFAULT = 'mergedPct';

/**
 * Rows of /api/campuses in display order: campus groups (each followed by its subtotal), then the grand total.
 * Sorting keeps the grouping: campuses are ordered by their subtotal, years within a campus by their own value.
 * `sort: 'campus'` is the roster order (ADYPU, RU, SVYASA, SMRU; 1st year first). Unknown always comes last.
 */
export function groupedRows(data, { sort = CAMPUS_SORT_DEFAULT, order = 'desc', rateMode = false, total = true } = {}) {
  const totals = new Map((data.totals || []).map((t) => [t.campus, t]));
  const names = [...new Set((data.rows || []).map((r) => r.campus))];
  const field = SORT_FIELDS[sort] ? SORT_FIELDS[sort][rateMode ? 1 : 0] : null;
  const dir = order === 'asc' ? 1 : -1;
  const val = (r) => (r && r[field] !== null && r[field] !== undefined ? r[field] : -Infinity);
  const unknownLast = (a, b, key) => (a === key) - (b === key);
  if (field) {
    names.sort((a, b) => unknownLast(a, b, 'Unknown') || (val(totals.get(a)) - val(totals.get(b))) * dir);
  } else if (sort === 'campus' && order === 'desc') {
    names.reverse();
    names.sort((a, b) => unknownLast(a, b, 'Unknown'));
  }
  const out = [];
  for (const campus of names) {
    const rows = (data.rows || []).filter((r) => r.campus === campus);
    if (field) rows.sort((a, b) => unknownLast(a.year, b.year, 'Unknown') || (val(a) - val(b)) * dir || yearRank(a.year) - yearRank(b.year));
    else rows.sort((a, b) => yearRank(a.year) - yearRank(b.year));
    rows.forEach((r, i) => out.push({ ...r, _kind: i === 0 ? 'group' : null }));
    if (totals.has(campus)) out.push({ ...totals.get(campus), _kind: 'subtotal' });
  }
  if (total && data.total) out.push({ ...data.total, _kind: 'total' });
  return out;
}

/**
 * The campus × year table. `rateMode` shows the student columns as % of the cohort and the PR columns per 100
 * students; the two headline rates (% with a merged PR, merged PRs per 100) are shown in both modes, next to
 * their counts. opts: { ctx, past, rateMode, sort, order, onSort, mix (add All PRs + Mix), below, rows (pre-built), caption }
 */
export function campusYearTable(data, { ctx, past = false, rateMode = false, sort = CAMPUS_SORT_DEFAULT, order = 'desc', onSort = null, mix = false, period = null, rows = null, caption = 'Students and pull requests by campus and year', firstColumn = 'campus' } = {}) {
  const below = data.smallCohortBelow || 30;
  const list = rows || groupedRows(data, { sort, order, rateMode });
  const withShare = (key) => (r) => h('span', { title: `${fmt.pct(r[key], r.students)} of ${fmt.num(r.students)} students` }, fmt.num(r[key]));
  const asPct = (key, pctKey) => (r) => h('span', { title: `${fmt.num(r[key])} of ${fmt.num(r.students)} students` }, pctVal(r[pctKey]));
  const asRate = (key, rateKey, what) => (r) => h('span', { title: `${fmt.num(r[key])} ${what}, ${fmt.num(r.students)} students` }, rate(r[rateKey]));
  const students = (label, id, key, pctKey, title) => (rateMode
    ? { key: pctKey, sortKey: id, label: `% ${label}`, num: true, sortable: true, title: `${title}, as a share of the tracked students`, render: asPct(key, pctKey) }
    : { key, sortKey: id, label, num: true, sortable: true, title, render: withShare(key) });
  const prs = (label, id, key, rateKey, title, what) => (rateMode
    ? { key: rateKey, sortKey: id, label: `${label} per 100`, num: true, sortable: true, title: `${title}, per 100 tracked students`, render: asRate(key, rateKey, what) }
    : { key, sortKey: id, label, num: true, sortable: true, title });
  const columns = [
    firstColumn === 'campus' ? {
      key: 'campus', label: 'Campus', sortable: true,
      render: (r) => (r._kind === 'total' ? 'All campuses' : r._kind === 'subtotal' ? [campusLink(r.campus, ctx), ' total'] : campusLink(r.campus, ctx)),
    } : null,
    {
      key: 'year', label: 'Year',
      render: (r) => [r._kind === 'total' && firstColumn !== 'campus' ? 'All years' : yearLabel(r, past), r._kind ? null : [' ', smallMark(r, below)]],
    },
    { key: 'students', sortKey: 'students', label: 'Students', num: true, sortable: true, title: 'Tracked students: the denominator of every rate in the row' },
    {
      key: 'withOsMergedPct', sortKey: 'mergedPct', label: '% with merged PR', num: true, sortable: true, class: 'col-rate',
      title: 'Share of the tracked students with a merged open-source pull request', render: (r) => pctVal(r.withOsMergedPct),
    },
    {
      key: 'osMergedPer100', sortKey: 'per100', label: 'Merged per 100', num: true, sortable: true, class: 'col-rate',
      title: 'Merged open-source pull requests per 100 tracked students', render: (r) => rate(r.osMergedPer100),
    },
    students('Any PR', 'anyPr', 'withAnyPr', 'withAnyPrPct', 'Students with at least one pull request'),
    students('Open-source PR', 'osPr', 'withOsPr', 'withOsPrPct', 'Students with at least one open-source pull request'),
    { key: 'withOsMerged', sortKey: 'merged', label: 'Merged PR', num: true, sortable: true, title: 'Students with at least one merged open-source pull request' },
    students('Major project', 'major', 'withMajorMerged', 'withMajorMergedPct', 'Students merged into a major project'),
    prs('Open-source PRs', 'osPrs', 'osPrs', 'osPrsPer100', 'Open-source pull requests opened', 'open-source pull requests'),
    { key: 'osMerged', sortKey: 'osMerged', label: 'Merged PRs', num: true, sortable: true, title: 'Merged open-source pull requests' },
    prs('Major merged', 'majorMerged', 'osMajorMerged', 'osMajorMergedPer100', 'Pull requests merged into major projects', 'merged into major projects'),
    mix ? prs('All PRs', 'totalPrs', 'totalPrs', 'totalPrsPer100', 'Pull requests of every category', 'pull requests') : null,
    mix ? { key: 'mix', label: 'Mix', title: 'All pull requests by category', render: (r) => mixBar(r.byCategory, { merged: r.osMerged, period }) } : null,
  ].filter(Boolean).map((c) => (onSort ? c : { ...c, sortable: false }));
  return table({ caption, rows: list, rowClass: (r) => r._kind, sort, order, onSort, columns, empty: 'No data yet. An admin needs to import or add students.' });
}

/** The comparison as CSV text: every row of the table with both the counts and the rates. */
export function campusCsv(data) {
  const cols = [
    ['campus', (r) => (r._kind === 'total' ? 'All campuses' : r.campus)],
    ['year', (r) => (r._kind === 'subtotal' || r._kind === 'total' ? 'All years' : r.year)],
    ['batch', (r) => r.batch ?? ''],
    ...['students', 'withAnyPr', 'withAnyPrPct', 'withOsPr', 'withOsPrPct', 'withOsMerged', 'withOsMergedPct', 'withMajorMerged', 'withMajorMergedPct',
      'totalPrs', 'totalPrsPer100', 'osPrs', 'osPrsPer100', 'osMerged', 'osMergedPer100', 'osMajorMerged', 'osMajorMergedPer100'].map((k) => [k, (r) => r[k] ?? '']),
    ['smallCohort', (r) => (r.smallCohort ? 'yes' : '')],
  ];
  const cell = (v) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = groupedRows(data, { sort: 'campus', order: 'asc' });
  return [cols.map((c) => c[0]).join(','), ...rows.map((r) => cols.map((c) => cell(c[1](r))).join(','))].join('\n');
}

/** Button that saves `text` as a file (the comparison has no CSV endpoint; it is built from what is on screen). */
export function downloadButton(text, filename, label = 'Download CSV') {
  return h('button', {
    type: 'button', class: 'btn', name: 'download-csv',
    onClick: () => {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
      const a = h('a', { href: url, download: filename });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  }, label);
}

/* ───────────── campuses over time (GET /api/activity → byCampusMonth | byCampusWeek | byCampusDate) ───────────── */

/** The time steps of the campus lines: the axis list and the sparse campus rows of /api/activity, and the key both share. */
export const STEPS = {
  month: { axis: 'byMonth', rows: 'byCampusMonth', key: 'month', word: 'month', label: 'Month' },
  week: { axis: 'byWeek', rows: 'byCampusWeek', key: 'weekStart', word: 'week', label: 'Week' },
  day: { axis: 'byDate', rows: 'byCampusDate', key: 'date', word: 'day', label: 'Day' },
};
/** ?step=week|day → 'week' | 'day'; anything else → 'month'. */
export const stepOf = (q) => (q && STEPS[q.step] ? q.step : 'month');
/** Whether an /api/activity response carries the rows for a step (day rows are left out for a range that is too long). */
export const hasStep = (activity, step) => Boolean(activity && Array.isArray(activity[STEPS[step].rows]) && Array.isArray(activity[STEPS[step].axis]));

/** Month | Week | Day switch (`?step=`). A step the response cannot show is left out. */
export function stepToggle(ctx, activity, step = stepOf(ctx.query)) {
  const options = Object.entries(STEPS).filter(([k]) => k === 'month' || hasStep(activity, k))
    .map(([value, s]) => ({ value, label: s.label, title: `One point per ${s.word}` }));
  if (options.length < 2) return null;
  return segmented({
    name: 'step', label: 'Time step', options, value: step,
    onChange: (v) => setQuery({ step: v === 'month' ? '' : v }),
  });
}

/**
 * Chart input for "campuses by month / week / day" in one of the three scales.
 * → null when there is nothing to compare, else { input (for lineChart / barChart), names, unit, step }
 * opts: { scale, metric: 'opened' | 'merged', unknown (include the Unknown campus), noun ('pull requests'), step ('month' | 'week' | 'day') }
 */
export function campusMonthSeries(activity, { scale = 'per100', metric = 'merged', unknown = false, noun = 'pull requests', step = 'month' } = {}) {
  const st = STEPS[step] || STEPS.month;
  if (!activity || !Array.isArray(activity[st.rows])) return null;
  const months = (activity[st.axis] || []).map((m) => m[st.key]);
  const rows = activity[st.rows];
  const hasRates = rows.length === 0 || rows.some((r) => 'students' in r);
  const mode = hasRates ? scale : 'raw'; // an older server without cohorts can only show counts
  const cohorts = Array.isArray(activity.cohorts) && activity.cohorts.length
    ? activity.cohorts
    : [...new Set(rows.map((r) => r.campus))].map((campus) => ({ campus, students: null, smallCohort: false }));
  const names = cohorts.filter((c) => unknown || c.campus !== 'Unknown');
  if (!months.length || !names.length) return null;
  const at = new Map(rows.map((r) => [`${r.campus}|${r[st.key]}`, r]));
  const word = metric === 'merged' ? 'merged' : 'opened';
  const rateKey = metric === 'merged' ? 'per100Merged' : 'per100Opened';
  const cell = (c, m) => at.get(`${c.campus}|${m}`) || null;
  const value = (c, m) => {
    const r = cell(c, m);
    if (mode === 'raw') return r ? r[metric] || 0 : 0;
    if (!c.students) return null; // no cohort: a rate would be a division by zero
    if (!r) return 0;
    return mode === 'share' ? r.activePct : r[rateKey];
  };
  const series = names.map((c, i) => ({
    label: c.students === null ? c.campus : cohortLabel(c), color: campusColor(c.campus, i), dashed: Boolean(c.smallCohort),
    data: months.map((m) => value(c, m)),
  }));
  const unit = mode === 'per100' ? `${noun} ${word} per 100 tracked students`
    : mode === 'share' ? '% of tracked students who opened or merged one'
      : `${noun} ${word}`;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const tooltipLabel = (si, di) => {
    const c = names[si];
    const r = cell(c, months[di]) || { opened: 0, merged: 0, activeStudents: 0, per100Opened: c.students ? 0 : null, per100Merged: c.students ? 0 : null, activePct: c.students ? 0 : null };
    const count = `${fmt.num(r[metric] || 0)} ${word}`;
    const size = c.students === null ? null : `${fmt.num(c.students)} students${c.smallCohort ? ' (small cohort)' : ''}`;
    const per = c.students ? `${rate(r[rateKey])} per 100` : null;
    const active = c.students ? `${pctVal(r.activePct)} active (${fmt.num(r.activeStudents || 0)} students)` : null;
    const parts = mode === 'share' ? [active, count, size] : mode === 'raw' ? [count, per, size] : [per, count, size];
    return [c.campus, ...parts.filter(Boolean)].join(' · ');
  };
  return {
    names, mode, unit: cap(unit),
    input: {
      labels: months, series, tooltipLabel, axisTitle: AXIS[mode],
      format: mode === 'share' ? (v) => pctVal(v) : mode === 'per100' ? (v) => rate(v) : null,
      label: `${cap(unit)}, per ${st.word} by campus`,
    },
    step: st.word,
  };
}

/* ───────────── HTML bar blocks ───────────── */

/**
 * Horizontal bars with the value written out: hbars([{ label, sub?, value, text, note?, small?, href? }], { max })
 * All bars of a comparison share `max`, so lengths can be compared across the blocks of a page.
 */
export function hbars(rows, { max = null, tone = null } = {}) {
  const top = max ?? Math.max(0, ...rows.map((r) => Number(r.value) || 0));
  return h('dl', { class: ['hbars', tone && `hbars-${tone}`] }, rows.map((r) => {
    const w = top && r.value !== null && r.value !== undefined ? Math.max(0, Math.min(100, (Number(r.value) / top) * 100)) : 0;
    return [
      h('dt', null, r.href ? h('a', { href: r.href }, r.label) : r.label, r.sub ? h('small', null, r.sub) : null),
      h('dd', { class: ['track', r.small && 'is-small'], 'aria-hidden': 'true' }, h('span', { style: { width: `${w}%` } })),
      h('dd', { class: 'val' }, r.text, r.note ? h('small', null, r.note) : null),
    ];
  }));
}

/**
 * Stacked rows, one per group: stackRows([{ label, sub?, href?, parts: [{ key, label, value, cls? }], total, text }], { full, max })
 * `full` draws every row at 100% (a mix); otherwise the row length is total / max (a volume).
 */
export function stackRows(rows, { full = false, max = null, empty = 'None in this period' } = {}) {
  const top = max ?? Math.max(0, ...rows.map((r) => Number(r.total) || 0));
  return h('dl', { class: 'hbars hbars-stack' }, rows.map((r) => {
    const sum = r.parts.reduce((a, p) => a + (Number(p.value) || 0), 0);
    const width = sum ? (full ? 100 : top ? Math.max(1, (Number(r.total) / top) * 100) : 0) : 0;
    const summary = sum ? r.parts.filter((p) => p.value > 0).map((p) => `${p.label} ${fmt.pct(p.value, sum)}`).join(', ') : empty;
    return [
      h('dt', null, r.href ? h('a', { href: r.href }, r.label) : r.label, r.sub ? h('small', null, r.sub) : null),
      !sum ? h('dd', { class: 'hbars-empty muted' }, empty) : h('dd', { class: 'track', role: 'img', 'aria-label': `${r.label}: ${summary}` },
        sum ? h('span', { class: 'stackbar', style: { width: `${width}%` } }, r.parts.filter((p) => p.value > 0).map((p) => h('i', {
          class: p.cls, style: { flex: `${p.value} 0 0` }, title: `${p.label}: ${p.title || fmt.num(p.value)} (${fmt.pct(p.value, sum)})`,
        }, full && p.value / sum >= 0.12 ? h('b', null, fmt.pct(p.value, sum)) : null))) : null),
      sum ? h('dd', { class: 'val' }, r.text, r.note ? h('small', null, r.note) : null) : null,
    ];
  }));
}

/** Key for a stackRows block: legendKey([{ cls, label }]) */
export function legendKey(items) {
  return h('ul', { class: 'legend' }, items.map((i) => h('li', { class: i.cls, title: i.title || null },
    h('span', { class: 'swatch', 'aria-hidden': 'true' }), i.label)));
}

const cohortSub = (t, below) => [`${fmt.num(t.students)} students`, t.smallCohort ? [' · ', smallMark(t, below)] : null];

/** Tier mix of the merged open-source PRs, one row per group (campus or year). */
export function tierMixBlock(groups, { scale, ctx, below = 30, labelOf = (t) => t.campus, hrefOf = null } = {}) {
  const rows = groups.map((t) => {
    const merged = (t.tierMix && t.tierMix.merged) || {};
    return {
      label: labelOf(t), sub: cohortSub(t, below), href: hrefOf ? hrefOf(t) : null,
      parts: TIERS.map((k) => ({ key: k, label: TIER_LABELS[k], value: merged[k] || 0, cls: `tier-bg-${k}` })),
      total: scale === 'per100' ? t.osMergedPer100 : t.osMerged,
      text: scale === 'per100' ? rate(t.osMergedPer100) : scale === 'share' ? fmt.pct(merged.major || 0, t.osMerged) : fmt.num(t.osMerged),
      note: scale === 'per100' ? `per 100 · ${fmt.num(t.osMerged)} merged` : scale === 'share' ? `major · ${fmt.num(t.osMerged)} merged` : `merged · ${rate(t.osMergedPer100)} per 100`,
    };
  });
  return h('div', null,
    stackRows(rows, { full: scale === 'share', empty: 'No merged open-source PRs' }),
    legendKey(TIERS.map((k) => ({ cls: `tier-bg-${k}`, label: TIER_LABELS[k] }))));
}

/** Category mix of all pull requests opened, one row per group. */
export function categoryMixBlock(groups, { scale, below = 30, labelOf = (t) => t.campus, hrefOf = null } = {}) {
  const rows = groups.map((t) => {
    const by = t.byCategory || {};
    return {
      label: labelOf(t), sub: cohortSub(t, below), href: hrefOf ? hrefOf(t) : null,
      parts: CATEGORIES.map((k) => ({ key: k, label: CATEGORY_LABELS[k], value: by[k] || 0, cls: `cat-bg cat-${k}` })),
      total: scale === 'per100' ? t.totalPrsPer100 : t.totalPrs,
      text: scale === 'per100' ? rate(t.totalPrsPer100) : scale === 'share' ? fmt.pct(by.open_source || 0, t.totalPrs) : fmt.num(t.totalPrs),
      note: scale === 'per100' ? `per 100 · ${fmt.num(t.totalPrs)} PRs` : scale === 'share' ? `open source · ${fmt.num(t.totalPrs)} PRs` : `PRs · ${rate(t.totalPrsPer100)} per 100`,
    };
  });
  return h('div', null,
    stackRows(rows, { full: scale === 'share', empty: 'No pull requests' }),
    legendKey(CATEGORIES.map((k) => ({ cls: `cat-bg cat-${k}`, label: CATEGORY_LABELS[k] }))));
}

/**
 * Participation funnel as a matrix: one row per group, one column per step, each cell a bar scaled to the
 * largest value of its column. Reading down a column compares the groups on that step.
 */
export function funnelMatrix(groups, { scale, ctx, below = 30, first = 'Campus', labelOf = null } = {}) {
  const raw = scale === 'raw';
  const steps = ((groups[0] && groups[0].funnel) || []).filter((s) => s.key !== 'tracked');
  const step = (t, key) => (t.funnel || []).find((s) => s.key === key) || { count: 0, pct: null };
  const short = { anyPr: 'Any PR', osPr: 'Open-source PR', osMerged: 'Merged open-source PR', majorMerged: 'Merged in a major project' };
  return table({
    caption: 'Share of tracked students reaching each step, by campus', sticky: true,
    rows: groups,
    columns: [
      { key: 'campus', label: first, render: (t) => (labelOf ? labelOf(t) : [campusLink(t.campus, ctx), ' ', smallMark(t, below)]) },
      { key: 'students', label: 'Tracked students', num: true },
      ...steps.map((s) => {
        const max = Math.max(0, ...groups.map((t) => (raw ? step(t, s.key).count : step(t, s.key).pct) || 0));
        return {
          key: s.key, label: short[s.key] || s.label, num: true, class: 'col-bar',
          title: `${s.label}${raw ? '' : ', as a share of the tracked students'}`,
          render: (t) => {
            const v = step(t, s.key);
            const main = raw ? v.count : v.pct;
            const w = max && main ? Math.max(1, (main / max) * 100) : 0;
            return h('span', { class: 'cellbar', title: `${fmt.num(v.count)} of ${fmt.num(t.students)} students (${pctVal(v.pct)})` },
              h('span', { class: 'cellbar-value' }, raw ? fmt.num(v.count) : pctVal(v.pct), h('small', null, raw ? pctVal(v.pct) : fmt.num(v.count))),
              h('span', { class: 'cellbar-track', 'aria-hidden': 'true' }, h('span', { class: ['cellbar-fill', s.key === 'majorMerged' && 'is-last'], style: { width: `${w}%` } })));
          },
        };
      }),
    ],
  });
}

/** What the year-wise bars show in each scale. */
export function yearMetric(scale) {
  if (scale === 'share') return { value: (r) => r.withOsMergedPct, text: (r) => pctVal(r.withOsMergedPct), note: (r) => `${fmt.num(r.withOsMerged)} ${r.withOsMerged === 1 ? 'student' : 'students'}`, unit: '% of students with a merged open-source PR' };
  if (scale === 'raw') return { value: (r) => r.osMerged, text: (r) => fmt.num(r.osMerged), note: (r) => `${rate(r.osMergedPer100)} per 100`, unit: 'Merged open-source PRs' };
  return { value: (r) => r.osMergedPer100, text: (r) => rate(r.osMergedPer100), note: (r) => `${fmt.num(r.osMerged)} merged`, unit: 'Merged open-source PRs per 100 students' };
}

/** Year-wise bars of one campus; pass the same `max` to every campus so the panels share a scale. */
export function yearBars(rows, { scale, max = null, past = false, below = 30 } = {}) {
  const m = yearMetric(scale);
  return hbars(rows.map((r) => ({
    label: r.year === 'Unknown' ? 'Year unknown' : r.year,
    sub: [`${fmt.num(r.students)} students`, past && r.batch ? ` · Batch ${r.batch}` : null, r.smallCohort ? [' · ', smallMark(r, below)] : null],
    value: m.value(r), text: m.text(r), note: m.note(r), small: r.smallCohort,
  })), { max });
}

/** How concentrated the merged work is: one row per group. */
export function distributionTable(groups, { ctx, first = 'Campus', labelOf = null, caption = 'How the merged open-source pull requests are spread over students' } = {}) {
  const BUCKETS = ['1', '2-4', '5-9', '10+'];
  const name = { 1: '1 PR', '2-4': '2 to 4', '5-9': '5 to 9', '10+': '10 or more' };
  const d = (t) => t.distribution || { contributors: 0, buckets: {} };
  return table({
    caption, rows: groups,
    columns: [
      { key: 'campus', label: first, render: (t) => (labelOf ? labelOf(t) : campusLink(t.campus, ctx)) },
      { key: 'contributors', label: 'Students with a merged PR', num: true, render: (t) => fmt.num(d(t).contributors) },
      {
        key: 'spread', label: 'By number of merged PRs', class: 'col-spread', title: 'Students with 1, 2 to 4, 5 to 9 and 10 or more merged open-source pull requests',
        render: (t) => {
          const b = d(t).buckets || {};
          const total = d(t).contributors;
          if (!total) return null;
          return h('span', { class: 'spread', role: 'img', 'aria-label': BUCKETS.map((k) => `${name[k]}: ${fmt.num(b[k] || 0)}`).join(', ') },
            BUCKETS.filter((k) => b[k] > 0).map((k) => h('i', { class: `heat-${BUCKETS.indexOf(k) + 1}`, style: { flex: `${b[k]} 0 0` }, title: `${name[k]}: ${fmt.num(b[k])} students (${fmt.pct(b[k], total)})` })));
        },
      },
      ...BUCKETS.map((k) => ({ key: `b${k}`, label: name[k], num: true, render: (t) => (d(t).contributors ? fmt.num((d(t).buckets || {})[k] || 0) : null) })),
      { key: 'median', label: 'Median', num: true, title: 'Median number of merged open-source pull requests among students with at least one', render: (t) => (d(t).median === null || d(t).median === undefined ? null : rate(d(t).median)) },
      { key: 'max', label: 'Most by one student', num: true, render: (t) => (d(t).contributors ? fmt.num(d(t).max) : null) },
      {
        key: 'top', label: 'From the top 10%', num: true, title: 'Share of the merged open-source pull requests that came from the top 10% of contributing students',
        render: (t) => (d(t).top10PctShare === null || d(t).top10PctShare === undefined ? null
          : h('span', { title: `${fmt.num(d(t).top10PctMerged)} of the merged PRs came from ${fmt.num(d(t).top10PctStudents)} ${d(t).top10PctStudents === 1 ? 'student' : 'students'}` },
            pctVal(d(t).top10PctShare), h('small', { class: 'sub-inline muted' }, ` by ${fmt.num(d(t).top10PctStudents)}`))),
      },
    ],
  });
}

/** Key for the "By number of merged PRs" bar. */
export function spreadKey() {
  return h('ul', { class: 'legend' },
    ['1 merged PR', '2 to 4', '5 to 9', '10 or more'].map((label, i) => h('li', null, h('span', { class: `swatch heat-${i + 1}`, 'aria-hidden': 'true' }), label)));
}

/** "▲ 103.1% merged open-source PRs vs the previous 142 days (547 → 1,111)" as nodes; null when there is nothing to compare. */
export function deltaLine(t, previousRange) {
  if (!previousRange || !t || !t.delta || !t.previous) return null;
  const d = t.delta;
  const days = previousRange.days ? `the ${fmt.num(previousRange.days)} days before` : 'the period before';
  const span = `${fmt.num(t.previous.osMerged)} → ${fmt.num(t.osMerged)}`;
  if (!d.osMerged) return h('span', { class: 'delta' }, h('b', null, 'No change'), ` in merged open-source PRs vs ${days} (${span})`);
  const up = d.osMerged > 0;
  const size = d.osMergedPct === null || d.osMergedPct === undefined ? signed(d.osMerged, fmt.num) : `${ONE.format(Math.abs(d.osMergedPct))}%`;
  return h('span', { class: ['delta', up ? 'delta-up' : 'delta-down'], title: `Previous period: ${fmt.range(previousRange.from, previousRange.to)}, on today’s list of students` },
    h('b', null, h('span', { 'aria-hidden': 'true' }, up ? '▲ ' : '▼ '), h('span', { class: 'sr-only' }, up ? 'Up ' : 'Down '), size),
    ` merged open-source PRs vs ${days} (${span})`);
}
