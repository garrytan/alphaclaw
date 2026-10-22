const {
  createOpenclawCapabilities,
  kPinnedCapabilities,
  kCapabilityKeys,
} = require("../../lib/server/openclaw-capabilities");

describe("server/openclaw-capabilities pinned answers", () => {
  it("getAll answers the pinned constants for every key", async () => {
    const caps = createOpenclawCapabilities();
    expect(await caps.getAll()).toEqual({
      restartHandoff: { supported: true, protocolVersion: 1, consume: true },
      databasePreflight: true,
      backupSqlite: true,
      secretsStore: true,
      updateRepair: true,
      execApprovalsCli: true,
      execApprovalsSqlite: "sqlite",
      buzzChannel: true,
      clickclackGuidedSetup: true,
      trustedProxyTeam: true,
    });
    expect([...kCapabilityKeys].sort()).toEqual(Object.keys(kPinnedCapabilities).sort());
  });

  it("get answers each key from the same constants", async () => {
    const caps = createOpenclawCapabilities();
    for (const key of kCapabilityKeys) {
      expect(await caps.get(key)).toEqual(kPinnedCapabilities[key]);
    }
  });

  it("getAll hands out a copy, so a caller cannot change the constants", async () => {
    const caps = createOpenclawCapabilities();
    const first = await caps.getAll();
    first.buzzChannel = false;
    expect((await caps.getAll()).buzzChannel).toBe(true);
    expect(Object.isFrozen(kPinnedCapabilities)).toBe(true);
    expect(Object.isFrozen(kPinnedCapabilities.restartHandoff)).toBe(true);
  });

  it("rejects an unknown key, including the deleted doctorJsonShape", async () => {
    const caps = createOpenclawCapabilities();
    await expect(caps.get("doctorJsonShape")).rejects.toThrow(/unknown OpenClaw capability/);
    await expect(caps.get("__proto__")).rejects.toThrow(/unknown OpenClaw capability/);
    expect(kCapabilityKeys).not.toContain("doctorJsonShape");
  });
});
