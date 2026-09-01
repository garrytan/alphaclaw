const fs = require("fs");
const path = require("path");
const { OPENCLAW_DIR } = require("./constants");
const { createSlackApi } = require("./slack-api");
const { readOpenclawConfig } = require("./openclaw-config");
const { postNotifyWebhookDirect } = require("./notify-webhook");
const { readChannelAllowEntriesByAccount } = require("./openclaw-state-era");
const { quoteShellArg } = require("./utils/shell");

const kSlackBotEnvKey = "SLACK_BOT_TOKEN";
const kWhatsAppOwnerNumberEnvKey = "WHATSAPP_OWNER_NUMBER";
// Fan-out webhook timeout is more generous than the boot-process direct path
// (5s): the server's flush loop tolerates a slow endpoint, boot must not.
const kNotifyWebhookFanoutTimeoutMs = 10_000;

const normalizeAccountId = (value) =>
  String(value || "").trim().toLowerCase() || "default";

const resolveCredentialPairingAccountId = ({ channel, fileName }) => {
  const prefix = `${String(channel || "").trim().toLowerCase()}-`;
  const suffix = "-allowFrom.json";
  const rawFileName = String(fileName || "").trim();
  if (!rawFileName.startsWith(prefix) || !rawFileName.endsWith(suffix)) {
    return "";
  }
  return normalizeAccountId(rawFileName.slice(prefix.length, -suffix.length));
};

const deriveSlackBotEnvKey = (accountId = "default") => {
  const normalizedAccountId = normalizeAccountId(accountId);
  if (normalizedAccountId === "default") return kSlackBotEnvKey;
  return `${kSlackBotEnvKey}_${normalizedAccountId.replace(/-/g, "_").toUpperCase()}`;
};

const getPairedTargetsByAccount = ({
  channel,
  fsImpl = fs,
  openclawDir = OPENCLAW_DIR,
}) => {
  const safeChannel = String(channel || "").trim().toLowerCase();
  if (!safeChannel) return new Map();
  const idsByAccount = new Map();
  // openclaw >= 2026.9.1-beta.1 imports the *-allowFrom.json files into
  // channel_pairing_allow_entries and DELETES them at gateway startup — the
  // sqlite rows become the only pairing-derived notification targets. Union
  // both sources unconditionally (at most one carries data outside the brief
  // import window): incident notifications must never die because the files
  // vanished, or because a store probe transiently failed.
  try {
    const sqliteEntries = readChannelAllowEntriesByAccount({
      fsModule: fsImpl,
      openclawDir,
      channel: safeChannel,
    });
    for (const [accountId, entries] of sqliteEntries) {
      const ids =
        idsByAccount.get(accountId) instanceof Set
          ? idsByAccount.get(accountId)
          : new Set();
      for (const entry of entries) ids.add(entry);
      if (ids.size > 0) idsByAccount.set(accountId, ids);
    }
    if (idsByAccount.size > 0) {
      console.log(
        `[watchdog] ${safeChannel} notification targets resolved from the sqlite pairing store (${idsByAccount.size} account(s))`,
      );
    }
  } catch (err) {
    console.error(
      `[watchdog] could not resolve ${safeChannel} allowFrom IDs from the state db: ${err.message}`,
    );
  }
  const credentialsDir = path.join(openclawDir, "credentials");
  if (!fsImpl.existsSync(credentialsDir)) {
    return new Map(
      Array.from(idsByAccount.entries()).map(([accountId, ids]) => [
        accountId,
        Array.from(ids),
      ]),
    );
  }
  try {
    const files = fsImpl
      .readdirSync(credentialsDir)
      .filter(
        (fileName) =>
          fileName.startsWith(`${safeChannel}-`) && fileName.endsWith("-allowFrom.json"),
      );
    for (const fileName of files) {
      const accountId = resolveCredentialPairingAccountId({
        channel: safeChannel,
        fileName,
      });
      if (!accountId) continue;
      const filePath = path.join(credentialsDir, fileName);
      const raw = fsImpl.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const allowFrom = Array.isArray(parsed?.allowFrom) ? parsed.allowFrom : [];
      const ids =
        idsByAccount.get(accountId) instanceof Set
          ? idsByAccount.get(accountId)
          : new Set();
      for (const id of allowFrom) {
        if (id == null) continue;
        const value = String(id).trim();
        if (!value) continue;
        ids.add(value);
      }
      idsByAccount.set(accountId, ids);
    }
  } catch (err) {
    console.error(`[watchdog] could not resolve ${safeChannel} allowFrom IDs: ${err.message}`);
  }
  return new Map(
    Array.from(idsByAccount.entries()).map(([accountId, ids]) => [
      accountId,
      Array.from(ids),
    ]),
  );
};

