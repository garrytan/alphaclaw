// Doctor restore guard (issue #20 bug 3): quarantine-first prevention plus
// tripwire detection/revert. The incident: `doctor --fix --yes` silently
// replaced openclaw.json with a 6-week-stale openclaw.json.last-good (3 MCP
// servers, a provider, plugin flags gone; a plaintext key resurrected) and
// printed a success summary.
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createDoctorGuard,
  buildDoctorRestoreBlockedNotification,
} = require("../../lib/server/doctor-guard");

const kSilentLogger = { log() {}, warn() {}, error() {} };
const mkOpenclawDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-doctor-guard-"));

const kLiveConfig = {
  meta: { lastTouchedAt: "2026-08-29T05:12:17Z" },
  wizard: { lastRunAt: "2026-08-29T05:12:17Z" },
  mcp: {
    servers: {
      nessie: { url: "https://example.com/mcp" },
      cfoai: { url: "https://example.com/cfo" },
    },
  },
  models: {
    providers: {
      together: { apiKey: "${TOGETHER_API_KEY}" },
      meta: { apiKey: "${META_MODEL_API_KEY}" },
    },
  },
};

const kStaleConfig = {
  meta: { lastTouchedAt: "2026-06-11T00:00:00Z" },
  wizard: { lastRunAt: "2026-05-24T17:00:44Z" },
  mcp: { servers: {} },
  models: { providers: { meta: { apiKey: "sk-plaintext-resurrected" } } },
};

