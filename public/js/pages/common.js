// Shared by the public pages: meta cache, date-range plumbing (SPEC addendum A), cross-links and the PR table.
// Only the helpers from ../lib are used for markup; nothing here invents CSS classes.

import { api } from '../lib/api.js';
import { href, setQuery } from '../lib/router.js';
import {
  h, table, fmt, ghLink, extLink, stateBadge, categoryBadge, overrideBadge, rangeBar, CATEGORIES, CATEGORY_LABELS,
} from '../lib/ui.js';

/* ───────────── meta ───────────── */

let metaPromise = null;
let metaAt = 0;

/** GET /api/meta, shared by every page for five minutes. A failed request is not cached. */
export function getMeta() {
  if (!metaPromise || Date.now() - metaAt > 5 * 60 * 1000) {
    metaAt = Date.now();
    const p = api.get('/meta');
    metaPromise = p;
    p.catch(() => { if (metaPromise === p) metaPromise = null; });
  }
  return metaPromise;
}

/** True when the server implements date ranges (addendum A): /api/meta lists presets. */
export const hasRanges = (meta) => Boolean(meta && Array.isArray(meta.presets) && meta.presets.length);

/* ───────────── date range ───────────── */

const RANGE_KEYS = ['from', 'to', 'range'];

/** The range part of a hash query, to carry across links: { from, to, range } (empty keys left out). */
export function rangeQuery(query = {}) {
  const out = {};
  for (const k of RANGE_KEYS) if (query[k]) out[k] = query[k];
  return out;
}

/**
 * Range params for an API call. Custom dates pass through; `range=all` passes through; any other preset key is
 * resolved to its from / to dates from meta.presets when they are listed (else the key is sent as is).
 * Nothing set → nothing sent: the server then applies its default (the current academic year).
 */
export function rangeParams(query = {}, meta = null) {
  if (query.from || query.to) return { from: query.from || '', to: query.to || '' };
  if (!query.range) return {};
  if (query.range === 'all') return { range: 'all' };
  const preset = hasRanges(meta) ? meta.presets.find((p) => p.key === query.range) : null;
  if (preset && (preset.from || preset.to)) return { from: preset.from || '', to: preset.to || '' };
  return { range: query.range };
}

/** href() that keeps the active date range. */
export function link(path, query = {}, ctx = null) {
  return href(path, { ...(ctx ? rangeQuery(ctx.query) : {}), ...query });
}

/** The date-range control, or null when the server has no ranges. Goes directly under the page head. */
export function rangeControl(meta, ctx) {
  if (!hasRanges(meta)) return null;
  return rangeBar({ presets: meta.presets, query: ctx.query, onChange: (patch) => setQuery({ ...patch, page: '' }) });
}

/** "Academic year 2026-27, 1 Jul 2026 – 30 Jun 2027." from the `range` object a ranged response echoes; '' otherwise. */
export function rangeSentence(range) {
  if (!range || typeof range !== 'object') return '';
  const dates = range.from || range.to ? fmt.range(range.from, range.to) : 'All time';
  const label = range.label && range.label !== dates ? `${range.label}, ` : '';
  return `${label}${dates}.`;
}

/* ───────────── small pieces ───────────── */

/** el.append() that skips null / false (Element.append would print "null"). */
export function put(el, ...nodes) {
  el.append(...nodes.flat().filter((n) => n !== null && n !== undefined && n !== false));
}

export const studentName = (s) => (s && (s.name || s.username)) || '';

/** "RU · 2nd year" as plain text; unknown parts are left out. */
export function cohortText(s) {
  return [s.campus && s.campus !== 'Unknown' ? s.campus : null, s.year && s.year !== 'Unknown' ? s.year : null].filter(Boolean).join(' · ');
}

/** Table cell for a student: name → profile here, GitHub handle underneath. */
export function studentCell(s, ctx, { sub = 'github' } = {}) {
  return h('div', null,
    h('a', { href: link(`/students/${encodeURIComponent(s.username)}`, {}, ctx) }, studentName(s)),
    sub === 'github' ? h('div', { class: 'sub' }, ghLink(s.username)) : null,
    sub === 'cohort' && cohortText(s) ? h('div', { class: 'sub' }, cohortText(s)) : null);
}

export function repoHref(name, ctx) {
  const [owner, ...rest] = String(name || '').split('/');
  return link(`/projects/${encodeURIComponent(owner)}/${encodeURIComponent(rest.join('/'))}`, {}, ctx);
}

export const orgHref = (login, ctx) => link(`/orgs/${encodeURIComponent(login)}`, {}, ctx);

/** Options for a select from a list of plain values. */
export const opts = (list) => (list || []).map((v) => ({ value: String(v), label: String(v) }));

/** Category select options where '' is the API default (open source) and 'all' lifts the filter. */
export function categoryOptions({ allLabel = 'All categories', only = null } = {}) {
  const rest = CATEGORIES.filter((c) => c !== 'open_source' && (!only || only.includes(c)));
  return [
    { value: '', label: CATEGORY_LABELS.open_source },
    { value: 'all', label: allLabel },
    ...rest.map((c) => ({ value: c, label: CATEGORY_LABELS[c] })),
  ];
}

