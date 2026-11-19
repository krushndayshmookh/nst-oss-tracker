// Admin → Review: the detail panel. A side drawer for one repository ('owner/name') or one owner (login) that opens
// over the queue without leaving it. It sits on <body>, outside the router's page element, so re-rendering the
// queue (filters, paging, a decision) neither closes it nor moves the queue's scroll position.
//
//   syncDetail(key | '', { onOpen(key), onClose() })   open / switch / close; idempotent for the same key
//   closeDetail()                                      remove it
//   detailSubject()                                    → { kind: 'repo' | 'owner', row } | null (for keyboard shortcuts)
//
// Data: GET /repos/:owner/:name, GET /orgs/:login and GET /prs?repo=|owner=&category=all. An admin session gets the
// admin fields (override notes) from these public endpoints and is never served from the public cache.

import { api } from '../lib/api.js';
import {
  h, table, pagination, tabs, badge, categoryBadge, categoryBar, overrideBadge, stateBadge, extLink, ghLink, loading, fmt, STATE_LABELS,
} from '../lib/ui.js';
import { handleAuthError, errorText, plural } from './common.js';
import { onDecision, repoSource, prSource, sourceTag, repoButtons, ownerButtons, prButtons } from './decisions.js';

const PR_LIMIT = 20;
const OWNER_WORD = { include: 'Owner included', exclude: 'Owner excluded', nst_internal: 'Owner marked NST internal' };
const OVERRIDE_WORD = { include: 'Included', exclude: 'Excluded', nst_internal: 'Marked NST internal' };
const lc = (s) => String(s || '').toLowerCase();
const enc = encodeURIComponent;

// what the admin last chose; kept while moving from row to row
const prefs = { range: 'all', tab: 'prs' };

let cur = null; // { key, kind, el, title, kindLabel, body, handlers, data, error, prs, prState, prPage, token, prToken, stop }

export function detailSubject() {
  if (!cur || !cur.data) return null;
  return { kind: cur.kind, row: cur.kind === 'repo' ? cur.data.repo : cur.data.org };
}

export function closeDetail() {
  if (!cur) return;
  const c = cur;
  cur = null;
  c.token++;
  c.prToken++;
  c.stop();
  window.removeEventListener('scroll', c.place);
  window.removeEventListener('resize', c.place);
  c.el.remove();
  document.body.classList.remove('has-drawer');
}

export function syncDetail(key, handlers = {}) {
  const want = String(key || '').trim();
  if (!want) { closeDetail(); return; }
  if (cur) {
    cur.handlers = handlers;
    if (lc(cur.key) === lc(want)) return;
  } else {
    build(handlers);
  }
  cur.key = want;
  cur.kind = want.includes('/') ? 'repo' : 'owner';
  cur.data = null;
  cur.error = null;
  cur.prs = null;
  cur.prState = '';
  cur.prPage = 1;
  cur.kindLabel.textContent = cur.kind === 'repo' ? 'Repository' : 'Owner';
  cur.title.textContent = want;
  cur.body.scrollTop = 0;
  draw();
  load();
}

