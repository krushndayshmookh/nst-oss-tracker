// Admin → Overrides. Every decision currently in force (GET /admin/overrides), newest first, each with Undo.

import { api } from '../lib/api.js';
import { h, pageHead, table, card, empty, extLink, ghLink, overrideBadge, categoryBadge, fmt } from '../lib/ui.js';
import { decidePr, decideRepo, decideOwner } from './decisions.js';

const when = (r) => (r.overrideAt ? h('span', { title: fmt.datetime(r.overrideAt) }, fmt.rel(r.overrideAt)) : null);
const note = { key: 'overrideNote', label: 'Note', wrap: true };

function undo(label, run) {
  const b = h('button', { type: 'button', class: 'btn btn-sm', name: `undo-${label}`, 'aria-label': `Undo the decision on ${label}` }, 'Undo');
  b.addEventListener('click', () => run(b));
  return b;
}

export default async function (el) {
  const data = await api.get('/admin/overrides');
  const total = data.prs.length + data.repos.length + data.owners.length;

  el.append(pageHead({
    title: 'Overrides',
    lede: total
      ? `${fmt.num(total)} ${total === 1 ? 'decision is' : 'decisions are'} in force. They win over the rules until you undo them.`
      : 'Decisions that win over the rules are listed here.',
  }));
  if (!total) {
    el.append(empty('No decisions yet. Make them in Review or Pull requests.', h('a', { class: 'btn', href: '#/review' }, 'Open Review')));
    return;
  }

  el.append(
    card({ flush: true, title: 'Owners', note: `${fmt.num(data.owners.length)}` },
      table({
        caption: 'Decisions on owners', compact: true, rows: data.owners, empty: 'No decisions on owners.',
        columns: [
          { key: 'login', label: 'Owner', render: (o) => h('div', null, ghLink(o.login), h('div', { class: 'sub' }, `${fmt.num(o.stats.prs)} PRs in ${fmt.num(o.stats.repos)} repos`)) },
          { key: 'override', label: 'Decision', render: (o) => overrideBadge(o.override, o.overrideNote) },
          note,
          { key: 'overrideAt', label: 'When', class: 'nowrap', render: when },
          { key: 'undo', label: 'Undo', render: (o) => undo(o.login, (b) => decideOwner(o, null, b)) },
        ],
      })),
    card({ flush: true, title: 'Repositories', note: `${fmt.num(data.repos.length)}` },
      table({
        caption: 'Decisions on repositories', compact: true, rows: data.repos, empty: 'No decisions on repositories.',
        columns: [
          { key: 'name', label: 'Repository', render: (r) => h('div', null, ghLink(r.name), h('div', { class: 'sub' }, `${fmt.num(r.stats.prs)} PRs by ${fmt.num(r.stats.students)} students · ${fmt.compact(r.stars)} stars`)) },
          { key: 'override', label: 'Decision', render: (r) => overrideBadge(r.override, r.overrideNote) },
          note,
          { key: 'overrideAt', label: 'When', class: 'nowrap', render: when },
          { key: 'undo', label: 'Undo', render: (r) => undo(r.name, (b) => decideRepo(r, null, b)) },
        ],
      })),
    card({ flush: true, title: 'Pull requests', note: `${fmt.num(data.prs.length)}` },
      table({
        caption: 'Decisions on pull requests', compact: true, rows: data.prs, empty: 'No decisions on single pull requests.',
        columns: [
          {
            key: 'title', label: 'Pull request', wrap: true,
            render: (p) => h('div', null, extLink(p.title || `#${p.number}`, p.url), h('div', { class: 'sub' }, `${p.repo}#${p.number} · ${p.authorName || p.author}`)),
          },
          { key: 'override', label: 'Decision', render: (p) => h('div', null, overrideBadge(p.override, p.overrideNote), h('div', { class: 'sub' }, categoryBadge(p.category, p.tier))) },
          note,
          { key: 'overrideAt', label: 'When', class: 'nowrap', render: when },
          { key: 'undo', label: 'Undo', render: (p) => undo(`${p.repo}#${p.number}`, (b) => decidePr(p, null, b)) },
        ],
      })));
}
