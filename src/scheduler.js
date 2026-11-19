// The scheduled fetch, managed from the admin UI (SPEC addendum C). Runs inside the app (replicas: 1): every tick
// looks at the `schedule` settings doc and enqueues a `sync` job when one is due. All state is in Mongo, so a restart
// loses nothing: a run missed while the app was down is caught up once, a run cut off by a restart is started again once.
import { collections } from './db.js';
import { TZ, addDays, isYmd, zoned, zonedTime } from './dates.js';
import { activeSync, enqueue } from './jobs.js';

export const TICK_MS = 30000;
const HOUR_MS = 60 * 60 * 1000;

export function defaultSchedule(concurrency = 6) {
  return { enabled: true, paused: false, pausedUntil: null, pauseNote: '', dailyAt: '02:30', fullRefreshDay: null, concurrency,
    lastRunAt: null, lastRunJobId: null, lastRunStatus: null, nextRunAt: null };
}

/** The first `dailyAt` (HH:MM on the wall clock of `tz`) strictly after `now`. */
export function nextRunAfter(now, dailyAt = '02:30', tz = TZ) {
  const [h, m] = dailyAt.split(':').map(Number);
  const today = zoned(now, tz).ymd;
  const t = zonedTime(today, h, m, tz);
  return t > now ? t : zonedTime(addDays(today, 1), h, m, tz);
}

export async function loadSchedule(db) {
  const doc = await collections(db).settings.findOne({ _id: 'schedule' });
  return { ...defaultSchedule(), ...(doc || {}) };
}

/** Creates the settings doc on first boot and makes sure an enabled schedule has a next run time. */
export async function ensureSchedule(db, { now = new Date(), tz = TZ, concurrency = 6 } = {}) {
  const { settings } = collections(db);
  const { _id, ...defaults } = { _id: 'schedule', ...defaultSchedule(concurrency) };
  await settings.updateOne({ _id: 'schedule' }, { $setOnInsert: { ...defaults, nextRunAt: nextRunAfter(now, defaults.dailyAt, tz) } }, { upsert: true });
  const s = await loadSchedule(db);
  if (s.enabled && !(s.nextRunAt instanceof Date)) {
    s.nextRunAt = nextRunAfter(now, s.dailyAt, tz);
    await settings.updateOne({ _id: 'schedule' }, { $set: { nextRunAt: s.nextRunAt } });
  }
  return s;
}

/** Validates the editable fields of PUT /api/admin/schedule: -> { value } | { error }. Only the given fields are returned. */
export function validateSchedule(body) {
  const v = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'a JSON object is required' };
  if ('dailyAt' in body) {
    if (typeof body.dailyAt !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.dailyAt)) return { error: 'dailyAt must be a time like 02:30 (24-hour clock)' };
    v.dailyAt = body.dailyAt;
  }
  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') return { error: 'enabled must be true or false' };
    v.enabled = body.enabled;
  }
  if ('fullRefreshDay' in body) {
    const d = body.fullRefreshDay;
    if (d !== null && !(Number.isInteger(d) && d >= 0 && d <= 6)) return { error: 'fullRefreshDay must be null or 0 (Sunday) to 6 (Saturday)' };
    v.fullRefreshDay = d;
  }
  if ('concurrency' in body) {
    if (!Number.isInteger(body.concurrency) || body.concurrency < 1 || body.concurrency > 16) return { error: 'concurrency must be a whole number from 1 to 16' };
    v.concurrency = body.concurrency;
  }
  if (!Object.keys(v).length) return { error: 'nothing to update (allowed: dailyAt, enabled, fullRefreshDay, concurrency)' };
  return { value: v };
}

export async function updateSchedule(db, patch, { now = new Date(), tz = TZ } = {}) {
  const { settings } = collections(db);
  const before = await ensureSchedule(db, { now, tz });
  const next = { ...before, ...patch };
  const set = { ...patch };
  if (!next.enabled) set.nextRunAt = null;
  else if (!before.enabled || before.dailyAt !== next.dailyAt || !(before.nextRunAt instanceof Date)) set.nextRunAt = nextRunAfter(now, next.dailyAt, tz);
  await settings.updateOne({ _id: 'schedule' }, { $set: set });
  return loadSchedule(db);
}

