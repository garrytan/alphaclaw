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
const { kDiskFullPattern } = require("./disk-full");

const kPartialLineCapBytes = 4096;
const kDetailMaxChars = 300;
const kBoxDrawingPattern = /[\u2500-\u257f\u25c6\u25c7\u25cf\u25cb\u2502]/g;
const kCaptureUnavailablePattern = /Original state capture was unavailable:\s*(.+)$/i;
const kCaptureRetainedPattern = /Pre-repair state retained for manual recovery at (\S+?manifest\.json)/i;
const kAtomicReplacePattern = /Atomic replace parent must be a real directory/i;
// OPENCLAW_GATEWAY_STARTUP_TRACE timings (set on every Doctor run) are printed
// in a finally, after the line that explains a failure; never the detail.
const kStartupTracePattern = /startup trace: /;
// OpenClaw 2026.10.x refuses state older than its July 2026 upgrade support
// window and names the bridge release that still migrates it; the refusal is
// word-wrapped inside a box, so each line is also matched joined to the one
// before it.
const kUpgradeWindowPattern = /predates (?:the )?July 2026|pre-July-2026|upgrading-very-old-versions/i;
const kBridgeVersionPattern = /(?:install OpenClaw|doctor --fix on) (\d{4}\.\d+\.\d+)/i;
const kStateBusyPattern = /SQLITE_BUSY|database is locked|owns this state directory|owns gateway-lifecycle|owns state-lifecycle|owner lease is still active|Waiting for the gateway that owns/i;
// OpenClaw 2026.10.x's workspace-alias check (core/doctor/workspace-alias):
// the workspace's real path changed after OpenClaw saved its setup records,
// and doctor --fix --yes won't rebind them without an interactive confirm or
// --force. Doctor's own wording, and the runtime error's:
//   Workspace path <alias> now resolves to <new>, but its saved setup records belong to <old>.
//   workspace path alias points to a different current target: <alias> now resolves to <new>, but its stored workspace state belongs to <old>.
// The single-line forms (the stderr migration warning) carry full paths; the
// boxed notes wrap them, and the "Failing check" line is cut short.
const kWorkspaceMovePatterns = [
  /workspace path alias points to a different current target:\s*(.+?) now resolves to (.+?), but its stored workspace state belongs to (.+?)\.(?=\s|$)/i,
  /Workspace path (.+?) now resolves to (.+?), but its saved setup records belong to (.+?)\.(?=\s|$)/i,
];
// The move cases OpenClaw refuses to rebind even when confirmed.
const kWorkspaceMoveBlockedPattern =
  /(The original workspace still exists|The destination already owns workspace records|The destination is not an existing directory|Another workspace path still refers to the original location)[^.]*\./i;
const kWrappedWindowLines = 6;

// shortenHomePath prints $OPENCLAW_HOME/… or ~/…; the card names real paths.
const expandDisplayHome = (value, env) => {
  if (env?.OPENCLAW_HOME && /^\$OPENCLAW_HOME(?=\/|$)/.test(value)) return env.OPENCLAW_HOME + value.slice("$OPENCLAW_HOME".length);
  if (env?.HOME && /^~(?=\/|$)/.test(value)) return env.HOME + value.slice(1);
  return value;
};

const parseWorkspaceMove = (text, { env = null } = {}) => {
  const line = String(text || "");
  for (const pattern of kWorkspaceMovePatterns) {
    const match = line.match(pattern);
    if (!match) continue;
    const [aliasPath, currentPath, storedPath] = match.slice(1, 4).map((value) => expandDisplayHome(value.trim(), env));
    if (!aliasPath || !currentPath || !storedPath) return null;
    return { aliasPath, from: storedPath, to: currentPath };
  }
  return null;
};

const cleanDoctorLine = (line) =>
  stripAnsi(String(line ?? "")).replace(kBoxDrawingPattern, " ").replace(/\s+/g, " ").trim();

const captureCauseFrom = (text) =>
  text.replace(/\.\s+Doctor will continue\b.*$/i, "").replace(/\.$/, "").trim() || null;

