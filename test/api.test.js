// Public + admin API against a real mongod (SPEC sections 5, 6 and Appendix A).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { startMongo } from './helpers/mongo.js';
import { startApp, TEST_PASSWORD } from './helpers/app.js';
import { insertStudents, prNode } from './helpers/fixtures.js';
import { collections, ensureIndexes } from '../src/db.js';
import { refreshAggregates, upsertPRs } from '../src/ingest.js';
import { invalidateContext, yearLabel } from '../src/classify.js';
import { registerHandler, unregisterHandler, whenIdle } from '../src/jobs.js';

const SECRETS = ['alice@private.example', 'ENR-ALICE-001', 'test sheet', 'private note'];
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const STATS_KEYS = ['totalPrs', 'mergedPrs', 'osPrs', 'osMerged', 'osOpen', 'osMajorMerged', 'osRepos', 'osOrgs', 'byCategory', 'firstPrAt', 'lastPrAt', 'lastOsMergedAt'];
const PR_KEYS = ['url', 'number', 'title', 'author', 'authorName', 'repo', 'owner', 'ownerType', 'stars', 'state', 'isDraft', 'createdAt', 'mergedAt', 'closedAt',
  'additions', 'deletions', 'changedFiles', 'comments', 'reviews', 'campus', 'batch', 'year', 'category', 'tier', 'reason', 'override', 'overrideNote'];

let mongo, db, c, app;
const backfills = [];
const syncs = [];

before(async () => {
  mongo = await startMongo();
  db = mongo.db;
  c = collections(db);
  await ensureIndexes(db);
  registerHandler('backfill', async (d, params, ctx) => { backfills.push(params); ctx.log('fake backfill'); ctx.progress(1, 1); return { students: params.users?.length ?? 0, ok: 0, failed: 0, prs: 0, renamed: 0, notFound: 0 }; });
  registerHandler('sync', async (d, params) => { syncs.push(params); return { students: 0, ok: 0, failed: 0, prs: 0, renamed: 0, notFound: 0 }; });
  const [alice, bob, , dave] = await insertStudents(db, [
    { username: 'Alice', name: 'Alice Anand', campus: 'RU', batch: 2025, email: 'alice@private.example', enrolmentNo: 'ENR-ALICE-001' },
    { username: 'Bob', name: '', campus: 'ADYPU', batch: 2026 },
    { username: 'carol', name: 'Carol C', campus: 'RU', batch: null },
    { username: 'dave', name: 'Dave D', campus: 'SVYASA', batch: 2024, active: false },
  ]);
  invalidateContext();
  const m = (repo, number, extra = {}) => prNode({ repo, number, createdAt: daysAgo(20), mergedAt: daysAgo(18), ...extra });
  await upsertPRs(db, alice, [
    m('apache/airflow', 1, { title: 'Fix scheduler race' }),
    prNode({ repo: 'apache/airflow', number: 2, state: 'OPEN', createdAt: daysAgo(5), title: 'Add docs page' }),
    m('Alice/site', 3, { ownerType: 'User', stars: 3 }),
    m('nst-sdc/portal', 4, { stars: 1 }),
    m('Bob/proj', 5, { ownerType: 'User', stars: 0 }),
    m('firstcontributions/first-contributions', 6, { stars: 40000 }),
    prNode({ repo: 'tiny/lib', number: 7, state: 'CLOSED', stars: 10, createdAt: daysAgo(40) }),
    m('secret/internal', 99, { isPrivate: true }),
  ]);
  await upsertPRs(db, bob, [m('apache/airflow', 8), m('midorg/tool', 9, { stars: 300 })]);
  await upsertPRs(db, dave, [m('apache/airflow', 10)]);
  await refreshAggregates(db);
  app = await startApp(db);
});

after(async () => {
  await whenIdle(db);
  await app?.close();
  unregisterHandler('backfill');
  unregisterHandler('sync');
  await mongo?.stop();
});

// ------------------------------------------------------------------ public

test('ingest: categories, private repos skipped, aggregates', async () => {
  const cats = Object.fromEntries((await c.prs.find({}).toArray()).map((p) => [p.number, p.category]));
  assert.deepEqual(cats, { 1: 'open_source', 2: 'open_source', 3: 'own_repo', 4: 'nst_internal', 5: 'peer_repo', 6: 'practice', 7: 'low_signal', 8: 'open_source', 9: 'open_source', 10: 'open_source' });
  assert.equal(await c.prs.countDocuments({ repoLc: 'secret/internal' }), 0);
  assert.equal(await c.repos.countDocuments({ _id: 'secret/internal' }), 0);
  const alice = await c.students.findOne({ _id: 'alice' });
  assert.deepEqual({ ...alice.stats, firstPrAt: null, lastPrAt: null, lastOsMergedAt: null }, {
    totalPrs: 7, mergedPrs: 5, osPrs: 2, osMerged: 1, osOpen: 1, osMajorMerged: 1, osRepos: 1, osOrgs: 1,
    byCategory: { open_source: 2, practice: 1, nst_internal: 1, peer_repo: 1, own_repo: 1, low_signal: 1 }, firstPrAt: null, lastPrAt: null, lastOsMergedAt: null,
  });
  assert.ok(alice.stats.firstPrAt < alice.stats.lastPrAt && alice.stats.lastOsMergedAt instanceof Date);
  assert.equal((await c.students.findOne({ _id: 'carol' })).stats.totalPrs, 0);
  assert.equal((await c.students.findOne({ _id: 'dave' })).stats.totalPrs, 0, 'inactive students have empty stats');
  const airflow = await c.repos.findOne({ _id: 'apache/airflow' });
  assert.deepEqual([airflow.stats.prs, airflow.stats.merged, airflow.stats.open, airflow.stats.closed, airflow.stats.students, airflow.stats.campuses], [3, 2, 1, 0, 2, ['ADYPU', 'RU']]);
  assert.deepEqual([airflow.category, airflow.tier], ['open_source', 'major']);
  // a student's personal repo is peer_repo at repo level while their own PR to it is own_repo
  assert.equal((await c.repos.findOne({ _id: 'alice/site' })).category, 'peer_repo');
  const apache = await c.owners.findOne({ _id: 'apache' });
  assert.deepEqual([apache.stats.repos, apache.stats.prs, apache.stats.merged, apache.stats.osPrs, apache.stats.osMerged, apache.stats.students, apache.stats.maxStars], [1, 3, 2, 3, 2, 2, 5000]);
});

