const os = require("os");
const path = require("path");

// AlphaClaw's relay guard (ALPH-71 H-1): an OpenClaw plugin whose
// before_tool_call hook makes relay sessions read-only. OpenClaw blocks the
// whole call when a before_tool_call hook throws, for every session, so the
// hook answers {} for any session that is provably not a relay session
// before it touches the disk, and any error while it checks a relay call
// denies that call only. Every deny carries the "[relay-guard]" marker the
// bridge reads from the run's history to tell the owner, and is logged once
// per tool and session.
const kPluginId = "relay-guard";
const kDenyMarker = "[relay-guard]";
const kMaxLoggedDenies = 2000;

const createRelayGuardPlugin = ({ policy = require("./policy") } = {}) => ({
  id: kPluginId,
  name: "AlphaClaw Relay Guard",
  description: "Keeps Agent Relay sessions to read-only tools inside the agent workspace",
  register: (api) => {
    const logger = api?.logger;
    const pluginConfig = api?.pluginConfig && typeof api.pluginConfig === "object" ? api.pluginConfig : {};
    const rootDir = String(pluginConfig.rootDir || process.env.ALPHACLAW_ROOT_DIR || path.join(os.homedir(), ".alphaclaw"));
    const logDirs = Array.isArray(pluginConfig.logDirs) ? pluginConfig.logDirs.filter((dir) => typeof dir === "string" && dir) : [path.join(rootDir, "logs")];
    const logged = new Set();
    const logDeny = (toolName, label, reason) => {
      const key = label + "|" + toolName;
      if (logged.has(key)) return;
      if (logged.size >= kMaxLoggedDenies) logged.clear();
      logged.add(key);
      logger?.warn?.(kDenyMarker + " denied tool=" + toolName + " session=" + label + " reason=" + reason);
    };
    const deny = (toolName, label, reason) => {
      logDeny(toolName, label, reason);
      return { block: true, blockReason: kDenyMarker + " " + reason + ". Relay requests are read-only: say in your answer what you would need, and AlphaClaw tells your owner." };
    };
    api.on("before_tool_call", (event, ctx) => {
      const sessionKey = ctx?.sessionKey;
      const runId = ctx?.runId || event?.runId;
      const kind = policy.classifyCall({ sessionKey, runId });
      if (kind === "other") return {};
      const toolName = String(event?.toolName || ctx?.toolName || "tool").toLowerCase().slice(0, 128);
      const label = String(sessionKey || runId || "unattributed").slice(0, 160);
      try {
        if (kind === "unknown" && !policy.relayRunActive({ rootDir })) return {};
        const scope = policy.buildScope({ config: api?.config, ctx: { agentId: ctx?.agentId, sessionKey }, rootDir, logDirs });
        const decision = policy.decideRelayToolCall({ toolName, params: event?.params, derivedPaths: event?.derivedPaths, scope, sessionKey });
        return decision.allow ? {} : deny(toolName, label, decision.reason);
      } catch (error) {
        logger?.error?.(kDenyMarker + " check failed tool=" + toolName + ": " + String(error?.message || error).slice(0, 200));
        return deny(toolName, label, "the relay guard could not check this call");
      }
    });
    logger?.info?.(kDenyMarker + " active: relay sessions may use " + policy.kRelayAllowedTools.join(", "));
  },
});

const plugin = createRelayGuardPlugin();
module.exports = plugin;
module.exports.default = plugin;
module.exports.createRelayGuardPlugin = createRelayGuardPlugin;
module.exports.kRelayGuardPluginId = kPluginId;
module.exports.kRelayGuardDenyMarker = kDenyMarker;