/** Download link styled as a button. */
export function csvButton(path, params, label = 'Download CSV') {
  return h('a', { class: 'btn', href: api.url(path, params), download: '' }, label);
}

/** Remove keys with empty values (for API params built from the hash query). */
export function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== '' && v !== null && v !== undefined) out[k] = v;
  return out;
}

/* ───────────── PR table ───────────── */

/**
 * The pull-request table used on the profile, repo page and the explorer.
 * opts: { student (show the Student column), project (show the Project column), sort, order, onSort, empty, caption }
 */
export function prTable(rows, ctx, { student = true, project = true, sort = null, order = 'desc', onSort = null, empty = 'No pull requests match these filters.', caption = 'Pull requests' } = {}) {
  const sortable = Boolean(onSort);
  const columns = [
    {
      key: 'title', label: 'Pull request', wrap: true,
      render: (p) => h('div', null,
        extLink(p.title || `#${p.number}`, p.url),
        h('div', { class: 'sub' }, `${p.repo}#${p.number}`)),
    },
    student && {
      key: 'author', label: 'Student',
      render: (p) => h('a', { href: link(`/students/${encodeURIComponent(p.author)}`, {}, ctx) }, p.authorName || p.author),
    },
    project && {
      key: 'repo', label: 'Project',
      render: (p) => h('div', null,
        h('a', { href: repoHref(p.repo, ctx) }, p.repo),
        h('div', { class: 'sub' }, `${fmt.compact(p.stars)} stars`)),
    },
    { key: 'state', label: 'State', render: (p) => stateBadge(p.isDraft && p.state === 'open' ? 'draft' : p.state) },
    {
      key: 'category', label: 'Category',
      render: (p) => (p.override
        ? h('div', null, categoryBadge(p.category, p.tier), h('div', { class: 'sub' }, overrideBadge(p.override, p.overrideNote)))
        : categoryBadge(p.category, p.tier)),
    },
    { key: 'createdAt', label: 'Opened', sortable, class: 'nowrap', render: (p) => fmt.date(p.createdAt) },
    { key: 'mergedAt', label: 'Merged', sortable, class: 'nowrap', render: (p) => (p.mergedAt ? fmt.date(p.mergedAt) : null) },
    {
      key: 'additions', label: 'Changes', num: true, sortable, title: 'Lines added and removed',
      render: (p) => `+${fmt.num(p.additions)} −${fmt.num(p.deletions)}`,
    },
  ].filter(Boolean);
  return table({ columns, rows, sort, order, onSort, empty, caption });
}

/** Students-in-this-project table (repo and org pages). Rows are Student plus { prs, merged }. */
export function contributorsTable(rows, ctx, { empty = 'No students yet.', caption = 'Students' } = {}) {
  return table({
    caption, empty, rows,
    columns: [
      { key: 'name', label: 'Student', render: (s) => studentCell(s, ctx) },
      { key: 'campus', label: 'Campus' },
      { key: 'year', label: 'Year' },
      { key: 'prs', label: 'PRs here', num: true },
      { key: 'merged', label: 'Merged here', num: true },
    ],
  });
}

/* ───────────── per-entity activity (SPEC addendum A; needs GET /api/activity) ───────────── */

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** GET /activity for one student / repo / owner, or null when the server has no ranges or the call fails. */
export function fetchActivity(meta, params) {
  if (!hasRanges(meta)) return Promise.resolve(null);
  return api.get('/activity', clean(params)).catch(() => null);
}

/**
 * "Activity in this period" card: calendar heatmap + weekday bars. Returns null when there is nothing to show.
 * Call `draw(barChart)` on the result once the card is in the page; it returns the chart handle to destroy.
 */
export function activityCard(activity, ctx, { card, calendarHeatmap, linkQuery = {}, unit = 'pull requests opened' }) {
  if (!activity || !Array.isArray(activity.byWeekday)) return null;
  const canvas = h('canvas');
  const node = card({ title: 'Activity in this period', note: h('a', { href: link('/activity', linkQuery, ctx) }, 'See all activity') },
    h('div', { class: 'grid grid-main' },
      Array.isArray(activity.byDate) && activity.byDate.length
        ? calendarHeatmap(activity.byDate.map((d) => ({ date: d.date, value: d.opened })), { unit })
        : h('p', { class: 'muted' }, 'The range is too long for a day-by-day view.'),
      h('div', { class: 'chart-box chart-box-sm' }, canvas)));
  const byDow = new Map(activity.byWeekday.map((d) => [d.dow, d]));
  return {
    el: node,
    draw: (barChart) => barChart(canvas, {
      labels: WEEKDAYS,
      series: [{ label: 'Opened', data: WEEKDAYS.map((_, i) => (byDow.get(i + 1) || {}).opened || 0), color: 1 }],
      label: 'Pull requests opened by day of the week',
    }),
  };
}
