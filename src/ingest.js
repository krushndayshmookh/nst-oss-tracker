// PR ingestion (raw GraphQL nodes -> prs / repos / owners) and aggregate refresh (SPEC sections 2-4).
import { collections } from './db.js';
import { CATEGORIES, classify, loadContext, reclassify } from './classify.js';
import { recomputeDomains } from './tech.js';

const lc = (s) => String(s ?? '').toLowerCase();
const date = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const num = (v) => (Number.isFinite(v) ? v : 0);

/**
 * GraphQL `languages{totalSize edges{size node{name}}}` -> [{ name, bytes, pct }] (largest first), or undefined when the
 * node does not carry the field (legacy raw files): stored values are then left alone.
 */
export function parseLanguages(conn) {
  if (!conn || !Array.isArray(conn.edges)) return undefined;
  const total = Number(conn.totalSize) || conn.edges.reduce((s, e) => s + (Number(e?.size) || 0), 0);
  return conn.edges.filter((e) => e?.node?.name).map((e) => {
    const bytes = Number(e.size) || 0;
    return { name: e.node.name, bytes, pct: total > 0 ? Math.round((bytes * 1000) / total) / 10 : 0 };
  }).sort((a, b) => b.bytes - a.bytes);
}
/** GraphQL `repositoryTopics{nodes{topic{name}}}` -> ['topic', …] (lowercase), or undefined when absent. */
export function parseTopics(conn) {
  if (!conn || !Array.isArray(conn.nodes)) return undefined;
  return [...new Set(conn.nodes.map((n) => String(n?.topic?.name ?? '').trim().toLowerCase()).filter(Boolean))];
}

export function emptyByCategory() {
  return Object.fromEntries(CATEGORIES.map((k) => [k, 0]));
}

export function emptyStudentStats() {
  return {
    totalPrs: 0, mergedPrs: 0, osPrs: 0, osMerged: 0, osOpen: 0, osMajorMerged: 0, osRepos: 0, osOrgs: 0,
    byCategory: emptyByCategory(), firstPrAt: null, lastPrAt: null, lastOsMergedAt: null,
    osClosed: 0, totalIssues: 0, osIssues: 0, totalReviews: 0, osReviews: 0, osContributions: 0, lastActivityAt: null,
  };
}
export function emptyRepoStats() {
  return { prs: 0, merged: 0, open: 0, closed: 0, students: 0, campuses: [], firstPrAt: null, lastPrAt: null, issues: 0, reviews: 0 };
}
export function emptyOwnerStats() {
  return {
    repos: 0, prs: 0, merged: 0, osPrs: 0, osMerged: 0, students: 0, maxStars: 0, byCategory: emptyByCategory(),
    issues: 0, reviews: 0, osIssues: 0, osReviews: 0,
  };
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
      _id: n.url, url: n.url, ...(Number.isFinite(n.databaseId) && { ghId: n.databaseId }), number: num(n.number), title: String(n.title ?? '').split(/\s+/).filter(Boolean).join(' '),
      author: student._id, authorLogin: n.author?.login || student.username || student._id,
      repo, repoLc, owner, ownerLc, ownerType,
      state: mergedAt ? 'merged' : (n.state === 'OPEN' ? 'open' : 'closed'),
      isDraft: Boolean(n.isDraft), createdAt: date(n.createdAt), mergedAt, closedAt: date(n.closedAt), updatedAt: date(n.updatedAt),
      additions: num(n.additions), deletions: num(n.deletions), changedFiles: num(n.changedFiles),
      comments: num(n.comments?.totalCount), reviews: num(n.reviews?.totalCount), stars,
      campus: student.campus ?? 'Unknown', batch: student.batch ?? null, active: student.active !== false,
    });
    const languages = parseLanguages(r.languages);
    const topics = parseTopics(r.repositoryTopics);
    repos.set(repoLc, {
      _id: repoLc, name: repo, owner, ownerLc, ownerType, stars, forks: num(r.forkCount),
      isFork: Boolean(r.isFork), isArchived: Boolean(r.isArchived), language: r.primaryLanguage?.name ?? null,
      license: r.licenseInfo?.spdxId ?? null, description: r.description ?? null,
      // newer fetches carry the languages by size and the topics (SPEC addendum H); legacy nodes do not
      ...(languages && { languages }), ...(topics && { topics }),
    });
    owners.set(ownerLc, { _id: ownerLc, login: owner, type: ownerType });
  }
  return { prs, repos, owners, githubId, skippedPrivate };
}

