// Admin → Jobs → "Scheduled fetch" (SPEC addendum C) and Admin → Rules → "Academic year" (addendum A1).
// GET/PUT /admin/schedule, POST /admin/schedule/pause|resume, POST /admin/jobs/sync, POST /admin/jobs/:id/cancel,
// GET/PUT /admin/academic-year.

import { api } from '../lib/api.js';
import { h, card, table, stateBadge, modal, confirmDialog, toast, fmt } from '../lib/ui.js';
import { act, field, errorText, fetchErrorText } from './common.js';

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

/**
 * The "Scheduled fetch" card. scheduledFetch({ onChange, showLog }) → { el, load() }.
 * `load()` re-reads GET /admin/schedule and redraws; the Jobs page calls it from its 5-second poll.
 */
export function scheduledFetch({ onChange = () => {}, showLog = null } = {}) {
  const body = h('div', { class: 'stack' });
  const el = card({ title: 'Scheduled fetch', note: 'New and changed pull requests are fetched from GitHub every night.' }, body);
  let view = null;

  const call = async (fn, button, okText) => {
    const res = await act(fn, {
      button,
      onError: (err) => {
        if (err.status !== 409) return false;
        toast('A fetch is already running. Wait for it to finish or cancel it first.', 'error');
        return true;
      },
    });
    if (!res) return;
    if (okText) toast(okText);
    await load();
    onChange();
  };

  function openSettings() {
    const s = view.schedule;
    const time = field({ label: `Time of the nightly fetch (${tzLabel(view.tz)})`, name: 'dailyAt', type: 'time', value: s.dailyAt, required: true });
    const day = field({
      label: 'Weekly full refresh', name: 'fullRefreshDay', type: 'select', value: s.fullRefreshDay === null ? '' : String(s.fullRefreshDay),
      options: [{ value: '', label: 'Never' }, ...DAYS.map((d, i) => ({ value: String(i), label: `Every ${d}` }))],
      hint: 'On that day the nightly fetch re-reads every student’s whole history instead of only what changed. It takes hours; leave it off unless numbers drift.',
    });
    const conc = field({ label: 'Students fetched in parallel', name: 'concurrency', type: 'number', value: String(s.concurrency), attrs: { min: 1, max: 16, step: 1 } });
    const enabled = field({ label: 'Nightly fetch is on', name: 'enabled', type: 'checkbox', value: s.enabled, hint: 'Turn this off to stop scheduled fetches for good. To skip a few nights, use Pause instead.' });
    const form = h('form', { class: 'form', novalidate: true }, time.row, day.row, conc.row, enabled.row);
    const m = modal({ title: 'Scheduled fetch settings', body: form, actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: () => form.requestSubmit() }] });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      time.setError(null); conc.setError(null);
      if (!/^\d{2}:\d{2}$/.test(time.get())) { time.setError('Enter a time like 02:30.'); return; }
      const n = Number(conc.get());
      if (!Number.isInteger(n) || n < 1 || n > 16) { conc.setError('Enter a whole number from 1 to 16.'); return; }
      const res = await act(() => api.put('/admin/schedule', { dailyAt: time.get(), fullRefreshDay: day.get() === '' ? null : Number(day.get()), concurrency: n, enabled: enabled.get() }), {
        button: m.el.querySelectorAll('.dialog-actions .btn')[1],
        onError: (err) => { if (err.status !== 400) return false; time.setError(errorText(err)); return true; },
      });
      if (!res) return;
      m.close();
      toast('Saved the schedule.');
      await load();
      onChange();
    });
  }

  function openPause(button) {
    const until = field({ label: 'Resume automatically on (optional)', name: 'until', type: 'date', hint: 'Leave empty to stay paused until someone presses Resume.', attrs: { min: new Date(Date.now() + 86400000).toISOString().slice(0, 10) } });
    const note = field({ label: 'Note (optional)', name: 'note', placeholder: 'Why? Shown here while paused', attrs: { maxlength: 300 } });
    const form = h('form', { class: 'form', novalidate: true },
      h('p', null, 'While paused, no nightly fetch starts. Nothing is lost: the next fetch picks up everything since each student was last checked.'),
      until.row, note.row);
    const m = modal({ title: 'Pause the scheduled fetch', body: form, actions: [{ label: 'Cancel' }, { label: 'Pause', kind: 'primary', onClick: () => form.requestSubmit() }] });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      until.setError(null);
      const res = await act(() => api.post('/admin/schedule/pause', { until: until.get() || null, note: note.get() }), {
        button: m.el.querySelectorAll('.dialog-actions .btn')[1],
        onError: (err) => { if (err.status !== 400) return false; until.setError(errorText(err)); return true; },
      });
      if (!res) return;
      m.close();
      toast('Paused the scheduled fetch.');
      await load();
      onChange();
      if (button && button.isConnected) button.focus();
    });
  }

  async function fullRefresh(button) {
    const ok = await confirmDialog(
      'Start a full refresh? It re-reads every student’s whole pull-request history from GitHub, not just what changed. For all students this takes roughly one to three hours and uses a large part of the hourly GitHub allowance. Pull requests that moved or disappeared on GitHub are cleaned up. The site stays usable meanwhile.',
      { title: 'Full refresh', confirmLabel: 'Start full refresh' });
    if (ok) await call(() => api.post('/admin/jobs/sync', { full: true }), button, 'Started a full refresh of every student.');
  }

  function draw() {
    const { schedule: s, running, runs, tz } = view;
    const state = !s.enabled ? h('span', null, h('strong', null, 'Off. '), 'No fetch is scheduled.')
      : s.paused ? h('span', null, h('strong', null, s.pausedUntil ? `Paused until ${when(s.pausedUntil, tz)}. ` : 'Paused. '), s.pauseNote ? `Note: ${s.pauseNote}` : null)
        : h('span', null, h('strong', null, 'Active. '), `Next fetch ${when(s.nextRunAt, tz) || 'not set'}, every night at ${s.dailyAt} ${tzLabel(tz)}.`);
    const last = runs.find((j) => j.status !== 'queued' && j.status !== 'running');
    const btn = (label, name, onClick, cls = 'btn') => { const b = h('button', { type: 'button', class: cls, name }, label); b.addEventListener('click', () => onClick(b)); return b; };
    const actions = h('div', { class: 'toolbar' },
      btn('Fetch now', 'fetch-now', (b) => call(() => api.post('/admin/jobs/sync', { full: false }), b, 'Started a fetch of everything new.'), 'btn btn-primary'),
      btn('Full refresh', 'full-refresh', fullRefresh),
      s.paused ? btn('Resume', 'schedule-resume', (b) => call(() => api.post('/admin/schedule/resume', {}), b, 'Resumed the scheduled fetch.'))
        : btn('Pause', 'schedule-pause', openPause),
      btn('Settings', 'schedule-settings', openSettings));
    if (running) actions.querySelector('[name="fetch-now"]').disabled = true;
    if (running) actions.querySelector('[name="full-refresh"]').disabled = true;

    let live = null;
    if (running) {
      const { done = 0, total = 0 } = running.progress || {};
      const pct = total ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
      const cancel = btn(running.cancelRequested ? 'Stopping…' : 'Cancel running fetch', 'cancel-running', async (b) => {
        const ok = await confirmDialog('Stop the running fetch? It stops after the students it is working on; everything fetched so far is kept.', { title: 'Cancel fetch', confirmLabel: 'Stop the fetch', danger: true });
        if (ok) await call(() => api.post(`/admin/jobs/${encodeURIComponent(running.id)}/cancel`, {}), b, 'Stopping the fetch.');
      }, 'btn btn-danger btn-sm');
      cancel.disabled = Boolean(running.cancelRequested);
      live = h('div', { class: 'notice', role: 'status' },
        h('strong', null, running.status === 'queued' ? 'A fetch is waiting to start. ' : `Fetching now${running.params && running.params.full ? ' (full refresh)' : ''}. `),
        total ? `${fmt.num(done)} of ${fmt.num(total)} students done. ` : null,
        total ? h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done), 'aria-label': 'Fetch progress' }, h('span', { style: { width: `${pct}%` } })) : null,
        h('div', { class: 'toolbar' }, cancel, showLog ? btn('View log', 'running-log', () => showLog(running.id), 'btn btn-sm') : null));
    }

    body.replaceChildren(
      h('p', null, state, ' ', last ? h('span', { class: 'muted' }, `Last fetch ${fmt.rel(last.finishedAt || last.createdAt)}: ${last.status === 'done' ? runResult(last) : last.status === 'cancelled' ? 'cancelled' : runResult(last)}.`) : h('span', { class: 'muted' }, 'No fetch has run yet.')),
      actions,
      ...(live ? [live] : []),
      h('details', null,
        h('summary', null, `Recent fetches (${fmt.num(runs.length)})`),
        table({
          caption: 'Recent fetches, newest first', compact: true, sticky: false, rows: runs, empty: 'No fetch has run yet.',
          columns: [
            { key: 'createdAt', label: 'Started', class: 'nowrap', render: (j) => when(j.startedAt || j.createdAt, tz) },
            { key: 'trigger', label: 'Why', render: (j) => `${TRIGGERS[j.params && j.params.trigger] || (j.runner === 'cli' ? 'Script' : 'Started by an admin')}${j.params && j.params.full ? ', full refresh' : ''}` },
            { key: 'status', label: 'Status', render: (j) => stateBadge(j.status) },
            { key: 'summary', label: 'Result', wrap: true, render: runResult },
            { key: 'duration', label: 'Duration', class: 'nowrap', render: runDuration },
            ...(showLog ? [{ key: 'log', label: 'Log', render: (j) => h('button', { type: 'button', class: 'btn btn-sm', onClick: () => showLog(j.id) }, 'View log') }] : []),
          ],
        })));
  }

  async function load() {
    const open = body.querySelector('details') ? body.querySelector('details').open : false;
    view = await api.get('/admin/schedule');
    draw();
    if (open) body.querySelector('details').open = true;
  }

  return { el, load };
}

