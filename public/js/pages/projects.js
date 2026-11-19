// Projects: repositories students have sent pull requests to. GET /repos.

import { api } from '../lib/api.js';
import { setQuery } from '../lib/router.js';
import { h, pageHead, filterBar, table, pagination, card, barCell, tierBadge, categoryBadge, ghLink, fmt, TIERS, TIER_LABELS } from '../lib/ui.js';
import { getMeta, rangeParams, rangeControl, rangeLine, repoHref, orgHref, categoryOptions, clean, put } from './common.js';

export default async function (el, ctx) {
  const meta = await getMeta();
  const q = ctx.query;
  const filters = clean({ q: q.q, category: q.category, tier: q.tier, owner: q.owner, ...rangeParams(q, meta) });
  const data = await api.get('/repos', { ...filters, sort: q.sort, order: q.order, page: q.page });
  const sort = q.sort || 'prs';
  const order = q.order || 'desc';
  const openSource = !q.category;
  const max = data.items.reduce((m, r) => Math.max(m, r.stats.merged), 0);

  put(el, 
    pageHead({
      title: 'Projects',
      lede: [openSource
        ? 'Public projects that count as open source here and have received pull requests from NST students. '
        : 'Repositories that have received pull requests from NST students. ',
      data.range && (data.range.from || data.range.to) ? 'Only projects with a pull request opened or merged in the period are listed.' : null],
      range: rangeLine(data.range),
    }),
    rangeControl(meta, ctx),
    filterBar({
      fields: [
        { name: 'q', label: 'Search', type: 'search', placeholder: 'Project name or description' },
        { name: 'category', label: 'Category', type: 'select', options: categoryOptions() },
        { name: 'tier', label: 'Tier', type: 'select', options: TIERS.map((t) => ({ value: t, label: TIER_LABELS[t] })) },
      ],
      values: q,
      onChange: (v) => setQuery({ ...v, page: '' }),
    }),
    q.owner ? h('div', { class: 'notice' }, 'Showing projects owned by ', h('a', { href: orgHref(q.owner, ctx) }, q.owner), '. ',
      h('button', { type: 'button', class: 'btn btn-link', onClick: () => setQuery({ owner: '', page: '' }) }, 'Show every owner')) : null,
    card({ flush: true },
      table({
        caption: 'Projects',
        rows: data.items,
        sort, order,
        onSort: (s, o) => setQuery({ sort: s, order: o, page: '' }),
        empty: 'No projects match these filters.',
        columns: [
          {
            key: 'name', label: 'Project', wrap: true,
            render: (r) => h('div', null,
              h('a', { href: repoHref(r.name, ctx) }, r.name), ' ', ghLink(r.name, 'GitHub'),
              r.description ? h('div', { class: 'sub cell-clip', title: r.description }, r.description) : null),
          },
          openSource
            ? { key: 'tier', label: 'Tier', render: (r) => tierBadge(r.tier) }
            : { key: 'category', label: 'Category', render: (r) => categoryBadge(r.category, r.tier) },
          { key: 'stars', label: 'Stars', num: true, sortable: true, render: (r) => h('span', { title: fmt.num(r.stars) }, fmt.compact(r.stars)) },
          { key: 'language', label: 'Language' },
          { key: 'stats.students', sortKey: 'students', label: 'Students', num: true, sortable: true },
          { key: 'stats.prs', sortKey: 'prs', label: 'PRs', num: true, sortable: true },
          { key: 'stats.merged', sortKey: 'merged', label: 'Merged', num: true, sortable: true, render: (r) => barCell(r.stats.merged, max) },
          { key: 'campuses', label: 'Campuses', render: (r) => (r.stats.campuses || []).join(', ') },
          { key: 'lastPrAt', label: 'Last PR', num: true, render: (r) => (r.stats.lastPrAt ? h('span', { title: fmt.date(r.stats.lastPrAt) }, fmt.rel(r.stats.lastPrAt)) : null) },
        ],
      }),
      pagination({ ...data, onPage: (page) => setQuery({ page: page > 1 ? page : '' }) })),
  );
}
