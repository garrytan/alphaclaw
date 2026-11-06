const { openRemoteStore } = require("./remote-store");
const { createRelayOAuthProvider } = require("./oauth-provider");
const { createRemoteRelayTools, kRemoteAgentPrefix } = require("./remote-tools");
const { createWakeDelivery } = require("./wake");
const { RelayError } = require("./errors");

// The relay's remote side: the OAuth authorization server, the tools served
// at /relay/mcp, and wake delivery to bound Capy threads. It opens its store
// (relay/remote.db) only once the relay is ready, and answers
// relay_disabled / remote_disabled / public_url_missing / provisioning_pending
// until then. Routes live in routes/relay-remote.js.
const kSweepMs = 60 * 60 * 1000;

const resolvePublicOrigin = (raw) => {
  try {
    const url = new URL(String(raw || ""));
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
};

const createRelayRemote = ({ relayService, getPublicUrl, now = Date.now, logger = console, wakeOptions = {} }) => {
  const state = { store: null, provider: null, tools: null, wake: null, sweepTimer: null };
  const config = () => relayService.config;

  const publicOrigin = () => resolvePublicOrigin(getPublicUrl());
  const mcpUrl = () => {
    const origin = publicOrigin();
    return origin ? origin + "/relay/mcp" : null;
  };

  // Why the remote side cannot serve right now, or null.
  const unavailableReason = () => {
    if (!config().enabled) return "relay_disabled";
    if (!config().remoteEnabled) return "remote_disabled";
    if (!publicOrigin()) return "public_url_missing";
    if (!relayService.isReady()) return "provisioning_pending";
    return null;
  };

  const ensureOpen = () => {
    const reason = unavailableReason();
    if (reason) throw new RelayError(reason);
    if (state.store) return state;
    state.store = openRemoteStore({ dbPath: relayService.paths.remoteDb, now });
    state.provider = createRelayOAuthProvider({
      store: state.store,
      getResourceUrl: () => mcpUrl(),
      getRedirectAllowlist: () => config().oauthRedirectUris,
      now,
      logger,
    });
    state.tools = createRemoteRelayTools({
      engine: relayService.engine,
      store: state.store,
      getWorkspaceKey: () => relayService.getAuth().workspaceKey,
      getConfig: config,
      now,
      logger,
    });
    state.wake = createWakeDelivery({ store: state.store, getConfig: config, now, logger, ...wakeOptions });
    state.wake.start();
    state.store.sweep({ auditRetentionDays: config().retentionDays });
    state.sweepTimer = setInterval(() => {
      try {
        state.store?.sweep({ auditRetentionDays: config().retentionDays });
      } catch (error) {
        logger.warn("[relay] remote sweep failed: " + String(error?.message || error));
      }
    }, kSweepMs);
    state.sweepTimer.unref?.();
    logger.log("[relay] remote endpoint ready at " + mcpUrl());
    return state;
  };

  // Called by the bridge for every relay DM or thread reply it sees. The
  // bridge awaits it before its event cursor moves past the message, so a
  // restart cannot drop a wake between the event and the durable queue.
  const onRelayMessage = async (routed) => {
    if (!routed?.recipient || !String(routed.recipient).startsWith(kRemoteAgentPrefix)) return;
    let opened;
    try {
      opened = ensureOpen();
    } catch {
      return;
    }
    if (!opened.store.bindings.get(routed.recipient)) return;
    const { workspaceKey } = relayService.getAuth();
    try {
      const message = await relayService.engine
        .getMessage(workspaceKey, routed.messageId)
        .catch(() => ({ id: routed.messageId, agent_name: routed.sender, text: routed.text, thread_id: routed.kind === "thread.reply" ? routed.threadRoot : null }));
      opened.wake.enqueue({ agent: routed.recipient, message: { ...message, id: message?.id || routed.messageId } });
    } catch (error) {
      logger.warn("[relay] wake enqueue failed for " + routed.recipient + ": " + String(error?.message || error));
    }
  };

  // Called once the relay is ready, so wakes left in the queue by the last
  // run are delivered without waiting for the first remote request.
  const onRelayReady = () => {
    if (unavailableReason()) return;
    try {
      ensureOpen();
    } catch (error) {
      logger.warn("[relay] remote side could not open: " + String(error?.message || error));
    }
  };

  const getStatus = () => {
    const reason = unavailableReason();
    const base = { enabled: config().enabled && config().remoteEnabled, mcpUrl: mcpUrl(), unavailable: reason };
    if (!reason) {
      try {
        ensureOpen();
      } catch {}
    }
    if (reason || !state.store) return { ...base, clients: [], bindings: [], wakes: {}, audit: [] };
    const { store } = state;
    return {
      ...base,
      clients: store.clients.list().map((client) => ({
        clientId: client.clientId,
        name: client.info?.client_name || null,
        redirectHosts: (client.info?.redirect_uris || []).map((uri) => {
          try {
            return new URL(uri).host;
          } catch {
            return null;
          }
        }),
        createdAt: client.createdAt,
        consentedAt: client.consentedAt,
        revokedAt: client.revokedAt,
        activeGrants: store.tokens.countActive(client.clientId),
      })),
      bindings: store.bindings.list().map((binding) => ({
        agent: binding.agent,
        threadId: binding.threadId,
        clientId: binding.clientId,
        webhookHost: (() => {
          try {
            return new URL(binding.webhookUrl).host;
          } catch {
            return null;
          }
        })(),
        until: binding.until,
        expired: binding.until < now(),
        deadAt: binding.deadAt,
        lastWakeAt: binding.lastWakeAt,
        lastWakeStatus: binding.lastWakeStatus,
        createdAt: binding.createdAt,
      })),
      wakes: store.wakes.counts(),
      audit: store.recentAudit(30),
    };
  };

  const stop = () => {
    if (state.sweepTimer) clearInterval(state.sweepTimer);
    state.wake?.stop();
    try {
      state.store?.close();
    } catch {}
    Object.assign(state, { store: null, provider: null, tools: null, wake: null, sweepTimer: null });
  };

  return {
    ensureOpen,
    unavailableReason,
    publicOrigin,
    mcpUrl,
    onRelayMessage,
    onRelayReady,
    getStatus,
    revokeClient: ({ clientId, actor }) => ensureOpen().provider.revokeClient({ clientId, actor }),
    removeBinding: ({ agent, actor }) => {
      const { store } = ensureOpen();
      const binding = store.bindings.get(agent);
      if (!binding) return null;
      store.bindings.remove(agent);
      store.audit("binding_removed", { clientId: binding.clientId, agent, detail: { by: actor } });
      return { agent };
    },
    stop,
  };
};

module.exports = { createRelayRemote, resolvePublicOrigin };