function build(handlers) {
  const title = h('h2', { id: 'review-drawer-title', tabindex: '-1' });
  const kindLabel = h('div', { class: 'drawer-kind' });
  const body = h('div', { class: 'drawer-body' });
  const close = h('button', { type: 'button', class: 'dialog-close', name: 'drawer-close', 'aria-label': 'Close details', title: 'Close (Esc)' }, '×');
  const el = h('aside', { class: 'drawer', id: 'review-drawer', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'review-drawer-title' },
    h('header', { class: 'drawer-head' }, h('div', { class: 'drawer-title' }, kindLabel, title), close),
    body);
  const stop = onDecision(({ kind, res }) => {
    if (!cur) return;
    // show the answer at once where it is visible, then fetch the numbers again
    if (cur.data) {
      if (kind === 'repo' && cur.kind === 'repo' && lc(res.repo.name) === lc(cur.data.repo.name)) keepStats(cur.data.repo, res.repo);
      if (kind === 'repo' && cur.kind === 'owner') {
        const r = cur.data.repos.find((x) => lc(x.name) === lc(res.repo.name));
        if (r) keepStats(r, res.repo);
      }
      if (kind === 'owner' && cur.kind === 'owner' && lc(res.org.login) === lc(cur.data.org.login)) {
        keepStats(cur.data.org, res.org);
        for (const r of cur.data.repos) r.ownerOverride = res.org.override;
      }
      if (kind === 'owner' && cur.kind === 'repo' && lc(res.org.login) === lc(cur.data.repo.owner)) {
        cur.data.owner.override = res.org.override;
        cur.data.repo.ownerOverride = res.org.override;
      }
    }
    if (kind === 'pr' && cur.prs) {
      const p = cur.prs.items.find((x) => x.url === res.pr.url);
      if (p) Object.assign(p, res.pr);
    }
    draw();
    load({ quiet: true });
  });
  close.addEventListener('click', () => requestClose());
  // on wide screens the panel starts under the masthead while that is in view, so the top bar stays usable
  const place = () => {
    const mast = document.querySelector('.masthead');
    const top = mast && window.innerWidth >= 1100 ? Math.max(0, Math.round(mast.getBoundingClientRect().bottom)) : 0;
    el.style.top = `${top}px`;
  };
  window.addEventListener('scroll', place, { passive: true });
  window.addEventListener('resize', place);
  place();
  cur = { el, title, kindLabel, body, handlers, place, token: 0, prToken: 0, stop, key: '', kind: 'repo', data: null, error: null, prs: null, prState: '', prPage: 1 };
  document.body.append(el);
  document.body.classList.add('has-drawer');
}

/** A decision answers with all-time stats; while the panel shows a date range keep the ranged numbers until the reload. */
function keepStats(target, fresh) {
  const stats = target.stats;
  Object.assign(target, fresh);
  if (prefs.range !== 'all' && stats) target.stats = stats;
}

function requestClose() {
  const fn = cur && cur.handlers.onClose;
  if (fn) fn(); else closeDetail();
}

function openOther(key) {
  const fn = cur && cur.handlers.onOpen;
  if (fn) fn(key); else syncDetail(key, cur ? cur.handlers : {});
}

/* ───────────── loading ───────────── */

async function load({ quiet = false } = {}) {
  const c = cur;
  if (!c) return;
  const token = ++c.token;
  if (!quiet) c.el.setAttribute('aria-busy', 'true');
  const params = { range: prefs.range, _: Date.now() };
  try {
    let data;
    if (c.kind === 'repo') {
      const [owner, ...rest] = c.key.split('/');
      data = await api.get(`/repos/${enc(owner)}/${enc(rest.join('/'))}`, params);
      data.repo.ownerOverride = data.owner ? data.owner.override : null;
    } else {
      data = await api.get(`/orgs/${enc(c.key)}`, params);
      for (const r of data.repos) r.ownerOverride = data.org.override;
    }
    if (cur !== c || token !== c.token) return;
    c.data = data;
    c.error = null;
    c.title.textContent = c.kind === 'repo' ? data.repo.name : data.org.login;
  } catch (err) {
    if (cur !== c || token !== c.token) return;
    if (handleAuthError(err)) { closeDetail(); return; }
    c.data = null;
    c.error = err;
  }
  c.el.removeAttribute('aria-busy');
  draw();
  if (c.data) loadPrs({ quiet: true });
}

async function loadPrs({ quiet = false } = {}) {
  const c = cur;
  if (!c || !c.data) return;
  const token = ++c.prToken;
  if (!quiet) { c.prs = null; draw(); }
  try {
    const res = await api.get('/prs', {
      [c.kind === 'repo' ? 'repo' : 'owner']: c.kind === 'repo' ? c.data.repo.name : c.data.org.login,
      category: 'all', range: prefs.range, state: c.prState, page: c.prPage, limit: PR_LIMIT, _: Date.now(),
    });
    if (cur !== c || token !== c.prToken) return;
    c.prs = res;
  } catch (err) {
    if (cur !== c || token !== c.prToken) return;
    if (handleAuthError(err)) { closeDetail(); return; }
    c.prs = { error: err, items: [], total: 0, page: 1, limit: PR_LIMIT };
  }
  draw();
}

/* ───────────── drawing ───────────── */

