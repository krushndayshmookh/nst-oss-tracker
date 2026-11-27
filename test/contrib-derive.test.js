// SPEC addendum I4: derived data of contributions (issues raised, reviews given): classification, aggregates, admin writes.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo } from './helpers/mongo.js';
import { startApp } from './helpers/app.js';
import { insertStudents, prNode } from './helpers/fixtures.js';
import { collections, ensureIndexes } from '../src/db.js';
import { emptyOwnerStats, emptyRepoStats, emptyStudentStats, pruneStalePRs, refreshAggregates, upsertPRs } from '../src/ingest.js';
import { invalidateContext, reclassify, reclassifyAll } from '../src/classify.js';
import { repoMetaJob } from '../src/repoMeta.js';
import { fakeSleep, json } from './helpers/github.js';

let mongo;
before(async () => { mongo = await startMongo(); });
after(async () => { await mongo?.stop(); });

const D = (s) => new Date(s);
const REPOS = {
  'apache/airflow': { ownerType: 'Organization', stars: 5000 },
  'alice/site': { ownerType: 'User', stars: 5 },
  'nst-sdc/portal': { ownerType: 'Organization', stars: 10 },
  'bob/tool': { ownerType: 'User', stars: 300 },
  'smallorg/lib': { ownerType: 'Organization', stars: 10 },
};

function repoDoc(name) {
  const r = REPOS[name];
  const owner = name.split('/')[0];
  return { _id: name, name, owner, ownerLc: owner, ownerType: r.ownerType, stars: r.stars, forks: 0, isFork: false, isArchived: false,
    language: null, license: null, description: null, override: null, category: 'low_signal', tier: null, reason: 'not classified yet', stats: emptyRepoStats() };
}

function contribution({ kind, id, author, repo, createdAt, lastReviewedAt = null, state, active = true, campus = 'RU', batch = 2025 }) {
  const owner = repo.split('/')[0];
  const base = {
    _id: id, kind, url: id, number: 1, title: 'A thing', author, authorLogin: author,
    repo, repoLc: repo, owner, ownerLc: owner, ownerType: REPOS[repo].ownerType, stars: REPOS[repo].stars,
    state, createdAt: D(createdAt), closedAt: null, updatedAt: D(createdAt), campus, batch, active,
    category: 'low_signal', tier: null, reason: 'not classified yet',
  };
  return kind === 'issue'
    ? { ...base, ghId: 1, stateReason: null, comments: 0 }
    : { ...base, prUrl: id.split('#')[0], prAuthor: 'someone', prState: 'open', reviewCount: 1, lastReviewedAt: D(lastReviewedAt ?? createdAt) };
}

const I1 = 'https://github.com/apache/airflow/issues/1';
const I2 = 'https://github.com/alice/site/issues/2';
const I3 = 'https://github.com/nst-sdc/portal/issues/3';
const I4 = 'https://github.com/apache/airflow/issues/4';
const R1 = 'https://github.com/bob/tool/pull/7#review-by-alice';
const R2 = 'https://github.com/apache/airflow/pull/8#review-by-alice';
const R3 = 'https://github.com/smallorg/lib/pull/9#review-by-alice';

