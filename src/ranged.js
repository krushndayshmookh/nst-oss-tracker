// Ranged statistics and activity analytics (SPEC addendum A2 / A3): aggregation pipelines over `prs`.
// A PR is "opened in range" when createdAt is inside the range and "merged in range" when mergedAt is, whatever
// the day it was opened. With an unbounded range the numbers equal the precomputed all-time `stats`.
import { collections } from './db.js';
import { CAMPUSES, CATEGORIES } from './classify.js';
import { emptyByCategory } from './ingest.js';
import { TZ, addDays, daysBetween, inRange, zoned } from './dates.js';

export const AGG = { maxTimeMS: 20000, allowDiskUse: true };
const MAX_DAYS = 800;

export const eq = (f, v) => ({ $eq: [f, v] });
export const and = (...c) => { const list = c.filter((x) => x !== true); return list.length === 0 ? true : list.length === 1 ? list[0] : { $and: list }; };
export const sumIf = (cond) => (cond === true ? { $sum: 1 } : { $sum: { $cond: [cond, 1, 0] } });
/** count per 100 students (= % of students), 1 decimal; null for a cohort without students (SPEC addendum D). */
export const per100 = (count, students) => (students > 0 ? Math.round(((count || 0) * 1000) / students) / 10 : null);
export const OS = eq('$category', 'open_source');
export const MERGED = eq('$state', 'merged');

function within(field, range) {
  const c = [];
  if (range.start) c.push({ $gte: [field, range.start] });
  if (range.end) c.push({ $lt: [field, range.end] });
  return and(...c);
}

/** Aggregation expressions: was this PR opened / merged inside the range. */
export function rangeFlags(range) {
  return { opened: within('$createdAt', range), merged: and(MERGED, within('$mergedAt', range)) };
}

/** $match fragment selecting the PRs that were opened or merged inside the range ({} when unbounded). */
export function rangeMatch(range) {
  const cond = inRange(range);
  return cond ? { $or: [{ createdAt: cond }, { mergedAt: cond }] } : {};
}

/** Combines filter fragments without one `$or` clobbering another. */
export function allOf(...parts) {
  const out = {};
  const ands = [];
  for (const p of parts) {
    if (!p) continue;
    for (const [k, v] of Object.entries(p)) {
      if (k === '$and') ands.push(...v);
      else if (k in out) ands.push({ [k]: v });
      else out[k] = v;
    }
  }
  if (ands.length) out.$and = ands;
  return out;
}

/**
 * One row per `by` ('author' | 'repoLc' | 'ownerLc') with the counters the public shape of that kind needs
 * (studentStats / repoStats / ownerStats below) and nothing else: the whole-dataset maps are kept in memory for a
 * while, so every field that is not read costs heap for nothing.
 * `match` is ANDed with active:true and the range.
 */
export async function groupStats(db, { by, range, match = {} }) {
  const { prs } = collections(db);
  const { opened, merged } = rangeFlags(range);
  const touched = range.all ? true : { $or: [opened, merged] };
  const setIf = (cond, field) => ({ $addToSet: cond === true ? field : { $cond: [cond, field, null] } });
  const sizeOf = (f) => ({ $size: { $setDifference: [f, [null]] } });
  const student = by === 'author';
  const repo = by === 'repoLc';
  const owner = by === 'ownerLc';
  const cats = Object.fromEntries(CATEGORIES.map((k) => [`c_${k}`, sumIf(and(opened, eq('$category', k)))]));
  const first = { $min: opened === true ? '$createdAt' : { $cond: [opened, '$createdAt', null] } };
  const last = { $max: opened === true ? '$createdAt' : { $cond: [opened, '$createdAt', null] } };
  const group = {
    _id: `$${by}`,
    opened: sumIf(opened), merged: sumIf(merged),
    ...((student || owner) && { osOpened: sumIf(and(OS, opened)), osMerged: sumIf(and(OS, merged)), ...cats }),
    ...(student && {
      osOpen: sumIf(and(OS, opened, eq('$state', 'open'))),
      osMajorMerged: sumIf(and(OS, merged, eq('$tier', 'major'))),
      osRepos: setIf(and(OS, touched), '$repoLc'), osOrgs: setIf(and(OS, touched), '$ownerLc'),
      lastOsMergedAt: { $max: { $cond: [and(OS, merged), '$mergedAt', null] } },
    }),
    ...((student || repo) && { firstPrAt: first, lastPrAt: last }),
    ...(repo && {
      open: sumIf(and(opened, eq('$state', 'open'))), closed: sumIf(and(opened, eq('$state', 'closed'))),
      campuses: { $addToSet: '$campus' },
    }),
    ...((repo || owner) && { students: { $addToSet: '$author' } }),
    ...(owner && { repos: { $addToSet: '$repoLc' }, maxStars: { $max: '$stars' } }),
  };
  const project = Object.fromEntries(Object.keys(group).filter((k) => k !== '_id').map((k) => [k, 1]));
  if (student) Object.assign(project, { osRepos: sizeOf('$osRepos'), osOrgs: sizeOf('$osOrgs') });
  if (repo || owner) project.students = { $size: '$students' };
  if (owner) project.repos = { $size: '$repos' };
  const rows = await prs.aggregate([
    { $match: allOf({ active: true }, match, rangeMatch(range)) },
    { $group: group },
    { $project: project },
  ], AGG).toArray();
  return new Map(rows.map((g) => [g._id, g]));
}

