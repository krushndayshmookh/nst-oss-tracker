// Shared by routes/public.js and routes/admin.js: query parsing, filters and response serialisers (SPEC Appendix A).
import { collections } from '../db.js';
import { ApiError, badRequest } from '../auth.js';
import { CAMPUSES, CATEGORIES, TIERS, YEAR_LABELS, batchesForYear, yearLabel } from '../classify.js';
import { emptyByCategory, emptyOwnerStats, emptyRepoStats, emptyStudentStats } from '../ingest.js';
import { inRange } from '../dates.js';
import { allOf } from '../ranged.js';
import { domainLabel } from '../tech.js';

export { ApiError, badRequest };
export const STATES = ['open', 'merged', 'closed'];

export const iso = (d) => (d instanceof Date ? d.toISOString() : (d ? new Date(d).toISOString() : null));
export const lc = (s) => String(s ?? '').toLowerCase();
export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const contains = (q) => ({ $regex: escapeRegex(q), $options: 'i' });

// ---------- query parsing ----------

/** First value of a query param as a trimmed string; '' when absent. */
export function str(query, name) {
  let v = query?.[name];
  if (Array.isArray(v)) v = v[0];
  if (v === undefined || v === null || typeof v === 'object') return '';
  return String(v).trim();
}

export function oneOf(query, name, allowed, def = '') {
  const v = str(query, name);
  if (!v) return def;
  if (!allowed.includes(v)) throw badRequest(`invalid ${name}: expected one of ${allowed.join(', ')}`);
  return v;
}

export function intParam(query, name, { min = 0, max = Number.MAX_SAFE_INTEGER, def = null } = {}) {
  const v = str(query, name);
  if (!v) return def;
  if (!/^-?\d+$/.test(v)) throw badRequest(`invalid ${name}: expected an integer`);
  const n = Number(v);
  if (n < min || n > max) throw badRequest(`invalid ${name}: expected ${min}..${max}`);
  return n;
}

export function flag(query, name) {
  const v = str(query, name);
  if (!v) return null;
  if (['1', 'true'].includes(v)) return true;
  if (['0', 'false'].includes(v)) return false;
  throw badRequest(`invalid ${name}: expected 1 or 0`);
}

export function paging(query) {
  const page = intParam(query, 'page', { min: 1, max: 1000000, def: 1 });
  const limit = intParam(query, 'limit', { min: 1, max: 100, def: 25 });
  return { page, limit, skip: (page - 1) * limit };
}

export function sorting(query, allowed, def, ascByDefault = ['name', 'username']) {
  const sort = oneOf(query, 'sort', allowed, def);
  const order = oneOf(query, 'order', ['asc', 'desc'], ascByDefault.includes(sort) ? 'asc' : 'desc');
  return { sort, order, dir: order === 'asc' ? 1 : -1 };
}

export const MAX_SEARCH = 100;

/** The `q` search text; longer than MAX_SEARCH characters is a bad request (it is matched as an unanchored regex). */
export function search(query, name = 'q') {
  const v = str(query, name);
  if (v.length > MAX_SEARCH) throw badRequest(`invalid ${name}: at most ${MAX_SEARCH} characters`);
  return v;
}

/**
 * Which PRs belong to a date range (SPEC addendum A2): merged ones by mergedAt when `state` is 'merged', any other
 * single state by createdAt, and without a state filter everything opened or merged inside the range.
 */
export function prRangeFilter(range, state = '') {
  const cond = range ? inRange(range) : null;
  if (!cond) return {};
  if (state === 'merged') return { mergedAt: cond };
  if (state) return { createdAt: cond };
  return { $or: [{ createdAt: cond }, { mergedAt: cond }] };
}

/** campus / year / batch filter on fields `campus` and `batch` (students and prs share these names). */
export function cohortFilter(query, now = new Date()) {
  const f = {};
  const campus = oneOf(query, 'campus', CAMPUSES);
  if (campus) f.campus = campus;
  const year = oneOf(query, 'year', YEAR_LABELS);
  const batch = intParam(query, 'batch', { min: 1990, max: 2100 });
  if (year) Object.assign(f, batchesForYear(year, now));
  if (batch !== null) {
    if (year && yearLabel(batch, now) !== year) f.batch = { $in: [] }; // contradictory filters: no rows
    else f.batch = batch;
  }
  return f;
}

/** Case-insensitive student lookup by stable id or current username. */
export async function findStudent(db, name) {
  const { students } = collections(db);
  const key = lc(name).trim();
  if (!key) return null;
  return (await students.findOne({ _id: key }))
    || students.findOne({ username: { $regex: `^${escapeRegex(key)}$`, $options: 'i' } });
}

