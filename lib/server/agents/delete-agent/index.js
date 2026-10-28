const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { readOpenclawConfigForWrite, setOpenclawConfigWriteGate } = require("../../openclaw-config");
const { openReadonlyOpenclawStateDb } = require("../../openclaw-state-db");
const { writeFileAtomic } = require("../../utils/safe-file");
const { kDefaultAgentId, isValidAgentId, withNormalizedAgentsConfig } = require("../shared");
const { callAgentsDelete, summarizeAnswer } = require("./gateway-delete");
const { classifyDeletion, readDeletionFacts, readIncompleteDeletions } = require("./read-back");
const {
  SnapshotError,
  assessHistoryCoverage,
  checkRepositoryAncestors,
  copyTree,
  createDatabaseSnapshot,
  databaseFamilyBytes,
  findWorkspaceOwner,
  freeBytes,
  measureTree,
  resolveAgentPaths,
  snapshotNeedBytes,
} = require("./snapshot");
const {
  kStagingPrefix,
  ensurePrivateDir,
  readOperations,
  removeStaleStaging,
  writeOperation,
} = require("./operations");

const kArchiveSchema = "alphaclaw.agent-archive/1";
const kConfigGateMessage = "An agent is being deleted. Try again in a moment.";
const kGatewayCallTimeoutMs = 120_000;
const kLeaseMs = 5 * 60 * 1000;
const kGb = 1e9;

