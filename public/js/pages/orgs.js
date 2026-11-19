// Organisations (repository owners). GET /orgs.

import { api } from '../lib/api.js';
import { setQuery } from '../lib/router.js';
import { h, pageHead, filterBar, table, pagination, card, barCell, ghLink, fmt } from '../lib/ui.js';
import { getMeta, rangeParams, rangeControl, rangeSentence, orgHref, clean, put } from './common.js';

export default async function (el, ctx) {
  const meta = await getMeta();
  const q = ctx.query;
  const filters = clean({ q: q.q, category: q.category, ...rangeParams(q, meta) });
  const data = await api.get('/orgs', { ...filters, sort: q.sort, order: q.order, page: q.page });
  const sort = q.sort || 'osMerged';
  const order = q.order || 'desc';
  const max = data.items.reduce((m, o) => Math.max(m, o.stats.osMerged), 0);

  put(el, 
    pageHead({
      title: 'Organisations',
      lede: [q.category === 'all'
        ? 'Every account that owns a repository students have sent pull requests to, including their own. '
        : 'Organisations and maintainers whose open-source projects have received pull requests from NST students. ', rangeSentence(data.range)],
    }),
    rangeControl(meta, ctx),
    filterBar({
      fields: [
        { name: 'q', label: 'Search', type: 'search', placeholder: 'Organisation name' },
        { name: 'category', label: 'Show', type: 'select', options: [{ value: '', label: 'Open source' }, { value: 'all', label: 'All owners' }] },
      ],
      values: q,
      onChange: (v) => setQuery({ ...v, page: '' }),
    }),
    card({ flush: true },
      table({
        caption: 'Organisations',
        rows: data.items,
        sort, order,
        onSort: (s, o) => setQuery({ sort: s, order: o, page: '' }),
        empty: 'No organisations match these filters.',
        columns: [
          {
            key: 'login', label: 'Organisation',
            render: (o) => h('div', null,
              h('a', { href: orgHref(o.login, ctx) }, o.login), ' ', ghLink(o.login, 'GitHub'),
              o.type === 'User' ? h('div', { class: 'sub' }, 'Personal account') : null),
          },
          { key: 'stats.osMerged', sortKey: 'osMerged', label: 'Merged open-source', num: true, sortable: true, render: (o) => barCell(o.stats.osMerged, max) },
          { key: 'stats.osPrs', sortKey: 'osPrs', label: 'Open-source PRs', num: true, sortable: true },
          { key: 'stats.students', sortKey: 'students', label: 'Students', num: true, sortable: true },
          { key: 'stats.repos', label: 'Projects', num: true },
          { key: 'stats.maxStars', label: 'Top project stars', num: true, render: (o) => h('span', { title: fmt.num(o.stats.maxStars) }, fmt.compact(o.stats.maxStars)) },
          { key: 'stats.prs', sortKey: 'prs', label: 'All PRs', num: true, sortable: true },
        ],
      }),
      pagination({ ...data, onPage: (page) => setQuery({ page: page > 1 ? page : '' }) })),
  );
}
