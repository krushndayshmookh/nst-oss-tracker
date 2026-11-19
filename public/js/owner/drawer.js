// Krushn's dashboard → the student panel: one student's readiness score per program with its breakdown ("why"),
// the pull requests behind it, the weeks of the program window, the suggested next step, and the private note + flag.
// A side drawer on <body> (shell styles: admin.html), so filtering or paging the list underneath does not close it.
//
//   syncStudentPanel(username | '', { program?, onClose(), onChanged() })   open / switch / close; idempotent
//   closeStudentPanel()
//
// Data: GET /api/owner/students/:username, PUT /api/owner/students/:username/note, GET /api/owner/programs.

import { h, table, stateBadge, extLink, ghLink, loading, fmt, toast } from '../lib/ui.js';
import { errorText } from '../admin/common.js';
import {
  oapi, act, Locked, BANDS, BAND_LABELS, FLAGS, FLAG_LABELS, FEATURE_LABELS, bandBadge, scoreCell, deltaNum, pts, plural, calibrationBlock, profileUrl,
} from './common.js';

let cur = null; // { key, el, title, sub, body, handlers, data, cfg, error, program, wantProgram, token, noteDirty }
let cfgCache = null; // GET /programs of this unlock (feature help, eligibility notes, calibration is in the summary)

export function closeStudentPanel() {
  if (!cur) return;
  const c = cur;
  cur = null;
  c.token++;
  document.removeEventListener('keydown', c.onKey);
  c.el.remove();
  document.body.classList.remove('has-drawer');
  cfgCache = null;
}

export function syncStudentPanel(username, handlers = {}) {
  const want = String(username || '').trim();
  if (!want) { closeStudentPanel(); return; }
  if (cur) {
    cur.handlers = handlers;
    if (cur.key.toLowerCase() === want.toLowerCase()) {
      if (handlers.program && handlers.program !== cur.wantProgram) { cur.wantProgram = handlers.program; cur.program = handlers.program; draw(); }
      return;
    }
  } else {
    build(handlers);
  }
  cur.key = want;
  cur.data = null;
  cur.error = null;
  cur.noteDirty = false;
  cur.wantProgram = handlers.program || '';
  cur.program = handlers.program || '';
  cur.title.textContent = want;
  cur.sub.replaceChildren();
  cur.body.scrollTop = 0;
  draw();
  load();
}

function build(handlers) {
  const title = h('h2', { id: 'owner-drawer-title', tabindex: '-1' });
  const sub = h('div', { class: 'drawer-meta' });
  const body = h('div', { class: 'drawer-body' });
  const close = h('button', { type: 'button', class: 'dialog-close', name: 'drawer-close', 'aria-label': 'Close the student panel', title: 'Close (Esc)' }, '×');
  const el = h('aside', { class: 'drawer owner-drawer', id: 'owner-drawer', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'owner-drawer-title' },
    h('header', { class: 'drawer-head' }, h('div', { class: 'drawer-title' }, h('div', { class: 'drawer-kind' }, 'Student · private view'), title, sub), close),
    body);
  const requestClose = () => {
    if (!cur) return;
    if (cur.noteDirty && !window.confirm('Your note has unsaved changes. Close without saving?')) return;
    const fn = cur.handlers.onClose;
    closeStudentPanel();
    if (fn) fn();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape' || !cur) return;
    if (document.querySelector('dialog[open]')) return;
    e.preventDefault();
    requestClose();
  };
  close.addEventListener('click', requestClose);
  document.addEventListener('keydown', onKey);
  cur = { key: '', el, title, sub, body, handlers, data: null, cfg: null, error: null, program: '', wantProgram: '', token: 0, noteDirty: false, onKey };
  document.body.append(el);
  document.body.classList.add('has-drawer');
  setTimeout(() => { if (cur && cur.el === el) title.focus({ preventScroll: true }); }, 0);
}

async function load() {
  const c = cur;
  const token = ++c.token;
  try {
    if (!cfgCache) cfgCache = oapi.get('/programs').catch((err) => { cfgCache = null; throw err; });
    const [data, cfg] = await Promise.all([oapi.get(`/students/${encodeURIComponent(c.key)}`), cfgCache]);
    if (cur !== c || token !== c.token) return;
    c.data = data;
    c.cfg = cfg;
  } catch (err) {
    if (err instanceof Locked) return;
    if (cur !== c || token !== c.token) return;
    c.error = err;
  }
  draw();
}

/* ───────────── drawing ───────────── */

