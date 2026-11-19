// Admin entry point (SPEC 7.1): route table + the sign-in gate.
// Every navigation asks GET /admin/me; while it says admin:false the gate owns #app and shows the sign-in form.
// A page (or any action) that gets a 401 later — the 12 h session ran out, or the server restarted with a new
// secret — comes back here through handleAuthError().

import { api } from '../lib/api.js';
import { startRouter, navigate } from '../lib/router.js';
import { handleAuthError, closeDialogs, takeExpired } from './common.js';
import { h } from '../lib/ui.js';
import renderLogin from './login.js';

const app = document.getElementById('app');
const nav = document.getElementById('admin-nav');

/** Wrap a page loader so a 401 while loading shows the sign-in form instead of an error box. */
const guarded = (load) => async (el, ctx) => {
  try {
    const mod = await load();
    return await mod.default(el, ctx);
  } catch (err) {
    if (handleAuthError(err)) return undefined;
    throw err;
  }
};

/**
 * "Krushn's dashboard" (SPEC addendum G). The page lives in its own module, public/js/owner/main.js, which asks for
 * the second password itself; nothing of it is loaded until the link is opened. If the module is not on this server,
 * say so instead of showing a stack trace.
 */
const ownerPage = async (el, ctx) => {
  let mod;
  try {
    mod = await import('../owner/main.js');
  } catch (err) {
    console.warn('owner dashboard module could not be loaded', err);
    el.append(
      h('header', { class: 'page-head' }, h('div', null,
        h('h1', null, "Krushn's dashboard"),
        h('p', { class: 'lede' }, 'A private page with program-readiness scores. It has its own password.'))),
      h('div', { class: 'notice notice-warn', role: 'alert' },
        'This page is not available on this server yet. Nothing was loaded and no data was requested. Try again after the next deploy.'),
      h('div', { class: 'toolbar' }, h('a', { class: 'btn', href: '#/students' }, 'Back to Students')));
    return undefined;
  }
  if (!mod || typeof mod.default !== 'function') throw new Error('The dashboard module has no page to show.');
  return mod.default(el, ctx);
};
const owner = guarded(async () => ({ default: ownerPage }));

const routes = [
  { path: '/', page: guarded(() => import('./students.js')) },
  { path: '/students', page: guarded(() => import('./students.js')) },
  { path: '/review', page: guarded(() => import('./review.js')) },
  { path: '/prs', page: guarded(() => import('./prs.js')) },
  { path: '/overrides', page: guarded(() => import('./overrides.js')) },
  { path: '/rules', page: guarded(() => import('./rules.js')) },
  { path: '/jobs', page: guarded(() => import('./jobs.js')) },
  { path: '/owner', page: owner },
  { path: '/owner/:section', page: owner },
  { path: '/owner/:section/:id', page: owner },
];

let router = null;
let wasAdmin = false; // signed in earlier in this page's life; Sign out reloads the page, which resets it

router = startRouter(routes, app, {
  title: 'NST Open Source admin',
  onNavigate: async (ctx) => {
    let me;
    try {
      me = await api.get('/admin/me');
    } catch (err) {
      // the server cannot be reached: show that, with a way to retry, rather than a blank page
      me = { admin: false, configured: true, unreachable: err };
    }
    if (nav) nav.hidden = !me.admin;
    if (!me.admin) {
      const expired = takeExpired() || wasAdmin;
      wasAdmin = false;
      closeDialogs();
      document.title = 'Sign in · NST Open Source admin';
      renderLogin(app, me, { expired: expired && !me.unreachable, onDone: () => router.refresh() });
      return false; // the router leaves #app to the sign-in form
    }
    wasAdmin = true;
    if (ctx.path === '/') {
      navigate('/students', ctx.query, { replace: true });
      return false;
    }
    return true;
  },
});