function draw() {
  const c = cur;
  if (!c) return;
  const top = c.body.scrollTop;
  const active = document.activeElement;
  const focusName = active && c.body.contains(active) ? active.getAttribute('name') : null;
  if (c.error) {
    const missing = c.error.status === 404;
    c.body.replaceChildren(h('div', { class: 'notice notice-warn', role: 'alert' },
      missing ? `Nothing is stored for “${c.key}”. It may have been renamed, or it has no pull requests by tracked students.` : errorText(c.error)),
    h('div', { class: 'toolbar' },
      missing ? null : h('button', { type: 'button', class: 'btn', name: 'drawer-retry', onClick: () => load() }, 'Try again'),
      h('button', { type: 'button', class: 'btn', name: 'drawer-close-2', onClick: () => requestClose() }, 'Close')));
    return;
  }
  if (!c.data) { c.body.replaceChildren(loading('Loading details…')); return; }
  const isRepo = c.kind === 'repo';
  const d = c.data;
  const tab = !isRepo || prefs.tab !== 'repos' ? prefs.tab : 'prs';
  const stats = isRepo ? d.repo.stats : d.org.stats;
  c.body.replaceChildren(
    isRepo ? repoHead(d) : ownerHead(d),
    rangeToggle(d.range),
    figures(isRepo, stats, d),
    tabs([
      { label: 'Pull requests', value: 'prs', count: stats.prs, active: tab === 'prs' },
      { label: 'Students', value: 'students', count: d.students.length >= 100 ? null : d.students.length, active: tab === 'students' },
      isRepo ? null : { label: 'Repositories', value: 'repos', count: d.repos.length >= 100 ? null : d.repos.length, active: tab === 'repos' },
    ].filter(Boolean), { label: 'Details', onSelect: (value) => { prefs.tab = value; draw(); } }),
    h('div', { class: 'drawer-panel', role: 'tabpanel' }, tab === 'prs' ? prsPanel(c) : tab === 'students' ? studentsPanel(d, isRepo) : reposPanel(d)));
  c.body.scrollTop = top;
  if (focusName) {
    const again = c.body.querySelector(`[name="${CSS.escape(focusName)}"]`);
    if (again) again.focus({ preventScroll: true });
  }
}

function reasonText(r) {
  if (!r.reason || (r.category === 'open_source' && r.reason === r.tier)) return null;
  const text = r.reason.replace(/^admin: /, 'Admin: ');
  return r.category === 'open_source' ? text : `Not counted: ${text}`;
}

function repoHead({ repo: r, owner }) {
  const src = repoSource(r);
  const facts = [
    `${fmt.num(r.stars)} ${r.stars === 1 ? 'star' : 'stars'}`,
    r.ownerType === 'User' ? 'Personal repository' : 'Organisation repository',
    r.language, r.license,
  ].filter(Boolean);
  const ownerBtn = h('button', { type: 'button', class: 'btn btn-sm btn-link', name: `open-owner-${r.owner}`, title: 'Open the owner’s details', onClick: () => openOther(r.owner) }, r.owner);
  return h('section', { class: 'drawer-section' },
    h('div', { class: 'drawer-meta' }, ghLink(r.name, 'Open on GitHub'), facts.map((f) => h('span', null, f)),
      r.isFork ? badge('Fork') : null, r.isArchived ? badge('Archived') : null),
    r.description ? h('p', { class: 'drawer-desc muted' }, r.description) : null,
    h('div', { class: 'drawer-meta' }, h('span', null, 'Owner: ', ownerBtn),
      owner && owner.override ? h('span', { class: 'badge badge-override' }, OWNER_WORD[owner.override] || owner.override) : null),
    h('div', { class: 'drawer-state' },
      h('span', { class: 'drawer-label' }, 'Currently'),
      categoryBadge(r.category, r.tier), ' ',
      sourceTag(src, { link: src === 'org' ? r.owner : null, note: r.overrideNote, onOpen: openOther }),
      src === 'admin'
        ? h('div', { class: 'sub' }, `${OVERRIDE_WORD[r.override] || r.override} by an admin${r.overrideNote ? `: ${r.overrideNote}` : ''}`)
        : (reasonText(r) ? h('div', { class: 'sub' }, reasonText(r)) : null)),
    repoButtons(r, { name: `drawer-${r.name}` }));
}

