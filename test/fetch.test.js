// Sync / backfill handlers and scripts against a real mongod and an in-memory GitHub (mocked fetch).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startMongo } from './helpers/mongo.js';
import { fakeSleep, mockGitHub } from './helpers/github.js';
import { insertStudents, prNode } from './helpers/fixtures.js';
import { collections, ensureIndexes } from '../src/db.js';
import { refreshAggregates, upsertPRs } from '../src/ingest.js';
import { invalidateContext, reclassify } from '../src/classify.js';
import { runInline } from '../src/jobs.js';
import { backfill, sync, MAX_CONSECUTIVE_FAILURES } from '../src/jobHandlers.js';
import { parseArgs, totalFailure } from '../scripts/_cli.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NOW = new Date('2026-11-19T21:00:00Z');
const LAST = new Date('2026-11-18T21:00:00Z'); // previous successful sync

let mongo;
before(async () => { mongo = await startMongo(); });
after(async () => { await mongo?.stop(); });

async function freshDb() {
  const db = mongo.client.db(`t_${Math.random().toString(16).slice(2, 10)}`);
  await ensureIndexes(db);
  invalidateContext();
  return db;
}
function ctxOf() {
  const lines = [];
  const progress = [];
  return { lines, progressCalls: progress, log: (l) => lines.push(l), progress: (d, t) => progress.push([d, t]) };
}
function harness(users) {
  const gh = mockGitHub({ users });
  const sleep = fakeSleep();
  return { gh, sleep, opts: { fetch: gh.fetch, token: 'test-token', sleep, now: () => NOW, concurrency: 2 } };
}
const author = (login, id) => ({ login, databaseId: id });

