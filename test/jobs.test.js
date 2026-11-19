// Job runner, ingest edge cases and the legacy import against a real mongod.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMongo } from './helpers/mongo.js';
import { startApp } from './helpers/app.js';
import { insertStudents, prNode } from './helpers/fixtures.js';
import { collections, ensureIndexes } from '../src/db.js';
import { refreshAggregates, upsertPRs } from '../src/ingest.js';
import { invalidateContext, reclassifyAll } from '../src/classify.js';
import { loadRules, saveRules } from '../src/rules.js';
import { enqueue, registerHandler, runInline, startRunner, unregisterHandler, whenIdle } from '../src/jobs.js';
import { importLegacy } from '../scripts/import_legacy.js';

let mongo;
before(async () => { mongo = await startMongo(); });
after(async () => { await mongo?.stop(); });
const freshDb = () => mongo.client.db(`t_${Math.random().toString(16).slice(2, 10)}`);

test('jobs: app jobs run one at a time in order; errors are recorded', async () => {
  const db = freshDb();
  const { jobs } = collections(db);
  const events = [];
  let running = 0;
  let maxRunning = 0;
  registerHandler('sync', async (d, params, ctx) => {
    running++; maxRunning = Math.max(maxRunning, running);
    events.push(`start ${params.n}`);
    ctx.log(`working on ${params.n}`);
    ctx.progress(1, 2);
    await new Promise((r) => setTimeout(r, 30));
    ctx.progress(2, 2);
    events.push(`end ${params.n}`);
    running--;
    if (params.fail) throw new Error('boom');
    return { students: 1, ok: 1, failed: 0, prs: params.n, renamed: 0, notFound: 0 };
  });
  try {
    const a = await enqueue(db, 'sync', { n: 1 });
    assert.deepEqual([a.status, a.runner, a.type, a.params, a.progress, a.log, a.summary, a.error], ['queued', 'app', 'sync', { n: 1 }, { done: 0, total: 0 }, [], null, null]);
    assert.match(a._id, /^[0-9a-f]{12}$/);
    const b = await enqueue(db, 'sync', { n: 2, fail: true });
    const cJob = await enqueue(db, 'sync', { n: 3 });
    await whenIdle(db);
    assert.deepEqual(events, ['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
    assert.equal(maxRunning, 1);
    const [da, dbb, dc] = await Promise.all([a, b, cJob].map((j) => jobs.findOne({ _id: j._id })));
    assert.deepEqual([da.status, da.summary.prs, da.progress, da.error], ['done', 1, { done: 2, total: 2 }, null]);
    assert.ok(da.startedAt >= da.createdAt && da.finishedAt >= da.startedAt);
    assert.match(da.log[0], /^\d\d:\d\d:\d\d working on 1$/);
    assert.deepEqual([dbb.status, dbb.error, dbb.summary], ['error', 'boom', null]);
    assert.match(dbb.log.at(-1), /error: boom$/);
    assert.equal(dc.status, 'done', 'a failed job does not stop the queue');
    await assert.rejects(() => enqueue(db, 'nonsense', {}), /unknown job type/);
  } finally { unregisterHandler('sync'); }
});

test('jobs: log keeps the last 200 lines; runInline returns the finished doc (runner cli)', async () => {
  const db = freshDb();
  registerHandler('backfill', async (d, params, ctx) => {
    for (let i = 1; i <= 450; i++) ctx.log(`line ${i}`);
    return { students: 0, ok: 0, failed: 0, prs: 0, renamed: 0, notFound: 0 };
  });
  try {
    const job = await runInline(db, 'backfill', { pending: true }, { echo: false });
    assert.deepEqual([job.status, job.runner, job.params, job.log.length], ['done', 'cli', { pending: true }, 200]);
    assert.match(job.log[0], /line 251$/);
    assert.match(job.log.at(-1), /line 450$/);
    registerHandler('backfill', async () => { throw new Error('github down'); });
    const failed = await runInline(db, 'backfill', {}, { echo: false });
    assert.deepEqual([failed.status, failed.error], ['error', 'github down']);
    assert.ok(failed.finishedAt instanceof Date);
  } finally { unregisterHandler('backfill'); }
});

test('jobs: startRunner marks interrupted app jobs and resumes queued ones; cli jobs are left alone', async () => {
  const db = freshDb();
  const { jobs } = collections(db);
  const now = new Date();
  const base = { params: {}, createdAt: now, startedAt: now, finishedAt: null, progress: { done: 0, total: 0 }, summary: null, log: [], error: null };
  await jobs.insertMany([
    { ...base, _id: 'aaaaaaaaaaaa', type: 'reclassify', runner: 'app', status: 'running' },
    { ...base, _id: 'bbbbbbbbbbbb', type: 'sync', runner: 'cli', status: 'running' },
    { ...base, _id: 'cccccccccccc', type: 'reclassify', runner: 'app', status: 'queued', startedAt: null },
    { ...base, _id: 'dddddddddddd', type: 'sync', runner: 'cli', status: 'running', startedAt: new Date(now.getTime() - 7 * 3600 * 1000) },
  ]);
  await startRunner(db);
  await whenIdle(db);
  const get = async (id) => jobs.findOne({ _id: id });
  assert.deepEqual([(await get('aaaaaaaaaaaa')).status, (await get('aaaaaaaaaaaa')).error], ['error', 'interrupted']);
  assert.ok((await get('aaaaaaaaaaaa')).finishedAt instanceof Date);
  assert.equal((await get('bbbbbbbbbbbb')).status, 'running');
  // a cli job that was killed hard hours ago can never finish: it is marked failed
  assert.deepEqual([(await get('dddddddddddd')).status, /^interrupted/.test((await get('dddddddddddd')).error)], ['error', true]);
  const resumed = await get('cccccccccccc');
  assert.deepEqual([resumed.status, resumed.summary], ['done', { prs: 0, repos: 0, prsChanged: 0, reposChanged: 0 }]);
});

test('ingest: githubId, re-ingest updates in place, star drift reclassifies the other PRs of a repo', async () => {
  const db = freshDb();
  const c = collections(db);
  await ensureIndexes(db);
  const [alice, bob] = await insertStudents(db, [{ username: 'Alice' }, { username: 'Bob' }]);
  invalidateContext();
  assert.deepEqual(await upsertPRs(db, alice, []), { prs: 0, repos: 0 });
  assert.deepEqual(await upsertPRs(db, alice, [prNode({ repo: 'grow/lib', number: 1, stars: 40 }), prNode({ repo: 'grow/lib', number: 1, stars: 40 }), prNode({ repo: 'p/q', number: 2, isPrivate: true })]), { prs: 1, repos: 1 });
  assert.equal((await c.prs.findOne({ number: 1 })).category, 'low_signal');
  assert.equal((await c.students.findOne({ _id: 'alice' })).githubId, null);
  // Bob's later fetch sees the repo at 60 stars: Alice's PR in the same repo follows
  const res = await upsertPRs(db, bob, [prNode({ repo: 'grow/lib', number: 2, stars: 60, state: 'OPEN', author: { login: 'Bob', databaseId: 777 }, updatedAt: '2026-11-02T00:00:00Z' })]);
  assert.deepEqual(res, { prs: 1, repos: 1 });
  assert.equal((await c.students.findOne({ _id: 'bob' })).githubId, 777);
  assert.deepEqual((await c.prs.find({}).sort({ number: 1 }).toArray()).map((p) => [p.category, p.tier, p.stars]), [['open_source', 'emerging', 60], ['open_source', 'emerging', 60]]);
  assert.deepEqual([(await c.repos.findOne({ _id: 'grow/lib' })).category, await c.repos.countDocuments({}), await c.owners.countDocuments({})], ['open_source', 1, 1]);
  // githubId is not overwritten once set
  await upsertPRs(db, bob, [prNode({ repo: 'grow/lib', number: 2, stars: 60, state: 'MERGED', author: { login: 'Bob', databaseId: 999 } })]);
  assert.equal((await c.students.findOne({ _id: 'bob' })).githubId, 777);
  assert.deepEqual([await c.prs.countDocuments({}), (await c.prs.findOne({ number: 2 })).state], [2, 'merged']);
  // upsertPRs leaves aggregates alone
  assert.equal((await c.students.findOne({ _id: 'bob' })).stats.totalPrs, 0);
  await refreshAggregates(db);
  assert.deepEqual([(await c.students.findOne({ _id: 'bob' })).stats.osMerged, (await c.repos.findOne({ _id: 'grow/lib' })).stats.students], [1, 2]);
  // rules are read from the settings doc
  await saveRules(db, { ...(await loadRules(db)), minStarsOrgRepo: 100 });
  const r = await reclassifyAll(db);
  assert.deepEqual([r.prs, r.prsChanged, r.repos, r.reposChanged], [2, 2, 1, 1]);
  assert.equal((await c.students.findOne({ _id: 'bob' })).stats.osMerged, 0);
});

test('admin add student: validated against GitHub when a token is configured', async () => {
  const db = freshDb();
  await ensureIndexes(db);
  await insertStudents(db, [{ username: 'Existing' }]);
  registerHandler('backfill', async () => ({ students: 1, ok: 1, failed: 0, prs: 0, renamed: 0, notFound: 0 }));
  const calls = [];
  const github = {
    async getUser(login, opts) {
      calls.push([login, opts?.token]);
      if (login === 'ghost') return null;
      if (login === 'offline') throw new Error('network down');
      if (login === 'old-name') return { login: 'Existing', id: 5, name: 'Renamed' };
      return { login: 'OctoCat', id: 583231, name: 'The Octocat' };
    },
  };
  const app = await startApp(db, { githubToken: 'test-token' }, { github });
  try {
    await app.login();
    const ghost = await app.post('/api/admin/students', { username: 'ghost', campus: 'RU', batch: 2026 });
    assert.deepEqual([ghost.status, ghost.body.error.code], [400, 'bad_request']);
    assert.match(ghost.body.error.message, /does not exist/);
    const ok = await app.post('/api/admin/students', { username: 'github.com/octocat', name: '', campus: 'RU', batch: 2026 });
    assert.equal(ok.status, 201);
    assert.deepEqual([ok.body.student.username, ok.body.student.githubId, ok.body.student.name, ok.body.student.nameSource], ['OctoCat', 583231, 'The Octocat', 'github profile']);
    assert.deepEqual(calls.at(-1), ['octocat', 'test-token']);
    assert.equal((await collections(db).students.findOne({ _id: 'octocat' })).username, 'OctoCat');
    // the canonical login belongs to a student we already track
    assert.equal((await app.post('/api/admin/students', { username: 'old-name', campus: 'RU' })).status, 409);
    // GitHub unreachable: accepted as typed, the backfill sorts it out
    const off = await app.post('/api/admin/students', { username: 'offline', name: 'Typed Name', campus: 'RU' });
    assert.deepEqual([off.status, off.body.student.username, off.body.student.githubId, off.body.student.nameSource], [201, 'offline', null, 'sheet']);
    await whenIdle(db);
  } finally { await app.close(); unregisterHandler('backfill'); }
});

test('import_legacy: imports csv + raw files, is idempotent and preserves overrides and admin edits', async () => {
  const db = freshDb();
  const c = collections(db);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oss-import-'));
  try {
    await mkdir(path.join(dir, 'raw'));
    await writeFile(path.join(dir, 'students.csv'), [
      'campus,year,batch,name,github_username,github_profile,email,enrolment_no,name_source,sources,notes',
      'ADYPU,1st year,2026,"Karva, Aarush",AarushK,https://github.com/AarushK,a@example.org,E26,sheet,Sheet A; OSS tracker (x); Form,"note, with comma"',
      'RU,9th year,,,NoBatch,https://github.com/NoBatch,,,,,',
      'Mars,1st year,2025,Odd Campus,OddCampus,,,,github profile,Sheet B,',
      'RU,2nd year,2025,No Raw,NoRaw,,,,sheet,Sheet B,',
      'RU,2nd year,2025,Failed Fetch,Failed,,,,sheet,Sheet B,',
    ].join('\n') + '\n');
    const raw = (user, prs, error = '') => writeFile(path.join(dir, 'raw', `${user.toLowerCase()}.json`), JSON.stringify({ user, count: prs.length, prs, error }));
    await raw('AarushK', [
      prNode({ repo: 'apache/airflow', number: 1, createdAt: '2026-10-01T10:00:00Z', mergedAt: '2026-10-20T08:00:00Z' }),
      prNode({ repo: 'AarushK/dotfiles', number: 2, ownerType: 'User', stars: 0 }),
      prNode({ repo: 'NoBatch/project', number: 3, ownerType: 'User', stars: 1 }),
      prNode({ repo: 'corp/private', number: 4, isPrivate: true }),
      null,
      prNode({ repo: 'apache/airflow', number: 1 }),
    ]);
    await raw('NoBatch', []);
    await raw('OddCampus', [prNode({ repo: 'apache/airflow', number: 5, state: 'OPEN', createdAt: '2026-09-01T00:00:00Z' })]);
    await raw('Failed', [prNode({ repo: 'tiny/x', number: 6, stars: 1 })], '[{"message":"gave up"}]');
    await raw('Stranger', [prNode({ repo: 'apache/airflow', number: 7 })]);

    const lines = [];
    const first = await importLegacy(db, { data: dir }, { log: (l) => lines.push(l), progress() {} });
    assert.deepEqual({ ...first, ms: 0 }, {
      students: 5, studentsAdded: 5, rawFiles: 5, prs: 5, repos: 4, owners: 4, skippedPrivate: 1, missingRaw: 1, unknownRaw: 1, fetchErrors: 1,
      byCategory: { open_source: 2, own_repo: 1, peer_repo: 1, low_signal: 1 }, lastSyncedAt: '2026-10-17T08:00:00.000Z', ms: 0,
    });
    assert.ok(lines.some((l) => /stranger\.json/.test(l)));

    const a = await c.students.findOne({ _id: 'aarushk' });
    assert.deepEqual([a.username, a.name, a.nameSource, a.campus, a.batch, a.email, a.enrolmentNo, a.sources, a.notes, a.active, a.addedBy, a.backfill.status],
      ['AarushK', 'Karva, Aarush', 'sheet', 'ADYPU', 2026, 'a@example.org', 'E26', ['Sheet A', 'OSS tracker (x)', 'Form'], 'note, with comma', true, 'import', 'done']);
    assert.equal(a.lastSyncedAt.toISOString(), '2026-10-17T08:00:00.000Z', 'latest PR timestamp in the dataset minus 3 days');
    assert.deepEqual([a.stats.totalPrs, a.stats.osMerged, a.stats.byCategory.own_repo, a.stats.byCategory.peer_repo], [3, 1, 1, 1]);
    assert.equal('year' in a || 'github_profile' in a, false);
    const nb = await c.students.findOne({ _id: 'nobatch' });
    assert.deepEqual([nb.batch, nb.name, nb.nameSource, nb.sources, nb.backfill.status, nb.stats.totalPrs], [null, '', '', [], 'done', 0]);
    assert.equal((await c.students.findOne({ _id: 'oddcampus' })).campus, 'Unknown');
    const noRaw = await c.students.findOne({ _id: 'noraw' });
    assert.deepEqual([noRaw.backfill.status, noRaw.lastSyncedAt], ['pending', null]);
    const failed = await c.students.findOne({ _id: 'failed' });
    assert.deepEqual([failed.backfill.status, failed.backfill.error, failed.lastSyncedAt, failed.stats.totalPrs], ['error', '[{"message":"gave up"}]', null, 1]);
    assert.equal(await c.students.countDocuments({ _id: 'stranger' }), 0);
    assert.equal(await c.prs.countDocuments({ number: 7 }), 0);
    assert.equal(await c.prs.countDocuments({ repoLc: 'corp/private' }), 0);
    const pr = await c.prs.findOne({ _id: 'https://github.com/apache/airflow/pull/1' });
    assert.deepEqual([pr.author, pr.authorLogin, pr.campus, pr.batch, pr.active, pr.category, pr.tier, pr.override, pr.updatedAt], ['aarushk', 'AarushK', 'ADYPU', 2026, true, 'open_source', 'major', null, null]);
    assert.equal((await c.settings.findOne({ _id: 'rules' })).minStarsOrgRepo, 50);
    assert.ok((await c.prs.indexes()).some((i) => i.name === 'author_1_createdAt_-1'));

    // admin work between two imports
    await c.prs.updateOne({ _id: pr._id }, { $set: { override: 'not_open_source', overrideNote: 'spam', overrideAt: new Date() } });
    await c.repos.updateOne({ _id: 'tiny/x' }, { $set: { override: 'include', overrideNote: 'ok', overrideAt: new Date() } });
    await c.students.updateOne({ _id: 'aarushk' }, { $set: { campus: 'RU', name: 'Edited Name', notes: 'edited', lastSyncedAt: new Date('2026-11-18T00:00:00Z') } });
    await c.students.updateOne({ _id: 'oddcampus' }, { $set: { active: false } });
    const counts = async () => Promise.all([c.students, c.prs, c.repos, c.owners].map((x) => x.countDocuments({})));
    const beforeCounts = await counts();

    const second = await importLegacy(db, { data: dir, fetchedAt: '2026-11-19T00:00:00Z' });
    assert.deepEqual([second.studentsAdded, second.prs, second.lastSyncedAt], [0, 5, '2026-11-19T00:00:00.000Z']);
    assert.deepEqual(await counts(), beforeCounts);
    const a2 = await c.students.findOne({ _id: 'aarushk' });
    assert.deepEqual([a2.campus, a2.name, a2.notes, a2.lastSyncedAt.toISOString()], ['RU', 'Edited Name', 'edited', '2026-11-18T00:00:00.000Z']);
    const pr2 = await c.prs.findOne({ _id: pr._id });
    assert.deepEqual([pr2.override, pr2.overrideNote, pr2.category, pr2.campus], ['not_open_source', 'spam', 'low_signal', 'RU']);
    assert.deepEqual([(await c.repos.findOne({ _id: 'tiny/x' })).override, (await c.prs.findOne({ number: 6 })).category], ['include', 'open_source']);
    assert.deepEqual([(await c.students.findOne({ _id: 'oddcampus' })).active, (await c.prs.findOne({ number: 5 })).active], [false, false]);
    assert.equal(a2.stats.osMerged, 0);

    await assert.rejects(() => importLegacy(freshDb(), { data: dir, fetchedAt: 'not a date' }), /invalid --fetched-at/);
    await assert.rejects(() => importLegacy(freshDb(), { data: path.join(dir, 'missing') }), /ENOENT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
