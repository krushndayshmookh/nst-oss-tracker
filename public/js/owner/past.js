// Krushn's dashboard → Past results: how the selected and the not-selected applicants of one past program round
// actually worked during the academic year before selection. Descriptive: a handful of people, never a model.
// Data: GET /api/owner/past-results?program=&year=   (the rounds come from the outcomes stored in Settings → Past outcomes)
//
//   #/owner/past?program=gsoc&year=2025

import { href, setQuery } from '../lib/router.js';
import { h, card, table, segmented, fmt, ghLink } from '../lib/ui.js';
import { barChart } from '../lib/charts.js';
import { oapi, scoreCell, plural } from './common.js';

const shortName = (name) => String(name || '').replace(/\s+20\d\d$/, '');
const roundName = (name, year) => `${shortName(name)} ${year}`;
const MAPPING = {
  exact: ['GitHub login', 'The organisation text is the login of an organisation in our data.'],
  program_orgs: ['Program list', 'Matched through the program\'s organisation list (Settings → Organisation mapping).'],
  contains: ['Login contains it', 'No exact login: every organisation whose login contains this text is counted. Check the logins.'],
  none: ['Not found', 'No organisation in our data matches this text, so nothing counts as target-organisation work.'],
  empty: ['No organisation', 'The outcome names no organisation.'],
};

/** Position of a YYYY-MM-DD date on a monthly category axis: -0.5 = start of the first month, +0.5 per half month. */
function monthPos(ymd, months, { end = false } = {}) {
  const [y, m, d] = ymd.split('-').map(Number);
  const i = months.indexOf(`${y}-${String(m).padStart(2, '0')}`);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (i < 0) return ymd < `${months[0]}-01` ? -0.5 : months.length - 0.5;
  return i - 0.5 + (end ? d : d - 1) / days;
}

/** '2025-04-08' → '8 Apr 2025' (a plain calendar date). */
const day = (ymd) => fmt.range(ymd, ymd).split(' – ')[0];
const n1 = (v) => (v === null || v === undefined ? '–' : (Math.round(v * 10) / 10).toLocaleString('en-IN', { maximumFractionDigits: 1 }));

/** The admin shell does not load Chart.js (only the public one does): load the vendored copy once, on first use. */
let chartJs = null;
function ensureChartJs() {
  if (globalThis.Chart) return Promise.resolve();
  if (!chartJs) {
    chartJs = new Promise((resolve) => {
      const s = h('script', { src: '/vendor/chart.umd.js' });
      s.addEventListener('load', resolve);
      s.addEventListener('error', () => { chartJs = null; resolve(); }); // the chart wrapper then shows its one-line note
      document.head.append(s);
      setTimeout(resolve, 5000);
    });
  }
  return chartJs;
}

