// Sync / backfill job handlers for the in-process runner and the CLI scripts (SPEC section 4, addenda B and C).
//
//   backfill(db, { users?: [string], pending?: boolean }, ctx)                     full history
//   sync(db, { users?, full?, limit?, campus?, batch?, concurrency? }, ctx)       daily incremental fetch
//
// Both return { students, ok, failed, prs, renamed, notFound, ... } and end with refreshAggregates(db).
// A 4th argument injects the GitHub side for tests: { fetch, token, sleep, now, concurrency, github }.
import { collections } from './db.js';
import { invalidateContext, reclassify } from './classify.js';
import { pruneStalePRs, refreshAggregates, upsertPRs } from './ingest.js';
import * as defaultGithub from './github.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const OVERLAP_DAYS = 2;          // incremental window starts this long before lastSyncedAt
export const FIRST_WINDOW_DAYS = 3;     // ... or this long before now when lastSyncedAt is missing
export const LOGIN_CHECK_DAYS = 7;      // rename check at most once per student in this period
export const MAX_CONSECUTIVE_FAILURES = 25; // GitHub is down or the token is bad: stop instead of failing everyone slowly

const lc = (s) => String(s ?? '').toLowerCase();

function emptySummary() {
  return {
    students: 0, ok: 0, failed: 0, prs: 0, renamed: 0, notFound: 0, skipped: 0,
    // addendum C per-run numbers
    studentsChecked: 0, studentsFailed: 0, prsNew: 0, prsUpdated: 0, newMerged: 0, rateLimitRemaining: null, durationMs: 0,
  };
}

function makeEnv(db, ctx, opts = {}) {
  const github = opts.github ?? defaultGithub;
  const now = opts.now ?? (() => new Date());
  const gh = { now, log: (line) => ctx?.log?.(line) };
  for (const k of ['fetch', 'token', 'sleep']) if (opts[k] !== undefined) gh[k] = opts[k];
  return {
    db, c: collections(db), github, now, gh,
    log: (line) => ctx?.log?.(line),
    progress: (done, total) => ctx?.progress?.(done, total),
    ctx: ctx ?? {},
    tokenSet: Boolean(opts.token ?? process.env.GITHUB_TOKEN),
  };
}

/** Cooperative cancel (addendum C): the runner may expose ctx.isCancelled(), otherwise jobs.cancelRequested is polled. */
function cancelChecker(env) {
  let last = 0;
  let cancelled = false;
  return async () => {
    if (cancelled) return true;
    const { ctx } = env;
    if (typeof ctx.isCancelled === 'function') {
      cancelled = Boolean(await ctx.isCancelled());
      return cancelled;
    }
    if (ctx.cancelled === true) { cancelled = true; return true; }
    if (!ctx.job?.id || Date.now() - last < 2000) return false;
    last = Date.now();
    const j = await env.c.jobs.findOne({ _id: ctx.job.id }, { projection: { cancelRequested: 1 } }).catch(() => null);
    cancelled = Boolean(j?.cancelRequested);
    return cancelled;
  };
}

function appendNote(notes, line) {
  const base = String(notes ?? '').trim();
  return base ? `${base}\n${line}` : line;
}

/** Applies a login change found via githubId: keeps _id, sets username, appends a note, reclassifies repos owned by the new login. */
async function applyRename(env, student, newLogin) {
  const old = student.username;
  const at = env.now();
  // the notes are re-read: an admin may have edited them since this run loaded its students
  const fresh = await env.c.students.findOne({ _id: student._id }, { projection: { notes: 1 } });
  const notes = appendNote(fresh ? fresh.notes : student.notes, `[${at.toISOString().slice(0, 10)}] GitHub login changed: ${old} -> ${newLogin}`);
  await env.c.students.updateOne({ _id: student._id }, { $set: { username: newLogin, notes, loginCheckedAt: at }, $unset: { unresolvedSince: '' } });
  student.username = newLogin;
  student.notes = notes;
  student.loginCheckedAt = at;
  delete student.unresolvedSince;
  invalidateContext();
  // PRs other students sent to repos of the new login are peer_repo now
  const ids = [lc(newLogin)];
  await reclassify(env.db, { prFilter: { ownerLc: { $in: ids } }, repoFilter: { ownerLc: { $in: ids } } }).catch((e) => env.log(`${student._id}: reclassify after rename failed: ${e?.message || e}`));
  env.log(`${student._id}: GitHub login changed ${old} -> ${newLogin}`);
}

