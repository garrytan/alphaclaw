const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const {
  createGatewayMutationPolicy,
  kGatewayMutationIntents,
  assertApplyBackupAdmission,
} = require("../../lib/server/gateway-mutation-policy");

describe("apply backup admission", () => {
  const original = { reason: "config_migration_failed", at: 1, bootId: "original", detail: { source: "stable" } };

  const withPolicy = ({ initialHold = null } = {}) => {
    const lock = createGatewayLifecycleLock();
    let info = initialHold ? { gatewayHold: structuredClone(initialHold) } : {};
    const getChannelInfo = vi.fn(() => info);
    const policy = createGatewayMutationPolicy({ lock, getChannelInfo, isApplyInProgress: () => true });
    return { lock, policy, getChannelInfo, change: (value) => { info = value; } };
  };

  it.each([null, original])("rechecks a fresh lease for both pauses without changing the captured hold: %j", async (recoveryHold) => {
    const cell = withPolicy({ initialHold: recoveryHold });
    for (let pause = 0; pause < 2; pause += 1) {
      const hold = await cell.lock.acquire("backup_quiesce");
      try {
        expect(() => assertApplyBackupAdmission({ ...cell, hold, recoveryHold })).not.toThrow();
        expect(cell.lock.owns(hold)).toBe(true);
      } finally { hold(); }
    }
    expect(cell.getChannelInfo).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["new hold", null, { gatewayHold: original }, "gateway_held"],
    ["replacement hold", original, { gatewayHold: { ...original, at: 2 } }, "gateway_held"],
    ["changed nested facts", original, { gatewayHold: { ...original, detail: { source: "beta" } } }, "gateway_held"],
    ["corrupt state", original, { stateCorrupted: true, gatewayHold: original }, "gateway_hold_unreadable"],
  ])("refuses %s before the next pause can mutate the gateway", async (_name, recoveryHold, changed, code) => {
    const cell = withPolicy({ initialHold: recoveryHold });
    const first = await cell.lock.acquire("backup_quiesce");
    assertApplyBackupAdmission({ ...cell, hold: first, recoveryHold });
    first();
    cell.change(changed);
    const second = await cell.lock.acquire("backup_quiesce");
    const stop = vi.fn();
    try {
      expect(() => {
        assertApplyBackupAdmission({ ...cell, hold: second, recoveryHold });
        stop();
      }).toThrow(expect.objectContaining({ code, blocked: true }));
      expect(stop).not.toHaveBeenCalled();
    } finally { second(); }
    expect(cell.lock.getActiveOperation()).toBeNull();
  });

  it("refuses unreadable authority even if it was readable at admission", async () => {
    const cell = withPolicy({ initialHold: original });
    const hold = await cell.lock.acquire("backup_quiesce");
    cell.getChannelInfo.mockImplementation(() => { throw new Error("state read failed"); });
    try {
      expect(() => assertApplyBackupAdmission({ ...cell, hold, recoveryHold: original }))
        .toThrow(expect.objectContaining({ code: "gateway_hold_unreadable" }));
    } finally { hold(); }
  });

  it("rejects forged, stale and unrelated lease handles through the real policy", async () => {
    const cell = withPolicy();
    const first = await cell.lock.acquire("backup_quiesce");
    const forged = Object.assign(() => {}, first);
    expect(() => assertApplyBackupAdmission({ ...cell, hold: forged }))
      .toThrow(expect.objectContaining({ code: "lease_expired" }));
    first();
    const second = await cell.lock.acquire("backup_quiesce");
    try {
      expect(() => assertApplyBackupAdmission({ ...cell, hold: first }))
        .toThrow(expect.objectContaining({ code: "lease_expired" }));
      expect(cell.lock.owns(second)).toBe(true);
    } finally { second(); }
    const apply = await cell.lock.acquire("apply_commit");
    try {
      expect(() => assertApplyBackupAdmission({ ...cell, hold: apply }))
        .toThrow(expect.objectContaining({ code: "apply_in_progress" }));
    } finally { apply(); }
  });

  it("keeps standalone backup and activation separate from apply backup recovery", async () => {
    const cell = withPolicy({ initialHold: original });
    const hold = await cell.lock.acquire("backup_quiesce");
    try {
      const options = { hold, recoveryHold: original };
      expect(cell.policy.read({ ...options, intent: kGatewayMutationIntents.backup }).code).toBe("gateway_held");
      expect(cell.policy.read({ ...options, intent: kGatewayMutationIntents.applyRecovery }).code).toBe("apply_in_progress");
      expect(cell.policy.read({ ...options, intent: "applyBackup" }).code).toBe("apply_in_progress");
      expect(cell.policy.read({ ...options, intent: kGatewayMutationIntents.applyBackup })).toBeNull();
    } finally { hold(); }
  });

  it("preserves legacy caller-owned leases while enforcing the same hold-state checks", () => {
    let info = { gatewayHold: structuredClone(original) };
    const options = { hold: () => {}, recoveryHold: original, getChannelInfo: () => info };
    expect(() => assertApplyBackupAdmission(options)).not.toThrow();
    info = { gatewayHold: { ...original, bootId: "replacement" } };
    expect(() => assertApplyBackupAdmission(options)).toThrow(expect.objectContaining({ code: "gateway_held" }));
    info = { stateCorrupted: true, gatewayHold: original };
    expect(() => assertApplyBackupAdmission(options)).toThrow(expect.objectContaining({ code: "gateway_hold_unreadable" }));
    info = { gatewayHold: original };
    expect(() => assertApplyBackupAdmission({ ...options, recoveryHold: null }))
      .toThrow(expect.objectContaining({ code: "gateway_held" }));
  });
});
