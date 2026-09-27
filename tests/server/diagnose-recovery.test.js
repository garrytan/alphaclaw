const { projectDatabaseEvidence, buildRecoverySummary } = require("../../lib/server/diagnose/recovery-summary");
const { renderDiagnoseMarkdown } = require("../../lib/server/diagnose/render");
const { collectDiagnose } = require("../../lib/server/diagnose/collect");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync, spawnSync } = require("node:child_process");

const now = Date.parse("2026-09-27T12:00:00.000Z");
const stateDir = "/data/.openclaw";
const assess = (overrides = {}) => ({
  observedAt: new Date(now).toISOString(), complete: true, compatible: true, migrationRequired: false, reasons: [],
  inventory: { databaseSetComplete: true, configPresent: true, files: [], dbs: [{ sourcePath: `${stateDir}/state/openclaw.sqlite` }], skipped: [] },
  perDb: [{ sourcePath: `${stateDir}/state/openclaw.sqlite`, dbKind: "state", bytes: 4096, userVersion: 17,
    compatible: true, migrationRequired: false, reasons: [], status: "ok" }], ...overrides,
});
const project = (assessment, extraSections = {}) => {
  const data = projectDatabaseEvidence({ assessment, stateDir });
  const sections = { stateDb: { source: "disk", data }, ...extraSections };
  return { data, summary: buildRecoverySummary({ assessment, sections, generatedAtMs: now }), sections };
};