/**
 * Resolves the current login through githubId. -> 'renamed' | 'same' | 'gone' | 'unknown' (lookup failed).
 * Records loginCheckedAt unless the lookup failed.
 */
async function checkLogin(env, student) {
  let user;
  try {
    user = await env.github.getUserById(student.githubId, env.gh);
  } catch (e) {
    env.log(`${student._id}: login check failed: ${e?.message || e}`);
    return 'unknown';
  }
  const at = env.now();
  if (!user) {
    const set = { loginCheckedAt: at };
    if (!student.unresolvedSince) { set.unresolvedSince = at; student.unresolvedSince = at; }
    await env.c.students.updateOne({ _id: student._id }, { $set: set });
    student.loginCheckedAt = at;
    return 'gone';
  }
  if (user.login && lc(user.login) !== lc(student.username)) {
    await applyRename(env, student, user.login);
    return 'renamed';
  }
  await env.c.students.updateOne({ _id: student._id }, { $set: { loginCheckedAt: at } });
  student.loginCheckedAt = at;
  return 'same';
}

/**
 * Looks at fetched nodes next to what is stored: `pub` = the public, de-duplicated nodes (all of them are written, so
 * that the repository's fresh stars / fork / archive flags are never thrown away with an unchanged PR), `changed` = the
 * new or updated ones (for the run's numbers).
 */
async function diffNodes(env, nodes, { full }) {
  const pub = [];
  const seen = new Set();
  for (const n of nodes) {
    if (!n?.url || !n.repository || n.repository.isPrivate || seen.has(n.url)) continue;
    seen.add(n.url);
    pub.push(n);
  }
  const existing = new Map();
  const urls = pub.map((n) => n.url);
  for (let i = 0; i < urls.length; i += 5000) {
    const rows = await env.c.prs.find({ _id: { $in: urls.slice(i, i + 5000) } }, { projection: { state: 1, updatedAt: 1 } }).toArray();
    for (const r of rows) existing.set(r._id, r);
  }
  const out = { pub, changed: [], prsNew: 0, prsUpdated: 0, newMerged: 0 };
  for (const n of pub) {
    const before = existing.get(n.url);
    if (!before) {
      out.prsNew++;
      if (n.mergedAt) out.newMerged++;
      out.changed.push(n);
      continue;
    }
    const t = n.updatedAt ? new Date(n.updatedAt).getTime() : NaN;
    const same = Number.isFinite(t) && before.updatedAt instanceof Date && before.updatedAt.getTime() === t;
    if (same && !full) continue;
    if (!same) out.prsUpdated++;
    if (n.mergedAt && before.state !== 'merged') out.newMerged++;
    out.changed.push(n);
  }
  return out;
}

/**
 * Fetches one student. -> { outcome: 'ok' | 'failed' | 'notFound', prs, prsNew, prsUpdated, newMerged, renamed, fatal?, error? }
 * Never throws for GitHub-side failures.
 */
