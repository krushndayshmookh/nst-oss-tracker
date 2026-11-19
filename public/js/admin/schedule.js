// Admin → Jobs → "Scheduled fetch" (SPEC addendum C) and Admin → Rules → "Academic year" (addendum A1).
// GET/PUT /admin/schedule, POST /admin/schedule/pause|resume, POST /admin/jobs/sync, POST /admin/jobs/:id/cancel,
// GET/PUT /admin/academic-year.

import { api } from '../lib/api.js';
import { h, card, table, stateBadge, modal, confirmDialog, toast, fmt } from '../lib/ui.js';
import { CAMPUSES, act, field, errorText, fetchErrorText, getMeta } from './common.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TRIGGERS = { schedule: 'Nightly', catchup: 'Nightly (caught up)', recovery: 'Nightly (restarted)', manual: 'Started by an admin' };
const tzLabel = (tz) => (tz === 'Asia/Kolkata' ? 'IST' : tz || 'server time');

function when(iso, tz) {
  if (!iso) return null;
  try {
    return `${new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))} ${tzLabel(tz)}`;
  } catch {
    return fmt.datetime(iso);
  }
}

function runResult(job) {
  if (job.status === 'error' && /^interrupted/.test(job.error || '')) return 'Stopped because the server restarted. What was fetched is kept; the next fetch carries on';
  if (job.status === 'error') return `Failed: ${fetchErrorText(job.error)}`;
  const s = job.summary;
  if (!s) return job.status === 'cancelled' ? 'Cancelled before it started' : null;
  const bits = [`${fmt.num(s.studentsChecked ?? s.ok ?? 0)} students checked`];
  if (s.studentsFailed) bits.push(`${fmt.num(s.studentsFailed)} failed`);
  bits.push(`${fmt.num(s.prsNew ?? 0)} new PRs`, `${fmt.num(s.prsUpdated ?? 0)} updated`, `${fmt.num(s.newMerged ?? 0)} newly merged`);
  if (s.renamed) bits.push(`${fmt.num(s.renamed)} renamed`);
  if (s.notFound) bits.push(`${fmt.num(s.notFound)} not found on GitHub`);
  if (typeof s.rateLimitRemaining === 'number') bits.push(`${fmt.num(s.rateLimitRemaining)} GitHub requests left`);
  return bits.join(', ');
}

function runDuration(job) {
  const ms = job.summary && job.summary.durationMs ? job.summary.durationMs
    : job.startedAt ? (job.finishedAt ? new Date(job.finishedAt) : new Date()) - new Date(job.startedAt) : null;
  if (ms === null) return null;
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec < 60 ? `${sec} s` : sec < 3600 ? `${Math.floor(sec / 60)} min` : `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min`;
}

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})$/;
const TAIL_LINES = 12;

/** "Sunday 22 Nov, 02:30 IST" plus how far away it is. */
function whenLong(iso, tz) {
  if (!iso) return null;
  try {
    return `${new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))} ${tzLabel(tz)}`;
  } catch {
    return when(iso, tz);
  }
}

/** Who a fetch covers, from its params: "RU, batch 2025", "3 students", "everyone". */
function scopeText(params) {
  const p = params || {};
  const bits = [];
  if (Array.isArray(p.users) && p.users.length) bits.push(p.users.length <= 2 ? p.users.join(', ') : `${fmt.num(p.users.length)} students`);
  if (p.campus) bits.push(p.campus);
  if (p.batch) bits.push(`batch ${p.batch}`);
  return bits.length ? bits.join(', ') : 'everyone';
}

/** What a fetch reads: only changes, everyone's whole history ("full refresh"), or the whole history of a few. */
const kindText = (params) => (!(params && params.full) ? 'New and changed' : scopeText(params) === 'everyone' ? 'Full refresh' : 'Whole history');

