// Thin wrapper over OpenClaw's versioned restart-handoff consume contract (protocol
// v1, docs/cli/gateway.md "External supervisors"). When AlphaClaw's gateway child
// exits unexpectedly, this lets the watchdog distinguish an intentional in-gateway
// restart request from a crash: a fresh-process restart writes a bounded SQLite
// handoff before clean exit, and consuming it (validating the expected pid) proves the
// exit was requested. An accepted handoff is deleted before success returns upstream,
// so a double-consume is safe.
//
// Only meaningful when capabilities.restartHandoff.consume is true — callers must
// gate on the capabilities probe, never on a version string.

// Consume a pending restart handoff for the exited gateway pid. Returns
// { accepted } — accepted is true ONLY when the CLI exits 0 AND the JSON confirms a
// restart handoff was consumed. Exit 0 also covers non-restart results (e.g. "no
// handoff present"), so we parse the body rather than trusting the exit code alone.
// Any error / timeout / unparseable output ⇒ { accepted: false } (treat as a crash).
const consumeRestartHandoff = async ({ clawCmd, pid, timeoutMs = 5000, logger = console } = {}) => {
  if (typeof clawCmd !== "function") {
    throw new Error("consumeRestartHandoff requires a clawCmd function");
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return { accepted: false, reason: "invalid-expected-pid" };
  }
  let result;
  try {
    result = await clawCmd(
      `gateway restart-handoff consume --expected-pid ${pid} --json`,
      { quiet: true, timeoutMs },
    );
  } catch (error) {
    logger.warn?.(
      `[restart-handoff] consume threw for pid ${pid}: ${error.message}`,
    );
    return { accepted: false, reason: "error" };
  }

  // exit 2 = invalid-expected-pid, exit 1 = store-unavailable → not authorized.
  if (!result.ok) {
    return { accepted: false, reason: parseReason(result.stdout) || "not-ok" };
  }

  const doc = parseJson(result.stdout);
  if (!doc || typeof doc !== "object") {
    return { accepted: false, reason: "unparseable" };
  }
  // Upstream reports the outcome via a boolean/flag; accept only an explicit
  // consumed/accepted signal, never a mere exit-0 "no restart" result.
  // openclaw >= 2026.9.1-beta.1 emits { ok, protocolVersion, status:
  // "accepted" | "rejected" | "none", … } — status carries the verdict.
  const accepted =
    doc.consumed === true ||
    doc.accepted === true ||
    doc.restart === true ||
    doc.result === "consumed" ||
    doc.result === "accepted" ||
    doc.status === "accepted";
  return { accepted, reason: doc.reason || null };
};

const parseJson = (text) => {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text.trim());
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
};

const parseReason = (text) => {
  const doc = parseJson(text);
  return doc && typeof doc.reason === "string" ? doc.reason : null;
};

module.exports = { consumeRestartHandoff };
