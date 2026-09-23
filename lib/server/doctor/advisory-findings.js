// Structured Doctor finding → watchdog readiness advisory (#87, plan B3/X6).
//
// The watchdog used to grep Doctor PROSE for /secret/ + /fail|degrad|…/ —
// a regex that never demonstrated a real upstream match and could fire on
// unrelated wording. This helper reads the structured findings payload that
// usable Doctor output carries (`{ findings: [...] }`, extracted via the
// classifier's shared validator) and answers ONE question: does OpenClaw's
// own Doctor report a RUNTIME secret failure that explains a not-ready
// gateway? Config-hygiene findings (plaintext secrets in config) are Drift
// Doctor's job and never become a readiness advisory.
//
// Two upstream finding shapes exist (verified read-only against the OpenClaw
// 2026.9.3 tarball, 2026-09-10) — both are accepted:
//
//   (1) security-audit shape: { checkId, severity: "info"|"warn"|"critical",
//       title, detail, remediation }
//         gateway.probe_auth_secretref_unavailable   → runtime (the gateway
//                                                      could not resolve a
//                                                      SecretRef at probe time)
//         config.plaintext_secrets                   → hygiene
//         config.secrets.gateway_password_in_config  → hygiene
//         config.secrets.hooks_token_in_config       → hygiene
//
//   (2) doctor-lint shape: { checkId, severity: "info"|"warning"|"error",
//       message, path?, line?, fixHint? }
//         core/doctor/gateway-health|gateway-auth|gateway-config|security
//         with a message naming a SecretRef AND an unavailability verb
//         (unavailable / unresolved / could not / cannot / failed / missing /
//         not resolved …) → runtime (doctor-lint's gateway checks import
//         isGatewaySecretRefUnavailableError, so a runtime SecretRef failure
//         can surface under these generic ids). A bare mention — "consider a
//         SecretRef" hygiene advice under a gateway id — is NOT a runtime
//         failure and never becomes a readiness advisory (#87 F6).
//
// Output is gateway-influenced text bound for an event row, so `checkId` is
// admitted only when it matches kStructuralCheckIdPattern (else "unknown")
// and `message` runs through the shared Doctor text sanitizer (control chars
// stripped, secret values redacted, kDoctorNotifyMaxLineChars surrogate-safe
// cap, one line) and then the shape redactor (the gateway-medic bar: tokens
// that live in no store — `sk-ant-…`, JWTs, Bearer values — are masked by
// shape). Nothing here restarts, repairs, or notifies — the watchdog logs
// the finding as advisory evidence only.
const { extractFindingsPayload } = require("./classify-doctor-cli");
const { kStructuralCheckIdPattern, kDoctorNotifyMaxLineChars } = require("./constants");
const { createDoctorTextSanitizer } = require("./sanitize");
const { redactSecretShapes } = require("../utils/redact");

// One cap for every Doctor line that reaches an event row or a notice.
const kAdvisoryMessageMaxChars = kDoctorNotifyMaxLineChars;
// Bound the ids echoed in the hygiene_only console line.
const kMaxHygieneCheckIds = 10;

const kSeverityByUpstreamValue = {
  error: "error",
  critical: "error",
  warn: "warning",
  warning: "warning",
  info: "info",
};
const kAdvisorySeverities = new Set(["error", "warning"]);

// Generic doctor-lint gateway ids under which a runtime SecretRef failure can
// land; the message must name a SecretRef AND say it is unavailable for the
// rule to apply (#87 F6 — a hygiene "consider a SecretRef" under one of these
// ids is not a failure).
const kCoreDoctorGatewayCheckIds = new Set([
  "core/doctor/gateway-health",
  "core/doctor/gateway-auth",
  "core/doctor/gateway-config",
  "core/doctor/security",
]);
const kSecretCheckIdPattern = /secret/i;
const kSecretRefMessagePattern = /secret\s*ref/i;
const kSecretRefUnavailableMessagePattern =
  /(unavailable|unresolved|could not|cannot|couldn't|failed|failing|missing|not (?:be )?resolv)/i;
const kRuntimeCheckIdPattern = /secretref|unavailable/i;

// The factory builds its redactor lazily (first call, 30 s TTL), so a
// module-scope instance costs nothing at require time.
const defaultSanitizer = createDoctorTextSanitizer();

const normalizeSeverity = (raw) =>
  kSeverityByUpstreamValue[String(raw ?? "").trim().toLowerCase()] || "unknown";

// Both shapes → { checkId, severity, message }. Non-object entries → null.
const normalizeFinding = (finding) => {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    return null;
  }
  return {
    checkId: typeof finding.checkId === "string" ? finding.checkId.trim() : "",
    severity: normalizeSeverity(finding.severity),
    message:
      [finding.message, finding.detail, finding.title].find(
        (v) => typeof v === "string" && v.trim(),
      ) ?? "",
  };
};

