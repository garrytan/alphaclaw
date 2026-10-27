const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const { createDoctorPhaseTracker } = require("../../lib/server/doctor-progress");
const {
  buildDoctorReport,
  formatDoctorReportLine,
  measureRetainedCapture,
  readConfigFingerprint,
} = require("../../lib/server/doctor-report");
const {
  formatUnconfiguredAgentDatabasesLine,
  readUnconfiguredAgentDatabases,
} = require("../../lib/server/agent-database-registry");
const { reportDoctorFactsAfterServing } = require("../../lib/server/doctor-after-serving");
const { readMigrationRecord, recordDoctorOutcome } = require("../../lib/server/openclaw-boot-migration");

// Real output of OpenClaw 2026.10.8 `doctor --fix --yes` with
// OPENCLAW_GATEWAY_STARTUP_TRACE=1 on scratch state (paths rewritten to /data).
const kFixtureDir = path.join(__dirname, "..", "fixtures", "doctor-trace-2026.10.8");
const kStdout = fs.readFileSync(path.join(kFixtureDir, "stdout.txt"), "utf8");
const kStderr = fs.readFileSync(path.join(kFixtureDir, "stderr.txt"), "utf8");

const kRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-doctor-report-"));
let seq = 0;
const makeDir = () => fs.mkdtempSync(path.join(kRoot, "case-" + (seq += 1) + "-"));
afterAll(() => fs.rmSync(kRoot, { recursive: true, force: true }));

// Feeds both streams in small chunks, alternating, so lines split mid-token
// (a duration's digits included) on both sides.
const feedInterleaved = (tracker, { stdout, stderr, size = 37 }) => {
  for (let offset = 0; offset < Math.max(stdout.length, stderr.length); offset += size) {
    tracker.onOutput(stderr.slice(offset, offset + size), "stderr");
    tracker.onOutput(stdout.slice(offset, offset + size), "stdout");
  }
};

describe("doctor report: steps from the startup trace", () => {
  it("reads every phase of a real 2026.10.8 run from interleaved, split stdout and stderr chunks", () => {
    const tracker = createDoctorPhaseTracker();
    feedInterleaved(tracker, { stdout: kStdout, stderr: kStderr });
    tracker.drain();
    const report = buildDoctorReport({ traced: tracker.report(), totalMs: 13_340 });

    expect(report.steps).toEqual([
      { step: "maintenance.begin", ms: 1535, nested: [{ step: "recovery-copy", ms: 1489 }] },
      { step: "database-preflight", ms: 2, nested: [] },
      { step: "config-flow", ms: 3246, nested: [{ step: "legacy-state-migrations", ms: 1748 }] },
      { step: "contributions", ms: 6441, nested: [] },
      { step: "maintenance-ready", ms: 76, nested: [] },
      { step: "maintenance.finish", ms: 3, nested: [] },
      { step: "maintenance.release", ms: 1, nested: [] },
    ]);
    expect(report.unattributedMs).toBe(13_340 - (1535 + 2 + 3246 + 6441 + 76 + 3 + 1));
    expect(report.slowestChecks).toEqual([
      { check: "write-config-migrations", ms: 1214 },
      { check: "runtime-tool-schemas", ms: 901 },
      { check: "session-transcripts", ms: 834 },
      { check: "shell-completion", ms: 692 },
      { check: "state-integrity", ms: 539 },
    ]);
    expect(report.changes[0]).toBe("Recorded webhook listener decisions; removed pins will not be recreated.");
    expect(report.changes).toContain("- Disabled 1password");
    expect(report.changes).toHaveLength(20);
    expect(report.changeCount).toBeGreaterThan(20);
    expect(report.changes).not.toContain('Create heartbeat monitor for agent "main" at 30m.');
  });

  it("keeps a last trace line that ends without a newline", () => {
    const tracker = createDoctorPhaseTracker();
    tracker.onOutput("[gateway] startup trace: doctor.maintenance.release 0.9ms total=13020.3ms start=13019.5ms", "stderr");
    expect(tracker.report().steps.size).toBe(0);
    tracker.drain();
    expect(tracker.report().steps.get("doctor.maintenance.release")).toBe(0.9);
  });

  it("an untraced run reports its total only, never a zero for steps it did not see", () => {
    const tracker = createDoctorPhaseTracker();
    tracker.onOutput("Doctor complete.\n", "stdout");
    const report = buildDoctorReport({ traced: tracker.report(), totalMs: 4_000 });
    expect(report).toMatchObject({ traced: false, steps: [], unattributedMs: null, slowestChecks: [], configFileRewritten: null, captureBytes: null });
    expect(formatDoctorReportLine(report, { source: "repair" })).toBe(
      "[alphaclaw] doctor --fix summary source=repair total=4.0s steps=untraced recoveryCopy=unknown configFile=unknown migrations=0 changes=0",
    );
  });

  it("formats one summary line with nested steps beside their parent", () => {
    const tracker = createDoctorPhaseTracker();
    feedInterleaved(tracker, { stdout: kStdout, stderr: kStderr, size: 4096 });
    tracker.drain();
    const report = buildDoctorReport({ traced: tracker.report(), totalMs: 632_000, configBefore: "a", configAfter: "b", captureBytes: 5_400_000_000 });
    const line = formatDoctorReportLine(report, { source: "boot" });
    expect(line).toMatch(/^\[alphaclaw\] doctor --fix summary source=boot total=632s maintenance\.begin=1\.5s\(recovery-copy=1\.5s\) database-preflight=0\.0s config-flow=3\.2s\(legacy-state-migrations=1\.7s\) contributions=6\.4s /);
    expect(line).toContain(" slowestChecks=write-config-migrations=1.2s,runtime-tool-schemas=0.9s,");
    expect(line).toContain(" recoveryCopy=5.4GB configFile=rewritten migrations=0 changes=");
  });
});