test('health, meta, 404 and validation errors', async () => {
  const h = await app.get('/api/health');
  assert.deepEqual([h.status, h.body, h.headers.get('cache-control')], [200, { ok: true }, 'no-store']);
  const meta = await app.get('/api/meta');
  assert.equal(meta.headers.get('cache-control'), 'public, max-age=60');
  assert.deepEqual(meta.body.campuses, ['ADYPU', 'RU']);
  assert.deepEqual(meta.body.batches, [2026, 2025]);
  assert.deepEqual(meta.body.years, [yearLabel(2026), yearLabel(2025), 'Unknown'].sort((a, b) => a.localeCompare(b)).filter((v, i, arr) => arr.indexOf(v) === i));
  assert.deepEqual(meta.body.categories, ['open_source', 'practice', 'nst_internal', 'peer_repo', 'own_repo', 'low_signal']);
  assert.deepEqual(meta.body.tiers, ['major', 'established', 'emerging']);
  assert.deepEqual(meta.body.counts, { students: 3, prs: 9 });
  assert.equal(meta.body.rulesSummary.minStarsOrgRepo, 50);
  assert.ok(typeof meta.body.lastSyncAt === 'string');
  const nf = await app.get('/api/nope');
  assert.equal(nf.status, 404);
  assert.equal(nf.body.error.code, 'not_found');
  for (const bad of ['/api/prs?state=bogus', '/api/prs?limit=101', '/api/prs?page=0', '/api/students?campus=XX', '/api/students?year=5th', '/api/students?sort=email',
    '/api/prs?from=yesterday', '/api/prs?category=nope', '/api/repos?tier=huge', '/api/students?batch=abc', '/api/orgs?order=up', '/api/overview?year=nope']) {
    const r = await app.get(bad);
    assert.equal(r.status, 400, bad);
    assert.equal(r.body.error.code, 'bad_request', bad);
    assert.ok(r.body.error.message);
  }
  assert.equal((await app.get('/api/prs?unknownParam=1')).status, 200);
});

test('overview', async () => {
  // no range given -> the current academic year (every fixture PR is inside it), with the months of that year so far
  const ay = await app.get('/api/overview');
  assert.equal(ay.body.range.preset, 'ay');
  assert.match(ay.body.range.label, /^AY \d{4}-\d{2}$/);
  assert.ok(ay.body.monthly.length >= 1 && ay.body.monthly.length <= 12);
  assert.equal(ay.body.monthly[0].month.slice(5), '07');
  const { status, body } = await app.get('/api/overview?range=all');
  assert.equal(status, 200);
  assert.deepEqual(body.range, { from: null, to: null, label: 'All time', preset: 'all' });
  assert.deepEqual([ay.body.students, ay.body.prs, ay.body.topRepos, ay.body.topOrgs, ay.body.topStudents.map((s) => s.username)],
    [body.students, body.prs, body.topRepos, body.topOrgs, body.topStudents.map((s) => s.username)], 'ranged pipelines agree with the all-time stats');
  assert.deepEqual(body.filters, { campus: null, year: null });
  assert.deepEqual(body.students, { tracked: 3, withAnyPr: 2, withOsPr: 2, withOsMerged: 2, withMajorMerged: 2 });
  assert.deepEqual(body.prs, {
    total: 9, merged: 7, osPrs: 4, osMerged: 3, osOpen: 1,
    byCategory: { open_source: 4, practice: 1, nst_internal: 1, peer_repo: 1, own_repo: 1, low_signal: 1 },
    byState: { open: 1, merged: 7, closed: 1 },
    osMergedByTier: { major: 2, established: 1, emerging: 0 },
  });
  assert.deepEqual(body.topRepos, [
    { name: 'apache/airflow', stars: 5000, tier: 'major', osPrs: 3, osMerged: 2, students: 2 },
    { name: 'midorg/tool', stars: 300, tier: 'established', osPrs: 1, osMerged: 1, students: 1 },
  ]);
  assert.deepEqual(body.topOrgs, [{ login: 'apache', osPrs: 3, osMerged: 2, students: 2 }, { login: 'midorg', osPrs: 1, osMerged: 1, students: 1 }]);
  assert.deepEqual(body.topStudents.map((s) => s.username), ['Bob', 'Alice']);
  assert.deepEqual(Object.keys(body.topStudents[0]), ['username', 'name', 'campus', 'batch', 'year', 'stats']);
  assert.equal(body.monthly.length, 24);
  assert.equal(body.monthly.at(-1).month, new Date().toISOString().slice(0, 7));
  assert.deepEqual(Object.keys(body.monthly[0]), ['month', 'osOpened', 'osMerged', 'allOpened']);
  const sum = (k) => body.monthly.reduce((a, m) => a + m[k], 0);
  assert.deepEqual([sum('allOpened'), sum('osOpened'), sum('osMerged')], [9, 4, 3]);
  assert.ok(body.monthly.every((m, i, arr) => i === 0 || arr[i - 1].month < m.month));

  const ru = (await app.get('/api/overview?campus=RU')).body;
  assert.deepEqual(ru.students, { tracked: 2, withAnyPr: 1, withOsPr: 1, withOsMerged: 1, withMajorMerged: 1 });
  assert.deepEqual([ru.prs.total, ru.prs.osPrs, ru.prs.osMerged], [7, 2, 1]);
  assert.deepEqual(ru.topRepos, [{ name: 'apache/airflow', stars: 5000, tier: 'major', osPrs: 2, osMerged: 1, students: 1 }]);
  assert.deepEqual(ru.topStudents.map((s) => s.username), ['Alice']);
  const unknown = (await app.get('/api/overview?campus=RU&year=Unknown')).body;
  assert.deepEqual(unknown.filters, { campus: 'RU', year: 'Unknown' });
  assert.deepEqual([unknown.students.tracked, unknown.prs.total, unknown.topRepos.length], [1, 0, 0]);
});

test('campuses', async () => {
  const { body } = await app.get('/api/campuses');
  assert.deepEqual(body.rows.map((r) => [r.campus, r.year, r.batch, r.students, r.withOsMerged, r.totalPrs]), [
    ['ADYPU', yearLabel(2026), 2026, 1, 1, 2], ['RU', yearLabel(2025), 2025, 1, 1, 7], ['RU', 'Unknown', null, 1, 0, 0],
  ]);
  assert.deepEqual(body.totals.map((r) => [r.campus, r.year, r.batch, r.students, r.osPrs]), [['ADYPU', 'All', null, 1, 2], ['RU', 'All', null, 2, 2]]);
  assert.deepEqual({ ...body.total, byCategory: null }, { campus: 'All', year: 'All', batch: null, students: 3, withAnyPr: 2, withOsPr: 2, withOsMerged: 2, withMajorMerged: 2,
    totalPrs: 9, osPrs: 4, osMerged: 3, byCategory: null });
  assert.deepEqual(body.total.byCategory, { open_source: 4, practice: 1, nst_internal: 1, peer_repo: 1, own_repo: 1, low_signal: 1 });
});

