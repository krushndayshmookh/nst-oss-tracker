// Issues raised and reviews given (SPEC addendum I1 / I3): raw search nodes -> `contributions` documents, plus the
// repo / owner metadata of every item (upserted exactly as for PRs, so classification and admin overrides apply).
//
//   buildContributionDocs(student, kind, nodes) -> { docs, repos, owners, skippedPrivate }        pure, no DB
//   upsertContributions(db, student, kind, nodes) -> { contributions, added, repos }             no aggregates
//   pruneStaleContributions(db, student, kind, nodes) -> { removed, skipped }                    after a COMPLETE full fetch
import { classify, loadContext, reclassify } from './classify.js';
import { bulk, ownerUpsertOp, parseLanguages, parseTopics, repoUpsertOp } from './ingest.js';
import { recomputeDomains } from './tech.js';

export const KINDS = ['issue', 'review'];
const lc = (s) => String(s ?? '').toLowerCase();
const date = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const num = (v) => (Number.isFinite(v) ? v : 0);
const collapse = (s) => String(s ?? '').split(/\s+/).filter(Boolean).join(' ');
const STATE_REASONS = new Set(['completed', 'not_planned', 'duplicate', 'reopened']);
const DECISIVE = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
const contributions = (db) => db.collection('contributions');

function checkKind(kind) {
  if (!KINDS.includes(kind)) throw new Error(`unknown contribution kind: ${kind}`);
}

/** The repo / owner part shared with PRs (same fields as ingest.buildDocs). */
function repoParts(r) {
  const repo = r.nameWithOwner;
  const repoLc = lc(repo);
  const owner = r.owner?.login || repo.split('/')[0];
  const ownerLc = lc(owner);
  const ownerType = r.owner?.__typename === 'Organization' ? 'Organization' : 'User';
  const stars = num(r.stargazerCount);
  const languages = parseLanguages(r.languages);
  const topics = parseTopics(r.repositoryTopics);
  const repoDoc = {
    _id: repoLc, name: repo, owner, ownerLc, ownerType, stars, forks: num(r.forkCount),
    isFork: Boolean(r.isFork), isArchived: Boolean(r.isArchived), language: r.primaryLanguage?.name ?? null,
    license: r.licenseInfo?.spdxId ?? null, description: r.description ?? null,
    ...(languages && { languages }), ...(topics && { topics }),
  };
  return { repo, repoLc, owner, ownerLc, ownerType, stars, repoDoc, ownerDoc: { _id: ownerLc, login: owner, type: ownerType } };
}

function issueDoc(student, n, p) {
  const reason = lc(n.stateReason);
  return {
    _id: n.url, kind: 'issue', url: n.url, number: num(n.number), title: collapse(n.title),
    ...(Number.isFinite(n.databaseId) && { ghId: n.databaseId }),
    state: n.state === 'OPEN' ? 'open' : 'closed', stateReason: STATE_REASONS.has(reason) ? reason : null,
    createdAt: date(n.createdAt), closedAt: date(n.closedAt), updatedAt: date(n.updatedAt),
    comments: num(n.comments?.totalCount),
    authorLogin: n.author?.login || student.username || student._id,
  };
}

/** null when the PR is the student's own or carries no submitted review by the student. */
function reviewDoc(student, n, mine) {
  if (mine.has(lc(n.author?.login))) return null;
  const listed = (n.reviews?.nodes || []).filter(Boolean);
  const submitted = listed.filter((v) => v.state !== 'PENDING' && date(v.submittedAt))
    .sort((a, b) => date(a.submittedAt) - date(b.submittedAt));
  if (!submitted.length) return null;
  const first = submitted[0];
  const last = submitted.at(-1);
  const decisive = submitted.filter((v) => DECISIVE.has(v.state)).at(-1);
  // reviews(last:50): above 50 the older reviews not listed still count (totalCount may include a pending one: rare);
  // createdAt is then the earliest listed review, and upsertContributions never moves a stored createdAt later ($min)
  const unlisted = Math.max(0, num(n.reviews?.totalCount) - listed.length);
  return {
    _id: `${n.url}#review-by-${student._id}`, kind: 'review', url: last.url || n.url, number: num(n.number), title: collapse(n.title),
    state: decisive ? lc(decisive.state) : 'commented',
    createdAt: date(first.submittedAt), closedAt: null, updatedAt: date(n.updatedAt),
    prUrl: n.url, prAuthor: n.author?.login ?? null,
    prState: n.mergedAt || n.state === 'MERGED' ? 'merged' : (n.state === 'OPEN' ? 'open' : 'closed'),
    reviewCount: submitted.length + unlisted, lastReviewedAt: date(last.submittedAt),
    authorLogin: student.username || student._id,
  };
}