/**
 * The "Scheduled fetch" card (SPEC addendum C). scheduledFetch({ onChange, showLog }) → { el, load(), isRunning() }.
 * `load()` re-reads GET /admin/schedule (and the running job's log) and redraws the parts that show server state;
 * the settings form is only refilled when the admin is not in the middle of editing it. The Jobs page calls load()
 * from its poll: every 2 seconds while a fetch runs.
 */
export function scheduledFetch({ onChange = () => {}, showLog = null } = {}) {
  let view = null;
  let tail = null; // { id, lines } of the running job
  let runsOpen = true;

  const statusEl = h('dl', { class: 'sched-status' });
  const actionsEl = h('div', { class: 'toolbar' });
  const liveEl = h('div', { class: 'notice sched-live', hidden: true });
  const runsEl = h('details', { class: 'sched-runs', open: true });
  runsEl.addEventListener('toggle', () => { runsOpen = runsEl.open; });

  /* ── settings form: daily time, weekly full refresh, parallel fetches, on / off ── */
  const time = field({ label: 'Daily fetch at', name: 'dailyAt', type: 'time', required: true });
  const day = field({
    label: 'Weekly full refresh', name: 'fullRefreshDay', type: 'select',
    options: [{ value: '', label: 'Never' }, ...DAYS.map((d, i) => ({ value: String(i), label: `Every ${d}` }))],
  });
  const conc = field({ label: 'Students in parallel', name: 'concurrency', type: 'number', attrs: { min: 1, max: 16, step: 1, inputmode: 'numeric' } });
  const enabled = field({ label: 'Scheduled fetch is on', name: 'enabled', type: 'checkbox' });
  const saveBtn = h('button', { type: 'submit', class: 'btn', name: 'save-schedule', disabled: true }, 'Save schedule');
  const formNote = h('p', { class: 'hint muted' });
  const formError = h('div', { class: 'field-error', role: 'alert', hidden: true });
  const form = h('form', { class: 'stack', novalidate: true, 'aria-label': 'Schedule settings' },
    h('div', { class: 'sched-inline' }, time.row, day.row, conc.row),
    enabled.row,
    h('div', { class: 'form-actions' }, saveBtn),
    formError, formNote);
  const formValues = () => ({
    dailyAt: time.input.value, fullRefreshDay: day.input.value === '' ? null : Number(day.input.value),
    concurrency: conc.input.value.trim() === '' ? null : Number(conc.input.value), enabled: enabled.input.checked,
  });
  const formDirty = () => {
    if (!view) return false;
    const v = formValues();
    const s = view.schedule;
    return v.dailyAt !== s.dailyAt || v.fullRefreshDay !== (s.fullRefreshDay ?? null) || v.concurrency !== s.concurrency || v.enabled !== s.enabled;
  };
  const fillForm = () => {
    const s = view.schedule;
    time.input.value = s.dailyAt;
    day.input.value = s.fullRefreshDay === null || s.fullRefreshDay === undefined ? '' : String(s.fullRefreshDay);
    conc.input.value = String(s.concurrency);
    enabled.input.checked = s.enabled;
    time.row.querySelector('label').textContent = `Daily fetch at (${tzLabel(view.tz)})`;
    formNote.textContent = 'The weekly full refresh re-reads every student’s whole history on that night instead of only what changed. It takes hours: leave it on Never unless numbers drift.';
    saveBtn.disabled = true;
  };
  const onFormInput = () => {
    for (const f of [time, conc]) f.setError(null);
    formError.hidden = true;
    saveBtn.disabled = !formDirty();
  };
  form.addEventListener('input', onFormInput);
  form.addEventListener('change', onFormInput);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.dailyAt)) { time.setError('Enter a time like 02:30 (24-hour clock).'); time.input.focus(); return; }
    if (!Number.isInteger(v.concurrency) || v.concurrency < 1 || v.concurrency > 16) { conc.setError('Enter a whole number from 1 to 16.'); conc.input.focus(); return; }
    if (!v.enabled && view.schedule.enabled) {
      const ok = await confirmDialog('Turn the scheduled fetch off? No fetch starts on its own until it is turned on again; the public numbers stop updating unless someone presses Fetch now. To skip only a few nights, use Pause instead.',
        { title: 'Turn the scheduled fetch off', confirmLabel: 'Turn off', danger: true });
      if (!ok) return;
    }
    const res = await act(() => api.put('/admin/schedule', v), {
      button: saveBtn,
      onError: (err) => {
        if (err.status !== 400) return false;
        const target = /dailyAt/i.test(err.message) ? time : /concurrency/i.test(err.message) ? conc : null;
        if (target) target.setError(errorText(err)); else { formError.textContent = errorText(err); formError.hidden = false; }
        return true;
      },
    });
    if (!res) { saveBtn.disabled = !formDirty(); return; }
    apply(res);
    fillForm();
    toast(res.schedule.enabled ? `Saved. The next fetch is ${whenLong(res.schedule.nextRunAt, res.tz) || 'not set'}.` : 'Saved. The scheduled fetch is off.');
    onChange();
  });

  const body = h('div', { class: 'stack' }, statusEl, actionsEl, liveEl,
    h('details', { class: 'sched-settings', open: true }, h('summary', null, 'Schedule settings'), form),
    runsEl);
  const el = card({ title: 'Scheduled fetch', note: 'New and changed pull requests are fetched from GitHub every night, by this server.' }, body);

  /* ── actions ── */
  const conflictToast = (err) => {
    if (err.status !== 409) return false;
    toast('A fetch is already waiting or running. Wait for it to finish, or cancel it first.', 'error');
    load().catch(() => {});
    return true;
  };
  const call = async (fn, button, okText) => {
    const res = await act(fn, { button, onError: conflictToast });
    if (!res) return false;
    if (okText) toast(okText);
    if (res.schedule) apply(res); else await load();
    onChange();
    return true;
  };

  /** Fetch now: everyone, or one campus / batch / a list of students; incremental unless "whole history" is ticked. */
  async function openFetch(opener) {
    const meta = await getMeta();
    const campus = field({ label: 'Campus', name: 'sync-campus', type: 'select', options: [{ value: '', label: 'All campuses' }, ...(meta.campuses || CAMPUSES)] });
    const batch = field({ label: 'Batch', name: 'sync-batch', type: 'select', options: [{ value: '', label: 'All batches' }, ...(meta.batches || []).map(String)] });
    const users = field({
      label: 'Only these students (optional)', name: 'sync-users', type: 'textarea', rows: 3, placeholder: 'GitHub usernames, separated by commas, spaces or new lines',
      hint: 'Leave empty for every active student of the campus and batch chosen above.',
    });
    const full = field({
      label: 'Fetch their whole history again, not only what changed', name: 'sync-full', type: 'checkbox',
      hint: 'Slower. Useful after fixing a username or when one student’s numbers look wrong.',
    });
    const what = h('p', { class: 'muted', 'aria-live': 'polite' });
    const list = () => users.get().split(/[\s,;]+/).map((u) => u.replace(/^@/, '').replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '').replace(/\/.*$/, '')).filter(Boolean);
    const describe = () => {
      const params = { users: list(), campus: campus.get(), batch: batch.get() };
      const who = scopeText(params);
      what.textContent = `This fetches ${full.get() ? 'the whole pull-request history' : 'new and changed pull requests'} of ${who === 'everyone' ? 'every active student' : who}.`;
    };
    const form2 = h('form', { class: 'form', novalidate: true },
      h('p', null, 'Fetch from GitHub now instead of waiting for tonight. Leave everything as it is to fetch what is new for everyone.'),
      h('div', { class: 'form-grid' }, campus.row, batch.row), users.row, full.row, what);
    form2.addEventListener('input', describe);
    form2.addEventListener('change', describe);
    describe();
    const m = modal({ title: 'Fetch now', body: form2, actions: [{ label: 'Cancel' }, { label: 'Start fetch', kind: 'primary', onClick: () => form2.requestSubmit() }] });
    form2.addEventListener('submit', async (e) => {
      e.preventDefault();
      users.setError(null);
      const names = list();
      const bad = names.find((u) => !LOGIN_RE.test(u));
      if (bad) { users.setError(`“${bad}” is not a GitHub username.`); users.input.focus(); return; }
      const payload = { full: full.get() };
      if (names.length) payload.users = names;
      if (campus.get()) payload.campus = campus.get();
      if (batch.get()) payload.batch = Number(batch.get());
      if (payload.full && !names.length && !payload.campus && !payload.batch) {
        m.close();
        fullRefresh(opener);
        return;
      }
      const res = await act(() => api.post('/admin/jobs/sync', payload), {
        button: m.el.querySelectorAll('.dialog-actions .btn')[1],
        onError: (err) => {
          if (err.status === 400) { users.setError(errorText(err)); return true; }
          if (err.status === 409) { m.close(); return conflictToast(err); }
          return false;
        },
      });
      if (!res) return;
      m.close();
      toast(`Started a ${payload.full ? 'full-history ' : ''}fetch for ${scopeText(payload) === 'everyone' ? 'every active student' : scopeText(payload)}. Progress shows here.`);
      await load();
      onChange();
    });
    (m.el.querySelectorAll('.dialog-actions .btn')[1]).focus();
  }

  function openPause(button) {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const until = field({ label: `Resume automatically on (optional, 00:00 ${tzLabel(view.tz)})`, name: 'until', type: 'date', hint: 'Leave empty to stay paused until someone presses Resume.', attrs: { min: tomorrow } });
    const note = field({ label: 'Note (optional)', name: 'note', placeholder: 'Why? Shown here while paused', attrs: { maxlength: 300 } });
    const form2 = h('form', { class: 'form', novalidate: true },
      h('p', null, 'While paused, no scheduled fetch starts. Nothing is lost: the next fetch picks up everything since each student was last checked. Fetch now still works, and a fetch that is running now carries on.'),
      until.row, note.row);
    const m = modal({ title: 'Pause the scheduled fetch', body: form2, actions: [{ label: 'Cancel' }, { label: 'Pause', kind: 'primary', onClick: () => form2.requestSubmit() }] });
    form2.addEventListener('submit', async (e) => {
      e.preventDefault();
      until.setError(null);
      if (until.get() && until.get() < tomorrow) { until.setError('Choose a date after today, or leave it empty.'); until.input.focus(); return; }
      const res = await act(() => api.post('/admin/schedule/pause', { until: until.get() || null, note: note.get() }), {
        button: m.el.querySelectorAll('.dialog-actions .btn')[1],
        onError: (err) => { if (err.status !== 400) return false; until.setError(errorText(err)); return true; },
      });
      if (!res) return;
      m.close();
      toast(res.schedule && res.schedule.pausedUntil ? `Paused until ${whenLong(res.schedule.pausedUntil, res.tz)}.` : 'Paused the scheduled fetch until someone resumes it.');
      if (res.schedule) apply(res); else await load();
      onChange();
      const next = actionsEl.querySelector('[name="schedule-resume"]');
      if (next) next.focus(); else if (button && button.isConnected) button.focus();
    });
    until.input.focus();
  }

  async function fullRefresh(button) {
    const meta = await getMeta();
    const n = meta && meta.counts ? meta.counts.students : null;
    const ok = await confirmDialog(h('div', { class: 'stack' },
      h('p', null, h('strong', null, 'This re-reads the whole pull-request history of every active student from GitHub'), ', not just what changed since last night.'),
      h('ul', null,
        h('li', null, `It takes roughly one to three hours${n ? ` for ${fmt.num(n)} students` : ''} and uses a large part of the hourly GitHub allowance.`),
        h('li', null, 'No other fetch can start until it finishes or is cancelled. The public site stays usable and shows numbers as they come in.'),
        h('li', null, 'Pull requests that moved or disappeared on GitHub are cleaned up. Your include / exclude decisions are kept.')),
      h('p', { class: 'muted' }, 'For one campus, batch or a few students, use Fetch now and tick “whole history” instead.')),
    { title: 'Start a full refresh?', confirmLabel: 'Start full refresh' });
    if (ok) await call(() => api.post('/admin/jobs/sync', { full: true }), button && button.isConnected ? button : null, 'Started a full refresh of every student. Progress shows here.');
  }

  async function cancelRunning(button) {
    const running = view && view.running;
    if (!running) return;
    const ok = await confirmDialog(
      running.status === 'queued' ? 'Cancel the fetch that is waiting to start?'
        : 'Stop the running fetch? It stops after the students it is working on right now. Everything fetched so far is kept, and the next fetch continues from there.',
      { title: 'Cancel the fetch', confirmLabel: running.status === 'queued' ? 'Cancel the fetch' : 'Stop the fetch', cancelLabel: 'Keep it running', danger: true });
    if (!ok) return;
    await call(() => api.post(`/admin/jobs/${encodeURIComponent(running.id)}/cancel`, {}), button, running.status === 'queued' ? 'Cancelled the fetch.' : 'Stopping the fetch. It ends after the students it is working on.');
  }

  /* ── drawing ── */
  const btn = (label, name, onClick, cls = 'btn', attrs = {}) => {
    const b = h('button', { type: 'button', class: cls, name, ...attrs }, label);
    b.addEventListener('click', () => onClick(b));
    return b;
  };

  function drawStatus() {
    const { schedule: s, running, runs, tz } = view;
    const state = !s.enabled ? [h('strong', null, 'Disabled'), h('div', { class: 'muted' }, 'No fetch starts on its own. Turn it on under Schedule settings.')]
      : s.paused ? [h('strong', null, s.pausedUntil ? `Paused until ${whenLong(s.pausedUntil, tz)}` : 'Paused'),
        h('div', { class: 'muted' }, s.pausedUntil ? 'It resumes by itself then.' : 'Until someone presses Resume.', s.pauseNote ? ` Note: ${s.pauseNote}` : '')]
        : [h('strong', null, 'Active'), h('div', { class: 'muted' }, `Every night at ${s.dailyAt} ${tzLabel(tz)}${s.fullRefreshDay !== null && s.fullRefreshDay !== undefined ? `, full refresh on ${DAYS[s.fullRefreshDay]}s` : ''}.`)];
    const afterPause = s.paused && s.pausedUntil && (!s.nextRunAt || s.nextRunAt < s.pausedUntil); // the stored next run falls inside the pause
    const nextRun = !s.enabled ? [h('strong', null, 'None'), h('div', { class: 'muted' }, 'The schedule is off.')]
      : s.paused && !s.pausedUntil ? [h('strong', null, 'None while paused'), h('div', { class: 'muted' }, 'Press Resume to schedule the next one.')]
        : afterPause ? [h('strong', null, 'After the pause'), h('div', { class: 'muted' }, `The first ${s.dailyAt} ${tzLabel(tz)} after ${whenLong(s.pausedUntil, tz)}.`)]
          : [h('strong', null, whenLong(s.nextRunAt, tz) || 'Not set'),
            h('div', { class: 'muted' }, s.nextRunAt ? `${fmt.rel(s.nextRunAt)}${running ? ', unless a fetch is still running then' : ''}` : 'It is set within half a minute.')];
    const last = runs.find((j) => j.status !== 'queued' && j.status !== 'running');
    const lastRun = last
      ? [h('div', null, stateBadge(last.status), ' ', h('span', { title: fmt.datetime(last.finishedAt || last.createdAt) }, fmt.rel(last.finishedAt || last.createdAt))),
        h('div', { class: 'muted' }, `${TRIGGERS[last.params && last.params.trigger] || 'Started by an admin'}, ${kindText(last.params).toLowerCase()}, ${scopeText(last.params)}: ${runResult(last) || 'no summary'}.`)]
      : [h('strong', null, 'None yet'), h('div', { class: 'muted' }, 'No fetch has run on this server.')];
    statusEl.replaceChildren(
      h('div', { 'data-item': 'state' }, h('dt', null, 'Status'), h('dd', null, state)),
      h('div', { 'data-item': 'next' }, h('dt', null, `Next run (${tzLabel(tz)})`), h('dd', null, nextRun)),
      h('div', { 'data-item': 'last' }, h('dt', null, 'Last run'), h('dd', null, lastRun)));
  }

  function drawActions() {
    const { schedule: s, running } = view;
    const key = `${s.paused}|${s.enabled}|${running ? running.id : ''}|${running ? running.cancelRequested : ''}`;
    if (actionsEl.dataset.key === key) return; // keep the buttons (and the focus on them) while nothing changed
    const focused = actionsEl.contains(document.activeElement) ? document.activeElement.name : null;
    actionsEl.dataset.key = key;
    const busy = Boolean(running);
    const why = busy ? 'A fetch is already waiting or running' : null;
    actionsEl.replaceChildren(...[
      btn('Fetch now…', 'fetch-now', openFetch, 'btn btn-primary', { disabled: busy, title: why || 'Everyone, or one campus, batch or a few students' }),
      btn('Full refresh…', 'full-refresh', fullRefresh, 'btn', { disabled: busy, title: why || 'Re-read every student’s whole history' }),
      s.paused ? btn('Resume', 'schedule-resume', (b) => call(() => api.post('/admin/schedule/resume', {}), b, 'Resumed the scheduled fetch.'))
        : btn('Pause…', 'schedule-pause', openPause, 'btn', { disabled: !s.enabled, title: s.enabled ? 'Skip the nightly fetch for a while' : 'The schedule is off' }),
      busy ? btn(running.cancelRequested ? 'Stopping…' : 'Cancel running job', 'cancel-running', cancelRunning, 'btn btn-danger', { disabled: Boolean(running.cancelRequested) }) : null].filter(Boolean));
    if (focused) { const again = actionsEl.querySelector(`[name="${focused}"]:not([disabled])`); if (again) again.focus(); }
  }

  function drawLive() {
    const { running } = view;
    liveEl.hidden = !running;
    if (!running) { liveEl.replaceChildren(); delete liveEl.dataset.id; return; }
    const { done = 0, total = 0 } = running.progress || {};
    const pct = total ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
    if (liveEl.dataset.id !== running.id) {
      liveEl.dataset.id = running.id;
      liveEl.replaceChildren(
        h('div', { 'data-part': 'head', role: 'status' }),
        h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-label': 'Students fetched' }, h('span')),
        h('pre', { class: 'log', tabindex: '0', 'aria-label': 'Latest log lines of the running fetch' }),
        ...(showLog ? [h('div', { class: 'toolbar' }, btn('Open the full log', 'running-log', () => showLog(running.id), 'btn btn-sm'))] : []));
    }
    const head = liveEl.querySelector('[data-part="head"]');
    const scoped = scopeText(running.params) !== 'everyone';
    const what = `${running.params && running.params.full ? (scoped ? 'Whole-history fetch' : 'Full refresh') : 'Fetch'} of ${scoped ? scopeText(running.params) : 'every active student'}`;
    const text = running.status === 'queued' ? `${what} is waiting for the job in front of it.`
      : running.cancelRequested ? `Stopping: ${fmt.num(done)} of ${fmt.num(total)} students done. It ends after the students it is working on.`
        : total ? `${fmt.num(done)} of ${fmt.num(total)} students done (${Math.floor(pct)}%)${running.startedAt ? `, started ${fmt.rel(running.startedAt)}` : ''}.`
          : 'Working out which students to fetch…';
    head.replaceChildren(h('strong', null, running.status === 'queued' ? 'Waiting to start. ' : `${what} is running. `), text);
    const bar = liveEl.querySelector('.progress');
    bar.setAttribute('aria-valuemax', String(total || 1));
    bar.setAttribute('aria-valuenow', String(done));
    bar.firstChild.style.width = `${pct}%`;
    const pre = liveEl.querySelector('pre');
    const lines = tail && tail.id === running.id ? tail.lines : [];
    const next = lines.length ? lines.slice(-TAIL_LINES).join('\n') : (running.status === 'queued' ? 'Not started yet.' : 'No log lines yet.');
    if (pre.textContent !== next) { pre.textContent = next; pre.scrollTop = pre.scrollHeight; }
  }

  function drawRuns() {
    const { runs, tz } = view;
    runsEl.open = runsOpen;
    runsEl.replaceChildren(
      h('summary', null, `Recent runs (${fmt.num(runs.length)})`),
      table({
        caption: 'Recent fetches, newest first', compact: true, sticky: false, rows: runs, empty: 'No fetch has run yet. The first one starts at the next scheduled time, or press Fetch now.',
        columns: [
          { key: 'createdAt', label: `Started (${tzLabel(tz)})`, class: 'nowrap', render: (j) => (j.startedAt ? when(j.startedAt, tz) : 'Not yet') },
          { key: 'trigger', label: 'Started by', render: (j) => h('div', null, TRIGGERS[j.params && j.params.trigger] || (j.runner === 'cli' ? 'Script' : 'Started by an admin'),
            h('div', { class: 'sub' }, `${kindText(j.params)} · ${scopeText(j.params)}`)) },
          { key: 'status', label: 'Status', render: (j) => stateBadge(j.status) },
          { key: 'summary', label: 'Result', wrap: true, render: (j) => (j.status === 'running' && j.progress && j.progress.total ? `${fmt.num(j.progress.done)} of ${fmt.num(j.progress.total)} students so far` : (j.status === 'cancelled' && j.summary ? `Stopped early; kept: ${runResult(j)}` : runResult(j))) },
          { key: 'duration', label: 'Duration', class: 'nowrap', render: runDuration },
          ...(showLog ? [{ key: 'log', label: 'Log', render: (j) => h('button', { type: 'button', class: 'btn btn-sm', name: `run-log-${j.id}`, onClick: () => showLog(j.id) }, 'View log') }] : []),
        ],
      }));
  }

  function apply(next) {
    const first = !view;
    view = { ...(view || {}), ...next };
    drawStatus();
    drawActions();
    drawLive();
    drawRuns();
    if (first || (!formDirty() && !form.contains(document.activeElement))) fillForm();
    else saveBtn.disabled = !formDirty();
  }

  async function load() {
    const next = await api.get('/admin/schedule');
    if (next.running && next.running.status === 'running') {
      try {
        const { job } = await api.get(`/admin/jobs/${encodeURIComponent(next.running.id)}`);
        tail = { id: job.id, lines: Array.isArray(job.log) ? job.log : [] };
      } catch { /* the job may have just finished; the next tick shows the result */ }
    }
    apply(next);
  }

  return { el, load, isRunning: () => Boolean(view && view.running) };
}

