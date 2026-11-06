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

// The agent actor sees connection health, not who is connected: bound
// thread ids, client ids, agent names and audit details are humans-only.
const stripRemoteIdentities = (body) => {
  if (!body || typeof body !== "object") return body;
  return {
    ...body,
    identitiesHidden: true,
    clients: (Array.isArray(body.clients) ? body.clients : []).map(({ clientId, ...rest }) => rest),
    bindings: (Array.isArray(body.bindings) ? body.bindings : []).map(({ threadId, clientId, agent, ...rest }) => rest),
    audit: (Array.isArray(body.audit) ? body.audit : []).map((row) => ({ at: row?.at ?? null, event: row?.event ?? null })),
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
      redactResponse: stripRemoteIdentities,
      notes: "Thread ids, client ids, agent names and audit details are removed for the agent actor. Revoking a client or removing a binding is for signed-in people only.",
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
