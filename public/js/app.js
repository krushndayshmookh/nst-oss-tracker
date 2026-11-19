// Entry point of the public site: route table + the bits of the shell that depend on the current route.
import { startRouter, href } from './lib/router.js';
import { getMeta, hasRanges, rangeQuery } from './pages/common.js';

const NAV_PATHS = new WeakMap();

/** Carry the active date range across the masthead links (they are static in index.html). */
function syncNav(ctx) {
  const range = rangeQuery(ctx.query);
  for (const a of document.querySelectorAll('a[data-nav]')) {
    if (!NAV_PATHS.has(a)) NAV_PATHS.set(a, (a.getAttribute('href') || '#/').replace(/^#/, '').split('?')[0] || '/');
    a.setAttribute('href', href(NAV_PATHS.get(a), range));
  }
}

/** The Activity page needs GET /api/activity (SPEC addendum A). Show its nav item only when the server has it. */
let activityNav = null;
async function ensureActivityNav(ctx) {
  if (activityNav === null) {
    activityNav = false;
    let meta = null;
    try { meta = await getMeta(); } catch { /* the page itself reports the failure */ }
    const nav = document.querySelector('.site-nav');
    if (nav && hasRanges(meta) && !nav.querySelector('a[href^="#/activity"]')) {
      const a = document.createElement('a');
      a.setAttribute('data-nav', '');
      a.setAttribute('href', '#/activity');
      a.textContent = 'Activity';
      const about = nav.querySelector('a[href^="#/about"]');
      nav.insertBefore(a, about);
      activityNav = a;
    }
  }
  if (activityNav) {
    if (ctx.path === '/activity') activityNav.setAttribute('aria-current', 'page'); else activityNav.removeAttribute('aria-current');
  }
}

startRouter([
  { path: '/', page: () => import('./pages/overview.js') },
  { path: '/students', page: () => import('./pages/students.js') },
  { path: '/students/:username', page: () => import('./pages/student.js') },
  { path: '/projects', page: () => import('./pages/projects.js') },
  { path: '/projects/:owner/:name', page: () => import('./pages/repo.js') },
  { path: '/orgs', page: () => import('./pages/orgs.js') },
  { path: '/orgs/:login', page: () => import('./pages/org.js') },
  { path: '/prs', page: () => import('./pages/prs.js') },
  { path: '/activity', page: () => import('./pages/activity.js') },
  { path: '/about', page: () => import('./pages/about.js') },
], document.getElementById('app'), {
  onNavigate: async (ctx) => {
    await ensureActivityNav(ctx);
    syncNav(ctx);
  },
});