function draw() {
  const c = cur;
  if (!c) return;
  c.el.setAttribute('aria-busy', c.data || c.error ? 'false' : 'true');
  if (c.error) {
    c.body.replaceChildren(h('div', { class: 'notice notice-warn', role: 'alert' },
      c.error.status === 404 ? 'This student is not tracked (or is inactive), so there is no score.' : errorText(c.error)));
    return;
  }
  if (!c.data) { c.body.replaceChildren(loading('Loading the student…')); return; }

  const { student: s, note, outcomes } = c.data;
  const cfg = c.cfg || { programs: [], featureKeys: [], featureHelp: {} };
  const enabled = (cfg.programs || []).filter((p) => p.enabled && s.programs[p.key]);
  if (!enabled.some((p) => p.key === c.program)) {
    c.program = (enabled.find((p) => p.key === s.bestProgram) || enabled.find((p) => s.programs[p.key].band !== 'none') || enabled[0] || {}).key || '';
  }
  const prog = enabled.find((p) => p.key === c.program) || null;
  const ps = prog ? s.programs[prog.key] : null;

  c.title.textContent = s.name || s.username;
  c.sub.replaceChildren(
    h('span', null, `${s.campus} · ${s.year}${s.batch ? ` · batch ${s.batch}` : ''}`),
    ghLink(s.username, `@${s.username}`),
    h('a', { href: profileUrl(s.username), target: '_blank', rel: 'noopener', class: 'ext' }, 'Public profile'));

  c.body.replaceChildren(...[
    noteSection(c, s, note),
    h('section', { class: 'drawer-section' },
      h('h3', null, 'Readiness score per program'),
      h('div', { class: 'od-progs', role: 'group', 'aria-label': 'Program' }, enabled.map((p) => h('button', {
        type: 'button', class: 'od-prog', name: `prog-${p.key}`, 'aria-pressed': p.key === c.program ? 'true' : 'false',
        onClick: () => { c.program = p.key; draw(); },
      }, p.name, scoreCell(s.programs[p.key]))))),
    prog && ps ? programSection(s, prog, ps, cfg) : h('p', { class: 'muted' }, 'No program is enabled.'),
    outcomes && outcomes.length ? h('section', { class: 'drawer-section' },
      h('h3', null, 'Past program results (uploaded by you)'),
      h('ul', { class: 'od-blockers' }, outcomes.map((o) => h('li', null,
        `${(cfg.programs.find((p) => p.key === o.program) || {}).name || o.program} ${o.year}${o.org ? `, ${o.org}` : ''}: `, h('b', null, o.selected ? 'selected' : 'applied, not selected'))))) : null].filter(Boolean));
}

function noteSection(c, s, note) {
  const flag = note.flag || null;
  const area = h('textarea', { name: 'owner-note', rows: 3, maxlength: 5000, placeholder: 'Private note: what you agreed, which organisation, who mentors…', 'aria-label': 'Private note' });
  area.value = note.note || '';
  const stateText = h('span', { role: 'status' }, note.updatedAt ? `Saved ${fmt.rel(note.updatedAt)}` : 'Only you can read this.');
  const save = h('button', { type: 'button', class: 'btn btn-sm', name: 'note-save', disabled: true }, 'Save note');
  area.addEventListener('input', () => {
    c.noteDirty = area.value !== (note.note || '');
    save.disabled = !c.noteDirty;
    stateText.textContent = c.noteDirty ? 'Not saved yet' : (note.updatedAt ? `Saved ${fmt.rel(note.updatedAt)}` : 'Only you can read this.');
  });
  const put = async (body, button, done) => {
    const res = await act(() => oapi.put(`/students/${encodeURIComponent(s.username)}/note`, body), { button });
    if (!res || cur !== c) return;
    c.data.note = res.note;
    c.data.student.flag = res.note.flag;
    c.data.student.hasNote = Boolean(res.note.note);
    if ('note' in body) c.noteDirty = false;
    toast(done(res.note));
    // keep what is being typed when only the flag changed
    const typed = c.noteDirty ? area.value : null;
    draw();
    if (typed !== null) {
      const next = c.body.querySelector('textarea[name="owner-note"]');
      if (next) { next.value = typed; next.dispatchEvent(new Event('input')); }
    }
    if (c.handlers.onChanged) c.handlers.onChanged();
  };
  save.addEventListener('click', () => put({ note: area.value }, save, () => `Saved your note on ${s.name || s.username}.`));
  return h('section', { class: 'drawer-section od-note' },
    h('h3', null, 'Your decision and note'),
    h('div', { class: 'od-flags btn-group', role: 'group', 'aria-label': 'Flag' }, FLAGS.map((f) => h('button', {
      type: 'button', class: ['btn btn-sm', flag === f && 'is-on'], name: `flag-${f}`, 'aria-pressed': flag === f ? 'true' : 'false',
      title: flag === f ? 'Click again to remove the flag' : null,
      onClick: (e) => put({ flag: flag === f ? null : f }, e.currentTarget,
        (n) => (n.flag ? `${s.name || s.username}: ${FLAG_LABELS[n.flag]}.` : `Removed the flag from ${s.name || s.username}.`)),
    }, FLAG_LABELS[f]))),
    area,
    h('div', { class: 'od-note-foot' }, stateText, save));
}

