// Technology distribution (SPEC addendum H): domain rules, ingest of languages / topics, GET /api/tech and the
// technology fields of other payloads, and the repoMeta enrichment job with a mocked GitHub. Real mongod.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo } from './helpers/mongo.js';
import { startApp } from './helpers/app.js';
import { insertStudents, prNode } from './helpers/fixtures.js';
import { json, fakeSleep } from './helpers/github.js';
import { collections, ensureIndexes } from '../src/db.js';
import { refreshAggregates, upsertPRs } from '../src/ingest.js';
import { invalidateContext } from '../src/classify.js';
import { whenIdle, registerHandler, unregisterHandler } from '../src/jobs.js';
import {
  classifyDomain, compileTechRules, defaultTechRules, ensureDomains, languageOf, nameTokens, validateTechRules, LANG_NONE,
} from '../src/tech.js';
import { BATCH_SIZES, buildRepoQuery, repoMetaJob } from '../src/repoMeta.js';
import { SEARCH_QUERY } from '../src/github.js';

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const shipped = compileTechRules(defaultTechRules());
const dom = (repo) => classifyDomain(repo, shipped);

/** A PR node whose repository carries the given language / topics / languages by size / description. */
function node(repo, number, { language = 'Python', topics, languages, description, ...rest } = {}) {
  const n = prNode({ repo, number, createdAt: daysAgo(20), mergedAt: daysAgo(18), ...rest });
  n.repository.primaryLanguage = language ? { name: language } : null;
  n.repository.description = description ?? null;
  if (topics) n.repository.repositoryTopics = { nodes: topics.map((t) => ({ topic: { name: t } })) };
  if (languages) n.repository.languages = { totalSize: languages.reduce((s, [, b]) => s + b, 0), edges: languages.map(([name, size]) => ({ size, node: { name } })) };
  return n;
}

// ---------- pure rules ----------

test('domain rules: topics win over name and language, first match wins, unknown is other', () => {
  // a Python repo whose topics say web frontend: the topic phase comes first
  assert.equal(dom({ name: 'acme/thing', language: 'Python', topics: ['react'] }).domain, 'web_frontend');
  // topics are tried before names: "kubernetes" topic beats the ML word in the name
  const r = dom({ name: 'acme/ml-thing', language: 'Python', topics: ['kubernetes'] });
  assert.deepEqual([r.domain, r.domainRule], ['devops', 'topic-devops']);
  assert.match(r.domainReason, /topic "kubernetes"/);
  // without topics the name decides, before the language
  assert.equal(dom({ name: 'acme/ml-thing', language: 'Go' }).domain, 'ai_data');
  // first matching rule wins: security comes before AI in every phase
  assert.equal(dom({ name: 'acme/ai-security-scanner', language: 'Python' }).domain, 'security');
  assert.equal(dom({ name: 'acme/x', language: 'Python', topics: ['machine-learning', 'security'] }).domain, 'security');
  // description words come after the name and before the language
  assert.equal(dom({ name: 'acme/zeta', language: 'TypeScript', description: 'A Kubernetes operator for zeta' }).domain, 'devops');
  // language fallbacks: JS/TS are web whose side is unknown, Jupyter is data, no language is docs
  assert.deepEqual([dom({ name: 'acme/zeta', language: 'TypeScript' }).domain, dom({ name: 'acme/zeta', language: 'TypeScript' }).domainRule], ['fullstack', 'lang-js']);
  assert.equal(dom({ name: 'acme/zeta', language: 'Jupyter Notebook' }).domain, 'ai_data');
  assert.equal(dom({ name: 'acme/zeta', language: null }).domain, 'docs');
  assert.equal(dom({ name: 'acme/zeta', language: null }).domainReason, `language ${LANG_NONE} (rule lang-none)`);
  // the largest language by size stands in for a missing primary language
  assert.equal(dom({ name: 'acme/zeta', language: null, languages: [{ name: 'Kotlin', bytes: 10 }] }).domain, 'mobile');
  // nothing matches -> other
  const none = dom({ name: 'acme/zeta', language: 'Brainfuck' });
  assert.deepEqual([none.domain, none.domainRule, none.domainReason], ['other', null, 'no rule matched']);
});

