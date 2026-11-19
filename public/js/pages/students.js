// Students: ranked, filterable table. GET /students.

import { api } from '../lib/api.js';
import { setQuery } from '../lib/router.js';
import { h, pageHead, filterBar, table, pagination, card, categoryBar, barCell, fmt } from '../lib/ui.js';
import { getMeta, rangeParams, rangeControl, rangeSentence, studentCell, csvButton, opts, clean } from './common.js';

export default async function (el, ctx) {
  const meta = await getMeta();
  const q = ctx.query;
  const filters = clean({ q: q.q, campus: q.campus, year: q.year, batch: q.batch, hasOs: q.hasOs, ...rangeParams(q, meta) });
  const data = await api.get('/students', { ...filters, sort: q.sort, order: q.order, page: q.page });
  const sort = q.sort || 'osMerged';
  const order = q.order || (sort === 'name' ? 'asc' : 'desc');
  const max = data.items.reduce((m, s) => Math.max(m, s.stats.osMerged), 0);
  const any = Object.keys(filters).length > 0;

  el.append(
    pageHead({
      title: 'Students',
      lede: ['Every tracked student, ranked by merged open-source pull requests unless you sort otherwise. ', rangeSentence(data.range)],
      actions: [csvButton('/export/students.csv', filters)],
    }),
    rangeControl(meta, ctx),
    filterBar({
      fields: [
        { name: 'q', label: 'Search', type: 'search', placeholder: 'Name or GitHub username' },
        { name: 'campus', label: 'Campus', type: 'select', options: opts(meta.campuses) },
        { name: 'year', label: 'Year', type: 'select', options: opts(meta.years) },
        { name: 'batch', label: 'Batch', type: 'select', options: opts(meta.batches) },
        { name: 'hasOs', label: 'With open-source PRs', type: 'checkbox' },
      ],
      values: q,
      onChange: (v) => setQuery({ ...v, page: '' }),
    }),
    card({ flush: true },
      table({
        caption: 'Students',
        rows: data.items,
        sort, order,
        onSort: (s, o) => setQuery({ sort: s, order: o, page: '' }),
        empty: any ? 'No students match these filters.' : 'No data yet. An admin needs to import or add students.',
        columns: [
          { key: 'name', label: 'Student', sortable: true, render: (s) => studentCell(s, ctx) },
          { key: 'campus', label: 'Campus' },
          { key: 'year', label: 'Year', render: (s) => (s.batch ? h('span', { title: `Batch ${s.batch}` }, s.year) : s.year) },
          { key: 'stats.osMerged', sortKey: 'osMerged', label: 'Merged open-source', num: true, sortable: true, render: (s) => barCell(s.stats.osMerged, max) },
          { key: 'stats.osPrs', sortKey: 'osPrs', label: 'Open-source PRs', num: true, sortable: true },
          { key: 'stats.osMajorMerged', label: 'Major merged', num: true, title: 'Merged into major projects' },
          { key: 'stats.osRepos', label: 'Projects', num: true, title: 'Open-source projects contributed to' },
          { key: 'stats.totalPrs', sortKey: 'totalPrs', label: 'All PRs', num: true, sortable: true },
          { key: 'mix', label: 'Mix', title: 'All pull requests by category', render: (s) => categoryBar(s.stats.byCategory) },
          {
            key: 'stats.lastPrAt', sortKey: 'lastPrAt', label: 'Last PR', sortable: true, num: true,
            render: (s) => (s.stats.lastPrAt ? h('span', { title: fmt.date(s.stats.lastPrAt) }, fmt.rel(s.stats.lastPrAt)) : null),
          },
        ],
      }),
      pagination({ ...data, onPage: (page) => setQuery({ page: page > 1 ? page : '' }) })),
  );
}
