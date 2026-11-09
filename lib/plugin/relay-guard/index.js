const os = require("os");
const path = require("path");

// AlphaClaw's relay guard (ALPH-71 H-1, tiers GST-1982): an OpenClaw plugin
// whose before_tool_call hook keeps peer relay sessions messaging-only and
// gives delegate relay sessions (Capy threads on a connection the operator
// listed) the owner's working tools without the ones that reach other
// people. OpenClaw blocks the whole call when a before_tool_call hook throws,
// for every session, so the hook answers {} for any session that is provably
// not a relay session before it touches the disk, and any error while it
// checks a relay call denies that call only. Every deny carries the
// "[relay-guard]" marker the bridge reads from the run's history, and is
// logged once per tool and session.
const kPluginId = "relay-guard";
const kDenyMarker = "[relay-guard]";
const kMaxLoggedDenies = 2000;
const kMaxTrackedApprovals = 2000;

const kPeerDenyHint = "Relay requests are messaging-only: say in your answer what you would need, and AlphaClaw tells your owner.";
const kDelegateDenyHint = "A delegate relay session cannot use this. Say so in your answer; the Capy thread takes it to your owner directly.";

const createRelayGuardPlugin = ({ policy = require("./policy") } = {}) => ({
  id: kPluginId,
  name: "AlphaClaw Relay Guard",
  description: "Keeps peer Agent Relay sessions messaging-only and withholds outbound tools from delegate relay sessions",
  register: (api) => {
    const logger = api?.logger;
    const pluginConfig = api?.pluginConfig && typeof api.pluginConfig === "object" ? api.pluginConfig : {};
    const rootDir = String(pluginConfig.rootDir || process.env.ALPHACLAW_ROOT_DIR || path.join(os.homedir(), ".alphaclaw"));
    const delegateTools = Array.isArray(pluginConfig.delegateTools) ? pluginConfig.delegateTools.map((entry) => String(entry).toLowerCase()) : [];
    // The guard's copy of ALPHACLAW_RELAY_DELEGATE_AGENTS, read only as the
    // one-release fallback for an agent with no grant row (GST-2090): the
    // owner's grants in relay/remote.db decide, and a revoked grant beats it.
    const fallbackAgents = Array.isArray(pluginConfig.delegateAgents) ? pluginConfig.delegateAgents.map((entry) => String(entry).toLowerCase()) : [];
    const logged = new Set();
    // Targets an approval was already spent on, per relay message. In memory
    // only: a gateway restart forgets them, so the run it interrupted could
    // send once more to a recipient it already reached (a documented
    // residual, docs/designs/agent-relay.md "Delegates").
    const spent = new Map();
    const spentFor = (messageId) => {
      if (!spent.has(messageId)) {
        if (spent.size >= kMaxTrackedApprovals) spent.delete(spent.keys().next().value);
        spent.set(messageId, new Set());
      }
      return spent.get(messageId);
    };
    const logDeny = (toolName, label, reason) => {
      const key = label + "|" + toolName;
      if (logged.has(key)) return;
      if (logged.size >= kMaxLoggedDenies) logged.clear();
      logged.add(key);
      logger?.warn?.(kDenyMarker + " denied tool=" + toolName + " session=" + label + " reason=" + reason);
    };
    const deny = (toolName, label, reason, tier) => {
      logDeny(toolName, label, reason);
      return { block: true, blockReason: kDenyMarker + " " + reason + ". " + (tier === "delegate" ? kDelegateDenyHint : kPeerDenyHint) };
    };
    api.on("before_tool_call", (event, ctx) => {
      const sessionKey = ctx?.sessionKey;
      const runId = ctx?.runId || event?.runId;
      const kind = policy.classifyCall({ sessionKey, runId });
      if (kind === "other") return {};
      const toolName = String(event?.toolName || ctx?.toolName || "tool").toLowerCase().slice(0, 128);
      const label = String(sessionKey || runId || "unattributed").slice(0, 160);
      let tier = "peer";
      try {
        const trust = policy.resolveTrust({ rootDir, sessionKey, runId, fallbackAgents });
        if (kind === "unknown" && trust.tier === "none") return {};
        tier = trust.tier;
        const usedTargets = trust.messageId ? spentFor(trust.messageId) : new Set();
        const decision = policy.decideRelayToolCall({ toolName, params: event?.params, sessionKey, trust, delegateTools, usedTargets });
        if (!decision.allow) return deny(toolName, label, decision.reason, tier);
        if (decision.spend?.length) {
          for (const target of decision.spend) usedTargets.add(target);
          logger?.info?.(kDenyMarker + " approved send tool=" + toolName + " session=" + label + " targets=" + decision.spend.length);
        }
        return {};
      } catch (error) {
        logger?.error?.(kDenyMarker + " check failed tool=" + toolName + ": " + String(error?.message || error).slice(0, 200));
        return deny(toolName, label, "the relay guard could not check this call", tier);
      }
    });
    logger?.info?.(kDenyMarker + " active: peer relay sessions may use " + policy.kRelayAllowedTools.join(", ") + "; delegate relay sessions get the owner's working tools");
  },
});

const plugin = createRelayGuardPlugin();
module.exports = plugin;
module.exports.default = plugin;
module.exports.createRelayGuardPlugin = createRelayGuardPlugin;
module.exports.kRelayGuardPluginId = kPluginId;
module.exports.kRelayGuardDenyMarker = kDenyMarker;
