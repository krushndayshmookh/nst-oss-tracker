// Shared by the Technologies page and the technology blocks on Overview, Campuses and the student profile
// (SPEC addendum H). Not a page: nothing routes here. Data: GET /api/tech, `tech` of GET /students/:username.

import { h, fmt } from '../lib/ui.js';
import { link } from './common.js';
import { stackRows, legendKey, rate, smallMark } from './campus-common.js';

export const BY_LABELS = { language: 'Language', domain: 'Technology area' };
export const BY_PLURAL = { language: 'languages', domain: 'technology areas' };
export const REST_KEY = '_rest';

// "Is it mostly web?" (the question behind addendum H): which keys count as web work in each view.
export const WEB_LANGUAGES = new Set(['JavaScript', 'TypeScript', 'HTML', 'CSS', 'SCSS', 'Sass', 'Less', 'Vue', 'Svelte', 'Astro', 'MDX', 'EJS', 'Handlebars', 'CoffeeScript']);
export const WEB_DOMAINS = new Set(['web_frontend', 'web_backend', 'fullstack']);
export const isWeb = (by, key) => (by === 'domain' ? WEB_DOMAINS.has(key) : WEB_LANGUAGES.has(key));

/** Projects list filtered to one language / area (the click target of every technology name). */
export function techHref(by, key, ctx, { all = false } = {}) {
  return link('/projects', { [by === 'domain' ? 'domain' : 'language']: key, category: all ? 'all' : '' }, ctx);
}

/** Colour slots for a mix of up to five keys plus "everything else": .tech-s1 … .tech-s5, .tech-rest (app.css). */
export const slotClass = (i) => (i < 5 ? `tech-s${i + 1}` : 'tech-rest');

/** The five keys with the most merged PRs among `cells` (byCampus rows), in that order. */
export function topKeys(rows, n = 5) {
  return rows.filter((r) => r.merged > 0).slice(0, n).map((r) => ({ key: r.key, label: r.label }));
}

/**
 * Technology mix of the merged PRs of each campus: one stacked row per campus (top five keys + everything else).
 * scale: 'share' → every row 100%; 'per100' → length = merged per 100 tracked students; 'raw' → counts.
 */
export function campusTechBlock(tech, { scale = 'per100', ctx, showUnknown = false, hrefOf = null } = {}) {
  const below = tech.smallCohortBelow || 30;
  const keys = topKeys(tech.rows || []);
  const topSet = new Set(keys.map((k) => k.key));
  const cohorts = (tech.cohorts || []).filter((c) => c.students > 0 && (showUnknown || c.campus !== 'Unknown'));
  const rows = cohorts.map((c) => {
    const cells = (tech.byCampus || []).filter((x) => x.campus === c.campus);
    const value = (key) => cells.filter((x) => x.key === key).reduce((s, x) => s + x.merged, 0);
    const rest = cells.filter((x) => !topSet.has(x.key)).reduce((s, x) => s + x.merged, 0);
    const per100 = c.students > 0 ? Math.round((c.merged * 1000) / c.students) / 10 : null;
    return {
      label: c.campus, href: hrefOf ? hrefOf(c) : null,
      sub: [`${fmt.num(c.students)} students`, c.smallCohort ? [' · ', smallMark(c, below)] : null],
      parts: [...keys.map((k, i) => ({ key: k.key, label: k.label, value: value(k.key), cls: slotClass(i) })),
        { key: REST_KEY, label: 'Everything else', value: rest, cls: 'tech-rest' }],
      total: scale === 'per100' ? per100 : c.merged,
      text: scale === 'per100' ? rate(per100) : fmt.num(c.merged),
      note: scale === 'per100' ? `per 100 · ${fmt.num(c.merged)} merged` : scale === 'share' ? 'merged PRs = 100%' : `merged · ${rate(per100)} per 100`,
    };
  });
  return h('div', null,
    stackRows(rows, { full: scale === 'share', empty: 'No merged pull requests' }),
    legendKey([...keys.map((k, i) => ({ cls: slotClass(i), label: k.label })), { cls: 'tech-rest', label: 'Everything else' }]));
}

/**
 * A compact ranked list of technologies: [{ key, label, merged, … }] → .hbars with the share written out.
 * `value(row)` picks the number the bar shows (default merged PRs).
 */
export function techList(rows, { by, ctx, n = 5, all = false, value = (r) => r.merged, text = null, note = null, empty = 'Nothing in this period.' } = {}) {
  const list = rows.filter((r) => value(r) > 0).slice(0, n);
  if (!list.length) return h('p', { class: 'muted' }, empty);
  const top = Math.max(...list.map(value));
  return h('dl', { class: 'hbars hbars-tech' }, list.map((r) => {
    const v = value(r);
    return [
      h('dt', null, h('a', { href: techHref(by, r.key, ctx, { all }), title: r.label }, r.label)),
      h('dd', { class: 'track', 'aria-hidden': 'true' }, h('span', { style: { width: `${top ? Math.max(1, (v / top) * 100) : 0}%` } })),
      h('dd', { class: 'val' }, text ? text(r) : fmt.num(v), note ? h('small', null, note(r)) : null),
    ];
  }));
}

/** Heat level 0…4 of a value against the largest of its table (a simple linear ramp: few cells, readable steps). */
export const heatLevel = (v, max) => (!v || !max ? 0 : Math.max(1, Math.min(4, Math.ceil((v / max) * 4))));
