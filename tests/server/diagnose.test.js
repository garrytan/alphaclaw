// `alphaclaw diagnose` collector + renderer (#76 A9): every section reads a
// mkdtemp root with the persisted formats present / missing / corrupt, a
// throwing reader degrades its OWN section to unavailable + reason (the
// readStatusSource pattern), live seams stamp `live`, the bundle is redacted
// before it is returned (fixture .env / openclaw.json / secret-named env
// values never reach the JSON or the markdown), and the markdown carries one
// heading per section with UTC ISO timestamps. Hermetic: real fs on a temp
// root, injected env / nowFn / reader seams, no server, no network.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const {
  kDiagnoseSchema,
  kDiagnoseSectionNames,
  kDiagnoseLogLinePattern,
  kDefaultLogTailLines,
  collectDiagnose,
  resolveStateDir,
  kWatchdogStatusFields,
} = require("../../lib/server/diagnose/collect");
const { renderDiagnoseMarkdown, kDiagnoseSectionTitles, iso } = require("../../lib/server/diagnose/render");
const { createServerPidfile } = require("../../lib/server/server-pidfile");
const { kBootMigrationFileName } = require("../../lib/server/openclaw-boot-migration");
const { kRetirementFileName } = require("../../lib/server/openclaw-channel-retirement");
const { createSchema } = require("../../lib/server/db/watchdog/schema");

const kNow = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
const kIsoPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;
const kEnvSecret = "tg-secret-value-7788";
const kConfigSecret = "cfg-secret-token-9911";
const kProcessEnvSecret = "env-secret-value-5566";
// The installed OpenClaw matches AlphaClaw's real pin: the CLI path's runtime
// reads the pin from AlphaClaw's own package.json.
const kPin = require("../../package.json").dependencies.openclaw;

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

// A real SQLite file with an explicit user_version (the schema-versions
// fixture shape).
const writeDb = (file, userVersion) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE t(x INTEGER)");
  db.exec(`PRAGMA user_version = ${userVersion}`);
  db.exec("CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT)");
  const agentId = file.includes(`${path.sep}agents${path.sep}`) ? path.basename(path.dirname(path.dirname(file))) : null;
  db.prepare("INSERT INTO schema_meta VALUES ('primary', ?, ?, ?)").run(agentId ? "agent" : "global", userVersion, agentId);
  db.close();
};

const createRoot = () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-diagnose-"));
  const openclawDir = path.join(rootDir, ".openclaw");
  const installDir = path.join(rootDir, "install");
  const managedDir = path.join(openclawDir, ".alphaclaw");
  fs.mkdirSync(managedDir, { recursive: true });
  const pidfile = createServerPidfile({ managedDir, logger: { warn() {}, log() {}, error() {} } });
  return { rootDir, openclawDir, installDir, managedDir, pidfile };
};