function ownerHead({ org: o }) {
  const facts = [
    o.type === 'User' ? 'Personal account' : 'Organisation',
    `top repository: ${fmt.num(o.stats.maxStars)} ${o.stats.maxStars === 1 ? 'star' : 'stars'}`,
  ];
  return h('section', { class: 'drawer-section' },
    h('div', { class: 'drawer-meta' }, ghLink(o.login, 'Open on GitHub'), facts.map((f) => h('span', null, f))),
    h('div', { class: 'drawer-state' },
      h('span', { class: 'drawer-label' }, 'Currently'),
      o.override ? overrideBadge(o.override, o.overrideNote) : h('span', { class: 'badge badge-neutral' }, 'No decision'), ' ',
      sourceTag(o.override ? 'admin' : 'rule', { note: o.overrideNote }),
      h('div', { class: 'sub' }, o.override
        ? `${OVERRIDE_WORD[o.override] || o.override} by an admin${o.overrideNote ? `: ${o.overrideNote}` : ''}. Covers every repository of this owner without its own decision.`
        : 'Each repository of this owner is placed by the rules.')),
    h('div', { class: 'drawer-mix' }, categoryBar(o.stats.byCategory, { legend: true })),
    ownerButtons(o, { name: `drawer-${o.login}` }));
}

function rangeToggle(range) {
  const btn = (value, label) => h('button', {
    type: 'button', name: `drawer-range-${value}`, class: ['btn btn-sm', prefs.range === value && 'is-on'], 'aria-pressed': prefs.range === value ? 'true' : 'false',
    onClick: () => {
      if (prefs.range === value || !cur) return;
      prefs.range = value;
      cur.prPage = 1;
      cur.prs = null;
      draw();
      load();
    },
  }, label);
  const span = range && range.from && prefs.range !== 'all' ? `${range.label} · ${fmt.date(range.from)} – ${fmt.date(range.to)}` : null;
  return h('div', { class: 'drawer-range', role: 'group', 'aria-label': 'Period for the numbers below' },
    h('span', { class: 'drawer-label' }, 'Numbers for'),
    h('div', { class: 'btn-group' }, btn('all', 'All time'), btn('ay', 'This academic year')),
    span ? h('span', { class: 'muted drawer-range-note' }, span) : null);
}

function figures(isRepo, s, d) {
  const items = isRepo
    ? [['Pull requests', s.prs], ['Merged', s.merged], ['Open', s.open], ['Closed unmerged', s.closed], ['Students', s.students]]
    : [['Repositories', s.repos], ['Pull requests', s.prs], ['Merged', s.merged], ['Open-source PRs', s.osPrs], ['Open-source merged', s.osMerged], ['Students', s.students]];
  return h('dl', { class: 'drawer-figures', 'aria-label': d.range && prefs.range !== 'all' ? d.range.label : 'All time' },
    items.map(([label, value]) => h('div', null, h('dt', null, label), h('dd', null, fmt.num(value)))));
}

/* ───────────── tab: pull requests ───────────── */

function prSourceTag(p) {
  const src = prSource(p);
  return sourceTag(src, { link: src === 'repo' ? p.repo : src === 'org' ? p.owner : null, note: p.overrideNote, onOpen: openOther });
}

function prItem(p, c) {
  const lines = `+${fmt.num(p.additions)} −${fmt.num(p.deletions)}`;
  const inOwner = c.kind === 'owner';
  return h('li', { class: 'drawer-item', dataset: { url: p.url } },
    h('div', { class: 'drawer-item-title' }, extLink(p.title || `#${p.number}`, p.url)),
    h('div', { class: 'drawer-item-meta' },
      stateBadge(p.isDraft && p.state === 'open' ? 'draft' : p.state),
      h('span', null, inOwner ? `${p.repo}#${p.number}` : `#${p.number}`),
      h('span', null, 'by ', h('a', { href: `/#/students/${enc(p.author)}`, target: '_blank', rel: 'noopener', title: 'Public profile' }, p.authorName || p.author)),
      h('span', null, `Opened ${fmt.date(p.createdAt)}`),
      p.mergedAt ? h('span', null, `Merged ${fmt.date(p.mergedAt)}`) : (p.state === 'closed' && p.closedAt ? h('span', null, `Closed ${fmt.date(p.closedAt)}`) : null),
      h('span', { class: 'nowrap', title: `${fmt.num(p.additions)} lines added, ${fmt.num(p.deletions)} removed in ${plural(p.changedFiles, 'file')}` }, lines)),
    h('div', { class: 'drawer-item-decide' },
      h('span', { class: 'drawer-item-cat' }, categoryBadge(p.category, p.tier), ' ', prSourceTag(p),
        p.override && p.overrideNote ? h('span', { class: 'sub' }, p.overrideNote) : null),
      prButtons(p, { compact: true })));
}

