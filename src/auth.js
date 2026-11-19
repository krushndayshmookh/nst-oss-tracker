// Admin auth (SPEC section 6): one shared password, HMAC-signed cookie, in-memory login rate limit.
import crypto from 'node:crypto';

export const COOKIE_NAME = 'oss_admin';
export const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
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

export function createAuth(config) {
  const failures = new Map(); // ip -> [timestamps of failed attempts]

  const recent = (ip, now) => {
    const list = (failures.get(ip) || []).filter((t) => now - t < WINDOW_MS);
    if (list.length) failures.set(ip, list); else failures.delete(ip);
    return list;
  };
  const cookieAttrs = () => `Path=/; HttpOnly; SameSite=Lax${config.production ? '; Secure' : ''}`;

  const auth = {
    configured: () => Boolean(config.adminPassword),
    isAdmin(req) {
      if (!config.adminPassword) return false;
      return verifyToken(parseCookies(req.headers.cookie)[COOKIE_NAME], config.sessionSecret);
    },
    /** 503 while ADMIN_PASSWORD is unset. */
    requireConfigured(req, res, next) {
      if (!config.adminPassword) return next(new ApiError(503, 'unavailable', 'admin is not configured (ADMIN_PASSWORD is unset)'));
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
    login(req, res) {
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      const now = Date.now();
      const list = recent(ip, now);
      if (list.length >= MAX_FAILURES) {
        res.set('Retry-After', String(Math.ceil((WINDOW_MS - (now - list[0])) / 1000)));
        throw new ApiError(429, 'rate_limited', 'too many failed login attempts, try again later');
      }
      const password = req.body?.password;
      if (typeof password !== 'string' || !safeEqual(password, config.adminPassword)) {
        list.push(now);
        failures.set(ip, list);
        if (failures.size > 10000) for (const k of failures.keys()) recent(k, now);
        throw new ApiError(401, 'unauthorized', 'wrong password');
      }
      failures.delete(ip);
      res.append('Set-Cookie', `${COOKIE_NAME}=${createToken(config.sessionSecret, now)}; Max-Age=${SESSION_MS / 1000}; ${cookieAttrs()}`);
      res.json({ ok: true });
    },
    logout(req, res) {
      res.append('Set-Cookie', `${COOKIE_NAME}=; Max-Age=0; ${cookieAttrs()}`);
      res.json({ ok: true });
    },
  };
  return auth;
}
