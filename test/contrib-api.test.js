// SPEC addendum I5: public API for contributions (issues raised, reviews given) against a real mongod.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo } from './helpers/mongo.js';
import { startApp } from './helpers/app.js';
import { insertStudents, prNode } from './helpers/fixtures.js';
import { collections, ensureIndexes } from '../src/db.js';
import { refreshAggregates, upsertPRs } from '../src/ingest.js';
import { invalidateContext } from '../src/classify.js';
import { contribGroupStats, studentStats } from '../src/ranged.js';

const AY = 'from=2026-07-01&to=2027-06-30';
const SECRETS = ['carol@private.example', 'ENR-CAROL-9', 'test sheet', 'private note', 'contribSyncedAt'];
const CONTRIB_KEYS = ['kind', 'url', 'number', 'title', 'author', 'authorName', 'repo', 'owner', 'ownerType', 'stars', 'state', 'stateReason', 'createdAt',
  'closedAt', 'comments', 'prUrl', 'prAuthor', 'prState', 'reviewCount', 'lastReviewedAt', 'campus', 'batch', 'year', 'category', 'tier', 'reason'];
const NEW_STATS = ['osClosed', 'totalIssues', 'osIssues', 'totalReviews', 'osReviews', 'osContributions', 'lastActivityAt'];
const NEW_BLOCK = ['osOpen', 'osIssues', 'osReviews', 'withOsIssue', 'withOsReview'];
const d = (s) => new Date(s);

let mongo, db, c, app, cached;

/** A contribution document as agent A stores it (addendum I1). */
function issueDoc({ n, student, repo = 'apache/airflow', state = 'open', createdAt, category = 'open_source', tier = 'major', stars = 5000, active = true, ...rest }) {
  const [owner] = repo.split('/');
  const url = `https://github.com/${repo}/issues/${n}`;
  return {
    _id: url, kind: 'issue', url, number: n, title: `Issue ${n}`, author: student._id, authorLogin: student.username,
    repo, repoLc: repo.toLowerCase(), owner, ownerLc: owner.toLowerCase(), ownerType: 'Organization', stars,
    state, createdAt: d(createdAt), closedAt: state === 'closed' ? d(createdAt) : null, updatedAt: d(createdAt),
    campus: student.campus, batch: student.batch, active, category, tier, reason: category === 'open_source' ? tier : category,
    ghId: n, stateReason: state === 'closed' ? 'completed' : null, comments: 3, ...rest,
  };
}
function reviewDoc({ n, student, repo = 'apache/airflow', state = 'approved', createdAt, lastReviewedAt = createdAt, category = 'open_source', tier = 'major', stars = 5000, active = true, ...rest }) {
  const [owner] = repo.split('/');
  const prUrl = `https://github.com/${repo}/pull/${n}`;
  return {
    _id: `${prUrl}#review-by-${student._id}`, kind: 'review', url: `${prUrl}#pullrequestreview-${n}`, number: n, title: `PR ${n}`,
    author: student._id, authorLogin: student.username,
    repo, repoLc: repo.toLowerCase(), owner, ownerLc: owner.toLowerCase(), ownerType: 'Organization', stars,
    state, createdAt: d(createdAt), closedAt: null, updatedAt: d(lastReviewedAt),
    campus: student.campus, batch: student.batch, active, category, tier, reason: category === 'open_source' ? tier : category,
    prUrl, prAuthor: 'someone', prState: 'merged', reviewCount: 2, lastReviewedAt: d(lastReviewedAt), ...rest,
  };
}

