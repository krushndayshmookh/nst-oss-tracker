// The scheduled fetch, managed from the admin UI (SPEC addendum C). Runs inside the app (replicas: 1): every tick
// looks at the `schedule` settings doc and enqueues a `sync` job when one is due. All state is in Mongo, so a restart
// loses nothing: a run missed while the app was down is caught up once, a run cut off by a restart is started again once.
import { collections } from './db.js';
import { TZ, addDays, daysBetween, isYmd, zoned, zonedTime } from './dates.js';
import { activeSync, enqueue, syncLock } from './jobs.js';

export const TICK_MS = 30000;
const HOUR_MS = 60 * 60 * 1000;

export function defaultSchedule(concurrency = 6) {
  return { enabled: true, paused: false, pausedUntil: null, pauseNote: '', dailyAt: '02:30', fullRefreshDay: null, concurrency,
    lastRunAt: null, lastRunJobId: null, lastRunStatus: null, lastFullRefreshYmd: null, nextRunAt: null };
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

/** After a catch-up (or a recovery of a whole run) the next daily slot is skipped when it is closer than this. */
export const MIN_GAP_MS = 6 * HOUR_MS;

/**
 * The day (YYYY-MM-DD in `tz`) of the first daily slot in [from, before) that falls on the weekly full-refresh day, or
 * null. `from` is a slot itself (the stored nextRunAt). The weekday is that of the SLOT, not of the moment it fires:
 * Sunday's run that starts on Monday because a sync was in the way is still Sunday's.
 */
function fullRefreshSlot(s, from, before, tz) {
  if (s.fullRefreshDay === null || s.fullRefreshDay === undefined || !(from instanceof Date)) return null;
  const [h, m] = String(s.dailyAt || '02:30').split(':').map(Number);
  let ymd = zoned(from, tz).ymd;
  for (let i = 0; i < 8; i++, ymd = addDays(ymd, 1)) {
    const t = i === 0 ? from : zonedTime(ymd, h, m, tz);
    if (t >= before) break;
    if (zoned(t, tz).dow % 7 !== s.fullRefreshDay) continue;
    // at most one scheduled full refresh a week, also when the weekday or the time was edited in between
    if (isYmd(s.lastFullRefreshYmd) && daysBetween(s.lastFullRefreshYmd, ymd) < 6) return null;
    return ymd;
  }
  return null;
}

/**
 * One scheduler step. -> { fired: job id | null, why }
 * Fires when the schedule is enabled, not paused, `now >= nextRunAt` and no sync is queued or running; `nextRunAt` then
 * moves to the next daily slot, so a long downtime is caught up with exactly one run. A run that fires late (catch-up)
 * also stands in for a daily slot less than MIN_GAP_MS ahead: two complete passes minutes apart help nobody.
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
    const set = { ...claim.set, lastRunAt: now };
    const claimed = await settings.updateOne({ _id: 'schedule', ...claim.filter }, { $set: set });
    if (!claimed.modifiedCount) return { fired: null, why: 'already claimed' };
    const params = { trigger, full: false, concurrency: s.concurrency, ...extra };
    let job;
    try {
      job = await enqueueJob(db, 'sync', params);
    } catch (e) {
      // nothing was queued: give the slot back, or this run would be lost without a retry (nextRunAt is in the future now)
      const undo = Object.fromEntries(Object.keys(set).map((k) => [k, s[k] ?? null]));
      await settings.updateOne({ _id: 'schedule', lastRunAt: now }, { $set: undo }).catch(() => {});
      throw e;
    }
    await settings.updateOne({ _id: 'schedule' }, { $set: { lastRunJobId: job._id, lastRunStatus: job.status || 'queued' } });
    return { fired: job._id, why: trigger, job };
  };
  const out = ({ fired, why }) => ({ fired, why });

  // "is a sync active?" and the enqueue are one step, under the lock the admin's "Fetch now" takes too
  return syncLock(db, async () => {
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
    /** Runs start() for a claimed cut-off job and records who recovered it (or releases the claim when nothing started). */
    const startFor = async (claimedCut, ...args) => {
      let r = null;
      try {
        r = await start(...args);
        return r;
      } finally {
        if (claimedCut) await jobs.updateOne({ _id: cut._id }, r?.fired ? { $set: { recoveredBy: r.fired } } : { $unset: { recoveredBy: '' } }).catch(() => {});
      }
    };
    const afterGap = () => nextRunAfter(new Date(now.getTime() + MIN_GAP_MS), s.dailyAt, tz);
    const due = s.nextRunAt instanceof Date && now >= s.nextRunAt;
    if (cut && !due) {
      if (!(await claimCut())) return { fired: null, why: 'already claimed' };
      // same selection as the run that was cut off; students it had already finished are not fetched again
      const extra = { recovers: cut._id };
      for (const k of ['full', 'users', 'campus', 'batch', 'limit']) if (cut.params?.[k] !== undefined) extra[k] = cut.params[k];
      if (cut.startedAt instanceof Date) extra.resumeSince = cut.startedAt;
      const set = { recoveredJobId: cut._id };
      // a recovery of a run over every student also stands in for a daily slot that is only a few hours away
      // (unless that slot is the weekly full refresh, which the recovery is not)
      const everyone = !extra.users && !extra.campus && extra.batch === undefined && extra.limit === undefined;
      if (everyone && s.nextRunAt instanceof Date && s.nextRunAt.getTime() - now.getTime() < MIN_GAP_MS) {
        const next = afterGap();
        if (!fullRefreshSlot(s, s.nextRunAt, next, tz)) set.nextRunAt = next;
      }
      return out(await startFor(true, 'recovery', { filter: {}, set }, extra));
    }
    if (!(s.nextRunAt instanceof Date)) {
      await settings.updateOne({ _id: 'schedule' }, { $set: { nextRunAt: nextRunAfter(now, s.dailyAt, tz) } });
      return { fired: null, why: 'scheduled' };
    }
    if (!due) return { fired: null, why: 'not due' };
    if (busy) return { fired: null, why: 'a sync is already queued or running' };
    const late = now.getTime() - s.nextRunAt.getTime() > HOUR_MS;
    const next = late ? afterGap() : nextRunAfter(now, s.dailyAt, tz);
    const set = { nextRunAt: next };
    const extra = {};
    // the weekly full refresh belongs to a slot: this run is one when a slot it stands for falls on that weekday
    const fullYmd = fullRefreshSlot(s, s.nextRunAt, next, tz);
    if (fullYmd) { extra.full = true; set.lastFullRefreshYmd = fullYmd; }
    // a nightly run that is due anyway also stands in for a run that was cut off (it covers every student)
    const claimedCut = Boolean(cut) && (await claimCut());
    if (claimedCut) {
      extra.recovers = cut._id;
      if (cut.params?.full === true && !cut.params.users && !cut.params.campus && cut.params.batch === undefined) extra.full = true;
    }
    return out(await startFor(claimedCut, late ? 'catchup' : 'schedule', { filter: { nextRunAt: s.nextRunAt }, set }, extra));
  });
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
