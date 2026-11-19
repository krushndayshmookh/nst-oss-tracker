#!/usr/bin/env node
// Full-history fetch (SPEC section 4).
// Usage: node scripts/backfill.js --users a,b      the given tracked students (also inactive ones)
//        node scripts/backfill.js --pending        every active student whose backfill is still pending (the default)
// Env: MONGODB_URI, MONGODB_DB, GITHUB_TOKEN, SYNC_CONCURRENCY. Exit code 1 only on total failure.
import { parseArgs, runJob } from './_cli.js';

const USAGE = 'usage: node scripts/backfill.js [--users a,b | --pending] [--concurrency N]';
let params;
try {
  const a = parseArgs(process.argv.slice(2), { users: 'list', pending: 'bool', concurrency: 'int', help: 'bool' });
  if (a.help) { console.log(USAGE); process.exit(0); }
  params = {};
  if (a.users) params.users = a.users;
  if (a.pending || !a.users) params.pending = true;
  if (a.concurrency !== undefined) params.concurrency = a.concurrency;
} catch (e) {
  console.error(e.message);
  console.error(USAGE);
  process.exitCode = 2;
}
if (params) process.exitCode = await runJob('backfill', params, { usage: USAGE });