// Every persisted artifact the collector reads, in the shape its writer
// leaves on the volume. Secrets are planted where evidence can echo them.
const populate = ({ rootDir, openclawDir, installDir, managedDir, pidfile }) => {
  fs.writeFileSync(path.join(rootDir, ".env"), `# comment\nTELEGRAM_BOT_TOKEN=${kEnvSecret}\nPLAIN=notsecret\n`);
  writeJson(path.join(openclawDir, "openclaw.json"), { gateway: { auth: { token: kConfigSecret } } });

  writeJson(path.join(managedDir, "alphaclaw-version.json"), {
    version: "0.9.77",
    commit: "abc123",
    firstBootAt: kNow - 60_000,
    lastBootAt: kNow,
    bootCount: 3,
    previous: { version: "0.9.76", commit: null, lastBootAt: kNow - 120_000 },
  });

  const bootReport = (bootId, extra = {}) => ({
    schema: "alphaclaw.boot-report.v1",
    bootId,
    at: kNow - 1000,
    alphaclaw: { version: "0.9.77", commit: "abc123", previousVersion: "0.9.76", firstBootOfVersion: false },
    container: { pid1StartTicks: 3431, startMs: kNow - 90_000 },
    pidfile: { decision: "proceed", reason: "absent", record: { raw: null, format: null, legacyClaim: false } },
    openclaw: {
      declaredPin: "2026.9.2",
      installedAtBoot: "2026.9.2",
      installedDiverged: false,
      retiredChannel: null,
      bootSync: { action: "none", reason: null, warnings: [] },
    },
    binPhase: { status: "ok" },
    serverPhase: { status: "recorded", at: kNow, verdict: [], stateDb: [{ path: "x", kind: "state", userVersion: 15, status: "ok" }] },
    ...extra,
  });
  writeJson(
    path.join(managedDir, "boot-report.json"),
    bootReport("40:1", {
      openclaw: {
        declaredPin: "2026.9.2",
        installedAtBoot: "2026.9.2",
        installedDiverged: false,
        retiredChannel: { channel: "beta", version: "2026.9.3-beta.1", sha: null },
        bootSync: { action: "none", reason: null, warnings: [`boot guard warning echoing ${kEnvSecret}`] },
      },
    }),
  );
  writeJson(path.join(managedDir, "boot-report.1.json"), bootReport("39:1"));
  writeJson(
    path.join(managedDir, "boot-report-incident.json"),
    bootReport("38:1", {
      pinnedAt: kNow - 5000,
      openclaw: { declaredPin: "2026.9.2", installedAtBoot: "2026.7.1-2", bootSync: { action: "skipped_concurrent", reason: "pid_live", warnings: [] } },
      serverPhase: { status: "recorded", verdict: ["installed_not_expected", "pidfile_contradiction"] },
    }),
  );
  // The last REFUSED start (boot-report-refused.json): a second instance the
  // pidfile guard turned away for a corroborated live owner — bin half only,
  // server phase not_reached, kept OUT of the ring by the writer.
  writeJson(
    path.join(managedDir, "boot-report-refused.json"),
    bootReport("41:1", {
      pidfile: {
        evidence: { pid: 21, corroborated: true },
        decision: "skip",
        reason: "corroborated",
        record: { raw: { pid: 21, at: 1, startTicks: 5 }, format: 2, legacyClaim: false },
      },
      openclaw: {
        declaredPin: "2026.9.2",
        installedAtBoot: "2026.7.1-2",
        installedDiverged: true,
        bootSync: { action: "skipped_concurrent", reason: "live_server_corroborated", warnings: [] },
      },
      serverPhase: { status: "not_reached", reason: "pidfile_skip", at: kNow - 500, verdict: ["installed_not_expected"] },
    }),
  );

  writeJson(path.join(managedDir, kBootMigrationFileName), { completedForVersion: kPin, at: kNow - 10_000 });
  writeJson(path.join(managedDir, kRetirementFileName), {
    retiredAt: kNow - 20_000,
    previous: { channel: "beta", version: "2026.9.3-beta.1", sha: null },
    pinVersion: kPin,
    overlayDir: null,
    needsNotice: true,
    notifiedAt: kNow - 15_000,
  });
  pidfile.writeServerPid();

  writeDb(path.join(openclawDir, "state", "openclaw.sqlite"), 15);
  writeDb(path.join(openclawDir, "agents", "main", "agent", "openclaw-agent.sqlite"), 19);
  const brokenDb = path.join(openclawDir, "agents", "broken", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(brokenDb), { recursive: true });
  fs.writeFileSync(brokenDb, Buffer.alloc(4096, 0x41));

  const packageDir = path.join(installDir, "node_modules", "openclaw");
  writeJson(path.join(packageDir, "package.json"), { name: "openclaw", version: kPin, bin: "openclaw.mjs" });
  fs.writeFileSync(path.join(packageDir, "openclaw.mjs"), "");
  fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "dist", "openclaw-state-db-contract-AAAA.js"), "const OPENCLAW_STATE_SCHEMA_VERSION=15;export{OPENCLAW_STATE_SCHEMA_VERSION};\n");
  fs.writeFileSync(path.join(packageDir, "dist", "openclaw-agent-db-contract-BBBB.js"), "const OPENCLAW_AGENT_SCHEMA_VERSION = 19;\n");

  const dbDir = path.join(rootDir, "db");
  fs.mkdirSync(dbDir, { recursive: true });
  const watchdogDb = new DatabaseSync(path.join(dbDir, "watchdog.db"));
  // createSchema now carries plan A3's additive cause_json/severity columns
  // (db/watchdog/schema.js, pragma-guarded) — no manual ALTER here.
  createSchema(watchdogDb);
  const insert = watchdogDb.prepare(
    "INSERT INTO watchdog_incidents (incident_key, status, opened_at, resolved_at, summary_json, cause_json) VALUES ($key, $status, $opened, $resolved, $summary, $cause)",
  );
  insert.run({ $key: "crash_loop", $status: "resolved", $opened: "2026-09-06T10:00:00.000Z", $resolved: "2026-09-06T10:05:00.000Z", $summary: JSON.stringify({ trigger: "crash_loop", severity: "critical", durationMs: 300_000, statusSnapshot: { huge: true } }), $cause: null });
  insert.run({ $key: "gateway_down", $status: "resolved", $opened: "2026-09-06T11:00:00.000Z", $resolved: "2026-09-06T11:01:00.000Z", $summary: JSON.stringify({ trigger: "gateway_down", severity: "warning" }), $cause: null });
  insert.run({ $key: "crash_loop", $status: "abandoned", $opened: "2026-09-06T12:00:00.000Z", $resolved: "2026-09-06T12:30:00.000Z", $summary: "{not json", $cause: null });
  insert.run({ $key: "version_mismatch", $status: "open", $opened: "2026-09-06T13:00:00.000Z", $resolved: null, $summary: JSON.stringify({ trigger: "version_mismatch", severity: "critical" }), $cause: JSON.stringify({ cause: "state_schema_too_new", detail: `found 17 supports 15 ${kConfigSecret}`, fingerprint: "abcd1234" }) });
  watchdogDb.close();

  writeJson(path.join(openclawDir, "alphaclaw-restart-operation.json"), {
    operationId: "op-restart-1",
    kind: "gateway_restart",
    status: "failed",
    startedAt: kNow - 30_000,
    bootId: "40:1",
    expiresAt: kNow + 30_000,
    completedAt: kNow - 20_000,
    lastStep: "start_gateway",
    errorSummary: "gateway exited 1",
    evidenceTail: `ERROR Legacy exec approvals exist ${kConfigSecret}\n`,
    reasonsSnapshot: ["config_changed"],
  });
  writeJson(path.join(rootDir, "gateway-state.json"), {
    state: "degraded",
    since: kNow - 60_000,
    bootId: "40",
    cause: { cause: "legacy_exec_approvals", fingerprint: "ffff0000" },
    versionMismatch: { expected: "2026.9.2", running: "2026.7.1-2", source: "boot", detectedAt: kNow - 60_000 },
  });

  const backupsDir = path.join(rootDir, "backups", "openclaw");
  fs.mkdirSync(path.join(backupsDir, "leftover-dir"), { recursive: true });
  const writeBytes = (name, n, mtimeMs) => {
    fs.writeFileSync(path.join(backupsDir, name), Buffer.alloc(n, 0x42));
    fs.utimesSync(path.join(backupsDir, name), mtimeMs / 1000, mtimeMs / 1000);
  };
  writeBytes("2026-09-06T08-00-00.000Z-openclaw-backup.tar.gz", 100, kNow - 1000);
  writeBytes("2026-09-05T08-00-00.000Z-openclaw-backup.tar.gz", 50, kNow - 90_000);

  const logLines = [];
  for (let i = 0; i < 250; i += 1) logLines.push(`[alphaclaw] boot line ${i}`);
  logLines.push("plain noise line without a tag");
  logLines.push("2026-09-06T00:00:00.000Z [watchdog] health probe failed");
  logLines.push(`[gateway] exit code 1 token=${kEnvSecret} key ${kProcessEnvSecret}`);
  logLines.push("[openclaw-channel] boot sync: none");
  logLines.push("[cron] unrelated subsystem");
  fs.mkdirSync(path.join(rootDir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "logs", "process.log"), `${logLines.join("\n")}\n`);
};

