// OpenClaw Project Context contract, per version line.
//
// Single source of truth for what OpenClaw injects into the agent's system
// prompt and under which budgets. Every fact below was verified against the
// published npm tarballs (`npm pack openclaw@<version>`, dist/ + docs/) —
// citations name the package version and the dist symbol. Re-verify on each
// upstream release adoption: see docs/designs/openclaw-context-contract.md
// ("Re-verification checklist"). The profile fact-snapshot tests
// (tests/server/doctor-context-profiles.test.js) are the checked-in golden
// fixtures for these values.
//
// Verified packages: openclaw@2026.7.1-2 (pinned stable),
// openclaw@2026.8.1-beta.1 and @2026.8.1-beta.3 (beta line).

// Shared budgets — identical on stable and beta:
// - DEFAULT_BOOTSTRAP_MAX_CHARS = 2e4 (stable dist/embedded-agent-helpers,
//   beta dist/bootstrap-*.js)
// - DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS = 6e4 (same modules; NOT 150k)
// - DEFAULT_BOOTSTRAP_NEAR_LIMIT_RATIO = .85 (dist/bootstrap-budget-*.js)
// - MIN_BOOTSTRAP_FILE_BUDGET_CHARS = 64: files with less remaining total
//   budget are skipped entirely with a warning.
// Config overrides: agents.defaults.bootstrapMaxChars / bootstrapTotalMaxChars
// (per-agent overrides exist upstream; the doctor honors the defaults keys).
const kDoctorBootstrapMaxChars = 20000;
const kDoctorBootstrapTotalMaxChars = 60000;
const kDoctorBootstrapNearLimitRatio = 0.85;
// USER.md hard cap — beta line only, NOT configurable upstream
// (USER_BOOTSTRAP_MAX_CHARS = 4e3, first shipped in 2026.8.1-beta.1).
const kDoctorUserBootstrapMaxChars = 4000;
const kDoctorBootstrapMinFileBudgetChars = 64;

// Truncation behavior (both versions): keeps ~75% head / ~25% tail of the
// marker-adjusted budget and inserts a VISIBLE in-file marker
// ("[...truncated, read <file> for full content...]"); AGENTS.md uses a
// special 45% head + 35% policy-digest + 15% tail algorithm; an agent-visible
// "[Bootstrap truncation warning]" block is injected alongside. Truncation is
// NOT silent. (dist/bootstrap-*.js BOOTSTRAP_HEAD_RATIO/.75,
// BOOTSTRAP_TAIL_RATIO/.25, AGENTS_POLICY_* ratios; bootstrap-budget-*.js.)
const kDoctorContextTruncationGuidance =
  "OpenClaw trims an oversized injected file to roughly its first 75% and last 25% " +
  "of the budget with a visible in-file truncation marker (AGENTS.md instead keeps a " +
  "45% head, a 35% policy digest extracted from the middle, and a 15% tail), and it " +
  "always injects a bootstrap-truncation warning so the agent knows context is partial.";

// Weight-4 paths that are not injected bootstrap files but are still
// high-signal guidance for drift scoring (README is a doctor review target).
const kDoctorExtraHighSignalPaths = ["readme.md"];

const kStableProfile = Object.freeze({
  id: "stable-2026.7",
  // Injection order matters: the total budget is spent in order, later files
  // (and hook extras, appended last) starve first.
  // stable dist/workspace-*.js loadWorkspaceBootstrapFiles order.
  injectedRootFiles: Object.freeze([
    "AGENTS.md",
    "SOUL.md",
    "TOOLS.md",
    "IDENTITY.md",
    "USER.md",
    "HEARTBEAT.md",
    "BOOTSTRAP.md",
    "MEMORY.md",
  ]),
  // Files whose absence is expected (skipped silently when missing).
  // stable dist/workspace-*.js: MEMORY.md skipped when absent; SOUL/IDENTITY/
  // USER/HEARTBEAT are "optional" seeds. AGENTS.md missing renders [MISSING].
  optionalRootFiles: Object.freeze([
    "SOUL.md",
    "IDENTITY.md",
    "USER.md",
    "HEARTBEAT.md",
    "MEMORY.md",
  ]),
  retiredRootFiles: Object.freeze([]),
  // bootstrap-extra-files basename allowlist — stable VALID_BOOTSTRAP_NAMES
  // (stable dist/workspace-*.js): 8 names.
  allowedExtraBasenames: Object.freeze([
    "AGENTS.md",
    "SOUL.md",
    "TOOLS.md",
    "IDENTITY.md",
    "USER.md",
    "HEARTBEAT.md",
    "BOOTSTRAP.md",
    "MEMORY.md",
  ]),
  userFileCapChars: null,
  // Session-scope filtering (stable dist/workspace-*.js
  // filterBootstrapFilesForSession): informs the doctor prompt only.
  sessionScopeNotes: Object.freeze([
    "Sub-agent sessions inject only AGENTS.md and TOOLS.md.",
    "Cron sessions inject AGENTS.md, TOOLS.md, SOUL.md, IDENTITY.md, and USER.md only (not HEARTBEAT.md).",
    "Group and channel sessions never receive the root MEMORY.md.",
  ]),
});

