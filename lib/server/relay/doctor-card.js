// Doctor cards for the Agent Relay (det:relay-*): one card while the relay is
// on but not running, naming the coded failure and its fix (errors.js). No
// card while it is off, starting, or ready; the non-loopback listener is a
// Relay-page warning, not a Doctor card (it is expected until the engine has
// a host flag). A running relay whose gateway does not report the relay
// guard plugin active gets relay_guard_missing: its messages are held.
//
// The brain archive adds one card (det:relay-archive-<code>) when relay
// conversations wait for a person (gbrain asked for one, the page changed in
// the brain, or a page still looked like it carried a secret), or when the
// relay source is federated. A box without gbrain or without the relay
// source gets no card: the archive is simply off there.
const kArchiveCardCopy = Object.freeze({
  gbrain_stopped: {
    title: "gbrain asked for a person before saving relay conversations",
    fix: "Run the gbrain command it names by hand to see what it needs, then press Retry in Agent Relay → Brain archive.",
  },
  revision_conflict: {
    title: "relay conversation pages changed in the brain",
    fix: "Something other than AlphaClaw edited these pages in the relay source. Pressing Retry in Agent Relay → Brain archive replaces them with the archived conversation (gbrain keeps the replaced version in its history).",
  },
  masked_refused: {
    title: "relay conversations were not saved because they still looked like they carried a secret",
    fix: "Nothing is written while a page matches the secret scanner. Read the conversation on the Relay page; if it holds a credential AlphaClaw does not know yet, add it to the box's .env so the masker hides it, then press Retry in Agent Relay → Brain archive.",
  },
  peer_budget_total: {
    title: "a peer's relay conversations are past the brain archive budget",
    fix: "One peer's pages reached ALPHACLAW_RELAY_BRAIN_PEER_TOTAL_MB (default 512). Read who it is on the Relay page; raise the budget in the deployment env if the volume is expected, or stop the peer, then press Retry in Agent Relay → Brain archive.",
  },
  source_federated: {
    title: "the brain's relay source is federated",
    fix: "The relay source must stay out of default recall. Ask the brain's owner to set it back to not federated (gbrain sources add relay --no-federated); AlphaClaw writes nothing until then.",
  },
});

const buildArchiveCards = (archive, sanitize) => {
  if (!archive?.enabled) return [];
  const cards = [];
  const card = (code, summary, evidence) => {
    const copy = kArchiveCardCopy[code];
    cards.push({
      sourceKey: "det:relay-archive-" + code,
      priority: "P3",
      category: "config",
      title: "Relay brain archive: " + copy.title,
      summary: sanitize(summary),
      recommendation: sanitize(copy.fix),
      evidence: [{ type: "text", text: sanitize(evidence) }],
      targetPaths: [],
      fixPrompt:
        "Read alphaclaw admin GET /api/relay/status (its archive field). The archive's code is " + code + ": follow the alphaclaw-admin skill's relay.md under \"Brain archive\". " +
        "Never write to the brain's relay source yourself, never run git in it, and never press Retry for the owner.",
    });
  };
  if (archive.phase === "unavailable" && archive.code === "source_federated") {
    card("source_federated", "Relay conversations are not being saved to the brain: its relay source is federated, so its pages would reach default recall.", "code source_federated");
  }
  for (const { code, count } of Array.isArray(archive.parked) ? archive.parked : []) {
    if (!kArchiveCardCopy[code]) continue;
    const until = code === "peer_budget_total" ? "until the peer's archive budget is raised" : "until someone presses Retry";
    card(code, count + " relay conversation" + (count === 1 ? " is" : "s are") + " not saved to the brain " + until + ".", "code " + code + "; conversations " + count);
  }
  return cards;
};

const buildGuardMissingCard = () => {
  const { describeRelayError } = require("./errors");
  const { title, fix, retry } = describeRelayError("relay_guard_missing");
  return {
    sourceKey: "det:relay-relay_guard_missing",
    priority: "P1",
    category: "config",
    title: "Agent Relay is holding messages: " + title.toLowerCase(),
    summary: "The relay guard keeps relay sessions messaging-only. Until the gateway loads it, relay messages to this box wait and are not answered.",
    recommendation: fix,
    evidence: [{ type: "text", text: "code relay_guard_missing; retry: " + retry }],
    targetPaths: [],
    fixPrompt:
      "Read alphaclaw admin GET /api/relay/status (bridge.guard) and the gateway log for relay-guard. Follow the fix in the alphaclaw-admin skill's relay.md under relay_guard_missing. " +
      "Never remove or loosen the relay-guard plugin entry to make relay messages run.",
  };
};

