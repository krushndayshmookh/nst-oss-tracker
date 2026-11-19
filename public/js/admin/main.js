// Admin entry point (SPEC 7.1): route table + the sign-in gate.
// Every navigation asks GET /admin/me; while it says admin:false the gate owns #app and shows the sign-in form.
// A page (or any action) that gets a 401 later — the 12 h session ran out, or the server restarted with a new
// secret — comes back here through handleAuthError().

import { api } from '../lib/api.js';
import { startRouter, navigate } from '../lib/router.js';
import { handleAuthError, closeDialogs, takeExpired } from './common.js';
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

const routes = [
  { path: '/', page: guarded(() => import('./students.js')) },
  { path: '/students', page: guarded(() => import('./students.js')) },
  { path: '/review', page: guarded(() => import('./review.js')) },
  { path: '/prs', page: guarded(() => import('./prs.js')) },
  { path: '/overrides', page: guarded(() => import('./overrides.js')) },
  { path: '/rules', page: guarded(() => import('./rules.js')) },
  { path: '/jobs', page: guarded(() => import('./jobs.js')) },
];

let router = null;

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
      closeDialogs();
      document.title = 'Sign in · NST Open Source admin';
      renderLogin(app, me, { expired: takeExpired(), onDone: () => router.refresh() });
      return false; // the router leaves #app to the sign-in form
    }
    if (ctx.path === '/') {
      navigate('/students', ctx.query, { replace: true });
      return false;
    }
    return true;
  },
});
