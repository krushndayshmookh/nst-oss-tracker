// Hash router: '#/students/octocat?campus=RU&page=2'. Contract: SPEC.md section 7.1.
//
//   startRouter([{ path: '/students/:username', page: fn | () => import('./pages/student.js') }], el, { onNavigate })
//
// A page is `async function (el, ctx)`; it may return a cleanup function. `ctx = { params, query, path }`.
// Each navigation renders into a fresh <div class="page"> inside `el`, so a slow page that resolves after
// the user has moved on writes into a detached node and cannot clobber the current view.

import { h, loading, errorBox } from './ui.js';

let state = null; // { routes, el, onNavigate, token, cleanup, pageEl, path }

function compile(path) {
  const names = [];
  const source = String(path)
    .replace(/\/+$/, '')
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { re: new RegExp(`^${source || ''}/?$`), names };
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Parse a location hash into { path, query }. '' and '#' mean '/'. */
export function parseHash(hash = location.hash) {
  let raw = String(hash || '').replace(/^#/, '');
  if (!raw.startsWith('/')) raw = `/${raw}`;
  const i = raw.indexOf('?');
  const path = (i === -1 ? raw : raw.slice(0, i)).replace(/\/+$/, '') || '/';
  const query = {};
  if (i !== -1) for (const [k, v] of new URLSearchParams(raw.slice(i + 1))) query[k] = v;
  return { path, query };
}

/** Build a hash href. Empty / null / undefined query values are dropped. */
export function href(path, query) {
  let p = String(path || '/');
  if (!p.startsWith('/')) p = `/${p}`;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v === null || v === undefined || v === '' || v === false) continue;
    sp.set(k, v === true ? '1' : String(v));
  }
  const qs = sp.toString();
  return `#${p}${qs ? `?${qs}` : ''}`;
}

/** Go to a path. `opts.replace` swaps the current history entry instead of adding one. */
export function navigate(path, query, opts = {}) {
  const target = href(path, query);
  if (target === (location.hash || '#/')) { render(); return; }
  if (opts.replace) {
    history.replaceState(null, '', target);
    render();
  } else {
    location.hash = target;
  }
}

/** Merge a patch into the current hash query (empty values remove the key) and re-render. */
export function setQuery(patch, opts = {}) {
  const { path, query } = parseHash();
  navigate(path, { ...query, ...patch }, opts);
}

/** The current { path, query } without subscribing to anything. */
export function currentRoute() {
  return parseHash();
}

