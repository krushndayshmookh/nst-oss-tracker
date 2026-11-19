#!/usr/bin/env node
// Recomputes category / tier / reason of every PR and repo with the current rules, then all aggregates.
// Usage: node scripts/reclassify.js
import { loadConfig } from '../src/config.js';
import { connect, ensureIndexes } from '../src/db.js';
import { runInline } from '../src/jobs.js';

const config = loadConfig();
let client;
try {
  const conn = await connect(config);
  client = conn.client;
  await ensureIndexes(conn.db);
  const job = await runInline(conn.db, 'reclassify', {});
  console.log(`reclassify ${job.status}: ${JSON.stringify(job.summary ?? job.error)}`);
  process.exitCode = job.status === 'done' ? 0 : 1;
} catch (e) {
  console.error('reclassify failed:', e?.message || e);
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
}
