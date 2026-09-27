const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createDatabaseRecoveryController } = require("../../lib/server/watchdog-db-recovery");

const setup = () => {
  const lock = createGatewayLifecycleLock();
  const state = { autoRepair: true, managed: true, epoch: 1, generation: 1, pause: null,
    gatewayHold: { reason: "state_db_unverified", at: 1 } };
  let time = 0;
  const verify = vi.fn(async () => ({ ok: false, code: "state_db_unverified" }));
  const launch = vi.fn(async () => ({ ok: true, verdict: "launch_requested" }));
  const beforeLaunch = vi.fn();
  const onResult = vi.fn();
  const controller = createDatabaseRecoveryController({ readState: () => ({ ...state }),
    tryAcquire: (...args) => lock.tryAcquire(...args), verify, launch, beforeLaunch, onResult, now: () => time });
  return { state, lock, verify, launch, beforeLaunch, onResult, controller, advance: (ms) => { time += ms; } };
};

describe("database verification retry controller", () => {
  it("keeps the sixty-second cadence after repeated identical failures and dedupes only logs", async () => {
    const h = setup();
    for (let i = 0; i < 10; i++) {
      await h.controller.tick();
      expect(h.verify).toHaveBeenCalledTimes(i + 1);
      await h.controller.tick();
      expect(h.verify).toHaveBeenCalledTimes(i + 1);
      h.advance(60_000);
    }
    expect(h.onResult).toHaveBeenCalledTimes(1);
    h.verify.mockResolvedValue({ ok: true, recoveryId: "one" });
    await h.controller.tick();
    expect(h.launch).toHaveBeenCalledTimes(1);
    expect(h.beforeLaunch).toHaveBeenCalledTimes(1);
    expect(h.onResult).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["stopped", true], ["shuttingDown", true], ["autoRepair", false], ["managed", false],
    ["busy", true], ["relaunching", true], ["stateCorrupted", true],
    ["unrelatedConfigurationError", true],
    ["pause", { reason: "version_mismatch" }], ["gatewayHold", { reason: "recovery_choice_required" }],
  ])("does not assess or queue while %s prevents recovery", async (field, value) => {
    const h = setup();
    h.state[field] = value;
    expect((await h.controller.tick()).skipped).toBe(true);
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.controller.describe().nextEligibleAt).toBeNull();
  });

  it("does not spend cadence while a lifecycle owner is busy", async () => {
    const h = setup();
    const prior = h.lock.tryAcquire("apply_commit");
    await h.controller.tick();
    expect(h.verify).not.toHaveBeenCalled();
    prior();
    await h.controller.tick();
    expect(h.verify).toHaveBeenCalledTimes(1);
  });

  it.each(["stopped", "shuttingDown", "epoch", "generation", "autoRepair", "pause"])(
    "discards a successful observation after %s changes during its await", async (field) => {
      const h = setup();
      let resume;
      h.verify.mockImplementation(async ({ isCurrent }) => {
        await new Promise((resolve) => { resume = resolve; });
        expect(isCurrent()).toBe(false);
        return { ok: true, recoveryId: "stale" };
      });
      const pending = h.controller.tick();
      await Promise.resolve();
      expect((await h.controller.tick()).code).toBe("verification_in_progress");
      h.state[field] = field === "autoRepair" ? false : field === "pause" ? { reason: "new" } : field === "epoch" || field === "generation" ? 2 : true;
      resume();
      await pending;
      expect(h.launch).not.toHaveBeenCalled();
      expect(h.beforeLaunch).not.toHaveBeenCalled();
      expect(h.lock.getActiveOperation()).toBeNull();
    });

  it("never launches after failed verification or an exception", async () => {
    const h = setup();
    h.verify.mockRejectedValue(Object.assign(new Error("bad state"), { code: "gateway_hold_unreadable" }));
    expect(await h.controller.tick()).toMatchObject({ ok: false, code: "gateway_hold_unreadable" });
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.lock.getActiveOperation()).toBeNull();
  });
});