function programSection(s, prog, ps, cfg) {
  const none = ps.band === 'none' && !ps.prs;
  const sumW = Object.values(ps.features || {}).reduce((a, f) => a + (Number(f.weight) || 0), 0) || 1;
  const keys = (cfg.featureKeys && cfg.featureKeys.length ? cfg.featureKeys : Object.keys(ps.features || {})).filter((k) => ps.features && ps.features[k]);

  const top = h('div', { class: 'od-top' },
    h('div', { class: `od-score band-${BANDS.includes(ps.band) ? ps.band : 'none'}` }, h('b', null, ps.score), h('span', null, 'of 100')),
    h('div', { class: 'od-top-text' },
      h('span', { class: 'od-band' }, `${BAND_LABELS[ps.band] || ps.band} readiness for ${prog.name}`),
      h('span', null,
        ps.bestOrg ? ['Best organisation: ', ghLink(ps.bestOrg), ` · ${plural(ps.mergedInBestOrg || 0, 'merged PR')} there`] : 'No organisation of this program yet',
        ps.prs ? ` · ${plural(ps.prs, 'PR')} counted, ${fmt.num(ps.merged)} merged` : ''),
      h('span', { class: 'muted' }, ps.delta ? [deltaNum(ps.delta), ` points in ${cfg.trendDays || 30} days (was ${ps.prevScore}, ${BAND_LABELS[ps.prevBand] || ps.prevBand})`] : `No change in ${cfg.trendDays || 30} days`,
        ps.lastActivityAt ? ` · last PR ${fmt.rel(ps.lastActivityAt)}` : '')));

  const next = ps.nextStep ? h('div', { class: 'od-next' }, h('h3', null, 'Suggested next step'), h('p', null, ps.nextStep)) : null;
  const blockers = (ps.blockers || []).length ? h('section', { class: 'drawer-section' },
    h('h3', null, 'What holds this score back'),
    h('ul', { class: 'od-blockers' }, ps.blockers.map((b) => h('li', null, b.charAt(0).toUpperCase() + b.slice(1))))) : null;

  const why = h('section', { class: 'drawer-section' },
    h('h3', null, 'Why this score'),
    h('div', null, keys.map((k) => {
      const f = ps.features[k];
      const max = (Number(f.weight) || 0) * 100 / sumW;
      return h('div', { class: 'feat', title: (cfg.featureHelp || {})[k] || null },
        h('span', { class: 'feat-name' }, FEATURE_LABELS[k] || k),
        h('span', { class: 'feat-pts' }, h('b', null, pts(f.points)), h('small', null, ` of ${pts(max)}`)),
        h('span', { class: ['feat-track', f.value < 0.34 && 'is-low'], role: 'img', 'aria-label': `${Math.round(f.value * 100)}% of the points available` }, h('span', { style: { width: `${Math.max(0, Math.min(1, f.value)) * 100}%` } })),
        h('span', { class: 'feat-why' }, f.explain ? f.explain.charAt(0).toUpperCase() + f.explain.slice(1) : ''));
    }),
    h('div', { class: 'feat-total' }, h('span', null, 'Readiness score'), h('span', null, `${ps.score} of 100`))),
    none ? h('p', { class: 'fine' }, `The few points come from merged work elsewhere; no pull request counts for ${prog.name} yet, so the band is No signal.`) : null,
    h('p', { class: 'fine' }, 'Short bars in marigold are the weakest parts. Hover a line for how it is measured. A heuristic from public pull requests, not a probability of selection.'));

  const orgs = (ps.orgs || []).length ? h('section', { class: 'drawer-section' },
    h('h3', null, prog.match === 'orgs' ? `Organisations of ${prog.name} with their work` : 'Where the counted work is'),
    table({
      compact: true, sticky: false, caption: 'Organisations',
      columns: [
        { key: 'login', label: 'Organisation', render: (o) => [ghLink(o.login), o.login === ps.bestOrg ? [' ', h('span', { class: 'tag tag-on' }, 'best')] : null] },
        { key: 'merged', label: 'Merged', num: true },
        { key: 'open', label: 'Open', num: true },
        { key: 'closed', label: 'Closed', num: true },
        { key: 'last', label: 'Last PR', num: true, render: (o) => (o.lastActivityAt ? h('span', { title: fmt.date(o.lastActivityAt) }, fmt.rel(o.lastActivityAt)) : null) },
      ],
      rows: ps.orgs.slice(0, 8),
    }),
    ps.orgs.length > 8 ? h('p', { class: 'fine' }, `and ${ps.orgs.length - 8} more`) : null) : null;

  const evidence = (ps.evidence || []).length ? h('section', { class: 'drawer-section' },
    h('h3', null, 'Pull requests behind the score'),
    h('ul', { class: 'ev' }, ps.evidence.map((e) => h('li', null,
      h('span', { class: 'ev-title' }, extLink(e.title || e.url, e.url)),
      h('span', { class: 'ev-meta' },
        h('span', null, e.repo), stateBadge(e.state),
        h('span', null, e.mergedAt ? `merged ${fmt.date(e.mergedAt)}` : `opened ${fmt.date(e.createdAt)}`),
        h('span', { class: 'nowrap' }, `+${fmt.num(e.additions)} −${fmt.num(e.deletions)} in ${plural(e.changedFiles, 'file')}`),
        e.nonTrivial ? null : h('span', { class: 'tag', title: 'Small or docs-only: does not count as substantial work' }, 'small change')))))) : null;

  const cal = null; // per-band past selection counts are on the Summary tab (they describe a band, not this student)
  const elig = prog.eligibilityNote ? h('p', { class: 'fine' }, h('b', null, 'Eligibility: '), prog.eligibilityNote) : null;

  return h('div', { class: 'stack' }, top, next, blockers, why, timeline(prog, ps), orgs, evidence, elig, cal ? calibrationBlock(cal) : null);
}