const collect = (ctx, overrides = {}) =>
  collectDiagnose({
    rootDir: ctx.rootDir,
    openclawDir: ctx.openclawDir,
    installDir: ctx.installDir,
    nowFn: () => kNow,
    env: { MY_API_KEY: kProcessEnvSecret, HOME: "/home/x" },
    ...overrides,
  });

describe("diagnose: boot-to-boot state path identity", () => {
  let ctx;
  beforeEach(() => { ctx = createRoot(); });
  afterEach(() => { fs.rmSync(ctx.rootDir, { recursive: true, force: true }); });

  it("warns in JSON and Markdown when symlink-equivalent boot paths differ", async () => {
    const alias = path.join(ctx.rootDir, "state-alias");
    fs.symlinkSync(ctx.openclawDir, alias);
    const bundle = await collect(ctx, {
      bootReports: {
        current: { bootId: "new", openclaw: { stateDir: ctx.openclawDir } },
        previous: [{ bootId: "old", openclaw: { stateDir: alias } }],
      },
    });
    expect(fs.realpathSync(alias)).toBe(fs.realpathSync(ctx.openclawDir));
    const warnings = bundle.sections.bootReports.warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`${alias} → ${ctx.openclawDir}`);
    expect(warnings[0]).toContain("Cron jobs and run history");
    expect(renderDiagnoseMarkdown(bundle)).toContain(warnings[0]);
    expect(bundle.sections.bootReports.data.verdict).toBeNull();
  });

  it.each([
    ["/state", "/state"],
    ["/state", undefined],
    [undefined, "/state"],
    ["/state", ""],
    ["/state", 123],
  ])("does not invent a change for unchanged or legacy paths (%s, %s)", async (current, previous) => {
    const bundle = await collect(ctx, {
      bootReports: {
        current: { openclaw: { stateDir: current } },
        previous: [{ openclaw: { stateDir: previous } }],
      },
    });
    expect(bundle.sections.bootReports.warnings).toEqual([]);
  });

  it("does not compare an initial boot against an incident or refused start", async () => {
    const bundle = await collect(ctx, {
      bootReports: {
        current: { openclaw: { stateDir: "/state" } },
        previous: [],
        incident: { openclaw: { stateDir: "/old" } },
        refused: { openclaw: { stateDir: "/refused" } },
      },
    });
    expect(bundle.sections.bootReports.warnings).toEqual([]);
  });
});

