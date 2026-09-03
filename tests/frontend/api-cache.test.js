import { describe, expect, it, vi } from "vitest";
import {
  cachedFetch,
  getCached,
  getCachedAt,
  invalidateCache,
  invalidateCachePrefix,
  setCached,
} from "../../lib/public/js/lib/api-cache.js";

// The cache is module-level state, so every test uses its own key.

describe("frontend/api-cache", () => {
  it("gets, sets, and invalidates cache entries", () => {
    expect(getCached("")).toBe(null);
    expect(getCached("never-set")).toBe(null);

    expect(setCached("basic-key", { a: 1 })).toEqual({ a: 1 });
    expect(getCached("basic-key")).toEqual({ a: 1 });

    // Empty keys are no-ops that pass data through.
    expect(setCached("", "ignored")).toBe("ignored");
    expect(getCached("")).toBe(null);

    invalidateCache("basic-key");
    expect(getCached("basic-key")).toBe(null);
    expect(invalidateCache("")).toBeUndefined();
  });

  it("persists whitelisted keys to sessionStorage with an as-of stamp", () => {
    const store = new Map();
    const fakeStorage = {
      get length() {
        return store.size;
      },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
    vi.stubGlobal("sessionStorage", fakeStorage);
    try {
      // Catalog keys persist; live-status keys never do.
      setCached("/api/openclaw/catalog?channel=stable", { versions: [1] });
      setCached("/api/watchdog/events?limit=20", { events: [] });
      expect(store.has("acApiCache:/api/openclaw/catalog?channel=stable")).toBe(
        true,
      );
      expect(store.has("acApiCache:/api/watchdog/events?limit=20")).toBe(false);

      const persisted = JSON.parse(
        store.get("acApiCache:/api/openclaw/catalog?channel=stable"),
      );
      expect(persisted.data).toEqual({ versions: [1] });
      expect(typeof persisted.fetchedAt).toBe("number");
      expect(getCachedAt("/api/openclaw/catalog?channel=stable")).toBe(
        persisted.fetchedAt,
      );

      invalidateCache("/api/openclaw/catalog?channel=stable");
      expect(store.has("acApiCache:/api/openclaw/catalog?channel=stable")).toBe(
        false,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hydration skips and removes a corrupt persisted entry instead of aborting the rest", async () => {
    const store = new Map([
      ["acApiCache:/api/openclaw/catalog?bad", "{not json"],
      [
        "acApiCache:/api/openclaw/catalog?good",
        JSON.stringify({ data: "survives", fetchedAt: 1 }),
      ],
    ]);
    const fakeStorage = {
      get length() {
        return store.size;
      },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
    vi.stubGlobal("sessionStorage", fakeStorage);
    try {
      vi.resetModules();
      // Fresh module instance re-runs hydrateFromSessionStorage at load.
      const freshCache = await import(
        "../../lib/public/js/lib/api-cache.js"
      );
      expect(freshCache.getCached("/api/openclaw/catalog?good")).toBe(
        "survives",
      );
      // The corrupt entry was dropped from storage so it can't break every
      // future load.
      expect(store.has("acApiCache:/api/openclaw/catalog?bad")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("bypasses caching for empty keys or non-function fetchers", async () => {
    const fetcher = vi.fn(async () => "direct");
    await expect(cachedFetch("", fetcher)).resolves.toBe("direct");
    expect(fetcher).toHaveBeenCalledTimes(1);

    await expect(cachedFetch("bad-fetcher-key", null)).rejects.toThrow();
  });

  it("returns fresh entries without refetching", async () => {
    setCached("fresh-key", "cached-value");
    const fetcher = vi.fn(async () => "new-value");
    await expect(
      cachedFetch("fresh-key", fetcher, { maxAgeMs: 60000 }),
    ).resolves.toBe("cached-value");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("serves stale data while revalidating in the background once", async () => {
    setCached("swr-key", "stale-value");
    let resolveFetch;
    const fetcher = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const onRevalidate = vi.fn();

    await expect(
      cachedFetch("swr-key", fetcher, { maxAgeMs: 0, onRevalidate }),
    ).resolves.toBe("stale-value");

    // A second stale read while the revalidation is in flight does not
    // schedule another fetch.
    await expect(
      cachedFetch("swr-key", fetcher, { maxAgeMs: 0 }),
    ).resolves.toBe("stale-value");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    resolveFetch("fresh-value");
    await vi.waitFor(() =>
      expect(onRevalidate).toHaveBeenCalledWith("fresh-value"),
    );
    expect(getCached("swr-key")).toBe("fresh-value");
  });

  it("keeps serving stale data when a background revalidation fails", async () => {
    setCached("swr-fail-key", "stale-value");
    const fetcher = vi.fn(async () => {
      throw new Error("upstream down");
    });
    const onRevalidate = vi.fn();

    // A failed background revalidation must neither reject this call nor
    // surface as an unhandled rejection — the stale entry stays.
    await expect(
      cachedFetch("swr-fail-key", fetcher, { maxAgeMs: 0, onRevalidate }),
    ).resolves.toBe("stale-value");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onRevalidate).not.toHaveBeenCalled();
    expect(getCached("swr-fail-key")).toBe("stale-value");

    // The in-flight slot was released: a later stale read retries the fetch.
    await expect(
      cachedFetch("swr-fail-key", fetcher, { maxAgeMs: 0 }),
    ).resolves.toBe("stale-value");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it("revalidates stale data without an onRevalidate callback", async () => {
    setCached("swr-silent-key", "old");
    const fetcher = vi.fn(async () => "new");

    await expect(
      cachedFetch("swr-silent-key", fetcher, { maxAgeMs: 0 }),
    ).resolves.toBe("old");
    await vi.waitFor(() => expect(getCached("swr-silent-key")).toBe("new"));
  });

  it("refetches stale entries when staleWhileRevalidate is off", async () => {
    setCached("no-swr-key", "old");
    const fetcher = vi.fn(async () => "new");

    await expect(
      cachedFetch("no-swr-key", fetcher, {
        maxAgeMs: 0,
        staleWhileRevalidate: false,
      }),
    ).resolves.toBe("new");
    expect(getCached("no-swr-key")).toBe("new");
  });

  it("forces a refetch past a fresh cache entry", async () => {
    setCached("force-key", "old");
    const fetcher = vi.fn(async () => "forced");

    await expect(
      cachedFetch("force-key", fetcher, { maxAgeMs: 60000, force: true }),
    ).resolves.toBe("forced");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent uncached fetches", async () => {
    let resolveFetch;
    const fetcher = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const otherFetcher = vi.fn(async () => "should-not-run");

    const firstPromise = cachedFetch("inflight-key", fetcher);
    const secondPromise = cachedFetch("inflight-key", otherFetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    resolveFetch("shared-result");

    await expect(firstPromise).resolves.toBe("shared-result");
    await expect(secondPromise).resolves.toBe("shared-result");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(otherFetcher).not.toHaveBeenCalled();
    expect(getCached("inflight-key")).toBe("shared-result");
  });
});

// Generation guards: post-mutation refreshes must never be satisfied by — or
// overwritten by — a request dispatched before the write.
describe("frontend/api-cache generation guards", () => {
  it("force does not reuse a pre-mutation in-flight promise, and the stale result cannot overwrite the fresh one", async () => {
    let resolveOld;
    const oldFetcher = vi.fn(
      () => new Promise((resolve) => (resolveOld = resolve)),
    );
    const newFetcher = vi.fn(async () => "post-mutation");

    const oldPromise = cachedFetch("gen-force-key", oldFetcher);
    await vi.waitFor(() => expect(oldFetcher).toHaveBeenCalledTimes(1));

    // A mutation happened; the caller forces a refresh. It must dispatch
    // fresh — the in-flight GET predates the write.
    const forcedPromise = cachedFetch("gen-force-key", newFetcher, { force: true });
    await expect(forcedPromise).resolves.toBe("post-mutation");
    expect(newFetcher).toHaveBeenCalledTimes(1);
    expect(getCached("gen-force-key")).toBe("post-mutation");

    // The superseded request lands late: its result must not clobber the cache.
    resolveOld("pre-mutation");
    await expect(oldPromise).resolves.toBe("pre-mutation");
    expect(getCached("gen-force-key")).toBe("post-mutation");
  });

  it("a superseded request's cleanup cannot evict the replacement in-flight entry", async () => {
    let resolveOld;
    let resolveNew;
    const oldFetcher = vi.fn(() => new Promise((resolve) => (resolveOld = resolve)));
    const newFetcher = vi.fn(() => new Promise((resolve) => (resolveNew = resolve)));
    const thirdFetcher = vi.fn(async () => "should-not-run");

    const oldPromise = cachedFetch("gen-evict-key", oldFetcher);
    const forcedPromise = cachedFetch("gen-evict-key", newFetcher, { force: true });
    await vi.waitFor(() => expect(newFetcher).toHaveBeenCalledTimes(1));

    // Old request settles first — its .finally must NOT delete the forced
    // request's in-flight entry (identity-guarded delete).
    resolveOld("old");
    await oldPromise;

    // A plain read while the forced request is still in flight dedupes onto
    // it (proving the entry survived the old request's cleanup).
    const dedupedPromise = cachedFetch("gen-evict-key", thirdFetcher);
    resolveNew("new");
    await expect(forcedPromise).resolves.toBe("new");
    await expect(dedupedPromise).resolves.toBe("new");
    expect(thirdFetcher).not.toHaveBeenCalled();
  });

  it("a setCached write (e.g. a poll) makes an older in-flight response unable to overwrite it", async () => {
    let resolveOld;
    const oldFetcher = vi.fn(() => new Promise((resolve) => (resolveOld = resolve)));
    const oldPromise = cachedFetch("gen-poll-key", oldFetcher);
    await vi.waitFor(() => expect(oldFetcher).toHaveBeenCalledTimes(1));

    setCached("gen-poll-key", "poll-write");
    resolveOld("stale");
    await expect(oldPromise).resolves.toBe("stale");
    expect(getCached("gen-poll-key")).toBe("poll-write");
  });

  it("invalidateCachePrefix drops every query-scoped variant of a key", async () => {
    setCached("prefix-key", "global");
    setCached("prefix-key?agentId=a", "scoped-a");
    setCached("prefix-key?agentId=b", "scoped-b");
    setCached("prefix-key-sibling", "sibling");

    invalidateCachePrefix("prefix-key?");
    expect(getCached("prefix-key")).toBe("global");
    expect(getCached("prefix-key?agentId=a")).toBe(null);
    expect(getCached("prefix-key?agentId=b")).toBe(null);

    invalidateCachePrefix("prefix-key");
    expect(getCached("prefix-key")).toBe(null);
    expect(getCached("prefix-key-sibling")).toBe(null);

    // Empty prefix is a no-op, never a cache wipe.
    setCached("prefix-key", "back");
    invalidateCachePrefix("");
    expect(getCached("prefix-key")).toBe("back");
  });

  it("plain reads do not dedupe onto an in-flight promise made obsolete by invalidateCache", async () => {
    let resolveOld;
    const oldFetcher = vi.fn(() => new Promise((resolve) => (resolveOld = resolve)));
    const freshFetcher = vi.fn(async () => "fresh");

    const oldPromise = cachedFetch("gen-invalidate-key", oldFetcher);
    await vi.waitFor(() => expect(oldFetcher).toHaveBeenCalledTimes(1));

    invalidateCache("gen-invalidate-key");

    const freshPromise = cachedFetch("gen-invalidate-key", freshFetcher);
    await expect(freshPromise).resolves.toBe("fresh");
    expect(freshFetcher).toHaveBeenCalledTimes(1);
    expect(getCached("gen-invalidate-key")).toBe("fresh");

    resolveOld("obsolete");
    await expect(oldPromise).resolves.toBe("obsolete");
    expect(getCached("gen-invalidate-key")).toBe("fresh");
  });
});
