import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesForYear, classify, compileRules, isNstOwner, yearLabel } from '../src/classify.js';
import { DEFAULT_RULES, defaultRules, validateRules } from '../src/rules.js';
import { csvField, csvLine, parseCsv, parseCsvRows } from '../src/csv.js';
import { createToken, parseCookies, safeEqual, verifyToken, SESSION_MS } from '../src/auth.js';
import { buildDocs } from '../src/ingest.js';
import { loadConfig } from '../src/config.js';
import { prNode, studentDoc } from './helpers/fixtures.js';

const ctx = compileRules(DEFAULT_RULES, new Set(['alice', 'bob', 'bob-new']), new Map([['alice', 'alice'], ['bob', 'bob-new']]));
const base = { repo: 'apache/airflow', ownerType: 'Organization', stars: 5000, isFork: false };
const cat = (input) => classify({ ...base, ...input }, ctx);

test('yearLabel / batchesForYear follow the academic year (starts 1 July)', () => {
  const nov = new Date('2026-11-19T00:00:00Z');
  assert.equal(yearLabel(2026, nov), '1st year');
  assert.equal(yearLabel(2025, nov), '2nd year');
  assert.equal(yearLabel(2023, nov), '4th year');
  assert.equal(yearLabel(2022, nov), 'alumni');
  assert.equal(yearLabel(2027, nov), 'Unknown');
  assert.equal(yearLabel(null, nov), 'Unknown');
  assert.equal(yearLabel(undefined, nov), 'Unknown');
  // before 1 July the academic year is still the previous one
  assert.equal(yearLabel(2025, new Date('2026-06-30T23:59:59Z')), '1st year');
  assert.equal(yearLabel(2025, new Date('2026-07-01T00:00:00Z')), '2nd year');
  assert.deepEqual(batchesForYear('1st year', nov), { batch: 2026 });
  assert.deepEqual(batchesForYear('4th year', nov), { batch: 2023 });
  assert.deepEqual(batchesForYear('alumni', nov), { batch: { $lt: 2023 } });
  assert.deepEqual(batchesForYear('Unknown', nov), { batch: null });
  assert.equal(batchesForYear('5th year', nov), null);
  for (const b of [2023, 2024, 2025, 2026]) assert.deepEqual(batchesForYear(yearLabel(b, nov), nov), { batch: b });
});

test('classification order: first match wins', () => {
  // 12 + tiers
  assert.deepEqual(cat({}), { category: 'open_source', tier: 'major', reason: 'major' });
  assert.deepEqual(cat({ stars: 1000 }), { category: 'open_source', tier: 'major', reason: 'major' });
  assert.deepEqual(cat({ stars: 999 }), { category: 'open_source', tier: 'established', reason: 'established' });
  assert.deepEqual(cat({ stars: 199 }), { category: 'open_source', tier: 'emerging', reason: 'emerging' });
  assert.deepEqual(cat({ stars: 50 }), { category: 'open_source', tier: 'emerging', reason: 'emerging' });
  // 11
  assert.deepEqual(cat({ stars: 49 }), { category: 'low_signal', tier: null, reason: 'under 50 stars' });
  // 10
  assert.deepEqual(cat({ repo: 'someone/tool', ownerType: 'User', stars: 199 }), { category: 'low_signal', tier: null, reason: 'personal repo under 200 stars' });
  assert.equal(cat({ repo: 'someone/tool', ownerType: 'User', stars: 200 }).category, 'open_source');
  // 9: allow-listed org regardless of stars, tier emerging below 50
  assert.deepEqual(cat({ repo: 'C2SIorg/thing', stars: 3 }), { category: 'open_source', tier: 'emerging', reason: 'emerging' });
  // 8: forks, even of an allow-listed org
  assert.deepEqual(cat({ isFork: true }), { category: 'low_signal', tier: null, reason: 'repo is a fork' });
  assert.equal(cat({ repo: 'c2siorg/thing', isFork: true }).category, 'low_signal');
  // 7: practice by repo list, by repo name keyword, by owner keyword (beats fork and stars)
  assert.equal(cat({ repo: 'FirstContributions/First-Contributions', stars: 50000 }).category, 'practice');
  assert.equal(cat({ repo: 'bigorg/Hacktoberfest-2026', stars: 9000, isFork: true }).category, 'practice');
  assert.equal(cat({ repo: 'gssoc-org/site' }).category, 'practice');
  // 6: peer repo by student id and by current username; wins over practice
  assert.equal(cat({ repo: 'Alice/practice-repo', ownerType: 'User' }).category, 'peer_repo');
  assert.equal(cat({ repo: 'bob-new/x', ownerType: 'User', author: 'alice' }).category, 'peer_repo');
  // 5: NST org / keyword wins over peer
  assert.equal(cat({ repo: 'NST-SDC/site' }).category, 'nst_internal');
  assert.equal(cat({ repo: 'devclub-nstru/site' }).category, 'nst_internal');
  // 4: own repo (by _id and by renamed username); repo level (no author) falls through to peer_repo
  assert.deepEqual(cat({ repo: 'Alice/x', ownerType: 'User', author: 'alice' }), { category: 'own_repo', tier: null, reason: 'author owns repo' });
  assert.equal(cat({ repo: 'Bob-New/x', ownerType: 'User', author: 'bob' }).category, 'own_repo');
  assert.equal(cat({ repo: 'bob/x', ownerType: 'User', author: 'bob' }).category, 'own_repo');
  assert.equal(cat({ repo: 'alice/x', ownerType: 'User' }).category, 'peer_repo');
});