const getPairedIds = ({
  channel,
  fsImpl = fs,
  openclawDir = OPENCLAW_DIR,
}) => {
  const ids = new Set();
  const idsByAccount = getPairedTargetsByAccount({
    channel,
    fsImpl,
    openclawDir,
  });
  for (const accountIds of idsByAccount.values()) {
    for (const id of accountIds) {
      ids.add(id);
    }
  }
  return Array.from(ids);
};

// Shared Telegram bot-token resolver: .env first (canonical), then the
// literal token onboarding writes into openclaw.json
// (channels.telegram.botToken) — the #21 box had the token ONLY there, so
// every watchdog alert died with no_channels_delivered. Imported configs
// store a "${TELEGRAM_BOT_TOKEN}" placeholder instead of a literal token;
// that is an env reference (already covered by the env check) and is
// skipped. Any config read failure degrades to env-only: a broken
// openclaw.json must never break notification delivery — that is the exact
// incident these notifications exist for.
const resolveTelegramBotToken = ({
  env = process.env,
  fsImpl = fs,
  openclawDir = OPENCLAW_DIR,
} = {}) => {
  const envToken = String(env?.TELEGRAM_BOT_TOKEN || "").trim();
  if (envToken) return envToken;
  try {
    const config = readOpenclawConfig({
      fsModule: fsImpl,
      openclawDir,
      fallback: {},
    });
    const configToken = String(
      config?.channels?.telegram?.botToken || "",
    ).trim();
    if (!configToken || /^\$\{[^}]*\}$/.test(configToken)) return "";
    return configToken;
  } catch {
    return "";
  }
};

// openclaw.json channels.<ch>.allowFrom, as a raw array. Fallback-only
// target source (see the fan-out below); a missing/unparseable config
// degrades to [] — env + pairing files keep working regardless.
const readChannelAllowFromConfig = ({
  channel,
  fsImpl = fs,
  openclawDir = OPENCLAW_DIR,
} = {}) => {
  try {
    const config = readOpenclawConfig({
      fsModule: fsImpl,
      openclawDir,
      fallback: {},
    });
    const allowFrom = config?.channels?.[String(channel || "").trim()]?.allowFrom;
    return Array.isArray(allowFrom) ? allowFrom : [];
  } catch {
    return [];
  }
};

// allowFrom entries are authorization identities, not delivery destinations:
// only numeric chat IDs (groups are negative) are sendable — usernames,
// "@handles" and the "*" wildcard are not chat_ids and must be skipped.
const filterNumericChatIds = (entries) =>
  Array.from(
    new Set(
      (Array.isArray(entries) ? entries : [])
        .map((entry) => String(entry ?? "").trim())
        .filter((entry) => /^-?\d+$/.test(entry)),
    ),
  );

const formatDiscordMessage = (message) =>
  String(message || "").replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "**$1**");

/**
 * Track thread state for Slack notifications
 * Key: accountId:userId, Value: { threadTs, lastEvent }
 */
const slackThreads = new Map();

