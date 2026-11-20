// Past results (SPEC addendum G, "Past results" view of the private dashboard): how the selected and the not-selected
// applicants of one past program round actually worked during the academic year before selection.
//
// PRIVATE: read only by GET /api/owner/past-results. Descriptive numbers about a handful of people, never a model.
//
// Definitions (all boundaries in config.tzName, Asia/Kolkata by default):
//   academic year (AY)   1 Jul (year - 1) → 30 Jun (year), both days inclusive, unless from / to are given
//   opened / merged      createdAt in the AY / mergedAt in the AY (whenever it was opened), any category
//   os*                  the same, category open_source
//   target*              the same, PRs whose owner is one of the target-org logins (any category)
//   mergedTargetBeforeDeadline   merged in a target-org login from the AY start up to the end of the deadline day
//   activeWeeks          distinct Monday-start weeks with a PR opened or merged in the AY (osActiveWeeks: open-source PRs)
//   medianPrSize         median additions + deletions of the PRs opened in the AY
import { addDays, dayStart, zoned, TZ } from './dates.js';
import { normName } from './programs.js';
import { compileProgram, median, scoreProgram, shiftYears, weekStartOf } from './scores.js';

const LOGIN_RE = /^[a-z\d](?:[a-z\d-]{0,38})$/i;
const lc = (s) => String(s ?? '').trim().toLowerCase();
const iso = (d) => (d ? new Date(d).toISOString() : null);
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const round1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

export const METRICS = ['opened', 'merged', 'osOpened', 'osMerged', 'targetOpened', 'targetMerged', 'mergedTargetBeforeDeadline', 'activeWeeks',
  'osActiveWeeks', 'medianPrSize', 'readiness', 'readinessAtDeadline'];

/** The academic year that ends in June of `year`. */
export function programAcademicYear(year) {
  return { label: `${year - 1}-${String(year % 100).padStart(2, '0')}`, from: `${year - 1}-07-01`, to: `${year}-06-30` };
}

/** Months 'YYYY-MM' from the month of `from` to the month of `to` (both YYYY-MM-DD). */
export function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while ((y < ty || (y === ty && m <= tm)) && out.length < 60) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * Maps the free-text organisation of an outcome to GitHub owner logins, in this order:
 *   'exact'          the text is the login of an owner in our data;
 *   'program_orgs'   an entry of the program's organisation list (that year first, then any year) whose slug, name or
 *                    one of whose logins equals the text, and that has logins;
 *   'contains'       organisations in our data whose login contains the text (case-insensitive), most PRs first, at most 10;
 *   'none' / 'empty' nothing found / no organisation given.
 * -> { text, mapping, logins:[lowercase], via } (`via`: the program-org name or the matched logins, for display)
 */
export async function matchOrg(db, text, { program, year }) {
  const raw = String(text ?? '').trim();
  if (!raw) return { text: '', mapping: 'empty', logins: [], via: null };
  const low = lc(raw).replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\/.*$/, '').replace(/^@/, '');
  if (LOGIN_RE.test(low) && await db.collection('owners').findOne({ _id: low }, { projection: { _id: 1 } })) {
    return { text: raw, mapping: 'exact', logins: [low], via: low };
  }
  const n = normName(raw);
  const rows = await db.collection('program_orgs').find({ program }, { projection: { year: 1, slug: 1, name: 1, logins: 1 } }).toArray();
  const hit = (o) => o.logins?.length && (lc(o.slug) === low || normName(o.slug) === n || normName(o.name) === n || o.logins.includes(low));
  const found = rows.filter((o) => o.year === year).find(hit) || rows.sort((a, b) => b.year - a.year).find(hit);
  if (found) return { text: raw, mapping: 'program_orgs', logins: [...new Set(found.logins.map(lc))], via: `${found.name} (${found.year})` };
  if (low.length >= 3) {
    const owners = await db.collection('owners').find({ _id: { $regex: escapeRegex(low) }, type: 'Organization' }, { projection: { _id: 1, 'stats.prs': 1 } })
      .sort({ 'stats.prs': -1 }).limit(10).toArray();
    if (owners.length) return { text: raw, mapping: 'contains', logins: owners.map((o) => o._id), via: owners.map((o) => o._id).join(', ') };
  }
  return { text: raw, mapping: 'none', logins: [], via: null };
}

