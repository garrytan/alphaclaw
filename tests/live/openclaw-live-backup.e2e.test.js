// LIVE TIER — "Back up now" (lib/server/openclaw-runtime.js startBackup /
// getBackupStatus) driving the REAL pinned OpenClaw CLI. AlphaClaw no longer
// owns a backup ladder: the button runs upstream's own
//   openclaw backup create --output <backupsDir> --verify --json
// and trusts its JSON report ({ archivePath, verified: true, ... }). The
// hermetic route/runtime suites stub that report; this tier records what the
// pinned binary actually prints. Offline by design: no registry, no GitHub —
// the pinned package in node_modules is the entire upstream surface.
//
// Contract observed on the 2026.9.8 pin (2026-10-03): an existing --output
// directory gets ONE timestamped archive inside it
// ("<iso>-openclaw-backup.tar.gz"), stdout is exactly one JSON document with
// `archivePath` naming that file and `verified: true`.

// Isolate module-level kRootDir BEFORE any lib/ module loads constants
// (constants captures kRootDir at load).
const fs = require("fs");
const path = require("path");
const liveHelpers = require("./live-helpers");
process.env.ALPHACLAW_ROOT_DIR = liveHelpers.mkTemp("alphaclaw-live-backup-root-");
delete process.env.OPENCLAW_GIT_DIR;

const { execFile } = require("child_process");
const { kLiveEnabled, kSilentLogger, mkTemp, repoOpenclawBin, scrubTestRunnerEnv, waitFor } = liveHelpers;
const { materializeDatabases } = require("./database-fixture");
const { createOpenclawRuntime } = require("../../lib/server/openclaw-runtime");
const { telemetryDirectory } = require("../../lib/server/gateway-memory/telemetry-protocol");

const describeLive = kLiveEnabled ? describe : describe.skip;

const kRepoRoot = path.resolve(__dirname, "../..");
const kTestTimeoutMs = 180_000;
const kExecMaxBuffer = 16 * 1024 * 1024;

// Env for real-CLI invocations, mirroring lib/server/gateway.js gatewayEnv's
// shape (HOME/OPENCLAW_HOME at the data root, state dir + config pinned,
// XDG_CONFIG_HOME, no auto-update) against an isolated fixture root.
const buildCliEnv = ({ homeDir, stateDir }) => ({
  ...scrubTestRunnerEnv(),
  HOME: homeDir,
  OPENCLAW_HOME: homeDir,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  XDG_CONFIG_HOME: stateDir,
  OPENCLAW_NO_AUTO_UPDATE: "1",
});

// A box shaped like production: real state + agent databases authored by the
// pinned CLI, the backups dir a SIBLING of the state dir (<root>/backups/openclaw
// beside <root>/.openclaw), and the runtime wired the way lib/server.js wires it.
const createBox = () => {
  const homeDir = mkTemp("openclaw-live-backup-home-");
  const stateDir = path.join(homeDir, ".openclaw");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}\n");
  const cliEnv = buildCliEnv({ homeDir, stateDir });
  const pin = JSON.parse(fs.readFileSync(path.join(kRepoRoot, "package.json"), "utf8")).dependencies.openclaw;
  const databases = materializeDatabases({ openclawBin: repoOpenclawBin(), cliEnv, stateDir, version: pin });
  const backupsDir = path.join(homeDir, "backups", "openclaw");
  const runtime = createOpenclawRuntime({
    openclawDir: stateDir,
    packageRoot: kRepoRoot,
    backupsDir,
    resolveInstallDir: () => kRepoRoot,
    openclawSpawnEnv: () => cliEnv,
    logger: kSilentLogger,
  });
  return { stateDir, backupsDir, databases, runtime };
};

