// Admin API (SPEC section 6, Appendix A). Everything except login / logout / me needs the admin cookie.
import express from 'express';
import { collections } from '../db.js';
import { ApiError, badRequest, notFound } from '../auth.js';
import { CAMPUSES, CATEGORIES, YEAR_LABELS, invalidateContext, reclassify } from '../classify.js';
import { emptyStudentStats, refreshAggregates } from '../ingest.js';
import { loadRules, saveRules, validateRules } from '../rules.js';
import { JOB_TYPES, enqueue } from '../jobs.js';
import { parseCsv } from '../csv.js';
import {
  COLLATION, adminStudentOut, cohortFilter, contains, findStudent, flag, intParam, jobOut, lc, oneOf, orgOut, paging, prOut, repoOut,
  rulesOut, sorting, str, studentMap,
} from './common.js';

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
  const n = typeof v === 'number' ? v : (/^\d{4}$/.test(String(v).trim()) ? Number(String(v).trim()) : NaN);
  if (!Number.isInteger(n) || n < 2000 || n > 2100) throw badRequest('invalid batch: expected a year like 2026 or null');
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
    if (!['GET', 'HEAD', 'DELETE'].includes(req.method) && (req.body === undefined || req.body === null || typeof req.body !== 'object' || Array.isArray(req.body))) {
      return next(badRequest('a JSON object body is required (Content-Type: application/json)'));
    }
    next();
  });

  r.post('/login', (req, res) => auth.login(req, res));
  r.post('/logout', (req, res) => auth.logout(req, res));

  r.use(auth.requireAdmin);

  // ---------- students ----------

  const STUDENT_SORT = { addedAt: 'addedAt', name: 'name', username: 'username', osMerged: 'stats.osMerged' };

  r.get('/students', async (req, res) => {
    const { page, limit, skip } = paging(req.query);
    const { sort, dir } = sorting(req.query, Object.keys(STUDENT_SORT), 'addedAt');
    const f = cohortFilter(req.query);
    const active = flag(req.query, 'active');
    if (active !== null) f.active = active;
    const backfill = oneOf(req.query, 'backfill', BACKFILL_STATUSES);
    if (backfill) f['backfill.status'] = backfill;
    const q = str(req.query, 'q');
    if (q) f.$or = [{ name: contains(q) }, { username: contains(q) }, { email: contains(q) }, { enrolmentNo: contains(q) }];
    const [rows, total] = await Promise.all([
      c.students.find(f).collation(COLLATION).sort({ [STUDENT_SORT[sort]]: dir, _id: 1 }).skip(skip).limit(limit).toArray(),
      c.students.countDocuments(f),
    ]);
    const now = new Date();
    res.json({ items: rows.map((s) => adminStudentOut(s, now)), total, page, limit });
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
    const seen = new Set();
    const existing = new Set();
    for await (const s of c.students.find({}, { projection: { username: 1 } })) { existing.add(s._id); existing.add(lc(s.username)); }

    rows.forEach((raw, i) => {
      const row = raw && typeof raw === 'object' ? raw : {};
      const get = (...keys) => { for (const k of keys) if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') return String(row[k]).trim(); return ''; };
      const typed = get('github_username', 'username', 'github_profile');
      const result = { row: i + 1, username: typed, status: 'invalid', error: null };
      results.push(result);
      if (!typed) { result.error = 'github_username required'; return; }
      const username = parseUsername(typed);
      if (!username) { result.error = 'not a valid GitHub login or profile URL'; return; }
      result.username = username;
      const id = username.toLowerCase();
      if (existing.has(id) || seen.has(id)) { result.status = 'exists'; return; }
      try {
        const name = text(get('name'), 'name', 200);
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
    if (docs.length) {
      await c.students.insertMany(docs, { ordered: false });
      await afterStudentSetChanged(docs.map((d) => d._id));
      job = await enqueue(db, 'backfill', { users: docs.map((d) => d.username) });
    }
    const count = (s) => results.filter((x) => x.status === s).length;
    res.json({ results, added: count('added'), exists: count('exists'), invalid: count('invalid'), job: job ? { id: job._id } : null });
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

  const REVIEW_REPO_SORT = { prs: 'stats.prs', students: 'stats.students', stars: 'stars', merged: 'stats.merged' };

  r.get('/review/repos', async (req, res) => {
    const { page, limit, skip } = paging(req.query);
    const { sort, dir } = sorting(req.query, Object.keys(REVIEW_REPO_SORT), 'prs');
    const f = { 'stats.prs': { $gte: intParam(req.query, 'minPrs', { min: 0, def: 1 }) }, ...overrideFilter(req.query) };
    const category = oneOf(req.query, 'category', [...CATEGORIES, 'all'], 'all');
    if (category !== 'all') f.category = category;
    const owner = str(req.query, 'owner');
    if (owner) f.ownerLc = lc(owner);
    const q = str(req.query, 'q');
    if (q) f.$or = [{ name: contains(q) }, { description: contains(q) }];
    const [rows, total] = await Promise.all([
      c.repos.find(f).sort({ [REVIEW_REPO_SORT[sort]]: dir, 'stats.prs': -1, _id: 1 }).skip(skip).limit(limit).toArray(),
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
    const q = str(req.query, 'q');
    if (q) f.login = contains(q);
    const [rows, total] = await Promise.all([
      c.owners.find(f).sort({ [REVIEW_OWNER_SORT[sort]]: dir, 'stats.prs': -1, _id: 1 }).skip(skip).limit(limit).toArray(),
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
    const status = oneOf(req.query, 'status', ['queued', 'running', 'done', 'error']);
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
    const params = {};
    if (req.body.users !== undefined && req.body.users !== null) {
      if (!Array.isArray(req.body.users) || req.body.users.some((u) => typeof u !== 'string' || !parseUsername(u))) throw badRequest('users must be a list of GitHub logins');
      if (req.body.users.length) params.users = req.body.users.map((u) => parseUsername(u));
    }
    if (req.body.full !== undefined && typeof req.body.full !== 'boolean') throw badRequest('full must be true or false');
    params.full = req.body.full === true;
    const job = await enqueue(db, 'sync', params);
    res.status(202).json({ job: { id: job._id } });
  });

  r.post('/jobs/reclassify', async (req, res) => {
    const job = await enqueue(db, 'reclassify', {});
    res.status(202).json({ job: { id: job._id } });
  });

  return r;
}

export default adminRouter;
