// Program-readiness scores (SPEC addendum G3). PRIVATE: read only by /api/owner/*.
//
// A score is a transparent heuristic, not a probability: seven features in 0..1 per student × program, a weighted sum
// mapped to 0–100, a band, and the reasons (blockers, evidence, next step). Nothing here looks at who a student is:
// only at their public pull requests. No protected attribute is read, stored or inferred.
//
// Private collections written here: `program_scores` (one doc per active student), `program_outcomes` (uploaded past
// results, calibration only). The run state lives in settings `programScoresState`.
import { addDays, dayStart, zoned, TZ } from './dates.js';
import { BAND_KEYS, FEATURE_KEYS, loadPrograms } from './programs.js';

const DAY = 86400000;
export const SCORE_FIELDS_NEVER_PUBLIC = ['prestigeScore', 'realChance', 'bestBand', 'blockers', 'nextStep'];

// ---------- small pure helpers ----------

/** Piecewise-linear saturation through `points` [[x, y], …] (ascending x); flat outside. */
export function sat(x, points) {
  if (!(x > points[0][0])) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return points[points.length - 1][1];
}
export const CURVES = {
  depth: [[0, 0], [1, 0.25], [3, 0.6], [6, 0.85], [10, 1]],
  medianSize: [[0, 0], [10, 0.2], [50, 0.6], [200, 1]],
  mergedConfidence: [[0, 0], [1, 0.5], [2, 0.75], [3, 1]],
  weeks: [[0, 0], [1, 0.15], [4, 0.5], [8, 0.8], [12, 1]],
  tenure: [[0, 0], [30, 0.4], [90, 0.8], [180, 1]],
  recency: [[14, 1], [45, 0.3], [90, 0]],
  interaction: [[0, 0], [2, 0.5], [5, 0.85], [8, 1]],
  breadth: [[0, 0], [1, 0.5], [2, 0.8], [3, 1]],
  trackRecord: [[0, 0], [1, 0.3], [3, 0.6], [6, 0.85], [10, 1]],
};

