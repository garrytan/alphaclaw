// openclaw-boot-migration.js: `openclaw doctor --fix` runs once per pinned
// OpenClaw version, before the gateway starts. Hermetic: real temp dirs, an
// injected runDoctorFix, a fixed clock.
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  kBootMigrationFileName,
  kRememberedFailureRetryMs,
  readCompletedForVersion,
  readMigrationRecord,
  recordDoctorCompletedForPin,
  recordDoctorOutcome,
  runBootMigration,
} = require("../../lib/server/openclaw-boot-migration");

const kNow = 1_788_681_600_000;
const silentLogger = () => ({ log: vi.fn(), warn: vi.fn() });

const createBox = ({ withConfig = true } = {}) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-boot-migration-"));
  const openclawDir = path.join(rootDir, ".openclaw");
  const managedDir = path.join(openclawDir, ".alphaclaw");
  fs.mkdirSync(managedDir, { recursive: true });
  if (withConfig) fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}\n");
  return { rootDir, openclawDir, managedDir, recordPath: path.join(managedDir, kBootMigrationFileName) };
};

describe("server/openclaw-boot-migration", () => {
  const boxes = [];
  const newBox = (options) => {
    const box = createBox(options);
    boxes.push(box.rootDir);
    return box;
  };
  afterEach(() => {
    for (const dir of boxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runs doctor --fix for a version it never completed, records it, and never runs it again for that version", async () => {
    const box = newBox();
    const runDoctorFix = vi.fn(async () => ({ ok: true }));
    const operation = { signal: new AbortController().signal };
    const logger = silentLogger();
    const run = () =>
      runBootMigration({ ...box, installedVersion: "2026.9.8", runDoctorFix, operation, timeoutMs: 1234, nowFn: () => kNow, logger });

    await expect(run()).resolves.toMatchObject({ status: "ok", ran: true, captureUnavailable: null });
    expect(runDoctorFix).toHaveBeenCalledTimes(1);
    expect(runDoctorFix).toHaveBeenCalledWith({ timeoutMs: 1234, operation, source: "boot" });
    expect(JSON.parse(fs.readFileSync(box.recordPath, "utf8"))).toEqual({ completedForVersion: "2026.9.8", at: kNow });
    expect(logger.log).toHaveBeenCalledWith("[alphaclaw] OpenClaw 2026.9.8: running doctor --fix before the gateway starts");

    await expect(run()).resolves.toEqual({ status: "ok", ran: false });
    expect(runDoctorFix).toHaveBeenCalledTimes(1);
  });

  it("a new pin runs doctor again and names the version it moves from", async () => {
    const box = newBox();
    recordDoctorCompletedForPin({ managedDir: box.managedDir, version: "2026.9.3", nowFn: () => kNow - 1 });
    const runDoctorFix = vi.fn(async () => ({ ok: true }));
    const logger = silentLogger();

    await expect(
      runBootMigration({ ...box, installedVersion: "2026.9.8", runDoctorFix, nowFn: () => kNow, logger }),
    ).resolves.toMatchObject({ status: "ok", ran: true });
    expect(runDoctorFix).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith("[alphaclaw] OpenClaw 2026.9.3 → 2026.9.8: running doctor --fix before the gateway starts");
    expect(readCompletedForVersion({ managedDir: box.managedDir })).toBe("2026.9.8");
  });

  it.each([
    ["an unexplained exit", { ok: false, code: 1 }, "exit_1"],
    ["a timeout", { ok: false, timedOut: true }, "timed_out"],
    ["a cancellation", { ok: false, cancelled: true }, "cancelled"],
    ["no space", { ok: false, code: 1, stdout: "Error: ENOSPC: no space left on device, write\n" }, "no_space"],
    ["no result", null, "failed"],
  ])("%s: transient — notifies once, remembers nothing and still returns (the gateway starts anyway)", async (_label, result, reason) => {
    const box = newBox();
    recordDoctorCompletedForPin({ managedDir: box.managedDir, version: "2026.9.3", nowFn: () => kNow - 1 });
    const notify = vi.fn(async () => {});
    const logger = silentLogger();

    await expect(
      runBootMigration({ ...box, installedVersion: "2026.9.8", runDoctorFix: async () => result, notify, nowFn: () => kNow, logger }),
    ).resolves.toMatchObject({ status: "failed", ran: true, reason, class: "transient" });
    expect(readCompletedForVersion({ managedDir: box.managedDir })).toBe("2026.9.3");
    expect(readMigrationRecord({ managedDir: box.managedDir }).failed).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, options] = notify.mock.calls[0];
    expect(message).toContain("OpenClaw 2026.9.8");
    expect(message).toContain(`did not complete (${reason})`);
    expect(message).toContain("The gateway is starting anyway");
    expect(options).toEqual({ eventType: "health", id: "boot-migration-failed-2026.9.8" });
    expect(logger.warn).toHaveBeenCalledWith(
      `[alphaclaw] doctor --fix for OpenClaw 2026.9.8 did not complete (${reason}); starting the gateway anyway`,
    );
  });

  // Real `openclaw doctor --fix --yes` output on OpenClaw 2026.10.2 for a
  // state dir carrying a legacy plugins/installs.json (exit 1), trimmed.
  const kUpgradeWindowRefusalOutput = [
    "┌  OpenClaw doctor",
    "◇  Doctor warnings ─────────────────────────────────────────────────────────╮",
    "│                                                                           │",
    "│  - Plugin install index /data/.openclaw/plugins/installs.json             │",
    "│    predates the July 2026 upgrade support window and was left             │",
    "│    unchanged. Run openclaw doctor --fix on 2026.9.5 with a pre-update     │",
    "│    backup before upgrading again:                                         │",
    "│    https://docs.openclaw.ai/install/updating#upgrading-very-old-versions  │",
    "│                                                                           │",
    "├───────────────────────────────────────────────────────────────────────────╯",
    "Doctor stopped because a state migration refused to continue. Resolve the reported migration failure before retrying. Later repairs were not run.",
    "Failing check plugin-install-index (unsupported-plugin-install-index): Plugin install index [redacted-path]",
    'Failing check session-entry-state (blocked-by-prior-refusal): Migration step "session-entry-state" was not run because prior step "plugin-install-index" refused execution.',
    "",
  ].join("\n");

  const runFailed = async (result, expected) => {
    const box = newBox();
    const notify = vi.fn(async () => {});
    await expect(
      runBootMigration({ ...box, installedVersion: "2026.10.2", runDoctorFix: async () => result, notify, logger: silentLogger() }),
    ).resolves.toMatchObject({ status: "failed", ran: true, ...expected });
    expect(notify).toHaveBeenCalledTimes(1);
    return notify.mock.calls[0][0];
  };

  it("names the 2026.9.5 bridge release when doctor refuses pre-July-2026 state, and never points it at the live state", async () => {
    const message = await runFailed({
      ok: false,
      code: 1,
      stdout: kUpgradeWindowRefusalOutput,
      lastOutputLine: 'Failing check session-entry-state (blocked-by-prior-refusal): Migration step "session-entry-state" was not run',
    }, { reason: "upgrade_window_refused", class: "deterministic" });
    expect(message).toContain("refused to migrate state that predates OpenClaw's July 2026 upgrade support window");
    expect(message).toContain("Leave the current state directory untouched");
    expect(message).toContain("restore it into a separate directory, run `openclaw doctor --fix` with OpenClaw 2026.9.5 there");
    expect(message).toContain("Without such a backup OpenClaw cannot migrate this state automatically");
    expect(message).not.toContain("redeploy");
    expect(message).toContain(
      'OpenClaw said: "Failing check plugin-install-index (unsupported-plugin-install-index): Plugin install index [redacted-path]"',
    );
    expect(message).not.toContain("the watchdog repairs and reports it");
  });

  it("names the bridge version OpenClaw asks for when it is not 2026.9.5", async () => {
    const message = await runFailed({
      ok: false,
      code: 1,
      stdout:
        "Config contains retired pre-July-2026 settings: channels.discord.guilds.g1.channels.c1.allow. Doctor cannot remove these settings safely.\n" +
        'Install OpenClaw 2026.9.7, run "openclaw doctor --fix", then upgrade to latest. See https://docs.openclaw.ai/install/updating#upgrading-very-old-versions.\n',
    }, { reason: "upgrade_window_refused" });
    expect(message).toContain("with OpenClaw 2026.9.7 there");
    expect(message).not.toContain("2026.9.5");
  });

  it("recognizes the session room refusal from its message alone", async () => {
    const message = await runFailed({
      ok: false,
      code: 1,
      lastOutputLine:
        'Session field "room" predates July 2026 and is no longer supported. Preserve the original state, install OpenClaw 2026.9.5 and run "openclaw doctor --fix", then upgrade again.',
    }, { reason: "upgrade_window_refused" });
    expect(message).toContain("upgrade support window");
    expect(message).toContain("with OpenClaw 2026.9.5 there");
  });

  it("quotes doctor's last output line in the generic failure notice", async () => {
    const message = await runFailed(
      { ok: false, code: 1, stdout: "", lastOutputLine: "Config invalid: gateway.port" },
      { reason: "exit_1", class: "transient", detail: "Config invalid: gateway.port" },
    );
    expect(message).toContain("did not complete (exit_1)");
    expect(message).toContain('OpenClaw said: "Config invalid: gateway.port"');
    expect(message).toContain("the watchdog repairs and reports it");
  });

  it("a throwing notifier never turns a failed migration into a throw", async () => {
    const box = newBox();
    await expect(
      runBootMigration({
        ...box,
        installedVersion: "2026.9.8",
        runDoctorFix: async () => ({ ok: false, code: 1 }),
        notify: async () => {
          throw new Error("notifier down");
        },
        logger: silentLogger(),
      }),
    ).resolves.toMatchObject({ status: "failed", ran: true, reason: "exit_1" });
  });

  it("skips without running doctor when the installed version is unknown or there is no openclaw.json yet", async () => {
    const runDoctorFix = vi.fn(async () => ({ ok: true }));
    const configured = newBox();
    await expect(
      runBootMigration({ ...configured, installedVersion: null, runDoctorFix, logger: silentLogger() }),
    ).resolves.toEqual({ status: "skipped", reason: "version_unknown" });
    const fresh = newBox({ withConfig: false });
    await expect(
      runBootMigration({ ...fresh, installedVersion: "2026.9.8", runDoctorFix, logger: silentLogger() }),
    ).resolves.toEqual({ status: "skipped", reason: "no_config" });
    expect(runDoctorFix).not.toHaveBeenCalled();
    expect(fs.existsSync(fresh.recordPath)).toBe(false);
  });

  it("readCompletedForVersion is lenient: a missing, corrupt or non-string record reads as null", () => {
    const box = newBox();
    expect(readCompletedForVersion({ managedDir: box.managedDir })).toBeNull();
    fs.writeFileSync(box.recordPath, "{not json");
    expect(readCompletedForVersion({ managedDir: box.managedDir })).toBeNull();
    fs.writeFileSync(box.recordPath, JSON.stringify({ completedForVersion: 42 }));
    expect(readCompletedForVersion({ managedDir: box.managedDir })).toBeNull();
  });

  it("a corrupt record re-runs doctor and overwrites it", async () => {
    const box = newBox();
    fs.writeFileSync(box.recordPath, "{not json");
    const runDoctorFix = vi.fn(async () => ({ ok: true }));
    await expect(
      runBootMigration({ ...box, installedVersion: "2026.9.8", runDoctorFix, nowFn: () => kNow, logger: silentLogger() }),
    ).resolves.toMatchObject({ status: "ok", ran: true });
    expect(runDoctorFix).toHaveBeenCalledTimes(1);
    expect(readCompletedForVersion({ managedDir: box.managedDir })).toBe("2026.9.8");
  });

  // Real 2026.10.2 output on the #144 layout (/data/.openclaw a symlink,
  // /data 2775 root:node), trimmed.
  const kSymlinkedLayoutFailure = {
    ok: false,
    code: 1,
    stdout: [
      "┌  OpenClaw doctor",
      "Original state capture was unavailable: SQLite staging ancestor must not allow another user to replace its child: /data. Doctor will continue; inspect retained evidence manually before restoring state.",
      "◇  Doctor warnings ────────────────────────────────────────╮",
      "Doctor could not complete maintenance. Check the reported service state and resolve the failure.",
      "Atomic replace parent must be a real directory: /data/.openclaw",
      "",
    ].join("\n"),
  };

  it("reports the atomic-replace refusal as deterministic, with the capture cause, and remembers it", async () => {
    const box = newBox();
    const notify = vi.fn(async () => {});
    const result = await runBootMigration({
      ...box,
      installedVersion: "2026.10.4",
      alphaclawVersion: "0.10.6",
      runDoctorFix: async () => kSymlinkedLayoutFailure,
      notify,
      nowFn: () => kNow,
      logger: silentLogger(),
    });
    expect(result).toEqual({
      status: "failed",
      ran: true,
      reason: "atomic_replace_refused",
      class: "deterministic",
      detail: "Atomic replace parent must be a real directory: /data/.openclaw",
      captureUnavailable: { cause: "SQLite staging ancestor must not allow another user to replace its child: /data" },
    });
    const failed = readMigrationRecord({ managedDir: box.managedDir }).failed;
    expect(failed).toMatchObject({ reason: "atomic_replace_refused", attempts: 1, at: kNow });
    expect(failed.key).toMatchObject({ openclawVersion: "2026.10.4", alphaclawVersion: "0.10.6" });
    expect(failed.key.configSha).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(failed.key)).not.toMatch(/free|bytes/i);
  });

  describe("failure memory across boots", () => {
    const boot = (box, overrides = {}) => {
      const runDoctorFix = vi.fn(async () => kSymlinkedLayoutFailure);
      const run = runBootMigration({
        ...box,
        installedVersion: "2026.10.4",
        alphaclawVersion: "0.10.6",
        runDoctorFix,
        notify: async () => {},
        nowFn: () => kNow,
        logger: silentLogger(),
        ...overrides,
      });
      return { run, runDoctorFix: overrides.runDoctorFix || runDoctorFix };
    };

    it("an unchanged deterministic failure is skipped on the next boot", async () => {
      const box = newBox();
      await boot(box).run;
      const second = boot(box);
      await expect(second.run).resolves.toEqual({
        status: "skipped",
        reason: "remembered_failure",
        class: "deterministic",
        detail: "Atomic replace parent must be a real directory: /data/.openclaw",
        ran: false,
      });
      expect(second.runDoctorFix).not.toHaveBeenCalled();
    });

    it.each([
      ["a config edit", (box) => fs.writeFileSync(path.join(box.openclawDir, "openclaw.json"), '{"edited":true}\n'), {}],
      ["a permission change", (box) => fs.chmodSync(box.openclawDir, 0o1777), {}],
      ["a new AlphaClaw version", () => {}, { alphaclawVersion: "0.10.7" }],
      ["a new OpenClaw version", () => {}, { installedVersion: "2026.10.5" }],
      ["24 hours passing", () => {}, { nowFn: () => kNow + kRememberedFailureRetryMs }],
    ])("%s retries the Doctor", async (_label, change, overrides) => {
      const box = newBox();
      await boot(box).run;
      change(box);
      const second = boot(box, overrides);
      await expect(second.run).resolves.toMatchObject({ status: "failed", ran: true });
      expect(second.runDoctorFix).toHaveBeenCalledTimes(1);
    });

    it("OpenClaw's meta and wizard stamps and autotune's concurrency between boots do not defeat the memory", async () => {
      const box = newBox();
      const configPath = path.join(box.openclawDir, "openclaw.json");
      fs.writeFileSync(configPath, JSON.stringify({ gateway: { port: 18789 }, meta: { lastTouchedAt: "2026-10-16T10:00:00Z" } }));
      await boot(box).run;
      fs.writeFileSync(
        configPath,
        JSON.stringify({ meta: { lastTouchedAt: "2026-10-16T10:05:00Z", lastTouchedVersion: "2026.10.4" }, wizard: { lastRunAt: "2026-10-16T10:05:00Z", lastRunVersion: "2026.10.4" }, agents: { defaults: { maxConcurrent: 3 } }, gateway: { port: 18789 } }, null, 2),
      );
      const second = boot(box);
      await expect(second.run).resolves.toMatchObject({ status: "skipped", reason: "remembered_failure" });
      expect(second.runDoctorFix).not.toHaveBeenCalled();
    });

    it("a repeat failure on the same key counts attempts; a success clears the memory", async () => {
      const box = newBox();
      await boot(box).run;
      await boot(box, { nowFn: () => kNow + kRememberedFailureRetryMs }).run;
      expect(readMigrationRecord({ managedDir: box.managedDir }).failed.attempts).toBe(2);
      recordDoctorCompletedForPin({ managedDir: box.managedDir, version: "2026.10.4", nowFn: () => kNow + 1 });
      const record = readMigrationRecord({ managedDir: box.managedDir });
      expect(record.failed).toBeUndefined();
      expect(record.completedForVersion).toBe("2026.10.4");
    });

    it("a remembered failure survives a recorded outcome from another Doctor run", async () => {
      const box = newBox();
      await boot(box).run;
      recordDoctorOutcome({ managedDir: box.managedDir, outcome: { status: "failed", source: "repair" } });
      const record = readMigrationRecord({ managedDir: box.managedDir });
      expect(record.failed.reason).toBe("atomic_replace_refused");
      expect(record.lastOutcome).toEqual({ status: "failed", source: "repair" });
    });
  });

  it("a success without a safety snapshot sends one plain notice naming the cause", async () => {
    const box = newBox();
    const notify = vi.fn(async () => {});
    const result = await runBootMigration({
      ...box,
      installedVersion: "2026.10.4",
      runDoctorFix: async () => ({
        ok: true,
        code: 0,
        stdout: "Original state capture was unavailable: SQLite staging ancestor must not allow another user to replace its child: /data. Doctor will continue.\nDoctor complete\n",
      }),
      notify,
      nowFn: () => kNow,
      logger: silentLogger(),
    });
    expect(result).toMatchObject({ status: "ok", captureUnavailable: { cause: "SQLite staging ancestor must not allow another user to replace its child: /data" } });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("OpenClaw's data upgrade to 2026.10.4 finished, but without a safety snapshot. OpenClaw said: SQLite staging ancestor must not allow another user to replace its child: /data. Nothing is broken."),
      { eventType: "health", id: expect.stringMatching(/^boot-migration-no-snapshot-2026\.10\.4-[0-9a-f]{12}$/) },
    );
  });
});
