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

// The refusal a delegate gets for a high-risk call that has no spendable
// owner confirmation (confirm.js). The ref is the one the owner's link and
// the sender's retry name.
const confirmationRefusal = (risk, check) => {
  const what = risk.action;
  if (check.state === "denied") return what + " was denied by your owner (confirmation " + check.ref + "). Do not try it again; say so in your answer";
  if (check.state === "requested") {
    return what + " needs your owner's confirmation " + check.ref + ". AlphaClaw is sending them a one-tap link now, valid 15 minutes. Stop here and say in your answer that it waits for confirmation " + check.ref;
  }
  if (check.state === "pending") {
    return what + " is waiting for your owner's confirmation " + check.ref + " (the link was already sent). Stop here and say in your answer that it waits for confirmation " + check.ref;
  }
  if (check.state === "too_many") return what + " needs your owner's confirmation, and 5 requests are already waiting for them. Stop here and say so in your answer";
  return what + " needs your owner's confirmation, and AlphaClaw could not record the request. Say so in your answer";
};

// The refusal an attested delegate gets for a change to the relay's trust
// anchor (confirm.js classifyAnchor). There is no confirmation to wait for.
const anchorRefusal = (anchor) =>
  anchor.action +
  " would change what decides relay trust on this box (the relay's files, AlphaClaw's installed code, the relay guard's plugin entry or the trust env names), which no relay session can change, even your owner's own Capy thread. Nothing was asked of your owner. Say so in your answer: the way to change it is in the AlphaClaw repository and a deploy, or by the box's operator from outside this agent.";

// What a relay turn is told when it reaches the relay's own files (GST-2336).
const keyReadRefusal = (keyRead) =>
  keyRead.action +
  " is refused in every relay session: the relay's files (its agent keys, the owner-provenance signing key, its internal secret, its databases and their backups) are never read or changed from a relay turn, even your owner's own Capy thread's. Nothing was asked of your owner. Say so in your answer; the box's operator handles these from outside the agent.";

// What a relay turn of the owner's own thread is told about a gateway
// restart it asked for (restart.js): AlphaClaw's restart ladder runs it,
// after the turn's own work, so the turn answers now and does not ask again.
const restartAnswer = (result) => {
  const op = String(result.operationId || "").slice(0, 8) || "unknown";
  if (result.ok && result.attached) return "A gateway restart is already running in AlphaClaw (operation " + op + "); it covers this request. Finish your answer now and do not ask for another restart.";
  if (result.ok) {
    return "AlphaClaw is restarting the gateway through its restart ladder (operation " + op + (result.source ? ", recorded as " + result.source : "") + "). It lets running work finish first, this turn included, so finish your answer now and do not ask for the restart again.";
  }
  if (result.code === "unreachable") return "AlphaClaw could not be reached to restart the gateway, so nothing was restarted. Say so in your answer.";
  return "AlphaClaw did not restart the gateway (" + String(result.code).slice(0, 40) + (result.error ? ": " + String(result.error).slice(0, 160) : "") + "). Say so in your answer.";
};
const kRestartAloneHint =
  "A relay session restarts the gateway only through AlphaClaw's restart ladder. Run openclaw gateway restart as a command of its own, with nothing else on the line, and AlphaClaw runs it.";

