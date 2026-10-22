const {
  createFeatureGates,
  kFeatureMinVersions,
} = require("../../lib/server/openclaw-feature-gates");

const gatesFor = (version) =>
  createFeatureGates({ getInstalledVersion: () => version });

describe("server/openclaw-feature-gates", () => {
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
  });

  it("no longer exposes a version-gated supportsFeature", () => {
    expect(gatesFor("2026.10.4").supportsFeature).toBeUndefined();
  });
});
