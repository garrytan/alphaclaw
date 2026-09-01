// Classifies an `openclaw doctor` invocation's outcome into three states:
//
//   "usable"      — the run produced doctor output worth consuming
//                   (reason "findings" = structured lint payload;
//                    reason "legacy"  = the pinned stable's legitimate
//                    non-structured output — clean exit, real content)
//   "unavailable" — the CLI ITSELF could not run. Says NOTHING about gateway
//                   health (the 2026-09-01 incident: doctor crashed on a
//                   plugin-surface bug ~530x/day and its stderr was read as
//                   gateway evidence). Gateway health stays HTTP/TCP-probe
//                   driven — this classification only stops a broken tool
//                   from polluting evidence and status.
//   "unusable"    — the CLI ran but this capture can't be trusted (timeout —
//                   possibly just a busy upstream lease — or truncation).
//
// Precedence is FINDINGS-FIRST by design (reviewed twice, cross-model): a
// run that produced a findings payload is usable even when interleaved noise
// contains an error envelope or crash-shaped text — otherwise plugin chatter
// could manufacture a false doctor outage. Envelope/crash-text checks are
// additionally gated on ok === false.
//
// Two producers feed this, with structurally different result shapes — use
// the matching adapter, never hand-rolled fields:
//   - classifyFromRunStream: runOpenclawDoctorLintJson (merged stdout+stderr
//     tail, spawn error and timedOut passed through since this change)
//   - classifyFromClawCmd:   clawCmd (resolves-never-rejects; missing binary
//     = ok:false code 127; NOTE: maxBuffer overflow also reads as timedOut —
//     Node sets killed+SIGTERM for both)
// Verified against openclaw 2026.7.1-2 (stable pin) and 2026.9.1-beta.1.
const {
  parseJsonValueFromNoisyOutput,
  parseCliErrorReport,
} = require("../utils/json");

const kCliStartupCrashPattern = /Could not start the CLI/i;

const extractFindingsPayload = (stdout) =>
  parseJsonValueFromNoisyOutput(String(stdout ?? ""), {
    validate: (parsed) =>
      Boolean(parsed) &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Array.isArray(parsed.findings),
  });

// Bootstrap-level failure detection shared with the capabilities guard: the
// plain startup-crash text, or a cli_error envelope whose message reads like
// the CLI failing to come up at all (vs a sub-command failing).
const matchesCliStartupFailure = (text) => {
  const raw = String(text ?? "");
  if (!raw) return false;
  if (kCliStartupCrashPattern.test(raw)) return true;
  const report = parseCliErrorReport(raw);
  return Boolean(
    report &&
      report.error.type === "cli_error" &&
      /could not start|failed to start|bundled plugin|public surface|cannot load|startup/i.test(
        report.error.message,
      ),
  );
};

const classifyDoctorCliResult = ({
  ok = false,
  code = null,
  stdout = "",
  stderr = "",
  timedOut = false,
  truncated = false,
  spawnError = null,
} = {}) => {
  const out = String(stdout ?? "");
  const err = String(stderr ?? "");
  const combined = err ? `${out}\n${err}` : out;
  // Only CLEAN captures can be trusted payload-first: a truncated or
  // timed-out tail may contain a complete-LOOKING object that misrepresents
  // the run ("parsers skip rather than misread" — the runner contract), and
  // exit 2 is the CLI's own verdict that it failed before findings.
  const cleanCapture = !truncated && !timedOut && Number(code) !== 2;

  // (1) A findings payload in a clean capture wins outright — the CLI
  // demonstrably worked, even when interleaved noise contains an error
  // envelope or crash-shaped text (the manufactured-outage guard).
  const payload = cleanCapture ? extractFindingsPayload(out) : null;
  if (payload) {
    return { status: "usable", reason: "findings", payload };
  }
  // (2) The pinned stable's legitimate legacy shape: clean exit, real
  // output, no failure envelope. Evidence-grade (the bridge still requires a
  // findings array before minting cards). Crash-shaped TEXT is deliberately
  // not excluded here: heuristics never override the CLI's own success exit
  // (a report that merely QUOTES a crash line must stay usable).
  if (
    ok === true &&
    cleanCapture &&
    combined.trim() &&
    !parseCliErrorReport(combined)
  ) {
    return { status: "usable", reason: "legacy" };
  }
  // (3) The process never ran.
  if (spawnError) {
    return {
      status: "unavailable",
      reason: "spawn_failed",
      detail: String(spawnError?.message || spawnError).slice(0, 300),
    };
  }
  // (4) cli_error envelope — exact type, only on a failed run with no usable
  // payload (both gates prevent manufactured outages from noise).
  if (ok === false) {
    const report = parseCliErrorReport(combined);
    if (report && report.error.type === "cli_error") {
      return {
        status: "unavailable",
        reason: "cli_error",
        detail: report.error.message.slice(0, 300),
      };
    }
    // (5) Plain-text startup crash (the incident's shape when the envelope
    // is mangled by interleaving).
    const crashLine = combined
      .split("\n")
      .find((line) => kCliStartupCrashPattern.test(line));
    if (crashLine) {
      return {
        status: "unavailable",
        reason: "cli_startup_crash",
        detail: crashLine.trim().slice(0, 300),
      };
    }
  }
  // (6) Timeout: possibly a busy upstream state-lifecycle lease — NOT proof
  // the CLI is broken.
  if (timedOut) return { status: "unusable", reason: "timeout" };
  // (7) Truncated capture: skip, don't misread.
  if (truncated) return { status: "unusable", reason: "truncated" };
  // (8) Exit 2 = runtime failure before findings (repo contract for our
  // fixed-args invocations, lib/server.js doctrine; distinct reason keeps it
  // auditable against future CLI semantics changes).
  if (Number(code) === 2) {
    return { status: "unavailable", reason: "exit_2" };
  }
  // Defaults: a failed run with no recognizable payload is an unavailable
  // CLI; a clean run with NO output at all is an untrustworthy capture.
  if (ok === false) {
    return {
      status: "unavailable",
      reason: "nonzero_exit",
      detail: `exit code ${code}`,
    };
  }
  return { status: "unusable", reason: "no_payload" };
};

// Adapter for runOpenclawDoctorLintJson (runStreamed-backed): merged
// stdout+stderr tail arrives as `stdout`; spawn errors and timeouts are
// passed through as their own fields (they were folded into `truncated`
// before this change — which made the timeout branch unreachable).
const classifyFromRunStream = (result = {}) =>
  classifyDoctorCliResult({
    ok: !!result.ok,
    code: result.code ?? null,
    stdout: result.stdout ?? "",
    stderr: "",
    timedOut: !!result.timedOut,
    truncated: !!result.truncated,
    spawnError: result.error || null,
  });

// Adapter for clawCmd (exec-backed, resolves-never-rejects): split streams,
// timedOut derived from killed+killSignal (maxBuffer overflow included),
// missing binary surfaces as ok:false code 127 — never a spawnError.
const classifyFromClawCmd = (result = {}) =>
  classifyDoctorCliResult({
    ok: !!result.ok,
    code: result.code ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: !!result.timedOut,
    truncated: false,
    spawnError: null,
  });

module.exports = {
  classifyDoctorCliResult,
  classifyFromRunStream,
  classifyFromClawCmd,
  matchesCliStartupFailure,
};
