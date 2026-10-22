// Pure crash-cause / exit description helpers for the watchdog exit handler.
const { kCorroboratedGatewayCrashCauses } = require("./gateway-crash-cause");
const { kStateMigrationRefusalPattern } = require("./gateway-exit-signatures");
const { asInlineCode } = require("./watchdog-format");

// Exit copy covers all three shapes (codex-eng #7): numeric code, signal
// name, or neither (rare handler edge) — never "exit undefined".
const describeExit = (code, signal) =>
  code !== null && code !== undefined
    ? `exit ${code}`
    : signal
      ? `signal ${signal}`
      : "unexpectedly";
// Model output is derived from UNTRUSTED gateway stderr; before it rides a
// trusted-looking watchdog notification, strip anything that could carry a
// social-engineering payload (links, markdown link syntax) and label it as
// machine-generated.
const sanitizeModelDiagnosis = (diagnosis) => {
  const text = String(diagnosis || "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\bhttps?:\/\/\S+/gi, "[link removed]")
    .replace(/\s+/g, " ")
    .trim();
  return text ? `Model-suggested diagnosis (unverified): ${text}` : null;
};
// The matched wording of a state-migration EX_CONFIG refusal (pattern at
// module scope, shared with gateway-crash-cause.js), or null.
const detectStateMigrationRefusal = (stderrTail = []) => {
  const text = (Array.isArray(stderrTail) ? stderrTail : [])
    .map((line) => String(line ?? ""))
    .join("\n");
  const match = kStateMigrationRefusalPattern.exec(text);
  return match ? match[0] : null;
};
// OOM classification (autotune): two distinct failure shapes with OPPOSITE
// remediations — a V8 heap abort wants a bigger heap (when the box has
// headroom), a kernel/container OOM kill (exit 137 / SIGKILL) means the box
// itself is out of memory and raising the heap makes it WORSE. The
// remediation command is machine-derived and omitted when no headroom
// exists. Fire-and-forget: classification never delays crash handling, and
// notifyOncePerIncident keeps a crash loop from spamming the channel.
// Only the unexpected-exit resolvers (handleConfigErrorExit /
// handleCrashExit) schedule it — benign step-aside, accepted-handoff,
// expected, managed, and duplicate-launch exits are never OOM-classified.
// The heap signature itself (kHeapOomPattern) lives at module scope.
// Shared remedy derivation (OOM classifier + the memory monitor's critical
// notification) so the two paths can't drift: suggest a heap raise only
// when the autotune ceiling leaves room; at the ceiling, raising the heap
// trades a V8 abort for a kernel OOM kill.
const deriveHeapOomRemedy = () => {
  let remedy =
    "Enable resource autotune (Watchdog tab) so the gateway heap is sized to this machine.";
  try {
    const {
      getActiveGatewayHeapMb,
      maxGatewayHeapMbFor,
    } = require("./autotune");
    const { getMachineProfile } = require("./machine-profile");
    const active = getActiveGatewayHeapMb();
    const memMb = Math.round(
      (getMachineProfile()?.memory?.limitBytes || 0) / (1024 * 1024),
    );
    if (active != null && memMb > 0) {
      // Same ceiling autotune enforces on overrides — a suggestion
      // above it would be clamped back on apply.
      const ceiling = maxGatewayHeapMbFor(memMb);
      const suggested = Math.min(Math.round(active * 1.25), ceiling);
      remedy =
        suggested > active
          ? `Raise the gateway heap: \`alphaclaw admin PUT /api/autotune/settings --data '{"overrides":{"gatewayHeapMb":${suggested}}}'\` (or set it on the Autotune card in the Watchdog tab), then restart the gateway.`
          : `This container is at its memory limit (${memMb}MB) — raising the heap would trade a V8 abort for a kernel OOM kill. Upgrade the container's memory plan.`;
    }
  } catch {}
  return remedy;
};
const causeIsCorroboratable = (cause) =>
  kCorroboratedGatewayCrashCauses.includes(cause);
// Details stamped on the crash / crash_loop / config_error rows.
const causeRowDetails = (classified) =>
  classified
    ? {
        cause: classified.cause,
        fingerprint: classified.fingerprint,
        ...(causeIsCorroboratable(classified.cause)
          ? { suspectedCause: classified.cause }
          : {}),
      }
    : {};
// lastExit gains the cause and its corroboration state (null = pending or
// nothing to corroborate).
const causeExitFields = (classified) => ({
  cause: classified?.cause ?? null,
  corroborated: null,
});
// Notice context line: the operator hears the suspicion, never a claim.
const suspectedCauseLines = (classified) =>
  classified && classified.cause !== "unknown"
    ? [`Suspected cause: ${asInlineCode(classified.cause)}`]
    : [];
// Ledger/status shape of an ownership conflict: the family plus what the
// stderr line named about the holder — never the stderr text itself.
const describeConflict = (conflict) => ({
  kind: conflict.kind,
  holderPid: conflict.holderPid ?? null,
  holderRole: conflict.holderRole ?? null,
  // owner_lease_held only: the lease's recorded facts (state DB, not stderr).
  ...(conflict.lease ? { lease: conflict.lease } : {}),
});

module.exports = {
  describeExit,
  sanitizeModelDiagnosis,
  detectStateMigrationRefusal,
  deriveHeapOomRemedy,
  causeIsCorroboratable,
  causeRowDetails,
  causeExitFields,
  suspectedCauseLines,
  describeConflict,
};