/** `until`: a YYYY-MM-DD day (the schedule resumes at 00:00 of that day in `tz`) or an ISO date-time; null = until resumed by hand. */
export function parseUntil(until, { now = new Date(), tz = TZ } = {}) {
  if (until === undefined || until === null || until === '') return { value: null };
  if (typeof until !== 'string') return { error: 'until must be a date (YYYY-MM-DD) or an ISO date-time' };
  const d = isYmd(until) ? zonedTime(until, 0, 0, tz) : new Date(until);
  if (Number.isNaN(d.getTime())) return { error: 'until must be a date (YYYY-MM-DD) or an ISO date-time' };
  if (d <= now) return { error: 'until must be in the future' };
  return { value: d };
}

export async function pauseSchedule(db, { until = null, note = '' } = {}, { now = new Date(), tz = TZ } = {}) {
  await ensureSchedule(db, { now, tz });
  await collections(db).settings.updateOne({ _id: 'schedule' }, { $set: { paused: true, pausedUntil: until, pauseNote: String(note || '').slice(0, 300), pausedAt: now } });
  return loadSchedule(db);
}

export async function resumeSchedule(db, { now = new Date(), tz = TZ } = {}) {
  await ensureSchedule(db, { now, tz });
  await collections(db).settings.updateOne({ _id: 'schedule' }, { $set: { paused: false, pausedUntil: null, pauseNote: '' } });
  return loadSchedule(db);
}

/**
 * One scheduler step. -> { fired: job id | null, why }
 * Fires when the schedule is enabled, not paused, `now >= nextRunAt` and no sync is queued or running; `nextRunAt` then
 * moves to the next daily slot, so a long downtime is caught up with exactly one run.
 */
