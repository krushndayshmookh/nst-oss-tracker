// About: what is counted and how a pull request is classified, with the live rules. GET /meta, GET /overview.

import { api } from '../lib/api.js';
import { h, pageHead, table, categoryBadge, tierBadge, fmt, CATEGORIES, CATEGORY_HELP } from '../lib/ui.js';
import { getMeta, hasRanges, link, put, rangeParams, rangeControl, rangeLine, rangeSentence } from './common.js';

function chips(list, emptyText) {
  if (!list || !list.length) return h('p', { class: 'muted' }, emptyText);
  return h('ul', { class: 'chips' }, list.map((v) => h('li', { class: 'chip', style: { paddingRight: '8px' } }, v)));
}

export default async function (el, ctx) {
  const meta = await getMeta();
  const range = rangeParams(ctx.query, meta);
  const overview = await api.get('/overview', range).catch(() => null);
  const ay = meta.academicYear && meta.academicYear.current;
  const tzNote = !meta.tz || meta.tz === 'Asia/Kolkata' ? 'India Standard Time' : meta.tz;
  const r = meta.rulesSummary || {};
  const tiers = r.tiers || {};
  const n = (v) => fmt.num(v);
  const counts = overview ? overview.prs.byCategory : null;
  const total = overview ? overview.prs.total : 0;
  const step = (title, text) => h('li', null, h('div', null, h('strong', null, title), ' ', text));

  put(el, 
    pageHead({
      title: 'How contributions are counted',
      range: overview ? rangeLine(overview.range) : null,
      lede: 'What this site counts, how each pull request is put into a category, how date ranges work, and where the data comes from.',
    }),
    rangeControl(meta, ctx),
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
      overview && overview.range ? h('p', { class: 'muted' }, `Pull requests opened in the selected period (${rangeSentence(overview.range)}).`) : null,
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

      h('h2', { id: 'campus-rates' }, 'Comparing campuses'),
      h('p', null,
        'The campuses differ a lot in size, so wherever campuses or years of study are set side by side the site shows rates: ',
        h('strong', null, 'figures per 100 tracked students'), ' (a count divided by the number of tracked students in the group, times 100) and ',
        h('strong', null, 'shares of the tracked students'), '. The denominator is the number of ', h('strong', null, 'tracked students'),
        ': students of that campus and year whose GitHub username is known to this site. It is not the full strength of the batch, ',
        'so a campus where fewer usernames have been collected has a smaller denominator than its enrolment. ',
        'The number of students behind a rate is always shown beside it, and a group with fewer than 30 tracked students is marked “small cohort”, because one student moves its rate a lot. ',
        h('a', { href: link('/campuses', {}, ctx) }, 'Compare the campuses'), '.'),

      hasRanges(meta) ? [
        h('h2', null, 'Date ranges'),
        h('p', null,
          'Every page shows its figures for one period, chosen with the buttons under the page title. ',
          ay ? ['Unless you choose otherwise that is the current academic year, ', h('strong', null, `AY ${ay.label}`), ` (${fmt.range(ay.start, ay.end)}). `] : null,
          'The period is part of the page address, so a link you share opens on the same dates.'),
        h('ul', null,
          h('li', null, 'A pull request counts as ', h('strong', null, 'opened'), ' in a period when it was created in it, and as ', h('strong', null, 'merged'),
            ' when it was merged in it, whenever it was opened. A pull request opened in June and merged in July is opened in one academic year and merged in the next.'),
          h('li', null, '“Students with a merged open-source pull request” means at least one merged in the period.'),
          h('li', null, `Days, weeks (Monday to Sunday), months and hours are in ${tzNote}. A period includes both its first and its last day.`),
          h('li', null, 'Year of study is always as of today. For a past academic year the batch is shown beside it, because a student now in 3rd year was in 2nd year then.')),
        h('p', null, h('a', { href: link('/activity', {}, ctx) }, 'When students contribute'), ' breaks the period down by month, week, day, day of the week and hour.'),
      ] : null,

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
        h('a', { href: api.url('/export/students.csv', range), download: '' }, 'Download the student table as CSV')),
    ),
  );
}