function prsPanel(c) {
  const states = [['', 'All'], ['open', STATE_LABELS.open || 'Open'], ['merged', STATE_LABELS.merged || 'Merged'], ['closed', STATE_LABELS.closed || 'Closed']];
  const filter = h('div', { class: 'btn-group drawer-filter', role: 'group', 'aria-label': 'Filter by state' }, states.map(([value, label]) =>
    h('button', {
      type: 'button', name: `drawer-state-${value || 'all'}`, class: ['btn btn-sm', c.prState === value && 'is-on'], 'aria-pressed': c.prState === value ? 'true' : 'false',
      onClick: () => { if (c.prState === value) return; c.prState = value; c.prPage = 1; loadPrs(); },
    }, label)));
  if (!c.prs) return h('div', null, filter, loading('Loading pull requests…'));
  if (c.prs.error) return h('div', null, filter, h('div', { class: 'notice notice-warn', role: 'alert' }, errorText(c.prs.error)));
  return h('div', null, filter,
    c.prs.items.length
      ? h('ul', { class: 'drawer-list', 'aria-label': 'Pull requests' }, c.prs.items.map((p) => prItem(p, c)))
      : h('div', { class: 'empty' }, c.prState ? 'No pull requests in this state for the chosen period.' : 'No pull requests in the chosen period.'),
    pagination({ page: c.prs.page, limit: c.prs.limit, total: c.prs.total, onPage: (page) => { c.prPage = page; c.body.scrollTop = 0; loadPrs({ quiet: true }); } }));
}

/* ───────────── tab: students ───────────── */

function studentsPanel(d, isRepo) {
  const where = isRepo ? 'this repository' : 'this owner’s repositories';
  return h('div', null,
    d.students.length >= 100 ? h('p', { class: 'muted drawer-note' }, 'The 100 students with the most merged pull requests here.') : null,
    table({
      caption: `Students with pull requests in ${where}`, compact: true, sticky: false,
      rows: d.students,
      empty: 'No students in the chosen period.',
      columns: [
        {
          key: 'name', label: 'Student', wrap: true,
          render: (s) => h('div', null,
            h('a', { href: `/#/students/${enc(s.username)}`, target: '_blank', rel: 'noopener', title: 'Public profile' }, s.name || s.username),
            h('div', { class: 'sub' }, ghLink(s.username))),
        },
        { key: 'campus', label: 'Campus' },
        { key: 'year', label: 'Year' },
        { key: 'prs', label: 'PRs', num: true, title: `Pull requests in ${where}` },
        { key: 'merged', label: 'Merged', num: true, title: `Merged pull requests in ${where}` },
      ],
    }));
}

/* ───────────── tab: repositories of an owner ───────────── */

function reposPanel(d) {
  if (!d.repos.length) return h('div', { class: 'empty' }, 'No repositories with pull requests in the chosen period.');
  return h('div', null,
    d.repos.length >= 100 ? h('p', { class: 'muted drawer-note' }, 'The 100 repositories with the most pull requests.') : null,
    h('ul', { class: 'drawer-list', 'aria-label': 'Repositories' }, d.repos.map((r) => {
      const src = repoSource(r);
      return h('li', { class: 'drawer-item' },
        h('div', { class: 'drawer-item-title' },
          h('button', { type: 'button', class: 'btn btn-sm btn-link drawer-open', name: `open-repo-${r.name}`, title: 'Open this repository’s details', onClick: () => openOther(r.name) }, r.name),
          r.isFork ? badge('Fork') : null, r.isArchived ? badge('Archived') : null),
        h('div', { class: 'drawer-item-meta' },
          h('span', null, `${fmt.num(r.stars)} ${r.stars === 1 ? 'star' : 'stars'}`),
          h('span', null, plural(r.stats.prs, 'PR')),
          h('span', null, `${fmt.num(r.stats.merged)} merged`),
          h('span', null, plural(r.stats.students, 'student')),
          ghLink(r.name, 'GitHub')),
        h('div', { class: 'drawer-item-decide' },
          h('span', { class: 'drawer-item-cat' }, categoryBadge(r.category, r.tier), ' ',
            sourceTag(src, { note: r.overrideNote })),
          repoButtons(r, { name: `drawer-repo-${r.name}`, compact: true })));
    })));
}
