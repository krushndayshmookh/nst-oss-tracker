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

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, 'public');

export function createApp({ db, config = loadConfig(), publicDir = PUBLIC_DIR, github = null } = {}) {
  const app = express();
  const auth = createAuth(config);
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? 1);
  app.set('etag', 'weak');
  app.set('query parser', 'simple');

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('X-Frame-Options', 'DENY');
    next();
  });

  app.use('/api', express.json({ limit: '5mb' }));
  app.use('/api/admin', adminRouter({ db, config, auth, github }));
  app.use('/api', publicRouter({ db, config, auth }));
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
    res.status(status).json({ error: { code, message } });
  });

  return app;
}

async function main() {
  const config = loadConfig();
  if (config.production) {
    if (!config.adminPassword) console.warn('WARNING: ADMIN_PASSWORD is unset: the admin API answers 503 until it is set');
    if (!config.sessionSecretSet) console.warn('WARNING: SESSION_SECRET is unset: admin sessions will not survive a restart');
  }
  const { client, db } = await connect(config);
  await ensureIndexes(db);
  await ensureRules(db);
  const app = createApp({ db, config });
  const server = app.listen(config.port, () => {
    console.log(`oss-status listening on :${config.port} (db ${config.mongoDb}, ${config.nodeEnv})`);
  });
  await startRunner(db);
  const shutdown = (signal) => {
    console.log(`${signal}: shutting down`);
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