test('domain rules: name words are whole words or joined neighbours, never substrings', () => {
  assert.deepEqual(nameTokens('freeCodeCamp/MusicBlocks'), ['free', 'code', 'camp', 'music', 'blocks']);
  assert.equal(dom({ name: 'freeCodeCamp/freeCodeCamp', language: 'TypeScript' }).domain, 'education');
  assert.equal(dom({ name: 'sugarlabs/musicblocks', language: 'JavaScript' }).domain, 'education');
  // "unity" (games) must not fire on "community", "os" (systems) not on "chaos"
  assert.notEqual(dom({ name: 'asyncapi/community', language: 'JavaScript' }).domain, 'games');
  assert.equal(dom({ name: 'litmuschaos/litmus', language: 'Go' }).domain, 'devops');
  assert.equal(dom({ name: 'acme/chaos-toolkit', language: 'Python' }).domainRule, 'name-devops');
  // prefix keywords: kube* matches kubestellar / kubescape
  assert.equal(dom({ name: 'kubescape/kubescape', language: 'Go' }).domainRule, 'name-devops');
  // an explicit ui repo is frontend even inside an infra project
  assert.equal(dom({ name: 'kubestellar/ui', language: 'TypeScript' }).domain, 'web_frontend');
  // multi-word keywords match those words in order
  assert.equal(dom({ name: 'sagold/json-schema-library', language: 'TypeScript' }).domain, 'devtools');
  // case-insensitive everywhere
  assert.equal(dom({ name: 'ACME/zeta', language: 'jUpYtEr NoTeBoOk', topics: ['REACT'] }).domain, 'web_frontend');
  assert.equal(languageOf({}), LANG_NONE);
});

test('domain rules: the table is validated, and an edited table changes the result', () => {
  assert.ok(validateTechRules(defaultTechRules()).value, 'the shipped table is valid');
  assert.match(validateTechRules({ domains: [{ key: 'a', label: 'A' }], rules: [] }).error, /other/);
  const base = { domains: [{ key: 'web', label: 'Web' }, { key: 'other', label: 'Other' }] };
  assert.match(validateTechRules({ ...base, rules: [{ id: 'x', domain: 'nope', name: ['a'] }] }).error, /unknown domain/);
  assert.match(validateTechRules({ ...base, rules: [{ id: 'x', domain: 'web', name: ['a'], topics: ['b'] }] }).error, /exactly one/);
  assert.match(validateTechRules({ ...base, rules: [{ id: 'x', domain: 'web', name: [] }] }).error, /non-empty/);
  assert.match(validateTechRules({ ...base, rules: [{ id: 'x', domain: 'web', name: ['a'] }, { id: 'x', domain: 'web', name: ['b'] }] }).error, /twice/);
  const custom = compileTechRules({ ...base, rules: [{ id: 'py', domain: 'web', languages: ['Python'] }] });
  assert.equal(classifyDomain({ name: 'a/b', language: 'Python' }, custom).domain, 'web');
  assert.equal(classifyDomain({ name: 'a/b', language: 'Go' }, custom).domain, 'other');
  assert.notEqual(custom.hash, shipped.hash);
});

// ---------- data + API ----------

let mongo;
let db;
let c;
let app;

