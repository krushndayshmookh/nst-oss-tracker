// Program configuration of the private readiness page (SPEC addendum G2): defaults, seed, validation, storage, and the
// mapper from a program's organisation list (e.g. the GSoC archive) to GitHub org logins.
//
// Everything here is PRIVATE to /api/owner/*: the settings doc `programs` and the collection `program_orgs` are never
// read by the public or the admin routes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isYmd } from './dates.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SEED_PATH = path.join(ROOT, 'config', 'programs.seed.json');
export const ALIASES_PATH = path.join(ROOT, 'config', 'program-org-aliases.json');

export const FEATURE_KEYS = ['depth', 'substance', 'sustained', 'recency', 'engagement', 'breadth', 'trackRecord'];
export const BAND_KEYS = ['strong', 'possible', 'early', 'none'];
export const BAND_LABELS = { strong: 'Strong', possible: 'Possible', early: 'Early', none: 'No signal' };
export const MATCH_MODES = ['orgs', 'major', 'open_source'];
export const DEFAULT_WEIGHTS = { depth: 0.3, substance: 0.2, sustained: 0.15, recency: 0.1, engagement: 0.1, breadth: 0.05, trackRecord: 0.1 };
export const DEFAULT_BANDS = { strong: 60, possible: 35, early: 10 };
export const DEFAULT_TREND_DAYS = 30;
export const DEFAULT_CROWDED_AT = 5;
export const DEFAULT_PRE_WINDOW_WEIGHT = 0.5;

export const FEATURE_HELP = {
  depth: 'Merged PRs in the student\'s best single program org (1 → 0.25, 3 → 0.6, 6 → 0.85, 10+ → 1). Selection is per org, so concentration counts more than spread. PRs merged before the program window count at the pre-window weight.',
  substance: 'Share of merged PRs that are non-trivial (at least 30 changed lines in at least 2 files, and not a docs / typo change by its title) and their median size. Damped while there are fewer than 3 merged PRs.',
  sustained: 'Distinct weeks with activity in the best org inside the program window (1 → 0.15, 4 → 0.5, 8 → 0.8, 12+ → 1) and tenure there (first to last PR: 30 days → 0.4, 90 → 0.8, 180+ → 1).',
  recency: 'Days since the last PR opened or merged in a program org: 1 up to 14 days, falling to 0.3 at 45 days and to 0 at 90 days.',
  engagement: 'Maintainer interaction (reviews + comments per PR: 2 → 0.5, 5 → 0.85, 8+ → 1) and the merge ratio of PRs that were decided (merged or closed).',
  breadth: 'Other program orgs with at least one PR (1 → 0.5, 2 → 0.8, 3+ → 1). Small weight on purpose.',
  trackRecord: 'Merged PRs in major-tier open-source projects overall, in any org (1 → 0.3, 3 → 0.6, 6 → 0.85, 10+ → 1).',
};

export const DISCLAIMER = 'Readiness score: a transparent heuristic computed from public GitHub pull requests (where, how many, how substantial, '
  + 'how sustained, how recent). It is not a probability of selection: programs also judge the proposal, communication with mentors, '
  + 'eligibility and the number of slots, none of which this data can see. Eligibility is never inferred.';

const ELIGIBILITY = {
  gsoc: 'GSoC requires contributors to be 18 or older and new or beginner contributors to open source. The data cannot see either; confirm with the student.',
  outreachy: 'Outreachy has applicant eligibility criteria (an initial application essay reviewed by Outreachy, time-commitment and prior-participation rules) that this data cannot see and the app never infers. Check eligibility with each student directly.',
  lfx: 'LFX Mentorship terms run three times a year; each project lists its own prerequisites on the LFX platform.',
  processing: 'Processing Foundation fellowships and its GSoC slots are few; fellowships are proposal based and open to non-code work as well.',
  sob: 'Summer of Bitcoin selects through its own application and a proposal round; students must be enrolled at a university.',
  mlh: 'MLH Fellowship selection is by application, code sample and interview, not by contributions to a specific organisation; this score only reflects general open-source strength.',
  'other-major': 'General signal, not a program: merged work in any major-tier open-source project.',
};

const lcTrim = (s) => String(s ?? '').trim();
const uniq = (list) => [...new Set(list)];

// ---------- defaults / seed ----------