async function fixture() {
  const db = mongo.client.db(`cd_${Math.random().toString(16).slice(2, 10)}`);
  await ensureIndexes(db);
  invalidateContext();
  const c = collections(db);
  const [alice] = await insertStudents(db, [
    { username: 'alice', campus: 'RU', batch: 2025 },
    { username: 'bob', campus: 'ADYPU', batch: 2024 },
    { username: 'carl', campus: 'RU', batch: 2025, active: false },
  ]);
  await c.repos.insertMany(Object.keys(REPOS).map(repoDoc));
  await c.owners.insertMany([...new Set(Object.keys(REPOS).map((r) => r.split('/')[0]))].map((o) => ({
    _id: o, login: o, type: REPOS[Object.keys(REPOS).find((r) => r.startsWith(`${o}/`))].ownerType, override: null, stats: emptyOwnerStats(),
  })));
  await upsertPRs(db, alice, [
    prNode({ repo: 'apache/airflow', number: 11, state: 'MERGED', createdAt: '2026-10-01T10:00:00Z' }),
    prNode({ repo: 'apache/airflow', number: 12, state: 'CLOSED', createdAt: '2026-10-02T10:00:00Z' }),
    prNode({ repo: 'apache/airflow', number: 13, state: 'OPEN', createdAt: '2026-10-03T10:00:00Z' }),
  ]);
  await db.collection('contributions').insertMany([
    contribution({ kind: 'issue', id: I1, author: 'alice', repo: 'apache/airflow', state: 'open', createdAt: '2026-11-05T10:00:00Z' }),
    contribution({ kind: 'issue', id: I2, author: 'alice', repo: 'alice/site', state: 'closed', createdAt: '2026-09-01T10:00:00Z' }),
    contribution({ kind: 'issue', id: I3, author: 'alice', repo: 'nst-sdc/portal', state: 'open', createdAt: '2026-09-02T10:00:00Z' }),
    contribution({ kind: 'issue', id: I4, author: 'carl', repo: 'apache/airflow', state: 'open', createdAt: '2026-11-06T10:00:00Z', active: false }),
    contribution({ kind: 'review', id: R1, author: 'alice', repo: 'bob/tool', state: 'approved', createdAt: '2026-11-01T10:00:00Z', lastReviewedAt: '2026-11-20T10:00:00Z' }),
    contribution({ kind: 'review', id: R2, author: 'alice', repo: 'apache/airflow', state: 'commented', createdAt: '2026-10-20T10:00:00Z' }),
    contribution({ kind: 'review', id: R3, author: 'alice', repo: 'smallorg/lib', state: 'changes_requested', createdAt: '2026-10-21T10:00:00Z' }),
  ]);
  return { db, c, contribs: db.collection('contributions'), alice };
}

const catOf = async (coll, id) => {
  const d = await coll.findOne({ _id: id });
  return [d.category, d.tier, d.reason];
};

test('reclassify: contribFilter default rule, explicit filter, null, and the categories of issues and reviews', async () => {
  const { db, contribs } = await fixture();
  // non-empty prFilter, contribFilter omitted: contributions skipped
  let res = await reclassify(db, { prFilter: { repoLc: 'apache/airflow' }, repoFilter: null });
  assert.deepEqual([res.contributions, res.contributionsChanged], [0, 0]);
  assert.equal((await contribs.findOne({ _id: I1 })).reason, 'not classified yet');
  // explicit null skips even on a full PR recompute
  res = await reclassify(db, { prFilter: {}, repoFilter: null, contribFilter: null });
  assert.deepEqual([res.contributions, res.contributionsChanged], [0, 0]);
  // explicit filter, PRs skipped
  res = await reclassify(db, { prFilter: null, repoFilter: null, contribFilter: { kind: 'review' } });
  assert.deepEqual([res.prs, res.contributions, res.contributionsChanged], [0, 3, 3]);
  assert.equal((await contribs.findOne({ _id: I1 })).reason, 'not classified yet');
  // prFilter {} and contribFilter omitted: full recompute covers contributions
  res = await reclassify(db, { prFilter: {}, repoFilter: {} });
  assert.deepEqual([res.contributions, res.contributionsChanged], [7, 4]);
  assert.deepEqual(await catOf(contribs, I1), ['open_source', 'major', 'major']);
  assert.deepEqual(await catOf(contribs, I2), ['own_repo', null, 'author owns repo']);
  assert.deepEqual(await catOf(contribs, I3), ['nst_internal', null, 'NST org/keyword']);
  assert.deepEqual(await catOf(contribs, R1), ['peer_repo', null, 'owner is an NST student']);
  assert.deepEqual(await catOf(contribs, R2), ['open_source', 'major', 'major']);
  assert.deepEqual(await catOf(contribs, R3), ['low_signal', null, 'under 50 stars']);
  // nothing left to change
  res = await reclassify(db, { prFilter: {}, repoFilter: {} });
  assert.equal(res.contributionsChanged, 0);
  // stars follow the repo document
  await db.collection('repos').updateOne({ _id: 'smallorg/lib' }, { $set: { stars: 300 } });
  res = await reclassify(db, { prFilter: null, repoFilter: null, contribFilter: { repoLc: 'smallorg/lib' } });
  assert.deepEqual([res.contributions, res.contributionsChanged], [1, 1]);
  const r3 = await contribs.findOne({ _id: R3 });
  assert.deepEqual([r3.category, r3.tier, r3.stars], ['open_source', 'established', 300]);
});

