const path = require("path");
const { writeFileAtomic } = require("./utils/safe-file");
const { updateOpenclawConfig } = require("./openclaw-config");
const {
  readGoogleState,
  writeGoogleState,
  updateGoogleState,
  listGoogleAccounts,
  getGoogleAccountById,
  getGoogleAccountByEmail,
  getGmailPushConfig,
  setGmailPushConfig,
  getAccountGmailWatch,
  setAccountGmailWatch,
  listWatchEnabledAccounts,
  generatePushToken,
  allocateServePort,
} = require("./google-state");
const { createGmailServeManager } = require("./gmail-serve");
const { parseJsonObjectFromNoisyOutput, parseJsonSafe } = require("./utils/json");
const { createWebhook } = require("./webhooks");
const { readOpenclawConfig } = require("./openclaw-config");
const { quoteShellArg } = require("./utils/shell");

const parseExpirationFromOutput = (raw) => {
  const parsed =
    parseJsonSafe(raw, null, { trim: true }) ||
    parseJsonObjectFromNoisyOutput(raw);
  if (parsed?.expiration) {
    const numeric = Number.parseInt(String(parsed.expiration), 10);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  const text = String(raw || "");
  const epochMatch = text.match(/"expiration"\s*:\s*"?(\d{10,})"?/i);
  if (epochMatch?.[1]) {
    const numeric = Number.parseInt(epochMatch[1], 10);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return null;
};

const createTopicNameForClient = (client = "default") => {
  const normalizedClient = String(client || "default")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!normalizedClient || normalizedClient === "default") {
    return "gog-gmail-watch";
  }
  return `gog-gmail-watch-${normalizedClient}`;
};

const createSubscriptionNameForClient = (client = "default") =>
  `${createTopicNameForClient(client)}-push`;

const parseTopicName = (topicPath = "") => {
  const match = String(topicPath || "").match(/\/topics\/([^/]+)$/);
  return match?.[1] ? String(match[1]) : "";
};

const parseProjectIdFromTopicPath = (topicPath = "") => {
  const match = String(topicPath || "").match(/^projects\/([^/]+)\/topics\/[^/]+$/);
  return match?.[1] ? String(match[1]) : "";
};

const normalizeDestination = (destination = null) => {
  if (!destination || typeof destination !== "object") return null;
  const channel = String(destination?.channel || "").trim();
  const to = String(destination?.to || "").trim();
  const agentId = String(destination?.agentId || "").trim();
  if (!channel && !to && !agentId) return null;
  if (!channel || !to) {
    throw new Error("destination.channel and destination.to are required");
  }
  return {
    channel,
    to,
    ...(agentId ? { agentId } : {}),
  };
};

const buildGmailTransformSource = (destination = null) => {
  const normalizedDestination = normalizeDestination(destination);
  return [
    "export default async function transform(payload) {",
    "  const data = payload?.payload || payload || {};",
    "  const messages = Array.isArray(data.messages) ? data.messages : [];",
    "  const first = messages[0] || {};",
    "  const from = String(first.from || \"unknown sender\").trim();",
    "  const subject = String(first.subject || \"(no subject)\").trim();",
    "  const snippet = String(first.snippet || \"\").trim();",
    "  return {",
    "    message: `New email from ${from}\\nSubject: ${subject}\\n${snippet}`.trim(),",
    "    messages,",
    '    name: "Gmail",',
    '    wakeMode: "now",',
    ...(normalizedDestination
      ? [
          `    channel: ${JSON.stringify(normalizedDestination.channel)},`,
          `    to: ${JSON.stringify(normalizedDestination.to)},`,
          ...(normalizedDestination.agentId
            ? [`    agentId: ${JSON.stringify(normalizedDestination.agentId)},`]
            : []),
        ]
      : []),
    "  };",
    "}",
    "",
  ].join("\n");
};

const hasGmailWebhookMapping = ({ fs, openclawDir }) => {
  const cfg = readOpenclawConfig({
    fsModule: fs,
    openclawDir,
    fallback: {},
  });
  const mappings = Array.isArray(cfg?.hooks?.mappings) ? cfg.hooks.mappings : [];
  return mappings.some(
    (mapping) => String(mapping?.match?.path || "").trim().toLowerCase() === "gmail",
  );
};

const getGmailTransformAbsolutePath = (constants) =>
  path.join(constants.OPENCLAW_DIR, "hooks/transforms/gmail/gmail-transform.mjs");

const ensureTopicPathForClient = ({
  state,
  client,
  readGoogleCredentials,
  projectIdOverride = "",
}) => {
  const normalizedClient = String(client || "default").trim() || "default";
  const push = getGmailPushConfig(state);
  const existingTopic = String(push.topics?.[normalizedClient] || "").trim();
  const requestedProjectId = String(projectIdOverride || "").trim();
  const existingProjectId = parseProjectIdFromTopicPath(existingTopic);
  if (existingTopic && (!requestedProjectId || requestedProjectId === existingProjectId)) {
    return { state, topicPath: existingTopic };
  }
  const credentials = readGoogleCredentials(normalizedClient);
  const projectId =
    requestedProjectId ||
    String(credentials?.projectId || "").trim();
  if (!projectId) {
    throw new Error(
      `Could not detect GCP project_id for client "${normalizedClient}". Save Google credentials first.`,
    );
  }
  const topicName =
    parseTopicName(existingTopic) || createTopicNameForClient(normalizedClient);
  const topicPath = `projects/${projectId}/topics/${topicName}`;
  const updated = setGmailPushConfig({
    state,
    config: {
      topics: {
        [normalizedClient]: topicPath,
      },
    },
  });
  return {
    state: updated.state,
    topicPath,
  };
};

const createGmailWatchService = ({
  fs,
  constants,
  gogCmd,
  getBaseUrl,
  readGoogleCredentials,
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  restartRequiredState,
}) => {
  const ensureAccountClientMappings = ({ state }) => {
    const configDir = String(constants.GOG_CONFIG_DIR || "").trim();
    if (!configDir) return;
    const configPath = path.join(configDir, "config.json");
    let currentConfig = {};
    if (fs.existsSync(configPath)) {
      // Fail closed (fix wave F190): gog owns other keys in this file. An
      // existing file this code cannot parse used to be rebuilt from {} —
      // dropping gog's keys silently and permanently (the boot sentinel
      // "config.json exists → skip `gog auth keyring file`" never re-seeds).
      // Leave it alone and say so; the mapping write is best-effort anyway.
      try {
        const raw = String(fs.readFileSync(configPath, "utf8") || "").trim();
        if (raw) {
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("config root is not an object");
          }
          currentConfig = parsed;
        }
      } catch (error) {
        const refusal = Object.assign(
          new Error(`gog config.json at ${configPath} is not JSON alphaclaw can parse (${error.message})`),
          { code: "GOG_CONFIG_UNREADABLE", filePath: configPath },
        );
        try {
          require("./utils/config-unreadable").noteConfigUnreadable({
            error: refusal,
            source: "gmail-watch",
          });
        } catch {}
        return;
      }
    }

    const nextAccountClients = {
      ...(currentConfig.account_clients &&
      typeof currentConfig.account_clients === "object" &&
      !Array.isArray(currentConfig.account_clients)
        ? currentConfig.account_clients
        : {}),
    };
    for (const account of listGoogleAccounts(state)) {
      const email = String(account?.email || "").trim().toLowerCase();
      const client = String(account?.client || "default").trim() || "default";
      if (!email) continue;
      nextAccountClients[email] = client;
    }
    const nextConfig = {
      ...currentConfig,
      account_clients: nextAccountClients,
    };
    const previousSerialized = JSON.stringify(currentConfig);
    const nextSerialized = JSON.stringify(nextConfig);
    if (previousSerialized === nextSerialized) return;
    fs.mkdirSync(configDir, { recursive: true });
    writeFileAtomic(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, { fsModule: fs });
  };

  const readState = () =>
    readGoogleState({
      fs,
      statePath: constants.GOG_STATE_PATH,
    });

  const saveState = (state) => {
    ensureAccountClientMappings({ state });
    writeGoogleState({
      fs,
      statePath: constants.GOG_STATE_PATH,
      state,
    });
  };

  // Locked read-modify-write for the async paths (startWatch/stopWatch/renew/
  // serve-restart) whose read→write spans multi-second subprocess awaits: a
  // concurrent google-state writer (e.g. an OAuth-callback completion, or a
  // disconnect) landing in that window would otherwise be clobbered — erasing a
  // just-connected account and orphaning its live token. The slow awaits stay
  // OUTSIDE the lock; only the small final mutation runs inside it against fresh
  // state. Mirrors saveState's ensureAccountClientMappings side effect.
  const updateState = (mutator) =>
    updateGoogleState({
      fs,
      statePath: constants.GOG_STATE_PATH,
      mutator: (current) => {
        const next = mutator(current) ?? current;
        ensureAccountClientMappings({ state: next });
        return next;
      },
    });

  const markRestartRequired = (source = "gmail-watch") => {
    try {
      restartRequiredState?.markRequired?.(source);
    } catch {}
  };

  const ensurePushToken = ({ state, forceRegenerate = false }) => {
    const current = getGmailPushConfig(state);
    if (current.token && !forceRegenerate) {
      return { state, token: current.token };
    }
    const token = generatePushToken();
    const updated = setGmailPushConfig({
      state,
      config: {
        ...current,
        token,
      },
    });
    return { state: updated.state, token };
  };

  const ensureWebhookToken = () => {
    const existing = String(process.env.WEBHOOK_TOKEN || "").trim();
    if (existing) return { token: existing, changed: false };
    const vars = readEnvFile();
    const tokenFromFile = String(
      vars.find((entry) => entry.key === "WEBHOOK_TOKEN")?.value || "",
    ).trim();
    if (tokenFromFile) {
      process.env.WEBHOOK_TOKEN = tokenFromFile;
      return { token: tokenFromFile, changed: false };
    }
    const token = generatePushToken();
    const nextVars = vars.filter((entry) => entry.key !== "WEBHOOK_TOKEN");
    nextVars.push({ key: "WEBHOOK_TOKEN", value: token });
    writeEnvFile(nextVars);
    reloadEnv();
    return { token, changed: true };
  };

  const ensureHooksPreset = ({ destination = null } = {}) => {
    const configPath = path.join(constants.OPENCLAW_DIR, "openclaw.json");
    if (!fs.existsSync(configPath)) {
      throw new Error("openclaw.json not found. Complete onboarding first.");
    }
    const gmailTransformModulePath = "gmail/gmail-transform.mjs";
    // One locked, fail-closed, atomic, shape-preserving read-modify-write
    // (fix wave F096): the raw JSON.parse + writeFileSync pair here raced the
    // other openclaw.json writers and would rebuild a torn file from scratch.
    let changed = false;
    updateOpenclawConfig({
      fsModule: fs,
      openclawDir: constants.OPENCLAW_DIR,
      mutate: (cfg) => {
        if (!cfg.hooks || typeof cfg.hooks !== "object") {
          cfg.hooks = {};
          changed = true;
        }
        if (cfg.hooks.enabled !== true) {
          cfg.hooks.enabled = true;
          changed = true;
        }
        if (typeof cfg.hooks.token !== "string" || !cfg.hooks.token.trim()) {
          cfg.hooks.token = "${WEBHOOK_TOKEN}";
          changed = true;
        }
        if (!Array.isArray(cfg.hooks.presets)) {
          cfg.hooks.presets = [];
          changed = true;
        }
        if (!cfg.hooks.presets.includes("gmail")) {
          cfg.hooks.presets = [...cfg.hooks.presets, "gmail"];
          changed = true;
        }
        return changed ? {} : { skipWrite: true };
      },
    });
    const webhookBefore = fs.readFileSync(configPath, "utf8");
    createWebhook({
      fs,
      constants,
      name: "gmail",
      upsert: true,
      allowManagedName: true,
      mapping: {
        action: "agent",
        name: "Gmail",
        wakeMode: "now",
        transform: { module: gmailTransformModulePath },
      },
      transformSource: buildGmailTransformSource(destination),
    });
    const webhookAfter = fs.readFileSync(configPath, "utf8");
    if (webhookBefore !== webhookAfter) {
      changed = true;
    }
    return { changed };
  };

  const ensureHookWiring = ({ destination = null } = {}) => {
    const webhook = ensureWebhookToken();
    const hooks = ensureHooksPreset({ destination });
    const changed = webhook.changed || hooks.changed;
    if (changed) markRestartRequired("gmail-watch");
    return { webhookToken: webhook.token, changed };
  };

  const runGogForAccount = async ({ account, command, quiet = true }) => {
    const client = String(account?.client || "default").trim() || "default";
    const prefix = client === "default" ? "" : `--client ${quoteShellArg(client)} `;
    return await gogCmd(`${prefix}${command}`, { quiet });
  };

  let serviceRef = null;
  const serveManager = createGmailServeManager({
    constants,
    onServeExit: (payload) => {
      const accountId = String(payload?.accountId || "").trim();
      if (!accountId) return;
      setTimeout(async () => {
        try {
          const state = readState();
          const account = getGoogleAccountById(state, accountId);
          const watch = getAccountGmailWatch(account || {});
          if (!account || !watch.enabled || !watch.port) return;
          const token = String(
            process.env.WEBHOOK_TOKEN || "",
          ).trim();
          if (!token) return;
          const status = await serveManager.startServe({
            account,
            port: watch.port,
            webhookToken: token,
          });
          // Persist the new pid under the lock against fresh state — this runs
          // on a 5s timer that can fire concurrently with a disconnect/callback.
          updateState((current) =>
            setAccountGmailWatch({
              state: current,
              accountId,
              watch: { pid: status.pid || null },
            }).state,
          );
        } catch (err) {
          console.error("[alphaclaw] Gmail serve auto-restart failed:", err);
        }
      }, 5000);
    },
  });

  const buildClientConfig = ({ state, client, baseUrl }) => {
    const normalizedClient = String(client || "default").trim() || "default";
    const push = getGmailPushConfig(state);
    const topicPath = String(push.topics?.[normalizedClient] || "").trim();
    const credentials = readGoogleCredentials(normalizedClient);
    const projectId =
      String(credentials?.projectId || "").trim() ||
      parseProjectIdFromTopicPath(topicPath);
    const topicName = parseTopicName(topicPath) || createTopicNameForClient(normalizedClient);
    const subscriptionName = createSubscriptionNameForClient(normalizedClient);
    const pushEndpoint = `${baseUrl}/gmail-pubsub?token=${encodeURIComponent(
      String(push.token || ""),
    )}`;
    const transformExists = fs.existsSync(getGmailTransformAbsolutePath(constants));
    const webhookExists = hasGmailWebhookMapping({
      fs,
      openclawDir: constants.OPENCLAW_DIR,
    });
    const commands =
      projectId && push.token
        ? {
            enableApis: `gcloud --project ${projectId} services enable gmail.googleapis.com pubsub.googleapis.com`,
            createTopic: `gcloud --project ${projectId} pubsub topics create ${topicName}`,
            grantPublisher: `gcloud --project ${projectId} pubsub topics add-iam-policy-binding ${topicName} --member=serviceAccount:gmail-api-push@system.gserviceaccount.com --role=roles/pubsub.publisher`,
            createSubscription: `gcloud --project ${projectId} pubsub subscriptions create ${subscriptionName} --topic ${topicName} --push-endpoint "${pushEndpoint}"`,
          }
        : null;
    return {
      client: normalizedClient,
      projectId: projectId || null,
      topicPath: topicPath || null,
      topicName,
      subscriptionName,
      pushEndpoint,
      commands,
      transformExists,
      webhookExists,
      configured: Boolean(topicPath && push.token && projectId),
    };
  };

  const getConfig = ({ req }) => {
    let state = readState();
    const ensuredPush = ensurePushToken({ state });
    state = ensuredPush.state;
    saveState(state);
    const baseUrl = getBaseUrl(req);
    const clients = Array.from(
      new Set(
        listGoogleAccounts(state).map(
          (account) => String(account.client || "default").trim() || "default",
        ),
      ),
    );
    const clientConfigs = clients.map((client) =>
      buildClientConfig({ state, client, baseUrl }),
    );
    const serveStatuses = new Map(
      serveManager
        .listServeStatuses()
        .map((status) => [String(status.accountId || ""), status]),
    );
    const accounts = listGoogleAccounts(state).map((account) => {
      const watch = getAccountGmailWatch(account);
      const serve = serveStatuses.get(String(account.id || "")) || null;
      return {
        accountId: account.id,
        email: account.email,
        client: account.client || "default",
        enabled: watch.enabled,
        port: watch.port || null,
        expiration: watch.expiration || null,
        lastPushAt: watch.lastPushAt || null,
        pid: serve?.pid || watch.pid || null,
        running: Boolean(serve?.running),
      };
    });
    return {
      ok: true,
      pushToken: ensuredPush.token,
      pushEndpoint: `${baseUrl}/gmail-pubsub?token=${encodeURIComponent(
        ensuredPush.token,
      )}`,
      clients: clientConfigs,
      accounts,
    };
  };

  const saveClientConfig = ({ req, body = {} }) => {
    let state = readState();
    const client = String(body.client || "default").trim() || "default";
    const ensuredPush = ensurePushToken({
      state,
      forceRegenerate: Boolean(body.regeneratePushToken),
    });
    state = ensuredPush.state;
    let topicPath = String(body.topicPath || "").trim();
    if (!topicPath) {
      const ensuredTopic = ensureTopicPathForClient({
        state,
        client,
        readGoogleCredentials,
        projectIdOverride: String(body.projectId || "").trim(),
      });
      state = ensuredTopic.state;
      topicPath = ensuredTopic.topicPath;
    } else {
      const updatedPush = setGmailPushConfig({
        state,
        config: {
          topics: {
            [client]: topicPath,
          },
        },
      });
      state = updatedPush.state;
    }
    saveState(state);
    const baseUrl = getBaseUrl(req);
    return {
      ok: true,
      client: buildClientConfig({ state, client, baseUrl }),
      topicPath,
      pushToken: getGmailPushConfig(state).token,
    };
  };

  const startWatch = async ({ accountId, req, destination = null }) => {
    let state = readState();
    const account = getGoogleAccountById(state, accountId);
    if (!account) throw new Error("Google account not found");
    if (!Array.isArray(account.services) || !account.services.includes("gmail:read")) {
      throw new Error("Account is missing gmail:read permission");
    }
    const client = String(account.client || "default").trim() || "default";
    const ensuredPush = ensurePushToken({ state });
    state = ensuredPush.state;
    const ensuredTopic = ensureTopicPathForClient({
      state,
      client,
      readGoogleCredentials,
    });
    state = ensuredTopic.state;
    const topicPath = ensuredTopic.topicPath;

    const { webhookToken } = ensureHookWiring({ destination });
    const watchStart = await runGogForAccount({
      account,
      command:
        `gmail watch start --json --account ${quoteShellArg(account.email)} ` +
        `--topic ${quoteShellArg(topicPath)} --label INBOX`,
    });
    if (!watchStart.ok) {
      throw new Error(watchStart.stderr || "Failed to start Gmail watch");
    }

    const currentWatch = getAccountGmailWatch(account);
    const selectedPort =
      currentWatch.port ||
      allocateServePort({
        state,
        basePort: constants.kGmailServeBasePort,
        maxAccounts: constants.kMaxGoogleAccounts,
      });
    if (!selectedPort) {
      throw new Error("No available Gmail watch serve ports");
    }
    const serveStatus = await serveManager.startServe({
      account,
      port: selectedPort,
      webhookToken,
    });
    const expiration = parseExpirationFromOutput(watchStart.stdout);
    // Persist under the lock, applying the values COMPUTED above (push token,
    // topic path, watch) to freshly-read state — the pre-await `state` was a
    // stale snapshot and a concurrent callback/disconnect may have written
    // since. Re-apply the exact computed push token/topic (not a fresh
    // ensure*, which could mint a different token than the one already used in
    // the gog watch-start command) plus the watch, merging into current state.
    let updatedAccount = null;
    updateState((current) => {
      const freshPush = getGmailPushConfig(current);
      let next = setGmailPushConfig({
        state: current,
        config: {
          ...freshPush,
          // Set-if-absent: only write the pre-await token when fresh state has
          // none, so a concurrent saveClientConfig({regeneratePushToken}) that
          // rotated the token during our awaits isn't clobbered with the stale
          // one. (The mint case — first watch ever — is the only time fresh
          // state lacks a token, and there our computed token is the right one.)
          token: freshPush.token || ensuredPush.token,
          topics: { ...freshPush.topics, [client]: topicPath },
        },
      }).state;
      const r = setAccountGmailWatch({
        state: next,
        accountId,
        watch: {
          enabled: true,
          port: selectedPort,
          expiration,
          pid: serveStatus.pid || null,
        },
      });
      updatedAccount = r.account;
      return r.state;
    });
    return {
      ok: true,
      accountId,
      client,
      topicPath,
      watch: getAccountGmailWatch(updatedAccount),
      serve: serveStatus,
    };
  };

  const stopWatch = async ({ accountId }) => {
    const account = getGoogleAccountById(readState(), accountId);
    if (!account) return { ok: true, accountId, skipped: true };

    // Disable the watch in state FIRST, under the lock. Two reasons: (1) the
    // serve process's own SIGTERM in stopServe below triggers onServeExit's
    // 5s auto-restart, which re-reads state and bails only when the watch is
    // already disabled — writing it first closes that restart race (which
    // would otherwise strand a serve process on its port after the account is
    // gone); (2) the locked write can't be clobbered by a concurrent
    // OAuth-callback/disconnect landing during the awaits below.
    let updatedAccount = null;
    updateState((current) => {
      const r = setAccountGmailWatch({
        state: current,
        accountId,
        watch: { enabled: false, pid: null },
      });
      updatedAccount = r.account;
      return r.state;
    });

    await serveManager.stopServe({ accountId });
    const watchStop = await runGogForAccount({
      account,
      command: `gmail watch stop --account ${quoteShellArg(account.email)} --force`,
    });
    if (!watchStop.ok) {
      console.log(
        `[alphaclaw] Gmail watch stop warning (${account.email}): ${watchStop.stderr || "unknown"}`,
      );
    }
    return { ok: true, accountId, watch: getAccountGmailWatch(updatedAccount) };
  };

  const renewWatch = async ({ accountId = "", force = false }) => {
    let state = readState();
    const now = Date.now();
    const allTargets = accountId
      ? [getGoogleAccountById(state, accountId)].filter(Boolean)
      : listWatchEnabledAccounts(state);
    const results = [];
    for (const account of allTargets) {
      const watch = getAccountGmailWatch(account);
      const shouldRenew =
        force ||
        !watch.expiration ||
        watch.expiration - now <= constants.kGmailWatchRenewalThresholdMs;
      if (!shouldRenew) {
        results.push({
          accountId: account.id,
          skipped: true,
          reason: "not_due",
        });
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const renewed = await startWatch({ accountId: account.id, req: null });
        results.push({
          accountId: account.id,
          renewed: true,
          expiration: renewed.watch.expiration || null,
        });
      } catch (err) {
        results.push({
          accountId: account.id,
          renewed: false,
          error: err.message || "renew_failed",
        });
      }
    }
    return { ok: true, results };
  };

  let renewalTimer = null;
  const start = () => {
    const run = async () => {
      try {
        await renewWatch({ force: false });
      } catch (err) {
        console.error("[alphaclaw] Gmail watch renewal error:", err);
      }
    };
    if (renewalTimer) clearInterval(renewalTimer);
    renewalTimer = setInterval(run, constants.kGmailWatchRenewalIntervalMs);
    renewalTimer.unref?.();

    setTimeout(async () => {
      try {
        const hookToken = String(
          process.env.WEBHOOK_TOKEN || "",
        ).trim();
        const enabled = listWatchEnabledAccounts(readState());
        // Collect the restored pids across the awaited serve starts, then apply
        // them in ONE locked read-modify-write — the loop's awaits must not hold
        // the lock, and a plain accumulate-on-stale-snapshot save would clobber
        // a concurrent callback/disconnect landing during boot.
        const restoredPids = new Map();
        for (const account of enabled) {
          const watch = getAccountGmailWatch(account);
          if (!watch.enabled || !watch.port || !hookToken) continue;
          try {
            // eslint-disable-next-line no-await-in-loop
            const serveStatus = await serveManager.startServe({
              account,
              port: watch.port,
              webhookToken: hookToken,
            });
            restoredPids.set(account.id, serveStatus.pid || null);
          } catch (err) {
            console.error(
              `[alphaclaw] Failed to restore Gmail serve for ${account.email}: ${err.message || "unknown"}`,
            );
          }
        }
        if (restoredPids.size) {
          updateState((current) => {
            let next = current;
            for (const [accountId, pid] of restoredPids) {
              next = setAccountGmailWatch({
                state: next,
                accountId,
                watch: { pid },
              }).state;
            }
            return next;
          });
        }
        await run();
      } catch (err) {
        console.error("[alphaclaw] Failed to bootstrap Gmail watch services:", err);
      }
    }, 0);
  };

  const stop = async () => {
    if (renewalTimer) {
      clearInterval(renewalTimer);
      renewalTimer = null;
    }
    await serveManager.stopAll();
  };

  const getTargetByEmail = (email = "") => {
    const state = readState();
    const account = getGoogleAccountByEmail(state, email);
    if (!account) return null;
    const watch = getAccountGmailWatch(account);
    if (!watch.enabled || !watch.port) return null;
    return {
      accountId: account.id,
      port: watch.port,
      email: account.email,
      client: account.client || "default",
    };
  };

  const markPushReceived = ({ accountId, at }) => {
    const state = readState();
    const updated = setAccountGmailWatch({
      state,
      accountId,
      watch: {
        lastPushAt: Number.parseInt(String(at || Date.now()), 10),
      },
    });
    saveState(updated.state);
  };

  serviceRef = {
    start,
    stop,
    getConfig,
    saveClientConfig,
    startWatch,
    stopWatch,
    renewWatch,
    getTargetByEmail,
    markPushReceived,
    resolvePushToken: () => getGmailPushConfig(readState()).token,
    getServeStatus: (accountId) => serveManager.getServeStatus(accountId),
    ensureHookWiring,
  };

  return serviceRef;
};

module.exports = {
  createGmailWatchService,
  createTopicNameForClient,
  createSubscriptionNameForClient,
};
