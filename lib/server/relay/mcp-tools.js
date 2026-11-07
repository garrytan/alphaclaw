const { RelayError, toMcpError } = require("./errors");
const { isValidRelayAgentName } = require("./config");
const { redactSecretText } = require("../utils/redact");

// The relay tool set an agent gets: messaging only. There is no tool to
// create workspaces, rotate keys, remove agents, register webhooks or start
// anything, so a prompt-injected relay message cannot reach the engine's
// admin surface through these tools. The box agent's stdio server
// (mcp-stdio.js) serves this set as its own agent.
const kMaxTextChars = 16000;
const kMaxHistory = 100;

const kToolDefinitions = Object.freeze([
  {
    name: "relay_send",
    description:
      "Send a direct message to another agent on this Agent Relay. Use relay_agents to see who is on the relay. Their answer arrives as a reply in the same thread.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "The recipient's relay agent name, for example capy-1a2b3c4d." },
        text: { type: "string", description: "The message, plain text or Markdown." },
      },
      required: ["to", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "relay_reply",
    description: "Reply in the thread of a relay message you received (by its message id).",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "The id of the message you are answering." },
        text: { type: "string", description: "The reply." },
      },
      required: ["message_id", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "relay_inbox",
    description: "List your unread relay messages and mentions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "relay_history",
    description: "Read your direct-message history with one agent, newest last.",
    inputSchema: {
      type: "object",
      properties: {
        with: { type: "string", description: "The other agent's relay name." },
        limit: { type: "integer", minimum: 1, maximum: kMaxHistory, description: "How many messages, at most 100 (default 30)." },
      },
      required: ["with"],
      additionalProperties: false,
    },
  },
  {
    name: "relay_agents",
    description: "List the agents on this relay and whether each is online.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
]);

const requireText = (value, field) => {
  const text = typeof value === "string" ? value : "";
  if (!text.trim()) throw new RelayError("invalid_input", field + " is required.");
  if (text.length > kMaxTextChars) throw new RelayError("invalid_input", field + " is longer than " + kMaxTextChars + " characters.");
  return text;
};

const requireAgentName = (value, field) => {
  const name = String(value || "").trim().toLowerCase();
  if (!isValidRelayAgentName(name)) throw new RelayError("invalid_input", field + " must be a relay agent name (a-z, 0-9 and -).");
  return name;
};

const requireMessageId = (value) => {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new RelayError("invalid_input", "message_id is not a relay message id.");
  return id;
};

const summarizeMessage = (message) => ({
  id: String(message?.id || ""),
  from: message?.agent_name || null,
  text: message?.text || "",
  thread_id: message?.thread_id || null,
  created_at: message?.created_at || null,
  ...(message?.metadata?.relay_status ? { relay_status: message.metadata.relay_status } : {}),
  ...(message?.metadata?.relay_code ? { relay_code: message.metadata.relay_code } : {}),
});

const rethrowEngine = (error, recipient) => {
  if (error?.engineStatus === 404 && recipient) throw new RelayError("recipient_unknown", "No agent named " + recipient + " is on this relay.");
  if (error?.engineStatus === 404) throw new RelayError("message_not_found", "The relay has no such message.");
  throw error;
};

