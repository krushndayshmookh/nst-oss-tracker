// Campus comparisons (SPEC addenda D and F): per-student rates, stat blocks per campus × year, the previous-period
// comparison, participation funnel, tier mix, distribution / concentration, top orgs and repos per campus and the
// orgs several campuses share. Shapes: "API shapes (D, F)" in SPEC-ADDENDUM-dates.md.
//
// Every rate has the number of ACTIVE tracked students of the group as its denominator. A group without students has
// no rate: `rate()` returns null, never 0, Infinity or NaN.
import { collections } from './db.js';
import { CAMPUSES, CATEGORIES, TIERS, YEAR_LABELS, yearLabel } from './classify.js';
import { emptyByCategory } from './ingest.js';
import { TZ, addDays, dayStart, daysBetween, zoned } from './dates.js';
import { AGG, OS, allOf, and, eq, per100, rangeFlags, rangeMatch, studentStats, sumIf } from './ranged.js';

export const SMALL_COHORT = 30;
const round1 = (n) => Math.round(n * 10) / 10;
/** count per 100 students (also "% of students"), 1 decimal; null when the cohort is empty. */
export const rate = per100;
export const isSmall = (students) => students > 0 && students < SMALL_COHORT;

const campusIndex = (c) => { const i = CAMPUSES.indexOf(c); return i < 0 ? CAMPUSES.length : i; };
/** ADYPU, RU, SVYASA, SMRU, Unknown (anything else after them, alphabetically). */
export const byCampusOrder = (a, b) => campusIndex(a) - campusIndex(b) || (a < b ? -1 : a > b ? 1 : 0);
/** The campus of the enum that `name` spells (case-insensitive), or null. */
export const campusNamed = (name) => CAMPUSES.find((c) => c.toLowerCase() === String(name ?? '').trim().toLowerCase()) ?? null;

export const cohortOut = (campus, students) => ({ campus, students, smallCohort: isSmall(students) });

/**
 * The equal-length period right before `range`, or null when there is none (all time, or no `from`).
 * A range that ends in the future is cut at today first: half-way through an academic year the comparison is with
 * the same number of days before the year began, not with a whole year.
 */
export function previousRange(range, now = new Date(), tz = TZ) {
  if (!range?.from) return null;
  const today = zoned(now, tz).ymd;
  const to = range.to && range.to <= today ? range.to : today;
  if (to < range.from) return null; // the range has not begun
  const days = daysBetween(range.from, to) + 1;
  const from = addDays(range.from, -days);
  if (from < '1970-01-01') return null;
  return { from, to: addDays(range.from, -1), days, start: dayStart(from, tz), end: dayStart(range.from, tz), all: false };
}

// ---------- stat blocks ----------

const COUNTS = ['students', 'withAnyPr', 'withOsPr', 'withOsMerged', 'withMajorMerged', 'totalPrs', 'osPrs', 'osMerged', 'osMajorMerged'];
const emptyTiers = () => Object.fromEntries(TIERS.map((t) => [t, 0]));

function emptyBlock(campus, year, batch) {
  return { campus, year, batch, students: 0, withAnyPr: 0, withOsPr: 0, withOsMerged: 0, withMajorMerged: 0,
    totalPrs: 0, osPrs: 0, osMerged: 0, osMajorMerged: 0, byCategory: emptyByCategory(),
    osOpen: 0, osIssues: 0, osReviews: 0, withOsIssue: 0, withOsReview: 0,
    tierMix: { opened: emptyTiers(), merged: emptyTiers() }, contrib: [] };
}
/** Adds one student (its `stats` of the range, or nothing when it has no PR there) to a block. */
function addStudent(block, st) {
  st ||= {};
  block.students++;
  if (st.totalPrs > 0 || st.mergedPrs > 0) block.withAnyPr++;
  if (st.osPrs > 0 || st.osMerged > 0) block.withOsPr++;
  if (st.osMerged > 0) { block.withOsMerged++; block.contrib.push(st.osMerged); }
  if (st.osMajorMerged > 0) block.withMajorMerged++;
  block.totalPrs += st.totalPrs || 0;
  block.osPrs += st.osPrs || 0;
  block.osMerged += st.osMerged || 0;
  block.osMajorMerged += st.osMajorMerged || 0;
  for (const k of CATEGORIES) block.byCategory[k] += st.byCategory?.[k] || 0;
  // addendum I: stored stats may predate these keys
  block.osOpen += st.osOpen || 0;
  block.osIssues += st.osIssues || 0;
  block.osReviews += st.osReviews || 0;
  if (st.osIssues > 0) block.withOsIssue++;
  if (st.osReviews > 0) block.withOsReview++;
}

