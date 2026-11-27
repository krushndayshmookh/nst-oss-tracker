// Addendum I (agent A): issue / review fetching, document mapping, upsert, prune and the sync integration.
// Real mongod, mocked GitHub (test/helpers/github.js).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo } from './helpers/mongo.js';
import { fakeSleep, issueNode, json, mockGitHub, reviewNode } from './helpers/github.js';
import { insertStudents, prNode } from './helpers/fixtures.js';
import { collections, COLLECTIONS, ensureIndexes } from '../src/db.js';
import { invalidateContext } from '../src/classify.js';
import { buildContributionDocs, pruneStaleContributions, upsertContributions } from '../src/contributions.js';
import { fetchUserIssues, fetchUserReviews, fetchUserPRs, ISSUE_FIELDS, PR_FIELDS, REPO_FIELDS, SEARCH_QUERY, searchQuery } from '../src/github.js';
import * as realGithub from '../src/github.js';
import { backfill, sync } from '../src/jobHandlers.js';

const NOW = new Date('2026-11-19T21:00:00Z');
const LAST = new Date('2026-11-18T21:00:00Z');
const D = (s) => new Date(s);

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
  return { lines, log: (l) => lines.push(l), progress: () => {} };
}
const student = (extra = {}) => ({ _id: 'alice', username: 'Alice', campus: 'RU', batch: 2025, active: true, ...extra });
const ghOpts = (gh) => ({ fetch: gh.fetch, token: 't', sleep: fakeSleep(), now: () => NOW });

// ---------- github.js ----------

