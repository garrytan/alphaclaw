const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createGatewayMutationPolicy, GatewayMutationBlockedError,
  restartDeferredFields } = require("../../lib/server/gateway-mutation-policy");

describe("gateway mutation admission", () => {
  it("admits an owned lease and refuses a released, superseded or forged one", async () => {
    const lock = createGatewayLifecycleLock();
    const policy = createGatewayMutationPolicy({ lock });
    const hold = await lock.acquire("restart");
    expect(policy.read({ hold })).toBeNull();
    const forged = Object.assign(() => {}, hold);
    expect(policy.read({ hold: forged })).toMatchObject({ code: "lease_expired", statusCode: 409 });
    hold();
    expect(policy.read({ hold }).code).toBe("lease_expired");
    const successor = await lock.acquire("restart");
    try {
      expect(policy.read({ hold }).code).toBe("lease_expired");
      expect(policy.read({ hold: successor })).toBeNull();
    } finally { successor(); }
  });

  it("checks lease validity even without a lock", () => {
    const policy = createGatewayMutationPolicy();
    expect(policy.read()).toBeNull();
    expect(policy.read({ hold: { isValid: () => true } })).toBeNull();
    expect(policy.read({ hold: { isValid: () => false } }).code).toBe("lease_expired");
  });

  it("refuses a pre-lock mutation while boot owns the gateway, and only pre-lock", async () => {
    const lock = createGatewayLifecycleLock();
    const policy = createGatewayMutationPolicy({ lock });
    expect(policy.read({ preLock: true })).toBeNull();
    const boot = await lock.acquire("boot");
    try {
      expect(policy.read({ preLock: true })).toMatchObject({ code: "booting", statusCode: 409 });
      expect(policy.read()).toBeNull();
      expect(() => policy.assert({ preLock: true })).toThrow(GatewayMutationBlockedError);
    } finally { boot(); }
    const repair = await lock.acquire("repair");
    try {
      expect(policy.read({ preLock: true })).toBeNull();
    } finally { repair(); }
  });

  it("fences the actual restart when the lease is lost during asynchronous preparation", async () => {
    const lock = createGatewayLifecycleLock();
    const hold = await lock.acquire("restart");
    const policy = createGatewayMutationPolicy({ lock });
    const spawn = vi.fn();
    await expect(policy.restart({ hold, restartGateway: async ({ shouldAbort }) => {
      expect(shouldAbort()).toBe(false);
      await Promise.resolve();
      hold();
      if (shouldAbort()) throw new Error("aborted_by_caller");
      spawn();
    } })).rejects.toMatchObject({ code: "lease_expired", blocked: true, restartDeferred: true });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses to start a restart without an owned lease and re-checks after it returns", async () => {
    const lock = createGatewayLifecycleLock();
    const policy = createGatewayMutationPolicy({ lock });
    const stale = await lock.acquire("restart");
    stale();
    const restartGateway = vi.fn();
    await expect(policy.restart({ hold: stale, restartGateway })).rejects.toBeInstanceOf(GatewayMutationBlockedError);
    expect(restartGateway).not.toHaveBeenCalled();

    const hold = await lock.acquire("restart");
    await expect(policy.restart({ hold, restartGateway: async () => { hold(); return { ok: true }; } }))
      .rejects.toMatchObject({ code: "lease_expired" });
  });

  it("passes through the caller's own shouldAbort, options and result, and rethrows unrelated failures", async () => {
    const lock = createGatewayLifecycleLock();
    const policy = createGatewayMutationPolicy({ lock });
    const hold = await lock.acquire("restart");
    try {
      let callerAbort = false;
      const result = await policy.restart({ hold, options: { reason: "manual", shouldAbort: () => callerAbort },
        restartGateway: async ({ reason, shouldAbort }) => {
          expect(reason).toBe("manual");
          expect(shouldAbort()).toBe(false);
          callerAbort = true;
          expect(shouldAbort()).toBe(true);
          return { ok: true };
        } });
      expect(result).toEqual({ ok: true });
      const failure = new Error("launch failed");
      await expect(policy.restart({ hold, restartGateway: async () => { throw failure; } })).rejects.toBe(failure);
    } finally { hold(); }
  });

  it("reports accurate partial-save outcomes", () => {
    const policy = createGatewayMutationPolicy({ lock: createGatewayLifecycleLock() });
    const blocker = policy.read({ hold: { isValid: () => false } });
    expect(blocker.hint).toContain("Wait for the current operation");
    expect(restartDeferredFields(new GatewayMutationBlockedError(blocker))).toEqual({
      configSaved: true, restartDeferred: true, restartRequired: true, code: "lease_expired", hint: blocker.hint,
    });
    expect(restartDeferredFields(new Error("launch failed"))).toEqual({});
  });
});
