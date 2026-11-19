#!/usr/bin/env node
// Imports data/students.csv + data/raw/<username-lowercase>.json into Mongo. Idempotent: every student, PR, repo and
// owner is written only when it does not exist yet, so a re-run adds what is missing and never puts the old file
// contents over overrides, admin edits or anything a later sync stored (PR state, stars, tiers).
// Usage: node scripts/import_legacy.js [--data <dir>=./data] [--fetched-at <ISO>]
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { collections, connect, ensureIndexes } from '../src/db.js';
import { CAMPUSES, reclassifyAll } from '../src/classify.js';
import { buildDocs, bulk, emptyStudentStats, ownerUpsertOp, prUpsertOp, repoUpsertOp } from '../src/ingest.js';
import { ensureRules } from '../src/rules.js';
import { parseCsv } from '../src/csv.js';
import { registerHandler, runInline } from '../src/jobs.js';

const DAY = 24 * 60 * 60 * 1000;

function rowToStudent(row, now) {
  const username = (row.github_username || '').trim();
  const batch = /^\d{4}$/.test(row.batch || '') ? Number(row.batch) : null;
  const nameSource = ['sheet', 'github profile'].includes(row.name_source) ? row.name_source : '';
  return {
    _id: username.toLowerCase(), username, githubId: null, name: row.name || '', nameSource,
    campus: CAMPUSES.includes(row.campus) ? row.campus : 'Unknown', batch,
    email: row.email || '', enrolmentNo: row.enrolment_no || '',
    sources: (row.sources || '').split('; ').map((s) => s.trim()).filter(Boolean), notes: row.notes || '',
    active: true, backfill: { status: 'pending', at: now }, lastSyncedAt: null, loginCheckedAt: null,
    addedAt: now, addedBy: 'import', stats: emptyStudentStats(),
  };
}

/**
 * Job handler (type `import`). params: { data: dir, fetchedAt?: ISO string }.
 * Returns { students, studentsAdded, rawFiles, prs, repos, owners, skippedPrivate, missingRaw, unknownRaw, fetchErrors, byCategory, lastSyncedAt, ms }.
 */