/**
 * Per-applicant numbers from that applicant's PR documents. Pure.
 *   prs: PR docs (createdAt, mergedAt, ownerLc, category, additions, deletions, url, title, repo)
 *   span: { start, end, deadlineEnd } Dates (end / deadlineEnd exclusive)
 *   logins: Set of lowercase target-org logins
 *   months: Map 'YYYY-MM' -> { opened, merged, targetMerged } (added to, for the group's monthly series)
 */
export function applicantMetrics(prs, { start, end, deadlineEnd }, logins, { tz = TZ, months = null } = {}) {
  const s = start.getTime(); const e = end.getTime(); const d = deadlineEnd ? deadlineEnd.getTime() : null;
  const inAy = (t) => t !== null && t >= s && t < e;
  const m = { opened: 0, merged: 0, osOpened: 0, osMerged: 0, targetOpened: 0, targetMerged: 0, mergedTargetBeforeDeadline: d === null ? null : 0 };
  const weeks = new Set(); const osWeeks = new Set(); const sizes = [];
  let first = null;
  const bump = (date, field) => {
    if (!months) return;
    const z = zoned(date, tz);
    const b = months.get(`${z.year}-${String(z.month).padStart(2, '0')}`);
    if (b) b[field]++;
  };
  for (const p of prs) {
    const c = p.createdAt ? p.createdAt.getTime() : null;
    const mg = p.mergedAt ? p.mergedAt.getTime() : null;
    const os = p.category === 'open_source';
    const target = logins.has(p.ownerLc);
    if (target && c !== null && (!first || c < first.createdAt.getTime())) first = p;
    if (inAy(c)) {
      m.opened++; if (os) m.osOpened++; if (target) m.targetOpened++;
      sizes.push((p.additions || 0) + (p.deletions || 0));
      const w = weekStartOf(p.createdAt, tz); weeks.add(w); if (os) osWeeks.add(w);
      bump(p.createdAt, 'opened');
    }
    if (inAy(mg)) {
      m.merged++; if (os) m.osMerged++;
      if (target) { m.targetMerged++; bump(p.mergedAt, 'targetMerged'); if (d !== null && mg < d) m.mergedTargetBeforeDeadline++; }
      const w = weekStartOf(p.mergedAt, tz); weeks.add(w); if (os) osWeeks.add(w);
      bump(p.mergedAt, 'merged');
    }
  }
  return {
    ...m, activeWeeks: weeks.size, osActiveWeeks: osWeeks.size, medianPrSize: sizes.length ? median(sizes) : null,
    firstTargetPr: first ? { url: first.url || first._id, repo: first.repo || '', title: first.title || '', createdAt: iso(first.createdAt), mergedAt: iso(first.mergedAt),
      beforeAy: first.createdAt.getTime() < s } : null,
  };
}

const PR_FIELDS = { url: 1, title: 1, author: 1, repo: 1, repoLc: 1, owner: 1, ownerLc: 1, category: 1, tier: 1, reason: 1, override: 1, state: 1,
  createdAt: 1, mergedAt: 1, closedAt: 1, additions: 1, deletions: 1, changedFiles: 1, comments: 1, reviews: 1 };

/**
 * Everything GET /api/owner/past-results returns. `cfg` = loadPrograms(); `program` a program of it; `year` the round.
 * `from` / `to` (YYYY-MM-DD, optional) replace the default academic year.
 */
