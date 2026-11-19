// Admin → Review. Triage queues: repositories (GET /admin/review/repos) and owners (GET /admin/review/owners),
// with one-click include / exclude / NST-internal decisions, a detail panel per row (detail.js, `&open=<repo|owner>`)
// and keyboard shortcuts (j / k / arrows, Enter, i / e / n, Esc).

import { api } from '../lib/api.js';
import { setQuery, href, currentRoute } from '../lib/router.js';
import {
  h, pageHead, filterBar, table, pagination, card, tabs, badge, categoryBadge, categoryBar, overrideBadge, ghLink, toast, fmt, CATEGORIES, CATEGORY_LABELS,
} from '../lib/ui.js';
import {
  decideRepo, decideOwner, onDecision, repoSource, sourceTag, repoButtons, ownerButtons, alreadyText,
} from './decisions.js';
import { syncDetail, closeDetail, detailSubject } from './detail.js';

const MIN_PRS = ['2', '3', '5', '10', '25', '50'].map((v) => ({ value: v, label: `${v} or more` }));
const DECISION = [{ value: 'none', label: 'Undecided' }, { value: 'any', label: 'Decided' }];
const OWNER_WORD = { include: 'Owner included', exclude: 'Owner excluded', nst_internal: 'Owner marked NST internal' };
const OVERRIDE_WORD = { include: 'Included', exclude: 'Excluded', nst_internal: 'Marked NST internal' };
const lc = (s) => String(s || '').toLowerCase();

const onSort = (sort, order) => setQuery({ sort, order, page: '' });
const onPage = (page) => setQuery({ page: page > 1 ? page : '' });

// the row the keyboard is on; survives a re-render of the queue (a decision, a filter)
const selection = { key: null };

/**
 * A cell that can be drawn again without fetching the list: liveCell(view, key, row, render).
 * `view.live` maps a lowercase key to { row, redraw() }.
 */
function liveCell(view, key, row, render) {
  const holder = h('div', { class: 'live-cell' }, render(row));
  const id = lc(key);
  const item = view.live.get(id) || { row, cells: [], redraw() { for (const c of this.cells) c(); } };
  item.cells.push(() => {
    const active = document.activeElement;
    const name = active && holder.contains(active) ? active.getAttribute('name') : null;
    holder.replaceChildren(render(row));
    if (name) {
      const again = holder.querySelector(`[name="${CSS.escape(name)}"]`);
      if (again) again.focus({ preventScroll: true });
    }
  });
  view.live.set(id, item);
  return holder;
}

const viewButton = (view, key, label) => h('button', {
  type: 'button', class: 'btn btn-sm btn-link row-view', name: `view-${key}`, 'aria-haspopup': 'dialog',
  'aria-label': `View details of ${label}`, title: 'Pull requests, students and decisions (Enter)',
  onClick: (e) => { e.stopPropagation(); view.open(key); },
}, 'View');

/** Why a repository is where it is, in words. Reasons from the API are already short phrases. */
function reasonLine(r) {
  if (!r.reason || (r.category === 'open_source' && r.reason === r.tier)) return null;
  const text = r.reason.replace(/^admin: /, 'Admin: ');
  return h('div', { class: 'sub' }, r.category === 'open_source' ? text : `Not counted: ${text}`);
}

function repoState(view, r) {
  const src = repoSource(r);
  return [
    categoryBadge(r.category, r.tier), ' ',
    sourceTag(src, { link: src === 'org' ? r.owner : null, note: r.overrideNote, onOpen: (key) => view.open(key) }),
    src === 'admin' ? h('div', { class: 'sub' }, `${OVERRIDE_WORD[r.override] || r.override}${r.overrideNote ? `: ${r.overrideNote}` : ''}`) : null,
    src === 'org' ? h('div', { class: 'sub' }, OWNER_WORD[r.ownerOverride] || 'Decided on its owner') : null,
    src === 'rule' ? reasonLine(r) : null,
  ];
}

