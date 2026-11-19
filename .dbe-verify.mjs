// throwaway independent cross-check: plain JS over raw files + prs docs (category/tier/active only from Mongo), no aggregation
import fs from 'node:fs';
import { MongoClient } from 'mongodb';
const BASE = process.env.BASE || 'http://127.0.0.1:38411';
const client = new MongoClient('mongodb://127.0.0.1:27811'); await client.connect();
const db = client.db('dbe');
const IST = 5.5 * 3600e3;
const get = async (p) => { const r = await fetch(BASE + p); if (r.status !== 200) throw new Error(p + ' ' + r.status + ' ' + await r.text()); return r.json(); };
let fails = 0, checks = 0;
const eq = (a, b, what) => { checks++; const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) { fails++; console.log('MISMATCH', what, '\n  api :', x.slice(0, 400), '\n  mine:', y.slice(0, 400)); } };

// students from csv ids -> from mongo (campus/batch/active), PR dates from RAW files
const students = await db.collection('students').find({}).toArray();
const sById = new Map(students.map((s) => [s._id, s]));
const cls = new Map(); // url -> {category,tier,active,state}
for await (const p of db.collection('prs').find({}, { projection: { category: 1, tier: 1, active: 1, state: 1, repoLc: 1, ownerLc: 1, campus: 1, batch: 1, createdAt: 1, mergedAt: 1, author: 1 } })) cls.set(p._id, p);
const prs = [];
let rawCount = 0, dateMismatch = 0, missing = 0, cohortMismatch = 0, mergedNoState = 0;
for (const f of fs.readdirSync('data/raw')) {
  const id = f.slice(0, -5).toLowerCase();
  const data = JSON.parse(fs.readFileSync('data/raw/' + f, 'utf8'));
  for (const n of data.prs || []) {
    if (n.repository?.isPrivate) continue;
    rawCount++;
    const doc = [...[cls.get(n.url), cls.get(n.url.toLowerCase())]].find(Boolean);
    if (!doc) { missing++; continue; }
    const created = Date.parse(n.createdAt), merged = n.mergedAt ? Date.parse(n.mergedAt) : null;
    if (doc.createdAt.getTime() !== created || (doc.mergedAt?.getTime() ?? null) !== merged || doc.author !== id) dateMismatch++;
    const s = sById.get(id);
    if (doc.campus !== s.campus || (doc.batch ?? null) !== (s.batch ?? null)) cohortMismatch++;
    const state = n.state.toLowerCase();
    if ((merged !== null) !== (state === 'merged')) mergedNoState++;
    if (!doc.active) continue;
    const [owner, name] = n.repository.nameWithOwner.toLowerCase().split('/');
    prs.push({ author: id, created, merged, state, category: doc.category, tier: doc.tier, repo: `${owner}/${name}`, owner, campus: s.campus, batch: s.batch });
  }
}
console.log({ rawCount, inMongo: cls.size, missing, dateMismatch, cohortMismatch, mergedNoState, active: prs.length });

const ymd = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
const hourOf = (ms) => new Date(ms + IST).getUTCHours();
const dowOf = (ms) => new Date(ms + IST).getUTCDay() || 7;
const meta = await get('/api/meta');
const preset = Object.fromEntries(meta.presets.map((p) => [p.key, p]));
const ranges = [['', preset.ay], ['range=90d', preset['90d']], ['range=all', preset.all], ['range=ay-2025-26', preset['ay-2025-26']], ['from=2026-10-01&to=2026-10-31', { from: '2026-10-01', to: '2026-10-31' }]];
const CATS = meta.categories;

