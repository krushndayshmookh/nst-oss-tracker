// SPEC addendum G: the private "Krushn's dashboard" — access, scoring, org mapping, API (real mongod).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { startMongo } from './helpers/mongo.js';
import { startApp, TEST_PASSWORD } from './helpers/app.js';
import { insertStudents, prNode } from './helpers/fixtures.js';
import { collections, ensureIndexes } from '../src/db.js';
import { refreshAggregates, upsertPRs } from '../src/ingest.js';
import { invalidateContext } from '../src/classify.js';
import { registerHandler, unregisterHandler, runInline, whenIdle } from '../src/jobs.js';
import { ownerProblem } from '../src/config.js';
import { OWNER_SESSION_MS } from '../src/owner.js';
import {
  defaultProgramsDoc, ensurePrograms, githubLoginsIn, loadPrograms, mapProgramOrg, mapProgramOrgs, nameCandidates, savePrograms, validatePrograms, DEFAULT_WEIGHTS,
} from '../src/programs.js';
import { compileProgram, isDocsTitle, isNonTrivial, matchesProgram, programTimeline, recomputeScores, sat, scoreProgram, scoreStudent, weekStartOf, CURVES } from '../src/scores.js';
import { fetchGsocOrgs, gsocApiUrl, run as runOrgs } from '../scripts/fetch_program_orgs.js';
import { proposalsToOutcomes, readSheet } from '../scripts/convert_gsoc_mentees.js';

const OWNER_PASSWORD = 'owner page second password';
const BANDS = { strong: 60, possible: 35, early: 10 };
const ist = (ymd, hm = '12:00') => new Date(`${ymd}T${hm}:00+05:30`);

let mongo;
before(async () => { mongo = await startMongo(); });
after(async () => { await mongo.stop(); });
let n = 0;
async function freshDb() {
  const db = mongo.client.db(`owner_${++n}_${Math.random().toString(16).slice(2, 8)}`);
  await ensureIndexes(db);
  invalidateContext();
  return db;
}

// ---------- pure scoring ----------

let seq = 0;
/** A PR document as stored in `prs` (only the fields the scorer reads). */
function pr({ owner = 'zulip', repo = 'zulip', created, merged = null, closed = null, add = 60, del = 10, files = 3, title = 'Fix narrow race', category = 'open_source',
  tier = 'established', reason = 'established', comments = 2, reviews = 1, override = null } = {}) {
  seq++;
  return { url: `https://github.com/${owner}/${repo}/pull/${seq}`, title, repo: `${owner}/${repo}`, repoLc: `${owner}/${repo}`.toLowerCase(), owner, ownerLc: owner.toLowerCase(),
    category, tier, reason, override, createdAt: new Date(created), mergedAt: merged ? new Date(merged) : null, closedAt: merged ? new Date(merged) : (closed ? new Date(closed) : null),
    additions: add, deletions: del, changedFiles: files, comments, reviews };
}
const program = (over = {}) => compileProgram({ key: 'gsoc', name: 'GSoC 2027', match: 'orgs', orgs: ['zulip', 'sugarlabs', 'oppia'], repos: [], includeLowStar: true,
  window: { from: '2026-09-01', to: '2027-04-08' }, preWindowWeight: 0.5, weights: { ...DEFAULT_WEIGHTS }, prestigious: true, ...over }, 'Asia/Kolkata');
const NOW = ist('2026-11-19');
const score = (prs, over = {}, opts = {}) => scoreProgram(prs, program(over), { asOf: NOW, bands: BANDS, tz: 'Asia/Kolkata', ...opts });
const mergedIn = (count, extra = {}) => Array.from({ length: count }, (_, i) => pr({ created: ist('2026-10-01'), merged: ist(`2026-10-${String(2 + i).padStart(2, '0')}`), ...extra }));

test('scores: saturation curve and the depth feature follow the documented points', () => {
  assert.equal(sat(0, CURVES.depth), 0);
  assert.equal(sat(1, CURVES.depth), 0.25);
  assert.equal(sat(3, CURVES.depth), 0.6);
  assert.equal(sat(6, CURVES.depth), 0.85);
  assert.equal(sat(10, CURVES.depth), 1);
  assert.equal(sat(50, CURVES.depth), 1);
  assert.equal(sat(2, CURVES.depth), 0.425, 'linear between the points');
  for (const [count, value] of [[1, 0.25], [3, 0.6], [6, 0.85], [10, 1]]) {
    const s = score(mergedIn(count));
    assert.equal(s.features.depth.value, value, `${count} merged PRs in one org`);
    assert.equal(s.bestOrg, 'zulip');
    assert.equal(s.mergedInBestOrg, count);
  }
});

test('scores: depth is about the best SINGLE org; PRs merged before the window count at the pre-window weight', () => {
  // 2 in zulip, 2 in sugarlabs, 2 in oppia: spread → depth of 2, not 6
  const spread = [...mergedIn(2), ...mergedIn(2, { owner: 'sugarlabs', repo: 'musicblocks' }), ...mergedIn(2, { owner: 'oppia', repo: 'oppia' })];
  const s = score(spread);
  assert.equal(s.features.depth.detail.mergedInBestOrg, 2);
  assert.equal(s.features.depth.value, 0.425);
  assert.equal(s.features.breadth.detail.otherOrgs, 2);
  assert.equal(s.features.breadth.value, 0.8);
  assert.ok(score(mergedIn(6)).score > s.score, 'six merged PRs in one org beat six spread over three');

  // 4 merged before the window (×0.5) + 1 inside = weighted 3 → 0.6
  const old = Array.from({ length: 4 }, () => pr({ created: ist('2026-05-01'), merged: ist('2026-05-03') }));
  const mixed = score([...old, ...mergedIn(1)]);
  assert.deepEqual(mixed.features.depth.detail, { mergedInBestOrg: 5, mergedInWindow: 1, mergedBeforeWindow: 4, weighted: 3 });
  assert.equal(mixed.features.depth.value, 0.6);
  assert.equal(score([...old, ...mergedIn(1)], { preWindowWeight: 1 }).features.depth.detail.weighted, 5);
});

test('scores: substance — non-trivial needs 30 lines in 2 files and a non-docs title', () => {
  assert.equal(isNonTrivial({ additions: 20, deletions: 10, changedFiles: 2, title: 'Fix parser' }), true);
  assert.equal(isNonTrivial({ additions: 20, deletions: 9, changedFiles: 2, title: 'Fix parser' }), false, '29 lines');
  assert.equal(isNonTrivial({ additions: 200, deletions: 0, changedFiles: 1, title: 'Fix parser' }), false, 'one file');
  assert.equal(isNonTrivial({ additions: 200, deletions: 0, changedFiles: 4, title: 'docs: explain setup' }), false, 'docs by title');
  for (const t of ['Fix typo in README', 'docs: add guide', 'Update documentation for hooks', 'Fixed spelling', '[Docs] contributing', 'fix broken link']) assert.equal(isDocsTitle(t), true, t);
  for (const t of ['Fix scheduler race', 'Add dockerfile support', 'Refactor typography tokens', 'Document picker crashes on iOS']) assert.equal(isDocsTitle(t), false, t);

  const docsOnly = score(mergedIn(3, { title: 'Fix typo', add: 2, del: 2, files: 1 }));
  assert.equal(docsOnly.features.substance.detail.nonTrivial, 0);
  assert.ok(docsOnly.blockers.includes('only docs-size PRs'));
  assert.match(docsOnly.nextStep, /docs \/ typo fixes to a code change in zulip/);
  const solid = score(mergedIn(3, { add: 150, del: 50 }));
  assert.equal(solid.features.substance.value, 1, 'all non-trivial, median 200 lines, three merged');
  assert.equal(score(mergedIn(1, { add: 150, del: 50 })).features.substance.value, 0.5, 'one merged PR is damped to half');
  assert.ok(!solid.blockers.includes('only docs-size PRs'));
});

test('scores: sustained, recency, engagement, track record', () => {
  // merged in 4 different weeks of the window, first PR 60 days before the last activity
  const weekly = ['2026-09-21', '2026-10-05', '2026-10-19', '2026-11-16'].map((d) => pr({ created: ist(d), merged: ist(d, '18:00') }));
  const s = score(weekly);
  assert.equal(s.features.sustained.detail.activeWeeks, 4);
  assert.equal(s.features.sustained.detail.tenureDays, 56);
  assert.equal(s.features.sustained.value, Math.round((0.7 * 0.5 + 0.3 * sat(56, CURVES.tenure)) * 1000) / 1000);
  assert.equal(s.features.recency.value, 1, 'active 3 days ago');
  assert.equal(s.features.recency.detail.daysSinceLast, 2);

  const at = (days) => score([pr({ created: new Date(NOW.getTime() - days * 86400000 - 1000), merged: new Date(NOW.getTime() - days * 86400000) })]).features.recency.value;
  assert.equal(at(14), 1);
  assert.equal(at(45), 0.3);
  assert.equal(at(90), 0);
  assert.ok(at(30) < 1 && at(30) > 0.3, 'decays between 14 and 45 days');

  // 4 merged, 1 closed unmerged, 1 open; 8 reviews+comments per PR
  const set = [...mergedIn(4, { comments: 5, reviews: 3 }), pr({ created: ist('2026-10-10'), closed: ist('2026-10-12'), comments: 5, reviews: 3 }), pr({ created: ist('2026-11-01'), comments: 5, reviews: 3 })];
  const e = score(set).features.engagement;
  assert.deepEqual(e.detail, { interactionsPerPr: 8, merged: 4, decided: 5, mergeRatio: 0.8 });
  assert.equal(e.value, 0.92, '0.6 × 1 + 0.4 × 0.8');

  // track record: merged major-tier open-source PRs anywhere, also outside the program
  const elsewhere = Array.from({ length: 3 }, () => pr({ owner: 'apache', repo: 'airflow', tier: 'major', created: ist('2025-03-01'), merged: ist('2025-03-05') }));
  const t = score([...mergedIn(1), ...elsewhere]);
  assert.equal(t.features.trackRecord.detail.majorMerged, 3);
  assert.equal(t.features.trackRecord.value, 0.6);
  assert.equal(t.prs, 1, 'apache is not a program org: it only feeds the track record');
});