/**
 * Raw issue / reviewed-PR nodes of one student -> plain `contributions` documents (no classification).
 * Skips null nodes, nodes without url / repository, private repositories, duplicates, and for reviews the student's
 * own PRs and PRs without a submitted review by the student (PENDING reviews are ignored).
 * -> { docs: [doc], repos: Map<repoLc, doc>, owners: Map<ownerLc, doc>, skippedPrivate }
 */
export function buildContributionDocs(student, kind, nodes) {
  checkKind(kind);
  const docs = [];
  const repos = new Map();
  const owners = new Map();
  const seen = new Set();
  const mine = new Set([lc(student._id), lc(student.username)].filter(Boolean));
  let skippedPrivate = 0;
  for (const n of nodes || []) {
    const r = n?.repository;
    if (!n || !n.url || !r || !r.nameWithOwner) continue;
    if (r.isPrivate) { skippedPrivate++; continue; }
    const p = repoParts(r);
    const own = kind === 'issue' ? issueDoc(student, n, p) : reviewDoc(student, n, mine);
    if (!own || seen.has(own._id)) continue;
    seen.add(own._id);
    const { _id, kind: k, url, number, title, authorLogin, ...rest } = own;
    docs.push({
      _id, kind: k, url, number, title, author: student._id, authorLogin,
      repo: p.repo, repoLc: p.repoLc, owner: p.owner, ownerLc: p.ownerLc, ownerType: p.ownerType, stars: p.stars,
      ...rest,
      campus: student.campus ?? 'Unknown', batch: student.batch ?? null, active: student.active !== false,
    });
    repos.set(p.repoLc, p.repoDoc);
    owners.set(p.ownerLc, p.ownerDoc);
  }
  return { docs, repos, owners, skippedPrivate };
}

const strip = ({ _id, ...rest }) => rest;

/**
 * Upserts the issues or reviews of one student ($set of every field), upserts repo / owner metadata (overrides and stats
 * preserved) and classifies each item like a PR by this author on that repo (no per-item override). A repo whose class
 * changed (stars crossed a threshold) gets its stored PRs and contributions reclassified. A stored issue of the student
 * with the same GitHub id under another url (transferred issue, renamed repo) is deleted. Does NOT touch aggregates.
 * -> { contributions: n, added: n (documents that did not exist before), repos: n }
 */
