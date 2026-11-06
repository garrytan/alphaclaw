// Agent Relay: the agent actor reads status, the roster and bridged-message
// states, but never message bodies (what other agents and threads sent this
// box), which only a signed-in human reads in the Relay page.
const stripBodies = (body) => {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return body;
  return {
    ...body,
    bodiesHidden: true,
    messages: body.messages.map((message) => {
      const { text, ...rest } = message || {};
      return { ...rest, textChars: typeof text === "string" ? text.length : 0 };
    }),
  };
};

module.exports = {
  domain: "relay",
  title: "Agent Relay",
  summary: "Agent Relay: status, roster, audit log (bodies humans-only), bridged runs",
  ops: [
    {
      id: "relay.status",
      title: "Relay health, engine, roster and bridge counts",
      method: "GET",
      path: "/api/relay/status",
      tier: "safe",
    },
    {
      id: "relay.messages",
      title: "Relay audit log (message bodies stripped for the agent)",
      method: "GET",
      path: "/api/relay/messages",
      tier: "safe",
      redactResponse: stripBodies,
      notes: "Each message's text is removed for the agent actor (textChars gives its length).",
    },
    {
      id: "relay.remote",
      title: "Remote connections: OAuth clients, bound threads and wake delivery",
      method: "GET",
      path: "/api/relay/remote",
      tier: "safe",
      notes: "Revoking a client or removing a binding is for signed-in people only.",
    },
    {
      id: "relay.runs",
      title: "Bridged relay messages and their states",
      method: "GET",
      path: "/api/relay/runs",
      tier: "safe",
    },
  ],
};
