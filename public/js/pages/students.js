// Students: ranked, filterable table. GET /students.

import { api } from '../lib/api.js';
import { setQuery } from '../lib/router.js';
import { h, pageHead, filterBar, table, pagination, card, mixBar, mixLegend, barCell, fmt } from '../lib/ui.js';
import { getMeta, hasContributions, rangeParams, rangeControl, rangeLine, rangeSentence, isPastRange, yearLabel, studentCell, campusLink, csvButton, opts, clean, put } from './common.js';

export default async function (el, ctx) {
  const meta = await getMeta();
  const q = ctx.query;
  const contrib = hasContributions(meta);
  const filters = clean({ q: q.q, campus: q.campus, year: q.year, batch: q.batch, hasOs: q.hasOs, hasContribution: contrib ? q.hasContribution : '', ...rangeParams(q, meta) });
  const data = await api.get('/students', { ...filters, sort: q.sort, order: q.order, page: q.page });
  const sort = q.sort || 'osMerged';
  const order = q.order || (sort === 'name' ? 'asc' : 'desc');
  const max = data.items.reduce((m, s) => Math.max(m, s.stats.osMerged), 0);
  const any = Boolean(q.q || q.campus || q.year || q.batch || q.hasOs || (contrib && q.hasContribution));
  const lastAt = (s) => s.stats.lastActivityAt || s.stats.lastPrAt;
  const past = isPastRange(data.range, meta);
  const period = rangeSentence(data.range) || null;

  put(el, 
    pageHead({
      title: 'Students',
      range: rangeLine(data.range),
      lede: ['Every tracked student, ranked by merged open-source pull requests unless you sort otherwise. ',
        data.range ? (contrib ? 'The numbers count pull requests opened or merged, issues raised and reviews given in the period above.' : 'The numbers count pull requests opened or merged in the period above.') : null,
        past ? ' Year of study is as of today; the batch is shown beside it.' : null],
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
        contrib ? { name: 'hasContribution', label: 'With any open-source contribution', type: 'checkbox' } : null,
      ].filter(Boolean),
      values: q,
      onChange: (v) => setQuery({ ...v, page: '' }),
    }),
    card({ flush: true },
      mixLegend(),
      table({
        caption: 'Students',
        rows: data.items,
        sort, order,
        onSort: (s, o) => setQuery({ sort: s, order: o, page: '' }),
        empty: any ? 'No students match these filters.' : 'No data yet. An admin needs to import or add students.',
        columns: [
          { key: 'name', label: 'Student', sortable: true, render: (s) => studentCell(s, ctx) },
          { key: 'campus', label: 'Campus', render: (s) => campusLink(s.campus, ctx) },
          { key: 'year', label: 'Year', render: (s) => yearLabel(s, past) },
          { key: 'stats.osMerged', sortKey: 'osMerged', label: 'Merged open-source', num: true, sortable: true, render: (s) => barCell(s.stats.osMerged, max) },
          { key: 'stats.osPrs', sortKey: 'osPrs', label: 'Open-source PRs', num: true, sortable: true },
          contrib ? { key: 'stats.osOpen', sortKey: 'osOpen', label: 'Open PRs', num: true, sortable: true, title: 'Open-source pull requests still open', render: (s) => fmt.num(s.stats.osOpen ?? 0) } : null,
          contrib ? { key: 'stats.osIssues', sortKey: 'osIssues', label: 'Issues', num: true, sortable: true, title: 'Issues raised in open-source projects', render: (s) => fmt.num(s.stats.osIssues ?? 0) } : null,
          contrib ? { key: 'stats.osReviews', sortKey: 'osReviews', label: 'Reviews', num: true, sortable: true, title: 'Pull requests of other people reviewed in open-source projects', render: (s) => fmt.num(s.stats.osReviews ?? 0) } : null,
          { key: 'stats.osMajorMerged', label: 'Major merged', num: true, title: 'Merged into major projects' },
          { key: 'stats.osRepos', label: 'Projects', num: true, title: 'Open-source projects contributed to' },
          { key: 'stats.totalPrs', sortKey: 'totalPrs', label: 'All PRs', num: true, sortable: true },
          { key: 'mix', label: 'Mix', title: 'All pull requests by category', render: (s) => mixBar(s.stats.byCategory, { merged: s.stats.osMerged, period }) },
          {
            // with contributions the column and its sort are the latest PR, issue or review (lastActivityAt)
            key: contrib ? 'stats.lastActivityAt' : 'stats.lastPrAt', sortKey: contrib ? 'lastActivityAt' : 'lastPrAt',
            label: contrib ? 'Last activity' : 'Last PR', sortable: true, num: true,
            title: contrib ? 'Latest pull request, issue or review' : 'Latest pull request',
            render: (s) => (lastAt(s) ? h('span', { title: fmt.date(lastAt(s)) }, fmt.rel(lastAt(s))) : null),
          },
        ].filter(Boolean),
      }),
      pagination({ ...data, onPage: (page) => setQuery({ page: page > 1 ? page : '' }) })),
  );
}