async function reposTab(q, view) {
  const data = await api.get('/admin/review/repos', {
    q: q.q, category: q.category, minPrs: q.minPrs, override: q.override, owner: q.owner, sort: q.sort, order: q.order, page: q.page,
  });
  view.kind = 'repo';
  view.rows = data.items;
  view.keyOf = (r) => r.name;
  return [
    filterBar({
      fields: [
        { name: 'q', label: 'Search', type: 'search', placeholder: 'Repository name or description' },
        { name: 'category', label: 'Currently', type: 'select', allLabel: 'All categories', options: CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] })) },
        { name: 'minPrs', label: 'Pull requests', type: 'select', allLabel: 'Any number', options: MIN_PRS },
        { name: 'override', label: 'Decision', type: 'select', options: DECISION },
      ],
      values: q,
      onChange: (v) => setQuery({ ...v, page: '' }),
    }),
    q.owner ? h('div', { class: 'notice' }, `Showing repositories owned by ${q.owner}. `,
      h('a', { href: href('/review', { ...q, owner: '', page: '' }) }, 'Show all repositories')) : null,
    card({ flush: true, title: `${fmt.num(data.total)} ${data.total === 1 ? 'repository' : 'repositories'}`, note: 'Busiest first. A decision here applies to every pull request in the repository.' },
      table({
        caption: 'Repositories to review', compact: true,
        rows: data.items,
        sort: q.sort || 'prs', order: q.order || 'desc', onSort,
        empty: 'No repositories match these filters.',
        columns: [
          {
            key: 'name', label: 'Repository', wrap: true,
            render: (r) => h('div', null, ghLink(r.name),
              r.isFork ? [' ', badge('Fork')] : null, r.isArchived ? [' ', badge('Archived')] : null, ' ', viewButton(view, r.name, r.name),
              h('div', { class: 'sub' }, [r.language, r.description].filter(Boolean).join(' · ') || (r.ownerType === 'User' ? 'Personal repository' : ''))),
          },
          { key: 'stars', label: 'Stars', num: true, sortable: true },
          { key: 'prs', label: 'PRs', num: true, sortable: true, render: (r) => h('a', { href: href('/prs', { repo: r.name }), title: 'See these pull requests' }, fmt.num(r.stats.prs)) },
          { key: 'students', label: 'Students', num: true, sortable: true, render: (r) => fmt.num(r.stats.students) },
          { key: 'merged', label: 'Merged', num: true, sortable: true, render: (r) => fmt.num(r.stats.merged) },
          { key: 'category', label: 'Currently', render: (r) => liveCell(view, r.name, r, (row) => repoState(view, row)) },
          { key: 'decision', label: 'Decision', render: (r) => liveCell(view, r.name, r, (row) => repoButtons(row)) },
        ],
      }),
      pagination({ ...data, onPage })),
  ];
}

function ownerState(o) {
  return [
    o.override ? overrideBadge(o.override, o.overrideNote) : h('span', { class: 'muted' }, 'No decision'), ' ',
    sourceTag(o.override ? 'admin' : 'rule', { note: o.overrideNote }),
    o.override && o.overrideNote ? h('div', { class: 'sub' }, o.overrideNote) : null,
  ];
}

async function ownersTab(q, view) {
  const data = await api.get('/admin/review/owners', { q: q.q, minPrs: q.minPrs, override: q.override, sort: q.sort, order: q.order, page: q.page });
  view.kind = 'owner';
  view.rows = data.items;
  view.keyOf = (o) => o.login;
  return [
    filterBar({
      fields: [
        { name: 'q', label: 'Search', type: 'search', placeholder: 'Owner login' },
        { name: 'minPrs', label: 'Pull requests', type: 'select', allLabel: 'Any number', options: MIN_PRS },
        { name: 'override', label: 'Decision', type: 'select', options: DECISION },
      ],
      values: q,
      onChange: (v) => setQuery({ ...v, page: '' }),
    }),
    card({ flush: true, title: `${fmt.num(data.total)} ${data.total === 1 ? 'owner' : 'owners'}`, note: 'Organisations and personal accounts that own the repositories. A decision here covers all their repositories.' },
      table({
        caption: 'Owners to review', compact: true,
        rows: data.items,
        sort: q.sort || 'prs', order: q.order || 'desc', onSort,
        empty: 'No owners match these filters.',
        columns: [
          {
            key: 'login', label: 'Owner',
            render: (o) => h('div', null, ghLink(o.login), ' ', viewButton(view, o.login, o.login),
              h('div', { class: 'sub' }, o.type === 'User' ? 'Personal account' : 'Organisation')),
          },
          { key: 'repos', label: 'Repos', num: true, sortable: true, render: (o) => h('a', { href: href('/review', { owner: o.login }), title: 'Review these repositories' }, fmt.num(o.stats.repos)) },
          { key: 'prs', label: 'PRs', num: true, sortable: true, render: (o) => h('a', { href: href('/prs', { owner: o.login }), title: 'See these pull requests' }, fmt.num(o.stats.prs)) },
          { key: 'osPrs', label: 'Open-source PRs', num: true, sortable: true, render: (o) => fmt.num(o.stats.osPrs) },
          { key: 'students', label: 'Students', num: true, sortable: true, render: (o) => fmt.num(o.stats.students) },
          { key: 'maxStars', label: 'Top stars', num: true, title: 'Stars of their most-starred repository', render: (o) => fmt.num(o.stats.maxStars) },
          { key: 'mix', label: 'Mix', title: 'How their pull requests are categorised now', width: '110px', render: (o) => categoryBar(o.stats.byCategory) },
          { key: 'state', label: 'Currently', render: (o) => liveCell(view, o.login, o, ownerState) },
          { key: 'decision', label: 'Decision', render: (o) => liveCell(view, o.login, o, (row) => ownerButtons(row)) },
        ],
      }),
      pagination({ ...data, onPage })),
  ];
}