test('scores: weighted sum, points add up to the score, weights are editable', () => {
  const prs = mergedIn(6, { add: 150, del: 50 });
  const s = score(prs);
  const points = Object.values(s.features).reduce((a, f) => a + f.points, 0);
  assert.ok(Math.abs(points - s.score) <= 0.6, `points ${points} vs score ${s.score}`);
  for (const f of Object.values(s.features)) assert.ok(f.value >= 0 && f.value <= 1 && typeof f.explain === 'string' && f.explain);
  // only depth counts → the score is the depth value
  const onlyDepth = score(prs, { weights: { depth: 5, substance: 0, sustained: 0, recency: 0, engagement: 0, breadth: 0, trackRecord: 0 } });
  assert.equal(onlyDepth.score, 85);
  assert.equal(onlyDepth.features.depth.points, 85);
  assert.equal(onlyDepth.features.substance.points, 0);
});

test('scores: bands follow the thresholds, with the two gates (no PR → no signal; no merged PR → never Strong)', () => {
  // eight substantial merged PRs in zulip, one a week from mid-September to mid-November
  const strong = score(Array.from({ length: 8 }, (_, i) => {
    const at = new Date(ist('2026-09-21').getTime() + i * 7 * 86400000);
    return pr({ created: at, merged: new Date(at.getTime() + 2 * 86400000), add: 150, del: 50, comments: 4, reviews: 3 });
  }));
  assert.ok(strong.score >= 60, String(strong.score));
  assert.equal(strong.band, 'strong');
  assert.deepEqual(strong.blockers, []);

  const prs = mergedIn(2);
  const s = score(prs);
  const band = (bands) => scoreProgram(prs, program(), { asOf: NOW, bands }).band;
  assert.equal(band({ strong: s.score, possible: 5, early: 1 }), 'strong', 'score equal to the threshold is in the band');
  assert.equal(band({ strong: s.score + 1, possible: s.score, early: 1 }), 'possible');
  assert.equal(band({ strong: 99, possible: s.score + 1, early: s.score }), 'early');
  assert.equal(band({ strong: 99, possible: 98, early: s.score + 1 }), 'none');

  // a strong track record elsewhere but nothing in a program org: still "no signal" for this program
  const elsewhere = Array.from({ length: 12 }, () => pr({ owner: 'apache', repo: 'airflow', tier: 'major', created: ist('2026-10-01'), merged: ist('2026-10-05') }));
  const none = scoreProgram(elsewhere, program(), { asOf: NOW, bands: { strong: 3, possible: 2, early: 1 } });
  assert.equal(none.score, 10);
  assert.equal(none.band, 'none');
  assert.deepEqual(none.blockers, ['no PR in a GSoC org']);
  assert.match(none.nextStep, /12 merged PRs in major projects/);

  // open PRs only: thresholds would say Strong, the gate says Possible
  const open = Array.from({ length: 5 }, (_, i) => pr({ created: ist(`2026-11-1${i}`), comments: 6, reviews: 4 }));
  const gated = scoreProgram(open, program(), { asOf: NOW, bands: { strong: 5, possible: 3, early: 1 } });
  assert.equal(gated.band, 'possible');
  assert.deepEqual(gated.blockers, ['no merged PR in a GSoC org']);
  assert.match(gated.nextStep, /first PR merged in zulip/);
});

test('scores: blockers — stale activity, spread thin, low merge ratio', () => {
  const stale = score([pr({ created: ist('2026-06-01'), merged: ist('2026-06-10') }), pr({ created: ist('2026-06-02'), merged: ist('2026-06-11') })]);
  assert.ok(stale.blockers.includes('all activity older than 90 days'));
  assert.match(stale.nextStep, /^Restart in zulip/);
  const thin = score([...mergedIn(1), ...mergedIn(1, { owner: 'sugarlabs', repo: 'x' }), ...mergedIn(1, { owner: 'oppia', repo: 'oppia' })]);
  assert.ok(thin.blockers.includes('spread thin: no org with 2 or more merged PRs'));
  const rejected = score([...mergedIn(1), ...Array.from({ length: 4 }, () => pr({ created: ist('2026-10-10'), closed: ist('2026-10-12') }))]);
  assert.ok(rejected.blockers.some((b) => b.startsWith('low merge ratio (1 of 5')));
});

test('scores: which PRs count — program orgs and repos, open source, small repos of a program org, never an admin exclusion', () => {
  const cp = program({ repos: ['processing/p5.js'] });
  const base = { created: ist('2026-10-01') };
  assert.equal(matchesProgram(pr(base), cp), true);
  assert.equal(matchesProgram(pr({ ...base, owner: 'ZULIP' }), cp), true, 'case-insensitive');
  assert.equal(matchesProgram(pr({ ...base, owner: 'processing', repo: 'p5.js' }), cp), true, 'listed repo');
  assert.equal(matchesProgram(pr({ ...base, owner: 'processing', repo: 'other' }), cp), false);
  assert.equal(matchesProgram(pr({ ...base, owner: 'apache', repo: 'airflow' }), cp), false);
  assert.equal(matchesProgram(pr({ ...base, category: 'low_signal', tier: null, reason: 'under 50 stars' }), cp), true, 'a small repo of a program org counts');
  assert.equal(matchesProgram(pr({ ...base, category: 'low_signal', tier: null, reason: 'under 50 stars' }), program({ includeLowStar: false })), false);
  assert.equal(matchesProgram(pr({ ...base, category: 'low_signal', tier: null, reason: 'admin: marked not open source', override: 'not_open_source' }), cp), false);
  assert.equal(matchesProgram(pr({ ...base, category: 'low_signal', tier: null, reason: 'repo is a fork' }), cp), false);
  for (const category of ['practice', 'nst_internal', 'peer_repo', 'own_repo']) assert.equal(matchesProgram(pr({ ...base, category, tier: null }), cp), false, category);
  // match modes
  const major = program({ match: 'major', orgs: [] });
  assert.equal(matchesProgram(pr({ ...base, owner: 'apache', repo: 'airflow', tier: 'major' }), major), true);
  assert.equal(matchesProgram(pr({ ...base, tier: 'established' }), major), false);
  assert.equal(matchesProgram(pr({ ...base, owner: 'anything', repo: 'x', tier: 'emerging' }), program({ match: 'open_source', orgs: [] })), true);
  assert.equal(scoreProgram([pr({ ...base, owner: 'apache', repo: 'airflow', tier: 'major', merged: ist('2026-10-02') })], major, { asOf: NOW, bands: BANDS }).blockers.length, 0);
  assert.deepEqual(scoreProgram([], major, { asOf: NOW, bands: BANDS }).blockers, ['no PR in a major project']);
});

test('scores: the program window is bounded in IST, both ends', () => {
  const after = ist('2027-06-01'); // long after the window: only the window end limits what counts
  const at = (prs, opts = {}) => scoreProgram(prs, program(), { asOf: after, bands: BANDS, tz: 'Asia/Kolkata', ...opts });
  // window.to = 2027-04-08 is inclusive: 23:50 IST that day counts as merged, 00:10 IST the next day does not
  const inside = at([pr({ created: ist('2027-04-01'), merged: ist('2027-04-08', '23:50') })]);
  assert.equal(inside.merged, 1);
  assert.equal(inside.features.depth.detail.mergedInWindow, 1);
  const late = at([pr({ created: ist('2027-04-01'), merged: ist('2027-04-09', '00:10') })]);
  assert.equal(late.prs, 1, 'opened inside the window');
  assert.equal(late.merged, 0, 'merged after the window closed: still open as far as the program is concerned');
  assert.equal(late.evidence[0].state, 'open');
  assert.equal(at([pr({ created: ist('2027-04-09', '00:10'), merged: ist('2027-04-10') })]).prs, 0, 'opened after the window: not counted at all');
  // 23:50 IST on 8 April is 18:20 UTC; a UTC window would also have accepted 00:10 IST on the 9th (18:40 UTC on the 8th)
  assert.equal(scoreProgram([pr({ created: ist('2027-04-01'), merged: ist('2027-04-09', '00:10') })], compileProgram({ ...program(), window: { from: '2026-09-01', to: '2027-04-08' } }, 'UTC'),
    { asOf: after, bands: BANDS, tz: 'UTC' }).merged, 1, 'the same instant is inside a UTC window');

  // window.from = 2026-09-01: merged 31 Aug 23:50 IST is before the window (×0.5), 1 Sep 00:10 IST is inside
  const before = at([pr({ created: ist('2026-08-20'), merged: ist('2026-08-31', '23:50') })]).features.depth.detail;
  assert.deepEqual([before.mergedInWindow, before.mergedBeforeWindow, before.weighted], [0, 1, 0.5]);
  const first = at([pr({ created: ist('2026-08-20'), merged: ist('2026-09-01', '00:10') })]).features.depth.detail;
  assert.deepEqual([first.mergedInWindow, first.mergedBeforeWindow, first.weighted], [1, 0, 1]);

  // "as of": only what had happened by then
  const p = [pr({ created: ist('2026-10-01'), merged: ist('2026-11-10') })];
  assert.equal(scoreProgram(p, program(), { asOf: ist('2026-11-09'), bands: BANDS }).merged, 0);
  assert.equal(scoreProgram(p, program(), { asOf: ist('2026-11-11'), bands: BANDS }).merged, 1);
  assert.equal(scoreProgram(p, program(), { asOf: ist('2026-09-30'), bands: BANDS }).prs, 0);

  // weeks start on Monday in IST: Sunday 23:30 IST and Monday 00:30 IST are different weeks (both are Sunday in UTC)
  assert.equal(weekStartOf(ist('2026-10-04', '23:30'), 'Asia/Kolkata'), '2026-09-28');
  assert.equal(weekStartOf(ist('2026-10-05', '00:30'), 'Asia/Kolkata'), '2026-10-05');
  assert.equal(weekStartOf(ist('2026-10-05', '00:30'), 'UTC'), '2026-09-28');
  const tl = programTimeline([pr({ created: ist('2026-10-04', '23:30'), merged: ist('2026-10-05', '00:30') })], program(), { now: ist('2026-10-20'), tz: 'Asia/Kolkata' });
  assert.equal(tl[0].weekStart, '2026-08-31', 'the week that contains 1 September');
  assert.deepEqual(tl.find((w) => w.weekStart === '2026-09-28'), { weekStart: '2026-09-28', opened: 1, merged: 0 });
  assert.deepEqual(tl.find((w) => w.weekStart === '2026-10-05'), { weekStart: '2026-10-05', opened: 0, merged: 1 });
  assert.equal(tl.at(-1).weekStart, '2026-10-19', 'zero-filled up to the current week');
});

