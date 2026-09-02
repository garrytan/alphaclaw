const { createSituationSlot } = require("../../lib/server/overseer-situation-slot");

// Independent-review follow-up (v0.9.69): a THROWING read is not a corrupt
// blob. If the situation slot rebuilt its record from the empty default and the
// next write succeeded, a transient lock/I-O failure would wipe lastVerdict
// and history. The slot must refuse to write blind and keep the stored record.
describe("overseer-situation-slot — transient read failure", () => {
  const kNow = Date.parse("2026-08-29T12:00:00Z");
  const stored = {
    v: 1,
    current: { state: "done", verdict: "watch", at: kNow - 60_000 },
    lastVerdict: { state: "done", verdict: "watch", at: kNow - 60_000 },
    history: [{ state: "done", verdict: "all_clear", at: kNow - 120_000 }],
  };

  it("persist refuses to overwrite the record while reads throw, then resumes", () => {
    let blob = stored;
    let readThrows = true;
    const write = vi.fn((next) => {
      blob = next;
      return true;
    });
    const log = vi.fn();
    const slot = createSituationSlot({
      read: () => {
        if (readThrows) throw new Error("database is locked");
        return { ok: true, record: blob };
      },
      write,
      nowFn: () => kNow,
      log,
    });

    // Read path: unreadable to the caller, but the cause is named honestly.
    const view = slot.readRecord();
    expect(view).toMatchObject({ current: null, lastVerdict: null, unreadable: true });
    expect(slot.projectForApi(view)).toEqual({ current: null, lastVerdict: null, unreadable: true });
    expect(log.mock.calls.some(([m]) => m.includes("read failed"))).toBe(true);
    expect(log.mock.calls.some(([m]) => m.includes("corrupt blob"))).toBe(false);

    // Write path: no blind rebuild — the stored blob is untouched.
    const pending = { state: "pending", manual: true, situation: true, at: kNow };
    expect(slot.persist(pending, { supersede: true })).toEqual({
      ok: false,
      error: expect.stringContaining("refusing to overwrite"),
    });
    expect(write).not.toHaveBeenCalled();
    expect(blob).toBe(stored);
    // markPendingInterrupted has nothing to act on and writes nothing either.
    expect(slot.markPendingInterrupted()).toBe(false);
    expect(write).not.toHaveBeenCalled();

    // Once the read works again, the same call supersedes normally and the
    // old verdict is still there to be pushed into history.
    readThrows = false;
    expect(slot.persist(pending, { supersede: true })).toEqual({ ok: true });
    expect(blob.current).toBe(pending);
    expect(blob.lastVerdict).toEqual(stored.lastVerdict);
    expect(blob.history[0]).toEqual(stored.current);
    expect(blob.history).toHaveLength(2);
  });

  it("a corrupt blob (read succeeds, JSON unusable) is still replaced by the next write", () => {
    let blob = null;
    const slot = createSituationSlot({
      read: () => ({ ok: false, reason: "unreadable" }),
      write: (next) => {
        blob = next;
        return true;
      },
      nowFn: () => kNow,
    });
    const done = { state: "done", verdict: "all_clear", at: kNow };
    expect(slot.persist(done, { supersede: true })).toEqual({ ok: true });
    expect(blob).toEqual({ v: 1, current: done, lastVerdict: done, history: [] });
  });
});
