#!/usr/bin/env node
// Builds a program's organisation list with GitHub logins (SPEC addendum G2).
//
//   node scripts/fetch_program_orgs.js --year 2025                          # fetch the GSoC list for 2025 from the GSoC archive API
//   node scripts/fetch_program_orgs.js --year 2025 --file config/gsoc-2025-orgs.raw.json   # or map a list that was saved earlier
//   ... --apply         also set the program's org list (settings `programs`) to the mapped logins and recompute the scores
//   ... --write-seed    also rewrite config/programs.seed.json (the list a fresh database starts with)
//   ... --no-db         map from links only (no name matching against the organisations in the database, nothing saved)
//
// Each organisation is mapped to GitHub logins from (1) config/program-org-aliases.json, (2) github.com links in its
// own entry, (3) its name matching an organisation NST students already contributed to. Unmapped ones are listed for
// manual mapping on the private page (Settings → Organisations). GSOC_API_URL overrides the API base (tests, mirrors).
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { connect, ensureIndexes } from '../src/db.js';
import { ensurePrograms, knownOwnerMap, loadPrograms, loadSeed, mapProgramOrgs, savePrograms, saveProgramOrgs, SEED_PATH } from '../src/programs.js';
import { parseArgs } from './_cli.js';

const USAGE = 'usage: node scripts/fetch_program_orgs.js --year <YYYY> [--program gsoc] [--file <json>] [--apply] [--write-seed] [--no-db]';

export const gsocApiUrl = (year, base = process.env.GSOC_API_URL || 'https://summerofcode.withgoogle.com/api') =>
  `${String(base).replace(/\/+$/, '')}/program/${year}/organizations/`;

/** The organisation list of one GSoC year from the public archive API. */
export async function fetchGsocOrgs(year, { fetch: f = fetch, base } = {}) {
  const res = await f(gsocApiUrl(year, base), { headers: { accept: 'application/json', 'user-agent': 'oss-status' } });
  if (!res.ok) throw new Error(`GSoC API answered ${res.status} for ${year}`);
  const body = await res.json();
  const list = Array.isArray(body) ? body : body?.organizations || body?.results;
  if (!Array.isArray(list) || !list.length) throw new Error(`GSoC API returned no organisations for ${year}`);
  return list;
}

/** Maps, saves (when a db is given) and reports. -> { items, mapped, unmapped, logins, nst? } */
export async function run({ db = null, program = 'gsoc', year, orgs, apply = false, now = new Date() }) {
  const knownOwners = db ? await knownOwnerMap(db) : new Map();
  const result = mapProgramOrgs(orgs, { program, year, knownOwners });
  if (!db) return result;
  await ensurePrograms(db, now);
  const logins = await saveProgramOrgs(db, result.items, now);
  if (apply) {
    const cfg = await loadPrograms(db, now);
    const p = cfg.programs.find((x) => x.key === program);
    if (!p) throw new Error(`no program with key ${program}`);
    p.orgs = logins;
    p.orgSource = `${program}-${year}`;
    p.starter = false;
    await savePrograms(db, { programs: cfg.programs, bands: cfg.bands, trendDays: cfg.trendDays, crowdedAt: cfg.crowdedAt }, now);
    const { recomputeScores } = await import('../src/scores.js');
    await recomputeScores(db, { now });
  }
  // how much NST work falls in these organisations (all time, every category)
  const nst = await db.collection('prs').aggregate([
    { $match: { active: true, ownerLc: { $in: logins } } },
    { $group: { _id: null, prs: { $sum: 1 }, os: { $sum: { $cond: [{ $eq: ['$category', 'open_source'] }, 1, 0] } },
      merged: { $sum: { $cond: [{ $and: [{ $eq: ['$category', 'open_source'] }, { $eq: ['$state', 'merged'] }] }, 1, 0] } },
      students: { $addToSet: '$author' }, orgs: { $addToSet: '$ownerLc' } } },
  ]).toArray();
  const n = nst[0] || { prs: 0, os: 0, merged: 0, students: [], orgs: [] };
  return { ...result, logins, nst: { prs: n.prs, openSourcePrs: n.os, mergedOpenSourcePrs: n.merged, students: n.students.length, orgsWithNstPrs: n.orgs.length } };
}

/** Rewrites the program's org list and provenance rows in config/programs.seed.json; other programs are kept as they are. */
export function writeSeed(result, { program, year, file = SEED_PATH, now = new Date() }) {
  const seed = JSON.parse(JSON.stringify(loadSeed(file)));
  seed.generatedAt = now.toISOString();
  seed.programs ||= [];
  let p = seed.programs.find((x) => x.key === program);
  if (!p) { p = { key: program }; seed.programs.unshift(p); }
  p.orgs = result.logins;
  p.orgSource = `${program}-${year}`;
  p.starter = false;
  seed.programOrgs = [
    ...(seed.programOrgs || []).filter((o) => !(o.program === program && Number(o.year) === Number(year))),
    ...result.items.map(({ program: pr, year: y, slug, name, url, ideasUrl, logins, mappedBy, confidence }) => ({ program: pr, year: y, slug, name, url, ideasUrl, logins, mappedBy, confidence })),
  ];
  writeFileSync(file, `${JSON.stringify(seed, null, 1)}\n`);
  return seed;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), { year: 'int', program: 'string', file: 'string', apply: 'bool', 'write-seed': 'bool', 'no-db': 'bool' });
  } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    return 2;
  }
  if (!args.year) { console.error(USAGE); return 2; }
  const program = args.program || 'gsoc';
  const orgs = args.file ? JSON.parse(readFileSync(args.file, 'utf8')) : await fetchGsocOrgs(args.year);
  let client = null;
  let db = null;
  if (!args['no-db']) {
    const conn = await connect(loadConfig());
    client = conn.client;
    db = conn.db;
    await ensureIndexes(db);
  }
  try {
    const r = await run({ db, program, year: args.year, orgs, apply: Boolean(args.apply) });
    const by = {};
    for (const i of r.items) by[i.mappedBy || 'unmapped'] = (by[i.mappedBy || 'unmapped'] || 0) + 1;
    console.log(`${program} ${args.year}: ${r.items.length} organisations, ${r.mapped} mapped to ${r.logins.length} GitHub logins, ${r.unmapped} unmapped`);
    console.log(`  mapped by: ${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    if (r.nst) console.log(`  NST work in these organisations: ${r.nst.prs} PRs (${r.nst.openSourcePrs} open source, ${r.nst.mergedOpenSourcePrs} merged) by ${r.nst.students} students in ${r.nst.orgsWithNstPrs} of the logins`);
    const unmapped = r.items.filter((i) => !i.logins.length);
    if (unmapped.length) console.log(`  unmapped (map by hand on the private page, or leave: many do not use GitHub):\n${unmapped.map((i) => `    ${i.slug}  ${i.name}  ${i.url}`).join('\n')}`);
    if (args['write-seed']) { writeSeed(r, { program, year: args.year }); console.log(`  wrote ${SEED_PATH}`); }
    return 0;
  } finally {
    await client?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (e) => { console.error(`fetch_program_orgs failed: ${e?.message || e}`); process.exit(1); });
}