/** Mongo filter for PR lists / exports (active PRs only). `range` comes from dates.resolveRange (null = no date filter). */
export async function prFilter(db, query, { defaultCategory = 'open_source', range = null, impliedState = '' } = {}) {
  const f = { active: true, ...cohortFilter(query) };
  const category = oneOf(query, 'category', [...CATEGORIES, 'all'], defaultCategory);
  if (category !== 'all') f.category = category;
  const state = oneOf(query, 'state', STATES) || impliedState; // an explicit state wins
  if (state) f.state = state;
  const tier = oneOf(query, 'tier', TIERS);
  if (tier) f.tier = tier;
  const author = str(query, 'author');
  if (author) f.author = (await findStudent(db, author))?._id ?? lc(author);
  const repo = str(query, 'repo');
  if (repo) f.repoLc = lc(repo);
  const owner = str(query, 'owner');
  if (owner) f.ownerLc = lc(owner);
  const q = search(query);
  return allOf(f, q ? { $or: [{ title: contains(q) }, { repo: contains(q) }] } : null, prRangeFilter(range, state));
}

// ---------- serialisers ----------

export function statsOut(s) {
  const e = emptyStudentStats();
  s ||= e;
  return {
    totalPrs: s.totalPrs ?? 0, mergedPrs: s.mergedPrs ?? 0, osPrs: s.osPrs ?? 0, osMerged: s.osMerged ?? 0, osOpen: s.osOpen ?? 0,
    osMajorMerged: s.osMajorMerged ?? 0, osRepos: s.osRepos ?? 0, osOrgs: s.osOrgs ?? 0,
    byCategory: { ...emptyByCategory(), ...(s.byCategory || {}) },
    firstPrAt: iso(s.firstPrAt), lastPrAt: iso(s.lastPrAt), lastOsMergedAt: iso(s.lastOsMergedAt),
  };
}

/** Public student fields: username, name, campus, batch, year, stats. Nothing else. */
export function studentOut(s, now = new Date()) {
  return {
    username: s.username || s._id, name: s.name || '', campus: s.campus || 'Unknown', batch: s.batch ?? null,
    year: yearLabel(s.batch, now), stats: statsOut(s.stats),
  };
}

export const MISSING_KEYS = ['batch', 'campus', 'name', 'email', 'enrolmentNo', 'nameUnofficial', 'githubId', 'unresolved'];
const blank = (field) => ({ $or: [{ [field]: { $in: [null, ''] } }, { [field]: { $exists: false } }] });
/** Mongo filter per kind of missing data (SPEC addendum B). */
export const MISSING_FILTERS = {
  batch: { batch: null },
  campus: { $or: [{ campus: { $in: [null, '', 'Unknown'] } }, { campus: { $exists: false } }] },
  name: blank('name'),
  email: blank('email'),
  enrolmentNo: blank('enrolmentNo'),
  nameUnofficial: { nameSource: { $ne: 'sheet' } },
  githubId: { githubId: null },
  unresolved: { $or: [{ unresolvedSince: { $type: 'date' } }, { 'backfill.error': 'not_found' }] },
};
/** The same rules for one document: the list of missing keys. */
export function missingOf(s) {
  const out = [];
  if (s.batch === null || s.batch === undefined) out.push('batch');
  if (!s.campus || s.campus === 'Unknown') out.push('campus');
  if (!s.name) out.push('name');
  if (!s.email) out.push('email');
  if (!s.enrolmentNo) out.push('enrolmentNo');
  if (s.nameSource !== 'sheet') out.push('nameUnofficial');
  if (s.githubId === null || s.githubId === undefined) out.push('githubId');
  if (s.unresolvedSince instanceof Date || s.backfill?.error === 'not_found') out.push('unresolved');
  return out;
}

export function adminStudentOut(s, now = new Date()) {
  return {
    ...studentOut(s, now),
    unresolvedSince: iso(s.unresolvedSince), missing: missingOf(s),
    githubId: s.githubId ?? null, nameSource: s.nameSource || '', email: s.email || '', enrolmentNo: s.enrolmentNo || '',
    sources: s.sources || [], notes: s.notes || '', active: s.active !== false,
    backfill: { status: s.backfill?.status || 'pending', at: iso(s.backfill?.at), error: s.backfill?.error ?? null },
    lastSyncedAt: iso(s.lastSyncedAt), addedAt: iso(s.addedAt), addedBy: s.addedBy || 'import',
  };
}

/**
 * `students` is a Map<student _id, {username, name}> (see studentMap).
 * `overrideNote` is the admin's private reason for a decision: it is only returned to a logged-in admin (`admin: true`).
 */
