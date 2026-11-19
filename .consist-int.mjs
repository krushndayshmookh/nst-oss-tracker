import { MongoClient } from 'mongodb';
import crypto from 'node:crypto';
const B = 'http://127.0.0.1:3311';
const c = await MongoClient.connect('mongodb://127.0.0.1:27717'); const db = c.db('oss_int');
const get = async (p) => (await fetch(B + p, { headers: { 'cache-control': 'no-cache' } })).json();
const errs = []; const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) errs.push(`${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
const CATS = ['open_source', 'practice', 'nst_internal', 'peer_repo', 'own_repo', 'low_signal'];
const ov = await get('/api/overview'); const cp = await get('/api/campuses'); const meta = await get('/api/meta');
const P = db.collection('prs'), St = db.collection('students');
const A = { active: true };
// direct mongo
const m = {
  tracked: await St.countDocuments(A),
  total: await P.countDocuments(A), merged: await P.countDocuments({ ...A, state: 'merged' }),
  osPrs: await P.countDocuments({ ...A, category: 'open_source' }), osMerged: await P.countDocuments({ ...A, category: 'open_source', state: 'merged' }),
  osOpen: await P.countDocuments({ ...A, category: 'open_source', state: 'open' }),
  withAnyPr: (await P.distinct('author', A)).length, withOsPr: (await P.distinct('author', { ...A, category: 'open_source' })).length,
  withOsMerged: (await P.distinct('author', { ...A, category: 'open_source', state: 'merged' })).length,
  withMajorMerged: (await P.distinct('author', { ...A, category: 'open_source', state: 'merged', tier: 'major' })).length,
};
eq(ov.students, { tracked: m.tracked, withAnyPr: m.withAnyPr, withOsPr: m.withOsPr, withOsMerged: m.withOsMerged, withMajorMerged: m.withMajorMerged }, 'overview.students vs mongo');
eq([ov.prs.total, ov.prs.merged, ov.prs.osPrs, ov.prs.osMerged, ov.prs.osOpen], [m.total, m.merged, m.osPrs, m.osMerged, m.osOpen], 'overview.prs vs mongo');
for (const k of CATS) eq(ov.prs.byCategory[k], await P.countDocuments({ ...A, category: k }), 'byCategory ' + k);
for (const k of ['open', 'merged', 'closed']) eq(ov.prs.byState[k], await P.countDocuments({ ...A, state: k }), 'byState ' + k);
for (const k of ['major', 'established', 'emerging']) eq(ov.prs.osMergedByTier[k], await P.countDocuments({ ...A, category: 'open_source', state: 'merged', tier: k }), 'tier ' + k);
eq(Object.values(ov.prs.byCategory).reduce((a, b) => a + b, 0), ov.prs.total, 'sum byCategory = total');
eq(Object.values(ov.prs.byState).reduce((a, b) => a + b, 0), ov.prs.total, 'sum byState = total');
eq(Object.values(ov.prs.osMergedByTier).reduce((a, b) => a + b, 0), ov.prs.osMerged, 'sum tier = osMerged');
// campuses
const NUM = ['students', 'withAnyPr', 'withOsPr', 'withOsMerged', 'withMajorMerged', 'totalPrs', 'osPrs', 'osMerged'];
const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);
for (const k of NUM) { eq(sum(cp.rows, k), cp.total[k], `campus rows sum ${k} = total`); eq(sum(cp.totals, k), cp.total[k], `campus totals sum ${k} = total`); }
for (const k of CATS) eq(sum(cp.rows, 'x') || cp.rows.reduce((a, r) => a + r.byCategory[k], 0), cp.total.byCategory[k], 'campus byCategory ' + k);
for (const t of cp.totals) for (const k of NUM) eq(sum(cp.rows.filter((r) => r.campus === t.campus), k), t[k], `campus ${t.campus} ${k}`);
eq([cp.total.students, cp.total.withAnyPr, cp.total.withOsPr, cp.total.withOsMerged, cp.total.withMajorMerged, cp.total.totalPrs, cp.total.osPrs, cp.total.osMerged],
   [ov.students.tracked, ov.students.withAnyPr, ov.students.withOsPr, ov.students.withOsMerged, ov.students.withMajorMerged, ov.prs.total, ov.prs.osPrs, ov.prs.osMerged], 'campuses.total vs overview');
eq(cp.total.byCategory, ov.prs.byCategory, 'campuses.total.byCategory vs overview');
for (const t of cp.totals) { const o = await get('/api/overview?campus=' + t.campus); eq([o.students.tracked, o.students.withOsMerged, o.prs.total, o.prs.osMerged], [t.students, t.withOsMerged, t.totalPrs, t.osMerged], 'overview?campus=' + t.campus); }
eq(meta.counts, { students: m.tracked, prs: m.total }, 'meta.counts');
// stored aggregates vs prs
const ss = await St.aggregate([{ $match: A }, { $group: { _id: null, t: { $sum: '$stats.totalPrs' }, m: { $sum: '$stats.mergedPrs' }, o: { $sum: '$stats.osPrs' }, om: { $sum: '$stats.osMerged' }, w: { $sum: { $cond: [{ $gt: ['$stats.osMerged', 0] }, 1, 0] } } } }]).next();
eq([ss.t, ss.m, ss.o, ss.om, ss.w], [m.total, m.merged, m.osPrs, m.osMerged, m.withOsMerged], 'sum students.stats vs prs');
const rs = await db.collection('repos').aggregate([{ $group: { _id: null, p: { $sum: '$stats.prs' }, m: { $sum: '$stats.merged' } } }]).next();
eq([rs.p, rs.m], [m.total, m.merged], 'sum repos.stats vs prs');
const os = await db.collection('owners').aggregate([{ $group: { _id: null, p: { $sum: '$stats.prs' }, o: { $sum: '$stats.osPrs' }, om: { $sum: '$stats.osMerged' } } }]).next();
eq([os.p, os.o, os.om], [m.total, m.osPrs, m.osMerged], 'sum owners.stats vs prs');
eq((await get('/api/students?limit=1')).total, m.tracked, 'students list total');
eq((await get('/api/students?limit=1&hasOs=1')).total, m.withOsPr, 'students hasOs total');
eq((await get('/api/prs?limit=1')).total, m.osPrs, 'prs default total');
eq((await get('/api/prs?limit=1&category=all')).total, m.total, 'prs all total');
eq((await get('/api/prs?limit=1&state=merged')).total, m.osMerged, 'prs os merged total');
eq(sum(ov.monthly, 'x') || 0, 0, 'noop');
// fingerprint of every derived value
const h = crypto.createHash('sha256');
for await (const d of P.find({}, { projection: { category: 1, tier: 1, reason: 1, override: 1, active: 1, campus: 1, batch: 1 } }).sort({ _id: 1 })) h.update(JSON.stringify(d));
for await (const d of St.find({}, { projection: { stats: 1, active: 1 } }).sort({ _id: 1 })) h.update(JSON.stringify(d));
for await (const d of db.collection('repos').find({}, { projection: { stats: 1, category: 1, tier: 1, reason: 1, override: 1 } }).sort({ _id: 1 })) h.update(JSON.stringify(d));
for await (const d of db.collection('owners').find({}, { projection: { stats: 1, override: 1 } }).sort({ _id: 1 })) h.update(JSON.stringify(d));
console.log(JSON.stringify({ students: ov.students, prs: { total: m.total, merged: m.merged, osPrs: m.osPrs, osMerged: m.osMerged, osOpen: m.osOpen }, byCategory: ov.prs.byCategory, tier: ov.prs.osMergedByTier, repos: await db.collection('repos').countDocuments(), owners: await db.collection('owners').countDocuments() }));
console.log('fingerprint', h.digest('hex').slice(0, 16), errs.length ? 'ERRORS:\n' + errs.join('\n') : 'ALL CONSISTENT');
await c.close();