before(async () => {
  mongo = await startMongo();
  db = mongo.db;
  c = collections(db);
  await ensureIndexes(db);
  const [alice, bob, carol] = await insertStudents(db, [
    { username: 'Alice', name: 'Alice A', campus: 'RU', batch: 2025 },
    { username: 'Bob', name: 'Bob B', campus: 'ADYPU', batch: 2026 },
    { username: 'carol', name: 'Carol C', campus: 'RU', batch: 2024 },
    { username: 'dave', name: 'Dave D', campus: 'SVYASA', batch: 2024 },
  ]);
  invalidateContext();
  await upsertPRs(db, alice, [
    node('apache/airflow', 1, { language: 'Python' }),                              // ai_data by name
    node('apache/airflow', 2, { language: 'Python', state: 'OPEN', mergedAt: null }),
    node('facebook/react', 3, { language: 'JavaScript', topics: ['react', 'ui'], languages: [['JavaScript', 900], ['TypeScript', 100]] }),
    node('kubernetes/kubernetes', 4, { language: 'Go' }),                            // devops by name
    node('Alice/notes', 5, { language: null, ownerType: 'User', stars: 1 }),         // own repo, docs by "no language"
  ]);
  await upsertPRs(db, bob, [
    node('facebook/react', 6, { language: 'JavaScript', topics: ['react', 'ui'] }),
    node('kubernetes/kubernetes', 7, { language: 'Go', createdAt: daysAgo(400), mergedAt: daysAgo(399) }), // before the AY
  ]);
  await upsertPRs(db, carol, [node('rust-lang/zeta', 8, { language: 'Rust' })]);   // systems by language
  await refreshAggregates(db);
  app = await startApp(db);
});

after(async () => {
  await whenIdle(db);
  await app?.close();
  await mongo?.stop();
});

test('ingest: languages and topics are stored and drive the domain; a legacy node never wipes them', async () => {
  // the nightly PR search asks for them, so a sync keeps them fresh
  assert.match(SEARCH_QUERY, /languages\(first:5, orderBy:\{field:SIZE, direction:DESC\}\)\{totalSize edges\{size node\{name\}\}\}/);
  assert.match(SEARCH_QUERY, /repositoryTopics\(first:10\)\{nodes\{topic\{name\}\}\}/);
  const react = await c.repos.findOne({ _id: 'facebook/react' });
  assert.deepEqual(react.topics, ['react', 'ui']);
  assert.deepEqual(react.languages.map((l) => [l.name, l.bytes, l.pct]), [['JavaScript', 900, 90], ['TypeScript', 100, 10]]);
  assert.deepEqual([react.domain, react.domainRule], ['web_frontend', 'topic-frontend']);
  assert.equal((await c.repos.findOne({ _id: 'alice/notes' })).domain, 'docs');
  // a legacy-style node (no topics / languages fields) for the same repo keeps what is stored
  const [alice] = await c.students.find({ _id: 'alice' }).toArray();
  const legacy = prNode({ repo: 'facebook/react', number: 3, createdAt: daysAgo(20), mergedAt: daysAgo(18) });
  legacy.repository.primaryLanguage = { name: 'JavaScript' };
  await upsertPRs(db, alice, [legacy]);
  const again = await c.repos.findOne({ _id: 'facebook/react' });
  assert.deepEqual([again.topics, again.languages.length, again.domain], [['react', 'ui'], 2, 'web_frontend']);
  // ensureDomains: nothing to do when the table is unchanged and every repo is classified
  await ensureDomains(db, { force: true });
  assert.equal((await ensureDomains(db)).recomputed, false);
  await c.repos.updateOne({ _id: 'rust-lang/zeta' }, { $unset: { domain: '' } });
  const d = await ensureDomains(db);
  assert.deepEqual([d.recomputed, d.changed], [true, 1]);
  assert.equal((await c.repos.findOne({ _id: 'rust-lang/zeta' })).domain, 'systems');
});

test('GET /api/tech: totals equal the overview for the same range and filters, by language and by domain', async () => {
  for (const q of ['', '&range=all', '&campus=RU', '&range=all&campus=RU', '&year=2nd%20year']) {
    const ov = (await app.get(`/api/overview?x=1${q}`)).body;
    for (const by of ['language', 'domain']) {
      const t = (await app.get(`/api/tech?by=${by}${q}`)).body;
      assert.equal(t.by, by);
      assert.deepEqual([t.totals.prs, t.totals.merged, t.totals.students, t.totals.mergedStudents],
        [ov.prs.osPrs, ov.prs.osMerged, ov.students.withOsPr, ov.students.withOsMerged], `${by} ${q}`);
      assert.equal(t.rows.reduce((s, r) => s + r.merged, 0), t.totals.merged);
      assert.equal(t.rows.reduce((s, r) => s + r.prs, 0), t.totals.prs);
      assert.equal(t.byCampus.reduce((s, r) => s + r.merged, 0), t.totals.merged);
      assert.deepEqual(t.range, ov.range);
    }
    // category=all equals the all-category PR totals of the overview
    const all = (await app.get(`/api/tech?category=all${q}`)).body;
    assert.deepEqual([all.totals.prs, all.totals.merged], [ov.prs.total, ov.prs.merged], `all ${q}`);
  }
});