/** Weeks of the program window so far: opened and merged pull requests per week. */
function timeline(prog, ps) {
  const weeks = ps.timeline || [];
  if (!weeks.length) return null;
  const max = Math.max(1, ...weeks.map((w) => Math.max(w.opened || 0, w.merged || 0)));
  const opened = weeks.reduce((a, w) => a + (w.opened || 0), 0);
  const merged = weeks.reduce((a, w) => a + (w.merged || 0), 0);
  const active = weeks.filter((w) => (w.opened || 0) + (w.merged || 0) > 0).length;
  const day = (d) => fmt.range(d, null).replace(/^From /, '');
  let lastMonth = '';
  return h('section', { class: 'drawer-section' },
    h('h3', null, `Week by week in the ${prog.name} window`),
    h('div', { class: 'tl', role: 'img', 'aria-label': `${opened} pull requests opened and ${merged} merged in ${active} of ${weeks.length} weeks since ${day(weeks[0].weekStart)}` },
      weeks.map((w) => h('div', { class: ['tl-col', !(w.opened || w.merged) && 'is-empty'], title: `Week of ${day(w.weekStart)}: ${w.opened || 0} opened, ${w.merged || 0} merged` },
        h('i', { class: 'tl-opened', style: { height: `${((w.opened || 0) / max) * 100}%` } }),
        h('i', { class: 'tl-merged', style: { height: `${((w.merged || 0) / max) * 100}%` } })))),
    h('div', { class: 'tl-axis', 'aria-hidden': 'true' }, weeks.map((w) => {
      const m = fmt.month(w.weekStart).split(' ')[0];
      const show = m !== lastMonth;
      lastMonth = m;
      return h('span', null, show ? m : '');
    })),
    h('div', { class: 'tl-legend' },
      h('span', null, h('i', { class: 'tl-opened', style: { background: 'color-mix(in srgb, var(--brand) 32%, var(--surface))' } }), `Opened (${fmt.num(opened)})`),
      h('span', null, h('i', { style: { background: 'var(--state-merged)' } }), `Merged (${fmt.num(merged)})`),
      h('span', null, `Active in ${active} of ${weeks.length} weeks · window ${fmt.range(prog.window.from, prog.window.to)} · tallest bar ${max}`)));
}
