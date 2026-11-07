import { beforeEach, describe, expect, it, vi } from "vitest";

// Stateful hook harness: state lives in per-call-index slots, so the hook
// can be called again (a re-render) and see what its setters stored.
vi.mock("preact/hooks", () => {
  const harness = { slots: [], cursor: 0 };
  harness.reset = () => {
    harness.slots = [];
    harness.cursor = 0;
  };
  const useState = (initialValue) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = typeof initialValue === "function" ? initialValue() : initialValue;
    const setState = (next) => {
      harness.slots[index] = typeof next === "function" ? next(harness.slots[index]) : next;
    };
    return [harness.slots[index], setState];
  };
  const useRef = (initialValue = null) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = { current: initialValue };
    return harness.slots[index];
  };
  return { useState, useRef, useEffect: () => {}, useMemo: (factory) => factory(), useCallback: (fn) => fn, __harness: harness };
});

const kPolled = new Map();
vi.mock("../../lib/public/js/hooks/usePolling.js", () => ({
  usePolling: vi.fn((_fetcher, _interval, { cacheKey, enabled } = {}) => ({
    data: enabled === false ? null : kPolled.get(String(cacheKey).split("?")[0]) ?? null,
    error: null,
    refresh: vi.fn(),
  })),
}));

vi.mock("../../lib/public/js/lib/api.js", () => ({
  fetchRelayConversations: vi.fn(),
  fetchRelayConversation: vi.fn(),
}));

import * as preactHooks from "preact/hooks";
import { usePolling } from "../../lib/public/js/hooks/usePolling.js";
import { fetchRelayConversation, fetchRelayConversations } from "../../lib/public/js/lib/api.js";
import { useRelayConversations } from "../../lib/public/js/components/relay-tab/use-relay-conversations.js";

const harness = preactHooks.__harness;
const render = () => {
  harness.cursor = 0;
  return useRelayConversations({ ready: true });
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const conv = (id) => ({ id, participants: ["wintermute", id], peer: id, lastMessageAt: "2026-11-06T18:00:00.000Z", lastText: "", sessionKey: "agent:main:relay-" + id });

describe("useRelayConversations paging (ALPH-69 fix round)", () => {
  beforeEach(() => {
    harness.reset();
    kPolled.clear();
    vi.clearAllMocks();
    kPolled.set("/api/relay/conversations", { agentName: "wintermute", conversations: [conv("a"), conv("b")], nextBefore: "2026-11-05T00:00:00.000Z" });
  });

  it("appends the next page and follows its cursor", async () => {
    fetchRelayConversations.mockResolvedValueOnce({ conversations: [conv("c")], nextBefore: "2026-11-01T00:00:00.000Z" });
    let state = render();
    expect(state.hasMoreConversations).toBe(true);
    await state.loadMoreConversations();
    expect(fetchRelayConversations).toHaveBeenCalledWith({ q: "", agent: "", from: "", to: "", before: "2026-11-05T00:00:00.000Z", limit: 50 });
    state = render();
    expect(state.conversations.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(state.hasMoreConversations).toBe(true);
    expect(state.loadingMore).toBe(false);
    expect(state.moreError).toBeNull();
    fetchRelayConversations.mockResolvedValueOnce({ conversations: [conv("d")], nextBefore: null });
    await state.loadMoreConversations();
    expect(fetchRelayConversations.mock.calls[1][0].before).toBe("2026-11-01T00:00:00.000Z");
    state = render();
    expect(state.conversations.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
    expect(state.hasMoreConversations).toBe(false);
  });

  it("drops an older page that lands after the filters changed", async () => {
    const page = deferred();
    fetchRelayConversations.mockReturnValueOnce(page.promise);
    let state = render();
    const loading = state.loadMoreConversations();
    state.setFilters({ q: "disk" });
    state = render();
    page.resolve({ conversations: [conv("stale")], nextBefore: null });
    await loading;
    state = render();
    expect(state.filters.q).toBe("disk");
    expect(state.conversations.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("shows the error and stops loading when a page fails", async () => {
    fetchRelayConversations.mockRejectedValueOnce(new Error("relay engine unavailable"));
    let state = render();
    await state.loadMoreConversations();
    state = render();
    expect(state.moreError?.message).toBe("relay engine unavailable");
    expect(state.loadingMore).toBe(false);
    expect(state.conversations.map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("useRelayConversations relay log (ALPH-69 fix round)", () => {
  beforeEach(() => {
    harness.reset();
    kPolled.clear();
    vi.clearAllMocks();
    kPolled.set("/api/relay/conversations", { agentName: "wintermute", conversations: [conv("a"), conv("b")], nextBefore: null });
  });

  const logCall = () => usePolling.mock.calls[usePolling.mock.calls.length - 1][2];

  it("fetches a log only while its row is expanded, one row at a time", () => {
    let state = render();
    expect(logCall().enabled).toBe(false);
    state.toggleLog("a");
    state = render();
    expect(state.expandedId).toBe("a");
    expect(logCall()).toMatchObject({ cacheKey: "/api/relay/conversations/a", enabled: true });
    state.toggleLog("b");
    state = render();
    expect(state.expandedId).toBe("b");
    expect(logCall()).toMatchObject({ cacheKey: "/api/relay/conversations/b", enabled: true });
    state.toggleLog("b");
    state = render();
    expect(state.expandedId).toBe("");
    expect(logCall().enabled).toBe(false);
    expect(state.log).toBeNull();
  });

  it("never fetches a log for a session past retention", () => {
    let state = render();
    state.toggleLog("session:agent:main:relay-old");
    state = render();
    expect(logCall().enabled).toBe(false);
    expect(state.log).toBeNull();
  });

  it("loads earlier messages and drops a page that lands after the row changed", async () => {
    kPolled.set("/api/relay/conversations/a", { messages: [{ id: "m3", from: "a", text: "newest" }], nextBefore: "m3" });
    let state = render();
    state.toggleLog("a");
    state = render();
    expect(state.log.hasEarlier).toBe(true);
    fetchRelayConversation.mockResolvedValueOnce({ messages: [{ id: "m1", from: "a", text: "oldest" }], nextBefore: null });
    await state.log.loadEarlier();
    expect(fetchRelayConversation).toHaveBeenCalledWith("a", { before: "m3" });
    state = render();
    expect(state.log.messages.map((message) => message.id)).toEqual(["m1", "m3"]);
    expect(state.log.hasEarlier).toBe(false);

    harness.reset();
    state = render();
    state.toggleLog("a");
    state = render();
    const page = deferred();
    fetchRelayConversation.mockReturnValueOnce(page.promise);
    const loading = state.log.loadEarlier();
    state.toggleLog("b");
    state = render();
    page.resolve({ messages: [{ id: "stale", from: "a", text: "stale" }], nextBefore: null });
    await loading;
    state.toggleLog("a");
    state = render();
    expect(state.log.messages.map((message) => message.id)).not.toContain("stale");
  });
});
