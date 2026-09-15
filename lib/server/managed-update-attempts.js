const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { withFileLockSync, writeFileAtomic } = require("./utils/safe-file");
const { noteConfigUnreadable } = require("./utils/config-unreadable");

const kManagedAttemptFile = "managed-update-attempt.json";
const kBlockingStates = new Set(["submitting", "accepted", "unknown"]);
const kStates = new Set([...kBlockingStates, "rejected", "noop", "resolved"]);
const isText = (value, max = 2048) => typeof value === "string" && value.length <= max;
const validDate = (value) => isText(value, 40) && Number.isFinite(Date.parse(value));
const isManagedAttemptDocument = (doc) => {
  const a = doc?.attempt;
  const validResolution = a?.resolution && ["deployed", "not_deployed"].includes(a.resolution.outcome) &&
    validDate(a.resolution.at) && a.resolution.source === "operator";
  return doc?.schemaVersion === 1 && a && isText(a.id, 100) && /^[\w-]+$/.test(a.id) &&
    kStates.has(a.state) && validDate(a.requestedAt) && validDate(a.updatedAt) &&
    a.target && ["repo", "ref", "alphaclawVersion", "openclawVersion"].every((key) => isText(a.target[key])) &&
    (!a.resolution || validResolution) && (a.state !== "resolved" || validResolution);
};
const projectAttempt = (a) => a ? ({
  id: a.id, state: a.state, requestedAt: a.requestedAt, updatedAt: a.updatedAt,
  target: { repo: a.target.repo, ref: a.target.ref, alphaclawVersion: a.target.alphaclawVersion,
    openclawVersion: a.target.openclawVersion },
  ...(a.resolution ? { resolution: { outcome: a.resolution.outcome, at: a.resolution.at, source: "operator" } } : {}),
}) : null;

// submitting -> accepted/unknown remain blocked across boot/version changes.
// Only explicit rejection/noop or terminal provider verification by a human
// unlock another submission. No transition here ever dispatches a request.
const createManagedUpdateAttempts = ({ managedDir, fsModule = fs, now = Date.now, onTransition = () => {} }) => {
  const filePath = path.join(managedDir, kManagedAttemptFile);
  const unreadable = (cause) => {
    const error = new Error(`Cannot read managed update attempt: ${cause.message}`);
    error.code = "MANAGED_UPDATE_ATTEMPT_UNREADABLE";
    error.filePath = filePath;
    noteConfigUnreadable({ error, source: "managed_update" });
    return error;
  };
  const read = () => {
    let doc;
    try {
      doc = JSON.parse(fsModule.readFileSync(filePath, "utf8"));
      if (!isManagedAttemptDocument(doc)) throw new Error("invalid attempt schema");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw unreadable(error);
    }
    return projectAttempt(doc.attempt);
  };
  const write = (attempt) => {
    writeFileAtomic(filePath, JSON.stringify({ schemaVersion: 1, attempt }, null, 2) + "\n", { fsModule, mode: 0o600 });
    try { onTransition(projectAttempt(attempt)); } catch (error) {
      console.warn(`[alphaclaw] managed update audit failed: ${error.message}`);
    }
    return projectAttempt(attempt);
  };
  const locked = (fn) => withFileLockSync(filePath, fn, { fsModule });
  const conflict = (code, attempt) => Object.assign(new Error(
    code === "managed_update_pending" ? "Check the deployment provider and resolve the existing update before submitting another." : "The managed update attempt changed. Refresh its status and retry.",
  ), { status: 409, code, managedUpdateAttempt: attempt });
  const begin = (target) => locked(() => {
    const existing = read();
    if (existing && kBlockingStates.has(existing.state)) throw conflict("managed_update_pending", existing);
    const at = new Date(now()).toISOString();
    return write({ id: randomUUID(), state: "submitting", requestedAt: at, updatedAt: at, target });
  });
  const transition = (id, from, state) => locked(() => {
    const current = read();
    if (current?.id !== id || !from.includes(current.state)) return null;
    return write({ ...current, state, updatedAt: new Date(now()).toISOString() });
  });
  const recover = () => locked(() => {
    const current = read();
    return current?.state === "submitting"
      ? write({ ...current, state: "unknown", updatedAt: new Date(now()).toISOString() }) : current;
  });
  const resolve = (id, outcome) => locked(() => {
    const current = read();
    if (current?.id !== id) throw conflict("attempt_stale", current);
    if (current.state === "resolved" && current.resolution.outcome === outcome) return current;
    if (!["accepted", "unknown"].includes(current.state)) throw conflict("attempt_stale", current);
    const at = new Date(now()).toISOString();
    return write({ ...current, state: "resolved", updatedAt: at, resolution: { outcome, at, source: "operator" } });
  });
  return { read, begin, transition, recover, resolve, filePath,
    isBlocking: (attempt = read()) => !!attempt && kBlockingStates.has(attempt.state) };
};

module.exports = { createManagedUpdateAttempts, kManagedAttemptFile, isManagedAttemptDocument };
