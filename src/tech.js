// Technology distribution (SPEC addendum H): the domain rule table, repo classification and the /api/tech numbers.
//
// A repo's technology is read two ways:
//   language  the GitHub primary language (`repos.language`; the largest of `repos.languages` when that is missing;
//             '(none)' when GitHub detected none)
//   domain    one technology area from config/tech-domains.json: ordered rules over topics, repo / owner name words,
//             description words and the language; the first match wins, no match is 'other'. Stored on the repo as
//             `domain`, `domainRule` and `domainReason` and recomputed whenever the metadata or the rules change.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { collections } from './db.js';
import { CAMPUSES } from './classify.js';
import { createCache } from './cache.js';
import { TZ, inRange, zoned } from './dates.js';
import { AGG, allOf, per100, rangeFlags, rangeMatch, sumIf } from './ranged.js';

export const TECH_RULES_FILE = new URL('../config/tech-domains.json', import.meta.url);
export const LANG_NONE = '(none)';
export const OTHER = 'other';
export const REST_KEY = '_rest'; // the "everything else" series of byMonth
export const MATCH_FIELDS = ['topics', 'name', 'description', 'languages'];
const FIELD_WORDS = { topics: 'topic', name: 'name', description: 'description', languages: 'language' };

const lc = (s) => String(s ?? '').trim().toLowerCase();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- rule table ----------

let fileRules = null;
/** The rule table shipped in config/tech-domains.json (parsed once). */
export function defaultTechRules() {
  if (!fileRules) fileRules = JSON.parse(fs.readFileSync(TECH_RULES_FILE, 'utf8'));
  return fileRules;
}

/** Checks a rule table. -> { value } (normalised copy) | { error } */
export function validateTechRules(doc) {
  try {
    if (!doc || typeof doc !== 'object') throw new Error('rule table must be an object');
    if (!Array.isArray(doc.domains) || !doc.domains.length) throw new Error('domains must be a non-empty list');
    const domains = doc.domains.map((d, i) => {
      if (!d || typeof d.key !== 'string' || !/^[a-z0-9_]+$/.test(d.key)) throw new Error(`domains[${i}].key must be a lowercase identifier`);
      if (typeof d.label !== 'string' || !d.label.trim()) throw new Error(`domains[${i}].label must be a non-empty string`);
      return { key: d.key, label: d.label.trim() };
    });
    const keys = new Set(domains.map((d) => d.key));
    if (keys.size !== domains.length) throw new Error('domain keys must be unique');
    if (!keys.has(OTHER)) throw new Error(`domains must include "${OTHER}"`);
    if (!Array.isArray(doc.rules)) throw new Error('rules must be a list');
    const ids = new Set();
    const rules = doc.rules.map((r, i) => {
      if (!r || typeof r !== 'object') throw new Error(`rules[${i}] must be an object`);
      const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `rule-${i + 1}`;
      if (ids.has(id)) throw new Error(`rule id ${id} is used twice`);
      ids.add(id);
      if (!keys.has(r.domain)) throw new Error(`rules[${i}] (${id}): unknown domain ${JSON.stringify(r.domain)}`);
      const fields = MATCH_FIELDS.filter((f) => r[f] !== undefined);
      if (fields.length !== 1) throw new Error(`rules[${i}] (${id}): needs exactly one of ${MATCH_FIELDS.join(', ')}`);
      const list = r[fields[0]];
      if (!Array.isArray(list) || !list.length || list.some((k) => typeof k !== 'string' || !k.trim())) {
        throw new Error(`rules[${i}] (${id}): ${fields[0]} must be a non-empty list of strings`);
      }
      return { id, domain: r.domain, [fields[0]]: list.map((k) => k.trim()), ...(typeof r.note === 'string' && { note: r.note }) };
    });
    return { value: { version: Number(doc.version) || 1, domains, rules } };
  } catch (e) {
    return { error: e.message };
  }
}

