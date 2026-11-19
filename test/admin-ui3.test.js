// Addendum E, admin frontend: the pure helpers the Review / Pull requests pages use to grey the button of the state a
// row is already in and to say where a category comes from, and the API facts those helpers read (the `reason`
// strings of SPEC section 3 and the admin fields on the public detail endpoints). Real mongod.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMongo } from './helpers/mongo.js';
import { startApp } from './helpers/app.js';
import { insertStudents, prNode } from './helpers/fixtures.js';
import { collections, ensureIndexes } from '../src/db.js';
import { refreshAggregates, upsertPRs } from '../src/ingest.js';
import { invalidateContext } from '../src/classify.js';
import { alreadyText, prSource, repoSource, reviewHref } from '../public/js/admin/decisions.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let mongo;
let app;
let db;

before(async () => {
  mongo = await startMongo();
  db = mongo.client.db('adminui3');
  await ensureIndexes(db);
  invalidateContext();
  await insertStudents(db, [{ username: 'alice', name: 'Alice A' }, { username: 'bob', name: 'Bob B' }]);
  const { students } = collections(db);
  const alice = await students.findOne({ _id: 'alice' });
  const bob = await students.findOne({ _id: 'bob' });
  await upsertPRs(db, alice, [
    prNode({ repo: 'bigorg/engine', number: 1, stars: 5000 }),
    prNode({ repo: 'smallorg/tool', number: 2, stars: 3 }),
    prNode({ repo: 'smallorg/tool', number: 3, stars: 3, state: 'OPEN' }),
    prNode({ repo: 'smallorg/other', number: 4, stars: 2 }),
  ]);
  await upsertPRs(db, bob, [prNode({ repo: 'smallorg/tool', number: 5, stars: 3 })]);
  await refreshAggregates(db);
  app = await startApp(db);
  await app.login();
});
after(async () => { await app?.close(); await mongo?.stop(); });

const prs = async (query) => (await app.get(`/api/prs?category=all&range=all&${query}`)).body.items;
const byNumber = (items, n) => items.find((p) => p.number === n);

test('rule-based rows: source "rule"; Include is greyed only where the repository already counts', async () => {
  const review = (await app.get('/api/admin/review/repos')).body.items;
  const engine = review.find((r) => r.name === 'bigorg/engine');
  const tool = review.find((r) => r.name === 'smallorg/tool');
  assert.equal(repoSource(engine), 'rule');
  assert.equal(repoSource(tool), 'rule');
  assert.match(alreadyText('repo', engine, 'include'), /^Already included/);
  assert.equal(alreadyText('repo', engine, 'exclude'), null);
  assert.equal(alreadyText('repo', tool, 'include'), null);
  assert.equal(alreadyText('repo', tool, 'exclude'), null, 'a rule-based low-signal repository can still be excluded explicitly');
  for (const p of await prs('owner=smallorg')) assert.equal(prSource(p), 'rule');
});

test('repository decision: the repo is "admin", its pull requests are "repo" (via repo) and keep override null', async () => {
  const res = await app.post('/api/admin/repos/override', { repo: 'smallorg/tool', override: 'include', note: 'real project' });
  assert.equal(res.status, 200);
  assert.equal(repoSource(res.body.repo), 'admin');
  assert.equal(alreadyText('repo', res.body.repo, 'include'), 'Already included');
  assert.equal(alreadyText('repo', res.body.repo, 'exclude'), null);
  const items = await prs('repo=smallorg/tool');
  assert.equal(items.length, 3);
  for (const p of items) {
    assert.equal(p.override, null);
    assert.equal(p.category, 'open_source');
    assert.equal(prSource(p), 'repo');
  }
  // the detail panel reads the admin fields from the public detail endpoint
  const detail = (await app.get('/api/repos/smallorg/tool?range=all')).body;
  assert.equal(detail.repo.override, 'include');
  assert.equal(detail.repo.overrideNote, 'real project');
  assert.equal(detail.owner.override, null);
  assert.deepEqual(detail.students.map((s) => [s.username, s.prs, s.merged]).sort(), [['alice', 2, 1], ['bob', 1, 1]]);

  const excluded = (await app.post('/api/admin/repos/override', { repo: 'smallorg/tool', override: 'exclude' })).body.repo;
  assert.equal(alreadyText('repo', excluded, 'exclude'), 'Already excluded');
  assert.equal(alreadyText('repo', excluded, 'include'), null);
  for (const p of await prs('repo=smallorg/tool')) assert.equal(prSource(p), 'repo');
});