test('students list + profile', async () => {
  const list = (await app.get('/api/students')).body;
  assert.deepEqual([list.total, list.page, list.limit], [3, 1, 25]);
  assert.deepEqual(list.items.map((s) => s.username), ['Bob', 'Alice', 'carol']);
  assert.deepEqual(Object.keys(list.items[0]), ['username', 'name', 'campus', 'batch', 'year', 'stats']);
  assert.deepEqual(Object.keys(list.items[0].stats), STATS_KEYS);
  assert.deepEqual((await app.get('/api/students?sort=name')).body.items.map((s) => s.name), ['', 'Alice Anand', 'Carol C']);
  assert.deepEqual((await app.get('/api/students?sort=totalPrs&order=asc')).body.items.map((s) => s.username), ['carol', 'Bob', 'Alice']);
  assert.deepEqual((await app.get('/api/students?q=ALI')).body.items.map((s) => s.username), ['Alice']);
  assert.deepEqual((await app.get('/api/students?hasOs=1&campus=RU')).body.items.map((s) => s.username), ['Alice']);
  assert.deepEqual((await app.get('/api/students?year=Unknown')).body.items.map((s) => s.username), ['carol']);
  assert.deepEqual((await app.get(`/api/students?year=${encodeURIComponent(yearLabel(2026))}`)).body.items.map((s) => s.username), ['Bob']);
  assert.deepEqual((await app.get('/api/students?batch=2025')).body.items.map((s) => s.username), ['Alice']);
  const p2 = (await app.get('/api/students?limit=2&page=2')).body;
  assert.deepEqual([p2.items.length, p2.total, p2.page, p2.limit], [1, 3, 2, 2]);
  assert.equal((await app.get('/api/students?q=.*')).body.total, 0, 'q is a literal substring, not a regex');

  const prof = (await app.get('/api/students/ALICE')).body;
  assert.deepEqual(Object.keys(prof), ['range', 'student', 'monthly', 'repos', 'prs']);
  assert.equal(prof.student.username, 'Alice');
  assert.equal(prof.range.preset, 'ay');
  assert.equal(prof.monthly.reduce((a, m) => a + m.allOpened, 0), 7);
  const profAll = (await app.get('/api/students/ALICE?range=all')).body;
  assert.equal(profAll.monthly.length, 24);
  assert.deepEqual(profAll.student, prof.student, 'every fixture PR is inside the academic year');
  assert.equal(prof.repos.length, 6);
  assert.deepEqual({ ...prof.repos[0], lastPrAt: null }, { name: 'apache/airflow', stars: 5000, category: 'open_source', tier: 'major', prs: 2, merged: 1, lastPrAt: null });
  assert.equal(prof.repos.find((r) => r.name === 'Alice/site').category, 'own_repo');
  assert.deepEqual([prof.prs.total, prof.prs.page, prof.prs.limit, prof.prs.items.length], [7, 1, 25, 7]);
  assert.equal(prof.prs.items[0].number, 2, 'newest first');
  assert.equal((await app.get('/api/students/dave')).status, 404, 'inactive students are not public');
  assert.equal((await app.get('/api/students/nobody')).status, 404);
});

test('prs list filters and sorting', async () => {
  const def = (await app.get('/api/prs')).body;
  assert.equal(def.total, 4, 'default category is open_source, inactive authors hidden');
  assert.deepEqual(Object.keys(def.items[0]), PR_KEYS);
  assert.deepEqual(def.items.map((p) => p.number)[0], 2);
  const one = def.items.find((p) => p.number === 1);
  assert.deepEqual([one.author, one.authorName, one.campus, one.batch, one.year, one.state, one.tier, one.reason, one.override, one.overrideNote],
    ['Alice', 'Alice Anand', 'RU', 2025, yearLabel(2025), 'merged', 'major', 'major', null, null]);
  const count = async (qs) => (await app.get(`/api/prs?${qs}`)).body.total;
  assert.equal(await count('category=all'), 9);
  assert.equal(await count('category=all&author=ALICE'), 7);
  assert.equal(await count('category=all&author=nobody'), 0);
  assert.equal(await count('category=all&repo=Apache/Airflow'), 3);
  assert.equal(await count('category=all&owner=APACHE&state=open'), 1);
  assert.equal(await count('category=low_signal'), 1);
  assert.equal(await count('tier=established'), 1);
  assert.equal(await count('category=all&campus=ADYPU'), 2);
  assert.equal(await count('category=all&q=SCHEDULER'), 1);
  assert.equal(await count('category=all&q=first-contrib'), 1);
  assert.equal(await count(`category=all&from=${daysAgo(10).slice(0, 10)}`), 1);
  assert.equal(await count(`category=all&to=${daysAgo(30).slice(0, 10)}`), 1);
  assert.equal(await count(`category=all&from=${daysAgo(25).slice(0, 10)}&to=${daysAgo(15).slice(0, 10)}`), 7);
  const byStars = (await app.get('/api/prs?category=all&sort=stars&limit=1')).body.items[0];
  assert.equal(byStars.stars, 40000);
  const asc = (await app.get('/api/prs?category=all&sort=stars&order=asc&limit=1')).body.items[0];
  assert.equal(asc.stars, 0);
  assert.equal((await app.get('/api/prs?category=all&sort=mergedAt')).body.total, 7, 'sort=mergedAt lists merged PRs only');
});

test('repos and orgs', async () => {
  const repos = (await app.get('/api/repos')).body;
  assert.deepEqual(repos.items.map((r) => r.name), ['apache/airflow', 'midorg/tool']);
  assert.deepEqual(Object.keys(repos.items[0]), ['name', 'owner', 'ownerType', 'stars', 'forks', 'language', 'license', 'description', 'isFork', 'isArchived',
    'category', 'tier', 'reason', 'override', 'overrideNote', 'stats']);
  assert.deepEqual(Object.keys(repos.items[0].stats), ['prs', 'merged', 'open', 'closed', 'students', 'campuses', 'firstPrAt', 'lastPrAt']);
  assert.equal((await app.get('/api/repos?category=all')).body.total, 7);
  assert.deepEqual((await app.get('/api/repos?category=all&q=PORTAL')).body.items.map((r) => r.name), ['nst-sdc/portal']);
  assert.deepEqual((await app.get('/api/repos?category=all&owner=alice')).body.items.map((r) => [r.name, r.category]), [['Alice/site', 'peer_repo']]);
  assert.deepEqual((await app.get('/api/repos?category=all&sort=stars&limit=1')).body.items.map((r) => r.name), ['firstcontributions/first-contributions']);

  const repo = (await app.get('/api/repos/APACHE/Airflow')).body;
  assert.deepEqual(Object.keys(repo), ['range', 'repo', 'owner', 'students', 'prs']);
  assert.equal(repo.repo.name, 'apache/airflow');
  assert.equal(repo.owner.login, 'apache');
  assert.deepEqual(repo.students.map((s) => [s.username, s.prs, s.merged]), [['Alice', 2, 1], ['Bob', 1, 1]]);
  assert.equal(repo.prs.total, 3);
  assert.equal((await app.get('/api/repos/no/such')).status, 404);

  const orgs = (await app.get('/api/orgs')).body;
  assert.deepEqual(orgs.items.map((o) => o.login), ['apache', 'midorg']);
  assert.deepEqual(Object.keys(orgs.items[0]), ['login', 'type', 'override', 'overrideNote', 'stats']);
  assert.deepEqual(Object.keys(orgs.items[0].stats), ['repos', 'prs', 'merged', 'osPrs', 'osMerged', 'students', 'maxStars', 'byCategory']);
  assert.equal((await app.get('/api/orgs?category=all')).body.total, 7);
  assert.deepEqual((await app.get('/api/orgs?category=all&q=NST')).body.items.map((o) => o.login), ['nst-sdc']);
  const org = (await app.get('/api/orgs/Apache')).body;
  assert.deepEqual(Object.keys(org), ['range', 'org', 'repos', 'students']);
  assert.deepEqual([org.org.login, org.repos.length, org.students.length], ['apache', 1, 2]);
  assert.equal((await app.get('/api/orgs/nobody')).status, 404);
});

