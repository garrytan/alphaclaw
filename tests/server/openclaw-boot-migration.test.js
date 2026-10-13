// openclaw-boot-migration.js: `openclaw doctor --fix` runs once per pinned
// OpenClaw version, before the gateway starts. Hermetic: real temp dirs, an
// injected runDoctorFix, a fixed clock.
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  kBootMigrationFileName,
  readCompletedForVersion,
  writeCompletedForVersion,
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

    await expect(run()).resolves.toEqual({ status: "ok", ran: true });
    expect(runDoctorFix).toHaveBeenCalledTimes(1);
    expect(runDoctorFix).toHaveBeenCalledWith({ timeoutMs: 1234, operation });
    expect(JSON.parse(fs.readFileSync(box.recordPath, "utf8"))).toEqual({ completedForVersion: "2026.9.8", at: kNow });
    expect(logger.log).toHaveBeenCalledWith("[alphaclaw] OpenClaw 2026.9.8: running doctor --fix before the gateway starts");

    await expect(run()).resolves.toEqual({ status: "ok", ran: false });
    expect(runDoctorFix).toHaveBeenCalledTimes(1);
  });

  it("a new pin runs doctor again and names the version it moves from", async () => {
    const box = newBox();
    writeCompletedForVersion({ managedDir: box.managedDir, version: "2026.9.3", nowFn: () => kNow - 1 });
    const runDoctorFix = vi.fn(async () => ({ ok: true }));
    const logger = silentLogger();

    await expect(
      runBootMigration({ ...box, installedVersion: "2026.9.8", runDoctorFix, nowFn: () => kNow, logger }),
    ).resolves.toEqual({ status: "ok", ran: true });
    expect(runDoctorFix).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith("[alphaclaw] OpenClaw 2026.9.3 → 2026.9.8: running doctor --fix before the gateway starts");
    expect(readCompletedForVersion({ managedDir: box.managedDir })).toBe("2026.9.8");
  });

  it.each([
    ["a failure code", { ok: false, code: "exit_1" }, "exit_1"],
    ["a timeout", { ok: false, timedOut: true }, "timed out"],
    ["no result", null, "failed"],
  ])("%s: notifies once, records nothing and still returns (the gateway starts anyway)", async (_label, result, reason) => {
    const box = newBox();
    writeCompletedForVersion({ managedDir: box.managedDir, version: "2026.9.3", nowFn: () => kNow - 1 });
    const notify = vi.fn(async () => {});
    const logger = silentLogger();

    await expect(
      runBootMigration({ ...box, installedVersion: "2026.9.8", runDoctorFix: async () => result, notify, nowFn: () => kNow, logger }),
    ).resolves.toEqual({ status: "failed", ran: true, reason });
    expect(readCompletedForVersion({ managedDir: box.managedDir })).toBe("2026.9.3");
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

  const runFailed = async (result) => {
    const box = newBox();
    const notify = vi.fn(async () => {});
    await expect(
      runBootMigration({ ...box, installedVersion: "2026.10.2", runDoctorFix: async () => result, notify, logger: silentLogger() }),
    ).resolves.toEqual({ status: "failed", ran: true, reason: result.code });
    expect(notify).toHaveBeenCalledTimes(1);
    return notify.mock.calls[0][0];
  };

  it("names the 2026.9.5 bridge release when doctor refuses pre-July-2026 state", async () => {
    const message = await runFailed({
      ok: false,
      code: "exit_1",
      stdout: kUpgradeWindowRefusalOutput,
      lastOutputLine: 'Failing check session-entry-state (blocked-by-prior-refusal): Migration step "session-entry-state" was not run',
    });
    expect(message).toContain("refused to migrate state that predates OpenClaw's July 2026 upgrade support window (exit_1)");
    expect(message).toContain("deploy an AlphaClaw release pinned to OpenClaw 2026.9.5 (v0.9.88–v0.9.97)");
    expect(message).toContain("then redeploy this release");
    expect(message).toContain(
      'OpenClaw said: "Failing check plugin-install-index (unsupported-plugin-install-index): Plugin install index [redacted-path]"',
    );
    expect(message).not.toContain("the watchdog repairs and reports it");
  });

  it("names the bridge version OpenClaw asks for when it is not 2026.9.5", async () => {
    const message = await runFailed({
      ok: false,
      code: "exit_1",
      stdout:
        "Config contains retired pre-July-2026 settings: channels.discord.guilds.g1.channels.c1.allow. Doctor cannot remove these settings safely.\n" +
        'Install OpenClaw 2026.9.7, run "openclaw doctor --fix", then upgrade to latest. See https://docs.openclaw.ai/install/updating#upgrading-very-old-versions.\n',
    });
    expect(message).toContain("run `openclaw doctor --fix` with OpenClaw 2026.9.7 against this state directory");
    expect(message).not.toContain("v0.9.88");
  });

  it("recognizes the session room refusal from its message alone", async () => {
    const message = await runFailed({
      ok: false,
      code: "exit_1",
      lastOutputLine:
        'Session field "room" predates July 2026 and is no longer supported. Preserve the original state, install OpenClaw 2026.9.5 and run "openclaw doctor --fix", then upgrade again.',
    });
    expect(message).toContain("upgrade support window");
    expect(message).toContain("OpenClaw 2026.9.5 (v0.9.88–v0.9.97)");
  });

  it("quotes doctor's last output line in the generic failure notice", async () => {
    const message = await runFailed({ ok: false, code: "exit_1", stdout: "boom\n", lastOutputLine: "Config invalid: gateway.port" });
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
        runDoctorFix: async () => ({ ok: false, code: "exit_1" }),
        notify: async () => {
          throw new Error("notifier down");
        },
        logger: silentLogger(),
      }),
    ).resolves.toEqual({ status: "failed", ran: true, reason: "exit_1" });
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
    ).resolves.toEqual({ status: "ok", ran: true });
    expect(runDoctorFix).toHaveBeenCalledTimes(1);
    expect(readCompletedForVersion({ managedDir: box.managedDir })).toBe("2026.9.8");
  });
});
