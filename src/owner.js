// Second lock of the private page (SPEC addendum G1).
//
// The page opens only for a request that carries BOTH a valid admin session and a valid owner cookie. The owner cookie
// is separate (`oss_owner`), httpOnly, limited to /api/owner, lives 2 hours, and is signed with a key derived from
// SESSION_SECRET, OWNER_PASSWORD and ADMIN_PASSWORD: rotating any of the three locks the page everywhere.
// Unlocking has the same guards as the admin login: constant-time compare, per-visitor limit, global slow-down, CSRF header.
import crypto from 'node:crypto';
import { ApiError, GLOBAL_SLOW_AFTER, GLOBAL_SLOW_MS, parseCookies, safeEqual } from './auth.js';
import { clientIp } from './limits.js';
import { ownerProblem } from './config.js';

export const OWNER_COOKIE = 'oss_owner';
export const OWNER_SESSION_MS = 2 * 60 * 60 * 1000;
export const OWNER_COOKIE_PATH = '/api/owner';
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;

function ownerKey(config) {
  return crypto.createHmac('sha256', String(config.sessionSecret)).update(`owner:${config.ownerPassword}\n${config.adminPassword}`).digest();
}
const sign = (payload, key) => crypto.createHmac('sha256', key).update(payload).digest('base64url');

export function createOwnerToken(key, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ exp: now + OWNER_SESSION_MS, n: crypto.randomBytes(6).toString('hex'), k: 'owner' })).toString('base64url');
  return `${payload}.${sign(payload, key)}`;
}

/** -> expiry in ms since the epoch, or 0 when the token is missing, forged, of another kind, or expired. */
export function verifyOwnerToken(token, key, now = Date.now()) {
  if (typeof token !== 'string') return 0;
  const dot = token.indexOf('.');
  if (dot <= 0) return 0;
  const payload = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(payload, key));
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return 0;
  try {
    const { exp, k } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return k === 'owner' && typeof exp === 'number' && exp > now ? exp : 0;
  } catch {
    return 0;
  }
}

const unauthorized = (reason, message) => new ApiError(401, 'unauthorized', message, { reason });

/**
 * `auth` is the admin auth of the app (createAuth). `now` and `sleep` are injectable for tests.
 */
export function createOwnerAuth(config, auth, { now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const failures = new Map(); // visitor address -> [timestamps of failed attempts]
  let allFailures = [];
  const problem = () => ownerProblem(config);
  const cookieAttrs = () => `Path=${OWNER_COOKIE_PATH}; HttpOnly; SameSite=Strict${config.production ? '; Secure' : ''}`;
  const recent = (ip, t) => {
    const list = (failures.get(ip) || []).filter((x) => t - x < WINDOW_MS);
    if (list.length) failures.set(ip, list); else failures.delete(ip);
    return list;
  };

  const owner = {
    configured: () => !problem(),
    isAdminRequest: (req) => auth.isAdmin(req),
    /** Expiry (ms) of this request's unlock, or 0. Needs the admin session as well. */
    expiry(req) {
      if (problem() || !auth.isAdmin(req)) return 0;
      return verifyOwnerToken(parseCookies(req.headers.cookie)[OWNER_COOKIE], ownerKey(config), now());
    },
    isUnlocked: (req) => owner.expiry(req) > 0,
    requireConfigured(req, res, next) {
      if (problem()) return next(new ApiError(503, 'unavailable', problem()));
      next();
    },
    requireAdmin(req, res, next) {
      if (!auth.isAdmin(req)) return next(unauthorized('admin', 'admin login required'));
      next();
    },
    /** Admin session AND owner cookie. Anything less is 401, also for a logged-in admin. */
    requireOwner(req, res, next) {
      if (!auth.isAdmin(req)) return next(unauthorized('admin', 'admin login required'));
      if (!owner.isUnlocked(req)) return next(unauthorized('owner', 'this page is locked: enter its password'));
      next();
    },
    async unlock(req, res) {
      const ip = clientIp(req, config);
      let t = now();
      const list = recent(ip, t);
      if (list.length >= MAX_FAILURES) {
        res.set('Retry-After', String(Math.ceil((WINDOW_MS - (t - list[0])) / 1000)));
        throw new ApiError(429, 'rate_limited', 'too many wrong passwords, try again later');
      }
      allFailures = allFailures.filter((x) => t - x < WINDOW_MS);
      if (allFailures.length >= GLOBAL_SLOW_AFTER) {
        await sleep(GLOBAL_SLOW_MS);
        t = now();
      }
      const password = req.body?.password;
      if (typeof password !== 'string' || !safeEqual(password, config.ownerPassword)) {
        const mine = recent(ip, t);
        mine.push(t);
        failures.set(ip, mine);
        allFailures.push(t);
        if (allFailures.length > 5000) allFailures = allFailures.slice(-1000);
        if (failures.size > 10000) for (const k of failures.keys()) recent(k, t);
        throw unauthorized('password', 'wrong password');
      }
      failures.delete(ip);
      const token = createOwnerToken(ownerKey(config), t);
      res.append('Set-Cookie', `${OWNER_COOKIE}=${token}; Max-Age=${OWNER_SESSION_MS / 1000}; ${cookieAttrs()}`);
      res.json({ ok: true, expiresAt: new Date(t + OWNER_SESSION_MS).toISOString() });
    },
    lock(req, res) {
      res.append('Set-Cookie', `${OWNER_COOKIE}=; Max-Age=0; ${cookieAttrs()}`);
      res.json({ ok: true });
    },
  };
  return owner;
}