class DeleteAgentError extends Error {
  constructor(message, { status = 400, code = "refused" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const readVersion = (request) => {
  try {
    return String(require(request).version || "");
  } catch {
    return "";
  }
};

const stepTimeoutMs = (bytes, perGbMs) => 60_000 + Math.ceil(Math.max(0, bytes) / kGb) * perGbMs;

const kOutcomeSentence = {
  deleted: (id) => `Deleted ${id}.`,
  cleanup_incomplete: (id) => `${id} was deleted, but OpenClaw couldn't finish cleaning up its data. Finish deleting to retry.`,
  not_deleted: (id) => `OpenClaw didn't delete ${id}.`,
  unknown: (id) => `Couldn't confirm whether ${id} was deleted.`,
  config_only: (id) => `${id} is gone from the settings, but OpenClaw didn't record a deletion, so its data may still be on disk.`,
};

const createAgentDeleter = ({
  openclawDir,
  archivesRoot,
  execFileCmd,
  gatewayEnv = () => process.env,
  isGatewayRunning = async () => false,
  lifecycleLock,
  countCronJobs = () => null,
  insertEvent = null,
  notify = null,
  logger = console,
  fsModule = fs,
  fsp = fs.promises,
  openStateDb = openReadonlyOpenclawStateDb,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  randomHex = () => crypto.randomBytes(3).toString("hex"),
  settleMs = 10_000,
  pollMs = 1000,
  lockWaitMs = 60_000,
  versions = { alphaclaw: readVersion("../../../../package.json"), openclaw: readVersion("openclaw/package.json") },
}) => {
  let running = null;

  const readConfig = () =>
    withNormalizedAgentsConfig({
      OPENCLAW_DIR: openclawDir,
      cfg: readOpenclawConfigForWrite({ fsModule, openclawDir }),
    });
  const readFacts = (agentId) => readDeletionFacts({ openclawDir, agentId, fsModule, openStateDb });

  // AlphaClaw's own refusals, in front of OpenClaw's, with the messages the
  // Agents tab has always shown.
  const findRefusal = (cfg, agentId) => {
    if (agentId === kDefaultAgentId) return new DeleteAgentError("The default main agent cannot be deleted");
    const target = cfg.agents.list.find((entry) => String(entry.id || "").trim() === agentId);
    if (!target) return null;
    if (target.default) return new DeleteAgentError("Default agent cannot be deleted");
    const defaults = cfg.agents.defaults && typeof cfg.agents.defaults === "object" ? cfg.agents.defaults : {};
    for (const key of ["authInheritance", "sessionStore"]) {
      if (String(defaults[key]?.agentId || "").trim() === agentId) {
        return new DeleteAgentError(`Agent "${agentId}" owns agents.defaults.${key} and cannot be deleted`);
      }
    }
    return null;
  };

  const isConfigured = (cfg, agentId) => cfg.agents.list.some((entry) => String(entry.id || "").trim() === agentId);

  const gatewayServing = async () => !lifecycleLock?.getActiveOperation?.() && (await isGatewayRunning()) === true;

  const assertIdShape = (rawId) => {
    const agentId = String(rawId || "").trim();
    if (!isValidAgentId(agentId)) throw new DeleteAgentError(`Agent "${agentId}" not found`, { status: 404, code: "not_found" });
    return agentId;
  };

  const acquireLock = async () => {
    let timer = null;
    let timedOut = false;
    const pending = lifecycleLock.acquire("agent-delete", { leaseMs: kLeaseMs });
    const release = await Promise.race([
      pending,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(null);
        }, lockWaitMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    if (timedOut) {
      pending.then((late) => late());
      return null;
    }
    return release;
  };

  const measureSnapshotInputs = async ({ cfg, agentId }) => {
    const paths = resolveAgentPaths({ cfg, agentId, openclawDir });
    const facts = readFacts(agentId);
    const coverage = assessHistoryCoverage({ cfg, agentId, paths, registered: facts.registered, openclawDir, fsModule });
    const databaseBytes = coverage.hasDatabase ? databaseFamilyBytes(paths.databasePath, fsModule) : 0;
    const history = await measureTree(paths.sessionsDir, { fsp });
    const retainedBy = findWorkspaceOwner({ cfg, agentId, workspace: paths.workspace, openclawDir });
    const workspace = retainedBy ? { exists: true, bytes: 0, files: 0, approximate: false } : await measureTree(paths.workspace, { fsp });
    const neededBytes = snapshotNeedBytes({ databaseBytes, historyBytes: history.bytes, workspaceBytes: workspace.bytes });
    const availableBytes = await freeBytes(archivesRoot, { fsp, fsModule });
    const ancestorProblem = checkRepositoryAncestors(archivesRoot, { fsModule });
    return { paths, coverage, databaseBytes, history, retainedBy, workspace, neededBytes, availableBytes, ancestorProblem };
  };

  const snapshotVerdict = (inputs) => {
    if (!inputs.coverage.available) return { available: false, reason: inputs.coverage.reason };
    if (inputs.ancestorProblem) return { available: false, reason: inputs.ancestorProblem };
    const approximate = inputs.history.approximate || inputs.workspace.approximate;
    const fits = inputs.availableBytes === null ? null : inputs.availableBytes >= inputs.neededBytes;
    return { available: true, reason: null, fits, approximate, neededBytes: inputs.neededBytes, availableBytes: inputs.availableBytes };
  };

  const preview = async (rawId) => {
    const agentId = assertIdShape(rawId);
    const cfg = readConfig();
    if (!isConfigured(cfg, agentId)) {
      const facts = readFacts(agentId);
      if (facts.configured === false && facts.journal && !facts.journal.complete) {
        return { agentId, state: "cleanup_incomplete", gatewayServing: await gatewayServing(), busy: !!running };
      }
      throw new DeleteAgentError(`Agent "${agentId}" not found`, { status: 404, code: "not_found" });
    }
    const refusal = findRefusal(cfg, agentId);
    const inputs = await measureSnapshotInputs({ cfg, agentId });
    const entry = inputs.paths.entry;
    return {
      agentId,
      name: String(entry.name || entry.identity?.name || agentId),
      state: "configured",
      refusal: refusal ? refusal.message : null,
      gatewayServing: await gatewayServing(),
      busy: !!running,
      counts: {
        bindings: (Array.isArray(cfg.bindings) ? cfg.bindings : []).filter((binding) => String(binding?.agentId || "") === agentId).length,
        cronJobs: countCronJobs(agentId),
      },
      history: { hasDatabase: !!inputs.coverage.hasDatabase, bytes: inputs.databaseBytes + inputs.history.bytes, approximate: inputs.history.approximate },
      workspace: {
        path: inputs.paths.workspace,
        exists: inputs.workspace.exists,
        bytes: inputs.workspace.bytes,
        files: inputs.workspace.files,
        approximate: inputs.workspace.approximate,
        retainedBy: inputs.retainedBy,
      },
      snapshot: snapshotVerdict(inputs),
    };
  };

  const stageSnapshot = async ({ cfg, agentId }) => {
    const inputs = await measureSnapshotInputs({ cfg, agentId });
    const verdict = snapshotVerdict(inputs);
    if (!verdict.available) throw new DeleteAgentError(verdict.reason, { status: 409, code: "snapshot_unavailable" });
    if (verdict.fits === false) {
      throw new DeleteAgentError(
        `Not enough disk for the snapshot: it needs ${(inputs.neededBytes / kGb).toFixed(2)} GB free and ${(inputs.availableBytes / kGb).toFixed(2)} GB is available. Turn off the snapshot to delete without one.`,
        { status: 507, code: "snapshot_no_space" },
      );
    }
    ensurePrivateDir(archivesRoot, fsModule);
    const createdAt = now();
    const name = `${new Date(createdAt).toISOString().slice(0, 10)}-${agentId}-${randomHex()}`;
    const staging = path.join(archivesRoot, kStagingPrefix + name);
    fsModule.mkdirSync(staging, { mode: 0o700 });
    try {
      let database = null;
      if (inputs.coverage.hasDatabase) {
        const repository = path.join(staging, "database");
        const scratch = path.join(staging, ".scratch");
        fsModule.mkdirSync(repository, { mode: 0o700 });
        fsModule.mkdirSync(scratch, { mode: 0o700 });
        database = await createDatabaseSnapshot({
          execFileCmd,
          env: gatewayEnv(),
          agentId,
          repository,
          scratch,
          timeoutMs: stepTimeoutMs(inputs.databaseBytes + inputs.history.bytes, 20_000),
        });
        await fsp.rm(scratch, { recursive: true, force: true });
      }
      let workspace = { included: false, path: inputs.paths.workspace, retainedBy: inputs.retainedBy, files: 0, bytes: 0, skipped: [] };
      if (!inputs.retainedBy && inputs.workspace.exists) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), stepTimeoutMs(inputs.workspace.bytes, 30_000));
        try {
          const copied = await copyTree(inputs.paths.workspace, path.join(staging, "workspace"), { signal: controller.signal, fsp });
          workspace = { ...workspace, included: true, ...copied };
        } finally {
          clearTimeout(timer);
        }
      }
      const entry = inputs.paths.entry;
      const manifest = {
        schema: kArchiveSchema,
        agentId,
        name: String(entry.name || entry.identity?.name || agentId),
        config: {
          name: entry.name ?? null,
          model: entry.model ?? null,
          workspace: inputs.paths.workspace,
          agentDir: inputs.paths.agentDir,
        },
        counts: {
          bindings: (Array.isArray(cfg.bindings) ? cfg.bindings : []).filter((binding) => String(binding?.agentId || "") === agentId).length,
          cronJobs: countCronJobs(agentId),
        },
        snapshotAt: new Date(now()).toISOString(),
        database: database ? { snapshotId: database.snapshotId, manifest: database.manifest } : null,
        noChatHistory: !database,
        workspace,
        versions,
        delete: null,
      };
      writeFileAtomic(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { fsModule, mode: 0o600 });
      return { name, staging, manifest };
    } catch (error) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      if (error?.code === "ENOSPC") throw new DeleteAgentError("The disk filled up while saving the snapshot. Nothing was deleted.", { status: 507, code: "snapshot_no_space" });
      if (error instanceof SnapshotError || error instanceof DeleteAgentError) throw error;
      throw new SnapshotError(`Couldn't save the snapshot: ${error.message}. Nothing was deleted.`);
    }
  };

