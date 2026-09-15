import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCachedFetch } from "../../lib/public/js/hooks/use-cached-fetch.js";
import { clearApiCache, denyCachedKey, getCached, setCached } from "../../lib/public/js/lib/api-cache.js";
import { createReadHost, deferred } from "./mounted-read-helpers.js";

let host;
beforeEach(() => {
  clearApiCache();
  host = createReadHost();
  vi.stubGlobal("document", host.document);
});
afterEach(async () => {
  await host.unmount();
  clearApiCache();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const probe = (id, key, fetcher, options = {}) => ({ id, useRead: useCachedFetch, args: [key, fetcher, options] });

describe("frontend/use-cached-fetch mounted consumers", () => {
  it("an opted-in disabled refresh waits for SWR work before publishing its committed entry", async () => {
    const work = deferred();
    const fetcher = vi.fn(() => work.promise);
    setCached("shared", "before");
    await host.render([probe("a", "shared", fetcher, { initialFetch: false, subscribeEnabled: false, maxAgeMs: 0 })]);
    let settled = false;
    const refresh = host.result("a").refresh({ publishWhenDisabled: true }).then(() => { settled = true; });
    await host.settle();
    expect(settled).toBe(false);
    expect(host.result("a").data).toBe("before");
    await host.settle(() => work.resolve("after"));
    await refresh;
    expect(host.result("a").data).toBe("after");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("disabling a consumer fences late shared results while preserving access revocation", async () => {
    const work = deferred();
    let signal;
    const fetcher = ({ signal: next }) => { signal = next; return work.promise; };
    const options = { maxAgeMs: 0, acceptsSignal: true };
    setCached("shared", "before");
    await host.render([probe("a", "shared", fetcher, options), probe("b", "shared", fetcher, options)]);
    await host.render([probe("a", "shared", fetcher, { ...options, enabled: false }), probe("b", "shared", fetcher, options)]);
    expect(signal.aborted).toBe(false);
    await host.settle(() => work.resolve("after"));
    expect(host.result("a")).toMatchObject({ data: "before", loading: false, isFetching: false });
    expect(host.result("b").data).toBe("after");
    await host.settle(() => denyCachedKey("shared", Object.assign(new Error("Denied"), { status: 403 })));
    expect(host.result("a").data).toBe(null);
    expect(host.result("b").data).toBe(null);
  });
  it("fans one SWR read out to every mounted consumer", async () => {
    const work = deferred();
    const fetcher = vi.fn(() => work.promise);
    setCached("shared", "old");
    await host.render([probe("a", "shared", fetcher, { maxAgeMs: 0 }), probe("b", "shared", fetcher, { maxAgeMs: 0 })]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(host.result("a").data).toBe("old");
    expect(host.result("b").data).toBe("old");
    await host.settle(() => work.resolve("new"));
    expect(host.result("a").data).toBe("new");
    expect(host.result("b").data).toBe("new");
    expect(host.result("a").loading).toBe(false);
  });

  it("mutation commits reach mounted consumers and a pre-mutation promise cannot repaint", async () => {
    const work = deferred();
    const fetcher = vi.fn(() => work.promise);
    await host.render([probe("a", "shared", fetcher), probe("b", "shared", fetcher)]);
    await host.settle(() => setCached("shared", "saved"));
    expect(host.result("a").data).toBe("saved");
    expect(host.result("b").data).toBe("saved");
    await host.settle(() => work.resolve("old"));
    expect(host.result("a").data).toBe("saved");
    expect(host.result("b").data).toBe("saved");
    expect(getCached("shared")).toBe("saved");
  });

  it("force supersedes a slow read while all consumers adopt the replacement", async () => {
    const first = deferred();
    const second = deferred();
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await host.render([probe("a", "shared", fetcher), probe("b", "shared", fetcher)]);
    const forced = host.result("a").refresh({ force: true });
    await host.settle(() => second.resolve("new"));
    await forced;
    await host.settle(() => first.resolve("old"));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(host.result("a").data).toBe("new");
    expect(host.result("b").data).toBe("new");
  });

  it("unmounting one consumer leaves another consumer's shared request alive", async () => {
    const work = deferred();
    let signal;
    const fetcher = vi.fn((options) => { signal = options.signal; return work.promise; });
    const opts = { acceptsSignal: true };
    await host.render([probe("a", "shared", fetcher, opts), probe("b", "shared", fetcher, opts)]);
    await host.render([probe("b", "shared", fetcher, opts)]);
    expect(signal.aborted).toBe(false);
    await host.settle(() => work.resolve("done"));
    expect(host.result("b").data).toBe("done");
  });

  it("switching key while a read is pending never renders the previous entity or its error", async () => {
    const first = deferred();
    const second = deferred();
    await host.render([probe("a", "one", () => first.promise)]);
    await host.render([probe("a", "two", () => second.promise)]);
    expect(host.result("a").data).toBe(null);
    expect(host.result("a").loading).toBe(true);
    await host.settle(() => first.reject(new Error("wrong entity")));
    expect(host.result("a").error).toBe(null);
    await host.settle(() => second.resolve("two"));
    expect(host.result("a").data).toBe("two");
  });

  it("refresh invokes the latest fetcher without passing legacy positional arguments", async () => {
    const old = vi.fn(async () => "old");
    const current = vi.fn(async () => "current");
    await host.render([probe("a", "one", old)]);
    await host.render([probe("a", "one", current)]);
    await host.settle(() => host.result("a").refresh({ force: true }));
    expect(current).toHaveBeenCalledWith();
    expect(host.result("a").data).toBe("current");
  });

  it("a committed null result settles loading", async () => {
    await host.render([probe("a", "empty", async () => null)]);
    await host.settle();
    expect(host.result("a")).toMatchObject({ data: null, loading: false, error: null });
  });

  it("a key switch before the request microtask cannot fetch the new entity into the old key", async () => {
    const first = vi.fn(async () => "entity one");
    const second = vi.fn(async () => "entity two");
    await host.render([probe("a", "one", first, { initialFetch: false })]);
    const started = host.result("a").refresh({ force: true });
    await host.render([probe("a", "two", second, { initialFetch: false })]);
    await started;
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(getCached("one")).toBe("entity one");
    expect(host.result("a").data).toBe(null);
  });

  it("preserves last good data with an error on 5xx and clears the error on retry", async () => {
    const failure = deferred();
    const fetcher = vi.fn().mockReturnValueOnce(failure.promise).mockResolvedValue("recovered");
    setCached("one", "good");
    await host.render([probe("a", "one", fetcher, { maxAgeMs: 0 })]);
    await host.settle(() => failure.reject(Object.assign(new Error("down"), { status: 503 })));
    expect(host.result("a")).toMatchObject({ data: "good", stale: true, loading: false });
    expect(host.result("a").error.message).toBe("down");
    await host.settle(() => host.result("a").refresh({ force: true }));
    expect(host.result("a")).toMatchObject({ data: "recovered", error: null, stale: false });
  });
});
