// Shared plumbing of scripts/sync.js and scripts/backfill.js: flags, DB connection, inline job, exit code.
import { loadConfig } from '../src/config.js';
import { connect, ensureIndexes } from '../src/db.js';
import { runInline } from '../src/jobs.js';

/** Parses `--flag`, `--key value` and `--key=value`. `spec` maps flag name -> 'bool' | 'list' | 'int' | 'string'. */
export function parseArgs(argv, spec) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m || !(m[1] in spec)) throw new Error(`unknown argument: ${argv[i]}`);
    const [, name, inline] = m;
    const kind = spec[name];
    if (kind === 'bool') {
      if (inline !== undefined && !['true', 'false'].includes(inline)) throw new Error(`--${name} takes no value`);
      out[name] = inline !== 'false';
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    if (kind === 'list') {
      out[name] = value.split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean);
      if (!out[name].length) throw new Error(`--${name} needs at least one value`);
    } else if (kind === 'int') {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
      out[name] = n;
    } else {
      out[name] = value;
    }
  }
  return out;
}

/** True when the run achieved nothing at all: the job crashed, or every student that was tried failed. */
export function totalFailure(job) {
  if (!job || job.status !== 'done') return true;
  const s = job.summary || {};
  return (s.failed || 0) > 0 && !(s.ok || 0) && !(s.notFound || 0);
}

/** Connects, runs one job inline (runner 'cli', logged to stdout and to the jobs collection) and returns the exit code. */
export async function runJob(type, params, { usage }) {
  const config = loadConfig();
  if (!config.githubToken) {
    console.error(`${type}: GITHUB_TOKEN is not set`);
    return 1;
  }
  let client;
  try {
    const conn = await connect(config);
    client = conn.client;
    await ensureIndexes(conn.db);
    if (params.concurrency === undefined) params.concurrency = config.syncConcurrency;
    const job = await runInline(conn.db, type, params);
    console.log(`${type} ${job.status}: ${JSON.stringify(job.summary ?? job.error)}`);
    return totalFailure(job) ? 1 : 0;
  } catch (e) {
    console.error(`${type} failed: ${e?.message || e}`);
    if (usage && /argument|needs a value/.test(String(e?.message))) console.error(usage);
    return 1;
  } finally {
    await client?.close().catch(() => {});
  }
}
