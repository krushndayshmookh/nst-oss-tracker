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

/** "AY 2026-27 · 1 Jul 2026 – 30 Jun 2027" as plain text, from the `range` object a ranged response echoes; '' otherwise. */
export function rangeSentence(range) {
  if (!range || typeof range !== 'object') return '';
  const dates = range.from || range.to ? fmt.range(range.from, range.to) : 'All time';
  const label = range.label && range.label !== dates && range.label !== 'Custom range' ? `${range.label} · ` : '';
  return `${label}${dates}`;
}

/** The same as nodes for pageHead({ range }): the label in bold, then the dates. null when the response has no range. */
export function rangeLine(range, extra = null) {
  if (!range || typeof range !== 'object') return extra ? [extra] : null;
  const dates = range.from || range.to ? fmt.range(range.from, range.to) : null;
  const label = range.label && range.label !== 'Custom range' ? range.label : (dates ? null : 'All time');
  return [
    label ? h('b', null, label) : null,
    label && dates ? h('span', { class: 'sep' }, ' · ') : null,
    dates,
    extra ? [h('span', { class: 'sep' }, ' · '), extra] : null,
  ];
}

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** True when the range has not ended yet (so its last month / week is still filling up). */
export const rangeIsOpen = (range) => !range || !range.to || range.to >= todayIso();

/** True when the whole range lies before the current academic year: year-of-study labels then need the batch beside them. */
export function isPastRange(range, meta) {
  const start = meta && meta.academicYear && meta.academicYear.current && meta.academicYear.current.start;
  return Boolean(range && range.to && start && range.to < start);
}

/** "3rd year", or "3rd year · Batch 2024" when `past` (the year label is as of today, the range is not). */
export function yearLabel(s, past = false) {
  const year = s.year === 'All' ? 'All years' : s.year;
  if (!s.batch) return year;
  if (past) return [year, h('span', { class: 'sub-inline muted' }, ` · Batch ${s.batch}`)];
  return h('span', { title: `Batch ${s.batch}` }, year);
}

/**
 * Drop date-range params that cannot be used (malformed date, from after to, unknown preset) from a hash query.
 * → the cleaned query, or null when nothing had to change. A stale shared link then opens on the default range
 * instead of an error page whose every link repeats the bad range.
 */
export function sanitizeRange(query = {}, meta = null) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const out = { ...query };
  let changed = false;
  const drop = (k) => { if (k in out) { delete out[k]; changed = true; } };
  for (const k of ['from', 'to']) if (out[k] && (!iso.test(out[k]) || Number.isNaN(Date.parse(out[k])))) drop(k);
  if (out.from && out.to && out.from > out.to) { const t = out.from; out.from = out.to; out.to = t; changed = true; }
  if (out.range && (out.from || out.to)) drop('range');
  if (out.range && hasRanges(meta) && !meta.presets.some((p) => p.key === out.range)) drop('range');
  return changed ? out : null;
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

/** cohortText plus the batch, for lists shown under a past academic year. */
export function cohortTextPast(s) {
  return [cohortText(s), s.batch ? `Batch ${s.batch}` : null].filter(Boolean).join(' · ');
}

/** A campus name as a link to its page (SPEC addendum F). 'Unknown' and empty stay plain text. */
export function campusLink(campus, ctx, text = null) {
  if (!campus) return null;
  if (campus === 'Unknown') return text || 'Unknown';
  return h('a', { href: link(`/campuses/${encodeURIComponent(campus)}`, {}, ctx) }, text || campus);
}

/** ['RU', 'SVYASA'] → linked names separated by commas. → array of nodes, or null for an empty list. */
export function campusList(list, ctx) {
  const names = (list || []).filter(Boolean);
  return names.length ? names.flatMap((c, i) => (i ? [', ', campusLink(c, ctx)] : [campusLink(c, ctx)])) : null;
}