test('sync (incremental): asks only for recently updated PRs, upserts only the changed ones, keeps overrides', async () => {
  const db = await freshDb();
  const c = collections(db);
  const [alice] = await insertStudents(db, [{ username: 'Alice', campus: 'RU', batch: 2025, lastSyncedAt: LAST, githubId: 42, loginCheckedAt: LAST }]);
  const A = author('Alice', 42);
  const unchanged = prNode({ repo: 'apache/airflow', number: 1, state: 'MERGED', updatedAt: '2026-11-17T00:00:00Z', author: A });
  const opened = prNode({ repo: 'apache/airflow', number: 2, state: 'OPEN', createdAt: '2026-11-15T10:00:00Z', updatedAt: '2026-11-15T10:00:00Z', author: A });
  const overridden = prNode({ repo: 'tiny/tool', number: 3, stars: 3, state: 'OPEN', createdAt: '2026-11-16T10:00:00Z', updatedAt: '2026-11-16T10:00:00Z', author: A });
  await upsertPRs(db, alice, [unchanged, opened, overridden]);
  await c.prs.updateOne({ _id: overridden.url }, { $set: { override: 'open_source', overrideNote: 'checked by hand', overrideAt: LAST } });
  await reclassify(db, { prFilter: { _id: overridden.url }, repoFilter: null });
  await refreshAggregates(db);
  assert.equal((await c.students.findOne({ _id: 'alice' })).stats.osMerged, 1);

  // GitHub now: #2 and #3 got merged, #4 is new; #1 comes back in the 2-day overlap with the same updatedAt; #5 is older than the window
  const { gh, opts } = harness([{ login: 'Alice', id: 42, prs: [
    { ...unchanged, title: 'TITLE THAT MUST NOT BE WRITTEN' }, // same updatedAt as stored: must be skipped
    { ...opened, state: 'MERGED', mergedAt: '2026-11-19T08:00:00Z', closedAt: '2026-11-19T08:00:00Z', updatedAt: '2026-11-19T08:00:00Z' },
    { ...overridden, state: 'MERGED', mergedAt: '2026-11-19T09:00:00Z', closedAt: '2026-11-19T09:00:00Z', updatedAt: '2026-11-19T09:00:00Z' },
    prNode({ repo: 'kubernetes/kubernetes', number: 4, stars: 90000, state: 'OPEN', createdAt: '2026-11-19T10:00:00Z', updatedAt: '2026-11-19T10:00:00Z', author: A }),
    prNode({ repo: 'old/thing', number: 5, state: 'MERGED', createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-03T10:00:00Z', author: A }),
  ] }]);
  const ctx = ctxOf();
  const summary = await sync(db, {}, ctx, opts);

  assert.equal(gh.graphql().length, 1);
  assert.equal(gh.graphql()[0].q, 'author:Alice type:pr updated:>=2026-11-16', 'since = lastSyncedAt - 2 days');
  assert.equal(gh.rest().length, 0, 'no user lookups on a normal incremental run');
  assert.deepEqual(
    { students: summary.students, ok: summary.ok, failed: summary.failed, prs: summary.prs, renamed: summary.renamed, notFound: summary.notFound },
    { students: 1, ok: 1, failed: 0, prs: 3, renamed: 0, notFound: 0 });
  assert.deepEqual({ prsNew: summary.prsNew, prsUpdated: summary.prsUpdated, newMerged: summary.newMerged, checked: summary.studentsChecked, rl: summary.rateLimitRemaining },
    { prsNew: 1, prsUpdated: 2, newMerged: 2, checked: 1, rl: 4900 });

  const byUrl = new Map((await c.prs.find({}).toArray()).map((p) => [p._id, p]));
  assert.equal(byUrl.size, 4, 'the old PR outside the window was not fetched');
  assert.equal(byUrl.get(unchanged.url).title, 'Fix a thing', 'unchanged PR was not rewritten');
  assert.equal(byUrl.get(opened.url).state, 'merged');
  const ov = byUrl.get(overridden.url);
  assert.equal(ov.state, 'merged');
  assert.equal(ov.override, 'open_source');
  assert.equal(ov.overrideNote, 'checked by hand');
  assert.equal(ov.category, 'open_source', 'override still decides the category after the upsert');
  assert.equal(byUrl.get('https://github.com/kubernetes/kubernetes/pull/4').author, 'alice');

  const s = await c.students.findOne({ _id: 'alice' });
  assert.equal(s.lastSyncedAt.toISOString(), NOW.toISOString(), 'lastSyncedAt = start of this fetch');
  assert.equal(s.backfill.status, 'done');
  assert.equal(s.stats.totalPrs, 4);
  assert.equal(s.stats.osMerged, 3);
  assert.equal(s.stats.osPrs, 4);
  assert.equal((await c.repos.findOne({ _id: 'kubernetes/kubernetes' })).stats.prs, 1);
  assert.deepEqual(ctx.progressCalls.at(-1), [1, 1]);

  // nothing changed on GitHub: the next run writes nothing
  const again = await sync(db, {}, ctxOf(), opts);
  assert.equal(again.prs, 0);
  assert.equal(again.ok, 1);
});

test('sync: first window is 3 days when lastSyncedAt is missing; private repos are never stored', async () => {
  const db = await freshDb();
  const c = collections(db);
  await insertStudents(db, [{ username: 'bob', lastSyncedAt: null }]);
  const { gh, opts } = harness([{ login: 'bob', id: 7, prs: [
    prNode({ repo: 'secret/repo', number: 1, isPrivate: true, createdAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-19T00:00:00Z', author: author('bob', 7) }),
    prNode({ repo: 'apache/airflow', number: 2, createdAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-19T00:00:00Z', author: author('bob', 7) }),
  ] }]);
  const summary = await sync(db, {}, ctxOf(), opts);
  assert.equal(gh.graphql()[0].q, 'author:bob type:pr updated:>=2026-11-16');
  assert.equal(summary.prs, 1);
  assert.equal(summary.prsNew, 1);
  assert.deepEqual((await c.prs.find({}).toArray()).map((p) => p.repo), ['apache/airflow']);
  assert.equal((await c.students.findOne({ _id: 'bob' })).githubId, 7, 'githubId learned from the PR author');
});

test('backfill: a newly added student gets the full history and all aggregates are updated', async () => {
  const db = await freshDb();
  const c = collections(db);
  const [old] = await insertStudents(db, [
    { username: 'oldhand', campus: 'RU', batch: 2024 },
    { username: 'NewKid', campus: 'ADYPU', batch: 2026, backfill: { status: 'pending', at: LAST }, lastSyncedAt: null, addedBy: 'admin' },
    { username: 'other-pending', backfill: { status: 'pending', at: LAST }, lastSyncedAt: null },
  ]);
  await upsertPRs(db, old, [prNode({ repo: 'apache/airflow', number: 900 })]);
  await refreshAggregates(db);

  const K = author('NewKid', 1001);
  const history = [
    ...Array.from({ length: 60 }, (_, i) => prNode({ repo: 'apache/airflow', number: i + 1, state: i < 40 ? 'MERGED' : 'OPEN',
      createdAt: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(), updatedAt: new Date(Date.UTC(2025, 0, 2 + i)).toISOString(), author: K })),
    prNode({ repo: 'NewKid/dotfiles', number: 1, stars: 0, ownerType: 'User', createdAt: '2024-05-01T00:00:00Z', updatedAt: '2024-05-01T00:00:00Z', author: K }),
    prNode({ repo: 'smallorg/lib', number: 5, stars: 120, createdAt: '2026-08-01T00:00:00Z', mergedAt: '2026-08-02T00:00:00Z', updatedAt: '2026-08-02T00:00:00Z', author: K }),
    prNode({ repo: 'hidden/private', number: 9, isPrivate: true, updatedAt: '2026-08-02T00:00:00Z', author: K }),
  ];
  const { gh, sleep, opts } = harness([{ login: 'NewKid', id: 1001, name: 'New Kid', prs: history }]);
  const ctx = ctxOf();
  const summary = await backfill(db, { users: ['newkid'] }, ctx, opts);

  assert.deepEqual(gh.graphql().map((x) => [x.q, x.after]), [['author:NewKid type:pr', null], ['author:NewKid type:pr', '50']], 'full history, no updated: filter, paginated');
  assert.deepEqual(sleep.calls, [300]);
  assert.deepEqual(
    { students: summary.students, ok: summary.ok, failed: summary.failed, prs: summary.prs, renamed: summary.renamed, notFound: summary.notFound },
    { students: 1, ok: 1, failed: 0, prs: 62, renamed: 0, notFound: 0 }, 'only the named student, private PR skipped');
  assert.equal(summary.prsNew, 62);
  assert.equal(summary.newMerged, 42);

  const s = await c.students.findOne({ _id: 'newkid' });
  assert.equal(s.backfill.status, 'done');
  assert.equal(s.backfill.error, undefined);
  assert.equal(s.lastSyncedAt.toISOString(), NOW.toISOString());
  assert.equal(s.githubId, 1001);
  assert.deepEqual(
    { total: s.stats.totalPrs, merged: s.stats.mergedPrs, os: s.stats.osPrs, osMerged: s.stats.osMerged, osOpen: s.stats.osOpen, major: s.stats.osMajorMerged, repos: s.stats.osRepos, orgs: s.stats.osOrgs, own: s.stats.byCategory.own_repo },
    { total: 62, merged: 42, os: 61, osMerged: 41, osOpen: 20, major: 40, repos: 2, orgs: 2, own: 1 });
  assert.equal(s.stats.firstPrAt.toISOString(), '2024-05-01T00:00:00.000Z');
  assert.equal(s.stats.lastOsMergedAt.toISOString(), '2026-10-03T10:00:00.000Z'); // fixture default mergedAt of the airflow PRs

  const airflow = await c.repos.findOne({ _id: 'apache/airflow' });
  assert.deepEqual({ prs: airflow.stats.prs, merged: airflow.stats.merged, students: airflow.stats.students, campuses: airflow.stats.campuses },
    { prs: 61, merged: 41, students: 2, campuses: ['ADYPU', 'RU'] });
  const apache = await c.owners.findOne({ _id: 'apache' });
  assert.deepEqual({ prs: apache.stats.prs, osMerged: apache.stats.osMerged, students: apache.stats.students }, { prs: 61, osMerged: 41, students: 2 });
  assert.equal(await c.prs.countDocuments({ repoLc: 'hidden/private' }), 0);
  assert.equal((await c.students.findOne({ _id: 'other-pending' })).backfill.status, 'pending', 'not part of this run');
  assert.equal((await c.students.findOne({ _id: 'oldhand' })).stats.totalPrs, 1);
  assert.ok(ctx.lines.some((l) => /newkid: 62 PRs saved/.test(l)));

  // --pending picks up the rest; an account with no PRs at all is still a successful backfill
  gh.addUser({ login: 'other-pending', id: 1002, name: 'No Prs' });
  const pending = await backfill(db, { pending: true }, ctxOf(), opts);
  assert.deepEqual({ students: pending.students, ok: pending.ok, prs: pending.prs, notFound: pending.notFound }, { students: 1, ok: 1, prs: 0, notFound: 0 });
  const o = await c.students.findOne({ _id: 'other-pending' });
  assert.equal(o.backfill.status, 'done');
  assert.equal(o.githubId, 1002, 'id resolved through the account check');
});

test('backfill + sync: unknown GitHub users are marked not_found, never crash the run and are skipped afterwards', async () => {
  const db = await freshDb();
  const c = collections(db);
  await insertStudents(db, [
    { username: 'ghost', backfill: { status: 'pending', at: LAST }, lastSyncedAt: null },
    { username: 'real', backfill: { status: 'pending', at: LAST }, lastSyncedAt: null },
  ]);
  const { gh, opts } = harness([{ login: 'real', id: 5, prs: [prNode({ repo: 'apache/airflow', number: 1, author: author('real', 5), updatedAt: '2026-10-03T10:00:00Z' })] }]);
  const summary = await backfill(db, { pending: true }, ctxOf(), opts);
  assert.deepEqual(
    { students: summary.students, ok: summary.ok, failed: summary.failed, prs: summary.prs, notFound: summary.notFound },
    { students: 2, ok: 1, failed: 0, prs: 1, notFound: 1 });
  const ghost = await c.students.findOne({ _id: 'ghost' });
  assert.equal(ghost.backfill.status, 'error');
  assert.equal(ghost.backfill.error, 'not_found');
  assert.equal(ghost.lastSyncedAt, null);
  assert.equal(ghost.unresolvedSince.toISOString(), NOW.toISOString());
  assert.deepEqual(gh.rest().map((x) => x.path).sort(), ['/users/ghost', '/users/real'], 'students without a GitHub id are looked up once (and only once)');
  assert.equal((await c.students.findOne({ _id: 'real' })).githubId, 5);

  // daily sync: the not_found student is skipped (no GitHub calls for it), the other one is incremental
  gh.calls.length = 0;
  const daily = await sync(db, {}, ctxOf(), opts);
  assert.deepEqual({ students: daily.students, ok: daily.ok, failed: daily.failed, notFound: daily.notFound, skipped: daily.skipped },
    { students: 2, ok: 1, failed: 0, notFound: 0, skipped: 1 });
  assert.ok(gh.calls.every((x) => !/ghost/.test(x.q || x.path)));

  // the account appears (admin fixed the login / re-backfills): resolved again
  gh.addUser({ login: 'ghost', id: 6, prs: [prNode({ repo: 'apache/airflow', number: 2, author: author('ghost', 6), updatedAt: '2026-10-03T10:00:00Z' })] });
  const retry = await backfill(db, { users: ['ghost'] }, ctxOf(), opts);
  assert.equal(retry.ok, 1);
  const fixed = await c.students.findOne({ _id: 'ghost' });
  assert.equal(fixed.backfill.status, 'done');
  assert.equal(fixed.unresolvedSince, undefined);
  assert.equal(fixed.stats.osMerged, 1);

  // logins that are not tracked at all are reported, not fetched
  const none = await backfill(db, { users: ['nobody-here'] }, ctxOf(), opts);
  assert.deepEqual({ students: none.students, ok: none.ok, failed: none.failed, unknown: none.unknown }, { students: 1, ok: 0, failed: 1, unknown: ['nobody-here'] });
});

test('sync: a renamed account is followed through githubId (weekly check), keeping _id and fetching the full history', async () => {
  const db = await freshDb();
  const c = collections(db);
  const eightDaysAgo = new Date(NOW.getTime() - 8 * 86400000);
  const [stu] = await insertStudents(db, [
    { username: 'OldName', githubId: 42, loginCheckedAt: eightDaysAgo, lastSyncedAt: LAST, notes: 'existing note' },
    { username: 'fresh', githubId: 43, loginCheckedAt: new Date(NOW.getTime() - 2 * 86400000), lastSyncedAt: LAST },
    { username: 'peer', lastSyncedAt: LAST },
  ]);
  const N = author('NewName', 42);
  const before2 = prNode({ repo: 'apache/airflow', number: 1, createdAt: '2025-03-01T00:00:00Z', mergedAt: '2025-03-02T00:00:00Z', updatedAt: '2025-03-02T00:00:00Z', author: author('OldName', 42) });
  await upsertPRs(db, stu, [before2]);
  // a peer's PR to a repo of the *new* login, classified before the rename is known
  await upsertPRs(db, await c.students.findOne({ _id: 'peer' }), [prNode({ repo: 'NewName/project', number: 3, stars: 500, ownerType: 'User' })]);
  assert.equal((await c.prs.findOne({ repoLc: 'newname/project' })).category, 'open_source');
  await refreshAggregates(db);

  const { gh, opts } = harness([
    { login: 'NewName', id: 42, prs: [
      { ...before2, author: N },
      prNode({ repo: 'apache/airflow', number: 2, createdAt: '2026-06-01T00:00:00Z', mergedAt: '2026-06-02T00:00:00Z', updatedAt: '2026-06-02T00:00:00Z', author: N }),
    ] },
    { login: 'fresh', id: 43 }, { login: 'peer', id: 44 },
  ]);
  const ctx = ctxOf();
  const summary = await sync(db, {}, ctx, opts);
  assert.deepEqual(
    { students: summary.students, ok: summary.ok, failed: summary.failed, renamed: summary.renamed, notFound: summary.notFound },
    { students: 3, ok: 3, failed: 0, renamed: 1, notFound: 0 });
  assert.deepEqual(gh.rest().map((x) => x.path).sort(), ['/user/42', '/users/peer'], 'only students whose check is older than 7 days (or who have no id yet) are looked up');
  assert.ok(gh.graphql().some((x) => x.q === 'author:NewName type:pr'), 'full fetch under the new login');
  assert.ok(!gh.graphql().some((x) => /author:OldName/.test(x.q)));

  const s = await c.students.findOne({ _id: 'oldname' });
  assert.equal(s.username, 'NewName');
  assert.match(s.notes, /^existing note\n\[2026-11-19\] GitHub login changed: OldName -> NewName$/);
  assert.equal(s.loginCheckedAt.toISOString(), NOW.toISOString());
  assert.equal(s.stats.osMerged, 2);
  assert.equal(await c.students.countDocuments({}), 3, 'no new student doc');
  const prs = await c.prs.find({ author: 'oldname' }).sort({ number: 1 }).toArray();
  assert.deepEqual(prs.map((p) => [p.number, p.authorLogin]), [[1, 'NewName'], [2, 'NewName']]);
  assert.equal((await c.prs.findOne({ repoLc: 'newname/project' })).category, 'peer_repo', 'repos of the new login now belong to a tracked student');
  assert.ok(ctx.lines.some((l) => /login changed OldName -> NewName/.test(l)));

  // next day: no lookup again (checked today), incremental under the new login
  gh.calls.length = 0;
  await sync(db, {}, ctxOf(), opts);
  assert.equal(gh.rest().length, 0);
  assert.ok(gh.graphql().some((x) => x.q === 'author:NewName type:pr updated:>=2026-11-17'));
});

test('backfill: a full fetch that hits not_found resolves the rename through githubId; a deleted account stays not_found', async () => {
  const db = await freshDb();
  const c = collections(db);
  await insertStudents(db, [
    { username: 'was-a', githubId: 77, loginCheckedAt: NOW, backfill: { status: 'pending', at: LAST }, lastSyncedAt: null },
    { username: 'deleted', githubId: 78, loginCheckedAt: new Date(NOW.getTime() - 30 * 86400000), lastSyncedAt: LAST },
  ]);
  const { gh, opts } = harness([{ login: 'now-b', id: 77, prs: [prNode({ repo: 'apache/airflow', number: 1, author: author('now-b', 77), updatedAt: '2026-10-03T10:00:00Z' })] }]);
  const summary = await backfill(db, { users: ['was-a'] }, ctxOf(), opts);
  assert.deepEqual({ ok: summary.ok, renamed: summary.renamed, notFound: summary.notFound, prs: summary.prs }, { ok: 1, renamed: 1, notFound: 0, prs: 1 });
  assert.deepEqual(gh.calls.map((x) => x.q || x.path), ['author:was-a type:pr', '/users/was-a', '/user/77', 'author:now-b type:pr']);
  const s = await c.students.findOne({ _id: 'was-a' });
  assert.equal(s.username, 'now-b');
  assert.equal(s.backfill.status, 'done');
  // the renamed student can be addressed by the new login as well
  assert.equal((await backfill(db, { users: ['NOW-B'] }, ctxOf(), opts)).ok, 1);

  // deleted account: the weekly check finds nothing, the confirming full fetch marks it not_found
  gh.calls.length = 0;
  const daily = await sync(db, { users: ['deleted'] }, ctxOf(), opts);
  assert.deepEqual({ ok: daily.ok, failed: daily.failed, notFound: daily.notFound, renamed: daily.renamed }, { ok: 0, failed: 0, notFound: 1, renamed: 0 });
  assert.deepEqual(gh.calls.map((x) => x.q || x.path), ['/user/78', 'author:deleted type:pr', '/users/deleted']);
  const d = await c.students.findOne({ _id: 'deleted' });
  assert.equal(d.backfill.error, 'not_found');
  assert.ok(d.unresolvedSince instanceof Date);
  assert.equal(d.lastSyncedAt.toISOString(), LAST.toISOString());
});

test('sync: a GitHub failure for one student is counted and does not stop the others; status rules per student', async () => {
  const db = await freshDb();
  const c = collections(db);
  await insertStudents(db, [
    { username: 'flaky', lastSyncedAt: LAST },
    { username: 'flaky-new', backfill: { status: 'pending', at: LAST }, lastSyncedAt: null },
    { username: 'fine', lastSyncedAt: new Date(LAST.getTime() - 86400000) },
    { username: 'errored', backfill: { status: 'error', at: LAST, error: 'gave up: http 502' }, lastSyncedAt: null },
    { username: 'inactive', active: false, lastSyncedAt: LAST },
  ]);
  const n = (login, num) => prNode({ repo: 'apache/airflow', number: num, author: author(login, num), createdAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-19T00:00:00Z' });
  const { gh, sleep, opts } = harness([
    { login: 'flaky', id: 1, prs: [n('flaky', 1)] }, { login: 'flaky-new', id: 2, prs: [n('flaky-new', 2)] },
    { login: 'fine', id: 3, prs: [n('fine', 3)] }, { login: 'errored', id: 4, prs: [n('errored', 4)] }, { login: 'inactive', id: 5, prs: [n('inactive', 5)] },
  ]);
  gh.intercept = (x) => (x.kind === 'graphql' && /author:flaky/.test(x.q) ? new Response('Bad Gateway', { status: 502 }) : undefined);
  const ctx = ctxOf();
  const summary = await sync(db, {}, ctx, opts);
  assert.deepEqual(
    { students: summary.students, ok: summary.ok, failed: summary.failed, prs: summary.prs, notFound: summary.notFound, studentsFailed: summary.studentsFailed },
    { students: 4, ok: 2, failed: 2, prs: 2, notFound: 0, studentsFailed: 2 });
  assert.ok(sleep.calls.length > 0 && sleep.calls.every((ms) => ms <= 12000), 'only short 502 backoffs, all through the injected sleep');

  const get = (id) => c.students.findOne({ _id: id });
  const flaky = await get('flaky');
  assert.equal(flaky.lastSyncedAt.toISOString(), LAST.toISOString(), 'failed incremental: lastSyncedAt untouched');
  assert.equal(flaky.backfill.status, 'done');
  const flakyNew = await get('flaky-new');
  assert.equal(flakyNew.backfill.status, 'error');
  assert.match(flakyNew.backfill.error, /gave up.*502/);
  assert.equal(flakyNew.lastSyncedAt, null);
  assert.equal((await get('fine')).lastSyncedAt.toISOString(), NOW.toISOString());
  const errored = await get('errored');
  assert.equal(errored.backfill.status, 'done', 'earlier (non not_found) error is retried with a full fetch');
  assert.equal(errored.stats.osMerged, 1);
  assert.ok(gh.graphql().some((x) => x.q === 'author:errored type:pr'));
  assert.ok(gh.graphql().some((x) => x.q === 'author:fine type:pr updated:>=2026-11-15'));
  assert.ok(!gh.calls.some((x) => /inactive/.test(x.q || x.path)), 'inactive students are not fetched');
  assert.ok(ctx.lines.some((l) => /^flaky: failed: /.test(l)));

  // params: users (case-insensitive), full, limit (least recently synced first), campus / batch
  gh.intercept = null;
  gh.calls.length = 0;
  const one = await sync(db, { users: ['FINE'], full: true }, ctxOf(), opts);
  assert.deepEqual({ students: one.students, ok: one.ok }, { students: 1, ok: 1 });
  assert.deepEqual(gh.graphql().map((x) => x.q), ['author:fine type:pr']);
  gh.calls.length = 0;
  const limited = await sync(db, { limit: 1 }, ctxOf(), opts);
  assert.equal(limited.students, 1);
  assert.match(gh.graphql()[0].q, /^author:flaky-new type:pr$/, 'never-synced student first');
  const none = await sync(db, { campus: 'SMRU' }, ctxOf(), opts);
  assert.deepEqual({ students: none.students, ok: none.ok, failed: none.failed }, { students: 0, ok: 0, failed: 0 });
  const batch = await sync(db, { campus: 'RU', batch: 2025 }, ctxOf(), opts);
  assert.equal(batch.students, 4);
});

test('sync: a bad token or a GitHub outage aborts the run instead of failing every student slowly', async () => {
  const db = await freshDb();
  const c = collections(db);
  const many = Array.from({ length: MAX_CONSECUTIVE_FAILURES + 15 }, (_, i) => ({ username: `s${i}`, lastSyncedAt: LAST }));
  await insertStudents(db, many);
  const { gh, opts } = harness([]);
  gh.intercept = () => new Response('{"message":"Bad credentials"}', { status: 401 });
  await assert.rejects(sync(db, {}, ctxOf(), opts), /aborted: .*401/);
  assert.ok(gh.graphql().length <= 2, 'stops at once (one request per worker)');

  gh.calls.length = 0;
  gh.intercept = () => new Response('Bad Gateway', { status: 502 });
  await assert.rejects(sync(db, {}, ctxOf(), opts), new RegExp(`aborted after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`));
  assert.equal(await c.students.countDocuments({ lastSyncedAt: LAST }), many.length, 'nobody was marked as synced');

  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    await assert.rejects(sync(db, {}, ctxOf(), { fetch: gh.fetch }), /GITHUB_TOKEN is not set/);
  } finally {
    if (saved !== undefined) process.env.GITHUB_TOKEN = saved;
  }
});

test('sync: cooperative cancel stops between students and keeps what was saved', async () => {
  const db = await freshDb();
  const c = collections(db);
  await insertStudents(db, Array.from({ length: 6 }, (_, i) => ({ username: `c${i}`, lastSyncedAt: new Date(LAST.getTime() + i * 1000) })));
  const users = Array.from({ length: 6 }, (_, i) => ({ login: `c${i}`, id: 100 + i,
    prs: [prNode({ repo: 'apache/airflow', number: 100 + i, author: author(`c${i}`, 100 + i), createdAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-19T00:00:00Z' })] }));
  const { opts } = harness(users);
  let checked = 0;
  const ctx = { ...ctxOf(), isCancelled: () => ++checked > 2 };
  const summary = await sync(db, {}, ctx, { ...opts, concurrency: 1 });
  assert.equal(summary.cancelled, true);
  assert.deepEqual({ students: summary.students, checked: summary.studentsChecked, ok: summary.ok, prs: summary.prs }, { students: 6, checked: 2, ok: 2, prs: 2 });
  assert.equal(await c.prs.countDocuments({}), 2);
  assert.equal((await c.students.findOne({ _id: 'c0' })).stats.osMerged, 1, 'aggregates refreshed for what was saved');
  assert.equal((await c.students.findOne({ _id: 'c5' })).lastSyncedAt.getTime(), LAST.getTime() + 5000);
});

test('job runner: backfill / sync handlers are loaded lazily and use global fetch + GITHUB_TOKEN', async () => {
  const db = await freshDb();
  const c = collections(db);
  await insertStudents(db, [{ username: 'runner', backfill: { status: 'pending', at: LAST }, lastSyncedAt: null }]);
  const gh = mockGitHub({ users: [{ login: 'runner', id: 9, prs: [prNode({ repo: 'apache/airflow', number: 1, author: author('runner', 9), updatedAt: '2026-10-03T10:00:00Z' })] }] });
  const savedFetch = globalThis.fetch;
  const savedToken = process.env.GITHUB_TOKEN;
  globalThis.fetch = gh.fetch;
  process.env.GITHUB_TOKEN = 'from-env';
  try {
    const job = await runInline(db, 'backfill', { users: ['runner'] }, { echo: false });
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.runner, 'cli');
    assert.deepEqual({ students: job.summary.students, ok: job.summary.ok, prs: job.summary.prs }, { students: 1, ok: 1, prs: 1 });
    assert.deepEqual(job.progress, { done: 1, total: 1 });
    assert.ok(job.log.some((l) => /runner: 1 PRs saved/.test(l)));
    assert.equal(gh.graphql()[0].headers.authorization, 'bearer from-env');
    const job2 = await runInline(db, 'sync', {}, { echo: false });
    assert.equal(job2.status, 'done', job2.error);
    assert.equal(job2.summary.ok, 1);
    assert.equal((await c.students.findOne({ _id: 'runner' })).stats.osMerged, 1);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = savedToken;
  }
});

test('scripts: argument parsing and the total-failure rule', () => {
  const spec = { users: 'list', full: 'bool', limit: 'int', pending: 'bool' };
  assert.deepEqual(parseArgs(['--users', 'a, @b,,c', '--full', '--limit=5'], spec), { users: ['a', 'b', 'c'], full: true, limit: 5 });
  assert.deepEqual(parseArgs([], spec), {});
  assert.throws(() => parseArgs(['--nope'], spec), /unknown argument/);
  assert.throws(() => parseArgs(['--users'], spec), /needs a value/);
  assert.throws(() => parseArgs(['--limit', 'x'], spec), /positive integer/);
  assert.equal(totalFailure({ status: 'error' }), true);
  assert.equal(totalFailure({ status: 'done', summary: { students: 3, ok: 0, failed: 3, notFound: 0 } }), true);
  assert.equal(totalFailure({ status: 'done', summary: { students: 3, ok: 1, failed: 2, notFound: 0 } }), false);
  assert.equal(totalFailure({ status: 'done', summary: { students: 1, ok: 0, failed: 0, notFound: 1 } }), false);
  assert.equal(totalFailure({ status: 'done', summary: { students: 0, ok: 0, failed: 0, notFound: 0 } }), false);
});

test('scripts/sync.js and scripts/backfill.js run end to end as processes (mocked GitHub preloaded)', async () => {
  const dbName = `t_cli_${Math.random().toString(16).slice(2, 10)}`;
  const db = mongo.client.db(dbName);
  const c = collections(db);
  await insertStudents(db, [
    { username: 'cli-a', lastSyncedAt: new Date(Date.now() - 86400000) },
    { username: 'cli-b', backfill: { status: 'pending', at: LAST }, lastSyncedAt: null },
  ]);
  const today = new Date().toISOString();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oss-status-cli-'));
  const file = path.join(dir, 'github.json');
  await writeFile(file, JSON.stringify({ users: [
    { login: 'cli-a', id: 1, prs: [prNode({ repo: 'apache/airflow', number: 1, author: author('cli-a', 1), createdAt: today, mergedAt: today, updatedAt: today })] },
    { login: 'cli-b', id: 2, prs: [prNode({ repo: 'apache/airflow', number: 2, author: author('cli-b', 2), createdAt: '2025-01-01T00:00:00Z', mergedAt: '2025-01-02T00:00:00Z', updatedAt: '2025-01-02T00:00:00Z' })] },
  ] }));
  const run = promisify(execFile);
  const env = { ...process.env, MONGODB_URI: mongo.uri, MONGODB_DB: dbName, GITHUB_TOKEN: 'cli-token', MOCK_GITHUB_FILE: file, NODE_ENV: 'test' };
  const node = (script, ...args) => run(process.execPath, ['--import', './test/helpers/github-preload.js', script, ...args], { cwd: ROOT, env });
  try {
    const b = await node('scripts/backfill.js', '--users', 'cli-b');
    assert.match(b.stdout, /backfill done: \{"students":1,"ok":1,"failed":0,"prs":1,/);
    assert.equal((await c.students.findOne({ _id: 'cli-b' })).backfill.status, 'done');

    const s = await node('scripts/sync.js');
    assert.match(s.stdout, /sync done: \{"students":2,"ok":2,"failed":0,"prs":1,/);
    assert.equal((await c.students.findOne({ _id: 'cli-a' })).stats.osMerged, 1);
    const jobs = await c.jobs.find({}).sort({ createdAt: 1 }).toArray();
    assert.deepEqual(jobs.map((j) => [j.type, j.runner, j.status]), [['backfill', 'cli', 'done'], ['sync', 'cli', 'done']]);
    assert.equal(jobs[1].params.concurrency, 6);

    // total failure -> exit code 1; bad flag -> 2; missing token -> 1
    await writeFile(file, JSON.stringify({ users: [] }));
    await c.students.updateOne({ _id: 'cli-b' }, { $set: { backfill: { status: 'pending', at: LAST } } });
    const untracked = await node('scripts/backfill.js', '--users', 'not-tracked').catch((e) => e);
    assert.equal(untracked.code, 1);
    const bad = await node('scripts/sync.js', '--bogus').catch((e) => e);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /usage: node scripts\/sync\.js/);
    const noToken = await run(process.execPath, ['scripts/sync.js'], { cwd: ROOT, env: { ...env, GITHUB_TOKEN: '' } }).catch((e) => e);
    assert.equal(noToken.code, 1);
    assert.match(noToken.stderr, /GITHUB_TOKEN is not set/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
