// Campuses: the campuses side by side (SPEC addendum F). GET /campuses (+ GET /activity for the monthly lines).
// The campuses differ a lot in size, so the page leads with rates on the number of tracked students and shows the
// size of every cohort next to its figure. One switch (per 100 students | share of students | raw counts) drives
// every comparison on the page and lives in the address (`?scale=`).

import { api } from '../lib/api.js';
import { setQuery } from '../lib/router.js';
import { h, pageHead, card, table, tierBadge, fmt } from '../lib/ui.js';
import { lineChart } from '../lib/charts.js';
import {
  getMeta, hasRanges, rangeParams, rangeControl, rangeLine, rangeIsOpen, isPastRange, link, campusLink, repoHref, orgHref, put,
} from './common.js';
import {
  scaleOf, scaleToggle, unknownToggle, rate, pctVal, smallMark, campusYearTable, campusCsv, downloadButton, CAMPUS_SORT_DEFAULT,
  campusMonthSeries, funnelMatrix, tierMixBlock, categoryMixBlock, yearBars, yearMetric, distributionTable, spreadKey, deltaLine,
} from './campus-common.js';
import { campusTechBlock } from './tech-common.js';

/** One campus of the scorecard row. `max` holds the largest value of each bar among the campuses shown. */
function scorecard(c, t, { ctx, max, previousRange, below }) {
  const head = h('div', { class: 'scorecard-head' },
    h('h2', null, campusLink(c.campus, ctx)),
    h('span', { class: 'muted' }, `${fmt.num(c.students)} tracked students`, c.smallCohort ? [' · ', smallMark(c, below)] : null));
  if (!t || !c.students) return h('section', { class: 'scorecard' }, head, h('p', { class: 'muted' }, 'No tracked students yet.'));
  const bar = (value, top, last = false) => h('span', { class: 'scorebar', 'aria-hidden': 'true' },
    h('span', { class: last ? 'is-last' : null, style: { width: `${top && value ? Math.max(1, (value / top) * 100) : 0}%` } }));
  const metric = ({ value, label, sub, bar: b, key = false }) => h('div', { class: ['score', key && 'score-key'] },
    h('div', { class: 'score-value' }, value),
    h('div', { class: 'score-label' }, label, sub ? h('small', null, sub) : null),
    b);
  return h('section', { class: 'scorecard' }, head,
    metric({
      key: true, value: pctVal(t.withOsMergedPct), label: 'of students have a merged open-source PR',
      sub: `${fmt.num(t.withOsMerged)} of ${fmt.num(t.students)}`, bar: bar(t.withOsMergedPct, max.withOsMergedPct),
    }),
    metric({
      value: rate(t.osMergedPer100), label: 'merged open-source PRs per 100 students',
      sub: `${fmt.num(t.osMerged)} merged`, bar: bar(t.osMergedPer100, max.osMergedPer100),
    }),
    metric({
      value: fmt.num(t.osMajorMerged), label: 'merged in major projects',
      sub: `${rate(t.osMajorMergedPer100)} per 100 students`, bar: bar(t.osMajorMergedPer100, max.osMajorMergedPer100, true),
    }),
    h('p', { class: 'scorecard-delta' }, deltaLine(t, previousRange)
      || h('span', { class: 'muted' }, 'No earlier period to compare with.')));
}

/** Ranked top-5 list of one campus (organisations or projects). */
function topList(items, { ctx, kind, empty }) {
  if (!items || !items.length) return h('p', { class: 'muted' }, empty);
  return h('ol', { class: 'toplist' }, items.map((r) => h('li', null,
    h('span', { class: 'toplist-name' },
      kind === 'org'
        ? h('a', { href: orgHref(r.login, ctx), title: r.login }, r.login)
        : h('a', { href: repoHref(r.name, ctx), title: r.name }, r.name),
      h('small', null, kind === 'repo' ? [tierBadge(r.tier, { label: false }), ' '] : null, `${fmt.num(r.students)} ${r.students === 1 ? 'student' : 'students'}`)),
    h('span', { class: 'toplist-value', title: `${fmt.num(r.osMerged)} merged of ${fmt.num(r.osPrs)} open-source PRs` }, fmt.num(r.osMerged)))));
}

