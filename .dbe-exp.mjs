import { MongoClient } from 'mongodb';
const client = new MongoClient('mongodb://127.0.0.1:27811'); await client.connect();
const prs = client.db('dbe').collection('prs');
const tz = 'Asia/Kolkata';
const time = async (name, fn) => { const ts = []; let r; for (let i = 0; i < 4; i++) { const t = performance.now(); r = await fn(); ts.push(Math.round(performance.now() - t)); } console.log(name, ts.join('/'), 'rows', Array.isArray(r) ? r.length : r); };
await time('current', () => prs.aggregate([
  { $match: { active: true } },
  { $project: { author: 1, campus: 1, ev: [{ t: 'o', d: '$createdAt' }, { t: 'm', d: '$mergedAt' }] } },
  { $unwind: '$ev' }, { $match: { 'ev.d': { $type: 'date' } } },
  { $group: { _id: { t: '$ev.t', h: { $dateToString: { date: '$ev.d', format: '%Y-%m-%dT%H', timezone: tz } }, u: { $dateToString: { date: '$ev.d', format: '%u', timezone: tz } }, c: '$campus' }, n: { $sum: 1 }, authors: { $addToSet: '$author' } } },
]).toArray());
const one = (field, extra = {}) => prs.aggregate([
  { $match: { active: true, ...extra } },
  { $group: { _id: { h: { $dateToString: { date: `$${field}`, format: '%Y-%m-%dT%H', timezone: tz } }, c: '$campus' }, n: { $sum: 1 } } },
]).toArray();
await time('two groups no authors', async () => (await Promise.all([one('createdAt'), one('mergedAt', { mergedAt: { $type: 'date' } })])).flat());
const oneT = (field, extra = {}) => prs.aggregate([
  { $match: { active: true, ...extra } },
  { $group: { _id: { h: { $dateTrunc: { date: `$${field}`, unit: 'hour' } }, c: '$campus' }, n: { $sum: 1 } } },
]).toArray();
await time('two groups dateTrunc hour (UTC)', async () => (await Promise.all([oneT('createdAt'), oneT('mergedAt', { mergedAt: { $type: 'date' } })])).flat());
const au = (field, extra = {}) => prs.aggregate([
  { $match: { active: true, ...extra } },
  { $group: { _id: { m: { $dateToString: { date: `$${field}`, format: '%Y-%m', timezone: tz } }, a: '$author' } } },
]).toArray();
await time('month-author pairs x2', async () => (await Promise.all([au('createdAt'), au('mergedAt', { mergedAt: { $type: 'date' } })])).flat());
const both = (field, extra = {}) => prs.aggregate([
  { $match: { active: true, ...extra } },
  { $group: { _id: { h: { $dateTrunc: { date: `$${field}`, unit: 'hour' } }, c: '$campus', a: '$author' }, n: { $sum: 1 } } },
]).toArray();
await time('hour+campus+author x2 (trunc)', async () => (await Promise.all([both('createdAt'), both('mergedAt', { mergedAt: { $type: 'date' } })])).flat());
const raw = () => prs.find({ active: true }, { projection: { _id: 0, author: 1, campus: 1, createdAt: 1, mergedAt: 1 } }).toArray();
await time('plain find + JS', raw);
await time('find raw batch', async () => { let n = 0; for await (const d of prs.find({ active: true }, { projection: { _id: 0, author: 1, campus: 1, createdAt: 1, mergedAt: 1 }, batchSize: 20000 })) n++; return n; });
await client.close();