test('GET /api/tech: rows, shares, top repos, campus rates and the monthly series', async () => {
  const t = (await app.get('/api/tech?by=language&range=all')).body;
  assert.deepEqual(Object.keys(t), ['range', 'category', 'filters', 'by', 'rows', 'byCampus', 'cohorts', 'smallCohortBelow', 'byMonth', 'months', 'monthKeys', 'totals']);
  // open source: airflow (Python, 1 merged + 1 open), react (JS, 2 merged), kubernetes (Go, 2 merged), zeta (Rust, 1 merged); own repo excluded
  assert.deepEqual(t.rows.map((r) => [r.key, r.merged, r.prs, r.students, r.repos]),
    [['Go', 2, 2, 2, 1], ['JavaScript', 2, 2, 2, 1], ['Python', 1, 2, 1, 1], ['Rust', 1, 1, 1, 1]]);
  assert.deepEqual(t.rows.map((r) => r.mergedShare), [33.3, 33.3, 16.7, 16.7]);
  assert.deepEqual(t.rows[1].topRepos, [{ name: 'facebook/react', stars: 5000, prs: 2, merged: 2, students: 2 }]);
  // per 100 students: RU has alice + carol (2 tracked), Go merged 1 there -> 50 per 100
  const ruGo = t.byCampus.find((x) => x.campus === 'RU' && x.key === 'Go');
  assert.deepEqual([ruGo.merged, ruGo.cohort, ruGo.per100, ruGo.studentsPct], [1, 2, 50, 50]);
  const sv = t.cohorts.find((x) => x.campus === 'SVYASA');
  assert.deepEqual([sv.students, sv.merged, sv.smallCohort], [1, 0, true]);
  // byMonth: dense over months x keys, sums to the merged total
  assert.equal(t.byMonth.length, t.months.length * t.monthKeys.length);
  assert.equal(t.byMonth.reduce((s, r) => s + r.merged, 0), t.totals.merged);
  const top1 = (await app.get('/api/tech?by=language&range=all&campus=RU')).body;
  assert.ok(top1.byCampus.every((x) => x.campus === 'RU'));

  // domain view carries labels and the domain list
  const d = (await app.get('/api/tech?by=domain&range=all')).body;
  assert.deepEqual(d.rows.map((r) => [r.key, r.label, r.merged]),
    [['devops', 'DevOps / cloud / infra', 2], ['web_frontend', 'Web frontend', 2], ['ai_data', 'AI / ML & data', 1], ['systems', 'Systems / low-level', 1]]);
  assert.ok(d.domains.some((x) => x.key === 'other'));
  // all work includes the own repo, under docs (no language)
  const da = (await app.get('/api/tech?by=domain&range=all&category=all')).body;
  assert.equal(da.rows.find((r) => r.key === 'docs').prs, 1);
  // the AY default leaves out bob's old kubernetes PR
  const ay = (await app.get('/api/tech?by=domain')).body;
  assert.equal(ay.rows.find((r) => r.key === 'devops').merged, 1);
  // bad values are 400
  assert.equal((await app.get('/api/tech?by=stack')).status, 400);
  assert.equal((await app.get('/api/tech?category=web')).status, 400);
});