export default async function (el, ctx) {
  const meta = await getMeta();
  const q = ctx.query;
  const range = rangeParams(q, meta);
  const [data, activity, tech] = await Promise.all([
    api.get('/campuses', range),
    hasRanges(meta) ? api.get('/activity', { ...range }).catch(() => null) : null,
    api.get('/tech', { by: 'domain', ...range }).catch(() => null), // tech mix per campus (SPEC addendum H)
  ]);
  const scale = scaleOf(q);
  const rateMode = scale !== 'raw';
  const below = data.smallCohortBelow || 30;
  const past = isPastRange(data.range, meta);
  const open = rangeIsOpen(data.range);
  const showUnknown = q.unknown === '1';
  const totals = new Map((data.totals || []).map((t) => [t.campus, t]));
  const cards = (data.campuses || []).filter((c) => c.campus !== 'Unknown');
  // the groups every chart compares: campuses with students, Unknown only on request
  const groups = (data.totals || []).filter((t) => t.students > 0 && (showUnknown || t.campus !== 'Unknown'));
  const sizes = cards.filter((c) => c.students > 0).map((c) => c.students);
  const spread = sizes.length > 1 ? Math.round(Math.max(...sizes) / Math.max(1, Math.min(...sizes))) : 0;
  const campusHref = (t) => (t.campus === 'Unknown' ? null : link(`/campuses/${encodeURIComponent(t.campus)}`, {}, ctx));
  const charts = [];

  put(el,
    pageHead({
      title: 'Campuses compared',
      range: rangeLine(data.range),
      lede: [
        spread >= 3 ? `The largest campus has about ${fmt.num(spread)} times as many tracked students as the smallest, so plain counts mostly show size. ` : null,
        'This page compares rates: figures per 100 tracked students, and shares of each campus’s students. The number of students behind a rate is always shown beside it. ',
        h('a', { href: link('/about', {}, ctx) }, 'Who counts as a tracked student'),
      ],
      actions: [downloadButton(campusCsv(data), `nst-campuses-${(data.range && data.range.from) || 'all'}_${(data.range && data.range.to) || 'time'}.csv`)],
    }),
    rangeControl(meta, ctx),
    h('div', { class: 'toolbar scalebar' },
      h('span', { class: 'scalebar-label' }, 'Compare by'), scaleToggle(ctx, 'page'),
      unknownToggle(ctx, data.campuses)),
    scale === 'raw' ? h('div', { class: 'notice' }, 'Raw counts are not adjusted for the size of a campus. A larger campus has more of everything; use “Per 100 students” to compare campuses fairly.') : null,
  );

  // ── 1. scorecards ──
  const maxOf = (key) => Math.max(0, ...cards.map((c) => (totals.get(c.campus) || {})[key] || 0));
  const max = { withOsMergedPct: maxOf('withOsMergedPct'), osMergedPer100: maxOf('osMergedPer100'), osMajorMergedPer100: maxOf('osMajorMergedPer100') };
  put(el, h('div', { class: 'scorecards' }, cards.map((c) => scorecard(c, totals.get(c.campus), { ctx, max, previousRange: data.previousRange, below }))),
    h('p', { class: 'fine' },
      'Bars compare the campuses on the same rate; the longest bar is the highest rate. ',
      data.previousRange ? `The change compares with ${fmt.range(data.previousRange.from, data.previousRange.to)}, counted on today’s list of students. ` : null,
      data.total ? `All campuses together: ${pctVal(data.total.withOsMergedPct)} of ${fmt.num(data.total.students)} students have a merged open-source PR, ${rate(data.total.osMergedPer100)} merged per 100 students.` : null));

  // ── 2. month by month + who takes part ──
  const month = campusMonthSeries(activity, { scale, metric: 'merged', unknown: showUnknown, noun: 'open-source PRs' });
  const monthCanvas = h('canvas');
  put(el,
    h('div', { class: 'section-head' }, h('h2', null, 'How far students get'), scaleToggle(ctx, 'funnel', { two: ['Share of students', 'Counts'] })),
    card({ flush: true },
      funnelMatrix(groups, { scale, ctx, below }),
      h('p', { class: 'card-note card-note-pad' },
        rateMode ? 'Each figure is a share of the campus’s tracked students, with the number of students beside it. ' : 'Number of students, with their share of the campus beside it. ',
        'Each step is a subset of the one before. Bars are scaled within a column, so read down a column to compare campuses.')),
    h('div', { class: 'section-head' }, h('h2', null, 'Month by month'), scaleToggle(ctx, 'month', { labels: { share: 'Share active' } })),
    card({ title: 'Merged open-source PRs by month', note: month ? month.unit : null },
      month ? [
        h('div', { class: 'chart-box' }, monthCanvas),
        h('p', { class: 'card-note' },
          scale === 'share' ? 'A student is active in a month when they opened or merged an open-source pull request in it. ' : null,
          'The number after a campus is its tracked students. ',
          open ? 'The current month is incomplete. ' : null,
          h('a', { href: link('/activity', {}, ctx) }, 'Full activity breakdown')),
      ] : h('p', { class: 'muted' }, 'No monthly figures for this period.')));

  // ── 3. year of study within each campus ──
  const ym = yearMetric(scale);
  const yearRows = (campus) => (data.rows || []).filter((r) => r.campus === campus);
  const yearMax = Math.max(0, ...groups.flatMap((t) => yearRows(t.campus).map((r) => ym.value(r) || 0)));
  put(el,
    h('div', { class: 'section-head' }, h('h2', null, 'Year of study within each campus'), scaleToggle(ctx, 'years')),
    card({ note: null },
      h('p', { class: 'chart-unit' }, ym.unit, '. All panels share one scale.'),
      h('div', { class: 'panels' }, groups.map((t) => h('div', { class: 'panel' },
        h('h3', { class: 'mini-title' }, campusLink(t.campus, ctx), h('span', { class: 'muted' }, ` · ${fmt.num(t.students)} students`)),
        yearBars(yearRows(t.campus), { scale, max: yearMax, past, below })))),
      h('p', { class: 'card-note' }, past ? 'Year of study is as of today; the batch is shown beside it. ' : 'Year of study as of today. ',
        `A cohort with fewer than ${below} students is marked “small cohort”: one student moves its rate a lot.`)));

  // ── 4. what the work is ──
  put(el,
    h('div', { class: 'section-head' }, h('h2', null, 'What the work is'), scaleToggle(ctx, 'mix', { labels: { share: 'Mix (100%)' } })),
    h('div', { class: 'grid grid-2' },
      card({ title: 'Merged open-source PRs by project tier' },
        tierMixBlock(groups, { scale, ctx, below, hrefOf: campusHref }),
        h('p', { class: 'card-note' }, scale === 'share' ? 'Each bar is 100% of the campus’s merged open-source pull requests.' : scale === 'per100' ? 'Bar length is merged open-source pull requests per 100 tracked students.' : 'Bar length is the number of merged open-source pull requests.')),
      card({ title: 'All pull requests by category' },
        categoryMixBlock(groups, { scale, below, hrefOf: campusHref }),
        h('p', { class: 'card-note' },
          scale === 'share' ? 'Each bar is 100% of the pull requests the campus’s students opened. ' : scale === 'per100' ? 'Bar length is pull requests opened per 100 tracked students. ' : 'Bar length is the number of pull requests opened. ',
          'Only the open-source part counts towards the headline. ', h('a', { href: link('/about', {}, ctx) }, 'How categories work')))),
    tech && tech.totals && tech.totals.merged > 0 ? card({ title: 'Merged open-source PRs by technology area' },
      campusTechBlock(tech, { scale, ctx, showUnknown, hrefOf: (c) => (c.campus === 'Unknown' ? null : link(`/campuses/${encodeURIComponent(c.campus)}`, {}, ctx)) }),
      h('p', { class: 'card-note' },
        scale === 'share' ? 'Each bar is 100% of the campus’s merged open-source pull requests. ' : scale === 'per100' ? 'Bar length is merged open-source pull requests per 100 tracked students. ' : 'Bar length is the number of merged open-source pull requests. ',
        'The five areas with the most merged work overall get a colour; the rest is grey. ',
        h('a', { href: link('/tech', { by: 'domain' }, ctx) }, 'Technologies in detail'))) : null);

  // ── 5. the table ──
  const sort = q.sort || CAMPUS_SORT_DEFAULT;
  const order = q.order || (sort === 'campus' ? 'asc' : 'desc');
  put(el,
    h('div', { class: 'section-head' }, h('h2', null, 'Campus by year'),
      h('div', { class: 'toolbar' }, scaleToggle(ctx, 'table', { two: ['Rates', 'Counts'] }))),
    card({ flush: true },
      campusYearTable(data, { ctx, past, rateMode, sort, order, onSort: (s, o) => setQuery({ sort: s === CAMPUS_SORT_DEFAULT && o === 'desc' ? '' : s, order: s === CAMPUS_SORT_DEFAULT && o === 'desc' ? '' : o }) }),
      h('p', { class: 'card-note card-note-pad' },
        rateMode ? 'Student columns are shares of the tracked students; pull-request columns are per 100 tracked students. Hover a figure for its count. ' : 'Counts, with the two headline rates beside them. ',
        'Sorting orders the campuses by their total and the years within each campus.')));

  // ── 6. concentration ──
  put(el,
    h('div', { class: 'section-head' }, h('h2', null, 'How concentrated the work is'),
      h('span', { class: 'muted' }, 'Merged open-source pull requests per contributing student')),
    card({ flush: true },
      distributionTable(groups, { ctx }),
      h('div', { class: 'card-note card-note-pad' }, spreadKey(),
        h('p', null, 'A high share from the top 10% means a few students carry the campus’s numbers; a higher median means the work is spread more evenly.'))));

  // ── 7. where the work lands ──
  const listCampuses = groups.filter((t) => t.campus !== 'Unknown');
  const lists = (kind) => h('div', { class: 'panels' }, listCampuses.map((t) => h('div', { class: 'panel' },
    h('h3', { class: 'mini-title' }, campusLink(t.campus, ctx)),
    topList(kind === 'org' ? t.topOrgs : t.topRepos, { ctx, kind, empty: 'No merged open-source PRs in this period.' }))));
  const shared = data.sharedOrgs || [];
  const sharedCampuses = cards.filter((c) => shared.some((o) => (o.byCampus || []).some((b) => b.campus === c.campus)));
  const allShared = q.shared === 'all';
  const cell = (o, campus) => (o.byCampus || []).find((b) => b.campus === campus);
  put(el,
    h('div', { class: 'section-head' }, h('h2', null, 'Where the merged work lands'), h('span', { class: 'muted' }, 'Ranked by merged open-source pull requests')),
    card({ title: 'Top organisations of each campus' }, lists('org')),
    card({ title: 'Top projects of each campus' }, lists('repo')),
    card({ title: 'Organisations shared by two or more campuses', note: shared.length ? `${fmt.num(shared.length)}${shared.length === 50 ? '+' : ''}` : null, flush: true },
      table({
        compact: true, caption: 'Organisations with open-source pull requests from students of two or more campuses',
        rows: allShared ? shared : shared.slice(0, 10), empty: 'No organisation has open-source pull requests from two campuses in this period.',
        columns: [
          { key: 'login', label: 'Organisation', render: (o) => h('a', { href: orgHref(o.login, ctx) }, o.login) },
          { key: 'campuses', label: 'Campuses', num: true },
          ...sharedCampuses.map((c) => ({
            key: `c-${c.campus}`, label: c.campus, num: true, title: `Merged open-source pull requests by ${c.campus} students`,
            render: (o) => {
              const b = cell(o, c.campus);
              return b ? h('span', { title: `${fmt.num(b.students)} ${b.students === 1 ? 'student' : 'students'}, ${fmt.num(b.osPrs)} open-source PRs opened` }, fmt.num(b.osMerged)) : null;
            },
          })),
          { key: 'osMerged', label: 'Merged', num: true },
          { key: 'students', label: 'Students', num: true },
        ],
      }),
      shared.length > 10 ? h('p', { class: 'card-note card-note-pad' },
        h('button', { type: 'button', class: 'btn btn-link', name: 'shared-all', onClick: () => setQuery({ shared: allShared ? '' : 'all' }) },
          allShared ? 'Show the first 10' : `Show all ${fmt.num(shared.length)}`),
        ' Campus columns count merged open-source pull requests.') : null));

  if (month) charts.push(lineChart(monthCanvas, month.input));
  return () => charts.forEach((c) => c.destroy());
}