before(async () => {
  mongo = await startMongo();
  db = mongo.db;
  c = collections(db);
  await ensureIndexes(db);
  invalidateContext();
  const [alice, bob, carol, dave] = await insertStudents(db, [
    { username: 'Alice', name: 'Alice A', campus: 'RU', batch: 2025, contribSyncedAt: d('2026-11-01T00:00:00Z') },
    { username: 'Bob', name: 'Bob B', campus: 'ADYPU', batch: 2026 },
    { username: 'carol', name: 'Carol C', campus: 'RU', batch: 2025, email: 'carol@private.example', enrolmentNo: 'ENR-CAROL-9' },
    { username: 'dave', name: 'Dave D', campus: 'SVYASA', batch: 2024, active: false },
    { username: 'idle', name: 'Idle I', campus: 'ADYPU', batch: 2026 },
  ]);
  await upsertPRs(db, alice, [
    prNode({ repo: 'apache/airflow', number: 1, createdAt: '2026-08-10T10:00:00Z', mergedAt: '2026-08-12T10:00:00Z' }),
    prNode({ repo: 'apache/airflow', number: 2, state: 'OPEN', createdAt: '2026-09-05T10:00:00Z' }),
    prNode({ repo: 'apache/airflow', number: 3, state: 'CLOSED', createdAt: '2026-09-10T10:00:00Z', closedAt: '2026-09-11T10:00:00Z' }),
  ]);
  await upsertPRs(db, bob, [prNode({ repo: 'apache/airflow', number: 8, createdAt: '2026-08-20T10:00:00Z', mergedAt: '2026-08-21T10:00:00Z' })]);
  await db.collection('contributions').insertMany([
    issueDoc({ n: 101, student: alice, createdAt: '2026-08-15T10:00:00Z', stars: 5000 }),
    issueDoc({ n: 102, student: alice, repo: 'Alice/site', state: 'closed', category: 'own_repo', tier: null, stars: 3, createdAt: '2026-09-20T10:00:00Z' }),
    issueDoc({ n: 103, student: carol, state: 'closed', createdAt: '2025-05-01T10:00:00Z', stars: 5200 }),
    reviewDoc({ n: 50, student: bob, createdAt: '2026-08-25T10:00:00Z', lastReviewedAt: '2026-09-01T10:00:00Z', stars: 5000 }),
    reviewDoc({ n: 51, student: carol, state: 'changes_requested', createdAt: '2026-10-02T10:00:00Z', stars: 5100 }),
    reviewDoc({ n: 60, student: alice, repo: 'midorg/tool', state: 'commented', category: 'peer_repo', tier: null, stars: 10, createdAt: '2026-10-05T10:00:00Z' }),
    issueDoc({ n: 104, student: dave, createdAt: '2026-08-15T10:00:00Z', active: false }),
    reviewDoc({ n: 52, student: dave, createdAt: '2026-08-15T10:00:00Z', active: false }),
  ]);
  await refreshAggregates(db);
  // all-time stats as agent B stores them (set here so this file does not depend on B's code)
  const set = (id, stats) => c.students.updateOne({ _id: id }, { $set: Object.fromEntries(Object.entries(stats).map(([k, v]) => [`stats.${k}`, v])) });
  await set('alice', { osClosed: 1, totalIssues: 2, osIssues: 1, totalReviews: 1, osReviews: 0, osContributions: 4, lastActivityAt: d('2026-10-05T10:00:00Z') });
  await set('bob', { osClosed: 0, totalIssues: 0, osIssues: 0, totalReviews: 1, osReviews: 1, osContributions: 2, lastActivityAt: d('2026-09-01T10:00:00Z') });
  await set('carol', { osClosed: 0, totalIssues: 1, osIssues: 1, totalReviews: 1, osReviews: 1, osContributions: 2, lastActivityAt: d('2026-10-02T10:00:00Z') });
  await c.repos.updateOne({ _id: 'apache/airflow' }, { $set: { 'stats.issues': 2, 'stats.reviews': 2 } });
  await c.owners.updateOne({ _id: 'apache' }, { $set: { 'stats.issues': 2, 'stats.reviews': 2, 'stats.osIssues': 2, 'stats.osReviews': 2 } });
  app = await startApp(db);
  cached = await startApp(db, { publicCacheMs: 60000 });
});

after(async () => {
  await app?.close();
  await cached?.close();
  await mongo?.stop();
});

const get = async (p) => {
  const r = await app.get(p);
  assert.equal(r.status, 200, `${p}: ${r.text.slice(0, 300)}`);
  for (const s of SECRETS) assert.ok(!r.text.includes(s), `${p} leaks ${s}`);
  return r.body;
};
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

// ------------------------------------------------------------------ list + export

