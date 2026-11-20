// Private dashboard → Past results: GET /api/owner/past-results (selected vs not-selected applicants of a past round).
// Real mongod; fixtures cover the groups, the org matching (exact, program_orgs, contains, empty, none), the academic
// year and the application deadline bounded in IST, and access (401 without the owner cookie).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo } from './helpers/mongo.js';
import { startApp } from './helpers/app.js';
import { insertStudents, prNode } from './helpers/fixtures.js';
import { ensureIndexes } from '../src/db.js';
import { refreshAggregates, upsertPRs } from '../src/ingest.js';
import { invalidateContext } from '../src/classify.js';
import { ensurePrograms, loadPrograms, validatePrograms } from '../src/programs.js';
import { recomputeScores } from '../src/scores.js';
import { applicantMetrics, monthsBetween, programAcademicYear } from '../src/pastResults.js';

const OWNER_PASSWORD = 'owner page second password';
let mongo;
before(async () => { mongo = await startMongo(); });
after(async () => { await mongo.stop(); });

function session(app) {
  const jar = {};
  const take = (res) => {
    for (const line of res.headers.getSetCookie?.() || []) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      if (/Max-Age=0/.test(line)) delete jar[pair.slice(0, i)]; else jar[pair.slice(0, i)] = pair.slice(i + 1);
    }
    app.setCookie(Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '));
    return res;
  };
  return {
    login: async () => take(await app.login()),
    unlock: async () => take(await app.post('/api/owner/unlock', { password: OWNER_PASSWORD })),
  };
}

const IST = (s) => `${s}+05:30`;

async function seed(db) {
  await ensureIndexes(db);
  invalidateContext();
  await ensurePrograms(db, new Date('2026-11-20T00:00:00Z'));
  const [sel, nots, jen, quiet] = await insertStudents(db, [
    { username: 'Sel', name: 'Selected One', campus: 'ADYPU', batch: 2024 },
    { username: 'Nots', name: 'Not Selected', campus: 'ADYPU', batch: 2024 },
    { username: 'Jen', name: 'Jenkins Fan', campus: 'ADYPU', batch: 2024 },
    { username: 'Quiet', name: 'Quiet Q', campus: 'ADYPU', batch: 2024 },
  ]);
  invalidateContext();
  await upsertPRs(db, sel, [
    // academic year boundaries (AY 2024-25 = 1 Jul 2024 00:00 IST → 1 Jul 2025 00:00 IST)
    prNode({ repo: 'zulip/zulip', number: 1, createdAt: IST('2024-06-30T23:50:00'), mergedAt: IST('2024-06-30T23:55:00'), additions: 1000, deletions: 0 }), // before the AY
    prNode({ repo: 'zulip/zulip', number: 2, createdAt: IST('2024-07-01T00:10:00'), mergedAt: IST('2024-07-02T10:00:00'), additions: 40, deletions: 10 }),
    prNode({ repo: 'zulip/zulip', number: 3, createdAt: IST('2025-04-01T10:00:00'), mergedAt: IST('2025-04-08T23:00:00'), additions: 100, deletions: 20 }), // on deadline day
    prNode({ repo: 'zulip/zulip', number: 4, createdAt: IST('2025-04-02T10:00:00'), mergedAt: IST('2025-04-09T00:30:00'), additions: 60, deletions: 0 }), // just after the deadline
    prNode({ repo: 'zulip/zulip', number: 5, createdAt: IST('2025-06-20T10:00:00'), mergedAt: IST('2025-06-30T23:50:00'), additions: 30, deletions: 0 }), // last minutes of the AY
    prNode({ repo: 'zulip/zulip', number: 6, createdAt: IST('2025-06-25T10:00:00'), mergedAt: IST('2025-07-01T00:10:00'), additions: 20, deletions: 0 }), // merged after the AY
    prNode({ repo: 'Sel/dotfiles', number: 1, ownerType: 'User', stars: 0, createdAt: IST('2024-09-03T10:00:00'), mergedAt: IST('2024-09-03T11:00:00'), additions: 5, deletions: 0 }),
  ]);
  await upsertPRs(db, nots, [
    prNode({ repo: 'sugarlabs/musicblocks', number: 1, state: 'OPEN', createdAt: IST('2025-02-10T10:00:00'), additions: 300, deletions: 10 }),
    prNode({ repo: 'apache/airflow', number: 9, createdAt: IST('2025-01-05T10:00:00'), mergedAt: IST('2025-01-06T10:00:00'), additions: 10, deletions: 0 }),
  ]);
  await upsertPRs(db, jen, [
    prNode({ repo: 'jenkinsci/jenkins', number: 1, createdAt: IST('2024-11-05T10:00:00'), mergedAt: IST('2024-11-06T10:00:00'), additions: 50, deletions: 5 }),
    prNode({ repo: 'jenkins-fan/site', number: 1, ownerType: 'User', stars: 0, createdAt: IST('2024-11-07T10:00:00'), mergedAt: IST('2024-11-07T11:00:00') }),
  ]);
  await refreshAggregates(db);
  await db.collection('program_orgs').deleteMany({});
  await db.collection('program_orgs').insertMany([
    { _id: 'gsoc:2025:sugarlabs', program: 'gsoc', year: 2025, slug: 'sugarlabs', name: 'Sugar Labs', url: '', ideasUrl: '', logins: ['sugarlabs'], mappedBy: 'link', confidence: 'high' },
  ]);
  const ids = { sel: sel._id, nots: nots._id, jen: jen._id, quiet: quiet._id };
  await db.collection('program_outcomes').insertMany([
    { _id: 'sel:gsoc:2025', username: 'Sel', student: ids.sel, program: 'gsoc', year: 2025, org: 'zulip', selected: true, updatedAt: new Date() },
    { _id: 'nots:gsoc:2025', username: 'Nots', student: ids.nots, program: 'gsoc', year: 2025, org: 'Sugar Labs', selected: false, updatedAt: new Date() },
    { _id: 'jen:gsoc:2025', username: 'Jen', student: ids.jen, program: 'gsoc', year: 2025, org: 'jenkins', selected: false, updatedAt: new Date() },
    { _id: 'quiet:gsoc:2025', username: 'Quiet', student: ids.quiet, program: 'gsoc', year: 2025, org: '', selected: false, updatedAt: new Date() },
    { _id: 'ghost:gsoc:2025', username: 'ghost', student: null, program: 'gsoc', year: 2025, org: 'nowhere-at-all', selected: false, updatedAt: new Date() },
    { _id: 'sel:gsoc:2024', username: 'Sel', student: ids.sel, program: 'gsoc', year: 2024, org: 'zulip', selected: false, updatedAt: new Date() },
  ]);
  await recomputeScores(db);
  return ids;
}

