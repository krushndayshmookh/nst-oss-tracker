// PR ingestion (raw GraphQL nodes -> prs / repos / owners) and aggregate refresh (SPEC sections 2-4).
import { collections } from './db.js';
import { CATEGORIES, classify, loadContext, reclassify } from './classify.js';

const lc = (s) => String(s ?? '').toLowerCase();
const date = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const num = (v) => (Number.isFinite(v) ? v : 0);

export function emptyByCategory() {
  return Object.fromEntries(CATEGORIES.map((k) => [k, 0]));
}

export function emptyStudentStats() {
  return {
    totalPrs: 0, mergedPrs: 0, osPrs: 0, osMerged: 0, osOpen: 0, osMajorMerged: 0, osRepos: 0, osOrgs: 0,
    byCategory: emptyByCategory(), firstPrAt: null, lastPrAt: null, lastOsMergedAt: null,
  };
}
export function emptyRepoStats() {
  return { prs: 0, merged: 0, open: 0, closed: 0, students: 0, campuses: [], firstPrAt: null, lastPrAt: null };
}
export function emptyOwnerStats() {
  return { repos: 0, prs: 0, merged: 0, osPrs: 0, osMerged: 0, students: 0, maxStars: 0, byCategory: emptyByCategory() };
}

/**
 * Converts raw PR nodes of one student into plain documents (no DB access, no classification).
 * Skips null nodes, nodes without url/repository, private repos and duplicate urls.
 * Returns { prs: [doc], repos: Map<repoLc, doc>, owners: Map<ownerLc, doc>, githubId, skippedPrivate }.
 */
export function buildDocs(student, nodes) {
  const prs = [];
  const repos = new Map();
  const owners = new Map();
  const seen = new Set();
  let githubId = null;
  let skippedPrivate = 0;
  for (const n of nodes || []) {
    const r = n?.repository;
    if (!n || !n.url || !r || !r.nameWithOwner) continue;
    if (r.isPrivate) { skippedPrivate++; continue; }
    if (seen.has(n.url)) continue;
    seen.add(n.url);
    const repo = r.nameWithOwner;
    const repoLc = lc(repo);
    const owner = r.owner?.login || repo.split('/')[0];
    const ownerLc = lc(owner);
    const ownerType = r.owner?.__typename === 'Organization' ? 'Organization' : 'User';
    const stars = num(r.stargazerCount);
    const mergedAt = date(n.mergedAt);
    if (githubId === null && Number.isFinite(n.author?.databaseId)) githubId = n.author.databaseId;
    prs.push({
      _id: n.url, url: n.url, number: num(n.number), title: String(n.title ?? '').split(/\s+/).filter(Boolean).join(' '),
      author: student._id, authorLogin: n.author?.login || student.username || student._id,
      repo, repoLc, owner, ownerLc, ownerType,
      state: mergedAt ? 'merged' : (n.state === 'OPEN' ? 'open' : 'closed'),
      isDraft: Boolean(n.isDraft), createdAt: date(n.createdAt), mergedAt, closedAt: date(n.closedAt), updatedAt: date(n.updatedAt),
      additions: num(n.additions), deletions: num(n.deletions), changedFiles: num(n.changedFiles),
      comments: num(n.comments?.totalCount), reviews: num(n.reviews?.totalCount), stars,
      campus: student.campus ?? 'Unknown', batch: student.batch ?? null, active: student.active !== false,
    });
    repos.set(repoLc, {
      _id: repoLc, name: repo, owner, ownerLc, ownerType, stars, forks: num(r.forkCount),
      isFork: Boolean(r.isFork), isArchived: Boolean(r.isArchived), language: r.primaryLanguage?.name ?? null,
      license: r.licenseInfo?.spdxId ?? null, description: r.description ?? null,
    });
    owners.set(ownerLc, { _id: ownerLc, login: owner, type: ownerType });
  }
  return { prs, repos, owners, githubId, skippedPrivate };
}

const strip = ({ _id, ...rest }) => rest;

export function prUpsertOp(doc, cls) {
  const set = strip(doc);
  const onInsert = { override: null };
  if (cls) Object.assign(set, cls);
  else Object.assign(onInsert, { category: 'low_signal', tier: null, reason: 'not classified yet' });
  return { updateOne: { filter: { _id: doc._id }, update: { $set: set, $setOnInsert: onInsert }, upsert: true } };
}
export function repoUpsertOp(doc, cls) {
  const set = strip(doc);
  const onInsert = { override: null, stats: emptyRepoStats() };
  if (cls) Object.assign(set, cls);
  else Object.assign(onInsert, { category: 'low_signal', tier: null, reason: 'not classified yet' });
  return { updateOne: { filter: { _id: doc._id }, update: { $set: set, $setOnInsert: onInsert }, upsert: true } };
}
export function ownerUpsertOp(doc) {
  return { updateOne: { filter: { _id: doc._id }, update: { $set: strip(doc), $setOnInsert: { override: null, stats: emptyOwnerStats() } }, upsert: true } };
}