export function prOut(p, students, now = new Date(), { admin = false } = {}) {
  const s = students?.get(p.author);
  return {
    url: p.url || p._id, number: p.number ?? 0, title: p.title || '', author: s?.username || p.authorLogin || p.author, authorName: s?.name || '',
    repo: p.repo, owner: p.owner, ownerType: p.ownerType, stars: p.stars ?? 0, state: p.state, isDraft: Boolean(p.isDraft),
    createdAt: iso(p.createdAt), mergedAt: iso(p.mergedAt), closedAt: iso(p.closedAt),
    additions: p.additions ?? 0, deletions: p.deletions ?? 0, changedFiles: p.changedFiles ?? 0, comments: p.comments ?? 0, reviews: p.reviews ?? 0,
    campus: p.campus || 'Unknown', batch: p.batch ?? null, year: yearLabel(p.batch, now),
    category: p.category, tier: p.tier ?? null, reason: p.reason || '', override: p.override ?? null, overrideNote: admin ? (p.overrideNote ?? null) : null,
  };
}

export function repoOut(r, { admin = false } = {}) {
  const s = { ...emptyRepoStats(), ...(r.stats || {}) };
  return {
    name: r.name || r._id, owner: r.owner, ownerType: r.ownerType, stars: r.stars ?? 0, forks: r.forks ?? 0, language: r.language ?? null,
    license: r.license ?? null, description: r.description ?? null, isFork: Boolean(r.isFork), isArchived: Boolean(r.isArchived),
    category: r.category, tier: r.tier ?? null, reason: r.reason || '', override: r.override ?? null, overrideNote: admin ? (r.overrideNote ?? null) : null,
    // technology (SPEC addendum H): languages by size and topics arrive with the repo metadata refresh
    languages: (r.languages || []).map((l) => ({ name: l.name, pct: l.pct ?? null })), topics: r.topics || [],
    domain: r.domain || 'other', domainLabel: domainLabel(r.domain || 'other'), domainReason: r.domainReason || '',
    metaFetchedAt: iso(r.metaFetchedAt), metaStatus: r.metaStatus || null,
    stats: { prs: s.prs, merged: s.merged, open: s.open, closed: s.closed, students: s.students, campuses: s.campuses || [],
      firstPrAt: iso(s.firstPrAt), lastPrAt: iso(s.lastPrAt) },
  };
}

export function orgOut(o, { admin = false } = {}) {
  const s = { ...emptyOwnerStats(), ...(o.stats || {}) };
  return {
    login: o.login || o._id, type: o.type || 'User', override: o.override ?? null, overrideNote: admin ? (o.overrideNote ?? null) : null,
    stats: { repos: s.repos, prs: s.prs, merged: s.merged, osPrs: s.osPrs, osMerged: s.osMerged, students: s.students, maxStars: s.maxStars ?? 0,
      byCategory: { ...emptyByCategory(), ...(s.byCategory || {}) } },
  };
}

export function jobOut(j, withLog = false) {
  const out = {
    id: j._id, type: j.type, runner: j.runner, status: j.status, params: j.params || {},
    createdAt: iso(j.createdAt), startedAt: iso(j.startedAt), finishedAt: iso(j.finishedAt),
    progress: { done: j.progress?.done ?? 0, total: j.progress?.total ?? 0 }, summary: j.summary ?? null, error: j.error ?? null,
    cancelRequested: Boolean(j.cancelRequested),
  };
  if (withLog) out.log = j.log || [];
  return out;
}

export function rulesOut(r) {
  return {
    tiers: { major: r.tiers.major, established: r.tiers.established }, minStarsUserRepo: r.minStarsUserRepo, minStarsOrgRepo: r.minStarsOrgRepo,
    nstOrgs: r.nstOrgs, nstOwnerKeywords: r.nstOwnerKeywords, practiceRepos: r.practiceRepos, practiceKeywords: r.practiceKeywords,
    allowOrgs: r.allowOrgs, updatedAt: iso(r.updatedAt),
  };
}

/** Map<student _id, {username, name}> for the authors of the given PRs (or every student when `ids` is omitted). */
export async function studentMap(db, ids) {
  const { students } = collections(db);
  const filter = ids ? { _id: { $in: [...new Set(ids)] } } : {};
  const map = new Map();
  for await (const s of students.find(filter, { projection: { username: 1, name: 1 } })) map.set(s._id, s);
  return map;
}

/** Runs a paged PR query and serialises it: { items, total, page, limit }. */
export async function prPage(db, filter, { sort = { createdAt: -1, _id: 1 }, page = 1, limit = 25, skip = 0, extra = null, admin = false } = {}) {
  const { prs } = collections(db);
  const [rows, total] = await Promise.all([
    prs.find(filter).sort(sort).skip(skip).limit(limit).maxTimeMS(15000).toArray(),
    prs.countDocuments(filter, { maxTimeMS: 15000 }),
  ]);
  const students = await studentMap(db, rows.map((p) => p.author));
  const now = new Date();
  const out = (p) => prOut(p, students, now, { admin });
  return { items: rows.map((p) => (extra ? { ...out(p), ...extra(p) } : out(p))), total, page, limit };
}

export const COLLATION = { locale: 'en', strength: 2 };