test('csv exports', async () => {
  const s = await app.get('/api/export/students.csv', { raw: true });
  assert.equal(s.status, 200);
  assert.match(s.headers.get('content-type'), /text\/csv/);
  assert.match(s.headers.get('content-disposition'), /attachment; filename="students.csv"/);
  const lines = s.text.trim().split('\n');
  assert.equal(lines[0], 'username,name,campus,batch,year,total_prs,merged_prs,os_prs,os_merged,os_open,os_major_merged,os_repos,os_orgs,practice_prs,nst_internal_prs,peer_repo_prs,own_repo_prs,low_signal_prs,first_pr_at,last_pr_at');
  assert.equal(lines.length, 4);
  assert.ok(lines[2].startsWith(`Alice,Alice Anand,RU,2025,${yearLabel(2025)},7,5,2,1,1,1,1,1,1,1,1,1,1,`));
  const p = await app.get('/api/export/prs.csv?category=all&author=alice', { raw: true });
  const plines = p.text.trim().split('\n');
  assert.equal(plines[0], 'url,author,author_name,campus,batch,year,repo,owner,owner_type,stars,title,state,is_draft,created_at,merged_at,closed_at,additions,deletions,changed_files,category,tier,reason');
  assert.equal(plines.length, 8);
  assert.equal((await app.get('/api/export/prs.csv', { raw: true })).text.trim().split('\n').length, 5);
  assert.equal((await app.get('/api/export/prs.csv?state=nope')).status, 400);
});

test('private student fields never appear on public endpoints', async () => {
  const paths = ['/api/meta', '/api/overview', '/api/campuses', '/api/students', '/api/students/alice', '/api/prs?category=all', '/api/repos?category=all',
    '/api/repos/apache/airflow', '/api/orgs?category=all', '/api/orgs/apache', '/api/export/students.csv', '/api/export/prs.csv?category=all'];
  for (const path of paths) {
    const r = await app.get(path, { raw: true });
    assert.equal(r.status, 200, path);
    for (const secret of SECRETS) assert.ok(!r.text.includes(secret), `${path} leaks "${secret}"`);
    for (const key of ['"email"', '"enrolmentNo"', '"sources"', '"notes"', '"_id"']) assert.ok(!r.text.includes(key), `${path} exposes ${key}`);
  }
});

test('static files: index at /, admin.html at /admin, unknown path 404', async () => {
  if (existsSync(new URL('../public/index.html', import.meta.url))) assert.equal((await app.get('/', { raw: true })).status, 200);
  if (existsSync(new URL('../public/admin.html', import.meta.url))) {
    const r = await app.get('/admin', { raw: true });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
  }
  assert.equal((await app.get('/no-such-file.txt', { raw: true })).status, 404);
  assert.equal((await app.get('/../package.json', { raw: true })).status, 404);
});

// ------------------------------------------------------------------ admin auth

test('admin auth: 401 without cookie, 403 without CSRF header, login, logout', async () => {
  assert.deepEqual((await app.get('/api/admin/me')).body, { admin: false, configured: true });
  const unauth = await app.get('/api/admin/students');
  assert.deepEqual([unauth.status, unauth.body.error.code, unauth.headers.get('cache-control')], [401, 'unauthorized', 'no-store']);
  for (const path of ['/api/admin/overrides', '/api/admin/rules', '/api/admin/jobs', '/api/admin/review/repos', '/api/admin/review/owners', '/api/admin/jobs/abc']) {
    assert.equal((await app.get(path)).status, 401, path);
  }
  for (const [method, path] of [['POST', '/api/admin/students'], ['POST', '/api/admin/students/bulk'], ['PATCH', '/api/admin/students/alice'], ['DELETE', '/api/admin/students/alice'],
    ['POST', '/api/admin/students/alice/backfill'], ['POST', '/api/admin/prs/override'], ['POST', '/api/admin/repos/override'], ['POST', '/api/admin/owners/override'],
    ['PUT', '/api/admin/rules'], ['POST', '/api/admin/jobs/sync'], ['POST', '/api/admin/jobs/reclassify']]) {
    assert.equal((await app.request(method, path, method === 'DELETE' ? undefined : {})).status, 401, `${method} ${path}`);
  }
  assert.equal((await c.students.findOne({ _id: 'alice' })).active, true);

  const noCsrf = await app.request('POST', '/api/admin/login', { password: TEST_PASSWORD }, { csrf: false });
  assert.deepEqual([noCsrf.status, noCsrf.body.error.code], [403, 'forbidden']);
  const wrong = await app.login('nope');
  assert.deepEqual([wrong.status, wrong.body.error.code], [401, 'unauthorized']);
  assert.equal((await app.post('/api/admin/login', {})).status, 401);

  const ok = await app.login();
  assert.deepEqual([ok.status, ok.body], [200, { ok: true }]);
  const setCookie = ok.headers.get('set-cookie');
  assert.match(setCookie, /^oss_admin=[\w-]+\.[\w-]+; Max-Age=43200; Path=\/; HttpOnly; SameSite=Lax$/);
  assert.deepEqual((await app.get('/api/admin/me')).body, { admin: true, configured: true });
  assert.equal((await app.get('/api/admin/students')).status, 200);
  // a logged-in admin is never served a cacheable public response
  assert.equal((await app.get('/api/prs')).headers.get('cache-control'), 'private, no-store');
  // logged in but no CSRF header
  assert.equal((await app.request('POST', '/api/admin/jobs/reclassify', {}, { csrf: false })).status, 403);
  // tampered cookie
  const good = app.getCookie();
  app.setCookie(good.slice(0, -3) + 'abc');
  assert.equal((await app.get('/api/admin/students')).status, 401);
  app.setCookie(good);

  const out = await app.post('/api/admin/logout');
  assert.deepEqual([out.status, out.body], [200, { ok: true }]);
  assert.deepEqual((await app.get('/api/admin/me')).body, { admin: false, configured: true });
  assert.equal((await app.get('/api/admin/students')).status, 401);
});

