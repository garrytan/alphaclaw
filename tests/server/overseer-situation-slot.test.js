const {
  createSituationSlot,
  projectRecordForApi,
  kStalePendingMs,
} = require("../../lib/server/overseer-situation-slot");

const kNow = Date.parse("2026-08-29T12:00:00Z");

// In-memory stand-in for watchdog_meta's tagged read / boolean write.
const createStore = (initial = null) => {
  const state = { record: initial, writes: 0 };
  return {
    state,
    read: () => (state.record == null ? { ok: false, reason: "missing" } : { ok: true, record: state.record }),
    write: (record) => {
      state.writes += 1;
      state.record = JSON.parse(JSON.stringify(record));
      return true;
    },
  };
};

describe("overseer-situation-slot", () => {
  it("normalizes malformed shapes to empty defaults instead of throwing", () => {
    const store = createStore({ v: 1, current: "not-an-object", lastVerdict: 42, history: "nope" });
    const slot = createSituationSlot({ ...store, nowFn: () => kNow });
    expect(slot.readRecord()).toEqual({
      current: null,
      lastVerdict: null,
      history: [],
      unreadable: false,
    });
    expect(slot.markPendingInterrupted()).toBe(false);
  });

  it("treats a throwing reader as unreadable and logs it once", () => {
    const log = vi.fn();
    const slot = createSituationSlot({
      read: () => {
        throw new Error("SQLITE_BUSY");
      },
      write: () => true,
      nowFn: () => kNow,
      log,
    });
    expect(slot.readRecord()).toMatchObject({ current: null, unreadable: true });
    slot.readRecord();
    expect(log.mock.calls.filter(([m]) => m.includes("unreadable"))).toHaveLength(1);
  });

  it("refuses to shape-sniff a blob written by a newer record version", () => {
    const store = createStore({ v: 2, current: { state: "done", verdict: "future" }, extra: 1 });
    const slot = createSituationSlot({ ...store, nowFn: () => kNow });
    expect(slot.readRecord()).toMatchObject({ current: null, unreadable: true });
    // Reading never rewrites the newer blob as v1.
    expect(store.state.writes).toBe(0);
    expect(store.state.record.v).toBe(2);
  });

  it("reports a writer that returns false or is missing", () => {
    expect(
      createSituationSlot({ read: () => null, write: () => false, nowFn: () => kNow }).persist({ state: "done" }),
    ).toEqual({ ok: false, error: "write returned false" });
    expect(
      createSituationSlot({ read: () => null, nowFn: () => kNow }).persist({ state: "done" }),
    ).toEqual({ ok: false, error: "no writer" });
  });

  it("logs a throwing writer once, not once per poll", () => {
    const log = vi.fn();
    const slot = createSituationSlot({
      read: () => ({ ok: true, record: { v: 1, current: { state: "pending", at: kNow - kStalePendingMs - 1 } } }),
      write: () => {
        throw new Error("readonly");
      },
      nowFn: () => kNow,
      log,
    });
    // Each read trips the stale-pending rewrite, whose write fails.
    slot.readRecord();
    slot.readRecord();
    slot.readRecord();
    expect(log.mock.calls.filter(([m]) => m.includes("write failed"))).toHaveLength(1);
    // The caller still sees the stale-rewritten record even though it did not persist.
    expect(slot.readRecord().current).toMatchObject({ state: "failed", reason: "stale" });
  });

  it("supersede pushes the previous current into history (cap 3) and lastVerdict tracks done records only", () => {
    const store = createStore(null);
    const slot = createSituationSlot({ ...store, nowFn: () => kNow });
    slot.persist({ state: "done", verdict: "watch", at: 1 });
    for (let i = 2; i <= 6; i += 1) {
      slot.persist({ state: "pending", at: i }, { supersede: true });
      slot.persist({ state: "failed", summary: "x", at: i });
    }
    const record = slot.readRecord();
    expect(record.current).toMatchObject({ state: "failed", at: 6 });
    expect(record.lastVerdict).toMatchObject({ state: "done", verdict: "watch", at: 1 });
    expect(record.history).toHaveLength(3);
  });

  it("markPendingInterrupted rewrites only a pending current and reports whether it did", () => {
    const store = createStore({ v: 1, current: { state: "pending", at: kNow - 1000 }, history: [] });
    const slot = createSituationSlot({ ...store, nowFn: () => kNow });
    expect(slot.markPendingInterrupted()).toBe(true);
    expect(store.state.record.current).toMatchObject({
      state: "failed",
      reason: "interrupted",
      summary: "Interrupted by a server restart.",
      at: kNow,
    });
    expect(slot.markPendingInterrupted()).toBe(false);
  });

  it("projects records through an allowlist", () => {
    expect(projectRecordForApi(null)).toBe(null);
    expect(projectRecordForApi("nope")).toBe(null);
    expect(
      projectRecordForApi({ state: "done", transcriptTail: "raw", bogus: 1, evidence: { a: 1 }, at: 5 }),
    ).toEqual({ state: "done", evidence: { a: 1 }, at: 5 });
  });
});
