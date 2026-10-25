const { createDoctorLintRunner } = require("../../lib/server/doctor/lint-runner");
const { kAdvisoryLintCheckIds } = require("../../lib/server/doctor/advisory-findings");
const { classifyFromRunStream } = require("../../lib/server/doctor/classify-doctor-cli");

// ALPH-36: one owner of `doctor --lint --json`. A full lint is never killed
// mid-copy by a fixed 60 s ceiling, never stacks across callers, and a run
// that still times out is swept only after it has exited.
const kFindings = JSON.stringify({ schemaVersion: 1, ok: true, checksRun: 4, checksSkipped: 0, findings: [] });

describe("doctor lint runner", () => {
  let now;
  let spawns;
  let order;
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  };
  const build = (overrides = {}) => {
    const logger = { warn: vi.fn(), log: vi.fn() };
    const recordAvailability = vi.fn();
    const runner = createDoctorLintRunner({
      runStreamed: (options) => {
        const job = deferred();
        spawns.push({ options, ...job });
        return job.promise;
      },
      getEnv: () => ({ HOME: "/home/test" }),
      resolveTimeoutMs: (floorMs) => Math.max(floorMs, 690_000),
      trackSnapshotCopies: () => ({ sweepAfterKill: () => order.push("sweep") }),
      classify: classifyFromRunStream,
      recordAvailability,
      timeoutFloorMs: 60_000,
      captureBytes: 1024 * 1024,
      cooldownMs: 15 * 60_000,
      timeoutCooldownMs: 60 * 60_000,
      nowMs: () => now,
      logger,
      ...overrides,
    });
    return { runner, logger, recordAvailability };
  };

  beforeEach(() => {
    now = 1_000_000;
    spawns = [];
    order = [];
  });

  it("sizes a full lint's ceiling from the state and keeps the floor for --only checks", async () => {
    const { runner, logger } = build();
    const full = runner.run();
    const only = runner.run({ only: kAdvisoryLintCheckIds });
    now += 72_000;
    expect(spawns).toHaveLength(2);
    expect(spawns[0].options).toMatchObject({ command: "openclaw", args: ["doctor", "--lint", "--json"], timeoutMs: 690_000 });
    expect(spawns[1].options.timeoutMs).toBe(60_000);
    expect(spawns[1].options.args).toEqual([
      "doctor", "--lint", "--json",
      "--only", "core/doctor/gateway-auth",
      "--only", "core/doctor/gateway-config",
      "--only", "core/doctor/gateway-health",
      "--only", "core/doctor/security",
    ]);
    spawns.forEach((spawn) => spawn.resolve({ ok: true, code: 0, tail: kFindings, timedOut: false }));
    await expect(full).resolves.toMatchObject({ ok: true, timedOut: false, classification: { status: "usable" } });
    await expect(only).resolves.toMatchObject({ ok: true, classification: { status: "usable" } });
    expect(logger.log.mock.calls).toEqual([["[alphaclaw] doctor --lint finished in 72s (ceiling 690s)"]]);
  });

  it("runs one full lint for every caller at a time and reuses it through the cooldown", async () => {
    const { runner, recordAvailability } = build();
    const first = runner.run();
    const second = runner.run();
    const third = runner.run({ only: [] });
    expect(spawns).toHaveLength(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
    spawns[0].resolve({ ok: true, code: 0, tail: kFindings, timedOut: false });
    await first;
    expect(recordAvailability).toHaveBeenCalledTimes(1);

    now += 14 * 60_000;
    await expect(runner.run()).resolves.toMatchObject({ reused: true, ok: true });
    expect(spawns).toHaveLength(1);
    expect(recordAvailability).toHaveBeenCalledTimes(1);

    now += 2 * 60_000;
    const fresh = runner.run();
    expect(spawns).toHaveLength(2);
    spawns[1].resolve({ ok: true, code: 0, tail: kFindings, timedOut: false });
    await expect(fresh).resolves.not.toHaveProperty("reused");
  });

  it("never reuses --only runs, but joins one already running for the same checks", async () => {
    const { runner } = build();
    const a = runner.run({ only: ["core/doctor/security", "core/doctor/gateway-health"] });
    const b = runner.run({ only: ["core/doctor/gateway-health", "core/doctor/security"] });
    expect(b).toBe(a);
    spawns[0].resolve({ ok: true, code: 0, tail: kFindings, timedOut: false });
    await a;
    runner.run({ only: ["core/doctor/security", "core/doctor/gateway-health"] });
    expect(spawns).toHaveLength(2);
  });

  it("logs a timed-out lint, sweeps its copies only after it exited, and holds full lints off for the longer cooldown", async () => {
    const { runner, logger } = build();
    const run = runner.run();
    expect(order).toEqual([]);
    order.push("exited");
    spawns[0].resolve({ ok: false, code: null, tail: "", timedOut: true });
    await expect(run).resolves.toMatchObject({ timedOut: true, timeoutMs: 690_000 });
    expect(order).toEqual(["exited", "sweep"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "[alphaclaw] doctor --lint timed out after 690s and was stopped; removing the snapshot copies it left once it has exited",
    );

    now += 30 * 60_000;
    await expect(runner.run()).resolves.toMatchObject({ reused: true, timedOut: true });
    expect(spawns).toHaveLength(1);
    now += 31 * 60_000;
    runner.run();
    expect(spawns).toHaveLength(2);
  });

  it("does not hold a spawn failure as a result, and records it", async () => {
    const recordAvailability = vi.fn();
    const runner = createDoctorLintRunner({
      runStreamed: async () => { throw new Error("spawn openclaw ENOENT"); },
      getEnv: () => ({}),
      resolveTimeoutMs: (floorMs) => floorMs,
      trackSnapshotCopies: () => ({ sweepAfterKill: () => {} }),
      classify: classifyFromRunStream,
      recordAvailability,
      timeoutFloorMs: 60_000,
      captureBytes: 1024,
      cooldownMs: 15 * 60_000,
      timeoutCooldownMs: 60 * 60_000,
      nowMs: () => now,
    });
    await expect(runner.run()).resolves.toMatchObject({ ok: false, classification: { status: "unavailable", reason: "spawn_failed" } });
    await expect(runner.run()).resolves.not.toHaveProperty("reused");
    expect(recordAvailability).toHaveBeenCalledTimes(2);
  });
});
