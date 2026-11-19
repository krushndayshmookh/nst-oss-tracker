// Project page. GET /repos/:owner/:name; further PR pages via GET /prs?repo=…&category=all

import { api } from '../lib/api.js';
import { setQuery } from '../lib/router.js';
import { h, pageHead, statCard, card, pagination, badge, categoryBadge, overrideBadge, calendarHeatmap, fmt, CATEGORY_HELP } from '../lib/ui.js';
import { barChart } from '../lib/charts.js';
import { getMeta, rangeParams, rangeControl, rangeLine, isPastRange, link, orgHref, campusList, prTable, contributorsTable, fetchActivity, activityCard, put } from './common.js';
import { techHref } from './tech-common.js';

export default async function (el, ctx) {
  const meta = await getMeta();
  const q = ctx.query;
  const range = rangeParams(q, meta);
  const full = `${ctx.params.owner}/${ctx.params.name}`;
  const page = Number(q.page) > 1 ? Number(q.page) : 1;
  const [data, more, activity] = await Promise.all([
    api.get(`/repos/${encodeURIComponent(ctx.params.owner)}/${encodeURIComponent(ctx.params.name)}`, range),
    page > 1 ? api.get('/prs', { repo: full, category: 'all', page, ...range }) : null,
    fetchActivity(meta, { repo: full, category: 'all', ...range }),
  ]);
  const { repo } = data;
  const prs = more || data.prs;
  const counted = repo.category === 'open_source';
  const charts = [];

  const why = counted ? null
    : repo.category === 'low_signal' ? `Not counted as open source: ${repo.reason || 'below the thresholds'}.`
      : `Not counted as open source. ${CATEGORY_HELP[repo.category] || ''}`;

  put(el, 
    pageHead({
      crumbs: [{ label: 'Projects', href: link('/projects', {}, ctx) }, { label: repo.owner, href: orgHref(repo.owner, ctx) }],
      title: repo.name,
      range: rangeLine(data.range),
      lede: repo.description || null,
      actions: [h('a', { class: 'btn ext', href: `https://github.com/${repo.name.split('/').map(encodeURIComponent).join('/')}`, target: '_blank', rel: 'noopener noreferrer' }, 'View on GitHub')],
    }),
    rangeControl(meta, ctx),
    h('div', { class: 'toolbar' },
      categoryBadge(repo.category, repo.tier),
      repo.override ? overrideBadge(repo.override, repo.overrideNote) : null,
      h('span', { class: 'muted' }, `${fmt.num(repo.stars)} stars`),
      repo.language ? h('a', { class: 'muted', href: techHref('language', repo.language, ctx, { all: !counted }), title: 'Projects with this main language' }, repo.language) : null,
      repo.domain ? h('a', { class: 'muted', href: techHref('domain', repo.domain, ctx, { all: !counted }), title: repo.domainReason ? `Technology area, set by ${repo.domainReason}` : 'Technology area' }, repo.domainLabel) : null,
      repo.license ? h('span', { class: 'muted' }, repo.license) : null,
      repo.isFork ? badge('Fork') : null,
      repo.isArchived ? badge('Archived', 'warn') : null,
      why ? h('span', null, why, ' ', h('a', { href: link('/about', {}, ctx) }, 'How this is decided')) : null),
    h('div', { class: 'cards' },
      statCard({ key: true, label: counted ? 'Merged PRs by NST students' : 'Merged PRs (not counted)', value: repo.stats.merged, sub: `of ${fmt.num(repo.stats.prs)} opened` }),
      statCard({ label: 'Students', value: repo.stats.students, sub: campusList(repo.stats.campuses, ctx) }),
      statCard({ label: 'Open now', value: repo.stats.open }),
      statCard({ label: 'Closed without merging', value: repo.stats.closed }),
      statCard({ label: 'First PR', value: fmt.date(repo.stats.firstPrAt), sub: repo.stats.lastPrAt ? `latest ${fmt.rel(repo.stats.lastPrAt)}` : null })),
  );

  // languages by size and GitHub topics arrive with the repo metadata refresh (SPEC addendum H)
  const langs = (repo.languages || []).filter((l) => l.pct === null || l.pct >= 1);
  if (langs.length > 1 || (repo.topics || []).length) {
    put(el, card({ title: 'Technology', note: repo.domainReason ? `Area: ${repo.domainLabel}` : null },
      h('dl', { class: 'facts' },
        langs.length ? [h('dt', null, 'Languages'), h('dd', null, langs.map((l) => `${l.name}${l.pct !== null ? ` ${l.pct}%` : ''}`).join(' · '))] : null,
        (repo.topics || []).length ? [h('dt', null, 'Topics'), h('dd', null, h('ul', { class: 'topics' }, repo.topics.map((t) => h('li', null, t))))] : null,
        repo.domainReason ? [h('dt', null, 'Area decided by'), h('dd', null, repo.domainReason)] : null)));
  }

  const strip = activityCard(activity, ctx, { card, calendarHeatmap, linkQuery: { repo: repo.name, category: 'all' } });
  if (strip) put(el, strip.el);

  put(el, 
    card({ title: 'Students', note: `${fmt.num(data.students.length)}${data.students.length === 100 ? '+' : ''}`, flush: true }, contributorsTable(data.students, ctx, { past: isPastRange(data.range, meta) })),
    card({ title: 'Pull requests', note: h('a', { href: link('/prs', { repo: repo.name, category: 'all' }, ctx) }, 'Open in the explorer'), flush: true },
      prTable(prs.items, ctx, { project: false }),
      pagination({ ...prs, onPage: (p) => setQuery({ page: p > 1 ? p : '' }) })),
  );
  if (strip) charts.push(strip.draw(barChart));
  return () => charts.forEach((c) => c.destroy());
}