/**
 * "Academic year" card of the Rules page (SPEC addendum A1): the default date range of every public page.
 * A year that starts after the current one ends is a new year: the old one stays available as an earlier range.
 * Anything else (a fixed label, moved dates) corrects the current year and leaves no trace. Earlier years can be
 * removed one by one. Validation mirrors the server: label required, first day before last day, at most 400 days.
 */
export async function academicYearCard() {
  const { academicYear } = await api.get('/admin/academic-year');
  let cur = academicYear.current;
  const label = field({ label: 'Label', name: 'ay-label', value: cur.label, required: true, placeholder: '2026-27', attrs: { maxlength: 20 } });
  const start = field({ label: 'First day', name: 'ay-start', type: 'date', value: cur.start, required: true });
  const end = field({ label: 'Last day', name: 'ay-end', type: 'date', value: cur.end, required: true });
  const save = h('button', { type: 'submit', class: 'btn', name: 'save-academic-year', disabled: true }, 'Save academic year');
  const effect = h('span', { class: 'muted', 'aria-live': 'polite' }, 'No unsaved changes.');
  const now = h('p', null);
  const history = h('div', { class: 'stack' });
  let past = academicYear.history;
  const removeEarlier = async (a, button) => {
    const ok = await confirmDialog(`Remove AY ${a.label} (${fmt.range(a.start, a.end)}) from the ranges offered on the public pages? The data is not touched; links that use this range by name stop working.`,
      { confirmLabel: 'Remove range', danger: true, title: `Remove AY ${a.label}` });
    if (!ok) return;
    const res = await act(() => api.put('/admin/academic-year', { ...cur, history: past.filter((x) => x.label !== a.label) }), { button });
    if (!res) return;
    drawFacts(res.academicYear);
    toast(`Removed AY ${a.label} from the earlier ranges.`);
  };
  const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1;
  const drawFacts = (ay) => {
    now.replaceChildren('Public pages open on ', h('strong', null, `AY ${ay.current.label}`), ` (${fmt.range(ay.current.start, ay.current.end)}, ${fmt.num(days(ay.current.start, ay.current.end))} days), unless a visitor picks another range.`);
    past = ay.history;
    history.replaceChildren(h('p', { class: 'muted' }, past.length ? 'Earlier years offered as ranges on the public pages:' : 'No earlier years yet.'),
      ...(past.length ? [h('ul', { class: 'ay-history' }, past.map((a) => {
        const remove = h('button', { type: 'button', class: 'btn btn-sm btn-quiet', 'aria-label': `Remove AY ${a.label}` }, 'Remove');
        remove.addEventListener('click', () => removeEarlier(a, remove));
        return h('li', null, h('span', null, `AY ${a.label} (${fmt.range(a.start, a.end)}) `), remove);
      }))] : []));
  };
  drawFacts(academicYear);
  const dirty = () => label.get() !== cur.label || start.get() !== cur.start || end.get() !== cur.end;
  const onInput = () => {
    for (const f of [label, start, end]) f.setError(null);
    save.disabled = !dirty();
    effect.textContent = !dirty() ? 'No unsaved changes.'
      : start.get() && start.get() > cur.end ? `Saving starts a new year “${label.get() || '…'}”. ${cur.label} stays available as an earlier range.`
        : `Saving corrects the current year (${cur.label}); nothing is added to the earlier ranges.`;
  };
  const form = h('form', { class: 'stack', novalidate: true },
    now,
    h('div', { class: 'form-grid' }, label.row, start.row, end.row),
    h('div', { class: 'form-actions' }, save, effect), history);
  form.addEventListener('input', onInput);
  form.addEventListener('change', onInput);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    for (const f of [label, start, end]) f.setError(null);
    const fail = (f, text) => { f.setError(text); f.input.focus(); };
    if (!label.get()) return fail(label, 'Enter a label, for example 2026-27.');
    if (!start.get()) return fail(start, 'Choose the first day.');
    if (!end.get()) return fail(end, 'Choose the last day.');
    if (start.get() >= end.get()) return fail(end, 'The last day must be after the first day.');
    if (days(start.get(), end.get()) > 400) return fail(end, `An academic year is at most 400 days long; this one would be ${fmt.num(days(start.get(), end.get()))} days.`);
    const res = await act(() => api.put('/admin/academic-year', { label: label.get(), start: start.get(), end: end.get() }), {
      button: save,
      onError: (err) => {
        if (err.status !== 400) return false;
        (/label/i.test(err.message) ? label : /start and end|dates/i.test(err.message) && !start.get() ? start : end).setError(errorText(err));
        return true;
      },
    });
    if (!res) { save.disabled = !dirty(); return undefined; }
    cur = res.academicYear.current;
    label.input.value = cur.label; start.input.value = cur.start; end.input.value = cur.end;
    drawFacts(res.academicYear);
    onInput();
    toast(`Saved. Public pages now default to AY ${cur.label} (${fmt.range(cur.start, cur.end)}).`);
    return undefined;
  });
  return card({ title: 'Academic year', note: 'The date range every public page shows by default.' }, form);
}