const round = (v, d = 2) => { const f = 10 ** d; return Math.round((v + Number.EPSILON) * f) / f; };
const median = (list) => {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const iso = (d) => (d ? new Date(d).toISOString() : null);

const DOCS_PREFIX = /^\s*(?:\[?\s*)?(docs?|documentation|readme|chore\(docs?\)|fix\(docs?\)|typo|typos)\b\s*[\]:(-]/i;
const DOCS_WORDS = /\b(typos?|spelling|grammar|grammatical|readme|broken links?|dead links?|contributors? list|add(?:ed|ing)? my name|update(?:d)? docs?|documentation)\b/i;
/** Docs / typo-only change, judged by the title alone (a heuristic: the diff is not available). */
export const isDocsTitle = (title) => DOCS_PREFIX.test(String(title || '')) || DOCS_WORDS.test(String(title || ''));
/** Non-trivial: at least 30 changed lines in at least 2 files, and not a docs / typo change by title. */
export const isNonTrivial = (p) => (p.additions || 0) + (p.deletions || 0) >= 30 && (p.changedFiles || 0) >= 2 && !isDocsTitle(p.title);

const STAR_ONLY = /under \d+ stars$/;

/** Lookup structure for one program. */
export function compileProgram(program, tz = TZ) {
  return {
    ...program,
    orgSet: new Set((program.orgs || []).map((o) => o.toLowerCase())),
    repoSet: new Set((program.repos || []).map((r) => r.toLowerCase())),
    start: dayStart(program.window.from, tz),
    end: dayStart(addDays(program.window.to, 1), tz), // window.to is inclusive
    label: String(program.name || program.key).replace(/\s+\d{4}$/, ''),
  };
}

/** Does this PR count for the program? (category open_source, or a small repo of a listed org when includeLowStar) */
export function matchesProgram(pr, cp) {
  if (cp.match === 'major') return pr.category === 'open_source' && pr.tier === 'major';
  if (cp.match === 'open_source') return pr.category === 'open_source';
  if (!cp.orgSet.has(pr.ownerLc) && !cp.repoSet.has(pr.repoLc)) return false;
  if (pr.category === 'open_source') return true;
  return Boolean(cp.includeLowStar) && pr.category === 'low_signal' && !pr.override && STAR_ONLY.test(pr.reason || '');
}

/** Monday (YYYY-MM-DD) of the week that contains `date` in `tz`. */
export function weekStartOf(date, tz = TZ) {
  const z = zoned(date, tz);
  return addDays(z.ymd, -(z.dow - 1));
}

const whereLabel = (cp) => (cp.match === 'major' ? 'a major project' : cp.match === 'open_source' ? 'an open-source project' : `a ${cp.label} org`);

/**
 * Scores one student for one program. Pure.
 *   prs       the student's PR docs (any category); fields used: ownerLc, owner, repo, repoLc, category, tier, reason, override,
 *             createdAt, mergedAt, closedAt, additions, deletions, changedFiles, comments, reviews, title, url
 *   cp        compileProgram(program)
 *   opts      { asOf: Date (default now), bands, tz, majorMerged?: number }
 * Only what was visible at `asOf` counts, and nothing after the end of the program window.
 */
export function scoreProgram(prs, cp, { asOf = new Date(), bands = { strong: 60, possible: 35, early: 10 }, tz = TZ, majorMerged = null } = {}) {
  const cutoff = asOf < cp.end ? asOf : cp.end;
  const cut = cutoff.getTime();
  const startMs = cp.start.getTime();
  const pre = cp.preWindowWeight ?? 0.5;
  const mine = [];
  for (const p of prs) {
    if (!p.createdAt || p.createdAt.getTime() >= cut || !matchesProgram(p, cp)) continue;
    const merged = Boolean(p.mergedAt) && p.mergedAt.getTime() < cut;
    const closed = !merged && Boolean(p.closedAt) && p.closedAt.getTime() < cut;
    mine.push({ p, merged, closed, last: merged ? Math.max(p.mergedAt.getTime(), p.createdAt.getTime()) : p.createdAt.getTime() });
  }

  // per org
  const orgs = new Map();
  for (const m of mine) {
    const key = m.p.ownerLc;
    let o = orgs.get(key);
    if (!o) { o = { login: m.p.owner || key, key, prs: 0, merged: 0, open: 0, closed: 0, mergedIn: 0, mergedPre: 0, last: 0, first: Infinity, weeks: new Set() }; orgs.set(key, o); }
    o.prs++;
    if (m.merged) { o.merged++; if (m.p.mergedAt.getTime() >= startMs) o.mergedIn++; else o.mergedPre++; } else if (m.closed) o.closed++; else o.open++;
    o.last = Math.max(o.last, m.last);
    o.first = Math.min(o.first, m.p.createdAt.getTime());
    if (m.p.createdAt.getTime() >= startMs) o.weeks.add(weekStartOf(m.p.createdAt, tz));
    if (m.merged && m.p.mergedAt.getTime() >= startMs) o.weeks.add(weekStartOf(m.p.mergedAt, tz));
  }
  for (const o of orgs.values()) o.weighted = o.mergedIn + pre * o.mergedPre;
  const ranked = [...orgs.values()].sort((a, b) => b.weighted - a.weighted || b.merged - a.merged || b.prs - a.prs || b.last - a.last || (a.key < b.key ? -1 : 1));
  const best = ranked[0] || null;

  const mergedList = mine.filter((m) => m.merged);
  const nonTrivial = mergedList.filter((m) => isNonTrivial(m.p));
  const sizes = mergedList.map((m) => (m.p.additions || 0) + (m.p.deletions || 0));
  const decided = mine.filter((m) => m.merged || m.closed).length;
  const lastMs = mine.reduce((a, m) => Math.max(a, m.last), 0);
  const daysSince = lastMs ? Math.max(0, (asOf.getTime() - lastMs) / DAY) : null;
  if (majorMerged === null) {
    majorMerged = prs.filter((p) => p.category === 'open_source' && p.tier === 'major' && p.mergedAt && p.mergedAt.getTime() < asOf.getTime()).length;
  }

  const f = {};
  // depth
  f.depth = {
    value: best ? sat(best.weighted, CURVES.depth) : 0,
    explain: best && best.merged
      ? `${plural(best.merged, 'merged PR')} in ${best.login} (best single org)${best.mergedPre ? `; ${best.mergedPre} before the window count ×${pre}` : ''}`
      : (best ? `no merged PR yet; ${plural(best.prs, 'PR')} in ${best.login}` : `no PR in ${whereLabel(cp)}`),
    detail: { mergedInBestOrg: best?.merged ?? 0, mergedInWindow: best?.mergedIn ?? 0, mergedBeforeWindow: best?.mergedPre ?? 0, weighted: round(best?.weighted ?? 0) },
  };
  // substance
  const share = mergedList.length ? nonTrivial.length / mergedList.length : 0;
  const med = median(sizes);
  f.substance = {
    value: mergedList.length ? (0.7 * share + 0.3 * sat(med, CURVES.medianSize)) * sat(mergedList.length, CURVES.mergedConfidence) : 0,
    explain: mergedList.length
      ? `${nonTrivial.length} of ${plural(mergedList.length, 'merged PR')} non-trivial; median size ${Math.round(med)} lines`
      : 'no merged PR to judge',
    detail: { merged: mergedList.length, nonTrivial: nonTrivial.length, share: round(share), medianLines: Math.round(med) },
  };
  // sustained
  const weeks = best ? best.weeks.size : 0;
  const tenureDays = best ? Math.max(0, Math.round((best.last - best.first) / DAY)) : 0;
  f.sustained = {
    value: best ? 0.7 * sat(weeks, CURVES.weeks) + 0.3 * sat(tenureDays, CURVES.tenure) : 0,
    explain: best ? `${plural(weeks, 'active week')} in ${best.login} in the window; ${tenureDays} days from first to last PR there` : 'no activity',
    detail: { activeWeeks: weeks, tenureDays },
  };
  // recency
  f.recency = {
    value: daysSince === null ? 0 : sat(daysSince, CURVES.recency),
    explain: daysSince === null ? 'no activity' : `last activity ${plural(Math.floor(daysSince), 'day')} ago`,
    detail: { daysSinceLast: daysSince === null ? null : Math.floor(daysSince), lastActivityAt: lastMs ? iso(lastMs) : null },
  };
  // engagement
  const inter = mine.length ? mine.reduce((a, m) => a + (m.p.reviews || 0) + (m.p.comments || 0), 0) / mine.length : 0;
  const ratio = decided ? mergedList.length / decided : null;
  f.engagement = {
    value: mine.length ? 0.6 * sat(inter, CURVES.interaction) + 0.4 * (ratio ?? 0) : 0,
    explain: mine.length
      ? `${round(inter, 1)} reviews + comments per PR; ${ratio === null ? 'no PR decided yet' : `${mergedList.length} of ${decided} decided PRs merged`}`
      : 'no PR',
    detail: { interactionsPerPr: round(inter, 1), merged: mergedList.length, decided, mergeRatio: ratio === null ? null : round(ratio) },
  };
  // breadth
  const others = Math.max(0, orgs.size - 1);
  f.breadth = {
    value: sat(others, CURVES.breadth),
    explain: others ? `${plural(others, 'other org')} touched` : 'no other org touched',
    detail: { otherOrgs: others },
  };
  // track record
  f.trackRecord = {
    value: sat(majorMerged, CURVES.trackRecord),
    explain: `${plural(majorMerged, 'merged PR')} in major open-source projects overall`,
    detail: { majorMerged },
  };

  const weights = cp.weights || {};
  let wSum = 0;
  for (const k of FEATURE_KEYS) wSum += Math.max(0, Number(weights[k]) || 0);
  let total = 0;
  const features = {};
  for (const k of FEATURE_KEYS) {
    const w = Math.max(0, Number(weights[k]) || 0);
    const pts = wSum ? (100 * w * f[k].value) / wSum : 0;
    total += pts;
    features[k] = { value: round(f[k].value, 3), weight: w, points: round(pts, 1), explain: f[k].explain, detail: f[k].detail };
  }
  const score = Math.round(total);

  // band: thresholds on the score, with two plain gates
  let band = score >= bands.strong ? 'strong' : score >= bands.possible ? 'possible' : score >= bands.early ? 'early' : 'none';
  if (!mine.length) band = 'none';                                // a track record elsewhere is not a signal for THIS program
  else if (band === 'strong' && !mergedList.length) band = 'possible'; // never Strong without a merged PR

  // blockers, most important first
  const where = whereLabel(cp);
  const blockers = [];
  const docsOnly = mergedList.length > 0 && nonTrivial.length === 0;
  const thin = mergedList.length >= 3 && best && best.merged < 2;
  if (!mine.length) blockers.push(`no PR in ${where}`);
  else if (!mergedList.length) blockers.push(`no merged PR in ${where}`);
  if (mine.length && daysSince !== null && daysSince > 90) blockers.push('all activity older than 90 days');
  if (docsOnly) blockers.push('only docs-size PRs');
  if (thin) blockers.push('spread thin: no org with 2 or more merged PRs');
  if (decided >= 4 && ratio !== null && ratio < 0.4) blockers.push(`low merge ratio (${mergedList.length} of ${decided} decided PRs merged)`);
  if (mergedList.length >= 2 && weeks <= 1 && cutoff.getTime() - startMs > 28 * DAY) blockers.push('single burst: active in at most one week of the window');

  let nextStep;
  const bo = best?.login;
  if (!mine.length) {
    nextStep = majorMerged
      ? `Already has ${plural(majorMerged, 'merged PR')} in major projects: choose one ${cp.match === 'orgs' ? `${cp.label} org` : 'project'} that fits that stack and open a first PR there.`
      : `Choose one ${cp.match === 'orgs' ? `${cp.label} org` : 'established project'} that fits their stack, set it up locally and open a first small PR.`;
  } else if (!mergedList.length) nextStep = `Get a first PR merged in ${bo}: pick a small, well-scoped issue, respond to review quickly and finish it.`;
  else if (daysSince > 90) nextStep = `Restart in ${bo}: no activity for ${Math.floor(daysSince)} days. One merged PR in the next two weeks brings the recency back.`;
  else if (docsOnly) nextStep = `Move from docs / typo fixes to a code change in ${bo}: a bug fix that touches two or more files.`;
  else if (thin) nextStep = `Concentrate: ${mergedList.length} merged PRs are spread over ${orgs.size} orgs. Pick ${bo} and get the next three merged there.`;
  else if (f.depth.value < 0.6) nextStep = `Build depth in ${bo}: ${plural(Math.max(1, Math.ceil(3 - best.weighted)), 'more merged PR')} to reach three, ideally one of them non-trivial.`;
  else if (f.substance.value < 0.5) nextStep = `Take on a larger issue in ${bo} (a feature or a multi-file fix): most merged PRs so far are small.`;
  else if (f.sustained.value < 0.5) nextStep = `Keep a weekly rhythm in ${bo}: one PR or review response every week until the application deadline.`;
  else if (daysSince > 30) nextStep = `Pick the work in ${bo} back up: last activity was ${Math.floor(daysSince)} days ago.`;
  else nextStep = `Ready to talk to ${bo} mentors about a project idea and start a proposal draft; keep the weekly rhythm.`;

  const evidence = [...mine]
    .sort((a, b) => Number(b.merged) - Number(a.merged) || Number(isNonTrivial(b.p)) - Number(isNonTrivial(a.p))
      || ((b.p.additions || 0) + (b.p.deletions || 0)) - ((a.p.additions || 0) + (a.p.deletions || 0)) || b.last - a.last)
    .slice(0, 5)
    .map((m) => ({
      url: m.p.url || m.p._id, title: m.p.title || '', repo: m.p.repo, state: m.merged ? 'merged' : m.closed ? 'closed' : 'open',
      createdAt: iso(m.p.createdAt), mergedAt: m.merged ? iso(m.p.mergedAt) : null,
      additions: m.p.additions || 0, deletions: m.p.deletions || 0, changedFiles: m.p.changedFiles || 0, nonTrivial: isNonTrivial(m.p),
    }));

  return {
    score, band, bestOrg: best ? best.login : null, mergedInBestOrg: best?.merged ?? 0, prs: mine.length, merged: mergedList.length,
    lastActivityAt: lastMs ? iso(lastMs) : null, blockers, nextStep, features,
    orgs: ranked.map((o) => ({ login: o.login, prs: o.prs, merged: o.merged, open: o.open, closed: o.closed, lastActivityAt: iso(o.last) })),
    evidence,
  };
}

/** Weekly opened / merged counts of the student's program PRs for every week of the window up to `now` (zero-filled). */
export function programTimeline(prs, cp, { now = new Date(), tz = TZ } = {}) {
  const endMs = Math.min(now.getTime(), cp.end.getTime() - 1);
  if (endMs < cp.start.getTime()) return [];
  const weeks = new Map();
  for (let w = weekStartOf(cp.start, tz), last = weekStartOf(new Date(endMs), tz); w <= last && weeks.size < 120; w = addDays(w, 7)) weeks.set(w, { weekStart: w, opened: 0, merged: 0 });
  for (const p of prs) {
    if (!matchesProgram(p, cp)) continue;
    const c = p.createdAt?.getTime();
    if (c >= cp.start.getTime() && c <= endMs) { const w = weeks.get(weekStartOf(p.createdAt, tz)); if (w) w.opened++; }
    const m = p.mergedAt?.getTime();
    if (m >= cp.start.getTime() && m <= endMs) { const w = weeks.get(weekStartOf(p.mergedAt, tz)); if (w) w.merged++; }
  }
  return [...weeks.values()];
}

const PR_FIELDS = { url: 1, title: 1, author: 1, repo: 1, repoLc: 1, owner: 1, ownerLc: 1, category: 1, tier: 1, reason: 1, override: 1,
  createdAt: 1, mergedAt: 1, closedAt: 1, additions: 1, deletions: 1, changedFiles: 1, comments: 1, reviews: 1 };

/** The PRs that can matter for any program: open-source ones and those held back only by the star thresholds. */
export const SCORABLE = { active: true, category: { $in: ['open_source', 'low_signal'] } };

export async function loadStudentPrs(db, author) {
  return db.collection('prs').find({ ...SCORABLE, author }, { projection: PR_FIELDS }).toArray();
}

/**
 * One student, every enabled program, now and `trendDays` ago. Pure.
 * -> the `program_scores` document without _id / identity fields.
 */
export function scoreStudent(prs, compiled, { now = new Date(), bands, trendDays = 30, tz = TZ } = {}) {
  const prev = new Date(now.getTime() - trendDays * DAY);
  const major = prs.filter((p) => p.category === 'open_source' && p.tier === 'major' && p.mergedAt);
  const majorNow = major.filter((p) => p.mergedAt < now).length;
  const majorPrev = major.filter((p) => p.mergedAt < prev).length;
  const programs = {};
  let prestigeScore = 0; let bestProgram = null; let prevPrestige = 0; let real = false; let prevReal = false;
  let strong = false;
  for (const cp of compiled) {
    const cur = scoreProgram(prs, cp, { asOf: now, bands, tz, majorMerged: majorNow });
    const old = scoreProgram(prs, cp, { asOf: prev, bands, tz, majorMerged: majorPrev });
    programs[cp.key] = { ...cur, prevScore: old.score, prevBand: old.band, delta: cur.score - old.score };
    if (!cp.prestigious) continue;
    if (cur.band !== 'none' && cur.score > prestigeScore) { prestigeScore = cur.score; bestProgram = cp.key; }
    if (old.band !== 'none') prevPrestige = Math.max(prevPrestige, old.score);
    if (cur.band === 'strong' || cur.band === 'possible') real = true;
    if (cur.band === 'strong') strong = true;
    if (old.band === 'strong' || old.band === 'possible') prevReal = true;
  }
  let lastOs = 0;
  for (const p of prs) {
    if (p.category !== 'open_source') continue;
    if (p.createdAt && p.createdAt < now) lastOs = Math.max(lastOs, p.createdAt.getTime());
    if (p.mergedAt && p.mergedAt < now) lastOs = Math.max(lastOs, p.mergedAt.getTime());
  }
  const bp = bestProgram ? programs[bestProgram] : null;
  return {
    prestigeScore, prevPrestigeScore: prevPrestige, bestProgram, bestBand: bp ? bp.band : 'none', bestOrg: bp ? bp.bestOrg : null,
    realChance: real, realChanceStrong: strong, prevRealChance: prevReal, lastActivityAt: lastOs ? new Date(lastOs) : null, programs,
  };
}

async function prsByAuthor(db, authors = null) {
  const filter = authors ? { ...SCORABLE, author: { $in: authors } } : SCORABLE;
  const map = new Map();
  for await (const p of db.collection('prs').find(filter, { projection: PR_FIELDS })) {
    let list = map.get(p.author);
    if (!list) { list = []; map.set(p.author, list); }
    list.push(p);
  }
  return map;
}

/** Shifts a YYYY-MM-DD date by whole years (29 Feb → 28 Feb). */
function shiftYears(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const yy = y + n;
  const last = new Date(Date.UTC(yy, m, 0)).getUTCDate();
  return `${yy}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/**
 * Past outcomes against the bands the same students would have had at that year's application deadline.
 * -> { <program key>: { outcomes, matched, selected, years, byBand:{band:{applicants, selected, rate, smallSample}}, note } }
 */
export async function calibrate(db, cfg, { tz = TZ } = {}) {
  const outcomes = await db.collection('program_outcomes').find({}).toArray();
  if (!outcomes.length) return {};
  const ids = [...new Set(outcomes.map((o) => o.student).filter(Boolean))];
  const prs = await prsByAuthor(db, ids);
  const out = {};
  for (const program of cfg.programs) {
    const mine = outcomes.filter((o) => o.program === program.key);
    if (!mine.length) continue;
    const byBand = Object.fromEntries(BAND_KEYS.map((b) => [b, { applicants: 0, selected: 0 }]));
    const windowYear = Number(program.window.to.slice(0, 4));
    const compiledByYear = new Map();
    let matched = 0; let selected = 0;
    for (const o of mine) {
      if (o.selected) selected++;
      if (!o.student) continue;
      matched++;
      if (!compiledByYear.has(o.year)) {
        const shift = o.year - windowYear;
        compiledByYear.set(o.year, compileProgram({ ...program, window: { from: shiftYears(program.window.from, shift), to: shiftYears(program.window.to, shift) } }, tz));
      }
      const cp = compiledByYear.get(o.year);
      const s = scoreProgram(prs.get(o.student) || [], cp, { asOf: cp.end, bands: cfg.bands, tz });
      byBand[s.band].applicants++;
      if (o.selected) byBand[s.band].selected++;
    }
    for (const b of BAND_KEYS) {
      const v = byBand[b];
      v.rate = v.applicants ? round(v.selected / v.applicants) : null;
      v.smallSample = v.applicants < 10;
    }
    out[program.key] = {
      outcomes: mine.length, matched, selected, years: [...new Set(mine.map((o) => o.year))].sort(), byBand,
      note: "Bands for past applicants are recomputed as of each year's application deadline with today's org list and weights.",
    };
  }
  return out;
}

/**
 * Recomputes every active student's scores and replaces `program_scores`. Idempotent: the same data, settings and
 * `now` give the same documents. -> { students, programs, withSignal, realChance, durationMs } (kept in the private state doc).
 */
export async function recomputeScores(db, { now = new Date(), tz = TZ, log = () => {}, progress = () => {} } = {}) {
  const t0 = Date.now();
  const cfg = await loadPrograms(db, now);
  const enabled = cfg.programs.filter((p) => p.enabled);
  const compiled = enabled.map((p) => compileProgram(p, tz));
  const students = await db.collection('students').find({ active: true }, { projection: { username: 1, name: 1, campus: 1, batch: 1 } }).toArray();
  const prs = await prsByAuthor(db);
  const coll = db.collection('program_scores');
  let ops = [];
  let withSignal = 0; let real = 0; let done = 0;
  const flush = async () => {
    if (ops.length) await coll.bulkWrite(ops, { ordered: false });
    ops = [];
  };
  for (const s of students) {
    const r = scoreStudent(prs.get(s._id) || [], compiled, { now, bands: cfg.bands, trendDays: cfg.trendDays, tz });
    if (r.prestigeScore > 0) withSignal++;
    if (r.realChance) real++;
    const programOrgs = [];
    for (const [key, v] of Object.entries(r.programs)) for (const o of v.orgs) programOrgs.push(`${key}:${o.login.toLowerCase()}`);
    ops.push({ replaceOne: { filter: { _id: s._id }, replacement: {
      username: s.username || s._id, name: s.name || '', campus: s.campus || 'Unknown', batch: s.batch ?? null, ...r, programOrgs, computedAt: now,
    }, upsert: true } });
    if (ops.length >= 500) await flush();
    if (++done % 500 === 0) progress(done, students.length);
  }
  await flush();
  await coll.deleteMany({ _id: { $nin: students.map((s) => s._id) } });
  const calibration = await calibrate(db, cfg, { tz });
  const summary = { students: students.length, programs: enabled.length, withSignal, realChance: real, durationMs: Date.now() - t0 };
  await db.collection('settings').updateOne({ _id: 'programScoresState' },
    { $set: { computedAt: now, finishedAt: new Date(), settingsUpdatedAt: cfg.updatedAt ?? null, summary, calibration } }, { upsert: true });
  progress(students.length, students.length);
  log(`${students.length} students processed`);
  return summary;
}

/**
 * Job handler `scores`. The job document is visible on the admin Jobs page, so its summary and log carry nothing
 * about results: only how many students were processed and how long it took.
 */
export async function scoresJob(db, params, ctx) {
  const s = await recomputeScores(db, { log: ctx?.log, progress: ctx?.progress });
  return { students: s.students, programs: s.programs, durationMs: s.durationMs };
}

export async function scoresState(db) {
  return (await db.collection('settings').findOne({ _id: 'programScoresState' })) || { computedAt: null, summary: null, calibration: {} };
}

/** The queued or running scores job, if any. */
export async function activeScoresJob(db) {
  return db.collection('jobs').findOne({ type: 'scores', status: { $in: ['queued', 'running'] } }, { sort: { createdAt: 1 }, projection: { log: 0 } });
}

/**
 * Are the stored scores older than the data they were computed from? True when they were never computed, the program
 * settings changed, a fetch / reclassify / import finished, or an admin changed a classification or a student since.
 */
export async function isStale(db, state = null) {
  state ||= await scoresState(db);
  if (!state.computedAt) return true;
  const at = state.computedAt;
  const settings = await db.collection('settings').findOne({ _id: 'programs' }, { projection: { updatedAt: 1 } });
  if (settings?.updatedAt && settings.updatedAt > at) return true;
  const job = await db.collection('jobs').findOne({ type: { $in: ['sync', 'backfill', 'reclassify', 'import'] }, finishedAt: { $gt: at } }, { projection: { _id: 1 } });
  if (job) return true;
  for (const name of ['prs', 'repos', 'owners']) {
    if (await db.collection(name).findOne({ overrideAt: { $gt: at } }, { projection: { _id: 1 } })) return true;
  }
  const outcome = await db.collection('program_outcomes').findOne({ updatedAt: { $gt: at } }, { projection: { _id: 1 } });
  return Boolean(outcome);
}

/**
 * Called by the job runner after a job that changed PR data. In the app the recompute is queued (one at a time);
 * a command-line run computes at once. Never throws: a failed recompute must not fail the fetch.
 */
export async function afterDataChange(db, job, { enqueue } = {}) {
  try {
    if (job.runner === 'app' && enqueue) {
      const queued = await db.collection('jobs').findOne({ type: 'scores', runner: 'app', status: 'queued' }, { projection: { _id: 1 } });
      if (!queued) await enqueue(db, 'scores', { trigger: job.type });
    } else {
      await recomputeScores(db);
    }
  } catch (e) {
    if (process.env.NODE_ENV !== 'test') console.error('readiness scores were not recomputed:', e?.message || e);
  }
}