/** The GSoC contribution window that matters for the coming summer, as of `now` (1 Sep → 8 Apr). */
export function defaultGsocWindow(now = new Date()) {
  const y = now.getUTCMonth() >= 5 ? now.getUTCFullYear() + 1 : now.getUTCFullYear(); // from June on, prepare for next year
  return { from: `${y - 1}-09-01`, to: `${y}-04-08` };
}

function fillProgram(p, now = new Date()) {
  const win = p.window && isYmd(p.window.from) && isYmd(p.window.to) ? p.window : defaultGsocWindow(now);
  return {
    key: p.key, name: p.name || p.key, enabled: p.enabled !== false, prestigious: p.prestigious !== false,
    match: MATCH_MODES.includes(p.match) ? p.match : 'orgs',
    orgs: uniq((p.orgs || []).map(lcTrim).filter(Boolean)), repos: uniq((p.repos || []).map(lcTrim).filter(Boolean)),
    orgSource: p.orgSource || 'manual', includeLowStar: p.includeLowStar !== false,
    window: { from: win.from, to: win.to },
    preWindowWeight: Number.isFinite(p.preWindowWeight) ? p.preWindowWeight : DEFAULT_PRE_WINDOW_WEIGHT,
    weights: { ...DEFAULT_WEIGHTS, ...(p.weights || {}) },
    notes: p.notes || '', eligibilityNote: p.eligibilityNote ?? ELIGIBILITY[p.key] ?? '', starter: Boolean(p.starter),
  };
}

let seedCache = null;
/** config/programs.seed.json: { generatedAt, programs:[…], programOrgs:[{program, year, slug, name, url, ideasUrl, logins, mappedBy, confidence}] }. */
export function loadSeed(file = SEED_PATH) {
  if (file === SEED_PATH && seedCache) return seedCache;
  let seed;
  try {
    seed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    seed = { programs: [], programOrgs: [] };
  }
  if (file === SEED_PATH) seedCache = seed;
  return seed;
}

/** Program-specific weights where the default would mislead. */
const WEIGHT_OVERRIDES = {
  // not tied to an org: concentration matters less, proven work in serious projects matters more
  mlh: { depth: 0.2, substance: 0.25, sustained: 0.15, recency: 0.1, engagement: 0.1, breadth: 0.05, trackRecord: 0.15 },
  'other-major': { depth: 0.25, substance: 0.25, sustained: 0.15, recency: 0.1, engagement: 0.1, breadth: 0.05, trackRecord: 0.1 },
};

/** The settings document a fresh database starts with (seed file + defaults). */
export function defaultProgramsDoc(now = new Date(), seed = loadSeed()) {
  const win = defaultGsocWindow(now);
  const year = Number(win.to.slice(0, 4));
  const byKey = new Map((seed.programs || []).map((p) => [p.key, p]));
  const base = [
    { key: 'gsoc', name: `GSoC ${year}`, match: 'orgs', window: win },
    { key: 'outreachy', name: 'Outreachy', match: 'orgs', window: win, starter: true },
    { key: 'lfx', name: 'LFX Mentorship', match: 'orgs', window: win, starter: true },
    { key: 'processing', name: 'Processing Foundation', match: 'orgs', window: win, starter: true },
    { key: 'sob', name: 'Summer of Bitcoin', match: 'orgs', window: win, starter: true },
    { key: 'mlh', name: 'MLH Fellowship', match: 'open_source', window: win, starter: true },
    { key: 'other-major', name: 'Other major projects', match: 'major', window: win, prestigious: false },
  ];
  const programs = base.map((b) => {
    const s = byKey.get(b.key) || {};
    return fillProgram({ ...b, ...s, name: b.name, window: b.window, weights: { ...(WEIGHT_OVERRIDES[b.key] || {}), ...(s.weights || {}) } }, now);
  });
  return { programs, bands: { ...DEFAULT_BANDS }, trendDays: DEFAULT_TREND_DAYS, crowdedAt: DEFAULT_CROWDED_AT };
}

export const programOrgId = (program, year, slug) => `${program}:${year}:${slug}`;