test('admin auth: Secure cookie in production, 503 when ADMIN_PASSWORD is unset, rate limit', async () => {
  const strong = 'f'.repeat(16) + '0123456789abcdef';
  const prod = await startApp(db, { production: true, sessionSecret: strong, sessionSecretSet: true });
  try {
    const res = await prod.login();
    assert.match(res.headers.get('set-cookie'), /; Secure$/);
    assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000');
  } finally { await prod.close(); }

  const off = await startApp(db, { adminPassword: '' });
  try {
    assert.deepEqual((await off.get('/api/admin/me')).body, { admin: false, configured: false });
    for (const r of [await off.login(''), await off.login('x'), await off.get('/api/admin/students'), await off.post('/api/admin/jobs/reclassify')]) {
      assert.deepEqual([r.status, r.body.error.code], [503, 'unavailable']);
    }
    assert.equal((await off.get('/api/students')).status, 200, 'public API keeps working');
  } finally { await off.close(); }

  const limited = await startApp(db);
  try {
    for (let i = 0; i < 10; i++) assert.equal((await limited.login('wrong')).status, 401);
    const blocked = await limited.login('wrong');
    assert.deepEqual([blocked.status, blocked.body.error.code], [429, 'rate_limited']);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal((await limited.login()).status, 429, 'the right password is refused too while blocked');
  } finally { await limited.close(); }
});

// ------------------------------------------------------------------ admin features

