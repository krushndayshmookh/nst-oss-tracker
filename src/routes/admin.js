// Admin API (SPEC section 6, Appendix A). Everything except login / logout / me needs the admin cookie.
import express from 'express';
import { collections } from '../db.js';
import { ApiError, badRequest, notFound } from '../auth.js';
import { CAMPUSES, CATEGORIES, YEAR_LABELS, invalidateContext, reclassify } from '../classify.js';
import { emptyStudentStats, refreshAggregates } from '../ingest.js';
import { loadRules, saveRules, validateRules } from '../rules.js';
import { JOB_TYPES, activeSync, cancelJob, enqueue, syncLock } from '../jobs.js';
import { csvLine, parseCsv } from '../csv.js';
import { invalidateAll } from '../cache.js';
import { allOf } from '../ranged.js';
import { loadAcademicYear, saveAcademicYear, validateAcademicYear, validateAcademicYearHistory } from '../dates.js';
import { ensureSchedule, parseUntil, pauseSchedule, resumeSchedule, scheduleOut, updateSchedule, validateSchedule } from '../scheduler.js';
import {
  COLLATION, MISSING_FILTERS, MISSING_KEYS, adminStudentOut, cohortFilter, contains, findStudent, flag, intParam, jobOut, lc, missingOf, oneOf,
  orgOut as orgOutPublic, paging, prOut as prOutPublic, repoOut as repoOutPublic, rulesOut, search, sorting, str, studentMap,
} from './common.js';

// admin responses carry the private override notes
const ADMIN = { admin: true };
const prOut = (p, students, now) => prOutPublic(p, students, now, ADMIN);
const repoOut = (r) => repoOutPublic(r, ADMIN);
const orgOut = (o) => orgOutPublic(o, ADMIN);

const BACKFILL_STATUSES = ['pending', 'running', 'done', 'error'];
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})$/;
const conflict = (m) => new ApiError(409, 'conflict', m);

/** Accepts a login, "@login" or a github.com profile URL. Returns the login or null. */
export function parseUsername(input) {
  let s = String(input ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#\s]+)/i);
  if (m) s = m[1];
  s = s.replace(/^@/, '');
  return LOGIN_RE.test(s) ? s : null;
}

function parseCampus(v, { required = false } = {}) {
  const s = String(v ?? '').trim();
  if (!s) {
    if (required) throw badRequest(`campus is required (one of ${CAMPUSES.join(', ')})`);
    return 'Unknown';
  }
  const hit = CAMPUSES.find((c) => c.toLowerCase() === s.toLowerCase());
  if (!hit) throw badRequest(`invalid campus: expected one of ${CAMPUSES.join(', ')}`);
  return hit;
}

function parseBatch(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'number' && typeof v !== 'string') throw badRequest('invalid batch: expected a year from 2015 to 2035, or null');
  const n = typeof v === 'number' ? v : (/^\d{4}$/.test(String(v).trim()) ? Number(String(v).trim()) : NaN);
  if (!Number.isInteger(n) || n < 2015 || n > 2035) throw badRequest('invalid batch: expected a year from 2015 to 2035, or null');
  return n;
}

function text(v, name, max = 500) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string' && typeof v !== 'number') throw badRequest(`invalid ${name}`);
  const s = String(v).trim();
  if (s.length > max) throw badRequest(`${name} is too long (max ${max})`);
  return s;
}

function newStudent({ username, githubId = null, name = '', nameSource = '', campus, batch, email = '', enrolmentNo = '', sources = [], notes = '' }) {
  const now = new Date();
  return {
    _id: username.toLowerCase(), username, githubId, name, nameSource, campus, batch, email, enrolmentNo, sources, notes, active: true,
    backfill: { status: 'pending', at: now }, lastSyncedAt: null, loginCheckedAt: null, addedAt: now, addedBy: 'admin', stats: emptyStudentStats(),
  };
}

/** github.js is owned by another agent and loaded lazily so the server boots without it. */
async function loadGithub() {
  try {
    return await import('../github.js');
  } catch {
    return null;
  }
}