test('refreshAggregates: student, repo and owner stats count active contributions', async () => {
  const { db, c } = await fixture();
  await reclassifyAll(db);
  const alice = (await c.students.findOne({ _id: 'alice' })).stats;
  assert.deepEqual(
    { osPrs: alice.osPrs, osMerged: alice.osMerged, osOpen: alice.osOpen, osClosed: alice.osClosed, totalIssues: alice.totalIssues, osIssues: alice.osIssues,
      totalReviews: alice.totalReviews, osReviews: alice.osReviews, osContributions: alice.osContributions, lastActivityAt: alice.lastActivityAt?.toISOString() },
    { osPrs: 3, osMerged: 1, osOpen: 1, osClosed: 1, totalIssues: 3, osIssues: 1, totalReviews: 3, osReviews: 1, osContributions: 5,
      lastActivityAt: '2026-11-20T10:00:00.000Z' },
  );
  assert.equal(alice.lastPrAt.toISOString(), '2026-10-03T10:00:00.000Z');
  // inactive student: nothing counted; student without anything: empty stats with every new key
  assert.deepEqual((await c.students.findOne({ _id: 'carl' })).stats, emptyStudentStats());
  assert.deepEqual((await c.students.findOne({ _id: 'bob' })).stats, emptyStudentStats());
  for (const k of ['osClosed', 'totalIssues', 'osIssues', 'totalReviews', 'osReviews', 'osContributions', 'lastActivityAt']) assert.ok(k in emptyStudentStats(), k);

  const airflow = (await c.repos.findOne({ _id: 'apache/airflow' })).stats;
  assert.deepEqual([airflow.prs, airflow.students, airflow.issues, airflow.reviews], [3, 1, 1, 1]);
  const tool = (await c.repos.findOne({ _id: 'bob/tool' })).stats;
  assert.deepEqual(tool, { ...emptyRepoStats(), reviews: 1 }, 'a repo with reviews but no PR: students stays "students with a PR"');
  const apache = (await c.owners.findOne({ _id: 'apache' })).stats;
  assert.deepEqual([apache.prs, apache.students, apache.issues, apache.reviews, apache.osIssues, apache.osReviews], [3, 1, 1, 1, 1, 1]);
  const bobOwner = (await c.owners.findOne({ _id: 'bob' })).stats;
  assert.deepEqual([bobOwner.students, bobOwner.reviews, bobOwner.osReviews, bobOwner.issues], [0, 1, 0, 0]);
  assert.deepEqual((await c.owners.findOne({ _id: 'smallorg' })).stats, { ...emptyOwnerStats(), reviews: 1 });

  // second run with no change writes nothing (stats compare equal, key order included)
  const before = await c.students.findOne({ _id: 'alice' });
  await refreshAggregates(db);
  assert.deepEqual((await c.students.findOne({ _id: 'alice' })).stats, before.stats);
});

test('upsertPRs star drift reclassifies the contributions on the drifted repo', async () => {
  const { db, c, contribs } = await fixture();
  await reclassifyAll(db);
  assert.equal((await contribs.findOne({ _id: R3 })).category, 'low_signal');
  const [bob] = await c.students.find({ _id: 'bob' }).toArray();
  await upsertPRs(db, bob, [prNode({ repo: 'smallorg/lib', number: 50, stars: 120 })]);
  const r3 = await contribs.findOne({ _id: R3 });
  assert.deepEqual([r3.category, r3.tier, r3.stars], ['open_source', 'emerging', 120]);
});