const rates = (b, students = b.students) => ({
  withAnyPrPct: rate(b.withAnyPr, students), withOsPrPct: rate(b.withOsPr, students),
  withOsMergedPct: rate(b.withOsMerged, students), withMajorMergedPct: rate(b.withMajorMerged, students),
  totalPrsPer100: rate(b.totalPrs, students), osPrsPer100: rate(b.osPrs, students),
  osMergedPer100: rate(b.osMerged, students), osMajorMergedPer100: rate(b.osMajorMerged, students),
});

/** Public stat block of a campus × year row, a campus total or the grand total. */
export function blockOut(b) {
  return {
    campus: b.campus, year: b.year, batch: b.batch,
    students: b.students, withAnyPr: b.withAnyPr, withOsPr: b.withOsPr, withOsMerged: b.withOsMerged, withMajorMerged: b.withMajorMerged,
    totalPrs: b.totalPrs, osPrs: b.osPrs, osMerged: b.osMerged, osMajorMerged: b.osMajorMerged, byCategory: { ...b.byCategory },
    osOpen: b.osOpen, osIssues: b.osIssues, osReviews: b.osReviews, withOsIssue: b.withOsIssue, withOsReview: b.withOsReview,
    smallCohort: isSmall(b.students), ...rates(b),
    tierMix: { opened: { ...b.tierMix.opened }, merged: { ...b.tierMix.merged } },
  };
}

const FUNNEL = [['tracked', 'Tracked students', 'students'], ['anyPr', 'Any PR', 'withAnyPr'], ['osPr', 'Open-source PR', 'withOsPr'],
  ['osMerged', 'Merged open-source PR', 'withOsMerged'], ['majorMerged', 'Merged in a major project', 'withMajorMerged']];
export const funnelOf = (b) => FUNNEL.map(([key, label, field]) => ({ key, label, count: b[field], pct: rate(b[field], b.students) }));

/**
 * How concentrated the merged open-source work is. `merged` = merged OS PRs of every contributor (student with >= 1).
 * buckets sum to contributors; top10PctShare = % of all merged OS PRs that came from the top ceil(10 %) contributors.
 */
export function distributionOf(merged) {
  const list = [...merged].sort((a, b) => b - a);
  const n = list.length;
  const buckets = { 1: 0, '2-4': 0, '5-9': 0, '10+': 0 };
  let sum = 0;
  for (const v of list) {
    sum += v;
    buckets[v >= 10 ? '10+' : v >= 5 ? '5-9' : v >= 2 ? '2-4' : 1]++;
  }
  const mid = Math.floor(n / 2);
  const top = n ? Math.max(1, Math.ceil(n * 0.1)) : 0;
  let topMerged = 0;
  for (let i = 0; i < top; i++) topMerged += list[i];
  return {
    contributors: n, buckets, median: n ? (n % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2) : null, max: n ? list[0] : 0,
    top10PctStudents: top, top10PctMerged: topMerged, top10PctShare: sum > 0 ? round1((topMerged / sum) * 100) : null,
  };
}

