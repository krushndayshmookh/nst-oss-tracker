// Pull-request explorer. GET /prs with every filter; author / repo / owner arrive from links elsewhere.
// With SPEC addendum I (meta.features.contributions) it is the Contributions page: tabs Pull requests | Issues |
// Reviews (`?kind=issue|review`, empty = pull requests); the Issues and Reviews tabs read GET /contributions.

import { api } from '../lib/api.js';
import { setQuery } from '../lib/router.js';
import { h, pageHead, filterBar, pagination, card, tabs, TIERS, TIER_LABELS, STATE_LABELS } from '../lib/ui.js';
import {
  getMeta, hasRanges, rangeParams, rangeControl, rangeLine, link, repoHref, orgHref, categoryOptions, csvButton, opts, clean, prTable, put,
  hasContributions, contributionTable, KIND_LABELS, ISSUE_STATE_LABELS, REVIEW_STATE_LABELS,
} from './common.js';

/** State filter values per kind (SPEC addendum I5); a value of another kind is never sent. */
const STATES = {
  pr: ['open', 'merged', 'closed'].map((s) => ({ value: s, label: STATE_LABELS[s] })),
  issue: Object.entries(ISSUE_STATE_LABELS).map(([value, label]) => ({ value, label })),
  review: Object.entries(REVIEW_STATE_LABELS).map(([value, label]) => ({ value, label })),
};
const CONTRIB_SORTS = ['createdAt', 'stars', 'lastReviewedAt'];
const NOUNS = { pr: 'pull requests', issue: 'issues', review: 'reviews' };

export default async function (el, ctx) {
  const meta = await getMeta();
  const q = ctx.query;
  const ranged = hasRanges(meta);
  const contrib = hasContributions(meta);
  const kind = contrib && (q.kind === 'issue' || q.kind === 'review') ? q.kind : 'pr';
  const isPr = kind === 'pr';
  // the PR tab passes its state through as before; issues and reviews only send a state of their own kind
  const state = isPr ? q.state : (STATES[kind].some((o) => o.value === q.state) ? q.state : '');
  const dates = ranged ? rangeParams(q, meta) : { from: q.from, to: q.to };
  const filters = clean({
    q: q.q, category: q.category, state, tier: q.tier, campus: q.campus, year: q.year, batch: q.batch,
    author: q.author, repo: q.repo, owner: q.owner, ...dates,
  });
  const sort = isPr ? (q.sort || 'createdAt') : (CONTRIB_SORTS.includes(q.sort) ? q.sort : 'createdAt');
  const order = q.order || 'desc';
  const data = isPr
    ? await api.get('/prs', { ...filters, sort: q.sort, order: q.order, page: q.page })
    : await api.get('/contributions', { kind, ...filters, sort: q.sort && sort, order: q.order, page: q.page });
  const noun = NOUNS[kind];
  const inRange = Boolean(data.range && (data.range.from || data.range.to));
  const into = isPr ? 'to ' : 'in ';

  const scopes = [
    q.author && ['by ', h('a', { href: link(`/students/${encodeURIComponent(q.author)}`, {}, ctx) }, q.author)],
    q.repo && [into, h('a', { href: repoHref(q.repo, ctx) }, q.repo)],
    q.owner && [`${into}projects of `, h('a', { href: orgHref(q.owner, ctx) }, q.owner)],
  ].filter(Boolean);

  const lede = {
    pr: ['Every pull request by a tracked student to a public repository. Open-source ones are shown unless you choose another category. ',
      inRange ? (q.state === 'merged' ? 'Listed: pull requests merged in the period.' : 'Listed: pull requests opened in the period, and those merged in it.') : null],
    issue: ['Every issue a tracked student raised in a public repository. Open-source ones are shown unless you choose another category. ',
      inRange ? 'Listed: issues opened in the period.' : null],
    review: ['Every review a tracked student gave on another person’s pull request in a public repository, one row per pull request. Open-source ones are shown unless you choose another category. ',
      inRange ? 'Listed: pull requests the student first reviewed in the period.' : null],
  }[kind];
  // switching tabs keeps the filters that every kind shares, and drops state, sort and page
  const carry = clean({ q: q.q, category: q.category, tier: q.tier, campus: q.campus, year: q.year, batch: q.batch, author: q.author, repo: q.repo, owner: q.owner });
  const dateWord = kind === 'review' ? 'First reviewed' : 'Opened';

  put(el, 
    pageHead({
      title: contrib ? 'Contributions' : 'Pull requests',
      lede,
      range: rangeLine(data.range),
      actions: [isPr ? csvButton('/export/prs.csv', filters) : csvButton('/export/contributions.csv', { kind, ...filters })],
    }),
    rangeControl(meta, ctx),
    contrib ? tabs(['pr', 'issue', 'review'].map((k) => ({
      label: KIND_LABELS[k], href: link('/prs', { ...carry, kind: k === 'pr' ? '' : k }, ctx), active: k === kind,
      count: k === kind ? data.total : null,
    })), { label: 'Contribution type' }) : null,
    filterBar({
      fields: [
        { name: 'q', label: 'Search', type: 'search', placeholder: 'Title or project' },
        { name: 'category', label: 'Category', type: 'select', options: categoryOptions() },
        { name: 'state', label: kind === 'review' ? 'Verdict' : 'State', type: 'select', options: STATES[kind] },
        { name: 'tier', label: 'Tier', type: 'select', options: TIERS.map((t) => ({ value: t, label: TIER_LABELS[t] })) },
        { name: 'campus', label: 'Campus', type: 'select', options: opts(meta.campuses) },
        { name: 'year', label: 'Year', type: 'select', options: opts(meta.years) },
        ...(ranged ? [] : [
          { name: 'from', label: `${dateWord} from`, type: 'date' },
          { name: 'to', label: `${dateWord} to`, type: 'date' },
        ]),
      ],
      values: { ...q, state },
      onChange: (v) => setQuery({ ...v, page: '' }),
    }),
    scopes.length ? h('div', { class: 'notice' }, `Showing ${noun} `, scopes.map((s, i) => [i ? ' ' : null, s]), '. ',
      h('button', { type: 'button', class: 'btn btn-link', name: 'scope-clear', onClick: () => setQuery({ author: '', repo: '', owner: '', page: '' }) }, 'Show everyone')) : null,
    card({ flush: true },
      isPr
        ? prTable(data.items, ctx, { sort, order, onSort: (s, o) => setQuery({ sort: s, order: o, page: '' }), student: !q.author, project: !q.repo })
        : contributionTable(data.items, ctx, { kind, sort, order, onSort: (s, o) => setQuery({ sort: s, order: o, page: '' }), student: !q.author, project: !q.repo }),
      pagination({ ...data, onPage: (page) => setQuery({ page: page > 1 ? page : '' }) })),
  );
}