const listArchive = (archivePath) =>
  new Promise((resolve, reject) => {
    execFile("tar", ["-tzf", archivePath], { encoding: "utf8", maxBuffer: kExecMaxBuffer },
      (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

const waitForBackupFinished = async (runtime) => {
  await waitFor(async () => runtime.getBackupStatus().running === false, kTestTimeoutMs - 30_000, "openclaw backup create finished");
  return runtime.getBackupStatus().last;
};

describeLive("LIVE Back up now against the real pinned OpenClaw CLI", () => {
  it("writes one verified archive into the backups dir and reports its path and size", { timeout: kTestTimeoutMs }, async () => {
    const { stateDir, backupsDir, databases, runtime } = createBox();
    expect(runtime.getBackupStatus()).toEqual({ running: false, last: null });

    expect(runtime.startBackup()).toEqual({ ok: true, started: true });
    // One at a time: the route answers 409 backup_in_progress from this.
    expect(runtime.startBackup()).toMatchObject({ ok: false, code: "backup_in_progress" });
    expect(runtime.getBackupStatus().running).toBe(true);

    const last = await waitForBackupFinished(runtime);
    expect(last, JSON.stringify(last)).toMatchObject({ ok: true, error: null });
    expect(last.finishedAt).toBeGreaterThanOrEqual(last.startedAt);
    expect(path.dirname(last.archivePath)).toBe(backupsDir);
    expect(path.basename(last.archivePath)).toMatch(/^\d{4}-\d{2}-\d{2}T.+-openclaw-backup\.tar\.gz$/);
    expect(fs.readdirSync(backupsDir)).toEqual([path.basename(last.archivePath)]);
    expect(last.bytes).toBe(fs.statSync(last.archivePath).size);
    expect(last.bytes).toBeGreaterThan(0);

    const entries = await listArchive(last.archivePath);
    expect(entries).toContain(`${stateDir}/openclaw.json`.replace(/^\//, ""));
    for (const file of Object.values(databases)) expect(entries).toContain(file.replace(/^\//, ""));
  });

  it("archives successfully while AlphaClaw's telemetry publishes and its producer processes exit", {
    timeout: kTestTimeoutMs,
  }, async () => {
    const { stateDir, runtime } = createBox();
    let running = true;
    let ready;
    const firstPublication = new Promise((resolve) => { ready = resolve; });
    let producers = 0;
    let sampleCount = 0;
    const churn = (async () => {
      do {
        const output = await new Promise((resolve, reject) => {
          const child = execFile(process.execPath, [
            path.join(__dirname, "gateway-telemetry-fixture.js"), stateDir,
          ], { env: scrubTestRunnerEnv(), timeout: 5_000, encoding: "utf8" },
          (error, stdout, stderr) => {
            if (error) reject(new Error(`telemetry fixture failed: ${error.message}\n${stderr}`));
            else resolve(stdout);
          });
          child.stdout.on("data", (chunk) => { if (String(chunk).includes("ready")) ready(); });
        });
        producers += 1;
        sampleCount += Number(/samples:(\d+)/.exec(output)?.[1] || 0);
      } while (running);
    })();
    // If a publisher fails before ready, fail promptly instead of waiting for
    // the test timeout. Keep the rejection observed during the backup too.
    const failedChurn = churn.then(() => {}, (error) => { throw error; });
    failedChurn.catch(() => {});
    let last;
    try {
      await Promise.race([firstPublication, failedChurn]);
      expect(runtime.startBackup()).toEqual({ ok: true, started: true });
      last = await waitForBackupFinished(runtime);
    } finally {
      running = false;
      await churn;
    }
    expect(last, JSON.stringify(last)).toMatchObject({ ok: true, error: null });
    expect(producers).toBeGreaterThan(0);
    expect(sampleCount).toBeGreaterThan(1);
    expect(fs.readdirSync(telemetryDirectory(stateDir))).toEqual([]);
    const entries = await listArchive(last.archivePath);
    expect(entries).toContain("openclaw.json");
    expect(entries).not.toMatch(/gateway-memory|\/tmp\/alphaclaw\//);
  });
});
