const { TTLCache, catalogCache, articleCache, pageCursorCache, clearAllCaches } = require("../src/cache");

describe("TTLCache", () => {
  test("stores and retrieves a value", () => {
    const cache = new TTLCache(1000);
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    expect(cache.has("a")).toBe(true);
  });

  test("set returns the stored value", () => {
    expect(new TTLCache(1000).set("a", "v")).toBe("v");
  });

  test("returns undefined for a missing key", () => {
    const cache = new TTLCache(1000);
    expect(cache.get("missing")).toBeUndefined();
    expect(cache.has("missing")).toBe(false);
  });

  test("expires entries after their TTL", () => {
    jest.useFakeTimers();
    const cache = new TTLCache(1000);
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    jest.advanceTimersByTime(1001);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0); // expired entry is actively removed
    jest.useRealTimers();
  });

  test("has() also reports false once expired", () => {
    jest.useFakeTimers();
    const cache = new TTLCache(100);
    cache.set("a", 1);
    jest.advanceTimersByTime(101);
    expect(cache.has("a")).toBe(false);
    jest.useRealTimers();
  });

  test("a per-entry ttl overrides the default", () => {
    jest.useFakeTimers();
    const cache = new TTLCache(100000);
    cache.set("short", "x", 10);
    jest.advanceTimersByTime(20);
    expect(cache.get("short")).toBeUndefined();
    jest.useRealTimers();
  });

  test("can cache a falsy value without it looking absent", () => {
    const cache = new TTLCache(1000);
    cache.set("zero", 0);
    cache.set("null", null);
    expect(cache.get("zero")).toBe(0);
    expect(cache.get("null")).toBeNull();
  });

  test("delete removes a key and reports whether it existed", () => {
    const cache = new TTLCache(1000);
    cache.set("a", 1);
    expect(cache.delete("a")).toBe(true);
    expect(cache.delete("a")).toBe(false);
    expect(cache.get("a")).toBeUndefined();
  });

  test("clear empties the whole cache", () => {
    const cache = new TTLCache(1000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  test("evicts the oldest entry once maxEntries is exceeded", () => {
    const cache = new TTLCache(1000, 2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // evicts "a"
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  test("overwriting an existing key does not evict another key", () => {
    const cache = new TTLCache(1000, 2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 99);
    expect(cache.get("a")).toBe(99);
    expect(cache.get("b")).toBe(2);
    expect(cache.size).toBe(2);
  });

  test("eviction is a no-op safety path when the store is somehow empty", () => {
    const cache = new TTLCache(1000, 0); // maxEntries 0 forces the eviction branch on an empty store
    expect(() => cache.set("a", 1)).not.toThrow();
    expect(cache.get("a")).toBe(1);
  });
});

describe("shared named caches", () => {
  test("the three stores are distinct instances", () => {
    expect(catalogCache).not.toBe(articleCache);
    expect(articleCache).not.toBe(pageCursorCache);
    expect(catalogCache).not.toBe(pageCursorCache);
  });

  test("clearAllCaches empties all three", () => {
    catalogCache.set("k", 1);
    articleCache.set("k", 1);
    pageCursorCache.set("k", 1);
    clearAllCaches();
    expect(catalogCache.size).toBe(0);
    expect(articleCache.size).toBe(0);
    expect(pageCursorCache.size).toBe(0);
  });

  test("article cache holds items longer than the catalog cache", () => {
    expect(articleCache.ttlMs).toBeGreaterThan(catalogCache.ttlMs);
  });
});
