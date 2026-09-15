import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePolling } from "../../lib/public/js/hooks/usePolling.js";
import { useCachedFetch } from "../../lib/public/js/hooks/use-cached-fetch.js";
import { clearApiCache, getCached, setCached } from "../../lib/public/js/lib/api-cache.js";
import { createReadHost, deferred } from "./mounted-read-helpers.js";

let host;
beforeEach(() => {
  vi.useFakeTimers();
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
const probe = (id, fetcher, options = {}, interval = 3000) => ({ id, useRead: usePolling, args: [fetcher, interval, options] });
const advance = (ms) => host.settle(() => vi.advanceTimersByTimeAsync(ms));

describe("frontend/use-polling mounted consumers", () => {
  it("waits while mounted hidden, resumes on visibility, pauses and cleans up", async () => {
    host.document.hidden = true;
    const fetcher = vi.fn(async () => "fresh");
    await host.render([probe("a", fetcher)]);
    await advance(9000);
    expect(fetcher).not.toHaveBeenCalled();
    await host.hidden(false);
    await host.settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await advance(3000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await host.hidden(true);
    await advance(6000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await host.unmount();
    expect(host.listenerCount()).toBe(0);
    await advance(6000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("supports deliberate background polling and disabled polls", async () => {
    host.document.hidden = true;
    const active = vi.fn(async () => "fresh");
    const disabled = vi.fn(async () => "unused");
    await host.render([probe("a", active, { pauseWhenHidden: false }), probe("b", disabled, { enabled: false })]);
    await advance(6000);
    expect(active).toHaveBeenCalledTimes(3);
    expect(disabled).not.toHaveBeenCalled();
  });

  it("shares requests with another poller and a cached reader without starving slow completions", async () => {
    const work = deferred();
    const fetcher = vi.fn(() => work.promise);
    const opts = { cacheKey: "shared" };
    await host.render([
      probe("a", fetcher, opts),
      probe("b", fetcher, opts),
      { id: "c", useRead: useCachedFetch, args: ["shared", fetcher] },
    ]);
    await advance(9000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await host.settle(() => work.resolve("first slow result"));
    for (const id of ["a", "b", "c"]) expect(host.result(id).data).toBe("first slow result");
    expect(host.result("a").isPolling).toBe(false);
    await advance(3000);
    // One immediate resolution can permit a subsequent scheduled poll in the
    // same tick; every still-pending request is nevertheless shared.
    expect(fetcher.mock.calls.length).toBeGreaterThan(1);
  });

  it("a forced post-mutation read wins over an unmounted pane's earlier request", async () => {
    const old = deferred();
    const fresh = deferred();
    const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    await host.render([probe("a", fetcher, { cacheKey: "shared" })]);
    await host.render([probe("b", fetcher, { cacheKey: "shared" })]);
    const forced = host.result("b").refresh({ force: true });
    await host.settle(() => fresh.resolve("new"));
    await forced;
    await host.settle(() => old.resolve("old"));
    expect(host.result("b").data).toBe("new");
    expect(getCached("shared")).toBe("new");
  });

  it("switching keys while hidden clears the previous key's data and error", async () => {
    setCached("one", "old");
    await host.render([probe("a", async () => "old", { cacheKey: "one" })]);
    await host.hidden(true);
    const fetcher = vi.fn(async () => "new");
    await host.render([probe("a", fetcher, { cacheKey: "two" })]);
    expect(host.result("a").data).toBe(null);
    expect(host.result("a").error).toBe(null);
    expect(fetcher).not.toHaveBeenCalled();
    await host.hidden(false);
    await host.settle();
    expect(host.result("a").data).toBe("new");
  });

  it("a timed-out read keeps last good data, frees the slot, and fences noncooperative completion", async () => {
    const hung = deferred();
    const fetcher = vi.fn().mockReturnValueOnce(hung.promise).mockResolvedValue("recovered");
    setCached("slow", "good");
    await host.render([probe("a", fetcher, { cacheKey: "slow", timeoutMs: 1000 }, 3000)]);
    await advance(1000);
    expect(host.result("a")).toMatchObject({ data: "good", stale: true, isPolling: false });
    expect(host.result("a").error.code).toBe("read_timeout");
    await advance(2000);
    expect(host.result("a").data).toBe("recovered");
    await host.settle(() => hung.resolve("late"));
    expect(host.result("a").data).toBe("recovered");
    expect(getCached("slow")).toBe("recovered");
  });

  it("403 purges mounted data, stops automatic retries, and allows an explicit force retry", async () => {
    const denied = deferred();
    const fetcher = vi.fn().mockReturnValueOnce(denied.promise).mockResolvedValue("authorized");
    setCached("protected", "secret");
    await host.render([probe("a", fetcher, { cacheKey: "protected" }), probe("b", fetcher, { cacheKey: "protected" })]);
    await host.settle(() => denied.reject(Object.assign(new Error("Forbidden"), { status: 403 })));
    expect(host.result("a").data).toBe(null);
    expect(host.result("b").data).toBe(null);
    expect(getCached("protected")).toBe(null);
    await advance(9000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await host.settle(() => host.result("a").refresh({ force: true }));
    expect(host.result("a").data).toBe("authorized");
    expect(host.result("b").error).toBe(null);
  });
});