describe("doctor report: facts AlphaClaw measures", () => {
  it("config file: same bytes, rewritten, or unknown when either side is unreadable", () => {
    const dir = makeDir();
    expect(readConfigFingerprint({ openclawDir: dir })).toBeNull();
    fs.writeFileSync(path.join(dir, "openclaw.json"), "{}\n");
    const before = readConfigFingerprint({ openclawDir: dir });
    expect(buildDoctorReport({ traced: null, totalMs: 1, configBefore: before, configAfter: readConfigFingerprint({ openclawDir: dir }) }).configFileRewritten).toBe(false);
    fs.writeFileSync(path.join(dir, "openclaw.json"), "{ }\n");
    expect(buildDoctorReport({ traced: null, totalMs: 1, configBefore: before, configAfter: readConfigFingerprint({ openclawDir: dir }) }).configFileRewritten).toBe(true);
    expect(buildDoctorReport({ traced: null, totalMs: 1, configBefore: before, configAfter: null }).configFileRewritten).toBeNull();
  });

  it("measures the recovery copy only inside <state>.update-captures/doctor-*, without following symlinks", () => {
    const dir = makeDir();
    const stateDir = path.join(dir, ".openclaw");
    const capture = path.join(dir, ".openclaw.update-captures", "doctor-f66c83ac");
    fs.mkdirSync(path.join(capture, "agents", "main"), { recursive: true });
    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(capture, "manifest.json"), "x".repeat(10));
    fs.writeFileSync(path.join(capture, "agents", "main", "openclaw-agent.sqlite"), "y".repeat(1000));
    const outside = path.join(dir, "elsewhere");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "big"), "z".repeat(5000));
    fs.symlinkSync(outside, path.join(capture, "link"));

    expect(measureRetainedCapture({ manifestPath: path.join(capture, "manifest.json"), stateDir })).toBe(1010);
    expect(measureRetainedCapture({ manifestPath: "~/.openclaw.update-captures/doctor-f66c83ac/manifest.json", stateDir, env: { HOME: dir } })).toBe(1010);
    expect(measureRetainedCapture({ manifestPath: path.join(outside, "manifest.json"), stateDir })).toBeNull();
    expect(measureRetainedCapture({ manifestPath: null, stateDir })).toBeNull();
  });
});

const makeStateDb = (openclawDir, rows, { table = true } = {}) => {
  fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
  const db = new DatabaseSync(path.join(openclawDir, "state", "openclaw.sqlite"));
  if (table) {
    db.exec("CREATE TABLE agent_databases (agent_id TEXT NOT NULL, path TEXT NOT NULL, schema_version INTEGER, last_seen_at INTEGER, size_bytes INTEGER, PRIMARY KEY (agent_id, path)) STRICT");
    const insert = db.prepare("INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at, size_bytes) VALUES (?, ?, 25, 0, ?)");
    for (const row of rows) insert.run(row.agentId, row.path, row.sizeBytes ?? null);
  }
  db.close();
};

