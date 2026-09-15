import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../lib/public/js/lib/api.js";
import { cachedFetch, clearApiCache, getCached, setCached } from "../../lib/public/js/lib/api-cache.js";
import { useCachedFetch } from "../../lib/public/js/hooks/use-cached-fetch.js";
import { createReadHost, deferred } from "./mounted-read-helpers.js";

const jsonResponse = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
let host;
beforeEach(() => {
  clearApiCache();
  host = createReadHost();
  vi.stubGlobal("document", host.document);
  vi.stubGlobal("window", { location: { href: "/" }, localStorage: { clear: vi.fn() } });
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(async () => {
  await host.unmount();
  clearApiCache();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("frontend/API ordinary read policy", () => {
  it.each([
    ["fetchPairings", []], ["fetchGoogleAccounts", []], ["fetchGoogleCredentials", [{}]],
    ["checkGoogleApis", ["account"]], ["fetchAlphaclawVersion", []], ["fetchDevicePairings", []],
    ["fetchAuthStatus", []], ["fetchOnboardProgress", []], ["fetchModels", []],
    ["fetchModelStatus", []], ["fetchThinkingOptions", ["provider/model"]],
    ["fetchModelsConfig", [{}]], ["fetchCodexStatus", []], ["fetchEnvVars", []],
  ])("%s rejects JSON 503 without caching a fabricated empty payload", async (name, args) => {
    const key = `policy:${name}`;
    setCached(key, { previous: true });
    fetch.mockResolvedValue(jsonResponse(503, { error: "temporarily unavailable", code: "store_unavailable", hint: "Retry later" }));
    await expect(cachedFetch(key, () => api[name](...args), { force: true })).rejects.toMatchObject({
      status: 503, code: "store_unavailable", hint: "Retry later",
    });
    expect(getCached(key)).toEqual({ previous: true });
  });

  it("HTML 502 is a failed read and a recovered read replaces the stale data", async () => {
    setCached("/api/google/accounts", { accounts: [{ id: "a" }] });
    fetch.mockResolvedValueOnce(new Response("<html>Bad gateway</html>", { status: 502 }));
    await expect(cachedFetch("/api/google/accounts", api.fetchGoogleAccounts, { force: true })).rejects.toMatchObject({ status: 502 });
    expect(getCached("/api/google/accounts").accounts).toHaveLength(1);
    fetch.mockResolvedValueOnce(jsonResponse(200, { accounts: [{ id: "b" }] }));
    await expect(cachedFetch("/api/google/accounts", api.fetchGoogleAccounts, { force: true })).resolves.toMatchObject({ accounts: [{ id: "b" }] });
  });

  it("401 purges every mounted/shared/persisted read before redirecting, without waiting for the body", async () => {
    const stored = new Map();
    vi.stubGlobal("sessionStorage", {
      setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key),
    });
    setCached("/api/env", { secret: true });
    setCached("/api/openclaw/catalog", { catalog: true });
    await host.render(["/api/env", "/api/openclaw/catalog"].map((key) => ({
      id: key, useRead: useCachedFetch, args: [key, () => {}, { initialFetch: false }],
    })));
    const text = vi.fn(() => new Promise(() => {}));
    fetch.mockResolvedValue({ status: 401, text });
    await host.settle(async () => { await expect(api.fetchStatus()).rejects.toMatchObject({ status: 401 }); });
    expect(text).not.toHaveBeenCalled();
    expect(host.result("/api/env").data).toBe(null);
    expect(host.result("/api/openclaw/catalog").data).toBe(null);
    expect(stored.size).toBe(0);
    expect(window.location.href).toBe("/setup");
  });

  it("403 purges only the denied key and does not redirect or automatically retry", async () => {
    setCached("/api/google/accounts", { accounts: [{ id: "private" }] });
    setCached("/api/status", { gateway: "running" });
    fetch.mockResolvedValue(jsonResponse(403, { error: "Admin required", code: "admin_required" }));
    await expect(cachedFetch("/api/google/accounts", api.fetchGoogleAccounts, { force: true })).rejects.toMatchObject({ status: 403 });
    expect(getCached("/api/google/accounts")).toBe(null);
    expect(getCached("/api/status")).toEqual({ gateway: "running" });
    expect(window.location.href).toBe("/");
    await expect(cachedFetch("/api/google/accounts", api.fetchGoogleAccounts)).rejects.toMatchObject({ status: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue(jsonResponse(200, { accounts: [] }));
    await expect(cachedFetch("/api/google/accounts", api.fetchGoogleAccounts, { force: true })).resolves.toEqual({ accounts: [] });
  });

  it("ordinary reads abort at 30s even if fetch ignores the signal", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    fetch.mockReturnValue(pending.promise);
    const request = api.fetchStatus();
    const outcome = request.catch((error) => error);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ code: "read_timeout" });
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    pending.resolve(jsonResponse(200, { gateway: "late" }));
    await host.settle();
  });

  it("the same deadline covers a response body that never completes", async () => {
    vi.useFakeTimers();
    fetch.mockResolvedValue({ status: 200, text: () => new Promise(() => {}) });
    const outcome = api.fetchStatus().catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await outcome).toMatchObject({ code: "read_timeout" });
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("catalog reads have an explicit 120s deadline through cache and transport", async () => {
    vi.useFakeTimers();
    fetch.mockImplementation(() => new Promise(() => {}));
    const outcome = cachedFetch("/api/openclaw/catalog", api.fetchOpenclawCatalog).catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await outcome).toMatchObject({ code: "read_timeout" });
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("an explicit signal adapter aborts obsolete transport and its completion cannot repaint", async () => {
    const old = deferred();
    fetch.mockReturnValueOnce(old.promise).mockResolvedValueOnce(jsonResponse(200, { gateway: "new" }));
    const obsolete = cachedFetch("/api/status", api.fetchStatus, { acceptsSignal: true }).catch((error) => error);
    await host.settle();
    await cachedFetch("/api/status", api.fetchStatus, { force: true, acceptsSignal: true });
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(await obsolete).toMatchObject({ code: "request_superseded" });
    old.resolve(jsonResponse(200, { gateway: "old" }));
    await host.settle();
    expect(getCached("/api/status")).toEqual({ gateway: "new" });
  });

  it("caller cancellation and raw downloads keep their distinct contracts", async () => {
    const controller = new AbortController();
    fetch.mockImplementation(() => new Promise(() => {}));
    const outcome = api.fetchStatus({ signal: controller.signal }).catch((error) => error);
    await host.settle();
    const reason = new Error("pane closed");
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    const response = { status: 200, blob: vi.fn() };
    fetch.mockResolvedValue(response);
    expect(await api.authFetch("/api/browse/download?path=a", { rawResponse: true })).toBe(response);
    expect(fetch.mock.calls.at(-1)[1]).not.toHaveProperty("signal");
  });
});
