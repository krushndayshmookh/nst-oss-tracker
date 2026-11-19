// Classification (SPEC section 3): a pure function plus bulk recompute helpers.
import { collections } from './db.js';
import { loadRules, normalizeRules } from './rules.js';
import { refreshAggregates } from './ingest.js';
import { config } from './config.js';

export const CATEGORIES = ['open_source', 'practice', 'nst_internal', 'peer_repo', 'own_repo', 'low_signal'];
export const TIERS = ['major', 'established', 'emerging'];
export const CAMPUSES = ['ADYPU', 'RU', 'SVYASA', 'SMRU', 'Unknown'];
export const YEAR_LABELS = ['1st year', '2nd year', '3rd year', '4th year', 'alumni', 'Unknown'];

// ---------- academic year helpers ----------

const ayFormat = new Intl.DateTimeFormat('en-US', { timeZone: config.tzName, year: 'numeric', month: 'numeric' });

/** Start year of the academic year containing `now` (AY starts 1 July 00:00 in config.tzName, Asia/Kolkata by default). */
export function academicYearStart(now = new Date()) {
  let year = 0;
  let month = 0;
  for (const p of ayFormat.formatToParts(now)) {
    if (p.type === 'year') year = Number(p.value);
    if (p.type === 'month') month = Number(p.value);
  }
  return month >= 7 ? year : year - 1;
}

/** batch (admission year) -> '1st year'..'4th year' | 'alumni' | 'Unknown' (no batch, or a batch that has not started yet). */
export function yearLabel(batch, now = new Date()) {
  if (batch === null || batch === undefined || !Number.isFinite(batch)) return 'Unknown';
  const y = academicYearStart(now) - batch + 1;
  if (y < 1) return 'Unknown';
  if (y > 4) return 'alumni';
  return YEAR_LABELS[y - 1];
}

/**
 * Inverse of yearLabel, as a Mongo filter fragment: {batch:n} | {batch:{$lt:n}} (alumni) |
 * {batch:{$not:{$lte:n}}} ('Unknown': no batch or a future batch, exactly the rows yearLabel calls Unknown); null for an unknown label.
 */
export function batchesForYear(label, now = new Date()) {
  const ay = academicYearStart(now);
  const idx = YEAR_LABELS.indexOf(label);
  if (idx < 0) return null;
  if (idx <= 3) return { batch: ay - idx };
  if (label === 'alumni') return { batch: { $lt: ay - 3 } };
  return { batch: { $not: { $lte: ay } } };
}

// ---------- pure classification ----------

const lc = (s) => String(s ?? '').toLowerCase();

/** Pre-computes lowercase sets from a rules doc. `students` is a Set of lowercase ids + current usernames. */
export function compileRules(rules, students = new Set(), usernames = new Map()) {
  const r = normalizeRules(rules);
  return {
    rules: r,
    tiers: r.tiers,
    minStarsUserRepo: r.minStarsUserRepo,
    minStarsOrgRepo: r.minStarsOrgRepo,
    nstOrgs: new Set(r.nstOrgs.map(lc)),
    nstOwnerKeywords: r.nstOwnerKeywords.map(lc).filter(Boolean),
    practiceRepos: new Set(r.practiceRepos.map(lc)),
    practiceKeywords: r.practiceKeywords.map(lc).filter(Boolean),
    allowOrgs: new Set(r.allowOrgs.map(lc)),
    students,            // Set<lowercase login>: every tracked student, by _id and by current username
    usernames,           // Map<student _id, lowercase current username>
  };
}

export function tierFor(stars, ctx) {
  if (stars >= ctx.tiers.major) return 'major';
  if (stars >= ctx.tiers.established) return 'established';
  return 'emerging';
}

/** Keywords of length <= 4 must equal a whole token of the owner (split on non-alphanumerics); longer ones may be substrings. */
export function isNstOwner(ownerLc, ctx) {
  if (ctx.nstOrgs.has(ownerLc)) return true;
  if (!ctx.nstOwnerKeywords.length) return false;
  let toks = null;
  for (const k of ctx.nstOwnerKeywords) {
    if (k.length <= 4) {
      toks ??= ownerLc.split(/[^a-z0-9]+/);
      if (toks.includes(k)) return true;
    } else if (ownerLc.includes(k)) return true;
  }
  return false;
}

