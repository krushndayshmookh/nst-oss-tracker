// Include / exclude decisions on pull requests, repositories and owners (POST /admin/{prs,repos,owners}/override).
// Used by Review, Pull requests and Overrides. Every decision: say what it will reach, take an optional note,
// apply it, then report the server's own `affected` counts and what happened to the public headline numbers.

import { api } from '../lib/api.js';
import { refresh } from '../lib/router.js';
import { h, toast, fmt } from '../lib/ui.js';
import { act, decide, headline, headlineDelta, plural } from './common.js';

const OWNER_STATE = { include: 'included', exclude: 'excluded', nst_internal: 'marked NST internal' };

async function apply({ ask, post, done, button }) {
  const reading = headline(); // read the public totals while the admin is typing the note
  let note = '';
  if (ask) {
    note = await ask();
    if (note === false) return;
  }
  const before = await reading; // must be complete before the change is sent
  const res = await act(() => post(note), { button });
  if (!res) return;
  toast(done(res) + headlineDelta(before, await headline()));
  refresh();
}

/* ───────────── repositories ───────────── */

/** repo: a Repo row (review rows also carry ownerOverride). override: 'include' | 'exclude' | null. */
export function decideRepo(repo, override, button = null) {
  const s = repo.stats || {};
  const reach = `${plural(s.prs || 0, 'pull request')} by ${plural(s.students || 0, 'student')}`;
  const ownerLine = repo.ownerOverride
    ? h('p', { class: 'muted' }, `Its owner ${repo.owner} is ${OWNER_STATE[repo.ownerOverride] || repo.ownerOverride}. A decision on the repository wins over the owner’s.`)
    : null;
  const post = (note) => api.post('/admin/repos/override', { repo: repo.name, override, note });
  const n = (res) => plural(res.affected.prs, 'pull request');

  if (override === null) {
    return apply({
      post, button,
      done: (res) => `Cleared the decision on ${repo.name}. ${n(res)} ${res.affected.prs === 1 ? 'is' : 'are'} back under the normal rules (now: ${categoryWord(res.repo)}).`,
    });
  }
  const include = override === 'include';
  return apply({
    button,
    ask: () => decide({
      title: include ? 'Include repository' : 'Exclude repository',
      confirmLabel: include ? 'Include' : 'Exclude',
      danger: !include,
      note: repo.override === override ? repo.overrideNote : '',
      message: h('div', { class: 'stack' },
        h('p', null, include
          ? `Include ${repo.name}? Its ${reach} will count as open source, whatever the star thresholds and lists say.`
          : `Exclude ${repo.name}? Its ${reach} will stop counting as open source and show as “Low signal”.`),
        ownerLine,
        h('p', { class: 'muted' }, 'A decision made on a single pull request still wins over this one. You can undo this at any time under Overrides.')),
    }),
    post,
    done: (res) => (include
      ? `Included ${repo.name}. ${n(res)} now count${res.affected.prs === 1 ? 's' : ''} as open source.`
      : `Excluded ${repo.name}. ${n(res)} no longer count${res.affected.prs === 1 ? 's' : ''}.`),
  });
}

function categoryWord(repo) {
  const labels = { open_source: 'open source', practice: 'practice repo', nst_internal: 'NST internal', peer_repo: 'peer repo', own_repo: 'own repo', low_signal: 'low signal' };
  return (repo && labels[repo.category]) || 'not counted';
}

/* ───────────── owners ───────────── */

