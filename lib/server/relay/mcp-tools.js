const { RelayError, toMcpError } = require("./errors");
const { isValidRelayAgentName } = require("./config");
const { redactSecretText } = require("../utils/redact");
const { kRelayWithheldText } = require("./constants");

// The relay tool set an agent gets: messaging only. There is no tool to
// create workspaces, rotate keys, remove agents, register webhooks or start
// anything, so a prompt-injected relay message cannot reach the engine's
// admin surface through these tools. The box agent's stdio server
// (mcp-stdio.js) serves this set as its own agent.
const kMaxTextChars = 16000;
// A Capy thread (capy-*) reads a long message in parts, so a send to one, or
// a remote agent's send to the box, may be this long (PR4, GST-2090).
const kMaxLongTextChars = 64000;
const kMaxHistory = 100;
const kLaneHistoryPages = 10;

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

const requireText = (value, field, max = kMaxTextChars) => {
  const text = typeof value === "string" ? value : "";
  if (!text.trim()) throw new RelayError("invalid_input", field + " is required.");
  if (text.length > max) throw new RelayError("invalid_input", field + " is longer than " + max + " characters.");
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

const summarizeMessage = (message, readProvenance = null) => ({
  id: String(message?.id || ""),
  from: message?.agent_name || null,
  text: message?.text || "",
  thread_id: message?.thread_id || null,
  created_at: message?.created_at || null,
  ...(message?.metadata?.relay_status ? { relay_status: message.metadata.relay_status } : {}),
  ...(message?.metadata?.relay_code ? { relay_code: message.metadata.relay_code } : {}),
  ...(message?.metadata?.relay_lane ? { lane: message.metadata.relay_lane } : {}),
  ...(message?.metadata?.relay_result_ref ? { result_ref: message.metadata.relay_result_ref, result_parts: message.metadata.relay_result_parts || null } : {}),
  ...(readProvenance && message?.metadata?.relay_provenance ? { owner_provenance: readProvenance(message) } : {}),
});

// A message the caller may not reply to and a message that does not exist
// get this same answer, so relay_reply cannot probe other conversations.
const kMessageNotFound = "Message not found.";

const rethrowEngine = (error, recipient) => {
  if (error?.engineStatus === 404 && recipient) throw new RelayError("recipient_unknown", "No agent named " + recipient + " is on this relay.");
  if (error?.engineStatus === 404) throw new RelayError("message_not_found", kMessageNotFound);
  throw error;
};

const participantNames = (conversation) =>
  (Array.isArray(conversation?.participants) ? conversation.participants : []).map((entry) => (typeof entry === "string" ? entry : entry?.agent_name));

// Engine 12.8.0 accepts a reply from an agent that is not in the
// conversation (ALPH-71 M-2), so the participant check is AlphaClaw's: the
// message's DM channel must be a conversation the acting agent is part of.
const isParticipant = async (engine, workspaceKey, message, agentName) => {
  const channelId = String(message?.channel_id || "");
  if (!channelId || !agentName) return false;
  const conversations = await engine.conversations(workspaceKey);
  const conversation = (Array.isArray(conversations) ? conversations : []).find((entry) => entry?.channel_id === channelId);
  return participantNames(conversation).includes(agentName);
};

// nextHop: the hop count a new message carries. The box agent's server
// passes one that reads the relay runs in flight (a message sent during a
// hop-N run carries N+1), so two agents answering each other reach the hop
// limit; a reply also carries at least its parent's hop + 1.
// maskText: what a sent text leaves the box as (may be async). The box
// agent's server passes AlphaClaw's masker (mcp-stdio.js); the default masks
// token shapes only. A masker that throws stops the send.
// extraMetadata: more message metadata for relay_send and relay_reply; only
// the remote side sets it (relay_approval from a delegate, GST-1982; lane,
// route and binding generation, GST-2090).
// historyLane: a lane name to keep relay_history to that lane's messages.
// maxTextChars: the longest text relay_send and relay_reply take.
// shapeOutbound({ to, text, provenanceRef }): what a masked text leaves as,
// { text, metadata, provenance }: the first part of a long message and its
// ref, and the owner-provenance statement (outbound.js). Default: as is.
// readProvenance(message): the owner_provenance relay_history shows.
// boxTools: list the box agent's definitions (provenance_ref on sends).
const createRelayTools = ({
  engine,
  getAuth,
  nextHop = () => 0,
  maskText = redactSecretText,
  onToolCall = () => {},
  extraMetadata = {},
  historyLane = null,
  maxTextChars = kMaxTextChars,
  shapeOutbound = null,
  readProvenance = null,
  boxTools = false,
}) => {
  const shaped = async (to, out, provenanceRef) => {
    if (!shapeOutbound) return { text: out.text, metadata: {}, extra: {} };
    const next = await shapeOutbound({ to, text: out.text, provenanceRef: typeof provenanceRef === "string" ? provenanceRef : null });
    const metadata = next?.metadata && typeof next.metadata === "object" ? next.metadata : {};
    return {
      text: String(next?.text ?? out.text),
      metadata,
      extra: {
        ...(metadata.relay_result_ref ? { parts: metadata.relay_result_parts || null } : {}),
        ...(metadata.relay_long_ref ? { delivered_whole: true } : {}),
        ...(next?.provenance ? { owner_provenance: true } : {}),
      },
    };
  };
  const masked = async (text) => {
    const out = String((await maskText(text)) ?? "");
    if (out === kRelayWithheldText) return { text: out, flag: { withheld: true, credentials_masked: true } };
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
      const text = requireText(args.text, "text", maxTextChars);
      const { agentToken, agentName } = getAuth();
      if (to === agentName) throw new RelayError("invalid_input", "You cannot message yourself.");
      const out = await masked(text);
      const shape = await shaped(to, out, args.provenance_ref);
      const sent = await engine.sendDm(agentToken, to, shape.text, { ...extraMetadata, ...shape.metadata, relay_hop: hopNow() }).catch((error) => rethrowEngine(error, to));
      const message = sent?.message || sent || {};
      return { message_id: String(message.id || sent?.id || ""), to, conversation_id: sent?.conversation_id || null, ...out.flag, ...shape.extra };
    },
    relay_reply: async (args) => {
      const id = requireMessageId(args.message_id);
      const text = requireText(args.text, "text", maxTextChars);
      const { agentToken, agentName, workspaceKey } = getAuth();
      const parent = await engine.getMessage(workspaceKey, id).catch((error) => rethrowEngine(error));
      if (!(await isParticipant(engine, workspaceKey, parent, agentName))) throw new RelayError("message_not_found", kMessageNotFound);
      const parentHop = Number.isInteger(parent?.metadata?.relay_hop) && parent.metadata.relay_hop >= 0 ? parent.metadata.relay_hop : -1;
      const relayHop = Math.max(parentHop + 1, hopNow());
      const out = await masked(text);
      const shape = await shaped(String(parent?.agent_name || ""), out, args.provenance_ref);
      const reply = await engine.reply(agentToken, id, shape.text, { ...extraMetadata, ...shape.metadata, relay_hop: relayHop }).catch((error) => rethrowEngine(error));
      return { message_id: String(reply?.id || ""), in_reply_to: id, ...out.flag, ...shape.extra };
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
      const pageOf = (messages) => (Array.isArray(messages) ? messages : Array.isArray(messages?.messages) ? messages.messages : []);
      let list = pageOf(await engine.dmMessages(agentToken, match.id, { limit }));
      // A lane's messages can sit behind a busier lane's: page back through
      // the conversation (newest first) until enough of them are found.
      if (historyLane) {
        let page = list;
        list = list.filter((message) => message?.metadata?.relay_lane === historyLane);
        for (let pages = 1; list.length < limit && page.length && pages < kLaneHistoryPages; pages += 1) {
          const oldest = page[page.length - 1]?.id;
          if (!oldest) break;
          page = pageOf(await engine.dmMessages(agentToken, match.id, { limit: kMaxHistory, before: oldest }));
          list = list.concat(page.filter((message) => message?.metadata?.relay_lane === historyLane));
        }
        list = list.slice(0, limit);
      }
      return {
        with: other,
        ...(historyLane ? { lane: historyLane } : {}),
        messages: list.map((message) => summarizeMessage(message, readProvenance)).sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id)),
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

  return { list: () => (boxTools ? kBoxToolDefinitions : kToolDefinitions), call };
};

// The box agent's set: its sends also take provenance_ref, which the relay
// guard sets on a turn the owner started and strips from every other call.
const kProvenanceRefProperty = {
  provenance_ref: { type: "string", description: "Set by AlphaClaw on a turn the owner started; leave it out." },
};
const kBoxToolDefinitions = Object.freeze(
  kToolDefinitions.map((definition) =>
    definition.name === "relay_send" || definition.name === "relay_reply"
      ? { ...definition, inputSchema: { ...definition.inputSchema, properties: { ...definition.inputSchema.properties, ...kProvenanceRefProperty } } }
      : definition,
  ),
);

module.exports = { createRelayTools, kToolDefinitions, kBoxToolDefinitions, kMaxTextChars, kMaxLongTextChars };