/** Seeds settings `programs` and the `program_orgs` provenance table on first boot. Never overwrites the owner's edits. */
export async function ensurePrograms(db, now = new Date(), seed = loadSeed()) {
  const settings = db.collection('settings');
  let doc = await settings.findOne({ _id: 'programs' });
  if (!doc) {
    const fresh = defaultProgramsDoc(now, seed);
    await settings.updateOne({ _id: 'programs' }, { $setOnInsert: { ...fresh, updatedAt: now, seededAt: now } }, { upsert: true });
    doc = await settings.findOne({ _id: 'programs' });
    const rows = (seed.programOrgs || []).filter((o) => o.program && o.slug);
    if (rows.length && !(await db.collection('program_orgs').estimatedDocumentCount())) {
      await db.collection('program_orgs').bulkWrite(rows.map((o) => ({
        updateOne: {
          filter: { _id: programOrgId(o.program, o.year, o.slug) },
          update: { $setOnInsert: programOrgDoc(o, now) },
          upsert: true,
        },
      })), { ordered: false });
    }
  }
  return programsOut(doc);
}

export function programOrgDoc(o, now = new Date()) {
  return {
    program: o.program, year: Number(o.year), slug: o.slug, name: o.name || o.slug, url: o.url || '', ideasUrl: o.ideasUrl || '',
    logins: uniq((o.logins || []).map((l) => lcTrim(l).toLowerCase()).filter(Boolean)), mappedBy: o.mappedBy ?? null,
    confidence: o.confidence ?? null, updatedAt: now,
  };
}

export async function loadPrograms(db, now = new Date()) {
  const doc = await db.collection('settings').findOne({ _id: 'programs' });
  if (!doc) return { ...defaultProgramsDoc(now), updatedAt: null };
  return programsOut(doc);
}

export function programsOut(doc) {
  return {
    programs: (doc.programs || []).map((p) => fillProgram(p)),
    bands: { ...DEFAULT_BANDS, ...(doc.bands || {}) },
    trendDays: doc.trendDays ?? DEFAULT_TREND_DAYS, crowdedAt: doc.crowdedAt ?? DEFAULT_CROWDED_AT,
    updatedAt: doc.updatedAt ?? null,
  };
}

// ---------- validation ----------

const LOGIN_RE = /^[a-z\d](?:[a-z\d-]{0,38})$/i;
const REPO_RE = /^[a-z\d][a-z\d-]{0,38}\/[\w.-]{1,100}$/i;

function stringList(v, name, re, max = 2000) {
  if (v === undefined) return { value: [] };
  if (!Array.isArray(v)) return { error: `${name} must be a list` };
  if (v.length > max) return { error: `${name} holds at most ${max} entries` };
  const out = [];
  for (const item of v) {
    if (typeof item !== 'string') return { error: `${name} must be a list of strings` };
    let s = item.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '').replace(/^@/, '');
    if (!s) continue;
    if (!re.test(s)) return { error: `${name}: "${item.slice(0, 60)}" is not a valid ${name === 'repos' ? 'owner/name' : 'GitHub login'}` };
    out.push(s);
  }
  // case-insensitive de-duplication, first spelling wins
  const seen = new Set();
  return { value: out.filter((s) => (seen.has(s.toLowerCase()) ? false : seen.add(s.toLowerCase()))) };
}

