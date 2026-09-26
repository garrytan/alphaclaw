const { beginRecoveryOperation } = require("../../lib/server/openclaw-recovery-operation");

describe("recovery transaction ownership", () => {
  const harness = () => {
    const events = [];
    let valid = true;
    let quietOptions;
    const hold = () => events.push("release");
    hold.isValid = () => valid;
    const gateway = {
      isRunning: async () => true,
      suppress: () => "mine",
      unsuppress: (owner) => events.push(`unsuppress:${owner}`),
      stop: async () => { events.push("stop"); return true; },
      start: async () => events.push("start"),
    };
    const options = { acquire: async () => hold, gateway,
      quiet: async (opts) => { quietOptions = opts; events.push("quiet"); return { release() {} }; },
      resume: () => events.push("resume"), assertPolicy: () => {} };
    return { events, options, loseLease: () => { valid = false; }, expireQuiet: () => quietOptions.onEvent({ status: "expired" }) };
  };

  it("keeps the capture-to-handoff window stopped and quiet", async () => {
    const h = harness();
    const transaction = await beginRecoveryOperation(h.options);
    transaction.handoff();
    await transaction.close();
    expect(h.events).toEqual(["stop", "quiet"]);
    transaction.defer();
    expect(h.events).toEqual(["stop", "quiet", "resume", "unsuppress:mine", "release"]);
  });

  it("bounds an unresolved acquisition without stopping or quieting the gateway", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.options.acquire = () => new Promise(() => {});
      const result = expect(beginRecoveryOperation({ ...h.options, acquireTimeoutMs: 15 }))
        .rejects.toMatchObject({ code: "recovery_lock_timeout" });
      await vi.advanceTimersByTimeAsync(15);
      await result;
      expect(h.events).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it("releases a late lease without stopping the gateway or retaining its ownership", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      let deliver;
      h.options.acquire = () => new Promise((resolve) => { deliver = resolve; });
      const result = expect(beginRecoveryOperation({ ...h.options, acquireTimeoutMs: 15 }))
        .rejects.toMatchObject({ code: "recovery_lock_timeout" });
      await vi.advanceTimersByTimeAsync(15);
      await result;
      const lateRelease = vi.fn();
      deliver(lateRelease);
      await vi.advanceTimersByTimeAsync(0);
      expect(lateRelease).toHaveBeenCalledOnce();
      expect(h.events).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it("does not restart after lease ownership passes to a successor", async () => {
    const h = harness();
    const transaction = await beginRecoveryOperation(h.options);
    h.loseLease();
    expect(() => transaction.assert()).toThrow("lease_expired");
    await transaction.close();
    expect(h.events).toEqual(["stop", "quiet", "resume", "unsuppress:mine", "release"]);
  });

  it("refuses expired quiet authority and unwinds only its own pause", async () => {
    const h = harness();
    const transaction = await beginRecoveryOperation(h.options);
    h.expireQuiet();
    expect(transaction.isQuiet()).toBe(false);
    expect(() => transaction.handoff()).toThrow("state_db_quiet_lost");
    await transaction.close();
    await transaction.close();
    expect(h.events).toEqual(["stop", "quiet", "resume", "start", "unsuppress:mine", "release"]);
  });

  it("attempts to recover a partially stopped gateway when stop cannot confirm", async () => {
    const h = harness();
    h.options.gateway.stop = async () => { h.events.push("stop"); return false; };
    await expect(beginRecoveryOperation(h.options)).rejects.toMatchObject({ code: "gateway_stop_unconfirmed" });
    expect(h.events).toEqual(["stop", "start", "unsuppress:mine", "release"]);
  });

  it("refuses success when relaunch returns without a running gateway", async () => {
    const h = harness();
    h.options.readinessTimeoutMs = 10;
    h.options.readinessPollMs = 1;
    const transaction = await beginRecoveryOperation(h.options);
    h.options.gateway.isRunning = async () => false;
    await expect(transaction.close()).rejects.toMatchObject({ code: "gateway_relaunch_failed" });
    expect(h.events).toEqual(["stop", "quiet", "resume", "start", "unsuppress:mine", "release"]);
  });
});