test('contributions list: kind, filters, sorts, category default, date range, inactive hidden', async () => {
  const issues = await get('/api/contributions?range=all');
  assert.equal(issues.kind, 'issue', 'kind defaults to issue');
  assert.deepEqual([issues.total, issues.page, issues.limit], [2, 1, 25]);
  assert.deepEqual(issues.items.map((x) => x.number), [101, 103], 'open source only by default, newest first, inactive hidden');
  assert.deepEqual(Object.keys(issues.items[0]), CONTRIB_KEYS, 'exactly the Contribution keys');
  assert.deepEqual(pick(issues.items[0], ['kind', 'author', 'authorName', 'repo', 'owner', 'state', 'stateReason', 'comments', 'prUrl', 'prAuthor', 'prState', 'reviewCount',
    'lastReviewedAt', 'campus', 'batch', 'category', 'tier', 'createdAt', 'closedAt']), {
    kind: 'issue', author: 'Alice', authorName: 'Alice A', repo: 'apache/airflow', owner: 'apache', state: 'open', stateReason: null, comments: 3,
    prUrl: null, prAuthor: null, prState: null, reviewCount: null, lastReviewedAt: null, campus: 'RU', batch: 2025, category: 'open_source', tier: 'major',
    createdAt: '2026-08-15T10:00:00.000Z', closedAt: null,
  });
  assert.equal((await get('/api/contributions?range=all&state=closed')).items[0].stateReason, 'completed');
  assert.deepEqual((await get('/api/contributions?range=all&category=all')).items.map((x) => x.number), [102, 101, 103]);
  assert.deepEqual((await get('/api/contributions?range=all&category=own_repo')).items.map((x) => x.number), [102]);
  assert.deepEqual((await get('/api/contributions?range=all&state=open')).items.map((x) => x.number), [101]);
  assert.deepEqual((await get('/api/contributions?range=all&author=CAROL')).items.map((x) => x.number), [103]);
  assert.deepEqual((await get('/api/contributions?range=all&author=dave&category=all')).total, 0, 'inactive students are hidden');
  assert.deepEqual((await get('/api/contributions?range=all&campus=RU&category=all&repo=Alice/Site')).items.map((x) => x.number), [102]);
  assert.deepEqual((await get('/api/contributions?range=all&owner=APACHE&q=issue 10')).items.map((x) => x.number), [101, 103]);
  assert.deepEqual((await get('/api/contributions?range=all&tier=major&batch=2025')).total, 2);
  assert.deepEqual((await get('/api/contributions?range=all&sort=stars')).items.map((x) => x.number), [103, 101]);
  assert.deepEqual((await get('/api/contributions?range=all&sort=stars&order=asc')).items.map((x) => x.number), [101, 103]);
  // a contribution counts in a range by createdAt
  assert.deepEqual((await get(`/api/contributions?${AY}`)).items.map((x) => x.number), [101]);
  assert.deepEqual((await get(`/api/contributions?${AY}&category=all`)).items.map((x) => x.number), [102, 101]);
  assert.deepEqual((await get('/api/contributions?from=2025-01-01&to=2025-12-31')).items.map((x) => x.number), [103]);
  const def = await get('/api/contributions');
  assert.equal(def.range.preset, 'ay');

  const reviews = await get('/api/contributions?range=all&kind=review');
  assert.equal(reviews.kind, 'review');
  assert.deepEqual(reviews.items.map((x) => x.number), [51, 50]);
  assert.deepEqual(Object.keys(reviews.items[0]), CONTRIB_KEYS);
  assert.deepEqual(pick(reviews.items[1], ['kind', 'url', 'author', 'state', 'stateReason', 'comments', 'closedAt', 'prUrl', 'prAuthor', 'prState', 'reviewCount', 'lastReviewedAt', 'createdAt']), {
    kind: 'review', url: 'https://github.com/apache/airflow/pull/50#pullrequestreview-50', author: 'Bob', state: 'approved', stateReason: null, comments: null, closedAt: null,
    prUrl: 'https://github.com/apache/airflow/pull/50', prAuthor: 'someone', prState: 'merged', reviewCount: 2,
    lastReviewedAt: '2026-09-01T10:00:00.000Z', createdAt: '2026-08-25T10:00:00.000Z',
  });
  assert.deepEqual((await get('/api/contributions?range=all&kind=review&category=all')).items.map((x) => x.number), [60, 51, 50]);
  assert.deepEqual((await get('/api/contributions?range=all&kind=review&category=all&sort=lastReviewedAt&order=asc')).items.map((x) => x.number), [50, 51, 60]);
  assert.deepEqual((await get('/api/contributions?range=all&kind=review&state=changes_requested')).items.map((x) => x.author), ['carol']);
  assert.deepEqual((await get('/api/contributions?range=all&kind=review&category=all&state=commented')).items.map((x) => x.number), [60]);
  assert.deepEqual((await get('/api/contributions?range=all&kind=review&campus=ADYPU')).items.map((x) => x.number), [50]);
  assert.deepEqual((await get('/api/contributions?range=all&kind=review&limit=1&page=2')).items.map((x) => x.number), [50]);

  for (const bad of ['kind=pr', 'kind=bogus', 'kind=issue&state=approved', 'state=merged', 'kind=review&state=open', 'kind=review&state=bogus',
    'category=nope', 'sort=mergedAt', 'tier=huge', 'from=yesterday']) {
    const r = await app.get(`/api/contributions?range=all&${bad}`);
    assert.equal(r.status, 400, bad);
    assert.equal(r.body.error.code, 'bad_request', bad);
  }
});

