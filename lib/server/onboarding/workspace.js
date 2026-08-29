const path = require("path");
const { execSync } = require("child_process");
const {
  kSetupDir,
  OPENCLAW_DIR,
  ENV_FILE_PATH,
} = require("../constants");
const { renderTopicRegistryMarkdown } = require("../topic-registry");
const { readGoogleState } = require("../google-state");
const { readRestartRequiredFlag } = require("../restart-required-flag");
const { writeFileAtomic } = require("../utils/safe-file");
const {
  updateOpenclawConfig,
  readOpenclawConfig,
  resolveOpenclawConfigPath,
} = require("../openclaw-config");
const {
  kLegacyAlphaclawBootstrapExtraPaths,
  reconcileBootstrapExtraPaths,
} = require("./openclaw");

const {
  kDoctorBootstrapMaxChars,
  kDoctorBootstrapNearLimitRatio,
} = require("../doctor/context-profiles");

// Merged hardening file: warn before the merged output approaches OpenClaw's
// per-file injection cap — derived from the verified contract constants so a
// profile update can never desync this threshold from the doctor's own math.
const kMergedBootstrapWarnChars = Math.floor(
  kDoctorBootstrapMaxChars * kDoctorBootstrapNearLimitRatio,
);

const resolveSetupUiUrl = (baseUrl) => {
  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (normalizedBaseUrl) return normalizedBaseUrl;

  const railwayPublicDomain = String(process.env.RAILWAY_PUBLIC_DOMAIN || "").trim();
  if (railwayPublicDomain) {
    return `https://${railwayPublicDomain}`;
  }

  const railwayStaticUrl = String(process.env.RAILWAY_STATIC_URL || "").trim().replace(
    /\/+$/,
    "",
  );
  if (railwayStaticUrl) return railwayStaticUrl;

  return "http://localhost:3000";
};

