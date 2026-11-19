// Krushn's dashboard → Students: every student with a readiness score per program, to decide whom to mentor.
// Data: GET /api/owner/students (filters, sort and paging live in the hash query), GET /api/owner/orgs for the
// organisation filter, GET /api/owner/export/students.csv for the private export.

import { setQuery } from '../lib/router.js';
import { h, card, table, pagination, filterBar, fmt, ghLink } from '../lib/ui.js';
import { CAMPUSES, YEARS } from '../admin/common.js';
import { oapi, BAND_LABELS, FLAG_LABELS, bandBadge, bandKey, scoreCell, deltaNum, flagBadge, plural } from './common.js';

const FILTERS = ['q', 'campus', 'year', 'program', 'band', 'org', 'flag', 'realChance'];

/** "GSoC 2027" → "GSoC", "Summer of Bitcoin" → "Summer of Bitcoin": the column header drops a trailing year. */
const shortName = (name) => String(name || '').replace(/\s+20\d\d$/, '');

export default async function studentsPage(el, ctx, shared) {
  const q = ctx.query;
  const filters = Object.fromEntries(FILTERS.map((k) => [k, q[k] || '']));
  const params = { ...filters, sort: q.sort || '', order: q.order || '', page: q.page || 1, limit: 25 };
  const [data, cfg, orgs] = await Promise.all([
    oapi.get('/students', params),
    oapi.get('/programs'),
    filters.program ? oapi.get('/orgs', { program: filters.program, limit: 200, sort: 'students' }).catch((err) => { if (err.name === 'Locked') throw err; return { items: [] }; }) : Promise.resolve(null),
  ]);
  shared.bands = cfg.bands;
  const programs = data.programs || [];
  const focus = programs.find((p) => p.key === filters.program) || null;
  const focusCfg = focus ? (cfg.programs || []).find((p) => p.key === focus.key) : null;
  const sort = q.sort || (focus ? focus.key : 'prestigeScore');
  const order = q.order || (['name', 'campus'].includes(sort) ? 'asc' : 'desc');

  const orgOptions = orgs ? (orgs.items || []).map((o) => ({ value: o.login, label: `${o.login} (${o.students})` })) : [];
  if (filters.org && !orgOptions.some((o) => o.value === filters.org)) orgOptions.unshift({ value: filters.org, label: filters.org });

  const bar = filterBar({
    fields: [
      { name: 'q', label: 'Search', type: 'search', placeholder: 'Name or GitHub username' },
      { name: 'program', label: 'Program', type: 'select', options: programs.map((p) => ({ value: p.key, label: p.name })), allLabel: 'Best program of each student' },
      { name: 'band', label: 'Readiness band', type: 'select', options: [
        { value: 'strong,possible', label: 'Strong or Possible' },
        { value: 'strong', label: 'Strong' }, { value: 'possible', label: 'Possible' }, { value: 'early', label: 'Early' }, { value: 'none', label: 'No signal' },
      ] },
      { name: 'campus', label: 'Campus', type: 'select', options: CAMPUSES },
      { name: 'year', label: 'Year', type: 'select', options: YEARS },
      focus && focusCfg && focusCfg.match === 'orgs'
        ? { name: 'org', label: `Organisation (${shortName(focus.name)})`, type: 'select', options: orgOptions, allLabel: 'Any organisation' }
        : null,
      { name: 'flag', label: 'Your flag', type: 'select', options: [
        ...Object.entries(FLAG_LABELS).map(([value, label]) => ({ value, label })), { value: 'none', label: 'Not flagged' }] },
      { name: 'realChance', label: 'Real chance only', type: 'checkbox' },
    ].filter(Boolean),
    values: filters,
    // the organisation list belongs to one program: changing the program clears it
    onChange: (v) => setQuery({ ...v, org: v.program === filters.program ? (v.org ?? '') : '', page: '', student: q.student || '' }),
  });

  const needs = (r) => {
    const p = focus ? r.programs[focus.key] || {} : null;
    const list = (p ? p.blockers : r.blockers) || [];
    const band = p ? p.band : r.bestBand;
    if (!list.length) {
      if (band === 'strong') return h('span', { class: 'need-ok' }, 'Nothing blocking');
      if (band === 'none') return h('span', { class: 'muted' }, 'No program work yet');
      return h('span', { class: 'muted' }, 'Nothing blocking');
    }
    return [h('span', { class: 'need' }, list[0]), list.length > 1 ? h('span', { class: 'need need-more', title: list.slice(1).join('\n') }, `and ${list.length - 1} more`) : null];
  };

  const columns = [
    { key: 'name', label: 'Student', sortable: true, class: 'col-student', render: (r) => [
      h('button', { type: 'button', class: 'stu-name', name: `open-${r.username}`, title: 'Open the score breakdown' }, r.name || r.username),
      h('span', { class: 'sub' }, `${r.campus} · ${r.year}`,
        r.flag || r.hasNote ? h('span', { class: 'stu-marks' }, flagBadge(r.flag), r.hasNote ? h('span', { class: 'tag', title: 'You wrote a private note on this student' }, 'Note') : null) : null),
    ] },
    focus ? { key: 'org', label: `Best org (${shortName(focus.name)})`, class: 'col-org', render: (r) => {
      const p = r.programs[focus.key] || {};
      return p.bestOrg ? [ghLink(p.bestOrg), h('span', { class: 'sub' }, `${plural(p.mergedInBestOrg || 0, 'merged PR')}`)] : null;
    } } : { key: 'best', sortKey: 'prestigeScore', label: 'Best program', num: true, sortable: true, class: 'col-best', title: 'The program where this student scores highest among the programs counted for "real chance", and the organisation their work for it is in',
      render: (r) => (r.bestProgram
        ? h('span', { class: 'best-cell' }, bandBadge(r.bestBand, `${BAND_LABELS[r.bestBand]} · ${r.prestigeScore}`),
          h('small', null, shortName((programs.find((p) => p.key === r.bestProgram) || {}).name || r.bestProgram), r.bestOrg ? [' · ', ghLink(r.bestOrg)] : null))
        : h('span', { class: 'muted' }, 'No signal')) },
    ...programs.map((p) => ({
      key: p.key, label: shortName(p.name), sortable: true, num: true, title: `${p.name}: readiness score 0 to 100${p.prestigious ? '' : ' (general signal, not counted for "real chance")'}`,
      class: ['col-score', focus && focus.key === p.key && 'col-focus'].filter(Boolean).join(' '),
      render: (r) => scoreCell(r.programs[p.key], { name: p.name, label: shortName(p.name) }),
    })),
    { key: 'delta', label: `${cfg.trendDays} d`, sortable: true, num: true, title: `Change of the ${focus ? `${focus.name} score` : 'best score'} over the trend period (${cfg.trendDays} days)`,
      render: (r) => deltaNum(focus ? (r.programs[focus.key] || {}).delta : (r.programs[r.bestProgram] || {}).delta) },
    { key: 'lastActivityAt', label: 'Last PR', sortable: true, num: true, class: 'col-last', title: 'Last open-source pull request opened or merged, in any organisation',
      render: (r) => (r.lastActivityAt ? h('span', { title: fmt.date(r.lastActivityAt) }, fmt.rel(r.lastActivityAt)) : null) },
    { key: 'needs', label: focus ? `What holds ${shortName(focus.name)} back` : 'What holds it back', class: 'col-needs', render: needs },
  ].filter(Boolean);

  const tbl = table({
    columns, rows: data.items, sort, order,
    onSort: (s, o) => setQuery({ sort: s, order: o, page: '' }),
    caption: 'Students with their readiness score per program',
    empty: 'No student matches these filters.',
    rowClass: (r) => [q.student && q.student.toLowerCase() === r.username.toLowerCase() && 'is-open', r.flag === 'not_applying' && 'is-dim'].filter(Boolean).join(' ') || null,
  });
  // a row opens the student panel; links and the name button inside it keep their own behaviour
  [...tbl.querySelectorAll('tbody tr')].forEach((tr, i) => {
    const r = data.items[i];
    if (!r) return;
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      setQuery({ student: r.username });
    });
    // hide dashes on small screens, where a student is a block and seven empty cells are noise
    tr.querySelectorAll('td.col-score').forEach((td) => { if (td.querySelector('.rc-empty')) td.classList.add('is-blank'); });
  });

  const exportHref = oapi.url('/export/students.csv', { ...filters, sort: q.sort || '', order: q.order || '' });
  const anyFilter = FILTERS.some((k) => filters[k]);
  const head = h('div', { class: 'section-head' },
    h('h2', null, `${fmt.num(data.total)} ${data.total === 1 ? 'student' : 'students'}`,
      h('span', { class: 'muted sub-inline' }, anyFilter ? ' match these filters' : ' tracked, highest readiness first')),
    h('div', { class: 'toolbar' },
      h('a', { class: 'btn', href: exportHref, download: 'program-readiness.csv', title: 'Every row that matches the filters, with every program score. Private: keep the file to yourself.' }, 'Download CSV (private)')));

  el.append(...[
    bar,
    focus && focusCfg ? h('p', { class: 'fine' },
      `Band, organisation, sorting and the last column refer to ${focus.name}. `,
      focusCfg.eligibilityNote || '',
      focusCfg.starter && focusCfg.match === 'orgs' ? ' Its organisation list is an unchecked starter list.' : '') : null,
    head,
    card({ flush: true, class: 'owner-students' },
      bandKey(cfg.bands),
      tbl,
      pagination({ page: data.page, limit: data.limit, total: data.total, onPage: (page) => setQuery({ page }) })),
    h('p', { class: 'fine' }, 'Click a student for the score breakdown, the pull requests behind it, the suggested next step and your private note. ',
      'A dash means no pull request counted for that program.')].filter(Boolean));
  return undefined;
}
