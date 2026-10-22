const { GatewayMutationBlockedError, restartDeferredFields } = require("../gateway-mutation-policy");
const path = require("path");

const {
  kChannelTokenFields,
  kChannelLabels,
  kMaskedChannelToken,
  shellEscapeArg,
  loadConfig,
  saveConfig,
  ensurePluginAllowed,
  cloneJson,
  normalizeBindingMatch,
  matchesBinding,
  isValidChannelAccountId,
  normalizeChannelProvider,
  deriveChannelEnvKey,
  deriveChannelExtraEnvKeys,
  getConfiguredChannelEnvKeys,
  assertActiveChannelTokenEnvVars,
  hasSavedWhatsAppCredentials,
  normalizeChannelConfig,
  appendBindingToConfig,
  buildBindingSpec,
  hasLegacyDefaultChannelAccount,
  listConfiguredChannelAccounts,
  withNormalizedAgentsConfig,
  kChannelEnvKeys,
  kChannelExtraEnvKeys,
} = require("./shared");

const { createRunStream } = require("../openclaw-run-stream");
const { resolveChannelCmdTimeoutMs } = require("../constants");

// Channel plugins whose `channels add` accepts a `${VAR}` token reference in
// place of the secret (measured on OpenClaw 2026.9.5).
const kEnvRefTokenProviders = new Set(["telegram", "discord", "slack"]);
const { deleteChannelPairingRows } = require("../openclaw-state-era");
const { withFileLockSync } = require("../utils/safe-file");
const { createClickclackChannelSetup } = require("./channels/clickclack");
const { createChannelPairingCleanup } = require("./channels/pairing-cleanup");
const { createWhatsAppChannelAccounts } = require("./channels/whatsapp");

// A key any provider's deriveChannelEnvKey/deriveChannelExtraEnvKeys could have
// produced (base key, account-suffixed variant, or an extra key) — the only
// keys the orphan dedupe may treat as a stale channel credential (fix wave
// F091). Cross-provider on purpose: a token already living in another
// provider's configured key must still refuse ("already exists in …"), while an
// unrelated key that happens to hold the same secret is never touched.
const kChannelEnvKeyStems = [
  ...Object.values(kChannelEnvKeys),
  ...Object.values(kChannelExtraEnvKeys).flat(),
].filter(Boolean);
const isChannelEnvKeyShape = (key) =>
  kChannelEnvKeyStems.some((stem) => key === stem || key.startsWith(`${stem}_`));


