const {
  kDoctorCardSource,
  kDoctorOpenclawDoctorMaxCards,
  kDoctorOpenclawDoctorMaxFieldChars,
} = require("./constants");

// Bridge to OpenClaw's own machine-readable doctor. `doctor --lint --json` is
// the ONLY cross-version read-only invocation: bare `--json` implies lint on
// the 2026.8.1 beta but NOT on stable 2026.7.1-2 (verified in both tarballs —
// see docs/designs/openclaw-context-contract.md). Exit 0/1 both carry a valid
// payload (findings-threshold semantics); exit 2 is a runtime failure.
//
// Fail-soft by contract: CLI absent, timeout, truncated capture, or an
// unparseable payload produce ZERO cards and never fail the doctor run.
// Upstream findings we already cover deterministically are suppressed so the
// user never sees the same problem twice with different wording.
const kSuppressedCheckIds = new Set([
  // Covered by det:retired:TOOLS.md (deterministic-checks.js).
  "core/doctor/tools-md-migration",
]);
// Best-effort overlap guard for the bootstrap-size note family (its lint
// checkId is not pinned upstream): our bootstrap-context cards own this space.
const isBootstrapSizeOverlap = (finding) =>
  /bootstrap/i.test(String(finding?.checkId || "")) &&
  /(truncat|inject)/i.test(String(finding?.message || ""));

const kSeverityPriority = {
  error: "P0",
  warning: "P1",
  info: "P2",
};

// Tolerant payload extraction: the CLI can prefix/suffix human noise around
// the JSON object. Find the outermost object that parses and carries a
// findings array.
const extractDoctorPayload = (stdout = "") => {
  const text = String(stdout || "");
  const start = text.indexOf("{");
  if (start === -1) return null;
  for (let end = text.length; end > start; end -= 1) {
    if (text[end - 1] !== "}") continue;
    try {
      const parsed = JSON.parse(text.slice(start, end));
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.findings)) {
        return parsed;
      }
    } catch {
      // keep shrinking
    }
  }
  return null;
};

const runOpenclawDoctorBridge = async ({ runLintJson, sanitize }) => {
  let result = null;
  try {
    result = await runLintJson();
  } catch (error) {
    return { ok: false, cards: [], droppedCount: 0, reason: error?.message || "spawn failed" };
  }
  // Exit 2 = runtime failure before findings; a truncated capture is flagged
  // by the runner and treated exactly like an unparseable payload.
  if (!result || result.truncated || Number(result.code) === 2) {
    return { ok: false, cards: [], droppedCount: 0, reason: "unusable doctor output" };
  }
  const payload = extractDoctorPayload(result.stdout);
  if (!payload) {
    return { ok: false, cards: [], droppedCount: 0, reason: "unparseable doctor output" };
  }

  const capField = (value) =>
    sanitize(value, { maxChars: kDoctorOpenclawDoctorMaxFieldChars });

  const mapped = [];
  for (const [index, finding] of payload.findings.entries()) {
    if (!finding || typeof finding !== "object") continue;
    const checkId = capField(finding.checkId || "");
    if (!checkId) continue;
    if (kSuppressedCheckIds.has(checkId) || isBootstrapSizeOverlap(finding)) continue;
    const findingPath = capField(finding.path || "");
    const message = capField(finding.message || "");
    const fixHint = capField(finding.fixHint || "");
    const priority = kSeverityPriority[String(finding.severity || "").toLowerCase()] || "P2";
    const evidence = [];
    if (findingPath) {
      const startLine = Number(finding.line) > 0 ? Number(finding.line) : undefined;
      evidence.push({ type: "path", path: findingPath, ...(startLine ? { startLine } : {}) });
    }
    if (message) evidence.push({ type: "text", text: message });
    mapped.push({
      priority,
      category: "openclaw doctor",
      title: `[${checkId}] ${message || "finding"}`.slice(0, 200),
      summary: message,
      recommendation: fixHint || message,
      evidence,
      targetPaths: findingPath ? [{ path: findingPath }] : [],
      // Template-only fixPrompt: checkId/path are structural identifiers, the
      // free-text message stays in display-only fields.
      fixPrompt:
        `Address the OpenClaw doctor finding ${checkId}` +
        (findingPath ? ` affecting ${findingPath}` : "") +
        ". Run `openclaw doctor --lint --json` to see the finding, apply the smallest safe fix, " +
        "and re-run it to verify the finding clears.",
      status: "open",
      source: kDoctorCardSource.openclawDoctor,
      sourceKey: `ocd:${checkId}:${findingPath || index}`,
    });
  }

  // Hard cap, P0/P1 first (stable order within a priority band) — and the
  // drop is logged by the caller, never silent.
  const bandRank = { P0: 0, P1: 1, P2: 2 };
  mapped.sort((a, b) => bandRank[a.priority] - bandRank[b.priority]);
  const cards = mapped.slice(0, kDoctorOpenclawDoctorMaxCards);
  return {
    ok: true,
    cards,
    droppedCount: mapped.length - cards.length,
  };
};

module.exports = {
  extractDoctorPayload,
  runOpenclawDoctorBridge,
};
