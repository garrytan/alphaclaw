// LIVE TIER — the Doctor output the doctor --fix report parses, from the REAL
// pinned OpenClaw (node_modules): with OPENCLAW_GATEWAY_STARTUP_TRACE=1, a
// doctor --fix prints "startup trace: <step> <ms>ms" for the phases
// doctor-report.js names, keeps its recovery copy where Doctor's manifest
// line says, and the state database carries the agent_databases columns the
// unconfigured-database explainer reads. When this tier fails but the
// hermetic suite is green, suspect upstream OpenClaw drift first and update
// the encoded assumption (AGENTS.md "test:live" note).
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const liveHelpers = require("./live-helpers");
const { materializeDatabases } = require("./database-fixture");
const { createDoctorPhaseTracker } = require("../../lib/server/doctor-progress");
const { createDoctorOutputFacts } = require("../../lib/server/doctor-outcome");
const { buildDoctorReport, measureRetainedCapture } = require("../../lib/server/doctor-report");
const { readUnconfiguredAgentDatabases } = require("../../lib/server/agent-database-registry");

const describeLive = liveHelpers.kLiveEnabled ? describe : describe.skip;

describeLive("live: doctor --fix report contract", () => {
  it("traces the named phases, keeps the recovery copy Doctor names, and exposes the registry columns", () => {
    const openclawBin = liveHelpers.repoOpenclawBin();
    const version = liveHelpers.readDeclaredPin();
    const home = liveHelpers.mkTemp("alphaclaw-live-doctor-report-");
    const stateDir = path.join(home, ".openclaw");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify({ gateway: { mode: "local" } }, null, 2));
    const cliEnv = liveHelpers.scrubTestRunnerEnv({
      ...process.env,
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    });
    materializeDatabases({ openclawBin, cliEnv, stateDir, version });

    const run = spawnSync(process.execPath, [openclawBin, "doctor", "--fix", "--yes"], {
      env: { ...cliEnv, OPENCLAW_GATEWAY_STARTUP_TRACE: "1" },
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    expect(run.error, run.stderr).toBeUndefined();
    expect(run.status, run.stderr + run.stdout).toBe(0);

    const tracker = createDoctorPhaseTracker();
    const facts = createDoctorOutputFacts({ env: cliEnv });
    for (const [streamName, text] of [["stdout", run.stdout], ["stderr", run.stderr]]) {
      tracker.onOutput(text, streamName);
      facts.onOutput(text, streamName);
    }
    tracker.drain();
    const report = buildDoctorReport({ traced: tracker.report(), totalMs: 1 });
    const steps = Object.fromEntries(report.steps.map((entry) => [entry.step, entry]));
    for (const step of ["maintenance.begin", "database-preflight", "config-flow", "contributions", "maintenance-ready", "maintenance.finish", "maintenance.release"]) {
      expect(steps[step], step + " missing from the trace:\n" + run.stderr).toBeDefined();
    }
    expect(steps["maintenance.begin"].nested.map((entry) => entry.step)).toContain("recovery-copy");
    expect(steps["config-flow"].nested.map((entry) => entry.step)).toContain("legacy-state-migrations");
    expect(report.slowestChecks).toHaveLength(5);

    const manifestPath = facts.snapshot().captureManifest;
    expect(manifestPath, run.stdout).toBeTruthy();
    expect(measureRetainedCapture({ manifestPath, stateDir, env: cliEnv })).toBeGreaterThan(0);

    const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), { readOnly: true });
    let columns;
    try {
      columns = db.prepare("PRAGMA table_info(agent_databases)").all().map((column) => column.name);
    } finally {
      db.close();
    }
    expect(columns).toEqual(expect.arrayContaining(["agent_id", "path", "size_bytes"]));
    expect(readUnconfiguredAgentDatabases({ openclawDir: stateDir, config: {} })).toEqual({ available: true, reason: null, databases: [] });
  }, 10 * 60 * 1000);
});
