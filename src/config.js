// Environment parsing (SPEC section 8). No secrets live in the repo.
import crypto from 'node:crypto';

function int(v, def) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function trustProxy(v) {
  if (v === undefined || v === '') return 1;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return /^\d+$/.test(v) ? Number(v) : v;
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const production = nodeEnv === 'production';
  return {
    port: int(env.PORT, 3000),
    mongoUri: env.MONGODB_URI || 'mongodb://localhost:27017',
    mongoDb: env.MONGODB_DB || 'oss_status',
    adminPassword: env.ADMIN_PASSWORD || '',
    // Random per process in dev: sessions do not survive a restart unless SESSION_SECRET is set.
    sessionSecret: env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    sessionSecretSet: Boolean(env.SESSION_SECRET),
    githubToken: env.GITHUB_TOKEN || '',
    nodeEnv,
    production,
    syncConcurrency: Math.max(1, int(env.SYNC_CONCURRENCY, 6)),
    trustProxy: trustProxy(env.TRUST_PROXY),
  };
}

export const config = loadConfig();
export default config;