test('scores: one student across programs — prestige is the best prestigious program, trend compares with 30 days ago', () => {
  const compiled = [program(), program({ key: 'lfx', name: 'LFX Mentorship', orgs: ['meshery'] }), program({ key: 'other-major', name: 'Other major projects', match: 'major', orgs: [], prestigious: false })];
  const prs = [
    ...Array.from({ length: 4 }, (_, i) => pr({ created: ist(`2026-11-0${i + 1}`), merged: ist(`2026-11-0${i + 2}`), add: 100, del: 30 })),   // zulip, all in the last 30 days
    ...Array.from({ length: 12 }, () => pr({ owner: 'apache', repo: 'airflow', tier: 'major', created: ist('2026-09-10'), merged: ist('2026-09-12'), add: 200, del: 50 })),
  ];
  const s = scoreStudent(prs, compiled, { now: NOW, bands: BANDS, trendDays: 30, tz: 'Asia/Kolkata' });
  assert.equal(s.bestProgram, 'gsoc');
  assert.equal(s.prestigeScore, s.programs.gsoc.score);
  assert.ok(s.programs['other-major'].score > s.programs.gsoc.score, 'the general signal is higher but is not a prestigious program');
  assert.equal(s.programs.lfx.band, 'none');
  assert.equal(s.programs.gsoc.prevBand, 'none', '30 days ago there was no PR in a GSoC org');
  assert.equal(s.programs.gsoc.delta, s.programs.gsoc.score - s.programs.gsoc.prevScore);
  assert.ok(s.programs.gsoc.delta > 0);
  assert.equal(s.realChance, ['strong', 'possible'].includes(s.programs.gsoc.band));
  assert.equal(s.prevRealChance, false);
  assert.equal(s.lastActivityAt.toISOString(), ist('2026-11-05').toISOString());
  const nothing = scoreStudent([], compiled, { now: NOW, bands: BANDS });
  assert.deepEqual([nothing.prestigeScore, nothing.bestProgram, nothing.bestBand, nothing.realChance, nothing.lastActivityAt], [0, null, 'none', false, null]);
});

// ---------- org mapping ----------

test('org mapping: GitHub logins are read from links; reserved paths and other hosts are ignored', () => {
  assert.deepEqual(githubLoginsIn('https://github.com/zulip/zulip/wiki/GSoC'), ['zulip']);
  assert.deepEqual(githubLoginsIn('see https://www.github.com/orgs/CircuitVerse/discussions and http://github.com/sponsors/someone'), ['CircuitVerse', 'someone']);
  assert.deepEqual(githubLoginsIn('https://geomscale.github.io/gsoc'), ['geomscale']);
  assert.deepEqual(githubLoginsIn('https://raw.githubusercontent.com/aossie-org/ideas/main/x.md'), ['aossie-org']);
  assert.deepEqual(githubLoginsIn('https://github.com/topics/gsoc https://github.com/features https://gist.github.com/abc https://notgithub.com/evil https://docs.github.com/en'), []);
  assert.deepEqual(githubLoginsIn('gsoc@52north.org'), []);
  assert.deepEqual(githubLoginsIn(null), []);
  assert.ok(nameCandidates({ name: 'Machine Learning for Science (ML4SCI)', slug: 'ml4sci-x', website_url: 'https://ml4sci.org/' }).includes('ml4sci'));
  assert.ok(nameCandidates({ name: 'The Apache Software Foundation', slug: 'apache-software-foundation', website_url: 'https://apache.org' }).includes('apache'));
});

test('org mapping: alias beats link beats name; unmatched organisations stay unmapped for manual mapping', () => {
  const aliases = new Map([['jenkins-wp', ['jenkinsci', 'jenkins-infra']]]);
  const known = new Map([['apache', 'apache'], ['openmrs', 'OpenMRS'], ['zulip', 'zulip']]);
  const opts = { program: 'gsoc', year: 2025, knownOwners: known, aliases };
  const alias = mapProgramOrg({ slug: 'jenkins-wp', name: 'Jenkins', website_url: 'https://jenkins.io', ideas_list_url: 'https://github.com/someone-else/ideas' }, opts);
  assert.deepEqual([alias.logins, alias.mappedBy, alias.confidence], [['jenkinsci', 'jenkins-infra'], 'alias', 'high']);

  const link = mapProgramOrg({ slug: 'circuitverseorg', name: 'CircuitVerse.org', website_url: 'http://circuitverse.org/', ideas_list_url: 'https://github.com/CircuitVerse/CircuitVerse/wiki/Ideas',
    contact_links: [{ name: 'chat', value: 'https://circuitverse.org/slack' }, { name: 'blog', value: 'https://github.com/CircuitVerse' }] }, opts);
  assert.deepEqual([link.logins, link.mappedBy, link.confidence], [['circuitverse'], 'link', 'high']);
  assert.deepEqual([link.program, link.year, link.slug, link.name, link.url], ['gsoc', 2025, 'circuitverseorg', 'CircuitVerse.org', 'http://circuitverse.org/']);

  // a single link to an account that does not resemble the organisation's name: kept, but only medium confidence
  const weak = mapProgramOrg({ slug: 'api-dash', name: 'API Dash', website_url: 'https://apidash.dev', ideas_list_url: 'https://github.com/foss42/apidash/discussions/565' }, opts);
  assert.deepEqual([weak.logins, weak.mappedBy, weak.confidence], [['foss42'], 'link', 'medium']);

  const byName = mapProgramOrg({ slug: 'apache-software-foundation', name: 'Apache Software Foundation', website_url: 'https://apache.org' }, opts);
  assert.deepEqual([byName.logins, byName.mappedBy, byName.confidence], [['apache'], 'name', 'medium']);
  assert.deepEqual(mapProgramOrg({ slug: 'openmrs', name: 'OpenMRS', website_url: 'https://openmrs.org/' }, opts).logins, ['openmrs'], 'logins are stored lowercase');

  const none = mapProgramOrg({ slug: 'debian', name: 'Debian', website_url: 'https://debian.org' }, opts);
  assert.deepEqual([none.logins, none.mappedBy, none.confidence], [[], null, null]);
  const all = mapProgramOrgs([{ slug: 'debian', name: 'Debian' }, { slug: 'zulip', name: 'Zulip', website_url: 'https://zulip.com' }], opts);
  assert.deepEqual([all.mapped, all.unmapped, all.logins], [1, 1, ['zulip']]);
});

test('org mapping: the real GSoC 2025 list maps mostly from its own links, and the seed carries the mapped list', { skip: !existsSync('config/gsoc-2025-orgs.raw.json') }, () => {
  const raw = JSON.parse(readFileSync('config/gsoc-2025-orgs.raw.json', 'utf8'));
  assert.equal(raw.length, 185);
  const r = mapProgramOrgs(raw, { program: 'gsoc', year: 2025 }); // no database: aliases + links only
  assert.ok(r.mapped >= 115, `mapped ${r.mapped}`);
  const bySlug = new Map(r.items.map((i) => [i.slug, i]));
  assert.deepEqual(bySlug.get('sugar-labs').logins, ['sugarlabs']);
  assert.deepEqual(bySlug.get('oppia-foundation').logins, ['oppia']);
  assert.deepEqual(bySlug.get('jenkins-wp').logins, ['jenkinsci', 'jenkins-infra']);
  assert.deepEqual(bySlug.get('debian').logins, [], 'no GitHub workflow: left for manual mapping');
  for (const i of r.items) for (const l of i.logins) assert.match(l, /^[a-z\d][a-z\d-]{0,38}$/, `${i.slug}: ${l}`);

  const seed = JSON.parse(readFileSync('config/programs.seed.json', 'utf8'));
  const gsoc = seed.programs.find((p) => p.key === 'gsoc');
  assert.ok(gsoc.orgs.length >= 150 && gsoc.orgs.includes('zulip') && gsoc.orgs.includes('apache'));
  assert.equal(gsoc.orgSource, 'gsoc-2025');
  assert.equal(seed.programOrgs.filter((o) => o.program === 'gsoc' && o.year === 2025).length, 185);
  for (const key of ['outreachy', 'lfx', 'processing', 'sob']) {
    const p = seed.programs.find((x) => x.key === key);
    assert.equal(p.starter, true, `${key} is marked as a starter list`);
    assert.match(p.notes, /^STARTER LIST/);
    assert.ok(p.orgs.length >= 1);
  }
  assert.ok(seed.programs.find((p) => p.key === 'lfx').orgs.includes('meshery'));
  assert.ok(seed.programs.find((p) => p.key === 'processing').repos.includes('processing/p5.js'));
  assert.ok(!JSON.stringify(seed).includes('"selected"'), 'no student outcomes in the repo');
});

