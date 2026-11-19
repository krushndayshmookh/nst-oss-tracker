// Admin → Students. GET /admin/students; add one, add many (CSV), edit, deactivate / reactivate, delete for good,
// fetch history again, and a live view of history fetches that are still pending or running.

import { api } from '../lib/api.js';
import { setQuery, refresh, href } from '../lib/router.js';
import {
  h, pageHead, filterBar, table, pagination, card, badge, stateBadge, ghLink, modal, confirmDialog, toast, fmt,
} from '../lib/ui.js';
import {
  CAMPUSES, YEARS, act, field, batchOptions, getMeta, headline, headlineDelta, jobLink, poll, plural, errorText, handleAuthError, fetchErrorText,
} from './common.js';

const BACKFILL_LABELS = { pending: 'Pending', running: 'Running', done: 'Done', error: 'Failed' };
const MISSING_LABELS = {
  batch: 'No batch', campus: 'No campus', name: 'No name', email: 'No email', enrolmentNo: 'No enrolment no.',
  nameUnofficial: 'Name not from the sheet', githubId: 'GitHub account not confirmed', unresolved: 'GitHub user not found',
};

const displayName = (s) => s.name || s.username;
const enc = encodeURIComponent;

/** Totals per history-fetch status, from three one-row list calls. */
async function backfillCounts() {
  const one = (status) => api.get('/admin/students', { backfill: status, limit: 1 }).then((r) => r.total);
  const [pending, running, error] = await Promise.all([one('pending'), one('running'), one('error')]);
  return { pending, running, error };
}

function listParams(q) {
  return {
    q: q.q, campus: q.campus, year: q.year, batch: q.batch, active: q.active, backfill: q.backfill, missing: q.missing,
    sort: q.sort, order: q.order, page: q.page,
  };
}

/* ───────────── dialogs ───────────── */