test('contributions.csv and students.csv headers and rows', async () => {
  const csv = await app.get('/api/export/contributions.csv?range=all&kind=review&category=all', { raw: true });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  const lines = csv.text.trim().split('\n');
  assert.equal(lines[0], 'kind,url,author,author_name,campus,batch,year,repo,owner,owner_type,stars,title,state,state_reason,created_at,closed_at,pr_url,pr_author,pr_state,review_count,last_reviewed_at,category,tier,reason');
  assert.equal(lines.length, 4);
  const bob = lines.find((l) => l.includes(',Bob,'));
  assert.ok(bob.startsWith('review,https://github.com/apache/airflow/pull/50#pullrequestreview-50,Bob,Bob B,ADYPU,2026,'), bob);
  assert.ok(bob.includes(',apache/airflow,apache,Organization,5000,PR 50,approved,,2026-08-25T10:00:00.000Z,,https://github.com/apache/airflow/pull/50,someone,merged,2,2026-09-01T10:00:00.000Z,open_source,major,major'), bob);
  const issues = await app.get(`/api/export/contributions.csv?${AY}`, { raw: true });
  const rows = issues.text.trim().split('\n');
  assert.deepEqual([rows.length, rows[1].split(',')[0], rows[1].split(',')[1]], [2, 'issue', 'https://github.com/apache/airflow/issues/101']);
  assert.equal((await app.get('/api/export/contributions.csv?kind=nope')).status, 400);
  for (const s of SECRETS) assert.ok(!csv.text.includes(s) && !issues.text.includes(s));

  const st = await app.get('/api/export/students.csv?range=all', { raw: true });
  const head = st.text.split('\n')[0].split(',');
  assert.deepEqual(head.slice(-6), ['os_closed_prs', 'total_issues', 'os_issues', 'total_reviews', 'os_reviews', 'os_contributions']);
  assert.deepEqual(head.slice(0, 20), ['username', 'name', 'campus', 'batch', 'year', 'total_prs', 'merged_prs', 'os_prs', 'os_merged', 'os_open', 'os_major_merged', 'os_repos',
    'os_orgs', 'practice_prs', 'nst_internal_prs', 'peer_repo_prs', 'own_repo_prs', 'low_signal_prs', 'first_pr_at', 'last_pr_at'], 'existing columns unchanged');
  const alice = st.text.split('\n').find((l) => l.startsWith('Alice,'));
  assert.ok(alice.endsWith(',1,2,1,1,0,4'), alice);
  const ranged = await app.get(`/api/export/students.csv?${AY}`, { raw: true });
  assert.ok(ranged.text.split('\n').find((l) => l.startsWith('carol,')).endsWith(',0,0,0,1,1,1'), 'ranged: carol has one review in the year, her issue is older');
});

// ------------------------------------------------------------------ meta, overview

test('meta: kinds, features, counts of active issues and reviews', async () => {
  const meta = await get('/api/meta');
  assert.deepEqual(meta.kinds, ['pr', 'issue', 'review']);
  assert.deepEqual(meta.features, { contributions: true });
  assert.deepEqual(meta.counts, { students: 4, prs: 4, issues: 3, reviews: 3 });
});