test('org mapping: fetch from the GSoC API (mocked), name matching against owners in the database, manual mappings survive a re-run', async () => {
  const db = await freshDb();
  const calls = [];
  const list = [
    { slug: 'zulip', name: 'Zulip', website_url: 'https://zulip.com/', contact_links: [] },
    { slug: 'sugar-labs', name: 'Sugar Labs', website_url: 'https://sugarlabs.org', ideas_list_url: 'https://github.com/sugarlabs/GSoC/blob/master/Ideas-2025.md' },
    { slug: 'debian', name: 'Debian', website_url: 'https://debian.org' },
    { slug: 'ann', name: 'Ann', website_url: 'https://ann.example' },
  ];
  const fake = async (url, init) => { calls.push([url, init.headers.accept]); return { ok: true, status: 200, json: async () => list }; };
  assert.equal(gsocApiUrl(2025, 'http://127.0.0.1:9/api/'), 'http://127.0.0.1:9/api/program/2025/organizations/');
  const orgs = await fetchGsocOrgs(2025, { fetch: fake, base: 'http://gsoc.test/api' });
  assert.deepEqual(calls, [['http://gsoc.test/api/program/2025/organizations/', 'application/json']]);
  await assert.rejects(fetchGsocOrgs(2031, { fetch: async () => ({ ok: false, status: 404 }) }), /answered 404/);
  await assert.rejects(fetchGsocOrgs(2031, { fetch: async () => ({ ok: true, json: async () => [] }) }), /no organisations/);

  const [ann] = await insertStudents(db, [{ username: 'ann' }]);
  await upsertPRs(db, ann, [prNode({ repo: 'zulip/zulip', number: 1 }), prNode({ repo: 'sugarlabs/musicblocks', number: 2, state: 'OPEN' }), prNode({ repo: 'ann/dotfiles', number: 3, ownerType: 'User' })]);
  await refreshAggregates(db);
  const r = await runOrgs({ db, year: 2025, orgs, apply: true, now: NOW });
  assert.deepEqual([r.mapped, r.unmapped], [2, 2], 'a student account is never taken for an organisation, whatever its name');
  assert.deepEqual(r.items.map((i) => [i.slug, i.mappedBy]), [['zulip', 'name'], ['sugar-labs', 'link'], ['debian', null], ['ann', null]]);
  assert.deepEqual(r.logins, ['sugarlabs', 'zulip']);
  assert.deepEqual(r.nst, { prs: 2, openSourcePrs: 2, mergedOpenSourcePrs: 1, students: 1, orgsWithNstPrs: 2 });
  const cfg = await loadPrograms(db);
  const gsoc = cfg.programs.find((p) => p.key === 'gsoc');
  assert.deepEqual([gsoc.orgs, gsoc.orgSource, gsoc.starter], [['sugarlabs', 'zulip'], 'gsoc-2025', false]);
  assert.equal((await db.collection('program_scores').findOne({ _id: 'ann' })).programs.gsoc.prs, 2, '--apply recomputes');

  // the owner maps Debian by hand; fetching the list again keeps that
  await db.collection('program_orgs').updateOne({ _id: 'gsoc:2025:debian' }, { $set: { logins: ['debian-mirror'], mappedBy: 'manual', confidence: 'high' } });
  const again = await runOrgs({ db, year: 2025, orgs, now: NOW });
  assert.deepEqual(again.logins, ['debian-mirror', 'sugarlabs', 'zulip']);
  assert.equal((await db.collection('program_orgs').findOne({ _id: 'gsoc:2025:debian' })).mappedBy, 'manual');
  assert.equal(await db.collection('program_orgs').countDocuments({}), (await db.collection('program_orgs').countDocuments({ program: 'gsoc', year: 2025 })) + (await db.collection('program_orgs').countDocuments({ $nor: [{ program: 'gsoc', year: 2025 }] })));
});

// ---------- programs config ----------

test('programs: defaults, seed on first boot, validation', async () => {
  const d = defaultProgramsDoc(new Date('2026-11-19T00:00:00Z'));
  assert.deepEqual(d.programs.map((p) => p.key), ['gsoc', 'outreachy', 'lfx', 'processing', 'sob', 'mlh', 'other-major']);
  const gsoc = d.programs[0];
  assert.deepEqual([gsoc.name, gsoc.window, gsoc.match, gsoc.prestigious], ['GSoC 2027', { from: '2026-09-01', to: '2027-04-08' }, 'orgs', true]);
  assert.equal(defaultProgramsDoc(new Date('2027-03-01T00:00:00Z')).programs[0].name, 'GSoC 2027');
  assert.equal(defaultProgramsDoc(new Date('2027-07-01T00:00:00Z')).programs[0].name, 'GSoC 2028');
  assert.deepEqual(d.bands, BANDS);
  assert.equal(d.programs.find((p) => p.key === 'other-major').prestigious, false);
  assert.equal(d.programs.find((p) => p.key === 'mlh').match, 'open_source');
  assert.match(d.programs.find((p) => p.key === 'outreachy').eligibilityNote, /eligibility criteria .* cannot see and the app never infers/);
  assert.match(gsoc.eligibilityNote, /18 or older/);
  for (const p of d.programs) assert.ok(Math.abs(Object.values(p.weights).reduce((a, b) => a + b, 0) - 1) < 1e-9, `${p.key} weights sum to 1`);
  assert.ok(!/gender|caste|religion|female|\bmale\b|women/i.test(JSON.stringify(d)), 'no protected attribute anywhere in the program config');

  const db = await freshDb();
  const seeded = await ensurePrograms(db, NOW);
  assert.equal(seeded.programs.length, 7);
  await savePrograms(db, { ...seeded, programs: seeded.programs.map((p) => (p.key === 'gsoc' ? { ...p, notes: 'edited by the owner' } : p)) });
  assert.equal((await ensurePrograms(db, NOW)).programs[0].notes, 'edited by the owner', 'a second boot never overwrites the owner\'s edits');

  const ok = { programs: seeded.programs, bands: BANDS, trendDays: 30, crowdedAt: 5 };
  assert.equal(validatePrograms(ok).error, undefined);
  const bad = (patch, re) => assert.match(validatePrograms({ ...ok, ...patch }).error || '', re);
  const p0 = (patch) => ({ programs: [{ ...seeded.programs[0], ...patch }, ...seeded.programs.slice(1)] });
  bad({ programs: [] }, /between 1 and 20/);
  bad({ programs: 'x' }, /must be a list/);
  bad(p0({ key: 'Bad Key' }), /key .* is invalid/);
  bad(p0({ key: 'lfx' }), /used twice/);
  bad(p0({ name: '' }), /name is required/);
  bad(p0({ match: 'everything' }), /match must be one of/);
  bad(p0({ orgs: ['ok', 'not a login!'] }), /not a valid GitHub login/);
  bad(p0({ repos: ['no-slash'] }), /not a valid owner\/name/);
  bad(p0({ window: { from: '2027-04-08', to: '2026-09-01' } }), /from must be before/);
  bad(p0({ window: { from: 'soon', to: '2026-09-01' } }), /must be dates/);
  bad(p0({ weights: { ...DEFAULT_WEIGHTS, depth: -1 } }), /weight depth/);
  bad(p0({ weights: Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((k) => [k, 0])) }), /at least one weight/);
  bad(p0({ preWindowWeight: 2 }), /preWindowWeight/);
  bad(p0({ enabled: 'yes' }), /enabled must be true or false/);
  bad({ bands: { strong: 50, possible: 50, early: 10 } }, /strong > possible > early/);
  bad({ bands: { strong: 101, possible: 50, early: 10 } }, /100 ≥ strong/);
  bad({ trendDays: 3 }, /trendDays/);
  bad({ crowdedAt: 1 }, /crowdedAt/);
  const cleaned = validatePrograms(p0({ orgs: [' Zulip ', 'https://github.com/SugarLabs/', 'zulip', '@oppia'], repos: ['Processing/p5.js'] })).value.programs[0];
  assert.deepEqual([cleaned.orgs, cleaned.repos], [['Zulip', 'SugarLabs', 'oppia'], ['Processing/p5.js']]);
});

test('owner password: unset, short, placeholder or equal to the admin password keeps the page closed', () => {
  assert.match(ownerProblem({ ownerPassword: '', adminPassword: 'x' }), /OWNER_PASSWORD is unset/);
  assert.equal(ownerProblem({ ownerPassword: 'short-password', adminPassword: 'x' }), '');   // no minimum length (owner's decision)
  assert.match(ownerProblem({ ownerPassword: 'CHANGE-ME-CHANGE-ME-CHANGE-ME', adminPassword: 'x' }), /placeholder/);
  assert.match(ownerProblem({ ownerPassword: 'the very same long password', adminPassword: 'the very same long password' }), /must differ from ADMIN_PASSWORD/);
  assert.equal(ownerProblem({ ownerPassword: OWNER_PASSWORD, adminPassword: TEST_PASSWORD }), '');
});

// ---------- API ----------