/** "Academic year" card of the Rules page: the default date range of every public page. */
export async function academicYearCard() {
  const { academicYear } = await api.get('/admin/academic-year');
  const cur = academicYear.current;
  const label = field({ label: 'Label', name: 'ay-label', value: cur.label, required: true, placeholder: '2026-27', attrs: { maxlength: 20 } });
  const start = field({ label: 'First day', name: 'ay-start', type: 'date', value: cur.start, required: true });
  const end = field({ label: 'Last day', name: 'ay-end', type: 'date', value: cur.end, required: true });
  const save = h('button', { type: 'submit', class: 'btn', name: 'save-academic-year' }, 'Save academic year');
  const history = h('p', { class: 'muted' });
  const drawHistory = (ay) => {
    history.textContent = ay.history.length ? `Earlier years offered as ranges: ${ay.history.map((a) => `${a.label} (${fmt.range(a.start, a.end)})`).join('; ')}.` : 'No earlier years yet.';
  };
  drawHistory(academicYear);
  const form = h('form', { class: 'stack', novalidate: true },
    h('div', { class: 'form-grid' }, label.row, start.row, end.row),
    h('div', { class: 'form-actions' }, save), history);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    for (const f of [label, start, end]) f.setError(null);
    if (!label.get()) { label.setError('Enter a label, for example 2026-27.'); return; }
    if (!start.get() || !end.get()) { (start.get() ? end : start).setError('Choose a date.'); return; }
    if (start.get() >= end.get()) { end.setError('The last day must be after the first day.'); return; }
    if ((new Date(end.get()) - new Date(start.get())) / 86400000 + 1 > 400) { end.setError('An academic year is at most 400 days long.'); return; }
    const res = await act(() => api.put('/admin/academic-year', { label: label.get(), start: start.get(), end: end.get() }), {
      button: save,
      onError: (err) => { if (err.status !== 400) return false; end.setError(errorText(err)); return true; },
    });
    if (!res) return;
    drawHistory(res.academicYear);
    toast(`Saved. Public pages now default to ${res.academicYear.current.label}.`);
  });
  return card({ title: 'Academic year', note: 'The date range every public page shows by default. It moves on by itself each 1 July; edit it only if your year differs.' }, form);
}
