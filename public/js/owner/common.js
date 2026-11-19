// Shared by the pages of "Krushn's dashboard" (SPEC addendum G): the lock state, the /api/owner fetch wrapper,
// band / flag / feature vocabulary and the small pieces of markup every section draws. No data lives here.

import { api } from '../lib/api.js';
import { refresh } from '../lib/router.js';
import { h, fmt, toast } from '../lib/ui.js';
import { handleAuthError, errorText } from '../admin/common.js';

export const BANDS = ['strong', 'possible', 'early', 'none'];
export const BAND_LABELS = { strong: 'Strong', possible: 'Possible', early: 'Early', none: 'No signal' };
export const FLAGS = ['shortlist', 'watch', 'not_applying'];
export const FLAG_LABELS = { shortlist: 'Shortlist', watch: 'Watch', not_applying: 'Not applying' };
export const FEATURE_LABELS = {
  depth: 'Merged work in one organisation',
  substance: 'How substantial the merged work is',
  sustained: 'Sustained over weeks',
  recency: 'Recent activity',
  engagement: 'Engagement with maintainers',
  breadth: 'Other program organisations',
  trackRecord: 'Track record in major projects',
};
export const MATCH_LABELS = {
  orgs: 'Pull requests in the organisations and repositories listed below',
  major: 'Any major-tier open-source project',
  open_source: 'Any open-source pull request',
};

/* ───────────── lock state ───────────── */

/** unlocked: this page instance asked for the password and got in. why: text shown on the next password prompt. */
export const gate = { unlocked: false, expiresAt: null, why: null };

/** Thrown after a request found the page locked; the password prompt is already on its way, so callers stay quiet. */
export class Locked extends Error {
  constructor() { super('locked'); this.name = 'Locked'; }
}

const lockListeners = new Set();
/** Run `fn` whenever the page locks (to close what sits outside the router's element). Returns an unsubscribe. */
export function onLock(fn) {
  lockListeners.add(fn);
  return () => lockListeners.delete(fn);
}

/** Forget the unlock in this tab and close everything that shows data. Does not talk to the server. */
export function markLocked(why = null) {
  gate.unlocked = false;
  gate.expiresAt = null;
  gate.why = why;
  for (const fn of [...lockListeners]) { try { fn(); } catch (err) { console.error(err); } }
}

/** Clear the server-side unlock. `keepalive` lets it finish while the tab is closing. Never throws. */
export async function serverLock({ keepalive = false } = {}) {
  try {
    await fetch('/api/owner/lock', {
      method: 'POST', credentials: 'same-origin', keepalive,
      headers: { 'X-Requested-With': 'oss-admin', 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}',
    });
  } catch { /* offline: the cookie still expires on its own */ }
}

/**
 * A 401 does not say whose session ended (the fetch wrapper drops `error.reason`), so ask GET /owner/me:
 * no admin session → the admin sign-in form; otherwise the page is locked again → the password prompt.
 */
async function denied(err) {
  let me = null;
  try { me = await api.get('/owner/me'); } catch { /* unreachable: treat as locked */ }
  if (me && me.admin === false) {
    markLocked(null);
    handleAuthError(err);
  } else {
    markLocked(err.status === 503 ? null : 'expired');
    setTimeout(() => refresh(), 0);
  }
  throw new Locked();
}

const guard = (p) => p.catch((err) => {
  if (err && (err.status === 401 || (err.status === 503 && err.code === 'unavailable'))) return denied(err);
  throw err;
});

/** The owner API: oapi.get('/summary', { campus }) → GET /api/owner/summary. A locked page throws `Locked`. */
export const oapi = {
  get: (path, params) => guard(api.get(`/owner${path}`, params)),
  post: (path, body) => guard(api.post(`/owner${path}`, body)),
  put: (path, body) => guard(api.put(`/owner${path}`, body)),
  del: (path, params) => guard(api.del(`/owner${path}`, params)),
  url: (path, params) => api.url(`/owner${path}`, params),
};

/** Run a mutation: disables `button`, stays quiet when the page locked, otherwise a failure is a toast (or onError). */
export async function act(fn, { button = null, onError = null } = {}) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Locked) return undefined;
    if (onError && onError(err) === true) return undefined;
    console.error(err);
    toast(errorText(err), 'error');
    return undefined;
  } finally {
    if (button && button.isConnected) button.disabled = false;
  }
}

/* ───────────── small markup ───────────── */

