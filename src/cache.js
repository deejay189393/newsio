/**
 * A tiny in-memory TTL cache. Deliberately dependency-free: this addon runs
 * as a single container, so a Map with expiry timestamps is enough.
 *
 * Kept as its own small class (rather than inlined per-module Maps) so it's
 * easy to swap for a shared/disk-backed store later (e.g. Redis, SQLite) if
 * this ever runs as more than one instance -- every call site would just
 * need a different Cache implementation with the same get/set/has API.
 */
class TTLCache {
  /**
   * @param {number} ttlMs default time-to-live for entries, in ms
   * @param {number} [maxEntries] optional cap; the oldest entry (by insertion
   *   order) is evicted once exceeded, as a simple guard against unbounded
   *   growth from unique search queries.
   */
  constructor(ttlMs, maxEntries = 1000) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.store = new Map();
  }

  get(key) {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expires) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
    this.store.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  }

  delete(key) {
    return this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }

  get size() {
    return this.store.size;
  }
}

/**
 * Named caches used across the addon. Separate stores per concern, as each
 * has a different natural lifetime and key shape:
 *
 *   - catalogCache:   one page of results for one (topic|search, language)
 *                     query. Short TTL -- news should stay fresh.
 *   - articleCache:   individual articles keyed by our stable id, so /meta
 *                     and /stream lookups resolve without a second API call
 *                     even when the item was first seen via a different
 *                     catalog or search.
 *   - pageCursorCache: newsdata.io paginates with an opaque `nextPage` token
 *                     rather than a page number. This remembers, per query,
 *                     the token needed to fetch page N+1 once page N has
 *                     been fetched, so Stremio's numeric `skip` can be
 *                     translated into sequential token walks.
 */
const catalogCache = new TTLCache(10 * 60 * 1000, 500); // 10 minutes
const articleCache = new TTLCache(60 * 60 * 1000, 5000); // 1 hour
const pageCursorCache = new TTLCache(60 * 60 * 1000, 500); // 1 hour

function clearAllCaches() {
  catalogCache.clear();
  articleCache.clear();
  pageCursorCache.clear();
}

module.exports = { TTLCache, catalogCache, articleCache, pageCursorCache, clearAllCaches };
