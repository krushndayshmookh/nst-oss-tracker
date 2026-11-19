// Client address resolution and small in-memory request limiters (login, public API, exports).
import net from 'node:net';

/** Loopback, RFC 1918, link-local, CGNAT and unique-local addresses: the in-cluster ingress, never a visitor. */
export function isPrivateAddress(addr) {
  let a = String(addr || '');
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (net.isIPv4(a)) {
    const [x, y] = a.split('.').map(Number);
    return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127);
  }
  if (net.isIPv6(a)) {
    const l = a.toLowerCase();
    return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb');
  }
  return false;
}

/** One bucket per IPv4 address or per IPv6 /64 (a single host can use every address of its /64). */
export function bucketOf(addr) {
  let a = String(addr || '').trim();
  if (a.startsWith('::ffff:') && net.isIPv4(a.slice(7))) a = a.slice(7);
  if (!net.isIPv6(a)) return a || 'unknown';
  const [head, tail = ''] = a.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = a.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * The visitor's address. Behind Cloudflare -> Traefik the TCP peer is the ingress and req.ip is a Cloudflare edge or a
 * NATed node address shared by many visitors, so `config.clientIpHeader` (CF-Connecting-IP) is used instead, but only
 * when the peer is a private address: a request that reaches the pod directly cannot pick its own bucket.
 */
export function clientIp(req, config = {}) {
  const peer = req.socket?.remoteAddress || '';
  const name = config.clientIpHeader;
  if (name && isPrivateAddress(peer)) {
    const v = String(req.headers?.[name] || '').split(',')[0].trim();
    if (net.isIP(v)) return bucketOf(v);
  }
  return bucketOf(req.ip || peer);
}

/** Fixed-window counter: at most `limit` hits per `windowMs` per key. take(key) -> { ok, retryAfter (seconds) }. */
export function createRateLimiter({ limit, windowMs = 60000, now = Date.now, maxKeys = 50000 } = {}) {
  const hits = new Map(); // key -> { start, n }
  return {
    take(key) {
      if (!(limit > 0)) return { ok: true, retryAfter: 0 };
      const t = now();
      let h = hits.get(key);
      if (!h || t - h.start >= windowMs) {
        if (hits.size >= maxKeys) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
        if (hits.size >= maxKeys) hits.clear();
        h = { start: t, n: 0 };
        hits.set(key, h);
      }
      h.n++;
      return h.n <= limit ? { ok: true, retryAfter: 0 } : { ok: false, retryAfter: Math.max(1, Math.ceil((h.start + windowMs - t) / 1000)) };
    },
  };
}
