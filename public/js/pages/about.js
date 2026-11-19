// About: what is counted and how a pull request is classified, with the live rules. GET /meta, GET /overview.

import { api } from '../lib/api.js';
import { h, pageHead, table, categoryBadge, tierBadge, fmt, CATEGORIES, CATEGORY_HELP } from '../lib/ui.js';
import { getMeta, link } from './common.js';

function chips(list, emptyText) {
  if (!list || !list.length) return h('p', { class: 'muted' }, emptyText);
  return h('ul', { class: 'chips' }, list.map((v) => h('li', { class: 'chip', style: { paddingRight: '8px' } }, v)));
}

export default async function (el, ctx) {
  const [meta, overview] = await Promise.all([getMeta(), api.get('/overview', { range: ctx.query.range === 'all' ? 'all' : '' }).catch(() => null)]);
  const r = meta.rulesSummary || {};
  const tiers = r.tiers || {};
  const n = (v) => fmt.num(v);
  const counts = overview ? overview.prs.byCategory : null;
  const total = overview ? overview.prs.total : 0;
  const step = (title, text) => h('li', null, h('div', null, h('strong', null, title), ' ', text));

  el.append(
    pageHead({
      title: 'How contributions are counted',
      lede: 'What this site counts, how each pull request is put into a category, and where the data comes from.',
    }),
    h('div', { class: 'prose' },
      h('h2', null, 'What this site counts'),
      h('p', null,
        'The headline number is ', h('strong', null, 'merged open-source pull requests'),
        ': pull requests by tracked NST students that maintainers of an established public project accepted. Its companion is the number of ',
        h('strong', null, 'students with at least one merged open-source pull request'), '.'),
      h('p', null,
        'Everything else a student does on GitHub in public (coursework, club projects, practice repositories, their own and their friends’ projects) is kept and shown on their profile, ',
        'but it is not part of the headline. That work is worth doing; it is simply a different thing from getting a change accepted by an outside project.'),

      h('h2', null, 'The six categories'),
    ),
    table({
      caption: 'Categories', sticky: false,
      rows: CATEGORIES.map((c) => ({ c })),
      columns: [
        { key: 'c', label: 'Category', render: (row) => categoryBadge(row.c) },
        { key: 'help', label: 'What it means', wrap: true, render: (row) => CATEGORY_HELP[row.c] },
        { key: 'count', label: 'Pull requests', num: true, render: (row) => (counts ? fmt.num(counts[row.c]) : null) },
        { key: 'share', label: 'Share', num: true, render: (row) => (counts ? fmt.pct(counts[row.c], total) : null) },
        { key: 'headline', label: 'In the headline', render: (row) => (row.c === 'open_source' ? 'Yes' : 'No') },
      ],
    }),
    h('div', { class: 'prose' },
      h('h2', null, 'How a pull request is classified'),
      h('p', null, 'The rules are applied in this order and the first one that matches decides. Names are compared without regard to capital letters.'),
      h('ol', { class: 'rule-steps' },
        step('A decision on the pull request.', 'An admin can mark a single pull request as open source or not open source. That decision wins over everything below and is shown on the pull request.'),
        step('A decision on the project.', 'An admin can include or exclude a whole repository.'),
        step('A decision on the owner.', 'An admin can include or exclude an organisation, or mark it as NST internal.'),
        step('The student’s own repository.', 'A pull request to a repository under the student’s own account is “Own repo”.'),
        step('NST organisations.', 'Repositories owned by a listed NST organisation, or by an account whose name contains an NST keyword, are “NST internal”.'),
        step('Another tracked student’s repository.', 'These are “Peer repo”: usually group projects and friends’ repositories.'),
        step('Practice repositories.', 'Listed first-contribution repositories, and repositories or owners whose name contains a practice keyword, are “Practice repo”.'),
        step('Forks.', 'A pull request to a repository that is itself a fork is “Low signal”.'),
        step('Always-counted organisations.', 'Projects of the organisations listed below count as open source whatever their star count.'),
        step('Personal projects need a track record.', ['A repository owned by a person (not an organisation) with fewer than ', h('strong', null, n(r.minStarsUserRepo)), ' stars is “Low signal”.']),
        step('So do organisation projects.', ['A repository with fewer than ', h('strong', null, n(r.minStarsOrgRepo)), ' stars is “Low signal”.']),
        step('Everything else is open source.', 'It then gets a tier by stars.')),

      h('h3', null, 'Tiers'),
      h('p', null, 'Open-source projects are grouped by GitHub stars at the time of the last update:'),
      h('ul', null,
        h('li', null, tierBadge('major'), ` ${n(tiers.major)} stars or more`),
        h('li', null, tierBadge('established'), ` ${n(tiers.established)} to ${n(tiers.major - 1)} stars`),
        h('li', null, tierBadge('emerging'), ` fewer than ${n(tiers.established)} stars`)),
      h('p', null, 'Stars are a rough proxy for how established a project is, not a measure of the quality of a contribution. Admins correct the cases where the proxy is wrong.'),

      h('h2', null, 'Current lists'),
      h('h3', null, 'NST organisations'),
      chips(r.nstOrgs, 'None listed.'),
      h('h3', null, 'NST owner keywords'),
      chips(r.nstOwnerKeywords, 'None listed.'),
      h('h3', null, 'Practice repositories'),
      chips(r.practiceRepos, 'None listed.'),
      h('h3', null, 'Practice keywords'),
      chips(r.practiceKeywords, 'None listed.'),
      h('h3', null, 'Always-counted organisations'),
      chips(r.allowOrgs, 'None listed.'),
      r.updatedAt ? h('p', { class: 'muted' }, `Rules last changed ${fmt.date(r.updatedAt)}.`) : null,

      h('h2', null, 'Where the data comes from'),
      h('p', null,
        `GitHub’s public search for pull requests, one query per tracked username, refreshed daily. ${fmt.num(meta.counts.students)} students and ${fmt.num(meta.counts.prs)} pull requests are in the register. `,
        meta.lastSyncAt ? `Last updated ${fmt.datetime(meta.lastSyncAt)}.` : 'No update has run yet.'),
      h('ul', null,
        h('li', null, 'Pull requests in private repositories are never stored.'),
        h('li', null, 'Only pull requests are counted. Issues, reviews, discussions and commits pushed directly are not.'),
        h('li', null, 'Work done under a GitHub account that is not tracked here is not visible.'),
        h('li', null, 'Year of study is worked out from the batch and today’s date; the academic year starts on 1 July.')),

      h('h2', null, 'Corrections'),
      h('p', null,
        'If a project is in the wrong category, a pull request is missing, or your account is not tracked, tell your campus open-source coordinator or a site admin. ',
        'Admins can add students and override the category of a pull request, a project or an organisation; overridden items are marked.'),
      h('p', null, h('a', { href: link('/prs', { category: 'all' }, ctx) }, 'Browse every pull request'), ' · ',
        h('a', { href: '/api/export/students.csv' }, 'Download the student table as CSV')),
    ),
  );
}
