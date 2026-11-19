// Admin auth (SPEC section 6): one shared password, HMAC-signed cookie, in-memory login rate limit.
import crypto from 'node:crypto';
import { clientIp } from './limits.js';
import { adminProblem } from './config.js';

export const COOKIE_NAME = 'oss_admin';
export const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;
// Above this many failed logins from ALL addresses in the window, every login attempt is answered slowly. Nobody is
// locked out by somebody else's guesses (the hard limit is per visitor address), yet guessing spread over many addresses is throttled.
export const GLOBAL_SLOW_AFTER = 30;
export const GLOBAL_SLOW_MS = 1500;

export class ApiError extends Error {
  constructor(status, code, message, extra = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra; // additional fields for the error object, e.g. { jobId }
  }
}
export const badRequest = (m) => new ApiError(400, 'bad_request', m);
export const notFound = (m) => new ApiError(404, 'not_found', m);

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createToken(secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ exp: now + SESSION_MS, n: crypto.randomBytes(6).toString('hex') })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(payload, secret));
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof exp === 'number' && exp > now;
  } catch {
    return false;
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

/** Constant-time string compare (hash both sides so lengths do not leak). */
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Cookie signing key. It depends on both secrets, so rotating ADMIN_PASSWORD signs every admin out
 * (sessions are stateless: there is nothing else to revoke).
 */
export function cookieKey(config) {
  return crypto.createHmac('sha256', String(config.sessionSecret)).update(`cookie:${config.adminPassword}`).digest();
}

export function createAuth(config, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const failures = new Map(); // visitor address -> [timestamps of failed attempts]
  let allFailures = [];       // timestamps of failed attempts from every address
  const key = cookieKey(config);
  const problem = () => adminProblem(config);

  const recent = (ip, now) => {
    const list = (failures.get(ip) || []).filter((t) => now - t < WINDOW_MS);
    if (list.length) failures.set(ip, list); else failures.delete(ip);
    return list;
  };
  const cookieAttrs = () => `Path=/; HttpOnly; SameSite=Lax${config.production ? '; Secure' : ''}`;

  const auth = {
    configured: () => !problem(),
    isAdmin(req) {
      if (problem()) return false;
      return verifyToken(parseCookies(req.headers.cookie)[COOKIE_NAME], key);
    },
    /** 503 while ADMIN_PASSWORD is unset or, in production, while either secret is weak or a placeholder. */
    requireConfigured(req, res, next) {
      if (problem()) return next(new ApiError(503, 'unavailable', problem()));
      next();
    },
    /** State-changing requests must carry X-Requested-With: oss-admin. */
    requireCsrfHeader(req, res, next) {
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
      if (req.get('x-requested-with') !== 'oss-admin') return next(new ApiError(403, 'forbidden', 'missing X-Requested-With: oss-admin header'));
      next();
    },
    requireAdmin(req, res, next) {
      if (!auth.isAdmin(req)) return next(new ApiError(401, 'unauthorized', 'admin login required'));
      next();
    },
    async login(req, res) {
      const ip = clientIp(req, config);
      let now = Date.now();
      const list = recent(ip, now);
      if (list.length >= MAX_FAILURES) {
        res.set('Retry-After', String(Math.ceil((WINDOW_MS - (now - list[0])) / 1000)));
        throw new ApiError(429, 'rate_limited', 'too many failed login attempts, try again later');
      }
      allFailures = allFailures.filter((t) => now - t < WINDOW_MS);
      if (allFailures.length >= GLOBAL_SLOW_AFTER) {
        await sleep(GLOBAL_SLOW_MS);
        now = Date.now();
      }
      const password = req.body?.password;
      if (typeof password !== 'string' || !safeEqual(password, config.adminPassword)) {
        const mine = recent(ip, now);
        mine.push(now);
        failures.set(ip, mine);
        allFailures.push(now);
        if (allFailures.length > 5000) allFailures = allFailures.slice(-1000);
        if (failures.size > 10000) for (const k of failures.keys()) recent(k, now);
        throw new ApiError(401, 'unauthorized', 'wrong password');
      }
      failures.delete(ip);
      res.append('Set-Cookie', `${COOKIE_NAME}=${createToken(key, now)}; Max-Age=${SESSION_MS / 1000}; ${cookieAttrs()}`);
      res.json({ ok: true });
    },
    logout(req, res) {
      res.append('Set-Cookie', `${COOKIE_NAME}=; Max-Age=0; ${cookieAttrs()}`);
      res.json({ ok: true });
    },
  };
  return auth;
}