  const settleOutcome = async (agentId, answer) => {
    let facts = readFacts(agentId);
    let outcome = classifyDeletion({ facts, answer });
    const deadline = now() + settleMs;
    while (outcome === "unknown" && now() < deadline) {
      await sleep(pollMs);
      facts = readFacts(agentId);
      outcome = classifyDeletion({ facts, answer });
    }
    if (outcome === "unknown") outcome = classifyDeletion({ facts, answer, settled: true });
    return { outcome, facts };
  };

  const archiveBytes = (manifest) =>
    manifest ? (Number(manifest.database?.manifest?.artifact?.sizeBytes) || 0) + (Number(manifest.workspace?.bytes) || 0) : 0;

  const report = ({ record, actor }) => {
    logger.log?.(
      `[alphaclaw] agent delete op=${record.opId} agent=${record.agentId} outcome=${record.outcome} snapshot=${record.archive || "none"} actor=${actor}`,
    );
    try {
      insertEvent?.({
        eventType: "agent_delete",
        source: "agents",
        status: record.outcome === "deleted" ? "ok" : record.outcome === "unknown" || record.outcome === "not_deleted" ? "failed" : "warning",
        details: { agentId: record.agentId, outcome: record.outcome, opId: record.opId, archive: record.archive || null },
      });
    } catch {}
  };

