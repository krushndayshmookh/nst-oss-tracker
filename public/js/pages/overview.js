// Overview: the state of open source at NST at a glance.
// GET /overview?campus&year, GET /campuses, GET /meta (+ GET /activity when the server has date ranges).

import { api } from '../lib/api.js';
import { setQuery } from '../lib/router.js';
import {
  h, pageHead, filterBar, statCard, card, table, funnel, mixBar, mixLegend, barCell, tierBadge, calendarHeatmap, fmt, TIERS, TIER_LABELS,
} from '../lib/ui.js';
import { lineChart, barChart, doughnutChart } from '../lib/charts.js';
import {
  getMeta, hasRanges, rangeParams, rangeControl, rangeLine, rangeSentence, rangeIsOpen, isPastRange, activityCard, link, studentCell, repoHref, orgHref, csvButton, opts, clean, put
} from './common.js';
import {
  scaleOf, scaleToggle, campusYearTable, yearMetric, cohortLabel, campusColor, rate, pctVal, CAMPUS_SORT_DEFAULT, AXIS,
} from './campus-common.js';
import { techList, isWeb } from './tech-common.js';

/** Campus × year series for the comparison chart in one scale. Unknown campus / year stay in the table only. */
function campusSeries(campuses, scale) {
  const rows = (campuses.rows || []).filter((r) => r.campus !== 'Unknown' && r.year !== 'Unknown' && r.students > 0);
  const order = ['1st year', '2nd year', '3rd year', '4th year', 'alumni'];
  const years = order.filter((y) => rows.some((r) => r.year === y));
  const sizes = new Map((campuses.campuses || []).map((c) => [c.campus, c]));
  const names = [...new Set(rows.map((r) => r.campus))].slice(0, 5);
  const cell = (campus, year) => rows.find((r) => r.campus === campus && r.year === year);
  const m = yearMetric(scale);
  return {
    years, names, unit: m.unit,
    series: names.map((campus, i) => ({
      label: sizes.has(campus) ? cohortLabel(sizes.get(campus)) : campus, color: campusColor(campus, i),
      data: years.map((y) => { const r = cell(campus, y); return r ? m.value(r) : null; }),
    })),
    format: scale === 'share' ? (v) => pctVal(v) : scale === 'per100' ? (v) => rate(v) : null,
    tooltipLabel: (si, di) => {
      const r = cell(names[si], years[di]);
      if (!r) return null;
      return `${r.campus} · ${m.text(r)}${scale === 'per100' ? ' per 100' : scale === 'raw' ? ' merged' : ''} · ${m.note(r)} · ${fmt.num(r.students)} students${r.smallCohort ? ' (small cohort)' : ''}`;
    },
  };
}

