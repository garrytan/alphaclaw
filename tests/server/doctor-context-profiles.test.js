const {
  formatDoctorMissingFileMarker,
  getProfilePathChangeWeight,
  kCurrentContextProfile,
  kDoctorBootstrapMaxChars,
  kDoctorBootstrapMinFileBudgetChars,
  kDoctorBootstrapNearLimitRatio,
  kDoctorBootstrapTotalMaxChars,
  kDoctorUserBootstrapMaxChars,
} = require("../../lib/server/doctor/context-profiles");

// Golden contract fixtures: these values were verified against the published
// npm tarballs (openclaw@2026.8.1-beta.1, @2026.8.1-beta.3; budgets re-checked
// on @2026.10.2).
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

  it("encodes the current (2026.8.1) injection contract; the id keeps its persisted value", () => {
    expect(kCurrentContextProfile.id).toBe("beta-2026.8.1");
    expect(kCurrentContextProfile.injectedRootFiles).toEqual([
      "AGENTS.md",
      "SOUL.md",
      "IDENTITY.md",
      "USER.md",
      "BOOTSTRAP.md",
      "MEMORY.md",
    ]);
    expect(kCurrentContextProfile.retiredRootFiles).toEqual(["TOOLS.md", "HEARTBEAT.md"]);
    expect(kCurrentContextProfile.allowedExtraBasenames).toEqual([
      "AGENTS.md",
      "SOUL.md",
      "IDENTITY.md",
      "USER.md",
      "BOOTSTRAP.md",
      "MEMORY.md",
    ]);
    expect(kCurrentContextProfile.userFileCapChars).toBe(4000);
    // Beta omits USER.md as well as MEMORY.md when absent (case-exact
    // exactWorkspaceEntryExists) — no [MISSING] marker for either.
    expect(kCurrentContextProfile.omittedWhenAbsentRootFiles).toEqual([
      "MEMORY.md",
      "USER.md",
    ]);
    // The group/channel MEMORY.md stripping IS real on beta.
    expect(kCurrentContextProfile.sessionScopeNotes).toContain(
      "Group and channel sessions never receive the root MEMORY.md.",
    );
  });

  describe("getProfilePathChangeWeight", () => {
    it("weights injected root files highest", () => {
      expect(getProfilePathChangeWeight(kCurrentContextProfile, "AGENTS.md")).toBe(4);
      expect(getProfilePathChangeWeight(kCurrentContextProfile, "SOUL.md")).toBe(4);
      expect(getProfilePathChangeWeight(kCurrentContextProfile, "MEMORY.md")).toBe(4);
    });

    it("drops retired files to the generic markdown weight", () => {
      expect(getProfilePathChangeWeight(kCurrentContextProfile, "TOOLS.md")).toBe(2);
      expect(getProfilePathChangeWeight(kCurrentContextProfile, "HEARTBEAT.md")).toBe(2);
    });

    it("keeps hooks/skills weights and floors daily memory churn at 1", () => {
      {
        const profile = kCurrentContextProfile;
        expect(getProfilePathChangeWeight(profile, "hooks/bootstrap/AGENTS.md")).toBe(4);
        expect(getProfilePathChangeWeight(profile, "skills/foo/SKILL.md")).toBe(3);
        expect(getProfilePathChangeWeight(profile, "memory/2026-08-29.md")).toBe(1);
        expect(getProfilePathChangeWeight(profile, "README.md")).toBe(4);
        expect(getProfilePathChangeWeight(profile, "notes/other.md")).toBe(2);
        expect(getProfilePathChangeWeight(profile, "script.sh")).toBe(1);
        expect(getProfilePathChangeWeight(profile, "")).toBe(1);
      }
    });

    it("falls back to the current weights for an unknown profile", () => {
      expect(getProfilePathChangeWeight({ id: "future" }, "TOOLS.md")).toBe(2);
      expect(getProfilePathChangeWeight(null, "AGENTS.md")).toBe(4);
    });
  });
});