function markNav(path) {
  for (const a of document.querySelectorAll('a[data-nav]')) {
    const target = parseHash((a.getAttribute('href') || '').replace(/^[^#]*/, '')).path;
    const on = target === '/' ? path === '/' : path === target || path.startsWith(`${target}/`);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  const current = document.querySelector('a[data-nav][aria-current="page"]');
  if (current && current.scrollIntoView && current.parentElement && current.parentElement.scrollWidth > current.parentElement.clientWidth) {
    current.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
}

function notFound(path) {
  return h('div', { class: 'not-found' },
    h('h1', null, 'Page not found'),
    h('p', null, `Nothing lives at “${path}”. The link may be out of date.`),
    h('div', { class: 'toolbar' }, h('a', { class: 'btn btn-primary', href: '#/' }, 'Go to the start page')),
  );
}

// Remember which form control had focus so a query-only re-render (filters, search-as-you-type) can give it back.
function captureFocus(root) {
  const a = document.activeElement;
  if (!a || !root || !root.contains(a)) return null;
  const key = a.getAttribute('name') || a.id;
  if (!key) return null;
  let sel = null;
  try { if (typeof a.selectionStart === 'number') sel = [a.selectionStart, a.selectionEnd]; } catch { /* not a text control */ }
  const typed = a.tagName === 'INPUT' && /^(text|search)$/.test(a.type) ? a.value : null;
  return { key, byName: Boolean(a.getAttribute('name')), sel, typed };
}

function restoreFocus(root, saved) {
  if (!saved) return;
  const target = saved.byName
    ? root.querySelector(`[name="${CSS.escape(saved.key)}"]`)
    : root.querySelector(`#${CSS.escape(saved.key)}`);
  if (!target) return;
  // keep characters typed while the previous request was in flight; the old control's debounce still reports them
  if (saved.typed !== null && target.tagName === 'INPUT' && target.value !== saved.typed) target.value = saved.typed;
  target.focus({ preventScroll: true });
  if (saved.sel) { try { target.setSelectionRange(saved.sel[0], saved.sel[1]); } catch { /* ignore */ } }
}

function runCleanup(fn) {
  if (typeof fn !== 'function') return;
  try { fn(); } catch (err) { console.error('page cleanup failed', err); }
}

async function resolvePage(route, pageEl, ctx) {
  // `page` is either the page function itself or a loader `() => import('…')`. A loader ignores the arguments
  // and resolves to a module namespace; in that case call its default export.
  const page = route._resolved || route.page;
  let result = await page(pageEl, ctx);
  if (result && typeof result === 'object' && typeof result.default === 'function') {
    route._resolved = result.default;
    result = await result.default(pageEl, ctx);
  }
  return result;
}

async function render() {
  if (!state) return;
  const s = state;
  const token = ++s.token;
  const { path, query } = parseHash();
  let match = null;
  let params = {};
  for (const route of s.routes) {
    const m = route._match.re.exec(path);
    if (m) {
      match = route;
      route._match.names.forEach((name, i) => { params[name] = safeDecode(m[i + 1]); });
      break;
    }
  }
  const ctx = { params, query, path };
  markNav(path);

  if (s.onNavigate) {
    let go;
    try { go = await s.onNavigate(ctx); } catch (err) { console.error(err); }
    if (token !== s.token) return;
    if (go === false) { // the caller took over `el` (e.g. the admin login form)
      runCleanup(s.cleanup);
      s.cleanup = null;
      s.pageEl = null;
      s.path = null;
      return;
    }
  }

  const samePath = s.path === path && Boolean(s.pageEl) && s.pageEl.isConnected;
  const pageEl = h('div', { class: 'page' });
  let loader = null;
  if (samePath) {
    // Same page, new query (filter, sort, page): keep the current view on screen, dimmed, and build the next one
    // hidden beside it. Swapped in when ready — no flash, no scroll jump, focus stays in the filter being typed in.
    s.pageEl.setAttribute('aria-busy', 'true');
    pageEl.hidden = true;
    s.el.append(pageEl);
  } else {
    runCleanup(s.cleanup);
    s.cleanup = null;
    loader = loading();
    s.el.replaceChildren(pageEl, loader);
    s.pageEl = pageEl;
    s.path = path;
    window.scrollTo(0, 0);
  }

  let cleanup = null;
  let failed = null;
  try {
    if (!match) pageEl.append(notFound(path));
    else cleanup = await resolvePage(match, pageEl, ctx);
  } catch (err) {
    console.error(err);
    failed = err;
  }

  if (token !== s.token) {
    // a newer navigation owns the view now
    runCleanup(cleanup);
    if (samePath) pageEl.remove();
    return;
  }

  if (failed) {
    runCleanup(cleanup);
    cleanup = null;
    pageEl.replaceChildren(errorBox(failed, { retry: () => refresh() }));
  }
  if (samePath) {
    const focus = captureFocus(s.pageEl);
    runCleanup(s.cleanup);
    s.pageEl.remove();
    pageEl.hidden = false;
    s.pageEl = pageEl;
    restoreFocus(pageEl, focus);
  } else if (loader) {
    loader.remove();
  }
  s.cleanup = typeof cleanup === 'function' ? cleanup : null;

  const title = pageEl.querySelector('h1');
  document.title = title && title.textContent.trim() ? `${title.textContent.trim()} · ${s.baseTitle}` : s.baseTitle;
}

/**
 * Start routing. `routes`: [{ path, page }]; `el`: the mount element (<main id="app">).
 * `opts.onNavigate(ctx)` runs before every render; return false (or a promise of false) to stop the router
 * rendering this navigation (the caller then owns `el`). Call `refresh()` to render again.
 */
export function startRouter(routes, el, opts = {}) {
  if (state) window.removeEventListener('hashchange', render);
  state = {
    routes: routes.map((r) => ({ ...r, _match: compile(r.path) })),
    el,
    onNavigate: opts.onNavigate || null,
    token: 0,
    cleanup: null,
    pageEl: null,
    path: null,
    baseTitle: opts.title || document.title,
  };
  window.addEventListener('hashchange', render);
  render();
  return { refresh };
}

/** Re-run the current route in place (after a mutation, or after login). Keeps scroll position and focus. */
export function refresh() {
  return render();
}