export async function upsertContributions(db, student, kind, nodes) {
  const { docs, repos, owners } = buildContributionDocs(student, kind, nodes);
  if (!docs.length && !repos.size) return { contributions: 0, added: 0, repos: 0 };
  const ctx = await loadContext(db, { fresh: false });
  const repoIds = [...repos.keys()];
  const ids = docs.map((d) => d._id);
  const [repoOv, ownerOv, existing] = await Promise.all([
    db.collection('repos').find({ _id: { $in: repoIds } }, { projection: { override: 1, category: 1, tier: 1 } }).toArray(),
    db.collection('owners').find({ _id: { $in: [...owners.keys()] }, override: { $ne: null } }, { projection: { override: 1 } }).toArray(),
    contributions(db).find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray(),
  ]);
  const repoOverride = new Map(repoOv.filter((r) => r.override).map((r) => [r._id, r.override]));
  const repoBefore = new Map(repoOv.map((r) => [r._id, r]));
  const ownerOverride = new Map(ownerOv.map((o) => [o._id, o.override]));
  const drifted = [];

  const repoOps = [];
  for (const r of repos.values()) {
    const cls = classify({ repo: r._id, ownerType: r.ownerType, stars: r.stars, isFork: r.isFork,
      repoOverride: repoOverride.get(r._id) ?? null, ownerOverride: ownerOverride.get(r.ownerLc) ?? null }, ctx);
    repoOps.push(repoUpsertOp(r, cls));
    const before = repoBefore.get(r._id);
    if (before && (before.category !== cls.category || (before.tier ?? null) !== cls.tier)) drifted.push(r._id);
  }
  const ops = docs.map((d) => {
    const r = repos.get(d.repoLc);
    const cls = classify({ repo: d.repoLc, ownerType: r.ownerType, stars: r.stars, isFork: r.isFork,
      repoOverride: repoOverride.get(d.repoLc) ?? null, ownerOverride: ownerOverride.get(d.ownerLc) ?? null,
      author: student._id }, ctx);
    if (kind !== 'review') return { updateOne: { filter: { _id: d._id }, update: { $set: { ...strip(d), ...cls } }, upsert: true } };
    const { createdAt, ...rest } = strip(d); // the first review date only moves earlier
    return { updateOne: { filter: { _id: d._id }, update: { $set: { ...rest, ...cls }, $min: { createdAt } }, upsert: true } };
  });
  await Promise.all([
    bulk(db.collection('repos'), repoOps),
    bulk(db.collection('owners'), [...owners.values()].map((o) => ownerUpsertOp(o))),
  ]);
  await bulk(contributions(db), ops);
  // an issue transferred to another repo (or a renamed repo) comes back under a new url with the same GitHub id:
  // the document under the old url goes, on incremental runs too
  const ghIds = kind === 'issue' ? docs.map((d) => d.ghId).filter((v) => v !== undefined) : [];
  if (ghIds.length) await contributions(db).deleteMany({ author: student._id, kind: 'issue', ghId: { $in: ghIds }, _id: { $nin: ids } });
  if (drifted.length) {
    const f = { repoLc: { $in: drifted } };
    await reclassify(db, { prFilter: f, repoFilter: null, contribFilter: f, ctx });
  }
  await recomputeDomains(db, { filter: { _id: { $in: repoIds } } });
  const had = new Set(existing.map((e) => e._id));
  return { contributions: docs.length, added: ids.filter((id) => !had.has(id)).length, repos: repos.size };
}

/**
 * After a COMPLETE full fetch of one kind: deletes the student's stored documents of that kind that the fetch did not
 * return (repo renamed / deleted / made private, issue deleted, review removed). Guards as in pruneStalePRs: nothing is
 * removed when the fetch returned nothing, or when more than 20 and more than half of the stored documents would vanish
 * (an issue that came back under a new url with the same GitHub id is not counted as vanished).
 * `nodes` are the raw nodes of the fetch. -> { removed, skipped: '' | reason }
 */
export async function pruneStaleContributions(db, student, kind, nodes) {
  const fetched = buildContributionDocs(student, kind, nodes).docs;
  const out = { removed: 0, skipped: '' };
  const stored = await contributions(db).find({ author: student._id, kind }, { projection: { _id: 1, ghId: 1 } }).toArray();
  const ids = new Set(fetched.map((d) => d._id));
  const staleDocs = stored.filter((d) => !ids.has(d._id));
  const stale = staleDocs.map((d) => d._id);
  if (!stale.length) return out;
  const noun = kind === 'issue' ? 'issues' : 'reviews';
  if (!fetched.length) { out.skipped = `GitHub returned no ${noun} but ${stored.length} are stored`; return out; }
  // an issue fetched again under a new url (same GitHub id) has moved, it has not vanished: it does not count for the guard
  const fetchedGhIds = new Set(fetched.map((d) => d.ghId).filter((v) => v !== undefined));
  const vanished = staleDocs.filter((d) => d.ghId === undefined || !fetchedGhIds.has(d.ghId)).length;
  if (vanished > 20 && vanished > stored.length / 2) {
    out.skipped = `${vanished} of ${stored.length} stored ${noun} are missing from the fetch`;
    return out;
  }
  const res = await contributions(db).deleteMany({ author: student._id, kind, _id: { $in: stale } });
  out.removed = res.deletedCount ?? stale.length;
  return out;
}

export default { KINDS, buildContributionDocs, upsertContributions, pruneStaleContributions };