export const plural = (n, one, many = `${one}s`) => `${fmt.num(n)} ${Number(n) === 1 ? one : many}`;
export const rate = (v) => (v === null || v === undefined ? '–' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
export const pts = (v) => (Math.round(Number(v) * 10) / 10).toLocaleString('en-IN', { maximumFractionDigits: 1 });

/** Band as swatch + word: bandBadge('strong'). */
export function bandBadge(band, text = null) {
  const b = BANDS.includes(band) ? band : 'none';
  return h('span', { class: `band band-${b}` }, h('i', { 'aria-hidden': 'true' }), text || BAND_LABELS[b]);
}

/**
 * One readiness score as a shaded cell. `p` is a ProgramScoreBrief (or null). A student with no PR in the program
 * shows a dash rather than the few points the general track record alone gives.
 */
export function scoreCell(p, { name = '', label = null } = {}) {
  const lab = label ? h('span', { class: 'rc-label', 'aria-hidden': 'true' }, label) : null;
  if (!p || (p.band === 'none' && !p.prs)) {
    return h('span', { class: 'rc-wrap', title: name ? `${name}: no pull request counted for this program` : null }, lab,
      h('span', { class: 'rc-empty' }, '–', h('span', { class: 'sr-only' }, ' no signal')));
  }
  const tip = [
    `${name ? `${name}: ` : ''}readiness score ${p.score}, ${BAND_LABELS[p.band] || p.band}`,
    p.bestOrg ? `best organisation ${p.bestOrg} (${plural(p.mergedInBestOrg || 0, 'merged PR')})` : null,
    p.delta ? `${p.delta > 0 ? '+' : '−'}${Math.abs(p.delta)} in the trend period` : null,
  ].filter(Boolean).join(' · ');
  return h('span', { class: 'rc-wrap', title: tip }, lab,
    h('span', { class: `rc band-${p.band}` }, p.score, h('span', { class: 'sr-only' }, ` ${BAND_LABELS[p.band] || ''}`)));
}

/** "+7" / "−3" / "0" with colour and an accessible sentence. */
export function deltaNum(d, { unit = '' } = {}) {
  const n = Number(d) || 0;
  if (!n) return h('span', { class: 'delta-num', title: 'No change' }, '0');
  return h('span', { class: `delta-num ${n > 0 ? 'up' : 'down'}` }, `${n > 0 ? '+' : '−'}${fmt.num(Math.abs(n))}${unit}`);
}

/** Stacked bar of Strong / Possible / Early counts (No signal is left out: it is nine tenths of every cohort). */
export function bandBar(counts, { max = null } = {}) {
  const c = counts || {};
  const total = (c.strong || 0) + (c.possible || 0) + (c.early || 0);
  const scale = max || total;
  const label = `${c.strong || 0} Strong, ${c.possible || 0} Possible, ${c.early || 0} Early`;
  if (!total) return h('span', { class: 'bandbar', role: 'img', 'aria-label': label, title: label });
  return h('span', { class: 'bandbar', role: 'img', 'aria-label': label, title: label, style: { width: `${Math.max(4, (total / scale) * 100)}%` } },
    ['strong', 'possible', 'early'].map((b) => (c[b] ? h('i', { class: `band-${b}`, style: { flex: `${c[b]} 1 0` } }) : null)));
}

/** The key that explains the shading, with the live thresholds. */
export function bandKey(bands, { title = 'Readiness score' } = {}) {
  const b = bands || {};
  const item = (band, text) => h('li', null, bandBadge(band), h('span', null, text));
  return h('ul', { class: 'band-key' },
    h('li', { class: 'band-key-title' }, `${title}, 0 to 100:`),
    item('strong', `${b.strong ?? 60} and above`),
    item('possible', `${b.possible ?? 35} to ${(b.strong ?? 60) - 1}`),
    item('early', `${b.early ?? 10} to ${(b.possible ?? 35) - 1}`),
    item('none', 'below that, or nothing merged yet'));
}

export function flagBadge(flag) {
  if (!flag || !FLAG_LABELS[flag]) return null;
  return h('span', { class: `flag flag-${flag}` }, FLAG_LABELS[flag]);
}

/** Calibration → sentences per band. Only called when outcomes exist (labelMode "calibrated"). */
export function calibrationBlock(cal) {
  if (!cal || !cal.byBand) return null;
  return h('dl', { class: 'calib' }, BANDS.map((b) => {
    const x = cal.byBand[b] || { applicants: 0, selected: 0, rate: null };
    return h('div', { class: `band-${b}` },
      h('dt', null, BAND_LABELS[b]),
      h('dd', null, x.applicants
        ? [h('b', null, `${x.selected} of ${x.applicants}`), ' past applicants selected',
          x.smallSample ? [' ', h('span', { class: 'small-cohort', title: 'Fewer than 10 past applicants in this band: too few to read as a rate' }, 'small sample')] : ` (${Math.round((x.rate || 0) * 100)}%)`]
        : h('span', { class: 'muted' }, 'no past applicants')));
  }));
}

export const profileUrl = (username) => `/#/students/${encodeURIComponent(username)}`;