describe("diagnose: collectDiagnose over a populated root (disk path)", () => {
  let ctx;
  let bundle;
  beforeAll(async () => {
    ctx = createRoot();
    populate(ctx);
    bundle = await collect(ctx);
  });
  afterAll(() => {
    fs.rmSync(ctx.rootDir, { recursive: true, force: true });
  });

  it("stamps the schema, paths, mode and every section in collector order", () => {
    expect(bundle.schema).toBe(kDiagnoseSchema);
    expect(bundle.generatedAt).toBe("2023-11-14T22:13:20.000Z");
    expect(bundle.redacted).toBe(true);
    expect(Object.keys(bundle.sections)).toEqual([...kDiagnoseSectionNames]);
    expect(bundle.paths).toEqual({
      rootDir: ctx.rootDir,
      rootSource: "server_configuration",
      openclawDir: ctx.openclawDir,
      managedDir: ctx.managedDir,
      stateDir: ctx.openclawDir,
      installDir: ctx.installDir,
    });
    // The CLI path computes the OpenClaw runtime facts, the pidfile decision
    // and the state-DB reads live; everything else is read from disk.
    expect(bundle.mode).toBe("cli");
    expect(bundle.summary.sources).toEqual({ live: 3, disk: 8, unavailable: 1 });
    expect(bundle.summary.unavailable).toEqual(["watchdog"]);
    for (const name of kDiagnoseSectionNames) {
      const section = bundle.sections[name];
      expect(["live", "disk", "unavailable"]).toContain(section.source);
      expect(Array.isArray(section.warnings)).toBe(true);
      if (section.source === "unavailable") {
        expect(typeof section.reason).toBe("string");
        expect(section.data).toBeNull();
      } else {
        expect(section.reason).toBeNull();
        expect(section.data).not.toBeNull();
      }
    }
  });

  it("selfVersion: the stamp record", () => {
    const { source, data } = bundle.sections.selfVersion;
    expect(source).toBe("disk");
    expect(data.present).toBe(true);
    expect(data.record).toMatchObject({ version: "0.9.77", commit: "abc123", bootCount: 3, previous: { version: "0.9.76" } });
  });

  it("bootReports: current, rotated previous, pinned incident, the last refused start and the current verdict", () => {
    const { source, data } = bundle.sections.bootReports;
    expect(source).toBe("disk");
    expect(data.current.bootId).toBe("40:1");
    expect(data.previous.map((r) => r.bootId)).toEqual(["39:1"]);
    expect(data.incident.bootId).toBe("38:1");
    expect(data.incident.serverPhase.verdict).toEqual(["installed_not_expected", "pidfile_contradiction"]);
    // The refused start is its own entry — never a ring slot, never the
    // current boot, never the verdict the summary reports.
    expect(data.refused.bootId).toBe("41:1");
    expect(data.refused.serverPhase).toMatchObject({ status: "not_reached", reason: "pidfile_skip", verdict: ["installed_not_expected"] });
    expect(data.previous.map((r) => r.bootId)).not.toContain("41:1");
    expect(data.verdict).toEqual([]);
    expect(data.unreadable).toEqual([]);
    expect(bundle.summary.bootVerdict).toEqual([]);
  });

  it("openclaw: the pinned and installed versions, the doctor migration record and the retired version switch", () => {
    const { source, data, warnings } = bundle.sections.openclaw;
    expect(source).toBe("live");
    expect(warnings).toEqual([]);
    expect(data).toEqual({
      installedVersion: kPin,
      pinnedVersion: kPin,
      installedDiverged: false,
      bootMigration: { completedForVersion: kPin, at: kNow - 10_000 },
      retiredChannel: expect.objectContaining({ previous: { channel: "beta", version: "2026.9.3-beta.1", sha: null }, notifiedAt: kNow - 15_000 }),
    });
  });

  it("pidfile: a fresh describeServerPidDecision record plus its one audit line, stamped live", () => {
    const { source, data } = bundle.sections.pidfile;
    expect(source).toBe("live");
    expect(data.path).toBe(ctx.pidfile.serverPidPath);
    expect(["proceed", "skip"]).toContain(data.decision.decision);
    expect(typeof data.decision.reason).toBe("string");
    expect(data.line).toContain("→");
    expect(data.line).toContain(data.decision.decision);
  });

  it("stateDb: state + agent DBs under the state dir with their user_version; a corrupt DB is named, not skipped", () => {
    const { source, data, warnings } = bundle.sections.stateDb;
    expect(source).toBe("live");
    expect(data.stateDir).toBe(ctx.openclawDir);
    expect(data.stateDirFromEnv).toBe(false);
    const byKind = Object.fromEntries(data.entries.map((e) => [`${e.kind}:${e.agentId ?? ""}`, e]));
    expect(byKind["state:"]).toMatchObject({ userVersion: 15, status: "ok", agentId: null });
    expect(byKind["state:"].sizeBytes).toBeGreaterThan(0);
    expect(byKind["agent:main"]).toMatchObject({ userVersion: 19, status: "ok" });
    expect(byKind["agent:broken"]).toMatchObject({ userVersion: null, status: "corrupt" });
    expect(warnings.some((w) => w.includes("broken") && w.includes("unreadable"))).toBe(true);
  });

  it("supportedSchema: the installed build's declared dist constants win over the seeds", () => {
    const { source, data, warnings } = bundle.sections.supportedSchema;
    expect(source).toBe("disk");
    expect(data.installedVersion).toBe(kPin);
    expect(data.packageDir).toBe(path.join(ctx.installDir, "node_modules", "openclaw"));
    expect(data.supported).toEqual({ state: 15, agent: 19, source: { state: "declared", agent: "declared" } });
    expect(warnings).toEqual([]);
  });

  it("incidents: the last 3 rows read READ-ONLY, newest first, with cause and a slim summary", () => {
    const { source, data } = bundle.sections.incidents;
    expect(source).toBe("disk");
    expect(data.dbPath).toBe(path.join(ctx.rootDir, "db", "watchdog.db"));
    expect(data.incidents.map((i) => i.id)).toEqual([4, 3, 2]);
    const [open, abandoned, resolved] = data.incidents;
    expect(open).toMatchObject({ incidentKey: "version_mismatch", status: "open", resolvedAt: null, openedAt: "2026-09-06T13:00:00.000Z" });
    expect(open.cause).toMatchObject({ cause: "state_schema_too_new", fingerprint: "abcd1234" });
    expect(open.summary).toEqual({ trigger: "version_mismatch", severity: "critical" });
    expect(abandoned.summary).toEqual({ unreadable: true });
    expect(abandoned.cause).toBeNull();
    expect(resolved.summary).toEqual({ trigger: "gateway_down", severity: "warning" });
    // The DB is untouched: no schema created, no writer handle left behind.
    expect(fs.existsSync(path.join(ctx.rootDir, "db", "watchdog.db-wal"))).toBe(false);
  });

  it("restartOperation and gatewayState: the persisted records read leniently", () => {
    const restart = bundle.sections.restartOperation;
    expect(restart.source).toBe("disk");
    expect(restart.data.path).toBe(path.join(ctx.openclawDir, "alphaclaw-restart-operation.json"));
    expect(restart.data.present).toBe(true);
    expect(restart.data.record).toMatchObject({ operationId: "op-restart-1", status: "failed", lastStep: "start_gateway" });
    const gateway = bundle.sections.gatewayState;
    expect(gateway.source).toBe("disk");
    expect(gateway.data.path).toBe(path.join(ctx.rootDir, "gateway-state.json"));
    expect(gateway.data.record).toMatchObject({ state: "degraded", since: kNow - 60_000, cause: { cause: "legacy_exec_approvals" } });
  });

  it("backups: every entry of the backups dir, newest first, with a byte total", () => {
    const { source, data, warnings } = bundle.sections.backups;
    expect(source).toBe("disk");
    expect(warnings).toEqual([]);
    expect(data.dir).toBe(path.join(ctx.rootDir, "backups", "openclaw"));
    expect(data.present).toBe(true);
    const files = data.entries.filter((e) => !e.directory);
    expect(files).toEqual([
      { name: "2026-09-06T08-00-00.000Z-openclaw-backup.tar.gz", sizeBytes: 100, mtimeMs: kNow - 1000 },
      { name: "2026-09-05T08-00-00.000Z-openclaw-backup.tar.gz", sizeBytes: 50, mtimeMs: kNow - 90_000 },
    ]);
    expect(data.entries.find((e) => e.directory)).toMatchObject({ name: "leftover-dir", sizeBytes: null, directory: true });
    expect(data.totalBytes).toBe(150);
  });

  it("watchdog: unavailable on the CLI path with a reason naming the route", () => {
    const { source, reason, data } = bundle.sections.watchdog;
    expect(source).toBe("unavailable");
    expect(reason).toContain("GET /api/diagnose");
    expect(data).toBeNull();
  });

  it("logTail: process.log filtered by the boot-spine tag pattern (substring), bounded to the default line count", () => {
    const { source, data } = bundle.sections.logTail;
    expect(source).toBe("disk");
    expect(data.path).toBe(path.join(ctx.rootDir, "logs", "process.log"));
    expect(data.pattern).toBe(kDiagnoseLogLinePattern.source);
    expect(data.scannedLines).toBe(255);
    // 250 [alphaclaw] + [watchdog] (timestamp-prefixed) + [gateway] + [openclaw-channel]
    expect(data.matchedLines).toBe(253);
    expect(data.lines).toHaveLength(kDefaultLogTailLines);
    expect(data.truncated).toBe(true);
    expect(data.lines.at(-1)).toBe("[openclaw-channel] boot sync: none");
    expect(data.lines.some((l) => l.includes("[watchdog] health probe failed"))).toBe(true);
    expect(data.lines.some((l) => l.includes("[cron]") || l.includes("plain noise"))).toBe(false);
  });

  it("redaction: .env values, inline openclaw.json secrets and secret-named env values never appear in the JSON", () => {
    const json = JSON.stringify(bundle);
    expect(json).not.toContain(kEnvSecret);
    expect(json).not.toContain(kConfigSecret);
    expect(json).not.toContain(kProcessEnvSecret);
    expect(json).toContain("***");
    // Planted in four different sections — each one was scrubbed in place.
    expect(bundle.sections.bootReports.data.current.openclaw.bootSync.warnings[0]).toBe("boot guard warning echoing ***");
    expect(bundle.sections.restartOperation.data.record.evidenceTail).toContain("***");
    expect(bundle.sections.incidents.data.incidents[0].cause.detail).toBe("found 17 supports 15 ***");
    expect(bundle.sections.logTail.data.lines.some((l) => l.includes("[gateway] exit code 1 token=*** key ***"))).toBe(true);
    // Structure survives redaction: keys, paths and non-secret values are
    // untouched (only secret-NAMED process.env keys are collected, so HOME's
    // value is never a mask candidate).
    expect(bundle.sections.openclaw.data.pinnedVersion).toBe(kPin);
    expect(bundle.paths.rootDir).toBe(ctx.rootDir);
  });

  it("renderDiagnoseMarkdown: one heading per section, sources named, UTC ISO timestamps, no secrets", () => {
    const md = renderDiagnoseMarkdown(bundle);
    const headings = md.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toHaveLength(kDiagnoseSectionNames.length);
    for (const name of kDiagnoseSectionNames) {
      expect(headings.some((h) => h.startsWith(`## ${kDiagnoseSectionTitles[name]} (`))).toBe(true);
    }
    expect(md).toContain("## Server pidfile (live)");
    expect(md).toContain("## Watchdog (unavailable)");
    expect(md).toContain("_Unavailable: no live watchdog");
    expect(md).toContain("- generated: 2023-11-14T22:13:20.000Z");
    // gateway-state `since` (ms epoch) rendered as UTC ISO, never localized.
    expect(md).toContain("state: degraded since 2023-11-14T22:12:20.000Z");
    expect(md).toContain("opened 2026-09-06T13:00:00.000Z");
    expect(md).toMatch(kIsoPattern);
    expect(md).not.toMatch(/GMT[+-]/);
    expect(md).toContain("| database | kind | user_version | status | size |");
    expect(md).toContain("corrupt (SQLITE_NOTADB)");
    expect(md).toContain("cause: `state_schema_too_new`");
    expect(md).toContain("INCONSISTENT — `installed_not_expected`, `pidfile_contradiction`");
    // Versions come from the report's one reader (describeReportVersions).
    expect(md).toContain("- openclaw: pin 2026.9.2, installed 2026.9.2, diverged false, retired version switch (was beta 2026.9.3-beta.1)");
    expect(md).toContain("openclaw pin 2026.9.2 / installed 2026.9.2; guard none; pidfile proceed/absent");
    expect(md).toContain("- openclaw: pin 2026.9.2, installed 2026.7.1-2, diverged true");
    // The refused start renders under its own heading, outside the ring,
    // with the bin-half verdict and the not_reached server phase.
    expect(md).toContain("### Last refused start");
    expect(md).toContain("boot-report-refused.json — a second instance");
    expect(md).toContain("boot `41:1` at 2023-11-14T22:13:19.000Z — INCONSISTENT — `installed_not_expected`");
    expect(md).toContain("- server phase: not_reached (pidfile_skip) at 2023-11-14T22:13:19.500Z");
    expect(md).toContain("- pidfile: skip (corroborated)");
    expect(md).toContain("- boot guard: skipped_concurrent (live_server_corroborated)");
    expect(md).toContain(`- pinned: ${kPin}`);
    expect(md).toContain(`- doctor --fix completed for: ${kPin} at 2023-11-14T22:13:10.000Z`);
    expect(md).toContain("- retired version switch: was beta 2026.9.3-beta.1 at 2023-11-14T22:13:00.000Z; notice sent 2023-11-14T22:13:05.000Z");
    expect(md).not.toContain(kEnvSecret);
    expect(md).not.toContain(kConfigSecret);
    expect(md).not.toContain(kProcessEnvSecret);
    expect(md.endsWith("\n")).toBe(true);
  });
});

