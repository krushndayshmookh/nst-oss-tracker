// Shared by the admin pages: session handling, mutation wrapper, form fields, the public "headline" probe,
// and the note dialog used by every include / exclude decision. Markup comes from ../lib/ui.js only.

import { api } from '../lib/api.js';
import { refresh } from '../lib/router.js';
import { h, toast, modal, fmt } from '../lib/ui.js';

export const CAMPUSES = ['ADYPU', 'RU', 'SVYASA', 'SMRU', 'Unknown'];
export const YEARS = ['1st year', '2nd year', '3rd year', '4th year', 'alumni', 'Unknown'];

/* ───────────── session ───────────── */

const session = { expired: false };

/** True once, after a request came back 401 while the admin thought they were signed in. */
export function takeExpired() {
  const was = session.expired;
  session.expired = false;
  return was;
}

/** Close every open dialog (they sit on <body>, outside the router's page element). */
export function closeDialogs() {
  for (const d of document.querySelectorAll('dialog.dialog')) {
    try { if (d.open) d.close(); } catch { /* already closed */ }
    d.remove();
  }
}

/**
 * If `err` says the session is gone (401) return to the sign-in form and report true.
 * 503 `unavailable` on an admin route means ADMIN_PASSWORD was removed: the gate shows that notice too.
 */
export function handleAuthError(err) {
  if (!err || (err.status !== 401 && !(err.status === 503 && err.code === 'unavailable'))) return false;
  session.expired = err.status === 401;
  closeDialogs();
  setTimeout(() => refresh(), 0); // the gate in main.js asks /me again and renders the sign-in form
  return true;
}

/**
 * Run a mutation. Disables `button` while it runs; a 401 goes back to sign-in; any other failure is a toast
 * (or `onError(err)` when given and it returns true). Resolves to the result, or undefined when it failed.
 */
export async function act(fn, { button = null, onError = null } = {}) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (err) {
    if (handleAuthError(err)) return undefined;
    if (onError && onError(err) === true) return undefined;
    console.error(err);
    toast(errorText(err), 'error');
    return undefined;
  } finally {
    if (button && button.isConnected) button.disabled = false;
  }
}

/** A sentence for an ApiError: the server's own message, capitalised, with a full stop. */
export function errorText(err) {
  let m = String((err && err.message) || err || 'Something went wrong').trim();
  if (err && err.status === 429) m = 'Too many requests. Wait a little and try again';
  m = m.charAt(0).toUpperCase() + m.slice(1);
  return /[.!?]$/.test(m) ? m : `${m}.`;
}

/* ───────────── meta + public numbers ───────────── */

let metaPromise = null;
/** GET /api/meta (filter vocabularies), cached for the session; a failure is not cached and resolves to {}. */
export function getMeta() {
  if (!metaPromise) {
    const p = api.get('/meta', { _: Date.now() }).catch(() => { if (metaPromise === p) metaPromise = null; return {}; });
    metaPromise = p;
  }
  return metaPromise;
}

/**
 * The two public headline numbers, all time: { osMerged, students }. Used to show what a decision changed.
 * The public API is cacheable for 60 s, so every call carries a throwaway parameter. null when it cannot be read.
 */
export async function headline() {
  try {
    const o = await api.get('/overview', { range: 'all', _: Date.now() });
    return { osMerged: o.prs.osMerged, osPrs: o.prs.osPrs, students: o.students.withOsMerged };
  } catch {
    return null;
  }
}

/** " Public totals: 5,123 → 5,086 merged open-source pull requests, 612 → 610 students." ('' when unknown or unchanged). */
export function headlineDelta(before, after) {
  if (!before || !after) return '';
  if (before.osMerged === after.osMerged && before.students === after.students && before.osPrs === after.osPrs) {
    return ' The public totals did not change.';
  }
  const part = (a, b, label) => (a === b ? `${fmt.num(b)} ${label} (unchanged)` : `${fmt.num(a)} → ${fmt.num(b)} ${label}`);
  return ` Public totals: ${part(before.osMerged, after.osMerged, 'merged open-source pull requests')}, ${part(before.students, after.students, 'students with one')}.`;
}

export const plural = (n, one, many = `${one}s`) => `${fmt.num(n)} ${Number(n) === 1 ? one : many}`;

/* ───────────── forms ───────────── */

let uid = 0;