test('admin: repo and owner overrides flip contributions; PATCH and DELETE propagate to contributions', async () => {
  const { db, c, contribs } = await fixture();
  await reclassifyAll(db);
  const app = await startApp(db);
  try {
    assert.equal((await app.login()).status, 200);
    let res = await app.post('/api/admin/repos/override', { repo: 'smallorg/lib', override: 'include' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.affected, { prs: 0, repos: 1, contributions: 1 });
    assert.deepEqual(await catOf(contribs, R3), ['open_source', 'emerging', 'admin: repo included']);
    assert.equal((await c.students.findOne({ _id: 'alice' })).stats.osReviews, 2);

    res = await app.post('/api/admin/owners/override', { login: 'apache', override: 'exclude' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.affected, { prs: 3, repos: 1, contributions: 3 });
    assert.deepEqual(await catOf(contribs, I1), ['low_signal', null, 'admin: org excluded']);
    let s = (await c.students.findOne({ _id: 'alice' })).stats;
    assert.deepEqual([s.osPrs, s.osIssues, s.osReviews, s.osContributions], [0, 0, 1, 1]);
    assert.deepEqual([(await c.owners.findOne({ _id: 'apache' })).stats.issues, (await c.owners.findOne({ _id: 'apache' })).stats.osIssues], [1, 0]);

    res = await app.patch('/api/admin/students/alice', { campus: 'ADYPU', batch: 2024 });
    assert.equal(res.status, 200);
    assert.deepEqual(await contribs.distinct('campus', { author: 'alice' }), ['ADYPU']);
    assert.deepEqual(await contribs.distinct('batch', { author: 'alice' }), [2024]);

    res = await app.patch('/api/admin/students/alice', { active: false });
    assert.equal(res.status, 200);
    assert.deepEqual(await contribs.distinct('active', { author: 'alice' }), [false]);
    assert.deepEqual((await c.students.findOne({ _id: 'alice' })).stats, emptyStudentStats());
    assert.equal((await c.repos.findOne({ _id: 'bob/tool' })).stats.reviews, 0);

    res = await app.patch('/api/admin/students/alice', { active: true });
    assert.deepEqual(await contribs.distinct('active', { author: 'alice' }), [true]);
    s = (await c.students.findOne({ _id: 'alice' })).stats;
    assert.equal(s.totalReviews, 3);

    res = await app.del('/api/admin/students/alice');
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.prsRemoved, res.body.contributionsRemoved], [0, 0]);
    assert.deepEqual(await contribs.distinct('active', { author: 'alice' }), [false]);

    res = await app.del('/api/admin/students/alice?purge=1');
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.purged, res.body.prsRemoved, res.body.contributionsRemoved], [true, 3, 6]);
    assert.equal(await contribs.countDocuments({ author: 'alice' }), 0);
    assert.equal(await contribs.countDocuments({ author: 'carl' }), 1);
  } finally {
    await app.close();
  }
});

test('admin: a newly added student turns contributions on their repos into peer_repo', async () => {
  const { db, contribs } = await fixture();
  await reclassifyAll(db);
  assert.equal((await contribs.findOne({ _id: R3 })).category, 'low_signal');
  const app = await startApp(db);
  try {
    await app.login();
    const res = await app.post('/api/admin/students', { username: 'smallorg', campus: 'RU', batch: 2025 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(await catOf(contribs, R3), ['peer_repo', null, 'owner is an NST student']);
  } finally {
    await app.close();
  }
});

/** GitHub for repoMeta: every stored repo answers with its fixture metadata, `stars` overrides the star count. */
function repoMetaGitHub(stars) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const data = { rateLimit: { cost: 1, remaining: 4000, resetAt: new Date(Date.now() + 600000).toISOString() } };
    for (const [, alias, o, n] of body.query.matchAll(/(r\d+): repository\(owner: \$(o\d+), name: \$(n\d+)\)/g)) {
      const full = `${body.variables[o]}/${body.variables[n]}`;
      const r = REPOS[full.toLowerCase()] ?? { ownerType: 'Organization', stars: 10 };
      data[alias] = {
        nameWithOwner: full, isFork: false, isArchived: false, isPrivate: false, stargazerCount: stars[full.toLowerCase()] ?? r.stars, forkCount: 0,
        description: null, owner: { login: full.split('/')[0], __typename: r.ownerType }, primaryLanguage: { name: 'Python' }, licenseInfo: null,
        languages: { totalSize: 100, edges: [{ size: 100, node: { name: 'Python' } }] }, repositoryTopics: { nodes: [] },
      };
    }
    return json({ data });
  };
}