test('overview: contributions block, students.withOs*, monthly keys (ranged and all time)', async () => {
  const o = await get(`/api/overview?${AY}`);
  assert.deepEqual(o.contributions, { osPrsOpen: 1, osPrsMerged: 2, osPrsClosed: 1, osIssues: 1, osIssuesOpen: 1, osIssuesClosed: 0, osReviews: 2, osApprovals: 1,
    osChangesRequested: 1, totalIssues: 2, totalReviews: 3 });
  assert.equal(o.contributions.osPrsMerged, o.prs.osMerged);
  assert.deepEqual(pick(o.students, ['tracked', 'withOsPr', 'withOsIssue', 'withOsReview', 'withOsContribution']),
    { tracked: 4, withOsPr: 2, withOsIssue: 1, withOsReview: 2, withOsContribution: 3 });
  const aug = o.monthly.find((m) => m.month === '2026-08');
  assert.deepEqual(aug, { month: '2026-08', osOpened: 2, osMerged: 2, allOpened: 2, osIssues: 1, osReviews: 1 });
  assert.deepEqual(pick(o.monthly.find((m) => m.month === '2026-10'), ['osIssues', 'osReviews']), { osIssues: 0, osReviews: 1 });
  assert.ok(o.monthly.every((m) => 'osIssues' in m && 'osReviews' in m));
  assert.equal(o.topStudents[0].stats.osContributions, 4, 'ranged top students carry the contribution stats');

  const ru = await get(`/api/overview?${AY}&campus=RU`);
  assert.deepEqual(pick(ru.students, ['tracked', 'withOsIssue', 'withOsReview', 'withOsContribution']), { tracked: 2, withOsIssue: 1, withOsReview: 1, withOsContribution: 2 });
  assert.deepEqual(pick(ru.contributions, ['osIssues', 'osReviews', 'totalIssues', 'totalReviews']), { osIssues: 1, osReviews: 1, totalIssues: 2, totalReviews: 2 });

  const all = await get('/api/overview?range=all');
  assert.deepEqual(all.contributions, { osPrsOpen: 1, osPrsMerged: 2, osPrsClosed: 1, osIssues: 2, osIssuesOpen: 1, osIssuesClosed: 1, osReviews: 2, osApprovals: 1,
    osChangesRequested: 1, totalIssues: 3, totalReviews: 3 });
  assert.deepEqual(pick(all.students, ['withOsIssue', 'withOsReview', 'withOsContribution']), { withOsIssue: 2, withOsReview: 2, withOsContribution: 3 },
    'all time: from the stored stats');
});

// ------------------------------------------------------------------ students

test('students list: new stats keys, new sorts, hasContribution (ranged and all time)', async () => {
  const ranged = await get(`/api/students?${AY}&sort=osContributions`);
  assert.deepEqual(ranged.items.map((s) => [s.username, s.stats.osContributions]), [['Alice', 4], ['Bob', 2], ['carol', 1], ['idle', 0]]);
  const a = ranged.items[0].stats;
  assert.deepEqual(pick(a, NEW_STATS), { osClosed: 1, totalIssues: 2, osIssues: 1, totalReviews: 1, osReviews: 0, osContributions: 4, lastActivityAt: '2026-10-05T10:00:00.000Z' });
  assert.deepEqual(pick(ranged.items[2].stats, NEW_STATS), { osClosed: 0, totalIssues: 0, osIssues: 0, totalReviews: 1, osReviews: 1, osContributions: 1,
    lastActivityAt: '2026-10-02T10:00:00.000Z' }, 'a student with reviews and no PR in the range');
  assert.equal(ranged.items[1].stats.lastActivityAt, '2026-09-01T10:00:00.000Z', 'a review counts on its last review date when that is in the range');
  assert.deepEqual((await get(`/api/students?${AY}&sort=osReviews`)).items.map((s) => s.username), ['Bob', 'carol', 'Alice', 'idle']);
  assert.deepEqual((await get(`/api/students?${AY}&sort=osIssues`)).items.map((s) => s.username).slice(0, 1), ['Alice']);
  assert.deepEqual((await get(`/api/students?${AY}&sort=osOpen&order=asc`)).items.map((s) => s.stats.osOpen), [0, 0, 0, 1]);
  assert.deepEqual((await get(`/api/students?${AY}&sort=lastActivityAt`)).items.map((s) => s.username), ['Alice', 'carol', 'Bob', 'idle'], 'ranged: computed last activity');
  const has = await get(`/api/students?${AY}&hasContribution=1`);
  assert.deepEqual([has.total, has.items.map((s) => s.username).sort()], [3, ['Alice', 'Bob', 'carol']]);
  assert.equal((await get('/api/students?from=2025-01-01&to=2025-12-31&hasContribution=1')).items.map((s) => s.username).join(), 'carol');

  const all = await get('/api/students?range=all&sort=osContributions');
  assert.deepEqual(all.items.map((s) => [s.username, s.stats.osContributions]), [['Alice', 4], ['Bob', 2], ['carol', 2], ['idle', 0]]);
  assert.deepEqual(Object.keys(all.items[0].stats).slice(-7), NEW_STATS);
  assert.deepEqual((await get('/api/students?range=all&sort=osIssues')).items.map((s) => s.username).slice(0, 2), ['Alice', 'carol']);
  assert.deepEqual((await get('/api/students?range=all&sort=osReviews&order=asc')).items.map((s) => s.stats.osReviews), [0, 0, 1, 1]);
  assert.deepEqual((await get('/api/students?range=all&sort=lastActivityAt')).items.map((s) => s.username), ['Alice', 'carol', 'Bob', 'idle'], 'all time: stats.lastActivityAt');
  const allHas = await get('/api/students?range=all&hasContribution=1');
  assert.deepEqual([allHas.total, allHas.items.map((s) => s.username).sort()], [3, ['Alice', 'Bob', 'carol']]);
  assert.equal((await app.get('/api/students?hasContribution=yes')).status, 400);
  assert.equal((await app.get('/api/students?sort=osComments')).status, 400);
});

