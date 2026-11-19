// Small in-memory TTL cache for public responses and ranged aggregates (SPEC addendum A2).
// Every cache registers itself so that an admin write or the end of a job can drop everything at once.
const registry = new Set();

export function createCache({ ttlMs = 60000, max = 500, now = Date.now } = {}) {
  const map = new Map(); // key -> { at, value }
  const cache = {
    enabled: ttlMs > 0,
    get(key) {
      if (ttlMs <= 0) return undefined;
      const hit = map.get(key);
      if (!hit) return undefined;
      if (now() - hit.at >= ttlMs) { map.delete(key); return undefined; }
      return hit.value;
    },
    set(key, value) {
      if (ttlMs <= 0) return;
      map.delete(key);
      map.set(key, { at: now(), value });
      while (map.size > max) map.delete(map.keys().next().value); // oldest first
    },
    /** Returns the cached value for `key` or computes it once (concurrent callers share the same promise). */
    async memo(key, fn) {
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const p = Promise.resolve().then(fn);
      cache.set(key, p);
      try {
        return await p;
      } catch (e) {
        if (map.get(key)?.value === p) map.delete(key);
        throw e;
      }
    },
    clear() { map.clear(); },
    get size() { return map.size; },
  };
  registry.add(cache);
  return cache;
}

/** Drops every cached value in this process (called after admin writes and when a job ends). */
export function invalidateAll() {
  for (const c of registry) c.clear();
}
