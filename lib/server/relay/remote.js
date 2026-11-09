const { openRemoteStore } = require("./remote-store");
const { createRelayOAuthProvider } = require("./oauth-provider");
const { createRemoteRelayTools, kRemoteAgentPrefix } = require("./remote-tools");
const { createWakeDelivery } = require("./wake");
const { RelayError } = require("./errors");
const { classifyBinding } = require("../../plugin/relay-guard/trust");

// The relay's remote side: the OAuth authorization server, the tools served
// at /relay/mcp, and wake delivery to bound Capy threads. It opens its store
// (relay/remote.db) only once the relay is ready, and answers
// relay_disabled / remote_disabled / public_url_missing / provisioning_pending
// until then. Routes live in routes/relay-remote.js.
const kSweepMs = 60 * 60 * 1000;
const kMaxWakeEnqueueAttempts = 5;

const resolvePublicOrigin = (raw) => {
  try {
    const url = new URL(String(raw || ""));
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
};

// The remote side serves only from ALPHACLAW_SETUP_URL, as the docs say: the
// platform aliases (RENDER_EXTERNAL_URL, URL, Railway's) that resolveSetupUrl
// falls back to must not open a public OAuth endpoint on their own.
const resolveRelayPublicUrl = ({ env = process.env, resolveSetupUrl }) =>
  String(env.ALPHACLAW_SETUP_URL || "").trim() ? resolveSetupUrl() : null;

const createRelayRemote = ({ relayService, getPublicUrl, now = Date.now, logger = console, wakeOptions = {} }) => {
  const state = { store: null, provider: null, tools: null, wake: null, sweepTimer: null, enqueueFailures: new Map() };
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
      onBindingRemoved: (agent) => demote(agent, "unbound"),
      now,
      logger,
    });
    state.wake = createWakeDelivery({ store: state.store, getConfig: config, now, logger, ...wakeOptions });
    state.wake.start();
    try {
      state.store.sweep({ auditRetentionDays: config().retentionDays });
    } catch (error) {
      logger.warn("[relay] remote sweep failed: " + String(error?.message || error));
    }
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

  // GST-1982: the tier of a relay sender. A delegate is a capy-* agent with
  // a live binding on a consented, unrevoked client, listed by the operator
  // in ALPHACLAW_RELAY_DELEGATE_AGENTS; every other sender is a peer.
  const resolveDelegate = (agent) => {
    if (!config().delegateAgents?.length) return { trust: "peer", reason: "delegates_off" };
    if (!String(agent || "").startsWith(kRemoteAgentPrefix)) return { trust: "peer", reason: "not_bound" };
    let opened;
    try {
      opened = ensureOpen();
    } catch {
      return { trust: "peer", reason: "remote_unavailable" };
    }
    const binding = opened.store.bindings.get(agent);
    const client = binding ? opened.store.clients.get(binding.clientId) : null;
    return classifyBinding({ binding, client, delegateAgents: config().delegateAgents, now: now() });
  };

  // A binding that stopped existing: its running turns are demoted and
  // aborted in the bridge (bridge.js demoteSender).
  const demote = (agent, reason) => {
    void Promise.resolve(relayService.demoteSender?.(agent, reason)).catch((error) =>
      logger.warn("[relay] could not demote " + agent + " after it was " + reason + ": " + String(error?.message || error)),
    );
  };

  // Called by the bridge for every relay DM or thread reply it sees. The
  // bridge awaits it before its event cursor moves past the message, so a
  // restart cannot drop a wake between the event and the durable queue. A
  // failed enqueue throws, so the cursor stays and the next poll retries, up
  // to kMaxWakeEnqueueAttempts for one message: then that wake is dropped
  // (logged) so a remote.db that keeps failing (the binding read included)
  // cannot hold back every later relay event, the box agent's own DMs too.
  const onRelayMessage = async (routed) => {
    if (!routed?.recipient || !String(routed.recipient).startsWith(kRemoteAgentPrefix)) return;
    let opened;
    try {
      opened = ensureOpen();
    } catch {
      return;
    }
    try {
      if (opened.store.bindings.get(routed.recipient)) {
        const { workspaceKey } = relayService.getAuth();
        const message = await relayService.engine
          .getMessage(workspaceKey, routed.messageId)
          .catch(() => ({ id: routed.messageId, agent_name: routed.sender, text: routed.text, thread_id: routed.kind === "thread.reply" ? routed.threadRoot : null }));
        opened.wake.enqueue({ agent: routed.recipient, message: { ...message, id: message?.id || routed.messageId } });
      }
      state.enqueueFailures.delete(routed.messageId);
    } catch (error) {
      const failures = (state.enqueueFailures.get(routed.messageId) || 0) + 1;
      if (failures >= kMaxWakeEnqueueAttempts) {
        state.enqueueFailures.delete(routed.messageId);
        logger.warn("[relay] wake enqueue failed " + failures + " times for " + routed.recipient + " message=" + routed.messageId + "; that thread is not woken for it: " + String(error?.message || error));
        return;
      }
      state.enqueueFailures.set(routed.messageId, failures);
      logger.warn("[relay] wake enqueue failed for " + routed.recipient + " message=" + routed.messageId + "; the event will be read again: " + String(error?.message || error));
      throw error;
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
    const base = { enabled: config().enabled && config().remoteEnabled, mcpUrl: mcpUrl(), unavailable: reason, consentWindowUntil: null };
    if (!reason) {
      try {
        ensureOpen();
      } catch {}
    }
    if (reason || !state.store) return { ...base, delegateAgents: config().delegateAgents?.length || 0, clients: [], bindings: [], wakes: {}, audit: [] };
    const { store } = state;
    const delegateAgents = config().delegateAgents || [];
    return {
      ...base,
      consentWindowUntil: state.provider.consentWindowUntil(),
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
        tier: classifyBinding({ binding, client: store.clients.get(binding.clientId), delegateAgents, now: now() }).trust,
        deadAt: binding.deadAt,
        lastWakeAt: binding.lastWakeAt,
        lastWakeStatus: binding.lastWakeStatus,
        createdAt: binding.createdAt,
      })),
      delegateAgents: delegateAgents.length,
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
    resolveDelegate,
    revokeClient: ({ clientId, actor }) => {
      const result = ensureOpen().provider.revokeClient({ clientId, actor });
      for (const agent of result?.bindingsRemoved || []) demote(agent, "revoked");
      return result;
    },
    openConsentWindow: ({ actor }) => ensureOpen().provider.openConsentWindow({ actor }),
    removeBinding: ({ agent, actor }) => {
      const { store } = ensureOpen();
      const binding = store.bindings.get(agent);
      if (!binding) return null;
      store.bindings.remove(agent);
      store.audit("binding_removed", { clientId: binding.clientId, agent, detail: { by: actor } });
      demote(agent, "removed");
      return { agent };
    },
    stop,
  };
};

module.exports = { createRelayRemote, resolvePublicOrigin, resolveRelayPublicUrl };
