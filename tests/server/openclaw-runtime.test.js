const fs = require("fs");
const os = require("os");
const path = require("path");
const { createOpenclawRuntime } = require("../../lib/server/openclaw-runtime");

describe("server/openclaw-runtime", () => {
  let root;
  let backupsDir;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-"));
    backupsDir = path.join(root, "backups");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const write = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  };
  const pin = (version) => write(path.join(root, "package.json"), JSON.stringify({ dependencies: version ? { openclaw: version } : {} }));
  const install = (version) => {
    const packageDir = path.join(root, "node_modules", "openclaw");
    write(path.join(packageDir, "package.json"), JSON.stringify({ name: "openclaw", version, bin: { openclaw: "openclaw.mjs" } }));
    write(path.join(packageDir, "openclaw.mjs"), "");
    return path.join(packageDir, "openclaw.mjs");
  };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const createRuntime = (overrides = {}) => createOpenclawRuntime({
    packageRoot: root,
    resolveInstallDir: () => root,
    openclawDir: path.join(root, ".openclaw"),
    backupsDir,
    openclawSpawnEnv: () => ({ OPENCLAW_STATE_DIR: path.join(root, ".openclaw"), MARKER: "spawn-env" }),
    logger,
    ...overrides,
  });

  describe("getInfo", () => {
    it("reports the installed build matching the pin", () => {
      pin("2026.9.5");
      install("2026.9.5");
      expect(createRuntime().getInfo()).toEqual({ installedVersion: "2026.9.5", pinnedVersion: "2026.9.5", installedDiverged: false });
    });

    it("flags an install that diverged from the pin", () => {
      pin("2026.9.5");
      install("2026.9.4");
      expect(createRuntime().getInfo()).toEqual({ installedVersion: "2026.9.4", pinnedVersion: "2026.9.5", installedDiverged: true });
    });

    it("re-reads the installed version on every call", () => {
      pin("2026.9.5");
      install("2026.9.4");
      const runtime = createRuntime();
      expect(runtime.getInfo().installedDiverged).toBe(true);
      install("2026.9.5");
      expect(runtime.getInfo().installedDiverged).toBe(false);
    });

    it("never reports divergence when either side is unknown", () => {
      pin("2026.9.5");
      expect(createRuntime().getInfo()).toEqual({ installedVersion: null, pinnedVersion: "2026.9.5", installedDiverged: false });
      pin(null);
      install("2026.9.4");
      expect(createRuntime().getInfo()).toEqual({ installedVersion: "2026.9.4", pinnedVersion: null, installedDiverged: false });
    });
  });

  describe("backups", () => {
    const createBackupHarness = () => {
      pin("2026.9.5");
      const bin = install("2026.9.5");
      const calls = [];
      const execFileFn = vi.fn((file, args, options, callback) => { calls.push({ file, args, options, callback }); });
      let now = 1_000;
      const runtime = createRuntime({ execFileFn, nowFn: () => now });
      return { runtime, bin, calls, execFileFn, advance: (ms) => { now += ms; } };
    };

    it("starts with no backup and nothing running", () => {
      expect(createRuntime().getBackupStatus()).toEqual({ running: false, last: null });
    });

    it("runs OpenClaw's own verified backup into the backups dir and records the archive", () => {
      const { runtime, bin, calls, advance } = createBackupHarness();
      expect(runtime.startBackup()).toEqual({ ok: true, started: true });
      expect(fs.statSync(backupsDir).isDirectory()).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].file).toBe(process.execPath);
      expect(calls[0].args).toEqual([bin, "backup", "create", "--output", backupsDir, "--verify", "--json"]);
      expect(calls[0].options).toMatchObject({ env: { MARKER: "spawn-env" }, timeout: 30 * 60 * 1000, killSignal: "SIGKILL" });
      expect(runtime.getBackupStatus()).toEqual({ running: true, last: null });

      const archivePath = path.join(backupsDir, "openclaw-backup.tar.gz");
      write(archivePath, "x".repeat(42));
      advance(5_000);
      calls[0].callback(null, `${JSON.stringify({ archivePath, verified: true }, null, 2)}\n`, "");
      expect(runtime.getBackupStatus()).toEqual({
        running: false,
        last: { ok: true, startedAt: 1_000, finishedAt: 6_000, archivePath, bytes: 42, error: null },
      });
    });

    it("refuses a second backup while one is running, then accepts one after it finishes", () => {
      const { runtime, calls } = createBackupHarness();
      runtime.startBackup();
      expect(runtime.startBackup()).toEqual({ ok: false, code: "backup_in_progress", error: "A backup is already running." });
      expect(calls).toHaveLength(1);
      calls[0].callback(new Error("boom"), "", "");
      expect(runtime.startBackup()).toEqual({ ok: true, started: true });
      expect(calls).toHaveLength(2);
    });

    it("records a failed backup with the stderr tail", () => {
      const { runtime, calls } = createBackupHarness();
      runtime.startBackup();
      calls[0].callback(Object.assign(new Error("Command failed"), { code: 1 }), "", "line one\nline two\nline three\nBackup failed: disk full\n");
      expect(runtime.getBackupStatus()).toMatchObject({
        running: false,
        last: { ok: false, archivePath: null, bytes: null, error: "line two line three Backup failed: disk full" },
      });
    });

    it("names a timed-out backup", () => {
      const { runtime, calls } = createBackupHarness();
      runtime.startBackup();
      calls[0].callback(Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL" }), "", "partial");
      expect(runtime.getBackupStatus().last).toMatchObject({ ok: false, error: "openclaw backup create timed out" });
    });

    it.each([
      ["unverified", JSON.stringify({ archivePath: "/backups/a.tar.gz", verified: false })],
      ["missing archive path", JSON.stringify({ verified: true })],
      ["unparseable", "Backup archive: /backups/a.tar.gz"],
    ])("refuses to report success for %s output", (_name, stdout) => {
      const { runtime, calls } = createBackupHarness();
      runtime.startBackup();
      calls[0].callback(null, stdout, "");
      expect(runtime.getBackupStatus()).toMatchObject({
        running: false,
        last: { ok: false, error: "openclaw backup create did not report a verified archive" },
      });
    });

    it("keeps a verified archive whose size cannot be read", () => {
      const { runtime, calls } = createBackupHarness();
      runtime.startBackup();
      calls[0].callback(null, JSON.stringify({ archivePath: path.join(backupsDir, "gone.tar.gz"), verified: true }), "");
      expect(runtime.getBackupStatus().last).toMatchObject({ ok: true, bytes: null, error: null });
    });

    it("refuses without running anything when the installed OpenClaw is missing", () => {
      pin("2026.9.5");
      const execFileFn = vi.fn();
      const runtime = createRuntime({ execFileFn });
      expect(runtime.startBackup()).toEqual({ ok: false, code: "openclaw_unavailable", error: "The installed OpenClaw could not be found." });
      expect(execFileFn).not.toHaveBeenCalled();
      expect(runtime.getBackupStatus()).toEqual({ running: false, last: null });
    });

    it("records a failure without running anything when the backups dir cannot be created", () => {
      pin("2026.9.5");
      install("2026.9.5");
      write(backupsDir, "a file where the directory should be");
      const execFileFn = vi.fn();
      const runtime = createRuntime({ execFileFn });
      expect(runtime.startBackup()).toEqual({ ok: true, started: true });
      expect(execFileFn).not.toHaveBeenCalled();
      expect(runtime.getBackupStatus()).toMatchObject({ running: false, last: { ok: false } });
      expect(runtime.getBackupStatus().last.error).toContain(`Could not create ${backupsDir}`);
    });
  });
});