const writeJson = (dir, name, obj) =>
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(obj, null, 2)}\n`);
const readJson = (dir, name) =>
  JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));

describe("server/doctor-guard", () => {
  it("quarantines last-good for the run and restores it afterwards", async () => {
    const openclawDir = mkOpenclawDir();
    writeJson(openclawDir, "openclaw.json", kLiveConfig);
    writeJson(openclawDir, "openclaw.json.last-good", kStaleConfig);
    const guard = createDoctorGuard({ openclawDir, logger: kSilentLogger });

    let lastGoodDuringRun = "present";
    const result = await guard.withDoctorRestoreGuard({
      operationId: "abcd1234",
      run: async () => {
        lastGoodDuringRun = fs.existsSync(
          path.join(openclawDir, "openclaw.json.last-good"),
        )
          ? "present"
          : "absent";
        return { ok: true, tail: "Doctor complete\n" };
      },
    });

    // Doctor could not have restored what was not there.
    expect(lastGoodDuringRun).toBe("absent");
    expect(result.ok).toBe(true);
    expect(result.guard.quarantined).toBe(true);
    // Original restored, quarantine gone.
    expect(readJson(openclawDir, "openclaw.json.last-good")).toEqual(
      kStaleConfig,
    );
    expect(
      fs
        .readdirSync(openclawDir)
        .filter((name) => name.includes("quarantined")),
    ).toEqual([]);
  });

  it("keeps a FRESH last-good doctor wrote and drops the stale original", async () => {
    const openclawDir = mkOpenclawDir();
    writeJson(openclawDir, "openclaw.json", kLiveConfig);
    writeJson(openclawDir, "openclaw.json.last-good", kStaleConfig);
    const guard = createDoctorGuard({ openclawDir, logger: kSilentLogger });

    await guard.withDoctorRestoreGuard({
      operationId: "abcd1234",
      run: async () => {
        // Doctor writes a fresh post-migration last-good.
        writeJson(openclawDir, "openclaw.json.last-good", {
          fresh: true,
          meta: kLiveConfig.meta,
        });
        return { ok: true, tail: "Doctor complete\n" };
      },
    });

    expect(readJson(openclawDir, "openclaw.json.last-good").fresh).toBe(true);
    expect(
      fs
        .readdirSync(openclawDir)
        .filter((name) => name.includes("quarantined")),
    ).toEqual([]);
  });

  it("recovers a stranded quarantine at boot (crash mid-doctor)", () => {
    const openclawDir = mkOpenclawDir();
    writeJson(
      openclawDir,
      "openclaw.json.last-good.quarantined-deadbeef",
      kStaleConfig,
    );
    const guard = createDoctorGuard({ openclawDir, logger: kSilentLogger });

    const { recovered } = guard.recoverQuarantinedLastGood();

    expect(recovered).toBe(1);
    expect(readJson(openclawDir, "openclaw.json.last-good")).toEqual(
      kStaleConfig,
    );
  });

  it("drops a stranded quarantine when a fresh last-good already exists", () => {
    const openclawDir = mkOpenclawDir();
    writeJson(openclawDir, "openclaw.json.last-good", { fresh: true });
    writeJson(
      openclawDir,
      "openclaw.json.last-good.quarantined-deadbeef",
      kStaleConfig,
    );
    const guard = createDoctorGuard({ openclawDir, logger: kSilentLogger });

    guard.recoverQuarantinedLastGood();

    expect(readJson(openclawDir, "openclaw.json.last-good").fresh).toBe(true);
    expect(
      fs
        .readdirSync(openclawDir)
        .filter((name) => name.includes("quarantined")),
    ).toEqual([]);
  });

  describe("tripwires (restore sources the quarantine cannot reach)", () => {
    const runStaleSwap = async ({ tail = "Doctor complete\n" } = {}) => {
      const openclawDir = mkOpenclawDir();
      writeJson(openclawDir, "openclaw.json", kLiveConfig);
      const guard = createDoctorGuard({ openclawDir, logger: kSilentLogger });
      const result = await guard.withDoctorRestoreGuard({
        operationId: "abcd1234",
        run: async () => {
          // A restore path we did not anticipate swaps the whole config.
          writeJson(openclawDir, "openclaw.json", kStaleConfig);
          return { ok: true, tail };
        },
      });
      return { openclawDir, result };
    };

    it("detects the swap, reverts the config, and never reports success", async () => {
      const { openclawDir, result } = await runStaleSwap();

      expect(result.ok).toBe(false);
      expect(result.code).toBe("doctor_restored_stale_config");
      expect(result.reverted).toBe(true);
      // Signals: timestamps moved backward + inventory shrank + env-ref
      // became a literal.
      expect(result.signals).toEqual(
        expect.arrayContaining([
          "lastTouchedAt_moved_backward",
          "mcpServers_shrank",
          "env_ref_became_literal",
        ]),
      );
      // The live config is back, byte-for-byte.
      expect(readJson(openclawDir, "openclaw.json")).toEqual(kLiveConfig);
    });

    it("reports dropped key PATHS only — never values (redaction)", async () => {
      const { result } = await runStaleSwap();

      expect(result.droppedKeyPaths).toEqual(
        expect.arrayContaining([
          "mcp.servers.nessie",
          "mcp.servers.cfoai",
          "models.providers.together",
        ]),
      );
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("sk-plaintext-resurrected");
      expect(serialized).not.toContain("https://example.com/mcp");
    });

    it("trips on restore-shaped output even when the config diff is inconclusive", async () => {
      const openclawDir = mkOpenclawDir();
      // Same-count replacement: the config swap keeps inventories identical.
      writeJson(openclawDir, "openclaw.json", kLiveConfig);
      const guard = createDoctorGuard({ openclawDir, logger: kSilentLogger });
      const result = await guard.withDoctorRestoreGuard({
        operationId: "abcd1234",
        run: async () => ({
          ok: true,
          tail: "Config auto-restored from last-known-good: /data/.openclaw/openclaw.json (doctor-invalid-config)\n",
        }),
      });
      expect(result.ok).toBe(false);
      expect(result.signals).toContain("output_mentions_restore");
    });

    it("does not trip on an honest forward migration", async () => {
      const openclawDir = mkOpenclawDir();
      writeJson(openclawDir, "openclaw.json", kLiveConfig);
      const guard = createDoctorGuard({ openclawDir, logger: kSilentLogger });
      const result = await guard.withDoctorRestoreGuard({
        operationId: "abcd1234",
        run: async () => {
          // Migration moves timestamps FORWARD and keeps inventories.
          writeJson(openclawDir, "openclaw.json", {
            ...kLiveConfig,
            meta: { lastTouchedAt: "2026-08-29T17:00:00Z" },
            migratedField: true,
          });
          return { ok: true, tail: "Doctor complete\n" };
        },
      });
      expect(result.ok).toBe(true);
      expect(result.code).not.toBe("doctor_restored_stale_config");
      expect(readJson(openclawDir, "openclaw.json").migratedField).toBe(true);
    });
  });

  it("passes through a doctor failure untouched (no false restore verdicts)", async () => {
    const openclawDir = mkOpenclawDir();
    writeJson(openclawDir, "openclaw.json", kLiveConfig);
    const guard = createDoctorGuard({ openclawDir, logger: kSilentLogger });
    const result = await guard.withDoctorRestoreGuard({
      run: async () => ({ ok: false, code: 1, tail: "doctor exit 1\n", timedOut: false }),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
  });

  it("tolerates a missing config entirely (fresh install doctor run)", async () => {
    const openclawDir = mkOpenclawDir();
    const guard = createDoctorGuard({ openclawDir, logger: kSilentLogger });
    const result = await guard.withDoctorRestoreGuard({
      run: async () => ({ ok: true, tail: "created default config\n" }),
    });
    expect(result.ok).toBe(true);
  });

  describe("buildDoctorRestoreBlockedNotification", () => {
    // Single source for the operator copy: the watchdog-repair path and the
    // boot reconciler both fire it — key-path COUNTS only, never values.
    it("carries the dropped-path count and the blocked verdict", () => {
      const message = buildDoctorRestoreBlockedNotification(3);
      expect(message).toContain("3 setting path(s)");
      expect(message).toContain("AlphaClaw blocked it");
      expect(message).toContain("your settings are unchanged");
      // The non-held variant never points at the Upgrade page.
      expect(message).not.toContain("held");
      expect(message).not.toContain("Upgrade page");
    });

    it("appends the gateway-hold pointer only in the held variant", () => {
      const message = buildDoctorRestoreBlockedNotification(1, { held: true });
      expect(message).toContain("1 setting path(s)");
      expect(message).toContain("The gateway is held; see the Upgrade page.");
    });
  });
});