test('student profile: issues and reviews pages, ranged stats, monthly keys', async () => {
  const all = await get('/api/students/alice?range=all');
  assert.deepEqual([all.issues.total, all.issues.page, all.issues.limit, all.issues.items.map((x) => x.number)], [2, 1, 25, [102, 101]], 'every category, newest first');
  assert.deepEqual([all.reviews.total, all.reviews.items.map((x) => x.number)], [1, [60]]);
  assert.deepEqual(Object.keys(all.issues.items[0]), CONTRIB_KEYS);
  assert.equal(all.student.stats.osContributions, 4);
  assert.ok(all.monthly.every((m) => 'osIssues' in m && 'osReviews' in m));

  const sep = await get('/api/students/alice?from=2026-09-01&to=2026-09-30');
  assert.deepEqual([sep.issues.total, sep.issues.items[0].number, sep.reviews.total], [1, 102, 0], 'the range applies to createdAt');
  assert.deepEqual(pick(sep.student.stats, NEW_STATS), { osClosed: 1, totalIssues: 1, osIssues: 0, totalReviews: 0, osReviews: 0, osContributions: 2,
    lastActivityAt: '2026-09-20T10:00:00.000Z' });
  const carol = await get('/api/students/carol?range=all');
  assert.deepEqual([carol.issues.total, carol.reviews.total, carol.prs.total], [1, 1, 0]);
  const bob = await get(`/api/students/bob?${AY}`);
  assert.deepEqual(pick(bob.monthly.find((m) => m.month === '2026-08'), ['osOpened', 'osIssues', 'osReviews']), { osOpened: 1, osIssues: 0, osReviews: 1 });
  assert.equal((await app.get('/api/students/dave')).status, 404);
});

// ------------------------------------------------------------------ activity, campuses, repos, orgs

test('activity: metric issues / reviews counts contributions by createdAt, same shape', async () => {
  const prs = await get(`/api/activity?${AY}`);
  const issues = await get(`/api/activity?${AY}&metric=issues&category=all`);
  assert.equal(issues.metric, 'issues');
  assert.deepEqual(Object.keys(issues).filter((k) => k !== 'totals').sort(), Object.keys(prs).filter((k) => k !== 'totals').sort(), 'same response keys');
  assert.deepEqual(issues.totals, { opened: 2, merged: 0, issues: 2, activeStudents: 1 });
  assert.deepEqual(pick(issues.byMonth.find((m) => m.month === '2026-08'), ['opened', 'merged', 'issues', 'activeStudents']), { opened: 1, merged: 0, issues: 1, activeStudents: 1 });
  assert.deepEqual(issues.busiest.month, { month: '2026-08', count: 1 });
  assert.ok(issues.byCampusMonth.every((r) => r.campus === 'RU' && 'per100Opened' in r));
  const reviews = await get(`/api/activity?${AY}&metric=reviews`);
  assert.deepEqual(reviews.totals, { opened: 2, merged: 0, reviews: 2, activeStudents: 2 }, 'open source by default');
  assert.deepEqual(reviews.byCampusMonth.map((r) => [r.campus, r.month, r.reviews]), [['ADYPU', '2026-08', 1], ['RU', '2026-10', 1]]);
  assert.equal((await get(`/api/activity?${AY}&metric=reviews&campus=RU`)).totals.reviews, 1);
  assert.equal((await get(`/api/activity?${AY}&metric=reviews&author=bob`)).totals.reviews, 1);
  assert.equal((await get('/api/activity?range=all&metric=issues')).totals.issues, 2, 'inactive students are not counted');
  assert.equal((await app.get('/api/activity?metric=comments')).status, 400);
});