const createChannelsDomain = ({
  fsImpl,
  OPENCLAW_DIR,
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  restartGateway,
  clawCmd,
  // Env for argv-array CLI runs (guided ClickClack setup). Defaults keep older
  // callers/tests working; the server passes the real gatewayEnv.
  gatewayEnv = () => process.env,
  runStream = createRunStream(),
}) => {
  let createChannelAccountInProgress = false;
  const restartSavedChannel = async () => {
    try {
      await restartGateway();
      return {};
    } catch (error) {
      if (!(error instanceof GatewayMutationBlockedError)) throw error;
      return { gatewayRestartFailed: true, ...restartDeferredFields(error) };
    }
  };

  const formatClawResultOutput = (result) =>
    [result?.stderr, result?.stdout].filter(Boolean).join("\n").trim();

  const isConfigMutationConflictResult = (result) =>
    /ConfigMutationConflictError|config changed since last load/i.test(
      formatClawResultOutput(result),
    );

  const waitForRetry = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs));

  const clawCmdWithConfigConflictRetry = async (
    command,
    options,
    { label = "command", delaysMs = [250, 750] } = {},
  ) => {
    for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
      const result = await clawCmd(command, options);
      if (result?.ok || !isConfigMutationConflictResult(result)) {
        return result;
      }
      if (attempt >= delaysMs.length) {
        return result;
      }
      const delayMs = Number(delaysMs[attempt] || 0);
      console.warn(
        `[alphaclaw] Retrying openclaw ${label} after config mutation conflict`,
      );
      if (delayMs > 0) {
        await waitForRetry(delayMs);
      }
    }
    return { ok: false, stdout: "", stderr: "Command retry exhausted" };
  };

  const getChannelAccountToken = ({
    provider: rawProvider,
    accountId: rawAccountId,
  } = {}) => {
    const provider = normalizeChannelProvider(rawProvider);
    const accountId = String(rawAccountId || "").trim() || "default";
    const cfg = withNormalizedAgentsConfig({
      OPENCLAW_DIR,
      cfg: loadConfig({ fsImpl, OPENCLAW_DIR }),
    });
    const providerConfig =
      cfg.channels?.[provider] && typeof cfg.channels[provider] === "object"
        ? cfg.channels[provider]
        : null;
    if (!providerConfig) {
      throw new Error(`Channel "${provider}" not found`);
    }
    const hasAccounts =
      providerConfig.accounts && typeof providerConfig.accounts === "object";
    const hasLegacyDefault =
      accountId === "default" &&
      !hasAccounts &&
      hasLegacyDefaultChannelAccount({ config: providerConfig });
    if (!hasLegacyDefault && !providerConfig.accounts?.[accountId]) {
      throw new Error(`Channel account "${provider}/${accountId}" not found`);
    }
    const envKey = deriveChannelEnvKey({ provider, accountId });
    const extraEnvKeys = deriveChannelExtraEnvKeys({ provider, accountId });
    const envVars = readEnvFile();
    const envEntry = (Array.isArray(envVars) ? envVars : []).find(
      (entry) => String(entry?.key || "").trim() === envKey,
    );
    const appEnvKey = extraEnvKeys[0] || "";
    const appEnvEntry = appEnvKey
      ? (Array.isArray(envVars) ? envVars : []).find(
          (entry) => String(entry?.key || "").trim() === appEnvKey,
        )
      : null;
    return {
      provider,
      accountId,
      envKey,
      token: String(envEntry?.value || ""),
      ...(provider === "slack"
        ? {
            appEnvKey,
            appToken: String(appEnvEntry?.value || ""),
          }
        : {}),
    };
  };

  const { createClickclackGuidedAccount } = createClickclackChannelSetup({
    fsImpl,
    OPENCLAW_DIR,
    clawCmd,
    gatewayEnv,
    runStream,
    restartSavedChannel,
  });

  // Clears the pairing rows a previous account with this provider/id left
  // behind (see the call site in createChannelAccount). Any failure refuses
  // the add — nothing has been mutated yet, so refusing is clean.
  const clearStalePairingRowsBeforeAdd = ({ provider, accountId }) => {
    const label = `${provider}/${accountId}`;
    let result;
    try {
      result = deleteChannelPairingRows({
        openclawDir: OPENCLAW_DIR,
        channel: provider,
        accountId,
      });
    } catch (error) {
      throw new Error(
        `Could not clear stale pairing rows for ${label} before adding it: ${String(error?.message || error)}`,
      );
    }
    if (result?.ok === false) {
      throw new Error(
        `Could not clear stale pairing rows for ${label} before adding it: ${String(result.error || "unknown error")}`,
      );
    }
  };

  const createChannelAccount = async (
    input = {},
    { onProgress = () => {} } = {},
  ) => {
    if (createChannelAccountInProgress) {
      throw new Error("A channel account creation is already in progress");
    }
    createChannelAccountInProgress = true;
    try {
      const provider = normalizeChannelProvider(input.provider);
      const name =
        String(input.name || "").trim() || kChannelLabels[provider] || provider;

      const cfg = withNormalizedAgentsConfig({
        OPENCLAW_DIR,
        cfg: loadConfig({ fsImpl, OPENCLAW_DIR }),
      });

      const agentId = String(input.agentId || "").trim();
      const agent = cfg.agents.list.find((entry) => entry.id === agentId);
      if (!agent) throw new Error(`Agent "${agentId}" not found`);

      const existingChannelConfig =
        cfg.channels?.[provider] && typeof cfg.channels[provider] === "object"
          ? cfg.channels[provider]
          : {};
      const normalizedChannelConfig = normalizeChannelConfig({
        provider,
        channelConfig: existingChannelConfig,
      });
      const existingAccounts =
        normalizedChannelConfig.accounts &&
        typeof normalizedChannelConfig.accounts === "object"
          ? normalizedChannelConfig.accounts
          : {};
      const requestedAccountId = String(input.accountId || "").trim();
      const accountId =
        requestedAccountId ||
        (Object.keys(existingAccounts).length > 0 ? "" : "default");
      if (!accountId) {
        throw new Error("Channel account id is required");
      }
      if (!isValidChannelAccountId(accountId)) {
        throw new Error(
          "Channel account id must be lowercase letters, numbers, and hyphens only",
        );
      }
      if (existingAccounts[accountId]) {
        throw new Error(
          `Channel account "${provider}/${accountId}" already exists`,
        );
      }
      if (
        (provider === "discord" || provider === "whatsapp") &&
        Object.keys(existingAccounts).length > 0
      ) {
        throw new Error(
          `${kChannelLabels[provider] || "This provider"} supports a single channel account`,
        );
      }

      // A deleted account's pairing rows (allow entries, pending requests)
      // can outlive it (a failed clear at delete time). Re-adding the same id
      // must never inherit them, so the stale rows go FIRST — ordered before
      // the env/config writes and fail-closed: an uncleared table would start
      // the new account with the old account's authorized users, so the add
      // refuses and names why.
      clearStalePairingRowsBeforeAdd({ provider, accountId });

      if (provider === "whatsapp") {
        return await createWhatsAppChannelAccount({
          input,
          cfg,
          agentId,
          accountId,
          name,
          normalizedChannelConfig,
          existingAccounts,
          onProgress,
        });
      }

      // ClickClack guided setup (5.1): a pasted setup code or URL replaces
      // the manual token — the CLI resolves and stores the credential itself,
      // so no env var is written. The value is user input and a command-
      // injection boundary (C11): it travels as an argv ELEMENT through the
      // argv-array runner, never a shell string, and is never persisted or
      // echoed back (E-C12).
      const clickclackSetupValue =
        provider === "clickclack" ? String(input.setupValue || "").trim() : "";
      if (clickclackSetupValue) {
        return await createClickclackGuidedAccount({
          setupValue: clickclackSetupValue,
          agentId,
          accountId,
          name,
          onProgress,
        });
      }

      const token = String(input.token || "").trim();
      if (!token) throw new Error("Channel token is required");

      const envKey = deriveChannelEnvKey({ provider, accountId });
      const extraEnvKeys = deriveChannelExtraEnvKeys({ provider, accountId });
      const appToken = String(input.appToken || "").trim();
      if (provider === "slack" && !appToken) {
        throw new Error("Slack App Token is required");
      }
      const tokenField = kChannelTokenFields[provider];
      const currentEnvVars = readEnvFile();
      const previousEnvVars = Array.isArray(currentEnvVars)
        ? currentEnvVars
        : [];
      // Only CHANNEL-shaped keys can be "orphaned channel env vars" (fix wave
      // F091): matching any .env key by value silently deleted unrelated keys
      // that happened to hold the same token.
      const duplicateEnvEntry = previousEnvVars.find((entry) => {
        const existingKey = String(entry?.key || "").trim();
        const existingValue = String(entry?.value || "").trim();
        if (!existingKey || !existingValue) return false;
        if (existingKey === envKey) return false;
        if (!isChannelEnvKeyShape(existingKey)) return false;
        return existingValue === token;
      });
      let orphanedEnvKey = null;
      if (duplicateEnvEntry) {
        const dupKey = String(duplicateEnvEntry.key || "").trim();
        const configuredKeys = getConfiguredChannelEnvKeys(cfg);
        if (configuredKeys.has(dupKey)) {
          throw new Error(`Channel token already exists in ${dupKey}`);
        }
        orphanedEnvKey = dupKey;
        console.log(
          `[alphaclaw] Overwriting orphaned channel env var ${dupKey} (no matching config entry)`,
        );
      }
      let orphanedExtraEnvKey = null;
      if (provider === "slack") {
        const appEnvKey = extraEnvKeys[0];
        const duplicateAppTokenEntry = previousEnvVars.find((entry) => {
          const existingKey = String(entry?.key || "").trim();
          const existingValue = String(entry?.value || "").trim();
          if (!existingKey || !existingValue) return false;
          if (existingKey === envKey || existingKey === appEnvKey) return false;
          if (!isChannelEnvKeyShape(existingKey)) return false;
          return existingValue === appToken;
        });
        if (duplicateAppTokenEntry) {
          const dupKey = String(duplicateAppTokenEntry.key || "").trim();
          const configuredKeys = getConfiguredChannelEnvKeys(cfg);
          if (configuredKeys.has(dupKey)) {
            throw new Error(`Channel token already exists in ${dupKey}`);
          }
          orphanedExtraEnvKey = dupKey;
          console.log(
            `[alphaclaw] Overwriting orphaned channel env var ${dupKey} (no matching config entry)`,
          );
        }
      }
      const nextEnvVars = previousEnvVars.filter((entry) => {
        const key = String(entry?.key || "").trim();
        return (
          key !== envKey &&
          key !== orphanedEnvKey &&
          !extraEnvKeys.includes(key) &&
          key !== orphanedExtraEnvKey
        );
      });
      nextEnvVars.push({ key: envKey, value: token });
      if (provider === "slack" && extraEnvKeys[0]) {
        nextEnvVars.push({ key: extraEnvKeys[0], value: appToken });
      }

      const previousConfig = cloneJson(cfg);
      try {
        onProgress({ phase: "configuring", label: "Configuring..." });
        writeEnvFile(nextEnvVars);
        reloadEnv();
        assertActiveChannelTokenEnvVars({
          cfg: withNormalizedAgentsConfig({
            OPENCLAW_DIR,
            cfg: loadConfig({ fsImpl, OPENCLAW_DIR }),
          }),
          envVars: nextEnvVars,
        });
        const pluginEnabledCfg = withNormalizedAgentsConfig({
          OPENCLAW_DIR,
          cfg: loadConfig({ fsImpl, OPENCLAW_DIR }),
        });
        ensurePluginAllowed({ cfg: pluginEnabledCfg, pluginKey: provider });
        saveConfig({ fsImpl, OPENCLAW_DIR, config: pluginEnabledCfg });
        const addArgs = [
          "channels add",
          `--channel ${shellEscapeArg(provider)}`,
          accountId !== "default"
            ? `--account ${shellEscapeArg(accountId)}`
            : "",
          name ? `--name ${shellEscapeArg(name)}` : "",
          // Pass the env reference, never the secret: argv is readable by any
          // same-host process for the CLI's whole runtime, and the CLI would
          // write the literal into openclaw.json before the rewrite below.
          // The token is already in the env file (writeEnvFile above), and
          // OpenClaw stores `${VAR}` references as-is.
          // Verified on OpenClaw 2026.9.5 for the bundled telegram, discord
          // and slack plugins; other plugins keep the literal until checked.
          provider === "slack"
            ? `--bot-token ${shellEscapeArg(`\${${envKey}}`)}`
            : `--token ${shellEscapeArg(
                kEnvRefTokenProviders.has(provider) ? `\${${envKey}}` : token,
              )}`,
          provider === "slack" && appToken && extraEnvKeys[0]
            ? `--app-token ${shellEscapeArg(`\${${extraEnvKeys[0]}}`)}`
            : "",
          provider === "clickclack" && String(input.baseUrl || "").trim()
            ? `--base-url ${shellEscapeArg(String(input.baseUrl).trim())}`
            : "",
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
              "Could not add channel account",
          );
        }
        const nextCfg = withNormalizedAgentsConfig({
          OPENCLAW_DIR,
          cfg: loadConfig({ fsImpl, OPENCLAW_DIR }),
        });
        const nextProviderConfig = normalizeChannelConfig({
          provider,
          channelConfig:
            nextCfg.channels?.[provider] &&
            typeof nextCfg.channels[provider] === "object"
              ? nextCfg.channels[provider]
              : {},
        });
        const nextAccounts =
          nextProviderConfig.accounts &&
          typeof nextProviderConfig.accounts === "object"
            ? { ...nextProviderConfig.accounts }
            : {};
        nextAccounts[accountId] = {
          ...(nextAccounts[accountId] &&
          typeof nextAccounts[accountId] === "object"
            ? nextAccounts[accountId]
            : {}),
          ...(name ? { name } : {}),
          [tokenField]: `\${${envKey}}`,
          ...(provider === "slack" && extraEnvKeys[0]
            ? { appToken: `\${${extraEnvKeys[0]}}` }
            : {}),
          dmPolicy: "pairing",
        };
        nextProviderConfig.accounts = nextAccounts;
        nextProviderConfig.enabled = true;
        if (
          nextProviderConfig.accounts &&
          typeof nextProviderConfig.accounts === "object" &&
          !String(nextProviderConfig.defaultAccount || "").trim()
        ) {
          nextProviderConfig.defaultAccount = "default";
        }
        nextCfg.channels =
          nextCfg.channels && typeof nextCfg.channels === "object"
            ? { ...nextCfg.channels }
            : {};
        nextCfg.channels[provider] = nextProviderConfig;
        saveConfig({ fsImpl, OPENCLAW_DIR, config: nextCfg });
        onProgress({ phase: "binding", label: "Binding agent..." });
        const bindSpec = buildBindingSpec({ provider, accountId });
        const bindResult = await clawCmdWithConfigConflictRetry(
          `agents bind --agent ${shellEscapeArg(agentId)} --bind ${shellEscapeArg(bindSpec)}`,
          { quiet: true, timeoutMs: resolveChannelCmdTimeoutMs() },
          { label: "agents bind" },
        );
        if (!bindResult?.ok) {
          throw new Error(
            bindResult?.stderr ||
              bindResult?.stdout ||
              "Could not bind channel account",
          );
        }
      } catch (error) {
        try {
          await clawCmd(
            [
              "channels remove",
              `--channel ${shellEscapeArg(provider)}`,
              accountId !== "default"
                ? `--account ${shellEscapeArg(accountId)}`
                : "",
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

      // The account, env, config and binding are all in place; a gateway
      // that fails to come back ready is a RESTART problem, not a failed add
      // (fix wave F086) — deleteChannelAccount already treats it that way.
      // Rolling back here removed a correctly configured account (and
      // restored a stale whole-config snapshot) because of a slow boot.
      let gatewayRestartFailed = false;
      let restartOutcome = {};
      onProgress({ phase: "restarting", label: "Rebooting..." });
      try {
        await restartGateway();
      } catch (error) {
        console.warn(
          `[alphaclaw] gateway restart failed after channel add: ${error.message}`,
        );
        gatewayRestartFailed = true;
        restartOutcome = restartDeferredFields(error);
      }

      const binding = {
        agentId,
        match: normalizeBindingMatch({
          channel: provider,
          accountId,
        }),
      };
      return {
        channel: provider,
        account: {
          id: accountId,
          name,
          envKey,
        },
        binding,
        ...(gatewayRestartFailed ? { gatewayRestartFailed: true, ...restartOutcome } : {}),
      };
    } finally {
      createChannelAccountInProgress = false;
    }
  };

  // Locked read-modify-write (3.1): channel edits (incl. the Slack
  // statusReactions flip) take the shared openclaw.json lock so they can
  // never race the team/channel-sync writers. Mocked fs without openSync
  // (tests) degrades to an unserialized call.
  const updateChannelAccount = (input = {}) => {
    const configPath = path.join(OPENCLAW_DIR, "openclaw.json");
    return withFileLockSync(configPath, () => updateChannelAccountLocked(input), {
      fsModule: fsImpl,
    });
  };

  const updateChannelAccountLocked = (input = {}) => {
    const provider = normalizeChannelProvider(input.provider);
    const accountId = String(input.accountId || "").trim() || "default";
    const nextName = String(input.name || "").trim();
    const nextAgentId = String(input.agentId || "").trim();
    const nextToken = String(input.token || "").trim();
    const nextAppToken = String(input.appToken || "").trim();
    if (!nextName) throw new Error("Channel name is required");
    if (!nextAgentId) throw new Error("Agent is required");

    const cfg = withNormalizedAgentsConfig({
      OPENCLAW_DIR,
      cfg: loadConfig({ fsImpl, OPENCLAW_DIR }),
    });
    const agent = cfg.agents.list.find((entry) => entry.id === nextAgentId);
    if (!agent) throw new Error(`Agent "${nextAgentId}" not found`);

    const providerConfig =
      cfg.channels?.[provider] && typeof cfg.channels[provider] === "object"
        ? { ...cfg.channels[provider] }
        : null;
    if (!providerConfig) {
      throw new Error(`Channel "${provider}" not found`);
    }

    const hasAccounts =
      providerConfig.accounts && typeof providerConfig.accounts === "object";
    const hasLegacyDefault =
      accountId === "default" &&
      !hasAccounts &&
      hasLegacyDefaultChannelAccount({ config: providerConfig });
    if (!hasLegacyDefault && !providerConfig.accounts?.[accountId]) {
      throw new Error(`Channel account "${provider}/${accountId}" not found`);
    }

    let tokenUpdated = false;
    if (provider === "slack" && nextAppToken) {
      const appEnvKey = deriveChannelExtraEnvKeys({ provider, accountId })[0];
      const currentEnvVars = readEnvFile();
      const previousEnvVars = Array.isArray(currentEnvVars)
        ? currentEnvVars
        : [];
      const existingAppToken = String(
        previousEnvVars.find(
          (entry) => String(entry?.key || "").trim() === appEnvKey,
        )?.value || "",
      );
      const duplicateEnvEntry = previousEnvVars.find((entry) => {
        const existingKey = String(entry?.key || "").trim();
        const existingValue = String(entry?.value || "").trim();
        if (!existingKey || !existingValue) return false;
        if (existingKey === appEnvKey) return false;
        return existingValue === nextAppToken;
      });
      if (duplicateEnvEntry) {
        const dupKey = String(duplicateEnvEntry.key || "").trim();
        const configuredKeys = getConfiguredChannelEnvKeys(cfg);
        if (configuredKeys.has(dupKey)) {
          throw new Error(`Channel token already exists in ${dupKey}`);
        }
      }
      if (existingAppToken !== nextAppToken) {
        const nextEnvVars = previousEnvVars.filter(
          (entry) => String(entry?.key || "").trim() !== appEnvKey,
        );
        nextEnvVars.push({ key: appEnvKey, value: nextAppToken });
        writeEnvFile(nextEnvVars);
        reloadEnv();
        tokenUpdated = true;
      }
    }
    if (nextToken) {
      const envKey = deriveChannelEnvKey({ provider, accountId });
      const currentEnvVars = readEnvFile();
      const previousEnvVars = Array.isArray(currentEnvVars)
        ? currentEnvVars
        : [];
      const existingToken = String(
        previousEnvVars.find(
          (entry) => String(entry?.key || "").trim() === envKey,
        )?.value || "",
      );
      const duplicateEnvEntry = previousEnvVars.find((entry) => {
        const existingKey = String(entry?.key || "").trim();
        const existingValue = String(entry?.value || "").trim();
        if (!existingKey || !existingValue) return false;
        if (existingKey === envKey) return false;
        return existingValue === nextToken;
      });
      if (duplicateEnvEntry) {
        const dupKey = String(duplicateEnvEntry.key || "").trim();
        const configuredKeys = getConfiguredChannelEnvKeys(cfg);
        if (configuredKeys.has(dupKey)) {
          throw new Error(`Channel token already exists in ${dupKey}`);
        }
      }
      if (existingToken !== nextToken) {
        const nextEnvVars = previousEnvVars.filter(
          (entry) => String(entry?.key || "").trim() !== envKey,
        );
        nextEnvVars.push({ key: envKey, value: nextToken });
        writeEnvFile(nextEnvVars);
        reloadEnv();
        tokenUpdated = true;
      }
    }

    if (hasLegacyDefault) {
      providerConfig.name = nextName;
    } else {
      providerConfig.accounts = { ...providerConfig.accounts };
      providerConfig.accounts[accountId] = {
        ...(providerConfig.accounts[accountId] || {}),
        name: nextName,
      };
    }
    cfg.channels =
      cfg.channels && typeof cfg.channels === "object"
        ? { ...cfg.channels }
        : {};
    cfg.channels[provider] = providerConfig;

    const bindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];
    const targetMatch = normalizeBindingMatch({ channel: provider, accountId });
    const nextBindings = bindings.filter((binding) => {
      const match = binding?.match || {};
      const hasScopedFields =
        !!match.peer ||
        !!match.parentPeer ||
        !!String(match.guildId || "").trim() ||
        !!String(match.teamId || "").trim() ||
        (Array.isArray(match.roles) && match.roles.length > 0);
      if (hasScopedFields) return true;
      return !matchesBinding(match, targetMatch);
    });
    cfg.bindings = nextBindings;
    appendBindingToConfig({
      cfg,
      agentId: nextAgentId,
      match: targetMatch,
    });
    // Slack progress indicators (3.1): OpenClaw 2026.8 defaults to native Slack
    // thread status; messages.statusReactions.enabled=true restores the emoji
    // reaction lifecycle. Written ONLY on an explicit "on"/"off" choice — the
    // default option never writes, so we never override an operator's config
    // silently. Harmless key on older OpenClaw versions.
    if (provider === "slack") {
      const choice = String(input.statusReactions || "").trim();
      if (choice === "on" || choice === "off") {
        const messages =
          cfg.messages && typeof cfg.messages === "object"
            ? { ...cfg.messages }
            : {};
        const statusReactions =
          messages.statusReactions && typeof messages.statusReactions === "object"
            ? { ...messages.statusReactions }
            : {};
        statusReactions.enabled = choice === "on";
        messages.statusReactions = statusReactions;
        cfg.messages = messages;
      }
    }
    // ClickClack beta toggles (5.1): written ONLY on an explicit choice, same
    // contract as the Slack flip above. Keys verified against the beta plugin
    // schema: channels.clickclack.commandMenu (boolean) and allowBots
    // (boolean | "mentions" — bot collaboration is DENIED by default upstream).
    if (provider === "clickclack") {
      const clickclackCfg =
        cfg.channels?.clickclack && typeof cfg.channels.clickclack === "object"
          ? cfg.channels.clickclack
          : null;
      if (clickclackCfg) {
        const menuChoice = String(input.commandMenu || "").trim();
        if (menuChoice === "on" || menuChoice === "off") {
          clickclackCfg.commandMenu = menuChoice === "on";
        }
        const botsChoice = String(input.allowBots || "").trim();
        if (botsChoice === "on" || botsChoice === "off" || botsChoice === "mentions") {
          clickclackCfg.allowBots =
            botsChoice === "mentions" ? "mentions" : botsChoice === "on";
        }
      }
    }
    saveConfig({ fsImpl, OPENCLAW_DIR, config: cfg });

    return {
      channel: provider,
      account: {
        id: accountId,
        name: nextName,
        boundAgentId: nextAgentId,
      },
      tokenUpdated,
    };
  };

  // openclaw >= 2026.9.1-beta.1 keeps pairing state in the state db (the
  // legacy files are deleted at gateway startup) — clear the deleted
  // account's rows too, or its allow entries stay authorized after the
  // account is gone. This is the LAST mutation of every delete, after the
  // CLI/config/env writes: those cannot be undone once they ran. Clearing
  // them first (the previous order) meant a CLI timeout, a config write
  // failure or ENOSPC left the account and its token intact but its
  // authorized users permanently deleted. The outcome is never re-thrown
  // (the operator's retry would 404 against a mutated config); a failed
  // clear is security-relevant and must be LOUD (the delete still proceeds).
  const { clearChannelAccountPairingRows, pairingRowsOutcomeFields, cleanupChannelAccountPairingFiles } = createChannelPairingCleanup({
    fsImpl,
    OPENCLAW_DIR,
  });

  const { cleanupWhatsAppAuthFiles, createWhatsAppChannelAccount } = createWhatsAppChannelAccounts({
    fsImpl,
    OPENCLAW_DIR,
    readEnvFile,
    writeEnvFile,
    reloadEnv,
    clawCmd,
    restartSavedChannel,
    clawCmdWithConfigConflictRetry,
  });

  const deleteChannelAccount = async (input = {}) => {
    const provider = normalizeChannelProvider(input.provider);
    const accountId = String(input.accountId || "").trim() || "default";
    // The id flows into destructive rmSync path joins (whatsapp auth dir,
    // allowFrom files) — reject traversal shapes before any config read, same
    // contract as login/login-status (H5). A hostile id planted as a config
    // key must not pass just because it exists in openclaw.json.
    if (accountId !== "default" && !isValidChannelAccountId(accountId)) {
      throw new Error("Invalid channel accountId");
    }

    const cfg = withNormalizedAgentsConfig({
      OPENCLAW_DIR,
      cfg: loadConfig({ fsImpl, OPENCLAW_DIR }),
    });
    const providerConfig =
      cfg.channels?.[provider] && typeof cfg.channels[provider] === "object"
        ? cfg.channels[provider]
        : null;
    if (!providerConfig) {
      throw new Error(`Channel "${provider}" not found`);
    }
    const hasAccounts =
      providerConfig.accounts && typeof providerConfig.accounts === "object";
    const hasLegacyDefault =
      accountId === "default" &&
      !hasAccounts &&
      hasLegacyDefaultChannelAccount({ config: providerConfig });
    if (!hasLegacyDefault && !providerConfig.accounts?.[accountId]) {
      throw new Error(`Channel account "${provider}/${accountId}" not found`);
    }

    if (provider === "discord") {
      const nextCfg = withNormalizedAgentsConfig({
        OPENCLAW_DIR,
        cfg: loadConfig({ fsImpl, OPENCLAW_DIR }),
      });
      const nextChannels =
        nextCfg.channels && typeof nextCfg.channels === "object"
          ? { ...nextCfg.channels }
          : {};
      const nextProviderConfig = normalizeChannelConfig({
        provider,
        channelConfig:
          nextChannels[provider] && typeof nextChannels[provider] === "object"
            ? nextChannels[provider]
            : {},
      });
      const nextAccounts =
        nextProviderConfig.accounts &&
        typeof nextProviderConfig.accounts === "object"
          ? { ...nextProviderConfig.accounts }
          : {};
      delete nextAccounts[accountId];
      if (Object.keys(nextAccounts).length > 0) {
        nextProviderConfig.accounts = nextAccounts;
        nextChannels[provider] = nextProviderConfig;
      } else {
        delete nextChannels[provider];
      }
      nextCfg.channels = nextChannels;

      const targetMatch = normalizeBindingMatch({
        channel: provider,
        accountId,
      });
      const existingBindings = Array.isArray(nextCfg.bindings)
        ? nextCfg.bindings
        : [];
      nextCfg.bindings = existingBindings.filter((binding) => {
        const match = binding?.match || {};
        const hasScopedFields =
          !!match.peer ||
          !!match.parentPeer ||
          !!String(match.guildId || "").trim() ||
          !!String(match.teamId || "").trim() ||
          (Array.isArray(match.roles) && match.roles.length > 0);
        if (hasScopedFields) return true;
        return !matchesBinding(match, targetMatch);
      });
      if (!nextChannels[provider] && nextCfg.plugins?.entries?.[provider]) {
        nextCfg.plugins.entries[provider] = {
          ...(nextCfg.plugins.entries[provider] || {}),
          enabled: false,
        };
      }
      saveConfig({ fsImpl, OPENCLAW_DIR, config: nextCfg });

      const envKey = deriveChannelEnvKey({ provider, accountId });
      const extraEnvKeys = deriveChannelExtraEnvKeys({ provider, accountId });
      const currentEnvVars = readEnvFile();
      const previousEnvVars = Array.isArray(currentEnvVars)
        ? currentEnvVars
        : [];
      const nextEnvVars = previousEnvVars.filter(
        (entry) =>
          String(entry?.key || "").trim() !== envKey &&
          !extraEnvKeys.includes(String(entry?.key || "").trim()),
      );
      if (nextEnvVars.length !== previousEnvVars.length) {
        writeEnvFile(nextEnvVars);
        reloadEnv();
      }

      const pairingRows = clearChannelAccountPairingRows({ provider, accountId });
      const pairingRowsFields = pairingRowsOutcomeFields(pairingRows);
      cleanupChannelAccountPairingFiles({ provider, accountId });
      try {
        await restartGateway();
      } catch (error) {
        // restartGateway throws when the gateway never becomes ready; the
        // channel change itself succeeded — report it, don't fail the delete.
        console.warn(
          `[alphaclaw] gateway restart failed after channel change: ${error.message}`,
        );
        return { ok: true, gatewayRestartFailed: true, ...restartDeferredFields(error), ...pairingRowsFields };
      }
      return { ok: true, ...pairingRowsFields };
    }

    const removeArgs = [
      "channels remove",
      `--channel ${shellEscapeArg(provider)}`,
      `--account ${shellEscapeArg(accountId)}`,
      "--delete",
    ].filter(Boolean);
    const removeResult = await clawCmd(removeArgs.join(" "), {
      quiet: true,
      timeoutMs: resolveChannelCmdTimeoutMs(),
    });
    if (!removeResult?.ok) {
      throw new Error(
        removeResult?.stderr ||
          removeResult?.stdout ||
          "Could not delete channel account",
      );
    }

    const envKey = deriveChannelEnvKey({ provider, accountId });
    const extraEnvKeys = deriveChannelExtraEnvKeys({ provider, accountId });
    const currentEnvVars = readEnvFile();
    const previousEnvVars = Array.isArray(currentEnvVars) ? currentEnvVars : [];
    const nextEnvVars = previousEnvVars.filter(
      (entry) =>
        String(entry?.key || "").trim() !== envKey &&
        !extraEnvKeys.includes(String(entry?.key || "").trim()),
    );
    if (nextEnvVars.length !== previousEnvVars.length) {
      writeEnvFile(nextEnvVars);
      reloadEnv();
    }

    const nextCfg = withNormalizedAgentsConfig({
      OPENCLAW_DIR,
      cfg: loadConfig({ fsImpl, OPENCLAW_DIR }),
    });
    const nextChannels =
      nextCfg.channels && typeof nextCfg.channels === "object"
        ? { ...nextCfg.channels }
        : {};
    const nextProviderConfig = normalizeChannelConfig({
      provider,
      channelConfig:
        nextChannels[provider] && typeof nextChannels[provider] === "object"
          ? nextChannels[provider]
          : {},
    });
    const nextAccounts =
      nextProviderConfig.accounts &&
      typeof nextProviderConfig.accounts === "object"
        ? { ...nextProviderConfig.accounts }
        : {};
    delete nextAccounts[accountId];
    if (Object.keys(nextAccounts).length > 0) {
      nextProviderConfig.accounts = nextAccounts;
      nextChannels[provider] = nextProviderConfig;
    } else {
      delete nextChannels[provider];
    }
    nextCfg.channels = nextChannels;
    const targetMatch = normalizeBindingMatch({ channel: provider, accountId });
    const existingBindings = Array.isArray(nextCfg.bindings)
      ? nextCfg.bindings
      : [];
    nextCfg.bindings = existingBindings.filter((binding) => {
      const match = binding?.match || {};
      const hasScopedFields =
        !!match.peer ||
        !!match.parentPeer ||
        !!String(match.guildId || "").trim() ||
        !!String(match.teamId || "").trim() ||
        (Array.isArray(match.roles) && match.roles.length > 0);
      if (hasScopedFields) return true;
      return !matchesBinding(match, targetMatch);
    });
    if (!nextChannels[provider] && nextCfg.plugins?.entries?.[provider]) {
      nextCfg.plugins.entries[provider] = {
        ...(nextCfg.plugins.entries[provider] || {}),
        enabled: false,
      };
    }
    saveConfig({ fsImpl, OPENCLAW_DIR, config: nextCfg });

    const pairingRows = clearChannelAccountPairingRows({ provider, accountId });
    const pairingRowsFields = pairingRowsOutcomeFields(pairingRows);
    cleanupChannelAccountPairingFiles({ provider, accountId });
    if (provider === "whatsapp") {
      cleanupWhatsAppAuthFiles({ accountId });
    }
    if (provider === "whatsapp") {
      try {
        await restartGateway();
      } catch (error) {
        console.warn(
          `[alphaclaw] gateway restart failed after channel change: ${error.message}`,
        );
        return { ok: true, gatewayRestartFailed: true, ...restartDeferredFields(error), ...pairingRowsFields };
      }
    }
    return { ok: true, ...pairingRowsFields };
  };

  const listConfiguredChannelAccountsWithMaskedTokens = () => {
    const channels = listConfiguredChannelAccounts({
      fsImpl,
      OPENCLAW_DIR,
      cfg: withNormalizedAgentsConfig({
        OPENCLAW_DIR,
        cfg: loadConfig({ fsImpl, OPENCLAW_DIR }),
      }),
    });
    const envVars = readEnvFile();
    const envKeySet = new Set(
      (Array.isArray(envVars) ? envVars : [])
        .filter((v) => v?.key && String(v?.value || "").trim())
        .map((v) => String(v.key).trim()),
    );
    return channels.map((entry) => ({
      ...entry,
      accounts: entry.accounts.map((account) => ({
        ...account,
        token: envKeySet.has(String(account.envKey || "").trim())
          ? kMaskedChannelToken
          : "",
      })),
    }));
  };

  const runChannelAccountLogin = async ({
    provider: rawProvider,
    accountId: rawAccountId,
  } = {}) => {
    const provider = normalizeChannelProvider(rawProvider);
    if (provider !== "whatsapp") {
      throw new Error("Channel login is currently only supported for WhatsApp");
    }
    const accountId = String(rawAccountId || "").trim() || "default";
    // accountId is joined into credentials/whatsapp/<accountId>/creds.json; a
    // `../..` would traverse the filesystem, so reject anything but the strict
    // account-id shape (H5).
    if (accountId !== "default" && !isValidChannelAccountId(accountId)) {
      throw new Error("Invalid channel accountId");
    }
    const loginArgs = [
      "channels login",
      `--channel ${shellEscapeArg(provider)}`,
      accountId !== "default" ? `--account ${shellEscapeArg(accountId)}` : "",
    ].filter(Boolean);
    const loginStartedAt = Date.now();
    const result = await clawCmd(loginArgs.join(" "), {
      quiet: true,
      timeoutMs: 12000,
      killSignal: "SIGKILL",
      // The login CLI must outlive this call: the UI shows the QR from the
      // first 12 s of output and the CLI finishes linking in the background.
      killScope: "leader",
    });
    const elapsedMs = Date.now() - loginStartedAt;
    console.log(
      `[channels] login ${provider}/${accountId} finished ok=${!!result?.ok} code=${String(
        result?.code ?? "",
      )} elapsedMs=${elapsedMs}`,
    );
    return {
      ok: !!result?.ok,
      stdout: String(result?.stdout || ""),
      stderr: String(result?.stderr || ""),
      completed: !!result?.ok,
    };
  };

  const getChannelAccountLoginStatus = ({
    provider: rawProvider,
    accountId: rawAccountId,
  } = {}) => {
    const provider = normalizeChannelProvider(rawProvider);
    if (provider !== "whatsapp") {
      throw new Error("Channel login status is currently only supported for WhatsApp");
    }
    const accountId = String(rawAccountId || "").trim() || "default";
    // Same containment as login: this is a boolean file-exists oracle over an
    // accountId-derived path, so reject traversal shapes (H5).
    if (accountId !== "default" && !isValidChannelAccountId(accountId)) {
      throw new Error("Invalid channel accountId");
    }
    return {
      provider,
      accountId,
      linked: hasSavedWhatsAppCredentials({
        fsImpl,
        OPENCLAW_DIR,
        accountId,
      }),
    };
  };

  return {
    getChannelAccountToken,
    createChannelAccount,
    updateChannelAccount,
    deleteChannelAccount,
    runChannelAccountLogin,
    getChannelAccountLoginStatus,
    listConfiguredChannelAccountsWithMaskedTokens,
  };
};

module.exports = { createChannelsDomain };
