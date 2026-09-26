const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createOpenclawChannelSync } = require("../../lib/server/openclaw-channel-sync");
const { createOpenclawReleaseChannelStore } = require("../../lib/server/openclaw-release-channel");
const { createRunLedger } = require("../../lib/server/openclaw-run-ledger");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createGatewayMutationPolicy } = require("../../lib/server/gateway-mutation-policy");
const { readRecoveryCheckpoint } = require("../../lib/server/openclaw-recovery-checkpoint");
const { hasDatabaseRecoveryCoverage } = require("../../lib/server/openclaw-recovery-coverage");

let root;
let openclawDir;
let sync;
let store;
let ledger;
let gateway;
let running;
let handles;
let captureHook;
let runner;

const writePackage = (directory, version, schemas) => {
  fs.mkdirSync(path.join(directory, "dist", "extensions"), { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "openclaw", version, bin: "openclaw.mjs", openclaw: { schemaVersions: schemas } }));
  fs.writeFileSync(path.join(directory, "openclaw.mjs"), `console.log(${JSON.stringify(version)});`);
  fs.writeFileSync(path.join(directory, "dist", "thinking-levels.js"), "exports.listThinkingLevelOptions = () => [];");
  return directory;
};

const seedWal = (relative, version, role, agentId) => {
  const file = path.join(openclawDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=${version}; CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT); CREATE TABLE messages(body TEXT); INSERT INTO messages VALUES ('committed before snapshot')`);
  db.prepare("INSERT INTO schema_meta VALUES('primary',?,?,?)").run(role, version, agentId);
  handles.push({ db, file, relative });
  expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-wal-service-"));
  openclawDir = path.join(root, ".openclaw");
  fs.mkdirSync(openclawDir);
  fs.writeFileSync(path.join(openclawDir, "openclaw.json"), '{"agents":{"list":[{"id":"main"}]}}');
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { openclaw: "2026.8.2" } }));
  writePackage(path.join(root, "node_modules", "openclaw"), "2026.8.2", { state: 15, agent: 19 });
  handles = [];
  seedWal("state/openclaw.sqlite", 15, "global", null);
  seedWal("agents/main/agent/openclaw-agent.sqlite", 19, "agent", "main");
  captureHook = null;
  const logger = {
    log(message) {
      if (String(message).includes("apply step backup: completed")) captureHook?.();
    },
    warn() {}, error() {},
  };
  store = createOpenclawReleaseChannelStore({ rootDir: root, openclawDir, logger });
  store.writeSentinel({ installDir: root, version: "2026.8.2" });
  ledger = createRunLedger({ openclawDir });
  running = true;
  gateway = {
    isRunning: vi.fn(async () => running),
    probeReadiness: vi.fn(async () => ({ ok: running, kind: running ? "ready" : "not-ready", ready: running })),
    suppress: vi.fn(() => "wal-service-owner"),
    unsuppress: vi.fn(),
    stop: vi.fn(async () => { running = false; return true; }),
    start: vi.fn(async () => { running = true; }),
  };
  runner = vi.fn(async ({ command, args }) => {
    if (["tar", "gzip"].includes(command) || args?.includes("backup") || args?.includes("preflight")) throw new Error("Unexpected archive producer or database-copy preflight");
    if (args?.includes("--version")) {
      const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(args[0]), "package.json")));
      return { ok: true, tail: pkg.version };
    }
    return { ok: true, tail: "{}" };
  });
  const lock = createGatewayLifecycleLock({ logger });
  const policy = createGatewayMutationPolicy({ lock, getChannelInfo: () => sync?.getChannelInfo() || {}, isApplyInProgress: () => sync?.isApplyInProgress() || false });
  sync = createOpenclawChannelSync({
    rootDir: root, openclawDir, packageRoot: root, store, runLedger: ledger, logger,
    resolveInstallDir: () => root, isOnboarded: () => true,
    openclawSpawnEnv: () => ({ HOME: root, OPENCLAW_STATE_DIR: openclawDir, OPENCLAW_CONFIG_PATH: path.join(openclawDir, "openclaw.json") }),
    runStream: { runStreamed: runner }, gatewayQuiesce: gateway,
    acquireLifecycleLock: (kind, options) => lock.acquire(kind, options), gatewayMutationPolicy: policy,
    dbQuiet: async () => ({ release() {} }), dbResume: () => {},
    diskSpace: () => ({ ok: true, free: 100e9 }), backupsDir: path.join(root, "backups"),
    backupTuning: { postQuiesceReadyTimeoutMs: 100, postQuiescePollMs: 1 },
    installToTempDir: async ({ versionSpec }) => {
      const tmpDir = fs.mkdtempSync(path.join(root, "prepared-"));
      return { tmpDir, openclawPackageDir: writePackage(path.join(tmpDir, "node_modules", "openclaw"), versionSpec, { state: 17, agent: 21 }), cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
    },
  });
});
afterEach(() => {
  for (const { db } of handles) db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const apply = () => sync.applyUpdate({ channel: "stable", version: "2026.9.5", intent: "update", recoveryMode: "database_set" });

describe("real WAL database-set apply at the service boundary", () => {
  it.each([false, true])("accepts SQLite read-only WAL touches and hands off without old-gateway relaunch (RESERVED lock: %s)", async (reserved) => {
    if (reserved) handles[0].db.exec("BEGIN IMMEDIATE");
    const before = handles.map(({ file }) => ({ database: fs.readFileSync(file), wal: fs.readFileSync(`${file}-wal`), ctime: fs.statSync(`${file}-wal`).ctimeMs }));
    captureHook = () => {
      for (const { file } of handles) {
        const reader = new DatabaseSync(file, { readOnly: true });
        reader.prepare("PRAGMA user_version").get();
        reader.close();
        fs.chmodSync(`${file}-wal`, fs.statSync(`${file}-wal`).mode & 0o777);
      }
    };
    const response = await apply();
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    expect(response.body).toMatchObject({ restarting: true, recovery: { kind: "database_set", databases: { complete: true, verified: true } } });
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(gateway.start).not.toHaveBeenCalled();
    expect(running).toBe(false);
    const record = ledger.readRun(response.body.operationId);
    expect(record.state).toBe("restart_expected");
    expect(record.recoveryIntent.approved).toBe(true);
    expect(hasDatabaseRecoveryCoverage(record.recovery)).toBe(true);
    expect(record.recovery.databases.entries).toHaveLength(2);
    const verified = await readRecoveryCheckpoint(record.recovery.checkpoint.file, { operationId: record.operationId });
    for (const [index, { file, relative }] of handles.entries()) {
      expect(fs.readFileSync(file)).toEqual(before[index].database);
      expect(fs.readFileSync(`${file}-wal`)).toEqual(before[index].wal);
      expect(fs.statSync(`${file}-wal`).ctimeMs).toBeGreaterThan(before[index].ctime);
      const copy = new DatabaseSync(path.join(verified.file, "payload", relative), { readOnly: true });
      try {
        expect(copy.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
        expect(copy.prepare("SELECT body FROM messages").all()).toEqual([{ body: "committed before snapshot" }]);
      } finally { copy.close(); }
    }
    expect(runner.mock.calls.some(([call]) => call.command === "tar" || call.args?.includes("backup") || call.args?.includes("preflight"))).toBe(false);
    if (reserved) handles[0].db.exec("ROLLBACK");
  });

  it("refuses a real committed WAL write between snapshot publication and final apply admission", async () => {
    let changed = false;
    const before = fs.readFileSync(`${handles[0].file}-wal`);
    captureHook = () => {
      handles[0].db.exec("INSERT INTO messages VALUES ('foreign committed write after capture')");
      changed = true;
    };
    const response = await apply();
    expect(changed).toBe(true);
    expect(fs.readFileSync(`${handles[0].file}-wal`)).not.toEqual(before);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.code).toBe("apply_facts_changed");
    expect(store.readState().applied).toBeNull();
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(gateway.start).toHaveBeenCalledTimes(1);
    expect(running).toBe(true);
    const record = ledger.listRuns().find((entry) => entry.target.version === "2026.9.5");
    expect(record.state).toBe("failed");
    expect(record.recoveryIntent?.approved).not.toBe(true);
    expect(record.recovery.checkpoint.verified).toBe(true);
    const copy = new DatabaseSync(path.join(record.recovery.checkpoint.file, "payload/state/openclaw.sqlite"), { readOnly: true });
    try { expect(copy.prepare("SELECT body FROM messages").all()).toEqual([{ body: "committed before snapshot" }]); }
    finally { copy.close(); }
  });
});