export async function importLegacy(db, params = {}, ctx = { log() {}, progress() {} }) {
  const t0 = Date.now();
  const c = collections(db);
  const dir = path.resolve(params.data || './data');
  await ensureIndexes(db);
  await ensureRules(db);

  // 1. students
  const now = new Date();
  const rows = parseCsv(await fs.readFile(path.join(dir, 'students.csv'), 'utf8')).filter((r) => (r.github_username || '').trim());
  const fromCsv = new Map();
  for (const row of rows) {
    const s = rowToStudent(row, now);
    if (!fromCsv.has(s._id)) fromCsv.set(s._id, s);
  }
  const before = await c.students.countDocuments({});
  await bulk(c.students, [...fromCsv.values()].map(({ _id, ...doc }) => ({ updateOne: { filter: { _id }, update: { $setOnInsert: doc }, upsert: true } })));
  const studentsAdded = (await c.students.countDocuments({})) - before;
  ctx.log(`students.csv: ${fromCsv.size} students (${studentsAdded} new)`);

  // PRs carry the *stored* campus / batch / active (an admin may have edited a student since the first import)
  const stored = new Map();
  for await (const s of c.students.find({ _id: { $in: [...fromCsv.keys()] } }, { projection: { username: 1, campus: 1, batch: 1, active: 1, backfill: 1, addedBy: 1, lastSyncedAt: 1 } })) stored.set(s._id, s);

  // 2. raw PR files (insert-only: see the header comment)
  let files = [];
  try {
    files = (await fs.readdir(path.join(dir, 'raw'))).filter((f) => f.endsWith('.json')).sort();
  } catch {
    ctx.log('no raw/ directory: importing students only');
  }
  const repos = new Map();
  const owners = new Map();
  const fetched = [];        // student ids with a clean raw file
  const failed = [];         // [id, error] raw files whose fetch reported an error
  let prOps = [];
  let prCount = 0;
  let skippedPrivate = 0;
  let unknownRaw = 0;
  let latest = 0;
  let done = 0;
  for (const file of files) {
    const id = file.slice(0, -5).toLowerCase();
    const student = stored.get(id);
    done++;
    if (!student) { unknownRaw++; ctx.log(`raw/${file}: no such student in students.csv, skipped`); continue; }
    let data;
    try {
      data = JSON.parse(await fs.readFile(path.join(dir, 'raw', file), 'utf8'));
    } catch (e) {
      failed.push([id, `unreadable raw file: ${e.message}`]);
      continue;
    }
    const docs = buildDocs(student, data.prs || []);
    skippedPrivate += docs.skippedPrivate;
    for (const p of docs.prs) {
      for (const d of [p.createdAt, p.mergedAt, p.closedAt]) if (d && d.getTime() > latest) latest = d.getTime();
      prOps.push(prUpsertOp(p, null, { insertOnly: true }));
    }
    prCount += docs.prs.length;
    for (const [k, v] of docs.repos) repos.set(k, v);
    for (const [k, v] of docs.owners) owners.set(k, v);
    if (data.error) failed.push([id, String(data.error).slice(0, 300)]); else fetched.push(id);
    if (prOps.length >= 5000) { await bulk(c.prs, prOps); prOps = []; }
    if (done % 250 === 0) ctx.progress(done, files.length);
  }
  await bulk(c.prs, prOps);
  await Promise.all([
    bulk(c.repos, [...repos.values()].map((r) => repoUpsertOp(r, null, { insertOnly: true }))),
    bulk(c.owners, [...owners.values()].map((o) => ownerUpsertOp(o, { insertOnly: true }))),
  ]);
  ctx.progress(files.length, files.length);
  ctx.log(`raw: ${files.length} files, ${prCount} PRs, ${repos.size} repos, ${owners.size} owners, ${skippedPrivate} private PRs skipped`);

  // 3. fetch bookkeeping. File mtimes are copy times, so lastSyncedAt = --fetched-at or (latest PR timestamp - 3 days).
  let lastSyncedAt = null;
  if (params.fetchedAt) {
    lastSyncedAt = new Date(params.fetchedAt);
    if (Number.isNaN(lastSyncedAt.getTime())) throw new Error(`invalid --fetched-at: ${params.fetchedAt}`);
  } else if (latest) lastSyncedAt = new Date(latest - 3 * DAY);
  // Only students still in the imported state are touched: later syncs / admin actions win on a re-run.
  const untouched = { addedBy: 'import', 'backfill.status': 'pending', lastSyncedAt: null };
  if (fetched.length) {
    await c.students.updateMany({ _id: { $in: fetched }, ...untouched }, { $set: { backfill: { status: 'done', at: now }, lastSyncedAt } });
  }
  for (const [id, error] of failed) {
    await c.students.updateOne({ _id: id, ...untouched }, { $set: { backfill: { status: 'error', at: now, error } } });
  }
  const missingRaw = fromCsv.size - fetched.length - failed.length;
  if (missingRaw) ctx.log(`${missingRaw} students have no raw file: left as backfill pending (the next sync fetches them)`);
  if (failed.length) ctx.log(`${failed.length} raw files report a fetch error: marked backfill error (the next sync retries them)`);

  // 4. classify + aggregates
  const cls = await reclassifyAll(db);
  ctx.log(`classified ${cls.prs} PRs and ${cls.repos} repos; aggregates refreshed`);
  const byCategory = Object.fromEntries((await c.prs.aggregate([{ $group: { _id: '$category', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray()).map((g) => [g._id, g.n]));
  return {
    students: fromCsv.size, studentsAdded, rawFiles: files.length, prs: prCount, repos: repos.size, owners: owners.size, skippedPrivate,
    missingRaw, unknownRaw, fetchErrors: failed.length, byCategory, lastSyncedAt: lastSyncedAt ? lastSyncedAt.toISOString() : null, ms: Date.now() - t0,
  };
}

function parseArgs(argv) {
  const out = { data: './data' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
      i++;
      if (argv[i] === undefined) throw new Error(`${a} needs a value`);
      return argv[i];
    };
    if (a === '--data' || a.startsWith('--data=')) out.data = value();
    else if (a === '--fetched-at' || a.startsWith('--fetched-at=')) out.fetchedAt = value();
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\nusage: node scripts/import_legacy.js [--data <dir>] [--fetched-at <ISO>]`);
    process.exitCode = 2;
    return;
  }
  if (args.help) { console.log('usage: node scripts/import_legacy.js [--data <dir>=./data] [--fetched-at <ISO>]'); return; }
  const config = loadConfig();
  let client;
  try {
    const conn = await connect(config);
    client = conn.client;
    registerHandler('import', importLegacy);
    const params = { data: args.data, ...(args.fetchedAt && { fetchedAt: args.fetchedAt }) };
    const job = await runInline(conn.db, 'import', params);
    if (job.status !== 'done') {
      console.error(`import failed: ${job.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`import done in ${(job.summary.ms / 1000).toFixed(1)}s`);
    console.log(JSON.stringify(job.summary, null, 2));
  } catch (e) {
    console.error('import failed:', e?.message || e);
    process.exitCode = 1;
  } finally {
    await client?.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
