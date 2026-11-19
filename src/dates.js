// Time-zone aware date helpers, the academic-year setting and date-range resolution (SPEC addendum A).
// Every bucket and every range boundary of the app is computed in config.tzName (Asia/Kolkata by default).
import { collections } from './db.js';
import { config } from './config.js';

export const TZ = config.tzName;
const DAY_MS = 24 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, '0');

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in `tz`: { year, month (1-12), day, hour, minute, second, ymd, dow (Mon=1 … Sun=7) }. */
export function zoned(date = new Date(), tz = TZ) {
  const p = {};
  for (const part of formatter(tz).formatToParts(date)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() || 7;
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second, dow,
    ymd: `${p.year}-${pad(p.month)}-${pad(p.day)}` };
}

function offsetMs(date, tz) {
  const z = zoned(date, tz);
  return Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second) - Math.floor(date.getTime() / 1000) * 1000;
}

export function isYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** The instant at which the wall clock in `tz` shows `ymd` hh:mm. */
export function zonedTime(ymd, hour = 0, minute = 0, tz = TZ) {
  const [y, m, d] = ymd.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  const guess = wall - offsetMs(new Date(wall), tz);
  return new Date(wall - offsetMs(new Date(guess), tz));
}
export const dayStart = (ymd, tz = TZ) => zonedTime(ymd, 0, 0, tz);