test('campuses: every block carries the five new keys', async () => {
  const ranged = await get(`/api/campuses?${AY}`);
  for (const b of [...ranged.rows, ...ranged.totals, ranged.total]) for (const k of NEW_BLOCK) assert.equal(typeof b[k], 'number', `${b.campus}/${b.year} ${k}`);
  const ru = ranged.totals.find((t) => t.campus === 'RU');
  assert.deepEqual(pick(ru, NEW_BLOCK), { osOpen: 1, osIssues: 1, osReviews: 1, withOsIssue: 1, withOsReview: 1 });
  assert.deepEqual(pick(ranged.total, NEW_BLOCK), { osOpen: 1, osIssues: 1, osReviews: 2, withOsIssue: 1, withOsReview: 2 });
  const all = await get('/api/campuses?range=all');
  assert.deepEqual(pick(all.totals.find((t) => t.campus === 'RU'), NEW_BLOCK), { osOpen: 1, osIssues: 2, osReviews: 1, withOsIssue: 2, withOsReview: 1 }, 'all time: stored stats');
  const page = await get(`/api/campuses/RU?${AY}`);
  for (const b of [page.totals, page.overall, ...page.years]) for (const k of NEW_BLOCK) assert.equal(typeof b[k], 'number', k);
  assert.equal(page.years[0].osIssues, 1);
  assert.ok(page.monthly.every((m) => 'osIssues' in m && 'osReviews' in m));
});

test('repos and orgs: stats carry issues / reviews (ranged and all time)', async () => {
  const all = await get('/api/repos?range=all');
  const airflow = all.items.find((r) => r.name === 'apache/airflow');
  assert.deepEqual([airflow.stats.issues, airflow.stats.reviews], [2, 2]);
  const ranged = (await get(`/api/repos?${AY}`)).items.find((r) => r.name === 'apache/airflow');
  assert.deepEqual([ranged.stats.prs, ranged.stats.issues, ranged.stats.reviews], [4, 1, 2]);
  const one = await get(`/api/repos/apache/airflow?${AY}`);
  assert.deepEqual([one.repo.stats.issues, one.repo.stats.reviews], [1, 2]);
  assert.deepEqual(pick(one.owner.stats, ['issues', 'reviews', 'osIssues', 'osReviews']), { issues: 1, reviews: 2, osIssues: 1, osReviews: 2 });
  assert.equal(one.students.find((s) => s.username === 'Alice').stats.osContributions, 4, 'contributors carry ranged contribution stats');
  const oneAll = await get('/api/repos/apache/airflow?range=all');
  assert.deepEqual([oneAll.repo.stats.issues, oneAll.owner.stats.osReviews], [2, 2]);

  const orgs = await get('/api/orgs?range=all');
  assert.deepEqual(pick(orgs.items.find((o) => o.login === 'apache').stats, ['issues', 'reviews', 'osIssues', 'osReviews']), { issues: 2, reviews: 2, osIssues: 2, osReviews: 2 });
  const orgsRanged = await get(`/api/orgs?${AY}`);
  assert.deepEqual(pick(orgsRanged.items.find((o) => o.login === 'apache').stats, ['issues', 'reviews', 'osIssues', 'osReviews']), { issues: 1, reviews: 2, osIssues: 1, osReviews: 2 });
  const org = await get(`/api/orgs/apache?${AY}`);
  assert.deepEqual([org.org.stats.osIssues, org.org.stats.reviews, org.repos[0].stats.issues, org.repos[0].stats.reviews], [1, 2, 1, 2]);
  const orgAll = await get('/api/orgs/apache?range=all');
  assert.deepEqual([orgAll.org.stats.issues, orgAll.repos[0].stats.reviews], [2, 2]);
});

