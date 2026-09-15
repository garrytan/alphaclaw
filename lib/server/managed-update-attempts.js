const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { withFileLockSync, writeFileAtomic } = require("./utils/safe-file");
const { noteConfigUnreadable } = require("./utils/config-unreadable");

const kManagedAttemptFile = "managed-update-attempt.json";
const kBlockingStates = new Set(["submitting", "accepted", "unknown"]);
const kStates = new Set([...kBlockingStates, "rejected", "noop", "resolved"]);
// A new attempt needs at most three audit records: submitting, its response
// (or boot uncertainty), and operator resolution. Reserve those slots before
// dispatch so an unavailable audit sink can never prevent finalization.
const kMaxPendingAudit = 32;
const kAuditSlotsPerAttempt = 3;
const kResponseStates = new Set(["accepted", "unknown", "rejected", "noop"]);
const isText = (value, max = 2048) => typeof value === "string" && value.length <= max;
const validDate = (value) => isText(value, 40) && Number.isFinite(Date.parse(value));
const isAttempt = (a) => {
  const validResolution = a?.resolution && ["deployed", "not_deployed"].includes(a.resolution.outcome) &&
    validDate(a.resolution.at) && a.resolution.source === "operator";
  return a && isText(a.id, 100) && /^[\w-]+$/.test(a.id) &&
    kStates.has(a.state) && validDate(a.requestedAt) && validDate(a.updatedAt) &&
    a.target && ["repo", "ref", "alphaclawVersion", "openclawVersion"].every((key) => isText(a.target[key])) &&
    (!a.resolution || validResolution) && (a.state !== "resolved" || validResolution);
};
const remainingAuditSlots = (state) => state === "submitting" ? 2 : ["accepted", "unknown"].includes(state) ? 1 : 0;
const isManagedAttemptDocument = (doc) => doc?.schemaVersion === 1 && isAttempt(doc.attempt) &&
  (doc.pendingAudit === undefined || (Array.isArray(doc.pendingAudit) &&
    doc.pendingAudit.length <= kMaxPendingAudit - remainingAuditSlots(doc.attempt.state) &&
    doc.pendingAudit.every(isAttempt) &&
    new Set(doc.pendingAudit.map((a) => `${a.id}:${a.state}`)).size === doc.pendingAudit.length));
const projectAttempt = (a) => a ? ({
  id: a.id, state: a.state, requestedAt: a.requestedAt, updatedAt: a.updatedAt,
  target: { repo: a.target.repo, ref: a.target.ref, alphaclawVersion: a.target.alphaclawVersion,
    openclawVersion: a.target.openclawVersion },
  ...(a.resolution ? { resolution: { outcome: a.resolution.outcome, at: a.resolution.at, source: "operator" } } : {}),
}) : null;