// Single assembly point for TOOLS.md: template + topic registry.
// Idempotent — always rebuilds from source so deploys never clobber topic data.
const isTelegramWorkspaceEnabled = (fs) => {
  try {
    const configPath = `${OPENCLAW_DIR}/openclaw.json`;
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const telegramConfig = cfg.channels?.telegram || {};
    const topLevelGroupCount = Object.keys(telegramConfig.groups || {}).length;
    if (topLevelGroupCount > 0) return true;
    const accounts =
      telegramConfig.accounts && typeof telegramConfig.accounts === "object"
        ? telegramConfig.accounts
        : {};
    for (const accountConfig of Object.values(accounts)) {
      if (Object.keys(accountConfig?.groups || {}).length > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
};

const renderGoogleAccountsMarkdown = (fs) => {
  try {
    const googleStatePath = `${OPENCLAW_DIR}/gogcli/state.json`;
    const state = readGoogleState({ fs, statePath: googleStatePath });
    const accounts = Array.isArray(state.accounts) ? state.accounts : [];
    let section = "\n\n## Available Google Accounts\n\n";
    if (!accounts.length) {
      section += "No Google accounts are currently configured.\n";
      return section;
    }
    section +=
      "Configured in AlphaClaw (use `--client <client> --account <email>` for gog commands):\n\n";
    section += accounts
      .map((account) => {
        const email = String(account.email || "").trim() || "(unknown email)";
        const client = String(account.client || "default").trim() || "default";
        const personal = account.personal ? "personal" : "company";
        const auth = account.authenticated ? "authenticated" : "awaiting sign-in";
        const services = Array.isArray(account.services) ? account.services.join(", ") : "";
        const metaParts = [
          `type: ${personal}`,
          `client: ${client}`,
          `status: ${auth}`,
          services ? `services: ${services}` : null,
        ].filter(Boolean);
        return `- ${email} (${metaParts.join("; ")})`;
      })
      .join("\n");
    section += "\n";
    return section;
  } catch {
    return "";
  }
};

const resolveAllAgentWorkspaces = (fs) => {
  try {
    const configPath = path.join(OPENCLAW_DIR, "openclaw.json");
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const list = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
    return list
      .map((entry) => {
        const agentId = String(entry.id || "").trim();
        const workspace = String(entry.workspace || "").trim();
        if (!agentId || !workspace) return null;
        return {
          agentId,
          workspace,
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
};

// The native createForumTopic action only works once the gateway restarted
// with the action flags in config; until then TOOLS.md must not advertise it.
const isTopicCreateActionActive = (fs) => {
  try {
    const configPath = `${OPENCLAW_DIR}/openclaw.json`;
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const telegramConfig = cfg.channels?.telegram || {};
    const enabledOn = (container) => container?.actions?.createForumTopic === true;
    const accounts =
      telegramConfig.accounts && typeof telegramConfig.accounts === "object"
        ? Object.values(telegramConfig.accounts)
        : [];
    const enabled = enabledOn(telegramConfig) || accounts.some(enabledOn);
    if (!enabled) return false;
    return !readRestartRequiredFlag({ fsModule: fs });
  } catch {
    return false;
  }
};

// AlphaClaw's prompt hardening ships as ONE merged hooks/bootstrap/AGENTS.md
// (rules first, harness/tools map after — appendices last so the total-budget
// race starves decoration before rules). AGENTS.md is a valid extras basename
// on every supported OpenClaw line, while a TOOLS.md extra is silently
// rejected on 2026.8.1+ — the merge runs unconditionally so no install
// depends on a version gate for its hardening (see
// docs/designs/openclaw-context-contract.md). Migration ordering per sync:
// (1) write merged AGENTS.md atomically — hardening is never absent;
// (2) reconcile the openclaw.json hook entry (diff-before-write, preserves
//     user-added paths, drops only AlphaClaw's legacy TOOLS.md path);
// (3) delete the legacy AlphaClaw-owned hooks/bootstrap/TOOLS.md — but only
//     when step (2) succeeded, since a failed reconcile may leave the config
//     still referencing the legacy path.
// A crash between steps (or a skipped step 3) leaves at worst a harmless
// stale TOOLS.md (duplicate tools guidance consuming budget) that self-heals
// on the next sync (every boot). Failures at any stage surface through
// onFailure (the server wires a watchdog event) — never console-only.
const syncBootstrapPromptFiles = ({ fs, workspaceDir, baseUrl, onFailure = null }) => {
  const reportFailure = (stage, error) => {
    console.error(`[onboard] Bootstrap prompt sync ${stage} failed: ${error.message}`);
    try {
      onFailure?.(stage, error);
    } catch {
      // failure reporting must never break the sync itself
    }
  };
  try {
    const setupUiUrl = resolveSetupUiUrl(baseUrl);

    const toolsTemplate = fs.readFileSync(
      path.join(kSetupDir, "core-prompts", "TOOLS.md"),
      "utf8",
    );
    const agentsTemplate = fs.readFileSync(
      path.join(kSetupDir, "core-prompts", "AGENTS.md"),
      "utf8",
    );
    const telegramEnabled = isTelegramWorkspaceEnabled(fs);
    const topicCreateActionActive = telegramEnabled && isTopicCreateActionActive(fs);
    const googleAccountsSection = renderGoogleAccountsMarkdown(fs);
    const buildMergedContent = ({ agentId = "" } = {}) => {
      let toolsContent = toolsTemplate.replace(/\{\{SETUP_UI_URL\}\}/g, setupUiUrl);
      const topicSection = renderTopicRegistryMarkdown({
        includeSyncGuidance: telegramEnabled,
        telegramEnabled,
        topicCreateActionActive,
        agentId,
      });
      if (topicSection) {
        toolsContent += topicSection;
      }
      if (googleAccountsSection) {
        toolsContent += googleAccountsSection;
      }
      const merged = `${agentsTemplate.trimEnd()}\n\n${toolsContent}`;
      if (merged.length >= kMergedBootstrapWarnChars) {
        console.warn(
          `[onboard] Merged hooks/bootstrap/AGENTS.md is ${merged.length} chars — ` +
            `approaching OpenClaw's ${kDoctorBootstrapMaxChars.toLocaleString()}-char per-file ` +
            `injection cap; trim the topic registry or Google sections before content is truncated.`,
        );
      }
      return merged;
    };

    const writeToWorkspace = (targetDir, mergedContent) => {
      const bootstrapDir = path.join(targetDir, "hooks", "bootstrap");
      fs.mkdirSync(bootstrapDir, { recursive: true });
      // Atomic write (E4.8): openclaw reads this at session bootstrap; a torn
      // file would feed the agent a truncated prompt.
      writeFileAtomic(path.join(bootstrapDir, "AGENTS.md"), mergedContent, {
        fsModule: fs,
      });
    };

    const removeLegacyToolsFile = (targetDir) => {
      // Derived from the same constant that governs the config reconcile so
      // the file deletion and the entry removal can never drift apart.
      for (const legacyRelativePath of kLegacyAlphaclawBootstrapExtraPaths) {
        const legacyPath = path.join(targetDir, ...legacyRelativePath.split("/"));
        try {
          if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
        } catch (e) {
          reportFailure("legacy-tools-delete", e);
        }
      }
    };

    const syncedWorkspaces = [workspaceDir];
    writeToWorkspace(workspaceDir, buildMergedContent());

    const otherWorkspaces = resolveAllAgentWorkspaces(fs).filter(
      (entry) => path.resolve(entry.workspace) !== path.resolve(workspaceDir),
    );
    for (const entry of otherWorkspaces) {
      try {
        writeToWorkspace(
          entry.workspace,
          buildMergedContent({ agentId: entry.agentId }),
        );
        syncedWorkspaces.push(entry.workspace);
      } catch (e) {
        reportFailure(`workspace-sync:${entry.workspace}`, e);
      }
    }

    const configReconciled = reconcileBootstrapExtraConfig({ fs, reportFailure });

    // Delete only after the config reconcile succeeded (write→reconcile→
    // delete): on a reconcile failure openclaw.json may still reference
    // hooks/bootstrap/TOOLS.md, and deleting the file it points at would
    // break the injection. The kept stale TOOLS.md self-heals on the next
    // boot sync (every boot), same as a crash between steps.
    if (configReconciled) {
      for (const syncedWorkspace of syncedWorkspaces) {
        removeLegacyToolsFile(syncedWorkspace);
      }
    }

    console.log("[onboard] Bootstrap prompt files synced");
  } catch (e) {
    reportFailure("merge-write", e);
  }
};

// Boot-path hook-entry migration: onboarding's ensureManagedConfigShell only
// runs for fresh installs — already-onboarded installs migrate here, on every
// resync. Diff-before-write keeps this a no-op once migrated (no needless
// openclaw.json churn). Returns true on success (including the intentional
// no-op paths), false on a caught failure — the caller must NOT delete the
// legacy TOOLS.md when the config that may still reference it wasn't
// reconciled.
const reconcileBootstrapExtraConfig = ({ fs, reportFailure }) => {
  try {
    const config = readOpenclawConfig({
      fsModule: fs,
      openclawDir: OPENCLAW_DIR,
      fallback: null,
    });
    // No parseable openclaw.json: a MISSING file means not onboarded —
    // creation belongs to onboarding's ensureManagedConfigShell, nothing to
    // reconcile (true). A PRESENT file our strict parser cannot read (legal
    // JSON5/${ENV}/$include upstream) may still reference
    // hooks/bootstrap/TOOLS.md, so reporting it reconciled would let the
    // caller delete the only hardening injection. Same doctrine as the
    // doctor's config_unreadable state: not ours to judge — skip the delete
    // (false); self-heals if the config ever becomes strict-JSON readable.
    if (!config || typeof config !== "object") {
      const configPath = resolveOpenclawConfigPath({ openclawDir: OPENCLAW_DIR });
      if (!fs.existsSync(configPath)) return true;
      console.warn(
        "[onboard] openclaw.json exists but is not parseable as strict JSON " +
          "(JSON5/env/include?) — skipping hook-entry reconcile and legacy " +
          "TOOLS.md cleanup for this sync.",
      );
      return false;
    }
    // Full self-heal, not just path migration: a deleted entry or a flipped
    // hooks.internal.enabled means the flagship hardening is silently never
    // injected — the boot resync is the layer that repairs it.
    const entry = config?.hooks?.internal?.entries?.["bootstrap-extra-files"];
    const currentPaths = Array.isArray(entry?.paths)
      ? entry.paths.map((value) => String(value || ""))
      : [];
    const reconciledPaths = reconcileBootstrapExtraPaths(currentPaths);
    const unchanged =
      config?.hooks?.internal?.enabled === true &&
      entry?.enabled === true &&
      currentPaths.length === reconciledPaths.length &&
      currentPaths.every((value, index) => value === reconciledPaths[index]);
    if (unchanged) return true;
    updateOpenclawConfig({
      fsModule: fs,
      openclawDir: OPENCLAW_DIR,
      mutate: (liveConfig) => {
        if (!liveConfig.hooks) liveConfig.hooks = {};
        if (!liveConfig.hooks.internal) liveConfig.hooks.internal = {};
        if (!liveConfig.hooks.internal.entries) liveConfig.hooks.internal.entries = {};
        liveConfig.hooks.internal.enabled = true;
        const liveEntry =
          liveConfig.hooks.internal.entries["bootstrap-extra-files"] || {};
        liveConfig.hooks.internal.entries["bootstrap-extra-files"] = {
          ...liveEntry,
          enabled: true,
          paths: reconcileBootstrapExtraPaths(liveEntry.paths),
        };
      },
    });
    console.log("[onboard] bootstrap-extra-files hook entry reconciled");
    return true;
  } catch (e) {
    reportFailure("config-reconcile", e);
    return false;
  }
};

const ensureOpenclawRuntimeArtifacts = ({
  fs,
  openclawDir,
  envFilePath = ENV_FILE_PATH,
}) => {
  try {
    const openclawEnvLink = path.join(openclawDir, ".env");
    if (!fs.existsSync(openclawEnvLink) && fs.existsSync(envFilePath)) {
      fs.symlinkSync(envFilePath, openclawEnvLink);
      console.log(`[alphaclaw] Symlinked ${openclawEnvLink} -> ${envFilePath}`);
    }
  } catch (e) {
    console.log(`[alphaclaw] .env symlink skipped: ${e.message}`);
  }

  const gogConfigFile = path.join(openclawDir, "gogcli", "config.json");
  if (!fs.existsSync(gogConfigFile)) {
    fs.mkdirSync(path.join(openclawDir, "gogcli"), { recursive: true });
    try {
      execSync("gog auth keyring file", { stdio: "ignore" });
      console.log("[alphaclaw] gog keyring configured (file backend)");
    } catch {}
  }
};

module.exports = {
  ensureOpenclawRuntimeArtifacts,
  resolveSetupUiUrl,
  syncBootstrapPromptFiles,
};