async function processStudent(env, student, { full }) {
  const { c, github } = env;
  const r = { outcome: 'ok', prs: 0, prsNew: 0, prsUpdated: 0, newMerged: 0, renamed: 0, error: '', fatal: false, rateLimit: null };
  let loginChecked = false;

  // periodic account check (at most once per LOGIN_CHECK_DAYS)
  const lastCheck = student.loginCheckedAt ? new Date(student.loginCheckedAt).getTime() : 0;
  const checkDue = env.now().getTime() - lastCheck >= LOGIN_CHECK_DAYS * DAY_MS;
  if (student.githubId && checkDue) {
    const res = await checkLogin(env, student);
    loginChecked = res !== 'unknown';
    if (res === 'renamed') { r.renamed = 1; full = true; }
    if (res === 'gone') full = true; // the full fetch below confirms it and marks the student not_found
  } else if (!student.githubId && checkDue) {
    // No id yet (every imported student starts like this): a search for a login that was renamed or deleted silently
    // returns 0 PRs forever, so the login itself is looked up. Found -> remember the id (renames are detected from
    // then on); 404 -> flag the student instead of "syncing" nothing every night.
    let user;
    let checked = true;
    try {
      user = await github.getUser(student.username, env.gh);
    } catch (e) {
      checked = false;
      env.log(`${student._id}: could not verify the account: ${e?.message || e}`);
    }
    if (checked) {
      const at = env.now();
      loginChecked = true;
      student.loginCheckedAt = at;
      if (!user) {
        const set = { loginCheckedAt: at, backfill: { status: 'error', at, error: 'not_found' } };
        if (!student.unresolvedSince) { set.unresolvedSince = at; student.unresolvedSince = at; }
        await c.students.updateOne({ _id: student._id }, { $set: set });
        r.outcome = 'notFound';
        r.error = 'not_found';
        return r;
      }
      const set = { loginCheckedAt: at };
      if (Number.isFinite(user.id)) { set.githubId = user.id; student.githubId = user.id; }
      await c.students.updateOne({ _id: student._id }, { $set: set, $unset: { unresolvedSince: '' } });
      delete student.unresolvedSince;
    }
  }

  for (let pass = 0; pass < 2; pass++) {
    const startedAt = env.now();
    if (full) await c.students.updateOne({ _id: student._id }, { $set: { backfill: { status: 'running', at: startedAt } } });
    const since = full ? undefined
      : new Date(student.lastSyncedAt ? new Date(student.lastSyncedAt).getTime() - OVERLAP_DAYS * DAY_MS : startedAt.getTime() - FIRST_WINDOW_DAYS * DAY_MS);
    const res = await github.fetchUserPRs(student.username, { ...env.gh, since });
    r.rateLimit = res.rateLimit ?? r.rateLimit;

    // keep whatever was fetched, also when the result is partial
    const diff = await diffNodes(env, res.nodes || [], { full });
    if (diff.pub.length) {
      // The run loaded its students when it started, possibly hours ago. campus / batch / active are denormalised onto
      // the PRs, so they are taken from the student as stored NOW, and checked once more after the write: an admin
      // edit, deactivation or purge made while the run is in flight must win.
      const current = () => c.students.findOne({ _id: student._id }, { projection: { campus: 1, batch: 1, active: 1, githubId: 1 } });
      const before = await current();
      if (!before) {
        env.log(`${student._id}: removed while the run was in flight, nothing saved`);
        return r;
      }
      Object.assign(student, { campus: before.campus, batch: before.batch ?? null, active: before.active !== false });
      if (before.githubId && !student.githubId) student.githubId = before.githubId;
      await upsertPRs(env.db, student, diff.pub, { onlyUrls: new Set(diff.changed.map((n) => n.url)) });
      const after = await current();
      if (!after) {
        await c.prs.deleteMany({ author: student._id });
        env.log(`${student._id}: removed while the run was in flight, nothing saved`);
        return r;
      }
      const same = (after.campus ?? 'Unknown') === (student.campus ?? 'Unknown') && (after.batch ?? null) === (student.batch ?? null)
        && (after.active !== false) === (student.active !== false);
      if (!same) {
        Object.assign(student, { campus: after.campus, batch: after.batch ?? null, active: after.active !== false });
        await c.prs.updateMany({ author: student._id }, { $set: { campus: after.campus ?? 'Unknown', batch: after.batch ?? null, active: after.active !== false } });
      }
      r.prs += diff.changed.length;
      r.prsNew += diff.prsNew; r.prsUpdated += diff.prsUpdated; r.newMerged += diff.newMerged;
    }

    if (res.error) {
      r.outcome = 'failed';
      r.error = res.error;
      r.fatal = Boolean(res.fatal);
      if (full) await c.students.updateOne({ _id: student._id }, { $set: { backfill: { status: 'error', at: env.now(), error: String(res.error).slice(0, 300) } } });
      return r;
    }

    if (full && (res.nodes || []).length === 0) {
      // a search for a login that does not exist silently returns 0: check that the account is there
      let user;
      let checked = true;
      try {
        user = await github.getUser(student.username, env.gh);
      } catch (e) {
        checked = false;
        env.log(`${student._id}: could not verify the account: ${e?.message || e}`);
      }
      if (checked && !user) {
        if (pass === 0 && student.githubId && !loginChecked) {
          const how = await checkLogin(env, student);
          loginChecked = true;
          if (how === 'renamed') { r.renamed = 1; continue; } // fetch again under the new login
        }
        const at = env.now();
        const set = { backfill: { status: 'error', at, error: 'not_found' } };
        if (!student.unresolvedSince) set.unresolvedSince = at;
        await c.students.updateOne({ _id: student._id }, { $set: set });
        r.outcome = 'notFound';
        r.error = 'not_found';
        return r;
      }
      if (user && !student.githubId && Number.isFinite(user.id)) {
        await c.students.updateOne({ _id: student._id }, { $set: { githubId: user.id } });
        student.githubId = user.id;
      }
    }

    if (full) {
      // A complete full fetch is the whole truth about this student: PRs stored under urls GitHub no longer returns
      // (repo renamed / transferred / deleted / made private, account renamed) would otherwise be counted twice or forever.
      const expected = Number(res.count);
      const complete = !Number.isFinite(expected) || diff.pub.length >= expected - Math.max(3, Math.ceil(expected * 0.05));
      if (!complete) env.log(`${student._id}: GitHub reported ${expected} PRs but returned ${diff.pub.length}: stale PRs are not removed in this run`);
      else {
        const pruned = await pruneStalePRs(env.db, student, diff.pub);
        if (pruned.skipped) env.log(`${student._id}: stale PRs are not removed in this run (${pruned.skipped})`);
        else if (pruned.moved || pruned.removed) {
          r.prsMoved = pruned.moved; r.prsRemoved = pruned.removed;
          env.log(`${student._id}: ${pruned.moved} PRs moved to a new url, ${pruned.removed} no longer on GitHub removed`);
        }
      }
    }

    const set = { lastSyncedAt: startedAt };
    if (full || student.backfill?.status !== 'done') set.backfill = { status: 'done', at: env.now() };
    const update = { $set: set };
    if (full || (res.nodes || []).length) update.$unset = { unresolvedSince: '' }; // an empty incremental result proves nothing
    await c.students.updateOne({ _id: student._id }, update);
    return r;
  }
  return r;
}

