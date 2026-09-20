const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { createOfflineCopy } = require("../../lib/server/openclaw-backup-offline-copy");
const { beginStateDbQuiet, isStateDbQuiet } = require("../../lib/server/state-db-quiet");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");
const { withOpenclawStartupEnv } = require("../../lib/server/openclaw-runtime-env");
const { materializeDatabases } = require("./database-fixture");
const { buildCliEnv } = require("./live-backup-harness");
const { mkTemp, scrubTestRunnerEnv, waitFor } = require("./live-helpers");

const kCopyBudgetMs = 8 * 60_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const writeFile = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const gatewayConfig = () => ({ gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
  plugins: { enabled: false } });

const createSource = (bin) => {
  const homeDir = mkTemp("alphaclaw-live-minimal-source-");
  const stateDir = path.join(homeDir, ".openclaw");
  writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify(gatewayConfig()));
  const paths = materializeDatabases({ openclawBin: bin, version: "2026.9.3", stateDir,
    cliEnv: buildCliEnv({ homeDir, stateDir }) });
  writeFile(path.join(stateDir, "credentials", "restore-fixture.json"), '{"fixture":"captured"}');
  writeFile(path.join(stateDir, "identity", "restore-fixture.txt"), "captured identity");
  writeFile(path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"), '{"version":1,"profiles":{}}');
  writeFile(path.join(stateDir, "workspace", "omitted.txt"), "older workspace");
  return { homeDir, stateDir, paths };
};

// Leave actual committed WAL frames behind after the only writer exits. A
// normal SQLite close checkpoints them and would not exercise consolidation.
const leaveCommittedWal = (file, value) => {
  const script = `const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE IF NOT EXISTS alphaclaw_backup_fixture (id INTEGER PRIMARY KEY, value TEXT)');
    db.prepare('INSERT OR REPLACE INTO alphaclaw_backup_fixture VALUES (1,?)').run(process.argv[2]);
    process.kill(process.pid,'SIGKILL');`;
  const result = spawnSync(process.execPath, ["-e", script, file, value], {
    env: scrubTestRunnerEnv(), timeout: 10_000, encoding: "utf8",
  });
  if (result.error || result.signal !== "SIGKILL") throw new Error(`WAL fixture did not exit as expected: ${result.error?.message || result.stderr}`);
  if (!(fs.statSync(`${file}-wal`).size > 0)) throw new Error("WAL fixture contains no committed frames");
};

const sourceJournal = (file, mode) => {
  if (mode === "wal") return leaveCommittedWal(file, "captured");
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE alphaclaw_backup_fixture (id INTEGER PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO alphaclaw_backup_fixture VALUES (1,?)").run("captured");
  } finally { db.close(); }
};

const produceCopy = async (source, { profile = "migration-minimal", budgetMs = kCopyBudgetMs } = {}) => {
  const backupsDir = mkTemp("alphaclaw-live-minimal-archives-");
  (source.archiveDirs ||= []).push(backupsDir);
  const outputFile = path.join(backupsDir, `openclaw-backup-${Date.now()}-${profile}.alphaclaw.tar.gz`);
  const lock = createGatewayLifecycleLock({ logger: { warn() {} } });
  const hold = await lock.acquire("backup_quiesce", { leaseMs: budgetMs + 30_000 });
  const runner = createRunStream({});
  let quiet;
  try {
    quiet = await beginStateDbQuiet({ owner: "minimal-live-restore", maxMs: budgetMs + 10_000 });
    return await createOfflineCopy({ profile, stateDir: source.stateDir, backupsDir, outputFile,
      runtimeVersion: "2026.9.3", budgetMs, spawnEnv: buildCliEnv(source),
      exclusivity: { stopConfirmed: true, stopEvidence: { method: "fixture_already_stopped" },
        quietToken: quiet.token, liveProcesses: [], handleCount: 0 },
      isQuiet: isStateDbQuiet, isLeaseValid: hold.isValid,
      runCommand: (spec) => runner.runStreamed({ ...spec, env: scrubTestRunnerEnv() }),
    });
  } finally {
    quiet?.release();
    hold();
  }
};

// The selective operator runbook: preserve the existing root; save and
// replace only captured files, clearing the replaced database's old sidecars.
const restoreCapturedAssets = (archive, destination) => {
  const extractDir = path.join(destination.homeDir, "restore-extract");
  fs.mkdirSync(extractDir, { recursive: true });
  execFileSync("gzip", ["-t", archive], { timeout: 120_000, stdio: "pipe" });
  execFileSync("tar", ["-xzf", archive, "-C", extractDir], { timeout: 120_000, stdio: "pipe" });
  const roots = fs.readdirSync(extractDir);
  if (roots.length !== 1) throw new Error("restore archive must have one root");
  const root = path.join(extractDir, roots[0]);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  for (const asset of manifest.assets) {
    const relative = path.relative(manifest.paths.stateDir, asset.sourcePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("unsafe restore source path");
    const captured = path.resolve(root, asset.archivePath);
    if (!captured.startsWith(`${root}${path.sep}`)) throw new Error("unsafe restore archive path");
    const target = path.join(destination.stateDir, relative);
    const saved = path.join(destination.homeDir, "saved-before-restore", relative);
    for (const suffix of asset.kind === "sqlite" ? ["", "-wal", "-shm", "-journal"] : [""]) {
      if (!fs.existsSync(`${target}${suffix}`)) continue;
      fs.mkdirSync(path.dirname(saved), { recursive: true });
      fs.renameSync(`${target}${suffix}`, `${saved}${suffix}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(captured, target);
  }
  return manifest;
};

const bootAndStop = async (bin, source) => {
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, [bin, "gateway", "run", "--port", String(port)], {
    detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: withOpenclawStartupEnv({ ...buildCliEnv(source), OPENCLAW_GATEWAY_PORT: String(port),
      OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_SKIP_PROVIDERS: "1", DO_NOT_TRACK: "1" }),
  });
  let tail = "";
  let exited = false;
  child.stdout.on("data", (chunk) => { tail = `${tail}${chunk}`.slice(-8_000); });
  child.stderr.on("data", (chunk) => { tail = `${tail}${chunk}`.slice(-8_000); });
  const exit = new Promise((resolve) => child.once("exit", () => { exited = true; resolve(); }));
  try {
    await waitFor(async () => {
      if (exited) throw new Error(`gateway exited before ready: ${tail}`);
      try {
        return (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) })).ok;
      } catch { return false; }
    }, 120_000, `minimal restore gateway on ${port}`);
  } finally {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    await Promise.race([exit, delay(5_000)]);
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    await Promise.race([exit, delay(1_000)]);
  }
  if (!exited) throw new Error("gateway did not exit after restore verification");
};

module.exports = { kCopyBudgetMs, writeFile, createSource, sourceJournal, leaveCommittedWal,
  produceCopy, restoreCapturedAssets, bootAndStop };