test('pull request mark: "admin" wins over the repository; only the explicit mark greys its button', async () => {
  const url = 'https://github.com/smallorg/tool/pull/2';
  const marked = (await app.post('/api/admin/prs/override', { url, override: 'open_source', note: 'substantial' })).body.pr;
  assert.equal(prSource(marked), 'admin');
  assert.equal(marked.override, 'open_source');
  const items = await prs('repo=smallorg/tool');
  assert.equal(prSource(byNumber(items, 2)), 'admin');
  assert.equal(byNumber(items, 2).overrideNote, 'substantial');
  assert.equal(prSource(byNumber(items, 3)), 'repo');
  const reset = (await app.post('/api/admin/prs/override', { url, override: null })).body.pr;
  assert.equal(reset.override, null);
  assert.equal(prSource(reset), 'repo');
});

test('owner decision: repositories without their own decision are "org", pull requests "org" (via org)', async () => {
  await app.post('/api/admin/repos/override', { repo: 'smallorg/tool', override: null });
  const res = await app.post('/api/admin/owners/override', { login: 'smallorg', override: 'nst_internal', note: 'club' });
  assert.equal(res.status, 200);
  assert.equal(alreadyText('owner', res.body.org, 'nst_internal'), 'Already NST internal');
  assert.equal(alreadyText('owner', res.body.org, 'include'), null);
  assert.equal(alreadyText('owner', res.body.org, 'exclude'), null);
  const review = (await app.get('/api/admin/review/repos?owner=smallorg')).body.items;
  assert.equal(review.length, 2);
  for (const r of review) {
    assert.equal(r.ownerOverride, 'nst_internal');
    assert.equal(repoSource(r), 'org');
    assert.equal(alreadyText('repo', r, 'include'), null);
  }
  for (const p of await prs('owner=smallorg')) assert.equal(prSource(p), 'org');
  // the org panel: repos come without ownerOverride, the reason alone must say "via org"
  const org = (await app.get('/api/orgs/smallorg?range=all')).body;
  assert.equal(org.org.override, 'nst_internal');
  assert.equal(org.org.overrideNote, 'club');
  assert.equal(org.repos.length, 2);
  for (const r of org.repos) assert.equal(repoSource(r), 'org');
  // a decision on one repository wins over the owner's
  const own = (await app.post('/api/admin/repos/override', { repo: 'smallorg/other', override: 'include' })).body.repo;
  assert.equal(repoSource(own), 'admin');
  assert.equal(prSource(byNumber(await prs('owner=smallorg'), 4)), 'repo');
  await app.post('/api/admin/owners/override', { login: 'smallorg', override: null });
  await app.post('/api/admin/repos/override', { repo: 'smallorg/other', override: null });
  for (const p of await prs('owner=smallorg')) assert.equal(prSource(p), 'rule');
});

test('the private notes the panel shows never reach a visitor without the admin cookie', async () => {
  await app.post('/api/admin/repos/override', { repo: 'smallorg/tool', override: 'include', note: 'secret reason' });
  const cookie = app.getCookie();
  app.clearCookie();
  const detail = (await app.get('/api/repos/smallorg/tool?range=all')).body;
  assert.equal(detail.repo.override, 'include');
  assert.equal(detail.repo.overrideNote, null);
  app.setCookie(cookie);
  await app.post('/api/admin/repos/override', { repo: 'smallorg/tool', override: null });
});

test('links and labels: review deep links, the top-bar link, the relabelled missing-data chips, the lazy owner route', async () => {
  assert.equal(reviewHref('apache/airflow'), '#/review?q=apache%2Fairflow&open=apache%2Fairflow');
  assert.equal(reviewHref('apache'), '#/review?tab=owners&q=apache&open=apache');
  const html = await readFile(path.join(ROOT, 'public/admin.html'), 'utf8');
  assert.match(html, /<a data-nav[^>]*href="#\/owner"[^>]*>Krushn's dashboard<\/a>/);
  const students = await readFile(path.join(ROOT, 'public/js/admin/students.js'), 'utf8');
  assert.match(students, /githubId: 'Not yet checked on GitHub'/);
  assert.match(students, /unresolved: 'Account not found'/);
  const main = await readFile(path.join(ROOT, 'public/js/admin/main.js'), 'utf8');
  assert.match(main, /import\('\.\.\/owner\/main\.js'\)/);
  assert.match(main, /path: '\/owner'/);
  assert.ok(!/^import [^\n]*owner\//m.test(main), 'the owner module must not be imported statically');
});