// Delegates (GST-1982) are shown, not flagged: one P3 card names the Capy
// threads that act as the owner on this box while the relay runs, so the
// widened tier is never silent, and says when list entries were ignored.
const buildDelegateCards = (status, sanitize) => {
  const settings = status?.enabled ? status.settings : null;
  const agents = Array.isArray(settings?.delegateAgents) ? settings.delegateAgents : [];
  const ignored = (Number(settings?.delegateAgentsRejected) || 0) + (Number(settings?.delegateToolsRejected) || 0);
  const pinsIgnored = Number(settings?.trustedBindingsRejected) || 0;
  if (!agents.length && !ignored && !pinsIgnored) return [];
  const named = agents.length
    ? agents.length + " Capy thread" + (agents.length === 1 ? "" : "s") + " (" + agents.join(", ") + ") act" + (agents.length === 1 ? "s" : "") + " as you on this box: " +
      "their relay messages run with your agent's tools, commands included, and its message tool only with your approval in Capy."
    : "No Capy thread acts as you on this box.";
  return [
    {
      sourceKey: "det:relay-delegates",
      priority: "P3",
      category: "config",
      title: agents.length ? "Agent Relay: " + agents.length + " Capy thread" + (agents.length === 1 ? " acts" : "s act") + " as you" : "Agent Relay: delegate settings were ignored",
      summary: sanitize(named + (ignored ? " " + ignored + " entr" + (ignored === 1 ? "y" : "ies") + " in ALPHACLAW_RELAY_DELEGATE_AGENTS or ALPHACLAW_RELAY_DELEGATE_TOOLS did not fit and " + (ignored === 1 ? "was" : "were") + " ignored." : "") +
          (pinsIgnored ? " " + pinsIgnored + " entr" + (pinsIgnored === 1 ? "y" : "ies") + " in ALPHACLAW_RELAY_TRUSTED_BINDINGS or ALPHACLAW_RELAY_TRUSTED_BINDING_KEYS did not fit, so nothing is pinned for " + (pinsIgnored === 1 ? "it" : "them") + "." : "")),
      recommendation: sanitize(
        "Nothing to fix if this is who you meant. To stop a thread acting as you, press Revoke delegate or Remove on its binding in Agent Relay → Connections, which stops its running turn. Taking its agent out of ALPHACLAW_RELAY_DELEGATE_AGENTS does not: the relay imported that list as grants when it started.",
      ),
      evidence: [{ type: "text", text: sanitize("delegates " + agents.length + "; ignored entries " + (ignored + pinsIgnored)) }],
      targetPaths: [],
      fixPrompt:
        "Read alphaclaw admin GET /api/relay/status (settings.delegateAgents, remote.bindings[].tier). Delegates are set by the owner only: never add, remove or edit ALPHACLAW_RELAY_DELEGATE_AGENTS or ALPHACLAW_RELAY_DELEGATE_TOOLS yourself, and never remove a binding for the owner.",
    },
  ];
};

// The tailnet route (GST-2368): one card while it is on and not ready. In
// "required" mode the public URL refuses the relay's client paths, so a
// tailnet that is down means the liaison cannot reach the box at all.
const buildTailnetCards = (status, sanitize) => {
  const tailnet = status?.enabled ? status.tailnet : null;
  if (!tailnet) return [];
  const rejected = tailnet.settingsRejected || {};
  if (rejected.mode || (tailnet.mode !== "off" && (rejected.tags || rejected.loginServer))) {
    const names = [rejected.mode && "ALPHACLAW_RELAY_TAILNET", rejected.tags && "ALPHACLAW_RELAY_TAILNET_TAGS", rejected.loginServer && "ALPHACLAW_RELAY_TAILNET_LOGIN_SERVER"].filter(Boolean);
    const settingsCard = {
      sourceKey: "det:relay-tailnet-settings",
      priority: "P2",
      category: "config",
      title: "Agent Relay's tailnet settings were ignored",
      summary: sanitize(
        names.join(", ") + (names.length === 1 ? " has" : " have") + " a value that does not fit and " + (names.length === 1 ? "was" : "were") + " ignored." +
          (rejected.mode ? " The tailnet route is off, so the relay's client paths are still served on the public URL." : ""),
      ),
      recommendation: sanitize("Set ALPHACLAW_RELAY_TAILNET to off, on or required, each tag as tag:<name>, and the login server as an https URL, in the deployment environment, then redeploy."),
      evidence: [{ type: "text", text: sanitize("ignored " + names.join(", ")) }],
      targetPaths: [],
      fixPrompt: "Read alphaclaw admin GET /api/relay/status (tailnet.settingsRejected). Never change ALPHACLAW_RELAY_TAILNET or its keys yourself; ask the owner.",
    };
    if (tailnet.mode === "off") return [settingsCard];
    return [settingsCard, ...buildTailnetDownCards(tailnet, sanitize)];
  }
  return buildTailnetDownCards(tailnet, sanitize);
};

