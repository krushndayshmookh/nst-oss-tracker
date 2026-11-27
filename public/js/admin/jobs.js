// Admin → Jobs. GET /admin/jobs, GET /admin/jobs/:id; the scheduled-fetch panel (./schedule.js) starts, pauses and
// cancels fetches; reclassify; follow progress and the log. The list re-reads itself; an open log every 2 s.

import { api } from '../lib/api.js';
import { setQuery, refresh } from '../lib/router.js';
import { h, pageHead, filterBar, table, pagination, card, stateBadge, modal, confirmDialog, toast, loading, fmt } from '../lib/ui.js';
import { act, poll, errorText, handleAuthError, fetchErrorText, contribBits } from './common.js';
import { scheduledFetch } from './schedule.js';

const TYPE_LABELS = { sync: 'Sync', backfill: 'History fetch', reclassify: 'Reclassify', import: 'Import', repoMeta: 'Repo metadata' };
const TYPE_HELP = {
  sync: 'Fetches pull requests that are new or changed since each student was last synced.',
  backfill: 'Fetches a student’s whole pull-request history.',
  reclassify: 'Sorts every stored pull request into categories again and recomputes the totals.',
  import: 'Loads the original spreadsheet data.',
  repoMeta: 'Reads stars, languages and topics of every stored project from GitHub and recomputes their technology areas.',
};
const RUNNER_LABELS = { app: 'App', cli: 'Script' };
const LIVE = new Set(['queued', 'running']);