const createDoctorOutputFacts = ({ env = null } = {}) => {
  const partials = new Map();
  const windows = new Map();
  let workspaceMoveFromOneLine = false;
  const facts = {
    captureState: "unknown",
    captureCause: null,
    captureManifest: null,
    failingCheck: null,
    atomicReplaceLine: null,
    upgradeWindowRefused: false,
    bridgeVersion: null,
    diskFull: false,
    stateBusy: false,
    workspaceMove: null,
    workspaceMoveBlocked: null,
    lastMeaningfulLine: null,
  };
  let previousLine = "";
  const observeLine = (rawLine, streamName) => {
    const line = cleanDoctorLine(rawLine);
    if (!line) return;
    if (!kStartupTracePattern.test(line)) facts.lastMeaningfulLine = line;
    const recent = windows.get(streamName) || [];
    recent.push(line);
    if (recent.length > kWrappedWindowLines) recent.shift();
    windows.set(streamName, recent);
    const wrapped = recent.join(" ");
    if (!workspaceMoveFromOneLine) {
      const oneLine = parseWorkspaceMove(line, { env });
      if (oneLine) {
        facts.workspaceMove = oneLine;
        workspaceMoveFromOneLine = true;
      } else if (!facts.workspaceMove) {
        facts.workspaceMove = parseWorkspaceMove(wrapped, { env });
      }
    }
    if (!facts.workspaceMoveBlocked) facts.workspaceMoveBlocked = wrapped.match(kWorkspaceMoveBlockedPattern)?.[0] || null;
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
    if (kDiskFullPattern.test(line)) facts.diskFull = true;
    if (kStateBusyPattern.test(line)) facts.stateBusy = true;
  };
  const onOutput = (chunkText, streamName = "stdout") => {
    const lines = `${partials.get(streamName) || ""}${String(chunkText ?? "")}`.split("\n");
    let partial = lines.pop();
    if (partial.length > kPartialLineCapBytes) partial = partial.slice(-kPartialLineCapBytes);
    partials.set(streamName, partial);
    for (const line of lines) observeLine(line, streamName);
  };
  const snapshot = () => {
    for (const [streamName, partial] of partials) {
      if (partial) observeLine(partial, streamName);
      partials.set(streamName, "");
    }
    return { ...facts };
  };
  return { onOutput, snapshot };
};

// A runner result (or a test double) → the one outcome every caller records.
// deterministic: a completed non-zero exit OpenClaw will repeat on the same
// state (atomic-replace refusal, July-2026 window refusal, a failing check).
// transient: everything else that failed (timeout, cancel, signal, a full
// disk (ENOSPC / EDQUOT),
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
  // AlphaClaw's own refusal (doctor-fix-runner.js) carries its sentence; no
  // OpenClaw output exists to quote.
  const rawDetail = result?.code === "insufficient_disk"
    ? String(result.stderr || "")
    : facts.failingCheck || facts.atomicReplaceLine || facts.lastMeaningfulLine || "";
  const detail = redactLine(rawDetail, { secrets, maxLength: kDetailMaxChars }) || null;
  let reason;
  let outcomeClass = "transient";
  if (result?.cancelled) reason = "cancelled";
  else if (result?.timedOut) reason = "timed_out";
  else if (result?.code === "doctor_restored_stale_config") reason = "doctor_restored_stale_config";
  else if (result?.code === "insufficient_disk") reason = "insufficient_disk";
  else if (facts.diskFull) reason = "disk_full";
  else if (facts.stateBusy) reason = "state_busy";
  else if (typeof result?.code !== "number") reason = result?.signal ? `signal_${result.signal}` : "failed";
  else if (facts.upgradeWindowRefused) [reason, outcomeClass] = ["upgrade_window_refused", "deterministic"];
  else if (facts.workspaceMove) [reason, outcomeClass] = ["workspace_moved", "deterministic"];
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
    ...(reason === "workspace_moved"
      ? {
          workspaceMove: {
            ...facts.workspaceMove,
            ...(facts.workspaceMoveBlocked ? { blocked: redactLine(facts.workspaceMoveBlocked, { secrets, maxLength: kDetailMaxChars }) } : {}),
          },
        }
      : {}),
  };
};

module.exports = {
  cleanDoctorLine,
  createDoctorOutputFacts,
  parseWorkspaceMove,
  summarizeDoctorResult,
};