test('admin students: list, add, bulk add, edit, deactivate, purge, backfill', async () => {
  await app.login();
  const list = (await app.get('/api/admin/students')).body;
  assert.equal(list.total, 4, 'includes inactive students');
  const alice = list.items.find((s) => s.username === 'Alice');
  assert.deepEqual(Object.keys(alice), ['username', 'name', 'campus', 'batch', 'year', 'stats', 'githubId', 'nameSource', 'email', 'enrolmentNo', 'sources', 'notes', 'active',
    'backfill', 'lastSyncedAt', 'addedAt', 'addedBy'].toSpliced(6, 0, 'unresolvedSince', 'missing'));
  assert.deepEqual([alice.email, alice.enrolmentNo, alice.sources, alice.notes, alice.backfill.status, alice.backfill.error], ['alice@private.example', 'ENR-ALICE-001', ['test sheet'], 'private note', 'done', null]);
  assert.deepEqual((await app.get('/api/admin/students?active=0')).body.items.map((s) => s.username), ['dave']);
  assert.deepEqual((await app.get('/api/admin/students?q=enr-alice')).body.items.map((s) => s.username), ['Alice']);
  assert.deepEqual((await app.get('/api/admin/students?q=private.example')).body.items.map((s) => s.username), ['Alice']);
  assert.equal((await app.get('/api/admin/students?backfill=pending')).body.total, 0);
  assert.equal((await app.get('/api/admin/students?backfill=nope')).status, 400);
  assert.deepEqual((await app.get('/api/admin/students?sort=username')).body.items.map((s) => s.username), ['Alice', 'Bob', 'carol', 'dave']);

  // add one: "midorg" owns a repo Bob contributed to -> becomes a peer repo
  for (const [body, re] of [[{ username: '', campus: 'RU' }, /username/], [{ username: 'has space', campus: 'RU' }, /username/], [{ username: 'x', campus: 'Mars' }, /campus/],
    [{ username: 'x' }, /campus/], [{ username: 'x', campus: 'RU', batch: 'soon' }, /batch/]]) {
    const r = await app.post('/api/admin/students', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error.message, re);
  }
  assert.equal((await app.request('POST', '/api/admin/students', '[1]')).status, 400);
  assert.equal((await app.request('POST', '/api/admin/students', '{bad json')).status, 400);
  const added = await app.post('/api/admin/students', { username: 'https://github.com/MidOrg/', name: ' Mid Person ', campus: 'svyasa', batch: 2026, email: 'm@x.example', enrolmentNo: 'E1' });
  assert.equal(added.status, 201);
  assert.deepEqual([added.body.student.username, added.body.student.name, added.body.student.nameSource, added.body.student.campus, added.body.student.batch, added.body.student.active,
    added.body.student.backfill.status, added.body.student.addedBy, added.body.student.email], ['MidOrg', 'Mid Person', 'sheet', 'SVYASA', 2026, true, 'pending', 'admin', 'm@x.example']);
  assert.match(added.body.job.id, /^[0-9a-f]{12}$/);
  assert.equal((await c.students.findOne({ _id: 'midorg' })).stats.totalPrs, 0);
  await whenIdle(db);
  assert.deepEqual(backfills.at(-1), { users: ['MidOrg'] });
  const job = (await app.get(`/api/admin/jobs/${added.body.job.id}`)).body.job;
  assert.deepEqual([job.type, job.runner, job.status, job.progress, job.error], ['backfill', 'app', 'done', { done: 1, total: 1 }, null]);
  assert.match(job.log[0], /^\d\d:\d\d:\d\d fake backfill$/);
  assert.equal((await c.prs.findOne({ number: 9 })).category, 'peer_repo', 'PRs to a newly tracked student\'s repo are reclassified');
  assert.equal((await c.students.findOne({ _id: 'bob' })).stats.osPrs, 1);
  const dup = await app.post('/api/admin/students', { username: 'midorg', campus: 'RU' });
  assert.deepEqual([dup.status, dup.body.error.code], [409, 'conflict']);

  // bulk
  const bulk = await app.post('/api/admin/students/bulk', { csv: 'campus,batch,name,github_username,email\nRU,2026,New One,new-one,n1@x.example\nRU,2025,Alice Anand,ALICE,\nRU,2026,No Login,,\nMars,2026,Bad Campus,badcampus,\n,,,https://github.com/New-Two,\nRU,2026,Again,new-one,\n' });
  assert.equal(bulk.status, 200);
  assert.deepEqual(bulk.body.results, [
    { row: 1, username: 'new-one', status: 'added', error: null },
    { row: 2, username: 'Alice', status: 'exists', error: null },
    { row: 3, username: '', status: 'invalid', error: 'github_username required' },
    { row: 4, username: 'badcampus', status: 'invalid', error: 'invalid campus: expected one of ADYPU, RU, SVYASA, SMRU, Unknown' },
    { row: 5, username: 'New-Two', status: 'added', error: null },
    { row: 6, username: 'new-one', status: 'exists', error: null },
  ]);
  assert.deepEqual([bulk.body.added, bulk.body.exists, bulk.body.invalid], [2, 2, 2]);
  await whenIdle(db);
  assert.deepEqual(backfills.at(-1), { users: ['new-one', 'New-Two'] });
  const two = await c.students.findOne({ _id: 'new-two' });
  assert.deepEqual([two.username, two.campus, two.batch, two.name, two.backfill.status, two.addedBy, two.stats.totalPrs], ['New-Two', 'Unknown', null, '', 'pending', 'admin', 0]);
  const none = await app.post('/api/admin/students/bulk', { rows: [{ github_username: 'alice' }] });
  assert.deepEqual([none.body.added, none.body.exists, none.body.job], [0, 1, null]);
  const viaRows = await app.post('/api/admin/students/bulk', { rows: [{ github_username: 'row-user', campus: 'RU', batch: '2025', enrolment_no: 'E9' }] });
  assert.deepEqual([viaRows.body.added, (await c.students.findOne({ _id: 'row-user' })).enrolmentNo], [1, 'E9']);
  assert.equal((await app.post('/api/admin/students/bulk', {})).status, 400);
  await whenIdle(db);

  // edit: campus / batch are rewritten on the PRs and aggregates follow
  const patched = await app.patch('/api/admin/students/BOB', { campus: 'RU', batch: 2024, name: 'Bob B', notes: 'moved campus' });
  assert.equal(patched.status, 200);
  assert.deepEqual([patched.body.student.campus, patched.body.student.batch, patched.body.student.name, patched.body.student.nameSource, patched.body.student.notes], ['RU', 2024, 'Bob B', 'sheet', 'moved campus']);
  assert.deepEqual(await c.prs.distinct('campus', { author: 'bob' }), ['RU']);
  assert.deepEqual(await c.prs.distinct('batch', { author: 'bob' }), [2024]);
  assert.deepEqual((await c.repos.findOne({ _id: 'apache/airflow' })).stats.campuses, ['RU']);
  assert.equal((await app.patch('/api/admin/students/bob', {})).status, 400);
  assert.equal((await app.patch('/api/admin/students/bob', { campus: 'Mars' })).status, 400);
  assert.equal((await app.patch('/api/admin/students/bob', { active: 'yes' })).status, 400);
  assert.equal((await app.patch('/api/admin/students/nobody', { name: 'x' })).status, 404);

  // deactivate -> hidden everywhere public; reactivate
  const del = await app.del('/api/admin/students/bob');
  assert.deepEqual(del.body, { ok: true, purged: false, prsRemoved: 0 });
  assert.equal((await app.get('/api/students/bob')).status, 404);
  assert.equal((await app.get('/api/prs?category=all&author=bob')).body.total, 0);
  assert.equal((await c.repos.findOne({ _id: 'apache/airflow' })).stats.prs, 2);
  assert.equal((await c.repos.findOne({ _id: 'midorg/tool' })).stats.prs, 0);
  assert.equal((await app.get('/api/repos/midorg/tool')).status, 404, 'repos without active PRs are hidden');
  assert.equal((await c.students.findOne({ _id: 'bob' })).stats.totalPrs, 0);
  const back = await app.patch('/api/admin/students/bob', { active: true });
  assert.equal(back.body.student.active, true);
  assert.equal((await c.students.findOne({ _id: 'bob' })).stats.totalPrs, 2);
  assert.equal((await c.repos.findOne({ _id: 'apache/airflow' })).stats.prs, 3);

  // reactivating dave brings his PR back, purging removes it for good
  await app.patch('/api/admin/students/dave', { active: true });
  assert.equal((await c.repos.findOne({ _id: 'apache/airflow' })).stats.prs, 4);
  const purge = await app.del('/api/admin/students/dave?purge=1');
  assert.deepEqual(purge.body, { ok: true, purged: true, prsRemoved: 1 });
  assert.equal(await c.students.countDocuments({ _id: 'dave' }), 0);
  assert.equal(await c.prs.countDocuments({ author: 'dave' }), 0);
  assert.equal((await c.repos.findOne({ _id: 'apache/airflow' })).stats.prs, 3);
  assert.equal((await app.del('/api/admin/students/dave')).status, 404);

  // purging MidOrg turns the repo back into ordinary open source
  await app.del('/api/admin/students/midorg?purge=1');
  assert.equal((await c.prs.findOne({ number: 9 })).category, 'open_source');
  assert.equal((await c.students.findOne({ _id: 'bob' })).stats.osPrs, 2);

  // re-backfill
  const again = await app.post('/api/admin/students/Alice/backfill');
  assert.match(again.body.job.id, /^[0-9a-f]{12}$/);
  assert.equal((await c.students.findOne({ _id: 'alice' })).backfill.status, 'pending');
  await whenIdle(db);
  assert.deepEqual(backfills.at(-1), { users: ['Alice'] });
  assert.equal((await app.post('/api/admin/students/nobody/backfill')).status, 404);
  for (const id of ['new-one', 'new-two', 'row-user']) await app.del(`/api/admin/students/${id}?purge=1`);
  await app.patch('/api/admin/students/bob', { campus: 'ADYPU', batch: 2026 });
});

