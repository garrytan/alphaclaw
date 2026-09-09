const {
  assessApplyIntent,
  resolveChannelLatestVersion,
  kApplyIntents,
} = require("../../lib/server/openclaw-update-intent");

// v0.9.81 (cross-model D13 / D21): the declared-intent check behind
// POST /api/openclaw/apply and applyUpdate. CRITICAL regression pin for bug 2
// ("Update to latest stable" downgraded 2026.9.2 → 2026.9.1): an `update`
// whose version is not strictly newer than the running one is refused.
describe("server/openclaw-update-intent", () => {
  const installed = "2026.9.2";
  const table = [
    // intent      version       expected
    ["update", "2026.9.1", "intent_mismatch"],
    ["update", "2026.9.2", "intent_mismatch"],
    ["update", "2026.9.3", null],
    ["downgrade", "2026.9.1", null],
    ["downgrade", "2026.9.2", "intent_mismatch"],
    ["downgrade", "2026.9.3", "intent_mismatch"],
    ["switch", "2026.9.2", null],
    ["switch", "2026.9.1", "intent_mismatch"],
    ["switch", "2026.9.3", "intent_mismatch"],
  ];
  for (const [intent, version, code] of table) {
    it(`${intent} × ${version} (running ${installed}) → ${code || "ok"}`, () => {
      const verdict = assessApplyIntent({ intent, channel: "stable", version, installedVersion: installed });
      if (code) {
        expect(verdict).toEqual(expect.objectContaining({ ok: false, status: 409, code }));
        expect(verdict.message).toContain(version);
        expect(verdict.message).toContain(installed);
        expect(verdict.installedVersion).toBe(installed);
      } else {
        expect(verdict.ok).toBe(true);
        expect(verdict.check.direction).toBe("verified");
        expect(verdict.check.installedVersion).toBe(installed);
      }
    });
  }

  it("the direction is judged by version ORDER, not by list position or hotfix suffix spelling", () => {
    expect(assessApplyIntent({ intent: "update", channel: "stable", version: "2026.7.1-2", installedVersion: "2026.7.1" }).ok).toBe(true);
    expect(assessApplyIntent({ intent: "downgrade", channel: "beta", version: "2026.8.1-beta.3", installedVersion: "2026.8.1" }).ok).toBe(true);
    expect(assessApplyIntent({ intent: "switch", channel: "stable", version: "2026.7.1-02", installedVersion: "2026.7.1-2" }).ok).toBe(true);
  });

  it("with the installed version unknown, only `switch` is granted (update/downgrade cannot be confirmed — fail closed)", () => {
    for (const installedVersion of [null, undefined, ""]) {
      expect(assessApplyIntent({ intent: "switch", channel: "stable", version: "1.0.0", installedVersion }).ok).toBe(true);
      const update = assessApplyIntent({ intent: "update", channel: "stable", version: "1.0.0", installedVersion });
      expect(update).toEqual(expect.objectContaining({ ok: false, status: 409, code: "intent_mismatch" }));
      expect(update.message).toMatch(/running OpenClaw version is unknown/);
      expect(assessApplyIntent({ intent: "downgrade", channel: "stable", version: "1.0.0", installedVersion }).code).toBe("intent_mismatch");
    }
  });

  it("intent is REQUIRED for stable/beta (400 invalid_body naming the three values) and refused on dev", () => {
    for (const intent of [undefined, null, "", "upgrade", "UPDATE", 1, {}]) {
      const verdict = assessApplyIntent({ intent, channel: "stable", version: "1.1.0", installedVersion: "1.0.0" });
      expect(verdict).toEqual(expect.objectContaining({ ok: false, status: 400, code: "invalid_body" }));
      expect(verdict.message).toContain("update, downgrade, switch");
      expect(verdict.hint).toMatch(/update.*downgrade.*switch/);
    }
    expect(assessApplyIntent({ intent: undefined, channel: "beta", version: "1.1.0-beta.1", installedVersion: "1.0.0" }).code).toBe("invalid_body");
    const dev = assessApplyIntent({ intent: "update", channel: "dev", version: null, installedVersion: "1.0.0" });
    expect(dev).toEqual(expect.objectContaining({ ok: false, status: 400, code: "invalid_body" }));
    expect(dev.message).toMatch(/dev/);
    expect(assessApplyIntent({ channel: "dev" })).toEqual({
      ok: true,
      check: { direction: "not_applicable", latest: "not_applicable" },
    });
    expect(kApplyIntents).toEqual(["update", "downgrade", "switch"]);
  });

  describe("latest agreement (update + expectLatest; best-effort, always recorded)", () => {
    const catalog = {
      ok: true,
      degraded: { github: false, npm: false },
      stable: [
        { version: "2026.9.3", isDistTagLatest: true },
        { version: "2026.9.2" },
        { version: "2026.9.1" },
      ],
      beta: [{ version: "2026.9.4-beta.1" }, { version: "2026.9.4-beta.2" }],
    };
    const base = { channel: "stable", installedVersion: "2026.9.1", catalog, expectLatest: true };

    it("update to the channel latest verifies; update to an older-but-newer version is catalog_stale carrying `latest`", () => {
      const ok = assessApplyIntent({ ...base, intent: "update", version: "2026.9.3" });
      expect(ok.ok).toBe(true);
      expect(ok.check).toEqual({
        direction: "verified",
        installedVersion: "2026.9.1",
        latest: "verified",
        latestVersion: "2026.9.3",
      });
      const stale = assessApplyIntent({ ...base, intent: "update", version: "2026.9.2" });
      expect(stale).toEqual(
        expect.objectContaining({ ok: false, status: 409, code: "catalog_stale", latest: "2026.9.3" }),
      );
      expect(stale.message).toContain("2026.9.3");
      expect(stale.hint).toContain('"Check now"');
    });

    it("without the expectLatest claim (a catalog row's own Upgrade button) an older-but-newer version is fine and recorded not_claimed", () => {
      const verdict = assessApplyIntent({ ...base, expectLatest: false, intent: "update", version: "2026.9.2" });
      expect(verdict.ok).toBe(true);
      expect(verdict.check.latest).toBe("not_claimed");
    });

    it("beta uses the highest prerelease row (never the npm beta dist-tag)", () => {
      expect(resolveChannelLatestVersion({ catalog, channel: "beta" })).toBe("2026.9.4-beta.2");
      const stale = assessApplyIntent({ ...base, channel: "beta", intent: "update", version: "2026.9.4-beta.1" });
      expect(stale.code).toBe("catalog_stale");
      expect(stale.latest).toBe("2026.9.4-beta.2");
      expect(assessApplyIntent({ ...base, channel: "beta", intent: "update", version: "2026.9.4-beta.2" }).ok).toBe(true);
    });

    it("stable prefers the dist-tag row over the highest version (an extended-stable backport never becomes 'latest')", () => {
      const backport = {
        ok: true,
        degraded: { npm: false },
        stable: [{ version: "2026.9.9" }, { version: "2026.9.3", isDistTagLatest: true }],
      };
      expect(resolveChannelLatestVersion({ catalog: backport, channel: "stable" })).toBe("2026.9.3");
      expect(assessApplyIntent({ ...base, catalog: backport, intent: "update", version: "2026.9.3" }).ok).toBe(true);
    });

    it("a missing, failed or npm-degraded catalog SKIPS the check — direction still judged — and says so in `check.latest`", () => {
      expect(assessApplyIntent({ ...base, catalog: null, intent: "update", version: "2026.9.2" }).check.latest).toBe("skipped_catalog_unavailable");
      expect(assessApplyIntent({ ...base, catalog: { ok: false }, intent: "update", version: "2026.9.2" }).check.latest).toBe("skipped_catalog_unavailable");
      expect(assessApplyIntent({ ...base, catalog: { ok: true, stable: [] }, intent: "update", version: "2026.9.2" }).check.latest).toBe("skipped_catalog_unavailable");
      expect(
        assessApplyIntent({ ...base, catalog: { ...catalog, degraded: { npm: true } }, intent: "update", version: "2026.9.2" }).check.latest,
      ).toBe("skipped_degraded");
      // Direction is never skipped.
      expect(assessApplyIntent({ ...base, catalog: null, intent: "update", version: "2026.9.0" }).code).toBe("intent_mismatch");
    });

    it("downgrade and switch never consult the catalog", () => {
      const stale = { ok: true, degraded: { npm: false }, stable: [{ version: "2030.1.1", isDistTagLatest: true }] };
      expect(assessApplyIntent({ ...base, catalog: stale, intent: "downgrade", version: "2026.9.0" }).ok).toBe(true);
      expect(assessApplyIntent({ ...base, catalog: stale, intent: "downgrade", version: "2026.9.0" }).check.latest).toBe("not_applicable");
      expect(assessApplyIntent({ ...base, catalog: stale, intent: "switch", version: "2026.9.1" }).ok).toBe(true);
    });
  });

  it("exhaustive invariant: a granted `update` is always strictly newer than the installed version", () => {
    const { compareVersionParts } = require("../../lib/server/helpers");
    const versions = ["2026.6.34", "2026.7.1", "2026.7.1-2", "2026.8.1-beta.3", "2026.8.1", "2026.9.2", "2026.9.3", "2026.9.4-beta.1"];
    for (const installedVersion of versions) {
      for (const version of versions) {
        for (const channel of ["stable", "beta"]) {
          const verdict = assessApplyIntent({ intent: "update", channel, version, installedVersion });
          if (verdict.ok) expect(compareVersionParts(version, installedVersion)).toBeGreaterThan(0);
          else expect(compareVersionParts(version, installedVersion)).toBeLessThanOrEqual(0);
        }
      }
    }
  });
});