/** Cookie jar on top of the single-cookie test helper: admin and owner cookies are separate. */
function session(app) {
  const jar = {};
  const sync = () => app.setCookie(Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '));
  const take = (res) => {
    for (const line of res.headers.getSetCookie?.() || []) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      if (/Max-Age=0/.test(line)) delete jar[pair.slice(0, i)]; else jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
    sync();
    return res;
  };
  return {
    jar,
    login: async () => take(await app.login()),
    unlock: async (password = OWNER_PASSWORD) => take(await app.post('/api/owner/unlock', { password })),
    lock: async () => take(await app.post('/api/owner/lock')),
    only(...names) { for (const k of Object.keys(jar)) if (!names.includes(k)) delete jar[k]; sync(); },
    set(name, value) { jar[name] = value; sync(); },
  };
}

const OWNER_GETS = ['/summary', '/students', '/students/alice', '/orgs', '/programs', '/program-orgs', '/outcomes', '/status', '/export/students.csv', '/past-results'];

/** alice: strong in zulip (GSoC); bob: one open PR in sugarlabs; carol: nothing; dave: inactive. */
async function seedDb(db) {
  await ensurePrograms(db, new Date());
  const cfg = await loadPrograms(db);
  const day = (nAgo, h = 0) => new Date(Date.now() - nAgo * 86400000 + h * 3600000).toISOString();
  const today = new Date();
  const win = { from: new Date(today.getTime() - 150 * 86400000).toISOString().slice(0, 10), to: new Date(today.getTime() + 120 * 86400000).toISOString().slice(0, 10) };
  await savePrograms(db, { ...cfg, programs: cfg.programs.map((p) => ({ ...p, window: win, ...(p.key === 'gsoc' && { orgs: ['zulip', 'sugarlabs', 'oppia'] }) })) });
  const [alice, bob, , dave] = await insertStudents(db, [
    { username: 'Alice', name: 'Alice Anand', campus: 'RU', batch: 2025, email: 'alice@private.example', enrolmentNo: 'ENR-ALICE-001' },
    { username: 'Bob', name: 'Bob B', campus: 'ADYPU', batch: 2026 },
    { username: 'carol', name: 'Carol C', campus: 'RU', batch: 2024 },
    { username: 'dave', name: 'Dave D', campus: 'SVYASA', batch: 2024, active: false },
  ]);
  invalidateContext();
  await upsertPRs(db, alice, [
    ...Array.from({ length: 8 }, (_, i) => prNode({ repo: 'zulip/zulip', number: 100 + i, title: `Fix narrow bug ${i}`, createdAt: day(70 - i * 9), mergedAt: day(70 - i * 9, 20), additions: 120, deletions: 30 })),
    prNode({ repo: 'zulip/zulip-tiny', number: 1, stars: 5, title: 'Small repo fix', createdAt: day(12), mergedAt: day(11), additions: 40, deletions: 5 }),
    prNode({ repo: 'apache/airflow', number: 7, title: 'Scheduler fix', createdAt: day(200), mergedAt: day(198) }),
    prNode({ repo: 'Alice/notes', number: 1, ownerType: 'User', stars: 0, createdAt: day(5), mergedAt: day(5) }),
  ]);
  await upsertPRs(db, bob, [prNode({ repo: 'sugarlabs/musicblocks', number: 5, state: 'OPEN', title: 'Add tempo widget', createdAt: day(3) })]);
  await upsertPRs(db, dave, [prNode({ repo: 'zulip/zulip', number: 900, createdAt: day(10), mergedAt: day(9) })]);
  await collections(db).prs.updateMany({ ownerLc: 'zulip' }, { $set: { changedFiles: 4, comments: 4, reviews: 3 } });
  await refreshAggregates(db);
  return { alice, bob };
}

test('owner access: 401 without the owner cookie even for a logged-in admin; second password, 2 h cookie, lock', async () => {
  const db = await freshDb();
  await seedDb(db);
  await recomputeScores(db);
  let clock = Date.now();
  const app = await startApp(db, { ownerPassword: OWNER_PASSWORD }, { ownerOptions: { now: () => clock } });
  const s = session(app);
  try {
    // nobody
    assert.deepEqual((await app.get('/api/owner/me')).body, { admin: false, configured: true, unlocked: false, expiresAt: null, title: "Krushn's dashboard" });
    for (const p of OWNER_GETS) {
      const r = await app.get(`/api/owner${p}`);
      assert.deepEqual([r.status, r.body?.error?.code, r.body?.error?.reason], [401, 'unauthorized', 'admin'], `${p} without any cookie`);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await app.post('/api/owner/unlock', { password: OWNER_PASSWORD })).body.error.reason, 'admin', 'the second password alone opens nothing');

    // admin only
    await s.login();
    assert.deepEqual((await app.get('/api/owner/me')).body, { admin: true, configured: true, unlocked: false, expiresAt: null, title: "Krushn's dashboard" });
    for (const p of OWNER_GETS) {
      const r = await app.get(`/api/owner${p}`);
      assert.deepEqual([r.status, r.body?.error?.code, r.body?.error?.reason], [401, 'unauthorized', 'owner'], `${p} with only the admin cookie`);
      assert.ok(!/prestigeScore|"score"|"band"/.test(r.text));
    }
    for (const [method, p, body] of [['PUT', '/programs', {}], ['PUT', '/students/alice/note', { note: 'x' }], ['POST', '/recompute', {}], ['POST', '/outcomes', { csv: '' }],
      ['DELETE', '/outcomes', undefined], ['PUT', '/program-orgs/gsoc:2025:zulip', { logins: [] }], ['GET', '/nope', undefined]]) {
      const r = await app.request(method, `/api/owner${p}`, body);
      assert.equal(r.status, 401, `${method} ${p} with only the admin cookie`);
    }
    assert.equal(await db.collection('owner_notes').countDocuments({}), 0);

    // unlocking: CSRF header, wrong password, the admin password is not the owner password
    assert.equal((await app.post('/api/owner/unlock', { password: OWNER_PASSWORD }, { csrf: false })).status, 403);
    for (const password of ['nope', TEST_PASSWORD, '', undefined, 12345, { $ne: '' }]) {
      const r = await app.post('/api/owner/unlock', { password });
      assert.deepEqual([r.status, r.body.error.reason], [401, 'password']);
      assert.equal(r.headers.get('set-cookie'), null);
    }
    const ok = await s.unlock();
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /^oss_owner=[\w-]+\.[\w-]+; Max-Age=7200; Path=\/api\/owner; HttpOnly; SameSite=Strict$/);
    assert.equal(new Date(ok.body.expiresAt).getTime(), clock + OWNER_SESSION_MS);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    const me = (await app.get('/api/owner/me')).body;
    assert.deepEqual([me.unlocked, me.expiresAt], [true, ok.body.expiresAt]);
    for (const p of OWNER_GETS) {
      const r = await app.get(`/api/owner${p}`);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get('cache-control'), 'no-store', p);
      assert.equal(r.headers.get('x-cache'), null, `${p} never goes through the shared cache`);
    }
    assert.equal((await app.get('/api/owner/nope')).status, 404);
    assert.equal((await app.put('/api/owner/students/alice/note', { note: 'x' }, { csrf: false })).status, 403, 'writes need the CSRF header');

    // the owner cookie alone (admin session gone) opens nothing
    const owner = s.jar.oss_owner;
    s.only('oss_owner');
    assert.equal((await app.get('/api/owner/summary')).body.error.reason, 'admin');
    assert.equal((await app.get('/api/owner/me')).body.unlocked, false);
    // an admin cookie is not an owner cookie, and a tampered one is refused
    await s.login();
    s.set('oss_owner', s.jar.oss_admin);
    assert.equal((await app.get('/api/owner/summary')).body.error.reason, 'owner');
    s.set('oss_owner', `${owner.slice(0, -2)}xx`);
    assert.equal((await app.get('/api/owner/summary')).status, 401);
    s.set('oss_owner', owner);
    assert.equal((await app.get('/api/owner/summary')).status, 200);

    // 2 hours
    clock += OWNER_SESSION_MS - 1000;
    assert.equal((await app.get('/api/owner/summary')).status, 200);
    clock += 2000;
    assert.equal((await app.get('/api/owner/summary')).body.error.reason, 'owner', 'expired after 2 hours: ask again');
    assert.equal((await app.get('/api/owner/me')).body.unlocked, false);

    // lock
    await s.unlock();
    assert.equal((await app.get('/api/owner/students')).status, 200);
    const locked = await s.lock();
    assert.match(locked.headers.get('set-cookie'), /^oss_owner=; Max-Age=0; Path=\/api\/owner/);
    assert.equal(s.jar.oss_owner, undefined);
    assert.equal((await app.get('/api/owner/students')).body.error.reason, 'owner');
    assert.equal((await s.lock()).status, 200, 'locking twice is fine');
  } finally {
    await app.close();
  }
});

test('owner access: 503 while OWNER_PASSWORD is unset or weak; 10 wrong passwords lock the visitor out for 15 minutes', async () => {
  const db = await freshDb();
  for (const ownerPassword of ['', TEST_PASSWORD]) {
    const app = await startApp(db, { ownerPassword });
    try {
      await app.login();
      assert.deepEqual((await app.get('/api/owner/me')).body.configured, false);
      assert.deepEqual([(await app.post('/api/owner/unlock', { password: ownerPassword })).status, (await app.get('/api/owner/summary')).status], [503, 503], JSON.stringify(ownerPassword));
    } finally {
      await app.close();
    }
  }
  let clock = Date.now();
  const app = await startApp(db, { ownerPassword: OWNER_PASSWORD }, { ownerOptions: { now: () => clock } });
  const s = session(app);
  try {
    await s.login();
    for (let i = 0; i < 10; i++) assert.equal((await app.post('/api/owner/unlock', { password: `guess ${i}` })).status, 401);
    const limited = await app.post('/api/owner/unlock', { password: OWNER_PASSWORD });
    assert.deepEqual([limited.status, limited.body.error.code], [429, 'rate_limited']);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await app.get('/api/admin/students')).status, 200, 'the admin session is untouched');
    clock += 15 * 60 * 1000 + 1000;
    assert.equal((await s.unlock()).status, 200);
  } finally {
    await app.close();
  }
});