export default async function pastPage(el, ctx, shared) {
  const q = ctx.query;
  const [data] = await Promise.all([oapi.get('/past-results', { program: q.program || '', year: q.year || '' }), ensureChartJs()]);
  const rounds = data.available || [];

  if (!rounds.length || !data.groups) {
    el.append(h('div', { class: 'notice' }, 'No past outcomes are stored yet. Add who applied and who was selected in ',
      h('a', { href: href('/owner/settings', { s: 'outcomes' }) }, 'Settings → Past outcomes'), ', then come back here.'));
    return undefined;
  }

  const name = roundName(data.program.name, data.year);
  const { selected: sel, notSelected: not } = data.groups;
  const months = sel.monthly.map((m) => m.month);

  /* ── round picker + what is being compared ── */
  const picker = segmented({
    options: rounds.map((r) => ({ value: `${r.program}:${r.year}`, label: roundName(r.name, r.year), title: `${plural(r.applicants, 'applicant')}, ${r.selected} selected` })),
    value: `${data.program.key}:${data.year}`, label: 'Program round', name: 'round',
    onChange: (v) => { const [program, year] = v.split(':'); setQuery({ program, year }); },
  });
  const dl = data.deadline || {};
  el.append(
    h('div', { class: 'section-head' }, h('h2', null, `${name}: how applicants worked in the year before`), picker),
    h('p', { class: 'fine past-scope' },
      h('b', null, data.range.label), ` · ${fmt.range(data.range.from, data.range.to)} (India time)`,
      ' · application deadline ', h('b', null, day(dl.date)),
      dl.source === 'window' ? ' (no deadline stored for this year: the end of the program window is used)' : '',
      ` · program window from Settings ${fmt.range(data.window.from, data.window.to)}`,
      ` · ${plural(sel.count, 'selected applicant')}, ${plural(not.count, 'applicant')} not selected`));

  /* ── headline comparison ── */
  const cmp = (label, key, sub) => h('div', { class: 'stat past-cmp' },
    h('div', { class: 'stat-label' }, label),
    h('dl', null,
      h('div', { class: 'is-sel' }, h('dt', null, `Selected (${sel.matched})`), h('dd', null, n1(sel.medians[key]))),
      h('div', { class: 'is-not' }, h('dt', null, `Not selected (${not.matched})`), h('dd', null, n1(not.medians[key])))),
    h('div', { class: 'stat-sub' }, sub));
  el.append(h('div', { class: 'cards past-cards' },
    cmp('Merged PRs in their target organisation before the deadline', 'mergedTargetBeforeDeadline', `Median per applicant, ${day(data.range.from)} to ${day(dl.date)}`),
    cmp('Merged open-source PRs in the academic year', 'osMerged', `Median per applicant, ${data.range.label}`),
    cmp('Active weeks in open source', 'osActiveWeeks', 'Median weeks with an open-source PR opened or merged')));

  /* ── month by month ── */
  const canvas = h('canvas');
  const wrap = h('div', { class: 'chart-box past-chart' }, canvas);
  const markers = [
    { from: monthPos(data.window.from, months), to: monthPos(data.window.to, months, { end: true }), label: 'Program window' },
    { from: monthPos(dl.date, months, { end: true }), label: `Deadline ${day(dl.date).replace(/ \d{4}$/, '')}` },
  ];
  el.append(card({ title: 'Merged in the target organisation, month by month', note: 'Average per applicant of each group' },
    h('p', { class: 'chart-unit' }, 'Merged PRs per applicant'),
    wrap,
    h('p', { class: 'card-note' },
      'Shaded: the program window from Settings, moved to this round. Dashed line: the end of the application deadline day. ',
      'An average over a few people: one very active applicant can carry a whole group, so read it with the table below.')));
  const chart = barChart(canvas, {
    labels: months,
    series: [
      { label: `Selected (${sel.matched})`, data: sel.monthly.map((m) => m.perApplicant.targetMerged ?? 0), color: 1 },
      { label: `Not selected (${not.matched})`, data: not.monthly.map((m) => m.perApplicant.targetMerged ?? 0), color: '--chart-other' },
    ],
    markers,
    format: (v) => n1(v),
    label: `${name}: merged PRs in the target organisation per applicant and month, selected against not selected`,
    tooltipLabel: (si, di, v) => {
      const g = si === 0 ? sel : not;
      return `${si === 0 ? 'Selected' : 'Not selected'}: ${n1(v)} per applicant (${fmt.num(g.monthly[di].targetMerged)} in all)`;
    },
  });

  /* ── everyone, selected first ── */
  const rows = [...sel.applicants, ...not.applicants];
  const pair = (a, b) => (a === null || a === undefined ? '–' : [h('b', null, fmt.num(a)), h('span', { class: 'muted' }, ` / ${fmt.num(b)}`)]);
  const tbl = table({
    caption: `${name} applicants: what they did in ${data.range.label}`,
    compact: true,
    columns: [
      { key: 'who', label: 'Applicant', render: (a) => [
        a.matched && a.active
          ? h('a', { href: href(ctx.path, { ...q, student: a.username }), class: 'prog-name', title: 'Open the student panel' }, a.name || a.username)
          : h('span', { class: 'prog-name', title: a.matched ? 'No longer an active student' : 'Not a tracked student: no data' }, a.name || a.username),
        h('span', { class: 'sub' }, a.matched ? [ghLink(a.username, a.username), ` · ${a.campus || 'Unknown'}${a.batch ? ` · batch ${a.batch}` : ''}`] : 'not a tracked student')] },
      { key: 'selected', label: 'Outcome', render: (a) => h('span', { class: ['tag', a.selected ? 'tag-on' : null] }, a.selected ? 'Selected' : 'Not selected') },
      { key: 'org', label: 'Target organisation', wrap: true, render: (a) => {
        const m = MAPPING[a.orgMatch.mapping] || MAPPING.none;
        return [a.targetOrg || h('span', { class: 'muted' }, 'none given'),
          h('span', { class: 'sub' }, a.orgMatch.logins.length ? a.orgMatch.logins.slice(0, 3).join(', ') + (a.orgMatch.logins.length > 3 ? ` +${a.orgMatch.logins.length - 3}` : '') + ' · ' : '',
            h('span', { class: ['map-tag', `map-${a.orgMatch.mapping}`], title: m[1] }, m[0]))];
      } },
      { key: 'tgt', label: 'Target org: merged before deadline', num: true, title: 'Merged PRs in the target organisation from the start of the academic year to the end of the deadline day',
        render: (a) => (a.mergedTargetBeforeDeadline === null ? '–' : h('b', null, fmt.num(a.mergedTargetBeforeDeadline))) },
      { key: 'tgtAy', label: 'Target org: merged / opened in AY', num: true, render: (a) => pair(a.targetMerged, a.targetOpened) },
      { key: 'first', label: 'First PR in target org', render: (a) => (a.firstTargetPr
        ? h('a', { href: a.firstTargetPr.url, rel: 'noopener', target: '_blank', title: a.firstTargetPr.title || a.firstTargetPr.repo }, fmt.date(a.firstTargetPr.createdAt), a.firstTargetPr.beforeAy ? h('span', { class: 'sub' }, 'before this year') : null)
        : h('span', { class: 'muted' }, a.matched ? 'none' : '–')) },
      { key: 'os', label: 'Open source: merged / opened', num: true, render: (a) => pair(a.osMerged, a.osOpened) },
      { key: 'all', label: 'All PRs: merged / opened', num: true, title: 'Every category, also practice and own repositories', render: (a) => pair(a.merged, a.opened) },
      { key: 'weeks', label: 'Active weeks: OS / all', num: true, render: (a) => pair(a.osActiveWeeks, a.activeWeeks) },
      { key: 'size', label: 'Median PR size', num: true, title: 'Median lines added + deleted of the PRs opened in the year', render: (a) => (a.medianPrSize === null ? '–' : fmt.num(Math.round(a.medianPrSize))) },
      { key: 'ready', label: 'Readiness: now / at deadline', render: (a) => (a.matched
        ? h('span', { class: 'past-ready' }, scoreCell(a.readiness ? { ...a.readiness, prs: a.readiness.score ? 1 : 0 } : null, { name: 'Now' }),
          scoreCell(a.readinessAtDeadline ? { ...a.readinessAtDeadline, prs: a.readinessAtDeadline.score ? 1 : 0 } : null, { name: 'At the deadline' }))
        : '–') },
    ],
    rows,
    rowClass: (a, i) => [a.selected ? 'is-selected' : null, i === sel.applicants.length && i > 0 ? 'group-start' : null].filter(Boolean).join(' ') || null,
    empty: 'No applicants stored for this round.',
  });
  const medianRow = (label, g) => h('li', null, h('b', null, label), ' medians: ',
    `${n1(g.medians.mergedTargetBeforeDeadline)} merged in the target organisation before the deadline, `,
    `${n1(g.medians.targetMerged)} in the whole year, ${n1(g.medians.osMerged)} merged open-source PRs, `,
    `${n1(g.medians.osActiveWeeks)} active open-source weeks, median PR size ${n1(g.medians.medianPrSize)} lines, readiness now ${n1(g.medians.readiness)}.`);
  el.append(card({ title: `${plural(rows.length, 'applicant')}`, note: 'Selected first · a name opens the student panel', flush: true, class: 'past-table' },
    tbl,
    h('ul', { class: 'card-note card-note-pad past-medians' }, medianRow('Selected', sel), medianRow('Not selected', not))));

  const unmatched = rows.filter((a) => !a.matched).length;
  const guessed = rows.filter((a) => a.orgMatch.mapping === 'contains' || a.orgMatch.mapping === 'none').length;
  el.append(card({ title: 'Read this before drawing conclusions', class: 'past-honest' },
    h('p', null,
      `${plural(sel.count, 'selected applicant')} and ${not.count} not selected, from one round. With this few people the numbers are descriptive, not predictive: `,
      'they show how these applicants worked, not what gets someone selected. Selection also turned on the proposal, the conversation with mentors and the number of slots in each organisation, none of which is in this data.'),
    h('ul', { class: 'caveats' },
      h('li', null, h('b', null, 'Counted'), h('span', null, `Pull requests by date in India time: opened when created in ${data.range.label}, merged when merged in it, whenever they were opened. "Target organisation" is the organisation named in the outcome, matched to GitHub logins as shown in the table.`)),
      h('li', null, h('b', null, 'Readiness'), h('span', null, 'Now: the score as currently computed. At the deadline: the same computation with only the work visible at the end of the deadline day, in the program window moved to this round.')),
      unmatched ? h('li', null, h('b', null, 'Missing'), h('span', null, `${plural(unmatched, 'applicant')} ${unmatched === 1 ? 'is' : 'are'} not a tracked student and ${unmatched === 1 ? 'has' : 'have'} no numbers.`)) : null,
      guessed ? h('li', null, h('b', null, 'Check'), h('span', null, `${plural(guessed, 'target organisation')} could not be matched exactly. Fix the text in the outcomes or the program's organisation mapping in Settings.`)) : null)));

  return () => chart.destroy();
}