const byCat = (g) => ({ ...emptyByCategory(), ...Object.fromEntries(CATEGORIES.map((k) => [k, g[`c_${k}`] || 0])) });

/** groupStats row -> the `stats` object of a Student / Repo / Org (same keys as the all-time stats). */
export function studentStats(g) {
  return {
    totalPrs: g.opened, mergedPrs: g.merged, osPrs: g.osOpened, osMerged: g.osMerged, osOpen: g.osOpen, osMajorMerged: g.osMajorMerged,
    osRepos: g.osRepos, osOrgs: g.osOrgs, byCategory: byCat(g),
    firstPrAt: g.firstPrAt ?? null, lastPrAt: g.lastPrAt ?? null, lastOsMergedAt: g.lastOsMergedAt ?? null,
  };
}
export function repoStats(g) {
  return { prs: g.opened, merged: g.merged, open: g.open, closed: g.closed, students: g.students, campuses: [...(g.campuses || [])].sort(),
    firstPrAt: g.firstPrAt ?? null, lastPrAt: g.lastPrAt ?? null };
}
export function ownerStats(g) {
  return { repos: g.repos, prs: g.opened, merged: g.merged, osPrs: g.osOpened, osMerged: g.osMerged, students: g.students,
    maxStars: g.maxStars ?? 0, byCategory: byCat(g) };
}

// ---------- activity ----------

const monthsBetween = (a, b) => { // 'YYYY-MM' inclusive
  const out = [];
  let [y, m] = a.split('-').map(Number);
  const [ey, em] = b.split('-').map(Number);
  while ((y < ey || (y === ey && m <= em)) && out.length < 1200) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
};
const weekStartOf = (ymd, dow) => addDays(ymd, 1 - dow); // Monday
const dowOf = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay() || 7; // Mon=1 … Sun=7 of a calendar day

/**
 * Activity of the PRs matching `match` (active:true is added) inside `range`, bucketed in `tz`.
 * -> { totals, byMonth, byWeek, byDate | truncated, byWeekday, byHour, heatmap, byCampusMonth, busiest }
 * With `cohorts` (Map<campus, number of active tracked students>, SPEC addendum D) every byCampusMonth row also carries
 * students, per100Opened, per100Merged (count / students x 100, 1 decimal), activeStudents (distinct students of the
 * campus with an event that month) and activePct. A campus without students has null rates.
 */
