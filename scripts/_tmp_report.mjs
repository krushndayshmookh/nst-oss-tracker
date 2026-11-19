import { MongoClient } from 'mongodb';
import { recomputeScores } from '../src/scores.js';
import { loadPrograms } from '../src/programs.js';
const c = new MongoClient(process.env.MONGODB_URI); await c.connect(); const db = c.db(process.env.MONGODB_DB);
const now = process.env.NOW ? new Date(process.env.NOW) : new Date();
const t=Date.now(); const s = await recomputeScores(db, { now }); console.log('summary', s, 'ms', Date.now()-t);
const cfg = await loadPrograms(db); const keys = cfg.programs.map(p=>p.key);
const docs = await db.collection('program_scores').find({}).toArray();
const maxPr = await db.collection('prs').find({}).sort({createdAt:-1}).limit(1).toArray(); console.log('latest PR', maxPr[0].createdAt);
for (const k of keys) { const b={strong:0,possible:0,early:0,none:0}; const pb={strong:0,possible:0,early:0,none:0}; for (const d of docs){ b[d.programs[k].band]++; pb[d.programs[k].prevBand]++;} console.log(k.padEnd(12), JSON.stringify(b), 'prev', JSON.stringify(pb)); }
console.log('realChance', docs.filter(d=>d.realChance).length, 'strong', docs.filter(d=>d.realChanceStrong).length);
const noMlh = docs.filter(d=>['gsoc','outreachy','lfx','processing','sob'].some(k=>['strong','possible'].includes(d.programs[k].band))).length; console.log('realChance excluding mlh', noMlh);
const byC = {}; for (const d of docs){ const g = byC[d.campus] ||= {students:0, real:0, gsoc:{strong:0,possible:0,early:0,none:0}}; g.students++; if(d.realChance) g.real++; g.gsoc[d.programs.gsoc.band]++; } console.log(JSON.stringify(byC,null,0));
const top = docs.sort((a,b)=>b.programs.gsoc.score-a.programs.gsoc.score).slice(0, Number(process.env.TOP||5));
for (const d of top){ const g=d.programs.gsoc; console.log(`\n${d.username} (${d.campus} ${d.batch}) gsoc ${g.score} ${g.band} bestOrg ${g.bestOrg} prs ${g.prs} merged ${g.merged} prev ${g.prevScore}`); for (const [k,f] of Object.entries(g.features)) console.log(`   ${k.padEnd(11)} ${String(f.value).padEnd(6)} ${String(f.points).padEnd(5)} ${f.explain}`); console.log('   blockers', g.blockers, '|', g.nextStep); }
await c.close();
