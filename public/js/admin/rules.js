// Admin → Rules. GET /admin/rules, PUT /admin/rules (full document; the server then reclassifies everything).
// The form edits a local draft; nothing is sent until "Save rules" is confirmed.

import { api } from '../lib/api.js';
import { refresh } from '../lib/router.js';
import { h, pageHead, card, confirmDialog, toast, stateBadge, fmt } from '../lib/ui.js';
import { act, field, getMeta, jobLink, poll, errorText, handleAuthError } from './common.js';
import { academicYearCard } from './schedule.js';

const NUMBERS = [
  { path: ['tiers', 'major'], name: 'tiers.major', label: 'Major tier, stars', hint: 'An open-source repository with at least this many stars is “Major”.' },
  { path: ['tiers', 'established'], name: 'tiers.established', label: 'Established tier, stars', hint: 'At least this many stars is “Established”; below it, “Emerging”.' },
  { path: ['minStarsUserRepo'], name: 'minStarsUserRepo', label: 'Minimum stars, personal repos', hint: 'A repository owned by a person needs this many stars to count.' },
  { path: ['minStarsOrgRepo'], name: 'minStarsOrgRepo', label: 'Minimum stars, organisation repos', hint: 'A repository owned by an organisation needs this many stars to count.' },
];

const LISTS = [
  { key: 'nstOrgs', label: 'NST organisations', hint: 'GitHub owners that belong to NST. Their repositories show as “NST internal”.', placeholder: 'owner login, e.g. nst-sdc' },
  { key: 'nstOwnerKeywords', label: 'NST owner keywords', hint: 'An owner whose login contains one of these is NST internal. Keywords of four letters or fewer must match a whole word of the login.', placeholder: 'keyword, e.g. newton' },
  { key: 'practiceRepos', label: 'Practice repositories', hint: 'Exact repositories that are practice grounds, as owner/name.', placeholder: 'owner/name', repo: true },
  { key: 'practiceKeywords', label: 'Practice keywords', hint: 'A repository whose name or owner contains one of these is a practice repository.', placeholder: 'keyword, e.g. hacktoberfest' },
  { key: 'allowOrgs', label: 'Always-counted organisations', hint: 'Repositories of these owners count as open source whatever their stars.', placeholder: 'owner login' },
];

const clone = (r) => JSON.parse(JSON.stringify(r));
const strip = ({ updatedAt, ...rest }) => rest; // eslint-disable-line no-unused-vars
const same = (a, b) => JSON.stringify(strip(a)) === JSON.stringify(strip(b));

/** Mirrors the server's validation so problems show next to the field before anything is sent. */
function validate(draft, numberFields) {
  let ok = true;
  const values = {};
  for (const n of NUMBERS) {
    const f = numberFields[n.name];
    const raw = f.input.value.trim();
    f.setError(null);
    if (raw === '' || !/^\d+$/.test(raw)) { f.setError('Enter a whole number, 0 or more.'); ok = false; continue; }
    values[n.name] = Number(raw);
  }
  if (ok && !(values['tiers.major'] > values['tiers.established'])) {
    numberFields['tiers.major'].setError('Must be greater than the Established tier.');
    ok = false;
  }
  return ok;
}