/** Runs `tasks` ([{student, full}]) with a worker pool; fills and returns the summary. */
async function runAll(env, tasks, summary, { concurrency }) {
  const total = tasks.length;
  const isCancelled = cancelChecker(env);
  let next = 0;
  let done = 0;
  let consecutive = 0;
  let abort = null;
  env.progress(0, total);

  const worker = async () => {
    for (;;) {
      if (abort || next >= total) return;
      if (await isCancelled()) { summary.cancelled = true; return; }
      if (abort || next >= total) return;
      const { student, full } = tasks[next++];
      let r;
      try {
        r = await processStudent(env, student, { full });
      } catch (e) { // database or programming error for this student: count it, keep going
        r = { outcome: 'failed', prs: 0, prsNew: 0, prsUpdated: 0, newMerged: 0, renamed: 0, error: `unexpected: ${e?.message || e}`, fatal: false };
      }
      summary.studentsChecked++;
      summary.prs += r.prs; summary.prsNew += r.prsNew; summary.prsUpdated += r.prsUpdated; summary.newMerged += r.newMerged;
      summary.renamed += r.renamed;
      if (r.prsMoved) summary.prsMoved = (summary.prsMoved || 0) + r.prsMoved;
      if (r.prsRemoved) summary.prsRemoved = (summary.prsRemoved || 0) + r.prsRemoved;
      if (r.rateLimit && Number.isFinite(r.rateLimit.remaining)) summary.rateLimitRemaining = r.rateLimit.remaining;
      if (r.outcome === 'ok') {
        summary.ok++; consecutive = 0;
        if (r.prs) env.log(`${student._id}: ${r.prs} PRs saved (${r.prsNew} new, ${r.newMerged} newly merged)${full ? ' [full]' : ''}`);
      } else if (r.outcome === 'notFound') {
        summary.notFound++; consecutive = 0;
        env.log(`${student._id}: GitHub account ${student.username} not found`);
      } else {
        summary.failed++; summary.studentsFailed++; consecutive++;
        env.log(`${student._id}: failed: ${r.error}`);
        if (r.fatal) abort ??= new Error(`GitHub fetch aborted: ${r.error}`);
        else if (consecutive >= MAX_CONSECUTIVE_FAILURES) abort ??= new Error(`GitHub fetch aborted after ${consecutive} consecutive failures (last: ${r.error})`);
      }
      env.progress(++done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, worker));
  if (abort) throw abort;
  if (summary.cancelled) env.log(`cancelled after ${done} of ${total} students`);
}

function concurrencyOf(params, opts) {
  const n = Number(opts.concurrency ?? params.concurrency ?? process.env.SYNC_CONCURRENCY);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 16) : 6;
}

function userList(v) {
  if (v === undefined || v === null) return null;
  const list = (Array.isArray(v) ? v : String(v).split(',')).map((u) => String(u).trim().replace(/^@/, '')).filter(Boolean);
  return list.length ? list : null;
}

