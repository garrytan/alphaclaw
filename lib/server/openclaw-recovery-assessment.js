const path = require("path");
const fs = require("fs");
const { fork } = require("child_process");
const { performance } = require("perf_hooks");
const { buildRecoveryInventory, inspectRecoveryDatabases } = require("./openclaw-recovery-plan");
const { resolveDeclaredSchemaVersions, createSchemaVersionTable } = require("./openclaw-schema-versions");

const unavailable = (reason, executingBuild, extra = {}) => ({
  ok: false, compatible: null, migrationRequired: null, perDb: [], byKind: {}, reasons: [reason],
  inventory: null, assessment: "unavailable", complete: false, installationEvidence: "unknown", observedAt: new Date().toISOString(), excludedArtifacts: [], executingBuild, ...extra,
});

const runAssessmentInProcess = async ({ stateDir, spawnEnv = {}, rootDir, openclawDir, installDir, executingBuild, targetBuild, supported = (targetBuild === undefined ? executingBuild : targetBuild)?.schemas, schemaManagedDir, timeoutMs = 10000 }) => {
  const deadline = performance.now() + Math.min(timeoutMs, 10000);
  const checkpoint = () => {
    if (performance.now() >= deadline) throw Object.assign(new Error("Recovery assessment deadline exceeded"), { code: "RECOVERY_ASSESSMENT_TIMEOUT" });
  };
  let inventory;
  try {
    checkpoint();
    try { fs.lstatSync(stateDir); }
    catch (error) {
      if (error.code === "ENOENT") return unavailable("RECOVERY_STATE_ROOT_MISSING", executingBuild, { targetBuild: targetBuild === undefined ? executingBuild : targetBuild, installationEvidence: "absent", notAssessed: true });
      throw error;
    }
    if (executingBuild === undefined && rootDir) {
      const { createOpenclawReleaseChannelStore } = require("./openclaw-release-channel");
      const store = createOpenclawReleaseChannelStore({ rootDir, openclawDir: openclawDir || stateDir, logger: { warn() {} } });
      executingBuild = require("./openclaw-build").describeExecutingBuild({ installDir,
        checkoutDir: spawnEnv.OPENCLAW_GIT_DIR || path.join(rootDir, "openclaw"), store });
      schemaManagedDir ||= store.managedDir;
      checkpoint();
    }
    const schemaBuild = targetBuild === undefined ? executingBuild : targetBuild;
    if (supported === undefined) {
      const declared = schemaBuild?.packageDir ? resolveDeclaredSchemaVersions(schemaBuild.packageDir) : null;
      checkpoint();
      const table = createSchemaVersionTable({ managedDir: schemaManagedDir || path.join(stateDir, ".alphaclaw"), logger: { warn() {} },
        fsModule: { readFileSync(file) {
          const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
          try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Schema table exceeds observation limits");
            const buffer = Buffer.alloc(stat.size + 1);
            const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
            const after = fs.fstatSync(fd);
            if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("Schema table changed during observation");
            return buffer.subarray(0, count).toString("utf8");
          } finally { fs.closeSync(fd); }
        } },
      });
      const learned = (schemaBuild?.version ? table.supportedFor(schemaBuild.version, { buildId: schemaBuild.buildId || schemaBuild.version }) : null) ?? {};
      const tableRead = table.read();
      supported = { state: null, agent: null, source: {}, declared,
        table: { path: table.filePath, origin: tableRead.origin, installedEntry: learned, byVersion: tableRead.byVersion } };
      for (const kind of ["state", "agent"]) {
        if (declared?.unknownKinds?.includes(kind)) {
          (supported.unknownKinds ||= []).push(kind);
          supported.source[kind] = null;
        } else if (declared?.[kind] != null) {
          supported[kind] = declared[kind];
          supported.source[kind] = "declared";
        } else {
          supported[kind] = learned[kind] ?? null;
          supported.source[kind] = learned[kind] == null ? null : learned.source;
          if (learned.unknownKinds?.includes(kind)) (supported.unknownKinds ||= []).push(kind);
        }
      }
    }
    const metadataWorker = (data) => { checkpoint(); return require("./openclaw-recovery-probe").runProbe(data); };
    inventory = await buildRecoveryInventory({ stateDir, spawnEnv, executingBuild, checkpoint, metadataWorker });
    checkpoint();
    const verdict = await inspectRecoveryDatabases({ inventory, supported, metadataWorker });
    checkpoint();
    const complete = inventory.databaseSetComplete === true && verdict.compatible !== null && verdict.migrationRequired !== null && verdict.perDb.every((entry) => entry.compatible !== null);
    return { ...verdict, inventory, supported, assessment: complete ? "complete" : "partial", complete,
      installationEvidence: inventory.configPresent || inventory.files.length || inventory.dbs.length ? "present" : "absent",
      observedAt: new Date().toISOString(), excludedArtifacts: inventory.excludedArtifacts, executingBuild, targetBuild: schemaBuild };
  } catch (error) {
    inventory ||= error.inventory;
    return unavailable(error.code || "RECOVERY_ASSESSMENT_FAILED", executingBuild, {
      inventory: inventory || null, supported, targetBuild: targetBuild === undefined ? executingBuild : targetBuild, assessment: inventory ? "partial" : "unavailable", excludedArtifacts: inventory?.excludedArtifacts || [],
      installationEvidence: inventory?.configPresent || inventory?.files.length || inventory?.dbs.length ? "present" : "unknown",
      ...(error.sourcePath ? { sourcePath: error.sourcePath, perDb: [{ sourcePath: error.sourcePath, path: error.sourcePath, compatible: null,
        migrationRequired: null, status: error.status || "unverified", reasons: [error.code || "RECOVERY_ASSESSMENT_FAILED"], error: { code: error.code, errcode: error.errcode, message: String(error.message).slice(0, 4096) } }] } : {}),
      error: { code: error.code, message: String(error.message).slice(0, 4096) },
    });
  }
};

