// One campus (SPEC addendum F): GET /campuses/:campus (+ GET /activity?campus= for the monthly rates and the calendar).
// The same blocks as the comparison page, for one campus, with all campuses together as the yardstick.

import { api } from '../lib/api.js';
import { h, pageHead, statCard, card, table, barCell, tierBadge, calendarHeatmap, mixLegend, mixBar, fmt } from '../lib/ui.js';
import { lineChart, barChart } from '../lib/charts.js';
import {
  getMeta, hasRanges, rangeParams, rangeControl, rangeLine, rangeSentence, rangeIsOpen, isPastRange, yearLabel, link, campusLink, studentCell,
  repoHref, orgHref, activityCard, csvButton, put,
} from './common.js';
import {
  scaleOf, scaleToggle, rate, pctVal, smallMark, campusYearTable, funnelMatrix, tierMixBlock, categoryMixBlock, yearBars, yearMetric,
  distributionTable, spreadKey, deltaLine, AXIS,
} from './campus-common.js';

export default async function (el, ctx) {
  const meta = await getMeta();
  const q = ctx.query;
  const range = rangeParams(q, meta);
  const data = await api.get(`/campuses/${encodeURIComponent(ctx.params.campus)}`, range);
  const campus = data.campus;
  const activity = hasRanges(meta) ? await api.get('/activity', { campus, ...range }).catch(() => null) : null;
  const t = data.totals || {};
  const all = data.overall || {};
  const scale = scaleOf(q);
  const below = data.smallCohortBelow || 30;
  const past = isPastRange(data.range, meta);
  const open = rangeIsOpen(data.range);
  const period = rangeSentence(data.range) || null;
  const years = data.years || [];
  const charts = [];
  const empty = !t.students;

  put(el,
    pageHead({
      crumbs: [{ label: 'Campuses', href: link('/campuses', {}, ctx) }],
      title: campus === 'Unknown' ? 'Students without a campus' : `${campus} campus`,
      range: rangeLine(data.range),
      lede: [
        `${fmt.num(t.students || 0)} tracked students`, t.smallCohort ? [' (', smallMark(t, below), ')'] : null, '. ',
        'Rates are per 100 tracked students or shares of them, so they can be set against the other campuses whatever their size.',
      ],
      actions: [
        h('a', { class: 'btn', href: link('/students', { campus }, ctx) }, `Students at ${campus}`),
        csvButton('/export/students.csv', { campus, ...range }),
      ],
    }),
    rangeControl(meta, ctx),
  );

  if (empty) {
    put(el, card({}, h('p', { class: 'muted' }, 'No tracked students at this campus yet. ', h('a', { href: link('/campuses', {}, ctx) }, 'Compare the campuses'))));
    return undefined;
  }

  // ── headline band ──
  const vsAll = (v) => (campus === 'Unknown' ? null : `all campuses ${v}`);
  const delta = deltaLine(t, data.previousRange);
  put(el, h('div', { class: 'cards' },
    statCard({
      key: true, label: 'Students with a merged open-source PR', value: pctVal(t.withOsMergedPct),
      sub: [`${fmt.num(t.withOsMerged)} of ${fmt.num(t.students)}`, vsAll(pctVal(all.withOsMergedPct)) ? ` · ${vsAll(pctVal(all.withOsMergedPct))}` : null],
      href: link('/students', { campus, hasOs: '1' }, ctx), title: 'See the students',
    }),
    statCard({
      label: 'Merged open-source PRs per 100 students', value: rate(t.osMergedPer100),
      sub: [`${fmt.num(t.osMerged)} merged`, vsAll(rate(all.osMergedPer100)) ? ` · ${vsAll(rate(all.osMergedPer100))}` : null],
      href: link('/prs', { campus, state: 'merged' }, ctx), title: 'See the merged open-source pull requests',
    }),
    statCard({
      label: 'Merged in major projects', value: t.osMajorMerged,
      sub: [`${rate(t.osMajorMergedPer100)} per 100`, vsAll(rate(all.osMajorMergedPer100)) ? ` · ${vsAll(rate(all.osMajorMergedPer100))}` : null],
      href: link('/prs', { campus, state: 'merged', tier: 'major' }, ctx),
    }),
    statCard({ label: 'Students merged into a major project', value: t.withMajorMerged, sub: `${pctVal(t.withMajorMergedPct)} of the campus` }),
    statCard({ label: 'Open-source PRs opened', value: t.osPrs, sub: `${rate(t.osPrsPer100)} per 100 students` })),
  delta ? h('p', { class: 'fine' }, delta, '. ', `The earlier period is ${fmt.range(data.previousRange.from, data.previousRange.to)}, counted on today’s list of students.`) : null);

  // ── month by month + funnel ──
  const months = (activity && activity.byMonth ? activity.byMonth : []).map((m) => m.month);
  const cm = new Map(((activity && activity.byCampusMonth) || []).filter((r) => r.campus === campus).map((r) => [r.month, r]));
  const monthly = data.monthly || [];
  const useActivity = months.length > 0 && (scale === 'share' || !monthly.length);
  const monthCanvas = h('canvas');
  let monthInput = null;
  if (scale === 'share' && months.length) {
    monthInput = {
      labels: months, format: (v) => pctVal(v), axisTitle: AXIS.share, unit: '% of tracked students who opened or merged an open-source PR',
      series: [{ label: 'Active students', color: 1, data: months.map((m) => (cm.get(m) ? cm.get(m).activePct : 0)) }],
      tooltipLabel: (si, di) => { const r = cm.get(months[di]); return `${pctVal(r ? r.activePct : 0)} active · ${fmt.num(r ? r.activeStudents : 0)} of ${fmt.num(t.students)} students`; },
      label: `Share of ${campus} students who opened or merged an open-source pull request, per month`,
    };
  } else if (monthly.length || useActivity) {
    const src = monthly.length ? monthly.map((m) => ({ month: m.month, o: m.osOpened, m: m.osMerged, po: m.osOpenedPer100, pm: m.osMergedPer100 }))
      : months.map((mo) => { const r = cm.get(mo) || {}; return { month: mo, o: r.opened || 0, m: r.merged || 0, po: r.per100Opened ?? 0, pm: r.per100Merged ?? 0 }; });
    const per = scale !== 'raw';
    monthInput = {
      labels: src.map((m) => m.month), format: per ? (v) => rate(v) : null,
      axisTitle: per ? AXIS.per100 : AXIS.raw, unit: per ? 'Open-source PRs per 100 tracked students' : 'Open-source PRs',
      series: [
        { label: 'Opened', color: 1, data: src.map((m) => (per ? m.po : m.o)) },
        { label: 'Merged', color: 'merged', data: src.map((m) => (per ? m.pm : m.m)) },
      ],
      tooltipLabel: (si, di) => {
        const m = src[di];
        const [count, r, word] = si === 0 ? [m.o, m.po, 'opened'] : [m.m, m.pm, 'merged'];
        return per ? `${rate(r)} ${word} per 100 · ${fmt.num(count)} PRs · ${fmt.num(t.students)} students` : `${fmt.num(count)} ${word} · ${rate(r)} per 100 · ${fmt.num(t.students)} students`;
      },
      label: `Open-source pull requests by ${campus} students opened and merged per month${per ? ', per 100 tracked students' : ''}`,
    };
  }
  // `overall` is a plain stat block: rebuild its funnel from the counts so the campus can be read against it
  const funnelOf = (s) => s.funnel || [
    { key: 'tracked', label: 'Tracked students', count: s.students, pct: 100 },
    { key: 'anyPr', label: 'Any PR', count: s.withAnyPr, pct: s.withAnyPrPct },
    { key: 'osPr', label: 'Open-source PR', count: s.withOsPr, pct: s.withOsPrPct },
    { key: 'osMerged', label: 'Merged open-source PR', count: s.withOsMerged, pct: s.withOsMergedPct },
    { key: 'majorMerged', label: 'Merged in a major project', count: s.withMajorMerged, pct: s.withMajorMergedPct },
  ];
  const pair = campus === 'Unknown' || !all.students ? [{ ...t, funnel: funnelOf(t) }]
    : [{ ...t, funnel: funnelOf(t) }, { ...all, campus: 'All campuses', funnel: funnelOf(all), smallCohort: false }];
  const groupLabel = (g) => (g.campus === campus ? h('b', null, campus) : g.campus);
  const ym = yearMetric(scale);
  put(el,
    h('div', { class: 'section-head' }, h('h2', null, 'How far students get'), scaleToggle(ctx, 'funnel', { two: ['Share of students', 'Counts'] })),
    card({ flush: true },
      funnelMatrix(pair, { scale, ctx, below, labelOf: groupLabel }),
      h('p', { class: 'card-note card-note-pad' }, 'Each step is a subset of the one before. Bars are scaled within a column.')),
    h('div', { class: 'section-head' }, h('h2', null, 'Month by month and by year of study'), scaleToggle(ctx, 'month', { labels: { share: 'Share of students' } })),
    h('div', { class: 'grid grid-2' },
      card({ title: 'Open-source pull requests by month', note: monthInput ? monthInput.unit : null },
        monthInput ? [
          h('div', { class: 'chart-box' }, monthCanvas),
          h('p', { class: 'card-note' },
            scale === 'share' ? 'A student is active in a month when they opened or merged an open-source pull request in it. ' : null,
            open ? 'The current month is incomplete.' : null),
        ] : h('p', { class: 'muted' }, 'No monthly figures for this period.')),
      card({ title: 'By year of study', note: ym.unit },
        years.length ? yearBars(years, { scale, past, below }) : h('p', { class: 'muted' }, 'No students with a known year.'),
        h('p', { class: 'card-note' }, past ? 'Year of study is as of today; the batch is shown beside it.' : 'Year of study as of today.'))),
    card({ flush: true },
      campusYearTable({ smallCohortBelow: below }, {
        ctx, past, rateMode: scale !== 'raw', firstColumn: 'year', caption: `Students and pull requests at ${campus} by year of study`,
        rows: [...years.map((r) => ({ ...r, _kind: null })), { ...t, _kind: 'total' }],
      }),
      h('p', { class: 'card-note card-note-pad' }, scale !== 'raw'
        ? 'Student columns are shares of the tracked students; pull-request columns are per 100 tracked students. Hover a figure for its count.'
        : 'Counts, with the two headline rates beside them.')));

  // ── what the work is ──
  const mixGroups = campus === 'Unknown' || !all.students ? [t] : [t, { ...all, campus: 'All campuses', smallCohort: false }];
  put(el,
    h('div', { class: 'section-head' }, h('h2', null, 'What the work is'), scaleToggle(ctx, 'mix', { labels: { share: 'Mix (100%)' } })),
    h('div', { class: 'grid grid-2' },
      card({ title: 'Merged open-source PRs by project tier' }, tierMixBlock(mixGroups, { scale, ctx, below })),
      card({ title: 'All pull requests by category' }, categoryMixBlock(mixGroups, { scale, below }),
        h('p', { class: 'card-note' }, 'Only the open-source part counts towards the headline. ', h('a', { href: link('/about', {}, ctx) }, 'How categories work')))));

  // ── concentration ──
  const distRows = [{ ...t, _label: h('b', null, 'All years') }, ...years.map((r) => ({ ...r, _label: yearLabel(r, past) }))];
  put(el,
    h('div', { class: 'section-head' }, h('h2', null, 'How concentrated the work is'), h('span', { class: 'muted' }, 'Merged open-source pull requests per contributing student')),
    card({ flush: true },
      distributionTable(distRows, { ctx, first: 'Year', labelOf: (r) => r._label, caption: `How the merged open-source pull requests of ${campus} are spread over students` }),
      h('div', { class: 'card-note card-note-pad' }, spreadKey())));

  // ── when ──
  const strip = activityCard(activity, ctx, { card, calendarHeatmap, linkQuery: { campus }, unit: 'open-source pull requests opened', title: 'When the work happens' });
  if (strip) put(el, strip.el);

  // ── who and where ──
  const top = data.topStudents || [];
  const maxStudent = Math.max(0, ...top.map((s) => s.stats.osMerged));
  const repos = data.topRepos || [];
  const orgs = data.topOrgs || [];
  const maxRepo = Math.max(0, ...repos.map((r) => r.osMerged));
  const maxOrg = Math.max(0, ...orgs.map((r) => r.osMerged));
  const shared = data.sharedOrgs || [];
  put(el,
    h('div', { class: 'section-head' }, h('h2', null, 'Students and projects'), h('span', { class: 'muted' }, 'Ranked by merged open-source pull requests')),
    card({ title: `Top ${top.length === 20 ? '20 ' : ''}students`, note: h('a', { href: link('/students', { campus }, ctx) }, `All students at ${campus}`), flush: true },
      top.length ? mixLegend() : null,
      table({
        compact: true, caption: `Students at ${campus} by merged open-source pull requests`, rows: top, empty: 'No merged open-source pull requests in this period.',
        columns: [
          { key: 'name', label: 'Student', render: (s) => studentCell(s, ctx) },
          { key: 'year', label: 'Year', render: (s) => yearLabel(s, past) },
          { key: 'osMerged', label: 'Merged open-source', num: true, render: (s) => barCell(s.stats.osMerged, maxStudent) },
          { key: 'stats.osPrs', label: 'Open-source PRs', num: true },
          { key: 'stats.osMajorMerged', label: 'Major merged', num: true },
          { key: 'stats.osRepos', label: 'Projects', num: true },
          { key: 'stats.totalPrs', label: 'All PRs', num: true },
          { key: 'mix', label: 'Mix', title: 'All pull requests by category', render: (s) => mixBar(s.stats.byCategory, { merged: s.stats.osMerged, period }) },
        ],
      })),
    h('div', { class: 'grid grid-2' },
      card({ title: 'Top projects', flush: true },
        table({
          compact: true, caption: `Projects by merged open-source pull requests from ${campus}`, rows: repos, empty: 'No merged open-source pull requests in this period.',
          columns: [
            {
              key: 'name', label: 'Project',
              render: (r) => h('div', null, h('a', { class: 'cell-clip', href: repoHref(r.name, ctx), title: r.name }, r.name),
                h('div', { class: 'sub' }, tierBadge(r.tier), ` ${fmt.compact(r.stars)} stars`)),
            },
            { key: 'osMerged', label: 'Merged', num: true, render: (r) => barCell(r.osMerged, maxRepo) },
            { key: 'students', label: 'Students', num: true },
          ],
        })),
      card({ title: 'Top organisations', flush: true },
        table({
          compact: true, caption: `Organisations by merged open-source pull requests from ${campus}`, rows: orgs, empty: 'No merged open-source pull requests in this period.',
          columns: [
            { key: 'login', label: 'Organisation', render: (r) => h('a', { href: orgHref(r.login, ctx) }, r.login) },
            { key: 'osMerged', label: 'Merged', num: true, render: (r) => barCell(r.osMerged, maxOrg) },
            { key: 'osPrs', label: 'Open-source PRs', num: true },
            { key: 'students', label: 'Students', num: true },
          ],
        }))),
    shared.length ? card({ title: 'Organisations shared with other campuses', note: fmt.num(shared.length), flush: true },
      table({
        compact: true, caption: `Organisations with open-source pull requests from ${campus} and at least one other campus`, rows: shared.slice(0, 15),
        columns: [
          { key: 'login', label: 'Organisation', render: (o) => h('a', { href: orgHref(o.login, ctx) }, o.login) },
          { key: 'here', label: `Merged from ${campus}`, num: true, render: (o) => fmt.num(((o.byCampus || []).find((b) => b.campus === campus) || {}).osMerged || 0) },
          { key: 'osMerged', label: 'Merged, all campuses', num: true },
          {
            key: 'others', label: 'Also from',
            render: (o) => (o.byCampus || []).filter((b) => b.campus !== campus).flatMap((b, i) => [i ? ', ' : null, campusLink(b.campus, ctx), ` ${fmt.num(b.osMerged)}`]),
          },
          { key: 'students', label: 'Students', num: true },
        ],
      })) : null);

  if (monthInput) charts.push(scale === 'share' ? barChart(monthCanvas, monthInput) : lineChart(monthCanvas, monthInput));
  if (strip) charts.push(strip.draw(barChart));
  return () => charts.forEach((c) => c.destroy());
}
