// In-process job runner + registry + job log (SPEC sections 4 and 6).
//
// HANDLER INTERFACE (binding for src/jobHandlers.js, owned by the fetch agent)
// ---------------------------------------------------------------------------
// src/jobHandlers.js must export two async functions as NAMED exports:
//
//   export async function backfill(db, params, ctx)   // params: { users?: [string], pending?: boolean }
//   export async function sync(db, params, ctx)       // params: { users?: [string], full?: boolean, limit?: number }
//
//   db      mongodb Db instance (already connected; do not close it)
//   params  the plain object stored in jobs.params (always an object, possibly {})
//   ctx     { log(line: string): void          appends a line to the job log (last 200 kept; echoed to stdout for CLI runs)
//             progress(done: number, total: number): void   updates jobs.progress (throttled)
//             job: { id, type, runner } }
//   returns the summary object stored in jobs.summary:
//             { students, ok, failed, prs, renamed, notFound }
//   A handler that throws marks the job `error` (message in jobs.error). Per-student failures must NOT throw:
//   count them in `failed` and continue. Both handlers end with ingest.refreshAggregates(db).
//
// The module is imported lazily (`await import('./jobHandlers.js')`) the first time a backfill / sync job starts,
// so the server boots without it; such a job then ends with status `error` ("handler for <type> is not available").
// Tests (or other modules) can replace any handler with registerHandler(type, fn).
//
// Built-in handlers: `reclassify` (classify.reclassifyAll). `import` is registered by scripts/import_legacy.js.
import crypto from 'node:crypto';
import { collections } from './db.js';
import { invalidateContext, reclassifyAll } from './classify.js';
import { refreshAggregates } from './ingest.js';
import { invalidateAll } from './cache.js';

export const JOB_TYPES = ['backfill', 'sync', 'reclassify', 'import', 'scores'];
// After one of these finishes, the private readiness scores (SPEC addendum G) are recomputed.
const CHANGES_PR_DATA = new Set(['backfill', 'sync', 'reclassify', 'import']);
const LOG_LINES = 200;
const LAZY = new Set(['backfill', 'sync']);

const handlers = new Map();
handlers.set('reclassify', async (db, params, ctx) => {
  ctx.log('reclassifying all PRs and repos');
  const r = await reclassifyAll(db);
  ctx.log(`examined ${r.prs} PRs (${r.prsChanged} changed), ${r.repos} repos (${r.reposChanged} changed); aggregates refreshed`);
  return r;
});

/** Registers (or replaces) the handler for a job type: async (db, params, ctx) => summary. */
export function registerHandler(type, fn) {
  handlers.set(type, fn);
}
/** Removes a registered handler (backfill / sync fall back to src/jobHandlers.js). */
export function unregisterHandler(type) {
  handlers.delete(type);
}

async function getHandler(type) {
  if (handlers.has(type)) return handlers.get(type);
  if (LAZY.has(type)) {
    let mod;
    try {
      mod = await import('./jobHandlers.js');
    } catch (e) {
      const why = e?.code === 'ERR_MODULE_NOT_FOUND' ? 'src/jobHandlers.js (or one of its imports) is missing' : e.message;
      throw new Error(`handler for ${type} is not available: ${why}`);
    }
    const fn = mod[type] ?? mod.default?.[type];
    if (typeof fn !== 'function') throw new Error(`handler for ${type} is not available: src/jobHandlers.js does not export ${type}()`);
    return fn;
  }
  if (type === 'scores') return (await import('./scores.js')).scoresJob;
  throw new Error(`no handler registered for job type ${type}`);
}

const STALE_CLI_MS = 6 * 60 * 60 * 1000;
const newId = () => crypto.randomBytes(6).toString('hex');
const stamp = () => new Date().toISOString().slice(11, 19);

function newJob(type, params, runner, status) {
  const now = new Date();
  return {
    _id: newId(), type, runner, status, params: params && typeof params === 'object' ? params : {},
    createdAt: now, startedAt: status === 'running' ? now : null, finishedAt: null,
    progress: { done: 0, total: 0 }, summary: null, log: [], error: null,
  };
}

const live = new Map(); // job id -> { cancelled } for the jobs running in this process