const createRecoveryAssessor = ({ forkFn = fork } = {}) => {
  const slots = { observe: null, lifecycle: null };
  const assess = ({ stateDir, spawnEnv = process.env, rootDir, openclawDir, installDir, executingBuild, targetBuild, supported = (targetBuild === undefined ? executingBuild : targetBuild)?.schemas, schemaManagedDir, mode = "observe", timeoutMs = 10000, signal } = {}) => {
    if (typeof stateDir !== "string" || !stateDir || !["observe", "lifecycle"].includes(mode) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("Invalid recovery assessment options");
    const unavailableForRequest = (reason) => unavailable(reason, executingBuild, { targetBuild: targetBuild === undefined ? executingBuild : targetBuild });
    if (signal?.aborted) return Promise.resolve(unavailableForRequest("RECOVERY_ASSESSMENT_ABORTED"));
    const budget = Math.min(timeoutMs, 10000);
    const env = Object.fromEntries(["HOME", "USERPROFILE", "PREFIX", "ANDROID_DATA", "OPENCLAW_HOME", "OPENCLAW_GIT_DIR", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"].filter((key) => spawnEnv[key] !== undefined).map((key) => [key, spawnEnv[key]]));
    const key = JSON.stringify({ stateDir: path.resolve(stateDir), env, rootDir, openclawDir, installDir, executingBuild, targetBuild, supported, schemaManagedDir });
    let slot = slots[mode];
    if (slot && (mode === "lifecycle" || slot.key !== key || slot.stopping || slot.waiters.size >= 16)) return Promise.resolve(unavailableForRequest("RECOVERY_ASSESSMENT_BUSY"));
    if (!slot) {
      slot = { key, waiters: new Set(), stopping: false, child: null, timer: null, result: null };
      slots[mode] = slot;
    }
    return new Promise((resolve) => {
      const finish = (result) => {
        if (!slot.waiters.delete(finish)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(result);
      };
      const stop = () => {
        slot.stopping = true;
        slot.child?.kill("SIGKILL");
      };
      const detach = (reason) => {
        finish(unavailableForRequest(reason));
        if (!slot.waiters.size) stop();
      };
      const abort = () => detach("RECOVERY_ASSESSMENT_ABORTED");
      const timer = setTimeout(() => detach("RECOVERY_ASSESSMENT_TIMEOUT"), budget);
      slot.waiters.add(finish);
      signal?.addEventListener("abort", abort, { once: true });
      if (slot.child) return;
      const fail = (reason) => {
        for (const waiter of [...slot.waiters]) waiter(unavailableForRequest(reason));
        stop();
      };
      try {
        slot.child = forkFn(path.join(__dirname, "openclaw-recovery-probe.js"), [], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [], env: { PATH: process.env.PATH } });
        slot.timer = setTimeout(() => fail("RECOVERY_PROBE_TIMEOUT"), Math.min(budget, 5000));
        slot.child.once("message", (result) => {
          slot.result = result?.error && !result.assessment ? unavailableForRequest(result.code || "RECOVERY_ASSESSMENT_FAILED") : result;
          stop();
        });
        slot.child.once("exit", () => {
          clearTimeout(slot.timer);
          if (slots[mode] === slot) slots[mode] = null;
          for (const waiter of [...slot.waiters]) waiter(slot.result || unavailableForRequest("RECOVERY_WORKER_EXIT"));
        });
        slot.child.once("error", () => {
          fail("RECOVERY_WORKER_ERROR");
          if (!slot.child.pid) { clearTimeout(slot.timer); if (slots[mode] === slot) slots[mode] = null; }
        });
        slot.child.send({ mode: "assessment", options: { stateDir, spawnEnv: env, rootDir, openclawDir, installDir, executingBuild, targetBuild, supported, schemaManagedDir, timeoutMs: budget } }, (error) => { if (error) fail("RECOVERY_WORKER_ERROR"); });
      } catch {
        fail("RECOVERY_WORKER_ERROR");
        if (!slot.child?.pid && slots[mode] === slot) slots[mode] = null;
      }
    });
  };
  return assess;
};

const assessRecoveryState = createRecoveryAssessor();
module.exports = { assessRecoveryState, createRecoveryAssessor, runAssessmentInProcess };
