const {
  formatDoctorMissingFileMarker,
  getProfilePathChangeWeight,
  kBeta81Profile,
  kDoctorBootstrapMaxChars,
  kDoctorBootstrapMinFileBudgetChars,
  kDoctorBootstrapNearLimitRatio,
  kDoctorBootstrapTotalMaxChars,
  kDoctorUserBootstrapMaxChars,
  kStableProfile,
  selectDoctorContextProfile,
} = require("../../lib/server/doctor/context-profiles");

// Golden contract fixtures: these values were verified against the published
// npm tarballs (openclaw@2026.7.1-2, @2026.8.1-beta.1, @2026.8.1-beta.3).
// A failing assertion here means the encoded upstream contract changed —
// re-verify per docs/designs/openclaw-context-contract.md before "fixing"
// the test (AGENTS.md doctrine: update the assumption, not the guard).
describe("server/doctor/context-profiles", () => {
  it("encodes the shared budgets verified from the tarballs", () => {
    expect(kDoctorBootstrapMaxChars).toBe(20000);
    expect(kDoctorBootstrapTotalMaxChars).toBe(60000);
    expect(kDoctorBootstrapNearLimitRatio).toBe(0.85);
    expect(kDoctorUserBootstrapMaxChars).toBe(4000);
    expect(kDoctorBootstrapMinFileBudgetChars).toBe(64);
  });

  it("encodes the missing-root-file marker template verbatim", () => {
    // buildBootstrapContextFiles (stable dist/embedded-agent-helpers-*.js,
    // beta dist/bootstrap-*.js): `[MISSING] Expected at: ${pathValue}`.
    expect(formatDoctorMissingFileMarker("/work/SOUL.md")).toBe(
      "[MISSING] Expected at: /work/SOUL.md",
    );
  });

  it("encodes the stable 2026.7 injection contract", () => {
    expect(kStableProfile.id).toBe("stable-2026.7");
    expect(kStableProfile.injectedRootFiles).toEqual([
      "AGENTS.md",
      "SOUL.md",
      "TOOLS.md",
      "IDENTITY.md",
      "USER.md",
      "HEARTBEAT.md",
      "BOOTSTRAP.md",
      "MEMORY.md",
    ]);
    expect(kStableProfile.retiredRootFiles).toEqual([]);
    expect(kStableProfile.allowedExtraBasenames).toEqual([
      "AGENTS.md",
      "SOUL.md",
      "TOOLS.md",
      "IDENTITY.md",
      "USER.md",
      "HEARTBEAT.md",
      "BOOTSTRAP.md",
      "MEMORY.md",
    ]);
    expect(kStableProfile.userFileCapChars).toBeNull();
    // Only MEMORY.md is omitted entirely when absent on stable — every other
    // missing root file renders a budget-charged [MISSING] marker.
    expect(kStableProfile.omittedWhenAbsentRootFiles).toEqual(["MEMORY.md"]);
    // Stable has NO group/channel session filtering (root-MEMORY.md stripping
    // is beta-only: filterRootMemoryBootstrapFiles) — the profile must not
    // hand the doctor prompt beta-only placement advice.
    expect(kStableProfile.sessionScopeNotes).toEqual([
      "Sub-agent sessions inject only AGENTS.md and TOOLS.md.",
      "Cron sessions inject AGENTS.md, TOOLS.md, SOUL.md, IDENTITY.md, and USER.md only (not HEARTBEAT.md).",
    ]);
  });

  it("encodes the beta 2026.8.1 injection contract", () => {
    expect(kBeta81Profile.id).toBe("beta-2026.8.1");
    expect(kBeta81Profile.injectedRootFiles).toEqual([
      "AGENTS.md",
      "SOUL.md",
      "IDENTITY.md",
      "USER.md",
      "BOOTSTRAP.md",
      "MEMORY.md",
    ]);
    expect(kBeta81Profile.retiredRootFiles).toEqual(["TOOLS.md", "HEARTBEAT.md"]);
    expect(kBeta81Profile.allowedExtraBasenames).toEqual([
      "AGENTS.md",
      "SOUL.md",
      "IDENTITY.md",
      "USER.md",
      "BOOTSTRAP.md",
      "MEMORY.md",
    ]);
    expect(kBeta81Profile.userFileCapChars).toBe(4000);
    // Beta omits USER.md as well as MEMORY.md when absent (case-exact
    // exactWorkspaceEntryExists) — no [MISSING] marker for either.
    expect(kBeta81Profile.omittedWhenAbsentRootFiles).toEqual([
      "MEMORY.md",
      "USER.md",
    ]);
    // The group/channel MEMORY.md stripping IS real on beta.
    expect(kBeta81Profile.sessionScopeNotes).toContain(
      "Group and channel sessions never receive the root MEMORY.md.",
    );
  });

  describe("selectDoctorContextProfile", () => {
    it("selects the beta profile when the bootstrapContractV2 gate is open", () => {
      const profile = selectDoctorContextProfile({
        supportsFeature: (name) => name === "bootstrapContractV2",
      });
      expect(profile.id).toBe("beta-2026.8.1");
    });

    it("fails closed to the stable profile on a closed gate", () => {
      expect(
        selectDoctorContextProfile({ supportsFeature: () => false }).id,
      ).toBe("stable-2026.7");
    });

    it("fails closed when no gates are wired or the gate throws", () => {
      expect(selectDoctorContextProfile().id).toBe("stable-2026.7");
      expect(selectDoctorContextProfile({}).id).toBe("stable-2026.7");
      expect(
        selectDoctorContextProfile({
          supportsFeature: () => {
            throw new Error("boom");
          },
        }).id,
      ).toBe("stable-2026.7");
    });
  });

  describe("getProfilePathChangeWeight", () => {
    it("weights injected root files highest on each profile", () => {
      expect(getProfilePathChangeWeight(kStableProfile, "AGENTS.md")).toBe(4);
      expect(getProfilePathChangeWeight(kStableProfile, "SOUL.md")).toBe(4);
      expect(getProfilePathChangeWeight(kStableProfile, "TOOLS.md")).toBe(4);
      expect(getProfilePathChangeWeight(kStableProfile, "HEARTBEAT.md")).toBe(4);
      expect(getProfilePathChangeWeight(kBeta81Profile, "SOUL.md")).toBe(4);
      expect(getProfilePathChangeWeight(kBeta81Profile, "MEMORY.md")).toBe(4);
    });

    it("drops retired files to the generic markdown weight on beta", () => {
      expect(getProfilePathChangeWeight(kBeta81Profile, "TOOLS.md")).toBe(2);
      expect(getProfilePathChangeWeight(kBeta81Profile, "HEARTBEAT.md")).toBe(2);
    });

    it("keeps hooks/skills weights and floors daily memory churn at 1", () => {
      for (const profile of [kStableProfile, kBeta81Profile]) {
        expect(getProfilePathChangeWeight(profile, "hooks/bootstrap/AGENTS.md")).toBe(4);
        expect(getProfilePathChangeWeight(profile, "skills/foo/SKILL.md")).toBe(3);
        expect(getProfilePathChangeWeight(profile, "memory/2026-08-29.md")).toBe(1);
        expect(getProfilePathChangeWeight(profile, "README.md")).toBe(4);
        expect(getProfilePathChangeWeight(profile, "notes/other.md")).toBe(2);
        expect(getProfilePathChangeWeight(profile, "script.sh")).toBe(1);
        expect(getProfilePathChangeWeight(profile, "")).toBe(1);
      }
    });

    it("falls back to stable weights for an unknown profile", () => {
      expect(getProfilePathChangeWeight({ id: "future" }, "TOOLS.md")).toBe(4);
      expect(getProfilePathChangeWeight(null, "AGENTS.md")).toBe(4);
    });
  });
});
