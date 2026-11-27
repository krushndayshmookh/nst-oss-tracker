// Organisation page. GET /orgs/:login

import { api } from '../lib/api.js';
import { h, pageHead, statCard, card, table, barCell, badge, categoryBadge, mixBar, overrideBadge, calendarHeatmap, fmt, CATEGORIES } from '../lib/ui.js';
import { barChart } from '../lib/charts.js';
import { getMeta, rangeParams, rangeControl, rangeLine, rangeSentence, isPastRange, link, repoHref, contributorsTable, fetchActivity, activityCard, put, hasContributions, contribHref } from './common.js';
import { techList } from './tech-common.js';

export default async function (el, ctx) {
  const meta = await getMeta();
  const range = rangeParams(ctx.query, meta);
  const [data, activity] = await Promise.all([
    api.get(`/orgs/${encodeURIComponent(ctx.params.login)}`, range),
    fetchActivity(meta, { owner: ctx.params.login, category: 'all', ...range }),
  ]);
  const { org } = data;
  const st = org.stats;
  const charts = [];
  const present = CATEGORIES.filter((c) => st.byCategory[c] > 0);
  const max = data.repos.reduce((m, r) => Math.max(m, r.stats.merged), 0);

  put(el, 
    pageHead({
      crumbs: [{ label: 'Organisations', href: link('/orgs', {}, ctx) }],
      title: org.login,
      range: rangeLine(data.range),
      lede: org.type === 'User' ? 'Personal account.' : null,
      actions: [h('a', { class: 'btn ext', href: `https://github.com/${encodeURIComponent(org.login)}`, target: '_blank', rel: 'noopener noreferrer' }, 'View on GitHub')],
    }),
    rangeControl(meta, ctx),
    org.override ? h('div', { class: 'toolbar' }, overrideBadge(org.override, org.overrideNote)) : null,
    h('div', { class: 'cards' },
      statCard({ key: true, label: 'Merged open-source PRs', value: st.osMerged, sub: `of ${fmt.num(st.osPrs)} opened`, href: st.osMerged ? link('/prs', { owner: org.login, state: 'merged' }, ctx) : null }),
      statCard({ label: 'Open-source PRs', value: st.osPrs }),
      statCard({ label: 'Students', value: st.students }),
      statCard({ label: 'Projects', value: st.repos, sub: st.maxStars ? `largest has ${fmt.compact(st.maxStars)} stars` : null }),
      statCard({ label: 'All PRs', value: st.prs, sub: `${fmt.num(st.merged)} merged`, href: link('/prs', { owner: org.login, category: 'all' }, ctx) }),
      // issues and reviews by NST students in this organisation's projects (SPEC addendum I)
      hasContributions(meta) ? [
        statCard({ label: 'Issues raised', value: st.issues ?? 0, sub: `${fmt.num(st.osIssues ?? 0)} in open source`, href: contribHref('issue', { owner: org.login, category: 'all' }, ctx), title: 'See the issues raised in these projects' }),
        statCard({ label: 'Reviews given', value: st.reviews ?? 0, sub: `${fmt.num(st.osReviews ?? 0)} in open source`, href: contribHref('review', { owner: org.login, category: 'all' }, ctx), title: 'See the reviews given in these projects' }),
      ] : null),
    present.length > 1 ? card({ title: 'All pull requests by category' }, mixBar(st.byCategory, { merged: st.osMerged ?? null, period: rangeSentence(data.range) || null, legend: true, large: true })) : null,
  );

  // technology mix of the PRs to this organisation (SPEC addendum H): only worth a card when it has several
  const tech = data.tech || null;
  if (tech && ((tech.language || []).length > 1 || (tech.domain || []).length > 1)) {
    const opts = { ctx, all: true, n: 5, value: (r) => r.prs, text: (r) => `${fmt.num(r.prs)} PRs`, note: (r) => `${fmt.num(r.merged)} merged` };
    put(el, h('div', { class: 'grid grid-2' },
      card({ title: 'Languages of the pull requests' }, techList(tech.language || [], { ...opts, by: 'language' })),
      card({ title: 'Technology areas' }, techList(tech.domain || [], { ...opts, by: 'domain' }))));
  }

  const strip = activityCard(activity, ctx, { card, calendarHeatmap, linkQuery: { owner: org.login, category: 'all' } });
  if (strip) put(el, strip.el);

  put(el, 
    card({ title: 'Projects', note: `${fmt.num(data.repos.length)}${data.repos.length === 100 ? '+' : ''}`, flush: true },
      table({
        caption: `Projects of ${org.login}`, rows: data.repos, empty: 'No projects.',
        columns: [
          {
            key: 'name', label: 'Project', wrap: true,
            render: (r) => h('div', null, h('a', { href: repoHref(r.name, ctx) }, r.name),
              r.isArchived ? [' ', badge('Archived', 'warn')] : null,
              r.description ? h('div', { class: 'sub cell-clip', title: r.description }, r.description) : null),
          },
          { key: 'category', label: 'Category', render: (r) => categoryBadge(r.category, r.tier) },
          { key: 'stars', label: 'Stars', num: true, render: (r) => h('span', { title: fmt.num(r.stars) }, fmt.compact(r.stars)) },
          { key: 'language', label: 'Language' },
          { key: 'stats.students', label: 'Students', num: true },
          { key: 'stats.prs', label: 'PRs', num: true },
          { key: 'stats.merged', label: 'Merged', num: true, render: (r) => barCell(r.stats.merged, max) },
          { key: 'lastPrAt', label: 'Last PR', num: true, render: (r) => fmt.date(r.stats.lastPrAt) },
        ],
      })),
    card({ title: 'Students', note: `${fmt.num(data.students.length)}${data.students.length === 100 ? '+' : ''}`, flush: true }, contributorsTable(data.students, ctx, { past: isPastRange(data.range, meta) })),
  );
  if (strip) charts.push(strip.draw(barChart));
  return () => charts.forEach((c) => c.destroy());
}