test('repoMeta: stars that cross a threshold flip the stored contributions together with the PRs', async () => {
  const { db, c, contribs } = await fixture();
  const [bob] = await c.students.find({ _id: 'bob' }).toArray();
  await upsertPRs(db, bob, [prNode({ repo: 'smallorg/lib', number: 60, stars: 10 })]);
  await reclassifyAll(db);
  assert.deepEqual([(await c.prs.findOne({ repoLc: 'smallorg/lib' })).category, (await contribs.findOne({ _id: R3 })).category], ['low_signal', 'low_signal']);
  const lines = [];
  await repoMetaJob(db, {}, { log: (l) => lines.push(l) }, { fetch: repoMetaGitHub({ 'smallorg/lib': 300 }), token: 't', sleep: fakeSleep() });
  const pr = await c.prs.findOne({ repoLc: 'smallorg/lib' });
  const r3 = await contribs.findOne({ _id: R3 });
  assert.deepEqual([pr.category, pr.stars], ['open_source', 300]);
  assert.deepEqual([r3.category, r3.tier, r3.stars], ['open_source', 'established', 300]);
  assert.ok(lines.some((l) => /stars changed on 1 repos: 1 PRs, 1 contributions and 1 repos reclassified/.test(l)), lines.join('\n'));
  assert.equal((await c.students.findOne({ _id: 'alice' })).stats.osReviews, 2, 'aggregates refreshed');
});

test('pruneStalePRs: a repo move carries the repo override and reclassifies the contributions on the new repo', async () => {
  const { db, c, contribs, alice } = await fixture();
  const airflow = [
    prNode({ repo: 'apache/airflow', number: 11, state: 'MERGED', createdAt: '2026-10-01T10:00:00Z' }),
    prNode({ repo: 'apache/airflow', number: 12, state: 'CLOSED', createdAt: '2026-10-02T10:00:00Z' }),
    prNode({ repo: 'apache/airflow', number: 13, state: 'OPEN', createdAt: '2026-10-03T10:00:00Z' }),
  ];
  await upsertPRs(db, alice, [prNode({ repo: 'oldorg/lib', number: 77, createdAt: '2026-09-01T10:00:00Z', stars: 10 })]);
  await c.repos.updateOne({ _id: 'oldorg/lib' }, { $set: { override: 'include', overrideNote: 'kept' } });
  // an issue of alice on the repo the PR moves to, stored before the move
  await contribs.insertOne({ ...contribution({ kind: 'issue', id: 'https://github.com/neworg/lib/issues/5', author: 'alice', repo: 'smallorg/lib', state: 'open', createdAt: '2026-09-05T10:00:00Z' }),
    repo: 'neworg/lib', repoLc: 'neworg/lib', owner: 'neworg', ownerLc: 'neworg' });
  const fetched = [...airflow, prNode({ repo: 'neworg/lib', number: 77, createdAt: '2026-09-01T10:00:00Z', stars: 10 })];
  await upsertPRs(db, alice, fetched);
  assert.equal((await contribs.findOne({ repoLc: 'neworg/lib' })).category, 'low_signal');
  const out = await pruneStalePRs(db, alice, fetched);
  assert.deepEqual([out.moved, out.removed, out.skipped], [1, 0, '']);
  assert.equal((await c.repos.findOne({ _id: 'neworg/lib' })).override, 'include');
  assert.deepEqual([(await c.prs.findOne({ repoLc: 'neworg/lib' })).category, await catOf(contribs, 'https://github.com/neworg/lib/issues/5')],
    ['open_source', ['open_source', 'emerging', 'admin: repo included']]);
});
