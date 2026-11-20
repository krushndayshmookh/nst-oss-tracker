// /api/owner/* — the private "Krushn's dashboard" (SPEC addendum G). Every data route needs the admin session AND
// the owner cookie (src/owner.js). Responses are never cached: `no-store`, and nothing here touches the shared public cache.
import express from 'express';
import { ApiError, badRequest, notFound } from '../auth.js';
import { yearLabel } from '../classify.js';
import { csvLine, parseCsv } from '../csv.js';
import { isYmd, zoned, TZ } from '../dates.js';
import { pastResults } from '../pastResults.js';
import { enqueue } from '../jobs.js';
import {
  BAND_KEYS, DEFAULT_BANDS, DEFAULT_WEIGHTS, DISCLAIMER, FEATURE_HELP, FEATURE_KEYS, loadPrograms, programOrgDoc, savePrograms, validatePrograms,
} from '../programs.js';
import {
  activeScoresJob, compileProgram, isStale, loadStudentPrs, programTimeline, scoresState, scoreStudent,
} from '../scores.js';
import { cohortFilter, findStudent, flag, intParam, iso, lc, oneOf, paging, search, str } from './common.js';

const FLAGS = ['shortlist', 'watch', 'not_applying'];
const SMALL_COHORT = 30;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const per100 = (n, students) => (students ? Math.round((n / students) * 1000) / 10 : null);
const emptyBands = () => ({ strong: 0, possible: 0, early: 0, none: 0 });

const jobRef = (j) => (j ? {
  id: j._id, type: j.type, status: j.status, createdAt: iso(j.createdAt), startedAt: iso(j.startedAt), finishedAt: iso(j.finishedAt),
  progress: { done: j.progress?.done ?? 0, total: j.progress?.total ?? 0 }, summary: j.summary ?? null, error: j.error ?? null,
} : null);

function briefOut(v) {
  return {
    score: v?.score ?? 0, band: v?.band ?? 'none', bestOrg: v?.bestOrg ?? null, prevScore: v?.prevScore ?? 0, delta: v?.delta ?? 0,
    prevBand: v?.prevBand ?? 'none', mergedInBestOrg: v?.mergedInBestOrg ?? 0, prs: v?.prs ?? 0, merged: v?.merged ?? 0,
    lastActivityAt: iso(v?.lastActivityAt), blockers: v?.blockers ?? [],
  };
}

function rowOut(d, keys, notes, now, detail = false) {
  const note = notes?.get(d._id);
  const programs = {};
  for (const k of keys) {
    const v = d.programs?.[k];
    programs[k] = detail
      ? { ...briefOut(v), features: v?.features ?? {}, orgs: v?.orgs ?? [], evidence: v?.evidence ?? [], nextStep: v?.nextStep ?? '' }
      : briefOut(v);
  }
  const best = d.bestProgram && keys.includes(d.bestProgram) ? d.bestProgram : null;
  return {
    username: d.username || d._id, name: d.name || '', campus: d.campus || 'Unknown', batch: d.batch ?? null, year: yearLabel(d.batch, now),
    prestigeScore: d.prestigeScore ?? 0, bestProgram: best, bestBand: best ? d.bestBand : 'none', bestOrg: best ? d.bestOrg ?? null : null,
    realChance: Boolean(d.realChance), lastActivityAt: iso(d.lastActivityAt), flag: note?.flag ?? null, hasNote: Boolean(note?.note),
    blockers: best ? d.programs?.[best]?.blockers ?? [] : [], programs,
  };
}

/** Projection that leaves the heavy per-program detail out (lists and summaries). */
function lightProjection(keys) {
  const p = {};
  for (const k of keys) for (const f of ['features', 'evidence', 'nextStep']) p[`programs.${k}.${f}`] = 0;
  return p;
}

async function notesMap(db) {
  const map = new Map();
  for await (const n of db.collection('owner_notes').find({})) map.set(n._id, n);
  return map;
}