describe("diagnose: a fresh root (nothing written yet)", () => {
  let ctx;
  let bundle;
  beforeAll(async () => {
    ctx = createRoot();
    bundle = await collect(ctx);
  });
  afterAll(() => {
    fs.rmSync(ctx.rootDir, { recursive: true, force: true });
  });

  it("missing files are the documented empty state, not failures; only the DB-backed and live-only sections are unavailable", () => {
    expect(bundle.summary.unavailable).toEqual(["incidents", "watchdog"]);
    expect(bundle.sections.incidents.reason).toContain("watchdog.db");
    expect(bundle.sections.incidents.reason).toContain("not found");
    expect(bundle.sections.selfVersion.data).toEqual({ path: path.join(ctx.managedDir, "alphaclaw-version.json"), present: false, record: null });
    expect(bundle.sections.bootReports.data).toMatchObject({ current: null, previous: [], incident: null, refused: null, unreadable: [], verdict: null });
    expect(bundle.sections.openclaw.data).toMatchObject({ installedVersion: null, pinnedVersion: kPin, installedDiverged: false, bootMigration: null, retiredChannel: null });
    expect(bundle.sections.pidfile.data.decision).toMatchObject({ decision: "proceed", reason: "absent" });
    expect(bundle.sections.stateDb.data.entries).toEqual([]);
    expect(bundle.sections.stateDb.warnings[0]).toContain("no state databases");
    expect(bundle.sections.supportedSchema.data.supported.state).toBe(null);
    expect(bundle.sections.supportedSchema.warnings.length).toBeGreaterThan(0);
    expect(bundle.sections.restartOperation.data).toMatchObject({ present: false, record: null });
    expect(bundle.sections.gatewayState.data).toMatchObject({ present: false, record: null });
    expect(bundle.sections.backups.data).toMatchObject({ present: false, entries: [], totalBytes: 0 });
    expect(bundle.sections.logTail.data).toMatchObject({ scannedLines: 0, matchedLines: 0, lines: [], truncated: false });
    expect(bundle.sections.logTail.warnings[0]).toContain("process.log not found");
    expect(bundle.summary.bootVerdict).toBeNull();
  });

  it("still renders every section, saying why the unavailable ones are", () => {
    const md = renderDiagnoseMarkdown(bundle);
    expect(md.split("\n").filter((l) => l.startsWith("## "))).toHaveLength(kDiagnoseSectionNames.length);
    expect(md).toContain("## Incidents (unavailable)");
    expect(md).toContain("- no stamp at");
    expect(md).toContain("- no boot-report.json under");
    expect(md).toContain("- none (no start has been refused for a corroborated live owner)");
    expect(md).toContain("- no databases found");
    expect(md).toContain("- no backups directory at");
    expect(md).toContain("- doctor --fix completed for: none recorded");
    expect(md).toContain("(no matching lines)");
    expect(md).toContain("- current boot verdict: unknown");
  });
});