  // Lock, gate, re-check, publish, send, settle. Nothing is removed before
  // the send; once a delete is sent its archive is never discarded.
  const submit = async ({ agentId, staged, actor, kind }) => {
    const opId = crypto.randomUUID();
    let release = null;
    let submitted = false;
    let published = null;
    let record = null;
    try {
      release = await acquireLock();
      if (!release) throw new DeleteAgentError("The gateway is busy with a restart or repair. Try again in a minute.", { status: 409, code: "lifecycle_busy" });
      setOpenclawConfigWriteGate(kConfigGateMessage);
      const cfg = readConfig();
      if (kind === "delete") {
        if (!isConfigured(cfg, agentId)) throw new DeleteAgentError(`Agent "${agentId}" not found`, { status: 404, code: "not_found" });
        const refusal = findRefusal(cfg, agentId);
        if (refusal) throw refusal;
      } else {
        const facts = readFacts(agentId);
        if (isConfigured(cfg, agentId) || !facts.journal || facts.journal.complete) {
          throw new DeleteAgentError(`Nothing is left to finish for ${agentId}.`, { status: 409, code: "nothing_to_finish" });
        }
      }
      if (!release.isValid()) throw new DeleteAgentError("The gateway is busy with a restart or repair. Try again in a minute.", { status: 409, code: "lifecycle_busy" });
      if (staged) {
        published = path.join(archivesRoot, staged.name);
        await fsp.rename(staged.staging, published);
      }
      record = writeOperation({
        archivesRoot,
        fsModule,
        record: { opId, agentId, kind, archive: staged?.name || null, phase: "submitted", outcome: null, startedAt: now() },
      });
      submitted = true;
      const answer = await callAgentsDelete({ execFileCmd, env: gatewayEnv(), agentId, timeoutMs: kGatewayCallTimeoutMs });
      const { outcome } = await settleOutcome(agentId, answer);
      const summary = summarizeAnswer(answer);
      record = writeOperation({
        archivesRoot,
        fsModule,
        record: { ...record, phase: "settled", outcome, settledAt: now(), answer: summary, archiveBytes: archiveBytes(staged?.manifest) },
      });
      if (staged) {
        try {
          const manifest = { ...staged.manifest, delete: { opId, outcome, at: new Date(now()).toISOString(), answer: summary } };
          writeFileAtomic(path.join(published, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { fsModule, mode: 0o600 });
        } catch (error) {
          logger.warn?.(`[alphaclaw] could not record the delete in the snapshot manifest: ${error.message}`);
        }
      }
      report({ record, actor });
      return {
        opId,
        agentId,
        outcome,
        message: kOutcomeSentence[outcome](agentId) + (outcome === "not_deleted" && answer.kind === "error" && answer.message ? ` ${answer.message}` : ""),
        archive: staged ? { name: staged.name, bytes: archiveBytes(staged.manifest), workspaceIncluded: !!staged.manifest.workspace?.included, noChatHistory: !!staged.manifest.noChatHistory } : null,
        removedBindings: summary.kind === "ok" ? summary.removedBindings : null,
        failed: summary.kind === "ok" ? summary.failed : [],
      };
    } catch (error) {
      if (!submitted) {
        const leftover = published || staged?.staging;
        if (leftover) await fsp.rm(leftover, { recursive: true, force: true }).catch(() => {});
      }
      throw error;
    } finally {
      setOpenclawConfigWriteGate(null);
      release?.();
    }
  };

  const runExclusive = async (agentId, work) => {
    if (running) throw new DeleteAgentError(running.agentId === agentId ? "This agent is already being deleted." : "Another agent delete is running. Try again when it finishes.", { status: 409, code: "delete_running" });
    running = { agentId };
    try {
      return await work();
    } finally {
      running = null;
    }
  };

  const deleteAgent = async (rawId, { snapshot = true, actor = "unknown" } = {}) => {
    const agentId = assertIdShape(rawId);
    return runExclusive(agentId, async () => {
      const cfg = readConfig();
      if (!isConfigured(cfg, agentId)) {
        throw new DeleteAgentError(`Agent "${agentId}" not found`, { status: 404, code: "not_found" });
      }
      const refusal = findRefusal(cfg, agentId);
      if (refusal) throw refusal;
      if (!(await gatewayServing())) {
        throw new DeleteAgentError("The gateway isn't running. Delete the agent once it's back.", { status: 409, code: "gateway_not_serving" });
      }
      const staged = snapshot ? await stageSnapshot({ cfg, agentId }) : null;
      return submit({ agentId, staged, actor, kind: "delete" });
    });
  };

  const finishDelete = async (rawId, { actor = "unknown" } = {}) => {
    const agentId = assertIdShape(rawId);
    return runExclusive(agentId, async () => {
      if (!(await gatewayServing())) {
        throw new DeleteAgentError("The gateway isn't running. Finish deleting once it's back.", { status: 409, code: "gateway_not_serving" });
      }
      return submit({ agentId, staged: null, actor, kind: "finish" });
    });
  };

  // The latest outcome per agent (a receipt across reloads and admins), with
  // unsettled ones re-read from OpenClaw, plus deletions OpenClaw journaled but
  // didn't finish whoever started them.
  const listDeletions = () => {
    const latest = new Map();
    for (const record of readOperations({ archivesRoot, fsModule })) {
      if (!latest.has(record.agentId)) latest.set(record.agentId, record);
    }
    const deletions = [];
    for (const record of latest.values()) {
      let outcome = record.outcome || "unknown";
      if (record.phase !== "settled" || outcome === "unknown" || outcome === "cleanup_incomplete") {
        if (running?.agentId === record.agentId) outcome = "running";
        else outcome = classifyDeletion({ facts: readFacts(record.agentId), answer: { kind: "none" }, settled: record.phase === "settled" });
      }
      deletions.push({
        agentId: record.agentId,
        opId: record.opId,
        outcome,
        archive: record.archive || null,
        archiveBytes: Number(record.archiveBytes) || 0,
        at: record.settledAt || record.startedAt || null,
      });
    }
    for (const agentId of readIncompleteDeletions({ openclawDir, openStateDb })) {
      if (!latest.has(agentId)) deletions.push({ agentId, opId: null, outcome: "cleanup_incomplete", archive: null, archiveBytes: 0, at: null });
    }
    return { deletions, running: running ? { agentId: running.agentId } : null };
  };

  const cleanupStaging = () => removeStaleStaging({ archivesRoot, fsModule, logger });

  // After the gateway serves: a delete AlphaClaw sent but never saw settle
  // (it died or restarted mid-call) is decided from OpenClaw's own facts,
  // recorded, and told to the owner once. Never sends anything to OpenClaw.
  const reconcileInterrupted = async () => {
    const records = readOperations({ archivesRoot, fsModule }).filter((record) => record.phase === "submitted");
    const settled = [];
    for (const record of records) {
      try {
        const outcome = classifyDeletion({ facts: readFacts(record.agentId), answer: { kind: "none" }, settled: true });
        const next = writeOperation({ archivesRoot, fsModule, record: { ...record, phase: "settled", outcome, settledAt: now(), interrupted: true } });
        report({ record: next, actor: "reconcile" });
        settled.push(next);
        const kept = record.archive ? ` Its snapshot was kept as ${record.archive}.` : "";
        await notify?.(`AlphaClaw restarted while deleting agent ${record.agentId}. ${kOutcomeSentence[outcome](record.agentId)}${kept}`);
      } catch (error) {
        logger.warn?.(`[alphaclaw] could not settle the interrupted delete of ${record.agentId}: ${error.message}`);
      }
    }
    return settled;
  };

  return { preview, deleteAgent, finishDelete, listDeletions, cleanupStaging, reconcileInterrupted };
};

module.exports = { createAgentDeleter, DeleteAgentError, kConfigGateMessage };