// ------------------------------------------------------------------ cache, helpers

test('response cache key distinguishes kind and hasContribution', async () => {
  const a = await cached.get('/api/contributions?range=all');
  const b = await cached.get('/api/contributions?range=all&kind=review');
  const a2 = await cached.get('/api/contributions?range=all');
  assert.deepEqual([a.headers.get('x-cache'), b.headers.get('x-cache'), a2.headers.get('x-cache')], ['miss', 'miss', 'hit']);
  assert.deepEqual([a.body.kind, b.body.kind, a2.body.kind], ['issue', 'review', 'issue']);
  const s1 = await cached.get(`/api/students?${AY}`);
  const s2 = await cached.get(`/api/students?${AY}&hasContribution=1`);
  assert.deepEqual([s1.body.total, s2.body.total, s2.headers.get('x-cache')], [4, 3, 'miss']);
});

test('contribGroupStats / studentStats: optional second argument, lastAt inside the range', async () => {
  const range = { start: d('2026-08-01T00:00:00Z'), end: d('2026-08-31T00:00:00Z'), all: false };
  const rows = await contribGroupStats(db, { by: 'author', range });
  assert.deepEqual([...rows.keys()].sort(), ['alice', 'bob']);
  assert.deepEqual(pick(rows.get('bob'), ['issues', 'osIssues', 'reviews', 'osReviews']), { issues: 0, osIssues: 0, reviews: 1, osReviews: 1 });
  assert.equal(rows.get('bob').lastAt.toISOString(), '2026-08-25T10:00:00.000Z', 'last review is after the range: the first review date counts');
  const repos = await contribGroupStats(db, { by: 'repoLc', range: { all: true }, match: { kind: 'issue' } });
  assert.deepEqual(pick(repos.get('apache/airflow'), ['issues', 'osIssues', 'reviews']), { issues: 2, osIssues: 2, reviews: 0 });
  const st = studentStats({ opened: 1, merged: 0, osOpened: 1, osMerged: 0 });
  assert.deepEqual(pick(st, NEW_STATS), { osClosed: 0, totalIssues: 0, osIssues: 0, totalReviews: 0, osReviews: 0, osContributions: 1, lastActivityAt: null });
  assert.equal(studentStats(undefined, undefined).totalPrs, 0);
});

test('repo and org pages answer for issues or reviews without a PR; lists keep stats.prs > 0; nothing at all stays 404', async () => {
  const empty = { prs: 0, merged: 0, open: 0, closed: 0, students: 0, issues: 0, reviews: 0 };
  await c.repos.insertMany([
    { _id: 'midorg/tool', name: 'midorg/tool', owner: 'midorg', ownerLc: 'midorg', ownerType: 'Organization', stars: 10, category: 'low_signal', stats: { ...empty, reviews: 1 } },
    { _id: 'midorg/quiet', name: 'midorg/quiet', owner: 'midorg', ownerLc: 'midorg', ownerType: 'Organization', stars: 10, category: 'low_signal', stats: { ...empty } },
  ]);
  await c.owners.insertMany([
    { _id: 'midorg', login: 'midorg', type: 'Organization', stats: { prs: 0, students: 0, issues: 0, reviews: 1, osIssues: 0, osReviews: 0 } },
    { _id: 'quietorg', login: 'quietorg', type: 'Organization', stats: { prs: 0, students: 0, issues: 0, reviews: 0 } },
  ]);
  try {
    const one = await get('/api/repos/midorg/tool?range=all');
    assert.deepEqual([one.repo.name, one.repo.stats.prs, one.repo.stats.reviews, one.prs.total], ['midorg/tool', 0, 1, 0]);
    assert.equal((await app.get('/api/repos/midorg/quiet?range=all')).status, 404);
    assert.equal((await get('/api/repos?range=all')).items.some((r) => r.name.startsWith('midorg/')), false, 'lists keep stats.prs > 0');
    assert.equal((await get('/api/orgs/midorg?range=all')).org.login, 'midorg');
    assert.equal((await app.get('/api/orgs/quietorg?range=all')).status, 404);
    assert.equal((await get('/api/orgs?range=all')).items.some((o) => o.login === 'midorg'), false);
  } finally {
    await c.repos.deleteMany({ ownerLc: 'midorg' });
    await c.owners.deleteMany({ _id: { $in: ['midorg', 'quietorg'] } });
  }
});