export async function activity(db, { match = {}, range, metric = 'opened', tz = TZ, now = new Date(), cohorts = null }) {
  const { prs } = collections(db);
  const cond = inRange(range);
  // Opened and merged events are read by two index-friendly pipelines each (hour x campus counts, month x author pairs)
  // instead of one $unwind over every PR: on the full dataset this is 3-4 times faster for wide ranges.
  const events = (field, extra) => {
    const $match = allOf({ active: true, ...extra }, match, { [field]: cond ? { ...cond, $type: 'date' } : { $type: 'date' } });
    const str = (format) => ({ $dateToString: { date: `$${field}`, format, timezone: tz } });
    return [
      prs.aggregate([{ $match }, { $group: { _id: { h: str('%Y-%m-%dT%H'), c: '$campus' }, n: { $sum: 1 } } }], AGG).toArray(),
      prs.aggregate([{ $match }, { $group: { _id: { m: str('%Y-%m'), a: '$author' }, c: { $first: '$campus' } } }], AGG).toArray(),
    ];
  };
  const [openedRows, openedAuthors, mergedRows, mergedAuthors] = await Promise.all([
    ...events('createdAt', {}), ...events('mergedAt', { state: 'merged' }),
  ]);
  const rows = [...openedRows.map((r) => ({ k: 'opened', ...r })), ...mergedRows.map((r) => ({ k: 'merged', ...r }))];

  const zero = () => ({ opened: 0, merged: 0 });
  const months = new Map();
  const weeks = new Map();
  const dates = new Map();
  const weekdays = new Map();
  const hours = new Map();
  const cells = new Map();
  const campusMonths = new Map();
  const monthAuthors = new Map();
  const campusMonthAuthors = new Map();
  const allAuthors = new Set();
  const totals = { opened: 0, merged: 0, activeStudents: 0 };
  const bump = (map, key) => { let v = map.get(key); if (!v) { v = zero(); map.set(key, v); } return v; };
  let first = null;
  let last = null;
  for (const r of rows) {
    const { k } = r;
    const date = r._id.h.slice(0, 10);
    const month = date.slice(0, 7);
    const hour = Number(r._id.h.slice(11, 13));
    const dow = dowOf(date);
    totals[k] += r.n;
    bump(months, month)[k] += r.n;
    bump(weeks, weekStartOf(date, dow))[k] += r.n;
    bump(dates, date)[k] += r.n;
    bump(weekdays, dow)[k] += r.n;
    bump(hours, hour)[k] += r.n;
    bump(cells, `${dow}-${hour}`)[k] += r.n;
    bump(campusMonths, `${r._id.c || 'Unknown'}|${month}`)[k] += r.n;
    if (!first || date < first) first = date;
    if (!last || date > last) last = date;
  }
  for (const r of [...openedAuthors, ...mergedAuthors]) {
    let set = monthAuthors.get(r._id.m);
    if (!set) { set = new Set(); monthAuthors.set(r._id.m, set); }
    set.add(r._id.a);
    allAuthors.add(r._id.a);
    if (cohorts) {
      const key = `${r.c || 'Unknown'}|${r._id.m}`;
      let active = campusMonthAuthors.get(key);
      if (!active) { active = new Set(); campusMonthAuthors.set(key, active); }
      active.add(r._id.a);
    }
  }
  totals.activeStudents = allAuthors.size;

  // Zero-filled axes. A range that ends in the future is filled up to today only; an open end uses the data.
  const today = zoned(now, tz).ymd;
  let lo = range.from || first;
  let hi = range.to || (last && last > today ? last : today);
  if (range.to && range.to > today) hi = last && last > today ? last : today;
  // A range too long for the day-by-day list starts its month / week axes at the first event instead of `from`:
  // "from=1900-01-01" must not fill the axes with a century of zeros (and run into their caps before the data begins).
  const tooLong = Boolean(lo && hi && daysBetween(lo, hi) + 1 > MAX_DAYS);
  if (tooLong && (!first || first > lo)) lo = first || hi;
  const out = { totals, byMonth: [], byWeek: [], byWeekday: [], byHour: [], heatmap: [], byCampusMonth: [], busiest: { day: null, week: null, month: null } };
  if (lo && hi && lo <= hi) {
    for (const m of monthsBetween(lo.slice(0, 7), hi.slice(0, 7))) {
      out.byMonth.push({ month: m, ...(months.get(m) || zero()), activeStudents: monthAuthors.get(m)?.size ?? 0 });
    }
    const days = daysBetween(lo, hi) + 1;
    if (!tooLong) {
      out.byDate = [];
      for (let i = 0; i < days; i++) { const d = addDays(lo, i); out.byDate.push({ date: d, ...(dates.get(d) || zero()) }); }
    } else out.truncated = true;
    const firstWeek = weekStartOf(lo, dowOf(lo));
    for (let w = firstWeek, i = 0; w <= hi && i < 1000; w = addDays(w, 7), i++) out.byWeek.push({ weekStart: w, ...(weeks.get(w) || zero()) });
  } else out.byDate = [];
  for (let d = 1; d <= 7; d++) out.byWeekday.push({ dow: d, ...(weekdays.get(d) || zero()) });
  for (let hh = 0; hh < 24; hh++) out.byHour.push({ hour: hh, ...(hours.get(hh) || zero()) });
  for (let d = 1; d <= 7; d++) for (let hh = 0; hh < 24; hh++) out.heatmap.push({ dow: d, hour: hh, ...(cells.get(`${d}-${hh}`) || zero()) });
  const campusRank = (x) => { const i = CAMPUSES.indexOf(x); return i < 0 ? CAMPUSES.length : i; };
  out.byCampusMonth = [...campusMonths.entries()].map(([key, v]) => {
    const [campus, month] = key.split('|');
    if (!cohorts) return { campus, month, ...v };
    const students = cohorts.get(campus) ?? 0;
    const active = campusMonthAuthors.get(key)?.size ?? 0;
    return { campus, month, ...v, students, per100Opened: per100(v.opened, students), per100Merged: per100(v.merged, students),
      activeStudents: active, activePct: per100(active, students) };
  }).sort((a, b) => campusRank(a.campus) - campusRank(b.campus) || (a.campus < b.campus ? -1 : a.campus > b.campus ? 1 : a.month < b.month ? -1 : 1));
  const best = (map) => { let top = null; for (const [key, v] of map) if (v[metric] > 0 && (!top || v[metric] > top[1] || (v[metric] === top[1] && key < top[0]))) top = [key, v[metric]]; return top; };
  const d = best(dates); const w = best(weeks); const m = best(months);
  if (d) out.busiest.day = { date: d[0], count: d[1] };
  if (w) out.busiest.week = { weekStart: w[0], count: w[1] };
  if (m) out.busiest.month = { month: m[0], count: m[1] };
  return out;
}