async function execute(db, job, { echo = false } = {}) {
  const { jobs } = collections(db);
  const state = { cancelled: false, checkedAt: Date.now() };
  live.set(job._id, state);
  let pending = [];           // log lines not yet persisted
  let progress = null;
  let lastFlush = 0;
  let chain = Promise.resolve();
  const flush = (force = false) => {
    if (!force && Date.now() - lastFlush < 1000) return;
    if (!pending.length && !progress) return;
    lastFlush = Date.now();
    const update = {};
    if (pending.length) update.$push = { log: { $each: pending, $slice: -LOG_LINES } };
    if (progress) update.$set = { progress };
    pending = [];
    progress = null;
    chain = chain.then(() => jobs.updateOne({ _id: job._id }, update)).catch(() => {});
  };
  const ctx = {
    job: { id: job._id, type: job.type, runner: job.runner },
    log(line) {
      const text = `${stamp()} ${String(line)}`;
      pending.push(text);
      if (pending.length > LOG_LINES) pending = pending.slice(-LOG_LINES);
      if (echo) console.log(text);
      flush();
    },
    progress(done, total) {
      progress = { done: Number(done) || 0, total: Number(total) || 0 };
      flush();
    },
    /** Cooperative cancel: at once for a cancel requested in this process, within 2 s for one written by another process. */
    async isCancelled() {
      if (state.cancelled) return true;
      if (Date.now() - state.checkedAt < 2000) return false;
      state.checkedAt = Date.now();
      const j = await jobs.findOne({ _id: job._id }, { projection: { cancelRequested: 1 } }).catch(() => null);
      state.cancelled = Boolean(j?.cancelRequested);
      return state.cancelled;
    },
  };
  let set;
  try {
    const handler = await getHandler(job.type);
    const summary = await handler(db, job.params || {}, ctx);
    // A handler that stopped because cancelRequested was set says so in its summary: what it saved until then is kept.
    set = { status: summary?.cancelled ? 'cancelled' : 'done', summary: summary && typeof summary === 'object' ? summary : null, error: null };
  } catch (e) {
    ctx.log(`error: ${e?.message || e}`);
    set = { status: 'error', error: String(e?.message || e) };
  }
  live.delete(job._id);
  flush(true);
  await chain;
  set.finishedAt = new Date();
  await jobs.updateOne({ _id: job._id }, { $set: set });
  invalidateAll(); // cached public responses are stale now
  if (CHANGES_PR_DATA.has(job.type) && set.status !== 'error') {
    try {
      const { afterDataChange } = await import('./scores.js');
      await afterDataChange(db, job, { enqueue });
    } catch { /* the scores are private and optional: never fail a fetch over them */ }
  }
  return jobs.findOne({ _id: job._id });
}

// ---------- app runner: one `runner:'app'` job at a time ----------

const pumps = new WeakMap(); // db -> Promise of the active pump

function pump(db) {
  if (pumps.has(db)) return pumps.get(db);
  const p = (async () => {
    const { jobs } = collections(db);
    for (;;) {
      const job = await jobs.findOneAndUpdate(
        { runner: 'app', status: 'queued' },
        { $set: { status: 'running', startedAt: new Date() } },
        { sort: { createdAt: 1 }, returnDocument: 'after' },
      );
      if (!job) return;
      await execute(db, job);
    }
  })().catch((e) => {
    if (process.env.NODE_ENV !== 'test') console.error('job runner stopped:', e?.message || e);
  }).finally(() => {
    pumps.delete(db);
  });
  pumps.set(db, p);
  return p;
}

const syncLocks = new WeakMap(); // db -> tail of the chain

/**
 * Runs `fn` alone per database: "is a sync active?" and "enqueue one" must happen as one step, for the admin's
 * "Fetch now" and for the scheduler alike (replicas: 1, so an in-process lock is enough). -> whatever `fn` returns.
 */
export function syncLock(db, fn) {
  const run = (syncLocks.get(db) || Promise.resolve()).then(fn);
  syncLocks.set(db, run.catch(() => {}));
  return run;
}

/** Queues a job for the in-process runner and returns the job doc (status `queued`). */
export async function enqueue(db, type, params = {}) {
  if (!JOB_TYPES.includes(type)) throw new Error(`unknown job type ${type}`);
  const job = newJob(type, params, 'app', 'queued');
  await collections(db).jobs.insertOne(job);
  setImmediate(() => pump(db));
  return job;
}