function openAdd() {
  const f = {
    username: field({
      label: 'GitHub username or profile URL', name: 'username', required: true, placeholder: 'octocat or https://github.com/octocat',
      hint: 'The username is checked against GitHub when this server can reach it.',
    }),
    name: field({ label: 'Name', name: 'name', hint: 'Leave empty to take the name from the GitHub profile, when it can be read.' }),
    campus: field({ label: 'Campus', name: 'campus', type: 'select', required: true, options: [{ value: '', label: 'Choose a campus' }, ...CAMPUSES] }),
    batch: field({ label: 'Batch (intake year)', name: 'batch', type: 'select', options: batchOptions() }),
    email: field({ label: 'Email', name: 'email', type: 'email' }),
    enrolmentNo: field({ label: 'Enrolment no.', name: 'enrolmentNo' }),
  };
  const form = h('form', { class: 'form', novalidate: true },
    f.username.row, f.name.row, h('div', { class: 'form-grid' }, f.campus.row, f.batch.row), h('div', { class: 'form-grid' }, f.email.row, f.enrolmentNo.row),
    h('p', { class: 'hint muted' }, 'Email and enrolment number are only ever shown here in the admin area.'));
  const body = h('div', null, form);
  let changed = false;
  let done = false; // after a successful add the primary button becomes "Add another"

  const m = modal({
    title: 'Add student',
    body,
    actions: [
      { label: 'Cancel' },
      { label: 'Add student', kind: 'primary', onClick: (close) => { if (done) { close(); openAdd(); } else form.requestSubmit(); } },
    ],
    onClose: () => { if (changed) refresh(); },
  });
  const buttons = () => m.el.querySelectorAll('.dialog-actions .btn');

  async function reactivate(username, btn) {
    const res = await act(() => api.patch(`/admin/students/${enc(username)}`, { active: true }), { button: btn });
    if (!res) return;
    changed = true;
    toast(`Reactivated ${displayName(res.student)}. Their pull requests count again.`);
    m.close();
  }

  async function onConflict(username) {
    // 409: the student is already in the list. Find out whether they were deactivated, and offer the way back.
    let existing = null;
    try {
      const found = await api.get('/admin/students', { q: username, limit: 100 });
      existing = found.items.find((s) => s.username.toLowerCase() === username.toLowerCase()) || null;
    } catch (err) { if (handleAuthError(err)) return; }
    if (existing && !existing.active) {
      const btn = h('button', { type: 'button', class: 'btn btn-sm', name: 'reactivate' }, 'Reactivate');
      btn.addEventListener('click', () => reactivate(existing.username, btn));
      f.username.setError(`Already tracked, but deactivated (${displayName(existing)}).`, btn);
    } else {
      f.username.setError('Already tracked.',
        h('a', { href: href('/students', { q: username }), onClick: () => m.close() }, 'Show them in the list'));
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    for (const x of Object.values(f)) x.setError(null);
    const username = f.username.get();
    if (!username) { f.username.setError('Enter a GitHub username or profile URL.'); f.username.input.focus(); return; }
    if (!f.campus.get()) { f.campus.setError('Choose a campus (use Unknown if you do not know it yet).'); f.campus.input.focus(); return; }
    const [cancel, submit] = buttons();
    submit.disabled = true;
    submit.textContent = 'Adding…';
    let res = null;
    try {
      res = await api.post('/admin/students', {
        username, name: f.name.get(), campus: f.campus.get(), batch: f.batch.get() ? Number(f.batch.get()) : null,
        email: f.email.get(), enrolmentNo: f.enrolmentNo.get(),
      });
    } catch (err) {
      if (handleAuthError(err)) return;
      const login = username.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '').replace(/^@/, '').split(/[/?#]/)[0];
      if (err.status === 409) await onConflict(login);
      else if (err.status === 400 && /campus/i.test(err.message)) f.campus.setError(errorText(err));
      else if (err.status === 400 && /batch/i.test(err.message)) f.batch.setError(errorText(err));
      else if (err.status === 400 && /email/i.test(err.message)) f.email.setError(errorText(err));
      else if (err.status === 400 && /does not exist/i.test(err.message)) f.username.setError(`GitHub has no user called “${login}”. Check the spelling.`);
      else if (err.status === 400) f.username.setError(errorText(err));
      else f.username.setError(`Not added. ${errorText(err)}`);
      f.username.input.focus();
    }
    if (!res) {
      if (submit.isConnected) { submit.disabled = false; submit.textContent = 'Add student'; }
      return;
    }

    // Added. Say plainly whether GitHub confirmed the account: without a token, or when GitHub cannot be reached,
    // the server stores the username as typed and leaves the check to the history fetch.
    changed = true;
    const s = res.student;
    const verified = s.githubId !== null && s.githubId !== undefined;
    body.replaceChildren(
      h('div', { class: 'notice notice-ok', role: 'status' },
        h('strong', null, `Added ${displayName(s)}`), ` (${s.username}, ${s.campus}${s.batch ? `, batch ${s.batch}` : ''}). `,
        'Their pull-request history is being fetched now. ', res.job ? jobLink(res.job.id, 'Follow the fetch in Jobs') : null),
      verified
        ? h('p', { class: 'muted' }, `GitHub confirmed the account${s.nameSource === 'github profile' ? ' and supplied the name' : ''}.`)
        : h('div', { class: 'notice notice-warn' },
          h('strong', null, 'The username was not checked against GitHub. '),
          'This server has no GitHub token, or GitHub did not answer, so the name was saved exactly as typed. ',
          'If the account does not exist, the history fetch will mark this student “GitHub user not found” in the Backfill column, ',
          'and you can correct or remove them then.'));
    cancel.textContent = 'Done';
    submit.textContent = 'Add another';
    submit.disabled = false;
    done = true;
    cancel.focus();
  });
  f.username.input.focus();
}

const BULK_COLUMNS = 'github_username, name, campus, batch, email, enrolment_no, notes';
const RESULT_BADGE = { added: ['Added', 'ok'], exists: ['Already tracked', 'neutral'], invalid: ['Not added', 'danger'] };

function openBulk() {
  const text = field({
    label: 'Students, one per line', name: 'csv', type: 'textarea', rows: 9,
    placeholder: 'campus,batch,name,github_username\nRU,2026,Asha Rao,asha-rao\nADYPU,2025,,https://github.com/octocat',
    hint: `Paste CSV with a header row. Columns: ${BULK_COLUMNS}. Only github_username is required (a profile URL works too). A plain list of usernames, one per line, is also accepted.`,
  });
  const file = h('input', { type: 'file', id: 'bulk-file', name: 'file', accept: '.csv,.txt,text/csv,text/plain' });
  file.addEventListener('change', async () => {
    const f0 = file.files && file.files[0];
    if (!f0) return;
    if (f0.size > 2 * 1024 * 1024) { text.setError('That file is larger than 2 MB. Split it into smaller files.'); return; }
    text.input.value = await f0.text();
    text.setError(null);
  });
  const out = h('div', { 'aria-live': 'polite' });
  const body = h('div', { class: 'stack' },
    h('div', { class: 'form-row' }, h('label', { for: 'bulk-file' }, 'Upload a CSV file'), file),
    text.row,
    h('p', { class: 'muted' }, 'Usernames are not checked against GitHub one by one here. The history fetch marks any that do not exist as “GitHub user not found”.'),
    out);
  let changed = false;
  const m = modal({
    title: 'Add many students',
    wide: true,
    body,
    actions: [
      { label: 'Close' },
      { label: 'Add students', kind: 'primary', onClick: () => submit() },
    ],
    onClose: () => { if (changed) refresh(); },
  });

  /** A paste without a header row and without commas is a list of usernames. */
  function payload(raw) {
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const header = (lines[0] || '').toLowerCase();
    if (/(^|,)\s*"?(github_username|username|github_profile)"?\s*(,|$)/.test(header)) return { csv: raw };
    if (lines.every((l) => !l.includes(','))) return { rows: lines.map((l) => ({ github_username: l })) };
    return null;
  }

  async function submit() {
    const raw = text.input.value;
    text.setError(null);
    if (!raw.trim()) { text.setError('Paste some rows or choose a file first.'); text.input.focus(); return; }
    const body0 = payload(raw);
    if (!body0) { text.setError('The first row must be a header that names the columns, including github_username.'); text.input.focus(); return; }
    const btn = m.el.querySelectorAll('.dialog-actions .btn')[1];
    btn.textContent = 'Adding…';
    const res = await act(() => api.post('/admin/students/bulk', body0), {
      button: btn,
      onError: (err) => { if (err.status === 400 || err.status === 413) { text.setError(errorText(err)); return true; } return false; },
    });
    if (btn.isConnected) btn.textContent = 'Add students';
    if (!res) return;
    if (res.added) changed = true;
    out.replaceChildren(
      h('div', { class: ['notice', res.added ? 'notice-ok' : 'notice-warn'], role: 'status' },
        h('strong', null, `${fmt.num(res.added)} added, ${fmt.num(res.exists)} already tracked, ${fmt.num(res.invalid)} invalid.`), ' ',
        res.job ? ['Their pull-request history is being fetched. ', jobLink(res.job.id, 'Follow the fetch in Jobs')] : 'Nothing new to fetch.'),
      table({
        caption: 'Result per row', compact: true, sticky: false,
        rows: res.results,
        columns: [
          { key: 'row', label: 'Row', num: true },
          { key: 'username', label: 'Username' },
          { key: 'status', label: 'Result', render: (r) => { const [label, kind] = RESULT_BADGE[r.status] || [r.status, 'neutral']; return badge(label, kind); } },
          { key: 'error', label: 'Problem', wrap: true },
        ],
      }));
    if (res.added && !res.invalid) text.input.value = '';
    out.scrollIntoView({ block: 'nearest' });
  }
  text.input.focus();
}

function openEdit(s) {
  const f = {
    name: field({ label: 'Name', name: 'name', value: s.name }),
    campus: field({ label: 'Campus', name: 'campus', type: 'select', value: s.campus, options: CAMPUSES }),
    batch: field({ label: 'Batch (intake year)', name: 'batch', type: 'select', value: s.batch ?? '', options: batchOptions(s.batch) }),
    email: field({ label: 'Email', name: 'email', type: 'email', value: s.email }),
    enrolmentNo: field({ label: 'Enrolment no.', name: 'enrolmentNo', value: s.enrolmentNo }),
    notes: field({ label: 'Notes (admin only)', name: 'notes', type: 'textarea', rows: 3, value: s.notes, attrs: { maxlength: 2000 } }),
    active: field({
      label: 'Active', name: 'active', type: 'checkbox', value: s.active,
      hint: 'Pull requests of an inactive student are kept but do not count or show on the public site.',
    }),
  };
  const facts = h('dl', { class: 'facts' },
    h('dt', null, 'GitHub'), h('dd', null, ghLink(s.username), s.githubId ? ` (id ${s.githubId})` : ' (account not confirmed yet)'),
    h('dt', null, 'Added'), h('dd', null, `${fmt.date(s.addedAt)}, ${s.addedBy === 'import' ? 'from the imported sheet' : 'by an admin'}`),
    s.sources && s.sources.length ? [h('dt', null, 'Sources'), h('dd', null, s.sources.join('; '))] : null,
    h('dt', null, 'History fetch'), h('dd', null, backfillText(s)),
    h('dt', null, 'Last synced'), h('dd', null, s.lastSyncedAt ? fmt.datetime(s.lastSyncedAt) : 'Never'),
    h('dt', null, 'Pull requests'), h('dd', null, `${fmt.num(s.stats.totalPrs)} in total, ${fmt.num(s.stats.osMerged)} merged open source`));

  const purgeBtn = h('button', { type: 'button', class: 'btn btn-sm btn-danger', name: 'purge' }, 'Delete permanently…');
  const form = h('form', { class: 'form', novalidate: true },
    f.name.row, h('div', { class: 'form-grid' }, f.campus.row, f.batch.row), h('div', { class: 'form-grid' }, f.email.row, f.enrolmentNo.row),
    f.notes.row, f.active.row);
  const body = h('div', { class: 'stack' }, facts, form,
    h('div', { class: 'notice' }, h('strong', null, 'Remove for good. '),
      `Deletes ${displayName(s)} and their ${plural(s.stats.totalPrs, 'stored pull request')}. To stop counting someone but keep the record, untick Active instead. `,
      purgeBtn));

  const m = modal({
    title: `Edit ${displayName(s)}`,
    body,
    actions: [{ label: 'Cancel' }, { label: 'Save changes', kind: 'primary', onClick: () => form.requestSubmit() }],
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    for (const x of Object.values(f)) x.setError(null);
    const next = {
      name: f.name.get(), campus: f.campus.get(), batch: f.batch.get() ? Number(f.batch.get()) : null,
      email: f.email.get(), enrolmentNo: f.enrolmentNo.get(), notes: f.notes.get(), active: f.active.get(),
    };
    const patch = {};
    for (const [k, v] of Object.entries(next)) if (v !== (s[k] ?? (k === 'batch' ? null : ''))) patch[k] = v;
    if (!Object.keys(patch).length) { m.close(); return; }
    const affectsPublic = 'active' in patch || 'campus' in patch || 'batch' in patch;
    const before = 'active' in patch ? await headline() : null;
    const btn = m.el.querySelectorAll('.dialog-actions .btn')[1];
    const res = await act(() => api.patch(`/admin/students/${enc(s.username)}`, patch), {
      button: btn,
      onError: (err) => {
        if (err.status !== 400) return false;
        const hit = ['campus', 'batch', 'email', 'enrolmentNo', 'notes', 'name'].find((k) => new RegExp(k, 'i').test(err.message));
        (f[hit] || f.name).setError(errorText(err));
        return true;
      },
    });
    if (!res) return;
    const after = before ? await headline() : null;
    m.close();
    const what = 'active' in patch
      ? (patch.active ? `Reactivated ${displayName(res.student)}. Their pull requests count again.` : `Deactivated ${displayName(res.student)}. Their pull requests no longer count.`)
      : `Saved ${displayName(res.student)}.${affectsPublic ? ' The public campus and year tables are updated.' : ''}`;
    toast(what + headlineDelta(before, after));
    refresh();
  });

  purgeBtn.addEventListener('click', async () => {
    const typed = await confirmDialog(
      `This permanently deletes ${displayName(s)} (${s.username}) and their ${plural(s.stats.totalPrs, 'stored pull request')}. It cannot be undone; adding them again later means fetching everything from GitHub again.`,
      { title: 'Delete permanently', confirmLabel: 'Delete permanently', danger: true, input: { label: `Type ${s.username} to confirm`, required: true } });
    if (typed === false) return;
    if (String(typed).toLowerCase() !== s.username.toLowerCase()) { toast('The username did not match. Nothing was deleted.', 'error'); return; }
    const before = await headline();
    const res = await act(() => api.del(`/admin/students/${enc(s.username)}`, { purge: 1 }), { button: purgeBtn });
    if (!res) return;
    const after = await headline();
    m.close();
    toast(`Deleted ${displayName(s)} and ${plural(res.prsRemoved, 'pull request')}.${headlineDelta(before, after)}`);
    refresh();
  });
}

/* ───────────── row actions ───────────── */

function backfillText(s) {
  const b = s.backfill || {};
  if (b.status === 'error') return b.error === 'not_found' ? 'GitHub user not found' : `Failed: ${fetchErrorText(b.error)}`;
  return `${BACKFILL_LABELS[b.status] || b.status}${b.at ? `, ${fmt.rel(b.at)}` : ''}`;
}

async function deactivate(s, btn) {
  const ok = await confirmDialog(
    `Deactivate ${displayName(s)}? Their ${plural(s.stats.totalPrs, 'pull request')} (${fmt.num(s.stats.osMerged)} merged open source) stop counting on the public site. You can reactivate them later.`,
    { title: 'Deactivate student', confirmLabel: 'Deactivate', danger: true });
  if (!ok) return;
  const before = await headline();
  const res = await act(() => api.del(`/admin/students/${enc(s.username)}`), { button: btn });
  if (!res) return;
  toast(`Deactivated ${displayName(s)}. Their pull requests no longer count.${headlineDelta(before, await headline())}`);
  refresh();
}

async function reactivate(s, btn) {
  const before = await headline();
  const res = await act(() => api.patch(`/admin/students/${enc(s.username)}`, { active: true }), { button: btn });
  if (!res) return;
  toast(`Reactivated ${displayName(s)}. Their pull requests count again.${headlineDelta(before, await headline())}`);
  refresh();
}

async function fetchHistory(s, btn) {
  const ok = await confirmDialog(
    `Fetch the whole pull-request history of ${displayName(s)} (${s.username}) from GitHub again? Use this after fixing a username, or when a fetch failed. Decisions you made on their pull requests are kept.`,
    { title: 'Fetch history', confirmLabel: 'Fetch history' });
  if (!ok) return;
  const res = await act(() => api.post(`/admin/students/${enc(s.username)}/backfill`), { button: btn });
  if (!res) return;
  toast(`Queued a history fetch for ${displayName(s)}. This page updates when it finishes; the log is under Jobs.`);
  refresh();
}

/* ───────────── page ───────────── */

function statusNotice(counts, q) {
  const parts = [];
  const item = (n, status, text) => h('a', { href: href('/students', { backfill: status }) }, `${fmt.num(n)} ${text}`);
  if (counts.running) parts.push(item(counts.running, 'running', 'running'));
  if (counts.pending) parts.push(item(counts.pending, 'pending', 'waiting'));
  if (counts.error) parts.push(item(counts.error, 'error', 'failed'));
  if (!parts.length) return null;
  const live = counts.running + counts.pending > 0;
  return h('div', { class: ['notice', !live && counts.error ? 'notice-warn' : null], role: 'status' },
    h('strong', null, live ? 'Fetching pull-request history: ' : 'History fetches that need attention: '),
    parts.map((p, i) => [i ? ', ' : null, p]), '. ',
    live ? 'This list refreshes on its own. ' : 'Open Edit for the reason, fix the username if needed, then use Fetch history. ',
    h('a', { href: '#/jobs' }, 'Open Jobs'),
    q.backfill ? [' · ', h('a', { href: href('/students', { ...q, backfill: '', page: '' }) }, 'Show all students')] : null);
}

function missingBar(data, q) {
  const counts = data.missingCounts;
  if (!counts || typeof counts !== 'object') return null; // the server does not report missing data
  const active = new Set(String(q.missing || '').split(',').filter(Boolean));
  const toggle = (key) => {
    const next = new Set(active);
    if (next.has(key)) next.delete(key); else next.add(key);
    setQuery({ missing: [...next].join(','), page: '' });
  };
  return h('div', { class: 'toolbar', role: 'group', 'aria-label': 'Missing data' },
    h('span', { class: 'muted' }, 'Missing data:'),
    h('div', { class: 'btn-group' }, Object.keys(MISSING_LABELS).filter((k) => k in counts).map((k) =>
      h('button', {
        type: 'button', name: `missing-${k}`, class: ['btn btn-sm', active.has(k) && 'is-on'], 'aria-pressed': active.has(k) ? 'true' : 'false',
        onClick: () => toggle(k),
      }, `${MISSING_LABELS[k]} · ${fmt.num(counts[k])}`))));
}

function studentsTable(data, q) {
  const sort = q.sort || 'addedAt';
  const order = q.order || (sort === 'name' || sort === 'username' ? 'asc' : 'desc');
  return table({
    caption: 'Tracked students',
    compact: true,
    rows: data.items,
    sort,
    order,
    onSort: (s, o) => setQuery({ sort: s, order: o, page: '' }),
    rowClass: (s) => (s.active ? null : 'muted'),
    empty: data.total === 0 && !Object.keys(q).some((k) => !['sort', 'order', 'page'].includes(k) && q[k])
      ? 'No students yet. Use Add student or Add many.'
      : 'No students match these filters.',
    columns: [
      {
        key: 'name', label: 'Student', sortable: true,
        render: (s) => h('div', null,
          h('span', null, displayName(s)), s.active ? null : [' ', badge('Inactive')],
          h('div', { class: 'sub' }, ghLink(s.username)),
          Array.isArray(s.missing) && s.missing.length
            ? h('div', { class: 'sub' }, s.missing.map((k) => [badge(MISSING_LABELS[k] || k, 'warn'), ' '])) : null),
      },
      {
        key: 'campus', label: 'Campus · batch',
        render: (s) => h('div', null, s.campus, h('div', { class: 'sub' }, s.batch ? `${s.batch} · ${s.year}` : 'No batch')),
      },
      {
        key: 'email', label: 'Email · enrolment no.',
        render: (s) => (s.email || s.enrolmentNo
          ? h('div', null, s.email ? h('span', { class: 'cell-clip', title: s.email }, s.email) : h('span', { class: 'muted' }, 'No email'), h('div', { class: 'sub' }, s.enrolmentNo || 'No enrolment no.'))
          : null),
      },
      {
        key: 'backfill', label: 'Backfill · last sync', title: 'The fetch of this student’s full pull-request history',
        render: (s) => {
          const b = s.backfill || {};
          const synced = h('div', { class: 'sub', title: s.lastSyncedAt ? `Last synced ${fmt.datetime(s.lastSyncedAt)}` : null },
            s.lastSyncedAt ? `Synced ${fmt.rel(s.lastSyncedAt)}` : 'Never synced');
          if (b.status !== 'error') return h('div', null, stateBadge(b.status), synced);
          const notFound = b.error === 'not_found';
          return h('div', { title: `${fetchErrorText(b.error)}${notFound ? '' : `\n${b.error || ''}`}` },
            stateBadge('error', notFound ? 'GitHub user not found' : 'Failed'),
            notFound ? synced : h('div', { class: 'sub cell-clip' }, fetchErrorText(b.error)));
        },
      },
      { key: 'osMerged', label: 'OS merged', num: true, sortable: true, title: 'Merged open-source pull requests, all time', render: (s) => fmt.num(s.stats.osMerged) },
      {
        key: 'actions', label: 'Actions',
        render: (s) => {
          const edit = h('button', { type: 'button', class: 'btn btn-sm', name: `edit-${s.username}`, onClick: () => openEdit(s) }, 'Edit');
          const fetchBtn = h('button', {
            type: 'button', class: 'btn btn-sm', name: `backfill-${s.username}`,
            disabled: ['pending', 'running'].includes(s.backfill && s.backfill.status),
            title: ['pending', 'running'].includes(s.backfill && s.backfill.status) ? 'A fetch is already queued or running' : 'Fetch the full pull-request history from GitHub again',
          }, 'Fetch history');
          fetchBtn.addEventListener('click', () => fetchHistory(s, fetchBtn));
          const toggle = s.active
            ? h('button', { type: 'button', class: 'btn btn-sm btn-danger', name: `deactivate-${s.username}` }, 'Deactivate')
            : h('button', { type: 'button', class: 'btn btn-sm', name: `reactivate-${s.username}` }, 'Reactivate');
          toggle.addEventListener('click', () => (s.active ? deactivate(s, toggle) : reactivate(s, toggle)));
          return h('div', { class: 'btn-group', style: { flexWrap: 'nowrap' } }, edit, fetchBtn, toggle);
        },
      },
    ],
  });
}

export default async function (el, ctx) {
  const q = ctx.query;
  const [meta, data, counts] = await Promise.all([getMeta(), api.get('/admin/students', listParams(q)), backfillCounts()]);

  const status = h('div');
  const list = card({ flush: true });
  const render = (d, c) => {
    const n = statusNotice(c, q);
    status.replaceChildren(...(n ? [n] : []));
    status.hidden = !n;
    list.replaceChildren(studentsTable(d, q), pagination({ ...d, onPage: (page) => setQuery({ page: page > 1 ? page : '' }) }));
  };
  render(data, counts);

  el.append(
    pageHead({
      title: 'Students',
      lede: `${fmt.num(data.total)} ${Object.keys(listParams(q)).some((k) => !['sort', 'order', 'page'].includes(k) && q[k]) ? 'match these filters' : 'tracked'}. Add students, correct their details, and control whose pull requests count.`,
      actions: [
        h('button', { type: 'button', class: 'btn', name: 'add-many', onClick: openBulk }, 'Add many'),
        h('button', { type: 'button', class: 'btn btn-primary', name: 'add-student', onClick: openAdd }, 'Add student'),
      ],
    }),
    status,
    filterBar({
      fields: [
        { name: 'q', label: 'Search', type: 'search', placeholder: 'Name, username, email or enrolment no.' },
        { name: 'campus', label: 'Campus', type: 'select', options: CAMPUSES },
        { name: 'year', label: 'Year', type: 'select', options: YEARS },
        { name: 'batch', label: 'Batch', type: 'select', options: (meta.batches || []).map(String) },
        { name: 'active', label: 'Status', type: 'select', options: [{ value: '1', label: 'Active' }, { value: '0', label: 'Inactive' }] },
        { name: 'backfill', label: 'Backfill', type: 'select', options: Object.entries(BACKFILL_LABELS).map(([value, label]) => ({ value, label })) },
        {
          name: 'sort', label: 'Sort by', type: 'select', allLabel: 'Newest added',
          options: [{ value: 'name', label: 'Name' }, { value: 'username', label: 'Username' }, { value: 'osMerged', label: 'Merged open-source PRs' }],
        },
      ],
      values: q,
      onChange: (v) => setQuery({ ...v, order: v.sort === (q.sort || '') ? q.order : '', page: '' }),
    }),
    ...[missingBar(data, q)].filter(Boolean),
    list);

  // While any history fetch is queued or running, re-read the list in place (no dimming, filters untouched).
  let live = counts.pending + counts.running > 0;
  if (!live) return undefined;
  const stop = poll(async () => {
    const [d, c] = await Promise.all([api.get('/admin/students', listParams(q)), backfillCounts()]);
    if (document.querySelector('dialog.dialog[open]') && list.contains(document.activeElement)) return;
    render(d, c);
    live = c.pending + c.running > 0;
    if (!live) stop();
  }, 5000);
  return stop;
}
