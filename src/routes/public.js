// Public read-only API (SPEC section 5, Appendix A, addendum A). Counts only active students / PRs.
//
// Date ranges: every endpoint that returns counts or lists takes `from` / `to` (YYYY-MM-DD, days in config.tzName) or
// `range=<preset>`; with none of them the current academic year applies, `range=all` is all time. The response echoes
// `range: { from, to, label, preset }`. With a bounded range the `stats` objects keep their keys but hold ranged numbers
// (opened = createdAt in range, merged = mergedAt in range); with `range=all` they are the precomputed all-time stats.
import express from 'express';
import { collections } from '../db.js';
import { CATEGORIES, TIERS, YEAR_LABELS, yearLabel } from '../classify.js';
import { SMALL_COHORT, byCampusOrder, campusComparison, campusNamed, cohortOut, emptyCampusTotal, plainBlock, rate } from '../campuses.js';
import { emptyByCategory, emptyStudentStats } from '../ingest.js';
import { loadRules } from '../rules.js';
import { csvLine } from '../csv.js';
import { ApiError, notFound } from '../auth.js';
import { createCache, generation } from '../cache.js';
import { repoTechMap, techBase, techMix, techView, LANG_NONE } from '../tech.js';
import { RangeError400, TZ, inRange, loadAcademicYear, presets, rangeOut, resolveRange } from '../dates.js';
import {
  AGG, OS, activity, allOf, and, contribGroupStats, groupStats, monthlySeries, ownerStats, rangeFlags, rangeMatch, repoStats, studentStats, sumIf,
} from '../ranged.js';
import {
  COLLATION, STATES, badRequest, cohortFilter, contains, contribKind, contributionFilter, contributionOut, contributionPage, escapeRegex, findStudent,
  flag, iso, lc, oneOf, orgOut, paging, prFilter, prOut, prPage, prRangeFilter, repoOut, rulesOut, search, sorting, str, studentOut,
} from './common.js';

const PUBLIC_STUDENT = { username: 1, name: 1, campus: 1, batch: 1, stats: 1 };
const T = 15000; // maxTimeMS of public finds
// Query parameters that can change a response; anything else is ignored and must not create new cache entries.
export const RESPONSE_CACHE_BYTES = 32 * 1024 * 1024;
export const GROUPS_PRESET = 9; // e.g. 3 ranges x (students, repos, orgs)
export const GROUPS_CUSTOM = 3;
const KNOWN_PARAMS = ['campus', 'year', 'batch', 'category', 'state', 'tier', 'q', 'from', 'to', 'range', 'sort', 'order', 'page', 'limit',
  'author', 'repo', 'owner', 'hasOs', 'metric', 'by', 'language', 'domain', 'kind', 'hasContribution'];

const collator = new Intl.Collator('en', { sensitivity: 'accent' });
/** Mongo sort spec: the chosen field, then a tie-breaker (skipped when it is the chosen field itself, or it would overwrite the direction), then _id. */
const sortSpec = (field, dir, tie) => ({ [field]: dir, ...(tie !== field && { [tie]: -1 }), _id: 1 });
const time = (d) => (d ? new Date(d).getTime() : 0);