function listEditor(spec, draft, onChange) {
  const chips = h('ul', { class: 'chips', 'aria-label': spec.label });
  const add = field({ label: `Add to ${spec.label.toLowerCase()}`, name: `add-${spec.key}`, placeholder: spec.placeholder, attrs: { maxlength: 200 } });
  add.row.querySelector('label').classList.add('sr-only');
  const addBtn = h('button', { type: 'button', class: 'btn', name: `add-btn-${spec.key}` }, 'Add');

  const draw = () => {
    chips.replaceChildren(...draft[spec.key].map((value, i) => h('li', { class: 'chip' }, value,
      h('button', {
        type: 'button', 'aria-label': `Remove ${value}`, title: `Remove ${value}`,
        onClick: () => { draft[spec.key].splice(i, 1); draw(); onChange(); },
      }, '×'))));
    if (!draft[spec.key].length) chips.append(h('li', { class: 'muted' }, 'None'));
  };
  const commit = () => {
    add.setError(null);
    // accept several at once, separated by commas, spaces or new lines
    const items = add.input.value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!items.length) { add.input.focus(); return; }
    const have = new Set(draft[spec.key].map((s) => s.toLowerCase()));
    const dupes = [];
    for (const raw of items) {
      const item = spec.repo ? raw.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '').replace(/\/+$/, '') : raw.replace(/^@/, '');
      if (spec.repo && !/^[^/\s]+\/[^/\s]+$/.test(item)) { add.setError(`“${raw}” is not in the form owner/name.`); add.input.focus(); return; }
      if (have.has(item.toLowerCase())) { dupes.push(item); continue; }
      have.add(item.toLowerCase());
      draft[spec.key].push(item);
    }
    add.input.value = '';
    if (dupes.length) add.setError(`Already in the list: ${dupes.join(', ')}.`);
    draw();
    onChange();
    add.input.focus();
  };
  addBtn.addEventListener('click', commit);
  add.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
  draw();
  return {
    draw,
    node: card({ title: spec.label, note: spec.hint, class: 'stack' }, chips,
      h('div', { class: 'toolbar' }, h('div', { style: { flex: '1 1 220px' } }, add.row), addBtn)),
  };
}