test('overrides: PR beats repo beats owner beats rules', () => {
  assert.deepEqual(cat({ ownerOverride: 'exclude' }), { category: 'low_signal', tier: null, reason: 'admin: org excluded' });
  assert.deepEqual(cat({ ownerOverride: 'nst_internal' }), { category: 'nst_internal', tier: null, reason: 'admin: org marked NST internal' });
  assert.deepEqual(cat({ stars: 3, ownerOverride: 'include' }), { category: 'open_source', tier: 'emerging', reason: 'admin: org included' });
  assert.deepEqual(cat({ ownerOverride: 'exclude', repoOverride: 'include', stars: 300 }), { category: 'open_source', tier: 'established', reason: 'admin: repo included' });
  assert.deepEqual(cat({ ownerOverride: 'include', repoOverride: 'exclude' }), { category: 'low_signal', tier: null, reason: 'admin: repo excluded' });
  assert.deepEqual(cat({ repoOverride: 'include', prOverride: 'not_open_source' }), { category: 'low_signal', tier: null, reason: 'admin: marked not open source' });
  assert.deepEqual(cat({ repoOverride: 'exclude', prOverride: 'open_source' }), { category: 'open_source', tier: 'major', reason: 'admin: marked open source' });
  // overrides beat own_repo / nst_internal too
  assert.equal(cat({ repo: 'alice/x', author: 'alice', stars: 0, prOverride: 'open_source' }).category, 'open_source');
  assert.equal(cat({ repo: 'nst-sdc/x', repoOverride: 'include' }).category, 'open_source');
});

test('NST owner keywords: short ones need a whole token, long ones may be substrings', () => {
  assert.equal(isNstOwner('nst-sdc', ctx), true);
  assert.equal(isNstOwner('club-nst', ctx), true);
  assert.equal(isNstOwner('nstru', ctx), false);          // "nst" is not a whole token
  assert.equal(isNstOwner('instagram', ctx), false);
  assert.equal(isNstOwner('mynewtonschool', ctx), true);  // "newton" (6 chars) as a substring
  assert.equal(isNstOwner('rishihood-club', ctx), true);
  assert.equal(isNstOwner('sastxnst', ctx), true);        // listed in nstOrgs
  assert.equal(isNstOwner('apache', ctx), false);
});

test('rules validation', () => {
  assert.equal(validateRules(defaultRules()).error, undefined);
  assert.deepEqual(validateRules({ ...defaultRules(), nstOrgs: [' a ', 'A', 'b'] }).rules.nstOrgs, ['a', 'b']);
  assert.match(validateRules({ ...defaultRules(), tiers: { major: 100, established: 100 } }).error, /greater/);
  assert.match(validateRules({ ...defaultRules(), minStarsOrgRepo: -1 }).error, /minStarsOrgRepo/);
  assert.match(validateRules({ ...defaultRules(), minStarsUserRepo: '200' }).error, /minStarsUserRepo/);
  assert.match(validateRules({ ...defaultRules(), allowOrgs: ['ok', ' '] }).error, /empty/);
  assert.match(validateRules({ ...defaultRules(), practiceRepos: 'x' }).error, /list/);
  assert.match(validateRules(null).error, /object/);
  const { tiers, ...noTiers } = defaultRules();
  assert.match(validateRules(noTiers).error, /tiers/);
});

