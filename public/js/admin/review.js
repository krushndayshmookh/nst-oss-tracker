// Admin → Review. Triage queues: repositories (GET /admin/review/repos) and owners (GET /admin/review/owners),
// with one-click include / exclude / NST-internal decisions.

import { api } from '../lib/api.js';
import { setQuery, href } from '../lib/router.js';
import {
  h, pageHead, filterBar, table, pagination, card, tabs, badge, categoryBadge, categoryBar, overrideBadge, ghLink, fmt, CATEGORIES, CATEGORY_LABELS,
} from '../lib/ui.js';
import { decideRepo, decideOwner, decisionButtons } from './decisions.js';

const MIN_PRS = ['2', '3', '5', '10', '25', '50'].map((v) => ({ value: v, label: `${v} or more` }));
const DECISION = [{ value: 'none', label: 'Undecided' }, { value: 'any', label: 'Decided' }];
const OWNER_WORD = { include: 'Owner included', exclude: 'Owner excluded', nst_internal: 'Owner marked NST internal' };

const onSort = (sort, order) => setQuery({ sort, order, page: '' });
const onPage = (page) => setQuery({ page: page > 1 ? page : '' });

/** Why a repository is where it is, in words. Reasons from the API are already short phrases. */
function reasonLine(r) {
  if (!r.reason || (r.category === 'open_source' && r.reason === r.tier)) return null;
  const text = r.reason.replace(/^admin: /, 'Admin: ');
  return h('div', { class: 'sub' }, r.category === 'open_source' ? text : `Not counted: ${text}`);
}

async function reposTab(q) {
  const data = await api.get('/admin/review/repos', {
    q: q.q, category: q.category, minPrs: q.minPrs, override: q.override, owner: q.owner, sort: q.sort, order: q.order, page: q.page,
  });
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
              r.isFork ? [' ', badge('Fork')] : null, r.isArchived ? [' ', badge('Archived')] : null,
              h('div', { class: 'sub' }, [r.language, r.description].filter(Boolean).join(' · ') || (r.ownerType === 'User' ? 'Personal repository' : ''))),
          },
          { key: 'stars', label: 'Stars', num: true, sortable: true },
          { key: 'prs', label: 'PRs', num: true, sortable: true, render: (r) => h('a', { href: href('/prs', { repo: r.name }), title: 'See these pull requests' }, fmt.num(r.stats.prs)) },
          { key: 'students', label: 'Students', num: true, sortable: true, render: (r) => fmt.num(r.stats.students) },
          { key: 'merged', label: 'Merged', num: true, sortable: true, render: (r) => fmt.num(r.stats.merged) },
          {
            key: 'category', label: 'Currently',
            render: (r) => h('div', null, categoryBadge(r.category, r.tier), reasonLine(r),
              r.ownerOverride && !r.override ? h('div', { class: 'sub' }, h('span', { class: 'badge badge-override' }, OWNER_WORD[r.ownerOverride] || r.ownerOverride)) : null,
              r.override ? h('div', { class: 'sub' }, overrideBadge(r.override, r.overrideNote), r.overrideNote ? ` ${r.overrideNote}` : null) : null),
          },
          {
            key: 'decision', label: 'Decision',
            render: (r) => decisionButtons({
              name: r.name, current: r.override,
              options: [{ value: 'include', label: 'Include' }, { value: 'exclude', label: 'Exclude', danger: true }],
              onPick: (value, btn) => decideRepo(r, value, btn),
            }),
          },
        ],
      }),
      pagination({ ...data, onPage })),
  ];
}

async function ownersTab(q) {
  const data = await api.get('/admin/review/owners', { q: q.q, minPrs: q.minPrs, override: q.override, sort: q.sort, order: q.order, page: q.page });
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
            render: (o) => h('div', null, ghLink(o.login),
              h('div', { class: 'sub' }, o.type === 'User' ? 'Personal account' : 'Organisation'),
              o.override ? h('div', { class: 'sub' }, overrideBadge(o.override, o.overrideNote), o.overrideNote ? ` ${o.overrideNote}` : null) : null),
          },
          { key: 'repos', label: 'Repos', num: true, sortable: true, render: (o) => h('a', { href: href('/review', { owner: o.login }), title: 'Review these repositories' }, fmt.num(o.stats.repos)) },
          { key: 'prs', label: 'PRs', num: true, sortable: true, render: (o) => h('a', { href: href('/prs', { owner: o.login }), title: 'See these pull requests' }, fmt.num(o.stats.prs)) },
          { key: 'osPrs', label: 'Open-source PRs', num: true, sortable: true, render: (o) => fmt.num(o.stats.osPrs) },
          { key: 'students', label: 'Students', num: true, sortable: true, render: (o) => fmt.num(o.stats.students) },
          { key: 'maxStars', label: 'Top stars', num: true, title: 'Stars of their most-starred repository', render: (o) => fmt.num(o.stats.maxStars) },
          { key: 'mix', label: 'Currently', title: 'How their pull requests are categorised now', width: '120px', render: (o) => categoryBar(o.stats.byCategory) },
          {
            key: 'decision', label: 'Decision',
            render: (o) => decisionButtons({
              name: o.login, current: o.override,
              options: [{ value: 'include', label: 'Include' }, { value: 'exclude', label: 'Exclude', danger: true }, { value: 'nst_internal', label: 'NST internal' }],
              onPick: (value, btn) => decideOwner(o, value, btn),
            }),
          },
        ],
      }),
      pagination({ ...data, onPage })),
  ];
}

export default async function (el, ctx) {
  const q = ctx.query;
  const owners = q.tab === 'owners';
  const content = await (owners ? ownersTab(q) : reposTab(q));
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
    ...content.filter(Boolean));
}