/** Monthly series { month, osOpened, osMerged, allOpened } for the months of the range (last 24 months when unbounded), in `tz`. */
export async function monthlySeries(db, { match = {}, range, tz = TZ, now = new Date() }) {
  const { prs } = collections(db);
  const today = zoned(now, tz).ymd;
  let lo = range.from;
  let hi = range.to && range.to < today ? range.to : today;
  if (!lo) {
    const [y, m] = hi.slice(0, 7).split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 - 23, 1));
    lo = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }
  if (lo > hi) hi = lo;
  // at most the last 120 months of the range (computed from the end: monthsBetween stops counting after 100 years)
  const [hy, hm] = hi.slice(0, 7).split('-').map(Number);
  const [ly, lm] = lo.slice(0, 7).split('-').map(Number);
  let first = lo.slice(0, 7);
  if ((hy - ly) * 12 + (hm - lm) + 1 > 120) {
    const d = new Date(Date.UTC(hy, hm - 1 - 119, 1));
    first = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const months = monthsBetween(first, hi.slice(0, 7));
  const month = (field) => ({ $dateToString: { format: '%Y-%m', date: field, timezone: tz } });
  const cond = inRange(range);
  const [opened, merged] = await Promise.all([
    prs.aggregate([
      { $match: allOf({ active: true }, match, cond ? { createdAt: cond } : {}) },
      { $group: { _id: month('$createdAt'), allOpened: { $sum: 1 }, osOpened: sumIf(OS) } },
    ], AGG).toArray(),
    prs.aggregate([
      { $match: allOf({ active: true, category: 'open_source', state: 'merged' }, match, cond ? { mergedAt: cond } : { mergedAt: { $type: 'date' } }) },
      { $group: { _id: month('$mergedAt'), osMerged: { $sum: 1 } } },
    ], AGG).toArray(),
  ]);
  const o = new Map(opened.map((r) => [r._id, r]));
  const m = new Map(merged.map((r) => [r._id, r]));
  return months.map((k) => ({ month: k, osOpened: o.get(k)?.osOpened ?? 0, osMerged: m.get(k)?.osMerged ?? 0, allOpened: o.get(k)?.allOpened ?? 0 }));
}
