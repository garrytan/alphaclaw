import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The chip reads the gateway shell snapshot the controller publishes from the
// status stream; tests swap that snapshot instead of rendering the shell.
let currentShell = {};
vi.mock("../../lib/public/js/components/restart-progress-card.js", () => ({
  useGatewayShell: () => currentShell,
}));

import { deriveStatusChip, StatusChip } from "../../lib/public/js/components/status-chip.js";
import { normalizeStatusSnapshot } from "../../lib/public/js/lib/status-ingestion.js";

// One status-stream frame per gateway state, shaped like the server's SSE
// payload, reduced to the shell fields the controller publishes.
const frame = (state, label, extra = {}) => ({
  gateway: state === "running" ? "running" : "starting",
  state: { state, label, dot: { color: "gray", motion: "steady" }, ...extra },
  timestamp: "2026-11-07T08:00:00.000Z",
  snapshotEpoch: "epoch-1",
  snapshotRevision: 4,
});

const shellFromFrame = (payload, overrides = {}) => {
  const snapshot = normalizeStatusSnapshot(payload);
  return {
    hasStatus: !!snapshot,
    statusState: snapshot?.status?.state || null,
    restartOperation: null,
    connectivityMode: "online",
    ...overrides,
  };
};

describe("deriveStatusChip", () => {
  it.each([
    ["Running", frame("running", "Running"), {}, "running"],
    ["Degraded", frame("degraded", "Running with issues"), {}, "degraded"],
    ["Degraded (channels paused)", frame("safe_mode", "Channels paused"), {}, "degraded"],
    ["Down", frame("down", "Down"), {}, "down"],
    ["Down (config error)", frame("config_error", "Configuration error"), {}, "down"],
    ["Starting", frame("starting", "Starting"), {}, "starting"],
    ["Restarting (this tab's operation)", frame("starting", "Starting"), { restartOperation: { phase: "running" } }, "restarting"],
    ["Restarting (another tab's lock)", frame("running", "Running", { operation: { kind: "restart", startedAt: 1 } }), {}, "restarting"],
  ])("renders %s from its status frame", (_name, payload, overrides, key) => {
    expect(deriveStatusChip(shellFromFrame(payload, overrides)).key).toBe(key);
  });

  it("says Connecting… before the first status frame", () => {
    const chip = deriveStatusChip({ hasStatus: false, statusState: null, connectivityMode: "online" });
    expect(chip).toMatchObject({ key: "connecting", word: "Connecting…" });
    expect(deriveStatusChip({}).key).toBe("connecting");
  });

  it("says Connecting… while the stream reconnects and when the gateway state is unknown", () => {
    expect(deriveStatusChip(shellFromFrame(frame("running", "Running"), { connectivityMode: "reconnecting" })).key).toBe(
      "connecting",
    );
    const unknown = deriveStatusChip(shellFromFrame(frame("unknown", "Status unavailable")));
    expect(unknown).toMatchObject({ key: "connecting", title: "Status unavailable" });
  });

  it("says Offline when AlphaClaw is unreachable, whatever the last frame said", () => {
    for (const mode of ["unreachable", "alphaclaw_stalled", "alphaclaw_stuck", "restart_loop"]) {
      const chip = deriveStatusChip(shellFromFrame(frame("running", "Running"), { connectivityMode: mode }));
      expect(chip, mode).toEqual({ key: "offline", word: "Offline", title: "AlphaClaw is not answering." });
    }
  });

  it("follows AlphaClaw's own restart and boot", () => {
    expect(deriveStatusChip({ connectivityMode: "alphaclaw_restarting" }).key).toBe("restarting");
    expect(deriveStatusChip({ connectivityMode: "alphaclaw_booting" }).key).toBe("starting");
  });

  it("never shows a stale snapshot as live, even one holding a restart lock", () => {
    const stale = { statusFreshness: { mode: "stale", observedAtMs: 1, receivedAtMs: 2 } };
    for (const payload of [frame("running", "Running"), frame("running", "Running", { operation: { kind: "restart" } })]) {
      const chip = deriveStatusChip(shellFromFrame(payload, stale));
      expect(chip.key).toBe("connecting");
      expect(chip.word).toBe("Checking…");
    }
    expect(deriveStatusChip({ ...shellFromFrame(frame("running", "Running"), stale), restartOperation: { phase: "running" } }).key).toBe(
      "restarting",
    );
  });

  it("names the server's label in the title", () => {
    expect(deriveStatusChip(shellFromFrame(frame("degraded", "Running with issues"))).title).toBe(
      "Gateway: Running with issues",
    );
  });
});

describe("StatusChip", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("the chip must not fetch")));
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it.each([
    ["running", { hasStatus: true, statusState: { state: "running", label: "Running" } }, "Running"],
    ["restarting", { hasStatus: true, restartOperation: { phase: "running" } }, "Restarting"],
    ["degraded", { hasStatus: true, statusState: { state: "degraded", label: "Running with issues" } }, "Degraded"],
    ["down", { hasStatus: true, statusState: { state: "down", label: "Down" } }, "Down"],
    ["connecting", { hasStatus: false }, "Connecting…"],
    ["offline", { connectivityMode: "unreachable" }, "Offline"],
  ])("renders %s as a dot plus a word linking to Health, with no request", (key, shell, word) => {
    currentShell = shell;
    const vnode = StatusChip({});
    expect(vnode.type).toBe("a");
    expect(vnode.props.href).toBe("#/health");
    expect(vnode.props["data-state"]).toBe(key);
    expect(vnode.props["aria-label"]).toBe(`Gateway status: ${word}. Open Health`);
    const [dot, label] = vnode.props.children.filter((child) => child && typeof child === "object");
    expect(dot.props.class).toBe(`status-chip-dot status-chip-dot--${key}`);
    expect(dot.props["aria-hidden"]).toBe("true");
    expect(label.props.children).toBe(word);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("is plain text for a member, who cannot open Health", () => {
    currentShell = { hasStatus: true, statusState: { state: "running", label: "Running" } };
    const vnode = StatusChip({ linkToHealth: false });
    expect(vnode.type).toBe("span");
    expect(vnode.props.href).toBeUndefined();
    expect(vnode.props["data-state"]).toBe("running");
    expect(vnode.props["aria-label"]).toBeUndefined();
  });
});
