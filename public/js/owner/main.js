// "Krushn's dashboard" (SPEC addendum G): entry point, loaded by the admin app only when #/owner is opened.
//
// The second password is asked EVERY time the page is opened: this module keeps "unlocked" in memory only, clears
// the server-side unlock when it starts, when the admin leaves #/owner for another admin page, and when the tab
// closes, and goes back to the prompt whenever the API answers 401 (the unlock lasts 2 hours at most).
// Nothing here holds data: every figure comes from /api/owner/* after the unlock.
//
//   #/owner                     Summary          ?campus=&year=&p=<program>
//   #/owner/students            Students         ?campus=&year=&program=&band=&org=&flag=&realChance=&q=&sort=&order=&page=
//   #/owner/orgs                Organisations    ?program=&campus=&q=&minStudents=&sort=&order=&open=<login>
//   #/owner/settings            Settings         ?s=programs|orgs|outcomes
//   any of them + ?student=<username>   opens the student panel over the page

import { api } from '../lib/api.js';
import { refresh, href, setQuery, parseHash } from '../lib/router.js';
import { h, tabs, fmt, toast } from '../lib/ui.js';
import { handleAuthError, field, errorText } from '../admin/common.js';
import { gate, Locked, oapi, markLocked, serverLock, onLock } from './common.js';
import { syncStudentPanel, closeStudentPanel } from './drawer.js';

const TITLE = "Krushn's dashboard";
const SECTIONS = [
  { key: 'summary', path: '/owner', label: 'Summary', load: () => import('./summary.js') },
  { key: 'students', path: '/owner/students', label: 'Students', load: () => import('./students.js') },
  { key: 'orgs', path: '/owner/orgs', label: 'Organisations', load: () => import('./orgs.js') },
  { key: 'settings', path: '/owner/settings', label: 'Settings', load: () => import('./settings.js') },
];

/* ───────────── one-time wiring ───────────── */

let cssReady = null;
function ensureCss() {
  if (!cssReady) {
    cssReady = new Promise((resolve) => {
      const link = h('link', { rel: 'stylesheet', href: '/css/owner.css' });
      link.addEventListener('load', resolve);
      link.addEventListener('error', resolve); // unstyled is better than a blank page
      document.head.append(link);
      setTimeout(resolve, 3000);
    });
  }
  return cssReady;
}

const inOwner = () => /^\/owner(\/|$)/.test(parseHash().path);

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  // leaving for another admin page locks at once; coming back asks for the password again
  window.addEventListener('hashchange', () => {
    if (inOwner()) return;
    closeStudentPanel();
    if (gate.unlocked) { markLocked(null); serverLock(); }
  });
  window.addEventListener('pagehide', () => { if (gate.unlocked) serverLock({ keepalive: true }); });
  onLock(() => closeStudentPanel());
}

let enteredLocked = false; // the server-side unlock of an earlier visit was cleared for this page instance

/* ───────────── password prompt ───────────── */

