// Krushn's dashboard → Summary: how many students stand a real chance, per program, per campus and year, and who is closest.
// Data: GET /api/owner/summary?campus=&year=  and  GET /api/owner/students (top rows of the program in focus).

import { href, setQuery } from '../lib/router.js';
import { h, card, table, filterBar, segmented, fmt, ghLink } from '../lib/ui.js';
import { CAMPUSES, YEARS } from '../admin/common.js';
import { oapi, BANDS, BAND_LABELS, bandBadge, bandBar, bandKey, scoreCell, deltaNum, rate, plural, calibrationBlock, flagBadge } from './common.js';

const REAL = 'strong,possible';
const YEAR_ORDER = ['1st year', '2nd year', '3rd year', '4th year', 'alumni', 'Unknown'];

export default async function summaryPage(el, ctx, shared) {
  const q = ctx.query;
  const cohort = { campus: q.campus || '', year: q.year || '' };
  const s = await oapi.get('/summary', cohort);
  shared.bands = s.bands;
  const programs = s.programs || [];
  const focus = programs.find((p) => p.key === q.p) || programs.find((p) => p.key === 'gsoc') || programs[0] || null;
  const top = focus ? await oapi.get('/students', { ...cohort, program: focus.key, sort: focus.key, order: 'desc', limit: 10 }) : { items: [], total: 0 };

  const stuHref = (extra) => href('/owner/students', { ...cohort, ...extra });
  const cohortText = [cohort.campus, cohort.year].filter(Boolean).join(', ');
  const prestigious = programs.filter((p) => p.prestigious);
  const loose = prestigious.filter((p) => p.match !== 'orgs');
  const gsoc = programs.find((p) => p.key === 'gsoc');

  el.append(filterBar({
    fields: [
      { name: 'campus', label: 'Campus', type: 'select', options: CAMPUSES },
      { name: 'year', label: 'Year', type: 'select', options: YEARS },
    ],
    values: q,
    onChange: (v) => setQuery({ ...v }),
  }));

  if (!s.computedAt) {
    el.append(h('div', { class: 'notice' }, 'Scores have not been computed yet. This takes a few seconds; the page reloads by itself.'));
  }

  /* ── headline ── */
  const rc = s.realChance || { count: 0, strong: 0, possible: 0, delta: 0, prevCount: 0, per100: null };
  const big = h('div', { class: 'owner-big' },
    h('div', { class: 'owner-big-label' }, 'Students with a real chance', cohortText ? ` · ${cohortText}` : ''),
    h('div', { class: 'owner-big-row' },
      h('span', { class: 'owner-big-value' }, fmt.num(rc.count)),
      h('span', { class: 'owner-big-of' }, `of ${fmt.num(s.students)} tracked students · ${rate(rc.per100)} per 100`)),
    h('dl', { class: 'owner-big-split' },
      h('div', null, h('dd', null, fmt.num(rc.strong)), h('dt', null, bandBadge('strong', 'Strong in at least one program'))),
      h('div', null, h('dd', null, fmt.num(rc.possible)), h('dt', null, bandBadge('possible', 'Possible, not yet Strong'))),
      h('div', null, h('dd', null, deltaNum(rc.delta)), h('dt', null, `in the last ${s.trendDays} days (was ${fmt.num(rc.prevCount)})`))),
    h('p', { class: 'fine' },
      `Counted: readiness band Strong or Possible in at least one of ${prestigious.map((p) => p.name).join(', ') || 'the programs marked prestigious'}. `,
      loose.length && gsoc ? `${loose.map((p) => p.name).join(' and ')} ${loose.length === 1 ? 'is' : 'are'} scored on any open-source pull request, which widens this figure; for ${gsoc.name} alone it is ${fmt.num((gsoc.counts.strong || 0) + (gsoc.counts.possible || 0))}. ` : '',
      'This is readiness, not a forecast of selections.'),
    h('div', { class: 'toolbar' },
      h('a', { class: 'btn btn-primary', href: stuHref({ realChance: 1 }) }, 'See these students'),
      h('span', { class: 'fine' }, 'Your flags: ',
        h('a', { href: stuHref({ flag: 'shortlist' }) }, `${fmt.num(s.flags.shortlist)} shortlisted`), ' · ',
        h('a', { href: stuHref({ flag: 'watch' }) }, `${fmt.num(s.flags.watch)} on watch`), ' · ',
        h('a', { href: stuHref({ flag: 'not_applying' }) }, `${fmt.num(s.flags.not_applying)} not applying`))));

  const groupBars = (rows, nameOf, hrefOf) => {
    const shown = rows.filter((r) => r.students > 0);
    const max = Math.max(0, ...shown.map((r) => r.per100 || 0));
    return h('dl', { class: 'hbars' }, shown.map((r) => [
      h('dt', null, h('a', { href: hrefOf(r) }, nameOf(r)), h('small', null, `${fmt.num(r.students)} students`)),
      h('dd', null, h('div', { class: ['track', r.smallCohort && 'is-small'] }, h('span', { style: { width: `${max ? ((r.per100 || 0) / max) * 100 : 0}%` } }))),
      h('dd', { class: 'val', title: `${r.strong} Strong, ${r.possible} Possible` }, fmt.num(r.realChance), h('small', null, `${rate(r.per100)} per 100`)),
    ]));
  };
  const side = h('div', { class: 'owner-side' },
    h('h2', null, 'By campus'),
    groupBars([...(s.byCampus || [])].sort((a, b) => CAMPUSES.indexOf(a.campus) - CAMPUSES.indexOf(b.campus)), (r) => r.campus, (r) => stuHref({ campus: r.campus, realChance: 1 })),
    h('h2', null, 'By year'),
    groupBars(s.byYear || [], (r) => r.year, (r) => stuHref({ year: r.year, realChance: 1 })),
    h('p', { class: 'fine' }, 'Bars compare the rate per 100 students, so a small campus is not hidden by a large one.'));
  el.append(h('div', { class: 'owner-headline' }, big, side));

  /* ── per program ── */
  const maxSignal = Math.max(1, ...programs.map((p) => (p.counts.strong || 0) + (p.counts.possible || 0) + (p.counts.early || 0)));
  const countLink = (p, band) => {
    const n = p.counts[band] || 0;
    if (!n) return h('span', { class: 'muted' }, '0');
    return h('a', { class: 'count-link', href: stuHref({ program: p.key, band }), title: `${BAND_LABELS[band]} for ${p.name}: open the list` }, fmt.num(n));
  };
  const progTable = table({
    caption: 'Readiness bands per program',
    sticky: true,
    columns: [
      { key: 'name', label: 'Program', wrap: true, render: (p) => [
        h('span', { class: 'prog-name' }, h('a', { href: href('/owner', { ...cohort, p: p.key }) }, p.name)), ' ',
        !p.prestigious ? h('span', { class: 'tag', title: 'A general signal, not a program: it is not counted in "students with a real chance".' }, 'General signal') : null,
        p.match === 'open_source' ? h('span', { class: 'tag', title: 'This program has no organisation list: any open-source pull request counts.' }, 'Any open-source PR') : null,
        p.starter && p.match === 'orgs' ? h('a', { class: 'tag tag-warn', href: href('/owner/settings'), title: 'The organisation list of this program is a starter list that nobody has checked against the current roster. Review it in Settings.' }, 'Unchecked org list') : null,
        h('span', { class: 'sub' }, `Counts work from ${fmt.range(p.window.from, p.window.to)}`, p.match === 'orgs' ? ` · ${plural(p.orgs, 'organisation')} listed, ${fmt.num(p.activeOrgs)} with NST work` : ''),
      ] },
      { key: 'strong', label: bandBadge('strong'), class: 'col-band', render: (p) => countLink(p, 'strong') },
      { key: 'possible', label: bandBadge('possible'), class: 'col-band', render: (p) => countLink(p, 'possible') },
      { key: 'early', label: bandBadge('early'), class: 'col-band', render: (p) => countLink(p, 'early') },
      { key: 'bar', label: 'Students with any signal', render: (p) => bandBar(p.counts, { max: maxSignal }) },
      { key: 'real', label: 'Strong or Possible', num: true, class: 'col-rate', title: 'Strong + Possible, and the same per 100 students of the cohort',
        render: (p) => { const byAll = (p.counts.strong || 0) + (p.counts.possible || 0); return [h('b', null, fmt.num(byAll)), h('span', { class: 'sub' }, `${rate(s.students ? Math.round((byAll / s.students) * 1000) / 10 : null)} per 100`)]; } },
      { key: 'delta', label: `${s.trendDays}-day change`, num: true, title: `Change in Strong + Possible compared with the same computation ${s.trendDays} days ago`,
        render: (p) => deltaNum((p.delta.strong || 0) + (p.delta.possible || 0)) },
      { key: 'avg', label: 'Average score', num: true, title: 'Average readiness score of the students with any signal', render: (p) => (p.avgScoreWithSignal === null ? null : rate(p.avgScoreWithSignal)) },
    ],
    rows: programs,
    empty: 'No program is enabled. Enable one in Settings.',
  });
  el.append(card({ title: 'By program', note: 'Readiness score bands · a count opens the list', flush: true, class: 'owner-progs' }, bandKey(s.bands), progTable));

  /* ── estimated selection rate: only when real outcomes were uploaded ── */
  const calibrated = programs.filter((p) => p.labelMode === 'calibrated' && p.calibration);
  if (calibrated.length) {
    el.append(card({ title: 'Estimated selection rate, from past outcomes', note: 'Shown because past results were uploaded in Settings' },
      calibrated.map((p) => h('div', { class: 'stack' },
        h('p', { class: 'fine' }, h('b', null, p.name), `: ${plural(p.calibration.outcomes, 'past applicant')} (${(p.calibration.years || []).join(', ')}), ${fmt.num(p.calibration.selected)} selected. Where the applicants of each band ended up:`),
        calibrationBlock(p.calibration))),
      h('p', { class: 'card-note' }, 'Bands of past applicants are recomputed as of that year\'s deadline with today\'s organisation list and weights. With this few applicants these are counts to keep in mind, not rates to plan with.')));
  }

  /* ── the program in focus: campus × year, and who is closest ── */
  if (focus) {
    const picker = segmented({
      options: programs.map((p) => ({ value: p.key, label: p.name })), value: focus.key, label: 'Program', name: 'p',
      onChange: (v) => setQuery({ p: v }),
    });
    const years = YEAR_ORDER.filter((y) => (focus.byYear || []).some((r) => r.year === y && r.students > 0));
    const campuses = CAMPUSES.filter((c) => (focus.byCampus || []).some((r) => r.campus === c && r.students > 0));
    const cellOf = (c, y) => (focus.byCampusYear || []).find((r) => r.campus === c && r.year === y);
    const maxRate = Math.max(0, ...(focus.byCampusYear || []).filter((r) => r.students >= 30).map((r) => r.per100 || 0));
    const heat = (r) => (!r || !r.realChance || !maxRate || r.smallCohort ? 0 : Math.min(4, Math.max(1, Math.ceil(((r.per100 || 0) / maxRate) * 4))));
    const mcell = (r, link) => {
      if (!r || !r.students) return h('span', { class: 'muted' }, '–');
      const inner = h('span', { class: 'm-cell' },
        h('span', { class: 'm-count' }, fmt.num(r.realChance), r.smallCohort ? [' ', h('span', { class: 'small-cohort', title: `Only ${r.students} students: read the rate with care` }, 'small')] : null),
        h('span', { class: 'm-rate' }, `${rate(r.per100)} per 100 of ${fmt.num(r.students)}`));
      return r.realChance ? h('a', { href: link, title: `${r.counts.strong} Strong, ${r.counts.possible} Possible, ${r.counts.early} Early of ${r.students} students` }, inner) : inner;
    };
    const overall = { students: s.students, realChance: (focus.counts.strong || 0) + (focus.counts.possible || 0), counts: focus.counts };
    overall.per100 = overall.students ? Math.round((overall.realChance / overall.students) * 1000) / 10 : null;
    const matrix = h('div', { class: 'table-wrap table-sticky', tabindex: '0', role: 'region', 'aria-label': `${focus.name}: Strong or Possible by campus and year` },
      h('table', { class: 'data matrix' },
        h('caption', { class: 'sr-only' }, `${focus.name}: students in band Strong or Possible, by campus and year, with the rate per 100 students`),
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Campus'), years.map((y) => h('th', { scope: 'col' }, y)), h('th', { scope: 'col' }, 'All years'))),
        h('tbody', null,
          campuses.map((c) => {
            const tot = (focus.byCampus || []).find((r) => r.campus === c);
            return h('tr', null, h('th', { scope: 'row' }, c),
              years.map((y) => { const r = cellOf(c, y); return h('td', { class: heat(r) ? `m-heat-${heat(r)}` : null }, mcell(r, stuHref({ program: focus.key, band: REAL, campus: c, year: y }))); }),
              h('td', null, mcell(tot, stuHref({ program: focus.key, band: REAL, campus: c }))));
          }),
          h('tr', { class: 'total' }, h('th', { scope: 'row' }, 'All campuses'),
            years.map((y) => h('td', null, mcell((focus.byYear || []).find((r) => r.year === y), stuHref({ program: focus.key, band: REAL, year: y })))),
            h('td', null, mcell(overall, stuHref({ program: focus.key, band: REAL })))))));

    const needs = (r) => {
      const p = r.programs[focus.key] || {};
      const b = p.blockers || [];
      if (!b.length) return h('span', { class: 'need-ok' }, p.band === 'strong' ? 'Nothing blocking: ready to talk to mentors' : 'Nothing blocking: keep going');
      return [h('span', { class: 'need' }, b[0]), b.length > 1 ? h('span', { class: 'need need-more' }, `and ${b.length - 1} more`) : null];
    };
    const topTable = table({
      caption: `Highest readiness scores for ${focus.name}`,
      compact: true,
      columns: [
        { key: 'name', label: 'Student', render: (r) => [
          h('a', { href: href(ctx.path, { ...q, student: r.username }), class: 'prog-name' }, r.name || r.username), flagBadge(r.flag) ? [' ', flagBadge(r.flag)] : null,
          h('span', { class: 'sub' }, `${r.campus} · ${r.year}`)] },
        { key: 'score', label: 'Readiness', render: (r) => scoreCell(r.programs[focus.key], { name: focus.name }) },
        { key: 'delta', label: `${s.trendDays} days`, num: true, render: (r) => deltaNum((r.programs[focus.key] || {}).delta) },
        { key: 'org', label: 'Best organisation', render: (r) => { const p = r.programs[focus.key] || {}; return p.bestOrg ? [ghLink(p.bestOrg), h('span', { class: 'sub' }, `${plural(p.mergedInBestOrg || 0, 'merged PR')} there`)] : null; } },
        { key: 'last', label: 'Last PR', render: (r) => { const p = r.programs[focus.key] || {}; return p.lastActivityAt ? h('span', { title: fmt.date(p.lastActivityAt) }, fmt.rel(p.lastActivityAt)) : null; } },
        { key: 'needs', label: 'What holds it back', wrap: true, render: needs },
      ],
      rows: top.items || [],
      empty: `Nobody has a signal for ${focus.name} yet in this cohort.`,
    });

    const cal = focus.labelMode === 'calibrated' && focus.calibration;
    el.append(
      h('div', { class: 'section-head' }, h('h2', null, 'One program in detail'), picker),
      card({ title: `${focus.name}: Strong or Possible, by campus and year`, note: 'Count, and the rate per 100 students of that group', flush: true },
        matrix,
        h('p', { class: 'card-note card-note-pad' },
          `${fmt.num(focus.counts.strong)} Strong, ${fmt.num(focus.counts.possible)} Possible, ${fmt.num(focus.counts.early)} Early, ${fmt.num(focus.counts.none)} without a signal. `,
          'Darker cells have a higher rate. ', focus.eligibilityNote || '')),
      card({ title: `Closest for ${focus.name}`, note: h('a', { href: stuHref({ program: focus.key }) }, `See all ${fmt.num((focus.counts.strong || 0) + (focus.counts.possible || 0) + (focus.counts.early || 0))} with a signal`), flush: true },
        topTable,
        cal ? h('p', { class: 'card-note card-note-pad' }, 'Past outcomes exist for this program: the estimated selection rate per band is in the card above.') : null));
  }

  /* ── eligibility ── */
  const notes = programs.filter((p) => p.eligibilityNote);
  if (notes.length) {
    el.append(card({ title: 'Eligibility this data cannot see', note: 'Never inferred: confirm with each student' },
      h('ul', { class: 'caveats' }, notes.map((p) => h('li', null, h('b', null, p.name), h('span', null, p.eligibilityNote))))));
  }
  return undefined;
}

export { BANDS };
