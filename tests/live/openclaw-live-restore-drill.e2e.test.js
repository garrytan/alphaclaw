// LIVE TIER — the restore drill (plan WI-6.2): prove that a backup archive
// from EITHER producer can be restored by the documented runbook and that
// every supported target line then reads and RUNS the restored state.
//
//   producer  ∈ { upstream (real pin CLI `backup create --verify`),
//                 alphaclaw-offline-copy (createOfflineCopy) }
//   journal   ∈ { WAL, DELETE }   — PRAGMA journal_mode on the fixture DB
//   target    ∈ { pin 2026.7.1-2, stable 2026.8.2, beta 2026.9.1-beta.1 }
//
// Per cell (acceptance = all four; a failure is a finding, never a skip):
//   1. extract the archive into an isolated dir and place every
//      manifest.assets[] entry at archivePath → sourcePath (relative to the
//      manifest's paths.stateDir), exactly as docs/upgrade-troubleshooting.md
//      "Restoring a backup" tells the operator to;
//   2. the TARGET CLI's `database preflight <db> --json` on each restored DB
//      (standalone — no sidecars): pass ("exact" / "migration-required") or
//      an honest classification (the pin has no such command → unsupported);
//   3. PRAGMA integrity_check on every restored DB;
//   4. `gateway run` on the restored state dir answers /healthz within 120 s
//      (the live-gateway tier's loopback config).
// The fixture is a REAL pin-era state dir (materialized by the pin CLI), the
// oldest schema every target can read forward — so all 12 cells are
// supported upgrades-or-same. Downgrade compatibility is the downgrade
// tier's business (openclaw-live-downgrade.e2e.test.js).
//
// Calibration: ONE 500 MB cell records offline-copy duration + throughput
// (log) and asserts only the plan's 8-minute budget.
//
// Requires: network (two cached real installs), a supported Node. ~4-8 min.

const fs = require("fs");
const os = require("os");
const path = require("path");
const liveHelpers = require("./live-helpers");
process.env.ALPHACLAW_ROOT_DIR = liveHelpers.mkTemp(
  "alphaclaw-live-restore-drill-root-",
);
delete process.env.OPENCLAW_GIT_DIR;

