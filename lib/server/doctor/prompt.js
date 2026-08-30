const { kDoctorCardCategories } = require("./constants");
const {
  kDoctorBootstrapMaxChars,
  kDoctorBootstrapMinFileBudgetChars,
  kDoctorBootstrapTotalMaxChars,
  kDoctorContextTruncationGuidance,
  kStableProfile,
} = require("./context-profiles");

const renderList = (items = []) =>
  items.length ? items.map((item) => `- ${item}`).join("\n") : "- (none)";

const renderFileList = (files = []) => files.map((file) => `\`${file}\``).join(", ");

const renderHistoricalCards = (cards = []) => {
  if (!cards.length) return "";
  const dismissedLines = cards
    .filter((card) => card?.status === "dismissed")
    .map(
      (card) =>
        `- [${card.status}] ${card.title}` +
        (card.category ? ` (${card.category})` : ""),
    );
  const fixedLines = cards
    .filter((card) => card?.status === "fixed")
    .map(
      (card) =>
        `- [${card.status}] ${card.title}` +
        (card.category ? ` (${card.category})` : ""),
    );
  const sections = [];
  if (dismissedLines.length) {
    sections.push(
      `Previously dismissed findings (do not re-suggest these):\n${dismissedLines.join("\n")}`,
    );
  }
  if (fixedLines.length) {
    sections.push(
      `Previous findings marked as fixed (context only; re-suggest them if they are still present):\n${fixedLines.join("\n")}`,
    );
  }
  if (!sections.length) return "";
  return `

${sections.join("\n\n")}
`;
};

// The context-injection facts below are generated from the active profile
// (lib/server/doctor/context-profiles.js — tarball-verified per version).
const renderContextInjectionBlock = ({
  profile,
  bootstrapContext,
  installedVersion,
  releaseChannel,
}) => {
  // Only extras that are actually injected on this version (configured,
  // enabled hook, allowed basename) — listing blocked/disabled extras as
  // injected would hand the LLM a false contract. Fallbacks come from the
  // profile constants module, never re-hardcoded literals.
  const allExtras = (bootstrapContext?.files || []).filter(
    (file) => file.kind === "extra",
  );
  const injectedExtraPaths = allExtras
    .filter((file) => file.active && file.injectable && file.exists)
    .map((file) => file.path);
  const nonInjectedExtraCount = allExtras.length - injectedExtraPaths.length;
  const perFileMax = bootstrapContext?.bootstrapMaxChars || kDoctorBootstrapMaxChars;
  const totalMax =
    bootstrapContext?.bootstrapTotalMaxChars || kDoctorBootstrapTotalMaxChars;
  const lines = [
    `- Installed OpenClaw: ${installedVersion || "(unknown)"} (channel: ${releaseChannel || "unknown"}; context profile: ${profile.id}).`,
    `- OpenClaw injects these workspace files into the agent's Project Context, in this order: ${renderFileList(
      profile.injectedRootFiles,
    )}.`,
    "- `BOOTSTRAP.md` is injected only until workspace setup completes; the other files above are injected on normal turns when present.",
    injectedExtraPaths.length
      ? `- Extra bootstrap files injected on this install (appended AFTER the root files): ${renderFileList(
          injectedExtraPaths,
        )}.${nonInjectedExtraCount > 0 ? ` ${nonInjectedExtraCount} additional configured extra file(s) are NOT injected on this version.` : ""}`
      : "- No extra bootstrap files are currently injected.",
    `- Budgets: ${perFileMax} chars per file and ${totalMax} chars total across all injected files. The total budget is spent in injection order — files late in the order (including AlphaClaw's extras) are truncated or skipped FIRST. A file with under ${kDoctorBootstrapMinFileBudgetChars} chars of remaining budget is skipped entirely.`,
    ...(profile.userFileCapChars
      ? [`- \`USER.md\` has a fixed ${profile.userFileCapChars}-char cap on this version (not configurable).`]
      : []),
    `- ${bootstrapContext?.truncationGuidance || kDoctorContextTruncationGuidance}`,
    ...(profile.retiredRootFiles.length
      ? [
          `- RETIRED on this version (never injected, guidance inside them is invisible to the agent): ${renderFileList(
            profile.retiredRootFiles,
          )}. \`openclaw doctor --fix\` migrates their content.`,
        ]
      : []),
    ...profile.sessionScopeNotes.map((note) => `- Session scope: ${note}`),
  ];
  return lines.join("\n");
};

