const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { DatabaseSync } = require("node:sqlite");
const { assessRecoveryState, createRecoveryAssessor, runAssessmentInProcess } = require("../../lib/server/openclaw-recovery-assessment");
const { pinnedBuild, copyPinnedBuild } = require("../fixtures/sqlite-artifact-build");

describe("bounded recovery assessment", () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-assessment-")); });
  afterEach(() => { vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });
  const options = () => ({ stateDir: root, spawnEnv: {}, executingBuild: pinnedBuild });
  const fakeWorker = () => {
    const child = new EventEmitter();
    child.pid = 1234;
    child.kill = vi.fn();
    child.send = vi.fn();
    return child;
  };
  const database = (file = "state/openclaw.sqlite") => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    const db = new DatabaseSync(path.join(root, file));
    db.exec("PRAGMA user_version=19; CREATE TABLE schema_meta(meta_key TEXT,role TEXT,schema_version INTEGER,agent_id TEXT); INSERT INTO schema_meta VALUES('primary','global',19,NULL)");
    db.close();
  };

  it("uses one child for discovery, registry, schema resolution and inspection", async () => {
    database();
    fs.writeFileSync(path.join(root, "state/main.sqlite.generation-lock.sqlite"), "scratch");
    const result = await assessRecoveryState(options());
    expect(result).toMatchObject({ compatible: true, migrationRequired: false, assessment: "complete", complete: true, installationEvidence: "present",
      supported: { state: 19, agent: 24, source: { state: "declared", agent: "declared" }, declared: { metadata: "valid" }, table: { installedEntry: { state: 19, agent: 24 } } } });
    expect(result.excludedArtifacts).toHaveLength(1);
    expect(result.inventory).toMatchObject({ rootIdentity: { ino: expect.any(Number) }, dbs: [expect.objectContaining({ archivePath: "state/openclaw.sqlite", sourceIdentity: { dev: expect.any(Number), ino: expect.any(Number) } })] });
    expect(Date.parse(result.observedAt)).not.toBeNaN();
  });

  it("preserves explicit invalid declarations over seeded schemas", async () => {
    database();
    const build = copyPinnedBuild(path.join(root, "build"));
    fs.writeFileSync(path.join(build.packageDir, "package.json"), JSON.stringify({ version: build.version, openclaw: { schemaVersions: { state: "bad", agent: 21 } } }));
    const result = await assessRecoveryState({ ...options(), executingBuild: build });
    expect(result.supported).toMatchObject({ state: null, agent: null, unknownKinds: ["state", "agent"] });
    expect(result.compatible).toBeNull();
    expect(result.reasons).toContain("unsupported_target_schema_contract");
  });

  it.each([false, true])("qualifies artifact provenance from the actual producer, not the target (qualified producer: %s)", async (qualifiedProducer) => {
    database();
    const scratch = path.join(root, "state/main.sqlite.generation-lock.sqlite");
    fs.writeFileSync(scratch, "scratch owned by the executing producer");
    const executingBuild = qualifiedProducer ? pinnedBuild : { ...pinnedBuild, source: "dev", buildId: "unqualified-producer", schemas: { state: 99, agent: 99 } };
    const targetBuild = qualifiedProducer ? copyPinnedBuild(path.join(root, "target"), "dev") : pinnedBuild;
    const result = await assessRecoveryState({ ...options(), executingBuild, targetBuild });
    expect(result.executingBuild).toEqual(executingBuild);
    expect(result.targetBuild).toEqual(targetBuild);
    expect(result.inventory.executingBuild).toEqual(executingBuild);
    expect(result.supported).toMatchObject({ state: 19, agent: 24 });
    expect(result.compatible).toBe(qualifiedProducer ? true : null);
    expect(result.excludedArtifacts).toHaveLength(qualifiedProducer ? 1 : 0);
    if (!qualifiedProducer) expect(result.reasons).toContain("unsupported_transient_artifact_contract");
    expect(fs.readFileSync(scratch, "utf8")).toBe("scratch owned by the executing producer");
  });

  it("judges target schema compatibility independently of the qualified producer's schemas", async () => {
    database();
    fs.writeFileSync(path.join(root, "state/main.sqlite.generation-lock.sqlite"), "scratch");
    const targetBuild = copyPinnedBuild(path.join(root, "target"), "dev");
    fs.writeFileSync(path.join(targetBuild.packageDir, "package.json"), JSON.stringify({ version: targetBuild.version, openclaw: { schemaVersions: { state: 16, agent: 21 } } }));
    const result = await assessRecoveryState({ ...options(), executingBuild: { ...pinnedBuild, schemas: { state: 19, agent: 24 } }, targetBuild });
    expect(result.excludedArtifacts).toHaveLength(1);
    expect(result.supported.state).toBe(16);
    expect(result).toMatchObject({ compatible: false, reasons: ["database_schema_newer_than_target"] });
  });

  it("returns partial inventory and corruption evidence without losing the original database baseline", async () => {
    fs.mkdirSync(path.join(root, "state"));
    fs.writeFileSync(path.join(root, "state/openclaw.sqlite"), "corrupt");
    const result = await assessRecoveryState(options());
    expect(result).toMatchObject({ compatible: null, complete: false, assessment: "partial", installationEvidence: "present",
      inventory: { databaseSetComplete: false, dbs: [expect.objectContaining({ archivePath: "state/openclaw.sqlite" })] },
      perDb: [expect.objectContaining({ status: "corrupt", reasons: ["SQLITE_NOTADB"] })] });
  });

  it("distinguishes absent, empty and config-only roots without creating paths", async () => {
    expect(await assessRecoveryState({ ...options(), stateDir: path.join(root, "missing") })).toMatchObject({ compatible: null, assessment: "unavailable", installationEvidence: "absent" });
    expect(fs.existsSync(path.join(root, "missing"))).toBe(false);
    expect(await assessRecoveryState(options())).toMatchObject({ compatible: true, complete: true, installationEvidence: "absent" });
    fs.writeFileSync(path.join(root, "openclaw.json"), "{}");
    expect(await assessRecoveryState(options())).toMatchObject({ compatible: true, complete: true, installationEvidence: "present" });
  });

  it("refuses a FIFO schema table promptly and retains the declared-schema fallback", async () => {
    database();
    const managed = path.join(root, ".alphaclaw");
    fs.mkdirSync(managed);
    const file = path.join(managed, "openclaw-schema-versions.json");
    require("child_process").execFileSync("mkfifo", [file]);
    const result = await assessRecoveryState({ ...options(), timeoutMs: 2000 });
    expect(result).toMatchObject({ compatible: true, assessment: "complete", supported: { source: { state: "declared", agent: "declared" }, table: { origin: "unreadable" } } });
    expect(fs.lstatSync(file).isFIFO()).toBe(true);
  });

  it("coalesces sixteen observers, refuses overflow and different keys, and reserves lifecycle capacity", async () => {
    const children = [];
    const forkFn = vi.fn(() => { const child = fakeWorker(); children.push(child); return child; });
    const assess = createRecoveryAssessor({ forkFn });
    const observers = Array.from({ length: 16 }, () => assess(options()));
    expect(forkFn).toHaveBeenCalledTimes(1);
    expect(await assess(options())).toMatchObject({ reasons: ["RECOVERY_ASSESSMENT_BUSY"] });
    expect(await assess({ ...options(), stateDir: `${root}/other` })).toMatchObject({ reasons: ["RECOVERY_ASSESSMENT_BUSY"] });
    expect(await assess({ ...options(), targetBuild: { ...pinnedBuild, buildId: "different-target" } })).toMatchObject({ reasons: ["RECOVERY_ASSESSMENT_BUSY"] });
    const lifecycle = assess({ ...options(), mode: "lifecycle" });
    expect(forkFn).toHaveBeenCalledTimes(2);
    expect(await assess({ ...options(), mode: "lifecycle" })).toMatchObject({ reasons: ["RECOVERY_ASSESSMENT_BUSY"] });
    for (const child of children) { child.emit("message", { compatible: true, assessment: "complete" }); child.emit("exit", 0); }
    expect((await Promise.all([...observers, lifecycle])).every((result) => result.compatible)).toBe(true);
    const next = assess(options());
    expect(forkFn).toHaveBeenCalledTimes(3);
    children[2].emit("exit", 1);
    expect(await next).toMatchObject({ reasons: ["RECOVERY_WORKER_EXIT"] });
  });

  it("detaches one aborted observer without cancelling another observer or a lifecycle attempt", async () => {
    const children = [];
    const assess = createRecoveryAssessor({ forkFn: () => { const child = fakeWorker(); children.push(child); return child; } });
    const abort = new AbortController();
    const first = assess({ ...options(), signal: abort.signal });
    const second = assess(options());
    const lifecycle = assess({ ...options(), mode: "lifecycle" });
    abort.abort();
    expect(await first).toMatchObject({ reasons: ["RECOVERY_ASSESSMENT_ABORTED"] });
    expect(children.every((child) => child.kill.mock.calls.length === 0)).toBe(true);
    children.forEach((child) => child.emit("exit", 1));
    await Promise.all([second, lifecycle]);
  });

  it("keeps a killed but unexited worker's slot occupied and never grants stale success", async () => {
    vi.useFakeTimers();
    const child = fakeWorker();
    const forkFn = vi.fn(() => child);
    const assess = createRecoveryAssessor({ forkFn });
    const pending = assess(options());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({ compatible: null, reasons: ["RECOVERY_PROBE_TIMEOUT"] });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(await assess(options())).toMatchObject({ reasons: ["RECOVERY_ASSESSMENT_BUSY"] });
    expect(forkFn).toHaveBeenCalledTimes(1);
    child.emit("exit", null, "SIGKILL");
  });

  it("bounds a real worker with a tiny aggregate deadline and refuses pre-aborted work", async () => {
    expect(await assessRecoveryState({ ...options(), timeoutMs: 1 })).toMatchObject({ compatible: null, complete: false });
    const abort = new AbortController();
    abort.abort();
    expect(await assessRecoveryState({ ...options(), signal: abort.signal })).toMatchObject({ reasons: ["RECOVERY_ASSESSMENT_ABORTED"] });
    expect(() => assessRecoveryState({ stateDir: root, mode: "cached" })).toThrow(TypeError);
  });

  it("keeps the event loop responsive while killing synchronous work at the aggregate deadline", async () => {
    const script = path.join(root, "blocked-worker.js");
    fs.writeFileSync(script, "process.on('message', () => { while (true) {} });");
    let child;
    const assess = createRecoveryAssessor({ forkFn: () => {
      child = require("child_process").fork(script, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      return child;
    } });
    let responsive = false;
    const heartbeat = setTimeout(() => { responsive = true; }, 10);
    const result = await assess({ ...options(), timeoutMs: 200 });
    clearTimeout(heartbeat);
    expect(responsive).toBe(true);
    expect(result.compatible).toBeNull();
    await new Promise((resolve) => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", resolve));
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("resolves CLI overlay execution inside the worker instead of choosing the dormant install", async () => {
    const overlay = copyPinnedBuild(path.join(root, `openclaw-overlay/${pinnedBuild.version}/node_modules/openclaw`), "overlay");
    fs.writeFileSync(path.join(overlay.packageDir, "openclaw.mjs"), "");
    const stateDir = path.join(root, ".openclaw");
    fs.mkdirSync(path.join(stateDir, ".alphaclaw/bin"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, ".alphaclaw/bin/openclaw"), `#!/bin/sh\nexec node "${overlay.packageDir}/openclaw.mjs" "$@"\n`);
    const result = await runAssessmentInProcess({ stateDir, rootDir: root, openclawDir: stateDir, installDir: root, spawnEnv: {} });
    expect(result.executingBuild).toMatchObject({ packageDir: overlay.packageDir, source: "overlay", version: pinnedBuild.version });
  });
});