/** Students matching a list of logins (by _id or current username, case-insensitive). -> { found, unknown } */
async function findByLogins(env, logins, extra = {}) {
  const want = [...new Set(logins.map(lc))];
  const byId = await env.c.students.find({ ...extra, _id: { $in: want } }).toArray();
  const got = new Map(byId.map((s) => [s._id, s]));
  const left = want.filter((u) => !got.has(u));
  const matched = new Set(got.keys());
  if (left.length) {
    // renamed students are stored under their old _id
    const rows = await env.c.students.find({ ...extra, username: { $in: left.map((u) => new RegExp(`^${u.replace(/[^a-z0-9-]/g, '')}$`, 'i')) } }).toArray();
    for (const s of rows) { got.set(s._id, s); matched.add(lc(s.username)); }
  }
  return { found: [...got.values()], unknown: want.filter((u) => !matched.has(u)) };
}

async function run(db, ctx, opts, select, params) {
  const env = makeEnv(db, ctx, opts);
  const t0 = Date.now();
  const summary = emptySummary();
  if (!env.tokenSet && !opts.github) throw new Error('GITHUB_TOKEN is not set: cannot fetch from GitHub');
  const tasks = await select(env, summary);
  summary.students = tasks.length + summary.skipped + (summary.unknown?.length ?? 0);
  env.log(`${tasks.length} students to fetch (${tasks.filter((t) => t.full).length} full history)${summary.skipped ? `, ${summary.skipped} skipped (account not found earlier)` : ''}`);
  try {
    await runAll(env, tasks, summary, { concurrency: concurrencyOf(params, opts) });
  } finally {
    // whatever was saved must show up in the numbers, also after an abort or a cancel
    if (summary.studentsChecked) {
      invalidateContext();
      await refreshAggregates(db);
    }
  }
  if (!summary.studentsChecked) await refreshAggregates(db);
  summary.durationMs = Date.now() - t0;
  env.log(`done: ${summary.ok} ok, ${summary.failed} failed, ${summary.notFound} not found, ${summary.prs} PRs saved (${summary.prsNew} new, ${summary.newMerged} newly merged), ${summary.renamed} renamed`);
  return summary;
}

/** Full-history fetch for the given usernames, or for every active student whose backfill is pending. */
export async function backfill(db, params = {}, ctx = {}, opts = {}) {
  params ??= {};
  return run(db, ctx, opts, async (env, summary) => {
    const users = userList(params.users);
    let students = [];
    if (users) {
      const { found, unknown } = await findByLogins(env, users);
      students = found;
      if (unknown.length) {
        summary.unknown = unknown;
        summary.failed += unknown.length;
        env.log(`not tracked (add them first): ${unknown.join(', ')}`);
      }
    }
    if (params.pending || !users) {
      const have = new Set(students.map((s) => s._id));
      const pending = await env.c.students.find({ active: true, 'backfill.status': 'pending' }).sort({ addedAt: 1 }).toArray();
      for (const s of pending) if (!have.has(s._id)) students.push(s);
    }
    return students.map((student) => ({ student, full: true }));
  }, params);
}

/**
 * Daily fetch for the active students: incremental when the history is already there, full when it is pending or
 * failed earlier; accounts that were not found are skipped until an admin re-backfills them.
 */
export async function sync(db, params = {}, ctx = {}, opts = {}) {
  params ??= {};
  return run(db, ctx, opts, async (env, summary) => {
    const users = userList(params.users);
    const filter = { active: true };
    if (params.campus) filter.campus = String(params.campus);
    if (params.batch !== undefined && params.batch !== null && params.batch !== '') {
      const b = Number(params.batch);
      if (Number.isInteger(b)) filter.batch = b;
    }
    let students;
    if (users) {
      const { found, unknown } = await findByLogins(env, users, filter);
      students = found;
      if (unknown.length) {
        summary.unknown = unknown;
        summary.failed += unknown.length;
        env.log(`not tracked or not active: ${unknown.join(', ')}`);
      }
    } else {
      students = await env.c.students.find(filter).toArray();
    }
    // least recently synced first, so a limited or interrupted run rotates through everyone
    const key = (s) => (s.lastSyncedAt ? new Date(s.lastSyncedAt).getTime() : 0);
    students.sort((a, b) => key(a) - key(b) || (a._id < b._id ? -1 : 1));
    const tasks = [];
    for (const s of students) {
      const st = s.backfill?.status;
      if (st === 'error' && s.backfill?.error === 'not_found' && !users) { summary.skipped++; continue; }
      tasks.push({ student: s, full: Boolean(params.full) || st !== 'done' });
    }
    const limit = Number(params.limit);
    return Number.isInteger(limit) && limit > 0 ? tasks.slice(0, limit) : tasks;
  }, params);
}

export default { backfill, sync };