/**
 * The classification function. First match wins.
 * input: { repo ('owner/name'), ownerType, stars, isFork, repoOverride, ownerOverride,
 *          author (student _id, omit for the repo-level category), prOverride }
 * ctx: compileRules(...)
 * returns { category, tier, reason }
 */
export function classify(input, ctx) {
  const repoLc = lc(input.repo);
  const slash = repoLc.indexOf('/');
  const ownerLc = slash < 0 ? repoLc : repoLc.slice(0, slash);
  const nameLc = slash < 0 ? '' : repoLc.slice(slash + 1);
  const stars = Number(input.stars) || 0;
  const open = (reason) => {
    const tier = tierFor(stars, ctx);
    return { category: 'open_source', tier, reason: reason || tier };
  };
  const other = (category, reason) => ({ category, tier: null, reason });

  // 1. PR override
  if (input.prOverride === 'open_source') return open('admin: marked open source');
  if (input.prOverride === 'not_open_source') return other('low_signal', 'admin: marked not open source');
  // 2. repo override
  if (input.repoOverride === 'include') return open('admin: repo included');
  if (input.repoOverride === 'exclude') return other('low_signal', 'admin: repo excluded');
  // 3. owner override
  if (input.ownerOverride === 'include') return open('admin: org included');
  if (input.ownerOverride === 'exclude') return other('low_signal', 'admin: org excluded');
  if (input.ownerOverride === 'nst_internal') return other('nst_internal', 'admin: org marked NST internal');
  // 4. own repo (PR level only)
  if (input.author) {
    const a = lc(input.author);
    if (ownerLc === a || ownerLc === ctx.usernames.get(a)) return other('own_repo', 'author owns repo');
  }
  // 5. NST org / keyword
  if (isNstOwner(ownerLc, ctx)) return other('nst_internal', 'NST org/keyword');
  // 6. repo of another tracked student
  if (ctx.students.has(ownerLc)) return other('peer_repo', 'owner is an NST student');
  // 7. practice / event repos
  if (ctx.practiceRepos.has(repoLc)) return other('practice', 'practice/event repo');
  for (const k of ctx.practiceKeywords) {
    if (nameLc.includes(k) || ownerLc.includes(k)) return other('practice', 'practice/event repo');
  }
  // 8. forks
  if (input.isFork) return other('low_signal', 'repo is a fork');
  // 9. allow-listed orgs
  if (ctx.allowOrgs.has(ownerLc)) return open();
  // 10. personal repos
  if (input.ownerType === 'User' && stars < ctx.minStarsUserRepo) return other('low_signal', `personal repo under ${ctx.minStarsUserRepo} stars`);
  // 11. small repos
  if (stars < ctx.minStarsOrgRepo) return other('low_signal', `under ${ctx.minStarsOrgRepo} stars`);
  // 12.
  return open();
}

// ---------- context loading ----------

let ctxCache = null; // { db, at, ctx }
const CTX_TTL_MS = 15000;

/** Loads rules + the set of tracked students. `fresh:false` allows a short-lived per-process cache (used by ingest). */
export async function loadContext(db, { fresh = true } = {}) {
  if (!fresh && ctxCache && ctxCache.db === db && Date.now() - ctxCache.at < CTX_TTL_MS) return ctxCache.ctx;
  const { students } = collections(db);
  const rules = await loadRules(db);
  const set = new Set();
  const usernames = new Map();
  for await (const s of students.find({}, { projection: { username: 1 } })) {
    set.add(s._id);
    const u = lc(s.username);
    if (u) { set.add(u); usernames.set(s._id, u); }
  }
  const ctx = compileRules(rules, set, usernames);
  ctxCache = { db, at: Date.now(), ctx };
  return ctx;
}

export function invalidateContext() {
  ctxCache = null;
}

