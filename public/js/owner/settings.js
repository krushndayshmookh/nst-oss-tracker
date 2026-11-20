// Krushn's dashboard → Settings: programs (organisation lists, contribution windows, weights), band thresholds,
// the GSoC organisation → GitHub login mapping, past outcomes (calibration) and "recompute now".
// Data: GET/PUT /api/owner/programs, GET /api/owner/program-orgs + PUT /api/owner/program-orgs/:id,
// GET/POST/DELETE /api/owner/outcomes, POST /api/owner/recompute.

import { href, setQuery, refresh } from '../lib/router.js';
import { h, card, table, tabs, filterBar, fmt, toast, badge, confirmDialog, ghLink, extLink, safeUrl } from '../lib/ui.js';
import { field, errorText } from '../admin/common.js';
import { oapi, act, BANDS, BAND_LABELS, FEATURE_LABELS, MATCH_LABELS, bandBadge, calibrationBlock, plural, pts } from './common.js';

const SUBS = [
  { key: 'programs', label: 'Programs and scoring' },
  { key: 'orgs', label: 'Organisation mapping' },
  { key: 'outcomes', label: 'Past outcomes' },
];
const lines = (text) => String(text || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
const clone = (v) => JSON.parse(JSON.stringify(v));

export default async function settingsPage(el, ctx, shared) {
  const sub = SUBS.find((s) => s.key === ctx.query.s) || SUBS[0];
  const cfg = await oapi.get('/programs');
  shared.bands = cfg.bands;

  const recompute = h('button', { type: 'button', class: 'btn', name: 'recompute', disabled: Boolean(cfg.job) }, cfg.job ? 'Recomputing…' : 'Recompute scores now');
  recompute.addEventListener('click', async () => {
    const res = await act(() => oapi.post('/recompute', {}), {
      button: recompute,
      onError: (err) => { if (err.status === 409) { toast('A recompute is already running.'); refresh(); return true; } return false; },
    });
    if (res) { toast('Recomputing every score. This takes a few seconds.'); refresh(); }
  });

  el.append(
    h('div', { class: 'section-head' },
      h('p', { class: 'fine' }, cfg.computedAt ? `Scores were last computed ${fmt.datetime(cfg.computedAt)}. ` : 'Scores have not been computed yet. ',
        'They are recomputed after every fetch and after every change made here.'),
      recompute),
    tabs(SUBS.map((s) => ({ label: s.label, href: href(ctx.path, { s: s.key === 'programs' ? '' : s.key }), active: s === sub })), { label: 'Settings sections' }));

  if (sub.key === 'orgs') return mappingTab(el, ctx, cfg);
  if (sub.key === 'outcomes') return outcomesTab(el, ctx, cfg);
  return programsTab(el, ctx, cfg, shared);
}

/* ───────────── programs, weights, thresholds ───────────── */

function programsTab(el, ctx, cfg, shared) {
  const draft = { programs: clone(cfg.programs), bands: { ...cfg.bands }, trendDays: cfg.trendDays, crowdedAt: cfg.crowdedAt };
  const original = JSON.stringify(draft);
  const isDirty = () => JSON.stringify(draft) !== original;
  shared.isDirty = isDirty;

  const stateText = h('span', { class: 'set-state', role: 'status' }, 'No changes.');
  const problem = h('div', { class: 'notice notice-warn', role: 'alert', hidden: true });
  const save = h('button', { type: 'button', class: 'btn btn-primary', name: 'save-settings', disabled: true }, 'Save and recompute');
  const discard = h('button', { type: 'button', class: 'btn', name: 'discard-settings', disabled: true }, 'Discard changes');
  const touched = () => {
    const d = isDirty();
    save.disabled = !d;
    discard.disabled = !d;
    stateText.textContent = d ? 'Unsaved changes. Nothing is recomputed until you save.' : 'No changes.';
  };
  const num = (input, fallback = NaN) => { const v = Number(String(input.value).trim()); return input.value.trim() === '' || !Number.isFinite(v) ? fallback : v; };

  /* thresholds */
  const bandField = (k, hint) => {
    const f = field({ label: `${BAND_LABELS[k]} from`, name: `band-${k}`, type: 'number', value: draft.bands[k], hint, attrs: { min: 1, max: 100, step: 1, inputmode: 'numeric' } });
    f.input.addEventListener('input', () => { draft.bands[k] = num(f.input); touched(); });
    return f.row;
  };
  const trend = field({ label: 'Trend period, days', name: 'trendDays', type: 'number', value: draft.trendDays, hint: 'Scores are compared with this many days ago (7 to 180).', attrs: { min: 7, max: 180, step: 1, inputmode: 'numeric' } });
  trend.input.addEventListener('input', () => { draft.trendDays = num(trend.input); touched(); });
  const crowd = field({ label: 'Crowded from, students', name: 'crowdedAt', type: 'number', value: draft.crowdedAt, hint: 'An organisation counts as crowded when this many students have it as their best one.', attrs: { min: 2, max: 100, step: 1, inputmode: 'numeric' } });
  crowd.input.addEventListener('input', () => { draft.crowdedAt = num(crowd.input); touched(); });

  el.append(card({ title: 'Readiness bands', note: 'Apply to every program' },
    h('div', { class: 'set-grid' },
      bandField('strong', 'Score at which a student is shown as Strong.'),
      bandField('possible', 'Must be below Strong.'),
      bandField('early', 'Must be below Possible. Under it: No signal.'),
      trend.row, crowd.row),
    h('p', { class: 'card-note' }, 'A student also needs merged work in a program organisation to reach Possible or Strong; the thresholds alone do not lift someone with a high general track record.')));

  /* programs */
  const list = h('div', { class: 'set-list' });
  const drawPrograms = (openKey = null) => {
    list.replaceChildren(...draft.programs.map((p, i) => programEditor(p, i, openKey)));
  };

  function programEditor(p, index, openKey) {
    const summaryMeta = h('span', { class: 'muted' });
    const title = h('h3', null, p.name || 'New program');
    const tags = h('span', null);
    const paintSummary = () => {
      title.textContent = p.name || 'New program';
      summaryMeta.textContent = `${p.match === 'orgs' ? `${plural((p.orgs || []).length, 'organisation')}${(p.repos || []).length ? `, ${plural(p.repos.length, 'repository', 'repositories')}` : ''}` : MATCH_LABELS[p.match].toLowerCase()} · ${fmt.range(p.window.from, p.window.to)}`;
      tags.replaceChildren(...[
        !p.enabled ? badge('Off', 'neutral') : null,
        p.enabled && !p.prestigious ? h('span', { class: 'tag' }, 'Not counted for real chance') : null,
        p.starter && p.match === 'orgs' ? h('span', { class: 'tag tag-warn' }, 'Unchecked org list') : null].filter(Boolean));
    };
    paintSummary();
    const on = (f, apply) => { f.input.addEventListener(f.input.type === 'checkbox' || f.input.tagName === 'SELECT' ? 'change' : 'input', () => { apply(); paintSummary(); touched(); }); return f.row; };

    const name = field({ label: 'Name', name: `name-${index}`, value: p.name, attrs: { maxlength: 60 } });
    const key = field({ label: 'Key', name: `key-${index}`, value: p.key, hint: p._new ? '2 to 24 characters: a-z, 0-9 and -. Cannot be changed later without losing the link to uploaded outcomes.' : 'Fixed: outcomes and exports use it.', attrs: { maxlength: 24, readonly: p._new ? null : true } });
    const enabled = field({ label: 'Enabled: compute and show this program', name: `enabled-${index}`, type: 'checkbox', value: p.enabled });
    const prestigious = field({ label: 'Counts for "students with a real chance"', name: `prestigious-${index}`, type: 'checkbox', value: p.prestigious, hint: 'Untick for a general signal that should not lift the headline figure.' });
    const match = field({ label: 'Which pull requests count', name: `match-${index}`, type: 'select', value: p.match, options: Object.entries(MATCH_LABELS).map(([value, label]) => ({ value, label })) });
    const from = field({ label: 'Contribution window from', name: `from-${index}`, type: 'date', value: p.window.from });
    const to = field({ label: 'to (application deadline)', name: `to-${index}`, type: 'date', value: p.window.to });
    const fmtDeadlines = (d) => Object.entries(d || {}).map(([y, v]) => `${y}: ${v}`).join(', ');
    const deadlines = field({ label: 'Past application deadlines', name: `deadlines-${index}`, value: fmtDeadlines(p.deadlines),
      hint: 'Year: date, separated by commas, e.g. 2025: 2025-04-08. Used by Past results.', attrs: { placeholder: '2025: 2025-04-08', spellcheck: 'false' } });
    const parseDeadlines = (text) => {
      const out = {};
      for (const part of String(text || '').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean)) {
        const m = /^(\S+?)\s*[:=]\s*(\S+)$/.exec(part);
        if (m) out[m[1]] = m[2]; else out[part] = '';
      }
      return out;
    };
    const pre = field({ label: 'Weight of earlier work', name: `pre-${index}`, type: 'number', value: p.preWindowWeight, hint: 'A PR merged before the window counts this much (0 to 1).', attrs: { min: 0, max: 1, step: 0.05, inputmode: 'decimal' } });
    const low = field({ label: 'Also count small repositories of these organisations', name: `low-${index}`, type: 'checkbox', value: p.includeLowStar, hint: 'Pull requests that are "low signal" only because the repository has few stars.' });

    const orgs = h('textarea', { name: `orgs-${index}`, rows: 6, spellcheck: 'false', 'aria-label': `${p.name}: GitHub organisations, one per line` });
    orgs.value = (p.orgs || []).join('\n');
    const orgCount = h('span', { class: 'hint' });
    const repos = h('textarea', { name: `repos-${index}`, rows: 3, spellcheck: 'false', 'aria-label': `${p.name}: repositories, one per line` });
    repos.value = (p.repos || []).join('\n');
    const paintCount = () => { orgCount.textContent = `${plural(lines(orgs.value).length, 'organisation')}. One GitHub login per line (a github.com link works too).`; };
    paintCount();
    orgs.addEventListener('input', () => { p.orgs = lines(orgs.value); paintCount(); paintSummary(); touched(); });
    repos.addEventListener('input', () => { p.repos = lines(repos.value); paintSummary(); touched(); });
    const reviewed = field({ label: 'I have checked this list against the current roster', name: `reviewed-${index}`, type: 'checkbox', value: !p.starter, hint: 'Removes the "unchecked org list" warning from the dashboard.' });
    const listBox = h('div', { class: 'stack', hidden: p.match !== 'orgs' },
      h('div', null, h('h4', null, 'Organisations'), orgs, orgCount,
        /^gsoc-\d{4}$/.test(p.orgSource || '') ? h('div', { class: 'hint' }, `Filled from the ${p.orgSource.replace('gsoc-', 'GSoC ')} organisation list; see `, h('a', { href: href('/owner/settings', { s: 'orgs' }) }, 'Organisation mapping'), ' for where each login came from.') : null),
      h('div', null, h('h4', null, 'Single repositories (owner/name), for programs that live inside a larger organisation'), repos),
      on(reviewed, () => { p.starter = !reviewed.get(); }));

    const sumEl = h('p', { class: 'fine' });
    const weightInputs = (cfg.featureKeys || []).map((k) => {
      const f = field({ label: FEATURE_LABELS[k] || k, name: `w-${k}-${index}`, type: 'number', value: Math.round((p.weights[k] ?? 0) * 1000) / 10, hint: (cfg.featureHelp || {})[k] || null, attrs: { min: 0, max: 100, step: 1, inputmode: 'decimal' } });
      f.input.addEventListener('input', () => { p.weights[k] = num(f.input) / 100; paintSum(); touched(); });
      return { k, f };
    });
    function paintSum() {
      const total = Object.values(p.weights).reduce((a, w) => a + (Number.isFinite(w) ? w : 0), 0) * 100;
      sumEl.textContent = `Total ${pts(total)}. Weights are relative: each part gives its share of the total as points out of 100${Math.abs(total - 100) > 0.05 ? ' (so they need not add up to 100, but it is easier to read when they do)' : ''}.`;
    }
    paintSum();
    const resetW = h('button', { type: 'button', class: 'btn btn-sm', name: `reset-weights-${index}` }, 'Use the default weights');
    resetW.addEventListener('click', () => {
      p.weights = { ...cfg.defaults.weights };
      weightInputs.forEach(({ k, f }) => { f.input.value = Math.round((p.weights[k] ?? 0) * 1000) / 10; });
      paintSum(); touched();
    });

    const notes = h('textarea', { class: 'is-text', name: `notes-${index}`, rows: 2, maxlength: 2000, 'aria-label': `${p.name}: your notes` });
    notes.value = p.notes || '';
    notes.addEventListener('input', () => { p.notes = notes.value; touched(); });
    const elig = h('textarea', { class: 'is-text', name: `elig-${index}`, rows: 2, maxlength: 2000, 'aria-label': `${p.name}: eligibility caveat` });
    elig.value = p.eligibilityNote || '';
    elig.addEventListener('input', () => { p.eligibilityNote = elig.value; touched(); });

    const remove = h('button', { type: 'button', class: 'btn btn-sm btn-danger', name: `remove-${index}` }, 'Remove this program');
    remove.addEventListener('click', async () => {
      if (draft.programs.length <= 1) { toast('At least one program must stay.', 'error'); return; }
      const ok = await confirmDialog(`Remove ${p.name || 'this program'}? Its scores disappear after you save. Uploaded outcomes for it stay stored.`, { confirmLabel: 'Remove', danger: true });
      if (!ok) return;
      draft.programs.splice(draft.programs.indexOf(p), 1);
      drawPrograms();
      touched();
    });

    return h('details', { class: 'set-prog', open: openKey !== null && openKey === p.key ? true : null },
      h('summary', null, title, tags, summaryMeta),
      h('div', { class: 'set-body' },
        h('div', { class: 'set-grid' },
          on(name, () => { p.name = name.get(); }),
          p._new ? on(key, () => { p.key = key.get().toLowerCase(); }) : key.row,
          on(from, () => { p.window.from = from.get(); }),
          on(to, () => { p.window.to = to.get(); }),
          on(pre, () => { p.preWindowWeight = num(pre.input); }),
          on(deadlines, () => { p.deadlines = parseDeadlines(deadlines.get()); })),
        h('div', { class: 'set-grid' },
          on(enabled, () => { p.enabled = enabled.get(); }),
          on(prestigious, () => { p.prestigious = prestigious.get(); }),
          on(low, () => { p.includeLowStar = low.get(); })),
        on(match, () => { p.match = match.get(); listBox.hidden = p.match !== 'orgs'; }),
        listBox,
        h('div', null,
          h('h4', null, 'Weights: how many points each part of the score can give'),
          h('div', { class: 'set-weights' }, weightInputs.map(({ f }) => f.row)),
          sumEl,
          h('div', { class: 'toolbar' }, resetW)),
        h('div', { class: 'set-grid' },
          h('div', { class: 'form-row' }, h('label', null, 'Eligibility caveat shown with this program'), elig),
          h('div', { class: 'form-row' }, h('label', null, 'Your notes on this program'), notes)),
        h('div', { class: 'toolbar' }, remove)));
  }
  drawPrograms();

  const add = h('button', { type: 'button', class: 'btn', name: 'add-program' }, 'Add a program');
  add.addEventListener('click', () => {
    if (draft.programs.length >= 20) { toast('At most 20 programs.', 'error'); return; }
    let n = 1;
    while (draft.programs.some((p) => p.key === `program-${n}`)) n++;
    const base = draft.programs[0];
    draft.programs.push({
      _new: true, key: `program-${n}`, name: 'New program', enabled: true, prestigious: true, match: 'orgs', orgs: [], repos: [], orgSource: 'manual', includeLowStar: true,
      window: { ...base.window }, preWindowWeight: base.preWindowWeight, weights: { ...cfg.defaults.weights }, notes: '', eligibilityNote: '', starter: true,
    });
    drawPrograms(`program-${n}`);
    touched();
    const last = list.lastElementChild;
    if (last) last.scrollIntoView({ block: 'nearest' });
  });

  save.addEventListener('click', async () => {
    problem.hidden = true;
    const body = clone(draft);
    body.programs.forEach((p) => { delete p._new; });
    const res = await act(() => oapi.put('/programs', body), {
      button: save,
      onError: (err) => {
        if (err.status !== 400) return false;
        problem.textContent = `Not saved. ${errorText(err)}`;
        problem.hidden = false;
        problem.scrollIntoView({ block: 'nearest' });
        return true;
      },
    });
    if (!res) { touched(); return; }
    shared.isDirty = null;
    toast('Saved. Every score is being recomputed with the new settings.');
    refresh();
  });
  discard.addEventListener('click', () => { shared.isDirty = null; refresh(); });

  el.append(
    h('div', null,
      h('div', { class: 'section-head' }, h('h2', null, 'Programs'), add),
      h('p', { class: 'fine' }, 'Open a program to change its organisations, the months of work that count, and how the score is weighted.'),
      list),
    problem,
    h('div', { class: 'set-actions' }, save, discard, stateText));

  const warn = (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', warn);
  return () => window.removeEventListener('beforeunload', warn);
}

/* ───────────── organisation list → GitHub logins ───────────── */

async function mappingTab(el, ctx, cfg) {
  const q = ctx.query;
  const sources = (cfg.programs || []).filter((p) => /^[a-z]+-\d{4}$/.test(p.orgSource || ''));
  const programKey = sources.some((p) => p.key === q.mp) ? q.mp : (sources[0] || {}).key || 'gsoc';
  let data;
  try {
    data = await oapi.get('/program-orgs', { program: programKey, year: q.my || '', mapped: q.mapped || '', q: q.mq || '' });
  } catch (err) {
    if (err.name === 'Locked' || err.status !== 404) throw err;
    data = { items: [], total: 0, mapped: 0, unmapped: 0, years: [], year: null, program: programKey };
  }
  const prog = (cfg.programs || []).find((p) => p.key === programKey);
  const BY = { alias: 'Checked by hand', link: 'GitHub link in its program entry', name: 'Same name as an organisation in our data', manual: 'Set here' };

  el.append(
    h('p', { class: 'fine' },
      `The published organisation list of ${prog ? prog.name : programKey}${data.year ? ` (${data.year} list)` : ''}, and the GitHub login each organisation was matched to. `,
      'Pull requests only count when the login is right, so fix a wrong or missing one here: the change also updates the program\'s organisation list and recomputes the scores. ',
      'A new year\'s list is loaded on the server with scripts/fetch_program_orgs.js.'),
    h('div', { class: 'cards' },
      h('div', { class: 'stat stat-key' }, h('div', { class: 'stat-label' }, 'Organisations in the list'), h('div', { class: 'stat-value' }, fmt.num(data.total))),
      h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, 'Matched to GitHub'), h('div', { class: 'stat-value' }, fmt.num(data.mapped))),
      h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, 'Not matched'), h('div', { class: 'stat-value' }, fmt.num(data.unmapped)), h('div', { class: 'stat-sub' }, 'mostly projects that do not take contributions on GitHub'))),
    filterBar({
      fields: [
        sources.length > 1 ? { name: 'mp', label: 'Program', type: 'select', options: sources.map((p) => ({ value: p.key, label: p.name })), allLabel: sources[0].name } : null,
        (data.years || []).length > 1 ? { name: 'my', label: 'List of year', type: 'select', options: data.years.map(String), allLabel: 'Newest' } : null,
        { name: 'mq', label: 'Search', type: 'search', placeholder: 'Organisation name or login' },
        { name: 'mapped', label: 'Matched', type: 'select', options: [{ value: '0', label: 'Not matched' }, { value: '1', label: 'Matched' }] },
      ].filter(Boolean),
      values: q,
      onChange: (v) => setQuery({ ...v }),
    }));

  const tbl = table({
    caption: 'Program organisations and their GitHub logins',
    columns: [
      { key: 'name', label: 'Organisation', wrap: true, render: (o) => [h('b', null, o.name), h('span', { class: 'sub' }, safeUrl(o.url) ? extLink(o.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''), o.url) : null)] },
      { key: 'logins', label: 'GitHub logins (comma separated)', class: 'col-map', render: (o) => {
        const input = h('input', { type: 'text', name: `map-${o.id}`, value: (o.logins || []).join(', '), placeholder: 'not matched', spellcheck: 'false', autocomplete: 'off', 'aria-label': `GitHub logins of ${o.name}` });
        const btn = h('button', { type: 'button', class: 'btn btn-sm', name: `map-save-${o.id}`, disabled: true }, 'Save');
        const before = (o.logins || []).join(', ');
        input.addEventListener('input', () => { btn.disabled = lines(input.value).join(', ') === before; });
        const go = async () => {
          if (btn.disabled) return;
          const logins = lines(input.value);
          const res = await act(() => oapi.put(`/program-orgs/${encodeURIComponent(o.id)}`, { logins }), { button: btn });
          if (!res) return;
          toast(logins.length ? `${o.name} now maps to ${logins.join(', ')}. Recomputing scores.` : `${o.name} is no longer matched. Recomputing scores.`);
          refresh();
        };
        btn.addEventListener('click', go);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
        return h('span', { class: 'map-input' }, input, btn);
      } },
      { key: 'gh', label: 'Open', render: (o) => ((o.logins || []).length ? o.logins.slice(0, 2).map((l, i) => [i ? ', ' : null, ghLink(l)]) : null) },
      { key: 'mappedBy', label: 'How it was matched', render: (o) => (o.mappedBy ? [BY[o.mappedBy] || o.mappedBy, o.confidence === 'medium' ? [' ', h('span', { class: 'tag tag-warn', title: 'Matched by name only: worth a look' }, 'check')] : null] : h('span', { class: 'muted' }, 'Not matched')) },
      { key: 'nstStudents', label: 'NST students', num: true },
      { key: 'nstPrs', label: 'NST PRs', num: true },
    ],
    rows: data.items,
    empty: data.total ? 'No organisation matches these filters.' : 'No organisation list has been loaded for this program yet.',
  });
  el.append(card({ flush: true, class: 'owner-map', title: `${fmt.num((data.items || []).length)} shown`, note: 'NST figures are all-time, any category' }, tbl));
  return undefined;
}