// submitting -> accepted/unknown remain blocked across boot/version changes.
// Only explicit rejection/noop or terminal provider verification by a human
// unlock another submission. No transition here ever dispatches a request.
const createManagedUpdateAttempts = ({ managedDir, fsModule = fs, now = Date.now, onTransition = null }) => {
  const filePath = path.join(managedDir, kManagedAttemptFile);
  const unreadable = (cause) => {
    const error = new Error(`Cannot read managed update attempt: ${cause.message}`);
    error.code = "MANAGED_UPDATE_ATTEMPT_UNREADABLE";
    error.filePath = filePath;
    noteConfigUnreadable({ error, source: "managed_update" });
    return error;
  };
  const readDocument = () => {
    let doc;
    try {
      doc = JSON.parse(fsModule.readFileSync(filePath, "utf8"));
      if (!isManagedAttemptDocument(doc)) throw new Error("invalid attempt schema");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw unreadable(error);
    }
    return { schemaVersion: 1, attempt: projectAttempt(doc.attempt),
      pendingAudit: (doc.pendingAudit || []).map(projectAttempt) };
  };
  const persist = (doc) => writeFileAtomic(filePath, JSON.stringify(doc, null, 2) + "\n", { fsModule, mode: 0o600 });
  // State and its audit obligation land in the same atomic write. The sink is
  // synchronous and deduplicates by attempt ID + state in watchdog SQLite:
  // a crash after INSERT but before this acknowledgement safely replays it.
  // Call only under the attempt-file lock; never recursively call public read.
  const flushAudit = (doc) => {
    if (!doc?.pendingAudit.length || typeof onTransition !== "function") return doc;
    let acknowledged = 0;
    for (const attempt of doc.pendingAudit) {
      try {
        onTransition(projectAttempt(attempt));
        acknowledged += 1;
      } catch (error) {
        console.warn(`[alphaclaw] managed update audit pending: ${error.message}`);
        break;
      }
    }
    if (!acknowledged) return doc;
    const updated = { ...doc, pendingAudit: doc.pendingAudit.slice(acknowledged) };
    try { persist(updated); return updated; }
    catch (error) {
      // A failed acknowledgement cannot undo the already-durable attempt or
      // turn a provider response into a new submission. Keep replay authority.
      console.warn(`[alphaclaw] managed update audit acknowledgement pending: ${error.message}`);
      return doc;
    }
  };
  const write = (doc, attempt) => {
    const projected = projectAttempt(attempt);
    const updated = { schemaVersion: 1, attempt: projected,
      pendingAudit: [...(doc?.pendingAudit || []), projected] };
    persist(updated);
    flushAudit(updated);
    return projected;
  };
  const locked = (fn) => withFileLockSync(filePath, fn, { fsModule });
  const read = () => {
    const doc = readDocument();
    if (!doc?.pendingAudit.length) return projectAttempt(doc?.attempt);
    return locked(() => projectAttempt(flushAudit(readDocument())?.attempt));
  };
  const conflict = (code, attempt) => Object.assign(new Error(
    code === "managed_update_pending" ? "Check the deployment provider and resolve the existing update before submitting another." : "The managed update attempt changed. Refresh its status and retry.",
  ), { status: 409, code, managedUpdateAttempt: attempt });
  const begin = (target) => locked(() => {
    const doc = flushAudit(readDocument());
    const existing = doc?.attempt;
    if (existing && kBlockingStates.has(existing.state)) throw conflict("managed_update_pending", existing);
    if ((doc?.pendingAudit.length || 0) > kMaxPendingAudit - kAuditSlotsPerAttempt) {
      throw Object.assign(new Error("Managed update audit storage is unavailable. Restore watchdog database access before submitting another update."),
        { status: 409, code: "managed_update_audit_pending", managedUpdateAttempt: projectAttempt(existing) });
    }
    const at = new Date(now()).toISOString();
    return write(doc, { id: randomUUID(), state: "submitting", requestedAt: at, updatedAt: at, target });
  });
  const transition = (id, from, state) => locked(() => {
    const doc = flushAudit(readDocument());
    const current = doc?.attempt;
    if (current?.id !== id || !from.includes(current.state) ||
        current.state !== "submitting" || !kResponseStates.has(state)) return null;
    return write(doc, { ...current, state, updatedAt: new Date(now()).toISOString() });
  });
  const recover = () => locked(() => {
    const doc = flushAudit(readDocument());
    const current = doc?.attempt;
    return current?.state === "submitting"
      ? write(doc, { ...current, state: "unknown", updatedAt: new Date(now()).toISOString() }) : projectAttempt(current);
  });
  const resolve = (id, outcome) => locked(() => {
    const doc = flushAudit(readDocument());
    const current = doc?.attempt;
    if (current?.id !== id) throw conflict("attempt_stale", current);
    if (current.state === "resolved" && current.resolution.outcome === outcome) return current;
    if (!["accepted", "unknown"].includes(current.state)) throw conflict("attempt_stale", current);
    const at = new Date(now()).toISOString();
    return write(doc, { ...current, state: "resolved", updatedAt: at, resolution: { outcome, at, source: "operator" } });
  });
  return { read, begin, transition, recover, resolve, filePath,
    isBlocking: (attempt = read()) => !!attempt && kBlockingStates.has(attempt.state) };
};

module.exports = { createManagedUpdateAttempts, kManagedAttemptFile, isManagedAttemptDocument };