const buildTailnetDownCards = (tailnet, sanitize) => {
  if (tailnet.mode === "off" || !["failed", "needs_login"].includes(tailnet.phase)) return [];
  const code = tailnet.error?.code || "tailnet_failed";
  const required = tailnet.mode === "required";
  return [
    {
      sourceKey: "det:relay-tailnet-" + code,
      priority: required ? "P1" : "P2",
      category: "config",
      title: tailnet.phase === "needs_login" ? "Agent Relay's tailnet route needs a login" : "Agent Relay's tailnet route is down",
      summary: sanitize(
        String(tailnet.error?.message || "") +
          (required
            ? " ALPHACLAW_RELAY_TAILNET is required, so the public URL refuses the relay's client paths and remote agents cannot reach this box until the tailnet is up."
            : " Remote agents can still use the public URL."),
      ),
      recommendation: sanitize(
        code === "tailnet_needs_login"
          ? "Set ALPHACLAW_RELAY_TAILNET_AUTHKEY to a pre-approved auth key tagged for this box in the deployment environment and redeploy; once the box shows on the tailnet the key is no longer read."
          : code === "tailnet_no_tags"
            ? "Set ALPHACLAW_RELAY_TAILNET_TAGS to the liaison's tag (for example tag:relay-liaison) in the deployment environment and redeploy. The route lets in only nodes with one of these tags."
          : code === "tailnet_binary_missing"
            ? "Install tailscale and tailscaled on this box's PATH (the Render template image has both), or set ALPHACLAW_RELAY_TAILNET=off."
            : "Read logs/sidecars/relay-tailscaled.log in the AlphaClaw root. The route retries on its own with backoff.",
      ),
      evidence: [{ type: "text", text: sanitize("code " + code + "; mode " + tailnet.mode + "; phase " + tailnet.phase) }],
      targetPaths: [],
      fixPrompt:
        "Read alphaclaw admin GET /api/relay/status (tailnet). Never change ALPHACLAW_RELAY_TAILNET or its keys yourself, never print ALPHACLAW_RELAY_TAILNET_AUTHKEY, and never read or run tailscale against the relay's tailscale directory; ask the owner.",
    },
  ];
};

const buildRelayCards = (status, { sanitize = (text) => String(text ?? "") } = {}) => {
  const archiveCards = [...buildDelegateCards(status, sanitize), ...buildTailnetCards(status, sanitize), ...buildArchiveCards(status?.archive, sanitize)];
  if (status?.enabled && status.phase !== "failed" && status.bridge?.guard?.state === "missing") return [buildGuardMissingCard(), ...archiveCards];
  if (!status?.enabled || status.phase !== "failed" || !status.error?.code) return archiveCards;
  const { code, title, detail, fix, retry } = status.error;
  return [
    {
      sourceKey: "det:relay-" + code,
      priority: code === "secrets_missing" || code === "platform_unsupported" ? "P1" : "P2",
      category: "config",
      title: "Agent Relay is not running: " + title.toLowerCase(),
      summary: sanitize(detail) + " Other agents cannot reach this box over the relay until it is fixed.",
      recommendation: sanitize(fix),
      evidence: [
        { type: "text", text: sanitize("code " + code + "; retry: " + retry + (status.retryAt ? "; next attempt " + status.retryAt : "")) },
      ],
      targetPaths: [],
      fixPrompt:
        "Read alphaclaw admin GET /api/relay/status and the relay engine's log (logs/sidecars/relay-engine.log in the AlphaClaw root). " +
        "The error code is " + code + ": follow the fix in the alphaclaw-admin skill's relay.md under that code. Never delete relay/relaycast.db, " +
        "relay/secrets.json or relay/internal.secret, and never print their contents; ask the owner before changing the deployment environment.",
    },
    ...archiveCards,
  ];
};

module.exports = { buildRelayCards };