/** Runs a job to completion in this process (runner `cli`), logging to stdout too. Returns the finished job doc; never throws for handler errors. */
export async function runInline(db, type, params = {}, { echo = true } = {}) {
  if (!JOB_TYPES.includes(type)) throw new Error(`unknown job type ${type}`);
  const job = newJob(type, params, 'cli', 'running');
  const { jobs } = collections(db);
  await jobs.insertOne(job);
  // A killed script (Ctrl-C, CronJob deadline, pod eviction) must not leave its job `running` forever.
  let stopping = false;
  const onSignal = (signal) => {
    if (stopping) return;
    stopping = true;
    const done = () => process.exit(signal === 'SIGINT' ? 130 : 143);
    jobs.updateOne({ _id: job._id, status: 'running' }, { $set: { status: 'error', error: `interrupted (${signal})`, finishedAt: new Date() } })
      .then(done, done);
    setTimeout(done, 5000).unref();
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  try {
    return await execute(db, job, { echo });
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
  }
}

/** Call once on boot: marks interrupted app jobs as failed and resumes queued ones. */
export async function startRunner(db) {
  // a job that was being cancelled when the process went down is cancelled, not "interrupted": the scheduler must not start it again
  // A fetch that died with the process saved PRs student by student but never reached its closing refresh of the
  // precomputed all-time stats. Nothing else is certain to run soon (recovery needs an enabled, unpaused schedule), so
  // the stats are refreshed here: otherwise `range=all` and the admin queues disagree with every ranged page.
  const cutFetch = await collections(db).jobs.countDocuments({ runner: 'app', status: 'running', type: { $in: ['sync', 'backfill'] } });
  await collections(db).jobs.updateMany(
    { runner: 'app', status: 'running', cancelRequested: true },
    { $set: { status: 'cancelled', error: null, finishedAt: new Date() } },
  );
  await collections(db).jobs.updateMany(
    { runner: 'app', status: 'running' },
    { $set: { status: 'error', error: 'interrupted', finishedAt: new Date() } },
  );
  if (cutFetch) {
    try {
      invalidateContext();
      await refreshAggregates(db);
      invalidateAll();
    } catch (e) {
      if (process.env.NODE_ENV !== 'test') console.error('could not refresh the statistics after an interrupted fetch:', e?.message || e);
    }
  }
  // `cli` jobs are not managed by the app, but one that was killed hard (SIGKILL, node crash) can never finish:
  // anything still `running` long after the CronJob deadline (3 h) is marked failed so the Jobs page stays truthful.
  await collections(db).jobs.updateMany(
    { runner: 'cli', status: 'running', startedAt: { $lt: new Date(Date.now() - STALE_CLI_MS) } },
    { $set: { status: 'error', error: 'interrupted (no result after 6 hours)', finishedAt: new Date() } },
  );
  pump(db);
}

/**
 * Cooperative cancel (SPEC addendum C). A queued job is cancelled at once; a running one gets `cancelRequested` and its
 * handler stops between two students, keeping what it saved (status `cancelled`).
 * -> the job doc, or null when there is no such job. A job that already finished is returned unchanged.
 */
export async function cancelJob(db, id) {
  const { jobs } = collections(db);
  const queued = await jobs.findOneAndUpdate({ _id: id, status: 'queued' },
    { $set: { status: 'cancelled', cancelRequested: true, finishedAt: new Date(), error: null } }, { returnDocument: 'after' });
  if (queued) return queued;
  const running = await jobs.findOneAndUpdate({ _id: id, status: 'running' }, { $set: { cancelRequested: true } }, { returnDocument: 'after' });
  if (running && live.has(id)) live.get(id).cancelled = true;
  return running || jobs.findOne({ _id: id });
}

/** The sync job that is queued or running right now, if any (`cli` runs older than the stale limit do not count). */
export async function activeSync(db) {
  return collections(db).jobs.findOne({
    type: 'sync',
    $or: [{ runner: 'app', status: { $in: ['queued', 'running'] } }, { runner: 'cli', status: 'running', startedAt: { $gte: new Date(Date.now() - STALE_CLI_MS) } }],
  }, { sort: { createdAt: 1 } });
}

/** Resolves when the in-process runner has no queued or running job left (used by tests and graceful shutdown). */
export async function whenIdle(db) {
  for (;;) {
    await new Promise((r) => setImmediate(r));
    const p = pumps.get(db);
    if (p) { await p; continue; }
    const left = await collections(db).jobs.countDocuments({ runner: 'app', status: 'queued' });
    if (!left) return;
    await pump(db);
  }
}
