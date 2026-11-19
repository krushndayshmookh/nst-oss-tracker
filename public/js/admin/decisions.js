// Include / exclude decisions on pull requests, repositories and owners (POST /admin/{prs,repos,owners}/override).
// Used by Review, Pull requests and Overrides. Every decision: say what it will reach, take an optional note,
// apply it, then report the server's own `affected` counts and what happened to the public headline numbers.

import { api } from '../lib/api.js';
import { refresh, href } from '../lib/router.js';
import { h, toast, fmt } from '../lib/ui.js';
import { act, decide, headline, headlineDelta, plural } from './common.js';

const OWNER_STATE = { include: 'included', exclude: 'excluded', nst_internal: 'marked NST internal' };

/* ───────────── what happens after a decision ───────────── */

const listeners = new Set();
/**
 * Hear about every decision the moment the server has applied it: fn({ kind: 'repo' | 'owner' | 'pr', res }) with the
 * server's answer (`res.repo` / `res.org` / `res.pr`). Returns the function that stops listening.
 * Rows and the detail panel use it to redraw their buttons at once, before the list itself is fetched again.
 */
export function onDecision(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function apply({ kind, ask, post, done, button }) {
  const reading = headline(); // read the public totals while the admin is typing the note
  let note = '';
  if (ask) {
    note = await ask();
    if (note === false) return undefined;
  }
  const before = await reading; // must be complete before the change is sent
  if (button) button.classList.add('is-busy');
  const res = await act(() => post(note), { button });
  if (button) button.classList.remove('is-busy');
  if (!res) return undefined;
  for (const fn of [...listeners]) {
    try { fn({ kind, res }); } catch (err) { console.error(err); }
  }
  refresh(); // the numbers around the row (counts, other rows of the same owner) follow in the background
  toast(done(res) + headlineDelta(before, await headline()));
  return res;
}

/* ───────────── effective state: what is already applied, and who applied it ───────────── */

/** Where a repository's category comes from: 'admin' (its own decision), 'org' (a decision on its owner) or 'rule'. */
export function repoSource(r) {
  if (r.override) return 'admin';
  if (r.ownerOverride || /^admin: org/.test(r.reason || '')) return 'org';
  return 'rule';
}

/** Where a pull request's category comes from: 'admin' (marked itself), 'repo', 'org' (decision one level up) or 'rule'. */
export function prSource(p) {
  if (p.override) return 'admin';
  if (/^admin: repo/.test(p.reason || '')) return 'repo';
  if (/^admin: org/.test(p.reason || '')) return 'org';
  return 'rule';
}

/** Review link that opens the detail panel of a repository ('owner/name') or an owner (login). */
export function reviewHref(key) {
  const name = String(key || '');
  return name.includes('/') ? href('/review', { q: name, open: name }) : href('/review', { tab: 'owners', q: name, open: name });
}

const SOURCE_TEXT = { rule: 'by rule', admin: 'by admin', repo: 'via repo', org: 'via org' };
const SOURCE_TITLE = {
  rule: 'Placed by the rules (stars, lists, keywords). No admin decision.',
  admin: 'Set by an admin decision. It wins over the rules.',
};

/**
 * Small tag next to a category: sourceTag('rule' | 'admin') or sourceTag('repo' | 'org', { link: 'owner/name' | login })
 * (the latter links to that row in Review). `note` becomes part of the tooltip.
 */
export function sourceTag(source, { link = null, note = null, onOpen = null } = {}) {
  const text = SOURCE_TEXT[source] || SOURCE_TEXT.rule;
  const cls = `src-tag src-${source}`;
  if ((source === 'repo' || source === 'org') && link) {
    const title = `Follows the admin decision on ${source === 'repo' ? 'the repository' : 'the owner'} ${link}. Open it.`;
    const a = h('a', { class: cls, href: reviewHref(link), title }, text);
    if (onOpen) a.addEventListener('click', (e) => { e.preventDefault(); onOpen(link); });
    return a;
  }
  return h('span', { class: cls, title: source === 'admin' && note ? `Set by an admin: ${note}` : SOURCE_TITLE[source] || null }, text);
}

/** Buttons + reset for a repository row. Include is greyed when it already counts; Exclude only for an explicit exclude. */
export function repoButtons(r, { name = r.name, compact = false } = {}) {
  const src = repoSource(r);
  const included = r.override === 'include' || (!r.override && r.category === 'open_source');
  return decisionButtons({
    name, compact, reset: Boolean(r.override),
    options: [
      { value: 'include', label: 'Include', already: included ? `Already included${r.override ? '' : src === 'org' ? ' (via its owner)' : ' (by rule)'}` : null },
      { value: 'exclude', label: 'Exclude', danger: true, already: r.override === 'exclude' ? 'Already excluded' : null },
    ],
    onPick: (value, btn) => decideRepo(r, value, btn),
  });
}

/** Buttons + reset for an owner row. An owner has no rule-based state of its own, so only its decision greys a button. */
export function ownerButtons(o, { name = o.login, compact = false } = {}) {
  return decisionButtons({
    name, compact, reset: Boolean(o.override),
    options: [
      { value: 'include', label: 'Include', already: o.override === 'include' ? 'Already included' : null },
      { value: 'exclude', label: 'Exclude', danger: true, already: o.override === 'exclude' ? 'Already excluded' : null },
      { value: 'nst_internal', label: 'NST internal', already: o.override === 'nst_internal' ? 'Already NST internal' : null },
    ],
    onPick: (value, btn) => decideOwner(o, value, btn),
  });
}

/** Buttons + reset for a pull request. Only an explicit mark greys its button. */
export function prButtons(p, { name = p.url, compact = false } = {}) {
  return decisionButtons({
    name, compact, reset: Boolean(p.override),
    options: [
      { value: 'open_source', label: 'Open source', already: p.override === 'open_source' ? 'Already marked open source' : null },
      { value: 'not_open_source', label: 'Not open source', danger: true, already: p.override === 'not_open_source' ? 'Already marked not open source' : null },
    ],
    onPick: (value, btn) => decidePr(p, value, btn),
  });
}

/** True when `value` is the state the row is already in (its button is greyed). Used by the keyboard shortcuts. */
export function alreadyText(kind, row, value) {
  if (kind === 'repo') {
    if (value === 'include' && (row.override === 'include' || (!row.override && row.category === 'open_source'))) return 'Already included';
    if (value === 'exclude' && row.override === 'exclude') return 'Already excluded';
    return null;
  }
  if (row.override !== value) return null;
  return { include: 'Already included', exclude: 'Already excluded', nst_internal: 'Already NST internal' }[value] || null;
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
      kind: 'repo', post, button,
      done: (res) => `Cleared the decision on ${repo.name}. ${n(res)} ${res.affected.prs === 1 ? 'is' : 'are'} back under the normal rules (now: ${categoryWord(res.repo)}).`,
    });
  }
  const include = override === 'include';
  return apply({
    kind: 'repo', button,
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
    return apply({ kind: 'owner', post, button, done: (res) => `Cleared the decision on ${org.login}. ${n(res)} are back under the normal rules.` });
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
    kind: 'owner', button,
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
    return apply({ kind: 'pr', post, button, done: (res) => `Cleared the decision on ${ref}. It is back under the normal rules (now: ${categoryWord(res.pr)}).` });
  }
  const yes = override === 'open_source';
  return apply({
    kind: 'pr', button,
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
 * The row of decision buttons.
 *   options: [{ value, label, danger?, already?: string }] — `already` (e.g. "Already included") means the row is in that
 *     state now: the button is greyed, `aria-disabled`, carries the text as tooltip and does nothing when clicked.
 *   reset: show "Reset to rule" (an explicit decision exists) · onPick(value | null, button) · name: suffix of the button names.
 */
export function decisionButtons({ options, reset = false, onPick, name, compact = false }) {
  const buttons = options.map((o) => {
    const off = Boolean(o.already);
    const b = h('button', {
      type: 'button', name: `${o.value}-${name}`, class: ['btn btn-sm', o.danger && !off && 'btn-danger', off && 'is-current'],
      'aria-disabled': off ? 'true' : null, title: o.already || null, 'aria-label': off ? `${o.label}: ${o.already}` : null,
    }, o.label);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (b.getAttribute('aria-disabled') === 'true' || b.disabled) return;
      onPick(o.value, b);
    });
    return b;
  });
  if (reset) {
    const clear = h('button', { type: 'button', name: `clear-${name}`, class: 'btn btn-sm btn-link', title: 'Remove the admin decision; the rules decide again' }, 'Reset to rule');
    clear.addEventListener('click', (e) => { e.stopPropagation(); onPick(null, clear); });
    buttons.push(clear);
  }
  return h('div', { class: ['btn-group decision', compact && 'decision-compact'] }, buttons);
}