/* ───────────── past outcomes → calibration ───────────── */

async function outcomesTab(el, ctx, cfg) {
  const data = await oapi.get('/outcomes');
  const names = Object.fromEntries((cfg.programs || []).map((p) => [p.key, p.name]));
  const groups = new Map();
  for (const o of data.items || []) {
    const k = `${o.program}|${o.year}`;
    const g = groups.get(k) || { program: o.program, year: o.year, total: 0, selected: 0, unmatched: 0 };
    g.total++; if (o.selected) g.selected++; if (!o.matched) g.unmatched++;
    groups.set(k, g);
  }

  el.append(h('p', { class: 'fine' },
    'Upload who applied to a program in a past year and who was selected. The dashboard then shows, for each readiness band, how many past applicants of that band were selected. ',
    'Until outcomes exist, every number on this dashboard is labelled a readiness score and no selection rate is shown anywhere. Outcomes are stored privately and never appear on the public site.'));

  const cals = Object.entries(data.calibration || {}).filter(([, c]) => c && c.outcomes);
  if (cals.length) {
    el.append(card({ title: 'What past outcomes say about the bands' },
      cals.map(([key, c]) => h('div', { class: 'stack' },
        h('p', { class: 'fine' }, h('b', null, names[key] || key), `: ${plural(c.outcomes, 'applicant')} uploaded (${(c.years || []).join(', ')}), ${fmt.num(c.matched)} are tracked students, ${fmt.num(c.selected)} selected.`),
        calibrationBlock(c),
        c.note ? h('p', { class: 'fine' }, c.note) : null))));
  }

  /* stored */
  const stored = table({
    caption: 'Uploaded outcomes', sticky: false,
    columns: [
      { key: 'program', label: 'Program', render: (g) => names[g.program] || g.program },
      { key: 'year', label: 'Year', render: (g) => String(g.year) },
      { key: 'total', label: 'Applicants', num: true },
      { key: 'selected', label: 'Selected', num: true },
      { key: 'unmatched', label: 'Not tracked students', num: true, title: 'Usernames that are not in the student list: they cannot be scored, so they do not enter the calibration' },
      { key: 'past', label: '', render: (g) => h('a', { href: href('/owner/past', { program: g.program, year: String(g.year) }), title: 'How these applicants worked in the year before' }, 'Past results') },
      { key: 'act', label: '', render: (g) => {
        const b = h('button', { type: 'button', class: 'btn btn-sm btn-danger', name: `del-${g.program}-${g.year}` }, 'Delete');
        b.addEventListener('click', async () => {
          const ok = await confirmDialog(`Delete the ${g.total} outcomes of ${names[g.program] || g.program} ${g.year}? The selection figures for it disappear.`, { confirmLabel: 'Delete', danger: true });
          if (!ok) return;
          const res = await act(() => oapi.del('/outcomes', { program: g.program, year: g.year }), { button: b });
          if (res) { toast(`Deleted ${plural(res.deleted, 'outcome')}. Recomputing.`); refresh(); }
        });
        return b;
      } },
    ],
    rows: [...groups.values()],
    empty: 'No outcomes uploaded yet.',
  });
  el.append(card({ title: 'Stored outcomes', note: `${fmt.num(data.total)} rows`, flush: true }, stored));

  /* upload */
  const area = h('textarea', { name: 'outcomes-csv', spellcheck: 'false', placeholder: 'username,program,year,org,selected\noctocat,gsoc,2025,zulip,yes\nhubot,gsoc,2025,sugarlabs,no', 'aria-label': 'Outcomes as CSV' });
  const file = h('input', { type: 'file', name: 'outcomes-file', accept: '.csv,text/csv,text/plain', 'aria-label': 'Choose a CSV file' });
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { toast('The file is larger than 2 MB.', 'error'); return; }
    area.value = await f.text();
  });
  const replace = field({ label: 'Replace what is stored for the same program and year', name: 'replace', type: 'checkbox', value: false });
  const upload = h('button', { type: 'button', class: 'btn btn-primary', name: 'upload-outcomes' }, 'Upload outcomes');
  const result = h('div', { class: 'stack' });
  upload.addEventListener('click', async () => {
    const csv = area.value.trim();
    if (!csv) { toast('Paste the CSV or choose a file first.', 'error'); area.focus(); return; }
    const res = await act(() => oapi.post('/outcomes', { csv: `${csv}\n`, replace: replace.get() }), { button: upload });
    if (!res) return;
    const bad = (res.results || []).filter((r) => r.status !== 'saved');
    toast(`Saved ${plural(res.saved, 'outcome')}${res.invalid ? `, ${res.invalid} not valid` : ''}${res.unmatched ? `, ${res.unmatched} not tracked students` : ''}.`, res.saved ? 'ok' : 'error');
    if (!bad.length) { refresh(); return; }
    result.replaceChildren(
      h('div', { class: 'notice notice-warn', role: 'alert' }, `${plural(bad.length, 'row')} could not be saved. Fix them and upload again; rows already saved are simply updated.`,
        res.saved ? [' ', h('button', { type: 'button', class: 'btn btn-sm', onClick: () => refresh() }, 'Show what was saved')] : null),
      table({ compact: true, sticky: false, caption: 'Rows with problems', columns: [
        { key: 'row', label: 'Row', num: true }, { key: 'username', label: 'Username' }, { key: 'error', label: 'Problem', wrap: true }], rows: bad.slice(0, 100) }));
  });

  el.append(card({ title: 'Upload outcomes', class: 'upload-box' },
    h('div', { class: 'stack' },
      h('p', { class: 'fine' }, 'CSV with the header ', h('code', null, 'username,program,year,org,selected'), `. username is the GitHub login (a profile link works); program is one of ${Object.keys(names).join(', ')}; selected is yes or no. `,
        'Include the applicants who were not selected too: without them a rate cannot be read. NST\'s GSoC_Mentees.xlsx is converted with scripts/convert_gsoc_mentees.js.'),
      area,
      h('div', { class: 'toolbar' }, file),
      replace.row,
      h('div', { class: 'form-actions' }, upload),
      result)));
  return undefined;
}

export { BANDS, bandBadge };