export async function pastResults(db, { cfg, program, year, from = null, to = null, tz = TZ }) {
  const ay = programAcademicYear(year);
  const range = { from: from || ay.from, to: to || ay.to, label: from || to ? 'Custom range' : `AY ${ay.label}`, academicYear: ay.label };
  const start = dayStart(range.from, tz);
  const end = dayStart(addDays(range.to, 1), tz);
  // the program's contribution window from settings, moved to this round (as the calibration does)
  const shift = year - Number(program.window.to.slice(0, 4));
  const window = { from: shiftYears(program.window.from, shift), to: shiftYears(program.window.to, shift) };
  const applicationDeadline = program.deadlines?.[String(year)] ?? null;
  const deadline = { date: applicationDeadline || window.to, source: applicationDeadline ? 'settings' : 'window' };
  const deadlineEnd = dayStart(addDays(deadline.date, 1), tz);
  const cp = compileProgram({ ...program, window }, tz);

  const outcomes = await db.collection('program_outcomes').find({ program: program.key, year }).sort({ username: 1 }).toArray();
  const ids = [...new Set(outcomes.map((o) => o.student).filter(Boolean))];
  const [students, scores, prList] = await Promise.all([
    db.collection('students').find({ _id: { $in: ids } }, { projection: { username: 1, name: 1, campus: 1, batch: 1, active: 1 } }).toArray(),
    db.collection('program_scores').find({ _id: { $in: ids } }, { projection: { [`programs.${program.key}.score`]: 1, [`programs.${program.key}.band`]: 1, computedAt: 1 } }).toArray(),
    db.collection('prs').find({ author: { $in: ids } }, { projection: PR_FIELDS }).toArray(),
  ]);
  const studentOf = new Map(students.map((s) => [s._id, s]));
  const scoreOf = new Map(scores.map((s) => [s._id, s.programs?.[program.key] ?? null]));
  const prsOf = new Map();
  for (const p of prList) { if (!prsOf.has(p.author)) prsOf.set(p.author, []); prsOf.get(p.author).push(p); }

  const monthKeys = monthsBetween(range.from, range.to);
  const newMonths = () => new Map(monthKeys.map((k) => [k, { month: k, opened: 0, merged: 0, targetMerged: 0 }]));
  const groups = { selected: { months: newMonths(), applicants: [] }, notSelected: { months: newMonths(), applicants: [] } };
  const orgCache = new Map();

  for (const o of outcomes) {
    const key = lc(o.org);
    if (!orgCache.has(key)) orgCache.set(key, await matchOrg(db, o.org, { program: program.key, year }));
    const org = orgCache.get(key);
    const g = o.selected ? groups.selected : groups.notSelected;
    const s = o.student ? studentOf.get(o.student) : null;
    const base = {
      username: s?.username || o.username, name: s?.name || '', campus: s?.campus || null, batch: s?.batch ?? null, selected: Boolean(o.selected),
      matched: Boolean(s), active: s ? s.active !== false : false, targetOrg: o.org || '', orgMatch: org,
    };
    if (!s) {
      g.applicants.push({ ...base, ...Object.fromEntries(METRICS.map((k) => [k, null])), firstTargetPr: null });
      continue;
    }
    const prs = prsOf.get(s._id) || [];
    const m = applicantMetrics(prs, { start, end, deadlineEnd }, new Set(org.logins), { tz, months: g.months });
    const cur = scoreOf.get(s._id);
    const atDeadline = scoreProgram(prs, cp, { asOf: deadlineEnd, bands: cfg.bands, tz });
    g.applicants.push({
      ...base, ...m,
      readiness: cur ? { score: cur.score ?? 0, band: cur.band ?? 'none' } : null,
      readinessAtDeadline: { score: atDeadline.score, band: atDeadline.band, bestOrg: atDeadline.bestOrg },
    });
  }

  const value = (a, k) => (k === 'readiness' || k === 'readinessAtDeadline' ? a[k]?.score ?? null : a[k]);
  const out = {};
  for (const [name, g] of Object.entries(groups)) {
    const matched = g.applicants.filter((a) => a.matched);
    const medians = {};
    for (const k of METRICS) {
      const vals = matched.map((a) => value(a, k)).filter((v) => v !== null && v !== undefined);
      medians[k] = vals.length ? round1(median(vals)) : null;
    }
    const n = matched.length;
    g.applicants.sort((a, b) => (b.mergedTargetBeforeDeadline ?? -1) - (a.mergedTargetBeforeDeadline ?? -1) || (b.osMerged ?? -1) - (a.osMerged ?? -1)
      || (lc(a.username) < lc(b.username) ? -1 : 1));
    out[name] = {
      count: g.applicants.length, matched: n, medians,
      monthly: [...g.months.values()].map((x) => ({
        ...x, perApplicant: { opened: n ? round1(x.opened / n) : null, merged: n ? round1(x.merged / n) : null, targetMerged: n ? round1(x.targetMerged / n) : null },
      })),
      applicants: g.applicants,
    };
  }
  return {
    program: { key: program.key, name: program.name }, year, tz,
    range: { ...range, start: iso(start), end: iso(end) },
    window, applicationDeadline, deadline: { ...deadline, end: iso(deadlineEnd) },
    groups: out,
    mappings: Object.fromEntries(['exact', 'program_orgs', 'contains', 'none', 'empty'].map((k) => [k, [...out.selected.applicants, ...out.notSelected.applicants].filter((a) => a.orgMatch.mapping === k).length])),
    note: 'Descriptive, not predictive: a few past applicants from one round. Their numbers show how they worked, not what selects someone.',
  };
}
