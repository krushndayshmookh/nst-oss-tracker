// `repoMeta` job (SPEC addendum H1): refreshes the metadata of stored repositories (stars, language, languages by size,
// topics, description, …) with batched GraphQL queries of ~40 aliased `repository(owner:, name:)` fields each.
//
//   repoMetaJob(db, params, ctx) -> summary { repos, ok, renamed, missing, private, failed, requests, rateLimitRemaining, cancelled? }
//   params: { force?: bool (every repo, however fresh), staleDays?: n (default 7), limit?: n, repos?: ['owner/name'] }
//
// Resumable: a repo is picked only when `metaFetchedAt` is missing or older than `staleDays`, and every batch is written as
// soon as it arrives, so a cancelled / interrupted run picks up where it stopped. Repos GitHub does not return (deleted,
// private, blocked) are marked `metaStatus: 'missing' | 'private'`; a repo answered under another name (renamed or
// transferred: GitHub follows the redirect) is marked 'renamed' with `renamedTo`. Its _id never changes (the PRs point at it).
// Changed stars / fork flags reclassify that repo's PRs; the technology domain of every touched repo is recomputed.
import { collections } from './db.js';
import { gql, respectRateLimit } from './github.js';
import { parseLanguages, parseTopics, bulk, refreshAggregates } from './ingest.js';
import { reclassify } from './classify.js';
import { recomputeDomains } from './tech.js';

export const BATCH_SIZES = [40, 20, 10]; // a batch GitHub answers with 502 / timeout is retried in smaller pieces
export const DEFAULT_STALE_DAYS = 7;
const MAX_FAILED_BATCHES = 5; // consecutive whole-batch failures before the run gives up
const PAUSE_MS = 250;

export const REPO_META_FIELDS = `nameWithOwner isFork isArchived isPrivate stargazerCount forkCount description
 owner{login __typename} primaryLanguage{name} licenseInfo{spdxId}
 languages(first:5, orderBy:{field:SIZE, direction:DESC}){totalSize edges{size node{name}}}
 repositoryTopics(first:10){nodes{topic{name}}}`;

/** One aliased query for a batch of 'owner/name' strings: r0 … rN, variables o0/n0 … (never string-interpolated). */
export function buildRepoQuery(names) {
  const vars = {};
  const decl = [];
  const fields = names.map((full, i) => {
    const at = full.indexOf('/');
    vars[`o${i}`] = full.slice(0, at);
    vars[`n${i}`] = full.slice(at + 1);
    decl.push(`$o${i}: String!`, `$n${i}: String!`);
    return `r${i}: repository(owner: $o${i}, name: $n${i}) { ...M }`;
  });
  const query = `query(${decl.join(', ')}) {\n${fields.join('\n')}\nrateLimit{cost remaining resetAt}\n}\nfragment M on Repository { ${REPO_META_FIELDS} }`;
  return { query, variables: vars };
}

/** The per-repo outcome of one answered batch. -> [{ id, status: 'ok'|'renamed'|'missing'|'private', node?, error? }] */
export function readBatch(batch, d) {
  const errs = new Map();
  for (const e of d?.errors || []) {
    const alias = Array.isArray(e?.path) ? e.path[0] : null;
    if (typeof alias === 'string') errs.set(alias, e);
  }
  return batch.map((r, i) => {
    const node = d?.data?.[`r${i}`];
    if (!node) {
      const e = errs.get(`r${i}`);
      return { id: r._id, status: 'missing', error: e ? `${e.type || 'error'}: ${String(e.message || '').slice(0, 160)}` : 'not returned' };
    }
    if (node.isPrivate) return { id: r._id, status: 'private', node };
    const renamed = String(node.nameWithOwner || '').toLowerCase() !== r._id;
    return { id: r._id, status: renamed ? 'renamed' : 'ok', node };
  });
}

/** $set of a repo GitHub answered (overrides, stats and classification are left alone). */
function metaSet(node, status, at) {
  const set = {
    stars: Number.isFinite(node.stargazerCount) ? node.stargazerCount : 0, forks: Number.isFinite(node.forkCount) ? node.forkCount : 0,
    isFork: Boolean(node.isFork), isArchived: Boolean(node.isArchived), language: node.primaryLanguage?.name ?? null,
    license: node.licenseInfo?.spdxId ?? null, description: node.description ?? null,
    languages: parseLanguages(node.languages) ?? [], topics: parseTopics(node.repositoryTopics) ?? [],
    metaFetchedAt: at, metaStatus: status, metaError: null,
  };
  set.renamedTo = status === 'renamed' ? node.nameWithOwner : null;
  return set;
}

