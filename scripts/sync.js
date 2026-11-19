#!/usr/bin/env node
// Daily incremental fetch for all active students (SPEC section 4).
// Usage: node scripts/sync.js [--users a,b] [--full] [--limit N] [--campus RU] [--batch 2025] [--concurrency N]
//   default       PRs updated since each student's last successful sync (minus 2 days); pending students get full history
//   --full        re-read the whole history of the selected students
// Env: MONGODB_URI, MONGODB_DB, GITHUB_TOKEN, SYNC_CONCURRENCY. Exit code 1 only on total failure.
import { parseArgs, runJob } from './_cli.js';

const USAGE = 'usage: node scripts/sync.js [--users a,b] [--full] [--limit N] [--campus C] [--batch YYYY] [--concurrency N]';
let params;
try {
  const a = parseArgs(process.argv.slice(2), { users: 'list', full: 'bool', limit: 'int', campus: 'string', batch: 'int', concurrency: 'int', help: 'bool' });
  if (a.help) { console.log(USAGE); process.exit(0); }
  params = { full: a.full === true };
  for (const k of ['users', 'limit', 'campus', 'batch', 'concurrency']) if (a[k] !== undefined) params[k] = a[k];
} catch (e) {
  console.error(e.message);
  console.error(USAGE);
  process.exit(2);
}
process.exitCode = await runJob('sync', params, { usage: USAGE });