const PREV_COUNTS = COUNTS.filter((k) => k !== 'students');
const emptyPrev = () => Object.fromEntries(PREV_COUNTS.map((k) => [k, 0]));
/** `previous` block: the counts of the previous period with rates on TODAY's cohort (there is no historical roster). */
function previousOut(p, students) {
  return { students, ...p, withOsMergedPct: rate(p.withOsMerged, students), osPrsPer100: rate(p.osPrs, students),
    osMergedPer100: rate(p.osMerged, students), osMajorMergedPer100: rate(p.osMajorMerged, students) };
}
const diff = (a, b) => (a === null || b === null ? null : round1(a - b));
function deltaOut(cur, prev) {
  return {
    osMerged: cur.osMerged - prev.osMerged,
    osMergedPct: prev.osMerged > 0 ? round1(((cur.osMerged - prev.osMerged) / prev.osMerged) * 100) : null,
    osPrs: cur.osPrs - prev.osPrs, osMajorMerged: cur.osMajorMerged - prev.osMajorMerged, withOsMerged: cur.withOsMerged - prev.withOsMerged,
    withOsMergedPct: diff(cur.withOsMergedPct, prev.withOsMergedPct), osMergedPer100: diff(cur.osMergedPer100, prev.osMergedPer100),
  };
}

/** A campus total (or the grand total) with the addendum F extras. */
function totalOut(b, prev, hasPrevious) {
  const out = blockOut(b);
  const previous = hasPrevious ? previousOut(prev || emptyPrev(), b.students) : null;
  return { ...out, funnel: funnelOf(b), distribution: distributionOf(b.contrib), previous, delta: previous ? deltaOut(out, previous) : null };
}

// ---------- the whole comparison for one range ----------

const TOP_KEPT = 10; // orgs / repos kept per campus (the list page shows 5, the campus page 10)
const TOP_STUDENTS = 20;
const SHARED_MAX = 50;
const byWork = (a, b) => b.osMerged - a.osMerged || b.osPrs - a.osPrs || (a.id < b.id ? -1 : 1);

/**
 * Everything GET /api/campuses and GET /api/campuses/:campus answer with, for one range.
 * `ranged` is the Map of groupStats(by 'author') rows of the range (or a promise of it: it is awaited together with
 * the other queries), or null for all time (then the precomputed `stats` of the students are used).
 * `contribRanged` is the Map (or promise) of contribGroupStats(by 'author') rows of the same range, used with `ranged`.
 * The result is plain data and safe to cache.
 */