describe("unconfigured agent databases", () => {
  it("names registered databases no configured agent owns, with their size on disk or as registered", () => {
    const openclawDir = path.join(makeDir(), ".openclaw");
    const agentDb = (id) => path.join(openclawDir, "agents", id, "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(agentDb("retired-a")), { recursive: true });
    fs.writeFileSync(agentDb("retired-a"), "a".repeat(3000));
    fs.writeFileSync(agentDb("retired-a") + "-wal", "w".repeat(500));
    makeStateDb(openclawDir, [
      { agentId: "main", path: agentDb("main"), sizeBytes: 5_200_000_000 },
      { agentId: "ops", path: agentDb("ops"), sizeBytes: 10 },
      { agentId: "retired-a", path: agentDb("retired-a"), sizeBytes: 1 },
      { agentId: "retired-b", path: agentDb("retired-b"), sizeBytes: 1_200_000_000 },
      { agentId: "retired-c", path: agentDb("retired-c"), sizeBytes: null },
    ]);
    const config = { agents: { list: [{ id: "main" }, { id: "ops" }] } };

    const registry = readUnconfiguredAgentDatabases({ openclawDir, config });

    expect(registry).toEqual({
      available: true,
      reason: null,
      databases: [
        { agentId: "retired-a", path: agentDb("retired-a"), bytes: 3500 },
        { agentId: "retired-b", path: agentDb("retired-b"), bytes: 1_200_000_000 },
        { agentId: "retired-c", path: agentDb("retired-c"), bytes: null },
      ],
    });
    expect(formatUnconfiguredAgentDatabasesLine(registry)).toBe(
      "[alphaclaw] 3 agent databases belong to no configured agent: retired-a (0.00 GB), retired-b (1.2 GB), retired-c (size unknown)." +
        " OpenClaw logs \"database is not a configured target\" for these at gateway start and leaves them untouched;" +
        " doctor --fix still includes them in its recovery copy. Nothing was deleted.",
    );
  });

  it("an implicit main agent counts as configured, and none unconfigured is an empty list", () => {
    const openclawDir = path.join(makeDir(), ".openclaw");
    makeStateDb(openclawDir, [{ agentId: "main", path: "/data/.openclaw/agents/main/agent/openclaw-agent.sqlite", sizeBytes: 1 }]);
    expect(readUnconfiguredAgentDatabases({ openclawDir, config: {} })).toEqual({ available: true, reason: null, databases: [] });
  });

  it("says why when it cannot read the registry", () => {
    const missing = path.join(makeDir(), ".openclaw");
    expect(readUnconfiguredAgentDatabases({ openclawDir: missing, config: {} })).toMatchObject({ available: false, reason: "no_state_db" });
    const noTable = path.join(makeDir(), ".openclaw");
    makeStateDb(noTable, [], { table: false });
    expect(readUnconfiguredAgentDatabases({ openclawDir: noTable, config: {} })).toMatchObject({ available: false, reason: "no_registry" });
    const broken = path.join(makeDir(), ".openclaw");
    fs.mkdirSync(path.join(broken, "state"), { recursive: true });
    fs.writeFileSync(path.join(broken, "state", "openclaw.sqlite"), "not a database");
    expect(readUnconfiguredAgentDatabases({ openclawDir: broken, config: {} })).toMatchObject({ available: false, reason: "unreadable" });
  });
});

describe("doctor facts after the gateway serves", () => {
  const makeBox = () => {
    const dir = makeDir();
    const openclawDir = path.join(dir, ".openclaw");
    const managedDir = path.join(openclawDir, ".alphaclaw");
    fs.mkdirSync(managedDir, { recursive: true });
    const capture = path.join(dir, ".openclaw.update-captures", "doctor-1");
    fs.mkdirSync(capture, { recursive: true });
    fs.writeFileSync(path.join(capture, "manifest.json"), "m".repeat(2000));
    return { openclawDir, managedDir, manifestPath: path.join(capture, "manifest.json") };
  };
  const logger = () => ({ log: vi.fn(), warn: vi.fn() });

  it("adds this boot's recovery copy size to its report and the boot report, and logs the unconfigured databases", () => {
    const box = makeBox();
    recordDoctorOutcome({ managedDir: box.managedDir, outcome: { status: "ok", source: "boot", at: 5_000, report: { totalMs: 9, captureBytes: null, captureManifest: box.manifestPath } } });
    const mergeBootReport = vi.fn();
    const log = logger();
    const registry = { available: true, databases: [{ agentId: "retired-a", path: "/x", bytes: 7 }] };

    const facts = reportDoctorFactsAfterServing({
      ...box, processStartedAtMs: 1_000, readConfig: () => ({}), mergeBootReport, logger: log, readRegistry: () => registry,
    });

    expect(facts).toEqual({ doctorRecoveryCopyBytes: 2000, unconfiguredAgentDatabases: [{ agentId: "retired-a", bytes: 7 }] });
    expect(readMigrationRecord({ managedDir: box.managedDir }).lastOutcome.report.captureBytes).toBe(2000);
    expect(mergeBootReport).toHaveBeenCalledWith(facts);
    expect(log.log).toHaveBeenCalledWith("[alphaclaw] doctor --fix recovery copy kept: 0.00 GB");
    expect(log.log).toHaveBeenCalledWith(formatUnconfiguredAgentDatabasesLine(registry));
  });

  it("leaves an earlier boot's or another caller's run alone, and never throws", () => {
    const box = makeBox();
    recordDoctorOutcome({ managedDir: box.managedDir, outcome: { status: "ok", source: "boot", at: 500, report: { captureBytes: null, captureManifest: box.manifestPath } } });
    const facts = reportDoctorFactsAfterServing({
      ...box, processStartedAtMs: 1_000, readConfig: () => ({}), logger: logger(), readRegistry: () => ({ available: true, databases: [] }),
    });
    expect(facts).toEqual({ unconfiguredAgentDatabases: [] });
    expect(readMigrationRecord({ managedDir: box.managedDir }).lastOutcome.report.captureBytes).toBeNull();

    const log = logger();
    expect(() => reportDoctorFactsAfterServing({
      ...box, processStartedAtMs: 0, readConfig: () => { throw new Error("config gone"); }, logger: log,
    })).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith("[alphaclaw] could not read the agent database registry: config gone");
  });
});