// "runtime" | "hygiene" for a secret-related finding; null when the finding
// is not about secrets at all. A SecretRef mention in the message counts ONLY
// under the generic core/doctor gateway ids, and only when the same message
// says the ref is unavailable (#87 F6) — a plaintext-secret hygiene finding
// whose remediation says "use a SecretRef" stays hygiene, and a gateway-id
// hygiene hint ("consider a SecretRef") is not secret-related at all.
const classifySecretKind = ({ checkId, message }) => {
  if (
    kCoreDoctorGatewayCheckIds.has(checkId) &&
    kSecretRefMessagePattern.test(message) &&
    kSecretRefUnavailableMessagePattern.test(message)
  ) {
    return "runtime";
  }
  if (!kSecretCheckIdPattern.test(checkId)) return null;
  return kRuntimeCheckIdPattern.test(checkId) ? "runtime" : "hygiene";
};

const structuralCheckId = (checkId) =>
  kStructuralCheckIdPattern.test(checkId) ? checkId : "unknown";

// strip → value-redact → shape-redact → cap. The shape pass runs on the
// control-stripped, single-line text (an escape inside a token would defeat
// the pattern) and BEFORE the cap (a token split at the cap would escape it).
const advisoryMessage = (message, sanitize) =>
  sanitize(redactSecretShapes(sanitize(message, { singleLine: true })), {
    maxChars: kAdvisoryMessageMaxChars,
    singleLine: true,
  });

// Full classification, for callers that log WHY nothing was emitted:
//   { finding: <advisory>|null,
//     reason: "no_payload" | "no_finding" | "hygiene_only" | "found",
//     hygieneCheckIds: string[] }   (structural ids only, deduped, capped)
const classifySecretFindings = (
  doctorText,
  { sanitize = defaultSanitizer.sanitize } = {},
) => {
  const payload = extractFindingsPayload(doctorText);
  if (!payload) return { finding: null, reason: "no_payload", hygieneCheckIds: [] };
  const hygieneCheckIds = [];
  let finding = null;
  for (const raw of payload.findings) {
    const normalized = normalizeFinding(raw);
    if (!normalized) continue;
    const kind = classifySecretKind(normalized);
    if (!kind) continue;
    if (kind === "hygiene") {
      const id = structuralCheckId(normalized.checkId);
      if (
        hygieneCheckIds.length < kMaxHygieneCheckIds &&
        !hygieneCheckIds.includes(id)
      ) {
        hygieneCheckIds.push(id);
      }
      continue;
    }
    if (finding || !kAdvisorySeverities.has(normalized.severity)) continue;
    finding = {
      checkId: structuralCheckId(normalized.checkId),
      severity: normalized.severity,
      kind: "runtime",
      component: "secrets",
      message: advisoryMessage(normalized.message, sanitize),
    };
  }
  if (finding) return { finding, reason: "found", hygieneCheckIds };
  return {
    finding: null,
    reason: hygieneCheckIds.length > 0 ? "hygiene_only" : "no_finding",
    hygieneCheckIds,
  };
};

// The first runtime secret finding with severity error|warning, or null.
const extractSecretRuntimeFinding = (doctorText, options) =>
  classifySecretFindings(doctorText, options).finding;

module.exports = {
  classifySecretFindings,
  extractSecretRuntimeFinding,
};