export function publicRouter({ db, auth, config = {}, cache = null }) {
  const r = express.Router();
  const c = collections(db);
  const tz = config.tzName || TZ;
  // Response bodies: bounded by count and by size (a visitor chooses the query, so the cache must not grow with it).
  cache ??= createCache({ ttlMs: config.publicCacheMs ?? 0, maxBytes: RESPONSE_CACHE_BYTES });
  // Whole-dataset maps of ranged numbers are large (thousands of rows each), so they live in two small LRUs of their
  // own: one for the preset ranges every visitor shares, one for custom ranges (enough to page through a list).
  // Any number of distinct custom ranges therefore pins at most GROUPS_CUSTOM maps; the rest is computed and dropped.
  const groupTtl = cache.enabled ? (config.publicCacheMs || 60000) : 0;
  const presetGroups = createCache({ ttlMs: groupTtl, max: GROUPS_PRESET });
  const customGroups = createCache({ ttlMs: groupTtl, max: GROUPS_CUSTOM });
  // the contribution counterparts (addendum I5), memoised the same way in caches of their own
  const presetContribGroups = createCache({ ttlMs: groupTtl, max: GROUPS_PRESET });
  const customContribGroups = createCache({ ttlMs: groupTtl, max: GROUPS_CUSTOM });
  const contribs = db.collection('contributions');

  r.get('/health', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      await db.command({ ping: 1 });
      res.json({ ok: true });
    } catch {
      res.status(503).json({ error: { code: 'unavailable', message: 'database unreachable' } });
    }
  });

  // Public responses are cacheable for a minute, in the browser / CDN and in this process (identical queries are answered
  // from memory; the cache is dropped on any admin write and when a job ends). A logged-in admin always gets fresh data.
  r.use((req, res, next) => {
    const admin = Boolean(auth?.isAdmin(req));
    req.isAdmin = admin;
    if (admin) res.set('Cache-Control', 'private, no-store');
    else res.set('Cache-Control', 'public, max-age=60');
    res.set('Vary', 'Cookie');
    if (req.method !== 'GET' || admin || !cache.enabled || req.path.startsWith('/export/')) return next();
    // One value per known parameter, in a fixed order, JSON-encoded: free text (q, author, repo, owner) that contains
    // `&from=...` can never produce the key of a different request.
    const key = `res:${JSON.stringify([req.path, KNOWN_PARAMS.map((k) => str(req.query, k))])}`;
    const startedAt = generation();
    const hit = cache.get(key);
    if (typeof hit === 'string') {
      res.set('X-Cache', 'hit');
      return res.type('json').send(hit);
    }
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode !== 200) return json(body);
      const text = JSON.stringify(body);
      // an admin write or a job that ended while this was being computed dropped the cache: the body may predate it
      if (generation() === startedAt) cache.set(key, text);
      res.set('X-Cache', 'miss');
      return res.type('json').send(text);
    };
    next();
  });

  // ---------- ranges ----------

  const academicYear = (now) => cache.memo('ay', () => loadAcademicYear(db, now, tz));

  async function rangeOf(req, now = new Date()) {
    try {
      return resolveRange({ from: str(req.query, 'from'), to: str(req.query, 'to'), range: str(req.query, 'range') }, await academicYear(now), now, tz);
    } catch (e) {
      if (e instanceof RangeError400) throw badRequest(e.message);
      throw e;
    }
  }
  const rangeKey = (range) => `${range.from || ''}|${range.to || ''}`;
  /** Map<id, groupStats row> for the whole dataset in a range, shared by lists, campus table and exports. */
  const grouped = (by, range) => (range.preset ? presetGroups : customGroups).memo(`g:${by}:${rangeKey(range)}`, () => groupStats(db, { by, range }));
  /** Map<id, contribGroupStats row> for the whole dataset in a range. */
  const contribGrouped = (by, range) => (range.preset ? presetContribGroups : customContribGroups)
    .memo(`cg:${by}:${rangeKey(range)}`, () => contribGroupStats(db, { by, range }));
  /** createdAt filter of contributions in a range ({} when unbounded). */
  const createdIn = (range) => { const cond = inRange(range); return cond ? { createdAt: cond } : {}; };

  r.get('/meta', async (req, res) => {
    const now = new Date();
    const [campuses, batches, students, prs, syncJob, importJob, lastSynced, rules, ay, schedule, issues, reviews] = await Promise.all([
      c.students.distinct('campus', { active: true }),
      c.students.distinct('batch', { active: true }),
      c.students.countDocuments({ active: true }),
      c.prs.countDocuments({ active: true }),
      c.jobs.find({ type: 'sync', status: 'done' }, { projection: { finishedAt: 1 } }).sort({ finishedAt: -1 }).limit(1).next(),
      c.jobs.find({ type: 'import', status: 'done' }, { projection: { finishedAt: 1 } }).sort({ finishedAt: -1 }).limit(1).next(),
      c.students.find({ lastSyncedAt: { $type: 'date' } }, { projection: { lastSyncedAt: 1 } }).sort({ lastSyncedAt: -1 }).limit(1).next(),
      loadRules(db),
      academicYear(now),
      c.settings.findOne({ _id: 'schedule' }, { projection: { paused: 1, pausedUntil: 1, enabled: 1 } }),
      contribs.countDocuments({ active: true, kind: 'issue' }, { maxTimeMS: T }),
      contribs.countDocuments({ active: true, kind: 'review' }, { maxTimeMS: T }),
    ]);
    const labels = new Set(batches.map((b) => yearLabel(b, now)));
    const paused = Boolean(schedule?.paused) && !(schedule.pausedUntil instanceof Date && schedule.pausedUntil <= now);
    res.json({
      campuses: campuses.filter(Boolean).sort(),
      years: YEAR_LABELS.filter((y) => labels.has(y)),
      batches: batches.filter((b) => Number.isFinite(b)).sort((a, b) => b - a),
      categories: CATEGORIES, tiers: TIERS, kinds: ['pr', 'issue', 'review'], features: { contributions: true },
      // finish time of the last successful sync; before the first sync, the import or the newest per-student fetch time
      lastSyncAt: iso(syncJob?.finishedAt ?? importJob?.finishedAt ?? lastSynced?.lastSyncedAt ?? null),
      updatesPaused: paused,
      counts: { students, prs, issues, reviews },
      rulesSummary: rulesOut(rules),
      academicYear: ay, tz, presets: presets(ay, now, tz),
      techDomains: (await repoTechMap(db)).compiled.domains, // [{key, label}] of addendum H
    });
  });

  // ---------- overview ----------

  r.get('/overview', async (req, res) => {
    const now = new Date();
    const range = await rangeOf(req, now);
    const cohort = cohortFilter({ campus: req.query.campus, year: req.query.year }, now);
    const hasCohort = Object.keys(cohort).length > 0;
    const { opened, merged } = rangeFlags(range);
    const prMatch = allOf({ active: true }, cohort, rangeMatch(range));
    const top = (field) => [
      { $match: allOf({ active: true, category: 'open_source' }, cohort, rangeMatch(range)) },
      { $group: { _id: field, osPrs: sumIf(opened), osMerged: sumIf(merged), students: { $addToSet: '$author' } } },
      { $project: { osPrs: 1, osMerged: 1, students: { $size: '$students' } } },
      { $sort: { osMerged: -1, osPrs: -1, _id: 1 } },
      { $limit: 10 },
    ];

    // per-student numbers: the all-time stats are precomputed, ranged ones come from one $group over the PRs
    const studentNumbers = async () => {
      const tracked = await c.students.countDocuments({ active: true, ...cohort }, { maxTimeMS: T });
      if (range.all) {
        const [agg, topDocs] = await Promise.all([
          c.students.aggregate([
            { $match: { active: true, ...cohort } },
            { $group: { _id: null,
              withAnyPr: sumIf({ $gt: ['$stats.totalPrs', 0] }), withOsPr: sumIf({ $gt: ['$stats.osPrs', 0] }),
              withOsMerged: sumIf({ $gt: ['$stats.osMerged', 0] }), withMajorMerged: sumIf({ $gt: ['$stats.osMajorMerged', 0] }),
              // addendum I: stored stats may predate the new keys
              withOsIssue: sumIf({ $gt: [{ $ifNull: ['$stats.osIssues', 0] }, 0] }), withOsReview: sumIf({ $gt: [{ $ifNull: ['$stats.osReviews', 0] }, 0] }),
              withOsContribution: sumIf({ $gt: [{ $add: [{ $ifNull: ['$stats.osPrs', 0] }, { $ifNull: ['$stats.osIssues', 0] }, { $ifNull: ['$stats.osReviews', 0] }] }, 0] }) } },
          ], AGG).toArray(),
          c.students.find({ active: true, ...cohort, 'stats.osMerged': { $gt: 0 } }, { projection: PUBLIC_STUDENT })
            .sort({ 'stats.osMerged': -1, 'stats.osPrs': -1, _id: 1 }).limit(10).maxTimeMS(T).toArray(),
        ]);
        const a = agg[0] || {};
        return { counts: { tracked, withAnyPr: a.withAnyPr ?? 0, withOsPr: a.withOsPr ?? 0, withOsMerged: a.withOsMerged ?? 0, withMajorMerged: a.withMajorMerged ?? 0,
          withOsIssue: a.withOsIssue ?? 0, withOsReview: a.withOsReview ?? 0, withOsContribution: a.withOsContribution ?? 0 },
          top: topDocs.map((d) => studentOut(d, now)) };
      }
      const [rows, contribRows] = hasCohort
        ? await Promise.all([groupStats(db, { by: 'author', range, match: cohort }), contribGroupStats(db, { by: 'author', range, match: cohort })])
        : await Promise.all([grouped('author', range), contribGrouped('author', range)]);
      const counts = { tracked, withAnyPr: 0, withOsPr: 0, withOsMerged: 0, withMajorMerged: 0, withOsIssue: 0, withOsReview: 0, withOsContribution: 0 };
      const ranked = [];
      const contributors = new Set();
      for (const g of rows.values()) {
        if (g.opened > 0 || g.merged > 0) counts.withAnyPr++;
        if (g.osOpened > 0 || g.osMerged > 0) { counts.withOsPr++; contributors.add(g._id); }
        if (g.osMerged > 0) { counts.withOsMerged++; ranked.push(g); }
        if (g.osMajorMerged > 0) counts.withMajorMerged++;
      }
      for (const g of contribRows.values()) {
        if (g.osIssues > 0) counts.withOsIssue++;
        if (g.osReviews > 0) counts.withOsReview++;
        if (g.osIssues > 0 || g.osReviews > 0) contributors.add(g._id);
      }
      counts.withOsContribution = contributors.size;
      ranked.sort((a, b) => b.osMerged - a.osMerged || b.osOpened - a.osOpened || (a._id < b._id ? -1 : 1));
      const best = ranked.slice(0, 10);
      const docs = await c.students.find({ _id: { $in: best.map((g) => g._id) }, active: true }, { projection: PUBLIC_STUDENT }).toArray();
      const byId = new Map(docs.map((d) => [d._id, d]));
      return { counts, top: best.filter((g) => byId.has(g._id)).map((g) => studentOut({ ...byId.get(g._id), stats: studentStats(g, contribRows.get(g._id)) }, now)) };
    };

    const [studentPart, groups, topRepos, topOrgs, series, contribGroups] = await Promise.all([
      studentNumbers(),
      c.prs.aggregate([{ $match: prMatch }, { $group: { _id: { c: '$category', s: '$state', t: '$tier' }, opened: sumIf(opened), merged: sumIf(merged) } }], AGG).toArray(),
      c.prs.aggregate(top('$repoLc'), AGG).toArray(),
      c.prs.aggregate(top('$ownerLc'), AGG).toArray(),
      monthlySeries(db, { match: cohort, range, tz, now }),
      contribs.aggregate([
        { $match: allOf({ active: true }, cohort, createdIn(range)) },
        { $group: { _id: { k: '$kind', c: '$category', s: '$state' }, n: { $sum: 1 } } },
      ], AGG).toArray(),
    ]);
    const [repoDocs, ownerDocs] = await Promise.all([
      c.repos.find({ _id: { $in: topRepos.map((t) => t._id) } }, { projection: { name: 1, stars: 1, tier: 1 } }).toArray(),
      c.owners.find({ _id: { $in: topOrgs.map((t) => t._id) } }, { projection: { login: 1 } }).toArray(),
    ]);
    const repoById = new Map(repoDocs.map((d) => [d._id, d]));
    const ownerById = new Map(ownerDocs.map((d) => [d._id, d]));

    const prs = { total: 0, merged: 0, osPrs: 0, osMerged: 0, osOpen: 0, byCategory: emptyByCategory(),
      byState: Object.fromEntries(STATES.map((s) => [s, 0])), osMergedByTier: Object.fromEntries(TIERS.map((t) => [t, 0])) };
    for (const g of groups) {
      const { c: cat, s: state, t: tier } = g._id;
      prs.total += g.opened;
      prs.merged += g.merged;
      if (cat in prs.byCategory) prs.byCategory[cat] += g.opened;
      if (state in prs.byState) prs.byState[state] += g.opened;
      if (cat === 'open_source') {
        prs.osPrs += g.opened;
        if (state === 'open') prs.osOpen += g.opened;
        prs.osMerged += g.merged;
        if (tier in prs.osMergedByTier) prs.osMergedByTier[tier] += g.merged;
      }
    }
    // addendum I5: open-source PRs opened in the range by current state, issues and reviews created in the range
    const contributions = { osPrsOpen: 0, osPrsMerged: prs.osMerged, osPrsClosed: 0, osIssues: 0, osIssuesOpen: 0, osIssuesClosed: 0,
      osReviews: 0, osApprovals: 0, osChangesRequested: 0, totalIssues: 0, totalReviews: 0 };
    for (const g of groups) {
      if (g._id.c !== 'open_source') continue;
      if (g._id.s === 'open') contributions.osPrsOpen += g.opened;
      if (g._id.s === 'closed') contributions.osPrsClosed += g.opened;
    }
    for (const g of contribGroups) {
      const { k: kind, c: cat, s: state } = g._id;
      const os = cat === 'open_source';
      if (kind === 'issue') {
        contributions.totalIssues += g.n;
        if (os) {
          contributions.osIssues += g.n;
          if (state === 'open') contributions.osIssuesOpen += g.n;
          if (state === 'closed') contributions.osIssuesClosed += g.n;
        }
      } else if (kind === 'review') {
        contributions.totalReviews += g.n;
        if (os) {
          contributions.osReviews += g.n;
          if (state === 'approved') contributions.osApprovals += g.n;
          if (state === 'changes_requested') contributions.osChangesRequested += g.n;
        }
      }
    }
    res.json({
      range: rangeOut(range),
      filters: { campus: str(req.query, 'campus') || null, year: str(req.query, 'year') || null },
      students: studentPart.counts,
      prs,
      contributions,
      topRepos: topRepos.filter((t) => t.osPrs > 0 || t.osMerged > 0).map((t) => ({ name: repoById.get(t._id)?.name ?? t._id, stars: repoById.get(t._id)?.stars ?? 0,
        tier: repoById.get(t._id)?.tier ?? null, osPrs: t.osPrs, osMerged: t.osMerged, students: t.students })),
      topOrgs: topOrgs.filter((t) => t.osPrs > 0 || t.osMerged > 0).map((t) => ({ login: ownerById.get(t._id)?.login ?? t._id, osPrs: t.osPrs, osMerged: t.osMerged, students: t.students })),
      topStudents: studentPart.top,
      monthly: series,
    });
  });

  // ---------- campuses (addenda D and F) ----------

  // One comparison per range feeds the list and every campus page; it is small, so a handful are kept.
  const comparisons = createCache({ ttlMs: groupTtl, max: 6 });
  const comparison = (range, now) => comparisons.memo(`c:${rangeKey(range)}`, () =>
    campusComparison(db, { range, ranged: range.all ? null : grouped('author', range), contribRanged: range.all ? null : contribGrouped('author', range), now, tz }));
  const top = (list, n) => list.slice(0, n);

  r.get('/campuses', async (req, res) => {
    const now = new Date();
    const range = await rangeOf(req, now);
    const d = await comparison(range, now);
    const five = (b) => ({ ...b, topOrgs: top(b.topOrgs, 5), topRepos: top(b.topRepos, 5) });
    res.json({
      range: rangeOut(range), previousRange: d.previousRange, smallCohortBelow: d.smallCohortBelow, campuses: d.campuses,
      rows: d.rows, totals: d.totals.map(five), total: five(d.total), sharedOrgs: d.sharedOrgs,
    });
  });

  r.get('/campuses/:campus', async (req, res) => {
    const campus = campusNamed(req.params.campus);
    if (!campus) throw notFound('campus not found');
    const now = new Date();
    const range = await rangeOf(req, now);
    const [d, series] = await Promise.all([comparison(range, now), monthlySeries(db, { match: { campus }, range, tz, now })]);
    const { topOrgs, topRepos, ...totals } = d.totals.find((t) => t.campus === campus) || emptyCampusTotal(campus, Boolean(d.previousRange));
    const best = d.topStudents.get(campus) || [];
    const docs = best.length ? await c.students.find({ _id: { $in: best.map((e) => e.id) }, active: true }, { projection: { username: 1, name: 1, campus: 1, batch: 1 } }).toArray() : [];
    const byId = new Map(docs.map((s) => [s._id, s]));
    res.json({
      range: rangeOut(range), previousRange: d.previousRange, smallCohortBelow: d.smallCohortBelow, campus,
      totals, overall: plainBlock(d.total),
      years: d.rows.filter((row) => row.campus === campus),
      monthly: series.map((m) => ({ ...m, osOpenedPer100: rate(m.osOpened, totals.students), osMergedPer100: rate(m.osMerged, totals.students) })),
      topStudents: best.filter((e) => byId.has(e.id)).map((e) => studentOut({ ...byId.get(e.id), stats: e.stats }, now)),
      topRepos, topOrgs,
      sharedOrgs: d.sharedOrgs.filter((o) => o.byCampus.some((x) => x.campus === campus)),
    });
  });

  /** Active tracked students per campus under the campus / year / batch filters of a query (addendum D denominators). */
  async function cohortSizes(query, now) {
    const groups = await c.students.aggregate([{ $match: { active: true, ...cohortFilter(query, now) } }, { $group: { _id: '$campus', n: { $sum: 1 } } }], AGG).toArray();
    const sizes = new Map();
    for (const g of groups) sizes.set(g._id || 'Unknown', (sizes.get(g._id || 'Unknown') || 0) + g.n);
    return sizes;
  }

  // ---------- technologies (addendum H) ----------

  // The PR data behind both views (language / domain) of one range + category + cohort is computed once and shared.
  const techBases = createCache({ ttlMs: groupTtl, max: 12 });

  r.get('/tech', async (req, res) => {
    const now = new Date();
    const range = await rangeOf(req, now);
    const by = oneOf(req.query, 'by', ['language', 'domain'], 'language');
    const category = oneOf(req.query, 'category', [...CATEGORIES, 'all'], 'open_source');
    const cohort = cohortFilter(req.query, now);
    const key = JSON.stringify([rangeKey(range), category, cohort]);
    const [base, sizes] = await Promise.all([
      techBases.memo(key, () => techBase(db, { range, category, cohort, tz })),
      cohortSizes(req.query, now),
    ]);
    res.json({
      range: rangeOut(range), category,
      filters: { campus: str(req.query, 'campus') || null, year: str(req.query, 'year') || null, batch: str(req.query, 'batch') || null },
      ...techView(base, { by, cohorts: sizes, range, now, tz, smallCohortBelow: SMALL_COHORT }),
    });
  });

  /** Language and domain mix of the PRs matching `match` in the range (student profile, org page). */
  async function techOf(match, range) {
    const { opened, merged } = rangeFlags(range);
    const [groups, repos] = await Promise.all([
      c.prs.aggregate([
        { $match: allOf({ active: true }, match, rangeMatch(range)) },
        { $group: { _id: '$repoLc', prs: sumIf(opened), merged: sumIf(merged), osPrs: sumIf(and(OS, opened)), osMerged: sumIf(and(OS, merged)) } },
      ], AGG).toArray(),
      repoTechMap(db),
    ]);
    return techMix(groups, repos.map, repos.compiled);
  }

  // ---------- activity (addendum A3) ----------

  r.get('/activity', async (req, res) => {
    const now = new Date();
    const range = await rangeOf(req, now);
    const metric = oneOf(req.query, 'metric', ['opened', 'merged', 'issues', 'reviews'], 'opened');
    const match = { ...cohortFilter(req.query, now) };
    const category = oneOf(req.query, 'category', [...CATEGORIES, 'all'], 'open_source');
    if (category !== 'all') match.category = category;
    const author = str(req.query, 'author');
    if (author) match.author = (await findStudent(db, author))?._id ?? lc(author);
    const repo = str(req.query, 'repo');
    if (repo) match.repoLc = lc(repo);
    const owner = str(req.query, 'owner');
    if (owner) match.ownerLc = lc(owner);
    // cohort sizes for per-100 rates: active tracked students under the same campus / year / batch filters (addendum D)
    const sizes = await cohortSizes(req.query, now);
    const a = await activity(db, { match, range, metric, tz, now, cohorts: sizes });
    for (const row of a.byCampusMonth) if (!sizes.has(row.campus)) sizes.set(row.campus, 0);
    const { busiest, byDate, truncated, ...rest } = a;
    res.json({
      range: rangeOut(range), tz, metric, ...rest,
      cohorts: [...sizes.keys()].sort(byCampusOrder).map((x) => cohortOut(x, sizes.get(x))), smallCohortBelow: SMALL_COHORT,
      busiest, ...(byDate && { byDate }), ...(truncated && { truncated }),
    });
  });

  // ---------- students ----------

  const STUDENT_SORTS = ['osMerged', 'osPrs', 'totalPrs', 'name', 'lastPrAt', 'osOpen', 'osIssues', 'osReviews', 'osContributions', 'lastActivityAt'];
  const STUDENT_SORT = { osMerged: 'stats.osMerged', osPrs: 'stats.osPrs', totalPrs: 'stats.totalPrs', name: 'name', lastPrAt: 'stats.lastPrAt',
    osOpen: 'stats.osOpen', osIssues: 'stats.osIssues', osReviews: 'stats.osReviews', osContributions: 'stats.osContributions', lastActivityAt: 'stats.lastActivityAt' };
  /** osContributions of a stats object, also when stored stats predate the key. */
  const osContribOf = (st) => st.osContributions ?? ((st.osPrs ?? 0) + (st.osIssues ?? 0) + (st.osReviews ?? 0));

  function studentFilter(query) {
    const f = { active: true, ...cohortFilter(query) };
    const q = search(query);
    if (q) f.$or = [{ name: contains(q) }, { username: contains(q) }];
    return f;
  }

  /** Every student matching the filters with the stats of the range, sorted. Ranged lists are sorted here, not by Mongo. */
  async function studentRows(query, range, { sort = 'osMerged', dir = -1 } = {}) {
    const f = studentFilter(query);
    const hasOs = flag(query, 'hasOs') === true;
    const hasContribution = flag(query, 'hasContribution') === true;
    const [ranged, contrib] = range.all ? [null, null] : await Promise.all([grouped('author', range), contribGrouped('author', range)]);
    const docs = await c.students.find(f, { projection: ranged ? { username: 1, name: 1, campus: 1, batch: 1 } : PUBLIC_STUDENT }).maxTimeMS(T).toArray();
    let rows = docs.map((d) => ({ ...d, stats: ranged ? studentStats(ranged.get(d._id), contrib.get(d._id)) : (d.stats || emptyStudentStats()) }));
    if (hasOs) rows = rows.filter((s) => s.stats.osPrs > 0 || s.stats.osMerged > 0);
    if (hasContribution) rows = rows.filter((s) => osContribOf(s.stats) > 0);
    const value = {
      osMerged: (s) => s.stats.osMerged, osPrs: (s) => s.stats.osPrs, totalPrs: (s) => s.stats.totalPrs, lastPrAt: (s) => time(s.stats.lastPrAt),
      osOpen: (s) => s.stats.osOpen ?? 0, osIssues: (s) => s.stats.osIssues ?? 0, osReviews: (s) => s.stats.osReviews ?? 0, osContributions: (s) => osContribOf(s.stats),
      lastActivityAt: (s) => time(s.stats.lastActivityAt),
    }[sort];
    rows.sort((a, b) => (sort === 'name' ? dir * collator.compare(a.name || '', b.name || '') : dir * (value(a) - value(b)))
      || b.stats.osPrs - a.stats.osPrs || (a._id < b._id ? -1 : 1));
    return rows;
  }

  r.get('/students', async (req, res) => {
    const { page, limit, skip } = paging(req.query);
    const { sort, dir } = sorting(req.query, STUDENT_SORTS, 'osMerged');
    const now = new Date();
    const range = await rangeOf(req, now);
    if (!range.all) {
      const rows = await studentRows(req.query, range, { sort, dir });
      return res.json({ range: rangeOut(range), items: rows.slice(skip, skip + limit).map((s) => studentOut(s, now)), total: rows.length, page, limit });
    }
    const f = studentFilter(req.query);
    if (flag(req.query, 'hasOs')) f['stats.osPrs'] = { $gt: 0 };
    if (flag(req.query, 'hasContribution')) f['stats.osContributions'] = { $gt: 0 };
    const [rows, total] = await Promise.all([
      c.students.find(f, { projection: PUBLIC_STUDENT }).collation(COLLATION).sort(sortSpec(STUDENT_SORT[sort], dir, 'stats.osPrs'))
        .skip(skip).limit(limit).maxTimeMS(T).toArray(),
      c.students.countDocuments(f, { maxTimeMS: T }),
    ]);
    res.json({ range: rangeOut(range), items: rows.map((s) => studentOut(s, now)), total, page, limit });
  });

  r.get('/students/:username', async (req, res) => {
    const s = await findStudent(db, req.params.username);
    if (!s || s.active === false) throw notFound('student not found');
    const now = new Date();
    const range = await rangeOf(req, now);
    const admin = req.isAdmin;
    const { opened, merged } = rangeFlags(range);
    const match = { active: true, author: s._id };
    const contribPageOf = (kind) => contributionPage(db, allOf({ active: true, author: s._id, kind }, createdIn(range)), { page: 1, limit: 25, skip: 0 });
    const [ranged, series, repoGroups, prs, tech, contribRanged, issues, reviews] = await Promise.all([
      range.all ? null : groupStats(db, { by: 'author', range, match: { author: s._id } }),
      monthlySeries(db, { match: { author: s._id }, range, tz, now }),
      c.prs.aggregate([
        { $match: allOf(match, rangeMatch(range)) },
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$repoLc', name: { $first: '$repo' }, stars: { $first: '$stars' }, category: { $first: '$category' }, tier: { $first: '$tier' },
          prs: sumIf(opened), merged: sumIf(merged), lastPrAt: { $max: '$createdAt' } } },
        { $sort: { prs: -1, lastPrAt: -1, _id: 1 } },
        { $limit: 100 },
      ], AGG).toArray(),
      prPage(db, allOf(match, prRangeFilter(range)), { page: 1, limit: 25, skip: 0, admin }),
      techOf({ author: s._id }, range),
      range.all ? null : contribGroupStats(db, { by: 'author', range, match: { author: s._id } }),
      contribPageOf('issue'),
      contribPageOf('review'),
    ]);
    const stats = ranged ? studentStats(ranged.get(s._id), contribRanged.get(s._id)) : s.stats;
    res.json({
      range: rangeOut(range),
      student: studentOut({ ...s, stats }, now),
      monthly: series,
      repos: repoGroups.map((g) => ({ name: g.name, stars: g.stars ?? 0, category: g.category, tier: g.tier ?? null, prs: g.prs, merged: g.merged, lastPrAt: iso(g.lastPrAt) })),
      prs,
      issues, reviews, // first page of each kind, every category, newest first (addendum I5)
      tech, // { language: [{key, label, prs, merged, osPrs, osMerged, repos}], domain: [...] } over every category (addendum H)
    });
  });

  // ---------- PRs ----------

  const PR_SORT = { createdAt: 'createdAt', mergedAt: 'mergedAt', stars: 'stars', additions: 'additions' };

  r.get('/prs', async (req, res) => {
    const { page, limit, skip } = paging(req.query);
    const { sort, dir } = sorting(req.query, Object.keys(PR_SORT), 'createdAt');
    const range = await rangeOf(req);
    // sorting by merge date lists merged PRs only; the range then applies to mergedAt, as for an explicit state=merged
    const f = await prFilter(db, req.query, { range, impliedState: sort === 'mergedAt' ? 'merged' : '' });
    const order = { [PR_SORT[sort]]: dir, ...(sort !== 'createdAt' && { createdAt: -1 }), _id: 1 };
    res.json({ range: rangeOut(range), ...(await prPage(db, f, { sort: order, page, limit, skip, admin: req.isAdmin })) });
  });

  // ---------- contributions (addendum I5) ----------

  const CONTRIB_SORT = { createdAt: 'createdAt', stars: 'stars', lastReviewedAt: 'lastReviewedAt' };

  r.get('/contributions', async (req, res) => {
    const { page, limit, skip } = paging(req.query);
    const { sort, dir } = sorting(req.query, Object.keys(CONTRIB_SORT), 'createdAt');
    const range = await rangeOf(req);
    const kind = contribKind(req.query);
    const f = await contributionFilter(db, req.query, { range });
    const order = { [CONTRIB_SORT[sort]]: dir, ...(sort !== 'createdAt' && { createdAt: -1 }), _id: 1 };
    res.json({ range: rangeOut(range), kind, ...(await contributionPage(db, f, { sort: order, page, limit, skip })) });
  });

  // ---------- repos ----------

  const REPO_SORTS = ['prs', 'merged', 'students', 'stars'];
  const REPO_SORT = { prs: 'stats.prs', merged: 'stats.merged', students: 'stats.students', stars: 'stars' };

  /** Sort + page documents whose `stats` were replaced by ranged ones. */
  function pageRanged(rows, value, dir, { skip, limit }) {
    rows.sort((a, b) => dir * (value(a) - value(b)) || b.stats.prs - a.stats.prs || (a._id < b._id ? -1 : 1));
    return rows.slice(skip, skip + limit);
  }

  r.get('/repos', async (req, res) => {
    const { page, limit, skip } = paging(req.query);
    const { sort, dir } = sorting(req.query, REPO_SORTS, 'prs');
    const range = await rangeOf(req);
    const f = {};
    const category = oneOf(req.query, 'category', [...CATEGORIES, 'all'], 'open_source');
    if (category !== 'all') f.category = category;
    const tier = oneOf(req.query, 'tier', TIERS);
    if (tier) f.tier = tier;
    const owner = str(req.query, 'owner');
    if (owner) f.ownerLc = lc(owner);
    // technology filters (addendum H): the language a repo is counted under on /api/tech, or its domain
    const language = str(req.query, 'language');
    if (language.length > 100) throw badRequest('invalid language: at most 100 characters');
    if (language) {
      const exact = { $regex: `^${escapeRegex(language)}$`, $options: 'i' };
      f.$and = [language === LANG_NONE
        ? { language: null, 'languages.0': { $exists: false } }
        : { $or: [{ language: exact }, { language: null, 'languages.0.name': exact }] }];
    }
    const domain = str(req.query, 'domain');
    if (domain) {
      const { labels } = (await repoTechMap(db)).compiled;
      if (!labels.has(domain)) throw badRequest(`invalid domain: expected one of ${[...labels.keys()].join(', ')}`);
      f.domain = domain;
    }
    const q = search(req.query);
    if (q) f.$or = [{ name: contains(q) }, { description: contains(q) }];
    const admin = req.isAdmin;
    if (!range.all) {
      const [ranged, contrib] = await Promise.all([grouped('repoLc', range), contribGrouped('repoLc', range)]);
      const docs = await c.repos.find({ ...f, _id: { $in: [...ranged.keys()] } }).maxTimeMS(T).toArray();
      const rows = docs.map((d) => ({ ...d, stats: repoStats(ranged.get(d._id), contrib.get(d._id)) }));
      const value = sort === 'stars' ? (d) => d.stars ?? 0 : (d) => d.stats[sort];
      return res.json({ range: rangeOut(range), items: pageRanged(rows, value, dir, { skip, limit }).map((d) => repoOut(d, { admin })), total: rows.length, page, limit });
    }
    f['stats.prs'] = { $gt: 0 };
    const [rows, total] = await Promise.all([
      c.repos.find(f).sort(sortSpec(REPO_SORT[sort], dir, 'stats.prs')).skip(skip).limit(limit).maxTimeMS(T).toArray(),
      c.repos.countDocuments(f, { maxTimeMS: T }),
    ]);
    res.json({ range: rangeOut(range), items: rows.map((d) => repoOut(d, { admin })), total, page, limit });
  });

  /** Students of a repo / org with their PR counts there, by merged desc (max 100). */
  async function contributors(match, range, now) {
    const { opened, merged } = rangeFlags(range);
    const groups = await c.prs.aggregate([
      { $match: allOf({ active: true }, match, rangeMatch(range)) },
      { $group: { _id: '$author', prs: sumIf(opened), merged: sumIf(merged) } },
      { $sort: { merged: -1, prs: -1, _id: 1 } },
      { $limit: 100 },
    ], AGG).toArray();
    const ids = groups.map((g) => g._id);
    const [docs, ranged, contrib] = await Promise.all([
      c.students.find({ _id: { $in: ids }, active: true }, { projection: PUBLIC_STUDENT }).toArray(),
      range.all ? null : groupStats(db, { by: 'author', range, match: { author: { $in: ids } } }),
      range.all ? null : contribGroupStats(db, { by: 'author', range, match: { author: { $in: ids } } }),
    ]);
    const byId = new Map(docs.map((s) => [s._id, s]));
    return groups.filter((g) => byId.has(g._id)).map((g) => {
      const s = byId.get(g._id);
      const stats = ranged ? studentStats(ranged.get(g._id), contrib.get(g._id)) : s.stats;
      return { ...studentOut({ ...s, stats }, now), prs: g.prs, merged: g.merged };
    });
  }

  r.get('/repos/:owner/:name', async (req, res) => {
    const id = lc(`${req.params.owner}/${req.params.name}`);
    const repo = await c.repos.findOne({ _id: id });
    // a repo with only issues or reviews by students has a page too (contribution rows link to it); lists keep stats.prs > 0
    if (!repo || !(repo.stats?.prs > 0 || repo.stats?.issues > 0 || repo.stats?.reviews > 0)) throw notFound('repo not found');
    const now = new Date();
    const range = await rangeOf(req, now);
    const admin = req.isAdmin;
    const [owner, ranged, ownerRanged, students, prs, contribRepo, contribOwner] = await Promise.all([
      c.owners.findOne({ _id: repo.ownerLc }),
      range.all ? null : groupStats(db, { by: 'repoLc', range, match: { repoLc: id } }),
      range.all ? null : groupStats(db, { by: 'ownerLc', range, match: { ownerLc: repo.ownerLc } }),
      contributors({ repoLc: id }, range, now),
      prPage(db, allOf({ active: true, repoLc: id }, prRangeFilter(range)), { page: 1, limit: 25, skip: 0, admin }),
      range.all ? null : contribGroupStats(db, { by: 'repoLc', range, match: { repoLc: id } }),
      range.all ? null : contribGroupStats(db, { by: 'ownerLc', range, match: { ownerLc: repo.ownerLc } }),
    ]);
    const ownerDoc = owner || { _id: repo.ownerLc, login: repo.owner, type: repo.ownerType };
    res.json({
      range: rangeOut(range),
      repo: repoOut(ranged ? { ...repo, stats: repoStats(ranged.get(id), contribRepo.get(id)) } : repo, { admin }),
      owner: orgOut(ownerRanged ? { ...ownerDoc, stats: ownerStats(ownerRanged.get(repo.ownerLc), contribOwner.get(repo.ownerLc)) } : ownerDoc, { admin }),
      students, prs,
    });
  });

  // ---------- orgs ----------

  const ORG_SORTS = ['osMerged', 'osPrs', 'prs', 'students'];
  const ORG_SORT = { osMerged: 'stats.osMerged', osPrs: 'stats.osPrs', prs: 'stats.prs', students: 'stats.students' };

  r.get('/orgs', async (req, res) => {
    const { page, limit, skip } = paging(req.query);
    const { sort, dir } = sorting(req.query, ORG_SORTS, 'osMerged');
    const range = await rangeOf(req);
    const category = oneOf(req.query, 'category', [...CATEGORIES, 'all'], 'open_source');
    const q = search(req.query);
    const admin = req.isAdmin;
    if (!range.all) {
      const [ranged, contrib] = await Promise.all([grouped('ownerLc', range), contribGrouped('ownerLc', range)]);
      const keep = (st) => (category === 'all' ? true : category === 'open_source' ? st.osPrs > 0 || st.osMerged > 0 : st.byCategory[category] > 0);
      const stats = new Map();
      for (const [id, g] of ranged) { const st = ownerStats(g, contrib.get(id)); if (keep(st)) stats.set(id, st); }
      const docs = await c.owners.find({ _id: { $in: [...stats.keys()] }, ...(q && { login: contains(q) }) }).maxTimeMS(T).toArray();
      const rows = docs.map((d) => ({ ...d, stats: stats.get(d._id) }));
      return res.json({ range: rangeOut(range), items: pageRanged(rows, (d) => d.stats[sort], dir, { skip, limit }).map((d) => orgOut(d, { admin })), total: rows.length, page, limit });
    }
    const f = { 'stats.prs': { $gt: 0 } };
    if (category === 'open_source') f['stats.osPrs'] = { $gt: 0 };
    else if (category !== 'all') f[`stats.byCategory.${category}`] = { $gt: 0 };
    if (q) f.login = contains(q);
    const [rows, total] = await Promise.all([
      c.owners.find(f).sort(sortSpec(ORG_SORT[sort], dir, 'stats.prs')).skip(skip).limit(limit).maxTimeMS(T).toArray(),
      c.owners.countDocuments(f, { maxTimeMS: T }),
    ]);
    res.json({ range: rangeOut(range), items: rows.map((d) => orgOut(d, { admin })), total, page, limit });
  });

  r.get('/orgs/:login', async (req, res) => {
    const id = lc(req.params.login);
    const org = await c.owners.findOne({ _id: id });
    if (!org || !(org.stats?.prs > 0 || org.stats?.issues > 0 || org.stats?.reviews > 0)) throw notFound('org not found');
    const now = new Date();
    const range = await rangeOf(req, now);
    const admin = req.isAdmin;
    let repos;
    let stats = org.stats;
    if (range.all) {
      repos = await c.repos.find({ ownerLc: id, 'stats.prs': { $gt: 0 } }).sort({ 'stats.prs': -1, _id: 1 }).limit(100).toArray();
    } else {
      const [own, ranged, contribOwn, contribRepos] = await Promise.all([
        groupStats(db, { by: 'ownerLc', range, match: { ownerLc: id } }),
        groupStats(db, { by: 'repoLc', range, match: { ownerLc: id } }),
        contribGroupStats(db, { by: 'ownerLc', range, match: { ownerLc: id } }),
        contribGroupStats(db, { by: 'repoLc', range, match: { ownerLc: id } }),
      ]);
      stats = ownerStats(own.get(id), contribOwn.get(id));
      const docs = await c.repos.find({ _id: { $in: [...ranged.keys()] } }).toArray();
      repos = docs.map((d) => ({ ...d, stats: repoStats(ranged.get(d._id), contribRepos.get(d._id)) }))
        .sort((a, b) => b.stats.prs - a.stats.prs || b.stats.merged - a.stats.merged || (a._id < b._id ? -1 : 1)).slice(0, 100);
    }
    const [students, tech] = await Promise.all([contributors({ ownerLc: id }, range, now), techOf({ ownerLc: id }, range)]);
    res.json({ range: rangeOut(range), org: orgOut({ ...org, stats }, { admin }), repos: repos.map((d) => repoOut(d, { admin })), students, tech });
  });

  // ---------- CSV exports ----------

  let exportsRunning = 0;
  const maxExports = config.maxConcurrentExports ?? 2;

  /** Streams rows as CSV. At most `maxConcurrentExports` run at once: an export reads a whole collection. */
  async function streamCsv(res, filename, header, rows, toRow) {
    if (exportsRunning >= maxExports) {
      res.set('Retry-After', '5');
      throw new ApiError(429, 'rate_limited', 'too many exports are running, try again in a few seconds');
    }
    exportsRunning++;
    try {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${filename}"`);
      res.write(csvLine(header));
      let buf = '';
      for await (const doc of rows) {
        buf += csvLine(toRow(doc));
        if (buf.length > 64 * 1024) {
          if (!res.write(buf)) {
            // wait for the socket to drain (or to go away); both listeners are removed again, a long export waits many times
            await new Promise((resolve) => {
              const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
              res.once('drain', done);
              res.once('close', done);
            });
          }
          buf = '';
          if (res.destroyed) break;
        }
      }
      res.end(buf);
    } catch (e) {
      if (!res.headersSent) throw e;
      res.destroy(e);
    } finally {
      exportsRunning--;
      await rows.close?.().catch(() => {});
    }
  }

  r.get('/export/students.csv', async (req, res) => {
    const now = new Date();
    const range = await rangeOf(req, now);
    const rows = await studentRows(req.query, range);
    await streamCsv(res, 'students.csv',
      ['username', 'name', 'campus', 'batch', 'year', 'total_prs', 'merged_prs', 'os_prs', 'os_merged', 'os_open', 'os_major_merged', 'os_repos', 'os_orgs',
        'practice_prs', 'nst_internal_prs', 'peer_repo_prs', 'own_repo_prs', 'low_signal_prs', 'first_pr_at', 'last_pr_at',
        'os_closed_prs', 'total_issues', 'os_issues', 'total_reviews', 'os_reviews', 'os_contributions'],
      rows, (d) => {
        const s = studentOut(d, now);
        const t = s.stats;
        return [s.username, s.name, s.campus, s.batch, s.year, t.totalPrs, t.mergedPrs, t.osPrs, t.osMerged, t.osOpen, t.osMajorMerged, t.osRepos, t.osOrgs,
          t.byCategory.practice, t.byCategory.nst_internal, t.byCategory.peer_repo, t.byCategory.own_repo, t.byCategory.low_signal, t.firstPrAt, t.lastPrAt,
          t.osClosed, t.totalIssues, t.osIssues, t.totalReviews, t.osReviews, t.osContributions];
      });
  });

  /** Rows of `cursor` with the author names looked up per batch of rows into `names` (not every student for every export). */
  function withNames(cursor, names) {
    async function* rows() {
      let batch = [];
      const flush = async () => {
        const need = [...new Set(batch.map((p) => p.author))].filter((id) => !names.has(id));
        if (need.length) {
          for (const id of need) names.set(id, null);
          for await (const s of c.students.find({ _id: { $in: need } }, { projection: { username: 1, name: 1 } })) names.set(s._id, s);
        }
        const out = batch;
        batch = [];
        return out;
      };
      for await (const p of cursor) {
        batch.push(p);
        if (batch.length >= 1000) yield* await flush();
      }
      yield* await flush();
    }
    const it = rows();
    it.close = () => cursor.close();
    return it;
  }

  const PR_EXPORT = { url: 1, author: 1, authorLogin: 1, campus: 1, batch: 1, repo: 1, owner: 1, ownerType: 1, stars: 1, title: 1, state: 1, isDraft: 1,
    createdAt: 1, mergedAt: 1, closedAt: 1, additions: 1, deletions: 1, changedFiles: 1, category: 1, tier: 1, reason: 1 };

  r.get('/export/prs.csv', async (req, res) => {
    const range = await rangeOf(req);
    const f = await prFilter(db, req.query, { range });
    const now = new Date();
    // the sort is not covered by an index: without allowDiskUse it fails once the selection outgrows Mongo's 100 MB sort limit
    const cursor = c.prs.find(f, { projection: PR_EXPORT, batchSize: 5000 }).sort({ createdAt: -1, _id: 1 }).allowDiskUse(true).maxTimeMS(60000);
    const names = new Map();
    const it = withNames(cursor, names);
    await streamCsv(res, 'prs.csv',
      ['url', 'author', 'author_name', 'campus', 'batch', 'year', 'repo', 'owner', 'owner_type', 'stars', 'title', 'state', 'is_draft', 'created_at', 'merged_at',
        'closed_at', 'additions', 'deletions', 'changed_files', 'category', 'tier', 'reason'],
      it, (d) => {
        const p = prOut(d, names, now);
        return [p.url, p.author, p.authorName, p.campus, p.batch, p.year, p.repo, p.owner, p.ownerType, p.stars, p.title, p.state, p.isDraft, p.createdAt, p.mergedAt,
          p.closedAt, p.additions, p.deletions, p.changedFiles, p.category, p.tier, p.reason];
      });
  });

  const CONTRIB_EXPORT = { kind: 1, url: 1, number: 1, title: 1, author: 1, authorLogin: 1, campus: 1, batch: 1, repo: 1, owner: 1, ownerType: 1, stars: 1,
    state: 1, stateReason: 1, createdAt: 1, closedAt: 1, comments: 1, prUrl: 1, prAuthor: 1, prState: 1, reviewCount: 1, lastReviewedAt: 1,
    category: 1, tier: 1, reason: 1 };

  r.get('/export/contributions.csv', async (req, res) => {
    const range = await rangeOf(req);
    const f = await contributionFilter(db, req.query, { range });
    const now = new Date();
    const cursor = contribs.find(f, { projection: CONTRIB_EXPORT, batchSize: 5000 }).sort({ createdAt: -1, _id: 1 }).allowDiskUse(true).maxTimeMS(60000);
    const names = new Map();
    await streamCsv(res, 'contributions.csv',
      ['kind', 'url', 'author', 'author_name', 'campus', 'batch', 'year', 'repo', 'owner', 'owner_type', 'stars', 'title', 'state', 'state_reason',
        'created_at', 'closed_at', 'pr_url', 'pr_author', 'pr_state', 'review_count', 'last_reviewed_at', 'category', 'tier', 'reason'],
      withNames(cursor, names), (d) => {
        const x = contributionOut(d, names, now);
        return [x.kind, x.url, x.author, x.authorName, x.campus, x.batch, x.year, x.repo, x.owner, x.ownerType, x.stars, x.title, x.state, x.stateReason,
          x.createdAt, x.closedAt, x.prUrl, x.prAuthor, x.prState, x.reviewCount, x.lastReviewedAt, x.category, x.tier, x.reason];
      });
  });

  return r;
}

export default publicRouter;
