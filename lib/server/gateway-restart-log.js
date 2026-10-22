const { redactLine, collectSecretValues } = require("./utils/redact");
// Namespace require (not destructured) so tests can spy on the module object.
const lockContention = require("./openclaw-lock-contention");

const kGatewayStderrTailLines = 50;

// One line per ladder event, one grammar: `[alphaclaw] restart op=<first 8>
// <event> key=value …`, arrays as compact JSON. `op=-` for callers without
// an operation (watchdog replace, shutdown). Every string value has been
// through redactLine. Documented in the runbook as the 0.10.1 log contract.
const formatRestartLogLine = (opId, event, fields = {}) => {
  const parts = [`[alphaclaw] restart op=${opId ? String(opId).slice(0, 8) : "-"} ${event}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  }
  return parts.join(" ");
};
const logRestart = (opId, event, fields) => console.log(formatRestartLogLine(opId, event, fields));
const redactEvidenceLine = (text, maxLength = 240) =>
  redactLine(text, { secrets: collectSecretValues({ env: process.env }), maxLength });

// Lock-contention evidence (read-only). Upstream's state-lifecycle
// coordinator is an exclusive SQLite transaction held by a LIVE process (see
// openclaw-lock-contention.js) — when a restart fails with contention text,
// the useful fact is WHICH live openclaw process holds it. Appended to the
// attempt's stdout evidence ring so it persists on the operation record.
const appendLockContentionEvidence = (stdoutTail, ...tails) => {
  const text = tails
    .filter(Array.isArray)
    .map((lines) => lines.join("\n"))
    .join("\n");
  if (!lockContention.looksLikeLockContention(text)) return;
  try {
    const report = lockContention.describeLockContention({ site: "restart" });
    for (const line of report.lines) {
      stdoutTail.append(`${line}\n`);
      console.warn(line);
    }
  } catch (error) {
    console.warn(
      `[alphaclaw] lock-contention diagnostic failed: ${String(error?.message || error)}`,
    );
  }
};

// Per-child stderr evidence tail: each spawned child gets its OWN tail,
// captured in its launch closure, so a late 'close' from an old child is
// always classified against that child's stderr — never a successor's. With
// the previous module-global tail, a newer launch reset the buffer and a
// stale exit-78 close could latch configuration_error against a healthy new
// gateway. Per-instance creation also replaces the old reset-per-attempt
// pattern (evidence honesty: a failed restart reports only its own stderr).
const createStderrTail = () => {
  let lines = [];
  let carry = "";
  const append = (chunk) => {
    const text =
      carry +
      (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? ""));
    carry = "";
    const split = text.split("\n");
    // A chunk rarely ends exactly on a newline; hold the trailing partial line
    // until it completes so a secret split across chunks is one tail entry
    // (redaction matches whole values) instead of two unmatchable halves.
    const partial = split.pop();
    // Cap the carry: a gateway that never emits a newline (\r progress bars,
    // one huge line) must not grow it without bound. Keep the tail end — that
    // is what snapshot() surfaces.
    if (partial) carry = partial.slice(-8192);
    for (const line of split) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      // Per-line cap at RETENTION time: completed lines had no bound, so a
      // gateway spraying huge single lines could hold 50 x multi-hundred-KB
      // strings here. 2KB keeps the diagnostic head of any sane log line.
      lines.push(trimmed.length > 2048 ? trimmed.slice(0, 2048) : trimmed);
    }
    if (lines.length > kGatewayStderrTailLines) {
      lines = lines.slice(-kGatewayStderrTailLines);
    }
  };
  // Evidence snapshot: completed lines plus any in-flight partial line (a
  // crash often dies mid-line and that fragment is the interesting part).
  const snapshot = () => {
    const tail = [...lines];
    if (carry.trimEnd()) tail.push(carry.trimEnd());
    return tail.slice(-kGatewayStderrTailLines);
  };
  return { append, snapshot };
};

module.exports = {
  formatRestartLogLine,
  logRestart,
  redactEvidenceLine,
  appendLockContentionEvidence,
  createStderrTail,
  kGatewayStderrTailLines,
};