export function ownerRouter({ db, config, owner }) {
  const router = express.Router();
  const scores = db.collection('program_scores');
  const tz = config.tzName || TZ;

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  // state-changing requests carry X-Requested-With: oss-admin (same guard as the admin API)
  router.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('x-requested-with') !== 'oss-admin') return next(new ApiError(403, 'forbidden', 'missing X-Requested-With: oss-admin header'));
    next();
  });

  router.get('/me', (req, res) => {
    const exp = owner.expiry(req);
    res.json({
      admin: owner.isAdminRequest(req), configured: owner.configured(), unlocked: exp > 0, expiresAt: exp ? new Date(exp).toISOString() : null,
      title: config.ownerTitle || "Krushn's dashboard",
    });
  });
  router.post('/unlock', owner.requireConfigured, owner.requireAdmin, wrap((req, res) => owner.unlock(req, res)));
  router.post('/lock', (req, res) => owner.lock(req, res));

  router.use(owner.requireConfigured, owner.requireOwner);

  // ---------- shared ----------

  async function context() {
    const now = new Date();
    const cfg = await loadPrograms(db, now);
    const enabled = cfg.programs.filter((p) => p.enabled);
    return { now, cfg, enabled, keys: enabled.map((p) => p.key) };
  }

  /** Queues a recompute unless one is already waiting. -> job doc */
  async function queueScores(trigger) {
    const waiting = await db.collection('jobs').findOne({ type: 'scores', runner: 'app', status: 'queued' }, { projection: { log: 0 } });
    return waiting || enqueue(db, 'scores', { trigger });
  }

  /** Scores older than the data: start a recompute (it takes seconds) and tell the page. */
  async function freshness() {
    const state = await scoresState(db);
    let job = await activeScoresJob(db);
    const stale = await isStale(db, state);
    if (stale && !job) job = await queueScores('stale');
    return { state, stale, job };
  }

  // ---------- summary ----------

  router.get('/summary', wrap(async (req, res) => {
    const { now, cfg, enabled, keys } = await context();
    const cohort = cohortFilter(req.query, now);
    const { state, stale, job } = await freshness();
    const docs = await scores.find(cohort, { projection: { ...lightProjection(keys), programOrgs: 0 } }).toArray();
    const students = await db.collection('students').countDocuments({ active: true, ...cohort });
    const sizes = { campus: new Map(), batch: new Map(), both: new Map() };
    for await (const g of db.collection('students').aggregate([{ $match: { active: true, ...cohort } }, { $group: { _id: { campus: '$campus', batch: '$batch' }, n: { $sum: 1 } } }])) {
      const campus = g._id.campus || 'Unknown';
      const batch = g._id.batch ?? null;
      sizes.campus.set(campus, (sizes.campus.get(campus) || 0) + g.n);
      sizes.batch.set(batch, (sizes.batch.get(batch) || 0) + g.n);
      sizes.both.set(`${campus}|${batch}`, g.n);
    }
    const group = (keyOf, sizeOf, shape, pick) => {
      const groups = new Map();
      for (const d of docs) {
        const k = keyOf(d);
        let g = groups.get(k);
        if (!g) { g = { ...shape(d), students: sizeOf(d), acc: pick.init() }; groups.set(k, g); }
        pick.add(g.acc, d);
      }
      return [...groups.values()].map(({ acc, ...g }) => ({ ...g, ...pick.out(acc, g.students), smallCohort: g.students < SMALL_COHORT }));
    };
    const campusOrder = (a, b) => (a.campus === 'Unknown') - (b.campus === 'Unknown') || (a.campus < b.campus ? -1 : a.campus > b.campus ? 1 : 0);
    const batchOrder = (a, b) => (a.batch === null) - (b.batch === null) || (b.batch ?? 0) - (a.batch ?? 0);
    const byCampus = (pick) => group((d) => d.campus || 'Unknown', (d) => sizes.campus.get(d.campus || 'Unknown') || 0, (d) => ({ campus: d.campus || 'Unknown' }), pick).sort(campusOrder);
    const byYear = (pick) => group((d) => d.batch ?? null, (d) => sizes.batch.get(d.batch ?? null) || 0,
      (d) => ({ year: yearLabel(d.batch, now), batch: d.batch ?? null }), pick).sort(batchOrder);
    const byCampusYear = (pick) => group((d) => `${d.campus || 'Unknown'}|${d.batch ?? null}`, (d) => sizes.both.get(`${d.campus || 'Unknown'}|${d.batch ?? null}`) || 0,
      (d) => ({ campus: d.campus || 'Unknown', year: yearLabel(d.batch, now), batch: d.batch ?? null }), pick).sort((a, b) => campusOrder(a, b) || batchOrder(a, b));

    const programs = enabled.map((p) => {
      const counts = emptyBands();
      const prevCounts = emptyBands();
      let sum = 0; let withSignal = 0;
      const orgs = new Set();
      for (const d of docs) {
        const v = d.programs?.[p.key];
        counts[v?.band ?? 'none']++;
        prevCounts[v?.prevBand ?? 'none']++;
        if (v && v.band !== 'none') { sum += v.score; withSignal++; }
        for (const o of v?.orgs || []) orgs.add(lc(o.login));
      }
      const pick = {
        init: () => ({ counts: emptyBands() }),
        add: (acc, d) => { acc.counts[d.programs?.[p.key]?.band ?? 'none']++; },
        out: (acc, n) => ({ counts: acc.counts, realChance: acc.counts.strong + acc.counts.possible, per100: per100(acc.counts.strong + acc.counts.possible, n) }),
      };
      const cal = state.calibration?.[p.key] ?? null;
      return {
        key: p.key, name: p.name, prestigious: p.prestigious, window: p.window, match: p.match, labelMode: cal ? 'calibrated' : 'readiness', starter: p.starter,
        orgs: p.orgs.length, eligibilityNote: p.eligibilityNote, counts, prevCounts,
        delta: Object.fromEntries(BAND_KEYS.map((b) => [b, counts[b] - prevCounts[b]])),
        avgScoreWithSignal: withSignal ? Math.round((sum / withSignal) * 10) / 10 : null, activeOrgs: orgs.size,
        byCampus: byCampus(pick), byYear: byYear(pick), byCampusYear: byCampusYear(pick), calibration: cal,
      };
    });

    const real = docs.filter((d) => d.realChance);
    const strong = real.filter((d) => d.realChanceStrong).length;
    const prevReal = docs.filter((d) => d.prevRealChance).length;
    const realPick = {
      init: () => ({ real: 0, strong: 0 }),
      add: (acc, d) => { if (d.realChance) { acc.real++; if (d.realChanceStrong) acc.strong++; } },
      out: (acc, n) => ({ realChance: acc.real, per100: per100(acc.real, n), strong: acc.strong, possible: acc.real - acc.strong }),
    };
    const flags = { shortlist: 0, watch: 0, not_applying: 0 };
    const ids = new Set(docs.map((d) => d._id));
    for await (const n of db.collection('owner_notes').find({ flag: { $in: FLAGS } }, { projection: { flag: 1 } })) if (ids.has(n._id)) flags[n.flag]++;

    res.json({
      computedAt: iso(state.computedAt), asOf: state.computedAt ? zoned(state.computedAt, tz).ymd : null, trendDays: cfg.trendDays, stale, job: jobRef(job),
      filters: { campus: str(req.query, 'campus') || null, year: str(req.query, 'year') || null, batch: intParam(req.query, 'batch', { min: 1990, max: 2100 }) },
      students,
      realChance: { count: real.length, per100: per100(real.length, students), prevCount: prevReal, delta: real.length - prevReal, strong, possible: real.length - strong },
      bands: cfg.bands, programs,
      byCampus: byCampus(realPick), byYear: byYear(realPick),
      flags, disclaimer: DISCLAIMER,
    });
  }));

  // ---------- students ----------

  async function studentRows(req) {
    const { now, enabled, keys } = await context();
    const program = oneOf(req.query, 'program', keys);
    const bands = str(req.query, 'band').split(',').map((s) => s.trim()).filter(Boolean);
    for (const b of bands) if (!BAND_KEYS.includes(b)) throw badRequest(`invalid band: expected any of ${BAND_KEYS.join(', ')}`);
    const org = lc(str(req.query, 'org'));
    const flagFilter = oneOf(req.query, 'flag', [...FLAGS, 'none']);
    const real = flag(req.query, 'realChance');
    const q = lc(search(req.query));
    const sort = oneOf(req.query, 'sort', ['prestigeScore', ...keys, 'delta', 'name', 'campus', 'batch', 'lastActivityAt'], program || 'prestigeScore');
    const order = oneOf(req.query, 'order', ['asc', 'desc'], ['name', 'campus'].includes(sort) ? 'asc' : 'desc');
    const [docs, notes] = await Promise.all([
      scores.find(cohortFilter(req.query, now), { projection: lightProjection(keys) }).toArray(),
      notesMap(db),
    ]);
    const rows = docs.filter((d) => {
      if (bands.length && !bands.includes(program ? d.programs?.[program]?.band ?? 'none' : (d.bestProgram ? d.bestBand : 'none'))) return false;
      if (org) {
        const list = d.programOrgs || [];
        if (!(program ? list.includes(`${program}:${org}`) : list.some((x) => x.slice(x.indexOf(':') + 1) === org))) return false;
      }
      if (flagFilter) {
        const f = notes.get(d._id)?.flag ?? null;
        if (flagFilter === 'none' ? f !== null : f !== flagFilter) return false;
      }
      if (real !== null && Boolean(d.realChance) !== real) return false;
      if (q && !lc(d.username).includes(q) && !lc(d.name).includes(q)) return false;
      return true;
    });
    const value = (d) => {
      if (sort === 'prestigeScore') return d.prestigeScore ?? 0;
      if (sort === 'delta') return program ? d.programs?.[program]?.delta ?? 0 : (d.prestigeScore ?? 0) - (d.prevPrestigeScore ?? 0);
      if (sort === 'name') return lc(d.name || d.username);
      if (sort === 'campus') return d.campus || '';
      if (sort === 'batch') return d.batch ?? 0;
      if (sort === 'lastActivityAt') return d.lastActivityAt ? d.lastActivityAt.getTime() : 0;
      return d.programs?.[sort]?.score ?? 0;
    };
    const dir = order === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const x = value(a); const y = value(b);
      if (x !== y) return (x < y ? -1 : 1) * dir;
      return (b.prestigeScore ?? 0) - (a.prestigeScore ?? 0) || (a._id < b._id ? -1 : 1);
    });
    return { rows, notes, now, enabled, keys };
  }

  router.get('/students', wrap(async (req, res) => {
    const { page, limit, skip } = paging(req.query);
    const { rows, notes, now, enabled, keys } = await studentRows(req);
    const state = await scoresState(db);
    res.json({
      items: rows.slice(skip, skip + limit).map((d) => rowOut(d, keys, notes, now)), total: rows.length, page, limit,
      programs: enabled.map((p) => ({ key: p.key, name: p.name, prestigious: p.prestigious })), computedAt: iso(state.computedAt),
    });
  }));

  router.get('/export/students.csv', wrap(async (req, res) => {
    const { rows, notes, now, keys } = await studentRows(req);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="program-readiness.csv"');
    const col = (k) => k.replace(/-/g, '_');
    let out = csvLine(['username', 'name', 'campus', 'batch', 'year', 'prestige_score', 'best_program', 'best_band', 'best_org', 'real_chance', 'flag', 'last_activity_at',
      ...keys.flatMap((k) => [`${col(k)}_score`, `${col(k)}_band`, `${col(k)}_best_org`, `${col(k)}_delta`]), 'blockers']);
    for (const d of rows) {
      const r = rowOut(d, keys, notes, now);
      out += csvLine([r.username, r.name, r.campus, r.batch, r.year, r.prestigeScore, r.bestProgram, r.bestBand, r.bestOrg, r.realChance ? 'yes' : 'no', r.flag, r.lastActivityAt,
        ...keys.flatMap((k) => [r.programs[k].score, r.programs[k].band, r.programs[k].bestOrg, r.programs[k].delta]), r.blockers.join('; ')]);
    }
    res.send(out);
  }));

  async function studentOr404(name) {
    const s = await findStudent(db, name);
    if (!s || s.active === false) throw notFound('student not found');
    return s;
  }
  const noteOut = (n) => ({ note: n?.note ?? '', flag: n?.flag ?? null, updatedAt: iso(n?.updatedAt) });

  router.get('/students/:username', wrap(async (req, res) => {
    const s = await studentOr404(req.params.username);
    const { now, cfg, enabled, keys } = await context();
    const compiled = enabled.map((p) => compileProgram(p, tz));
    const prs = await loadStudentPrs(db, s._id);
    let doc = await scores.findOne({ _id: s._id });
    if (!doc) { // added after the last recompute: score on the spot
      doc = { _id: s._id, username: s.username, name: s.name, campus: s.campus, batch: s.batch, ...scoreStudent(prs, compiled, { now, bands: cfg.bands, trendDays: cfg.trendDays, tz }) };
    }
    const note = await db.collection('owner_notes').findOne({ _id: s._id });
    const row = rowOut(doc, keys, new Map(note ? [[s._id, note]] : []), now, true);
    for (const cp of compiled) row.programs[cp.key].timeline = programTimeline(prs, cp, { now, tz });
    const outcomes = await db.collection('program_outcomes').find({ student: s._id }).sort({ year: -1 }).toArray();
    const state = await scoresState(db);
    res.json({ student: row, note: noteOut(note), outcomes: outcomes.map(outcomeOut), computedAt: iso(doc.computedAt ?? state.computedAt) });
  }));

  router.put('/students/:username/note', wrap(async (req, res) => {
    const s = await studentOr404(req.params.username);
    const body = req.body || {};
    const set = { updatedAt: new Date() };
    if (body.note !== undefined) {
      if (typeof body.note !== 'string' || body.note.length > 5000) throw badRequest('note must be text of at most 5000 characters');
      set.note = body.note.trim();
    }
    if (body.flag !== undefined) {
      if (body.flag !== null && !FLAGS.includes(body.flag)) throw badRequest(`flag must be one of ${FLAGS.join(', ')} or null`);
      set.flag = body.flag;
    }
    if (set.note === undefined && set.flag === undefined) throw badRequest('nothing to save: send note and / or flag');
    await db.collection('owner_notes').updateOne({ _id: s._id }, { $set: set, $setOnInsert: { ...(set.note === undefined && { note: '' }), ...(set.flag === undefined && { flag: null }) } }, { upsert: true });
    res.json({ note: noteOut(await db.collection('owner_notes').findOne({ _id: s._id })) });
  }));

  // ---------- org view ----------

  router.get('/orgs', wrap(async (req, res) => {
    const { now, cfg, enabled, keys } = await context();
    const program = oneOf(req.query, 'program', keys, keys[0] || '');
    if (!program) throw badRequest('no program is enabled');
    const minStudents = intParam(req.query, 'minStudents', { min: 1, max: 10000, def: 1 });
    const q = lc(search(req.query));
    const sort = oneOf(req.query, 'sort', ['students', 'merged', 'prs', 'login'], 'students');
    const order = oneOf(req.query, 'order', ['asc', 'desc'], sort === 'login' ? 'asc' : 'desc');
    const page = intParam(req.query, 'page', { min: 1, max: 100000, def: 1 });
    const limit = intParam(req.query, 'limit', { min: 1, max: 200, def: 50 });
    const campus = cohortFilter({ campus: req.query.campus }, now);
    const names = new Map();
    for await (const o of db.collection('program_orgs').find({ program }).sort({ year: 1 })) for (const l of o.logins || []) names.set(l, o.name);
    const orgs = new Map();
    for await (const d of scores.find(campus, { projection: { username: 1, name: 1, campus: 1, batch: 1, [`programs.${program}.orgs`]: 1, [`programs.${program}.score`]: 1,
      [`programs.${program}.band`]: 1, [`programs.${program}.bestOrg`]: 1 } })) {
      const v = d.programs?.[program];
      for (const o of v?.orgs || []) {
        const key = lc(o.login);
        let g = orgs.get(key);
        if (!g) { g = { login: o.login, name: names.get(key) || o.login, url: `https://github.com/${o.login}`, students: 0, prs: 0, merged: 0, open: 0, strongOrPossible: 0, bestOrgFor: 0, campuses: {}, people: [] }; orgs.set(key, g); }
        const isBest = lc(v.bestOrg) === key;
        g.students++; g.prs += o.prs; g.merged += o.merged; g.open += o.open;
        if (isBest) { g.bestOrgFor++; if (v.band === 'strong' || v.band === 'possible') g.strongOrPossible++; }
        g.campuses[d.campus || 'Unknown'] = (g.campuses[d.campus || 'Unknown'] || 0) + 1;
        g.people.push({ username: d.username, name: d.name || '', campus: d.campus || 'Unknown', year: yearLabel(d.batch, now), prs: o.prs, merged: o.merged,
          score: v.score, band: v.band, isBestOrg: isBest, lastActivityAt: iso(o.lastActivityAt) });
      }
    }
    let items = [...orgs.values()].filter((g) => g.students >= minStudents && (!q || lc(g.login).includes(q) || lc(g.name).includes(q)));
    const dir = order === 'asc' ? 1 : -1;
    items.sort((a, b) => (sort === 'login' ? (lc(a.login) < lc(b.login) ? -1 : 1) * dir : (a[sort] - b[sort]) * dir) || b.merged - a.merged || (lc(a.login) < lc(b.login) ? -1 : 1));
    const total = items.length;
    items = items.slice((page - 1) * limit, page * limit).map((g) => ({
      ...g, crowded: g.bestOrgFor >= cfg.crowdedAt,
      people: g.people.sort((a, b) => b.merged - a.merged || b.prs - a.prs || b.score - a.score).slice(0, 50),
    }));
    const state = await scoresState(db);
    res.json({ program, items, total, page, limit, crowdedAt: cfg.crowdedAt, computedAt: iso(state.computedAt) });
  }));

  // ---------- settings: programs ----------

  router.get('/programs', wrap(async (req, res) => {
    const cfg = await loadPrograms(db);
    const state = await scoresState(db);
    res.json({
      programs: cfg.programs, bands: cfg.bands, trendDays: cfg.trendDays, crowdedAt: cfg.crowdedAt,
      featureKeys: FEATURE_KEYS, featureHelp: FEATURE_HELP, defaults: { weights: DEFAULT_WEIGHTS, bands: DEFAULT_BANDS },
      updatedAt: iso(cfg.updatedAt), computedAt: iso(state.computedAt), job: jobRef(await activeScoresJob(db)),
    });
  }));

  router.put('/programs', wrap(async (req, res) => {
    const { value, error } = validatePrograms(req.body);
    if (error) throw badRequest(error);
    const cfg = await savePrograms(db, value);
    const job = await queueScores('settings');
    res.json({ programs: cfg.programs, bands: cfg.bands, trendDays: cfg.trendDays, crowdedAt: cfg.crowdedAt, updatedAt: iso(cfg.updatedAt), job: jobRef(job) });
  }));

  // ---------- settings: organisation lists ----------

  async function programOrgOut(o, owners) {
    let nstPrs = 0; let nstStudents = 0;
    for (const l of o.logins || []) { const s = owners.get(l); if (s) { nstPrs += s.prs || 0; nstStudents += s.students || 0; } }
    return { id: o._id, program: o.program, year: o.year, slug: o.slug, name: o.name, url: o.url || '', ideasUrl: o.ideasUrl || '', logins: o.logins || [],
      mappedBy: o.mappedBy ?? null, confidence: o.confidence ?? null, nstPrs, nstStudents };
  }
  async function ownerStats(logins) {
    const map = new Map();
    if (!logins.length) return map;
    for await (const o of db.collection('owners').find({ _id: { $in: logins } }, { projection: { 'stats.prs': 1, 'stats.students': 1 } })) map.set(o._id, o.stats || {});
    return map;
  }

  router.get('/program-orgs', wrap(async (req, res) => {
    const cfg = await loadPrograms(db);
    const program = oneOf(req.query, 'program', cfg.programs.map((p) => p.key), 'gsoc');
    const coll = db.collection('program_orgs');
    const years = (await coll.distinct('year', { program })).sort((a, b) => b - a);
    const year = intParam(req.query, 'year', { min: 2000, max: 2100, def: years[0] ?? null });
    const mapped = flag(req.query, 'mapped');
    const q = lc(search(req.query));
    const all = year === null ? [] : await coll.find({ program, year }).sort({ name: 1 }).collation({ locale: 'en', strength: 2 }).toArray();
    const owners = await ownerStats([...new Set(all.flatMap((o) => o.logins || []))]);
    const items = [];
    for (const o of all) {
      if (mapped !== null && Boolean(o.logins?.length) !== mapped) continue;
      if (q && !lc(o.name).includes(q) && !lc(o.slug).includes(q) && !(o.logins || []).some((l) => l.includes(q))) continue;
      items.push(await programOrgOut(o, owners));
    }
    const nMapped = all.filter((o) => o.logins?.length).length;
    res.json({ program, year, years, items, total: all.length, mapped: nMapped, unmapped: all.length - nMapped });
  }));

  router.put('/program-orgs/:id', wrap(async (req, res) => {
    const coll = db.collection('program_orgs');
    const doc = await coll.findOne({ _id: String(req.params.id) });
    if (!doc) throw notFound('no such program organisation');
    const check = validatePrograms({ programs: [{ key: 'xx', name: 'x', orgs: req.body?.logins, window: { from: '2026-01-01', to: '2026-01-02' } }] });
    if (!Array.isArray(req.body?.logins) || check.error) throw badRequest(check.error ? check.error.replace(/^program xx: /, '') : 'logins must be a list of GitHub logins');
    const logins = check.value.programs[0].orgs.map((l) => l.toLowerCase());
    const now = new Date();
    await coll.updateOne({ _id: doc._id }, { $set: { ...programOrgDoc({ ...doc, logins, mappedBy: logins.length ? 'manual' : null, confidence: logins.length ? 'high' : null }, now) } });
    // keep the program's own org list in step: drop logins only this entry contributed, add the new ones
    const cfg = await loadPrograms(db);
    const program = cfg.programs.find((p) => p.key === doc.program);
    if (program) {
      const others = new Set();
      for await (const o of coll.find({ program: doc.program, _id: { $ne: doc._id } }, { projection: { logins: 1 } })) for (const l of o.logins || []) others.add(l);
      const removed = new Set((doc.logins || []).filter((l) => !logins.includes(l) && !others.has(l)));
      const have = new Set(program.orgs.map((o) => o.toLowerCase()));
      program.orgs = [...program.orgs.filter((o) => !removed.has(o.toLowerCase())), ...logins.filter((l) => !have.has(l))];
      await savePrograms(db, { programs: cfg.programs, bands: cfg.bands, trendDays: cfg.trendDays, crowdedAt: cfg.crowdedAt }, now);
    }
    const job = await queueScores('program-orgs');
    const fresh = await coll.findOne({ _id: doc._id });
    res.json({ item: await programOrgOut(fresh, await ownerStats(fresh.logins || [])), job: jobRef(job) });
  }));

  // ---------- calibration outcomes ----------

  function outcomeOut(o) {
    return { username: o.username, program: o.program, year: o.year, org: o.org || '', selected: Boolean(o.selected), matched: Boolean(o.student) };
  }
  const TRUE = new Set(['yes', 'y', 'true', '1', 'selected']);
  const FALSE = new Set(['no', 'n', 'false', '0', '', 'not selected', 'rejected']);

  router.get('/outcomes', wrap(async (req, res) => {
    const cfg = await loadPrograms(db);
    const f = {};
    const program = oneOf(req.query, 'program', cfg.programs.map((p) => p.key));
    if (program) f.program = program;
    const year = intParam(req.query, 'year', { min: 2000, max: 2100 });
    if (year !== null) f.year = year;
    const items = await db.collection('program_outcomes').find(f).sort({ year: -1, program: 1, username: 1 }).toArray();
    const state = await scoresState(db);
    res.json({ items: items.map(outcomeOut), total: items.length, calibration: state.calibration || {} });
  }));

  router.post('/outcomes', wrap(async (req, res) => {
    const body = req.body || {};
    let rows;
    if (typeof body.csv === 'string') rows = parseCsv(body.csv);
    else if (Array.isArray(body.rows)) rows = body.rows.map((r) => Object.fromEntries(Object.entries(r && typeof r === 'object' ? r : {}).map(([k, v]) => [k.trim().toLowerCase(), v])));
    else throw badRequest('send csv (text with a header row: username,program,year,org,selected) or rows');
    if (rows.length > 5000) throw badRequest('at most 5000 rows per upload');
    const cfg = await loadPrograms(db);
    const keys = cfg.programs.map((p) => p.key);
    const students = new Map();
    for await (const s of db.collection('students').find({}, { projection: { username: 1 } })) { students.set(s._id, s._id); if (s.username) students.set(lc(s.username), s._id); }
    const now = new Date();
    const results = [];
    const docs = new Map();
    rows.forEach((r, i) => {
      const fail = (error) => results.push({ row: i + 1, username: String(r.username ?? '').slice(0, 100), status: 'invalid', error });
      const username = String(r.username ?? r.github ?? r.github_username ?? '').trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/[/?#].*$/, '').replace(/^@/, '');
      if (!username) return fail('username required');
      if (!/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(username)) return fail('username is not a GitHub login');
      const program = lc(r.program).trim();
      if (!keys.includes(program)) return fail(`program must be one of ${keys.join(', ')}`);
      const year = Number(String(r.year ?? '').trim());
      if (!Number.isInteger(year) || year < 2015 || year > 2035) return fail('year must be 2015 to 2035');
      const sel = lc(r.selected).trim();
      if (!TRUE.has(sel) && !FALSE.has(sel)) return fail('selected must be yes or no');
      const id = `${lc(username)}:${program}:${year}`;
      docs.set(id, { _id: id, username, student: students.get(lc(username)) ?? null, program, year, org: String(r.org ?? '').trim().slice(0, 100), selected: TRUE.has(sel), updatedAt: now });
      results.push({ row: i + 1, username, status: 'saved', error: null });
    });
    const coll = db.collection('program_outcomes');
    const list = [...docs.values()];
    if (body.replace === true && list.length) {
      const pairs = [...new Set(list.map((d) => `${d.program}|${d.year}`))].map((k) => { const [program, year] = k.split('|'); return { program, year: Number(year) }; });
      await coll.deleteMany({ $or: pairs });
    }
    if (list.length) await coll.bulkWrite(list.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })), { ordered: false });
    const job = list.length ? await queueScores('outcomes') : null;
    res.json({
      results, saved: results.filter((r) => r.status === 'saved').length, invalid: results.filter((r) => r.status === 'invalid').length,
      unmatched: list.filter((d) => !d.student).length, job: jobRef(job),
    });
  }));

  router.delete('/outcomes', wrap(async (req, res) => {
    const cfg = await loadPrograms(db);
    const f = {};
    const program = oneOf(req.query, 'program', cfg.programs.map((p) => p.key));
    if (program) f.program = program;
    const year = intParam(req.query, 'year', { min: 2000, max: 2100 });
    if (year !== null) f.year = year;
    const r = await db.collection('program_outcomes').deleteMany(f);
    // deleting leaves no newer timestamp behind, so the calibration is refreshed explicitly
    const job = await queueScores('outcomes');
    res.json({ ok: true, deleted: r.deletedCount, job: jobRef(job) });
  }));

  // ---------- past results: how past applicants worked in the year before selection ----------

  router.get('/past-results', wrap(async (req, res) => {
    const cfg = await loadPrograms(db);
    const names = new Map(cfg.programs.map((p) => [p.key, p.name]));
    const available = [];
    for await (const g of db.collection('program_outcomes').aggregate([
      { $group: { _id: { program: '$program', year: '$year' }, applicants: { $sum: 1 }, selected: { $sum: { $cond: ['$selected', 1, 0] } } } },
      { $sort: { '_id.year': -1, '_id.program': 1 } },
    ])) {
      if (names.has(g._id.program)) available.push({ program: g._id.program, name: names.get(g._id.program), year: g._id.year, applicants: g.applicants, selected: g.selected });
    }
    const key = oneOf(req.query, 'program', cfg.programs.map((p) => p.key), available[0]?.program || '');
    const year = intParam(req.query, 'year', { min: 2015, max: 2035, def: available.find((a) => a.program === key)?.year ?? null });
    const from = str(req.query, 'from');
    const to = str(req.query, 'to');
    for (const [n, v] of [['from', from], ['to', to]]) if (v && !isYmd(v)) throw badRequest(`invalid ${n}: expected a date (YYYY-MM-DD)`);
    if (from && to && from > to) throw badRequest('invalid range: from is after to');
    if (!key || year === null) return res.json({ available, program: null, year: null, groups: null });
    const program = cfg.programs.find((p) => p.key === key);
    const out = await pastResults(db, { cfg, program, year, from: from || null, to: to || null, tz });
    res.json({ available, ...out });
  }));

  // ---------- recompute ----------

  router.post('/recompute', wrap(async (req, res) => {
    const active = await activeScoresJob(db);
    if (active) throw new ApiError(409, 'conflict', 'a recompute is already queued or running', { jobId: active._id });
    const job = await enqueue(db, 'scores', { trigger: 'manual' });
    res.status(202).json({ job: jobRef(job) });
  }));

  router.get('/status', wrap(async (req, res) => {
    const { state, stale, job } = await freshness();
    const last = await db.collection('jobs').findOne({ type: 'scores', status: { $in: ['done', 'error', 'cancelled'] } }, { sort: { finishedAt: -1 }, projection: { log: 0 } });
    res.json({ computedAt: iso(state.computedAt), stale, students: state.summary?.students ?? 0, job: jobRef(job), last: jobRef(last) });
  }));

  router.use((req, res, next) => next(new ApiError(404, 'not_found', `no such endpoint: ${req.method} ${req.baseUrl}${req.path}`)));
  return router;
}
