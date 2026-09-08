import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Execute the actual connection + store hooks together with indexed state
// and effect cleanup. Socket events deliberately run before another render,
// exercising the synchronous hello → outbox flush boundary.
vi.mock("preact/hooks", () => {
  const h = { slots: [], cursor: 0, pending: [], intervals: new Map() };
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const useRef = (value) => {
    const i = h.cursor++;
    return (h.slots[i] ||= { current: value });
  };
  const useState = (value) => {
    const ref = useRef(typeof value === "function" ? value() : value);
    return [ref.current, (next) => { ref.current = typeof next === "function" ? next(ref.current) : next; }];
  };
  const useMemo = (fn, deps) => {
    const ref = useRef(null);
    if (!ref.current || !same(ref.current.deps, deps)) ref.current = { deps, value: fn() };
    return ref.current.value;
  };
  const useEffect = (fn, deps) => {
    const ref = useRef(null);
    if (!ref.current || !same(ref.current.deps, deps)) h.pending.push(() => {
      ref.current?.cleanup?.();
      ref.current = { deps, cleanup: fn() };
    });
  };
  h.render = (fn) => {
    h.cursor = 0;
    const result = fn();
    for (const effect of h.pending.splice(0)) effect();
    return result;
  };
  h.reset = () => { for (const slot of h.slots) slot?.current?.cleanup?.(); h.slots = []; h.pending = []; h.intervals.clear(); };
  return { useRef, useState, useMemo, useCallback: (fn, deps) => useMemo(() => fn, deps), useEffect, __harness: h };
});
vi.mock("../../lib/public/js/hooks/use-visible-interval.js", async () => {
  const { __harness } = await import("preact/hooks");
  return { useVisibleInterval: (fn, ms) => __harness.intervals.set(ms, fn) };
});
vi.mock("../../lib/public/js/lib/api.js", () => ({ authFetch: vi.fn(() => new Promise(() => {})) }));
vi.mock("../../lib/public/js/components/toast.js", () => ({ showToast: vi.fn() }));

import { __harness as h } from "preact/hooks";
import { useChatStore, resetSharedChatOutboxesForTests } from "../../lib/public/js/components/chat/use-chat-store.js";
import { kChatSendOutboxStorageKey } from "../../lib/public/js/lib/storage-keys.js";

