const BASE = process.env.BASE || 'http://127.0.0.1:38411';
const top = await (await fetch(BASE + '/api/students?limit=1')).json();
const u = top.items[0].username;
const eps = ['/api/overview', '/api/overview?campus=RU&year=2nd%20year', '/api/campuses', '/api/activity', '/api/activity?category=all', '/api/activity?category=all&metric=merged&campus=ADYPU',
  `/api/activity?author=${u}&category=all`, '/api/activity?owner=apache', '/api/students', '/api/students?sort=totalPrs&campus=RU&q=a', '/api/students?hasOs=1&sort=lastPrAt', `/api/students/${u}`,
  '/api/repos', '/api/repos?category=all&sort=students', '/api/orgs', '/api/orgs?category=all&sort=prs', '/api/prs', '/api/prs?category=all&state=merged&sort=mergedAt', '/api/prs?category=all&q=fix',
  '/api/export/students.csv', '/api/export/prs.csv', '/api/export/prs.csv?category=all', '/api/meta'];
const ranges = { ay: '', '90d': 'range=90d', all: 'range=all', prevAY: 'range=ay-2025-26' };
const rows = [];
// repo/org detail: pick top ones
const r0 = (await (await fetch(BASE + '/api/repos?limit=1')).json()).items[0].name; const o0 = (await (await fetch(BASE + '/api/orgs?limit=1')).json()).items[0].login;
eps.push(`/api/repos/${r0}`, `/api/orgs/${o0}`);
let worst = 0;
for (const ep of eps) {
  const row = { ep };
  for (const [k, qs] of Object.entries(ranges)) {
    const url = BASE + ep + (qs ? (ep.includes('?') ? '&' : '?') + qs : '');
    const ts = [];
    for (let i = 0; i < 5; i++) { const t = performance.now(); const r = await fetch(url); await r.arrayBuffer(); if (r.status !== 200) row[k] = 'HTTP' + r.status; ts.push(performance.now() - t); }
    row[k] ??= `${Math.round(ts[0])}/${Math.round(ts.slice().sort((a, b) => a - b)[2])}/${Math.round(Math.max(...ts))}`;
    worst = Math.max(worst, ...ts);
  }
  rows.push(row);
}
console.log('first/median/max ms over 5 uncached requests');
console.table(rows);
console.log('worst', Math.round(worst));
