const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRequire } = require("module");
const { DatabaseSync } = require("node:sqlite");
const { createOpenclawReleaseChannelStore } = require("../../lib/server/openclaw-release-channel");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createRepairOperation, kRepairKillGraceMs } = require("../../lib/server/repair-operation");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");
const { processGroupHasWriters } = require("../../lib/server/process-group");

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const loadService = (afterDoctor) => {
  const file = require.resolve("../../lib/server/openclaw-channel-sync");
  const nativeRequire = createRequire(file);
  const customRequire = (name) => {
    if (name !== "./doctor-guard") return nativeRequire(name);
    const { createDoctorGuard } = nativeRequire(name);
    return { createDoctorGuard: (options) => {
      const guard = createDoctorGuard(options);
      return { ...guard, withDoctorRestoreGuard: async (input) => {
        const result = await guard.withDoctorRestoreGuard(input);
        await afterDoctor();
        return result;
      } };
    } };
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", "__filename", "__dirname", fs.readFileSync(file, "utf8"))(
    customRequire, module, module.exports, file, path.dirname(file));
  return module.exports.createOpenclawChannelSync;
};

describe("native reconciliation cleanup owns validation and the full Doctor guard", () => {
  it.each(["validate", "doctor"])("drains the real %s process group before admitting a successor", async (kind) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-cleanup-"));
    const openclawDir = path.join(root, ".openclaw");
    const packageDir = path.join(root, "node_modules", "openclaw");
    const ready = path.join(root, "writer-ready");
    const cleaned = path.join(root, "restore-cleaned");
    const guardReached = deferred();
    const guardMayFinish = deferred();
    const logger = { log() {}, warn() {}, error() {} };
    fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
    fs.mkdirSync(path.join(packageDir, "dist", "extensions"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { openclaw: "2026.9.5" } }));
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.9.5", bin: "openclaw.mjs",
      openclaw: { schemaVersions: { state: 17, agent: 21 } } }));
    fs.writeFileSync(path.join(packageDir, "openclaw.mjs"), 'console.log("2026.9.5")');
    fs.writeFileSync(path.join(packageDir, "dist", "thinking-levels.js"), "exports.listThinkingLevelOptions = () => [];");
    fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}");
    fs.writeFileSync(path.join(openclawDir, "openclaw.json.last-good"), '{"original":true}');
    const db = new DatabaseSync(path.join(openclawDir, "state", "openclaw.sqlite"));
    db.exec("PRAGMA user_version=17; CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT); INSERT INTO schema_meta VALUES('primary','global',17,NULL)");
    db.close();
    const store = createOpenclawReleaseChannelStore({ rootDir: root, openclawDir, logger });
    store.writeSentinel({ installDir: root, version: "2026.9.5" });
    const lock = createGatewayLifecycleLock({ logger });
    let hold;
    const operation = createRepairOperation({ isCurrent: () => hold?.isValid() === true });
    hold = await lock.acquire("boot", { leaseMs: 30_000, cleanup: operation.cleanup });
    operation.start(20_000);
    const nativeRunner = createRunStream();
    const commands = [];
    let pid;
    let reconcile;
    let cleanup;
    let successor;
    try {
      const createService = loadService(async () => {
        guardReached.resolve();
        await guardMayFinish.promise;
        fs.writeFileSync(cleaned, "complete restore guard");
      });
      const sync = createService({ rootDir: root, openclawDir, packageRoot: root, store, logger,
        resolveInstallDir: () => root, isOnboarded: () => true,
        openclawSpawnEnv: () => ({ OPENCLAW_STATE_DIR: openclawDir, PATH: process.env.PATH }),
        gatewayQuiesce: { isRunning: async () => false }, backupsDir: path.join(root, "backups"),
        runStream: { runStreamed: async (spec) => {
          commands.push(spec);
          const selected = kind === "validate" ? spec.args.includes("validate") : spec.args.includes("doctor");
          if (!selected) return { ok: false, tail: "Invalid config" };
          expect(spec.signal).toBe(operation.signal);
          expect(spec.deadlineAt).toBe(operation.deadlineAt);
          expect(spec.killGraceMs).toBe(kRepairKillGraceMs);
          const script = `process.on('SIGTERM',()=>{});const child=require('child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,child:child.pid}));setInterval(()=>{},1000);`;
          return nativeRunner.runStreamed({ ...spec, command: process.execPath, args: ["-e", script], onProcess: (event) => {
            spec.onProcess(event);
            if (event.pid) pid = event.pid;
          } });
        } },
      });
      reconcile = sync.reconcileBootConfig({ hold, operation });
      await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true), { timeout: 8000 });
      expect(processGroupHasWriters(pid)).toBe(true);
      expect(operation.cleanup.describe().processes.some((entry) => entry.pid === pid)).toBe(true);
      let cleanupFinished = false;
      cleanup = lock.cancelActiveCleanup("shutdown").then(() => { cleanupFinished = true; });
      expect(operation.signal.aborted).toBe(true);
      expect(lock.tryAcquire("successor")).toBeNull();
      await vi.waitFor(() => expect(processGroupHasWriters(pid)).toBe(false), { timeout: 5000 });
      if (kind === "doctor") {
        await guardReached.promise;
        expect(cleanupFinished).toBe(false);
        expect(lock.tryAcquire("successor")).toBeNull();
        expect(fs.existsSync(cleaned)).toBe(false);
        guardMayFinish.resolve();
      }
      await cleanup;
      expect(await reconcile).toMatchObject({ status: "held" });
      expect(commands.filter((spec) => spec.args.includes("doctor"))).toHaveLength(kind === "doctor" ? 1 : 0);
      if (kind === "doctor") {
        expect(fs.readFileSync(cleaned, "utf8")).toBe("complete restore guard");
        expect(fs.readFileSync(path.join(openclawDir, "openclaw.json.last-good"), "utf8")).toBe('{"original":true}');
      }
      expect(store.readState().gatewayHold).toBeNull();
      successor = lock.tryAcquire("successor");
      expect(successor).toBeTruthy();
      expect(processGroupHasWriters(pid)).toBe(false);
    } finally {
      guardMayFinish.resolve();
      operation.cancel("shutdown");
      if (pid) { try { process.kill(-pid, "SIGKILL"); } catch {} }
      await reconcile;
      await cleanup;
      operation.finishWork();
      await operation.cleanup.wait();
      await hold?.();
      await successor?.();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