test('technology on other payloads: student tech mix, repo fields, org tech, project filters', async () => {
  const p = (await app.get('/api/students/alice?range=all')).body;
  assert.deepEqual(p.tech.language.map((r) => [r.key, r.prs, r.merged, r.osMerged]),
    [['Python', 2, 1, 1], ['Go', 1, 1, 1], ['JavaScript', 1, 1, 1], ['(none)', 1, 1, 0]]);
  assert.deepEqual(p.tech.domain.map((r) => r.key), ['ai_data', 'devops', 'web_frontend', 'docs']);
  const repo = (await app.get('/api/repos/facebook/react?range=all')).body.repo;
  assert.deepEqual([repo.language, repo.topics, repo.domain, repo.domainLabel], ['JavaScript', ['react', 'ui'], 'web_frontend', 'Web frontend']);
  assert.deepEqual(repo.languages, [{ name: 'JavaScript', pct: 90 }, { name: 'TypeScript', pct: 10 }]);
  assert.match(repo.domainReason, /topic "react"/);
  const org = (await app.get('/api/orgs/kubernetes?range=all')).body;
  assert.deepEqual(org.tech.domain.map((r) => [r.key, r.prs]), [['devops', 2]]);
  // Projects list filtered by language (case-insensitive) or domain, also with a range
  const names = async (qs) => (await app.get(`/api/repos?${qs}`)).body.items.map((r) => r.name);
  assert.deepEqual(await names('language=go&range=all'), ['kubernetes/kubernetes']);
  assert.deepEqual(await names('domain=web_frontend&range=all'), ['facebook/react']);
  assert.deepEqual(await names('domain=devops'), ['kubernetes/kubernetes']);
  assert.deepEqual(await names(`language=${encodeURIComponent('(none)')}&category=all&range=all`), ['Alice/notes']);
  assert.equal((await app.get('/api/repos?domain=nope')).status, 400);
  const meta = (await app.get('/api/meta')).body;
  assert.ok(meta.techDomains.some((d) => d.key === 'web_frontend' && d.label === 'Web frontend'));
});

// ---------- enrichment job ----------

/** Fake GraphQL endpoint for aliased repository() queries. `repos`: Map<lc 'owner/name', node | 'missing' | 'private' | {renamedTo}> */
function fakeRepoGitHub(repos) {
  const gh = { calls: [], fail: 0, rateLimit: { cost: 1, remaining: 4000, resetAt: new Date(Date.now() + 600000).toISOString() } };
  gh.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const aliases = [...body.query.matchAll(/(r\d+): repository\(owner: \$(o\d+), name: \$(n\d+)\)/g)];
    gh.calls.push({ size: aliases.length, auth: init.headers.Authorization });
    if (gh.fail > 0) { gh.fail--; return json({ message: 'Bad gateway' }, { status: 502 }); }
    const data = { rateLimit: gh.rateLimit };
    const errors = [];
    for (const [, alias, o, n] of aliases) {
      const id = `${body.variables[o]}/${body.variables[n]}`.toLowerCase();
      const v = repos.get(id);
      if (!v || v === 'missing') { data[alias] = null; errors.push({ type: 'NOT_FOUND', path: [alias], message: `Could not resolve to a Repository with the name '${id}'.` }); continue; }
      const full = v.renamedTo || `${body.variables[o]}/${body.variables[n]}`;
      data[alias] = {
        nameWithOwner: full, isFork: false, isArchived: false, isPrivate: v === 'private', stargazerCount: v.stars ?? 100, forkCount: 1,
        description: v.description ?? null, owner: { login: full.split('/')[0], __typename: 'Organization' },
        primaryLanguage: v.language === undefined ? { name: 'Python' } : (v.language && { name: v.language }), licenseInfo: null,
        languages: { totalSize: 100, edges: [{ size: 100, node: { name: v.language || 'Python' } }] },
        repositoryTopics: { nodes: (v.topics || []).map((t) => ({ topic: { name: t } })) },
      };
    }
    return json({ data, ...(errors.length && { errors }) });
  };
  return gh;
}

