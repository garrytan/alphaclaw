// Doctor card for the Agent Relay (det:relay-*): one card while the relay is
// on but not running, naming the coded failure and its fix (errors.js). No
// card while it is off, starting, or ready; the non-loopback listener is a
// Relay-page warning, not a Doctor card (it is expected until the engine has
// a host flag).
const buildRelayCards = (status, { sanitize = (text) => String(text ?? "") } = {}) => {
  if (!status?.enabled || status.phase !== "failed" || !status.error?.code) return [];
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
  ];
};

module.exports = { buildRelayCards };