test('owner API: summary, students, detail, notes, org view, CSV — and nothing of it in any public or admin response', async () => {
  const db = await freshDb();
  await seedDb(db);
  const app = await startApp(db, { ownerPassword: OWNER_PASSWORD });
  const s = session(app);
  try {
    await s.login();
    await s.unlock();
    // never computed: the first look queues the computation
    const first = (await app.get('/api/owner/summary')).body;
    assert.deepEqual([first.computedAt, first.stale, first.job.type, first.job.status], [null, true, 'scores', 'queued']);
    await whenIdle(db);
    const sum = (await app.get('/api/owner/summary')).body;
    assert.deepEqual([sum.stale, sum.job, sum.students, sum.trendDays], [false, null, 3, 30]);
    assert.ok(sum.computedAt);
    assert.match(sum.disclaimer, /not a probability/);
    assert.deepEqual(sum.programs.map((p) => p.key), ['gsoc', 'outreachy', 'lfx', 'processing', 'sob', 'mlh', 'other-major']);
    const gsoc = sum.programs[0];
    assert.deepEqual(gsoc.counts, { strong: 1, possible: 0, early: 1, none: 1 });
    assert.equal(gsoc.labelMode, 'readiness');
    assert.equal(gsoc.calibration, null);
    assert.equal(gsoc.activeOrgs, 2);
    assert.match(gsoc.eligibilityNote, /18 or older/);
    for (const p of sum.programs) {
      assert.equal(Object.values(p.counts).reduce((a, b) => a + b, 0), 3, `${p.key}: every active student is in exactly one band`);
      assert.equal(Object.values(p.prevCounts).reduce((a, b) => a + b, 0), 3);
      for (const b of Object.keys(p.counts)) assert.equal(p.delta[b], p.counts[b] - p.prevCounts[b]);
      assert.equal(p.byCampus.reduce((a, g) => a + g.students, 0), 3);
    }
    assert.deepEqual(gsoc.byCampus.map((g) => [g.campus, g.students, g.counts.strong, g.realChance, g.per100, g.smallCohort]), [['ADYPU', 1, 0, 0, 0, true], ['RU', 2, 1, 1, 50, true]]);
    assert.deepEqual(gsoc.byCampusYear.map((g) => [g.campus, g.batch, g.students]), [['ADYPU', 2026, 1], ['RU', 2025, 1], ['RU', 2024, 1]]);
    assert.deepEqual([sum.realChance.count, sum.realChance.per100, sum.realChance.strong], [1, 33.3, 1]);
    assert.equal(sum.realChance.delta, sum.realChance.count - sum.realChance.prevCount);
    assert.deepEqual(sum.byCampus.map((g) => [g.campus, g.realChance, g.per100]), [['ADYPU', 0, 0], ['RU', 1, 50]]);
    const ru = (await app.get('/api/owner/summary?campus=RU&year=2nd%20year')).body;
    assert.deepEqual([ru.students, ru.programs[0].counts.strong, ru.filters.campus], [1, 1, 'RU']);
    assert.equal((await app.get('/api/owner/summary?campus=Mars')).status, 400);

    // table
    const list = (await app.get('/api/owner/students')).body;
    assert.deepEqual([list.total, list.items.map((r) => r.username)], [3, ['Alice', 'Bob', 'carol']]);
    assert.deepEqual(list.programs[0], { key: 'gsoc', name: sum.programs[0].name, prestigious: true });
    const a = list.items[0];
    assert.deepEqual(Object.keys(a), ['username', 'name', 'campus', 'batch', 'year', 'prestigeScore', 'bestProgram', 'bestBand', 'bestOrg', 'realChance', 'lastActivityAt', 'flag', 'hasNote', 'blockers', 'programs']);
    assert.deepEqual(Object.keys(a.programs.gsoc), ['score', 'band', 'bestOrg', 'prevScore', 'delta', 'prevBand', 'mergedInBestOrg', 'prs', 'merged', 'lastActivityAt', 'blockers']);
    assert.deepEqual([a.bestProgram, a.bestBand, a.bestOrg, a.realChance, a.programs.gsoc.mergedInBestOrg, a.programs.gsoc.prs], ['gsoc', 'strong', 'zulip', true, 9, 9]);
    assert.ok(a.prestigeScore >= 60 && a.prestigeScore === a.programs.gsoc.score);
    assert.ok(!('email' in a) && !JSON.stringify(list).includes('ENR-ALICE'));
    const b = list.items[1];
    assert.deepEqual([b.programs.gsoc.band, b.programs.gsoc.bestOrg, b.programs.gsoc.blockers], ['early', 'sugarlabs', ['no merged PR in a GSoC org']]);
    assert.deepEqual([list.items[2].prestigeScore, list.items[2].bestProgram, list.items[2].programs.gsoc.blockers], [0, null, ['no PR in a GSoC org']]);
    const names = async (qs) => (await app.get(`/api/owner/students?${qs}`)).body.items.map((r) => r.username);
    assert.deepEqual(await names('program=gsoc&band=strong,possible'), ['Alice']);
    assert.deepEqual(await names('program=gsoc&band=early'), ['Bob']);
    assert.deepEqual(await names('band=none'), ['carol']);
    assert.deepEqual(await names('program=gsoc&org=SugarLabs'), ['Bob']);
    assert.deepEqual(await names('org=zulip'), ['Alice']);
    assert.deepEqual(await names('campus=RU'), ['Alice', 'carol']);
    assert.deepEqual(await names('year=1st%20year'), ['Bob']);
    assert.deepEqual(await names('realChance=1'), ['Alice']);
    assert.deepEqual(await names('q=bob'), ['Bob']);
    assert.deepEqual(await names('sort=name&order=desc'), ['carol', 'Bob', 'Alice']);
    assert.deepEqual(await names('sort=gsoc&order=asc'), ['carol', 'Bob', 'Alice']);
    assert.deepEqual(await names('limit=1&page=2'), ['Bob']);
    for (const qs of ['band=great', 'program=nope', 'sort=email', 'flag=maybe', 'realChance=yes']) assert.equal((await app.get(`/api/owner/students?${qs}`)).status, 400, qs);

    // detail
    const d = (await app.get('/api/owner/students/ALICE')).body;
    const g = d.student.programs.gsoc;
    assert.deepEqual(Object.keys(g.features), ['depth', 'substance', 'sustained', 'recency', 'engagement', 'breadth', 'trackRecord']);
    assert.deepEqual(Object.keys(g.features.depth), ['value', 'weight', 'points', 'explain', 'detail']);
    assert.equal(g.features.depth.detail.mergedInBestOrg, 9, 'the PR in a 5-star repo of zulip counts for the program');
    assert.equal(g.features.trackRecord.detail.majorMerged, 9, 'zulip/zulip and apache/airflow are major-tier; the 5-star repo and her own repo are not');
    assert.deepEqual(g.orgs.map((o) => [o.login, o.prs, o.merged]), [['zulip', 9, 9]]);
    assert.equal(g.evidence.length, 5);
    assert.deepEqual(Object.keys(g.evidence[0]), ['url', 'title', 'repo', 'state', 'createdAt', 'mergedAt', 'additions', 'deletions', 'changedFiles', 'nonTrivial']);
    assert.match(g.evidence[0].url, /^https:\/\/github\.com\/zulip\/zulip\/pull\/\d+$/);
    assert.ok(typeof g.nextStep === 'string' && g.nextStep.length > 10);
    assert.ok(g.timeline.length >= 20 && g.timeline.reduce((x, w) => x + w.merged, 0) === 9);
    assert.deepEqual(d.note, { note: '', flag: null, updatedAt: null });
    assert.deepEqual(d.outcomes, []);
    assert.equal((await app.get('/api/owner/students/dave')).status, 404, 'inactive students are not scored');
    assert.equal((await app.get('/api/owner/students/nobody')).status, 404);

    // notes and flags (private collection)
    const saved = (await app.put('/api/owner/students/alice/note', { note: '  Wants zulip; met on Monday. ', flag: 'shortlist' })).body.note;
    assert.deepEqual([saved.note, saved.flag], ['Wants zulip; met on Monday.', 'shortlist']);
    assert.deepEqual((await app.put('/api/owner/students/alice/note', { flag: 'watch' })).body.note.note, 'Wants zulip; met on Monday.', 'a flag-only update keeps the note');
    assert.equal((await app.put('/api/owner/students/bob/note', { flag: 'not_applying' })).body.note.note, '');
    assert.equal((await app.put('/api/owner/students/alice/note', { flag: 'star' })).status, 400);
    assert.equal((await app.put('/api/owner/students/alice/note', { note: 'x'.repeat(5001) })).status, 400);
    assert.equal((await app.put('/api/owner/students/alice/note', {})).status, 400);
    assert.equal((await app.put('/api/owner/students/nobody/note', { note: 'x' })).status, 404);
    const flagged = (await app.get('/api/owner/students?flag=watch')).body.items;
    assert.deepEqual(flagged.map((r) => [r.username, r.flag, r.hasNote]), [['Alice', 'watch', true]]);
    assert.deepEqual(await names('flag=none'), ['carol']);
    assert.deepEqual((await app.get('/api/owner/summary')).body.flags, { shortlist: 0, watch: 1, not_applying: 1 });
    assert.equal((await app.get('/api/owner/students/alice')).body.note.flag, 'watch');

    // org view
    const orgs = (await app.get('/api/owner/orgs?program=gsoc')).body;
    assert.deepEqual([orgs.program, orgs.total, orgs.crowdedAt], ['gsoc', 2, 5]);
    assert.deepEqual(orgs.items.map((o) => [o.login, o.students, o.prs, o.merged, o.open, o.bestOrgFor, o.strongOrPossible, o.crowded]), [['zulip', 1, 9, 9, 0, 1, 1, false], ['sugarlabs', 1, 1, 0, 1, 1, 0, false]]);
    assert.deepEqual(orgs.items[0].people.map((p) => [p.username, p.campus, p.band, p.isBestOrg]), [['Alice', 'RU', 'strong', true]]);
    assert.deepEqual(orgs.items[0].campuses, { RU: 1 });
    assert.deepEqual((await app.get('/api/owner/orgs?program=gsoc&campus=ADYPU')).body.items.map((o) => o.login), ['sugarlabs']);
    assert.deepEqual((await app.get('/api/owner/orgs?program=gsoc&q=zul')).body.items.map((o) => o.login), ['zulip']);
    assert.equal((await app.get('/api/owner/orgs?program=gsoc&minStudents=2')).body.total, 0);

    // CSV: private, attachment, same filters
    const csv = await app.get('/api/owner/export/students.csv?program=gsoc&band=strong,early', { raw: true });
    assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(csv.headers.get('cache-control'), 'no-store');
    assert.match(csv.headers.get('content-disposition'), /attachment; filename="program-readiness.csv"/);
    const lines = csv.text.trim().split('\n');
    assert.match(lines[0], /^username,name,campus,batch,year,prestige_score,best_program,best_band,best_org,real_chance,flag,last_activity_at,gsoc_score,gsoc_band,gsoc_best_org,gsoc_delta,.*other_major_delta,blockers$/);
    assert.deepEqual(lines.slice(1).map((l) => l.split(',').slice(0, 3).join(',')), ['Alice,Alice Anand,RU', 'Bob,Bob B,ADYPU']);
    assert.match(lines[1], /,gsoc,strong,zulip,yes,watch,/);

    // ---- nothing private anywhere else ----
    const LEAK = /prestigeScore|prestige_score|realChance|real_chance|bestBand|best_band|nextStep|readiness|program_scores|owner_notes|Wants zulip|shortlist|not_applying|"band"|withSignal|mergedInBestOrg|trackRecord/;
    const PUBLIC = ['/api/meta', '/api/overview', '/api/overview?range=all', '/api/campuses', '/api/campuses?range=all', '/api/students', '/api/students?range=all', '/api/students/alice', '/api/students/alice?range=all',
      '/api/prs?category=all', '/api/repos?category=all', '/api/repos/zulip/zulip', '/api/orgs?category=all', '/api/orgs/zulip', '/api/activity', '/api/activity?author=alice',
      '/api/export/students.csv', '/api/export/prs.csv?category=all', '/api/health', '/api/campuses/RU'];
    const ADMIN = ['/api/admin/me', '/api/admin/students', '/api/admin/students?q=alice', '/api/admin/overrides', '/api/admin/review/repos', '/api/admin/review/owners', '/api/admin/rules',
      '/api/admin/jobs', '/api/admin/schedule', '/api/admin/academic-year', '/api/admin/export/students.csv'];
    const scoresJob = await db.collection('jobs').findOne({ type: 'scores', status: 'done' });
    ADMIN.push(`/api/admin/jobs/${scoresJob._id}`);
    for (const p of [...PUBLIC, ...ADMIN]) {
      const r = await app.get(p, { raw: true });
      if (r.status === 404 && !PUBLIC.slice(0, 4).includes(p)) continue; // endpoint of another addendum that is not there (yet)
      assert.equal(r.status, 200, p);
      assert.ok(!LEAK.test(r.text), `${p} leaks: ${r.text.match(LEAK)?.[0]}`);
    }
    // the job the admin can see says how many students were processed and nothing about the result
    assert.deepEqual(Object.keys(scoresJob.summary).sort(), ['durationMs', 'programs', 'students']);
    assert.ok(!LEAK.test(JSON.stringify(scoresJob)));
    // and the public collections carry no score fields
    for (const name of ['students', 'prs', 'repos', 'owners']) {
      const doc = JSON.stringify(await db.collection(name).find({}).limit(50).toArray());
      assert.ok(!LEAK.test(doc), `${name} documents carry score fields`);
    }
    // logged out: the same public pages, still nothing; and the owner API is closed
    s.only();
    for (const p of PUBLIC.slice(0, 8)) assert.ok(!LEAK.test((await app.get(p, { raw: true })).text), p);
    assert.equal((await app.get('/api/owner/export/students.csv')).status, 401);
  } finally {
    await app.close();
  }
});