/** org: an Org row. override: 'include' | 'exclude' | 'nst_internal' | null. */
export function decideOwner(org, override, button = null) {
  const s = org.stats || {};
  const reach = `${plural(s.prs || 0, 'pull request')} in ${plural(s.repos || 0, 'repository', 'repositories')}`;
  const post = (note) => api.post('/admin/owners/override', { login: org.login, override, note });
  const n = (res) => `${plural(res.affected.prs, 'pull request')} in ${plural(res.affected.repos, 'repository', 'repositories')}`;

  if (override === null) {
    return apply({ post, button, done: (res) => `Cleared the decision on ${org.login}. ${n(res)} are back under the normal rules.` });
  }
  const text = {
    include: [`Include owner`, 'Include', `Include everything owned by ${org.login}? All ${reach} will count as open source, whatever the star thresholds say.`,
      (res) => `Included ${org.login}. ${n(res)} now count as open source.`],
    exclude: ['Exclude owner', 'Exclude', `Exclude everything owned by ${org.login}? All ${reach} (${fmt.num(s.osPrs || 0)} of them currently open source) will stop counting.`,
      (res) => `Excluded ${org.login}. ${n(res)} no longer count.`],
    nst_internal: ['Mark owner as NST internal', 'Mark NST internal', `Mark ${org.login} as an NST organisation? All ${reach} will show as “NST internal” and stop counting as open source.`,
      (res) => `Marked ${org.login} as NST internal. ${n(res)} now show as NST internal.`],
  }[override];
  return apply({
    button,
    ask: () => decide({
      title: text[0],
      confirmLabel: text[1],
      danger: override !== 'include',
      note: org.override === override ? org.overrideNote : '',
      message: h('div', { class: 'stack' },
        h('p', null, text[2]),
        h('p', { class: 'muted' }, 'Repositories and pull requests that have their own decision keep it. This also covers repositories of this owner that show up later. You can undo it under Overrides.')),
    }),
    post,
    done: text[3],
  });
}

/* ───────────── pull requests ───────────── */

/** pr: a PR row. override: 'open_source' | 'not_open_source' | null. */
export function decidePr(pr, override, button = null) {
  const post = (note) => api.post('/admin/prs/override', { url: pr.url, override, note });
  const ref = `${pr.repo}#${pr.number}`;
  if (override === null) {
    return apply({ post, button, done: (res) => `Cleared the decision on ${ref}. It is back under the normal rules (now: ${categoryWord(res.pr)}).` });
  }
  const yes = override === 'open_source';
  return apply({
    button,
    ask: () => decide({
      title: yes ? 'Mark as open source' : 'Mark as not open source',
      confirmLabel: yes ? 'Mark open source' : 'Mark not open source',
      danger: !yes,
      note: pr.override === override ? pr.overrideNote : '',
      message: h('div', { class: 'stack' },
        h('p', null, yes ? 'Count this pull request as open source?' : 'Stop counting this pull request as open source?'),
        h('p', null, h('strong', null, pr.title || ref), h('br'), h('span', { class: 'muted' }, `${ref} · by ${pr.authorName || pr.author}`)),
        h('p', { class: 'muted' }, 'This affects this one pull request only and wins over any decision on its repository or owner.')),
    }),
    post,
    done: () => (yes ? `Marked ${ref} as open source. It now counts.` : `Marked ${ref} as not open source. It no longer counts.`),
  });
}

/**
 * The row of decision buttons. options: [{ value, label, danger? }]; `current` is the applied override (gets .is-on);
 * `onPick(value | null, button)`. "Clear" appears only when a decision exists.
 */
export function decisionButtons({ options, current, onPick, name }) {
  const buttons = options.map((o) => {
    const on = current === o.value;
    const b = h('button', {
      type: 'button', name: `${o.value}-${name}`, class: ['btn btn-sm', o.danger && !on && 'btn-danger', on && 'is-on'],
      'aria-pressed': on ? 'true' : 'false', title: on ? 'Applied. Click to change the note.' : null,
    }, o.label);
    b.addEventListener('click', () => onPick(o.value, b));
    return b;
  });
  if (current) {
    const clear = h('button', { type: 'button', name: `clear-${name}`, class: 'btn btn-sm btn-link' }, 'Clear');
    clear.addEventListener('click', () => onPick(null, clear));
    buttons.push(clear);
  }
  return h('div', { class: 'btn-group', style: { flexWrap: 'nowrap' } }, buttons);
}
