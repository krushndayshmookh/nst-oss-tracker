// Classification rules: defaults + load/save of the `settings` doc {_id:'rules'} (SPEC section 3).
// The four list defaults were generated from legacy/rules.json (not hand-typed).
import { collections } from './db.js';

export const DEFAULT_RULES = Object.freeze(
{
  "tiers": {
    "major": 1000,
    "established": 200
  },
  "minStarsUserRepo": 200,
  "minStarsOrgRepo": 50,
  "nstOrgs": [
    "nst-sdc",
    "NST-DEVFORGE",
    "S-AI-Projects",
    "Newton-School",
    "devforge-nst",
    "devclub-nstru",
    "SASTxNST",
    "DCODE-HQ"
  ],
  "nstOwnerKeywords": [
    "nst",
    "newton",
    "devforge",
    "adypu",
    "rishihood",
    "svyasa",
    "smru"
  ],
  "practiceRepos": [
    "firstcontributions/first-contributions",
    "zero-to-mastery/start-here-guidelines",
    "MunGell/awesome-for-beginners",
    "github/docs-content-practice",
    "Syknapse/Contribute-To-This-Project",
    "codeisscience/first-contribution"
  ],
  "practiceKeywords": [
    "first-contribution",
    "firstcontribution",
    "hacktoberfest",
    "hacktober",
    "beginner",
    "practice",
    "good-first",
    "learn-git",
    "git-practice",
    "contribute-to-this",
    "dev-wall",
    "workbook",
    "gssoc",
    "ecsoc",
    "swoc",
    "open-source-practice",
    "100-days",
    "30-days",
    "awesome-list"
  ],
  "allowOrgs": [
    "c2siorg"
  ]
}
);

const LISTS = ['nstOrgs', 'nstOwnerKeywords', 'practiceRepos', 'practiceKeywords', 'allowOrgs'];

export function defaultRules() {
  return structuredClone(DEFAULT_RULES);
}

/** Keeps only known keys, fills gaps from the defaults. Does not validate. */
export function normalizeRules(doc) {
  const d = defaultRules();
  if (!doc || typeof doc !== 'object') return d;
  const out = {
    tiers: {
      major: Number.isFinite(doc.tiers?.major) ? doc.tiers.major : d.tiers.major,
      established: Number.isFinite(doc.tiers?.established) ? doc.tiers.established : d.tiers.established,
    },
    minStarsUserRepo: Number.isFinite(doc.minStarsUserRepo) ? doc.minStarsUserRepo : d.minStarsUserRepo,
    minStarsOrgRepo: Number.isFinite(doc.minStarsOrgRepo) ? doc.minStarsOrgRepo : d.minStarsOrgRepo,
  };
  for (const k of LISTS) out[k] = Array.isArray(doc[k]) ? doc[k].map(String) : d[k];
  return out;
}

/**
 * Validates a full rules document from an admin. Returns { rules } or { error: 'message' }.
 * Numbers >= 0, tiers.major > tiers.established, lists of trimmed non-empty strings (deduplicated, case-insensitive).
 */
export function validateRules(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'rules must be an object' };
  const num = (v, name) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`${name} must be a number >= 0`);
    return v;
  };
  try {
    if (!body.tiers || typeof body.tiers !== 'object') throw new Error('tiers is required');
    const rules = {
      tiers: { major: num(body.tiers.major, 'tiers.major'), established: num(body.tiers.established, 'tiers.established') },
      minStarsUserRepo: num(body.minStarsUserRepo, 'minStarsUserRepo'),
      minStarsOrgRepo: num(body.minStarsOrgRepo, 'minStarsOrgRepo'),
    };
    if (!(rules.tiers.major > rules.tiers.established)) throw new Error('tiers.major must be greater than tiers.established');
    for (const k of LISTS) {
      const list = body[k];
      if (!Array.isArray(list)) throw new Error(`${k} must be a list of strings`);
      const seen = new Set();
      const out = [];
      for (const item of list) {
        if (typeof item !== 'string') throw new Error(`${k} must be a list of strings`);
        const s = item.trim();
        if (!s) throw new Error(`${k} must not contain empty strings`);
        if (s.length > 200) throw new Error(`${k} entries must be at most 200 characters`);
        if (seen.has(s.toLowerCase())) continue;
        seen.add(s.toLowerCase());
        out.push(s);
      }
      if (out.length > 2000) throw new Error(`${k} is too long`);
      rules[k] = out;
    }
    return { rules };
  } catch (e) {
    return { error: e.message };
  }
}

/** Current rules (defaults when nothing was saved yet). Includes `updatedAt` (Date | null). */
export async function loadRules(db) {
  const doc = await collections(db).settings.findOne({ _id: 'rules' });
  return { ...normalizeRules(doc), updatedAt: doc?.updatedAt ?? null };
}

/** Replaces the rules document. Returns the stored rules incl. `updatedAt`. */
export async function saveRules(db, rules) {
  const doc = { ...normalizeRules(rules), updatedAt: new Date() };
  await collections(db).settings.replaceOne({ _id: 'rules' }, doc, { upsert: true });
  return doc;
}

/** Inserts the default rules when no rules doc exists. */
export async function ensureRules(db) {
  await collections(db).settings.updateOne({ _id: 'rules' }, { $setOnInsert: { ...defaultRules(), updatedAt: new Date() } }, { upsert: true });
}