test('csv reader and writer', () => {
  assert.deepEqual(parseCsvRows('a,b\r\n"x, y","he said ""hi"""\n\n1,\n'), [['a', 'b'], ['x, y', 'he said "hi"'], ['1', '']]);
  assert.deepEqual(parseCsv('﻿Campus, GitHub_Username\nRU, octocat \n'), [{ campus: 'RU', github_username: 'octocat' }]);
  assert.deepEqual(parseCsv('a,b\n"multi\nline",2'), [{ a: 'multi\nline', b: '2' }]);
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "x"'), '"say ""x"""');
  assert.equal(csvField(null), '');
  assert.equal(csvField(-5), '-5');
  assert.equal(csvField('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');   // formula injection guard
  assert.equal(csvLine(['a', 1, null, true]), 'a,1,,true\n');
  assert.deepEqual(parseCsvRows(csvLine(['x, "y"', 'line\nbreak'])), [['x, "y"', 'line\nbreak']]);
});

test('session tokens and helpers', () => {
  const now = Date.now();
  const token = createToken('secret', now);
  assert.equal(verifyToken(token, 'secret', now), true);
  assert.equal(verifyToken(token, 'other-secret', now), false);
  assert.equal(verifyToken(token, 'secret', now + SESSION_MS + 1), false);
  assert.equal(verifyToken(token.slice(0, -2) + 'xx', 'secret', now), false);
  const forged = Buffer.from(JSON.stringify({ exp: now + 1e12 })).toString('base64url') + '.' + token.split('.')[1];
  assert.equal(verifyToken(forged, 'secret', now), false);
  for (const bad of [undefined, '', 'abc', '.', 'a.b.c']) assert.equal(verifyToken(bad, 'secret', now), false);
  assert.deepEqual(parseCookies('a=1; oss_admin=x.y; b=%20z'), { a: '1', oss_admin: 'x.y', b: ' z' });
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('config defaults', () => {
  const c = loadConfig({});
  assert.equal(c.port, 3000);
  assert.equal(c.mongoUri, 'mongodb://localhost:27017');
  assert.equal(c.mongoDb, 'oss_status');
  assert.equal(c.syncConcurrency, 6);
  assert.equal(c.trustProxy, 1);
  assert.equal(c.adminPassword, '');
  assert.equal(c.production, false);
  assert.ok(c.sessionSecret.length >= 32);
  assert.equal(loadConfig({ NODE_ENV: 'production', PORT: '8080', SYNC_CONCURRENCY: '2' }).production, true);
  assert.equal(loadConfig({ PORT: '8080' }).port, 8080);
});

test('buildDocs: state, title, private repos, duplicates, legacy nodes', () => {
  const s = studentDoc({ username: 'Alice', campus: 'ADYPU', batch: 2026 });
  const merged = prNode({ repo: 'apache/airflow', number: 1, title: '  Fix \n  scheduler\trace ' });
  const open = prNode({ repo: 'apache/airflow', number: 2, state: 'OPEN' });
  const closed = prNode({ repo: 'Other/Repo', number: 3, state: 'CLOSED', ownerType: 'User', stars: 7 });
  const priv = prNode({ repo: 'secret/repo', number: 4, isPrivate: true });
  const withAuthor = prNode({ repo: 'apache/airflow', number: 5, author: { login: 'Alice-New', databaseId: 4242 }, updatedAt: '2026-11-01T00:00:00Z' });
  const d = buildDocs(s, [merged, open, closed, priv, null, merged, withAuthor, { url: 'x' }]);
  assert.equal(d.prs.length, 4);
  assert.equal(d.skippedPrivate, 1);
  assert.equal(d.githubId, 4242);
  const [a, b, c, e] = d.prs;
  assert.equal(a._id, 'https://github.com/apache/airflow/pull/1');
  assert.equal(a.title, 'Fix scheduler race');
  assert.equal(a.state, 'merged');
  assert.equal(b.state, 'open');
  assert.equal(c.state, 'closed');
  assert.ok(a.createdAt instanceof Date && a.mergedAt instanceof Date);
  assert.equal(b.mergedAt, null);
  assert.equal(a.updatedAt, null);
  assert.equal(a.author, 'alice');
  assert.equal(a.authorLogin, 'Alice');
  assert.equal(e.authorLogin, 'Alice-New');
  assert.ok(e.updatedAt instanceof Date);
  assert.deepEqual([a.campus, a.batch, a.active, a.comments, a.reviews, a.stars], ['ADYPU', 2026, true, 2, 1, 5000]);
  assert.deepEqual([c.repo, c.repoLc, c.owner, c.ownerLc, c.ownerType], ['Other/Repo', 'other/repo', 'Other', 'other', 'User']);
  assert.deepEqual([...d.repos.keys()], ['apache/airflow', 'other/repo']);
  assert.deepEqual(d.repos.get('apache/airflow').license, 'MIT');
  assert.deepEqual([...d.owners.keys()], ['apache', 'other']);
});
