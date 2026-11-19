// Entry point of the public site: route table + the bits of the shell that depend on the current route.
import { startRouter, href, navigate } from './lib/router.js';
import { api } from './lib/api.js';
import { getMeta, hasRanges, rangeQuery, rangeParams, sanitizeRange } from './pages/common.js';

const NAV_PATHS = new WeakMap();

/** Carry the active date range across the masthead links and the footer CSV link (they are static in index.html). */
function syncNav(ctx, meta) {
  const range = rangeQuery(ctx.query);
  for (const a of document.querySelectorAll('a[data-nav]')) {
    if (!NAV_PATHS.has(a)) NAV_PATHS.set(a, (a.getAttribute('href') || '#/').replace(/^#/, '').split('?')[0] || '/');
    a.setAttribute('href', href(NAV_PATHS.get(a), range));
  }
  const brand = document.querySelector('a.brand');
  if (brand) brand.setAttribute('href', href('/', range));
  const csv = document.getElementById('footer-csv');
  if (csv) csv.setAttribute('href', api.url('/export/students.csv', rangeParams(ctx.query, meta)));
}

/** The Activity page needs GET /api/activity (SPEC addendum A). Its nav item is removed when the server lacks it. */
function syncActivityNav(meta) {
  const a = document.querySelector('.site-nav a[href^="#/activity"]');
  if (a && meta && !hasRanges(meta)) a.remove();
}

startRouter([
  { path: '/', page: () => import('./pages/overview.js') },
  { path: '/campuses', page: () => import('./pages/campuses.js') },
  { path: '/campuses/:campus', page: () => import('./pages/campus.js') },
  { path: '/students', page: () => import('./pages/students.js') },
  { path: '/students/:username', page: () => import('./pages/student.js') },
  { path: '/projects', page: () => import('./pages/projects.js') },
  { path: '/projects/:owner/:name', page: () => import('./pages/repo.js') },
  { path: '/orgs', page: () => import('./pages/orgs.js') },
  { path: '/orgs/:login', page: () => import('./pages/org.js') },
  { path: '/prs', page: () => import('./pages/prs.js') },
  { path: '/activity', page: () => import('./pages/activity.js') },
  { path: '/tech', page: () => import('./pages/tech.js') },
  { path: '/about', page: () => import('./pages/about.js') },
], document.getElementById('app'), {
  onNavigate: async (ctx) => {
    let meta = null;
    try { meta = await getMeta(); } catch { /* the page itself reports the failure */ }
    // an unusable range in the URL (bad date, from after to, unknown preset) is dropped before any page asks for it
    const fixed = sanitizeRange(ctx.query, meta);
    if (fixed) { navigate(ctx.path, fixed, { replace: true }); return false; }
    syncActivityNav(meta);
    syncNav(ctx, meta);
    return undefined;
  },
});
