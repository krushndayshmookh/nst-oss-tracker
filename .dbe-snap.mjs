import fs from 'node:fs';
const BASE = 'http://127.0.0.1:38411';
const qs = ['', 'category=all', 'range=all', 'range=all&category=all', 'range=90d&category=all&metric=merged', 'range=ay-2025-26&campus=RU&year=2nd%20year', 'category=practice&batch=2025', 'author=vtushar06&category=all&range=all',
  'owner=apache&range=all', 'repo=sugarlabs/musicblocks&range=12m&metric=merged', 'from=2026-08-01', 'to=2025-12-31&category=all', 'from=2030-01-01&to=2030-02-01', 'campus=SMRU&category=all&range=30d', 'year=Unknown&category=all&range=all', 'author=nobody-here'];
const out = {};
for (const q of qs) out[q] = await (await fetch(`${BASE}/api/activity?${q}`)).json();
fs.writeFileSync(process.argv[2], JSON.stringify(out));
console.log(Object.entries(out).map(([q, a]) => `${q || '(default)'} -> ${JSON.stringify(a.totals)} m${a.byMonth?.length} w${a.byWeek?.length} d${a.byDate?.length} ${a.truncated ? 'trunc' : ''}`).join('\n'));