/** Repos due for a refresh, most-contributed first. */
async function pickRepos(db, params, now) {
  const { repos } = collections(db);
  const filter = {};
  if (Array.isArray(params.repos) && params.repos.length) filter._id = { $in: params.repos.map((r) => String(r).toLowerCase()) };
  else if (!params.force) {
    const days = Number.isFinite(params.staleDays) && params.staleDays >= 0 ? params.staleDays : DEFAULT_STALE_DAYS;
    const before = new Date(now.getTime() - days * 86400000);
    filter.$or = [{ metaFetchedAt: { $exists: false } }, { metaFetchedAt: null }, { metaFetchedAt: { $lt: before } }];
  }
  let cursor = repos.find(filter, { projection: { name: 1, stars: 1, isFork: 1 } }).sort({ 'stats.prs': -1, _id: 1 });
  if (Number.isInteger(params.limit) && params.limit > 0) cursor = cursor.limit(params.limit);
  return (await cursor.toArray()).filter((r) => /^[^/\s]+\/[^/\s]+$/.test(r.name || r._id));
}

export async function repoMetaJob(db, params = {}, ctx = {}, opts = {}) {
  const c = collections(db);
  const log = ctx.log || (() => {});
  const progress = ctx.progress || (() => {});
  const isCancelled = ctx.isCancelled || (async () => false);
  const o = {
    fetch: opts.fetch, token: opts.token ?? process.env.GITHUB_TOKEN ?? '', sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: opts.now ?? (() => new Date()), log,
  };
  if (!o.token) throw new Error('GITHUB_TOKEN is not set');
  const todo = await pickRepos(db, params, o.now());
  const summary = { repos: todo.length, ok: 0, renamed: 0, missing: 0, private: 0, failed: 0, requests: 0, rateLimitRemaining: null };
  log(`refreshing metadata of ${todo.length} repos${params.force ? ' (all)' : ''}`);
  progress(0, todo.length);
  const reclass = []; // repos whose stars / fork flag changed
  const touched = [];
  let done = 0;
  let failedInARow = 0;
  let i = 0;
  while (i < todo.length) {
    if (await isCancelled()) { summary.cancelled = true; log('cancelled'); break; }
    let answered = null;
    let batch = null;
    let lastError = '';
    for (const size of BATCH_SIZES) {
      batch = todo.slice(i, i + size);
      const { query, variables } = buildRepoQuery(batch.map((r) => r.name || r._id));
      summary.requests++;
      const d = await gql(query, variables, { ...o, attempts: 3 });
      if (d?.fatal) throw new Error(String(d.errors?.[0]?.message || 'GitHub refused the token'));
      if (d?.data?.rateLimit) summary.rateLimitRemaining = d.data.rateLimit.remaining ?? summary.rateLimitRemaining;
      if (d?.data) { answered = d; break; }
      lastError = String(d?.errors?.[0]?.message || 'no data').slice(0, 200);
      log(`  batch of ${batch.length} failed (${lastError}), retrying smaller`);
    }
    if (!answered) {
      // the smallest batch failed too: leave these repos for the next run (metaFetchedAt untouched)
      summary.failed += batch.length;
      done += batch.length;
      i += batch.length;
      failedInARow++;
      progress(done, todo.length);
      if (failedInARow >= MAX_FAILED_BATCHES) throw new Error(`GitHub failed ${failedInARow} batches in a row: ${lastError}`);
      continue;
    }
    failedInARow = 0;
    const at = o.now();
    const ops = [];
    const before = new Map(batch.map((r) => [r._id, r]));
    for (const res of readBatch(batch, answered)) {
      summary[res.status]++;
      touched.push(res.id);
      if (res.status === 'ok' || res.status === 'renamed') {
        const set = metaSet(res.node, res.status, at);
        const old = before.get(res.id);
        if (old && ((old.stars ?? 0) !== set.stars || Boolean(old.isFork) !== set.isFork)) reclass.push(res.id);
        ops.push({ updateOne: { filter: { _id: res.id }, update: { $set: set } } });
      } else {
        ops.push({ updateOne: { filter: { _id: res.id }, update: { $set: { metaFetchedAt: at, metaStatus: res.status, metaError: res.error ?? null } } } });
      }
    }
    await bulk(c.repos, ops);
    done += batch.length;
    i += batch.length;
    progress(done, todo.length);
    if (done % 400 < batch.length || done === todo.length) {
      log(`  ${done}/${todo.length}: ${summary.ok} ok, ${summary.renamed} renamed, ${summary.missing} missing, ${summary.private} private, rate limit ${summary.rateLimitRemaining ?? '?'} left`);
    }
    await respectRateLimit(answered.data.rateLimit, o);
    if (i < todo.length) await o.sleep(PAUSE_MS);
  }
  if (touched.length) {
    const d = await recomputeDomains(db, { filter: { _id: { $in: touched } } });
    log(`technology domains: ${d.changed} of ${d.repos} repos changed`);
  }
  if (reclass.length) {
    const r = await reclassify(db, { prFilter: { repoLc: { $in: reclass } }, repoFilter: { _id: { $in: reclass } } });
    log(`stars changed on ${reclass.length} repos: ${r.prsChanged} PRs and ${r.reposChanged} repos reclassified`);
  }
  if (touched.length) await refreshAggregates(db);
  log(`done: ${summary.ok} ok, ${summary.renamed} renamed, ${summary.missing} missing, ${summary.private} private, ${summary.failed} failed, ${summary.requests} requests`);
  return summary;
}

export default repoMetaJob;
