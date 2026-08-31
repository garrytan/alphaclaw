const kDoctorPromptVersion = "doctor-v2";
const kDoctorRunStatus = {
  running: "running",
  completed: "completed",
  failed: "failed",
};
const kDoctorCardStatus = {
  open: "open",
  working: "working",
  dismissed: "dismissed",
  fixed: "fixed",
};
const kDoctorPriority = {
  P0: "P0",
  P1: "P1",
  P2: "P2",
};
const kDoctorEngine = {
  gatewayAgent: "gateway_agent",
  manualImport: "manual_import",
  deterministicReuse: "deterministic_reuse",
};
// AlphaClaw's managed prompt-hardening extras live under this workspace
// prefix — load-bearing for the P0 hardening card, the General-tab badge,
// and the weight-4 drift scoring. One constant, several consumers.
const kAlphaclawHardeningPrefix = "hooks/bootstrap/";
// Canonical closed list of hardening reason values the bootstrap-context
// model can emit (per-file `reason`/`activeReason` plus the top-level
// hardening.reason values that describe absent files). The frontend copy map
// (lib/public/js/lib/hardening-reasons.js) must cover every value here — its
// coverage test imports THIS list, so drift fails CI instead of relying on
// keep-in-sync comments. `config_unreadable` is deliberately absent: it is a
// state-level reason (hardening.state === "unknown") owned by the badge copy,
// never a per-file cause.
const kHardeningReasonValues = [
  "file_limit",
  "total_limit",
  "file_and_total_limit",
  "starved",
  "invalid_basename",
  "hook_disabled",
  "escapes_workspace",
  "file_too_large",
  "not_configured",
  "missing_file",
  "pattern_unmodeled",
];
// Card provenance: which subsystem produced a card. LLM cards have no
// source_key; sourced cards carry a stable one for dedupe/notify semantics.
const kDoctorCardSource = {
  llm: "llm",
  bootstrap: "bootstrap",
  deterministic: "deterministic",
  openclawDoctor: "openclaw_doctor",
};
// Category enumeration shared by the prompt and the UI tone map — the LLM is
// told to pick from these; unknown values fall back to "workspace" downstream.
const kDoctorCardCategories = [
  "project context",
  "token efficiency",
  "redundancy",
  "mixed concerns",
  "workspace state",
  "memory hygiene",
  "skills",
  "stale guidance",
  "contradiction",
  "openclaw doctor",
];
const kDoctorStaleThresholdMs = 7 * 24 * 60 * 60 * 1000;
const kDoctorMeaningfulChangeScoreThreshold = 4;
const kDoctorRunTimeoutMs = 10 * 60 * 1000;
const kDoctorDefaultRunsLimit = 10;
const kDoctorMaxRunsLimit = 50;
const kDoctorMaxCardsPerRun = 12;
// `openclaw doctor --lint --json` bridge (workstream C).
const kDoctorOpenclawDoctorTimeoutMs = 60 * 1000;
const kDoctorOpenclawDoctorMaxCards = 20;
const kDoctorOpenclawDoctorMaxCaptureBytes = 1024 * 1024;
const kDoctorOpenclawDoctorMaxFieldChars = 500;
// Scheduled scans (E3): opt-in, default off.
const kDoctorAutoRunTickMs = 15 * 60 * 1000;
const kDoctorAutoRunMinIntervalMs = 6 * 60 * 60 * 1000;
const kDoctorAutoRunFailureBackoffMs = 24 * 60 * 60 * 1000;
// Notification content caps (E2): every line is redacted, escaped, and capped.
const kDoctorNotifyMaxLineChars = 200;
const kDoctorNotifyMaxFindings = 3;

module.exports = {
  kAlphaclawHardeningPrefix,
  kHardeningReasonValues,
  kDoctorPromptVersion,
  kDoctorRunStatus,
  kDoctorCardStatus,
  kDoctorPriority,
  kDoctorEngine,
  kDoctorCardSource,
  kDoctorCardCategories,
  kDoctorStaleThresholdMs,
  kDoctorMeaningfulChangeScoreThreshold,
  kDoctorRunTimeoutMs,
  kDoctorDefaultRunsLimit,
  kDoctorMaxRunsLimit,
  kDoctorMaxCardsPerRun,
  kDoctorOpenclawDoctorTimeoutMs,
  kDoctorOpenclawDoctorMaxCards,
  kDoctorOpenclawDoctorMaxCaptureBytes,
  kDoctorOpenclawDoctorMaxFieldChars,
  kDoctorAutoRunTickMs,
  kDoctorAutoRunMinIntervalMs,
  kDoctorAutoRunFailureBackoffMs,
  kDoctorNotifyMaxLineChars,
  kDoctorNotifyMaxFindings,
};
