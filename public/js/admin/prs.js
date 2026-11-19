// Admin → Pull requests. Search every stored pull request (public GET /prs with category=all) and mark single ones
// as open source or not. The button for the mark a pull request already has is greyed; a tag says where its category
// comes from (by rule, by admin, via repo, via org); a click shows on the row at once.

import { api } from '../lib/api.js';
import { setQuery } from '../lib/router.js';
import {
  h, pageHead, filterBar, table, pagination, card, extLink, ghLink, stateBadge, categoryBadge, fmt,
  CATEGORIES, CATEGORY_LABELS, STATE_LABELS,
} from '../lib/ui.js';
import { CAMPUSES, YEARS } from './common.js';
import { onDecision, prSource, sourceTag, prButtons } from './decisions.js';

const MARK_WORD = { open_source: 'Marked open source', not_open_source: 'Marked not open source' };

function prState(p) {
  const src = prSource(p);
  const reason = String(p.reason || '');
  return [
    categoryBadge(p.category, p.tier), ' ',
    sourceTag(src, { link: src === 'repo' ? p.repo : src === 'org' ? p.owner : null, note: p.overrideNote }),
    src === 'admin' ? h('div', { class: 'sub' }, `${MARK_WORD[p.override] || p.override}${p.overrideNote ? `: ${p.overrideNote}` : ''}`) : null,
    src === 'repo' || src === 'org' ? h('div', { class: 'sub' }, reason.replace(/^admin: /, 'Admin: ')) : null,
    src === 'rule' && p.category !== 'open_source' && reason ? h('div', { class: 'sub' }, `Not counted: ${reason}`) : null,
  ];
}

/** A cell that is drawn again when a decision on its pull request comes back. */
function liveCell(live, p, render) {
  const holder = h('div', { class: 'live-cell' }, render(p));
  const item = live.get(p.url) || { row: p, cells: [] };
  item.cells.push(() => {
    const active = document.activeElement;
    const name = active && holder.contains(active) ? active.getAttribute('name') : null;
    holder.replaceChildren(...h('div', null, render(p)).childNodes);
    const again = name ? holder.querySelector(`[name="${CSS.escape(name)}"]`) : null;
    if (again) again.focus({ preventScroll: true });
  });
  live.set(p.url, item);
  return holder;
}

export default async function (el, ctx) {
  const q = ctx.query;
  // All categories and all time unless the admin narrows it: the public default is open source in the current academic year.
  const dates = q.from || q.to ? { from: q.from, to: q.to } : { range: 'all' };
  const data = await api.get('/prs', {
    q: q.q, author: q.author, repo: q.repo, owner: q.owner, category: q.category || 'all', state: q.state, campus: q.campus, year: q.year,
    ...dates, sort: q.sort, order: q.order, page: q.page, _: Date.now(), // the public API is cacheable; decisions must show at once
  });
  const live = new Map();
  const scoped = [q.author && `by ${q.author}`, q.repo && `in ${q.repo}`, q.owner && `in repositories of ${q.owner}`].filter(Boolean);

  el.append(
    pageHead({
      title: 'Pull requests',
      lede: `${fmt.num(data.total)} pull ${data.total === 1 ? 'request' : 'requests'}${scoped.length ? ` ${scoped.join(' ')}` : ''}. Mark a single pull request as open source or not; that wins over its repository, its owner and the rules.`,
    }),
    filterBar({
      fields: [
        { name: 'q', label: 'Search', type: 'search', placeholder: 'Title or repository' },
        { name: 'author', label: 'Student username', type: 'search', placeholder: 'Exact GitHub username' },
        { name: 'repo', label: 'Repository', type: 'search', placeholder: 'owner/name' },
        { name: 'owner', label: 'Owner', type: 'search', placeholder: 'Organisation or user' },
        { name: 'category', label: 'Category', type: 'select', allLabel: 'All categories', options: CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] })) },
        { name: 'state', label: 'State', type: 'select', options: ['open', 'merged', 'closed'].map((s) => ({ value: s, label: STATE_LABELS[s] })) },
        { name: 'campus', label: 'Campus', type: 'select', options: CAMPUSES },
        { name: 'year', label: 'Year', type: 'select', options: YEARS },
        { name: 'from', label: 'Opened from', type: 'date' },
        { name: 'to', label: 'Opened to', type: 'date' },
      ],
      values: q,
      onChange: (v) => setQuery({ ...v, page: '' }),
    }),
    card({ flush: true },
      table({
        caption: 'Pull requests', compact: true,
        rows: data.items,
        sort: q.sort || 'createdAt', order: q.order || 'desc',
        onSort: (sort, order) => setQuery({ sort, order, page: '' }),
        empty: 'No pull requests match these filters.',
        columns: [
          {
            key: 'title', label: 'Pull request', wrap: true,
            render: (p) => h('div', null, extLink(p.title || `#${p.number}`, p.url),
              h('div', { class: 'sub' }, stateBadge(p.isDraft && p.state === 'open' ? 'draft' : p.state), ` · #${p.number}`)),
          },
          {
            key: 'author', label: 'Student',
            render: (p) => h('div', null, p.authorName || p.author, h('div', { class: 'sub' }, ghLink(p.author))),
          },
          {
            key: 'stars', label: 'Repository', sortable: true,
            render: (p) => h('div', null, ghLink(p.repo), h('div', { class: 'sub' }, `${fmt.compact(p.stars)} stars · ${p.ownerType === 'User' ? 'personal' : 'organisation'}`)),
          },
          { key: 'category', label: 'Category', wrap: true, render: (p) => liveCell(live, p, prState) },
          { key: 'createdAt', label: 'Opened', sortable: true, num: true, render: (p) => fmt.date(p.createdAt) },
          { key: 'decision', label: 'Decision', render: (p) => liveCell(live, p, (row) => prButtons(row, { compact: true })) },
        ],
      }),
      pagination({ ...data, onPage: (page) => setQuery({ page: page > 1 ? page : '' }) })));

  // show a decision on its row at once; decisions.js fetches the list again right after
  return onDecision(({ kind, res }) => {
    if (kind !== 'pr') return;
    const item = live.get(res.pr.url);
    if (!item) return;
    Object.assign(item.row, res.pr);
    for (const redraw of item.cells) redraw();
  });
}