const createWatchdogNotifier = ({
  telegramApi,
  discordApi,
  slackApi,
  clawCmd = null,
  readEnvFile = () => [],
  createSlackApi: createSlackApiFactory = createSlackApi,
  fsImpl = fs,
  openclawDir = OPENCLAW_DIR,
  // Injectable token getters (default env). lib/server.js wires the shared
  // env→openclaw.json resolver (resolveTelegramBotToken) here AND into
  // createTelegramApi so both agree on what "configured" means.
  getTelegramToken = () => String(process.env.TELEGRAM_BOT_TOKEN || "").trim(),
  getDiscordToken = () => String(process.env.DISCORD_BOT_TOKEN || "").trim(),
  readChannelAllowFrom = (channel) =>
    readChannelAllowFromConfig({ channel, fsImpl, openclawDir }),
  fetchImpl = fetch,
}) => {
  // Alerts are the operator's Discover surface — they must be provably alive.
  let lastDeliveredAt = null;

  const notify = async (message, opts = {}) => {
    const summary = {
      telegram: { sent: 0, failed: 0, skipped: false, targets: 0 },
      discord: { sent: 0, failed: 0, skipped: false, targets: 0 },
      slack: { sent: 0, failed: 0, skipped: false, targets: 0 },
      whatsapp: { sent: 0, failed: 0, skipped: false, targets: 0 },
      webhook: { sent: 0, failed: 0, skipped: false, targets: 0 },
    };
    const envVars = typeof readEnvFile === "function" ? readEnvFile() : [];
    const envMap = new Map(
      (Array.isArray(envVars) ? envVars : [])
        .map((entry) => [
          String(entry?.key || "").trim(),
          String(entry?.value || "").trim(),
        ])
        .filter(([key]) => key),
    );
    let telegramTargets = getPairedIds({
      channel: "telegram",
      fsImpl,
      openclawDir,
    });
    if (telegramTargets.length > 0) {
      console.log(
        `[watchdog] telegram notification targets resolved from the pairing store (${telegramTargets.length})`,
      );
    }
    if (telegramTargets.length === 0) {
      // Pairing files are the canonical target source; when none exist (fresh
      // box, wiped credentials dir — the #21 incident), fall back to the
      // numeric chat IDs in openclaw.json channels.telegram.allowFrom.
      // TELEGRAM ONLY: Discord allowFrom holds user IDs, not channel IDs —
      // minting DM channels for never-paired users is out of scope — and
      // Slack allowFrom is out of scope because targets there are per-account
      // (accountId → SLACK_BOT_TOKEN_<ID> derivation) and pairing files
      // remain its only account-aware source today.
      let fallbackAllowFrom = [];
      try {
        fallbackAllowFrom =
          typeof readChannelAllowFrom === "function"
            ? readChannelAllowFrom("telegram")
            : [];
      } catch {
        // A broken config read degrades to no fallback targets, never to a
        // failed fan-out.
      }
      telegramTargets = filterNumericChatIds(fallbackAllowFrom);
      if (telegramTargets.length > 0) {
        // Source visibility [8A]: pairing-store hits log inside
        // getPairedTargetsByAccount; this is the config-fallback branch.
        console.log(
          `[watchdog] telegram notification targets resolved from openclaw.json channels.telegram.allowFrom (${telegramTargets.length})`,
        );
      }
    }
    summary.telegram.targets = telegramTargets.length;
    if (!telegramApi?.sendMessage || !getTelegramToken() || telegramTargets.length === 0) {
      summary.telegram.skipped = true;
    } else {
      for (const chatId of telegramTargets) {
        try {
          // No link previews: Telegram's unfurler must not redeem rescue
          // capability links (and dashboard-link previews are noise anyway).
          await telegramApi.sendMessage(chatId, String(message || ""), {
            parseMode: "Markdown",
            disableWebPagePreview: true,
          });
          summary.telegram.sent += 1;
        } catch (err) {
          summary.telegram.failed += 1;
          console.error(`[watchdog] telegram notification failed for ${chatId}: ${err.message}`);
        }
      }
    }

    // No allowFrom fallback here (deliberate — see the Telegram fallback
    // comment above): Discord allowFrom entries are user IDs, not channel
    // IDs, and DM-channel creation for never-paired users is out of scope.
    const discordTargets = getPairedIds({
      channel: "discord",
      fsImpl,
      openclawDir,
    });
    summary.discord.targets = discordTargets.length;
    if (!discordApi?.sendDirectMessage || !getDiscordToken() || discordTargets.length === 0) {
      summary.discord.skipped = true;
    } else {
      const discordMessage = formatDiscordMessage(message);
      for (const userId of discordTargets) {
        try {
          // suppressEmbeds: Discord's crawler must not redeem rescue links.
          await discordApi.sendDirectMessage(userId, discordMessage, {
            suppressEmbeds: true,
          });
          summary.discord.sent += 1;
        } catch (err) {
          summary.discord.failed += 1;
          console.error(`[watchdog] discord notification failed for ${userId}: ${err.message}`);
        }
      }
    }

    // Enhanced Slack notifications with threading and reactions.
    // No allowFrom fallback here either (deliberate): Slack targets are
    // per-account (accountId → SLACK_BOT_TOKEN_<ID>), and openclaw.json's
    // flat allowFrom list carries no account association — pairing files
    // remain Slack's only target source.
    const slackTargetsByAccount = getPairedTargetsByAccount({
      channel: "slack",
      fsImpl,
      openclawDir,
    });
    summary.slack.targets = Array.from(slackTargetsByAccount.values()).reduce(
      (total, targets) => total + targets.length,
      0,
    );
    if (summary.slack.targets === 0) {
      summary.slack.skipped = true;
    } else {
      const eventType = opts.eventType || "info"; // crash, recovery, health, info
      for (const [accountId, slackTargets] of slackTargetsByAccount.entries()) {
        if (!slackTargets.length) continue;
        const envKey = deriveSlackBotEnvKey(accountId);
        const botToken = String(envMap.get(envKey) || process.env[envKey] || "").trim();
        if (!botToken) {
          summary.slack.failed += slackTargets.length;
          for (const userId of slackTargets) {
            console.error(
              `[watchdog] slack notification failed for ${accountId}/${userId}: missing ${envKey}`,
            );
          }
          continue;
        }

        const accountSlackApi =
          accountId === "default" &&
          slackApi?.postMessage &&
          botToken === String(process.env.SLACK_BOT_TOKEN || "").trim()
            ? slackApi
            : createSlackApiFactory(() => botToken);

        for (const userId of slackTargets) {
          try {
            let threadTs = null;
            let shouldCreateNewThread = true;
            const threadKey = `${accountId}:${userId}`;

            const existingThread = slackThreads.get(threadKey);
            if (existingThread && existingThread.lastEvent === "crash" && eventType === "recovery") {
              threadTs = existingThread.threadTs;
              shouldCreateNewThread = false;
            }

            const result = await accountSlackApi.postMessage(userId, String(message || ""), {
              thread_ts: threadTs,
              mrkdwn: true,
              // Slack's unfurler must not redeem rescue capability links.
              unfurl_links: false,
              unfurl_media: false,
            });

            if (shouldCreateNewThread && result.ts) {
              slackThreads.set(threadKey, {
                threadTs: result.ts,
                lastEvent: eventType,
              });
            }

            if (result.ts && result.channel && accountSlackApi.addReaction) {
              try {
                if (eventType === "crash" || eventType === "upgrade_failed") {
                  await accountSlackApi.addReaction(result.channel, result.ts, "x");
                } else if (eventType === "recovery") {
                  await accountSlackApi.addReaction(
                    result.channel,
                    result.ts,
                    "white_check_mark",
                  );
                } else if (eventType === "health") {
                  await accountSlackApi.addReaction(result.channel, result.ts, "heart");
                }
              } catch (reactionErr) {
                console.error(
                  `[watchdog] slack reaction failed for ${accountId}/${userId}: ${reactionErr.message}`,
                );
              }
            }

            summary.slack.sent += 1;
          } catch (err) {
            summary.slack.failed += 1;
            console.error(
              `[watchdog] slack notification failed for ${accountId}/${userId}: ${err.message}`,
            );
          }
        }
      }
    }

    const whatsAppOwnerNumber = String(
      envMap.get(kWhatsAppOwnerNumberEnvKey) ||
        process.env[kWhatsAppOwnerNumberEnvKey] ||
        "",
    ).trim();
    const whatsappTargets = whatsAppOwnerNumber ? [whatsAppOwnerNumber] : [];
    summary.whatsapp.targets = whatsappTargets.length;
    if (!clawCmd || whatsappTargets.length === 0) {
      summary.whatsapp.skipped = true;
    } else {
      for (const target of whatsappTargets) {
        try {
          const result = await clawCmd(
            `message send --channel whatsapp --target ${quoteShellArg(
              String(target || "").trim(),
            )} --message ${quoteShellArg(String(message || ""))}`,
            { quiet: true, timeoutMs: 30000 },
          );
          if (!result?.ok) {
            throw new Error(
              String(result?.stderr || result?.stdout || "WhatsApp send failed"),
            );
          }
          summary.whatsapp.sent += 1;
        } catch (err) {
          summary.whatsapp.failed += 1;
          console.error(`[watchdog] whatsapp notification failed for ${target}: ${err.message}`);
        }
      }
    }

    // Out-of-band webhook (ALPHACLAW_NOTIFY_WEBHOOK_URL): the one channel
    // that still works when every chat integration is down — the exact
    // incident scenario watchdog alerts exist for. Failures count per-channel
    // like everywhere else and never crash the fan-out (the shared helper
    // swallows all errors).
    const webhookUrl = String(
      process.env.ALPHACLAW_NOTIFY_WEBHOOK_URL || "",
    ).trim();
    summary.webhook.targets = webhookUrl ? 1 : 0;
    if (!webhookUrl) {
      summary.webhook.skipped = true;
    } else {
      const webhookOk = await postNotifyWebhookDirect(String(message || ""), {
        fetchImpl,
        timeoutMs: kNotifyWebhookFanoutTimeoutMs,
      });
      if (webhookOk) {
        summary.webhook.sent += 1;
      } else {
        summary.webhook.failed += 1;
        console.error("[watchdog] webhook notification failed (POST did not succeed)");
      }
    }

    const sent =
      summary.telegram.sent +
      summary.discord.sent +
      summary.slack.sent +
      summary.whatsapp.sent +
      summary.webhook.sent;
    const failed =
      summary.telegram.failed +
      summary.discord.failed +
      summary.slack.failed +
      summary.whatsapp.failed +
      summary.webhook.failed;
    if (sent > 0) lastDeliveredAt = new Date().toISOString();
    return {
      ok: sent > 0,
      sent,
      failed,
      channels: summary,
      ...(sent === 0 ? { reason: "no_channels_delivered" } : {}),
    };
  };

  // Targeted delivery for explicit admin recipients ({channel, target,
  // accountId}) — used by the preferred-channel routing layer instead of the
  // fan-out above. Returns { ok, reason? } and never throws.
  const sendToTarget = async ({ channel, target, accountId } = {}, message) => {
    const safeChannel = String(channel || "").trim().toLowerCase();
    const safeTarget = String(target || "").trim();
    if (!safeChannel || !safeTarget) {
      return { ok: false, reason: "invalid_target" };
    }
    try {
      if (safeChannel === "telegram") {
        if (!telegramApi?.sendMessage || !getTelegramToken()) {
          return { ok: false, reason: "telegram_unconfigured" };
        }
        await telegramApi.sendMessage(safeTarget, String(message || ""), {
          parseMode: "Markdown",
          disableWebPagePreview: true,
        });
        lastDeliveredAt = new Date().toISOString();
        return { ok: true };
      }
      if (safeChannel === "discord") {
        if (!discordApi?.sendDirectMessage || !getDiscordToken()) {
          return { ok: false, reason: "discord_unconfigured" };
        }
        await discordApi.sendDirectMessage(
          safeTarget,
          formatDiscordMessage(message),
          { suppressEmbeds: true },
        );
        lastDeliveredAt = new Date().toISOString();
        return { ok: true };
      }
      if (safeChannel === "slack") {
        const envVars = typeof readEnvFile === "function" ? readEnvFile() : [];
        const envMap = new Map(
          (Array.isArray(envVars) ? envVars : [])
            .map((entry) => [
              String(entry?.key || "").trim(),
              String(entry?.value || "").trim(),
            ])
            .filter(([key]) => key),
        );
        const envKey = deriveSlackBotEnvKey(accountId || "default");
        const botToken = String(
          envMap.get(envKey) || process.env[envKey] || "",
        ).trim();
        if (!botToken) return { ok: false, reason: `missing ${envKey}` };
        const api =
          botToken === String(process.env.SLACK_BOT_TOKEN || "").trim() &&
          slackApi?.postMessage
            ? slackApi
            : createSlackApiFactory(() => botToken);
        await api.postMessage(safeTarget, String(message || ""), {
          mrkdwn: true,
          unfurl_links: false,
          unfurl_media: false,
        });
        lastDeliveredAt = new Date().toISOString();
        return { ok: true };
      }
      if (safeChannel === "whatsapp") {
        if (!clawCmd) return { ok: false, reason: "whatsapp_unconfigured" };
        const result = await clawCmd(
          `message send --channel whatsapp --target ${quoteShellArg(safeTarget)} --message ${quoteShellArg(String(message || ""))}`,
          { quiet: true, timeoutMs: 30000 },
        );
        if (!result?.ok) {
          return {
            ok: false,
            reason: String(result?.stderr || result?.stdout || "send failed"),
          };
        }
        lastDeliveredAt = new Date().toISOString();
        return { ok: true };
      }
      return { ok: false, reason: `unsupported channel ${safeChannel}` };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  };

  return { notify, sendToTarget, getLastDeliveredAt: () => lastDeliveredAt };
};

module.exports = {
  createWatchdogNotifier,
  resolveTelegramBotToken,
  // Exported for tests: the sqlite/file union is the load-bearing piece of
  // incident-notification target resolution on sqlite-era openclaw.
  getPairedTargetsByAccount,
};
