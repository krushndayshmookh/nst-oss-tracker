// Student profile. GET /students/:username; the PR table pages through GET /prs?author=…

import { api } from '../lib/api.js';
import { setQuery } from '../lib/router.js';
import {
  h, pageHead, statCard, card, table, pagination, tabs, categoryBar, categoryBadge, calendarHeatmap, ghLink, fmt,
} from '../lib/ui.js';
import { barChart } from '../lib/charts.js';
import {
  getMeta, rangeParams, rangeControl, rangeSentence, link, repoHref, studentName, prTable, fetchActivity, activityCard, put
} from './common.js';

export default async function (el, ctx) {
  const meta = await getMeta();
  const q = ctx.query;
  const range = rangeParams(q, meta);
  const all = q.cat === 'all';
  const page = Number(q.page) > 1 ? Number(q.page) : 1;
  const username = ctx.params.username;
  const [data, prPage, activity] = await Promise.all([
    api.get(`/students/${encodeURIComponent(username)}`, range),
    all && page === 1 ? null : api.get('/prs', { author: username, category: all ? 'all' : 'open_source', page, ...range }),
    fetchActivity(meta, { author: username, category: 'all', ...range }),
  ]);
  const s = data.student;
  const st = s.stats;
  const prs = prPage || data.prs;
  const charts = [];

  const where = [s.campus !== 'Unknown' ? s.campus : null, s.year !== 'Unknown' ? s.year : null, s.batch ? `batch ${s.batch}` : null].filter(Boolean).join(', ');
  put(el, 
    pageHead({
      crumbs: [{ label: 'Students', href: link('/students', {}, ctx) }],
      title: studentName(s),
      lede: [where ? `${where}. ` : null, rangeSentence(data.range)],
      actions: [h('a', { class: 'btn ext', href: `https://github.com/${encodeURIComponent(s.username)}`, target: '_blank', rel: 'noopener noreferrer' }, `${s.username} on GitHub`)],
    }),
    rangeControl(meta, ctx),
    h('div', { class: 'cards' },
      statCard({ key: true, label: 'Merged open-source PRs', value: st.osMerged, sub: st.lastOsMergedAt ? `last merged ${fmt.rel(st.lastOsMergedAt)}` : null }),
      statCard({ label: 'Open-source PRs', value: st.osPrs, sub: `${fmt.num(st.osOpen)} open` }),
      statCard({ label: 'Merged into major projects', value: st.osMajorMerged }),
      statCard({ label: 'Open-source projects', value: st.osRepos, sub: `in ${fmt.num(st.osOrgs)} ${st.osOrgs === 1 ? 'organisation' : 'organisations'}` }),
      statCard({ label: 'All PRs', value: st.totalPrs, sub: `${fmt.num(st.mergedPrs)} merged` })),
  );

  const monthly = data.monthly || [];
  const monthCanvas = h('canvas');
  const anyOs = monthly.some((m) => m.osOpened || m.osMerged);
  put(el, h('div', { class: 'grid grid-main' },
    card({ title: 'Open-source pull requests by month', note: monthly.length ? `${fmt.month(monthly[0].month)} to ${fmt.month(monthly[monthly.length - 1].month)}` : null },
      anyOs ? h('div', { class: 'chart-box' }, monthCanvas) : h('p', { class: 'muted' }, 'No open-source pull requests in these months.')),
    card({ title: 'What the pull requests are' },
      h('div', { class: 'stack' },
        st.totalPrs ? categoryBar(st.byCategory, { legend: true, large: true }) : h('p', { class: 'muted' }, 'No public pull requests yet.'),
        h('dl', { class: 'facts' },
          h('dt', null, 'First PR'), h('dd', null, fmt.date(st.firstPrAt)),
          h('dt', null, 'Latest PR'), h('dd', null, fmt.date(st.lastPrAt)),
          h('dt', null, 'Latest merged open-source PR'), h('dd', null, fmt.date(st.lastOsMergedAt))),
        h('p', { class: 'card-note' }, h('a', { href: link('/about', {}, ctx) }, 'How categories work'))))));

  const strip = activityCard(activity, ctx, { card, calendarHeatmap, linkQuery: { author: s.username } });
  if (strip) put(el, strip.el);

  put(el, card({ title: 'Projects contributed to', note: `${fmt.num(data.repos.length)}${data.repos.length === 100 ? '+' : ''}`, flush: true },
    table({
      caption: 'Projects contributed to', compact: true, rows: data.repos, empty: 'No pull requests yet.',
      columns: [
        { key: 'name', label: 'Project', render: (r) => h('span', null, h('a', { href: repoHref(r.name, ctx) }, r.name), ' ', ghLink(r.name, 'GitHub')) },
        { key: 'category', label: 'Category', render: (r) => categoryBadge(r.category, r.tier) },
        { key: 'stars', label: 'Stars', num: true, render: (r) => h('span', { title: fmt.num(r.stars) }, fmt.compact(r.stars)) },
        { key: 'prs', label: 'PRs', num: true },
        { key: 'merged', label: 'Merged', num: true },
        { key: 'lastPrAt', label: 'Last PR', num: true, render: (r) => fmt.date(r.lastPrAt) },
      ],
    })));

  put(el, card({ title: 'Pull requests', flush: true },
    tabs([
      { label: 'Open source', value: '', count: st.osPrs, active: !all },
      { label: 'All', value: 'all', count: st.totalPrs, active: all },
    ], { onSelect: (v) => setQuery({ cat: v, page: '' }), label: 'Pull request category' }),
    prTable(prs.items, ctx, { student: false, empty: all ? 'No public pull requests yet.' : 'No open-source pull requests yet. The All tab shows every pull request.' }),
    pagination({ ...prs, onPage: (p) => setQuery({ page: p > 1 ? p : '' }) })));

  if (anyOs) {
    charts.push(barChart(monthCanvas, {
      labels: monthly.map((m) => m.month),
      series: [
        { label: 'Opened', data: monthly.map((m) => m.osOpened), color: 1 },
        { label: 'Merged', data: monthly.map((m) => m.osMerged), color: 'merged' },
      ],
      label: `Open-source pull requests opened and merged per month by ${studentName(s)}`,
    }));
  }
  if (strip) charts.push(strip.draw(barChart));
  return () => charts.forEach((c) => c.destroy());
}
