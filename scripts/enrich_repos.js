#!/usr/bin/env node
// Refreshes repository metadata (stars, language, languages by size, topics, description) for the stored repos and
// recomputes their technology domain (SPEC addendum H). Same job as the admin Jobs page button "Refresh repo metadata".
// Usage: node scripts/enrich_repos.js [--force] [--stale-days N] [--limit N] [--repos owner/name,owner/name]
//   default        repos never refreshed, or refreshed more than 7 days ago (re-running after an interruption resumes)
//   --force        every repo, however recently refreshed
// Env: MONGODB_URI, MONGODB_DB, GITHUB_TOKEN. About 40 repos per GraphQL request.
import { parseArgs, runJob } from './_cli.js';

const USAGE = 'usage: node scripts/enrich_repos.js [--force] [--stale-days N] [--limit N] [--repos owner/name,…]';
let params;
try {
  const a = parseArgs(process.argv.slice(2), { force: 'bool', 'stale-days': 'string', limit: 'int', repos: 'list', help: 'bool' });
  if (a.help) { console.log(USAGE); process.exit(0); }
  params = { force: a.force === true };
  if (a['stale-days'] !== undefined) {
    const n = Number(a['stale-days']);
    if (!Number.isInteger(n) || n < 0) throw new Error('--stale-days must be a whole number of days (0 or more)');
    params.staleDays = n;
  }
  if (a.limit !== undefined) params.limit = a.limit;
  if (a.repos !== undefined) {
    if (a.repos.some((r) => !/^[^/\s]+\/[^/\s]+$/.test(r))) throw new Error('--repos takes owner/name values');
    params.repos = a.repos;
  }
} catch (e) {
  console.error(e.message);
  console.error(USAGE);
  process.exit(2);
}
process.exitCode = await runJob('repoMeta', params, { usage: USAGE });
