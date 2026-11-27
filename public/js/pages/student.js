// Student profile. GET /students/:username; the PR table pages through GET /prs?author=…
// With SPEC addendum I the list card has tabs Pull requests | Issues | Reviews (`?tab=issues|reviews`); the PR tab has
// state chips (`?state=open|merged|closed`, sent to /prs); further issue / review pages come from GET /contributions.

import { api } from '../lib/api.js';
import { setQuery } from '../lib/router.js';
import {
  h, pageHead, statCard, card, table, pagination, tabs, segmented, mixBar, categoryBadge, calendarHeatmap, ghLink, fmt, STATE_LABELS,
} from '../lib/ui.js';
import { barChart } from '../lib/charts.js';
import {
  getMeta, rangeParams, rangeControl, rangeLine, rangeSentence, cohortNodes, link, repoHref, studentName, prTable, fetchActivity, activityCard, put,
  hasContributions, contributionTable, contribHref, KIND_LABELS,
} from './common.js';

const TAB_KIND = { issues: 'issue', reviews: 'review' };
const PR_STATES = ['open', 'merged', 'closed'];
import { techList } from './tech-common.js';

export default async function (el, ctx) {
  const meta = await getMeta();
  const q = ctx.query;
  const range = rangeParams(q, meta);
  const all = q.cat === 'all';
  const page = Number(q.page) > 1 ? Number(q.page) : 1;
  const username = ctx.params.username;
  const contrib = hasContributions(meta);
  const tab = contrib && TAB_KIND[q.tab] ? q.tab : '';
  const prState = contrib && PR_STATES.includes(q.state) ? q.state : '';
  const [data, prPage, contribPage, activity] = await Promise.all([
    api.get(`/students/${encodeURIComponent(username)}`, range),
    tab || (all && page === 1 && !prState) ? null : api.get('/prs', { author: username, category: all ? 'all' : 'open_source', state: prState, page, ...range }),
    tab && page > 1 ? api.get('/contributions', { kind: TAB_KIND[tab], author: username, category: 'all', page, ...range }) : null,
    fetchActivity(meta, { author: username, category: 'all', ...range }),
  ]);
  const s = data.student;
  const st = s.stats;
  const prs = prPage || data.prs;
  const osClosed = st.osClosed ?? Math.max(0, (st.osPrs || 0) - (st.osMerged || 0) - (st.osOpen || 0));
  const profileHref = (query) => link(`/students/${encodeURIComponent(s.username)}`, query, ctx);
  const charts = [];

  const where = cohortNodes(s, ctx, { past: true });
  put(el, 
    pageHead({
      crumbs: [{ label: 'Students', href: link('/students', {}, ctx) }],
      title: studentName(s),
      range: rangeLine(data.range),
      lede: where || null,
      actions: [h('a', { class: 'btn ext', href: `https://github.com/${encodeURIComponent(s.username)}`, target: '_blank', rel: 'noopener noreferrer' }, `${s.username} on GitHub`)],
    }),
    rangeControl(meta, ctx),
    h('div', { class: 'cards' },
      statCard({ key: true, label: 'Merged open-source PRs', value: st.osMerged, sub: st.lastOsMergedAt ? `last merged ${fmt.rel(st.lastOsMergedAt)}` : null }),
      statCard({ label: 'Open-source PRs', value: st.osPrs, sub: contrib ? `${fmt.num(st.osOpen)} open, ${fmt.num(osClosed)} closed without merge` : `${fmt.num(st.osOpen)} open` }),
      contrib ? statCard({ label: 'Issues raised', value: st.osIssues ?? 0, sub: `in open source, ${fmt.num(st.totalIssues ?? 0)} in all`, href: profileHref({ tab: 'issues' }), title: 'See the issues' }) : null,
      contrib ? statCard({ label: 'Reviews given', value: st.osReviews ?? 0, sub: `in open source, ${fmt.num(st.totalReviews ?? 0)} in all`, href: profileHref({ tab: 'reviews' }), title: 'See the reviews' }) : null,
      statCard({ label: 'Merged into major projects', value: st.osMajorMerged }),
      statCard({ label: 'Open-source projects', value: st.osRepos, sub: `in ${fmt.num(st.osOrgs)} ${st.osOrgs === 1 ? 'organisation' : 'organisations'}` }),
      statCard({ label: 'All PRs', value: st.totalPrs, sub: `${fmt.num(st.mergedPrs)} merged` })),
  );

  const monthly = data.monthly || [];
  const monthCanvas = h('canvas');
  const anyOs = monthly.some((m) => m.osOpened || m.osMerged || (contrib && (m.osIssues || m.osReviews)));
  put(el, h('div', { class: 'grid grid-main' },
    card({ title: contrib ? 'Open-source contributions by month' : 'Open-source pull requests by month', note: monthly.length ? `${fmt.month(monthly[0].month)} to ${fmt.month(monthly[monthly.length - 1].month)}` : null },
      anyOs ? h('div', { class: 'chart-box' }, monthCanvas) : h('p', { class: 'muted' }, contrib ? 'No open-source contributions in these months.' : 'No open-source pull requests in these months.')),
    card({ title: 'What the pull requests are' },
      h('div', { class: 'stack' },
        st.totalPrs ? mixBar(st.byCategory, { merged: st.osMerged, period: rangeSentence(data.range) || null, legend: true, large: true }) : h('p', { class: 'muted' }, 'No public pull requests in this period.'),
        h('dl', { class: 'facts' },
          h('dt', null, 'First PR'), h('dd', null, fmt.date(st.firstPrAt)),
          h('dt', null, 'Latest PR'), h('dd', null, fmt.date(st.lastPrAt)),
          h('dt', null, 'Latest merged open-source PR'), h('dd', null, fmt.date(st.lastOsMergedAt))),
        h('p', { class: 'card-note' }, h('a', { href: link('/about', {}, ctx) }, 'How categories work'))))));

  // language / technology-area mix of everything the student sent in the period (SPEC addendum H)
  const tech = data.tech || null;
  if (tech && ((tech.language || []).length || (tech.domain || []).length)) {
    const opts = { ctx, all: true, n: 6, value: (r) => r.prs, text: (r) => `${fmt.num(r.prs)} PRs`,
      note: (r) => (r.osMerged ? `${fmt.num(r.osMerged)} merged open source` : `${fmt.num(r.merged)} merged`) };
    put(el,
      h('div', { class: 'section-head' }, h('h2', null, 'Technologies'),
        h('span', { class: 'muted' }, 'Every pull request in the period, by its project’s main language and technology area. ', h('a', { href: link('/tech', {}, ctx) }, 'All students'))),
      h('div', { class: 'grid grid-2' },
        card({ title: 'Languages' }, techList(tech.language || [], { ...opts, by: 'language', empty: 'No pull requests in this period.' })),
        card({ title: 'Technology areas' }, techList(tech.domain || [], { ...opts, by: 'domain', empty: 'No pull requests in this period.' }))));
  }

  const strip = activityCard(activity, ctx, { card, calendarHeatmap, linkQuery: { author: s.username } });
  if (strip) put(el, strip.el);

  put(el, card({ title: 'Projects contributed to', note: `${fmt.num(data.repos.length)}${data.repos.length === 100 ? '+' : ''}`, flush: true },
    table({
      caption: 'Projects contributed to', compact: true, rows: data.repos, empty: 'No pull requests in this period.',
      columns: [
        { key: 'name', label: 'Project', render: (r) => h('span', null, h('a', { href: repoHref(r.name, ctx) }, r.name), ' ', ghLink(r.name, 'GitHub')) },
        { key: 'category', label: 'Category', render: (r) => categoryBadge(r.category, r.tier) },
        { key: 'stars', label: 'Stars', num: true, render: (r) => h('span', { title: fmt.num(r.stars) }, fmt.compact(r.stars)) },
        { key: 'prs', label: 'PRs', num: true },
        { key: 'merged', label: 'Merged', num: true },
        { key: 'lastPrAt', label: 'Last PR', num: true, render: (r) => fmt.date(r.lastPrAt) },
      ],
    })));

  const onPage = (p) => setQuery({ page: p > 1 ? p : '' });
  const kindTabs = contrib ? tabs([
    { label: KIND_LABELS.pr, value: '', count: st.totalPrs, active: !tab },
    { label: KIND_LABELS.issue, value: 'issues', count: (data.issues && data.issues.total) ?? st.totalIssues ?? 0, active: tab === 'issues' },
    { label: KIND_LABELS.review, value: 'reviews', count: (data.reviews && data.reviews.total) ?? st.totalReviews ?? 0, active: tab === 'reviews' },
  ], { onSelect: (v) => setQuery({ tab: v, page: '', state: '', cat: '' }), label: 'Contribution type' }) : null;
  if (tab) {
    const kind = TAB_KIND[tab];
    const block = contribPage || data[tab] || { items: [], total: 0, page: 1, limit: 25 };
    put(el, card({ title: 'Contributions', flush: true },
      kindTabs,
      h('div', { class: 'card-tools' },
        h('span', { class: 'muted' }, kind === 'issue' ? 'Issues in every category, newest first.' : 'Reviews on other people’s pull requests in every category, newest first.'),
        h('span', { class: 'spacer' }),
        h('a', { href: contribHref(kind, { author: s.username, category: 'all' }, ctx) }, 'Open in Contributions')),
      contributionTable(block.items, ctx, { kind, student: false, empty: kind === 'issue' ? 'No issues raised in this period.' : 'No reviews given in this period.' }),
      pagination({ ...block, onPage })));
  } else {
    const stateChips = contrib ? h('div', { class: 'card-tools' }, segmented({
      name: 'state', label: 'Pull request state', value: prState,
      options: [{ value: '', label: 'All' }, ...PR_STATES.map((v) => ({ value: v, label: STATE_LABELS[v] }))],
      onChange: (v) => setQuery({ state: v, page: '' }),
    })) : null;
    put(el, card({ title: contrib ? 'Contributions' : 'Pull requests', flush: true },
      kindTabs,
      tabs([
        { label: 'Open source', value: '', count: all ? st.osPrs : prs.total, active: !all },
        { label: 'All', value: 'all', count: all ? prs.total : st.totalPrs, active: all },
      ], { onSelect: (v) => setQuery({ cat: v, page: '' }), label: 'Pull request category' }),
      stateChips,
      prTable(prs.items, ctx, {
        student: false,
        empty: prState ? `No ${STATE_LABELS[prState].toLowerCase()} pull requests in this period.`
          : all ? 'No public pull requests in this period.' : 'No open-source pull requests in this period. The All tab shows every pull request.',
      }),
      pagination({ ...prs, onPage })));
  }

  if (anyOs) {
    charts.push(barChart(monthCanvas, {
      labels: monthly.map((m) => m.month),
      series: [
        { label: 'Opened', data: monthly.map((m) => m.osOpened), color: 1 },
        { label: 'Merged', data: monthly.map((m) => m.osMerged), color: 'merged' },
        ...(contrib ? [
          { label: 'Issues raised', data: monthly.map((m) => m.osIssues ?? 0), color: 3 },
          { label: 'Reviews given', data: monthly.map((m) => m.osReviews ?? 0), color: 4 },
        ] : []),
      ],
      label: contrib
        ? `Open-source pull requests opened and merged, issues raised and reviews given per month by ${studentName(s)}`
        : `Open-source pull requests opened and merged per month by ${studentName(s)}`,
    }));
  }
  if (strip) charts.push(strip.draw(barChart));
  return () => charts.forEach((c) => c.destroy());
}
