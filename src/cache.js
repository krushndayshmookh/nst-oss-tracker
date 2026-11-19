// Small in-memory TTL caches for public responses and ranged aggregates (SPEC addendum A2).
// Every cache registers itself so that an admin write or the end of a job can drop everything at once.
//
// Memory is bounded on purpose: anyone can ask for any date range, so a cache that grows with the number of distinct
// queries is a way to take the process down. Entries are counted (`max`) and, with `maxBytes`, weighed: strings by
// their length (2 bytes per character, the worst case in V8), other values by the `weigh` function of the cache.
const registry = new Set();
let gen = 0;

/** Changes whenever everything was invalidated: a value computed under an older generation must not be stored. */
export const generation = () => gen;

export function createCache({ ttlMs = 60000, max = 500, maxBytes = 0, weigh = null, now = Date.now } = {}) {
  const map = new Map(); // key -> { at, value, bytes }, least recently used first
  let bytes = 0;
  const weight = (value) => {
    if (!maxBytes) return 0;
    if (typeof value === 'string') return value.length * 2;
    return weigh ? Number(weigh(value)) || 0 : 0;
  };
  const drop = (key) => {
    const e = map.get(key);
    if (!e) return;
    bytes -= e.bytes;
    map.delete(key);
  };
  const cache = {
    enabled: ttlMs > 0,
    get(key) {
      if (ttlMs <= 0) return undefined;
      const hit = map.get(key);
      if (!hit) return undefined;
      if (now() - hit.at >= ttlMs) { drop(key); return undefined; }
      map.delete(key); // least recently used entries go first
      map.set(key, hit);
      return hit.value;
    },
    set(key, value) {
      if (ttlMs <= 0) return;
      drop(key);
      const size = weight(value);
      if (maxBytes && size > maxBytes) return; // would not fit even alone
      map.set(key, { at: now(), value, bytes: size });
      bytes += size;
      while (map.size > max || (maxBytes && bytes > maxBytes)) drop(map.keys().next().value);
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
        if (map.get(key)?.value === p) drop(key);
        throw e;
      }
    },
    clear() { map.clear(); bytes = 0; },
    get size() { return map.size; },
    get bytes() { return bytes; },
  };
  registry.add(cache);
  return cache;
}

/** Drops every cached value in this process (called after admin writes and when a job ends). */
export function invalidateAll() {
  gen++;
  for (const c of registry) c.clear();
}