test('past results: academic year, months and metrics are bounded in IST', () => {
  assert.deepEqual(programAcademicYear(2025), { label: '2024-25', from: '2024-07-01', to: '2025-06-30' });
  assert.deepEqual(monthsBetween('2024-07-01', '2025-06-30').length, 12);
  assert.deepEqual(monthsBetween('2024-07-01', '2025-06-30').slice(0, 2), ['2024-07', '2024-08']);
  const d = (s) => new Date(IST(s));
  const pr = (created, merged, over = {}) => ({ createdAt: d(created), mergedAt: merged ? d(merged) : null, ownerLc: 'zulip', category: 'open_source', additions: 10, deletions: 0, ...over });
  const months = new Map(monthsBetween('2024-07-01', '2025-06-30').map((k) => [k, { opened: 0, merged: 0, targetMerged: 0 }]));
  const m = applicantMetrics([
    pr('2024-06-30T23:59:00', '2024-07-01T00:01:00'),         // opened before, merged inside (first minute of July in IST)
    pr('2025-06-30T23:59:00', null, { additions: 30 }),          // opened in the last minute
    pr('2025-03-03T10:00:00', '2025-04-08T23:59:00', { ownerLc: 'other', category: 'practice' }),
  ], { start: d('2024-07-01T00:00:00'), end: d('2025-07-01T00:00:00'), deadlineEnd: d('2025-04-09T00:00:00') }, new Set(['zulip']), { tz: 'Asia/Kolkata', months });
  assert.deepEqual([m.opened, m.merged, m.osOpened, m.osMerged, m.targetOpened, m.targetMerged, m.mergedTargetBeforeDeadline], [2, 2, 1, 1, 1, 1, 1]);
  assert.equal(months.get('2024-07').targetMerged, 1, 'merged 00:01 IST on 1 Jul is a July merge, though it is still June in UTC');
  assert.equal(months.get('2025-06').opened, 1);
  assert.equal(m.medianPrSize, 20);
  assert.equal(m.firstTargetPr.beforeAy, true);
});