export async function bulk(coll, ops, size = 2000) {
  for (let i = 0; i < ops.length; i += size) await coll.bulkWrite(ops.slice(i, i + size), { ordered: false });
}

/**
 * Upserts the PRs of one student. Preserves overrides, skips private repos, dedupes by url, upserts repo / owner
 * metadata, classifies with the current rules and sets student.githubId when missing. Does NOT touch aggregates.
 * `student` is the students doc (needs _id, username, campus, batch, active, githubId).
 * Returns { prs: n, repos: n }.
 */
export async function upsertPRs(db, student, nodes) {
  const c = collections(db);
  const { prs, repos, owners, githubId } = buildDocs(student, nodes);
  if (githubId !== null && !student.githubId) {
    await c.students.updateOne({ _id: student._id, $or: [{ githubId: null }, { githubId: { $exists: false } }] }, { $set: { githubId } });
    student.githubId = githubId;
  }
  if (!prs.length) return { prs: 0, repos: 0 };
  const ctx = await loadContext(db, { fresh: false });
  const repoIds = [...repos.keys()];
  const ownerIds = [...owners.keys()];
  const [repoOv, ownerOv, prOv] = await Promise.all([
    c.repos.find({ _id: { $in: repoIds } }, { projection: { override: 1, category: 1, tier: 1 } }).toArray(),
    c.owners.find({ _id: { $in: ownerIds }, override: { $ne: null } }, { projection: { override: 1 } }).toArray(),
    c.prs.find({ _id: { $in: prs.map((p) => p._id) }, override: { $ne: null } }, { projection: { override: 1 } }).toArray(),
  ]);
  const repoOverride = new Map(repoOv.filter((r) => r.override).map((r) => [r._id, r.override]));
  const repoBefore = new Map(repoOv.map((r) => [r._id, r]));
  const drifted = []; // repos whose repo-level class changed (stars crossed a threshold): their other PRs need a recompute
  const ownerOverride = new Map(ownerOv.map((o) => [o._id, o.override]));
  const prOverride = new Map(prOv.map((p) => [p._id, p.override]));

  const repoOps = [];
  for (const r of repos.values()) {
    const cls = classify({ repo: r._id, ownerType: r.ownerType, stars: r.stars, isFork: r.isFork,
      repoOverride: repoOverride.get(r._id) ?? null, ownerOverride: ownerOverride.get(r.ownerLc) ?? null }, ctx);
    repoOps.push(repoUpsertOp(r, cls));
    const before = repoBefore.get(r._id);
    if (before && (before.category !== cls.category || (before.tier ?? null) !== cls.tier)) drifted.push(r._id);
  }
  const prOps = prs.map((p) => {
    const r = repos.get(p.repoLc);
    const cls = classify({ repo: p.repoLc, ownerType: r.ownerType, stars: r.stars, isFork: r.isFork,
      repoOverride: repoOverride.get(p.repoLc) ?? null, ownerOverride: ownerOverride.get(p.ownerLc) ?? null,
      author: student._id, prOverride: prOverride.get(p._id) ?? null }, ctx);
    return prUpsertOp(p, cls);
  });
  await Promise.all([
    bulk(c.repos, repoOps),
    bulk(c.owners, [...owners.values()].map(ownerUpsertOp)),
  ]);
  await bulk(c.prs, prOps);
  if (drifted.length) await reclassify(db, { prFilter: { repoLc: { $in: drifted } }, repoFilter: null, ctx });
  return { prs: prs.length, repos: repos.size };
}

// ---------- aggregates ----------

const eq = (field, v) => ({ $eq: [field, v] });
const sumIf = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
const OS = eq('$category', 'open_source');
const MERGED = eq('$state', 'merged');
const catSums = () => Object.fromEntries(CATEGORIES.map((k) => [`c_${k}`, sumIf(eq('$category', k))]));
const byCat = (g) => Object.fromEntries(CATEGORIES.map((k) => [k, g[`c_${k}`] || 0]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function writeStats(coll, computed, empty) {
  const ops = [];
  for await (const doc of coll.find({}, { projection: { stats: 1 } })) {
    const next = computed.get(doc._id) ?? empty();
    if (!same(doc.stats, next)) ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { stats: next } } } });
  }
  await bulk(coll, ops);
  return ops.length;
}