/** Validates the body of PUT /api/owner/programs: -> { value } | { error }. */
export function validatePrograms(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.programs)) return { error: 'programs must be a list' };
  if (!body.programs.length || body.programs.length > 20) return { error: 'between 1 and 20 programs are allowed' };
  const keys = new Set();
  const programs = [];
  for (const p of body.programs) {
    if (!p || typeof p !== 'object') return { error: 'each program must be an object' };
    const key = typeof p.key === 'string' ? p.key.trim() : '';
    if (!/^[a-z0-9][a-z0-9-]{1,23}$/.test(key)) return { error: `program key "${String(p.key).slice(0, 30)}" is invalid: 2 to 24 characters a-z, 0-9 and -` };
    if (keys.has(key)) return { error: `program key ${key} is used twice` };
    keys.add(key);
    const where = `program ${key}`;
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (!name || name.length > 60) return { error: `${where}: name is required (at most 60 characters)` };
    for (const f of ['enabled', 'prestigious', 'includeLowStar', 'starter']) {
      if (p[f] !== undefined && typeof p[f] !== 'boolean') return { error: `${where}: ${f} must be true or false` };
    }
    const match = p.match ?? 'orgs';
    if (!MATCH_MODES.includes(match)) return { error: `${where}: match must be one of ${MATCH_MODES.join(', ')}` };
    const orgs = stringList(p.orgs, 'orgs', LOGIN_RE);
    if (orgs.error) return { error: `${where}: ${orgs.error}` };
    const repos = stringList(p.repos, 'repos', REPO_RE);
    if (repos.error) return { error: `${where}: ${repos.error}` };
    if (!p.window || !isYmd(p.window.from) || !isYmd(p.window.to)) return { error: `${where}: window.from and window.to must be dates (YYYY-MM-DD)` };
    if (p.window.from >= p.window.to) return { error: `${where}: window.from must be before window.to` };
    const weights = {};
    let sum = 0;
    for (const k of FEATURE_KEYS) {
      const w = p.weights?.[k] ?? DEFAULT_WEIGHTS[k];
      if (typeof w !== 'number' || !Number.isFinite(w) || w < 0 || w > 100) return { error: `${where}: weight ${k} must be a number from 0 to 100` };
      weights[k] = w;
      sum += w;
    }
    if (!(sum > 0)) return { error: `${where}: at least one weight must be above 0` };
    const pre = p.preWindowWeight ?? DEFAULT_PRE_WINDOW_WEIGHT;
    if (typeof pre !== 'number' || !(pre >= 0 && pre <= 1)) return { error: `${where}: preWindowWeight must be a number from 0 to 1` };
    for (const f of ['notes', 'eligibilityNote']) {
      if (p[f] !== undefined && (typeof p[f] !== 'string' || p[f].length > 2000)) return { error: `${where}: ${f} must be text of at most 2000 characters` };
    }
    const orgSource = typeof p.orgSource === 'string' && /^(manual|[a-z]+-\d{4})$/.test(p.orgSource) ? p.orgSource : 'manual';
    programs.push({
      key, name, enabled: p.enabled !== false, prestigious: p.prestigious !== false, match, orgs: orgs.value, repos: repos.value, orgSource,
      includeLowStar: p.includeLowStar !== false, window: { from: p.window.from, to: p.window.to }, preWindowWeight: pre, weights,
      notes: (p.notes || '').trim(), eligibilityNote: (p.eligibilityNote ?? ELIGIBILITY[key] ?? '').trim(), starter: Boolean(p.starter),
    });
  }
  const bands = { ...DEFAULT_BANDS, ...(body.bands && typeof body.bands === 'object' ? body.bands : {}) };
  for (const k of ['strong', 'possible', 'early']) {
    if (typeof bands[k] !== 'number' || !Number.isFinite(bands[k])) return { error: `bands.${k} must be a number` };
  }
  if (!(bands.strong <= 100 && bands.strong > bands.possible && bands.possible > bands.early && bands.early >= 1)) {
    return { error: 'band thresholds must satisfy 100 ≥ strong > possible > early ≥ 1' };
  }
  const trendDays = body.trendDays ?? DEFAULT_TREND_DAYS;
  if (!Number.isInteger(trendDays) || trendDays < 7 || trendDays > 180) return { error: 'trendDays must be a whole number from 7 to 180' };
  const crowdedAt = body.crowdedAt ?? DEFAULT_CROWDED_AT;
  if (!Number.isInteger(crowdedAt) || crowdedAt < 2 || crowdedAt > 100) return { error: 'crowdedAt must be a whole number from 2 to 100' };
  return { value: { programs, bands: { strong: bands.strong, possible: bands.possible, early: bands.early }, trendDays, crowdedAt } };
}

export async function savePrograms(db, value, now = new Date()) {
  await db.collection('settings').updateOne({ _id: 'programs' }, { $set: { ...value, updatedAt: now } }, { upsert: true });
  return loadPrograms(db, now);
}

// ---------- organisation list → GitHub logins ----------

// first path segments of github.com that are not accounts
const GH_RESERVED = new Set(['orgs', 'sponsors', 'topics', 'features', 'about', 'marketplace', 'apps', 'users', 'search', 'login', 'join',
  'explore', 'settings', 'pulls', 'issues', 'notifications', 'collections', 'events', 'site', 'security', 'pricing', 'enterprise', 'team',
  'customer-stories', 'readme', 'new', 'organizations', 'contact', 'github', 'community', 'discussions', 'trending', 'codespaces', 'copilot']);