test('repoMeta: aliased batches of 40, variables not string-built, topics/languages stored, domains recomputed', async () => {
  const q = buildRepoQuery(['a/b', 'c/"x']);
  assert.deepEqual(q.variables, { o0: 'a', n0: 'b', o1: 'c', n1: '"x' });
  assert.doesNotMatch(q.query, /"x/);
  // 85 extra repos -> batches of 40, 40, then the rest
  const extra = Array.from({ length: 85 }, (_, i) => ({ _id: `bulk/r${i}`, name: `bulk/r${i}`, owner: 'bulk', ownerLc: 'bulk', stars: 100, stats: { prs: 0 } }));
  await c.repos.insertMany(extra);
  const all = await c.repos.find({}, { projection: { name: 1 } }).toArray();
  const map = new Map(all.map((r) => [r._id, { language: 'Python' }]));
  map.set('rust-lang/zeta', { language: 'Rust', topics: ['machine-learning'], stars: 100 });
  map.set('kubernetes/kubernetes', { language: 'Go', stars: 5000, renamedTo: 'kubernetes/k8s' });
  map.set('apache/airflow', 'missing');
  map.set('alice/notes', 'private');
  const gh = fakeRepoGitHub(map);
  const sleep = fakeSleep();
  const lines = [];
  const s = await repoMetaJob(db, {}, { log: (l) => lines.push(l) }, { fetch: gh.fetch, token: 't0ken', sleep });
  assert.equal(s.repos, all.length);
  assert.deepEqual(gh.calls.map((x) => x.size), [40, 40, all.length - 80]);
  assert.equal(gh.calls[0].auth, 'bearer t0ken');
  assert.deepEqual([s.ok, s.renamed, s.missing, s.private, s.failed, s.requests], [all.length - 3, 1, 1, 1, 0, 3]);
  const zeta = await c.repos.findOne({ _id: 'rust-lang/zeta' });
  assert.deepEqual([zeta.topics, zeta.metaStatus, zeta.domain, zeta.domainRule], [['machine-learning'], 'ok', 'ai_data', 'topic-ai']);
  assert.ok(zeta.metaFetchedAt instanceof Date);
  const k8s = await c.repos.findOne({ _id: 'kubernetes/kubernetes' });
  assert.deepEqual([k8s.metaStatus, k8s.renamedTo, k8s.stars], ['renamed', 'kubernetes/k8s', 5000]);
  const air = await c.repos.findOne({ _id: 'apache/airflow' });
  assert.equal(air.metaStatus, 'missing');
  assert.match(air.metaError, /NOT_FOUND/);
  assert.equal(air.language, 'Python', 'a missing repo keeps its stored metadata');
  assert.equal((await c.repos.findOne({ _id: 'alice/notes' })).metaStatus, 'private');
  // resumable: a second run finds nothing due; force re-reads everything
  const again = await repoMetaJob(db, {}, {}, { fetch: gh.fetch, token: 't', sleep });
  assert.deepEqual([again.repos, again.requests], [0, 0]);
  const forced = await repoMetaJob(db, { force: true, limit: 5 }, {}, { fetch: gh.fetch, token: 't', sleep });
  assert.equal(forced.repos, 5);
  await c.repos.deleteMany({ owner: 'bulk' });
});

test('repoMeta: rate limit sleeps until the reset, a 502 shrinks the batch, repeated failure leaves repos for later, cancel stops', async () => {
  const bulkRepos = Array.from({ length: 250 }, (_, i) => ({ _id: `bulk/r${i}`, name: `bulk/r${i}`, owner: 'bulk', ownerLc: 'bulk', stars: 100, stats: { prs: 0 } }));
  await c.repos.insertMany(bulkRepos);
  try {
    await c.repos.updateMany({}, { $unset: { metaFetchedAt: '' } });
    const n = await c.repos.countDocuments();
    const map = new Map((await c.repos.find({}).toArray()).map((r) => [r._id, { language: 'Python', stars: r.stars }]));
    const gh = fakeRepoGitHub(map);
    const reset = Date.now() + 120000;
    gh.rateLimit = { cost: 1, remaining: 50, resetAt: new Date(reset).toISOString() };
    gh.fail = 3; // the first 40-batch gets three 502s (gql retries each batch 3 times), then a 20-batch answers
    const sleep = fakeSleep();
    const s = await repoMetaJob(db, {}, {}, { fetch: gh.fetch, token: 't', sleep, now: () => new Date(reset - 120000) });
    assert.equal(s.ok, n);
    assert.deepEqual(gh.calls.slice(0, 5).map((x) => x.size), [40, 40, 40, BATCH_SIZES[1], 40]);
    assert.ok(sleep.calls.some((ms) => ms >= 120000 && ms <= 130000), `slept until the rate-limit reset: ${sleep.calls}`);

    // every size fails: those repos keep no metaFetchedAt (the next run retries them); five failures in a row end the job
    await c.repos.updateMany({}, { $unset: { metaFetchedAt: '' } });
    const down = fakeRepoGitHub(map);
    down.fail = 1e9;
    await assert.rejects(repoMetaJob(db, {}, {}, { fetch: down.fetch, token: 't', sleep: fakeSleep() }), /5 batches in a row/);
    assert.equal(await c.repos.countDocuments({ metaFetchedAt: { $type: 'date' } }), 0);

    // a bad token is fatal at once; no token never starts
    const unauthorized = async () => json({ message: 'Bad credentials' }, { status: 401 });
    await assert.rejects(repoMetaJob(db, {}, {}, { fetch: unauthorized, token: 't', sleep: fakeSleep() }), /401/);
    await assert.rejects(repoMetaJob(db, {}, {}, { fetch: gh.fetch, token: '', sleep: fakeSleep() }), /GITHUB_TOKEN/);

    // cancel between batches keeps what was saved; the next run resumes with the rest
    const ok = fakeRepoGitHub(map);
    let checks = 0;
    const cancelled = await repoMetaJob(db, {}, { isCancelled: async () => checks++ > 0 }, { fetch: ok.fetch, token: 't', sleep: fakeSleep() });
    assert.deepEqual([cancelled.cancelled, ok.calls.length, cancelled.ok], [true, 1, 40]);
    const rest = await repoMetaJob(db, {}, {}, { fetch: ok.fetch, token: 't', sleep: fakeSleep() });
    assert.equal(rest.repos, n - 40);
  } finally {
    await c.repos.deleteMany({ owner: 'bulk' });
  }
});

test('repoMeta: stars that cross a threshold reclassify the repo PRs; admin route queues one job at a time', async () => {
  // zeta has 5000 stars (fixture) -> major; GitHub now says 10 -> under the org threshold
  await c.repos.updateMany({}, { $set: { metaFetchedAt: new Date() } });
  await c.repos.updateOne({ _id: 'rust-lang/zeta' }, { $unset: { metaFetchedAt: '' } });
  const gh = fakeRepoGitHub(new Map([['rust-lang/zeta', { language: 'Rust', stars: 10 }]]));
  await repoMetaJob(db, {}, {}, { fetch: gh.fetch, token: 't', sleep: fakeSleep() });
  const pr = await c.prs.findOne({ repoLc: 'rust-lang/zeta' });
  assert.deepEqual([pr.category, pr.stars], ['low_signal', 10]);
  assert.equal((await c.students.findOne({ _id: 'carol' })).stats.osMerged, 0, 'aggregates refreshed');

  // POST /api/admin/jobs/repo-meta (the handler is faked: GitHub is not reachable here)
  let release;
  const gate = new Promise((r) => { release = r; });
  registerHandler('repoMeta', async () => { await gate; return { repos: 0, ok: 0 }; });
  try {
    await app.login();
    assert.equal((await app.post('/api/admin/jobs/repo-meta', { force: 'yes' })).status, 400);
    const first = await app.post('/api/admin/jobs/repo-meta', { force: true });
    assert.equal(first.status, 202);
    const second = await app.post('/api/admin/jobs/repo-meta', {});
    assert.equal(second.status, 409);
    assert.equal(second.body.error.jobId, first.body.job.id);
    release();
    await whenIdle(db);
    const job = (await app.get(`/api/admin/jobs/${first.body.job.id}`)).body.job;
    assert.deepEqual([job.type, job.status, job.params.force], ['repoMeta', 'done', true]);
    assert.equal((await app.get('/api/admin/jobs?type=repoMeta')).body.total, 1);
  } finally {
    release();
    unregisterHandler('repoMeta');
  }
});