// ---------- bulk recompute ----------

const BATCH = 2000;

async function flush(coll, ops) {
  for (let i = 0; i < ops.length; i += BATCH) {
    await coll.bulkWrite(ops.slice(i, i + BATCH), { ordered: false });
  }
}

/**
 * Recomputes category / tier / reason for the PRs matching `prFilter` and the repos matching `repoFilter`
 * (`null` skips that collection). Only changed documents are written. Does NOT refresh aggregates.
 * Returns { prs, repos, prsChanged, reposChanged } (examined / changed counts).
 */
export async function reclassify(db, { prFilter = {}, repoFilter = {}, ctx = null } = {}) {
  const c = collections(db);
  ctx ??= await loadContext(db);
  const ownerOverrides = new Map();
  for await (const o of c.owners.find({ override: { $ne: null } }, { projection: { override: 1 } })) {
    if (o.override) ownerOverrides.set(o._id, o.override);
  }
  const repoProj = { name: 1, ownerLc: 1, ownerType: 1, stars: 1, isFork: 1, override: 1, category: 1, tier: 1, reason: 1 };
  const result = { prs: 0, repos: 0, prsChanged: 0, reposChanged: 0 };

  // PRs first (their repos are needed, whether or not those match repoFilter)
  const repoMap = new Map();
  if (prFilter) {
    const prs = await c.prs.find(prFilter, {
      projection: { author: 1, repo: 1, repoLc: 1, ownerLc: 1, ownerType: 1, stars: 1, override: 1, category: 1, tier: 1, reason: 1 },
    }).toArray();
    result.prs = prs.length;
    const full = Object.keys(prFilter).length === 0;
    if (full) {
      for await (const r of c.repos.find({}, { projection: repoProj })) repoMap.set(r._id, r);
    } else {
      const ids = [...new Set(prs.map((p) => p.repoLc))];
      for (let i = 0; i < ids.length; i += 5000) {
        for await (const r of c.repos.find({ _id: { $in: ids.slice(i, i + 5000) } }, { projection: repoProj })) repoMap.set(r._id, r);
      }
    }
    const ops = [];
    for (const p of prs) {
      const r = repoMap.get(p.repoLc);
      const stars = r ? r.stars : p.stars;
      const res = classify({
        repo: p.repoLc, ownerType: r ? r.ownerType : p.ownerType, stars, isFork: r ? r.isFork : false,
        repoOverride: r?.override ?? null, ownerOverride: ownerOverrides.get(p.ownerLc) ?? null,
        author: p.author, prOverride: p.override ?? null,
      }, ctx);
      if (res.category !== p.category || res.tier !== (p.tier ?? null) || res.reason !== p.reason || stars !== p.stars) {
        ops.push({ updateOne: { filter: { _id: p._id }, update: { $set: { ...res, stars } } } });
      }
    }
    result.prsChanged = ops.length;
    await flush(c.prs, ops);
  }

  if (repoFilter) {
    const ops = [];
    const full = Object.keys(repoFilter).length === 0;
    const source = full && repoMap.size && prFilter && Object.keys(prFilter).length === 0
      ? repoMap.values()
      : c.repos.find(repoFilter, { projection: repoProj });
    for await (const r of source) {
      result.repos++;
      const res = classify({
        repo: r._id, ownerType: r.ownerType, stars: r.stars, isFork: r.isFork,
        repoOverride: r.override ?? null, ownerOverride: ownerOverrides.get(r.ownerLc) ?? null,
      }, ctx);
      if (res.category !== r.category || res.tier !== (r.tier ?? null) || res.reason !== r.reason) {
        ops.push({ updateOne: { filter: { _id: r._id }, update: { $set: res } } });
      }
    }
    result.reposChanged = ops.length;
    await flush(c.repos, ops);
  }
  return result;
}

/** Recomputes every PR and repo with the current rules, then all aggregates. */
export async function reclassifyAll(db) {
  invalidateContext();
  const result = await reclassify(db, { prFilter: {}, repoFilter: {} });
  await refreshAggregates(db);
  return result;
}