test('admin overrides are applied synchronously and can be undone', async () => {
  await app.login();
  const osMerged = async (id) => (await c.students.findOne({ _id: id })).stats.osMerged;
  assert.deepEqual([await osMerged('alice'), await osMerged('bob')], [1, 2]);

  // PR: mark not open source
  const url = 'https://github.com/apache/airflow/pull/1';
  const pr = await app.post('/api/admin/prs/override', { url, override: 'not_open_source', note: 'typo fix' });
  assert.equal(pr.status, 200);
  assert.deepEqual([pr.body.ok, pr.body.affected, pr.body.pr.category, pr.body.pr.tier, pr.body.pr.reason, pr.body.pr.override, pr.body.pr.overrideNote],
    [true, { prs: 1 }, 'low_signal', null, 'admin: marked not open source', 'not_open_source', 'typo fix']);
  assert.equal(await osMerged('alice'), 0);
  assert.equal((await app.get('/api/overview')).body.prs.osMerged, 2);
  // PR: mark open source (a 10-star repo)
  const tiny = await app.post('/api/admin/prs/override', { url: 'https://github.com/tiny/lib/pull/7', override: 'open_source', note: '' });
  assert.deepEqual([tiny.body.pr.category, tiny.body.pr.tier, tiny.body.pr.reason], ['open_source', 'emerging', 'admin: marked open source']);
  assert.equal((await c.repos.findOne({ _id: 'tiny/lib' })).category, 'low_signal', 'a PR override does not change the repo');
  // a re-ingest keeps the override
  await upsertPRs(db, await c.students.findOne({ _id: 'alice' }), [prNode({ repo: 'apache/airflow', number: 1, title: 'Fix scheduler race (v2)', createdAt: daysAgo(20), mergedAt: daysAgo(18), stars: 5100 })]);
  const kept = await c.prs.findOne({ _id: url });
  assert.deepEqual([kept.title, kept.override, kept.overrideNote, kept.category, kept.stars], ['Fix scheduler race (v2)', 'not_open_source', 'typo fix', 'low_signal', 5100]);

  let ov = (await app.get('/api/admin/overrides')).body;
  assert.deepEqual(ov.prs.map((p) => p.url), ['https://github.com/tiny/lib/pull/7', url], 'newest first');
  assert.ok(typeof ov.prs[0].overrideAt === 'string');
  assert.deepEqual([ov.repos, ov.owners], [[], []]);

  // repo: exclude -> every PR in it
  const repo = await app.post('/api/admin/repos/override', { repo: 'Apache/Airflow', override: 'exclude', note: 'tutorial repo' });
  assert.deepEqual([repo.body.ok, repo.body.affected, repo.body.repo.category, repo.body.repo.reason, repo.body.repo.override, repo.body.repo.overrideNote],
    [true, { prs: 3, repos: 1 }, 'low_signal', 'admin: repo excluded', 'exclude', 'tutorial repo']);
  assert.deepEqual(await c.prs.distinct('category', { repoLc: 'apache/airflow' }), ['low_signal']);
  assert.deepEqual([await osMerged('alice'), await osMerged('bob')], [0, 1]);
  assert.deepEqual((await app.get('/api/repos')).body.items.map((r) => r.name), ['midorg/tool']);
  await app.post('/api/admin/repos/override', { repo: 'apache/airflow', override: null });
  assert.deepEqual((await c.prs.find({ repoLc: 'apache/airflow' }).sort({ number: 1 }).toArray()).map((p) => p.category), ['low_signal', 'open_source', 'open_source'], 'the PR override survives');
  // repo: include a small repo
  const inc = await app.post('/api/admin/repos/override', { repo: 'tiny/lib', override: 'include', note: 'real project' });
  assert.deepEqual([inc.body.repo.category, inc.body.repo.tier, inc.body.repo.reason], ['open_source', 'emerging', 'admin: repo included']);

  // owner: NST internal / exclude / include
  const own = await app.post('/api/admin/owners/override', { login: 'MidOrg', override: 'nst_internal', note: 'club org' });
  assert.deepEqual([own.body.ok, own.body.affected, own.body.org.login, own.body.org.override, own.body.org.overrideNote, own.body.org.stats.byCategory.nst_internal],
    [true, { prs: 1, repos: 1 }, 'midorg', 'nst_internal', 'club org', 1]);
  assert.deepEqual([(await c.prs.findOne({ number: 9 })).category, (await c.prs.findOne({ number: 9 })).reason, (await c.repos.findOne({ _id: 'midorg/tool' })).category],
    ['nst_internal', 'admin: org marked NST internal', 'nst_internal']);
  assert.equal(await osMerged('bob'), 1);
  assert.equal((await app.post('/api/admin/owners/override', { login: 'midorg', override: 'exclude', note: '' })).body.org.stats.byCategory.low_signal, 1);
  const included = await app.post('/api/admin/owners/override', { login: 'nst-sdc', override: 'include', note: 'actually public' });
  assert.equal(included.body.org.stats.osPrs, 1);
  assert.equal((await c.prs.findOne({ number: 4 })).reason, 'admin: org included');

  ov = (await app.get('/api/admin/overrides')).body;
  assert.deepEqual([ov.prs.length, ov.repos.map((r) => r.name), ov.owners.map((o) => o.login)], [2, ['tiny/lib'], ['nst-sdc', 'midorg']]);

  // review queues
  const review = (await app.get('/api/admin/review/repos')).body;
  assert.equal(review.total, 7);
  assert.deepEqual(Object.keys(review.items[0]).at(-1), 'ownerOverride');
  assert.equal(review.items.find((r) => r.name === 'midorg/tool').ownerOverride, 'exclude');
  assert.equal(review.items.find((r) => r.name === 'apache/airflow').ownerOverride, null);
  assert.deepEqual((await app.get('/api/admin/review/repos?override=any')).body.items.map((r) => r.name), ['tiny/lib']);
  assert.equal((await app.get('/api/admin/review/repos?override=none')).body.total, 6);
  assert.deepEqual((await app.get('/api/admin/review/repos?minPrs=2')).body.items.map((r) => r.name), ['apache/airflow']);
  assert.deepEqual((await app.get('/api/admin/review/repos?category=peer_repo&sort=stars')).body.items.map((r) => r.name), ['Alice/site', 'Bob/proj']);
  assert.deepEqual((await app.get('/api/admin/review/repos?q=first')).body.items.map((r) => r.name), ['firstcontributions/first-contributions']);
  assert.equal((await app.get('/api/admin/review/repos?override=maybe')).status, 400);
  const owners = (await app.get('/api/admin/review/owners')).body;
  assert.deepEqual([owners.total, owners.items[0].login], [7, 'apache']);
  assert.deepEqual((await app.get('/api/admin/review/owners?override=any&sort=repos')).body.items.map((o) => o.login).sort(), ['midorg', 'nst-sdc']);
  assert.deepEqual((await app.get('/api/admin/review/owners?q=TINY')).body.items.map((o) => o.login), ['tiny']);
  // sort=prs honours order=asc (the tie-breaker used to overwrite the direction)
  for (const kind of ['repos', 'owners']) {
    const desc = (await app.get(`/api/admin/review/${kind}?sort=prs`)).body.items.map((x) => x.stats.prs);
    const asc = (await app.get(`/api/admin/review/${kind}?sort=prs&order=asc`)).body.items.map((x) => x.stats.prs);
    assert.ok(desc[0] > desc.at(-1), `${kind}: the fixture has different PR counts`);
    assert.deepEqual(asc, [...asc].sort((x, y) => x - y), `${kind} ascending`);
    assert.deepEqual(desc, [...desc].sort((x, y) => y - x), `${kind} descending`);
    assert.equal(asc[0], desc.at(-1));
  }

  // validation + 404s
  assert.equal((await app.post('/api/admin/prs/override', { url, override: 'maybe' })).status, 400);
  assert.equal((await app.post('/api/admin/prs/override', { override: null })).status, 400);
  assert.equal((await app.post('/api/admin/prs/override', { url: 'https://github.com/no/such/pull/1', override: null })).status, 404);
  assert.equal((await app.post('/api/admin/repos/override', { repo: 'no/such', override: 'exclude' })).status, 404);
  assert.equal((await app.post('/api/admin/repos/override', { repo: 'apache/airflow', override: 'nst_internal' })).status, 400);
  assert.equal((await app.post('/api/admin/owners/override', { login: 'nobody', override: 'exclude' })).status, 404);

  // undo everything -> back to the rule-based result
  await app.post('/api/admin/prs/override', { url, override: null });
  await app.post('/api/admin/prs/override', { url: 'https://github.com/tiny/lib/pull/7', override: null });
  await app.post('/api/admin/repos/override', { repo: 'tiny/lib', override: null });
  await app.post('/api/admin/owners/override', { login: 'midorg', override: null });
  const undone = await app.post('/api/admin/owners/override', { login: 'nst-sdc', override: null });
  assert.deepEqual([undone.body.org.override, undone.body.org.overrideNote], [null, null]);
  assert.deepEqual((await app.get('/api/admin/overrides')).body, { prs: [], repos: [], owners: [] });
  assert.deepEqual([await osMerged('alice'), await osMerged('bob')], [1, 2]);
  const cats = Object.fromEntries((await c.prs.find({}).toArray()).map((p) => [p.number, p.category]));
  assert.deepEqual(cats, { 1: 'open_source', 2: 'open_source', 3: 'own_repo', 4: 'nst_internal', 5: 'peer_repo', 6: 'practice', 7: 'low_signal', 8: 'open_source', 9: 'open_source' });
});