/**
 * One labelled control: field({ label, name, type?, value?, options?, hint?, required?, placeholder?, rows?, attrs? })
 * → { row, input, get(), setError(text | null) }. type: text (default) | email | number | password | select | textarea | checkbox.
 */
export function field({ label, name, type = 'text', value = '', options = null, hint = null, required = false, placeholder = null, rows = null, attrs = {} }) {
  const id = `af-${name}-${++uid}`;
  const hintId = hint ? `${id}-hint` : null;
  const errId = `${id}-err`;
  let input;
  if (type === 'select') {
    input = h('select', { id, name, required, ...attrs },
      (options || []).map((o) => {
        const opt = typeof o === 'object' && o !== null ? o : { value: String(o), label: String(o) };
        return h('option', { value: opt.value, selected: String(opt.value) === String(value ?? '') }, opt.label);
      }));
  } else if (type === 'textarea') {
    input = h('textarea', { id, name, rows: rows || 4, placeholder, spellcheck: 'false', ...attrs });
    input.value = value ?? '';
  } else if (type === 'checkbox') {
    input = h('input', { type: 'checkbox', id, name, checked: Boolean(value), ...attrs });
  } else {
    input = h('input', { type, id, name, value: value ?? '', placeholder, required, autocomplete: 'off', spellcheck: 'false', ...attrs });
  }
  if (hintId) input.setAttribute('aria-describedby', hintId);
  const error = h('div', { class: 'field-error', id: errId, role: 'alert', hidden: true });
  const row = type === 'checkbox'
    ? h('div', { class: 'form-row' }, h('div', { class: 'form-row-inline' }, input, h('label', { for: id }, label)),
      hint ? h('div', { class: 'hint', id: hintId }, hint) : null, error)
    : h('div', { class: 'form-row' }, h('label', { for: id }, label), input,
      hint ? h('div', { class: 'hint', id: hintId }, hint) : null, error);
  return {
    row,
    input,
    get: () => (type === 'checkbox' ? input.checked : input.value.trim()),
    setError(text, extra = null) {
      error.replaceChildren();
      if (!text) { error.hidden = true; input.removeAttribute('aria-invalid'); return; }
      error.append(text, extra ? ' ' : '', extra || '');
      error.hidden = false;
      input.setAttribute('aria-invalid', 'true');
    },
  };
}

/** Batch (intake year) options: "Not set", then next year down to six years back, plus `current` if it is outside that. */
export function batchOptions(current = null) {
  const y = new Date().getFullYear();
  const years = [];
  for (let n = y + 1; n >= y - 6; n--) years.push(n);
  if (current !== null && current !== '' && !years.includes(Number(current))) years.push(Number(current));
  years.sort((a, b) => b - a);
  return [{ value: '', label: 'Not set' }, ...years.map((n) => ({ value: String(n), label: String(n) }))];
}

/**
 * Dialog that states what a decision will do and takes an optional note.
 * decide({ title, message, confirmLabel, danger?, note? }) → Promise<false | string> (the note, possibly '').
 */
export function decide({ title, message, confirmLabel, danger = false, note = '', noteLabel = 'Note (optional)' }) {
  return new Promise((resolve) => {
    let result = false;
    const f = field({ label: noteLabel, name: 'note', value: note || '', placeholder: 'Why? Shown in the overrides list', attrs: { maxlength: 500 } });
    const m = modal({
      title,
      body: h('div', { class: 'stack' }, typeof message === 'string' ? h('p', null, message) : message, f.row),
      actions: [
        { label: 'Cancel' },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: (close) => { result = f.get(); close(); } },
      ],
      onClose: () => resolve(result),
    });
    f.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); result = f.get(); m.close(); } });
    f.input.focus();
  });
}

/** Link to the Jobs page for one job. */
export const jobLink = (id, text = 'See the job') => h('a', { href: `#/jobs?job=${encodeURIComponent(id)}` }, text);

/** Call `fn` every `ms` until the returned stop() runs. Skips a tick while the tab is hidden or a call is in flight. */
export function poll(fn, ms = 5000) {
  let busy = false;
  let stopped = false;
  const timer = setInterval(async () => {
    if (busy || stopped || document.hidden) return;
    busy = true;
    try { await fn(); } catch (err) { if (!handleAuthError(err)) console.error(err); } finally { busy = false; }
  }, ms);
  return () => { stopped = true; clearInterval(timer); };
}