export async function campusComparison(db, { range, ranged = null, contribRanged = null, now = new Date(), tz = TZ }) {
  const c = collections(db);
  const prev = previousRange(range, now, tz);
  const { opened, merged } = rangeFlags(range);
  const prevFlags = prev ? rangeFlags(prev) : null;

  const allTime = !ranged;
  const [students, pairs, prevRows, perStudent, perStudentContrib] = await Promise.all([
    c.students.find({ active: true }, { projection: { campus: 1, batch: 1, ...(allTime && { stats: 1 }) } }).maxTimeMS(15000).toArray(),
    // open-source work of the range per student × repo × tier: tier mix, top orgs / repos and shared orgs all come from
    // these few thousand rows, and through the student they are attributed to the same campus as every other number
    c.prs.aggregate([
      { $match: allOf({ active: true, category: 'open_source' }, rangeMatch(range)) },
      { $group: { _id: { a: '$author', r: '$repoLc', t: '$tier' }, o: { $first: '$ownerLc' }, opened: sumIf(opened), merged: sumIf(merged) } },
    ], AGG).toArray(),
    prev ? c.prs.aggregate([
      { $match: allOf({ active: true }, rangeMatch(prev)) },
      { $group: { _id: '$author', totalPrs: sumIf(prevFlags.opened), mergedPrs: sumIf(prevFlags.merged),
        osPrs: sumIf(and(OS, prevFlags.opened)), osMerged: sumIf(and(OS, prevFlags.merged)),
        osMajorMerged: sumIf(and(OS, prevFlags.merged, eq('$tier', 'major'))) } },
    ], AGG).toArray() : [],
    ranged,
    allTime ? null : contribRanged,
  ]);
  ranged = perStudent;
  const contrib = perStudentContrib || new Map();

  // --- students -> blocks
  const rows = new Map();
  const totals = new Map();
  const total = emptyBlock('All', 'All', null);
  const where = new Map(); // student id -> { campus, row, campusTotal }
  const ranked = new Map(); // campus -> [{ id, osMerged, osPrs, stats }]
  for (const s of students) {
    const campus = s.campus || 'Unknown';
    const year = yearLabel(s.batch, now);
    const key = `${campus}\u0000${year}`;
    const batch = Number.isFinite(s.batch) ? s.batch : null;
    const st = ranged ? (ranged.has(s._id) || contrib.has(s._id) ? studentStats(ranged.get(s._id), contrib.get(s._id)) : null) : s.stats;
    let row = rows.get(key);
    if (!row) { row = emptyBlock(campus, year, batch); rows.set(key, row); } else if (row.batch !== batch) row.batch = null; // several batches share a label
    let campusTotal = totals.get(campus);
    if (!campusTotal) { campusTotal = emptyBlock(campus, 'All', null); totals.set(campus, campusTotal); ranked.set(campus, []); }
    addStudent(row, st);
    addStudent(campusTotal, st);
    addStudent(total, st);
    where.set(s._id, { campus, row, campusTotal });
    if (st?.osMerged > 0) ranked.get(campus).push({ id: s._id, osMerged: st.osMerged, osPrs: st.osPrs || 0, stats: st });
  }

  // --- tier mix, orgs and repos
  const orgs = new Map(); // campus -> Map<ownerLc, { id, osPrs, osMerged, students:Set }>
  const repos = new Map();
  const bump = (byCampus, campus, id, p) => {
    let map = byCampus.get(campus);
    if (!map) { map = new Map(); byCampus.set(campus, map); }
    let e = map.get(id);
    if (!e) { e = { id, osPrs: 0, osMerged: 0, students: new Set() }; map.set(id, e); }
    e.osPrs += p.opened;
    e.osMerged += p.merged;
    e.students.add(p._id.a);
  };
  for (const p of pairs) {
    if (!(p.opened > 0 || p.merged > 0)) continue;
    const at = where.get(p._id.a);
    if (!at) continue; // not an active student
    const tier = p._id.t;
    if (TIERS.includes(tier)) {
      for (const b of [at.row, at.campusTotal, total]) { b.tierMix.opened[tier] += p.opened; b.tierMix.merged[tier] += p.merged; }
    }
    bump(repos, at.campus, p._id.r, p);
    bump(orgs, at.campus, p.o, p);
  }
  const flat = (e) => ({ id: e.id, osPrs: e.osPrs, osMerged: e.osMerged, students: e.students.size });
  const topOf = (byCampus, campus) => [...(byCampus.get(campus)?.values() ?? [])].map(flat).sort(byWork).slice(0, TOP_KEPT);
  /** The same lists for all campuses together: a student belongs to one campus, so the student counts add up. */
  const topOverall = (byCampus) => {
    const all = new Map();
    for (const map of byCampus.values()) {
      for (const e of map.values()) {
        const t = all.get(e.id) || { id: e.id, osPrs: 0, osMerged: 0, students: 0 };
        t.osPrs += e.osPrs; t.osMerged += e.osMerged; t.students += e.students.size;
        all.set(e.id, t);
      }
    }
    return [...all.values()].sort(byWork).slice(0, TOP_KEPT);
  };
  const top = { orgs: new Map(), repos: new Map() };
  for (const campus of totals.keys()) { top.orgs.set(campus, topOf(orgs, campus)); top.repos.set(campus, topOf(repos, campus)); }
  top.orgs.set('All', topOverall(orgs));
  top.repos.set('All', topOverall(repos));

  // orgs with open-source work from students of two or more campuses ('Unknown' is not a campus)
  const sharing = new Map();
  for (const [campus, map] of orgs) {
    if (campus === 'Unknown') continue;
    for (const e of map.values()) {
      let list = sharing.get(e.id);
      if (!list) { list = []; sharing.set(e.id, list); }
      list.push({ campus, ...flat(e) });
    }
  }
  const shared = [];
  for (const [id, list] of sharing) {
    if (list.length < 2) continue;
    list.sort((a, b) => byCampusOrder(a.campus, b.campus));
    shared.push({ id, campuses: list.length, osPrs: list.reduce((n, x) => n + x.osPrs, 0), osMerged: list.reduce((n, x) => n + x.osMerged, 0),
      students: list.reduce((n, x) => n + x.students, 0), byCampus: list.map(({ id: _, ...x }) => x) });
  }
  shared.sort(byWork);
  shared.length = Math.min(shared.length, SHARED_MAX);

  // --- names of the repos / owners that are shown
  const repoIds = new Set();
  const ownerIds = new Set(shared.map((s) => s.id));
  for (const list of top.repos.values()) for (const e of list) repoIds.add(e.id);
  for (const list of top.orgs.values()) for (const e of list) ownerIds.add(e.id);
  const [repoDocs, ownerDocs] = await Promise.all([
    repoIds.size ? c.repos.find({ _id: { $in: [...repoIds] } }, { projection: { name: 1, stars: 1, tier: 1 } }).toArray() : [],
    ownerIds.size ? c.owners.find({ _id: { $in: [...ownerIds] } }, { projection: { login: 1 } }).toArray() : [],
  ]);
  const repoById = new Map(repoDocs.map((d) => [d._id, d]));
  const loginOf = new Map(ownerDocs.map((d) => [d._id, d.login]));
  const orgOut = ({ id, ...e }) => ({ login: loginOf.get(id) ?? id, ...e });
  const repoOut = ({ id, ...e }) => ({ name: repoById.get(id)?.name ?? id, stars: repoById.get(id)?.stars ?? 0, tier: repoById.get(id)?.tier ?? null, ...e });

  // --- previous period
  const prevByCampus = new Map();
  const prevTotal = emptyPrev();
  for (const g of prevRows) {
    const at = where.get(g._id);
    if (!at) continue;
    let p = prevByCampus.get(at.campus);
    if (!p) { p = emptyPrev(); prevByCampus.set(at.campus, p); }
    for (const t of [p, prevTotal]) {
      if (g.totalPrs > 0 || g.mergedPrs > 0) t.withAnyPr++;
      if (g.osPrs > 0 || g.osMerged > 0) t.withOsPr++;
      if (g.osMerged > 0) t.withOsMerged++;
      if (g.osMajorMerged > 0) t.withMajorMerged++;
      t.totalPrs += g.totalPrs; t.osPrs += g.osPrs; t.osMerged += g.osMerged; t.osMajorMerged += g.osMajorMerged;
    }
  }

  const campuses = [...totals.keys()].sort(byCampusOrder);
  const rowList = [...rows.values()].sort((a, b) => byCampusOrder(a.campus, b.campus) || YEAR_LABELS.indexOf(a.year) - YEAR_LABELS.indexOf(b.year));
  const withTops = (campus, block) => ({ ...block, topOrgs: top.orgs.get(campus).map(orgOut), topRepos: top.repos.get(campus).map(repoOut) });
  return {
    previousRange: prev ? { from: prev.from, to: prev.to, days: prev.days } : null,
    smallCohortBelow: SMALL_COHORT,
    // the scorecard list: the four campuses always, Unknown (or anything unexpected) only when it has students
    campuses: [...new Set([...CAMPUSES.filter((x) => x !== 'Unknown'), ...campuses])].sort(byCampusOrder).map((x) => cohortOut(x, totals.get(x)?.students ?? 0)),
    rows: rowList.map((b) => ({ ...blockOut(b), distribution: distributionOf(b.contrib) })),
    totals: campuses.map((x) => withTops(x, totalOut(totals.get(x), prevByCampus.get(x), Boolean(prev)))),
    total: withTops('All', totalOut(total, prevTotal, Boolean(prev))),
    sharedOrgs: shared.map(orgOut),
    // the best students of each campus with their stats of the range (the campus page adds name and username)
    topStudents: new Map(campuses.map((x) => [x, ranked.get(x).sort(byWork).slice(0, TOP_STUDENTS).map((e) => ({ id: e.id, stats: e.stats }))])),
  };
}

/** The block of a campus of the enum that has no student: zeros and null rates. */
export function emptyCampusTotal(campus, hasPrevious) {
  return { ...totalOut(emptyBlock(campus, 'All', null), null, hasPrevious), topOrgs: [], topRepos: [] };
}

/** Removes the per-list extras so that a block can be shown as plain context ("all campuses"). */
export function plainBlock({ funnel, distribution, previous, delta, topOrgs, topRepos, ...block }) {
  return block;
}
