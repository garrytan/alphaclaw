const {
  createFeatureGates,
  kFeatureMinVersions,
} = require("../../lib/server/openclaw-feature-gates");

const gatesFor = (version) =>
  createFeatureGates({ getInstalledVersion: () => version });

describe("server/openclaw-feature-gates", () => {
  it("opens the 2026.8.1 beta-line gates on a beta install and keeps stable closed", () => {
    const beta = gatesFor("2026.8.1-beta.1");
    expect(beta.supportsFeature("supervisorMode")).toBe(true);
    expect(beta.supportsFeature("sessionDashboards")).toBe(true);
    expect(beta.supportsFeature("secretEgressBinding")).toBe(true);

    const stable = gatesFor("2026.7.1-2");
    expect(stable.supportsFeature("supervisorMode")).toBe(false);
    expect(stable.supportsFeature("sessionDashboards")).toBe(false);
    // trustedProxyAuth already ships on the pinned stable.
    expect(stable.supportsFeature("trustedProxyAuth")).toBe(true);
  });

  it("fails closed for unknown features, dev shas, and unreadable versions", () => {
    expect(gatesFor("2026.9.1").supportsFeature("nonexistentFeature")).toBe(false);
    // Dev builds are identified by commit sha — no calver range applies.
    expect(gatesFor("a1b2c3d").supportsFeature("supervisorMode")).toBe(false);
    expect(gatesFor(null).supportsFeature("supervisorMode")).toBe(false);
    const throwing = createFeatureGates({
      getInstalledVersion: () => {
        throw new Error("unreadable");
      },
    });
    expect(throwing.supportsFeature("supervisorMode")).toBe(false);
  });

  it("supportsFeature still compares each declared floor (Doctor context profile, until PR 16b-2)", () => {
    const gates = gatesFor("2026.8.1-beta.2");
    expect(gates.supportsFeature("supervisorMode")).toBe(true);
    expect(gates.supportsFeature("bootstrapContractV2")).toBe(true);
    expect(gates.supportsFeature("execApprovalsSqlite")).toBe(false);
  });

  it("features() answers every gate true on any version read, keeping the keys", () => {
    for (const version of ["2026.10.4", "2026.7.1-2", "a1b2c3d", null]) {
      const answer = gatesFor(version).features();
      expect(Object.keys(answer.features).sort()).toEqual(Object.keys(kFeatureMinVersions).sort());
      expect(Object.values(answer.features).every((v) => v === true)).toBe(true);
    }
    expect(gatesFor("2026.10.4").features().version).toBe("2026.10.4");
    expect(gatesFor("a1b2c3d").features().version).toBe(null);
    const throwing = createFeatureGates({
      getInstalledVersion: () => {
        throw new Error("unreadable");
      },
    });
    expect(throwing.features()).toEqual({
      version: null,
      features: Object.fromEntries(Object.keys(kFeatureMinVersions).map((k) => [k, true])),
    });
    expect(throwing.supportsFeature("sessionDashboards")).toBe(false);
  });
});
