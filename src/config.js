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

export const DEFAULT_TZ = 'Asia/Kolkata';

function tzName(v) {
  if (!v) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
    return v;
  } catch {
    return DEFAULT_TZ;
  }
}

const PLACEHOLDER = /change[-_ ]?me|^password$|^secret$|^admin$/i;

/**
 * Why the admin area must stay closed in production, or '' when the secrets are acceptable.
 * A weak shared password or a guessable cookie key would open every admin tool to the internet.
 */
export function adminProblem({ production, adminPassword, sessionSecret, sessionSecretSet }) {
  if (!adminPassword) return 'admin is not configured (ADMIN_PASSWORD is unset)';
  if (!production) return '';
  if (PLACEHOLDER.test(adminPassword)) return 'admin is not configured (ADMIN_PASSWORD is still a placeholder)';
  if (adminPassword.length < 16) return 'admin is not configured (ADMIN_PASSWORD must be at least 16 characters)';
  if (!sessionSecretSet) return 'admin is not configured (SESSION_SECRET is unset)';
  if (PLACEHOLDER.test(sessionSecret)) return 'admin is not configured (SESSION_SECRET is still a placeholder)';
  if (sessionSecret.length < 32) return 'admin is not configured (SESSION_SECRET must be at least 32 characters)';
  return '';
}

/**
 * Why the private owner page (SPEC addendum G) must stay closed, or '' when its password is acceptable.
 * It is a second, separate secret: at least 16 characters in every environment, and never the admin password.
 */
export function ownerProblem({ ownerPassword, adminPassword }) {
  if (!ownerPassword) return 'the private page is not configured (OWNER_PASSWORD is unset)';
  if (PLACEHOLDER.test(ownerPassword)) return 'the private page is not configured (OWNER_PASSWORD is still a placeholder)';
  if (ownerPassword.length < 16) return 'the private page is not configured (OWNER_PASSWORD must be at least 16 characters)';
  if (ownerPassword === adminPassword) return 'the private page is not configured (OWNER_PASSWORD must differ from ADMIN_PASSWORD)';
  return '';
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const production = nodeEnv === 'production';
  const cfg = {
    port: int(env.PORT, 3000),
    mongoUri: env.MONGODB_URI || 'mongodb://localhost:27017',
    mongoDb: env.MONGODB_DB || 'oss_status',
    adminPassword: env.ADMIN_PASSWORD || '',
    // second password of the private "Krushn's dashboard" page; the page answers 503 while it is unset or weak
    ownerPassword: env.OWNER_PASSWORD || '',
    ownerTitle: env.OWNER_TITLE || "Krushn's dashboard",
    // Random per process in dev: sessions do not survive a restart unless SESSION_SECRET is set.
    sessionSecret: env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    sessionSecretSet: Boolean(env.SESSION_SECRET),
    githubToken: env.GITHUB_TOKEN || '',
    nodeEnv,
    production,
    syncConcurrency: Math.max(1, int(env.SYNC_CONCURRENCY, 6)),
    trustProxy: trustProxy(env.TRUST_PROXY),
    // Header that carries the visitor address when the app sits behind a CDN (k8s sets CF-Connecting-IP). It is only
    // believed when the TCP peer is a private / loopback address, i.e. the in-cluster ingress.
    clientIpHeader: String(env.CLIENT_IP_HEADER || '').trim().toLowerCase(),
    tzName: tzName(env.TZ_NAME),
    // Public JSON responses are cached in memory for this long (0 disables; off in tests unless asked for).
    publicCacheMs: Math.max(0, int(env.PUBLIC_CACHE_MS, nodeEnv === 'test' ? 0 : 60000)),
    // Per-client request budgets per minute (0 disables). Exports are heavier and get their own, smaller budget.
    rateLimitPerMin: Math.max(0, int(env.RATE_LIMIT_PER_MIN, nodeEnv === 'test' ? 0 : 300)),
    exportLimitPerMin: Math.max(0, int(env.EXPORT_LIMIT_PER_MIN, nodeEnv === 'test' ? 0 : 6)),
    maxConcurrentExports: Math.max(1, int(env.MAX_CONCURRENT_EXPORTS, 2)),
    schedulerEnabled: env.SCHEDULER !== 'off',
  };
  cfg.adminProblem = adminProblem(cfg);
  cfg.ownerProblem = ownerProblem(cfg);
  return cfg;
}

export const config = loadConfig();
export default config;
