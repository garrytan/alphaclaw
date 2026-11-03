// AlphaClaw's injected prompt files (ALPH-58 decision 3): two Drift Doctor
// cards read from alphaclaw.json promptFiles, in their own det:prompt-files:*
// namespace (det:hardening:* stays the single owner of "the rules are not
// being injected"). Neither card has a fixPrompt: re-enabling the reference
// file is a human-only route the agent cannot call.
const kReferencePath = "hooks/bootstrap/reference/AGENTS.md";
const kRulesPath = "hooks/bootstrap/AGENTS.md";

const formatWhen = (ms) => {
  const date = new Date(Number(ms));
  return Number.isFinite(date.getTime()) ? date.toISOString() : "an earlier sync";
};

const buildPromptFilesCards = (promptFiles = null) => {
  if (!promptFiles || typeof promptFiles !== "object") return [];
  const cards = [];
  if (promptFiles.referenceDisabled) {
    cards.push({
      sourceKey: "det:prompt-files:reference-off",
      priority: "P2",
      category: "project context",
      title: "AlphaClaw's reference file is turned off",
      summary:
        `${kReferencePath} (Google accounts and the Telegram topic table) was removed from the ` +
        `bootstrap-extra-files paths in openclaw.json (noticed ${formatWhen(promptFiles.referenceDetectedAt)}), ` +
        "so AlphaClaw keeps it out of the agent's context. The rules file still tells the agent to look " +
        "topics up with `alphaclaw telegram topics list` and never to guess a thread ID.",
      recommendation:
        "Nothing to do if this was deliberate. To inject the file again, add its path back to " +
        "bootstrap-extra-files in openclaw.json, or send POST /api/doctor/prompt-files/reference with " +
        '{"enabled": true} from a signed-in Setup UI session.',
      evidence: [{ type: "text", text: `openclaw.json bootstrap-extra-files: ${kReferencePath} not listed` }],
      targetPaths: [],
    });
  }
  if (promptFiles.rulesRestoredAt) {
    cards.push({
      // One card per restore: dismissing one never hides the next.
      sourceKey: `det:prompt-files:rules-restored:${promptFiles.rulesRestoredAt}`,
      priority: "P1",
      category: "project context",
      title: "AlphaClaw put its rules file back into the agent's context",
      summary:
        `${kRulesPath} (AlphaClaw's safety and git rules) was missing from the bootstrap-extra-files paths ` +
        `in openclaw.json. AlphaClaw restored it at ${formatWhen(promptFiles.rulesRestoredAt)}: the agent must ` +
        "always see those rules.",
      recommendation:
        "Find out what edited openclaw.json. To slim the agent's context, remove the reference file's path " +
        `(${kReferencePath}) instead: AlphaClaw keeps that one out, but the rules file cannot be turned off.`,
      evidence: [{ type: "text", text: `openclaw.json bootstrap-extra-files: ${kRulesPath} restored` }],
      targetPaths: [],
    });
  }
  return cards;
};

module.exports = { buildPromptFilesCards };