test('past results: deadlines are validated and GSoC 2025 is seeded', async () => {
  const db = mongo.client.db(`past_seed_${Math.random().toString(16).slice(2, 8)}`);
  await ensurePrograms(db, new Date('2026-11-20T00:00:00Z'));
  const cfg = await loadPrograms(db);
  assert.deepEqual(cfg.programs.find((p) => p.key === 'gsoc').deadlines, { 2025: '2025-04-08' });
  assert.deepEqual(cfg.programs.find((p) => p.key === 'outreachy').deadlines, {});
  const body = (deadlines) => ({ programs: [{ ...cfg.programs[0], deadlines }] });
  assert.deepEqual(validatePrograms(body({ 2026: '2026-03-31' })).value.programs[0].deadlines, { 2026: '2026-03-31' });
  assert.deepEqual(validatePrograms(body({})).value.programs[0].deadlines, {}, 'the owner can clear them');
  assert.match(validatePrograms(body({ 2025: '8 April' })).error, /must be a date/);
  assert.match(validatePrograms(body({ 1999: '1999-04-08' })).error, /2015 to 2035/);
  assert.match(validatePrograms(body(['2025-04-08'])).error, /deadlines must be an object/);
});

test('past results API: groups, org matching, IST boundaries, deadline, monthly series, medians, access', async () => {
  const db = mongo.client.db(`past_${Math.random().toString(16).slice(2, 8)}`);
  await seed(db);
  const app = await startApp(db, { ownerPassword: OWNER_PASSWORD });
  const s = session(app);
  try {
    // access: nobody, then admin only → 401; no-store always
    let r = await app.get('/api/owner/past-results?program=gsoc&year=2025');
    assert.deepEqual([r.status, r.body.error.reason, r.headers.get('cache-control')], [401, 'admin', 'no-store']);
    await s.login();
    r = await app.get('/api/owner/past-results?program=gsoc&year=2025');
    assert.deepEqual([r.status, r.body.error.reason, r.headers.get('cache-control')], [401, 'owner', 'no-store']);
    assert.ok(!/selected|targetMerged/.test(r.text));
    for (const p of ['/api/students/sel', '/api/admin/students?q=sel']) assert.doesNotMatch((await app.get(p)).text, /mergedTargetBeforeDeadline|past-results/);
    await s.unlock();

    r = await app.get('/api/owner/past-results?program=gsoc&year=2025');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const b = r.body;
    assert.deepEqual(b.available, [
      { program: 'gsoc', name: b.program.name, year: 2025, applicants: 5, selected: 1 },
      { program: 'gsoc', name: b.program.name, year: 2024, applicants: 1, selected: 0 },
    ]);
    assert.deepEqual([b.year, b.range.from, b.range.to, b.range.label], [2025, '2024-07-01', '2025-06-30', 'AY 2024-25']);
    assert.deepEqual([b.range.start, b.range.end], ['2024-06-30T18:30:00.000Z', '2025-06-30T18:30:00.000Z']);
    assert.equal(b.applicationDeadline, '2025-04-08');
    assert.deepEqual(b.deadline, { date: '2025-04-08', source: 'settings', end: '2025-04-08T18:30:00.000Z' });
    const cfg = await loadPrograms(db);
    const gsoc = cfg.programs.find((p) => p.key === 'gsoc');
    const shift = 2025 - Number(gsoc.window.to.slice(0, 4));
    assert.equal(b.window.to.slice(0, 4), String(Number(gsoc.window.to.slice(0, 4)) + shift), 'the settings window moved to the 2025 round');
    assert.equal(b.window.to.slice(4), gsoc.window.to.slice(4));
    assert.match(b.note, /descriptive, not predictive/i);

    // groups and counts
    const { selected, notSelected } = b.groups;
    assert.deepEqual([selected.count, selected.matched, notSelected.count, notSelected.matched], [1, 1, 4, 3]);
    const sel = selected.applicants[0];
    assert.deepEqual([sel.username, sel.name, sel.campus, sel.batch, sel.selected, sel.targetOrg], ['Sel', 'Selected One', 'ADYPU', 2024, true, 'zulip']);
    assert.deepEqual(sel.orgMatch, { text: 'zulip', mapping: 'exact', logins: ['zulip'], via: 'zulip' });
    // in the AY: opened #2 #3 #4 #5 #6 + dotfiles = 6; merged #2 #3 #4 #5 + dotfiles = 5 (#1 before, #6 after)
    assert.deepEqual([sel.opened, sel.merged, sel.osOpened, sel.osMerged, sel.targetOpened, sel.targetMerged], [6, 5, 5, 4, 5, 4]);
    assert.equal(sel.mergedTargetBeforeDeadline, 2, '#2 and #3 (23:00 IST on the deadline day); #4 at 00:30 IST the next day is too late');
    assert.equal(sel.firstTargetPr.createdAt, new Date(IST('2024-06-30T23:50:00')).toISOString());
    assert.equal(sel.firstTargetPr.beforeAy, true);
    assert.equal(sel.medianPrSize, 40, 'sizes opened in the AY: 5 20 30 50 60 120');
    assert.deepEqual([sel.activeWeeks, sel.osActiveWeeks], [7, 6]);
    assert.equal(typeof sel.readiness.score, 'number');
    assert.ok(['strong', 'possible', 'early', 'none'].includes(sel.readinessAtDeadline.band));

    assert.deepEqual(notSelected.applicants.map((a) => a.username), ['Jen', 'Nots', 'Quiet', 'ghost'], 'most merged in the target org before the deadline first');
    const [jen, nots, quiet, ghost] = notSelected.applicants;
    assert.deepEqual(nots.orgMatch, { text: 'Sugar Labs', mapping: 'program_orgs', logins: ['sugarlabs'], via: 'Sugar Labs (2025)' });
    assert.deepEqual([nots.opened, nots.merged, nots.osOpened, nots.osMerged, nots.targetOpened, nots.targetMerged, nots.mergedTargetBeforeDeadline, nots.activeWeeks],
      [2, 1, 2, 1, 1, 0, 0, 3]);
    assert.deepEqual(jen.orgMatch, { text: 'jenkins', mapping: 'contains', logins: ['jenkinsci'], via: 'jenkinsci' }, 'contains matches organisations only, not the personal jenkins-fan');
    assert.deepEqual([jen.targetMerged, jen.mergedTargetBeforeDeadline, jen.activeWeeks], [1, 1, 1]);
    assert.deepEqual([quiet.orgMatch.mapping, quiet.opened, quiet.activeWeeks, quiet.medianPrSize, quiet.firstTargetPr], ['empty', 0, 0, null, null]);
    assert.deepEqual([ghost.matched, ghost.orgMatch.mapping, ghost.opened, ghost.readiness], [false, 'none', null, null]);
    assert.deepEqual(b.mappings, { exact: 1, program_orgs: 1, contains: 1, none: 1, empty: 1 });

    // group medians over the tracked applicants of the group
    assert.deepEqual([notSelected.medians.targetMerged, notSelected.medians.mergedTargetBeforeDeadline, notSelected.medians.osMerged, notSelected.medians.activeWeeks], [0, 0, 1, 1]);
    assert.equal(notSelected.medians.medianPrSize, 96.8, 'Nots 160 and Jen 33.5; Quiet has no PR and is left out');
    assert.equal(selected.medians.targetMerged, 4);

    // monthly series: every month of the AY, totals and per tracked applicant
    assert.deepEqual(selected.monthly.map((m) => m.month), monthsBetween('2024-07-01', '2025-06-30'));
    const month = (g, k) => g.monthly.find((m) => m.month === k);
    assert.deepEqual([month(selected, '2024-07').targetMerged, month(selected, '2025-04').targetMerged, month(selected, '2025-06').targetMerged], [1, 2, 1]);
    assert.equal(selected.monthly.reduce((a, m) => a + m.targetMerged, 0), sel.targetMerged);
    assert.deepEqual([month(notSelected, '2024-11').targetMerged, month(notSelected, '2024-11').perApplicant.targetMerged], [1, 0.3]);
    assert.equal(month(notSelected, '2025-02').opened, 1);

    // another round, the default round, a custom range, bad input
    const y24 = (await app.get('/api/owner/past-results?program=gsoc&year=2024')).body;
    assert.deepEqual([y24.range.from, y24.applicationDeadline, y24.deadline.source, y24.groups.selected.count, y24.groups.notSelected.applicants[0].targetMerged],
      ['2023-07-01', null, 'window', 0, 1], 'no deadline stored for 2024: the end of the moved window is used; #1 merged 30 Jun 2024 IST is in AY 2023-24');
    const def = (await app.get('/api/owner/past-results')).body;
    assert.deepEqual([def.program.key, def.year], ['gsoc', 2025], 'newest round with outcomes');
    const custom = (await app.get('/api/owner/past-results?program=gsoc&year=2025&from=2025-04-01&to=2025-04-30')).body;
    assert.deepEqual([custom.range.label, custom.groups.selected.applicants[0].targetMerged, custom.groups.selected.monthly.length], ['Custom range', 2, 1]);
    for (const q of ['program=nope&year=2025', 'program=gsoc&year=1990', 'program=gsoc&year=2025&from=2025-13-01', 'program=gsoc&year=2025&from=2025-05-01&to=2025-04-01']) {
      assert.equal((await app.get(`/api/owner/past-results?${q}`)).status, 400, q);
    }
    await db.collection('program_outcomes').deleteMany({});
    const none = (await app.get('/api/owner/past-results')).body;
    assert.deepEqual([none.available, none.groups], [[], null]);
  } finally {
    await app.close();
  }
});