test('admin rules: get, validate, put queues a reclassify job', async () => {
  await app.login();
  const { rules } = (await app.get('/api/admin/rules')).body;
  assert.deepEqual(Object.keys(rules), ['tiers', 'minStarsUserRepo', 'minStarsOrgRepo', 'nstOrgs', 'nstOwnerKeywords', 'practiceRepos', 'practiceKeywords', 'allowOrgs', 'updatedAt']);
  assert.deepEqual([rules.tiers, rules.minStarsUserRepo, rules.minStarsOrgRepo, rules.allowOrgs], [{ major: 1000, established: 200 }, 200, 50, ['c2siorg']]);
  const { updatedAt, ...body } = rules;
  assert.equal((await app.put('/api/admin/rules', { ...body, tiers: { major: 10, established: 20 } })).status, 400);
  assert.equal((await app.put('/api/admin/rules', { ...body, minStarsOrgRepo: -5 })).status, 400);
  assert.equal((await app.put('/api/admin/rules', { ...body, allowOrgs: [''] })).status, 400);
  assert.equal((await app.put('/api/admin/rules', { tiers: rules.tiers })).status, 400);

  // lower the org threshold to 10 stars and allow-list nothing: tiny/lib (10 stars) becomes open source
  const put = await app.put('/api/admin/rules', { ...body, minStarsOrgRepo: 10, allowOrgs: [' Tiny-Extra '] });
  assert.equal(put.status, 200);
  assert.deepEqual([put.body.rules.minStarsOrgRepo, put.body.rules.allowOrgs], [10, ['Tiny-Extra']]);
  assert.ok(typeof put.body.rules.updatedAt === 'string');
  await whenIdle(db);
  const job = (await app.get(`/api/admin/jobs/${put.body.job.id}`)).body.job;
  assert.deepEqual([job.type, job.status, job.summary.prsChanged, job.summary.reposChanged], ['reclassify', 'done', 1, 1]);
  assert.deepEqual([(await c.prs.findOne({ number: 7 })).category, (await c.repos.findOne({ _id: 'tiny/lib' })).tier], ['open_source', 'emerging']);
  assert.equal((await c.students.findOne({ _id: 'alice' })).stats.osPrs, 3);
  assert.equal((await app.get('/api/meta')).body.rulesSummary.minStarsOrgRepo, 10);

  const restore = await app.put('/api/admin/rules', body);
  await whenIdle(db);
  assert.equal((await app.get(`/api/admin/jobs/${restore.body.job.id}`)).body.job.status, 'done');
  assert.equal((await c.prs.findOne({ number: 7 })).category, 'low_signal');
  assert.equal((await c.students.findOne({ _id: 'alice' })).stats.osPrs, 2);
});

test('admin jobs: list, detail, sync, reclassify', async () => {
  await app.login();
  const sync = await app.post('/api/admin/jobs/sync', { users: ['Alice'], full: true });
  assert.equal(sync.status, 202);
  const re = await app.post('/api/admin/jobs/reclassify', {});
  assert.equal(re.status, 202);
  await whenIdle(db);
  assert.deepEqual(syncs.at(-1), { trigger: 'manual', users: ['Alice'], full: true, concurrency: 6 });
  await app.post('/api/admin/jobs/sync', {});
  await whenIdle(db);
  assert.deepEqual(syncs.at(-1), { trigger: 'manual', full: false, concurrency: 6 });
  assert.equal((await app.post('/api/admin/jobs/sync', { users: 'alice' })).status, 400);
  assert.equal((await app.post('/api/admin/jobs/sync', { full: 'yes' })).status, 400);

  const list = (await app.get('/api/admin/jobs')).body;
  assert.ok(list.total >= 3);
  assert.deepEqual(Object.keys(list.items[0]), ['id', 'type', 'runner', 'status', 'params', 'createdAt', 'startedAt', 'finishedAt', 'progress', 'summary', 'error', 'cancelRequested']);
  assert.ok(list.items.every((j, i, arr) => i === 0 || arr[i - 1].createdAt >= j.createdAt), 'newest first');
  assert.ok(list.items.every((j) => !('log' in j)));
  assert.ok((await app.get('/api/admin/jobs?type=sync')).body.items.every((j) => j.type === 'sync'));
  assert.equal((await app.get('/api/admin/jobs?status=queued')).body.total, 0);
  assert.equal((await app.get('/api/admin/jobs?type=nope')).status, 400);
  const detail = (await app.get(`/api/admin/jobs/${sync.body.job.id}`)).body.job;
  assert.deepEqual([detail.id, detail.type, detail.status, detail.params, Array.isArray(detail.log)], [sync.body.job.id, 'sync', 'done', { trigger: 'manual', users: ['Alice'], full: true, concurrency: 6 }, true]);
  assert.deepEqual(detail.summary, { students: 0, ok: 0, failed: 0, prs: 0, renamed: 0, notFound: 0 });
  assert.equal((await app.get('/api/admin/jobs/ffffffffffff')).status, 404);
  // meta.lastSyncAt = finishedAt of the latest finished sync job
  const meta = (await app.get('/api/meta')).body;
  assert.ok(new Date(meta.lastSyncAt) >= new Date(detail.finishedAt));
});