describe("diagnose: corrupt artifacts are reported explicitly", () => {
  let ctx;
  let bundle;
  beforeAll(async () => {
    ctx = createRoot();
    populate(ctx);
    fs.writeFileSync(path.join(ctx.managedDir, "boot-report.json"), "garbage");
    fs.writeFileSync(path.join(ctx.managedDir, "boot-report-incident.json"), "[1,2]");
    fs.writeFileSync(path.join(ctx.managedDir, "boot-report-refused.json"), '{"bootId":');
    fs.writeFileSync(path.join(ctx.managedDir, "alphaclaw-version.json"), "{{");
    fs.writeFileSync(path.join(ctx.rootDir, "gateway-state.json"), "nope");
    fs.writeFileSync(path.join(ctx.openclawDir, "alphaclaw-restart-operation.json"), "");
    fs.writeFileSync(path.join(ctx.rootDir, "db", "watchdog.db"), Buffer.alloc(8192, 0x5a));
    bundle = await collect(ctx);
  });
  afterAll(() => {
    fs.rmSync(ctx.rootDir, { recursive: true, force: true });
  });

  it("corrupt boot reports are listed by name; the readable ring slot survives", () => {
    const { data, warnings } = bundle.sections.bootReports;
    expect(data.current).toBeNull();
    expect(data.previous.map((r) => r.bootId)).toEqual(["39:1"]);
    expect(data.incident).toBeNull();
    expect(data.refused).toBeNull();
    expect(data.unreadable.sort()).toEqual(["boot-report-incident.json", "boot-report-refused.json", "boot-report.json"]);
    expect(warnings.some((w) => w.includes("boot-report.json is unreadable"))).toBe(true);
    expect(warnings.some((w) => w.includes("boot-report-refused.json is unreadable"))).toBe(true);
    expect(renderDiagnoseMarkdown(bundle)).toContain("- unreadable files: `boot-report-incident.json`, `boot-report-refused.json`, `boot-report.json`");
  });

  it("a corrupt version stamp, gateway-state and restart-op file are present-but-unreadable with a warning each", () => {
    expect(bundle.sections.selfVersion.data).toMatchObject({ present: true, record: null });
    expect(bundle.sections.selfVersion.warnings.length).toBeGreaterThan(0);
    expect(bundle.sections.gatewayState.data).toMatchObject({ present: true, record: null });
    expect(bundle.sections.gatewayState.warnings[0]).toContain("unreadable");
    expect(bundle.sections.restartOperation.data).toMatchObject({ present: true, record: null });
    expect(bundle.sections.restartOperation.warnings[0]).toContain("unreadable");
    const md = renderDiagnoseMarkdown(bundle);
    expect(md).toContain("is present but unreadable");
  });

  it("a corrupt watchdog.db makes ONLY the incidents section unavailable, with the SQLite reason", () => {
    const { source, reason } = bundle.sections.incidents;
    expect(source).toBe("unavailable");
    expect(reason).toMatch(/incidents failed: .*(not a database|malformed|SQLITE)/i);
    expect(bundle.sections.backups.source).toBe("disk");
    expect(bundle.sections.stateDb.source).toBe("live");
  });
});

describe("diagnose: a throwing reader degrades its own section only", () => {
  let ctx;
  afterEach(() => {
    if (ctx) fs.rmSync(ctx.rootDir, { recursive: true, force: true });
    ctx = null;
  });

  it("every injected seam that throws yields unavailable + its message; the rest of the bundle is intact and renders", async () => {
    ctx = createRoot();
    populate(ctx);
    const boom = (label) => () => {
      throw new Error(`${label} exploded`);
    };
    const bundle = await collect(ctx, {
      getWatchdogStatus: boom("watchdog"),
      openclawRuntime: {
        getInfo: boom("runtime info"),
        readStateDbVersions: boom("state db read"),
        getExecutingBuild: boom("build read"),
      },
      bootReports: boom("boot reports"),
      selfVersion: boom("self version"),
      readLogTail: boom("log tail"),
      incidentsDb: { listIncidents: boom("incidents") },
    });
    expect(bundle.sections.watchdog).toMatchObject({ source: "unavailable", reason: "watchdog failed: watchdog exploded", data: null });
    expect(bundle.sections.openclaw).toMatchObject({ source: "unavailable", reason: "openclaw failed: runtime info exploded" });
    expect(bundle.sections.supportedSchema).toMatchObject({ source: "unavailable", reason: "supportedSchema failed: build read exploded" });
    expect(bundle.sections.stateDb).toMatchObject({ source: "unavailable", reason: "stateDb failed: state db read exploded" });
    expect(bundle.sections.bootReports).toMatchObject({ source: "unavailable", reason: "bootReports failed: boot reports exploded" });
    expect(bundle.sections.selfVersion).toMatchObject({ source: "unavailable", reason: "selfVersion failed: self version exploded" });
    expect(bundle.sections.logTail).toMatchObject({ source: "unavailable", reason: "logTail failed: log tail exploded" });
    expect(bundle.sections.incidents).toMatchObject({ source: "unavailable", reason: "incidents failed: incidents exploded" });
    // Untouched sections still read the disk.
    expect(bundle.sections.pidfile.source).toBe("live");
    expect(bundle.sections.backups.source).toBe("disk");
    expect(bundle.sections.gatewayState.source).toBe("disk");
    expect(bundle.sections.restartOperation.source).toBe("disk");
    expect(bundle.summary.sources.unavailable).toBe(8);
    expect(bundle.summary.bootVerdict).toBeNull();

    const md = renderDiagnoseMarkdown(bundle);
    expect(md.split("\n").filter((l) => l.startsWith("## "))).toHaveLength(kDiagnoseSectionNames.length);
    expect(md).toContain("## OpenClaw (unavailable)\n_Unavailable: openclaw failed: runtime info exploded_");
    expect(md).toContain("## Boot reports (unavailable)");
    expect(md).toContain("- sections: 12 — live 1, disk 3, unavailable 8 (");
  });

});