function duration(job) {
  if (!job.startedAt) return null;
  const end = job.finishedAt ? new Date(job.finishedAt) : new Date();
  const sec = Math.max(0, Math.round((end - new Date(job.startedAt)) / 1000));
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ${sec % 60} s`;
  return `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min`;
}

function scope(job) {
  const p = job.params || {};
  const bits = [];
  const cohort = [p.campus, p.batch ? `batch ${p.batch}` : null].filter(Boolean).join(', ');
  if (Array.isArray(p.users) && p.users.length) bits.push(p.users.length <= 3 ? p.users.join(', ') : `${fmt.num(p.users.length)} students`);
  else if (cohort) bits.push(`active students of ${cohort}`);
  else if (job.type === 'sync' || job.type === 'backfill') bits.push(p.pending ? 'students waiting for a fetch' : 'all active students');
  if (p.full) bits.push('full history');
  return bits.join(' · ');
}

/** The summary in words. Unknown shapes fall back to "key value" pairs of whatever numbers are there. */
function resultText(job) {
  if (job.status === 'error') return `Failed: ${fetchErrorText(job.error)}`;
  const s = job.summary;
  if (job.status === 'cancelled' && (!s || typeof s !== 'object')) return 'Cancelled before it started';
  if (!s || typeof s !== 'object') return job.status === 'done' ? 'Finished' : null;
  if (job.type !== 'repoMeta' && ('ok' in s || 'failed' in s)) {
    const bits = [`${fmt.num(s.ok ?? 0)} ok`, `${fmt.num(s.failed ?? 0)} failed`, `${fmt.num(s.prs ?? 0)} PRs`];
    if (job.status === 'cancelled') bits.unshift('Cancelled, what was fetched is kept');
    bits.push(...contribBits(s));
    if (s.renamed) bits.push(`${fmt.num(s.renamed)} renamed`);
    if (s.notFound) bits.push(`${fmt.num(s.notFound)} not found on GitHub`);
    return bits.join(', ');
  }
  if (job.type === 'repoMeta' && 'repos' in s) {
    const bits = [`${fmt.num(s.ok ?? 0)} of ${fmt.num(s.repos)} projects refreshed`];
    if (job.status === 'cancelled') bits.unshift('Cancelled, what was read is kept');
    if (s.renamed) bits.push(`${fmt.num(s.renamed)} renamed`);
    if (s.missing) bits.push(`${fmt.num(s.missing)} gone from GitHub`);
    if (s.private) bits.push(`${fmt.num(s.private)} now private`);
    if (s.failed) bits.push(`${fmt.num(s.failed)} failed (retried next run)`);
    return bits.join(', ');
  }
  if (job.type === 'import' && 'students' in s) return `${fmt.num(s.students)} students, ${fmt.num(s.prs ?? 0)} PRs imported`;
  if ('prsChanged' in s) return `${fmt.num(s.prsChanged)} of ${fmt.num(s.prs ?? 0)} PRs and ${fmt.num(s.reposChanged ?? 0)} of ${fmt.num(s.repos ?? 0)} repos changed`;
  const nums = Object.entries(s).filter(([, v]) => typeof v === 'number').slice(0, 4);
  return nums.length ? nums.map(([k, v]) => `${fmt.num(v)} ${k}`).join(', ') : 'Finished';
}

function progressCell(job) {
  const { done = 0, total = 0 } = job.progress || {};
  if (!total) return job.status === 'running' ? h('span', { class: 'muted' }, 'Working…') : null;
  const pct = Math.max(0, Math.min(100, (done / total) * 100));
  return h('div', null,
    h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done), 'aria-label': 'Progress' },
      h('span', { style: { width: `${pct}%` } })),
    h('div', { class: 'sub' }, `${fmt.num(done)} / ${fmt.num(total)}`));
}

/* ───────────── log dialog ───────────── */

function openLog(id, onClose) {
  const body = h('div', { class: 'stack' }, loading('Loading the log…'));
  let stop = null;
  const m = modal({
    title: 'Job log', wide: true, body,
    actions: [{ label: 'Close' }],
    onClose: () => { if (stop) stop(); if (onClose) onClose(); },
  });
  const pre = h('pre', { class: 'log', tabindex: '0', 'aria-label': 'Log, newest lines last' });
  const facts = h('dl', { class: 'facts' });
  const note = h('p', { class: 'muted' });
  let drawn = false;

  const draw = (job) => {
    const atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
    facts.replaceChildren(
      h('dt', null, 'Job'), h('dd', null, `${TYPE_LABELS[job.type] || job.type} · ${scope(job) || TYPE_HELP[job.type] || ''}`),
      h('dt', null, 'Status'), h('dd', null, stateBadge(job.status), job.progress && job.progress.total ? ` ${fmt.num(job.progress.done)} / ${fmt.num(job.progress.total)}` : null),
      h('dt', null, 'Started'), h('dd', null, job.startedAt ? fmt.datetime(job.startedAt) : `Queued ${fmt.rel(job.createdAt)}`),
      h('dt', null, 'Duration'), h('dd', null, duration(job) || 'Not started'),
      h('dt', null, 'Result'), h('dd', null, resultText(job) || (LIVE.has(job.status) ? 'Still running' : 'None')),
      h('dt', null, 'Id'), h('dd', null, job.id));
    const lines = Array.isArray(job.log) ? job.log : [];
    pre.textContent = lines.length ? lines.join('\n') : (job.status === 'queued' ? 'Waiting for the job in front of it to finish.' : 'No log lines yet.');
    note.textContent = LIVE.has(job.status) ? 'Updating every 2 seconds. The log keeps the last 200 lines.' : 'The log keeps the last 200 lines.';
    if (!drawn) { body.replaceChildren(facts, pre, note); drawn = true; }
    if (atEnd || !drawn) pre.scrollTop = pre.scrollHeight;
    return !LIVE.has(job.status);
  };
  const tick = async () => {
    const { job } = await api.get(`/admin/jobs/${encodeURIComponent(id)}`);
    if (draw(job) && stop) { stop(); stop = null; }
  };
  tick().then(() => { pre.scrollTop = pre.scrollHeight; }).catch((err) => {
    if (handleAuthError(err)) return;
    body.replaceChildren(h('div', { class: 'notice notice-warn', role: 'alert' },
      err.status === 404 ? 'That job no longer exists.' : `The log could not be loaded. ${errorText(err)}`));
    if (stop) stop();
  });
  stop = poll(tick, 2000);
  return m;
}

/* ───────────── actions ───────────── */

async function reclassify(btn) {
  const ok = await confirmDialog(
    'Reclassify every pull request? Categories and all totals are recomputed from the current rules and decisions. Nothing is fetched from GitHub. This takes about a minute.',
    { title: 'Reclassify', confirmLabel: 'Reclassify' });
  if (!ok) return;
  const res = await act(() => api.post('/admin/jobs/reclassify', {}), { button: btn });
  if (!res) return;
  toast('Started reclassifying every pull request.');
  refresh();
}

async function refreshRepoMeta(btn) {
  const ok = await confirmDialog(
    'Read the metadata of every stored project from GitHub again? Stars, main language, languages by size and topics are refreshed, then technology areas and totals are recomputed. Projects refreshed in the last 7 days are skipped, so running it again after a stop continues where it left off. About 40 projects per request: a few minutes for the whole list.',
    { title: 'Refresh repo metadata', confirmLabel: 'Refresh' });
  if (!ok) return;
  const res = await act(() => api.post('/admin/jobs/repo-meta', {}), { button: btn });
  if (!res) return;
  toast('Started refreshing the project metadata.');
  refresh();
}

/* ───────────── page ───────────── */

function jobsTable(data, show) {
  return table({
    caption: 'Jobs, newest first', compact: true, sticky: false,
    rows: data.items,
    empty: 'No jobs match. Jobs appear here when a sync, a history fetch or a reclassify runs.',
    columns: [
      { key: 'createdAt', label: 'Started', class: 'nowrap', render: (j) => h('span', { title: `Created ${fmt.datetime(j.createdAt)}` }, j.startedAt ? fmt.datetime(j.startedAt) : 'Not yet') },
      { key: 'type', label: 'Type', render: (j) => h('div', { title: TYPE_HELP[j.type] }, TYPE_LABELS[j.type] || j.type, scope(j) ? h('div', { class: 'sub cell-clip' }, scope(j)) : null) },
      { key: 'runner', label: 'Runs on', title: 'App: the nightly fetch or started here. Script: run from a terminal.', render: (j) => RUNNER_LABELS[j.runner] || j.runner },
      { key: 'status', label: 'Status', render: (j) => stateBadge(j.status) },
      { key: 'progress', label: 'Progress', render: progressCell },
      { key: 'summary', label: 'Result', wrap: true, render: resultText },
      { key: 'duration', label: 'Duration', class: 'nowrap', render: duration },
      { key: 'log', label: 'Log', render: (j) => h('button', { type: 'button', class: 'btn btn-sm', name: `log-${j.id}`, onClick: () => show(j.id) }, 'View log') },
    ],
  });
}

export default async function (el, ctx) {
  const q = ctx.query;
  const params = { type: q.type, status: q.status, page: q.page };
  const data = await api.get('/admin/jobs', params);

  const status = h('div', { role: 'status' });
  const list = card({ flush: true });
  const show = (id) => openLog(id, () => { if (q.job) setQuery({ job: '' }, { replace: true }); });
  const render = (d) => {
    const running = d.items.filter((j) => j.status === 'running').length;
    const queued = d.items.filter((j) => j.status === 'queued').length;
    status.replaceChildren(...(running + queued ? [h('div', { class: 'notice' },
      h('strong', null, `${running ? `${fmt.num(running)} running` : ''}${running && queued ? ', ' : ''}${queued ? `${fmt.num(queued)} queued` : ''}. `),
      'Jobs started here run one at a time. This list updates by itself.')] : []));
    status.hidden = !(running + queued);
    list.replaceChildren(jobsTable(d, show), pagination({ ...d, onPage: (page) => setQuery({ page: page > 1 ? page : '' }) }));
  };
  render(data);
  const scheduled = scheduledFetch({ showLog: show, onChange: async () => render(await api.get('/admin/jobs', params)) });
  await scheduled.load();

  const reclassifyBtn = h('button', { type: 'button', class: 'btn', name: 'reclassify' }, 'Reclassify');
  reclassifyBtn.addEventListener('click', () => reclassify(reclassifyBtn));
  const metaBtn = h('button', { type: 'button', class: 'btn', name: 'repo-meta', title: TYPE_HELP.repoMeta }, 'Refresh repo metadata');
  metaBtn.addEventListener('click', () => refreshRepoMeta(metaBtn));
  el.append(
    pageHead({
      title: 'Jobs',
      lede: 'Fetches from GitHub and recomputations, newest first. New work is fetched every night; start one here when you cannot wait.',
      actions: [metaBtn, reclassifyBtn],
    }),
    scheduled.el,
    status,
    filterBar({
      fields: [
        { name: 'type', label: 'Type', type: 'select', options: Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label })) },
        { name: 'status', label: 'Status', type: 'select', options: [['queued', 'Queued'], ['running', 'Running'], ['done', 'Done'], ['error', 'Failed'], ['cancelled', 'Cancelled']].map(([value, label]) => ({ value, label })) },
      ],
      values: q,
      onChange: (v) => setQuery({ ...v, page: '' }),
    }),
    list);

  if (q.job) show(q.job);

  // Re-read in place: the scheduled-fetch panel every 2 s while a fetch runs (progress and log tail), otherwise every
  // 6 s like the list. That also picks up jobs started elsewhere (the nightly run, a history fetch queued from Students).
  let n = 0;
  return poll(async () => {
    n++;
    const wasRunning = scheduled.isRunning();
    if (wasRunning || n % 3 === 0) await scheduled.load();
    if (n % 3 === 0 || wasRunning !== scheduled.isRunning()) render(await api.get('/admin/jobs', params));
  }, 2000);
}
