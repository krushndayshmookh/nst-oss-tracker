// Express app factory + listen (SPEC section 1). createApp() never listens; running this file as main does.
import express from 'express';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { connect, ensureIndexes } from './db.js';
import { ApiError, createAuth } from './auth.js';
import { ensureRules } from './rules.js';
import { publicRouter } from './routes/public.js';
import { adminRouter } from './routes/admin.js';
import { startRunner } from './jobs.js';
import { createCache } from './cache.js';
import { clientIp, createRateLimiter } from './limits.js';
import { ensureAcademicYear } from './dates.js';
import { createOwnerAuth } from './owner.js';
import { ownerRouter } from './routes/owner.js';
import { ensurePrograms } from './programs.js';

const CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "connect-src 'self'",
  "font-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'"].join('; ');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, 'public');

export function createApp({ db, config = loadConfig(), publicDir = PUBLIC_DIR, github = null, authOptions = undefined, ownerOptions = undefined } = {}) {
  const app = express();
  const auth = createAuth(config, authOptions);
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? 1);
  app.set('etag', 'weak');
  app.set('query parser', 'simple');

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('X-Frame-Options', 'DENY');
    // The pages load only their own scripts and never build HTML from API text; the policy contains a future slip.
    res.set('Content-Security-Policy', CSP);
    if (config.production) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  // Per-visitor request budgets (in memory, replicas: 1). A logged-in admin and the health probes are not limited.
  const general = createRateLimiter({ limit: config.rateLimitPerMin ?? 0 });
  const exportsLimit = createRateLimiter({ limit: config.exportLimitPerMin ?? 0 });
  app.use('/api', (req, res, next) => {
    if (req.path === '/health' || auth.isAdmin(req)) return next();
    const ip = clientIp(req, config);
    let verdict = general.take(ip);
    if (verdict.ok && req.path.startsWith('/export/')) verdict = exportsLimit.take(ip);
    if (verdict.ok) return next();
    res.set('Retry-After', String(verdict.retryAfter));
    next(new ApiError(429, 'rate_limited', 'too many requests, slow down'));
  });

  // Only the admin API reads request bodies. Bodies are small, except the bulk CSV upload of a logged-in admin.
  const smallJson = express.json({ limit: '100kb' });
  const bulkJson = express.json({ limit: '5mb' });
  app.use('/api/admin', (req, res, next) => (req.path === '/students/bulk' && auth.isAdmin(req) ? bulkJson : smallJson)(req, res, next));
  const cache = createCache({ ttlMs: config.publicCacheMs ?? 0 });
  app.use('/api/admin', adminRouter({ db, config, auth, github }));
  // The private page (SPEC addendum G): admin session + a second password. Mounted before the public router and
  // never given the shared cache, so nothing it returns can be cached or served to anyone else.
  const owner = createOwnerAuth(config, auth, ownerOptions);
  const ownerJson = express.json({ limit: '2mb' }); // outcome CSV uploads; only once the page is unlocked
  app.use('/api/owner', (req, res, next) => (owner.isUnlocked(req) ? ownerJson : smallJson)(req, res, next), ownerRouter({ db, config, owner }));
  app.use('/api', publicRouter({ db, config, auth, cache }));
  app.use('/api', (req, res, next) => next(new ApiError(404, 'not_found', `no such endpoint: ${req.method} ${req.baseUrl}${req.path}`)));

  app.get('/admin', (req, res, next) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile('admin.html', { root: publicDir }, (err) => { if (err) next(); });
  });
  app.use(express.static(publicDir, {
    extensions: ['html'],
    setHeaders(res, file) {
      // No build step, so no content hashes: always revalidate (ETag makes that cheap), except the vendored library.
      res.set('Cache-Control', file.includes(`${path.sep}vendor${path.sep}`) ? 'public, max-age=86400' : 'no-cache');
    },
  }));
  app.use((req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return res.destroy();
    let status = err instanceof ApiError ? err.status : (Number.isInteger(err?.status) ? err.status : 500);
    if (status < 400 || status > 599) status = 500;
    let code = err instanceof ApiError ? err.code : null;
    let message = err?.message || 'error';
    if (!code) {
      if (err?.type === 'entity.too.large') { status = 413; code = 'bad_request'; message = 'request body too large'; }
      else if (status === 400 || err?.type === 'entity.parse.failed') { status = 400; code = 'bad_request'; message = 'invalid request body'; }
      else if (status === 404) code = 'not_found';
      else if (status < 500) code = 'bad_request';
      else {
        code = 'internal';
        message = 'internal error';
        if (config.nodeEnv !== 'test') console.error(`${req.method} ${req.originalUrl}:`, err);
      }
    }
    if (!req.originalUrl.startsWith('/api')) return res.status(status).type('text/plain').send(message);
    res.set('Cache-Control', 'no-store');
    res.status(status).json({ error: { code, message, ...(err instanceof ApiError && err.extra ? err.extra : {}) } });
  });

  return app;
}

async function main() {
  const config = loadConfig();
  if (config.production) {
    // Weak or placeholder secrets never open the admin area: it answers 503 until they are fixed. The public site still runs.
    if (config.adminProblem) console.warn(`WARNING: the admin area is closed: ${config.adminProblem}`);
  }
  const { client, db } = await connect(config);
  await ensureIndexes(db);
  await ensureRules(db);
  await ensureAcademicYear(db);
  await ensurePrograms(db);
  if (config.ownerProblem && config.ownerPassword) console.warn(`WARNING: the private page is closed: ${config.ownerProblem}`);
  const app = createApp({ db, config });
  // Listen first and only then start the job runner and the scheduler: a process that cannot bind its port (already in
  // use) must exit instead of staying alive as a second, invisible scheduler. Express 5 passes the listen error to the
  // callback rather than throwing it.
  const server = await new Promise((resolve, reject) => {
    const srv = app.listen(config.port, (err) => (err ? reject(err) : resolve(srv)));
    srv.once('error', reject);
  });
  console.log(`oss-status listening on :${config.port} (db ${config.mongoDb}, ${config.nodeEnv})`);
  await startRunner(db);
  let scheduler = null;
  if (config.schedulerEnabled) {
    const { startScheduler } = await import('./scheduler.js');
    scheduler = await startScheduler(db, { tz: config.tzName, concurrency: config.syncConcurrency });
  }
  const shutdown = (signal) => {
    console.log(`${signal}: shutting down`);
    scheduler?.stop();
    server.close(() => client.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('fatal:', e);
    process.exit(1);
  });
}
