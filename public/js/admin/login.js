// Sign-in form. Rendered by main.js straight into #app while GET /admin/me says admin:false.

import { api } from '../lib/api.js';
import { h } from '../lib/ui.js';
import { field } from './common.js';

/**
 * renderLogin(app, me, { expired, onDone })
 *   me: { admin, configured, unreachable? } · expired: the previous session ended · onDone: called after a good sign-in.
 */
export default function renderLogin(app, me, { expired = false, onDone } = {}) {
  const box = h('section', { class: 'card' }, h('h1', null, 'Admin sign in'));
  const wrap = h('div', { class: 'login' }, box);

  if (me.unreachable) {
    box.append(
      h('div', { class: 'notice notice-warn', role: 'alert' }, 'The server did not answer. Check your connection, then try again.'),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn btn-primary', name: 'retry', onClick: () => onDone && onDone() }, 'Try again')));
    app.replaceChildren(wrap);
    return;
  }
  if (me.configured === false) {
    box.append(h('div', { class: 'notice notice-warn', role: 'alert' },
      'Admin access is not set up on this server. Set ADMIN_PASSWORD and restart.'));
    app.replaceChildren(wrap);
    return;
  }

  const pw = field({
    label: 'Password', name: 'password', type: 'password', required: true,
    attrs: { autocomplete: 'current-password', autocapitalize: 'off' },
  });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary', name: 'sign-in' }, 'Sign in');
  const form = h('form', { class: 'form', novalidate: true },
    expired ? h('div', { class: 'notice notice-warn', role: 'status' }, 'Your session ended. Sign in again to carry on where you were.') : null,
    h('p', { class: 'muted' }, 'For NST staff who maintain the student list and decide what counts as open source.'),
    pw.row,
    h('div', { class: 'form-actions' }, submit));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = pw.input.value;
    if (!password) { pw.setError('Enter the admin password.'); pw.input.focus(); return; }
    pw.setError(null);
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      await api.post('/admin/login', { password });
      if (onDone) onDone();
      return;
    } catch (err) {
      if (err.status === 401) pw.setError('That password is not right.');
      else if (err.status === 429) pw.setError('Too many attempts. Try again in 15 minutes.');
      else if (err.status === 503) pw.setError('Admin access is not set up on this server. Set ADMIN_PASSWORD and restart.');
      else pw.setError(err.message || 'Could not sign in. Try again.');
      pw.input.select();
      pw.input.focus();
    }
    submit.disabled = false;
    submit.textContent = 'Sign in';
  });

  box.append(form);
  app.replaceChildren(wrap);
  pw.input.focus();
}
