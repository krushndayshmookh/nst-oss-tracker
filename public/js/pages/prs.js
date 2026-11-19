// Pull-request explorer. GET /prs with every filter; author / repo / owner arrive from links elsewhere.

import { api } from '../lib/api.js';
import { setQuery } from '../lib/router.js';
import { h, pageHead, filterBar, pagination, card, TIERS, TIER_LABELS, STATE_LABELS } from '../lib/ui.js';
import {
  getMeta, hasRanges, rangeParams, rangeControl, rangeSentence, link, repoHref, orgHref, categoryOptions, csvButton, opts, clean, prTable,
} from './common.js';

export default async function (el, ctx) {
  const meta = await getMeta();
  const q = ctx.query;
  const ranged = hasRanges(meta);
  const dates = ranged ? rangeParams(q, meta) : { from: q.from, to: q.to };
  const filters = clean({
    q: q.q, category: q.category, state: q.state, tier: q.tier, campus: q.campus, year: q.year, batch: q.batch,
    author: q.author, repo: q.repo, owner: q.owner, ...dates,
  });
  const data = await api.get('/prs', { ...filters, sort: q.sort, order: q.order, page: q.page });
  const sort = q.sort || 'createdAt';
  const order = q.order || 'desc';

  const scopes = [
    q.author && ['by ', h('a', { href: link(`/students/${encodeURIComponent(q.author)}`, {}, ctx) }, q.author)],
    q.repo && ['to ', h('a', { href: repoHref(q.repo, ctx) }, q.repo)],
    q.owner && ['to projects of ', h('a', { href: orgHref(q.owner, ctx) }, q.owner)],
  ].filter(Boolean);

  el.append(
    pageHead({
      title: 'Pull requests',
      lede: ['Every pull request by a tracked student to a public repository. Open-source ones are shown unless you choose another category. ', rangeSentence(data.range)],
      actions: [csvButton('/export/prs.csv', filters)],
    }),
    rangeControl(meta, ctx),
    filterBar({
      fields: [
        { name: 'q', label: 'Search', type: 'search', placeholder: 'Title or project' },
        { name: 'category', label: 'Category', type: 'select', options: categoryOptions() },
        { name: 'state', label: 'State', type: 'select', options: ['open', 'merged', 'closed'].map((s) => ({ value: s, label: STATE_LABELS[s] })) },
        { name: 'tier', label: 'Tier', type: 'select', options: TIERS.map((t) => ({ value: t, label: TIER_LABELS[t] })) },
        { name: 'campus', label: 'Campus', type: 'select', options: opts(meta.campuses) },
        { name: 'year', label: 'Year', type: 'select', options: opts(meta.years) },
        ...(ranged ? [] : [
          { name: 'from', label: 'Opened from', type: 'date' },
          { name: 'to', label: 'Opened to', type: 'date' },
        ]),
      ],
      values: q,
      onChange: (v) => setQuery({ ...v, page: '' }),
    }),
    scopes.length ? h('div', { class: 'notice' }, 'Showing pull requests ', scopes.map((s, i) => [i ? ' ' : null, s]), '. ',
      h('button', { type: 'button', class: 'btn btn-link', name: 'scope-clear', onClick: () => setQuery({ author: '', repo: '', owner: '', page: '' }) }, 'Show everyone')) : null,
    card({ flush: true },
      prTable(data.items, ctx, { sort, order, onSort: (s, o) => setQuery({ sort: s, order: o, page: '' }), student: !q.author, project: !q.repo }),
      pagination({ ...data, onPage: (page) => setQuery({ page: page > 1 ? page : '' }) })),
  );
}
