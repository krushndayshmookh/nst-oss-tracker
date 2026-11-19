// Public read-only API (SPEC section 5, Appendix A). Counts only active students / PRs.
import express from 'express';
import { collections } from '../db.js';
import { CATEGORIES, TIERS, YEAR_LABELS, yearLabel } from '../classify.js';
import { emptyByCategory } from '../ingest.js';
import { loadRules } from '../rules.js';
import { csvLine } from '../csv.js';
import { notFound } from '../auth.js';
import {
  COLLATION, STATES, cohortFilter, contains, findStudent, flag, iso, lc, oneOf, orgOut, paging, prFilter, prOut, prPage,
  repoOut, rulesOut, sorting, str, studentMap, studentOut,
} from './common.js';

const PUBLIC_STUDENT = { username: 1, name: 1, campus: 1, batch: 1, stats: 1 };

// ---------- monthly series ----------

function lastMonths(n, now = new Date()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return { months: out, start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1), 1)) };
}

/** 24 calendar months incl. the current one, oldest first, zero-filled (UTC). */
async function monthly(db, match, now = new Date()) {
  const { prs } = collections(db);
  const { months, start } = lastMonths(24, now);
  const month = (field) => ({ $dateToString: { format: '%Y-%m', date: field } });
  const [opened, merged] = await Promise.all([
    prs.aggregate([
      { $match: { ...match, createdAt: { $gte: start } } },
      { $group: { _id: month('$createdAt'), allOpened: { $sum: 1 }, osOpened: { $sum: { $cond: [{ $eq: ['$category', 'open_source'] }, 1, 0] } } } },
    ]).toArray(),
    prs.aggregate([
      { $match: { ...match, category: 'open_source', state: 'merged', mergedAt: { $gte: start } } },
      { $group: { _id: month('$mergedAt'), osMerged: { $sum: 1 } } },
    ]).toArray(),
  ]);
  const o = new Map(opened.map((r) => [r._id, r]));
  const m = new Map(merged.map((r) => [r._id, r]));
  return months.map((k) => ({ month: k, osOpened: o.get(k)?.osOpened ?? 0, osMerged: m.get(k)?.osMerged ?? 0, allOpened: o.get(k)?.allOpened ?? 0 }));
}

// ---------- campus table ----------

function emptyCampusRow(campus, year, batch) {
  return { campus, year, batch, students: 0, withAnyPr: 0, withOsPr: 0, withOsMerged: 0, withMajorMerged: 0,
    totalPrs: 0, osPrs: 0, osMerged: 0, byCategory: emptyByCategory() };
}
function addStudent(row, s) {
  const st = s.stats || {};
  row.students++;
  if (st.totalPrs > 0) row.withAnyPr++;
  if (st.osPrs > 0) row.withOsPr++;
  if (st.osMerged > 0) row.withOsMerged++;
  if (st.osMajorMerged > 0) row.withMajorMerged++;
  row.totalPrs += st.totalPrs || 0;
  row.osPrs += st.osPrs || 0;
  row.osMerged += st.osMerged || 0;
  for (const k of CATEGORIES) row.byCategory[k] += st.byCategory?.[k] || 0;
}

// ---------- student counts within a repo / org ----------

async function contributors(db, match, now) {
  const { prs, students } = collections(db);
  const groups = await prs.aggregate([
    { $match: { active: true, ...match } },
    { $group: { _id: '$author', prs: { $sum: 1 }, merged: { $sum: { $cond: [{ $eq: ['$state', 'merged'] }, 1, 0] } } } },
    { $sort: { merged: -1, prs: -1, _id: 1 } },
    { $limit: 100 },
  ]).toArray();
  const docs = await students.find({ _id: { $in: groups.map((g) => g._id) }, active: true }, { projection: PUBLIC_STUDENT }).toArray();
  const byId = new Map(docs.map((s) => [s._id, s]));
  return groups.filter((g) => byId.has(g._id)).map((g) => ({ ...studentOut(byId.get(g._id), now), prs: g.prs, merged: g.merged }));
}