const strip = ({ _id, ...rest }) => rest;

/**
 * `insertOnly` (used by the legacy import): the document is written only when it does not exist yet, so a re-run of
 * the import can never put old file contents over what a later sync stored.
 */
export function prUpsertOp(doc, cls, { insertOnly = false } = {}) {
  const set = strip(doc);
  const onInsert = { override: null };
  if (cls) Object.assign(set, cls);
  else Object.assign(onInsert, { category: 'low_signal', tier: null, reason: 'not classified yet' });
  let update = { $set: set, $setOnInsert: onInsert };
  if (insertOnly) {
    // the denormalised student fields are the one thing refreshed on an existing PR (they come from the stored student)
    const { campus, batch, active, ...rest } = set;
    update = { $set: { campus, batch, active }, $setOnInsert: { ...rest, ...onInsert } };
  }
  return { updateOne: { filter: { _id: doc._id }, update, upsert: true } };
}
export function repoUpsertOp(doc, cls, { insertOnly = false } = {}) {
  const set = strip(doc);
  const onInsert = { override: null, stats: emptyRepoStats() };
  if (cls) Object.assign(set, cls);
  else Object.assign(onInsert, { category: 'low_signal', tier: null, reason: 'not classified yet' });
  const update = insertOnly ? { $setOnInsert: { ...set, ...onInsert } } : { $set: set, $setOnInsert: onInsert };
  return { updateOne: { filter: { _id: doc._id }, update, upsert: true } };
}
export function ownerUpsertOp(doc, { insertOnly = false } = {}) {
  const onInsert = { override: null, stats: emptyOwnerStats() };
  const update = insertOnly ? { $setOnInsert: { ...strip(doc), ...onInsert } } : { $set: strip(doc), $setOnInsert: onInsert };
  return { updateOne: { filter: { _id: doc._id }, update, upsert: true } };
}

export async function bulk(coll, ops, size = 2000) {
  for (let i = 0; i < ops.length; i += size) await coll.bulkWrite(ops.slice(i, i + size), { ordered: false });
}

/**
 * Upserts the PRs of one student. Preserves overrides, skips private repos, dedupes by url, upserts repo / owner
 * metadata, classifies with the current rules and sets student.githubId when missing. Does NOT touch aggregates.
 * `student` is the students doc (needs _id, username, campus, batch, active, githubId).
 * A repo whose class changed (its stars crossed a threshold) gets its other stored PRs reclassified.
 * Returns { prs: n, repos: n }.
 */
export async function upsertPRs(db, student, nodes, { onlyUrls = null } = {}) {
  const c = collections(db);
  const built = buildDocs(student, nodes);
  const { repos, owners, githubId } = built;
  // `onlyUrls` (a Set): write the PR documents of these urls only, but the repo / owner metadata of every node. The
  // nightly sync uses it for PRs whose updatedAt did not change: the PR is left alone, the fresh star count is kept.
  const prs = onlyUrls ? built.prs.filter((p) => onlyUrls.has(p._id)) : built.prs;
  if (githubId !== null && !student.githubId) {
    await c.students.updateOne({ _id: student._id, $or: [{ githubId: null }, { githubId: { $exists: false } }] }, { $set: { githubId } });
    student.githubId = githubId;
  }
  if (!prs.length && !repos.size) return { prs: 0, repos: 0 };
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
  if (drifted.length) await reclassify(db, { prFilter: { repoLc: { $in: drifted } }, repoFilter: null, contribFilter: { repoLc: { $in: drifted } }, ctx });
  // technology domain of the repos just written (their language / topics / description may have changed)
  await recomputeDomains(db, { filter: { _id: { $in: repoIds } } });
  return { prs: prs.length, repos: repos.size };
}

/**
 * After a COMPLETE full-history fetch of one student: removes that student's stored PRs that GitHub no longer returns.
 * A PR's url (= _id) changes when its repository is renamed or transferred and when the owner account is renamed, so
 * without this every such PR would be stored, and counted, twice; PRs of deleted or now-private repos disappear too.
 * A stored PR that came back under a new url (same GitHub id, or same number + creation time) is "moved": an admin
 * override on it, and an override on its old repository, are carried over to the new url / repository.
 * Guards: nothing is removed when the fetch returned no PR at all, or when more than half of the stored PRs (and more
 * than 20) would vanish without a new url: that looks like a GitHub hiccup, not like reality.
 * `nodes` are the raw nodes of the fetch. Does NOT touch aggregates. -> { removed, moved, skipped }
 */
