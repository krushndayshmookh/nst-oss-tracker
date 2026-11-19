// Builders for test data shaped like the GraphQL nodes in data/raw/*.json.
import { collections } from '../../src/db.js';
import { emptyStudentStats } from '../../src/ingest.js';

let seq = 0;

/** Raw PR node. `repo` is 'owner/name'. Legacy-style by default (no updatedAt / author). */
export function prNode({ repo = 'apache/airflow', number, title = 'Fix a thing', state = 'MERGED', createdAt = '2026-10-01T10:00:00Z', mergedAt, closedAt,
  stars = 5000, ownerType = 'Organization', isFork = false, isPrivate = false, isDraft = false, additions = 10, deletions = 2, author, updatedAt } = {}) {
  number ??= ++seq;
  if (mergedAt === undefined) mergedAt = state === 'MERGED' ? '2026-10-03T10:00:00Z' : null;
  if (closedAt === undefined) closedAt = state === 'OPEN' ? null : (mergedAt || '2026-10-04T10:00:00Z');
  const node = {
    url: `https://github.com/${repo}/pull/${number}`, number, title, state, isDraft, createdAt, mergedAt, closedAt,
    additions, deletions, changedFiles: 1, comments: { totalCount: 2 }, reviews: { totalCount: 1 },
    repository: {
      nameWithOwner: repo, isFork, isArchived: false, isPrivate, stargazerCount: stars, forkCount: 3, description: `${repo} description`,
      createdAt: '2020-01-01T00:00:00Z', owner: { login: repo.split('/')[0], __typename: ownerType },
      primaryLanguage: { name: 'Python' }, licenseInfo: { spdxId: 'MIT' },
    },
  };
  if (author) node.author = author;
  if (updatedAt) node.updatedAt = updatedAt;
  return node;
}

export function studentDoc({ username, name = '', campus = 'RU', batch = 2025, email = '', enrolmentNo = '', active = true, ...rest } = {}) {
  const now = new Date('2026-11-01T00:00:00Z');
  return {
    _id: username.toLowerCase(), username, githubId: null, name, nameSource: name ? 'sheet' : '', campus, batch, email, enrolmentNo,
    sources: ['test sheet'], notes: 'private note', active, backfill: { status: 'done', at: now }, lastSyncedAt: now, loginCheckedAt: null,
    addedAt: now, addedBy: 'import', stats: emptyStudentStats(), ...rest,
  };
}

export async function insertStudents(db, list) {
  const docs = list.map(studentDoc);
  await collections(db).students.insertMany(docs);
  return docs;
}