for (const [qs, r] of ranges) {
  const lo = r.from ? Date.parse(r.from + 'T00:00:00+05:30') : -Infinity;
  const hi = r.to ? Date.parse(r.to + 'T00:00:00+05:30') + 86400e3 : Infinity;
  const inR = (t) => t !== null && t >= lo && t < hi;
  const q = (extra = '') => [qs, extra].filter(Boolean).join('&');
  console.log(`\n=== range "${qs || '(default)'}" ${r.from}..${r.to}`);
  // per-student
  const per = new Map();
  const blank = () => ({ totalPrs: 0, mergedPrs: 0, osPrs: 0, osMerged: 0, osOpen: 0, osMajorMerged: 0, repos: new Set(), orgs: new Set(), byCategory: Object.fromEntries(CATS.map((c) => [c, 0])) });
  const ov = { total: 0, merged: 0, osPrs: 0, osMerged: 0, osOpen: 0, byCategory: Object.fromEntries(CATS.map((c) => [c, 0])), byState: { open: 0, merged: 0, closed: 0 }, osMergedByTier: { major: 0, established: 0, emerging: 0 } };
  const act = { all: { opened: 0, merged: 0, st: new Set(), months: {}, dates: {}, wd: {}, hr: {}, cell: {}, cm: {} }, os: { opened: 0, merged: 0, st: new Set(), months: {}, dates: {}, wd: {}, hr: {}, cell: {}, cm: {} } };
  const repoS = new Map(), orgS = new Map();
  const bump = (o, k, f) => { (o[k] ||= { opened: 0, merged: 0 })[f]++; };
  for (const p of prs) {
    const o = inR(p.created), m = inR(p.merged);
    if (!o && !m) continue;
    const os = p.category === 'open_source';
    let s = per.get(p.author); if (!s) per.set(p.author, s = blank());
    let rp = repoS.get(p.repo); if (!rp) repoS.set(p.repo, rp = { prs: 0, merged: 0, open: 0, closed: 0, st: new Set() });
    let og = orgS.get(p.owner); if (!og) orgS.set(p.owner, og = { prs: 0, merged: 0, osPrs: 0, osMerged: 0, st: new Set(), repos: new Set() });
    rp.st.add(p.author); og.st.add(p.author); og.repos.add(p.repo);
    if (o) { s.totalPrs++; s.byCategory[p.category]++; ov.total++; ov.byCategory[p.category]++; ov.byState[p.state]++; rp.prs++; og.prs++; if (p.state === 'open') rp.open++; if (p.state === 'closed') rp.closed++; }
    if (m) { s.mergedPrs++; ov.merged++; rp.merged++; og.merged++; }
    if (os) {
      s.repos.add(p.repo); s.orgs.add(p.owner);
      if (o) { s.osPrs++; ov.osPrs++; og.osPrs++; if (p.state === 'open') { s.osOpen++; ov.osOpen++; } }
      if (m) { s.osMerged++; ov.osMerged++; og.osMerged++; ov.osMergedByTier[p.tier]++; if (p.tier === 'major') s.osMajorMerged++; }
    }
    for (const [k, a] of [['all', act.all], ...(os ? [['os', act.os]] : [])]) {
      for (const [f, t, on] of [['opened', p.created, o], ['merged', p.merged, m]]) {
        if (!on) continue;
        a[f]++; a.st.add(p.author);
        const d = ymd(t);
        bump(a.months, d.slice(0, 7), f); bump(a.dates, d, f); bump(a.wd, dowOf(t), f); bump(a.hr, hourOf(t), f); bump(a.cell, `${dowOf(t)}-${hourOf(t)}`, f); bump(a.cm, `${p.campus}|${d.slice(0, 7)}`, f);
      }
    }
  }
  const stu = { tracked: 0, withAnyPr: 0, withOsPr: 0, withOsMerged: 0, withMajorMerged: 0 };
  for (const s of students) { if (s.active === false) continue; stu.tracked++; const x = per.get(s._id); if (!x) continue;
    if (x.totalPrs || x.mergedPrs) stu.withAnyPr++; if (x.osPrs || x.osMerged) stu.withOsPr++; if (x.osMerged) stu.withOsMerged++; if (x.osMajorMerged) stu.withMajorMerged++; }
  console.log('mine headline', JSON.stringify({ students: stu, total: ov.total, merged: ov.merged, osPrs: ov.osPrs, osMerged: ov.osMerged }));

  const o = await get('/api/overview?' + q());
  eq(o.students, stu, 'overview.students');
  eq(o.prs, ov, 'overview.prs');
  // overview monthly vs mine
  eq(o.monthly.reduce((a, m) => a + m.allOpened, 0) , r.from ? ov.total : o.monthly.reduce((a, m) => a + (act.all.months[m.month]?.opened || 0), 0), 'overview.monthly sum allOpened');
  for (const m of o.monthly) eq([m.month, m.osOpened, m.osMerged, m.allOpened], [m.month, act.os.months[m.month]?.opened || 0, act.os.months[m.month]?.merged || 0, act.all.months[m.month]?.opened || 0], 'overview.monthly ' + m.month);
  eq(o.topStudents.map((s) => s.stats.osMerged), [...per.values()].map((s) => s.osMerged).sort((a, b) => b - a).slice(0, 10).filter(Boolean), 'topStudents osMerged');

  for (const [cat, a] of [['all', act.all], ['open_source', act.os]]) {
    const A = await get('/api/activity?' + q('category=' + cat));
    eq(A.totals, { opened: a.opened, merged: a.merged, activeStudents: a.st.size }, `activity(${cat}).totals`);
    eq([A.byMonth.reduce((s, m) => s + m.opened, 0), A.byMonth.reduce((s, m) => s + m.merged, 0)], [a.opened, a.merged], `activity(${cat}) sum byMonth = totals`);
    eq([A.byWeek.reduce((s, m) => s + m.opened, 0), A.byWeek.reduce((s, m) => s + m.merged, 0)], [a.opened, a.merged], `activity(${cat}) sum byWeek`);
    eq([A.byWeekday.reduce((s, m) => s + m.opened, 0), A.byHour.reduce((s, m) => s + m.merged, 0), A.heatmap.reduce((s, m) => s + m.opened, 0), A.byCampusMonth.reduce((s, m) => s + m.merged, 0)], [a.opened, a.merged, a.opened, a.merged], `activity(${cat}) sums`);
    if (A.byDate) eq([A.byDate.reduce((s, m) => s + m.opened, 0), A.byDate.reduce((s, m) => s + m.merged, 0)], [a.opened, a.merged], `activity(${cat}) sum byDate`); else console.log('  byDate omitted, truncated =', A.truncated);
    for (const m of A.byMonth) eq([m.opened, m.merged], [a.months[m.month]?.opened || 0, a.months[m.month]?.merged || 0], `activity(${cat}).byMonth ${m.month}`);
    for (const d of A.byDate || []) eq([d.opened, d.merged], [a.dates[d.date]?.opened || 0, a.dates[d.date]?.merged || 0], `byDate ${d.date}`);
    for (const d of A.byWeekday) eq([d.opened, d.merged], [a.wd[d.dow]?.opened || 0, a.wd[d.dow]?.merged || 0], `byWeekday ${d.dow}`);
    for (const d of A.byHour) eq([d.opened, d.merged], [a.hr[d.hour]?.opened || 0, a.hr[d.hour]?.merged || 0], `byHour ${d.hour}`);
    for (const d of A.heatmap) eq([d.opened, d.merged], [a.cell[`${d.dow}-${d.hour}`]?.opened || 0, a.cell[`${d.dow}-${d.hour}`]?.merged || 0], `heatmap ${d.dow}-${d.hour}`);
    eq(A.byCampusMonth.length, Object.keys(a.cm).length, 'byCampusMonth rows');
    for (const d of A.byCampusMonth) eq([d.opened, d.merged], [a.cm[`${d.campus}|${d.month}`]?.opened, a.cm[`${d.campus}|${d.month}`]?.merged], `byCampusMonth ${d.campus} ${d.month}`);
    const bd = Object.entries(a.dates).sort((x, y) => y[1].opened - x[1].opened || (x[0] < y[0] ? -1 : 1))[0];
    eq(A.busiest.day, bd && bd[1].opened ? { date: bd[0], count: bd[1].opened } : null, `busiest day (${cat})`);
    if (cat === 'open_source') { eq([A.totals.opened, A.totals.merged], [o.prs.osPrs, o.prs.osMerged], 'activity(os).totals = overview os'); console.log('  api os', JSON.stringify(A.totals), 'months', A.byMonth.length, 'days', A.byDate?.length, 'weeks', A.byWeek.length, 'busiest', JSON.stringify(A.busiest)); }
    else eq([A.totals.opened, A.totals.merged], [o.prs.total, o.prs.merged], 'activity(all).totals = overview');
  }
  // campuses
  const cp = await get('/api/campuses?' + q());
  eq([cp.total.students, cp.total.withAnyPr, cp.total.withOsPr, cp.total.withOsMerged, cp.total.withMajorMerged, cp.total.totalPrs, cp.total.osPrs, cp.total.osMerged], [stu.tracked, stu.withAnyPr, stu.withOsPr, stu.withOsMerged, stu.withMajorMerged, ov.total, ov.osPrs, ov.osMerged], 'campuses.total');
  eq(cp.rows.reduce((s, x) => s + x.osMerged, 0), ov.osMerged, 'campus rows sum');
  // students: all pages
  let seen = 0, prev = Infinity;
  for (let page = 1; ; page++) {
    const L = await get('/api/students?' + q(`limit=100&page=${page}`));
    for (const s of L.items) {
      seen++;
      const x = per.get(s.username.toLowerCase()) || blank();
      eq([s.stats.totalPrs, s.stats.mergedPrs, s.stats.osPrs, s.stats.osMerged, s.stats.osOpen, s.stats.osMajorMerged, s.stats.osRepos, s.stats.osOrgs, s.stats.byCategory],
        [x.totalPrs, x.mergedPrs, x.osPrs, x.osMerged, x.osOpen, x.osMajorMerged, x.repos.size, x.orgs.size, x.byCategory], 'student ' + s.username);
      if (s.stats.osMerged > prev) eq('sorted', 'not sorted', 'students order at ' + s.username);
      prev = s.stats.osMerged;
    }
    if (page * 100 >= L.total) { eq([L.total, seen], [stu.tracked, stu.tracked], 'students total'); break; }
  }
  // repos + orgs category=all, all pages
  for (const [path, mine, cmp] of [['repos', repoS, (it, x) => [[it.stats.prs, it.stats.merged, it.stats.open, it.stats.closed, it.stats.students], [x.prs, x.merged, x.open, x.closed, x.st.size]]],
    ['orgs', orgS, (it, x) => [[it.stats.prs, it.stats.merged, it.stats.osPrs, it.stats.osMerged, it.stats.students, it.stats.repos], [x.prs, x.merged, x.osPrs, x.osMerged, x.st.size, x.repos.size]]]]) {
    let n = 0;
    for (let page = 1; ; page++) {
      const L = await get(`/api/${path}?` + q(`category=all&limit=100&page=${page}`));
      for (const it of L.items) { n++; const x = mine.get((it.name || it.login).toLowerCase()); if (!x) { eq(it.name || it.login, null, path + ' unknown item'); continue; } const [a, b] = cmp(it, x); eq(a, b, `${path} ${it.name || it.login}`); }
      if (page * 100 >= L.total) { eq([L.total, n], [mine.size, mine.size], path + ' total'); break; }
    }
  }
  // prs list totals
  eq((await get('/api/prs?' + q('category=all&limit=1'))).total, prs.filter((p) => inR(p.created) || inR(p.merged)).length, 'prs total (opened or merged)');
  eq((await get('/api/prs?' + q('category=all&state=merged&limit=1'))).total, prs.filter((p) => p.state === 'merged' && inR(p.merged)).length, 'prs merged total');
  eq((await get('/api/prs?' + q('limit=1'))).total, prs.filter((p) => p.category === 'open_source' && (inR(p.created) || inR(p.merged))).length, 'prs os total');
  // csv exports
  const csvS = (await (await fetch(BASE + '/api/export/students.csv?' + q())).text()).trim().split('\n');
  eq(csvS.length - 1, stu.tracked, 'students.csv rows');
  const h = csvS[0].split(','); const iOs = h.indexOf('os_merged'), iT = h.indexOf('total_prs');
  let sOs = 0, sT = 0; for (const l of csvS.slice(1)) { const c = l.split(','); sOs += Number(c.at(iOs - h.length)); sT += Number(c.at(iT - h.length)); }
  eq([sOs, sT], [ov.osMerged, ov.total], 'students.csv sums (os_merged,total_prs)');
  const csvP = (await (await fetch(BASE + '/api/export/prs.csv?' + q('category=all'))).text()).trim().split('\n');
  console.log('  prs.csv lines', csvP.length - 1, '(may exceed PR count when titles hold newlines)');
}
console.log(`\n${checks} checks, ${fails} mismatches`);
await client.close();