export async function tick(db, { now = new Date(), tz = TZ, enqueueJob = enqueue } = {}) {
  const { settings, jobs } = collections(db);
  const s = await loadSchedule(db);
  if (!s._id) return { fired: null, why: 'no schedule' };

  if (s.paused && s.pausedUntil instanceof Date && now >= s.pausedUntil) { // auto-resume
    await settings.updateOne({ _id: 'schedule' }, { $set: { paused: false, pausedUntil: null, pauseNote: '' } });
    s.paused = false;
  }
  let last = null;
  if (s.lastRunJobId) {
    last = await jobs.findOne({ _id: s.lastRunJobId }, { projection: { status: 1, error: 1 } });
    if (last && last.status !== s.lastRunStatus) {
      await settings.updateOne({ _id: 'schedule' }, { $set: { lastRunStatus: last.status } });
      s.lastRunStatus = last.status;
    }
  }
  if (!s.enabled) return { fired: null, why: 'disabled' };
  if (s.paused) return { fired: null, why: 'paused' };

  const start = async (trigger, claim, extra = {}) => {
    // the claim makes a slot fire once, also if two ticks overlap
    const claimed = await settings.updateOne({ _id: 'schedule', ...claim.filter }, { $set: { ...claim.set, lastRunAt: now } });
    if (!claimed.modifiedCount) return { fired: null, why: 'already claimed' };
    const weekly = s.fullRefreshDay !== null && s.fullRefreshDay !== undefined && s.fullRefreshDay === zoned(now, tz).dow % 7;
    const params = { trigger, full: weekly, concurrency: s.concurrency, ...extra };
    const job = await enqueueJob(db, 'sync', params);
    await settings.updateOne({ _id: 'schedule' }, { $set: { lastRunJobId: job._id, lastRunStatus: job.status || 'queued' } });
    return { fired: job._id, why: trigger, job };
  };
  const out = ({ fired, why }) => ({ fired, why });

  const busy = await activeSync(db);
  // A sync that a restart cut off (startRunner marked it `interrupted`) is started again, once: only when it is the
  // newest sync job, and never for a run that was itself a recovery (a pod that keeps dying must not fetch in a loop).
  let cut = null;
  if (!busy) {
    const newest = await jobs.find({ type: 'sync' }, { projection: { log: 0 } }).sort({ createdAt: -1, _id: 1 }).limit(1).next();
    if (newest && newest.runner === 'app' && newest.status === 'error' && newest.error === 'interrupted' && !newest.recoveredBy
      && newest.params?.trigger !== 'recovery') cut = newest;
  }
  const claimCut = async () => (await jobs.updateOne({ _id: cut._id, recoveredBy: { $exists: false } }, { $set: { recoveredBy: 'pending' } })).modifiedCount === 1;
  const due = s.nextRunAt instanceof Date && now >= s.nextRunAt;
  if (cut && !due) {
    if (!(await claimCut())) return { fired: null, why: 'already claimed' };
    // same selection as the run that was cut off; students it had already finished are not fetched again
    const extra = { recovers: cut._id };
    for (const k of ['full', 'users', 'campus', 'batch', 'limit']) if (cut.params?.[k] !== undefined) extra[k] = cut.params[k];
    if (cut.startedAt instanceof Date) extra.resumeSince = cut.startedAt;
    const r = await start('recovery', { filter: {}, set: { recoveredJobId: cut._id } }, extra);
    await jobs.updateOne({ _id: cut._id }, r.fired ? { $set: { recoveredBy: r.fired } } : { $unset: { recoveredBy: '' } });
    return out(r);
  }
  if (!(s.nextRunAt instanceof Date)) {
    await settings.updateOne({ _id: 'schedule' }, { $set: { nextRunAt: nextRunAfter(now, s.dailyAt, tz) } });
    return { fired: null, why: 'scheduled' };
  }
  if (!due) return { fired: null, why: 'not due' };
  if (busy) return { fired: null, why: 'a sync is already queued or running' };
  const late = now.getTime() - s.nextRunAt.getTime() > HOUR_MS;
  // a nightly run that is due anyway also stands in for a run that was cut off (it covers every student)
  const extra = {};
  if (cut && (await claimCut())) {
    extra.recovers = cut._id;
    if (cut.params?.full === true && !cut.params.users && !cut.params.campus && cut.params.batch === undefined) extra.full = true;
  }
  const r = await start(late ? 'catchup' : 'schedule', { filter: { nextRunAt: s.nextRunAt }, set: { nextRunAt: nextRunAfter(now, s.dailyAt, tz) } }, extra);
  if (extra.recovers) await jobs.updateOne({ _id: cut._id }, r.fired ? { $set: { recoveredBy: r.fired } } : { $unset: { recoveredBy: '' } });
  return out(r);
}

/** Starts ticking (first tick right away: that is the catch-up on boot). -> { stop() } */
export async function startScheduler(db, { intervalMs = TICK_MS, tz = TZ, concurrency = 6, log = console.log } = {}) {
  await ensureSchedule(db, { tz, concurrency });
  let running = false;
  const step = async () => {
    if (running) return;
    running = true;
    try {
      const r = await tick(db, { tz });
      if (r.fired) log(`scheduler: started sync job ${r.fired} (${r.why})`);
    } catch (e) {
      log(`scheduler: tick failed: ${e?.message || e}`);
    } finally {
      running = false;
    }
  };
  await step();
  const timer = setInterval(step, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

const isoOf = (d) => (d instanceof Date ? d.toISOString() : null);
export function scheduleOut(s, now = new Date()) {
  const paused = Boolean(s.paused) && !(s.pausedUntil instanceof Date && s.pausedUntil <= now);
  return {
    enabled: s.enabled !== false, paused, pausedUntil: paused ? isoOf(s.pausedUntil) : null, pauseNote: paused ? (s.pauseNote || '') : '',
    dailyAt: s.dailyAt, fullRefreshDay: s.fullRefreshDay ?? null, concurrency: s.concurrency,
    lastRunAt: isoOf(s.lastRunAt), lastRunJobId: s.lastRunJobId ?? null, lastRunStatus: s.lastRunStatus ?? null,
    nextRunAt: s.enabled !== false ? isoOf(s.nextRunAt) : null,
  };
}
