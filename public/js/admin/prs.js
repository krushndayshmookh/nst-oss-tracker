// Admin → Pull requests. Search every stored pull request (public GET /prs with category=all) and mark single ones
// as open source or not.

import { api } from '../lib/api.js';
import { setQuery } from '../lib/router.js';
import {
  h, pageHead, filterBar, table, pagination, card, extLink, ghLink, stateBadge, categoryBadge, overrideBadge, fmt,
  CATEGORIES, CATEGORY_LABELS, STATE_LABELS,
} from '../lib/ui.js';
import { CAMPUSES, YEARS } from './common.js';
import { decidePr, decisionButtons } from './decisions.js';

export default async function (el, ctx) {
  const q = ctx.query;
  // All categories and all time unless the admin narrows it: the public default is open source in the current academic year.
  const dates = q.from || q.to ? { from: q.from, to: q.to } : { range: 'all' };
  const data = await api.get('/prs', {
    q: q.q, author: q.author, repo: q.repo, owner: q.owner, category: q.category || 'all', state: q.state, campus: q.campus, year: q.year,
    ...dates, sort: q.sort, order: q.order, page: q.page, _: Date.now(), // the public API is cacheable; decisions must show at once
  });
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
            render: (p) => h('div', null, extLink(p.title || `#${p.number}`, p.url), h('div', { class: 'sub' }, `${p.repo}#${p.number}`)),
          },
          {
            key: 'author', label: 'Student',
            render: (p) => h('div', null, p.authorName || p.author, h('div', { class: 'sub' }, ghLink(p.author))),
          },
          {
            key: 'stars', label: 'Repository', sortable: true,
            render: (p) => h('div', null, ghLink(p.repo), h('div', { class: 'sub' }, `${fmt.compact(p.stars)} stars · ${p.ownerType === 'User' ? 'personal' : 'organisation'}`)),
          },
          { key: 'state', label: 'State', render: (p) => stateBadge(p.isDraft && p.state === 'open' ? 'draft' : p.state) },
          {
            key: 'category', label: 'Category',
            render: (p) => h('div', null, categoryBadge(p.category, p.tier),
              p.category !== 'open_source' && p.reason && !p.override ? h('div', { class: 'sub' }, `Not counted: ${p.reason.replace(/^admin: /, 'admin, ')}`) : null,
              p.category === 'open_source' && /^admin/.test(p.reason || '') && !p.override ? h('div', { class: 'sub' }, p.reason.replace(/^admin: /, 'Admin: ')) : null,
              p.override ? h('div', { class: 'sub' }, overrideBadge(p.override, p.overrideNote), p.overrideNote ? ` ${p.overrideNote}` : null) : null),
          },
          { key: 'createdAt', label: 'Opened', sortable: true, num: true, render: (p) => fmt.date(p.createdAt) },
          {
            key: 'decision', label: 'Decision',
            render: (p) => decisionButtons({
              name: p.url, current: p.override,
              options: [{ value: 'open_source', label: 'Open source' }, { value: 'not_open_source', label: 'Not open source', danger: true }],
              onPick: (value, btn) => decidePr(p, value, btn),
            }),
          },
        ],
      }),
      pagination({ ...data, onPage: (page) => setQuery({ page: page > 1 ? page : '' }) })));
}
