// Krushn's dashboard → Organisations: for each organisation of a program, which NST students work there, so mentors
// can steer students away from an organisation ten of them are already competing in.
// Data: GET /api/owner/orgs?program=&campus=&q=&minStudents=&sort=&order=&page=&limit= and GET /api/owner/programs.

import { href, setQuery } from '../lib/router.js';
import { h, card, table, pagination, filterBar, fmt, ghLink, extLink, safeUrl } from '../lib/ui.js';
import { CAMPUSES } from '../admin/common.js';
import { oapi, scoreCell, plural } from './common.js';

const LIMIT = 50;

export default async function orgsPage(el, ctx, shared) {
  const q = ctx.query;
  const cfg = await oapi.get('/programs');
  shared.bands = cfg.bands;
  const programs = (cfg.programs || []).filter((p) => p.enabled);
  const first0 = programs.find((p) => p.key === 'gsoc') || programs[0];
  const prog = programs.find((p) => p.key === q.program) || first0;
  if (!prog) {
    el.append(h('div', { class: 'notice notice-warn' }, 'No program is enabled. Enable one in Settings.'));
    return undefined;
  }
  const sort = q.sort || 'bestOrgFor';
  const order = q.order || (sort === 'login' ? 'asc' : 'desc');
  const clientSort = sort === 'bestOrgFor' || sort === 'strongOrPossible';
  const params = { program: prog.key, campus: q.campus || '', q: q.q || '', minStudents: q.minStudents || '', sort: clientSort ? 'students' : sort, order: clientSort ? 'desc' : order };
  // crowding is judged over every organisation of the program, so read them all (the API pages at 200)
  const first = await oapi.get('/orgs', { ...params, page: 1, limit: 200 });
  let all = first.items || [];
  for (let page = 2; all.length < first.total && page <= 10; page++) {
    const more = await oapi.get('/orgs', { ...params, page, limit: 200 });
    if (!more.items || !more.items.length) break;
    all = all.concat(more.items);
  }
  if (clientSort) {
    const dir = order === 'asc' ? 1 : -1;
    all = [...all].sort((a, b) => ((a[sort] || 0) - (b[sort] || 0)) * dir || (b.students - a.students) || (a.login < b.login ? -1 : 1));
  }
  const crowdedAt = first.crowdedAt || cfg.crowdedAt || 5;
  const crowded = all.filter((o) => o.crowded).sort((a, b) => b.bestOrgFor - a.bestOrgFor);
  const pageNo = Math.max(1, Number(q.page) || 1);
  const rows = all.slice((pageNo - 1) * LIMIT, pageNo * LIMIT);
  const open = (q.open || '').toLowerCase();
  const maxBest = Math.max(crowdedAt, ...all.map((o) => o.bestOrgFor || 0));
  const singles = all.filter((o) => o.students === 1).length;

  el.append(filterBar({
    fields: [
      { name: 'program', label: 'Program', type: 'select', options: programs.filter((p) => p !== first0).map((p) => ({ value: p.key, label: p.name })), allLabel: first0.name },
      { name: 'q', label: 'Search', type: 'search', placeholder: 'Organisation name or login' },
      { name: 'campus', label: 'Campus', type: 'select', options: CAMPUSES },
      { name: 'minStudents', label: 'At least', type: 'select', options: [2, 3, 5, 10].map((n) => ({ value: String(n), label: `${n} students` })), allLabel: '1 student' },
    ],
    values: { program: prog === first0 ? '' : prog.key, q: q.q || '', campus: q.campus || '', minStudents: q.minStudents || '' },
    onChange: (v) => setQuery({ ...v, page: '', open: '' }),
  }));

  if (prog.match !== 'orgs') {
    el.append(h('div', { class: 'notice' }, `${prog.name} has no organisation list (${prog.match === 'major' ? 'any major-tier project counts' : 'any open-source pull request counts'}), so this shows every organisation its counted work is in.`));
  } else if (prog.starter) {
    el.append(h('div', { class: 'notice notice-warn' }, `The organisation list of ${prog.name} is a starter list that has not been checked against the current roster. `, h('a', { href: href('/owner/settings') }, 'Review it in Settings')));
  }

  el.append(h('div', { class: 'cards' },
    stat('Organisations with NST students', fmt.num(first.total), `${prog.name}${q.campus ? `, ${q.campus}` : ''}`, true),
    stat('Crowded', fmt.num(crowded.length), `${crowdedAt} or more students have it as their best organisation`),
    stat('With one student only', fmt.num(singles), 'no internal competition there'),
    stat('Listed for the program', prog.match === 'orgs' ? fmt.num((prog.orgs || []).length + (prog.repos || []).length) : '–', prog.match === 'orgs' ? 'organisations and repositories in Settings' : 'no list')));

  if (crowded.length) {
    el.append(card({ title: 'Where students are crowding', note: 'Students whose best organisation this is' },
      h('p', { class: 'fine' }, `A program accepts a handful of contributors per organisation, so ${crowdedAt} or more NST students concentrating on one are mostly competing with each other. Consider steering the newer ones to a quieter organisation.`),
      h('ul', { class: 'crowd-list' }, crowded.slice(0, 24).map((o) => h('li', null,
        h('a', { href: href(ctx.path, { ...q, open: o.login, page: String(Math.floor(all.indexOf(o) / LIMIT) + 1) }) }, o.login, h('b', null, fmt.num(o.bestOrgFor)),
          o.strongOrPossible ? h('span', { class: 'muted' }, `${o.strongOrPossible} Strong or Possible`) : null))))));
  }

  const toggle = (o) => setQuery({ open: open === o.login.toLowerCase() ? '' : o.login });
  const tbl = table({
    caption: `Organisations of ${prog.name} with NST students`,
    sort, order,
    onSort: (s, o2) => setQuery({ sort: s, order: o2, page: '', open: '' }),
    columns: [
      { key: 'login', label: 'Organisation', sortable: true, class: 'col-org', render: (o) => [
        h('button', { type: 'button', class: 'org-toggle', name: `org-${o.login}`, 'aria-expanded': open === o.login.toLowerCase() ? 'true' : 'false', title: 'Show the students' }, o.name && o.name.toLowerCase() !== o.login.toLowerCase() ? o.name : o.login),
        h('span', { class: 'sub' }, ghLink(o.login), o.crowded ? [' ', h('span', { class: 'tag tag-warn', title: `${o.bestOrgFor} students have this as their best organisation` }, 'Crowded')] : null)] },
      { key: 'bestOrgFor', label: 'Best organisation for', sortable: true, num: true, title: 'Students whose strongest work for this program is here. The tick marks where crowding starts.',
        render: (o) => h('span', { class: ['crowdcell', o.crowded && 'is-crowded'] }, h('b', null, fmt.num(o.bestOrgFor)),
          h('span', { class: 'track', 'aria-hidden': 'true' }, h('span', { style: { width: `${((o.bestOrgFor || 0) / maxBest) * 100}%` } }), h('u', { style: { left: `${(crowdedAt / maxBest) * 100}%` } }))) },
      { key: 'students', label: 'Students', sortable: true, num: true, title: 'Students with at least one counted pull request here' },
      { key: 'strongOrPossible', label: 'Strong or Possible', sortable: true, num: true, title: 'Of the students whose best organisation this is, how many are in band Strong or Possible' },
      { key: 'merged', label: 'Merged PRs', sortable: true, num: true },
      { key: 'prs', label: 'PRs', sortable: true, num: true, render: (o) => [fmt.num(o.prs), h('span', { class: 'sub' }, `${fmt.num(o.open)} open`)] },
      { key: 'campuses', label: 'Campuses', render: (o) => CAMPUSES.filter((c) => o.campuses && o.campuses[c]).map((c) => `${c} ${o.campuses[c]}`).join(' · ') },
    ],
    rows,
    empty: 'No organisation matches these filters.',
    rowClass: (o) => (open === o.login.toLowerCase() ? 'is-open' : null),
  });

  // rows open in place to show the students of that organisation
  [...tbl.querySelectorAll('tbody tr')].forEach((tr, i) => {
    const o = rows[i];
    if (!o) return;
    const btn = tr.querySelector('.org-toggle');
    if (btn) btn.addEventListener('click', () => toggle(o));
    if (open !== o.login.toLowerCase()) return;
    const people = table({
      compact: true, sticky: false, caption: `Students in ${o.login}`,
      columns: [
        { key: 'name', label: 'Student', render: (p) => [h('a', { href: href(ctx.path, { ...q, student: p.username }) }, p.name || p.username), h('span', { class: 'sub' }, `${p.campus} · ${p.year}`)] },
        { key: 'score', label: `Readiness (${prog.name})`, render: (p) => scoreCell({ score: p.score, band: p.band, prs: p.prs }, { name: prog.name }) },
        { key: 'isBestOrg', label: 'Their best organisation', render: (p) => (p.isBestOrg ? h('span', { class: 'tag tag-on' }, 'Yes') : h('span', { class: 'muted' }, 'No, elsewhere')) },
        { key: 'merged', label: 'Merged here', num: true },
        { key: 'prs', label: 'PRs here', num: true },
        { key: 'last', label: 'Last PR here', num: true, render: (p) => (p.lastActivityAt ? h('span', { title: fmt.date(p.lastActivityAt) }, fmt.rel(p.lastActivityAt)) : null) },
      ],
      rows: o.people || [],
    });
    const site = safeUrl(o.url) && !/github\.com/i.test(o.url) ? extLink('Website', o.url) : null;
    tr.after(h('tr', { class: 'org-people' }, h('td', { colspan: 7 },
      people,
      h('p', { class: 'fine' },
        (o.people || []).length < o.students ? `Showing the ${(o.people || []).length} with the most merged work of ${o.students}. ` : '',
        h('a', { href: href('/owner/students', { program: prog.key, org: o.login }) }, `Open these ${plural(o.students, 'student')} in the Students table`), site ? [' · ', site] : null))));
    setTimeout(() => { if (tr.isConnected && q.open && !ctx.query._seen) tr.scrollIntoView({ block: 'nearest' }); }, 0);
  });

  el.append(card({ flush: true, class: 'owner-orgs', title: `${fmt.num(first.total)} ${first.total === 1 ? 'organisation' : 'organisations'}`, note: 'Click an organisation to see its students' },
    tbl,
    pagination({ page: pageNo, limit: LIMIT, total: all.length, onPage: (page) => setQuery({ page, open: '' }) })));
  return undefined;
}

function stat(label, value, sub, key = false) {
  return h('div', { class: ['stat', key && 'stat-key'] }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-sub' }, sub));
}