export async function pruneStalePRs(db, student, nodes) {
  const c = collections(db);
  const fetched = buildDocs(student, nodes).prs;
  const out = { removed: 0, moved: 0, skipped: '' };
  const stored = await c.prs.find({ author: student._id },
    { projection: { number: 1, createdAt: 1, ghId: 1, repoLc: 1, override: 1, overrideNote: 1, overrideAt: 1 } }).toArray();
  const urls = new Set(fetched.map((p) => p._id));
  const stale = stored.filter((p) => !urls.has(p._id));
  if (!stale.length) return out;
  if (!fetched.length) { out.skipped = `GitHub returned no PRs but ${stored.length} are stored`; return out; }

  const key = (p) => `${p.number}|${p.createdAt instanceof Date ? p.createdAt.getTime() : ''}`;
  const byGhId = new Map();
  const byKey = new Map();
  for (const p of fetched) {
    if (p.ghId) byGhId.set(p.ghId, p);
    byKey.set(key(p), p);
  }
  const moves = []; // [stored doc, fetched doc]
  for (const old of stale) {
    const now = (old.ghId && byGhId.get(old.ghId)) || byKey.get(key(old));
    if (now) moves.push([old, now]);
  }
  const vanished = stale.length - moves.length;
  if (vanished > 20 && vanished > stored.length / 2) {
    out.skipped = `${vanished} of ${stored.length} stored PRs are missing from the fetch`;
    return out;
  }

  const prIds = [];
  const repoMoves = new Map();
  for (const [old, now] of moves) {
    if (old.override) {
      const upd = await c.prs.updateOne({ _id: now._id, override: null },
        { $set: { override: old.override, overrideNote: old.overrideNote ?? null, overrideAt: old.overrideAt ?? null } });
      if (upd.modifiedCount) prIds.push(now._id);
    }
    if (old.repoLc !== now.repoLc) repoMoves.set(old.repoLc, now.repoLc);
  }
  const repoIds = [];
  if (repoMoves.size) {
    for (const r of await c.repos.find({ _id: { $in: [...repoMoves.keys()] }, override: { $ne: null } }).toArray()) {
      const to = repoMoves.get(r._id);
      const upd = await c.repos.updateOne({ _id: to, override: null },
        { $set: { override: r.override, overrideNote: r.overrideNote ?? null, overrideAt: r.overrideAt ?? null } });
      if (upd.modifiedCount) repoIds.push(to);
    }
  }
  await c.prs.deleteMany({ author: student._id, _id: { $in: stale.map((p) => p._id) } });
  if (prIds.length || repoIds.length) {
    await reclassify(db, {
      prFilter: { $or: [{ _id: { $in: prIds } }, { repoLc: { $in: repoIds } }] },
      repoFilter: repoIds.length ? { _id: { $in: repoIds } } : null,
      contribFilter: repoIds.length ? { repoLc: { $in: repoIds } } : null,
    });
  }
  out.moved = moves.length;
  out.removed = vanished;
  return out;
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
 * Recomputes students.stats, repos.stats and owners.stats from the PRs and the contributions (issues, reviews; SPEC
 * addendum I4) with active:true. Three $group pipelines over prs, three over contributions, merged in memory; only
 * documents whose stats changed are written.
 */
export async function refreshAggregates(db) {
  const c = collections(db);
  const active = { $match: { active: true } };
  const opt = { allowDiskUse: true };

  const contribs = db.collection('contributions');
  const ISSUE = eq('$kind', 'issue');
  const REVIEW = eq('$kind', 'review');
  const [studentRows, repoRows, ownerRows, cStudentRows, cRepoRows, cOwnerRows] = await Promise.all([
    c.prs.aggregate([active, { $group: {
      _id: '$author',
      totalPrs: { $sum: 1 }, mergedPrs: sumIf(MERGED), osPrs: sumIf(OS), osMerged: sumIf({ $and: [OS, MERGED] }),
      osOpen: sumIf({ $and: [OS, eq('$state', 'open')] }), osClosed: sumIf({ $and: [OS, eq('$state', 'closed')] }),
      osMajorMerged: sumIf({ $and: [OS, MERGED, eq('$tier', 'major')] }),
      osRepos: { $addToSet: { $cond: [OS, '$repoLc', null] } },
      osOrgs: { $addToSet: { $cond: [OS, '$ownerLc', null] } },
      ...catSums(),
      firstPrAt: { $min: '$createdAt' }, lastPrAt: { $max: '$createdAt' },
      lastOsMergedAt: { $max: { $cond: [{ $and: [OS, MERGED] }, '$mergedAt', null] } },
    } }, { $project: {
      totalPrs: 1, mergedPrs: 1, osPrs: 1, osMerged: 1, osOpen: 1, osClosed: 1, osMajorMerged: 1, firstPrAt: 1, lastPrAt: 1, lastOsMergedAt: 1,
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
    contribs.aggregate([active, { $group: {
      _id: '$author',
      issues: sumIf(ISSUE), osIssues: sumIf({ $and: [OS, ISSUE] }), reviews: sumIf(REVIEW), osReviews: sumIf({ $and: [OS, REVIEW] }),
      lastAt: { $max: { $cond: [REVIEW, { $ifNull: ['$lastReviewedAt', '$createdAt'] }, '$createdAt'] } },
    } }], opt).toArray(),
    contribs.aggregate([active, { $group: { _id: '$repoLc', issues: sumIf(ISSUE), reviews: sumIf(REVIEW) } }], opt).toArray(),
    contribs.aggregate([active, { $group: {
      _id: '$ownerLc',
      issues: sumIf(ISSUE), reviews: sumIf(REVIEW), osIssues: sumIf({ $and: [OS, ISSUE] }), osReviews: sumIf({ $and: [OS, REVIEW] }),
    } }], opt).toArray(),
  ]);
  const cStudents = new Map(cStudentRows.map((g) => [g._id, g]));
  const cRepos = new Map(cRepoRows.map((g) => [g._id, g]));
  const cOwners = new Map(cOwnerRows.map((g) => [g._id, g]));
  const later = (a, b) => (!a ? (b ?? null) : !b ? a : (b > a ? b : a));

  // PR part first (key order is fixed by the empty*Stats constructors, so unchanged stats compare equal)
  const students = new Map(studentRows.map((g) => [g._id, {
    ...emptyStudentStats(),
    totalPrs: g.totalPrs, mergedPrs: g.mergedPrs, osPrs: g.osPrs, osMerged: g.osMerged, osOpen: g.osOpen, osMajorMerged: g.osMajorMerged,
    osRepos: g.osRepos, osOrgs: g.osOrgs, byCategory: byCat(g),
    firstPrAt: g.firstPrAt ?? null, lastPrAt: g.lastPrAt ?? null, lastOsMergedAt: g.lastOsMergedAt ?? null,
    osClosed: g.osClosed, osContributions: g.osPrs, lastActivityAt: g.lastPrAt ?? null,
  }]));
  for (const [id, g] of cStudents) {
    const s = students.get(id) ?? emptyStudentStats();
    s.totalIssues = g.issues; s.osIssues = g.osIssues; s.totalReviews = g.reviews; s.osReviews = g.osReviews;
    s.osContributions = s.osPrs + g.osIssues + g.osReviews;
    s.lastActivityAt = later(s.lastActivityAt, g.lastAt ?? null);
    students.set(id, s);
  }
  const repos = new Map(repoRows.map((g) => [g._id, {
    ...emptyRepoStats(),
    prs: g.prs, merged: g.merged, open: g.open, closed: g.closed, students: g.students,
    campuses: [...g.campuses].sort(), firstPrAt: g.firstPrAt ?? null, lastPrAt: g.lastPrAt ?? null,
  }]));
  for (const [id, g] of cRepos) {
    const s = repos.get(id) ?? emptyRepoStats();
    s.issues = g.issues; s.reviews = g.reviews;
    repos.set(id, s);
  }
  const owners = new Map(ownerRows.map((g) => [g._id, {
    ...emptyOwnerStats(),
    repos: g.repos, prs: g.prs, merged: g.merged, osPrs: g.osPrs, osMerged: g.osMerged, students: g.students,
    maxStars: g.maxStars ?? 0, byCategory: byCat(g),
  }]));
  for (const [id, g] of cOwners) {
    const s = owners.get(id) ?? emptyOwnerStats();
    s.issues = g.issues; s.reviews = g.reviews; s.osIssues = g.osIssues; s.osReviews = g.osReviews;
    owners.set(id, s);
  }

  await Promise.all([
    writeStats(c.students, students, emptyStudentStats),
    writeStats(c.repos, repos, emptyRepoStats),
    writeStats(c.owners, owners, emptyOwnerStats),
  ]);
}