class FakeSocket {
  static instances = [];
  constructor() { this.readyState = 0; this.frames = []; FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  frame(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }
  close() { this.readyState = 3; this.onclose?.(); }
  send(raw) { this.onSend?.(JSON.parse(raw)); this.frames.push(JSON.parse(raw)); }
  messages() { return this.frames.filter((f) => f.type === "message"); }
}

let values, current;
const render = () => (current = h.render(() => useChatStore({ selectedSessionKey: "s" })));
const stored = () => JSON.parse(values.get(kChatSendOutboxStorageKey) || "[]");
const first = () => FakeSocket.instances[0];
const reconnect = () => {
  first().close(); render();
  vi.advanceTimersByTime(3000);
  const socket = FakeSocket.instances.at(-1);
  expect(socket).not.toBe(first());
  socket.open();
  return socket;
};
const hello = (socket, fields = {}) => socket.frame({ type: "hello", protocolVersion: 2, activeRuns: [], ...fields });

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-08T00:00:00Z"));
  h.reset(); resetSharedChatOutboxesForTests(); FakeSocket.instances = [];
  values = new Map();
  const localStorage = { getItem: (k) => values.get(k) || null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) };
  vi.stubGlobal("window", { location: { protocol: "http:", host: "localhost" }, localStorage, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("WebSocket", FakeSocket);
  render();
});
afterEach(() => { h.reset(); resetSharedChatOutboxesForTests(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("chat hook handshake and retry integration", () => {
  it("persists submission evidence before the initial hello-triggered socket send", () => {
    current.actions.send("execute once"); render(); first().open();
    expect(first().messages()).toHaveLength(0);
    first().onSend = (frame) => {
      if (frame.type === "message") expect(stored()[0]).toMatchObject({ clientMsgId: frame.clientMsgId, possiblySubmitted: true });
    };
    hello(first(), { safeRetry: true });
    expect(first().messages()).toHaveLength(1);
    expect(first().messages()[0].retry).toBe(false);
  });

  it("never transmits after a marker write fails, including reload and explicit unsent retry", () => {
    current.actions.send("execute once"); render();
    const original = stored()[0].clientMsgId;
    const setItem = window.localStorage.setItem;
    window.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
    first().open(); hello(first(), { safeRetry: true }); render();
    expect(first().messages()).toHaveLength(0);
    expect(stored()[0]).toMatchObject({ clientMsgId: original, status: "queued", possiblySubmitted: false });
    expect(current.outboxItems[0]).toMatchObject({ status: "failed", possiblySubmitted: false,
      lastError: { code: "browser_storage_unavailable", notSubmitted: true } });
    vi.advanceTimersByTime(20_000); h.intervals.get(1000)();
    expect(first().messages()).toHaveLength(0);

    // Reload the hooks and shared outbox while retaining only browser storage.
    h.reset(); resetSharedChatOutboxesForTests(); FakeSocket.instances = [];
    window.localStorage.setItem = setItem;
    render(); first().open(); hello(first(), { safeRetry: true }); render();
    expect(first().messages()).toHaveLength(0);
    expect(current.outboxItems[0]).toMatchObject({ clientMsgId: original, status: "failed", possiblySubmitted: false });
    current.actions.retryItem(original);
    expect(first().messages()).toHaveLength(1);
    expect(first().messages()[0]).toMatchObject({ clientMsgId: original, retry: false });
    expect(stored()[0]).toMatchObject({ clientMsgId: original, possiblySubmitted: true });
  });

  it("an old-v2 replacement cannot inherit safeRetry, and frames from the replaced socket are ignored", () => {
    current.actions.send("execute once"); render(); first().open(); hello(first(), { safeRetry: true }); render();
    const next = reconnect();
    first().frame({ type: "ack", sessionKey: "s", clientMsgId: first().messages()[0].clientMsgId });
    expect(stored()[0].status).toBe("queued");
    first().frame({ type: "hello", safeRetry: true });
    expect(next.messages()).toHaveLength(0);
    hello(next); // protocol 2 without safeRetry
    expect(next.messages()).toHaveLength(0);
    expect(stored()[0]).toMatchObject({ status: "unknown", possiblySubmitted: true });
    render();
    current.actions.send("followup");
    expect(next.messages()).toHaveLength(0);
  });

  it("lost ack retransmission is marked retry synchronously on the new safe socket", () => {
    current.actions.send("execute once"); render(); first().open(); hello(first(), { safeRetry: true }); render();
    const next = reconnect();
    hello(next, { safeRetry: true });
    expect(next.messages()).toHaveLength(1);
    expect(next.messages()[0]).toMatchObject({ clientMsgId: first().messages()[0].clientMsgId, retry: true });
  });

  it("definite refusal clears evidence, but a legacy refusal cannot authorize automatic retry", () => {
    first().open(); hello(first(), { safeRetry: true }); render();
    current.actions.send("execute once"); render();
    const id = first().messages()[0].clientMsgId;
    first().frame({ type: "send-failed", sessionKey: "s", clientMsgId: id, code: "session_busy", retryable: true, notSubmitted: true });
    expect(stored()[0]).toMatchObject({ status: "queued", possiblySubmitted: false, attempts: 0 });
    render(); vi.advanceTimersByTime(5001); h.intervals.get(1000)(); render();
    expect(first().messages()[1]).toMatchObject({ clientMsgId: id, retry: false });
    first().frame({ type: "send-failed", sessionKey: "s", clientMsgId: id, code: "session_busy", retryable: true });
    expect(stored()[0].status).toBe("unknown");
  });

  it.each(["error", "timeout"])("acked history %s parks uncertainty and requires a new ID to send again", (failure) => {
    first().open(); hello(first(), { safeRetry: true }); render(); current.actions.send("execute once"); render();
    const original = first().messages()[0].clientMsgId;
    first().frame({ type: "ack", sessionKey: "s", clientMsgId: original }); render();
    const next = reconnect(); hello(next, { safeRetry: true }); render();
    if (failure === "error") next.frame({ type: "error", sessionKey: "s", message: "History unavailable" });
    else { vi.advanceTimersByTime(31_000); h.intervals.get(1000)(); }
    render();
    expect(next.messages()).toHaveLength(0);
    expect(stored()[0].status).toBe("unknown");
    current.actions.retryItem(original);
    expect(next.messages()).toHaveLength(1);
    expect(next.messages()[0].clientMsgId).not.toBe(original);
    expect(next.messages()[0].retry).toBe(false);
    expect(stored().find((item) => item.clientMsgId === original).status).toBe("unknown");
  });
});