test('owner API: programs settings, org list mapping, outcomes + calibration, recompute, staleness', async () => {
  const db = await freshDb();
  await seedDb(db);
  await db.collection('program_orgs').deleteMany({});
  await db.collection('program_orgs').insertMany([
    { _id: 'gsoc:2025:zulip', program: 'gsoc', year: 2025, slug: 'zulip', name: 'Zulip', url: 'https://zulip.com', ideasUrl: '', logins: ['zulip'], mappedBy: 'name', confidence: 'medium' },
    { _id: 'gsoc:2025:debian', program: 'gsoc', year: 2025, slug: 'debian', name: 'Debian', url: 'https://debian.org', ideasUrl: '', logins: [], mappedBy: null, confidence: null },
  ]);
  const app = await startApp(db, { ownerPassword: OWNER_PASSWORD });
  const s = session(app);
  try {
    await s.login();
    await s.unlock();
    await app.get('/api/owner/status');
    await whenIdle(db);
    const status = (await app.get('/api/owner/status')).body;
    assert.deepEqual([status.stale, status.job, status.students, status.last.type, status.last.status], [false, null, 3, 'scores', 'done']);

    // settings
    const cfg = (await app.get('/api/owner/programs')).body;
    assert.deepEqual(cfg.featureKeys, ['depth', 'substance', 'sustained', 'recency', 'engagement', 'breadth', 'trackRecord']);
    assert.deepEqual(Object.keys(cfg.featureHelp), cfg.featureKeys);
    assert.deepEqual(cfg.defaults.bands, BANDS);
    assert.deepEqual(Object.keys(cfg.programs[0]), ['key', 'name', 'enabled', 'prestigious', 'match', 'orgs', 'repos', 'orgSource', 'includeLowStar', 'window', 'preWindowWeight', 'weights', 'notes', 'eligibilityNote', 'starter', 'deadlines']);
    assert.equal((await app.put('/api/owner/programs', { programs: cfg.programs, bands: { strong: 20, possible: 30, early: 10 } })).status, 400);
    assert.equal((await app.get('/api/owner/programs')).body.bands.strong, 60, 'a rejected document changes nothing');
    // raise the bar: Alice is no longer Strong; disable Outreachy
    const put = await app.put('/api/owner/programs', { programs: cfg.programs.map((p) => (p.key === 'outreachy' ? { ...p, enabled: false } : p)), bands: { strong: 99, possible: 98, early: 10 }, trendDays: 14, crowdedAt: 2 });
    assert.equal(put.status, 200);
    assert.deepEqual([put.body.bands.strong, put.body.trendDays, put.body.crowdedAt, put.body.job.type, put.body.job.status], [99, 14, 2, 'scores', 'queued']);
    await whenIdle(db);
    const sum = (await app.get('/api/owner/summary')).body;
    assert.deepEqual(sum.programs.map((p) => p.key), ['gsoc', 'lfx', 'processing', 'sob', 'mlh', 'other-major'], 'a disabled program disappears');
    assert.deepEqual([sum.programs[0].counts, sum.realChance.count, sum.trendDays, sum.stale], [{ strong: 0, possible: 0, early: 2, none: 1 }, 0, 14, false]);
    assert.ok(!('outreachy' in (await app.get('/api/owner/students')).body.items[0].programs));
    await app.put('/api/owner/programs', { programs: cfg.programs, bands: BANDS, trendDays: 30, crowdedAt: 5 });
    await whenIdle(db);

    // org list: Debian is mapped by hand → joins the program's orgs; unmapping removes it again
    const po = (await app.get('/api/owner/program-orgs?program=gsoc')).body;
    assert.deepEqual([po.year, po.years, po.total, po.mapped, po.unmapped], [2025, [2025], 2, 1, 1]);
    assert.deepEqual(po.items.map((i) => [i.id, i.logins, i.mappedBy, i.nstPrs, i.nstStudents]), [['gsoc:2025:debian', [], null, 0, 0], ['gsoc:2025:zulip', ['zulip'], 'name', 9, 1]]);
    assert.deepEqual((await app.get('/api/owner/program-orgs?program=gsoc&mapped=0')).body.items.map((i) => i.slug), ['debian']);
    assert.equal((await app.put('/api/owner/program-orgs/gsoc:2025:debian', { logins: ['not a login'] })).status, 400);
    assert.equal((await app.put('/api/owner/program-orgs/gsoc:2025:nope', { logins: [] })).status, 404);
    const mapped = (await app.put('/api/owner/program-orgs/gsoc:2025:debian', { logins: ['Apache'] })).body;
    assert.deepEqual([mapped.item.logins, mapped.item.mappedBy, mapped.item.nstPrs, mapped.job.type], [['apache'], 'manual', 1, 'scores']);
    await whenIdle(db);
    assert.deepEqual((await loadPrograms(db)).programs[0].orgs, ['zulip', 'sugarlabs', 'oppia', 'apache']);
    assert.deepEqual((await app.get('/api/owner/students/alice')).body.student.programs.gsoc.orgs.map((o) => o.login), ['zulip', 'apache']);
    await app.put('/api/owner/program-orgs/gsoc:2025:debian', { logins: [] });
    await whenIdle(db);
    assert.deepEqual((await loadPrograms(db)).programs[0].orgs, ['zulip', 'sugarlabs', 'oppia']);
    assert.equal((await app.get('/api/owner/students/alice')).body.student.programs.gsoc.prs, 9);

    // outcomes → calibration; the label stays "readiness" until they exist
    assert.deepEqual((await app.get('/api/owner/outcomes')).body, { items: [], total: 0, calibration: {} });
    const year = Number((await loadPrograms(db)).programs[0].window.to.slice(0, 4));
    const up = (await app.post('/api/owner/outcomes', { csv: `username,program,year,org,selected\nalice,gsoc,${year},zulip,yes\nhttps://github.com/Bob/,GSOC,${year},sugarlabs,no\n` +
      `ghost-user,gsoc,${year},,no\n,gsoc,${year},,no\ncarol,nope,${year},,no\ncarol,gsoc,1999,,no\ncarol,gsoc,${year},,maybe\n` })).body;
    assert.deepEqual([up.saved, up.invalid, up.unmatched, up.job.type], [3, 4, 1, 'scores']);
    assert.deepEqual(up.results.map((r) => [r.row, r.status]), [[1, 'saved'], [2, 'saved'], [3, 'saved'], [4, 'invalid'], [5, 'invalid'], [6, 'invalid'], [7, 'invalid']]);
    assert.match(up.results[4].error, /program must be one of gsoc/);
    await whenIdle(db);
    const out = (await app.get(`/api/owner/outcomes?program=gsoc&year=${year}`)).body;
    assert.deepEqual(out.items.map((o) => [o.username, o.selected, o.matched]), [['Bob', false, true], ['alice', true, true], ['ghost-user', false, false]]);
    const cal = out.calibration.gsoc;
    assert.deepEqual([cal.outcomes, cal.matched, cal.selected, cal.years], [3, 2, 1, [year]]);
    assert.deepEqual(cal.byBand.strong, { applicants: 1, selected: 1, rate: 1, smallSample: true });
    assert.deepEqual(cal.byBand.possible, { applicants: 0, selected: 0, rate: null, smallSample: true });
    assert.equal(cal.byBand.strong.applicants + cal.byBand.possible.applicants + cal.byBand.early.applicants + cal.byBand.none.applicants, 2, 'only tracked students are placed in a band');
    const calibrated = (await app.get('/api/owner/summary')).body.programs;
    assert.deepEqual([calibrated[0].labelMode, calibrated[0].calibration.outcomes, calibrated[1].labelMode, calibrated[1].calibration], ['calibrated', 3, 'readiness', null]);
    assert.deepEqual((await app.get('/api/owner/students/alice')).body.outcomes, [{ username: 'alice', program: 'gsoc', year, org: 'zulip', selected: true, matched: true }]);
    // rows: upsert on (username, program, year); replace drops the rest of that program-year
    const again = (await app.post('/api/owner/outcomes', { rows: [{ Username: 'alice', program: 'gsoc', year, org: 'zulip', selected: 'no' }], replace: true })).body;
    assert.deepEqual([again.saved, again.invalid], [1, 0]);
    assert.deepEqual((await app.get('/api/owner/outcomes')).body.items.map((o) => [o.username, o.selected]), [['alice', false]]);
    assert.equal((await app.post('/api/owner/outcomes', { nothing: true })).status, 400);
    const del = (await app.del(`/api/owner/outcomes?program=gsoc&year=${year}`)).body;
    assert.deepEqual([del.ok, del.deleted], [true, 1]);
    await whenIdle(db);
    assert.deepEqual((await app.get('/api/owner/outcomes')).body.calibration, {});
    assert.equal((await app.get('/api/owner/summary')).body.programs[0].labelMode, 'readiness');

    // recompute on demand; a second request while one is waiting is a conflict
    registerHandler('reclassify', async () => { await new Promise((r) => setTimeout(r, 150)); return {}; });
    await app.post('/api/admin/jobs/reclassify', {}); // keeps the runner busy
    const rec = await app.post('/api/owner/recompute', {});
    assert.deepEqual([rec.status, rec.body.job.type, rec.body.job.status], [202, 'scores', 'queued']);
    const dup = await app.post('/api/owner/recompute', {});
    assert.deepEqual([dup.status, dup.body.error.code, dup.body.error.jobId], [409, 'conflict', rec.body.job.id]);
    await whenIdle(db);
    unregisterHandler('reclassify');

    // stale: an admin override after the last computation → the next look recomputes
    assert.equal((await app.get('/api/owner/status')).body.stale, false);
    assert.equal((await app.post('/api/admin/owners/override', { login: 'zulip', override: 'exclude', note: 'test' })).status, 200);
    const stale = (await app.get('/api/owner/status')).body;
    assert.deepEqual([stale.stale, stale.job.type], [true, 'scores']);
    await whenIdle(db);
    assert.equal((await app.get('/api/owner/students/alice')).body.student.programs.gsoc.prs, 0, 'an org the admin excluded no longer counts');
    assert.equal((await app.get('/api/owner/status')).body.stale, false);
  } finally {
    unregisterHandler('reclassify');
    await app.close();
  }
});