// nextHop: the hop count a new message carries. The box agent's server
// passes one that reads the relay runs in flight (a message sent during a
// hop-N run carries N+1), so two agents answering each other reach the hop
// limit; a reply also carries at least its parent's hop + 1.
// maskText: what a sent text leaves the box as (may be async). The box
// agent's server passes AlphaClaw's masker (mcp-stdio.js); the default masks
// token shapes only. A masker that throws stops the send.
const createRelayTools = ({ engine, getAuth, nextHop = () => 0, maskText = redactSecretText, onToolCall = () => {} }) => {
  const masked = async (text) => {
    const out = String((await maskText(text)) ?? "");
    return { text: out, flag: out !== text ? { credentials_masked: true } : {} };
  };
  const hopNow = () => {
    try {
      const hop = Number(nextHop());
      return Number.isInteger(hop) && hop > 0 ? hop : 0;
    } catch {
      return 0;
    }
  };
  const handlers = {
    relay_send: async (args) => {
      const to = requireAgentName(args.to, "to");
      const text = requireText(args.text, "text");
      const { agentToken, agentName } = getAuth();
      if (to === agentName) throw new RelayError("invalid_input", "You cannot message yourself.");
      const out = await masked(text);
      const sent = await engine.sendDm(agentToken, to, out.text, { relay_hop: hopNow() }).catch((error) => rethrowEngine(error, to));
      const message = sent?.message || sent || {};
      return { message_id: String(message.id || sent?.id || ""), to, conversation_id: sent?.conversation_id || null, ...out.flag };
    },
    relay_reply: async (args) => {
      const id = requireMessageId(args.message_id);
      const text = requireText(args.text, "text");
      const { agentToken, workspaceKey } = getAuth();
      let parentHop = -1;
      try {
        const hop = (await engine.getMessage(workspaceKey, id))?.metadata?.relay_hop;
        if (Number.isInteger(hop) && hop >= 0) parentHop = hop;
      } catch {}
      const relayHop = Math.max(parentHop + 1, hopNow());
      const out = await masked(text);
      const reply = await engine.reply(agentToken, id, out.text, { relay_hop: relayHop }).catch((error) => rethrowEngine(error));
      return { message_id: String(reply?.id || ""), in_reply_to: id, ...out.flag };
    },
    relay_inbox: async () => {
      const { agentToken } = getAuth();
      return engine.inbox(agentToken);
    },
    relay_history: async (args) => {
      const other = requireAgentName(args.with, "with");
      const limit = Number.isInteger(args.limit) ? Math.min(kMaxHistory, Math.max(1, args.limit)) : 30;
      const { agentToken } = getAuth();
      const conversations = await engine.dmConversations(agentToken);
      const participantNames = (conversation) =>
        (Array.isArray(conversation?.participants) ? conversation.participants : []).map((entry) =>
          typeof entry === "string" ? entry : entry?.agent_name,
        );
      const match = (Array.isArray(conversations) ? conversations : []).find((conversation) => {
        const names = participantNames(conversation);
        return names.length === 2 && names.includes(other);
      });
      if (!match) return { with: other, messages: [] };
      const messages = await engine.dmMessages(agentToken, match.id, { limit });
      const list = Array.isArray(messages) ? messages : Array.isArray(messages?.messages) ? messages.messages : [];
      return {
        with: other,
        messages: list
          .map(summarizeMessage)
          .sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id)),
      };
    },
    relay_agents: async () => {
      const { workspaceKey, agentName } = getAuth();
      const [agents, presence] = await Promise.all([engine.listAgents(workspaceKey), engine.presence(workspaceKey).catch(() => [])]);
      const online = new Map();
      for (const row of Array.isArray(presence) ? presence : []) {
        if (row?.agent_name || row?.name) online.set(row.agent_name || row.name, row.status || "online");
      }
      return {
        agents: (Array.isArray(agents) ? agents : []).map((agent) => ({
          name: agent.name,
          // The box agent answers through the bridge, so it is online
          // whenever these tools run.
          status: online.get(agent.name) || (agent.name === agentName ? "online" : agent.status || "offline"),
          ...(agent.name === agentName ? { box: true } : {}),
        })),
      };
    },
  };

  const call = async (name, args = {}) => {
    const handler = Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : null;
    if (!handler) return toMcpError(new RelayError("invalid_input", "Unknown relay tool " + String(name).slice(0, 64) + "."));
    const startedAt = Date.now();
    try {
      const result = await handler(args && typeof args === "object" ? args : {});
      try {
        onToolCall({ name, ok: true, ms: Date.now() - startedAt });
      } catch {}
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      try {
        onToolCall({ name, ok: false, code: error?.code || "engine_error", ms: Date.now() - startedAt });
      } catch {}
      return toMcpError(error);
    }
  };

  return { list: () => kToolDefinitions, call };
};

module.exports = { createRelayTools, kToolDefinitions, kMaxTextChars };