export function adminRouter({ db, config, auth, github = null }) {
  const r = express.Router();
  const c = collections(db);

  const tz = config.tzName;
  r.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  r.get('/me', (req, res) => {
    res.json({ admin: auth.isAdmin(req), configured: auth.configured() });
  });

  r.use(auth.requireConfigured);
  r.use(auth.requireCsrfHeader);
  r.use((req, res, next) => {
    // A POST without any body (curl -X POST …/backfill, /logout) is treated as {}.
    if (!['GET', 'HEAD', 'DELETE'].includes(req.method) && req.body === undefined && !Number(req.headers['content-length'] || 0)) req.body = {};
    if (!['GET', 'HEAD', 'DELETE'].includes(req.method) && (req.body === undefined || req.body === null || typeof req.body !== 'object' || Array.isArray(req.body))) {
      return next(badRequest('a JSON object body is required (Content-Type: application/json)'));
    }
    next();
  });

  r.post('/login', (req, res) => auth.login(req, res));
  r.post('/logout', (req, res) => auth.logout(req, res));

  r.use(auth.requireAdmin);

  // Any admin write can change what the public pages show: drop the in-memory caches when it is done. Only for a
  // logged-in admin and only when the write succeeded: a request that was refused (no session, no CSRF header, wrong
  // password, validation error) changed nothing, and must not let an anonymous client keep the public cache empty.
  r.use((req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) res.on('finish', () => { if (res.statusCode < 400 || res.statusCode >= 500) invalidateAll(); }); // 5xx: may have written part of it
    next();
  });

  // ---------- students ----------

  const STUDENT_SORT = { addedAt: 'addedAt', name: 'name', username: 'username', osMerged: 'stats.osMerged' };

  /** Filter of the admin students list (also used by the CSV export of that list). */
  function adminStudentFilter(query) {
    const f = cohortFilter(query);
    const active = flag(query, 'active');
    if (active !== null) f.active = active;
    const backfill = oneOf(query, 'backfill', BACKFILL_STATUSES);
    if (backfill) f['backfill.status'] = backfill;
    const q = search(query);
    const parts = [f];
    if (q) parts.push({ $or: [{ name: contains(q) }, { username: contains(q) }, { email: contains(q) }, { enrolmentNo: contains(q) }] });
    // missing=batch,email (OR-combined) or missing=any (SPEC addendum B)
    const missing = str(query, 'missing');
    if (missing) {
      const keys = missing.split(',').map((k) => k.trim()).filter(Boolean);
      const bad = keys.find((k) => k !== 'any' && !MISSING_KEYS.includes(k));
      if (bad) throw badRequest(`invalid missing: expected any or a comma list of ${MISSING_KEYS.join(', ')}`);
      const wanted = keys.includes('any') ? MISSING_KEYS : keys;
      if (wanted.length) parts.push({ $or: wanted.map((k) => MISSING_FILTERS[k]) });
    }
    return allOf(...parts);
  }

  r.get('/students', async (req, res) => {
    const { page, limit, skip } = paging(req.query);
    const { sort, dir } = sorting(req.query, Object.keys(STUDENT_SORT), 'addedAt');
    const f = adminStudentFilter(req.query);
    const [rows, total, all] = await Promise.all([
      c.students.find(f).collation(COLLATION).sort({ [STUDENT_SORT[sort]]: dir, _id: 1 }).skip(skip).limit(limit).toArray(),
      c.students.countDocuments(f),
      c.students.find({}, { projection: { batch: 1, campus: 1, name: 1, email: 1, enrolmentNo: 1, nameSource: 1, githubId: 1, unresolvedSince: 1, 'backfill.error': 1 } }).toArray(),
    ]);
    // counts over every student, whatever the active filter
    const missingCounts = Object.fromEntries([...MISSING_KEYS, 'any'].map((k) => [k, 0]));
    for (const s of all) {
      const m = missingOf(s);
      for (const k of m) missingCounts[k]++;
      if (m.length) missingCounts.any++;
    }
    const now = new Date();
    res.json({ items: rows.map((s) => adminStudentOut(s, now)), total, page, limit, missingCounts });
  });

  r.get('/export/students.csv', async (req, res) => {
    const f = adminStudentFilter(req.query);
    const now = new Date();
    const rows = await c.students.find(f).collation(COLLATION).sort({ name: 1, _id: 1 }).toArray();
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="students-admin.csv"');
    // same column names as data/students.csv and the bulk upload, so the file can be edited and uploaded again
    let out = csvLine(['campus', 'year', 'batch', 'name', 'github_username', 'github_profile', 'email', 'enrolment_no', 'name_source', 'sources', 'notes',
      'active', 'github_id', 'backfill_status', 'missing', 'os_merged', 'os_prs', 'total_prs']);
    for (const d of rows) {
      const s = adminStudentOut(d, now);
      out += csvLine([s.campus, s.year, s.batch, s.name, s.username, `https://github.com/${s.username}`, s.email, s.enrolmentNo, s.nameSource, s.sources.join('; '), s.notes,
        s.active, s.githubId, s.backfill.status, s.missing.join('; '), s.stats.osMerged, s.stats.osPrs, s.stats.totalPrs]);
    }
    res.send(out);
  });

  /** A new student may own repos other students already sent PRs to: those become peer_repo. */
  async function afterStudentSetChanged(ids) {
    invalidateContext();
    const res = await reclassify(db, { prFilter: { ownerLc: { $in: ids } }, repoFilter: { ownerLc: { $in: ids } } });
    if (res.prsChanged || res.reposChanged) await refreshAggregates(db);
  }

  r.post('/students', async (req, res) => {
    const b = req.body;
    let username = parseUsername(b.username);
    if (!username) throw badRequest('username must be a GitHub login or a github.com profile URL');
    const campus = parseCampus(b.campus, { required: true });
    const batch = parseBatch(b.batch);
    let name = text(b.name, 'name', 200);
    const email = text(b.email, 'email', 200);
    const enrolmentNo = text(b.enrolmentNo, 'enrolmentNo', 100);
    let nameSource = name ? 'sheet' : '';
    let githubId = null;

    if (await findStudent(db, username)) throw conflict(`student ${username} already exists (reactivate with PATCH active:true)`);

    if (config.githubToken) {
      const gh = github ?? await loadGithub(); // `github` is injectable for tests
      if (gh?.getUser) {
        let user;
        let checked = true;
        try {
          user = await gh.getUser(username, { token: config.githubToken });
        } catch {
          checked = false; // GitHub unreachable: accept the login as typed, the backfill marks unknown logins not_found
        }
        if (checked && !user) throw badRequest(`GitHub user ${username} does not exist`);
        if (user) {
          if (user.login) username = user.login;
          if (Number.isFinite(user.id)) githubId = user.id;
          if (!name && user.name) { name = String(user.name).trim().slice(0, 200); nameSource = name ? 'github profile' : ''; }
          if (await findStudent(db, username)) throw conflict(`student ${username} already exists (reactivate with PATCH active:true)`);
        }
      }
    }

    const doc = newStudent({ username, githubId, name, nameSource, campus, batch, email, enrolmentNo, sources: ['admin'] });
    try {
      await c.students.insertOne(doc);
    } catch (e) {
      if (e?.code === 11000) throw conflict(`student ${username} already exists`);
      throw e;
    }
    await afterStudentSetChanged([doc._id]);
    const job = await enqueue(db, 'backfill', { users: [doc.username] });
    res.status(201).json({ student: adminStudentOut(await c.students.findOne({ _id: doc._id })), job: { id: job._id } });
  });

  r.post('/students/bulk', async (req, res) => {
    let rows;
    if (typeof req.body.csv === 'string') rows = parseCsv(req.body.csv);
    else if (Array.isArray(req.body.rows)) rows = req.body.rows;
    else throw badRequest('body must contain csv (string) or rows (array)');
    if (rows.length > 5000) throw badRequest('at most 5000 rows per request');

    const results = [];
    const docs = [];
    const updates = []; // [student doc, $set]
    const seen = new Set();
    const existing = new Map(); // lowercase _id and lowercase current username -> student
    for await (const s of c.students.find({}, { projection: { username: 1, name: 1, nameSource: 1, campus: 1, batch: 1, email: 1, enrolmentNo: 1, notes: 1, active: 1 } })) {
      existing.set(s._id, s);
      existing.set(lc(s.username), s);
    }

    rows.forEach((raw, i) => {
      const row = raw && typeof raw === 'object' ? raw : {};
      // the CSV export puts ' in front of a value that a spreadsheet would run as a formula: taken off again here
      const get = (...keys) => { for (const k of keys) if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') return String(row[k]).trim().replace(/^'(?=[=+\-@])/, ''); return ''; };
      const typed = get('github_username', 'username', 'github_profile');
      const result = { row: i + 1, username: typed, status: 'invalid', error: null };
      results.push(result);
      if (!typed) { result.error = 'github_username required'; return; }
      const username = parseUsername(typed);
      if (!username) { result.error = 'not a valid GitHub login or profile URL'; return; }
      result.username = username;
      const id = username.toLowerCase();
      if (seen.has(id)) { result.status = 'exists'; return; }
      try {
        const name = text(get('name'), 'name', 200);
        const old = existing.get(id);
        if (old) {
          // An existing student is updated from the columns that have a value in this row (SPEC addendum B):
          // an empty cell never erases what is stored.
          const set = {};
          if (name && name !== (old.name || '')) { set.name = name; set.nameSource = ['sheet', 'github profile'].includes(get('name_source')) ? get('name_source') : 'sheet'; }
          if (get('campus')) { const campus = parseCampus(get('campus')); if (campus !== old.campus) set.campus = campus; }
          if (get('batch')) { const batch = parseBatch(get('batch')); if (batch !== (old.batch ?? null)) set.batch = batch; }
          const email = text(get('email'), 'email', 200);
          if (email && email !== (old.email || '')) set.email = email;
          const enrol = text(get('enrolment_no', 'enrolmentNo'), 'enrolment_no', 100);
          if (enrol && enrol !== (old.enrolmentNo || '')) set.enrolmentNo = enrol;
          const notes = text(get('notes'), 'notes', 2000);
          if (notes && notes !== (old.notes || '')) set.notes = notes;
          seen.add(old._id);
          seen.add(id);
          result.username = old.username || username;
          if (Object.keys(set).length) { updates.push([old, set]); result.status = 'updated'; } else result.status = 'exists';
          return;
        }
        const sources = get('sources') ? get('sources').split(';').map((s) => s.trim()).filter(Boolean) : ['admin bulk'];
        docs.push(newStudent({
          username, name, nameSource: name ? (get('name_source') || 'sheet') : '', campus: parseCampus(get('campus')), batch: parseBatch(get('batch')),
          email: text(get('email'), 'email', 200), enrolmentNo: text(get('enrolment_no', 'enrolmentNo'), 'enrolment_no', 100),
          sources, notes: text(get('notes'), 'notes', 2000),
        }));
        seen.add(id);
        result.status = 'added';
      } catch (e) {
        result.error = e.message;
      }
    });

    let job = null;
    let cohortChanged = false;
    for (const [old, set] of updates) {
      await c.students.updateOne({ _id: old._id }, { $set: set });
      if ('campus' in set || 'batch' in set) {
        cohortChanged = true;
        await c.prs.updateMany({ author: old._id }, { $set: { campus: set.campus ?? old.campus, batch: 'batch' in set ? set.batch : (old.batch ?? null) } });
      }
    }
    if (docs.length) {
      await c.students.insertMany(docs, { ordered: false });
      await afterStudentSetChanged(docs.map((d) => d._id));
      job = await enqueue(db, 'backfill', { users: docs.map((d) => d.username) });
    }
    if (cohortChanged) await refreshAggregates(db);
    const count = (st) => results.filter((x) => x.status === st).length;
    res.json({ results, added: count('added'), updated: count('updated'), exists: count('exists'), invalid: count('invalid'), job: job ? { id: job._id } : null });
  });

  async function studentOr404(name) {
    const s = await findStudent(db, name);
    if (!s) throw notFound('student not found');
    return s;
  }

  r.patch('/students/:username', async (req, res) => {
    const s = await studentOr404(req.params.username);
    const b = req.body;
    const set = {};
    if ('name' in b) {
      set.name = text(b.name, 'name', 200);
      if (set.name !== (s.name || '')) set.nameSource = set.name ? 'sheet' : '';
    }
    if ('campus' in b) set.campus = parseCampus(b.campus, { required: true });
    if ('batch' in b) set.batch = parseBatch(b.batch);
    if ('email' in b) set.email = text(b.email, 'email', 200);
    if ('enrolmentNo' in b) set.enrolmentNo = text(b.enrolmentNo, 'enrolmentNo', 100);
    if ('notes' in b) set.notes = text(b.notes, 'notes', 2000);
    if ('active' in b) {
      if (typeof b.active !== 'boolean') throw badRequest('active must be true or false');
      set.active = b.active;
    }
    if (!Object.keys(set).length) throw badRequest('nothing to update (allowed: name, campus, batch, email, enrolmentNo, notes, active)');
    await c.students.updateOne({ _id: s._id }, { $set: set });
    const next = { ...s, ...set };
    if (next.campus !== s.campus || (next.batch ?? null) !== (s.batch ?? null) || (next.active !== false) !== (s.active !== false)) {
      await c.prs.updateMany({ author: s._id }, { $set: { campus: next.campus, batch: next.batch ?? null, active: next.active !== false } });
      await refreshAggregates(db);
    }
    res.json({ student: adminStudentOut(await c.students.findOne({ _id: s._id })) });
  });

  r.delete('/students/:username', async (req, res) => {
    const s = await studentOr404(req.params.username);
    const purge = flag(req.query, 'purge') === true;
    let prsRemoved = 0;
    if (purge) {
      prsRemoved = (await c.prs.deleteMany({ author: s._id })).deletedCount;
      await c.students.deleteOne({ _id: s._id });
      invalidateContext();
      await reclassify(db, { prFilter: { ownerLc: { $in: [s._id, lc(s.username)] } }, repoFilter: { ownerLc: { $in: [s._id, lc(s.username)] } } });
    } else {
      await c.students.updateOne({ _id: s._id }, { $set: { active: false } });
      await c.prs.updateMany({ author: s._id }, { $set: { active: false } });
    }
    await refreshAggregates(db);
    res.json({ ok: true, purged: purge, prsRemoved });
  });

  r.post('/students/:username/backfill', async (req, res) => {
    const s = await studentOr404(req.params.username);
    await c.students.updateOne({ _id: s._id }, { $set: { backfill: { status: 'pending', at: new Date() } } });
    const job = await enqueue(db, 'backfill', { users: [s.username] });
    res.json({ job: { id: job._id } });
  });

  // ---------- overrides (synchronous: reclassify what is touched, then refresh aggregates) ----------

  function overrideBody(body, allowed) {
    const override = body.override ?? null;
    if (override !== null && !allowed.includes(override)) throw badRequest(`invalid override: expected ${allowed.join(', ')} or null`);
    const note = text(body.note, 'note', 500);
    return override === null
      ? { override: null, overrideNote: null, overrideAt: null }
      : { override, overrideNote: note, overrideAt: new Date() };
  }

  r.post('/prs/override', async (req, res) => {
    const url = text(req.body.url, 'url', 500);
    if (!url) throw badRequest('url is required');
    const set = overrideBody(req.body, ['open_source', 'not_open_source']);
    const upd = await c.prs.updateOne({ _id: url }, { $set: set });
    if (!upd.matchedCount) throw notFound('pr not found');
    await reclassify(db, { prFilter: { _id: url }, repoFilter: null });
    await refreshAggregates(db);
    const pr = await c.prs.findOne({ _id: url });
    res.json({ ok: true, pr: prOut(pr, await studentMap(db, [pr.author])), affected: { prs: 1 } });
  });

  r.post('/repos/override', async (req, res) => {
    const id = lc(text(req.body.repo, 'repo', 300));
    if (!id) throw badRequest('repo is required');
    const set = overrideBody(req.body, ['include', 'exclude']);
    const upd = await c.repos.updateOne({ _id: id }, { $set: set });
    if (!upd.matchedCount) throw notFound('repo not found');
    const result = await reclassify(db, { prFilter: { repoLc: id }, repoFilter: { _id: id } });
    await refreshAggregates(db);
    res.json({ ok: true, repo: repoOut(await c.repos.findOne({ _id: id })), affected: { prs: result.prs, repos: result.repos } });
  });

  r.post('/owners/override', async (req, res) => {
    const id = lc(text(req.body.login, 'login', 100));
    if (!id) throw badRequest('login is required');
    const set = overrideBody(req.body, ['include', 'exclude', 'nst_internal']);
    const upd = await c.owners.updateOne({ _id: id }, { $set: set });
    if (!upd.matchedCount) throw notFound('owner not found');
    const result = await reclassify(db, { prFilter: { ownerLc: id }, repoFilter: { ownerLc: id } });
    await refreshAggregates(db);
    res.json({ ok: true, org: orgOut(await c.owners.findOne({ _id: id })), affected: { prs: result.prs, repos: result.repos } });
  });

  r.get('/overrides', async (req, res) => {
    const f = { override: { $ne: null } };
    const sort = { overrideAt: -1, _id: 1 };
    const [prs, repos, owners] = await Promise.all([
      c.prs.find(f).sort(sort).toArray(),
      c.repos.find(f).sort(sort).toArray(),
      c.owners.find(f).sort(sort).toArray(),
    ]);
    const students = await studentMap(db, prs.map((p) => p.author));
    const at = (d) => (d.overrideAt instanceof Date ? d.overrideAt.toISOString() : null);
    res.json({
      prs: prs.map((p) => ({ ...prOut(p, students), overrideAt: at(p) })),
      repos: repos.map((d) => ({ ...repoOut(d), overrideAt: at(d) })),
      owners: owners.map((d) => ({ ...orgOut(d), overrideAt: at(d) })),
    });
  });

  // ---------- review queues ----------

  const overrideFilter = (query) => {
    const v = oneOf(query, 'override', ['any', 'none']);
    return v === 'any' ? { override: { $ne: null } } : v === 'none' ? { override: null } : {};
  };

  // the tie-breaker must not overwrite the chosen key (sort=prs&order=asc would come back descending)
  const reviewSort = (field, dir) => ({ [field]: dir, ...(field !== 'stats.prs' && { 'stats.prs': -1 }), _id: 1 });

  const REVIEW_REPO_SORT = { prs: 'stats.prs', students: 'stats.students', stars: 'stars', merged: 'stats.merged' };

  r.get('/review/repos', async (req, res) => {
    const { page, limit, skip } = paging(req.query);
    const { sort, dir } = sorting(req.query, Object.keys(REVIEW_REPO_SORT), 'prs');
    const f = { 'stats.prs': { $gte: intParam(req.query, 'minPrs', { min: 0, def: 1 }) }, ...overrideFilter(req.query) };
    const category = oneOf(req.query, 'category', [...CATEGORIES, 'all'], 'all');
    if (category !== 'all') f.category = category;
    const owner = str(req.query, 'owner');
    if (owner) f.ownerLc = lc(owner);
    const q = search(req.query);
    if (q) f.$or = [{ name: contains(q) }, { description: contains(q) }];
    const [rows, total] = await Promise.all([
      c.repos.find(f).sort(reviewSort(REVIEW_REPO_SORT[sort], dir)).skip(skip).limit(limit).toArray(),
      c.repos.countDocuments(f),
    ]);
    const owners = await c.owners.find({ _id: { $in: rows.map((x) => x.ownerLc) }, override: { $ne: null } }, { projection: { override: 1 } }).toArray();
    const ov = new Map(owners.map((o) => [o._id, o.override]));
    res.json({ items: rows.map((x) => ({ ...repoOut(x), ownerOverride: ov.get(x.ownerLc) ?? null })), total, page, limit });
  });

  const REVIEW_OWNER_SORT = { prs: 'stats.prs', osPrs: 'stats.osPrs', students: 'stats.students', repos: 'stats.repos' };

  r.get('/review/owners', async (req, res) => {
    const { page, limit, skip } = paging(req.query);
    const { sort, dir } = sorting(req.query, Object.keys(REVIEW_OWNER_SORT), 'prs');
    const f = { 'stats.prs': { $gte: intParam(req.query, 'minPrs', { min: 0, def: 1 }) }, ...overrideFilter(req.query) };
    const q = search(req.query);
    if (q) f.login = contains(q);
    const [rows, total] = await Promise.all([
      c.owners.find(f).sort(reviewSort(REVIEW_OWNER_SORT[sort], dir)).skip(skip).limit(limit).toArray(),
      c.owners.countDocuments(f),
    ]);
    res.json({ items: rows.map(orgOut), total, page, limit });
  });

  // ---------- rules ----------

  r.get('/rules', async (req, res) => {
    res.json({ rules: rulesOut(await loadRules(db)) });
  });

  r.put('/rules', async (req, res) => {
    const { rules, error } = validateRules(req.body);
    if (error) throw badRequest(error);
    const saved = await saveRules(db, rules);
    invalidateContext();
    const job = await enqueue(db, 'reclassify', {});
    res.json({ rules: rulesOut(saved), job: { id: job._id } });
  });

  // ---------- jobs ----------

  r.get('/jobs', async (req, res) => {
    const { page, limit, skip } = paging(req.query);
    const f = {};
    const type = oneOf(req.query, 'type', JOB_TYPES);
    if (type) f.type = type;
    const status = oneOf(req.query, 'status', ['queued', 'running', 'done', 'error', 'cancelled']);
    if (status) f.status = status;
    const [rows, total] = await Promise.all([
      c.jobs.find(f, { projection: { log: 0 } }).sort({ createdAt: -1, _id: 1 }).skip(skip).limit(limit).toArray(),
      c.jobs.countDocuments(f),
    ]);
    res.json({ items: rows.map((j) => jobOut(j)), total, page, limit });
  });

  r.get('/jobs/:id', async (req, res) => {
    const job = await c.jobs.findOne({ _id: String(req.params.id) });
    if (!job) throw notFound('job not found');
    res.json({ job: jobOut(job, true) });
  });

  r.post('/jobs/sync', async (req, res) => {
    const params = { trigger: 'manual' };
    if (req.body.users !== undefined && req.body.users !== null) {
      if (!Array.isArray(req.body.users) || req.body.users.some((u) => typeof u !== 'string' || !parseUsername(u))) throw badRequest('users must be a list of GitHub logins');
      if (req.body.users.length) params.users = req.body.users.map((u) => parseUsername(u));
    }
    if (req.body.full !== undefined && typeof req.body.full !== 'boolean') throw badRequest('full must be true or false');
    params.full = req.body.full === true;
    if (req.body.campus !== undefined && req.body.campus !== null && req.body.campus !== '') params.campus = parseCampus(req.body.campus);
    if (req.body.batch !== undefined && req.body.batch !== null && req.body.batch !== '') params.batch = parseBatch(req.body.batch);
    // one sync at a time: a second one would fetch the same students again. The check and the enqueue run one request
    // at a time (replicas: 1), so two "Fetch now" clicks that arrive together cannot both pass.
    // The lock is shared with the scheduler (jobs.syncLock), so a scheduled run and "Fetch now" cannot both pass either.
    const job = await syncLock(db, async () => {
      const running = await activeSync(db);
      if (running) throw new ApiError(409, 'conflict', `a sync is already ${running.status} (job ${running._id})`, { jobId: running._id });
      const schedule = await ensureSchedule(db, { tz, concurrency: config.syncConcurrency });
      params.concurrency = schedule.concurrency;
      return enqueue(db, 'sync', params);
    });
    res.status(202).json({ job: { id: job._id } });
  });

  r.post('/jobs/:id/cancel', async (req, res) => {
    const id = String(req.params.id);
    const before = await c.jobs.findOne({ _id: id }, { projection: { status: 1 } });
    if (!before) throw notFound('job not found');
    if (!['queued', 'running'].includes(before.status)) throw new ApiError(409, 'conflict', `job already finished (${before.status})`, { jobId: id });
    res.json({ job: jobOut(await cancelJob(db, id)) });
  });

  // ---------- scheduled fetch (SPEC addendum C) ----------

  async function scheduleView() {
    const now = new Date();
    const [schedule, running, runs] = await Promise.all([
      ensureSchedule(db, { tz, concurrency: config.syncConcurrency }),
      activeSync(db),
      c.jobs.find({ type: 'sync' }, { projection: { log: 0 } }).sort({ createdAt: -1, _id: 1 }).limit(14).toArray(),
    ]);
    // the result of the last scheduled run, as it is now (the scheduler copies it only every 30 seconds)
    if (schedule.lastRunJobId) {
      const last = await c.jobs.findOne({ _id: schedule.lastRunJobId }, { projection: { status: 1 } });
      if (last) schedule.lastRunStatus = last.status;
    }
    return { schedule: scheduleOut(schedule, now), tz, running: running ? jobOut(running) : null, runs: runs.map((j) => jobOut(j)) };
  }

  r.get('/schedule', async (req, res) => {
    res.json(await scheduleView());
  });

  r.put('/schedule', async (req, res) => {
    const { value, error } = validateSchedule(req.body);
    if (error) throw badRequest(error);
    await updateSchedule(db, value, { tz });
    res.json(await scheduleView());
  });

  r.post('/schedule/pause', async (req, res) => {
    const until = parseUntil(req.body.until, { tz });
    if (until.error) throw badRequest(until.error);
    await pauseSchedule(db, { until: until.value, note: text(req.body.note, 'note', 300) }, { tz });
    res.json(await scheduleView());
  });

  r.post('/schedule/resume', async (req, res) => {
    await resumeSchedule(db, { tz });
    res.json(await scheduleView());
  });

  // ---------- academic year (SPEC addendum A1) ----------

  r.get('/academic-year', async (req, res) => {
    res.json({ academicYear: await loadAcademicYear(db, new Date(), tz) });
  });

  r.put('/academic-year', async (req, res) => {
    const { value, error } = validateAcademicYear(req.body);
    if (error) throw badRequest(error);
    let history;
    if (req.body.history !== undefined) {
      const h = validateAcademicYearHistory(req.body.history, value);
      if (h.error) throw badRequest(h.error);
      history = h.value;
    }
    res.json({ academicYear: await saveAcademicYear(db, value, new Date(), tz, { history }) });
  });

  r.post('/jobs/reclassify', async (req, res) => {
    const job = await enqueue(db, 'reclassify', {});
    res.status(202).json({ job: { id: job._id } });
  });

  // Repo metadata refresh (SPEC addendum H): languages, topics, stars of every stored repo; one at a time.
  // {force?: bool} re-reads every repo; by default only repos not refreshed for 7 days (so a second run resumes).
  r.post('/jobs/repo-meta', async (req, res) => {
    if (req.body.force !== undefined && typeof req.body.force !== 'boolean') throw badRequest('force must be true or false');
    const job = await syncLock(db, async () => {
      const running = await c.jobs.findOne({ type: 'repoMeta', $or: [{ runner: 'app', status: { $in: ['queued', 'running'] } }, { runner: 'cli', status: 'running', startedAt: { $gte: new Date(Date.now() - 6 * 3600000) } }] });
      if (running) throw new ApiError(409, 'conflict', `a repo metadata refresh is already ${running.status} (job ${running._id})`, { jobId: running._id });
      return enqueue(db, 'repoMeta', { force: req.body.force === true, trigger: 'manual' });
    });
    res.status(202).json({ job: { id: job._id } });
  });

  return r;
}

export default adminRouter;
