import { MongoClient } from 'mongodb';
const BASE = 'http://127.0.0.1:38411';
const client = new MongoClient('mongodb://127.0.0.1:27811'); await client.connect();
const db = client.db('dbe');
const get = async (p) => { const r = await fetch(BASE + p); if (r.status !== 200) throw new Error(p + ' ' + r.status + ' ' + await r.text()); return r.json(); };
let fails = 0, checks = 0;
const eq = (a, b, what) => { checks++; const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) { fails++; console.log('MISMATCH', what, '\n  api :', x.slice(0, 500), '\n  mine:', y.slice(0, 500)); } };
const prs = await db.collection('prs').find({ active: true }).toArray();
const students = await db.collection('students').find({ active: true }).toArray();
const repos = new Map((await db.collection('repos').find({}).toArray()).map((r) => [r._id, r]));
const meta = await get('/api/meta');
const P = Object.fromEntries(meta.presets.map((p) => [p.key, p]));
const yearOf = (b) => (b == null ? 'Unknown' : ({ 2026: '1st year', 2025: '2nd year', 2024: '3rd year', 2023: '4th year' }[b] || (b < 2023 ? 'alumni' : 'Unknown')));
for (const [qs, r] of [['', P.ay], ['range=90d', P['90d']], ['range=all', P.all], ['range=12m', P['12m']]]) {
  const lo = r.from ? Date.parse(r.from + 'T00:00:00+05:30') : -Infinity, hi = r.to ? Date.parse(r.to + 'T00:00:00+05:30') + 864e5 : Infinity;
  const inR = (d) => d instanceof Date && d.getTime() >= lo && d.getTime() < hi;
  const O = (p) => inR(p.createdAt), M = (p) => p.state === 'merged' && inR(p.mergedAt);
  const q = (x) => [qs, x].filter(Boolean).join('&');
  console.log('=== ', qs || 'default');
  // 1 overview with cohort
  for (const [campus, year] of [['RU', '2nd year'], ['SMRU', ''], ['', '1st year'], ['ADYPU', 'Unknown']]) {
    const sel = (x) => (!campus || x.campus === campus) && (!year || yearOf(x.batch) === year);
    const mine = prs.filter(sel);
    const o = await get('/api/overview?' + q(`campus=${campus}&year=${encodeURIComponent(year)}`));
    const per = new Map();
    for (const p of mine) { if (!O(p) && !M(p)) continue; const s = per.get(p.author) || { any: 0, os: 0, osM: 0, maj: 0 }; per.set(p.author, s); s.any++; if (p.category === 'open_source') { s.os++; if (M(p)) { s.osM++; if (p.tier === 'major') s.maj++; } } }
    const v = [...per.values()];
    eq(o.students, { tracked: students.filter(sel).length, withAnyPr: v.length, withOsPr: v.filter((s) => s.os).length, withOsMerged: v.filter((s) => s.osM).length, withMajorMerged: v.filter((s) => s.maj).length }, `overview students ${campus}/${year}`);
    eq([o.prs.total, o.prs.merged, o.prs.osPrs, o.prs.osMerged], [mine.filter(O).length, mine.filter(M).length, mine.filter((p) => O(p) && p.category === 'open_source').length, mine.filter((p) => M(p) && p.category === 'open_source').length], `overview prs ${campus}/${year}`);
    const os = mine.filter((p) => p.category === 'open_source');
    const rp = new Map(); for (const p of os) { if (!O(p) && !M(p)) continue; const x = rp.get(p.repoLc) || { osPrs: 0, osMerged: 0, st: new Set() }; rp.set(p.repoLc, x); if (O(p)) x.osPrs++; if (M(p)) x.osMerged++; x.st.add(p.author); }
    const top = [...rp.entries()].sort((a, b) => b[1].osMerged - a[1].osMerged || b[1].osPrs - a[1].osPrs || (a[0] < b[0] ? -1 : 1)).slice(0, 10).map(([id, x]) => [id, x.osPrs, x.osMerged, x.st.size]);
    eq(o.topRepos.map((t) => [t.name.toLowerCase(), t.osPrs, t.osMerged, t.students]), top, `topRepos ${campus}/${year}`);
    // activity same cohort, metric merged
    const a = await get('/api/activity?' + q(`category=all&metric=merged&campus=${campus}&year=${encodeURIComponent(year)}`));
    eq([a.totals.opened, a.totals.merged], [o.prs.total, o.prs.merged], `activity = overview ${campus}/${year}`);
    eq(a.byMonth.reduce((s, m) => s + m.merged, 0), o.prs.merged, 'byMonth sum merged');
    const act = new Set(mine.filter((p) => O(p) || M(p)).map((p) => p.author));
    eq(a.totals.activeStudents, act.size, 'activeStudents');
    const mm = {}; for (const p of mine) if (M(p)) { const k = new Date(p.mergedAt.getTime() + 19800e3).toISOString().slice(0, 7); mm[k] = (mm[k] || 0) + 1; }
    const bm = Object.entries(mm).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0];
    eq(a.busiest.month, bm ? { month: bm[0], count: bm[1] } : null, 'busiest month by merged');
    // byMonth activeStudents
    for (const m of a.byMonth) { const set = new Set(); for (const p of mine) { for (const [d, on] of [[p.createdAt, O(p)], [p.mergedAt, M(p)]]) if (on && new Date(d.getTime() + 19800e3).toISOString().slice(0, 7) === m.month) set.add(p.author); } eq(m.activeStudents, set.size, `byMonth activeStudents ${m.month}`); }
  }
  // batch filter
  const ab = await get('/api/activity?' + q('batch=2024&category=nst_internal'));
  eq([ab.totals.opened, ab.totals.merged], [prs.filter((p) => p.batch === 2024 && p.category === 'nst_internal' && O(p)).length, prs.filter((p) => p.batch === 2024 && p.category === 'nst_internal' && M(p)).length], 'activity batch+category');
  // 3 students filters + sorts
  const stat = new Map();
  for (const p of prs) { if (!O(p) && !M(p)) continue; const s = stat.get(p.author) || { totalPrs: 0, osPrs: 0, osMerged: 0, last: 0 }; stat.set(p.author, s); if (O(p)) { s.totalPrs++; s.last = Math.max(s.last, p.createdAt.getTime()); if (p.category === 'open_source') s.osPrs++; } if (M(p) && p.category === 'open_source') s.osMerged++; }
  for (const [sort, key] of [['osPrs', 'osPrs'], ['totalPrs', 'totalPrs'], ['osMerged', 'osMerged']]) for (const order of ['desc', 'asc']) {
    const L = await get('/api/students?' + q(`campus=ADYPU&batch=2025&sort=${sort}&order=${order}&limit=100`));
    const pool = students.filter((s) => s.campus === 'ADYPU' && s.batch === 2025);
    eq(L.total, pool.length, 'students filtered total');
    const exp = pool.map((s) => stat.get(s._id)?.[key] || 0).sort((a, b) => (order === 'asc' ? a - b : b - a)).slice(0, 100);
    eq(L.items.map((s) => s.stats[key]), exp, `students sort ${sort} ${order}`);
  }
  const hasOs = await get('/api/students?' + q('hasOs=1&campus=SMRU&limit=100'));
  eq(hasOs.total, students.filter((s) => s.campus === 'SMRU' && (stat.get(s._id)?.osPrs || stat.get(s._id)?.osMerged)).length, 'hasOs total');
  const lastPr = await get('/api/students?' + q('sort=lastPrAt&limit=50'));
  eq(lastPr.items.map((s) => s.stats.lastPrAt && Date.parse(s.stats.lastPrAt)), [...stat.values()].map((s) => s.last).filter(Boolean).sort((a, b) => b - a).slice(0, 50), 'sort lastPrAt');
  const qn = await get('/api/students?' + q('q=sharma&sort=name&limit=100'));
  eq(qn.total, students.filter((s) => /sharma/i.test(s.name) || /sharma/i.test(s.username)).length, 'q filter');
  // 4 repos/orgs sorts on ranged numbers
  const rs = new Map(); for (const p of prs) { if (!O(p) && !M(p)) continue; const x = rs.get(p.repoLc) || { prs: 0, merged: 0, st: new Set() }; rs.set(p.repoLc, x); if (O(p)) x.prs++; if (M(p)) x.merged++; x.st.add(p.author); }
  for (const [sort, f] of [['merged', (x) => x.merged], ['prs', (x) => x.prs], ['students', (x) => x.st.size]]) for (const order of ['desc', 'asc']) {
    const L = await get('/api/repos?' + q(`sort=${sort}&order=${order}&limit=100&tier=major`));
    const pool = [...rs.entries()].filter(([id]) => repos.get(id)?.category === 'open_source' && repos.get(id)?.tier === 'major');
    eq(L.total, pool.length, 'repos tier total');
    eq(L.items.map((it) => it.stats[sort]), pool.map(([, x]) => f(x)).sort((a, b) => (order === 'asc' ? a - b : b - a)).slice(0, 100), `repos sort ${sort} ${order}`);
  }
  const os = new Map(); for (const p of prs) { if (!O(p) && !M(p)) continue; const x = os.get(p.ownerLc) || { prs: 0, osPrs: 0, osMerged: 0, st: new Set() }; os.set(p.ownerLc, x); if (O(p)) { x.prs++; if (p.category === 'open_source') x.osPrs++; } if (M(p) && p.category === 'open_source') x.osMerged++; x.st.add(p.author); }
  for (const [sort, f] of [['osMerged', (x) => x.osMerged], ['osPrs', (x) => x.osPrs], ['prs', (x) => x.prs], ['students', (x) => x.st.size]]) {
    const L = await get('/api/orgs?' + q(`sort=${sort}&limit=100`));
    const pool = [...os.values()].filter((x) => x.osPrs || x.osMerged);
    eq(L.total, pool.length, 'orgs os total');
    eq(L.items.map((it) => it.stats[sort]), pool.map(f).sort((a, b) => b - a).slice(0, 100), `orgs sort ${sort}`);
  }
  // 5 prs filters
  eq((await get('/api/prs?' + q('tier=major&state=merged&limit=1'))).total, prs.filter((p) => p.category === 'open_source' && p.tier === 'major' && M(p)).length, 'prs major merged');
  eq((await get('/api/prs?' + q('category=all&state=open&campus=RU&limit=1'))).total, prs.filter((p) => p.state === 'open' && p.campus === 'RU' && O(p)).length, 'prs open RU');
  eq((await get('/api/prs?' + q('category=all&state=closed&limit=1'))).total, prs.filter((p) => p.state === 'closed' && O(p)).length, 'prs closed');
  const sorted = await get('/api/prs?' + q('category=all&sort=mergedAt&order=asc&limit=100'));
  eq(sorted.items.every((p, i, a) => p.state === 'merged' && inR(new Date(p.mergedAt)) && (i === 0 || a[i - 1].mergedAt <= p.mergedAt)), true, 'prs sort mergedAt: all merged in range, ascending');
  // 6 profiles of 5 busiest students, 7 repo + org detail
  const busy = [...stat.entries()].sort((a, b) => b[1].totalPrs - a[1].totalPrs).slice(0, 5).map(([id]) => id);
  for (const id of busy) {
    const d = await get(`/api/students/${id}?` + qs);
    const mine = prs.filter((p) => p.author === id);
    eq([d.student.stats.totalPrs, d.student.stats.mergedPrs, d.student.stats.osPrs, d.student.stats.osMerged, d.prs.total], [mine.filter(O).length, mine.filter(M).length, mine.filter((p) => O(p) && p.category === 'open_source').length, mine.filter((p) => M(p) && p.category === 'open_source').length, mine.filter((p) => O(p) || M(p)).length], 'profile ' + id);
    if (new Set(mine.filter((p) => O(p) || M(p)).map((p) => p.repoLc)).size <= 100) eq([d.repos.reduce((s, x) => s + x.prs, 0), d.repos.reduce((s, x) => s + x.merged, 0)], [d.student.stats.totalPrs, d.student.stats.mergedPrs], 'profile repos sum ' + id);
    if (r.from) eq(d.monthly.reduce((s, m) => s + m.allOpened, 0), d.student.stats.totalPrs, 'profile monthly sum ' + id);
    const a = await get(`/api/activity?author=${id}&category=all&` + qs);
    eq([a.totals.opened, a.totals.merged, a.totals.activeStudents], [d.student.stats.totalPrs, d.student.stats.mergedPrs, d.student.stats.totalPrs || d.student.stats.mergedPrs ? 1 : 0], 'profile activity ' + id);
  }
  const topRepos = [...rs.entries()].sort((a, b) => b[1].prs - a[1].prs).slice(0, 5);
  for (const [id, x] of topRepos) {
    const d = await get(`/api/repos/${id}?` + qs);
    eq([d.repo.stats.prs, d.repo.stats.merged, d.repo.stats.students, d.prs.total], [x.prs, x.merged, x.st.size, prs.filter((p) => p.repoLc === id && (O(p) || M(p))).length], 'repo detail ' + id);
    if (x.st.size <= 100) eq([d.students.reduce((s, y) => s + y.prs, 0), d.students.reduce((s, y) => s + y.merged, 0)], [x.prs, x.merged], 'repo contributors sum ' + id);
    const a = await get(`/api/activity?repo=${id}&category=all&` + qs);
    eq([a.totals.opened, a.totals.merged, a.totals.activeStudents], [x.prs, x.merged, x.st.size], 'repo activity ' + id);
    const owner = id.split('/')[0]; const ox = os.get(owner);
    const od = await get(`/api/orgs/${owner}?` + qs);
    eq([od.org.stats.prs, od.org.stats.osPrs, od.org.stats.osMerged, od.org.stats.students], [ox.prs, ox.osPrs, ox.osMerged, ox.st.size], 'org detail ' + owner);
    eq(d.owner.stats, od.org.stats, 'repo.owner stats = org stats');
    const oa = await get(`/api/activity?owner=${owner}&category=all&` + qs);
    eq([oa.totals.opened, oa.totals.activeStudents], [ox.prs, ox.st.size], 'org activity ' + owner);
  }
}
// boundary on real data: single-day ranges partition the IST day
const day = '2026-10-29';
const d0 = Date.parse(day + 'T00:00:00+05:30');
eq((await get(`/api/activity?from=${day}&to=${day}&category=all`)).totals.opened, prs.filter((p) => p.createdAt.getTime() >= d0 && p.createdAt.getTime() < d0 + 864e5).length, 'single IST day');
const edge = prs.filter((p) => { const t = p.createdAt.getTime() - d0; return (t >= -5.5 * 36e5 && t < 0) || (t >= 864e5 - 5.5 * 36e5 && t < 864e5); }).length;
console.log('PRs created in the 5.5 h where the UTC day and the IST day disagree around', day, ':', edge);
console.log(`${checks} checks, ${fails} mismatches`);
await client.close();
