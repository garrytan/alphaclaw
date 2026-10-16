import { describe, expect, it } from "vitest";
import { createBootReconnectTracker, kBootLoopWindowMs, stageLabelOf } from "../../lib/public/js/lib/boot-reconnect.js";

const stages = [
  { id: "preparing", label: "Preparing", status: "done" },
  { id: "gateway", label: "Starting the gateway", status: "running" },
  { id: "channels", label: "Connecting channels", status: "pending" },
];
const serverFrame = (bootId, overrides = {}) => ({ v: 1, source: "server", bootId, stage: "gateway", stages, activitySeq: 1, stuck: false, outcome: null, ...overrides });
const placeholderFrame = (bootId, overrides = {}) => ({ v: 1, source: "placeholder", kind: "preparing", bootId, stage: "preparing", stuck: false, ...overrides });

const setup = (budgetMs = 120_000) => {
  let t = 1_000_000;
  const tracker = createBootReconnectTracker({ budgetMs, now: () => t });
  return { tracker, advance: (ms) => { t += ms; } };
};

describe("boot reconnect tracker", () => {
  it("is online while the status feed answers", () => {
    const { tracker } = setup();
    tracker.recordStatusFrame(serverFrame("a"));
    expect(tracker.getState().mode).toBe("online");
  });

  it("shows Preparing while the placeholder answers, then booting once the server does (one boot)", () => {
    const { tracker, advance } = setup();
    tracker.recordStatusFrame(serverFrame("old"));
    tracker.recordOutage();
    tracker.recordProbe(placeholderFrame("ph1"));
    expect(tracker.getState().mode).toBe("preparing");
    advance(3_000);
    tracker.recordProbe(serverFrame("new"));
    expect(tracker.getState()).toMatchObject({ mode: "booting", frame: { bootId: "new" } });
  });

  it("goes stalled when the same boot does not advance within the budget, and recovers on genuine progress", () => {
    const { tracker, advance } = setup(60_000);
    tracker.recordOutage();
    tracker.recordProbe(serverFrame("b", { activitySeq: 4 }));
    for (let i = 0; i < 25; i += 1) {
      advance(3_000);
      tracker.recordProbe(serverFrame("b", { activitySeq: 4 }));
    }
    expect(tracker.getState().mode).toBe("stalled");
    advance(3_000);
    tracker.recordProbe(serverFrame("b", { activitySeq: 5 }));
    expect(tracker.getState().mode).toBe("booting");
  });

  it("reports stuck when the responder says so, and unreachable only when nothing answers past the budget", () => {
    const { tracker, advance } = setup(60_000);
    tracker.recordOutage();
    tracker.recordProbe(placeholderFrame("ph", { stuck: true }));
    expect(tracker.getState().mode).toBe("stuck");
    advance(15_000);
    expect(tracker.getState().mode).toBe("reconnecting");
    advance(60_000);
    expect(tracker.getState().mode).toBe("unreachable");
  });

  it("calls more than three fresh boots inside ten minutes a restart loop (handoffs are not counted)", () => {
    const { tracker, advance } = setup();
    tracker.recordOutage();
    tracker.recordProbe(serverFrame("first"));
    for (const id of ["b2", "b3", "b4"]) {
      advance(60_000);
      tracker.recordProbe(placeholderFrame("ph-" + id));
      advance(5_000);
      tracker.recordProbe(serverFrame(id));
    }
    // ph-b2, ph-b3, ph-b4 are fresh boots; each server answer is its handoff.
    expect(tracker.getState().mode).not.toBe("restart_loop");
    advance(60_000);
    tracker.recordProbe(placeholderFrame("ph-b5"));
    expect(tracker.getState()).toMatchObject({ mode: "restart_loop", count: 4 });
    advance(kBootLoopWindowMs);
    expect(tracker.getState().mode).not.toBe("restart_loop");
  });

  it("a boot that reached verified readiness ends the loop state", () => {
    const { tracker } = setup();
    tracker.recordOutage();
    for (const id of ["a", "b", "c", "d", "e"]) tracker.recordProbe(serverFrame(id));
    expect(tracker.getState().mode).toBe("restart_loop");
    tracker.recordStatusFrame(serverFrame("e", { outcome: "ready" }));
    expect(tracker.getState().mode).toBe("online");
  });

  it("labels the stage of a frame", () => {
    expect(stageLabelOf(placeholderFrame("x"))).toBe("Preparing");
    expect(stageLabelOf(serverFrame("x"))).toBe("Starting the gateway");
    expect(stageLabelOf(null)).toBeNull();
  });
});