const buildDoctorPrompt = ({
  workspaceRoot = "",
  managedRoot = "",
  protectedPaths = [],
  lockedPaths = [],
  resolvedCards = [],
  promptVersion = "doctor-v2",
  profile = kStableProfile,
  bootstrapContext = null,
  installedVersion = "",
  releaseChannel = "",
}) =>
  `
You are AlphaClaw Doctor. Analyze this OpenClaw workspace for guidance drift, redundancy, misplacement, memory hygiene, and cleanup opportunities.

Important:
- Read the workspace and managed files as needed before deciding.
- This is advisory only. Do not make changes.
- Focus on organization and correctness of workspace guidance and setup-owned files.
- Prefer fewer, higher-signal findings.
- Avoid reporting issues that are already intentionally managed or locked by AlphaClaw.
- Evaluate files against intended OpenClaw defaults, not against an idealized minimal workspace.
- A fresh install can be healthy even if it includes broad default guidance.
- Return ONLY valid JSON. No markdown fences. No extra prose.

OpenClaw context injection (verified for the installed version):
${renderContextInjectionBlock({ profile, bootstrapContext, installedVersion, releaseChannel })}

OpenClaw default context:
- \`AGENTS.md\` is the workspace home file in the default OpenClaw template. It may intentionally include first-run instructions, session-startup guidance, memory conventions, safety rules, tool pointers, and optional behavioral guidance.
- Do not treat default-template content as drift just because it is broad or multi-purpose.
- Only flag \`AGENTS.md\` when there is clear workspace-specific drift, contradiction, substantial unnecessary local accretion, or guidance that no longer fits the file's intended role.

Placement doctrine (flag misplacement against these roles):
- \`SOUL.md\` is voice, stance, and personality — operating rules belong in \`AGENTS.md\`.
- \`USER.md\` is compact dated user preferences, superseded in place — not a dossier and not a task log.
- \`MEMORY.md\` is curated long-term memory — detailed history belongs in \`memory/*.md\` daily files, which are NOT injected (the agent retrieves them on demand). If \`MEMORY.md\` is repeatedly truncated, recommend distilling it.
- A lowercase \`memory.md\` next to \`MEMORY.md\` is legacy repair input only — do not keep both.
- Skill descriptions in \`skills/*/SKILL.md\` frontmatter cost prompt space deterministically — long descriptions degrade skill selection.
- Guidance that must reach sub-agents belongs in \`AGENTS.md\` (sub-agent sessions receive a reduced file set — see session scope above).

AlphaClaw ownership rules:
- AlphaClaw-managed files and bootstrap files are product-owned constraints.
- Do not recommend splitting, renaming, relocating, or otherwise restructuring AlphaClaw-managed files solely for cleanliness or purity.
- Do not propose breaking changes to AlphaClaw's managed file layout, even if another structure might look cleaner.
- Only flag AlphaClaw-managed content when there is a concrete correctness issue, internal contradiction, broken ownership boundary, or behavior that is actively misleading.

Workspace roots:
- Primary workspace root: ${workspaceRoot || "(unknown)"}
- Managed OpenClaw root: ${managedRoot || "(unknown)"}

AlphaClaw protected paths:
${renderList(protectedPaths)}

AlphaClaw locked/managed paths:
${renderList(lockedPaths)}

Review priorities:
- Drift between workspace reality and AGENTS.md, SKILL.md files, README, and setup-owned docs
- Memory hygiene: stale or contradictory memories, MEMORY.md content that belongs in memory/*.md (or vice versa), unbounded MEMORY.md growth
- Redundant or scattered instructions that should be centralized
- Guidance placed in the wrong file per the placement doctrine above
- Workspace cleanup and consolidation opportunities
- Real contradictions or misleading guidance inside AlphaClaw-managed files

Priority rubric:
- P0: dangerous drift, broken setup ownership, or issues likely to cause incorrect agent behavior
- P1: meaningful duplication, misplaced guidance, or organizational drift with clear cleanup value
- P2: nice-to-have consolidation and lower-risk cleanup opportunities

Use one of these categories for each card: ${kDoctorCardCategories.map((category) => `"${category}"`).join(", ")}.

Return exactly this JSON shape:
{
  "summary": "short overall assessment",
  "cards": [
    {
      "priority": "P0 | P1 | P2",
      "category": "short category",
      "title": "short title",
      "summary": "what is wrong and why it matters",
      "recommendation": "clear recommended action",
      "evidence": [
        { "type": "path", "path": "relative/path", "startLine": 10, "endLine": 25 },
        { "type": "note", "text": "short supporting note" }
      ],
      "targetPaths": [
        { "path": "relative/path/one", "startLine": 10 },
        { "path": "relative/path/two" }
      ],
      "fixPrompt": "a concise message another agent can use to fix just this finding safely",
      "status": "open"
    }
  ]
}

${renderHistoricalCards(resolvedCards)}Constraints:
- Maximum 12 cards
- Use relative paths in evidence and targetPaths
- Include startLine (and optionally endLine) in evidence and targetPaths when the finding relates to a specific section of a file
- targetPaths items can be strings or objects with { path, startLine? }
- Do not include duplicate cards
- Do not re-suggest findings that appear in the "Previously dismissed" list above
- Previously fixed findings may be re-suggested if the underlying issue is still present
- If a previously fixed finding is still present, you may call that out in the summary or card wording
- Do not create cards for healthy default-template behavior
- Do not create cards whose primary recommendation is to refactor AlphaClaw-managed file structure
- fixPrompt must only reference files the agent can edit. Never suggest editing files listed in "AlphaClaw locked/managed paths" above — they are managed by AlphaClaw, so manual edits would be lost.
- If there are no meaningful findings, return an empty cards array
- promptVersion: ${promptVersion}
`.trim();

module.exports = {
  buildDoctorPrompt,
};