/**
 * Recomputes students.stats, repos.stats and owners.stats from the PRs with active:true.
 * Three $group pipelines; only documents whose stats changed are written.
 */
export async function refreshAggregates(db) {
  const c = collections(db);
  const active = { $match: { active: true } };
  const opt = { allowDiskUse: true };

  const [studentRows, repoRows, ownerRows] = await Promise.all([
    c.prs.aggregate([active, { $group: {
      _id: '$author',
      totalPrs: { $sum: 1 }, mergedPrs: sumIf(MERGED), osPrs: sumIf(OS), osMerged: sumIf({ $and: [OS, MERGED] }),
      osOpen: sumIf({ $and: [OS, eq('$state', 'open')] }),
      osMajorMerged: sumIf({ $and: [OS, MERGED, eq('$tier', 'major')] }),
      osRepos: { $addToSet: { $cond: [OS, '$repoLc', null] } },
      osOrgs: { $addToSet: { $cond: [OS, '$ownerLc', null] } },
      ...catSums(),
      firstPrAt: { $min: '$createdAt' }, lastPrAt: { $max: '$createdAt' },
      lastOsMergedAt: { $max: { $cond: [{ $and: [OS, MERGED] }, '$mergedAt', null] } },
    } }, { $project: {
      totalPrs: 1, mergedPrs: 1, osPrs: 1, osMerged: 1, osOpen: 1, osMajorMerged: 1, firstPrAt: 1, lastPrAt: 1, lastOsMergedAt: 1,
      ...Object.fromEntries(CATEGORIES.map((k) => [`c_${k}`, 1])),
      osRepos: { $size: { $setDifference: ['$osRepos', [null]] } },
      osOrgs: { $size: { $setDifference: ['$osOrgs', [null]] } },
    } }], opt).toArray(),
    c.prs.aggregate([active, { $group: {
      _id: '$repoLc',
      prs: { $sum: 1 }, merged: sumIf(MERGED), open: sumIf(eq('$state', 'open')), closed: sumIf(eq('$state', 'closed')),
      students: { $addToSet: '$author' }, campuses: { $addToSet: '$campus' },
      firstPrAt: { $min: '$createdAt' }, lastPrAt: { $max: '$createdAt' },
    } }, { $project: { prs: 1, merged: 1, open: 1, closed: 1, students: { $size: '$students' }, campuses: 1, firstPrAt: 1, lastPrAt: 1 } }], opt).toArray(),
    c.prs.aggregate([active, { $group: {
      _id: '$ownerLc',
      repos: { $addToSet: '$repoLc' }, prs: { $sum: 1 }, merged: sumIf(MERGED), osPrs: sumIf(OS), osMerged: sumIf({ $and: [OS, MERGED] }),
      students: { $addToSet: '$author' }, maxStars: { $max: '$stars' }, ...catSums(),
    } }, { $project: {
      repos: { $size: '$repos' }, prs: 1, merged: 1, osPrs: 1, osMerged: 1, students: { $size: '$students' }, maxStars: 1,
      ...Object.fromEntries(CATEGORIES.map((k) => [`c_${k}`, 1])),
    } }], opt).toArray(),
  ]);

  const students = new Map(studentRows.map((g) => [g._id, {
    totalPrs: g.totalPrs, mergedPrs: g.mergedPrs, osPrs: g.osPrs, osMerged: g.osMerged, osOpen: g.osOpen, osMajorMerged: g.osMajorMerged,
    osRepos: g.osRepos, osOrgs: g.osOrgs, byCategory: byCat(g),
    firstPrAt: g.firstPrAt ?? null, lastPrAt: g.lastPrAt ?? null, lastOsMergedAt: g.lastOsMergedAt ?? null,
  }]));
  const repos = new Map(repoRows.map((g) => [g._id, {
    prs: g.prs, merged: g.merged, open: g.open, closed: g.closed, students: g.students,
    campuses: [...g.campuses].sort(), firstPrAt: g.firstPrAt ?? null, lastPrAt: g.lastPrAt ?? null,
  }]));
  const owners = new Map(ownerRows.map((g) => [g._id, {
    repos: g.repos, prs: g.prs, merged: g.merged, osPrs: g.osPrs, osMerged: g.osMerged, students: g.students,
    maxStars: g.maxStars ?? 0, byCategory: byCat(g),
  }]));

  await Promise.all([
    writeStats(c.students, students, emptyStudentStats),
    writeStats(c.repos, repos, emptyRepoStats),
    writeStats(c.owners, owners, emptyOwnerStats),
  ]);
}