const kBeta81Profile = Object.freeze({
  id: "beta-2026.8.1",
  // beta dist/workspace-*.js WORKSPACE_BOOTSTRAP_FILENAMES (6 names, verified
  // identical in 2026.8.1-beta.1 and beta.3). TOOLS.md and HEARTBEAT.md are
  // retired: never injected, and TOOLS.md is no longer an accepted
  // bootstrap-extra-files basename (invalid-bootstrap-filename diagnostic).
  injectedRootFiles: Object.freeze([
    "AGENTS.md",
    "SOUL.md",
    "IDENTITY.md",
    "USER.md",
    "BOOTSTRAP.md",
    "MEMORY.md",
  ]),
  optionalRootFiles: Object.freeze(["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"]),
  retiredRootFiles: Object.freeze(["TOOLS.md", "HEARTBEAT.md"]),
  // beta VALID_BOOTSTRAP_NAMES = the six injected names.
  allowedExtraBasenames: Object.freeze([
    "AGENTS.md",
    "SOUL.md",
    "IDENTITY.md",
    "USER.md",
    "BOOTSTRAP.md",
    "MEMORY.md",
  ]),
  userFileCapChars: kDoctorUserBootstrapMaxChars,
  sessionScopeNotes: Object.freeze([
    "Sub-agent sessions inject only AGENTS.md — guidance that must reach sub-agents belongs there.",
    "Cron sessions inject AGENTS.md, SOUL.md, IDENTITY.md, and USER.md only.",
    "Group and channel sessions never receive the root MEMORY.md.",
  ]),
});

// Skills prompt cost model (beta docs/tools/skills.md): ~97 chars fixed
// overhead per listed skill plus name/description/location lengths; limits
// skills.limits.maxSkillsInPrompt = 150 and maxSkillsPromptChars = 18000
// (beta dist/skill-prompt-limits-*.js). Used by the deterministic
// skills-bloat estimate; stable ships the same defaults.
const kDoctorSkillPromptOverheadChars = 97;
const kDoctorSkillsMaxInPrompt = 150;
const kDoctorSkillsMaxPromptChars = 18000;

// Fingerprint drift weights, derived from the active profile: injected root
// files and hook extras are the highest-signal paths; skills affect the
// prompt; daily memory files churn constantly by design and must not
// perpetually trip the stale banner (weight 1).
const buildProfilePathWeights = (profile) => {
  const weights = new Map();
  for (const name of profile.injectedRootFiles) {
    weights.set(name.toLowerCase(), 4);
  }
  for (const name of kDoctorExtraHighSignalPaths) {
    weights.set(name, 4);
  }
  // Retired files are ordinary docs on this profile — generic .md weight.
  for (const name of profile.retiredRootFiles) {
    weights.set(name.toLowerCase(), 2);
  }
  return weights;
};

const kProfilePathWeights = new Map([
  [kStableProfile.id, buildProfilePathWeights(kStableProfile)],
  [kBeta81Profile.id, buildProfilePathWeights(kBeta81Profile)],
]);

const getProfilePathChangeWeight = (profile, relativePath = "") => {
  const normalizedPath = String(relativePath || "").trim().toLowerCase();
  if (!normalizedPath) return 1;
  const weights =
    kProfilePathWeights.get(profile?.id) || kProfilePathWeights.get(kStableProfile.id);
  const rootWeight = weights.get(normalizedPath);
  if (rootWeight) return rootWeight;
  if (normalizedPath.startsWith("hooks/bootstrap/")) return 4;
  if (normalizedPath.startsWith("skills/")) return 3;
  // Daily memory notes are the agent's working layer — churn is expected and
  // not "guidance drift" (they are never injected; memory tools read them).
  if (normalizedPath.startsWith("memory/")) return 1;
  if (normalizedPath.endsWith(".md")) return 2;
  return 1;
};

// Profile selection: fail closed to the stable profile (unknown, unreadable,
// or dev-sha versions — same doctrine as the feature gates themselves). The
// gate is a monotonic minimum by repo convention: it means "the 2026.8.1
// contract or newer, until a newer profile is added here".
const selectDoctorContextProfile = ({ supportsFeature } = {}) => {
  try {
    if (typeof supportsFeature === "function" && supportsFeature("bootstrapContractV2")) {
      return kBeta81Profile;
    }
  } catch {
    // fall through to stable
  }
  return kStableProfile;
};

module.exports = {
  getProfilePathChangeWeight,
  kBeta81Profile,
  kDoctorBootstrapMaxChars,
  kDoctorBootstrapMinFileBudgetChars,
  kDoctorBootstrapNearLimitRatio,
  kDoctorBootstrapTotalMaxChars,
  kDoctorContextTruncationGuidance,
  kDoctorSkillPromptOverheadChars,
  kDoctorSkillsMaxInPrompt,
  kDoctorSkillsMaxPromptChars,
  kDoctorUserBootstrapMaxChars,
  kStableProfile,
  selectDoctorContextProfile,
};