const createRelayGuardPlugin = ({
  policy = require("./policy"),
  confirm = require("./confirm"),
  provenance = require("./provenance"),
  trustCheck = require("./trust"),
  restart = require("./restart"),
} = {}) => ({
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
    // Owner provenance (provenance.js): the Telegram message that started
    // each session's latest turn, and a relay send's provenance_ref, which
    // only the guard sets.
    const ownerTurns = provenance.createOwnerTurns();
    api.on("message_received", (event, ctx) => {
      try {
        ownerTurns.record(event, ctx);
      } catch {}
    });
    const relaySendParams = (toolName, params, sessionKey, ctx, kind, runId) => {
      if (!provenance.isRelaySendTool(toolName)) return null;
      let ref = null;
      if (kind === "other") {
        try {
          const turn = ownerTurns.ownerTurnFor(ctx, runId);
          if (turn) ref = provenance.writeClaim({ rootDir, sessionKey, turn });
          if (ref) logger?.info?.(kDenyMarker + " owner provenance claimed tool=" + toolName + " session=" + String(sessionKey).slice(0, 160) + " ref=" + ref);
        } catch (error) {
          logger?.warn?.(kDenyMarker + " owner provenance not claimed tool=" + toolName + ": " + String(error?.message || error).slice(0, 200));
        }
      }
      return provenance.withProvenance({ params, ref });
    };
    api.on("before_tool_call", (event, ctx) => {
      const sessionKey = ctx?.sessionKey;
      const runId = ctx?.runId || event?.runId;
      const kind = policy.classifyCall({ sessionKey, runId });
      try {
        ownerTurns.noteRun(runId);
      } catch {}
      const toolName = String(event?.toolName || ctx?.toolName || "tool").toLowerCase().slice(0, 128);
      const sendParams = relaySendParams(toolName, event?.params, sessionKey, ctx, kind, runId);
      const pass = () => (sendParams ? { params: sendParams } : {});
      if (kind === "other") return pass();
      const label = String(sessionKey || runId || "unattributed").slice(0, 160);
      let tier = "peer";
      try {
        const trust = policy.resolveTrust({ rootDir, sessionKey, runId, fallbackAgents });
        if (kind === "unknown" && trust.tier === "none") return pass();
        tier = trust.tier;
        const usedTargets = trust.messageId ? spentFor(trust.messageId) : new Set();
        // The owner's own attested thread (GST-2323 PR2): the same per-call
        // verdict as the confirmation bypass, from the box's records only.
        const ownerThread =
          tier === "delegate" && trust.attested === true && trustCheck.isAttestedDelegateMessage({ rootDir, sender: trust.sender, messageId: trust.messageId });
        const decision = policy.decideRelayToolCall({ toolName, params: event?.params, sessionKey, trust, delegateTools, usedTargets, ownerThread });
        if (!decision.allow) return deny(toolName, label, decision.reason, tier);
        // A gateway restart from the owner's thread runs through AlphaClaw's
        // attributed restart ladder; the raw call never reaches OpenClaw.
        const restartAsk = ownerThread ? confirm.gatewayRestartOf({ toolName, params: event?.params }) : null;
        if (restartAsk === "embedded") {
          logDeny(toolName, label, "gateway restart inside another command");
          return { block: true, blockReason: kDenyMarker + " " + kRestartAloneHint };
        }
        if (restartAsk === "request") {
          return Promise.resolve(restart.requestGatewayRestart({ rootDir, messageId: trust.messageId }))
            .catch(() => ({ ok: false, code: "unreachable" }))
            .then((result) => {
              const line = " gateway restart asked of AlphaClaw tool=" + toolName + " session=" + label + " outcome=" + (result.ok ? (result.attached ? "attached" : "started") : String(result.code).slice(0, 40));
              if (result.ok) logger?.info?.(kDenyMarker + line + " op=" + String(result.operationId || "").slice(0, 8));
              else logger?.warn?.(kDenyMarker + line);
              return { block: true, blockReason: kDenyMarker + " " + restartAnswer(result) };
            });
        }
        // High-risk calls (config, env, secrets, guards, access) need the
        // owner's confirmation on top of the grant, except an attested
        // delegate's (GST-2323, decided in checkConfirmation from the box's
        // records); the kind is derived from the call itself.
        if (tier === "delegate") {
          const agentId = ctx?.agentId || String(sessionKey || "").split(":")[1] || "";
          // The anchor is checked on every delegate call. An attested
          // delegate's change to it is refused outright (no confirmation
          // row, nothing sent to the owner); anyone else's needs the owner's
          // confirmation, even where the call otherwise rates low, unless it
          // reaches the relay's own files, which no tier gets (GST-2336).
          const anchor = confirm.classifyAnchor({ toolName, params: event?.params, rootDir, agentId });
          const refuseAnchor = () => {
            logger?.warn?.(kDenyMarker + " refused trust anchor change tool=" + toolName + " session=" + label);
            return { block: true, blockReason: kDenyMarker + " " + anchorRefusal(anchor) };
          };
          if (anchor && trust.attested === true) return refuseAnchor();
          const keyRead = confirm.classifyKeyRead({ toolName, params: event?.params, rootDir, agentId });
          if (keyRead) {
            logger?.warn?.(kDenyMarker + " refused relay file access tool=" + toolName + " session=" + label);
            return { block: true, blockReason: kDenyMarker + " " + keyReadRefusal(keyRead) };
          }
          const rated = confirm.classifyRisk({ toolName, params: event?.params, rootDir, agentId });
          const risk = anchor && rated.kind !== "high" ? confirm.anchorRisk({ anchor, params: event?.params }) : rated;
          if (risk.kind === "high") {
            const check = confirm.checkConfirmation({
              rootDir,
              sender: trust.sender,
              messageId: trust.messageId,
              lane: trust.lane,
              generation: trust.bindingGeneration,
              confirmationRef: trust.confirmationRef,
              kind: risk.kind,
              action: risk.action,
              target: risk.target,
            });
            if (check.state === "attested" && anchor) return refuseAnchor();
            if (!check.admitted) {
              logger?.warn?.(kDenyMarker + " held for confirmation tool=" + toolName + " session=" + label + " state=" + check.state + (check.ref ? " ref=" + check.ref : ""));
              return { block: true, blockReason: kDenyMarker + " " + confirmationRefusal(risk, check) + "." };
            }
            logger?.info?.(
              kDenyMarker + (check.state === "attested" ? " attested delegate call admitted tool=" + toolName + " session=" + label : " confirmed call admitted tool=" + toolName + " session=" + label + " ref=" + check.ref),
            );
          }
        }
        if (decision.spend?.length) {
          for (const target of decision.spend) usedTargets.add(target);
          logger?.info?.(kDenyMarker + " approved send tool=" + toolName + " session=" + label + " targets=" + decision.spend.length);
        }
        return pass();
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