describe("diagnose: live seams (server path)", () => {
  let ctx;
  afterEach(() => {
    if (ctx) fs.rmSync(ctx.rootDir, { recursive: true, force: true });
    ctx = null;
  });

  it("stamps watchdog / OpenClaw runtime / incidents as live, picks the stable status fields and flips the mode to server", async () => {
    ctx = createRoot();
    populate(ctx);
    const status = {
      lifecycle: "running",
      health: "degraded",
      degradedReason: "version_mismatch",
      degradedSince: "2026-09-06T13:00:00.000Z",
      versionMismatch: { expected: "2026.9.2", running: "2026.7.1-2", source: "boot", detectedAt: kNow },
      lastExit: { code: 1, signal: null, cause: "state_schema_too_new" },
      repairAttempts: 2,
      // #87 readiness axis enums ride the bundle beside readiness/readinessReason.
      readiness: "not_ready",
      readinessReason: "secrets",
      readinessStatus: "starting",
      readinessProbe: "ok",
      // Not for the bundle: history/tails the console renders.
      crashTimestamps: [1, 2, 3],
      recentEvents: [{ huge: true }],
    };
    const listIncidents = vi.fn(() => [
      { id: 9, incidentKey: "version_mismatch", status: "open", openedAt: "2026-09-06T13:00:00.000Z", resolvedAt: null, summary: { trigger: "version_mismatch", severity: "critical", statusSnapshot: {} }, overseer: null, eventCount: 12, cause: { cause: "agent_schema_too_new" } },
      { id: 8, incidentKey: "crash_loop", status: "resolved", openedAt: "2026-09-06T12:00:00.000Z", resolvedAt: "2026-09-06T12:01:00.000Z", summary: null, overseer: null, eventCount: 3 },
    ]);
    const bundle = await collect(ctx, {
      getWatchdogStatus: () => status,
      incidentsDb: { listIncidents },
      bootReports: { readBootReports: () => ({ current: { bootId: "live:1", serverPhase: { verdict: ["state_schema_too_new"] } }, previous: [], incident: null, unreadable: [] }) },
      selfVersion: () => ({ version: "0.9.77", commit: null, bootCount: 1, firstBootAt: kNow, lastBootAt: kNow, previous: null }),
      readLogTail: () => "[alphaclaw] from the live writer\nignored\n[watchdog] ok\npartial-without-newline",
    });
    expect(bundle.mode).toBe("server");
    expect(bundle.sections.watchdog).toMatchObject({ source: "live", data: { lifecycle: "running", health: "degraded", degradedReason: "version_mismatch", repairAttempts: 2 } });
    expect(bundle.sections.watchdog.data).toMatchObject({
      readiness: "not_ready",
      readinessReason: "secrets",
      readinessStatus: "starting",
      readinessProbe: "ok",
    });
    expect(kWatchdogStatusFields).toEqual(expect.arrayContaining(["readiness", "readinessReason", "readinessStatus", "readinessProbe"]));
    expect(bundle.sections.watchdog.data.crashTimestamps).toBeUndefined();
    expect(bundle.sections.watchdog.data.recentEvents).toBeUndefined();
    expect(bundle.sections.openclaw.source).toBe("live");
    expect(bundle.sections.openclaw.data).toMatchObject({ installedVersion: kPin, pinnedVersion: kPin, installedDiverged: false });
    expect(listIncidents).toHaveBeenCalledWith({ limit: 3 });
    expect(bundle.sections.incidents.source).toBe("live");
    expect(bundle.sections.incidents.data.dbPath).toBeNull();
    expect(bundle.sections.incidents.data.incidents).toEqual([
      { id: 9, incidentKey: "version_mismatch", status: "open", openedAt: "2026-09-06T13:00:00.000Z", resolvedAt: null, cause: { cause: "agent_schema_too_new" }, eventCount: 12, summary: { trigger: "version_mismatch", severity: "critical" } },
      { id: 8, incidentKey: "crash_loop", status: "resolved", openedAt: "2026-09-06T12:00:00.000Z", resolvedAt: "2026-09-06T12:01:00.000Z", cause: null, eventCount: 3, summary: null },
    ]);
    expect(bundle.sections.bootReports.data.current.bootId).toBe("live:1");
    // A reader that predates the refused file yields the documented empty state.
    expect(bundle.sections.bootReports.data.refused).toBeNull();
    expect(bundle.summary.bootVerdict).toEqual(["state_schema_too_new"]);
    expect(bundle.sections.selfVersion.data.record.version).toBe("0.9.77");
    // readLogTail text: complete lines only, then the tag filter.
    expect(bundle.sections.logTail.data).toMatchObject({ path: "readLogTail", scannedLines: 3, matchedLines: 2, lines: ["[alphaclaw] from the live writer", "[watchdog] ok"], truncated: false });
    const md = renderDiagnoseMarkdown(bundle);
    expect(md).toContain("- mode: server (live sections from the running server)");
    expect(md).toContain("## Watchdog (live)");
    expect(md).toContain("- degradedSince: 2026-09-06T13:00:00.000Z");
    expect(md).toContain("- current boot verdict: INCONSISTENT — `state_schema_too_new`");
  });
});

