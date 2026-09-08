const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createGatewayMutationPolicy, kGatewayMutationIntents, GatewayMutationBlockedError,
  restartDeferredFields } = require("../../lib/server/gateway-mutation-policy");

describe("gateway mutation admission", () => {
  it("rechecks a queued operation after a migration hold appears", async () => {
    const lock = createGatewayLifecycleLock();
    let info = {};
    const policy = createGatewayMutationPolicy({ lock, getChannelInfo: () => info });
    expect(policy.read({ preLock: true })).toBeNull();
    const prior = lock.tryAcquire("repair");
    const waiting = lock.acquire("restart");
    info = { gatewayHold: { reason: "config_migration_failed" } };
    prior();
    const hold = await waiting;
    try {
      expect(() => policy.assert({ hold })).toThrow(GatewayMutationBlockedError);
      expect(policy.read({ hold }).code).toBe("gateway_held");
    } finally { hold(); }
  });

  it("fences the actual restart after asynchronous preparation changes the hold", async () => {
    const lock = createGatewayLifecycleLock();
    const hold = await lock.acquire("restart");
    let info = {};
    const policy = createGatewayMutationPolicy({ lock, getChannelInfo: () => info });
    const spawn = vi.fn();
    try {
      await expect(policy.restart({ hold, restartGateway: async ({ shouldAbort }) => {
        await Promise.resolve();
        info = { gatewayHold: { reason: "version_mismatch" } };
        if (shouldAbort()) throw new Error("aborted_by_caller");
        spawn();
      } })).rejects.toMatchObject({ code: "gateway_held", restartDeferred: true });
      expect(spawn).not.toHaveBeenCalled();
    } finally { hold(); }
  });

  it("only a real current apply lease can pass its own apply latch", async () => {
    const lock = createGatewayLifecycleLock();
    const policy = createGatewayMutationPolicy({ lock, isApplyInProgress: () => true });
    const hold = await lock.acquire("apply_commit");
    try {
      expect(policy.read({ hold }).code).toBe("apply_in_progress");
      expect(policy.read({ hold, intent: "apply" }).code).toBe("apply_in_progress");
      expect(policy.read({ hold, intent: kGatewayMutationIntents.apply })).toBeNull();
      const forged = Object.assign(() => {}, hold);
      expect(policy.read({ hold: forged, intent: kGatewayMutationIntents.apply }).code).toBe("lease_expired");
    } finally { hold(); }
    const successor = await lock.acquire("apply_commit");
    try {
      expect(policy.read({ hold, intent: kGatewayMutationIntents.apply }).code).toBe("lease_expired");
      expect(lock.owns(successor)).toBe(true);
    } finally { successor(); }
  });

  it("reconciliation can own a structural hold but never a migration or corrupt state", async () => {
    const lock = createGatewayLifecycleLock();
    const hold = await lock.acquire("reconcile_installed");
    let info = { gatewayHold: { reason: "version_mismatch" } };
    const policy = createGatewayMutationPolicy({ lock, getChannelInfo: () => info });
    const options = { hold, intent: kGatewayMutationIntents.reconcile };
    try {
      expect(policy.read(options)).toBeNull();
      info.gatewayHold.reason = "config_migration_failed";
      expect(policy.read(options).code).toBe("gateway_held");
      info = { stateCorrupted: true };
      expect(policy.read(options).code).toBe("gateway_hold_unreadable");
    } finally { hold(); }
  });

  it("backed-up apply recovery owns only its original hold under the current apply lease", async () => {
    const lock = createGatewayLifecycleLock();
    const hold = await lock.acquire("apply_commit");
    const recoveryHold = { reason: "version_mismatch", at: 1, bootId: "first" };
    let info = { gatewayHold: { ...recoveryHold } };
    const policy = createGatewayMutationPolicy({ lock, getChannelInfo: () => info, isApplyInProgress: () => true });
    const options = { hold, recoveryHold, intent: kGatewayMutationIntents.applyRecovery };
    try {
      expect(policy.read(options)).toBeNull();
      expect(policy.read({ ...options, intent: "applyRecovery" }).code).toBe("apply_in_progress");
      expect(policy.read({ ...options, intent: kGatewayMutationIntents.apply }).code).toBe("gateway_held");
      info = { gatewayHold: { ...recoveryHold, at: 2 } };
      expect(policy.read(options).code).toBe("gateway_held");
      info = { stateCorrupted: true, gatewayHold: recoveryHold };
      expect(policy.read(options).code).toBe("gateway_hold_unreadable");
    } finally { hold(); }
    expect(policy.read(options).code).toBe("lease_expired");
  });

  it("reports structural remedies and accurate partial-save outcomes", () => {
    const policy = createGatewayMutationPolicy({ getChannelInfo: () => ({
      gatewayHold: { reason: "state_db_unreadable" },
    }) });
    const blocker = policy.read();
    expect(blocker.hint).toContain("alphaclaw diagnose");
    expect(blocker.error).not.toContain("Retry migration");
    expect(restartDeferredFields(new GatewayMutationBlockedError(blocker))).toMatchObject({
      configSaved: true, restartDeferred: true, restartRequired: true, code: "gateway_held",
    });
    expect(restartDeferredFields(new Error("launch failed"))).toEqual({});
  });
});