export default async function (el) {
  const [{ rules: saved }, meta, ayCard] = await Promise.all([api.get('/admin/rules'), getMeta(), academicYearCard().catch(() => null)]);
  const draft = clone(strip(saved));
  const prCount = meta && meta.counts ? meta.counts.prs : null;

  const numberFields = {};
  for (const n of NUMBERS) {
    const value = n.path.reduce((o, k) => o[k], draft);
    numberFields[n.name] = field({ label: n.label, name: n.name, type: 'number', value: String(value), hint: n.hint, attrs: { min: 0, step: 1, inputmode: 'numeric' } });
  }
  const readNumbers = () => {
    for (const n of NUMBERS) {
      const raw = numberFields[n.name].input.value.trim();
      const v = /^\d+$/.test(raw) ? Number(raw) : raw;
      if (n.path.length === 2) draft[n.path[0]][n.path[1]] = v; else draft[n.path[0]] = v;
    }
  };

  const problems = h('div', { class: 'notice notice-warn', role: 'alert', hidden: true });
  const jobStatus = h('div', { 'aria-live': 'polite' });
  const save = h('button', { type: 'submit', class: 'btn btn-primary', name: 'save-rules', disabled: true }, 'Save rules');
  const discard = h('button', { type: 'button', class: 'btn', name: 'discard-rules', disabled: true }, 'Discard changes');
  const dirtyNote = h('span', { class: 'muted' }, 'No unsaved changes.');
  let stopPoll = null;

  const onChange = () => {
    readNumbers();
    const dirty = !same(draft, saved);
    save.disabled = !dirty;
    discard.disabled = !dirty;
    dirtyNote.textContent = dirty ? 'You have unsaved changes.' : 'No unsaved changes.';
    problems.hidden = true;
  };
  for (const f of Object.values(numberFields)) f.input.addEventListener('input', () => { f.setError(null); onChange(); });
  const editors = LISTS.map((spec) => listEditor(spec, draft, onChange));

  const form = h('form', { class: 'stack', novalidate: true },
    card({ title: 'Star thresholds', note: 'Stars are read from GitHub each time a repository is fetched.' },
      h('div', { class: 'form-grid' }, NUMBERS.map((n) => numberFields[n.name].row))),
    h('div', { class: 'grid grid-2' }, editors.map((e) => e.node)),
    problems,
    h('div', { class: 'form-actions' }, save, discard, dirtyNote),
    jobStatus);

  function followJob(id) {
    if (stopPoll) stopPoll();
    const show = (job) => {
      const s = job.summary || {};
      jobStatus.replaceChildren(h('div', { class: ['notice', job.status === 'done' ? 'notice-ok' : job.status === 'error' ? 'notice-warn' : null] },
        stateBadge(job.status), ' ',
        job.status === 'done' ? `Reclassified: ${fmt.num(s.prsChanged ?? 0)} of ${fmt.num(s.prs ?? 0)} pull requests and ${fmt.num(s.reposChanged ?? 0)} of ${fmt.num(s.repos ?? 0)} repositories changed category. The public site shows the new numbers. `
          : job.status === 'error' ? `Reclassifying failed: ${job.error || 'unknown error'}. The rules are saved; run Reclassify from Jobs to try again. `
            : 'Reclassifying every pull request with the new rules. The public numbers change when this finishes. ',
        jobLink(id, 'Open the job')));
      return job.status === 'done' || job.status === 'error' || job.status === 'cancelled';
    };
    const tick = async () => {
      const { job } = await api.get(`/admin/jobs/${encodeURIComponent(id)}`);
      if (show(job) && stopPoll) { stopPoll(); stopPoll = null; }
    };
    show({ status: 'queued' });
    stopPoll = poll(tick, 2000);
    tick().catch((err) => { if (!handleAuthError(err)) console.error(err); });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    readNumbers();
    if (!validate(draft, numberFields)) {
      problems.textContent = 'Fix the highlighted fields, then save again.';
      problems.hidden = false;
      form.querySelector('[aria-invalid="true"]')?.focus();
      return;
    }
    const ok = await confirmDialog(
      `Save rules and reclassify every pull request? ${prCount ? `All ${fmt.num(prCount)} stored pull requests are` : 'Every stored pull request is'} sorted into categories again with the new rules, so the public numbers can change. This takes about a minute. Decisions under Overrides are kept.`,
      { title: 'Save rules', confirmLabel: 'Save and reclassify' });
    if (!ok) return;
    const res = await act(() => api.put('/admin/rules', strip(draft)), {
      button: save,
      onError: (err) => {
        if (err.status !== 400) return false;
        problems.textContent = `The server did not accept these rules: ${errorText(err)}`;
        problems.hidden = false;
        return true;
      },
    });
    if (!res) { onChange(); return; }
    Object.assign(saved, clone(res.rules));
    for (const k of Object.keys(draft)) draft[k] = clone(strip(res.rules))[k];
    for (const n of NUMBERS) numberFields[n.name].input.value = String(n.path.reduce((o, k) => o[k], draft));
    editors.forEach((ed) => ed.draw());
    onChange();
    updated.textContent = `Last saved ${fmt.datetime(res.rules.updatedAt)}.`;
    toast('Saved the rules. Reclassifying every pull request now.');
    if (res.job) followJob(res.job.id);
  });

  discard.addEventListener('click', async () => {
    const ok = await confirmDialog('Discard your unsaved changes to the rules?', { title: 'Discard changes', confirmLabel: 'Discard', danger: true });
    if (ok) refresh();
  });

  const updated = h('span', null, saved.updatedAt ? `Last saved ${fmt.datetime(saved.updatedAt)}.` : '');
  el.append(
    pageHead({
      title: 'Rules',
      lede: ['How pull requests are sorted into categories when no admin decision applies. ', updated],
    }),
    h('div', { class: 'notice notice-warn' },
      h('strong', null, 'Saving reclassifies everything. '),
      `These rules apply to ${prCount ? `all ${fmt.num(prCount)} stored pull requests` : 'every stored pull request'}, past and future. `,
      'Saving re-sorts all of them, which can move the public headline numbers. To change how one repository or organisation counts, make a decision in ',
      h('a', { href: '#/review' }, 'Review'), ' instead.'),
    form,
    ...(ayCard ? [ayCard] : []));

  const warn = (e) => { if (!same(draft, saved)) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', warn);
  return () => { window.removeEventListener('beforeunload', warn); if (stopPoll) stopPoll(); };
}