/** "RU · 2nd year" with the campus linked; unknown parts are left out. → array of nodes, or null. */
export function cohortNodes(s, ctx, { past = false } = {}) {
  const parts = [
    s.campus && s.campus !== 'Unknown' ? campusLink(s.campus, ctx) : null,
    s.year && s.year !== 'Unknown' ? s.year : null,
    past && s.batch ? `Batch ${s.batch}` : null,
  ].filter(Boolean);
  return parts.length ? parts.flatMap((p, i) => (i ? [' · ', p] : [p])) : null;
}

/** Table cell for a student: name → profile here, GitHub handle underneath. */
export function studentCell(s, ctx, { sub = 'github', past = false } = {}) {
  return h('div', null,
    h('a', { href: link(`/students/${encodeURIComponent(s.username)}`, {}, ctx) }, studentName(s)),
    sub === 'github' ? h('div', { class: 'sub' }, ghLink(s.username)) : null,
    sub === 'cohort' && cohortText(s) ? h('div', { class: 'sub' }, cohortNodes(s, ctx, { past })) : null);
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
export function contributorsTable(rows, ctx, { empty = 'No students in this period.', caption = 'Students', past = false } = {}) {
  return table({
    caption, empty, rows,
    columns: [
      { key: 'name', label: 'Student', render: (s) => studentCell(s, ctx) },
      { key: 'campus', label: 'Campus', render: (r) => campusLink(r.campus, ctx) },
      { key: 'year', label: 'Year', render: (r) => yearLabel(r, past) },
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

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** One sentence on the weekly rhythm from byWeekday rows, or null when there is too little to say. */
export function weekdaySentence(byWeekday, key = 'opened') {
  const v = WEEKDAYS.map((_, i) => ((byWeekday || []).find((d) => d.dow === i + 1) || {})[key] || 0);
  const total = v.reduce((x, y) => x + y, 0);
  if (total < 10) return null;
  const top = v.indexOf(Math.max(...v));
  return `Most on ${DAY_NAMES[top]}s (${fmt.pct(v[top], total)}); ${fmt.pct(v[5] + v[6], total)} at weekends.`;
}

/**
 * "When the work happened" card for one student / project / organisation: calendar heatmap + weekday bars.
 * Returns null when there is nothing to show. Call `draw(barChart)` on the result once the card is in the page;
 * it returns the chart handle to destroy.
 */
export function activityCard(activity, ctx, { card, calendarHeatmap, linkQuery = {}, unit = 'pull requests opened', title = 'When the work happened' }) {
  if (!activity || !Array.isArray(activity.byWeekday)) return null;
  const opened = (activity.totals && activity.totals.opened) || 0;
  const canvas = h('canvas');
  const days = Array.isArray(activity.byDate) ? activity.byDate : [];
  const activeDays = days.filter((d) => d.opened > 0).length;
  const sentence = weekdaySentence(activity.byWeekday);
  const node = card({ title, note: h('a', { href: link('/activity', linkQuery, ctx) }, 'Full activity breakdown') },
    opened === 0
      ? h('p', { class: 'muted' }, 'No pull requests were opened in this period.')
      : h('div', { class: 'split split-even' },
        h('div', null,
          h('h3', { class: 'mini-title' }, days.length ? `Day by day: pull requests opened on ${fmt.num(activeDays)} of ${fmt.num(days.length)} days` : 'Day by day'),
          days.length
            ? calendarHeatmap(days.map((d) => ({ date: d.date, value: d.opened })), { unit })
            : h('p', { class: 'muted' }, 'This range is too long for a day-by-day view. Choose a range of two years or less.')),
        h('div', null,
          h('h3', { class: 'mini-title' }, 'By day of the week'),
          h('div', { class: 'chart-box chart-box-sm' }, canvas),
          sentence ? h('p', { class: 'card-note' }, sentence) : null)));
  const byDow = new Map(activity.byWeekday.map((d) => [d.dow, d]));
  return {
    el: node,
    draw: (barChart) => (opened === 0 ? { destroy() {} } : barChart(canvas, {
      labels: WEEKDAYS,
      series: [{ label: 'Opened', data: WEEKDAYS.map((_, i) => (byDow.get(i + 1) || {}).opened || 0), color: 1 }],
      label: 'Pull requests opened by day of the week',
    })),
  };
}
