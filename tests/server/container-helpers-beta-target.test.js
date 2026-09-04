const { resolveBetaTarget } = require("../container/container-helpers");

// The container e2e's "beta" target must be what AlphaClaw's Beta catalog
// section offers — the newest prerelease above the stable pin — and never the
// raw `beta` dist-tag, which upstream re-points at the promoted stable release
// when a beta line ships (2026-09-03: beta = latest = 2026.9.1). The container
// tier itself needs docker, so the resolver is pinned here, hermetically.
const versionsOf = (...list) => Object.fromEntries(list.map((v) => [v, {}]));

describe("container e2e: resolveBetaTarget", () => {
  it("honors the beta dist-tag when it is itself the newest eligible prerelease", () => {
    expect(
      resolveBetaTarget({
        distTags: { latest: "2026.8.2", beta: "2026.9.1-beta.1" },
        versions: versionsOf("2026.8.1-beta.3", "2026.8.1", "2026.8.2", "2026.9.1-beta.1"),
        stablePin: "2026.7.1-2",
      }),
    ).toEqual({ version: "2026.9.1-beta.1", source: "dist-tag", tagged: "2026.9.1-beta.1" });
  });

  it("falls back to the newest prerelease when the beta tag was promoted to a stable release", () => {
    // The 2026-09-04 CI failure: beta = latest = 2026.9.1, the Beta section
    // still lists 2026.9.1-beta.1, and the box correctly came back on it.
    expect(
      resolveBetaTarget({
        distTags: { latest: "2026.9.1", beta: "2026.9.1", "extended-stable": "2026.6.34" },
        versions: versionsOf(
          "2026.6.34",
          "2026.8.1-beta.1",
          "2026.8.1-beta.2",
          "2026.8.1-beta.3",
          "2026.9.1-beta.1",
          "2026.8.1",
          "2026.8.2",
          "2026.9.1",
        ),
        stablePin: "2026.7.1-2",
      }),
    ).toEqual({ version: "2026.9.1-beta.1", source: "newest-prerelease", tagged: "2026.9.1" });
  });

  it("returns no target when every prerelease is at or below the pin's core version", () => {
    expect(
      resolveBetaTarget({
        distTags: { latest: "2026.9.1", beta: "2026.9.1" },
        versions: versionsOf("2026.8.1-beta.3", "2026.9.1-beta.1", "2026.9.1"),
        stablePin: "2026.9.1",
      }),
    ).toEqual({ version: null, source: "none", tagged: "2026.9.1" });
  });

  it("does not treat a prerelease of the pin's own core as an upgrade over the hotfix pin", () => {
    // 2026.7.1-beta.6 predates the 2026.7.1-2 hotfix even though a loose
    // segment compare would sort "beta" above "2".
    expect(
      resolveBetaTarget({
        distTags: { latest: "2026.7.1-2", beta: "2026.7.1-beta.6" },
        versions: versionsOf("2026.7.1-beta.6", "2026.7.1-2"),
        stablePin: "2026.7.1-2",
      }).version,
    ).toBeNull();
    expect(
      resolveBetaTarget({
        distTags: { latest: "2026.7.1-2", beta: "2026.7.1-beta.6" },
        versions: versionsOf("2026.7.1-beta.6", "2026.7.2-beta.1", "2026.7.1-2"),
        stablePin: "2026.7.1-2",
      }),
    ).toEqual({ version: "2026.7.2-beta.1", source: "newest-prerelease", tagged: "2026.7.1-beta.6" });
  });

  it("never picks a bare numeric hotfix suffix as a beta", () => {
    expect(
      resolveBetaTarget({
        distTags: { latest: "2026.7.1-2", beta: "2026.7.1-2" },
        versions: versionsOf("2026.7.1", "2026.7.1-2"),
        stablePin: "2026.6.34",
      }),
    ).toEqual({ version: null, source: "none", tagged: "2026.7.1-2" });
  });

  it("orders prerelease counters and minors numerically, not lexically", () => {
    expect(
      resolveBetaTarget({
        distTags: {},
        versions: versionsOf("2026.9.1-beta.9", "2026.9.1-beta.10", "2026.10.1-beta.1"),
        stablePin: "2026.8.2",
      }).version,
    ).toBe("2026.10.1-beta.1");
    expect(
      resolveBetaTarget({
        distTags: {},
        versions: versionsOf("2026.9.1-beta.9", "2026.9.1-beta.10"),
        stablePin: "2026.8.2",
      }).version,
    ).toBe("2026.9.1-beta.10");
  });

  it("counts a tagged prerelease that is missing from the versions map", () => {
    expect(
      resolveBetaTarget({
        distTags: { beta: "2026.9.2-beta.1" },
        versions: versionsOf("2026.9.1"),
        stablePin: "2026.9.1",
      }),
    ).toEqual({ version: "2026.9.2-beta.1", source: "dist-tag", tagged: "2026.9.2-beta.1" });
  });

  it("tolerates a missing dist-tags object and an empty versions map", () => {
    expect(resolveBetaTarget({ distTags: null, versions: null, stablePin: "2026.7.1-2" })).toEqual({
      version: null,
      source: "none",
      tagged: null,
    });
  });
});