const crypto = require("crypto");
const { execFileSync, spawnSync, spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const {
  createOfflineCopy,
  kOfflineCopyProducer,
  kOfflineCopyArchiveSuffix,
} = require("../../lib/server/openclaw-backup-offline-copy");
const {
  beginStateDbQuiet,
  isStateDbQuiet,
} = require("../../lib/server/state-db-quiet");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");
const {
  kOpenclawBackupOfflineCopyBudgetMs,
} = require("../../lib/server/constants");
const { withOpenclawStartupEnv } = require("../../lib/server/openclaw-runtime-env");
const { parseJsonObjectFromNoisyOutput } = require("../../lib/server/utils/json");
const { buildCliEnv } = require("./live-backup-harness");
const {
  kLiveEnabled,
  kOpenclawLines,
  mkTemp,
  repoOpenclawBin,
  scrubTestRunnerEnv,
  stageOpenclawVersion,
  waitFor,
} = liveHelpers;

const describeLive = kLiveEnabled ? describe : describe.skip;

const kInstallTimeoutMs = 8 * 60 * 1000;
const kSetupTimeoutMs = 12 * 60 * 1000;
const kCellTimeoutMs = 5 * 60 * 1000;
const kGatewayHealthTimeoutMs = 120_000;
const kCalibrationBytes = 500 * 1024 * 1024;
const kCalibrationTimeoutMs = kOpenclawBackupOfflineCopyBudgetMs + 4 * 60 * 1000;
const kGatewayToken = "live-e2e-token-000000000000000000000000";
const kBasePort = 19100;

const kProducers = ["upstream", kOfflineCopyProducer];
const kJournalModes = ["wal", "delete"];
const kTargets = ["pin", "stable", "beta"];

// Mirror of the module-local classifyPreflight vocabulary in
// openclaw-channel-sync.js, extended with the JSON `status` values the real
// CLIs print (probed live 2026-09-02): exact | migration-required (exit 0),
// incompatible | indeterminate (exit 1). The pin has no `database` command.
const kUnknownCliCommandPattern =
  /unknown (?:command|subcommand)|command not found|no such (?:command|subcommand)/i;
const classifyDrillPreflight = ({ code, out }) => {
  if (kUnknownCliCommandPattern.test(out)) return { verdict: "unsupported", status: null };
  const parsed = parseJsonObjectFromNoisyOutput(out);
  const status = parsed?.status ?? null;
  if (code === 0 && (status === "exact" || status === "migration-required")) {
    return { verdict: "pass", status, foundVersion: parsed.foundVersion, targetVersion: parsed.targetVersion };
  }
  return { verdict: "block", status, raw: out.slice(-600) };
};

const runCli = (bin, args, { homeDir, stateDir, timeoutMs = 120_000 }) => {
  const res = spawnSync(process.execPath, [bin, ...args], {
    env: buildCliEnv({ homeDir, stateDir }),
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return { code: res.status, out: `${res.stdout || ""}\n${res.stderr || ""}` };
};

const setJournalMode = (dbPath, mode) => {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare(`PRAGMA journal_mode = ${mode.toUpperCase()}`).get();
    if (String(row?.journal_mode).toLowerCase() !== mode) {
      throw new Error(`journal_mode=${mode} not applied: ${JSON.stringify(row)}`);
    }
  } finally {
    db.close();
  }
  if (mode === "delete") {
    for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
};

const readJournalMode = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return String(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toLowerCase();
  } finally {
    db.close();
  }
};

// The read-only open a WAL DB gets for PRAGMAs leaves empty -wal/-shm
// beside it; the preflight refuses a DB with sidecars, so drop them.
const dropEmptySidecars = (dbPath) => {
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${dbPath}${suffix}`;
    try {
      if (fs.statSync(sidecar).size === 0) fs.rmSync(sidecar, { force: true });
    } catch {}
  }
};

const integrityCheck = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return String(db.prepare("PRAGMA integrity_check").get()?.integrity_check);
  } finally {
    db.close();
    dropEmptySidecars(dbPath);
  }
};

const walkSqlite = (dir) => {
  const found = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && /\.sqlite$/.test(entry.name)) found.push(full);
    }
  };
  visit(dir);
  return found.sort();
};

const loopbackConfig = (port) => ({
  gateway: { mode: "local", bind: "loopback", port, auth: { token: kGatewayToken } },
});

// A real pin-era state dir: the pin CLI materializes state/openclaw.sqlite
// (user_version 1, 74 tables) beside a loopback gateway config and a session
// transcript. Copied per cell so producers/journal modes never share a DB.
const materializePinFixture = (pinBin) => {
  const homeDir = mkTemp("alphaclaw-live-drill-fixture-");
  const stateDir = path.join(homeDir, ".openclaw");
  fs.mkdirSync(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "openclaw.json"),
    `${JSON.stringify(loopbackConfig(kBasePort), null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(stateDir, "agents", "main", "sessions", "0001-seed.jsonl"),
    '{"role":"user","seq":1,"text":"restore drill"}\n',
  );
  const r = runCli(pinBin, ["approvals", "get", "--json"], { homeDir, stateDir });
  if (r.code !== 0) throw new Error(`pin could not materialize the fixture: ${r.out.slice(-600)}`);
  const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
  if (!fs.existsSync(dbPath)) throw new Error(`no state DB at ${dbPath}`);
  return { homeDir, stateDir, dbPath };
};

const cloneFixture = (fixture, { journalMode }) => {
  const homeDir = mkTemp(`alphaclaw-live-drill-src-${journalMode}-`);
  const stateDir = path.join(homeDir, ".openclaw");
  fs.cpSync(fixture.stateDir, stateDir, { recursive: true });
  const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  setJournalMode(dbPath, journalMode);
  if (journalMode === "wal") dropEmptySidecars(dbPath);
  return { homeDir, stateDir, dbPath };
};

const archiveCommandRunner = (() => {
  const runner = createRunStream({});
  return (spec) => runner.runStreamed({ ...spec, env: scrubTestRunnerEnv() });
})();

// Producers — both against the SAME cloned source dir.
const produceUpstream = (pinBin, source) => {
  const outDir = mkTemp("alphaclaw-live-drill-upstream-out-");
  const file = path.join(outDir, `openclaw-backup-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.tar.gz`);
  const r = runCli(pinBin, ["backup", "create", "--output", file, "--verify"], {
    homeDir: source.homeDir,
    stateDir: source.stateDir,
  });
  if (r.code !== 0 || !fs.existsSync(file)) {
    throw new Error(`pin backup create failed (${r.code}): ${r.out.slice(-800)}`);
  }
  return file;
};

const produceOfflineCopy = async (source, { runtimeVersion = kOpenclawLines.pin } = {}) => {
  const backupsDir = mkTemp("alphaclaw-live-drill-offline-out-");
  const outputFile = path.join(
    backupsDir,
    `openclaw-backup-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${kOfflineCopyArchiveSuffix}`,
  );
  // The barrier a production copy holds (owner token) — real module.
  const quiet = await beginStateDbQuiet({ owner: "restore-drill", maxMs: kCalibrationTimeoutMs });
  try {
    const copy = await createOfflineCopy({
      stateDir: source.stateDir,
      backupsDir,
      outputFile,
      exclusivity: {
        stopConfirmed: true,
        stopEvidence: { method: "managed_child", childExited: true, portReleased: true, cliRefused: false },
        quietToken: quiet.token ?? quiet,
        liveProcesses: [],
        handleCount: 0,
      },
      isQuiet: isStateDbQuiet,
      runCommand: archiveCommandRunner,
      runtimeVersion,
      diagnosis: null,
    });
    return copy;
  } finally {
    quiet.release?.();
  }
};

// The documented runbook, mechanized: extract → manifest → place assets.
// An upstream asset is the whole state dir (kind "state"); offline-copy
// assets are per-file. Both resolve through archivePath → sourcePath
// relative to manifest.paths.stateDir.
const restoreArchive = (file, { restoreRoot }) => {
  const extractDir = path.join(restoreRoot, "extract");
  fs.mkdirSync(extractDir, { recursive: true });
  execFileSync("tar", ["-xzf", file, "-C", extractDir], { stdio: "pipe", timeout: 120_000 });
  const roots = fs.readdirSync(extractDir);
  if (roots.length !== 1) throw new Error(`archive has ${roots.length} roots: ${roots}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(extractDir, roots[0], "manifest.json"), "utf8"));
  const restoredStateDir = path.join(restoreRoot, ".openclaw");
  fs.mkdirSync(restoredStateDir, { recursive: true });
  const placed = [];
  for (const asset of manifest.assets) {
    // Offline-copy archivePaths are relative to the archive root; upstream's
    // carry the root as their first segment.
    const inArchive = asset.archivePath.startsWith(`${manifest.archiveRoot}/`)
      ? path.join(extractDir, asset.archivePath)
      : path.join(extractDir, manifest.archiveRoot, asset.archivePath);
    const relative = path.relative(manifest.paths.stateDir, asset.sourcePath);
    if (relative.startsWith("..")) throw new Error(`asset outside stateDir: ${asset.sourcePath}`);
    const destination = path.join(restoredStateDir, relative);
    const stat = fs.statSync(inArchive);
    if (stat.isDirectory()) {
      fs.cpSync(inArchive, destination, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(inArchive, destination);
    }
    placed.push({ kind: asset.kind, relative: relative || ".", directory: stat.isDirectory() });
  }
  return { manifest, restoredStateDir, placed, archiveRoot: roots[0] };
};

const bootGateway = async ({ bin, homeDir, stateDir, port }) => {
  const configPath = path.join(stateDir, "openclaw.json");
  const current = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  fs.writeFileSync(configPath, `${JSON.stringify({ ...current, ...loopbackConfig(port) }, null, 2)}\n`);
  const env = withOpenclawStartupEnv({
    ...buildCliEnv({ homeDir, stateDir }),
    OPENCLAW_GATEWAY_PORT: String(port),
  });
  const child = spawn(process.execPath, [bin, "gateway", "run", "--port", String(port)], {
    env,
    stdio: "pipe",
  });
  let output = "";
  let exited = null;
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));
  child.on("exit", (code) => (exited = code));
  const startedAt = Date.now();
  try {
    await waitFor(
      async () => {
        if (exited !== null) return true;
        try {
          const r = await fetch(`http://127.0.0.1:${port}/healthz`);
          return r.ok;
        } catch {
          return false;
        }
      },
      kGatewayHealthTimeoutMs,
      `gateway /healthz on ${port} (last output: ${output.slice(-300)})`,
    );
    if (exited !== null) {
      throw new Error(`gateway exited ${exited} before /healthz:\n${output.slice(-2000)}`);
    }
    const healthz = await fetch(`http://127.0.0.1:${port}/healthz`);
    if (!healthz.ok) throw new Error(`/healthz ${healthz.status}`);
    return { readyMs: Date.now() - startedAt };
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
    if (exited === null) child.kill("SIGKILL");
  }
};