const GH_LOGIN = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})';

/** Every GitHub account login referenced by a URL or a piece of text (github.com/<login>/…, <login>.github.io, raw.githubusercontent.com/<login>). */
export function githubLoginsIn(text) {
  const out = [];
  const s = String(text ?? '');
  const push = (login) => {
    const l = login.replace(/-+$/, '');
    if (l && !GH_RESERVED.has(l.toLowerCase())) out.push(l);
  };
  const re = new RegExp(`(?:^|[^A-Za-z0-9.-])(?:www\\.)?github\\.com/(?:(orgs|sponsors|users)/)?(${GH_LOGIN})(?![A-Za-z0-9-])`, 'gi');
  for (const m of s.matchAll(re)) {
    if (m[1]) out.push(m[2]); else push(m[2]);
  }
  for (const m of s.matchAll(new RegExp(`(?:^|[^A-Za-z0-9.-])(${GH_LOGIN})\\.github\\.io(?![A-Za-z0-9-])`, 'gi'))) push(m[1]);
  for (const m of s.matchAll(new RegExp(`raw\\.githubusercontent\\.com/(${GH_LOGIN})(?![A-Za-z0-9-])`, 'gi'))) push(m[1]);
  return out;
}

/** Lowercase letters and digits only: "The Apache Software Foundation" → "theapachesoftwarefoundation". */
export const normName = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const NAME_NOISE = /\b(the|project|projects|foundation|software|organization|organisation|community|inc|e\.?v\.?|gmbh|ltd|llc|initiative|open source)\b/gi;

/** Names an organisation may go by on GitHub: full name, slug, name without noise words, acronyms in brackets, website label. */
export function nameCandidates(org) {
  const out = new Set();
  const name = String(org.name ?? '');
  const add = (s) => { const n = normName(s); if (n.length >= 3) out.add(n); };
  add(name);
  add(org.slug);
  add(name.replace(/\([^)]*\)/g, ' '));
  add(name.replace(/\([^)]*\)/g, ' ').replace(NAME_NOISE, ' '));
  for (const m of name.matchAll(/\(([^)]+)\)/g)) add(m[1]);
  const host = hostLabel(org.website_url ?? org.url);
  if (host) add(host);
  return [...out];
}

const GENERIC_HOSTS = new Set(['github', 'gitlab', 'google', 'sites', 'wordpress', 'medium', 'wiki', 'www', 'docs', 'blog', 'readthedocs', 'sourceforge', 'gitbook', 'notion', 'linktr']);
function hostLabel(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '');
    const parts = host.split('.');
    if (parts.length < 2) return '';
    const two = ['co', 'com', 'org', 'ac', 'gov', 'edu', 'net'];
    const label = parts.length >= 3 && two.includes(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[parts.length - 2];
    return GENERIC_HOSTS.has(label) ? '' : label;
  } catch {
    return '';
  }
}

let aliasCache = null;
/** config/program-org-aliases.json: { "<slug or normalised name>": ["login", …] } — hand-checked mappings for umbrella and link-less orgs. */
export function loadAliases(file = ALIASES_PATH) {
  if (file === ALIASES_PATH && aliasCache) return aliasCache;
  let a = {};
  try {
    a = JSON.parse(readFileSync(file, 'utf8'));
  } catch { /* no aliases */ }
  const map = new Map();
  for (const [k, v] of Object.entries(a)) if (!k.startsWith('_') && Array.isArray(v)) map.set(k.toLowerCase(), v);
  if (file === ALIASES_PATH) aliasCache = map;
  return map;
}

/**
 * Maps one organisation of a program list (GSoC archive shape: slug, name, website_url, contact_links[], ideas_list_url,
 * description_html) to GitHub logins.
 *   1. `alias`: a hand-checked entry in config/program-org-aliases.json (by slug);
 *   2. `link`: github.com / *.github.io links in the org's own entry (website, contact links, ideas list, description);
 *   3. `name`: its name, slug, bracketed acronym or website label equals the login of an organisation that NST students
 *      already contributed to (`knownOwners`: Map<normalised login, login>).
 * -> { program, year, slug, name, url, ideasUrl, logins:[lowercase], mappedBy:'alias'|'link'|'name'|null, confidence:'high'|'medium'|null }
 */