test('github: PR search is unchanged; issue and review searches use their own fields and query text', async () => {
  assert.equal(SEARCH_QUERY, searchQuery(PR_FIELDS));
  assert.ok(PR_FIELDS.includes(REPO_FIELDS) && ISSUE_FIELDS.includes(REPO_FIELDS), 'same repository fields everywhere');
  const gh = mockGitHub({ users: [{ login: 'Alice', id: 42,
    prs: [prNode({ number: 1 })],
    issues: [issueNode({ number: 2, updatedAt: '2026-11-18T00:00:00Z' }), issueNode({ number: 3, createdAt: '2025-01-01T00:00:00Z' })],
    reviews: [reviewNode({ number: 4 }), reviewNode({ number: 5, prAuthor: 'alice' })] }] });
  const o = ghOpts(gh);
  const prs = await fetchUserPRs('Alice', o);
  assert.deepEqual([prs.count, prs.error, gh.graphql().length, gh.contribCalls.length], [1, '', 1, 0]);
  const iss = await fetchUserIssues('Alice', { ...o, since: D('2026-11-17T05:00:00Z') });
  assert.equal(gh.contribCalls[0].q, 'author:Alice type:issue updated:>=2026-11-17');
  assert.match(gh.contribCalls[0].query, /\.\.\. on Issue\{databaseId url number title state stateReason/);
  assert.deepEqual([iss.count, iss.nodes.map((n) => n.number), iss.error, iss.fatal], [1, [2], '', false]);
  const rev = await fetchUserReviews('Alice', o);
  assert.equal(gh.contribCalls[1].q, 'reviewed-by:Alice type:pr -author:Alice');
  assert.match(gh.contribCalls[1].query, /reviews\(last:50, author:"Alice"\)\{totalCount nodes\{state submittedAt url\}\}/);
  assert.deepEqual(rev.nodes.map((n) => n.number), [4], '-author: drops own PRs');
  assert.deepEqual(gh.graphql().length, 1, 'contribution searches are not recorded with the PR searches');
  // same validation as fetchUserPRs: the login never reaches the query text
  const bad = await fetchUserReviews('x") { evil }', o);
  assert.match(bad.error, /invalid GitHub login/);
  assert.equal(gh.contribCalls.length, 2);
  assert.equal(typeof realGithub.default.fetchUserIssues, 'function');
  assert.equal(typeof realGithub.default.fetchUserReviews, 'function');
  assert.ok(COLLECTIONS.includes('contributions'));
});

test('github: issue search above 1000 results is split by created: year like PRs', async () => {
  const issues = Array.from({ length: 1200 }, (_, i) => issueNode({ number: i + 1, createdAt: `${i < 600 ? 2024 : 2025}-03-01T00:00:00Z` }));
  const gh = mockGitHub({ users: [{ login: 'big', id: 1, issues }] });
  const r = await fetchUserIssues('big', ghOpts(gh));
  assert.equal(r.error, '');
  assert.equal(r.count, 1200);
  assert.equal(r.nodes.length, 1200);
  assert.ok(gh.contribCalls.some((c) => c.q === 'author:big type:issue created:2024-01-01..2024-12-31'));
});

// ---------- document mapping ----------

test('buildContributionDocs (issue): every field of I1, private repos skipped, duplicates dropped', () => {
  const s = student();
  const open = issueNode({ repo: 'apache/airflow', number: 10, title: '  Crash\n on   start ', createdAt: '2026-11-01T00:00:00Z', comments: 4, databaseId: 99 });
  const done = issueNode({ repo: 'apache/airflow', number: 11, state: 'CLOSED', stateReason: 'COMPLETED', closedAt: '2026-11-05T00:00:00Z' });
  const np = issueNode({ repo: 'kubernetes/kubernetes', number: 12, state: 'CLOSED', stateReason: 'NOT_PLANNED', stars: 90000 });
  const reo = issueNode({ number: 13, stateReason: 'REOPENED' });
  const dup = issueNode({ number: 14, state: 'CLOSED', stateReason: 'DUPLICATE' });
  const odd = issueNode({ number: 16, stateReason: 'SOMETHING_NEW' });
  const priv = issueNode({ repo: 'secret/x', number: 15, isPrivate: true });
  const out = buildContributionDocs(s, 'issue', [open, done, np, reo, dup, odd, priv, open, null, { url: 'x' }]);
  assert.equal(out.skippedPrivate, 1);
  assert.equal(out.docs.length, 6);
  assert.deepEqual(out.docs[0], {
    _id: open.url, kind: 'issue', url: open.url, number: 10, title: 'Crash on start', author: 'alice', authorLogin: 'alice',
    repo: 'apache/airflow', repoLc: 'apache/airflow', owner: 'apache', ownerLc: 'apache', ownerType: 'Organization', stars: 5000,
    ghId: 99, state: 'open', stateReason: null, createdAt: D('2026-11-01T00:00:00Z'), closedAt: null, updatedAt: D('2026-11-01T00:00:00Z'),
    comments: 4, campus: 'RU', batch: 2025, active: true,
  });
  assert.deepEqual(out.docs.map((d) => [d.state, d.stateReason]), [['open', null], ['closed', 'completed'], ['closed', 'not_planned'], ['open', 'reopened'], ['closed', 'duplicate'], ['open', null]]);
  assert.equal(out.docs[1].closedAt.toISOString(), '2026-11-05T00:00:00.000Z');
  assert.ok(!('prUrl' in out.docs[0]) && !('reviewCount' in out.docs[0]), 'review-only keys are not on issues');
  assert.deepEqual([...out.repos.keys()].sort(), ['apache/airflow', 'kubernetes/kubernetes']);
  assert.deepEqual(out.repos.get('kubernetes/kubernetes').stars, 90000);
  assert.deepEqual(out.repos.get('apache/airflow').languages, [{ name: 'Go', bytes: 100, pct: 100 }]);
  assert.deepEqual(out.repos.get('apache/airflow').topics, ['scheduler']);
  assert.deepEqual(out.owners.get('apache'), { _id: 'apache', login: 'apache', type: 'Organization' });
  assert.throws(() => buildContributionDocs(s, 'comment', []), /unknown contribution kind/);
});

test('buildContributionDocs (review): own PRs skipped, PENDING ignored, state resolution, first / last review dates', () => {
  const s = student({ _id: 'alice', username: 'AliceNew' }); // renamed: both logins count as the student's own
  const R = (state, at) => ({ state, submittedAt: at });
  const approvedThenComment = reviewNode({ number: 1, prAuthor: 'bob', state: 'MERGED', mergedAt: '2026-10-09T00:00:00Z', closedAt: '2026-10-09T00:00:00Z',
    updatedAt: '2026-10-09T00:00:00Z',
    reviews: [R('COMMENTED', '2026-10-05T00:00:00Z'), R('APPROVED', '2026-10-03T00:00:00Z'), R('PENDING', null), R('COMMENTED', '2026-10-07T00:00:00Z')] });
  const commentOnly = reviewNode({ number: 2, reviews: [R('COMMENTED', '2026-10-02T00:00:00Z')] });
  const changes = reviewNode({ number: 3, state: 'CLOSED', closedAt: '2026-10-10T00:00:00Z', reviews: [R('APPROVED', '2026-10-01T00:00:00Z'), R('CHANGES_REQUESTED', '2026-10-02T00:00:00Z')] });
  const dismissed = reviewNode({ number: 4, reviews: [R('CHANGES_REQUESTED', '2026-10-01T00:00:00Z'), R('DISMISSED', '2026-10-02T00:00:00Z'), R('COMMENTED', '2026-10-03T00:00:00Z')] });
  const ownById = reviewNode({ number: 5, prAuthor: 'ALICE' });
  const ownByName = reviewNode({ number: 6, prAuthor: 'alicenew' });
  const pendingOnly = reviewNode({ number: 7, reviews: [R('PENDING', null)] });
  const none = reviewNode({ number: 8, reviews: [] });
  const priv = reviewNode({ number: 9, isPrivate: true });
  const many = reviewNode({ number: 10, totalCount: 60, reviews: Array.from({ length: 50 }, (_, i) => R('COMMENTED', `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z`)) });
  const ghost = reviewNode({ number: 11, prAuthor: null });
  const out = buildContributionDocs(s, 'review', [approvedThenComment, commentOnly, changes, dismissed, ownById, ownByName, pendingOnly, none, priv, many, ghost]);
  assert.equal(out.skippedPrivate, 1);
  assert.deepEqual(out.docs.map((d) => d.number), [1, 2, 3, 4, 10, 11]);
  const [a, b, c, d, m, g] = out.docs;
  assert.deepEqual(a, {
    _id: `${approvedThenComment.url}#review-by-alice`, kind: 'review', url: approvedThenComment.reviews.nodes[3].url, number: 1, title: 'Fix scheduler race',
    author: 'alice', authorLogin: 'AliceNew',
    repo: 'apache/airflow', repoLc: 'apache/airflow', owner: 'apache', ownerLc: 'apache', ownerType: 'Organization', stars: 5000,
    state: 'approved', createdAt: D('2026-10-03T00:00:00Z'), closedAt: null, updatedAt: D('2026-10-09T00:00:00Z'),
    prUrl: approvedThenComment.url, prAuthor: 'bob', prState: 'merged', reviewCount: 3, lastReviewedAt: D('2026-10-07T00:00:00Z'),
    campus: 'RU', batch: 2025, active: true,
  });
  assert.deepEqual([b.state, b.prState, b.reviewCount], ['commented', 'open', 1]);
  assert.deepEqual([c.state, c.prState], ['changes_requested', 'closed']);
  assert.equal(d.state, 'dismissed', 'latest decisive review wins over a later comment');
  assert.equal(m.reviewCount, 60, 'reviews beyond the first 50 still count');
  assert.equal(m.createdAt.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(g.prAuthor, null);
  const fallback = buildContributionDocs(s, 'review', [reviewNode({ number: 12, reviews: [{ state: 'APPROVED', submittedAt: '2026-10-01T00:00:00Z', url: null }] })]).docs[0];
  assert.equal(fallback.url, fallback.prUrl, 'no review url: the PR url');
});

// ---------- upsert / prune ----------

test('upsertContributions: idempotent, added counts, repo / owner metadata upserted without touching overrides or stats', async () => {
  const db = await freshDb();
  const c = collections(db);
  const [s] = await insertStudents(db, [{ username: 'alice' }]);
  await c.repos.insertOne({ _id: 'tiny/excluded', name: 'tiny/excluded', ownerLc: 'tiny', override: 'exclude', overrideNote: 'spam', stars: 1,
    stats: { prs: 3, merged: 1 }, category: 'low_signal', tier: null });
  await c.owners.insertOne({ _id: 'goodorg', login: 'goodorg', type: 'Organization', override: 'include', stats: { prs: 9 } });
  const nodes = [
    issueNode({ repo: 'tiny/excluded', number: 1, stars: 50000 }),
    issueNode({ repo: 'goodorg/small', number: 2, stars: 2 }),
    issueNode({ repo: 'alice/dotfiles', number: 3, stars: 0, ownerType: 'User' }),
    issueNode({ repo: 'kubernetes/kubernetes', number: 4, stars: 90000 }),
  ];
  const first = await upsertContributions(db, s, 'issue', nodes);
  assert.deepEqual(first, { contributions: 4, added: 4, repos: 4 });
  const again = await upsertContributions(db, s, 'issue', [...nodes, issueNode({ repo: 'kubernetes/kubernetes', number: 5, stars: 90000 })]);
  assert.deepEqual(again, { contributions: 5, added: 1, repos: 4 });
  assert.equal(await c.contributions.countDocuments(), 5);

  const by = new Map((await c.contributions.find({}).toArray()).map((d) => [d.number, d]));
  assert.deepEqual([by.get(1).category, by.get(1).reason], ['low_signal', 'admin: repo excluded']);
  assert.deepEqual([by.get(2).category, by.get(2).reason], ['open_source', 'admin: org included']);
  assert.deepEqual([by.get(3).category], ['own_repo']);
  assert.deepEqual([by.get(4).category, by.get(4).tier], ['open_source', 'major']);
  assert.ok(!('override' in by.get(4)), 'no per-item override field');

  const ex = await c.repos.findOne({ _id: 'tiny/excluded' });
  assert.deepEqual([ex.override, ex.overrideNote, ex.stars, ex.stats], ['exclude', 'spam', 50000, { prs: 3, merged: 1 }]);
  const k8s = await c.repos.findOne({ _id: 'kubernetes/kubernetes' });
  assert.deepEqual([k8s.stats.prs, k8s.override, k8s.category, k8s.language], [0, null, 'open_source', 'Go'], 'new repo: empty stats, hidden from public lists');
  const org = await c.owners.findOne({ _id: 'goodorg' });
  assert.deepEqual([org.override, org.stats], ['include', { prs: 9 }]);
  assert.equal((await c.owners.findOne({ _id: 'kubernetes' })).stats.prs, 0);
  assert.deepEqual(await upsertContributions(db, s, 'review', []), { contributions: 0, added: 0, repos: 0 });
});

test('pruneStaleContributions: removes what a complete fetch no longer returns, with the pruneStalePRs guards', async () => {
  const db = await freshDb();
  const c = collections(db);
  const [s] = await insertStudents(db, [{ username: 'alice' }]);
  const issues = Array.from({ length: 30 }, (_, i) => issueNode({ number: i + 1 }));
  const reviews = [reviewNode({ number: 100 })];
  await upsertContributions(db, s, 'issue', issues);
  await upsertContributions(db, s, 'review', reviews);

  assert.deepEqual(await pruneStaleContributions(db, s, 'issue', issues), { removed: 0, skipped: '' });
  assert.match((await pruneStaleContributions(db, s, 'issue', [])).skipped, /GitHub returned no issues but 30 are stored/);
  assert.match((await pruneStaleContributions(db, s, 'issue', issues.slice(0, 5))).skipped, /25 of 30 stored issues are missing/);
  assert.equal(await c.contributions.countDocuments({ kind: 'issue' }), 30);

  assert.deepEqual(await pruneStaleContributions(db, s, 'issue', issues.slice(0, 20)), { removed: 10, skipped: '' });
  assert.equal(await c.contributions.countDocuments({ kind: 'issue' }), 20);
  assert.equal(await c.contributions.countDocuments({ kind: 'review' }), 1, 'the other kind is left alone');
  // a small vanishing set is removed even when it is more than half
  const two = [reviewNode({ number: 101 }), reviewNode({ number: 102 })];
  await upsertContributions(db, s, 'review', two);
  assert.deepEqual(await pruneStaleContributions(db, s, 'review', [two[0]]), { removed: 2, skipped: '' });
  assert.deepEqual((await c.contributions.find({ kind: 'review' }).toArray()).map((d) => d.number), [101]);
});

// ---------- sync / backfill integration ----------

function setup(users) {
  const gh = mockGitHub({ users });
  return { gh, opts: { fetch: gh.fetch, token: 'test-token', sleep: fakeSleep(), now: () => NOW, concurrency: 2 } };
}

test('sync: the first run fetches the full history of both kinds and sets contribSyncedAt; later runs are incremental', async () => {
  const db = await freshDb();
  const c = collections(db);
  await insertStudents(db, [{ username: 'Alice', lastSyncedAt: LAST, githubId: 42, loginCheckedAt: LAST }]);
  const user = { login: 'Alice', id: 42, prs: [],
    issues: [issueNode({ number: 1, createdAt: '2024-01-01T00:00:00Z' }), issueNode({ number: 2, createdAt: '2026-11-18T00:00:00Z' })],
    reviews: [reviewNode({ number: 3, createdAt: '2025-05-01T00:00:00Z', reviews: [{ state: 'APPROVED', submittedAt: '2025-05-02T00:00:00Z' }] }),
      reviewNode({ number: 4, prAuthor: 'Alice' })] };
  const { gh, opts } = setup([user]);
  const ctx = ctxOf();
  const s1 = await sync(db, {}, ctx, opts);
  assert.deepEqual(gh.graphql().map((x) => x.q), ['author:Alice type:pr updated:>=2026-11-16'], 'PR search unchanged');
  assert.deepEqual(gh.contribCalls.map((x) => x.q), ['author:Alice type:issue', 'reviewed-by:Alice type:pr -author:Alice'], 'full contribution history');
  assert.deepEqual([s1.ok, s1.failed, s1.issues, s1.issuesNew, s1.reviews, s1.reviewsNew, s1.contribFailed], [1, 0, 2, 2, 1, 1, 0]);
  assert.equal((await c.students.findOne({ _id: 'alice' })).contribSyncedAt.toISOString(), NOW.toISOString());
  assert.ok(ctx.lines.includes('alice: 2 issues (2 new), 1 reviews (1 new) saved'));
  assert.match(ctx.lines.at(-1), /^done: 1 ok, 0 failed, 0 not found, 0 PRs saved \(0 new, 0 newly merged\), 2 issues \(2 new\), 1 reviews \(1 new\), 0 contribution fetches failed, 0 renamed$/);
  const docs = await c.contributions.find({}).sort({ number: 1 }).toArray();
  assert.deepEqual(docs.map((d) => [d.kind, d.number, d.campus, d.batch, d.active]), [['issue', 1, 'RU', 2025, true], ['issue', 2, 'RU', 2025, true], ['review', 3, 'RU', 2025, true]]);

  // next night: incremental from contribSyncedAt - 2 days; one new issue
  user.issues.push(issueNode({ number: 5, createdAt: '2026-11-19T00:00:00Z' }));
  gh.contribCalls.length = 0;
  const later = new Date('2026-11-20T21:00:00Z');
  const s2 = await sync(db, {}, ctxOf(), { ...opts, now: () => later });
  assert.deepEqual(gh.contribCalls.map((x) => x.q), ['author:Alice type:issue updated:>=2026-11-17', 'reviewed-by:Alice type:pr -author:Alice updated:>=2026-11-17']);
  assert.deepEqual([s2.issues, s2.issuesNew, s2.reviews, s2.reviewsNew], [2, 1, 0, 0], 'the overlap window re-writes issue 2, adds issue 5');
  assert.equal((await c.students.findOne({ _id: 'alice' })).contribSyncedAt.toISOString(), later.toISOString());
  assert.equal(await c.contributions.countDocuments(), 4);
});

test('sync: an error in one kind keeps what was fetched, leaves contribSyncedAt and counts contribFailed; PR outcome stays ok', async () => {
  const db = await freshDb();
  const c = collections(db);
  await insertStudents(db, [{ username: 'alice', lastSyncedAt: LAST, githubId: 42, loginCheckedAt: LAST, contribSyncedAt: LAST }]);
  const { gh, opts } = setup([{ login: 'alice', id: 42,
    prs: [prNode({ number: 1, createdAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-19T00:00:00Z', author: { login: 'alice', databaseId: 42 } })],
    issues: [issueNode({ number: 2, createdAt: '2026-11-19T00:00:00Z' })], reviews: [reviewNode({ number: 3, updatedAt: '2026-11-19T00:00:00Z' })] }]);
  gh.contribIntercept = (x) => (/reviewed-by:/.test(x.q) ? new Response('Bad Gateway', { status: 502 }) : undefined);
  const ctx = ctxOf();
  const s = await sync(db, {}, ctx, opts);
  assert.deepEqual([s.ok, s.failed, s.studentsFailed, s.prs, s.issues, s.reviews, s.contribFailed], [1, 0, 0, 1, 1, 0, 1]);
  assert.ok(ctx.lines.some((l) => /^alice: reviews failed: /.test(l)));
  const st = await c.students.findOne({ _id: 'alice' });
  assert.equal(st.contribSyncedAt.toISOString(), LAST.toISOString(), 'not moved');
  assert.equal(st.lastSyncedAt.toISOString(), NOW.toISOString(), 'the PR part succeeded');
  assert.equal(st.backfill.status, 'done');
  assert.equal(await c.contributions.countDocuments({ kind: 'issue' }), 1, 'issues kept');
  assert.equal(gh.contribCalls[0].q, 'author:alice type:issue updated:>=2026-11-16', 'incremental from contribSyncedAt - 2 days');

  // a PR failure skips contributions entirely
  gh.contribIntercept = null;
  gh.contribCalls.length = 0;
  gh.intercept = (x) => (x.kind === 'graphql' ? new Response('Bad Gateway', { status: 502 }) : undefined);
  const f = await sync(db, {}, ctxOf(), opts);
  assert.deepEqual([f.failed, f.contribFailed, gh.contribCalls.length], [1, 0, 0]);
});

test('sync: a bad token on a contribution search aborts the run', async () => {
  const db = await freshDb();
  await insertStudents(db, [{ username: 'alice', lastSyncedAt: LAST, githubId: 42, loginCheckedAt: LAST }]);
  const { gh, opts } = setup([{ login: 'alice', id: 42, prs: [] }]);
  gh.contribIntercept = () => json({ message: 'Bad credentials' }, { status: 401 });
  await assert.rejects(sync(db, {}, ctxOf(), opts), /aborted: issues: .*401/);
  assert.equal(gh.contribCalls.length, 1, 'the review search is not tried after a fatal error');
});

test('backfill: a complete full fetch prunes contributions GitHub no longer returns; an incomplete one does not', async () => {
  const db = await freshDb();
  const c = collections(db);
  const [s] = await insertStudents(db, [{ username: 'alice', githubId: 42, loginCheckedAt: LAST, contribSyncedAt: LAST }]);
  await upsertContributions(db, s, 'issue', [issueNode({ number: 1 }), issueNode({ number: 2 })]);
  await upsertContributions(db, s, 'review', [reviewNode({ number: 3 })]);
  const { gh, opts } = setup([{ login: 'alice', id: 42, prs: [prNode({ number: 9, author: { login: 'alice', databaseId: 42 } })],
    issues: [issueNode({ number: 1 })], reviews: [reviewNode({ number: 4 })] }]);
  const ctx = ctxOf();
  const r = await backfill(db, { users: ['alice'] }, ctx, opts);
  assert.deepEqual([r.ok, r.issues, r.issuesNew, r.reviews, r.reviewsNew, r.contribFailed], [1, 1, 0, 1, 1, 0]);
  assert.deepEqual(gh.contribCalls.map((x) => x.q), ['author:alice type:issue', 'reviewed-by:alice type:pr -author:alice'], 'a full run fetches full history');
  assert.deepEqual((await c.contributions.find({}).sort({ number: 1 }).toArray()).map((d) => d.number), [1, 4]);
  assert.ok(ctx.lines.includes('alice: 1 issues no longer on GitHub removed'));

  // GitHub reports more issues than it returned: nothing is removed
  await upsertContributions(db, s, 'issue', [issueNode({ number: 7 })]);
  gh.contribIntercept = (x) => (/type:issue/.test(x.q)
    ? json({ data: { s: { issueCount: 50, pageInfo: { hasNextPage: false, endCursor: '1' }, nodes: [issueNode({ number: 1 })] }, rateLimit: gh.rateLimit } })
    : undefined);
  const ctx2 = ctxOf();
  await backfill(db, { users: ['alice'] }, ctx2, opts);
  assert.equal(await c.contributions.countDocuments({ kind: 'issue' }), 2);
  assert.ok(ctx2.lines.some((l) => /GitHub reported 50 issues but returned 1: stale issues are not removed/.test(l)));
});

test('sync: student edited or removed while the contribution search is in flight', async () => {
  const db = await freshDb();
  const c = collections(db);
  await insertStudents(db, [
    { username: 'alice', campus: 'RU', lastSyncedAt: LAST, githubId: 42, loginCheckedAt: LAST },
    { username: 'bob', lastSyncedAt: LAST, githubId: 43, loginCheckedAt: LAST },
  ]);
  const { gh, opts } = setup([
    { login: 'alice', id: 42, prs: [], issues: [issueNode({ number: 1 })] },
    { login: 'bob', id: 43, prs: [], issues: [issueNode({ number: 2 })] },
  ]);
  gh.contribIntercept = async (x) => {
    if (x.q === 'author:alice type:issue') await c.students.updateOne({ _id: 'alice' }, { $set: { campus: 'ADYPU', batch: 2026, active: false } });
    if (x.q === 'author:bob type:issue') await c.students.deleteOne({ _id: 'bob' });
    return undefined;
  };
  const ctx = ctxOf();
  await sync(db, { concurrency: 1 }, ctx, opts);
  const a = await c.contributions.findOne({ author: 'alice' });
  assert.deepEqual([a.campus, a.batch, a.active], ['ADYPU', 2026, false], 'the student as stored now wins');
  assert.equal(await c.contributions.countDocuments({ author: 'bob' }), 0);
  assert.ok(ctx.lines.includes('bob: removed while the run was in flight, nothing saved'));
});

test('sync: an injected github without the new functions skips both kinds and leaves contribSyncedAt unset', async () => {
  const db = await freshDb();
  const c = collections(db);
  await insertStudents(db, [{ username: 'alice', lastSyncedAt: LAST, githubId: 42, loginCheckedAt: LAST }]);
  const github = {
    fetchUserPRs: async () => ({ nodes: [], count: 0, error: '', fatal: false, rateLimit: null }),
    getUser: async () => null, getUserById: async () => null,
  };
  const s = await sync(db, {}, ctxOf(), { github, now: () => NOW });
  assert.deepEqual([s.ok, s.issues, s.reviews, s.contribFailed], [1, 0, 0, 0]);
  assert.equal((await c.students.findOne({ _id: 'alice' })).contribSyncedAt, undefined);
  // only one kind present: it is fetched, but contribSyncedAt still needs both
  github.fetchUserIssues = async () => ({ nodes: [issueNode({ number: 1 })], count: 1, error: '', fatal: false, rateLimit: null });
  const t = await sync(db, {}, ctxOf(), { github, now: () => NOW });
  assert.deepEqual([t.issues, t.issuesNew], [1, 1]);
  assert.equal((await c.students.findOne({ _id: 'alice' })).contribSyncedAt, undefined);
});

// ---------- review fixes (finding 3, 4, 5, 7) ----------

test('sync: after 25 students in a row whose contribution search failed, issues and reviews are skipped for the rest of the run', async () => {
  const db = await freshDb();
  const c = collections(db);
  const users = Array.from({ length: 28 }, (_, i) => `u${String(i).padStart(2, '0')}`);
  await insertStudents(db, users.map((u, i) => ({ username: u, lastSyncedAt: LAST, githubId: 100 + i, loginCheckedAt: LAST, contribSyncedAt: LAST })));
  const { gh, opts } = setup(users.map((u, i) => ({ login: u, id: 100 + i, prs: [], issues: [], reviews: [] })));
  gh.contribIntercept = (x) => (/reviewed-by:/.test(x.q) ? new Response('Bad Gateway', { status: 502 }) : undefined);
  const ctx = ctxOf();
  const s = await sync(db, {}, ctx, { ...opts, concurrency: 1 });
  assert.deepEqual([s.ok, s.failed, s.contribFailed, s.contribSkipped], [28, 0, 25, 3]);
  assert.equal(ctx.lines.filter((l) => l === 'issues and reviews skipped for the rest of this run after 25 consecutive failures').length, 1);
  assert.equal(new Set(gh.contribCalls.map((x) => /(?:author|reviewed-by):(\S+)/.exec(x.q)[1])).size, 25, 'no search for the skipped students');
  assert.equal(await c.students.countDocuments({ lastSyncedAt: NOW }), 28, 'PR syncing carries on');
  assert.equal(await c.students.countDocuments({ contribSyncedAt: LAST }), 28, 'contribSyncedAt not moved');
  assert.match(ctx.lines.at(-1), /25 contribution fetches failed, 3 skipped, 0 renamed$/);

  // one student whose searches succeed resets the count
  const more = Array.from({ length: 30 }, (_, i) => `v${String(i).padStart(2, '0')}`);
  await c.students.deleteMany({});
  await insertStudents(db, more.map((u, i) => ({ username: u, lastSyncedAt: LAST, githubId: 200 + i, loginCheckedAt: LAST, contribSyncedAt: LAST })));
  const two = setup(more.map((u, i) => ({ login: u, id: 200 + i, prs: [], issues: [], reviews: [] })));
  const seen = [];
  two.gh.contribIntercept = (x) => {
    const m = /reviewed-by:(\S+)/.exec(x.q);
    if (!m) return undefined;
    if (!seen.includes(m[1])) seen.push(m[1]);
    return seen.indexOf(m[1]) === 9 ? undefined : new Response('Bad Gateway', { status: 502 });
  };
  const t = await sync(db, {}, ctxOf(), { ...two.opts, concurrency: 1 });
  assert.deepEqual([t.contribFailed, t.contribSkipped], [29, 0]);
  assert.equal(await c.students.countDocuments({ contribSyncedAt: NOW }), 1);
});

test('sync: a login rename reclassifies the contributions on repos of the new login (applyRename contribFilter)', async () => {
  const db = await freshDb();
  const c = collections(db);
  const [alice] = await insertStudents(db, [
    { username: 'alice', lastSyncedAt: LAST, githubId: 42, loginCheckedAt: LAST, contribSyncedAt: LAST },
    { username: 'bob', lastSyncedAt: LAST, githubId: 43, loginCheckedAt: null },
  ]);
  await upsertContributions(db, alice, 'issue', [issueNode({ repo: 'newbob/tool', number: 1, stars: 5, ownerType: 'User' })]);
  assert.equal((await c.contributions.findOne({ repoLc: 'newbob/tool' })).category, 'low_signal');
  const { opts } = setup([{ login: 'newbob', id: 43, prs: [] }]);
  const s = await sync(db, { users: ['bob'] }, ctxOf(), opts);
  assert.equal(s.renamed, 1);
  const d = await c.contributions.findOne({ repoLc: 'newbob/tool' });
  assert.deepEqual([d.category, d.reason], ['peer_repo', 'owner is an NST student']);
});

test('sync: a review keeps its first review date across a full and an incremental run; later reviews update count and date', async () => {
  const db = await freshDb();
  const c = collections(db);
  await insertStudents(db, [{ username: 'alice', lastSyncedAt: LAST, githubId: 42, loginCheckedAt: LAST }]);
  const R = (state, at) => ({ state, submittedAt: at });
  const user = { login: 'alice', id: 42, prs: [],
    reviews: [reviewNode({ number: 3, updatedAt: '2025-05-02T00:00:00Z', reviews: [R('APPROVED', '2025-05-02T00:00:00Z')] })] };
  const { gh, opts } = setup([user]);
  await sync(db, {}, ctxOf(), opts);
  const id = `${user.reviews[0].url}#review-by-alice`;
  let d = await c.contributions.findOne({ _id: id });
  assert.deepEqual([d.createdAt.toISOString(), d.reviewCount, d.state], ['2025-05-02T00:00:00.000Z', 1, 'approved']);

  user.reviews.splice(0, 1, reviewNode({ number: 3, updatedAt: '2026-11-20T00:00:00Z', reviews: [R('APPROVED', '2025-05-02T00:00:00Z'), R('COMMENTED', '2026-11-20T00:00:00Z')] }));
  gh.contribCalls.length = 0;
  const later = new Date('2026-11-20T21:00:00Z');
  await sync(db, {}, ctxOf(), { ...opts, now: () => later });
  assert.match(gh.contribCalls[1].q, /updated:>=2026-11-17$/, 'incremental');
  d = await c.contributions.findOne({ _id: id });
  assert.deepEqual([d.createdAt.toISOString(), d.lastReviewedAt.toISOString(), d.reviewCount, d.state],
    ['2025-05-02T00:00:00.000Z', '2026-11-20T00:00:00.000Z', 2, 'approved']);

  // more than 50 reviews: only the latest 50 are listed; the first review date never moves later
  const latest50 = Array.from({ length: 50 }, (_, i) => R(i === 49 ? 'CHANGES_REQUESTED' : 'COMMENTED', new Date(Date.UTC(2026, 10, 21, 0, i)).toISOString()));
  user.reviews.splice(0, 1, reviewNode({ number: 3, updatedAt: '2026-11-21T01:00:00Z', totalCount: 60, reviews: latest50 }));
  await sync(db, {}, ctxOf(), { ...opts, now: () => new Date('2026-11-21T21:00:00Z') });
  d = await c.contributions.findOne({ _id: id });
  assert.deepEqual([d.createdAt.toISOString(), d.lastReviewedAt.toISOString(), d.reviewCount, d.state],
    ['2025-05-02T00:00:00.000Z', '2026-11-21T00:49:00.000Z', 60, 'changes_requested']);
  // a first upsert with an overflowing list takes the earliest listed review
  const [bob] = await insertStudents(db, [{ username: 'bob' }]);
  await upsertContributions(db, bob, 'review', user.reviews);
  assert.equal((await c.contributions.findOne({ author: 'bob' })).createdAt.toISOString(), '2026-11-21T00:00:00.000Z');
});

test('issues: a transferred issue (same GitHub id, new url) replaces the stored one on an incremental run and in prune', async () => {
  const db = await freshDb();
  const c = collections(db);
  const [alice] = await insertStudents(db, [{ username: 'alice', lastSyncedAt: LAST, githubId: 42, loginCheckedAt: LAST, contribSyncedAt: LAST }]);
  await upsertContributions(db, alice, 'issue', [issueNode({ repo: 'old/repo', number: 5, databaseId: 777 }), issueNode({ repo: 'old/repo', number: 6, databaseId: 778 })]);
  const { opts } = setup([{ login: 'alice', id: 42, prs: [],
    issues: [issueNode({ repo: 'new/repo', number: 9, databaseId: 777, createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-11-19T00:00:00Z' })] }]);
  await sync(db, {}, ctxOf(), opts);
  assert.deepEqual((await c.contributions.find({ kind: 'issue' }).sort({ number: 1 }).toArray()).map((d) => [d.repo, d.number, d.ghId]),
    [['old/repo', 6, 778], ['new/repo', 9, 777]], 'old url gone, the other issue untouched');

  // prune: 30 issues that all came back under new urls are moved, not vanished: the guard does not stop them
  await c.contributions.deleteMany({});
  const old = Array.from({ length: 30 }, (_, i) => issueNode({ repo: 'old/many', number: i + 1, databaseId: 9000 + i }));
  await upsertContributions(db, alice, 'issue', old);
  const moved = old.map((n, i) => issueNode({ repo: 'new/many', number: i + 1, databaseId: 9000 + i }));
  assert.deepEqual(await pruneStaleContributions(db, alice, 'issue', moved), { removed: 30, skipped: '' });
});
