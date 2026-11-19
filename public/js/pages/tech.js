// Technologies: what students work on and contribute to (SPEC addendum H). GET /tech?by=language|domain.
// Query keys: by (language | domain), cat ('' = open source | all), campus, year, scale (campus table), the date range.

import { api } from '../lib/api.js';
import { setQuery } from '../lib/router.js';
import { h, pageHead, filterBar, statCard, card, table, segmented, barCell, fmt } from '../lib/ui.js';
import { barChart, lineChart } from '../lib/charts.js';
import { getMeta, rangeParams, rangeControl, rangeLine, rangeIsOpen, link, repoHref, campusLink, opts, clean, put } from './common.js';
import { scaleOf, scaleToggle, rate, smallMark } from './campus-common.js';
import { BY_LABELS, BY_PLURAL, REST_KEY, isWeb, techHref, heatLevel } from './tech-common.js';

const CHART_ROWS = 12;
const TREND_KEYS = 5;
const HEAT_KEYS = 10;

export default async function (el, ctx) {
  const meta = await getMeta();
  const q = ctx.query;
  const by = q.by === 'domain' ? 'domain' : 'language';
  const all = q.cat === 'all';
  const range = rangeParams(q, meta);
  const cohort = clean({ campus: q.campus, year: q.year });
  const data = await api.get('/tech', { by, category: all ? 'all' : '', ...cohort, ...range });
  const { totals } = data;
  const rows = data.rows || [];
  const merged = rows.filter((r) => r.merged > 0);
  const what = BY_LABELS[by].toLowerCase();
  const prsWord = all ? 'pull requests' : 'open-source pull requests';
  const scope = [cohort.campus, cohort.year].filter(Boolean).join(', ');
  const charts = [];

  // ── head, range, switches, filters ──
  put(el,
    pageHead({
      title: 'Technologies',
      range: rangeLine(data.range),
      lede: [
        `Which ${BY_PLURAL[by]} students’ ${prsWord} go to. `,
        by === 'language'
          ? 'Each pull request counts under the main language of its project, as GitHub reports it. '
          : 'Each project gets one technology area from a published rule table (its GitHub topics, then words in its name and description, then its main language). ',
        'Counts are pull requests merged in the period; a student counts once per technology.',
      ],
    }),
    rangeControl(meta, ctx),
    h('div', { class: 'toolbar techbar' },
      segmented({
        name: 'by', label: 'Group by', value: by,
        options: [{ value: 'language', label: 'Language' }, { value: 'domain', label: 'Technology area' }],
        onChange: (v) => setQuery({ by: v === 'language' ? '' : v }),
      }),
      segmented({
        name: 'cat', label: 'Which work', value: all ? 'all' : 'os',
        options: [{ value: 'os', label: 'Open source' }, { value: 'all', label: 'All work' }],
        onChange: (v) => setQuery({ cat: v === 'all' ? 'all' : '' }),
      }),
      h('span', { class: 'muted techbar-note' }, all ? 'All work includes own and course repos.' : 'Open source: pull requests to established public projects.')),
    filterBar({
      fields: [
        { name: 'campus', label: 'Campus', type: 'select', options: opts(meta.campuses), allLabel: 'All campuses' },
        { name: 'year', label: 'Year', type: 'select', options: opts(meta.years), allLabel: 'All years' },
      ],
      values: q,
      onChange: (v) => setQuery(v),
    }),
  );

  // ── headline band ──
  const web = rows.filter((r) => isWeb(by, r.key)).reduce((s, r) => s + r.merged, 0);
  const lead = merged[0];
  put(el, h('div', { class: 'cards' },
    statCard({ key: true, label: all ? 'Merged pull requests' : 'Merged open-source PRs', value: totals.merged, sub: `of ${fmt.num(totals.prs)} opened` }),
    statCard({ label: 'Students with a merged PR', value: totals.mergedStudents, sub: `${fmt.num(totals.students)} sent at least one` }),
    statCard({ label: `Most merged ${what}`, value: lead ? lead.label : null, sub: lead ? `${fmt.pct(lead.merged, totals.merged)} of merged · ${fmt.num(lead.mergedStudents)} students` : null }),
    statCard({
      label: by === 'domain' ? 'Web (frontend, backend, full-stack)' : 'Web languages (JS, TS, HTML, CSS…)',
      value: fmt.pct(web, totals.merged), sub: `${fmt.num(web)} of ${fmt.num(totals.merged)} merged`,
    }),
    statCard({ label: by === 'domain' ? 'Areas with merged work' : 'Languages with merged work', value: merged.length, sub: `${fmt.num(totals.repos)} projects` })));

  // ── chart + table ──
  const chartRows = merged.slice(0, CHART_ROWS);
  const barCanvas = h('canvas');
  const max = merged.length ? merged[0].merged : 0;
  put(el,
    card({ title: `Merged ${prsWord} by ${what}`, note: scope || null },
      chartRows.length
        ? h('div', { class: 'chart-box chart-box-tech', style: { height: `${Math.max(200, 44 + chartRows.length * 30)}px` } }, barCanvas)
        : h('p', { class: 'muted' }, `No merged ${prsWord} in this period.`),
      chartRows.length ? h('p', { class: 'card-note' },
        merged.length > CHART_ROWS ? `The ${CHART_ROWS} with the most merged pull requests; the table below lists all ${fmt.num(rows.length)}. ` : null,
        'Students: those with at least one merged pull request in that ', what, '. Select a name in the table to see its projects.') : null),
    card({ flush: true },
      table({
        caption: `${BY_LABELS[by]}s by merged ${prsWord}`, rows, empty: `No ${prsWord} in this period.`,
        columns: [
          { key: 'label', label: BY_LABELS[by], render: (r) => h('a', { href: techHref(by, r.key, ctx, { all }), title: by === 'domain' ? `Projects in ${r.label}` : `Projects in ${r.label}` }, r.label) },
          { key: 'merged', label: 'Merged', num: true, render: (r) => barCell(r.merged, max) },
          { key: 'mergedShare', label: 'Share', num: true, title: 'Share of all merged pull requests in this view', render: (r) => (r.mergedShare === null ? null : `${rate(r.mergedShare)}%`) },
          { key: 'prs', label: 'PRs opened', num: true },
          { key: 'students', label: 'Students', num: true, title: 'Students with a pull request opened or merged in the period', render: (r) => h('span', { title: `${fmt.num(r.mergedStudents)} with a merged pull request` }, fmt.num(r.students)) },
          { key: 'mergedStudents', label: 'Merged by', num: true, title: 'Students with a merged pull request' },
          { key: 'repos', label: 'Projects', num: true },
          {
            key: 'topRepos', label: 'Top projects', wrap: true,
            render: (r) => h('span', { class: 'toprepos' }, r.topRepos.map((p, i) => [i ? ', ' : null,
              h('a', { href: repoHref(p.name, ctx), title: `${fmt.num(p.merged)} merged · ${fmt.num(p.prs)} opened · ${fmt.num(p.students)} students` }, p.name),
              h('span', { class: 'muted' }, ` ${fmt.num(p.merged)}`)])),
          },
        ],
      })));

  // ── campus × technology ──
  const scale = scaleOf(q) === 'raw' ? 'raw' : 'per100';
  const campuses = (data.cohorts || []).filter((c) => c.students > 0 && c.campus !== 'Unknown');
  const heatKeys = merged.slice(0, HEAT_KEYS);
  const cellOf = new Map((data.byCampus || []).map((c) => [`${c.campus}|${c.key}`, c]));
  const valueOf = (c) => (!c ? 0 : scale === 'raw' ? c.merged : (c.per100 || 0));
  const heatMax = Math.max(0, ...heatKeys.flatMap((k) => campuses.map((c) => valueOf(cellOf.get(`${c.campus}|${k.key}`)))));
  const below = data.smallCohortBelow || 30;
  if (campuses.length > 1 && heatKeys.length) {
    put(el,
      h('div', { class: 'section-head' }, h('h2', null, `Campus by ${what}`),
        scaleToggle(ctx, 'heat', { two: ['Per 100 students', 'Raw counts'] })),
      card({ flush: true },
        table({
          caption: `Merged ${prsWord} by campus and ${what}${scale === 'per100' ? ', per 100 tracked students' : ''}`, compact: true,
          rows: heatKeys,
          columns: [
            { key: 'label', label: BY_LABELS[by], render: (r) => h('a', { href: techHref(by, r.key, ctx, { all }) }, r.label) },
            ...campuses.map((c) => ({
              key: `c-${c.campus}`, num: true,
              label: h('span', null, campusLink(c.campus, ctx), h('small', { class: 'th-sub' }, `${fmt.num(c.students)} students`), c.smallCohort ? smallMark(c, below) : null),
              title: `${c.campus}: ${fmt.num(c.students)} tracked students`,
              render: (r) => {
                const cell = cellOf.get(`${c.campus}|${r.key}`);
                const v = valueOf(cell);
                const text = scale === 'raw' ? fmt.num(cell ? cell.merged : 0) : rate(cell ? cell.per100 : 0);
                const tip = cell
                  ? `${c.campus} · ${r.label}: ${rate(cell.per100)} per 100 students · ${fmt.num(cell.merged)} merged · ${fmt.num(cell.students)} of ${fmt.num(c.students)} students`
                  : `${c.campus} · ${r.label}: none`;
                return h('span', { class: 'heatcell', title: tip }, h('i', { class: `heat-${heatLevel(v, heatMax)}`, 'aria-hidden': 'true' }), text);
              },
            })),
            { key: 'merged', label: 'All campuses', num: true, render: (r) => fmt.num(r.merged) },
          ],
        }),
        h('p', { class: 'card-note card-note-pad' },
          scale === 'per100' ? 'Merged pull requests per 100 tracked students of the campus, so campuses of different sizes compare fairly. ' : 'Plain counts: a larger campus has more of everything. ',
          'Darker cells are higher. Hover a cell for the count and the number of students behind it. ',
          (data.cohorts || []).some((c) => c.campus === 'Unknown' && c.merged > 0) ? 'Students without a campus are counted under All campuses only.' : null)));
  }

  // ── trend ──
  const trendKeys = (data.monthKeys || []).filter((k) => k.key !== REST_KEY).slice(0, TREND_KEYS);
  const trendSet = new Set(trendKeys.map((k) => k.key));
  const months = data.months || [];
  const series = trendKeys.map((k, i) => ({ label: k.label, color: i + 1, data: months.map((m) => 0) }));
  const rest = { label: 'Everything else', color: 'other', data: months.map(() => 0) };
  const idx = new Map(months.map((m, i) => [m, i]));
  for (const row of data.byMonth || []) {
    const i = idx.get(row.month);
    if (i === undefined) continue;
    const s = trendSet.has(row.key) ? series[trendKeys.findIndex((k) => k.key === row.key)] : rest;
    s.data[i] += row.merged;
  }
  const hasRest = rest.data.some((v) => v > 0);
  const trendCanvas = h('canvas');
  if (months.length > 1 && trendKeys.length) {
    put(el, card({ title: `Merged ${prsWord} per month, top ${BY_PLURAL[by]}`, note: `${fmt.month(months[0])} to ${fmt.month(months[months.length - 1])}` },
      h('div', { class: 'chart-box' }, trendCanvas),
      h('p', { class: 'card-note' }, `The ${trendKeys.length} ${BY_PLURAL[by]} with the most merged pull requests in the period${hasRest ? '; the grey line is everything else' : ''}. `,
        rangeIsOpen(data.range) ? 'The current month is incomplete.' : null)));
  }

  // ── how it is decided ──
  put(el, card({ title: by === 'domain' ? 'How a project’s technology area is decided' : 'How the language is decided' },
    by === 'domain'
      ? h('div', { class: 'prose' },
        h('p', null, 'Every project gets exactly one area. Rules are tried in order and the first match wins: the project’s GitHub topics, then words in the project or organisation name, then words in its description, then its main language. A project no rule matches is “Other”.'),
        h('p', null, 'A language alone cannot tell frontend from backend: a JavaScript or TypeScript project with no other signal is counted as full-stack web, a Python one as AI / ML & data, a Go one as DevOps / cloud. Each project page shows which rule placed it.'),
        h('p', null, 'Areas: ', (data.domains || []).filter((d) => d.key !== 'other').map((d) => d.label).join(', '), ', and Other.'))
      : h('div', { class: 'prose' },
        h('p', null, 'The language is the one GitHub shows first on the project page (the most code by size). A project in several languages counts under that one only. “(none)” means GitHub found no code: documentation or lists.')),
    h('p', { class: 'card-note' }, h('a', { href: link('/projects', { category: all ? 'all' : '' }, ctx) }, 'All projects'), ' · ',
      h('a', { href: link('/tech', { ...q, by: by === 'domain' ? '' : 'domain' }, ctx) }, by === 'domain' ? 'Group by language instead' : 'Group by technology area instead'))));

  // ── charts ──
  if (chartRows.length) {
    charts.push(barChart(barCanvas, {
      labels: chartRows.map((r) => r.label), horizontal: true,
      series: [
        { label: 'Merged PRs', data: chartRows.map((r) => r.merged), color: 1 },
        { label: 'Students', data: chartRows.map((r) => r.mergedStudents), color: 3 },
      ],
      tooltipLabel: (si, di) => {
        const r = chartRows[di];
        return si === 0 ? `${fmt.num(r.merged)} merged (${rate(r.mergedShare)}% of all)` : `${fmt.num(r.mergedStudents)} students (${fmt.pct(r.mergedStudents, totals.mergedStudents)})`;
      },
      label: `Merged ${prsWord} and students by ${what}: ${chartRows.slice(0, 5).map((r) => `${r.label} ${fmt.num(r.merged)}`).join(', ')}`,
    }));
  }
  if (months.length > 1 && trendKeys.length) {
    charts.push(lineChart(trendCanvas, {
      labels: months, series: hasRest ? [...series, rest] : series,
      label: `Merged ${prsWord} per month for ${trendKeys.map((k) => k.label).join(', ')}`,
    }));
  }
  return () => charts.forEach((c) => c.destroy());
}
