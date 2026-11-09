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
    bindings: (Array.isArray(body.bindings) ? body.bindings : []).map(({ threadId, clientId, agent, grantId, ...rest }) => rest),
    grants: (Array.isArray(body.grants) ? body.grants : []).map(({ id, agent, createdBy, revokedBy, ...rest }) => rest),
    handoffs: (Array.isArray(body.handoffs) ? body.handoffs : []).map(({ id, agent, fromThread, successorThread, ...rest }) => rest),
    audit: (Array.isArray(body.audit) ? body.audit : []).map((row) => ({ at: row?.at ?? null, event: row?.event ?? null })),
  };
};

// Conversations for the agent: who talked to whom, when, how many messages
// and the bridge's status codes; never text, and never a session key that
// would lead to a transcript.
const stripConversationBodies = (body) => {
  if (!body || typeof body !== "object") return body;
  const out = { ...body, bodiesHidden: true };
  if (Array.isArray(body.conversations)) {
    out.conversations = body.conversations.map(({ lastText, sessionKey, ...rest }) => ({
      ...rest,
      lastTextChars: typeof lastText === "string" ? lastText.length : 0,
    }));
  }
  if (Array.isArray(body.messages)) {
    out.messages = body.messages.map(({ text, bridge, ...rest }) => ({
      ...rest,
      textChars: typeof text === "string" ? text.length : 0,
      bridge: bridge ? { state: bridge.state, code: bridge.code, hop: bridge.hop, receivedAt: bridge.receivedAt, endedAt: bridge.endedAt } : null,
    }));
  }
  delete out.sessionKey;
  return out;
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
      id: "relay.conversations",
      title: "Relay conversations by agent pair (metadata only for the agent)",
      method: "GET",
      path: "/api/relay/conversations",
      tier: "safe",
      redactResponse: stripConversationBodies,
      notes: "Agent names, counts, times and status codes. The last message's text and the session key are removed for the agent actor.",
    },
    {
      id: "relay.conversation",
      title: "One relay conversation's messages (metadata only for the agent)",
      method: "GET",
      path: "/api/relay/conversations/:id",
      tier: "safe",
      redactResponse: stripConversationBodies,
      notes: "Each message's text and session key are removed for the agent actor (textChars gives its length).",
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