/** Put `open` into the hash without asking the router to render: the queue stays exactly as it is. */
function writeOpen(key, { replace = false } = {}) {
  const { path, query } = currentRoute();
  const target = href(path, { ...query, open: key || '' });
  if (target === (location.hash || '#/')) return;
  if (replace) history.replaceState(null, '', target); else history.pushState(null, '', target);
}

const typing = (t) => Boolean(t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]'));

export default async function (el, ctx) {
  const q = ctx.query;
  const owners = q.tab === 'owners';
  const view = { live: new Map(), rows: [], kind: 'repo', keyOf: null, open: null };
  let openKey = q.open || '';
  let trs = [];

  const rowIndex = (key) => view.rows.findIndex((r) => lc(view.keyOf(r)) === lc(key));
  const mark = () => {
    trs.forEach((tr, i) => {
      const key = lc(view.keyOf(view.rows[i]));
      const selected = selection.key !== null && key === lc(selection.key);
      tr.classList.toggle('is-selected', selected);
      tr.classList.toggle('is-open', Boolean(openKey) && key === lc(openKey));
      if (selected) tr.setAttribute('aria-current', 'true'); else tr.removeAttribute('aria-current');
    });
  };
  const select = (key, { scroll = false } = {}) => {
    selection.key = key;
    mark();
    const i = rowIndex(key);
    if (scroll && i >= 0 && trs[i]) trs[i].scrollIntoView({ block: 'nearest' });
  };
  const handlers = {
    onOpen: (key) => view.open(key),
    onClose: () => {
      const was = openKey;
      openKey = '';
      writeOpen('');
      closeDetail();
      mark();
      const i = rowIndex(was);
      const back = i >= 0 && trs[i] ? trs[i].querySelector('.row-view') : null;
      if (back) back.focus({ preventScroll: true });
    },
  };
  view.open = (key, { replace = false, focus = true } = {}) => {
    const fresh = !openKey;
    openKey = key;
    if (rowIndex(key) >= 0) selection.key = key;
    writeOpen(key, { replace: replace || !fresh });
    syncDetail(key, handlers);
    mark();
    if (focus) {
      const title = document.getElementById('review-drawer-title');
      if (title) title.focus({ preventScroll: true });
    }
  };

  const content = await (owners ? ownersTab(q, view) : reposTab(q, view));
  el.dataset.reviewPage = '1';
  el.append(
    pageHead({
      title: 'Review',
      lede: 'Decide which repositories and owners count as open source. The rules place everything first; a decision here overrides them and takes effect on the public site straight away.',
      actions: [h('a', { class: 'btn', href: '#/overrides' }, 'See all decisions')],
    }),
    tabs([
      { label: 'Repositories', href: href('/review'), active: !owners },
      { label: 'Owners', href: href('/review', { tab: 'owners' }), active: owners },
    ], { label: 'Review queues' }),
    h('p', { class: 'kbd-hint muted' }, 'Click a row for its pull requests and students. Keyboard: ',
      h('kbd', null, 'j'), ' ', h('kbd', null, 'k'), ' or arrows move, ', h('kbd', null, 'Enter'), ' opens, ',
      h('kbd', null, 'i'), ' includes, ', h('kbd', null, 'e'), ' excludes', owners ? [', ', h('kbd', null, 'n'), ' marks NST internal'] : null, ', ',
      h('kbd', null, 'Esc'), ' closes.'),
    ...content.filter(Boolean));

  // rows: click anywhere that is not a control opens the panel
  trs = view.rows.length ? [...el.querySelectorAll('table.data tbody tr')].slice(0, view.rows.length) : [];
  trs.forEach((tr, i) => {
    const key = view.keyOf(view.rows[i]);
    tr.classList.add('row-click');
    tr.dataset.key = key;
    tr.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.target.closest('a, button, input, select, textarea, label')) return;
      if (String(window.getSelection && window.getSelection()) !== '') return; // the admin is selecting text
      view.open(key);
    });
  });
  if (selection.key !== null && rowIndex(selection.key) < 0) selection.key = null;
  mark();

  // the panel follows the hash (deep link, Back / Forward)
  syncDetail(openKey, handlers);

  // a decision shows on its row at once; the list itself is fetched again right after (decisions.js)
  const stop = onDecision(({ kind, res }) => {
    if (kind === 'repo' && !owners) {
      const item = view.live.get(lc(res.repo.name));
      if (item) { Object.assign(item.row, res.repo); item.redraw(); }
    } else if (kind === 'owner' && owners) {
      const item = view.live.get(lc(res.org.login));
      if (item) { Object.assign(item.row, res.org); item.redraw(); }
    } else if (kind === 'owner') {
      for (const item of view.live.values()) {
        if (lc(item.row.owner) === lc(res.org.login)) { item.row.ownerOverride = res.org.override; item.redraw(); }
      }
    }
  });

  const move = (step) => {
    if (!view.rows.length) return;
    const at = selection.key === null ? -1 : rowIndex(selection.key);
    const next = at < 0 ? (step > 0 ? 0 : view.rows.length - 1) : Math.min(view.rows.length - 1, Math.max(0, at + step));
    const key = view.keyOf(view.rows[next]);
    select(key, { scroll: true });
    if (openKey && lc(openKey) !== lc(key)) view.open(key, { replace: true, focus: false });
  };
  const decideByKey = (value) => {
    const subject = openKey ? detailSubject() : null;
    let kind = view.kind;
    let row = null;
    if (subject) ({ kind, row } = subject);
    else if (!openKey && selection.key !== null) row = view.rows[rowIndex(selection.key)] || null;
    if (!row) { toast(openKey ? 'The details are still loading.' : 'Pick a row first: press j or click one.', 'error'); return; }
    if (value === 'nst_internal' && kind !== 'owner') return;
    const already = alreadyText(kind, row, value);
    if (already) { toast(`${kind === 'repo' ? row.name : row.login}: ${already.charAt(0).toLowerCase()}${already.slice(1)}.`); return; }
    if (kind === 'repo') decideRepo(row, value); else decideOwner(row, value);
  };
  const onKey = (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !el.isConnected || el.hidden) return;
    if (document.querySelector('dialog[open]') || typing(e.target)) return;
    const inDrawer = Boolean(e.target.closest && e.target.closest('.drawer'));
    const onControl = Boolean(e.target.closest && e.target.closest('a, button, summary, [role="tab"]'));
    switch (e.key) {
      case 'Escape':
        if (!openKey) return;
        handlers.onClose();
        break;
      case 'j': move(1); break;
      case 'k': move(-1); break;
      case 'ArrowDown': if (inDrawer) return; move(1); break;
      case 'ArrowUp': if (inDrawer) return; move(-1); break;
      case 'Enter':
        if (onControl || selection.key === null || rowIndex(selection.key) < 0) return;
        view.open(selection.key);
        break;
      case 'i': decideByKey('include'); break;
      case 'e': decideByKey('exclude'); break;
      case 'n': if (view.kind !== 'owner' && !(openKey && detailSubject() && detailSubject().kind === 'owner')) return; decideByKey('nst_internal'); break;
      default: return;
    }
    e.preventDefault();
  };
  document.addEventListener('keydown', onKey);

  return () => {
    stop();
    document.removeEventListener('keydown', onKey);
    // leaving Review (another page, or the sign-in form) closes the panel; a re-render of the queue does not
    setTimeout(() => { if (!document.querySelector('[data-review-page]')) closeDetail(); }, 0);
  };
}