export default async function (el, ctx) {
  const meta = await getMeta();
  const range = rangeParams(ctx.query, meta);
  const cohort = clean({ campus: ctx.query.campus, year: ctx.query.year });
  const [overview, campuses, activity, techLang, techDomain] = await Promise.all([
    api.get('/overview', { ...cohort, ...range }),
    api.get('/campuses', range),
    hasRanges(meta) ? api.get('/activity', { ...cohort, ...range }).catch(() => null) : null,
    // the "Top technologies" strip (SPEC addendum H); the page still renders when the endpoint is missing
    api.get('/tech', { by: 'language', ...cohort, ...range }).catch(() => null),
    api.get('/tech', { by: 'domain', ...cohort, ...range }).catch(() => null),
  ]);
  const charts = [];
  const canvas = () => h('canvas');
  const { students, prs } = overview;
  const rules = meta.rulesSummary || {};
  const majorStars = rules.tiers ? fmt.num(rules.tiers.major) : '1,000';
  const filtered = Boolean(cohort.campus || cohort.year);
  const scope = [cohort.campus, cohort.year].filter(Boolean).join(', ');
  const campusCount = (meta.campuses || []).filter((c) => c !== 'Unknown').length;

  // ── head, range, filters ──
  const open = rangeIsOpen(overview.range);
  const past = isPastRange(overview.range, meta);
  const ranged = Boolean(overview.range && (overview.range.from || overview.range.to));
  put(el, 
    pageHead({
      title: 'Open-source work by NST students',
      lede: [
        `${fmt.num(meta.counts ? meta.counts.students : students.tracked)} students tracked across ${campusCount} campuses. `,
        'The headline counts pull requests merged into established public projects; coursework, practice repositories and personal projects are shown separately. ',
        ranged ? 'Every figure on this page counts pull requests opened or merged in the period above.' : null,
      ],
      range: rangeLine(overview.range),
      actions: [csvButton('/export/students.csv', { ...cohort, ...range })],
    }),
    rangeControl(meta, ctx),
    filterBar({
      fields: [
        { name: 'campus', label: 'Campus', type: 'select', options: opts(meta.campuses), allLabel: 'All campuses' },
        { name: 'year', label: 'Year', type: 'select', options: opts(meta.years), allLabel: 'All years' },
      ],
      values: ctx.query,
      onChange: (v) => setQuery(v),
    }),
  );

  // ── headline band ──
  put(el, h('div', { class: 'cards' },
    statCard({
      key: true, label: 'Merged open-source PRs', value: prs.osMerged, sub: `of ${fmt.num(prs.osPrs)} opened`,
      href: link('/prs', { ...cohort, state: 'merged' }, ctx), title: 'See the merged open-source pull requests',
    }),
    statCard({
      label: 'Students with a merged open-source PR', value: students.withOsMerged,
      sub: `${fmt.pct(students.withOsMerged, students.tracked)} of ${fmt.num(students.tracked)} tracked`,
      href: link('/students', { ...cohort, hasOs: '1' }, ctx), title: 'See the students',
    }),
    statCard({ label: 'Students merged into a major project', value: students.withMajorMerged, sub: `projects with ${majorStars}+ stars` }),
    statCard({
      label: 'Merged PRs in major projects', value: prs.osMergedByTier.major, sub: `${fmt.pct(prs.osMergedByTier.major, prs.osMerged)} of merged`,
      href: link('/prs', { ...cohort, state: 'merged', tier: 'major' }, ctx), title: 'See the pull requests merged into major projects',
    }),
    statCard({ label: 'Open-source PRs awaiting review', value: prs.osOpen, sub: ranged ? 'opened in the period, open now' : 'open now', href: link('/prs', { ...cohort, state: 'open' }, ctx) }),
  ));

  // ── trend + funnel ──
  const monthly = Array.isArray(overview.monthly) && overview.monthly.length
    ? overview.monthly
    : ((activity && activity.byMonth) || []).map((m) => ({ month: m.month, osOpened: m.opened, osMerged: m.merged, allOpened: null }));
  const trendCanvas = canvas();
  const allOpened = monthly.reduce((sum, m) => sum + (m.allOpened || 0), 0);
  const recent = monthly.slice(-13, -1); // the last 12 complete months
  const before = monthly.slice(-25, -13);
  const sum = (list, key) => list.reduce((s, m) => s + (m[key] || 0), 0);
  let trendNote = null;
  if (open && recent.length === 12 && before.length >= 11 && sum(before, 'osMerged') > 0) {
    const a = sum(recent, 'osMerged');
    const b = sum(before, 'osMerged');
    const change = Math.round(((a - b) / b) * 100);
    const how = change >= 200 ? `${(a / b).toFixed(1)} times the 12 before` : `${change >= 0 ? 'up' : 'down'} ${Math.abs(change)}% on the 12 before`;
    trendNote = `${fmt.num(a)} merged in the last 12 complete months, ${how} (${fmt.num(b)}).`;
  }
  const trendCard = card({ title: 'Open-source pull requests by month', note: monthly.length ? `${fmt.month(monthly[0].month)} to ${fmt.month(monthly[monthly.length - 1].month)}` : null },
    h('div', { class: 'chart-box' }, trendCanvas),
    h('p', { class: 'card-note' },
      trendNote, trendNote ? ' ' : null,
      allOpened ? `Across all categories students opened ${fmt.num(allOpened)} pull requests in the same months. ` : null,
      open ? 'The current month is incomplete.' : null));
  const funnelCard = card({ title: 'From tracked to merged', note: scope || null },
    funnel([
      { label: 'Students tracked', value: students.tracked },
      { label: 'With any pull request', value: students.withAnyPr },
      { label: 'With an open-source pull request', value: students.withOsPr },
      { label: 'With a merged open-source pull request', value: students.withOsMerged },
      { label: 'Merged into a major project', value: students.withMajorMerged },
    ]),
    h('p', { class: 'card-note' }, 'Each bar is a share of the students tracked.'));
  put(el, h('div', { class: 'grid grid-main' }, trendCard, funnelCard));

  // ── activity strip: calendar + weekday, linking to the Activity page (needs GET /api/activity) ──
  const strip = activityCard(activity, ctx, {
    card, calendarHeatmap, linkQuery: cohort, unit: 'open-source pull requests opened', title: 'When the work happens',
  });
  if (strip) put(el, strip.el);

  // ── campus by year ──
  // Campuses differ a lot in size: the chart defaults to a rate, and the table sorts by one (SPEC addendum D).
  const scale = scaleOf(ctx.query);
  const cs = campusSeries(campuses, scale);
  const campusCanvas = canvas();
  const period = rangeSentence(overview.range) || null;
  const csort = ctx.query.csort || CAMPUS_SORT_DEFAULT;
  const corder = ctx.query.corder || (csort === 'campus' ? 'asc' : 'desc');
  const campusNote = [filtered ? `All campuses and years. The filter above (${scope}) does not apply here. ` : null,
    past ? 'Year of study is as of today; the batch is shown beside it. ' : 'Year of study as of today. ',
    h('a', { href: link('/campuses', {}, ctx) }, 'Compare the campuses in detail')];
  put(el, h('div', { class: 'section-head' }, h('h2', null, 'Campus by year'), h('span', { class: 'muted' }, campusNote)));
  if (cs.years.length && cs.names.length) {
    put(el, card({ title: 'Merged open-source work by campus and year of study', note: scaleToggle(ctx, 'campus') },
      h('p', { class: 'chart-unit' }, cs.unit),
      h('div', { class: 'chart-box chart-box-sm' }, campusCanvas),
      h('p', { class: 'card-note' },
        scale === 'raw' ? 'Raw counts are not adjusted for the size of a cohort. ' : 'Rates are on the tracked students of each campus and year. ',
        'The number after a campus is its tracked students.')));
  }
  put(el, card({ flush: true },
    mixLegend(),
    campusYearTable(campuses, {
      ctx, past, mix: true, period, sort: csort, order: corder,
      onSort: (s, o) => { const d = s === CAMPUS_SORT_DEFAULT && o === 'desc'; setQuery({ csort: d ? '' : s, corder: d ? '' : o }); },
    }),
    h('p', { class: 'card-note card-note-pad' }, 'Sorted by the share of students with a merged open-source pull request unless you sort otherwise; campuses are ordered by their total.')));

  // ── top projects, organisations, students ──
  const seeAll = (text, to) => h('a', { href: to }, text);
  const maxRepo = Math.max(0, ...overview.topRepos.map((r) => r.osMerged));
  const maxOrg = Math.max(0, ...overview.topOrgs.map((r) => r.osMerged));
  const maxStudent = Math.max(0, ...overview.topStudents.map((s) => s.stats.osMerged));
  put(el, 
    h('div', { class: 'section-head' }, h('h2', null, 'Where the merged work lands'),
      h('span', { class: 'muted' }, `Ranked by merged open-source pull requests${scope ? `, ${scope}` : ''}`)),
    h('div', { class: 'grid grid-3' },
      card({ title: 'Top projects', note: seeAll('All projects', link('/projects', {}, ctx)), flush: true },
        table({
          compact: true, caption: 'Top projects by merged open-source pull requests', rows: overview.topRepos, empty: 'No merged open-source pull requests in this period.',
          columns: [
            {
              key: 'name', label: 'Project',
              render: (r) => h('div', null,
                h('a', { class: 'cell-clip', style: { maxWidth: '17ch' }, href: repoHref(r.name, ctx), title: r.name }, r.name),
                h('div', { class: 'sub' }, tierBadge(r.tier), ` ${fmt.compact(r.stars)} stars`)),
            },
            { key: 'osMerged', label: 'Merged', num: true, render: (r) => barCell(r.osMerged, maxRepo) },
            { key: 'students', label: 'Students', num: true },
          ],
        })),
      card({ title: 'Top organisations', note: seeAll('All organisations', link('/orgs', {}, ctx)), flush: true },
        table({
          compact: true, caption: 'Top organisations by merged open-source pull requests', rows: overview.topOrgs, empty: 'No merged open-source pull requests yet.',
          columns: [
            { key: 'login', label: 'Organisation', render: (r) => h('a', { href: orgHref(r.login, ctx) }, r.login) },
            { key: 'osMerged', label: 'Merged', num: true, render: (r) => barCell(r.osMerged, maxOrg) },
            { key: 'students', label: 'Students', num: true },
          ],
        })),
      card({ title: 'Top students', note: seeAll('All students', link('/students', cohort, ctx)), flush: true },
        table({
          compact: true, caption: 'Students by merged open-source pull requests', rows: overview.topStudents, empty: 'No merged open-source pull requests yet.',
          columns: [
            { key: 'name', label: 'Student', render: (s) => studentCell(s, ctx, { sub: 'cohort', past }) },
            { key: 'osMerged', label: 'Merged', num: true, render: (s) => barCell(s.stats.osMerged, maxStudent) },
          ],
        }))),
  );

  // ── top technologies ──
  if (techLang && techDomain && techLang.totals && techLang.totals.merged > 0) {
    const t = techLang.totals;
    const opts = { ctx, n: 5, text: (r) => fmt.num(r.merged), note: (r) => `${fmt.pct(r.merged, t.merged)} · ${fmt.num(r.mergedStudents)} students` };
    const webShare = (data, by) => fmt.pct((data.rows || []).filter((r) => isWeb(by, r.key)).reduce((s, r) => s + r.merged, 0), t.merged);
    put(el,
      h('div', { class: 'section-head' }, h('h2', null, 'Top technologies'),
        h('span', { class: 'muted' }, `Merged open-source pull requests by the project’s main language and technology area${scope ? `, ${scope}` : ''}. `,
          h('a', { href: link('/tech', cohort, ctx) }, 'All technologies'))),
      h('div', { class: 'grid grid-2' },
        card({ title: 'Languages', note: `web languages ${webShare(techLang, 'language')} of merged` }, techList(techLang.rows || [], { ...opts, by: 'language' })),
        card({ title: 'Technology areas', note: `web ${webShare(techDomain, 'domain')} of merged` }, techList(techDomain.rows || [], { ...opts, by: 'domain' }))));
  }

  // ── composition ──
  const tierCanvas = canvas();
  const outcomeCanvas = canvas();
  const osClosed = Math.max(0, prs.osPrs - prs.osMerged - prs.osOpen);
  put(el, 
    h('div', { class: 'section-head' }, h('h2', null, 'What the pull requests are'), scope ? h('span', { class: 'muted' }, scope) : null),
    h('div', { class: 'grid grid-3' },
      card({ title: 'Merged by project tier' },
        prs.osMerged ? h('div', { class: 'chart-box chart-box-sm' }, tierCanvas) : h('p', { class: 'muted' }, 'No merged open-source pull requests yet.'),
        h('p', { class: 'card-note' }, `Major: ${majorStars}+ stars. Established: ${rules.tiers ? fmt.num(rules.tiers.established) : '200'}+. Emerging: below that.`)),
      card({ title: 'Open-source PR outcome' },
        prs.osPrs ? h('div', { class: 'chart-box chart-box-sm' }, outcomeCanvas) : h('p', { class: 'muted' }, 'No open-source pull requests yet.'),
        h('p', { class: 'card-note' }, `${fmt.pct(prs.osMerged, prs.osMerged + osClosed)} of the open-source pull requests that have been decided were merged.`)),
      card({ title: 'All pull requests by category', note: fmt.num(prs.total) },
        mixBar(prs.byCategory, { merged: prs.osMerged, period, legend: true, large: true }),
        h('p', { class: 'card-note' },
          `Only the ${fmt.pct(prs.byCategory.open_source, prs.total)} classified as open source count towards the headline. `,
          h('a', { href: link('/about', {}, ctx) }, 'How categories work')))),
  );

  // charts are created after the canvases are in the page element; Chart.js sizes them once that is attached
  charts.push(lineChart(trendCanvas, {
    labels: monthly.map((m) => m.month),
    series: [
      { label: 'Opened', data: monthly.map((m) => m.osOpened), color: 1 },
      { label: 'Merged', data: monthly.map((m) => m.osMerged), color: 'merged' },
    ],
    label: `Open-source pull requests opened and merged per month. ${trendNote || ''}`,
  }));
  if (cs.years.length && cs.names.length) {
    charts.push(barChart(campusCanvas, {
      labels: cs.years, series: cs.series, format: cs.format, tooltipLabel: cs.tooltipLabel, axisTitle: AXIS[scale],
      label: `${cs.unit}, by campus and year of study`,
    }));
  }
  if (prs.osMerged) {
    charts.push(doughnutChart(tierCanvas, {
      labels: TIERS.map((t) => TIER_LABELS[t]), data: TIERS.map((t) => prs.osMergedByTier[t] || 0),
      label: `Merged open-source pull requests by project tier: ${TIERS.map((t) => `${TIER_LABELS[t]} ${fmt.num(prs.osMergedByTier[t] || 0)}`).join(', ')}`,
    }));
  }
  if (prs.osPrs) {
    charts.push(doughnutChart(outcomeCanvas, {
      labels: ['Merged', 'Open', 'Closed'], data: [prs.osMerged, prs.osOpen, osClosed],
      label: `Open-source pull requests: ${fmt.num(prs.osMerged)} merged, ${fmt.num(prs.osOpen)} open, ${fmt.num(osClosed)} closed without merging`,
    }));
  }
  if (strip) charts.push(strip.draw(barChart));

  return () => charts.forEach((c) => c.destroy());
}