describe("diagnostic recovery evidence", () => {
  it("still redacts values from regular config and env files selected through symlinks", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-diagnose-redaction-"));
    try {
      fs.mkdirSync(path.join(root, ".openclaw"));
      const configSecret = "private-config-value-example";
      const envSecret = "private-env-value-example";
      fs.writeFileSync(path.join(root, "config-source.json"), JSON.stringify({ gateway: { auth: { token: configSecret } } }));
      fs.writeFileSync(path.join(root, "env-source"), `SERVICE_TOKEN=${envSecret}\n`);
      fs.symlinkSync(path.join(root, "config-source.json"), path.join(root, ".openclaw/openclaw.json"));
      fs.symlinkSync(path.join(root, "env-source"), path.join(root, ".env"));
      const bundle = await collectDiagnose({ rootDir: root, env: {},
        readLogTail: () => `[alphaclaw] ${configSecret} ${envSecret}\n`,
        assessRecovery: async () => ({ complete: false, reasons: ["RECOVERY_ASSESSMENT_FAILED"] }),
      });
      expect(JSON.stringify(bundle)).not.toContain(configSecret);
      expect(JSON.stringify(bundle)).not.toContain(envSecret);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([".openclaw/openclaw.json", ".env"])("refuses a FIFO redaction source without hanging collection: %s", (file) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-diagnose-fifo-"));
    try {
      fs.mkdirSync(path.join(root, ".openclaw"));
      execFileSync("mkfifo", [path.join(root, file)]);
      const script = `require(${JSON.stringify(require.resolve("../../lib/server/diagnose/collect"))}).collectDiagnose({rootDir:${JSON.stringify(root)},env:{},assessRecovery:async()=>({complete:false,reasons:['RECOVERY_ASSESSMENT_FAILED']})}).then(bundle=>console.log(JSON.stringify(bundle.summary.recovery)));`;
      const result = spawnSync(process.execPath, ["-e", script], { timeout: 3000, encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ assessment: "unavailable", databaseVerdict: "not_assessed" });
      expect(fs.lstatSync(path.join(root, file)).isFIFO()).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("separates a compatible database observation from unknown gateway readiness", () => {
    const { summary } = project(assess());
    expect(summary).toMatchObject({ installationEvidence: "present", assessment: "complete",
      databaseVerdict: "compatible", gatewayReadiness: "unknown", originalHold: null });
    expect(summary.nextActions.map((action) => action.id)).toEqual(["refresh_status"]);
  });

  it("requires a fresh live healthy and ready observation, never a disk snapshot", () => {
    const status = { health: "healthy", readiness: "ready", lastHealthCheckAt: new Date(now).toISOString() };
    expect(project(assess(), { watchdog: { source: "live", data: status } }).summary).toMatchObject({
      gatewayReadiness: "ready", nextActions: [], readinessObservedAt: new Date(now).toISOString(),
    });
    expect(project(assess(), { watchdog: { source: "disk", data: status } }).summary.gatewayReadiness).toBe("unknown");
    expect(project(assess(), { watchdog: { source: "live", data: { ...status, lastHealthCheckAt: new Date(now - 60000).toISOString() } } }).summary.gatewayReadiness).toBe("unknown");
    expect(project(assess(), { watchdog: { source: "live", data: { ...status, replacementPending: {} } } }).summary.gatewayReadiness).toBe("unknown");
  });

  it("does not call a positively empty root or a config-only installation compatible", () => {
    const empty = assess({ perDb: [], inventory: { databaseSetComplete: true, configPresent: false, dbs: [], files: [] } });
    const absent = project(empty).summary;
    expect(absent).toMatchObject({ installationEvidence: "absent", assessment: "complete", databaseVerdict: "not_assessed" });
    expect(absent.reasonCodes).toContain("no_installation_evidence");
    expect(absent.nextActions[0].id).toBe("choose_explicit_root");
    const configOnly = project({ ...empty, inventory: { ...empty.inventory, configPresent: true } }).summary;
    expect(configOnly).toMatchObject({ installationEvidence: "present", databaseVerdict: "not_assessed" });
  });

  it("keeps a definite corrupt finding visible alongside incomplete discovery", () => {
    const value = assess({ complete: false, compatible: null, reasons: ["SQLITE_NOTADB"],
      perDb: [{ sourcePath: `${stateDir}/agents/main/agent/broken.sqlite`, dbKind: "agent", agentId: "main", compatible: null, status: "corrupt", reasons: ["SQLITE_NOTADB"] }] });
    const { data, summary } = project(value);
    expect(summary).toMatchObject({ assessment: "partial", databaseVerdict: "blocked" });
    expect(data.findings).toHaveLength(2);
    expect(data.findings[0]).toMatchObject({ path: "agents/main/agent/broken.sqlite", code: "SQLITE_NOTADB" });
    expect(data.entries.find((entry) => entry.path.endsWith("state/openclaw.sqlite"))).toMatchObject({
      status: "not_assessed", userVersion: null,
    });
  });

  it("keeps unavailable reads unknown rather than guessing that the root is empty", () => {
    const { summary } = project({ complete: false, inventory: null, perDb: [], reasons: ["EACCES"] });
    expect(summary).toMatchObject({ installationEvidence: "unknown", assessment: "unavailable", databaseVerdict: "not_assessed" });
    expect(summary.nextActions[0].id).toBe("inspect_access");
  });

  it("distinguishes current corrected evidence from the original historical hold", () => {
    const { summary } = project(assess(), { channelState: { data: { gatewayHold: { reason: "state_db_unverified", at: now - 60000, bootId: "boot-1" } } } });
    expect(summary.databaseVerdict).toBe("compatible");
    expect(summary.originalHold).toEqual({ reason: "state_db_unverified", observedAt: new Date(now - 60000).toISOString(), identity: "boot-1" });
    expect(summary.nextActions.length).toBeGreaterThan(0);
  });

  it("does not put excluded artifacts in the database rows or erase migration protection", () => {
    const value = assess({ migrationRequired: true });
    value.inventory.skipped = [{ sourcePath: `${stateDir}/agents/main/agent/openclaw-agent.sqlite.generation-lock.sqlite`, kind: "openclaw-transient-lock", reason: "proven coordination artifact" }];
    const { data, summary } = project(value);
    expect(data.entries).toHaveLength(1);
    expect(data.excludedArtifacts).toEqual([{ path: "agents/main/agent/openclaw-agent.sqlite.generation-lock.sqlite", kind: "openclaw-transient-lock", reason: "proven coordination artifact" }]);
    expect(summary.reasonCodes).toContain("recovery_choice_required");
    expect(summary.nextActions.some((action) => action.id === "open_protection_choice")).toBe(true);
  });

  it("keeps pending recovery as installation evidence when the original root disappears", () => {
    const { summary } = project({ complete: false, inventory: null, perDb: [], notAssessed: true,
      installationEvidence: "absent", reasons: ["RECOVERY_STATE_ROOT_MISSING"] }, {
      channelState: { data: { databaseRecoveryPending: { recoveryId: "unfinished-verification", at: now - 60000 } } },
      watchdog: { source: "live", data: { health: "healthy", readiness: "ready", lastHealthCheckAt: new Date(now).toISOString() } },
    });
    expect(summary).toMatchObject({ installationEvidence: "present", assessment: "unavailable", gatewayReadiness: "unknown" });
    expect(summary.reasonCodes).toContain("database_recovery_pending");
    expect(summary.reasonCodes).not.toContain("no_installation_evidence");
  });

  it("does not label an unreadable installation record as absent", () => {
    const { summary } = project(assess({ perDb: [], inventory: { databaseSetComplete: true, configPresent: false, dbs: [], files: [] } }), {
      channelState: { data: { stateCorrupted: true } },
    });
    expect(summary.installationEvidence).toBe("present");
    expect(summary.reasonCodes).toContain("gateway_hold_unreadable");
    expect(summary.reasonCodes).not.toContain("no_installation_evidence");
  });

  it("marks truncated evidence partial rather than certifying coverage", () => {
    const value = assess();
    value.inventory.skipped = Array.from({ length: 4097 }, (_, i) => ({ sourcePath: `${stateDir}/tmp-${i}`, kind: "transient" }));
    const { data, summary } = project(value);
    expect(data.truncated).toBe(true);
    expect(data.excludedArtifacts).toHaveLength(4096);
    expect(summary.assessment).toBe("partial");
    expect(summary.databaseVerdict).toBe("not_assessed");
  });

  it("renders current findings, historical holds and exclusions with matching semantics", () => {
    const assessment = assess({ complete: false, compatible: null, reasons: ["SQLITE_NOTADB"],
      perDb: [{ sourcePath: `${stateDir}/broken.sqlite`, compatible: null, status: "corrupt", reasons: ["SQLITE_NOTADB"] }] });
    assessment.inventory.skipped = [{ sourcePath: `${stateDir}/openclaw-agent.sqlite.reindex-lock.sqlite`, kind: "transient-sqlite-artifact", reason: "verified coordination lock" }];
    const { summary, sections } = project(assessment, { channelState: { data: { gatewayHold: { reason: "state_db_unverified", at: now - 60000 } } } });
    const markdown = renderDiagnoseMarkdown({ summary: { recovery: summary }, sections, paths: { rootDir: "/data", rootSource: "cli" } });
    expect(markdown).toContain("selected by cli");
    expect(markdown).toContain("assessment: partial");
    expect(markdown).toContain("database verdict: blocked");
    expect(markdown).toContain("original hold (historical)");
    expect(markdown).toContain("### Current database findings");
    expect(markdown).toContain("### Excluded artifacts (not databases or backup coverage)");
    expect(markdown).toContain("does not certify readiness, clear a hold or authorize a restart");
  });

  it("preserves relative context when a logical state root resolves to another directory", () => {
    const assessment = assess({ compatible: null, reasons: ["SQLITE_BUSY"],
      perDb: [{ sourcePath: "/physical/state/agents/a/agent/db.sqlite", compatible: null, status: "busy", reasons: ["SQLITE_BUSY"] }] });
    assessment.inventory.stateDir = "/physical/state";
    assessment.inventory.dbs = [];
    const { data } = project(assessment);
    expect(data.findings[0].path).toBe("agents/a/agent/db.sqlite");
  });
});
