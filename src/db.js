// Mongo connection, collection handles and indexes (SPEC section 2).
import { MongoClient } from 'mongodb';
import { loadConfig } from './config.js';

export const COLLECTIONS = ['students', 'prs', 'repos', 'owners', 'settings', 'jobs'];

export async function connect(cfg = loadConfig()) {
  const client = new MongoClient(cfg.mongoUri, { serverSelectionTimeoutMS: cfg.serverSelectionTimeoutMS ?? 10000 });
  await client.connect();
  const db = client.db(cfg.mongoDb);
  return { client, db };
}

export function collections(db) {
  return {
    students: db.collection('students'),
    prs: db.collection('prs'),
    repos: db.collection('repos'),
    owners: db.collection('owners'),
    settings: db.collection('settings'),
    jobs: db.collection('jobs'),
  };
}

export async function ensureIndexes(db) {
  const c = collections(db);
  await Promise.all([
    c.prs.createIndexes([
      { key: { author: 1, createdAt: -1 } },
      { key: { repoLc: 1 } },
      { key: { ownerLc: 1 } },
      { key: { category: 1, state: 1, createdAt: -1 } },
      { key: { campus: 1, batch: 1 } },
      { key: { createdAt: -1 } },
    ]),
    c.students.createIndexes([
      { key: { campus: 1, batch: 1 } },
      { key: { 'stats.osMerged': -1 } },
    ]),
    c.repos.createIndexes([
      { key: { ownerLc: 1 } },
      { key: { 'stats.prs': -1 } },
    ]),
    c.jobs.createIndexes([{ key: { createdAt: -1 } }]),
  ]);
}