export function publicRouter({ db, auth }) {
  const r = express.Router();
  const c = collections(db);

  r.get('/health', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      await db.command({ ping: 1 });
      res.json({ ok: true });
    } catch {
      res.status(503).json({ error: { code: 'unavailable', message: 'database unreachable' } });
    }
  });

  // Public responses are cacheable for a minute; a logged-in admin always gets fresh data (the admin UI refetches right after a change).
  r.use((req, res, next) => {
    if (auth?.isAdmin(req)) res.set('Cache-Control', 'private, no-store');
    else res.set('Cache-Control', 'public, max-age=60');
    res.set('Vary', 'Cookie');
    next();
  });

  r.get('/meta', async (req, res) => {
    const now = new Date();
    const [campuses, batches, students, prs, job, lastSynced, rules] = await Promise.all([
      c.students.distinct('campus', { active: true }),
      c.students.distinct('batch', { active: true }),
      c.students.countDocuments({ active: true }),
      c.prs.countDocuments({ active: true }),
      c.jobs.find({ type: { $in: ['sync', 'import'] }, status: 'done' }, { projection: { finishedAt: 1 } }).sort({ finishedAt: -1 }).limit(1).next(),
      c.students.find({ lastSyncedAt: { $type: 'date' } }, { projection: { lastSyncedAt: 1 } }).sort({ lastSyncedAt: -1 }).limit(1).next(),
      loadRules(db),
    ]);
    const labels = new Set(batches.map((b) => yearLabel(b, now)));
    res.json({
      campuses: campuses.filter(Boolean).sort(),
      years: YEAR_LABELS.filter((y) => labels.has(y)),
      batches: batches.filter((b) => Number.isFinite(b)).sort((a, b) => b - a),
      categories: CATEGORIES, tiers: TIERS,
      lastSyncAt: iso(job?.finishedAt ?? lastSynced?.lastSyncedAt ?? null),
      counts: { students, prs },
      rulesSummary: rulesOut(rules),
    });
  });

  r.get('/overview', async (req, res) => {
    const now = new Date();
    const cohort = cohortFilter({ campus: req.query.campus, year: req.query.year }, now);
    const prMatch = { active: true, ...cohort };
    const os = { ...prMatch, category: 'open_source' };
    const top = (field) => [
      { $match: os },
      { $group: { _id: field, osPrs: { $sum: 1 }, osMerged: { $sum: { $cond: [{ $eq: ['$state', 'merged'] }, 1, 0] } }, students: { $addToSet: '$author' } } },
      { $project: { osPrs: 1, osMerged: 1, students: { $size: '$students' } } },
      { $sort: { osMerged: -1, osPrs: -1, _id: 1 } },
      { $limit: 10 },
    ];
    const [studentAgg, groups, topRepos, topOrgs, topStudents, series] = await Promise.all([
      c.students.aggregate([
        { $match: { active: true, ...cohort } },
        { $group: { _id: null, tracked: { $sum: 1 },
          withAnyPr: { $sum: { $cond: [{ $gt: ['$stats.totalPrs', 0] }, 1, 0] } },
          withOsPr: { $sum: { $cond: [{ $gt: ['$stats.osPrs', 0] }, 1, 0] } },
          withOsMerged: { $sum: { $cond: [{ $gt: ['$stats.osMerged', 0] }, 1, 0] } },
          withMajorMerged: { $sum: { $cond: [{ $gt: ['$stats.osMajorMerged', 0] }, 1, 0] } } } },
      ]).toArray(),
      c.prs.aggregate([{ $match: prMatch }, { $group: { _id: { c: '$category', s: '$state', t: '$tier' }, n: { $sum: 1 } } }]).toArray(),
      c.prs.aggregate(top('$repoLc')).toArray(),
      c.prs.aggregate(top('$ownerLc')).toArray(),
      c.students.find({ active: true, ...cohort, 'stats.osMerged': { $gt: 0 } }, { projection: PUBLIC_STUDENT })
        .sort({ 'stats.osMerged': -1, 'stats.osPrs': -1, _id: 1 }).limit(10).toArray(),
      monthly(db, prMatch, now),
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
      prs.total += g.n;
      if (cat in prs.byCategory) prs.byCategory[cat] += g.n;
      if (state in prs.byState) prs.byState[state] += g.n;
      if (state === 'merged') prs.merged += g.n;
      if (cat === 'open_source') {
        prs.osPrs += g.n;
        if (state === 'open') prs.osOpen += g.n;
        if (state === 'merged') {
          prs.osMerged += g.n;
          if (tier in prs.osMergedByTier) prs.osMergedByTier[tier] += g.n;
        }
      }
    }
    const s = studentAgg[0] || {};
    res.json({
      filters: { campus: str(req.query, 'campus') || null, year: str(req.query, 'year') || null },
      students: { tracked: s.tracked ?? 0, withAnyPr: s.withAnyPr ?? 0, withOsPr: s.withOsPr ?? 0, withOsMerged: s.withOsMerged ?? 0, withMajorMerged: s.withMajorMerged ?? 0 },
      prs,
      topRepos: topRepos.map((t) => ({ name: repoById.get(t._id)?.name ?? t._id, stars: repoById.get(t._id)?.stars ?? 0, tier: repoById.get(t._id)?.tier ?? null,
        osPrs: t.osPrs, osMerged: t.osMerged, students: t.students })),
      topOrgs: topOrgs.map((t) => ({ login: ownerById.get(t._id)?.login ?? t._id, osPrs: t.osPrs, osMerged: t.osMerged, students: t.students })),
      topStudents: topStudents.map((d) => studentOut(d, now)),
      monthly: series,
    });
  });

  r.get('/campuses', async (req, res) => {
    const now = new Date();
    const rows = new Map();
    const totals = new Map();
    const total = emptyCampusRow('All', 'All', null);
    for await (const s of c.students.find({ active: true }, { projection: { campus: 1, batch: 1, stats: 1 } })) {
      const campus = s.campus || 'Unknown';
      const year = yearLabel(s.batch, now);
      const key = `${campus}\u0000${year}`;
      const batch = Number.isFinite(s.batch) ? s.batch : null;
      let row = rows.get(key);
      if (!row) { row = emptyCampusRow(campus, year, batch); rows.set(key, row); } else if (row.batch !== batch) row.batch = null; // several batches share a label (alumni)
      if (!totals.has(campus)) totals.set(campus, emptyCampusRow(campus, 'All', null));
      addStudent(row, s);
      addStudent(totals.get(campus), s);
      addStudent(total, s);
    }
    const byCampus = (a, b) => (a.campus < b.campus ? -1 : a.campus > b.campus ? 1 : 0);
    res.json({
      rows: [...rows.values()].sort((a, b) => byCampus(a, b) || YEAR_LABELS.indexOf(a.year) - YEAR_LABELS.indexOf(b.year)),
      totals: [...totals.values()].sort(byCampus),
      total,
    });
  });

  // ---------- students ----------

  const STUDENT_SORT = { osMerged: 'stats.osMerged', osPrs: 'stats.osPrs', totalPrs: 'stats.totalPrs', name: 'name', lastPrAt: 'stats.lastPrAt' };

  function studentFilter(query) {
    const f = { active: true, ...cohortFilter(query) };
    const q = str(query, 'q');
    if (q) f.$or = [{ name: contains(q) }, { username: contains(q) }];
    if (flag(query, 'hasOs')) f['stats.osPrs'] = { $gt: 0 };
    return f;
  }

  r.get('/students', async (req, res) => {
    const { page, limit, skip } = paging(req.query);
    const { sort, dir } = sorting(req.query, Object.keys(STUDENT_SORT), 'osMerged');
    const f = studentFilter(req.query);
    const now = new Date();
    const [rows, total] = await Promise.all([
      c.students.find(f, { projection: PUBLIC_STUDENT }).collation(COLLATION).sort({ [STUDENT_SORT[sort]]: dir, 'stats.osPrs': -1, _id: 1 }).skip(skip).limit(limit).toArray(),
      c.students.countDocuments(f),
    ]);
    res.json({ items: rows.map((s) => studentOut(s, now)), total, page, limit });
  });

  r.get('/students/:username', async (req, res) => {
    const s = await findStudent(db, req.params.username);
    if (!s || s.active === false) throw notFound('student not found');
    const now = new Date();
    const match = { active: true, author: s._id };
    const [series, repoGroups, prs] = await Promise.all([
      monthly(db, match, now),
      c.prs.aggregate([
        { $match: match },
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$repoLc', name: { $first: '$repo' }, stars: { $first: '$stars' }, category: { $first: '$category' }, tier: { $first: '$tier' },
          prs: { $sum: 1 }, merged: { $sum: { $cond: [{ $eq: ['$state', 'merged'] }, 1, 0] } }, lastPrAt: { $max: '$createdAt' } } },
        { $sort: { prs: -1, lastPrAt: -1, _id: 1 } },
        { $limit: 100 },
      ]).toArray(),
      prPage(db, match, { page: 1, limit: 25, skip: 0 }),
    ]);
    res.json({
      student: studentOut(s, now),
      monthly: series,
      repos: repoGroups.map((g) => ({ name: g.name, stars: g.stars ?? 0, category: g.category, tier: g.tier ?? null, prs: g.prs, merged: g.merged, lastPrAt: iso(g.lastPrAt) })),
      prs,
    });
  });

  // ---------- PRs ----------

  const PR_SORT = { createdAt: 'createdAt', mergedAt: 'mergedAt', stars: 'stars', additions: 'additions' };

  r.get('/prs', async (req, res) => {
    const { page, limit, skip } = paging(req.query);
    const { sort, dir } = sorting(req.query, Object.keys(PR_SORT), 'createdAt');
    const f = await prFilter(db, req.query);
    if (sort === 'mergedAt' && !f.state) f.mergedAt = { $ne: null };
    const order = { [PR_SORT[sort]]: dir, ...(sort !== 'createdAt' && { createdAt: -1 }), _id: 1 };
    res.json(await prPage(db, f, { sort: order, page, limit, skip }));
  });

  // ---------- repos ----------

  const REPO_SORT = { prs: 'stats.prs', merged: 'stats.merged', students: 'stats.students', stars: 'stars' };

  r.get('/repos', async (req, res) => {
    const { page, limit, skip } = paging(req.query);
    const { sort, dir } = sorting(req.query, Object.keys(REPO_SORT), 'prs');
    const f = { 'stats.prs': { $gt: 0 } };
    const category = oneOf(req.query, 'category', [...CATEGORIES, 'all'], 'open_source');
    if (category !== 'all') f.category = category;
    const tier = oneOf(req.query, 'tier', TIERS);
    if (tier) f.tier = tier;
    const owner = str(req.query, 'owner');
    if (owner) f.ownerLc = lc(owner);
    const q = str(req.query, 'q');
    if (q) f.$or = [{ name: contains(q) }, { description: contains(q) }];
    const [rows, total] = await Promise.all([
      c.repos.find(f).sort({ [REPO_SORT[sort]]: dir, 'stats.prs': -1, _id: 1 }).skip(skip).limit(limit).toArray(),
      c.repos.countDocuments(f),
    ]);
    res.json({ items: rows.map(repoOut), total, page, limit });
  });

  r.get('/repos/:owner/:name', async (req, res) => {
    const id = lc(`${req.params.owner}/${req.params.name}`);
    const repo = await c.repos.findOne({ _id: id });
    if (!repo || !(repo.stats?.prs > 0)) throw notFound('repo not found');
    const now = new Date();
    const [owner, students, prs] = await Promise.all([
      c.owners.findOne({ _id: repo.ownerLc }),
      contributors(db, { repoLc: id }, now),
      prPage(db, { active: true, repoLc: id }, { page: 1, limit: 25, skip: 0 }),
    ]);
    res.json({ repo: repoOut(repo), owner: orgOut(owner || { _id: repo.ownerLc, login: repo.owner, type: repo.ownerType }), students, prs });
  });

  // ---------- orgs ----------

  const ORG_SORT = { osMerged: 'stats.osMerged', osPrs: 'stats.osPrs', prs: 'stats.prs', students: 'stats.students' };

  r.get('/orgs', async (req, res) => {
    const { page, limit, skip } = paging(req.query);
    const { sort, dir } = sorting(req.query, Object.keys(ORG_SORT), 'osMerged');
    const f = { 'stats.prs': { $gt: 0 } };
    const category = oneOf(req.query, 'category', [...CATEGORIES, 'all'], 'open_source');
    if (category === 'open_source') f['stats.osPrs'] = { $gt: 0 };
    else if (category !== 'all') f[`stats.byCategory.${category}`] = { $gt: 0 };
    const q = str(req.query, 'q');
    if (q) f.login = contains(q);
    const [rows, total] = await Promise.all([
      c.owners.find(f).sort({ [ORG_SORT[sort]]: dir, 'stats.prs': -1, _id: 1 }).skip(skip).limit(limit).toArray(),
      c.owners.countDocuments(f),
    ]);
    res.json({ items: rows.map(orgOut), total, page, limit });
  });

  r.get('/orgs/:login', async (req, res) => {
    const id = lc(req.params.login);
    const org = await c.owners.findOne({ _id: id });
    if (!org || !(org.stats?.prs > 0)) throw notFound('org not found');
    const now = new Date();
    const [repos, students] = await Promise.all([
      c.repos.find({ ownerLc: id, 'stats.prs': { $gt: 0 } }).sort({ 'stats.prs': -1, _id: 1 }).limit(100).toArray(),
      contributors(db, { ownerLc: id }, now),
    ]);
    res.json({ org: orgOut(org), repos: repos.map(repoOut), students });
  });

  // ---------- CSV exports ----------

  async function streamCsv(res, filename, header, cursor, toRow) {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.write(csvLine(header));
    let buf = '';
    try {
      for await (const doc of cursor) {
        buf += csvLine(toRow(doc));
        if (buf.length > 64 * 1024) {
          if (!res.write(buf)) await new Promise((resolve) => res.once('drain', resolve));
          buf = '';
          if (res.destroyed) break;
        }
      }
      res.end(buf);
    } catch (e) {
      res.destroy(e);
    } finally {
      await cursor.close().catch(() => {});
    }
  }

  r.get('/export/students.csv', async (req, res) => {
    const f = studentFilter(req.query);
    const now = new Date();
    const cursor = c.students.find(f, { projection: PUBLIC_STUDENT }).sort({ 'stats.osMerged': -1, 'stats.osPrs': -1, _id: 1 });
    await streamCsv(res, 'students.csv',
      ['username', 'name', 'campus', 'batch', 'year', 'total_prs', 'merged_prs', 'os_prs', 'os_merged', 'os_open', 'os_major_merged', 'os_repos', 'os_orgs',
        'practice_prs', 'nst_internal_prs', 'peer_repo_prs', 'own_repo_prs', 'low_signal_prs', 'first_pr_at', 'last_pr_at'],
      cursor, (d) => {
        const s = studentOut(d, now);
        const t = s.stats;
        return [s.username, s.name, s.campus, s.batch, s.year, t.totalPrs, t.mergedPrs, t.osPrs, t.osMerged, t.osOpen, t.osMajorMerged, t.osRepos, t.osOrgs,
          t.byCategory.practice, t.byCategory.nst_internal, t.byCategory.peer_repo, t.byCategory.own_repo, t.byCategory.low_signal, t.firstPrAt, t.lastPrAt];
      });
  });

  r.get('/export/prs.csv', async (req, res) => {
    const f = await prFilter(db, req.query);
    const students = await studentMap(db);
    const now = new Date();
    const cursor = c.prs.find(f).sort({ createdAt: -1, _id: 1 });
    await streamCsv(res, 'prs.csv',
      ['url', 'author', 'author_name', 'campus', 'batch', 'year', 'repo', 'owner', 'owner_type', 'stars', 'title', 'state', 'is_draft', 'created_at', 'merged_at',
        'closed_at', 'additions', 'deletions', 'changed_files', 'category', 'tier', 'reason'],
      cursor, (d) => {
        const p = prOut(d, students, now);
        return [p.url, p.author, p.authorName, p.campus, p.batch, p.year, p.repo, p.owner, p.ownerType, p.stars, p.title, p.state, p.isDraft, p.createdAt, p.mergedAt,
          p.closedAt, p.additions, p.deletions, p.changedFiles, p.category, p.tier, p.reason];
      });
  });

  return r;
}

export default publicRouter;
