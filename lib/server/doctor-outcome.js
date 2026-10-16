// Facts about one `openclaw doctor --fix` run, read from its live output and
// its exit, shared by every Doctor caller (boot migration, watchdog repair,
// medic). The run-stream keeps only a 64 KiB tail, and a Doctor that prints a
// capture line early and then thousands of migration lines would evict it, so
// the facts are latched line by line while the output streams, on stdout and
// stderr separately (a chunk boundary can split a line on either stream).
//
// Lines OpenClaw 2026.10.x prints, unboxed, on the #144 layout:
//   Original state capture was unavailable: SQLite staging ancestor must not
//     allow another user to replace its child: /data. Doctor will continue; …
//   Pre-repair state retained for manual recovery at <dir>/manifest.json.
//   Atomic replace parent must be a real directory: /data/.openclaw
// and, when a check fails, a "Failing check <name>: …" line.
const { redactLine, stripAnsi } = require("./utils/redact");

const kPartialLineCapBytes = 4096;
const kDetailMaxChars = 300;
const kBoxDrawingPattern = /[\u2500-\u257f\u25c6\u25c7\u25cf\u25cb\u2502]/g;
const kCaptureUnavailablePattern = /Original state capture was unavailable:\s*(.+)$/i;
const kCaptureRetainedPattern = /Pre-repair state retained for manual recovery at (\S+?manifest\.json)/i;
const kAtomicReplacePattern = /Atomic replace parent must be a real directory/i;
// OpenClaw 2026.10.x refuses state older than its July 2026 upgrade support
// window and names the bridge release that still migrates it; the refusal is
// word-wrapped inside a box, so each line is also matched joined to the one
// before it.
const kUpgradeWindowPattern = /predates (?:the )?July 2026|pre-July-2026|upgrading-very-old-versions/i;
const kBridgeVersionPattern = /(?:install OpenClaw|doctor --fix on) (\d{4}\.\d+\.\d+)/i;
const kNoSpacePattern = /ENOSPC|no space left on device/i;
const kStateBusyPattern = /SQLITE_BUSY|database is locked|owns this state directory/i;

const cleanDoctorLine = (line) =>
  stripAnsi(String(line ?? "")).replace(kBoxDrawingPattern, " ").replace(/\s+/g, " ").trim();

const captureCauseFrom = (text) =>
  text.replace(/\.\s+Doctor will continue\b.*$/i, "").replace(/\.$/, "").trim() || null;

const createDoctorOutputFacts = () => {
  const partials = new Map();
  const facts = {
    captureState: "unknown",
    captureCause: null,
    captureManifest: null,
    failingCheck: null,
    atomicReplaceLine: null,
    upgradeWindowRefused: false,
    bridgeVersion: null,
    noSpace: false,
    stateBusy: false,
    lastMeaningfulLine: null,
  };
  let previousLine = "";
  const observeLine = (rawLine) => {
    const line = cleanDoctorLine(rawLine);
    if (!line) return;
    facts.lastMeaningfulLine = line;
    const joined = previousLine ? `${previousLine} ${line}` : line;
    previousLine = line;
    const unavailable = line.match(kCaptureUnavailablePattern);
    if (unavailable) {
      facts.captureState = "unavailable";
      facts.captureCause = captureCauseFrom(unavailable[1]);
    }
    const retained = line.match(kCaptureRetainedPattern);
    if (retained) {
      facts.captureState = "available";
      facts.captureManifest = retained[1];
    }
    if (!facts.failingCheck && line.startsWith("Failing check ")) facts.failingCheck = line;
    if (!facts.atomicReplaceLine && kAtomicReplacePattern.test(line)) facts.atomicReplaceLine = line;
    if (kUpgradeWindowPattern.test(joined)) facts.upgradeWindowRefused = true;
    const bridge = joined.match(kBridgeVersionPattern);
    if (bridge && !facts.bridgeVersion) facts.bridgeVersion = bridge[1];
    if (kNoSpacePattern.test(line)) facts.noSpace = true;
    if (kStateBusyPattern.test(line)) facts.stateBusy = true;
  };
  const onOutput = (chunkText, streamName = "stdout") => {
    const lines = `${partials.get(streamName) || ""}${String(chunkText ?? "")}`.split("\n");
    let partial = lines.pop();
    if (partial.length > kPartialLineCapBytes) partial = partial.slice(-kPartialLineCapBytes);
    partials.set(streamName, partial);
    for (const line of lines) observeLine(line);
  };
  const snapshot = () => {
    for (const [streamName, partial] of partials) {
      if (partial) observeLine(partial);
      partials.set(streamName, "");
    }
    return { ...facts };
  };
  return { onOutput, snapshot };
};

// A runner result (or a test double) → the one outcome every caller records.
// deterministic: a completed non-zero exit OpenClaw will repeat on the same
// state (atomic-replace refusal, July-2026 window refusal, a failing check).
// transient: everything else that failed (timeout, cancel, signal, ENOSPC,
// state ownership/busy, an unexplained exit) — never remembered.
const summarizeDoctorResult = (result, { secrets = null } = {}) => {
  let facts = result?.facts;
  if (!facts) {
    const parsed = createDoctorOutputFacts();
    parsed.onOutput(String(result?.stdout || ""), "stdout");
    parsed.onOutput(String(result?.stderr || ""), "stderr");
    if (result?.lastOutputLine) parsed.onOutput(`${result.lastOutputLine}\n`, "last");
    facts = parsed.snapshot();
  }
  const capture = {
    captureState: facts.captureState || "unknown",
    captureCause: facts.captureCause ? redactLine(facts.captureCause, { secrets, maxLength: kDetailMaxChars }) : null,
    captureManifest: facts.captureManifest || null,
  };
  if (result?.ok) return { status: "ok", class: null, reason: null, detail: null, ...capture, bridgeVersion: null };
  const rawDetail = facts.failingCheck || facts.atomicReplaceLine || facts.lastMeaningfulLine || "";
  const detail = redactLine(rawDetail, { secrets, maxLength: kDetailMaxChars }) || null;
  let reason;
  let outcomeClass = "transient";
  if (result?.cancelled) reason = "cancelled";
  else if (result?.timedOut) reason = "timed_out";
  else if (result?.code === "doctor_restored_stale_config") reason = "doctor_restored_stale_config";
  else if (facts.noSpace) reason = "no_space";
  else if (facts.stateBusy) reason = "state_busy";
  else if (typeof result?.code !== "number") reason = result?.signal ? `signal_${result.signal}` : "failed";
  else if (facts.upgradeWindowRefused) [reason, outcomeClass] = ["upgrade_window_refused", "deterministic"];
  else if (facts.atomicReplaceLine) [reason, outcomeClass] = ["atomic_replace_refused", "deterministic"];
  else if (facts.failingCheck) [reason, outcomeClass] = ["failing_check", "deterministic"];
  else reason = `exit_${result.code}`;
  return {
    status: "failed",
    class: outcomeClass,
    reason,
    detail,
    ...capture,
    bridgeVersion: facts.upgradeWindowRefused ? facts.bridgeVersion : null,
  };
};

module.exports = {
  cleanDoctorLine,
  createDoctorOutputFacts,
  summarizeDoctorResult,
};