describeLive("LIVE restore drill (WI-6.2): producer × journal mode × target", () => {
  const bins = {};
  let fixture;
  // source archives per (producer, journalMode), produced once and restored
  // into a fresh dir per target.
  const archives = {};
  const results = [];
  let portCounter = kBasePort + 1;

  beforeAll(async () => {
    bins.pin = repoOpenclawBin();
    bins.stable = (await stageOpenclawVersion(kOpenclawLines.stable, { timeoutMs: kInstallTimeoutMs })).bin;
    bins.beta = (await stageOpenclawVersion(kOpenclawLines.beta, { timeoutMs: kInstallTimeoutMs })).bin;
    fixture = materializePinFixture(bins.pin);
    for (const journalMode of kJournalModes) {
      const source = cloneFixture(fixture, { journalMode });
      expect(readJournalMode(source.dbPath)).toBe(journalMode);
      dropEmptySidecars(source.dbPath);
      archives[`upstream/${journalMode}`] = {
        file: produceUpstream(bins.pin, source),
        source,
      };
      const copy = await produceOfflineCopy(source);
      expect(copy.ok).toBe(true);
      archives[`${kOfflineCopyProducer}/${journalMode}`] = { file: copy.file, source, copy };
    }
  }, kSetupTimeoutMs);

  afterAll(() => {
    if (results.length === 0) return;
    console.log("[live-restore-drill] results:");
    for (const row of results) {
      console.log(
        `  ${row.producer.padEnd(22)} ${row.journalMode.padEnd(6)} → ${row.target.padEnd(6)} ` +
          `preflight=${row.preflight} integrity=${row.integrity} healthz=${row.readyMs}ms restored=${row.restoredDbs}db`,
      );
    }
  });

  for (const producer of kProducers) {
    for (const journalMode of kJournalModes) {
      for (const target of kTargets) {
        it(
          `${producer} archive of a ${journalMode.toUpperCase()} fixture restores and boots on ${target} ${kOpenclawLines[target]}`,
          { timeout: kCellTimeoutMs },
          async () => {
            const archive = archives[`${producer}/${journalMode}`];
            expect(archive, `no ${producer}/${journalMode} archive was produced`).toBeTruthy();
            const restoreRoot = mkTemp(`alphaclaw-live-drill-restore-${target}-`);
            const port = portCounter++;

            // 1. Extract + place per manifest.
            const restored = restoreArchive(archive.file, { restoreRoot });
            if (producer === "upstream") {
              // Upstream: ONE state asset = the whole state dir.
              expect(restored.manifest.producer).toBeUndefined();
              expect(restored.placed).toEqual([{ kind: "state", relative: ".", directory: true }]);
            } else {
              expect(restored.manifest.producer).toBe(kOfflineCopyProducer);
              expect(restored.placed.some((p) => p.kind === "sqlite" && p.relative === path.join("state", "openclaw.sqlite"))).toBe(true);
              expect(restored.placed.some((p) => p.kind === "config" && p.relative === "openclaw.json")).toBe(true);
            }
            const restoredDbs = walkSqlite(restored.restoredStateDir);
            expect(restoredDbs.map((db) => path.relative(restored.restoredStateDir, db))).toContain(
              path.join("state", "openclaw.sqlite"),
            );
            // The restored DB is standalone — no sidecars rode along (the
            // offline copy skips them by design; upstream consolidates).
            for (const db of restoredDbs) {
              for (const suffix of ["-wal", "-shm", "-journal"]) {
                expect(fs.existsSync(`${db}${suffix}`), `${db}${suffix} rode along`).toBe(false);
              }
            }
            expect(fs.existsSync(path.join(restored.restoredStateDir, "openclaw.json"))).toBe(true);

            // 2. TARGET preflight on each restored DB (standalone file).
            const preflights = [];
            for (const db of restoredDbs) {
              const r = runCli(bins[target], ["database", "preflight", db, "--json"], {
                homeDir: mkTemp("alphaclaw-live-drill-pf-home-"),
                stateDir: mkTemp("alphaclaw-live-drill-pf-state-"),
              });
              const verdict = classifyDrillPreflight(r);
              preflights.push(verdict);
              if (target === "pin") {
                // Honest classification: the pin has no `database` command.
                expect(verdict.verdict).toBe("unsupported");
              } else {
                expect(verdict.verdict, `preflight ${JSON.stringify(verdict)}`).toBe("pass");
                // Pin-era schema 1 → 15 (stable) / 12 (beta): migration.
                expect(verdict.status).toBe("migration-required");
                expect(verdict.foundVersion).toBe(1);
              }
            }

            // 3. integrity_check on every restored DB.
            const integrity = restoredDbs.map((db) => integrityCheck(db));
            expect(integrity.every((verdict) => verdict === "ok"), JSON.stringify(integrity)).toBe(true);
            // Restored journal mode is whatever the archive carried — record it.
            const restoredJournal = readJournalMode(path.join(restored.restoredStateDir, "state", "openclaw.sqlite"));
            dropEmptySidecars(path.join(restored.restoredStateDir, "state", "openclaw.sqlite"));

            // 4. Boot the TARGET gateway on the restored state.
            const boot = await bootGateway({
              bin: bins[target],
              homeDir: restoreRoot,
              stateDir: restored.restoredStateDir,
              port,
            });
            expect(boot.readyMs).toBeLessThanOrEqual(kGatewayHealthTimeoutMs);
            results.push({
              producer,
              journalMode: `${journalMode}→${restoredJournal}`,
              target,
              preflight: preflights.map((p) => p.status || p.verdict).join(","),
              integrity: integrity.join(","),
              readyMs: boot.readyMs,
              restoredDbs: restoredDbs.length,
            });
          },
        );
      }
    }
  }

  it(
    "calibration: a 500 MB state tree offline-copies within the 8-minute budget (duration + throughput recorded)",
    { timeout: kCalibrationTimeoutMs },
    async () => {
      const source = cloneFixture(fixture, { journalMode: "wal" });
      // A second real-shaped DB path (the per-agent DB) carrying ~500 MB of
      // incompressible rows: gzip -1's worst case, sqlite backup()'s
      // realistic one.
      const bigDb = path.join(source.stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
      fs.mkdirSync(path.dirname(bigDb), { recursive: true });
      const db = new DatabaseSync(bigDb);
      try {
        db.exec("PRAGMA journal_mode = WAL; CREATE TABLE blobs (id INTEGER PRIMARY KEY, body BLOB)");
        const insert = db.prepare("INSERT INTO blobs (body) VALUES (?)");
        const chunk = 1024 * 1024;
        db.exec("BEGIN");
        for (let written = 0; written < kCalibrationBytes; written += chunk) {
          insert.run(crypto.randomBytes(chunk));
        }
        db.exec("COMMIT");
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        db.close();
      }
      const stateBytes = walkSqlite(source.stateDir).reduce((sum, file) => sum + fs.statSync(file).size, 0);
      expect(stateBytes).toBeGreaterThanOrEqual(kCalibrationBytes);

      const startedAt = Date.now();
      const copy = await produceOfflineCopy(source);
      const wallMs = Date.now() - startedAt;
      const mbPerSecond = stateBytes / 1e6 / (copy.durationMs / 1000);
      console.log(
        `[live-restore-drill calibration] ${Math.round(stateBytes / 1e6)} MB state → ${Math.round(copy.bytes / 1e6)} MB archive ` +
          `in ${copy.durationMs} ms (${mbPerSecond.toFixed(1)} MB/s source throughput, wall ${wallMs} ms, method "${copy.method}", ` +
          `${copy.databases.length} db(s) integrity ${copy.databases.map((d) => d.integrity).join("/")})`,
      );
      expect(copy.ok).toBe(true);
      expect(copy.durationMs).toBeLessThan(kOpenclawBackupOfflineCopyBudgetMs);
      expect(copy.bytes).toBeGreaterThan(kCalibrationBytes * 0.9);
      expect(copy.databases.every((d) => d.integrity === "ok")).toBe(true);
      expect(fs.statSync(copy.file).size).toBe(copy.bytes);
      // Free the half-gigabyte right away: the exit sweep would get it, but
      // the tier stages more dirs after this.
      fs.rmSync(copy.file, { force: true });
      fs.rmSync(source.homeDir, { recursive: true, force: true });
    },
  );
});