test('scores job: recompute is idempotent, follows students, and runs after every fetch', async () => {
  const db = await freshDb();
  const { bob } = await seedDb(db);
  const now = new Date();
  const strip = (docs) => docs.map(({ computedAt, ...d }) => d);
  const one = await recomputeScores(db, { now });
  const first = await db.collection('program_scores').find({}).sort({ _id: 1 }).toArray();
  assert.deepEqual([one.students, one.programs, first.map((d) => d._id)], [3, 7, ['alice', 'bob', 'carol']]);
  assert.deepEqual([one.withSignal, one.realChance], [2, 1]);
  await recomputeScores(db, { now });
  const second = await db.collection('program_scores').find({}).sort({ _id: 1 }).toArray();
  assert.deepEqual(second, first, 'same data, same settings, same moment: identical documents');
  assert.equal(await db.collection('program_scores').countDocuments({}), 3);
  await recomputeScores(db, { now: new Date(now.getTime() + 60000) });
  assert.deepEqual(strip(await db.collection('program_scores').find({}).sort({ _id: 1 }).toArray()).map((d) => d.prestigeScore), strip(first).map((d) => d.prestigeScore));

  // a deactivated student leaves the private collection on the next run; a new one enters
  await collections(db).students.updateOne({ _id: 'bob' }, { $set: { active: false } });
  await insertStudents(db, [{ username: 'erin', campus: 'SMRU', batch: 2026 }]);
  await recomputeScores(db, { now });
  assert.deepEqual((await db.collection('program_scores').find({}).sort({ _id: 1 }).toArray()).map((d) => d._id), ['alice', 'carol', 'erin']);
  await collections(db).students.updateOne({ _id: 'bob' }, { $set: { active: true } });

  // after a fetch: command-line runs recompute at once, the app queues a `scores` job behind the fetch
  registerHandler('sync', async (d) => {
    await upsertPRs(d, bob, [prNode({ repo: 'sugarlabs/musicblocks', number: 6, title: 'Fix tempo widget crash', createdAt: new Date(Date.now() - 86400000).toISOString(), mergedAt: new Date(Date.now() - 3600000).toISOString(), additions: 80, deletions: 20 })]);
    await refreshAggregates(d);
    return { students: 1, ok: 1, failed: 0, prs: 1, renamed: 0, notFound: 0 };
  });
  try {
    assert.equal((await db.collection('program_scores').findOne({ _id: 'bob' })), null);
    const job = await runInline(db, 'sync', {}, { echo: false });
    assert.equal(job.status, 'done');
    const b = await db.collection('program_scores').findOne({ _id: 'bob' });
    assert.deepEqual([b.programs.gsoc.prs, b.programs.gsoc.merged, b.programs.gsoc.bestOrg], [2, 1, 'sugarlabs']);

    await db.collection('program_scores').deleteMany({});
    const app = await startApp(db, { ownerPassword: OWNER_PASSWORD });
    try {
      await app.login();
      assert.equal((await app.post('/api/admin/jobs/sync', {})).status, 202);
      await whenIdle(db);
      const jobs = await db.collection('jobs').find({ runner: 'app' }).sort({ createdAt: 1 }).toArray();
      assert.deepEqual(jobs.map((j) => [j.type, j.status]), [['sync', 'done'], ['scores', 'done']]);
      assert.equal(jobs[1].params.trigger, 'sync');
      assert.equal(await db.collection('program_scores').countDocuments({}), 4);
    } finally {
      await app.close();
    }
    // a failed fetch does not trigger a recompute
    registerHandler('sync', async () => { throw new Error('GitHub is down'); });
    const before = await db.collection('jobs').countDocuments({ type: 'scores' });
    assert.equal((await runInline(db, 'sync', {}, { echo: false })).status, 'error');
    assert.equal(await db.collection('jobs').countDocuments({ type: 'scores' }), before);
  } finally {
    unregisterHandler('sync');
  }
});

// ---------- outcome converter ----------

test('outcome converter: the Proposals tab becomes username,program,year,org,selected', () => {
  const rows = [
    ['Column 19', 'Student', 'Github', 'Org', 'Project', 'Main/Backup', 'Submitted', 'Selected?'],
    [null, 'A One', 'https://github.com/a-one', 'zulip', 'x', 'Main', true, false],
    [null, 'A One', 'https://github.com/A-One/', 'jenkins', 'y', 'Backup', 'True', 'True'],       // second proposal of the same student, selected
    [null, 'B Two', '@b-two', null, null, 'Main', 'TRUE', 'FALSE'],
    [null, 'C Three', 'https://github.com/c-three?tab=repositories', 'oppia', null, 'Main', false, false],   // not submitted
    [null, 'D Four', 'NST Copy', null, null, null, true, false],
    [null, null, null, null, null, null, null, null],
  ];
  const r = proposalsToOutcomes(rows, { year: 2025 });
  assert.deepEqual(r.rows, [
    { username: 'A-One', program: 'gsoc', year: 2025, org: 'jenkins', selected: true },
    { username: 'b-two', program: 'gsoc', year: 2025, org: '', selected: false },
  ]);
  assert.equal(r.skipped.length, 2);
  assert.equal(proposalsToOutcomes(rows, { year: 2025, all: true }).rows.length, 3);
  assert.throws(() => proposalsToOutcomes([['Name', 'Org']], { year: 2025 }), /"Github" and a "Selected\?" column/);
});

test('outcome converter: reads the real workbook without a dependency', { skip: !existsSync('data/GSoC_Mentees.xlsx') }, () => {
  const rows = readSheet('data/GSoC_Mentees.xlsx', 'proposals');
  assert.ok(rows[0].includes('Github') && rows[0].includes('Selected?'));
  const r = proposalsToOutcomes(rows, { year: 2025 });
  assert.ok(r.rows.length >= 10);
  for (const o of r.rows) assert.match(o.username, /^[a-z\d][a-z\d-]{0,38}$/i);
  assert.throws(() => readSheet('data/GSoC_Mentees.xlsx', 'No such tab'), /no tab named/);
});
