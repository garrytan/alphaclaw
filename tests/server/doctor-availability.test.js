// Doctor-CLI availability tracker + single-flight evidence collector.
const {
  createDoctorAvailability,
} = require("../../lib/server/doctor/availability");
const {
  createDoctorJsonCollector,
} = require("../../lib/server/doctor/collect-doctor-json");

const unavailable = { status: "unavailable", reason: "cli_error", detail: "boom" };
const usable = { status: "usable", reason: "findings" };

describe("createDoctorAvailability", () => {
  it("emits transition-only events: N consecutive failures = 1 event; recovery = 1 event", () => {
    const events = [];
    const logs = [];
    const availability = createDoctorAvailability({
      nowFn: () => 1000,
      getInstalledVersion: () => "2026.9.1-beta.1",
      onEvent: (e) => events.push(e),
      log: (l) => logs.push(l),
    });
    availability.record(unavailable, { source: "t" });
    availability.record(unavailable, { source: "t" });
    availability.record(unavailable, { source: "t" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "doctor_probe", status: "failed" });
    expect(availability.get()).toMatchObject({
      status: "unavailable",
      consecutiveUnavailable: 3,
    });
    // One process.log-bound line per transition, greppable mid-incident.
    expect(logs.join("\n")).toContain("UNAVAILABLE");
    expect(logs).toHaveLength(1);

    availability.record(usable, { source: "t" });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ kind: "doctor_probe", status: "ok" });
    expect(availability.get()).toMatchObject({ status: "usable" });
  });

  it("a version change (channel apply) resets state — the new build may have fixed the CLI", () => {
    let version = "A";
    const events = [];
    const availability = createDoctorAvailability({
      getInstalledVersion: () => version,
      onEvent: (e) => events.push(e),
      log: () => {},
    });
    availability.record(unavailable);
    expect(availability.get().consecutiveUnavailable).toBe(1);
    version = "B";
    availability.record(unavailable);
    // Fresh state on B: counter restarted AND a fresh transition event.
    expect(availability.get()).toMatchObject({
      version: "B",
      consecutiveUnavailable: 1,
    });
    expect(events).toHaveLength(2);
  });

  it("a throwing event sink is harmless (pre-watchdog-wire drop)", () => {
    const availability = createDoctorAvailability({
      onEvent: () => {
        throw new Error("not wired yet");
      },
      log: () => {},
    });
    expect(() => availability.record(unavailable)).not.toThrow();
    expect(availability.get().status).toBe("unavailable");
  });
});

describe("createDoctorJsonCollector (single-flight, per-call budgets)", () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it("coalesces concurrent callers onto ONE spawn and re-collects after settle", async () => {
    let spawns = 0;
    let gate = deferred();
    const collector = createDoctorJsonCollector({
      runLintJson: async () => {
        spawns += 1;
        await gate.promise;
        return { ok: true, stdout: "DOC", classification: usable };
      },
      classify: (r) => r.classification,
    });
    const a = collector.collect();
    const b = collector.collect();
    gate.resolve();
    expect(await a).toBe("DOC");
    expect(await b).toBe("DOC");
    expect(spawns).toBe(1);
    // The in-flight slot cleared: a later collect runs a FRESH spawn (a
    // never-cleared slot would freeze availability forever).
    gate = deferred();
    gate.resolve();
    await collector.collect();
    expect(spawns).toBe(2);
  });

  it("races per-call budgets in both join orders; the shared spawn still records availability", async () => {
    vi.useFakeTimers();
    try {
      const recorded = [];
      const availability = { record: (c) => recorded.push(c) };
      const gate = deferred();
      const collector = createDoctorJsonCollector({
        runLintJson: async () => {
          await gate.promise;
          return { ok: true, stdout: "DOC", classification: usable };
        },
        classify: (r) => r.classification,
        availability,
      });
      // Short-budget caller first, long-budget joiner second.
      const short = collector.collect({ timeoutMs: 20_000 });
      const long = collector.collect({ timeoutMs: 60_000 });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await short).toBeNull(); // personal expiry — proceeds without a hint
      await vi.advanceTimersByTimeAsync(10_000);
      gate.resolve();
      expect(await long).toBe("DOC"); // the spawn completed for the long caller
      expect(recorded).toHaveLength(1); // ...and availability recorded once
    } finally {
      vi.useRealTimers();
    }
  });

  it("reverse join order: a short-budget joiner nulls out while the earlier long caller completes", async () => {
    vi.useFakeTimers();
    try {
      const gate = deferred();
      const collector = createDoctorJsonCollector({
        runLintJson: async () => {
          await gate.promise;
          return { ok: true, stdout: "DOC", classification: usable };
        },
        classify: (r) => r.classification,
      });
      const long = collector.collect({ timeoutMs: 60_000 });
      const short = collector.collect({ timeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await short).toBeNull();
      gate.resolve();
      expect(await long).toBe("DOC");
    } finally {
      vi.useRealTimers();
    }
  });

  it("NEVER returns stderr content: unavailable/unusable classifications yield null (the incident's laundering fix)", async () => {
    const collector = createDoctorJsonCollector({
      runLintJson: async () => ({
        ok: false,
        stdout: "Could not start the CLI.\nReason: codex/api.js",
        classification: {
          status: "unavailable",
          reason: "cli_startup_crash",
          detail: "Could not start the CLI.",
        },
      }),
      classify: (r) => r.classification,
    });
    expect(await collector.collect()).toBeNull();

    const unusableCollector = createDoctorJsonCollector({
      runLintJson: async () => ({
        ok: false,
        stdout: "partial…",
        classification: { status: "unusable", reason: "timeout" },
      }),
      classify: (r) => r.classification,
    });
    expect(await unusableCollector.collect()).toBeNull();
  });

  it("a rejecting runner classifies as spawn_failed and records availability", async () => {
    const recorded = [];
    const collector = createDoctorJsonCollector({
      runLintJson: async () => {
        throw new Error("spawn openclaw ENOENT");
      },
      classify: () => {
        throw new Error("never called");
      },
      availability: { record: (c) => recorded.push(c) },
    });
    expect(await collector.collect()).toBeNull();
    expect(recorded[0]).toMatchObject({
      status: "unavailable",
      reason: "spawn_failed",
    });
  });
});