describe("diagnose: state dir, log bounds and env-file seams", () => {
  let ctx;
  afterEach(() => {
    if (ctx) fs.rmSync(ctx.rootDir, { recursive: true, force: true });
    ctx = null;
  });

  it("honours OPENCLAW_STATE_DIR from the injected env", async () => {
    ctx = createRoot();
    const otherDir = path.join(ctx.rootDir, "elsewhere");
    writeDb(path.join(otherDir, "state", "openclaw.sqlite"), 12);
    writeDb(path.join(ctx.openclawDir, "state", "openclaw.sqlite"), 15); // must be ignored
    const bundle = await collect(ctx, { env: { OPENCLAW_STATE_DIR: `  ${otherDir}  ` } });
    expect(bundle.paths.stateDir).toBe(otherDir);
    expect(bundle.sections.stateDb.data).toMatchObject({ stateDir: otherDir, stateDirFromEnv: true });
    expect(bundle.sections.stateDb.data.entries.map((e) => e.userVersion)).toEqual([12]);
    expect(resolveStateDir({ env: {}, openclawDir: "/x/.openclaw" })).toBe("/x/.openclaw");
    expect(resolveStateDir({ env: { OPENCLAW_STATE_DIR: "relative/dir" }, openclawDir: "/x" })).toBe(path.resolve("relative/dir"));
    expect(resolveStateDir({ env: { OPENCLAW_STATE_DIR: "~/sub" }, openclawDir: "/x" })).toBe(path.join(os.homedir(), "sub"));
  });

  it("tailLines bounds the kept lines to the LAST n matches and flags truncation", async () => {
    ctx = createRoot();
    populate(ctx);
    const bundle = await collect(ctx, { tailLines: 5 });
    const { data } = bundle.sections.logTail;
    expect(data.matchedLines).toBe(253);
    expect(data.lines).toHaveLength(5);
    expect(data.truncated).toBe(true);
    expect(data.lines.at(-1)).toBe("[openclaw-channel] boot sync: none");
    expect(data.lines[0]).toBe("[alphaclaw] boot line 248");
  });

  it("envFileVars passed by the caller (readEnvFile()) drive redaction even when no .env is on the root", async () => {
    ctx = createRoot();
    fs.mkdirSync(path.join(ctx.rootDir, "logs"), { recursive: true });
    fs.writeFileSync(path.join(ctx.rootDir, "logs", "process.log"), "[gateway] handed-secret-value-1234 leaked\n");
    const bundle = await collect(ctx, { envFileVars: [{ key: "ANYTHING", value: "handed-secret-value-1234" }] });
    expect(bundle.sections.logTail.data.lines).toEqual(["[gateway] *** leaked"]);
  });

  it("a plain object works as the bootReports seam (the server hands the reports it already read)", async () => {
    ctx = createRoot();
    const bundle = await collect(ctx, { bootReports: { current: null, previous: [{ bootId: "p:1" }], incident: null, unreadable: ["boot-report.2.json"] } });
    expect(bundle.sections.bootReports.data.previous).toEqual([{ bootId: "p:1" }]);
    expect(bundle.sections.bootReports.warnings).toEqual(["boot-report.2.json is unreadable (corrupt JSON)"]);
  });
});

describe("diagnose: render helpers", () => {
  it("iso() normalizes ms epochs, ISO strings and dates to UTC ISO, and never invents a time", () => {
    expect(iso(kNow)).toBe("2023-11-14T22:13:20.000Z");
    expect(iso("2026-09-06T13:00:00.000Z")).toBe("2026-09-06T13:00:00.000Z");
    expect(iso("2026-09-06T13:00:00Z")).toBe("2026-09-06T13:00:00Z");
    expect(iso(new Date(kNow))).toBe("2023-11-14T22:13:20.000Z");
    expect(iso(null)).toBe("n/a");
    expect(iso(undefined)).toBe("n/a");
    expect(iso(0)).toBe("n/a");
    expect(iso("not a date")).toBe("not a date");
    expect(iso({})).toBe("n/a");
  });

  it("renders an unknown section and a renderer failure without throwing", () => {
    const md = renderDiagnoseMarkdown({
      schema: kDiagnoseSchema,
      generatedAtMs: kNow,
      sections: {
        mystery: { source: "disk", reason: null, warnings: ["odd"], data: { a: 1 } },
        stateDb: { source: "disk", reason: null, warnings: [], data: { entries: "not-an-array" } },
        watchdog: null,
      },
    });
    expect(md).toContain("## mystery (disk)");
    expect(md).toContain('"a": 1');
    expect(md).toContain("> ⚠ odd");
    expect(md).toContain("## Watchdog (unavailable)\n_Unavailable: no section_");
    expect(md).toContain("## State databases (disk)");
    expect(md).toContain("- generated: 2023-11-14T22:13:20.000Z");
  });

  it("boot-report versions follow describeReportVersions: the bin phase's pin/installed, else the server phase's own read, n/a when nothing is known", () => {
    const report = (bootId, openclaw, serverPhase = { status: "recorded", verdict: [] }) => ({ bootId, at: kNow, openclaw, serverPhase });
    const md = renderDiagnoseMarkdown({
      sections: {
        bootReports: {
          source: "disk",
          warnings: [],
          data: {
            current: report("50:1", { declaredPin: "2026.9.2", installedAtBoot: "2026.9.2", installedDiverged: false }),
            previous: [
              // No bin phase (the server phase created the report): its own read counts.
              report("49:1", null, { status: "recorded", verdict: [], installedVersion: "2026.9.1", expectedVersion: "2026.9.2" }),
              report("48:1", { declaredPin: "2026.9.2", installedAtBoot: "2026.8.2" }),
              // Nothing known at all.
              report("47:1", {}),
            ],
            incident: null,
            refused: null,
            unreadable: [],
            verdict: [],
          },
        },
      },
    });
    expect(md).toContain("- openclaw: pin 2026.9.2, installed 2026.9.2, diverged false");
    expect(md).toContain("openclaw pin 2026.9.2 / installed 2026.9.1; guard n/a");
    expect(md).toContain("openclaw pin 2026.9.2 / installed 2026.8.2; guard n/a");
    expect(md).toContain("openclaw pin n/a / installed n/a; guard n/a");
    expect(md).toContain("- none (no start has been refused for a corroborated live owner)");
  });
});
