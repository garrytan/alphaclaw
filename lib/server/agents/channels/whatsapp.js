// WhatsApp channel accounts: creation (QR login follows separately) and auth
// file cleanup on delete. Split out of createChannelsDomain.
const path = require("path");
const {
  shellEscapeArg,
  resolveCredentialsDirPath,
  loadConfig,
  saveConfig,
  ensurePluginAllowed,
  cloneJson,
  normalizeBindingMatch,
  isValidChannelAccountId,
  deriveChannelEnvKey,
  appendBindingToConfig,
  buildBindingSpec,
  withNormalizedAgentsConfig,
} = require("../shared");
const { resolveChannelCmdTimeoutMs } = require("../../constants");

const createWhatsAppChannelAccounts = ({
  fsImpl,
  OPENCLAW_DIR,
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  clawCmd,
  restartSavedChannel,
  clawCmdWithConfigConflictRetry,
}) => {
  const cleanupWhatsAppAuthFiles = ({ accountId }) => {
    const credDir = resolveCredentialsDirPath({ OPENCLAW_DIR });
    const providerCredDir = path.join(credDir, "whatsapp");
    const normalizedAccountId =
      String(accountId || "")
        .trim()
        .toLowerCase() || "default";
    // Defense in depth: never join an id that could escape the credentials
    // dir, even if a future caller skips the entry-point guard.
    if (!isValidChannelAccountId(normalizedAccountId)) return;

    try {
      fsImpl.rmSync(path.join(credDir, "whatsapp", normalizedAccountId), {
        recursive: true,
        force: true,
      });
    } catch {}

    try {
      fsImpl.rmSync(providerCredDir, {
        recursive: true,
        force: true,
      });
    } catch {}

    if (normalizedAccountId !== "default") {
      return;
    }

    const legacyAuthPatterns = [
      "creds.json",
      "creds.json.bak",
    ];
    try {
      const entries = fsImpl.readdirSync(credDir);
      for (const entry of Array.isArray(entries) ? entries : []) {
        const fileName = String(entry || "").trim();
        if (!fileName) continue;
        if (
          legacyAuthPatterns.includes(fileName) ||
          /^(app-state-sync|session|sender-key|pre-key)-.*\.json$/.test(fileName)
        ) {
          try {
            fsImpl.rmSync(path.join(credDir, fileName), { force: true });
          } catch {}
        }
      }
    } catch {}
  };

  const createWhatsAppChannelAccount = async ({
    input,
    cfg,
    agentId,
    accountId,
    name,
    normalizedChannelConfig,
    existingAccounts,
    onProgress,
  }) => {
    const ownerNumber = String(input.token || "").trim();
    if (!ownerNumber) throw new Error("WhatsApp owner number is required");

    const envKey = deriveChannelEnvKey({ provider: "whatsapp", accountId });
    const currentEnvVars = readEnvFile();
    const previousEnvVars = Array.isArray(currentEnvVars) ? currentEnvVars : [];
    const previousConfig = cloneJson(cfg);

    const nextEnvVars = previousEnvVars.filter(
      (entry) => String(entry?.key || "").trim() !== envKey,
    );
    nextEnvVars.push({ key: envKey, value: ownerNumber });

    let restartOutcome = {};
    try {
      onProgress({ phase: "configuring", label: "Configuring..." });
      writeEnvFile(nextEnvVars);
      reloadEnv();

      const nextCfg = withNormalizedAgentsConfig({
        OPENCLAW_DIR,
        cfg: loadConfig({ fsImpl, OPENCLAW_DIR }),
      });
      ensurePluginAllowed({ cfg: nextCfg, pluginKey: "whatsapp" });
      saveConfig({ fsImpl, OPENCLAW_DIR, config: nextCfg });

      onProgress({ phase: "configuring", label: "Adding channel..." });
      // WhatsApp's `channels add` takes only --account/--agent/--auth-dir/
      // --name (2026.9.8 and 2026.10.2 reject `--token` with `OpenClaw does
      // not recognize option "--token".`). The owner number persists through
      // the env var above and the allowFrom `${envKey}` reference below.
      const addArgs = [
        "channels add",
        "--channel whatsapp",
        accountId !== "default" ? `--account ${shellEscapeArg(accountId)}` : "",
        name ? `--name ${shellEscapeArg(name)}` : "",
      ].filter(Boolean);
      const addResult = await clawCmdWithConfigConflictRetry(
        addArgs.join(" "),
        {
          quiet: true,
          timeoutMs: resolveChannelCmdTimeoutMs(),
        },
        { label: "channels add" },
      );
      if (!addResult?.ok) {
        throw new Error(
          addResult?.stderr ||
            addResult?.stdout ||
            "Could not add WhatsApp channel account",
        );
      }

      const refreshedCfg = withNormalizedAgentsConfig({
        OPENCLAW_DIR,
        cfg: loadConfig({ fsImpl, OPENCLAW_DIR }),
      });

      const nextAccounts = { ...existingAccounts };
      nextAccounts[accountId] = {
        ...(nextAccounts[accountId] &&
        typeof nextAccounts[accountId] === "object"
          ? nextAccounts[accountId]
          : {}),
        ...(name ? { name } : {}),
        allowFrom: [`\${${envKey}}`],
        groupAllowFrom: [`\${${envKey}}`],
        dmPolicy: "allowlist",
        groupPolicy: "allowlist",
        selfChatMode: true,
      };
      normalizedChannelConfig.accounts = nextAccounts;
      normalizedChannelConfig.enabled = true;
      if (!String(normalizedChannelConfig.defaultAccount || "").trim()) {
        normalizedChannelConfig.defaultAccount = "default";
      }
      refreshedCfg.channels =
        refreshedCfg.channels && typeof refreshedCfg.channels === "object"
          ? { ...refreshedCfg.channels }
          : {};
      refreshedCfg.channels.whatsapp = normalizedChannelConfig;

      const bindSpec = buildBindingSpec({ provider: "whatsapp", accountId });
      appendBindingToConfig({
        cfg: refreshedCfg,
        agentId,
        match: normalizeBindingMatch({ channel: "whatsapp", accountId }),
      });
      saveConfig({ fsImpl, OPENCLAW_DIR, config: refreshedCfg });

      onProgress({ phase: "restarting", label: "Rebooting..." });
      restartOutcome = await restartSavedChannel({ source: "channels:whatsapp", reason: `whatsapp/${accountId}` });
    } catch (error) {
      try {
        await clawCmd(
          [
            "channels remove",
            "--channel whatsapp",
            accountId !== "default" ? `--account ${shellEscapeArg(accountId)}` : "",
            "--delete",
          ]
            .filter(Boolean)
            .join(" "),
          { quiet: true, timeoutMs: resolveChannelCmdTimeoutMs() },
        );
      } catch {}
      try {
        writeEnvFile(previousEnvVars);
        reloadEnv();
      } catch {}
      try {
        saveConfig({ fsImpl, OPENCLAW_DIR, config: previousConfig });
      } catch {}
      throw error;
    }

    return {
      ...restartOutcome,
      channel: "whatsapp",
      account: { id: accountId, name, envKey },
      binding: {
        agentId,
        match: normalizeBindingMatch({ channel: "whatsapp", accountId }),
      },
      restartRequired: true,
    };
  };

  return { cleanupWhatsAppAuthFiles, createWhatsAppChannelAccount };
};

module.exports = { createWhatsAppChannelAccounts };