export function mapProgramOrg(org, { program = 'gsoc', year = null, knownOwners = new Map(), aliases = loadAliases() } = {}) {
  const base = {
    program, year: Number(year ?? org.program_slug) || null, slug: String(org.slug || normName(org.name)), name: String(org.name || org.slug || ''),
    url: String(org.website_url || org.url || ''), ideasUrl: String(org.ideas_list_url || ''),
  };
  const alias = aliases.get(base.slug.toLowerCase());
  if (alias?.length) return { ...base, logins: uniq(alias.map((l) => l.toLowerCase())), mappedBy: 'alias', confidence: 'high' };

  const names = nameCandidates(org);
  const sources = [
    ['website', org.website_url],
    ['ideas', org.ideas_list_url],
    ...(Array.isArray(org.contact_links) ? org.contact_links.map((c) => ['contact', c?.value]) : []),
    ['source', org.source_code],
    ['description', org.description_html],
  ];
  const seen = new Map(); // lowercase login -> Set(source kinds)
  for (const [kind, text] of sources) {
    for (const login of githubLoginsIn(text)) {
      const k = login.toLowerCase();
      if (!seen.has(k)) seen.set(k, new Set());
      seen.get(k).add(kind);
    }
  }
  const byName = names.map((n) => knownOwners.get(n)).filter(Boolean).map((l) => l.toLowerCase());
  if (seen.size) {
    // A link is trusted fully when two fields agree, when the login resembles the org's name, or when it is the website itself.
    const resembles = (l) => { const n = normName(l); return names.some((c) => c === n || (n.length >= 4 && (c.includes(n) || n.includes(c)))); };
    const strong = [...seen].filter(([l, kinds]) => kinds.size >= 2 || kinds.has('website') || resembles(l)).map(([l]) => l);
    const logins = uniq([...(strong.length ? strong : [...seen.keys()]), ...byName]);
    return { ...base, logins, mappedBy: 'link', confidence: strong.length ? 'high' : 'medium' };
  }
  if (byName.length) return { ...base, logins: uniq(byName), mappedBy: 'name', confidence: 'medium' };
  return { ...base, logins: [], mappedBy: null, confidence: null };
}

/** Map<normalised login, login> of the organisations (never personal accounts or tracked students) present in `owners`. */
export async function knownOwnerMap(db) {
  const map = new Map();
  const students = new Set();
  for await (const s of db.collection('students').find({}, { projection: { username: 1 } })) {
    students.add(String(s._id).toLowerCase());
    if (s.username) students.add(String(s.username).toLowerCase());
  }
  for await (const o of db.collection('owners').find({ type: 'Organization' }, { projection: { login: 1 } })) {
    const login = o.login || o._id;
    if (students.has(String(login).toLowerCase())) continue;
    const n = normName(login);
    if (n.length >= 3 && !map.has(n)) map.set(n, login);
  }
  return map;
}

export function mapProgramOrgs(orgs, opts = {}) {
  const items = orgs.map((o) => mapProgramOrg(o, opts));
  const mapped = items.filter((i) => i.logins.length);
  return { items, mapped: mapped.length, unmapped: items.length - mapped.length, logins: uniq(mapped.flatMap((i) => i.logins)).sort() };
}

/** Upserts a mapped list into `program_orgs` (manual mappings made by the owner are kept) and returns the effective login list. */
export async function saveProgramOrgs(db, items, now = new Date()) {
  const coll = db.collection('program_orgs');
  const ids = items.map((i) => programOrgId(i.program, i.year, i.slug));
  const manual = new Map();
  for await (const d of coll.find({ _id: { $in: ids }, mappedBy: 'manual' })) manual.set(d._id, d);
  if (items.length) {
    await coll.bulkWrite(items.map((i) => {
      const id = programOrgId(i.program, i.year, i.slug);
      const keep = manual.get(id);
      const doc = programOrgDoc(keep ? { ...i, logins: keep.logins, mappedBy: 'manual', confidence: 'high' } : i, now);
      return { updateOne: { filter: { _id: id }, update: { $set: doc }, upsert: true } };
    }), { ordered: false });
  }
  const logins = new Set();
  for await (const d of coll.find({ _id: { $in: ids } }, { projection: { logins: 1 } })) for (const l of d.logins || []) logins.add(l);
  return [...logins].sort();
}