/** Words of a repo / owner name: split on anything not alphanumeric and on camelCase humps, lowercased. */
export function nameTokens(s) {
  return String(s ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * One keyword -> predicate over the prepared fields of a repo (see prepare()).
 *   topics       exact topic, or a topic starting with it for 'kube*'
 *   name         a whole word of the repo name / owner login, or 2-3 consecutive words written together
 *                ('freecodecamp' matches freeCodeCamp, 'musicblocks' matches MusicBlocks); 'kube*' = a word starting with kube;
 *                'json-schema' = these words in this order
 *   description  whole words / phrases, 'vulnerabilit*' = a word starting with it
 *   languages    the language, exactly
 */
function matcher(field, raw) {
  const kw = lc(raw);
  const prefix = kw.endsWith('*');
  const word = prefix ? kw.slice(0, -1) : kw;
  if (field === 'languages') return (p) => p.language === kw;
  if (field === 'topics') return (p) => p.topics.some((t) => (prefix ? t.startsWith(word) : t === word));
  if (field === 'description') {
    const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(word)}${prefix ? '' : '(?:[^a-z0-9]|$)'}`);
    return (p) => Boolean(p.description) && re.test(p.description);
  }
  const parts = nameTokens(word);
  if (!parts.length) return () => false;
  if (parts.length > 1) {
    const seq = `-${parts.join('-')}${prefix ? '' : '-'}`;
    return (p) => p.joined.includes(seq);
  }
  const w = parts[0];
  if (prefix) return (p) => p.words.some((t) => t.startsWith(w));
  return (p) => p.words.includes(w);
}

/** Compiles a rule table (validated first; throws on an invalid one). */
export function compileTechRules(doc = defaultTechRules()) {
  const { value, error } = validateTechRules(doc);
  if (error) throw new Error(`invalid tech domain rules: ${error}`);
  const labels = new Map(value.domains.map((d) => [d.key, d.label]));
  const rules = value.rules.map((r) => {
    const field = MATCH_FIELDS.find((f) => r[f]);
    return { id: r.id, domain: r.domain, field, tests: r[field].map((k) => ({ keyword: k, test: matcher(field, k) })) };
  });
  const hash = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
  return { domains: value.domains, labels, rules, hash, table: value };
}

let compiledDefault = null;
const defaultCompiled = () => (compiledDefault ??= compileTechRules(defaultTechRules()));

/** Admin-edited rules live in settings {_id:'techDomains', rules:{…}}; the shipped file applies when there are none (or they are invalid). */
export async function loadTechRules(db) {
  const doc = await collections(db).settings.findOne({ _id: 'techDomains' });
  if (doc?.table) {
    try { return compileTechRules(doc.table); } catch { /* fall back to the shipped table */ }
  }
  return defaultCompiled();
}

/** The language a repo is counted under: primary language, else the largest by bytes, else '(none)'. */
export function languageOf(repo) {
  return repo?.language || repo?.languages?.[0]?.name || LANG_NONE;
}

function prepare(repo) {
  const name = repo.name || repo._id || '';
  const [owner = '', rest = ''] = String(name).split('/');
  const o = nameTokens(owner);
  const n = nameTokens(rest);
  // every word, plus 2-3 consecutive words written together (within the owner or within the repo name)
  const words = [];
  for (const list of [o, n]) {
    for (let i = 0; i < list.length; i++) {
      words.push(list[i]);
      if (i + 1 < list.length) words.push(list[i] + list[i + 1]);
      if (i + 2 < list.length) words.push(list[i] + list[i + 1] + list[i + 2]);
    }
  }
  return {
    words, joined: `-${o.join('-')}-${n.join('-')}-`,
    topics: (repo.topics || []).map(lc).filter(Boolean),
    description: lc(repo.description),
    language: lc(languageOf(repo)),
  };
}

/**
 * Pure: the domain of one repo ({ name 'owner/name', topics?, description?, language?, languages? }).
 * -> { domain, domainRule, domainReason }   first matching rule wins; none -> 'other'.
 */
export function classifyDomain(repo, compiled = defaultCompiled()) {
  const p = prepare(repo || {});
  for (const rule of compiled.rules) {
    for (const t of rule.tests) {
      if (!t.test(p)) continue;
      const what = rule.field === 'languages' ? `language ${languageOf(repo)}` : `${FIELD_WORDS[rule.field]} "${t.keyword}"`;
      return { domain: rule.domain, domainRule: rule.id, domainReason: `${what} (rule ${rule.id})` };
    }
  }
  return { domain: OTHER, domainRule: null, domainReason: 'no rule matched' };
}

export const domainLabel = (key, compiled = defaultCompiled()) => compiled.labels.get(key) || key;

const DOMAIN_PROJECTION = { name: 1, owner: 1, language: 1, languages: 1, topics: 1, description: 1, domain: 1, domainRule: 1, domainReason: 1 };

/**
 * Recomputes domain / domainRule / domainReason for the repos matching `filter` (all by default). Only changed
 * documents are written. -> { repos: examined, changed }
 */
export async function recomputeDomains(db, { filter = {}, compiled = null } = {}) {
  const { repos } = collections(db);
  compiled ??= await loadTechRules(db);
  const out = { repos: 0, changed: 0 };
  let ops = [];
  const flush = async () => {
    if (ops.length) await repos.bulkWrite(ops, { ordered: false });
    out.changed += ops.length;
    ops = [];
  };
  for await (const r of repos.find(filter, { projection: DOMAIN_PROJECTION })) {
    out.repos++;
    const d = classifyDomain(r, compiled);
    if (d.domain !== r.domain || d.domainRule !== (r.domainRule ?? null) || d.domainReason !== r.domainReason) {
      ops.push({ updateOne: { filter: { _id: r._id }, update: { $set: d } } });
      if (ops.length >= 2000) await flush();
    }
  }
  await flush();
  return out;
}

/**
 * On boot (and after an import): when the rule table differs from the one the stored domains were computed with,
 * every repo is classified again. -> { recomputed: boolean, repos?, changed? }
 */
export async function ensureDomains(db, { force = false } = {}) {
  const { settings, repos } = collections(db);
  const compiled = await loadTechRules(db);
  const state = await settings.findOne({ _id: 'techDomainsState' });
  const unclassified = await repos.countDocuments({ domain: { $exists: false } }, { limit: 1 });
  if (!force && state?.hash === compiled.hash && !unclassified) return { recomputed: false };
  const r = await recomputeDomains(db, { compiled });
  await settings.updateOne({ _id: 'techDomainsState' }, { $set: { hash: compiled.hash, at: new Date(), ...r } }, { upsert: true });
  return { recomputed: true, ...r };
}

// ---------- aggregation (GET /api/tech, profile / org mixes) ----------

const repoCache = createCache({ ttlMs: process.env.NODE_ENV === 'test' ? 0 : 60000, max: 4 });
/** Map<repoLc, { name, stars, language, domain }> of every repo (small: a few thousand entries), cached for a minute. */
export function repoTechMap(db) {
  return repoCache.memo(`repos:${db.databaseName}`, async () => {
    const compiled = await loadTechRules(db);
    const map = new Map();
    for await (const r of collections(db).repos.find({}, { projection: { ...DOMAIN_PROJECTION, stars: 1 } })) {
      const domain = r.domain && compiled.labels.has(r.domain) ? r.domain : classifyDomain(r, compiled).domain;
      map.set(r._id, { name: r.name || r._id, stars: r.stars ?? 0, language: languageOf(r), domain });
    }
    return { map, compiled };
  });
}

const one = (x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const share = (part, whole) => (whole > 0 ? one((part * 100) / whole) : null);
const keyOf = (by, info) => (by === 'language' ? (info?.language || LANG_NONE) : (info?.domain || OTHER));

/** Month keys 'YYYY-MM' from a to b inclusive. */
function monthsBetween(a, b) {
  const out = [];
  let [y, m] = a.split('-').map(Number);
  const [ey, em] = b.split('-').map(Number);
  while ((y < ey || (y === ey && m <= em)) && out.length < 1200) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * The PR data behind /api/tech for one range / category / cohort, independent of `by`:
 * pairs (repo x student: opened / merged in range, campus) and merged PRs per repo x month (in tz).
 */
export async function techBase(db, { range, category = 'open_source', cohort = {}, tz = TZ }) {
  const { prs } = collections(db);
  const { opened, merged } = rangeFlags(range);
  const cat = category === 'all' ? {} : { category };
  const cond = inRange(range);
  const [pairs, months, repos] = await Promise.all([
    prs.aggregate([
      { $match: allOf({ active: true, ...cat }, cohort, rangeMatch(range)) },
      { $group: { _id: { r: '$repoLc', a: '$author' }, c: { $first: '$campus' }, prs: sumIf(opened), merged: sumIf(merged) } },
    ], AGG).toArray(),
    prs.aggregate([
      { $match: allOf({ active: true, state: 'merged', ...cat }, cohort, { mergedAt: cond ? { ...cond, $type: 'date' } : { $type: 'date' } }) },
      { $group: { _id: { r: '$repoLc', m: { $dateToString: { date: '$mergedAt', format: '%Y-%m', timezone: tz } } }, n: { $sum: 1 } } },
    ], AGG).toArray(),
    repoTechMap(db),
  ]);
  return { pairs, months, repos: repos.map, compiled: repos.compiled };
}

/**
 * Builds the /api/tech body (without `range`) from techBase() for `by` ('language' | 'domain').
 * `cohorts` is Map<campus, active tracked students> for the per-100 rates (SPEC addendum D).
 */
export function techView(base, { by, cohorts = new Map(), range = {}, now = new Date(), tz = TZ, topMonthKeys = 8, smallCohortBelow = 30 }) {
  const { pairs, months, repos, compiled } = base;
  const label = (key) => (by === 'domain' ? domainLabel(key, compiled) : key);
  const rows = new Map();
  const campusCells = new Map();
  const totals = { prs: 0, merged: 0, students: 0, mergedStudents: 0, repos: 0, keys: 0 };
  const allStudents = new Set();
  const mergedStudents = new Set();
  const allRepos = new Set();
  for (const p of pairs) {
    const info = repos.get(p._id.r);
    const key = keyOf(by, info);
    let row = rows.get(key);
    if (!row) {
      row = { key, prs: 0, merged: 0, students: new Set(), mergedStudents: new Set(), repos: new Map() };
      rows.set(key, row);
    }
    row.prs += p.prs;
    row.merged += p.merged;
    row.students.add(p._id.a);
    if (p.merged > 0) row.mergedStudents.add(p._id.a);
    let repo = row.repos.get(p._id.r);
    if (!repo) { repo = { name: info?.name || p._id.r, stars: info?.stars ?? 0, prs: 0, merged: 0, students: 0 }; row.repos.set(p._id.r, repo); }
    repo.prs += p.prs;
    repo.merged += p.merged;
    repo.students++;
    totals.prs += p.prs;
    totals.merged += p.merged;
    allStudents.add(p._id.a);
    if (p.merged > 0) mergedStudents.add(p._id.a);
    allRepos.add(p._id.r);
    const campus = p.c || 'Unknown';
    const ck = `${campus}|${key}`;
    let cell = campusCells.get(ck);
    if (!cell) { cell = { campus, key, prs: 0, merged: 0, students: new Set() }; campusCells.set(ck, cell); }
    cell.prs += p.prs;
    cell.merged += p.merged;
    cell.students.add(p._id.a);
  }
  totals.students = allStudents.size;
  totals.mergedStudents = mergedStudents.size;
  totals.repos = allRepos.size;
  totals.keys = rows.size;

  const byRank = (a, b) => b.merged - a.merged || b.prs - a.prs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const outRows = [...rows.values()].sort(byRank).map((r) => ({
    key: r.key, label: label(r.key),
    prs: r.prs, merged: r.merged, students: r.students.size, mergedStudents: r.mergedStudents.size, repos: r.repos.size,
    share: share(r.prs, totals.prs), mergedShare: share(r.merged, totals.merged), studentShare: share(r.students.size, totals.students),
    topRepos: [...r.repos.values()].sort((a, b) => b.merged - a.merged || b.prs - a.prs || b.students - a.students || (a.name < b.name ? -1 : 1)).slice(0, 3),
  }));

  // campus x key, with the cohort sizes of addendum D (null rates for an empty cohort)
  const campusRank = (x) => { const i = CAMPUSES.indexOf(x); return i < 0 ? CAMPUSES.length : i; };
  const keyRank = new Map(outRows.map((r, i) => [r.key, i]));
  const byCampus = [...campusCells.values()].map((c) => {
    const students = cohorts.get(c.campus) ?? 0;
    return { campus: c.campus, key: c.key, label: label(c.key), prs: c.prs, merged: c.merged, students: c.students.size,
      cohort: students, per100: per100(c.merged, students), prsPer100: per100(c.prs, students), studentsPct: per100(c.students.size, students) };
  }).sort((a, b) => campusRank(a.campus) - campusRank(b.campus) || (a.campus < b.campus ? -1 : a.campus > b.campus ? 1 : 0) || keyRank.get(a.key) - keyRank.get(b.key));
  const campusSet = new Set([...cohorts.keys(), ...byCampus.map((c) => c.campus)]);
  const cohortList = [...campusSet].sort((a, b) => campusRank(a) - campusRank(b) || (a < b ? -1 : 1)).map((campus) => {
    const students = cohorts.get(campus) ?? 0;
    const cells = byCampus.filter((c) => c.campus === campus);
    return { campus, students, smallCohort: students > 0 && students < smallCohortBelow,
      prs: cells.reduce((s, c) => s + c.prs, 0), merged: cells.reduce((s, c) => s + c.merged, 0) };
  });

  // merged per month for the top keys (by merged) + everything else, zero-filled over the months of the range
  const top = outRows.filter((r) => r.merged > 0).slice(0, topMonthKeys).map((r) => r.key);
  const topSet = new Set(top);
  const cell = new Map();
  let first = null;
  let last = null;
  for (const m of months) {
    const key = keyOf(by, repos.get(m._id.r));
    const k = topSet.has(key) ? key : REST_KEY;
    const ck = `${m._id.m}|${k}`;
    cell.set(ck, (cell.get(ck) || 0) + m.n);
    if (!first || m._id.m < first) first = m._id.m;
    if (!last || m._id.m > last) last = m._id.m;
  }
  const today = zoned(now, tz).ymd.slice(0, 7);
  let lo = range.from ? range.from.slice(0, 7) : first;
  let hi = range.to ? (range.to.slice(0, 7) < today ? range.to.slice(0, 7) : today) : (last && last > today ? last : today);
  if (last && last > hi) hi = last;
  let axis = lo && hi && lo <= hi ? monthsBetween(lo, hi) : [];
  if (axis.length > 120) { axis = axis.slice(-120); lo = axis[0]; }
  const hasRest = [...cell.keys()].some((k) => k.endsWith(`|${REST_KEY}`));
  const series = [...top, ...(hasRest ? [REST_KEY] : [])];
  const byMonth = [];
  for (const month of axis) for (const key of series) byMonth.push({ month, key, merged: cell.get(`${month}|${key}`) || 0 });

  return {
    by,
    rows: outRows,
    byCampus,
    cohorts: cohortList,
    smallCohortBelow,
    byMonth,
    months: axis,
    monthKeys: series.map((key) => ({ key, label: key === REST_KEY ? 'Everything else' : label(key) })),
    totals,
    ...(by === 'domain' && { domains: compiled.domains }),
  };
}

/**
 * Language and domain mix of a set of PR groups per repo: [{ _id: repoLc, prs, merged, osPrs?, osMerged? }].
 * -> { language: [{key, label, prs, merged, osPrs, osMerged, repos}], domain: […] }  sorted by merged, then PRs.
 */
export function techMix(groups, repos, compiled) {
  const out = {};
  for (const by of ['language', 'domain']) {
    const rows = new Map();
    for (const g of groups) {
      const key = keyOf(by, repos.get(g._id));
      let row = rows.get(key);
      if (!row) { row = { key, label: by === 'domain' ? domainLabel(key, compiled) : key, prs: 0, merged: 0, osPrs: 0, osMerged: 0, repos: 0 }; rows.set(key, row); }
      row.prs += g.prs || 0;
      row.merged += g.merged || 0;
      row.osPrs += g.osPrs || 0;
      row.osMerged += g.osMerged || 0;
      row.repos++;
    }
    out[by] = [...rows.values()].sort((a, b) => b.osMerged - a.osMerged || b.merged - a.merged || b.prs - a.prs || (a.key < b.key ? -1 : 1));
  }
  return out;
}