async function renderUnlock(el) {
  let me;
  try {
    me = await api.get('/owner/me');
  } catch (err) {
    me = { admin: true, configured: true, unreachable: err };
  }
  if (me.admin === false) { handleAuthError({ status: 401 }); return; }
  if (!enteredLocked && !me.unreachable) {
    // a cookie left by an earlier visit (within its 2 hours) must not open the page without the password
    if (me.unlocked) await serverLock();
    enteredLocked = true;
  }

  const box = h('section', { class: 'card' }, h('h1', null, me.title || TITLE));
  const wrap = h('div', { class: 'login owner-unlock' }, box);
  el.append(wrap);

  if (me.unreachable) {
    box.append(
      h('div', { class: 'notice notice-warn', role: 'alert' }, 'The server did not answer. Check your connection, then try again.'),
      h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn btn-primary', name: 'retry', onClick: () => refresh() }, 'Try again')));
    return;
  }
  if (me.configured === false) {
    box.append(h('div', { class: 'notice notice-warn', role: 'alert' },
      'This page is not set up on this server. Set OWNER_PASSWORD (different from the admin password) and restart.'));
    return;
  }

  const why = gate.why;
  gate.why = null;
  const pw = field({
    label: 'Password for this page', name: 'owner-password', type: 'password', required: true,
    attrs: { autocomplete: 'current-password', autocapitalize: 'off' },
  });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary', name: 'unlock' }, 'Unlock');
  const form = h('form', { class: 'form', novalidate: true },
    // a separate "account" for password managers, so this password is never offered on the admin sign-in form
    h('input', { type: 'text', name: 'username', value: 'krushn-dashboard', autocomplete: 'username', hidden: true, 'aria-hidden': 'true', tabindex: '-1' }),
    why === 'expired' ? h('div', { class: 'notice notice-warn', role: 'status' }, 'The page locked itself (it stays open for 2 hours at most). Enter the password to carry on.') : null,
    why === 'manual' ? h('div', { class: 'notice notice-ok', role: 'status' }, 'Locked.') : null,
    h('p', { class: 'muted' }, 'Private page with program-readiness scores. It has its own password, separate from the admin sign-in, and asks for it every time it is opened.'),
    pw.row,
    h('div', { class: 'form-actions' }, submit, h('a', { class: 'btn', href: '#/students' }, 'Back to admin')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = pw.input.value;
    if (!password) { pw.setError('Enter the password for this page.'); pw.input.focus(); return; }
    pw.setError(null);
    submit.disabled = true;
    submit.textContent = 'Unlocking…';
    try {
      const res = await api.post('/owner/unlock', { password });
      gate.unlocked = true;
      gate.expiresAt = res.expiresAt || null;
      gate.why = null;
      refresh();
      return;
    } catch (err) {
      if (err.status === 401) {
        let now = null;
        try { now = await api.get('/owner/me'); } catch { /* keep the generic message */ }
        if (now && now.admin === false) { handleAuthError(err); return; }
        pw.setError('That password is not right.');
      } else if (err.status === 429) pw.setError('Too many attempts. Try again in 15 minutes.');
      else if (err.status === 503) pw.setError('This page is not set up on this server (OWNER_PASSWORD).');
      else pw.setError(errorText(err));
      pw.input.select();
      pw.input.focus();
    }
    submit.disabled = false;
    submit.textContent = 'Unlock';
  });

  box.append(form);
  setTimeout(() => { if (pw.input.isConnected) pw.input.focus(); }, 0);
}

/* ───────────── the unlocked page ───────────── */

async function lockNow(button) {
  if (button) button.disabled = true;
  markLocked('manual');
  await serverLock();
  refresh();
}

function limitsNote(bands) {
  const b = bands || { strong: 60, possible: 35, early: 10 };
  return h('section', { class: 'owner-limits fine', id: 'owner-limits' },
    h('h2', null, 'How this is computed and its limits'),
    h('p', null,
      'Every student gets a readiness score from 0 to 100 for each program. It is built only from their public GitHub pull requests that count for that program: ',
      'merged work concentrated in one organisation (the largest part, because programs select per organisation), how substantial that work is, ',
      'how many weeks it spans, how recent it is, how maintainers engaged with it, and small credit for other program organisations and for merged work in major projects. ',
      `A score of ${b.strong} or more is shown as Strong, ${b.possible} or more as Possible, ${b.early} or more as Early; the weights, thresholds, organisation lists and contribution windows are on the Settings tab. `,
      'It is a heuristic, not a probability of selection: programs also judge the proposal, communication with mentors, eligibility and the number of slots, and none of that is in this data. ',
      'A past selection rate is shown only where real past outcomes have been uploaded, and with few past applicants it is a count, not a forecast. ',
      'Eligibility (age, gender, prior participation, enrolment) is never inferred: confirm it with each student.'));
}

export default async function ownerPage(el, ctx) {
  await ensureCss();
  wire();
  if (!gate.unlocked) {
    closeStudentPanel();
    await renderUnlock(el);
    return undefined;
  }

  const section = SECTIONS.find((s) => s.path === ctx.path) || (ctx.path.startsWith('/owner/') ? null : SECTIONS[0]);
  let stopped = false;
  let timer = null;
  let sectionCleanup = null;
  const shared = { isDirty: null, bands: null };

  try {
    const status = await oapi.get('/status');

    const fresh = h('span', { class: 'owner-fresh', role: 'status' });
    const showFresh = (st) => {
      fresh.replaceChildren(st.job
        ? 'Recomputing scores…'
        : st.computedAt ? `Scores computed ${fmt.rel(st.computedAt)}` : 'Scores not computed yet');
      fresh.title = st.computedAt ? `Computed ${fmt.datetime(st.computedAt)} for ${fmt.num(st.students)} students. They are recomputed after every fetch and every settings change.` : '';
    };
    showFresh(status);
    const lockBtn = h('button', { type: 'button', class: 'btn', name: 'owner-lock', title: 'Close this page now. The password is needed to open it again.', onClick: (e) => lockNow(e.currentTarget) }, 'Lock');

    el.classList.add('owner');
    el.append(
      h('header', { class: 'page-head owner-head' },
        h('div', null,
          h('h1', null, TITLE, h('span', { class: 'owner-private', title: 'Only reachable with the second password. Nothing on this page appears on the public site, in the admin pages or in their exports.' }, 'Private')),
          h('p', { class: 'lede' }, 'Who stands a real chance in GSoC and other open-source programs, and what each of them needs next.')),
        h('div', { class: 'toolbar' }, fresh, lockBtn)),
      tabs(SECTIONS.map((s) => ({ label: s.label, href: href(s.path), active: s === section })), { label: 'Dashboard sections' }));

    if (!section) {
      el.append(h('div', { class: 'notice notice-warn' }, 'There is no such section. ', h('a', { href: '#/owner' }, 'Go to the summary')));
    } else {
      const mod = await section.load();
      const body = h('div', { class: `stack owner-${section.key}-page` });
      el.append(body);
      sectionCleanup = await mod.default(body, ctx, shared);
    }
    el.append(limitsNote(shared.bands));

    // scores are recomputed in the background (≈ 2 s): wait for the job, then show the new numbers
    if (status.job || status.stale) {
      const tick = async () => {
        if (stopped) return;
        try {
          const st = await oapi.get('/status');
          if (stopped) return;
          showFresh(st);
          if (!st.job && !st.stale) {
            if (shared.isDirty && shared.isDirty()) toast('Scores were recomputed. Save or discard your changes to see them.');
            else refresh();
            return;
          }
        } catch (err) {
          if (err instanceof Locked) return;
        }
        timer = setTimeout(tick, 1500);
      };
      timer = setTimeout(tick, 1200);
    }

    syncStudentPanel(ctx.query.student || '', {
      program: ctx.query.program || ctx.query.p || '',
      onClose: () => setQuery({ student: '' }),
      onChanged: () => { if (!(shared.isDirty && shared.isDirty())) refresh(); },
    });
  } catch (err) {
    if (!(err instanceof Locked)) throw err;
  }

  return () => {
    stopped = true;
    clearTimeout(timer);
    if (typeof sectionCleanup === 'function') { try { sectionCleanup(); } catch (err) { console.error(err); } }
  };
}

