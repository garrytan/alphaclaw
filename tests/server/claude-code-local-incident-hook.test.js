// The incident tracker's rescue hook: fires on open (fresh + orphan-adopt)
// and on crash_loop escalation appends, and MUST be fail-open — a throwing
// observer never affects incident processing (the tracker's founding
// contract).
const {
  createWatchdogIncidentTracker,
  classifyEvent,
} = require("../../lib/server/watchdog-incidents");

const createFakeDb = () => {
  let nextId = 1;
  return {
    getOpenIncident: vi.fn(() => null),
    insertIncident: vi.fn(() => nextId++),
    resolveIncident: vi.fn(),
    getIncidentEventTypeCounts: vi.fn(() => ({})),
    withTransaction: vi.fn((fn) => fn()),
  };
};

const createTracker = (overrides = {}) => {
  const db = createFakeDb();
  const onIncidentActivity = vi.fn();
  const insert = vi.fn(() => 42);
  const tracker = createWatchdogIncidentTracker({
    db,
    onIncidentActivity,
    logger: { info: vi.fn(), error: vi.fn(), log: vi.fn() },
    ...overrides.deps,
  });
  const sink = tracker.wrapInsertEvent(insert);
  return { db, onIncidentActivity, insert, tracker, sink };
};

describe("watchdog-incidents rescue hook", () => {
  it("classifies channel_rollback as OPEN and crash_loop as append (comment-vs-code pin)", () => {
    expect(classifyEvent({ eventType: "channel_rollback" })).toBe("open");
    expect(classifyEvent({ eventType: "crash_loop" })).toBe("append");
  });

  it("fires kind=open on every open trigger, outside the transaction", () => {
    for (const eventType of ["crash", "config_error", "safe_mode", "channel_rollback"]) {
      const { onIncidentActivity, sink } = createTracker();
      sink({ eventType, status: "failed", details: {} });
      expect(onIncidentActivity).toHaveBeenCalledTimes(1);
      expect(onIncidentActivity).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "open", eventType }),
      );
    }
    const failedCheck = createTracker();
    failedCheck.sink({ eventType: "health_check", status: "failed", details: {} });
    expect(failedCheck.onIncidentActivity).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "open", eventType: "health_check" }),
    );
  });

  it("fires kind=open when adopting an orphaned open incident", () => {
    const { db, onIncidentActivity, sink } = createTracker();
    db.getOpenIncident.mockReturnValue({ id: 7, incidentKey: "gateway_crash" });
    sink({ eventType: "crash", details: {} });
    expect(onIncidentActivity).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "open", incidentId: 7 }),
    );
  });

  it("fires kind=escalation on crash_loop appends to an open incident", () => {
    const { onIncidentActivity, sink } = createTracker();
    sink({ eventType: "crash", details: {} }); // opens
    onIncidentActivity.mockClear();
    sink({ eventType: "crash_loop", details: {} });
    expect(onIncidentActivity).toHaveBeenCalledTimes(1);
    expect(onIncidentActivity).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "escalation", eventType: "crash_loop" }),
    );
  });

  it("does NOT fire on plain appends or closes", () => {
    const { onIncidentActivity, sink } = createTracker();
    sink({ eventType: "crash", details: {} });
    onIncidentActivity.mockClear();
    sink({ eventType: "restart", details: {} });
    sink({ eventType: "recovery", details: {} });
    expect(onIncidentActivity).not.toHaveBeenCalled();
  });

  it("never lets a throwing hook affect incident processing", () => {
    const throwing = createTracker();
    throwing.onIncidentActivity.mockImplementation(() => {
      throw new Error("hook boom");
    });
    const eventId = throwing.sink({ eventType: "crash", details: {} });
    expect(eventId).toBe(42);
    expect(throwing.db.insertIncident).toHaveBeenCalledTimes(1);
    // Escalation path too.
    expect(() => throwing.sink({ eventType: "crash_loop", details: {} })).not.toThrow();
  });

  it("does not fire kind=open when a rolled-back open transaction throws", () => {
    const { db, onIncidentActivity, insert, sink } = createTracker();
    db.withTransaction.mockImplementation(() => {
      throw new Error("db down");
    });
    const eventId = sink({ eventType: "crash", details: {} });
    // Fail-open: the event still inserts unstamped…
    expect(eventId).toBe(42);
    expect(insert).toHaveBeenCalledWith({ eventType: "crash", details: {} });
    // …but the rescue hook must not have fired for a failed open.
    expect(onIncidentActivity).not.toHaveBeenCalled();
  });
});