export function addDays(ymd, n) {
  return new Date(new Date(`${ymd}T00:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);
}
export function addMonths(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return `${first.getUTCFullYear()}-${pad(first.getUTCMonth() + 1)}-${pad(Math.min(d, last))}`;
}
export const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / DAY_MS);

// ---------- academic year ----------

/** The academic year (1 July – 30 June) that contains `now` in `tz`. */
export function defaultAcademicYear(now = new Date(), tz = TZ) {
  const z = zoned(now, tz);
  const y = z.month >= 7 ? z.year : z.year - 1;
  return { label: `${y}-${pad((y + 1) % 100)}`, start: `${y}-07-01`, end: `${y + 1}-06-30` };
}

const ayOut = (a) => ({ label: String(a.label), start: String(a.start), end: String(a.end) });
const validAy = (a) => a && typeof a.label === 'string' && isYmd(a.start) && isYmd(a.end) && a.start < a.end;

/**
 * { current, history } as it applies at `now`: when the stored year is over and nobody edited it, the next 1 July – 30 June
 * year takes over (and the old one moves to the history), so the default range moves on by itself.
 */
export function effectiveAcademicYear(doc, now = new Date(), tz = TZ) {
  let current = validAy(doc?.current) ? ayOut(doc.current) : null;
  const history = (Array.isArray(doc?.history) ? doc.history : []).filter(validAy).map(ayOut);
  const today = zoned(now, tz).ymd;
  if (!current || current.end < today) {
    if (current) history.unshift(current);
    current = defaultAcademicYear(now, tz);
  }
  const seen = new Set([current.label]);
  const past = [];
  for (const a of history) if (!seen.has(a.label)) { seen.add(a.label); past.push(a); }
  past.sort((a, b) => (a.start < b.start ? 1 : -1));
  return { current, history: past.slice(0, 10) };
}

export async function loadAcademicYear(db, now = new Date(), tz = TZ) {
  const doc = await collections(db).settings.findOne({ _id: 'academicYear' });
  return effectiveAcademicYear(doc, now, tz);
}

/** Seeds the settings doc on first boot and persists an automatic roll-over. */
export async function ensureAcademicYear(db, now = new Date(), tz = TZ) {
  const { settings } = collections(db);
  const doc = await settings.findOne({ _id: 'academicYear' });
  const eff = effectiveAcademicYear(doc, now, tz);
  if (!doc) {
    // the year before the first one is offered as a preset from day one
    const prev = defaultAcademicYear(new Date(dayStart(eff.current.start, tz).getTime() - DAY_MS), tz);
    eff.history = [prev];
  }
  if (!doc || JSON.stringify([doc.current, doc.history]) !== JSON.stringify([eff.current, eff.history])) {
    await settings.updateOne({ _id: 'academicYear' }, { $set: { current: eff.current, history: eff.history, updatedAt: now } }, { upsert: true });
  }
  return eff;
}

/** Validates { label, start, end }: -> { value } | { error }. */
export function validateAcademicYear(body) {
  const label = typeof body?.label === 'string' ? body.label.trim() : '';
  if (!label || label.length > 20) return { error: 'label is required (for example 2026-27, at most 20 characters)' };
  if (!isYmd(body.start) || !isYmd(body.end)) return { error: 'start and end must be dates (YYYY-MM-DD)' };
  if (body.start >= body.end) return { error: 'start must be before end' };
  if (daysBetween(body.start, body.end) + 1 > 400) return { error: 'an academic year is at most 400 days long' };
  return { value: { label, start: body.start, end: body.end } };
}

/** Validates the optional `history` of PUT /api/admin/academic-year (earlier years offered as presets): -> { value } | { error }. */
export function validateAcademicYearHistory(list, current) {
  if (!Array.isArray(list)) return { error: 'history must be a list of { label, start, end }' };
  if (list.length > 10) return { error: 'history holds at most 10 academic years' };
  const out = [];
  const labels = new Set([current.label]);
  for (const item of list) {
    const { value, error } = validateAcademicYear(item);
    if (error) return { error: `history: ${error}` };
    if (labels.has(value.label)) return { error: `history: the label ${value.label} is used twice` };
    labels.add(value.label);
    out.push(value);
  }
  return { value: out };
}

/**
 * Sets the current academic year.
 * The previous one moves to the history only when the new year comes AFTER it (starts after it ends): that is a new
 * year. Anything else (a fixed label, a moved start or end date, trying a year and going back) is a correction of the
 * current year and replaces it, so a typo never becomes a permanent public preset. `history` (already validated)
 * replaces the stored history outright, which is how an admin removes an entry.
 */
export async function saveAcademicYear(db, value, now = new Date(), tz = TZ, { history = undefined } = {}) {
  const { settings } = collections(db);
  const before = await loadAcademicYear(db, now, tz);
  let past = history;
  if (!past) {
    const isNewYear = value.start > before.current.end;
    past = isNewYear ? [before.current, ...before.history] : before.history;
  }
  // the current year is not also a preset of the past: neither under its label nor under its exact dates
  past = past.filter((a) => a.label !== value.label && !(a.start === value.start && a.end === value.end));
  await settings.updateOne({ _id: 'academicYear' }, { $set: { current: value, history: past.slice(0, 10), updatedAt: now } }, { upsert: true });
  return loadAcademicYear(db, now, tz);
}

// ---------- ranges ----------

/** Preset list for GET /api/meta: current AY, earlier AYs, rolling windows, all time. */
export function presets(ay, now = new Date(), tz = TZ) {
  const today = zoned(now, tz).ymd;
  return [
    { key: 'ay', label: `AY ${ay.current.label}`, from: ay.current.start, to: ay.current.end },
    ...ay.history.map((a) => ({ key: `ay-${a.label}`, label: `AY ${a.label}`, from: a.start, to: a.end })),
    { key: '30d', label: 'Last 30 days', from: addDays(today, -29), to: today },
    { key: '90d', label: 'Last 90 days', from: addDays(today, -89), to: today },
    { key: '12m', label: 'Last 12 months', from: addDays(addMonths(today, -12), 1), to: today },
    { key: 'all', label: 'All time', from: null, to: null },
  ];
}

export class RangeError400 extends Error {}

/**
 * Resolves `from` / `to` / `range` of a query (strings, '' when absent) to one range.
 * Nothing given -> the current academic year. `range=all` -> all time.
 * -> { from, to, label, preset, start: Date|null (inclusive), end: Date|null (exclusive), all: boolean }
 * `from` is 00:00 of that day in `tz`; `to` is inclusive, so `end` is 00:00 of the day after.
 */
export function resolveRange({ from = '', to = '', range = '' } = {}, ay, now = new Date(), tz = TZ) {
  const list = presets(ay, now, tz);
  let preset = null;
  if (from || to) {
    if (from && !isYmd(from)) throw new RangeError400('invalid from: expected a date (YYYY-MM-DD)');
    if (to && !isYmd(to)) throw new RangeError400('invalid to: expected a date (YYYY-MM-DD)');
    if (from && to && from > to) throw new RangeError400('invalid range: from is after to');
    for (const [name, v] of [['from', from], ['to', to]]) {
      if (v && (v < '1970-01-01' || v > '2199-12-31')) throw new RangeError400(`invalid ${name}: expected a date between 1970-01-01 and 2199-12-31`);
    }
    preset = list.find((p) => p.from === from && p.to === to) || null;
  } else {
    preset = list.find((p) => p.key === (range || 'ay'));
    if (!preset) throw new RangeError400(`invalid range: expected one of ${list.map((p) => p.key).join(', ')}`);
    from = preset.from || '';
    to = preset.to || '';
  }
  return {
    from: from || null, to: to || null,
    label: preset ? preset.label : 'Custom range', preset: preset ? preset.key : null,
    start: from ? dayStart(from, tz) : null, end: to ? dayStart(addDays(to, 1), tz) : null,
    all: !from && !to,
  };
}

export const rangeOut = (r) => ({ from: r.from, to: r.to, label: r.label, preset: r.preset });

/** Mongo condition for a date field inside the range, or null when the range is unbounded. */
export function inRange(range) {
  if (!range.start && !range.end) return null;
  return { ...(range.start && { $gte: range.start }), ...(range.end && { $lt: range.end }) };
}
