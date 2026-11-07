// Relay conversations for the Relay page (ALPH-68 PR2): every DM
// conversation in the engine, grouped by agent pair, with each message's
// thread replies and the bridge's state for it; plus relay sessions on the
// box whose engine messages retention already removed, so nothing that
// happened drops out of the list. Bodies go to signed-in people only; the
// admin manifest strips them for the agent actor.
const { kRelaySessionPrefix } = require("./constants");

const kListLimitMax = 100;
const kSearchScanPages = 10;
const kConsolePage = 100;
const kTranscriptPageMax = 50;
const kRepliesLimit = 200;

const toIso = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

const parseRelaySession = (key) => {
  const match = /^agent:([^:]+):([^:]+)$/.exec(String(key || ""));
  if (!match || !match[2].startsWith(kRelaySessionPrefix)) return null;
  const peer = match[2].slice(kRelaySessionPrefix.length);
  return peer ? { agentId: match[1], peer } : null;
};

const relaySessionKeyFor = (agentId, peer) => "agent:" + agentId + ":" + kRelaySessionPrefix + String(peer).toLowerCase();

const createRelayConversations = ({ relayService, listSessionRows = null, resolveAgentId = () => "main" }) => {
  const auth = () => relayService.getAuth();

  const bridgeRowsFor = (conversationId) => {
    const store = relayService.getStore();
    return store?.listByConversation ? store.listByConversation(conversationId) : [];
  };

  const latestBridgeRows = () => {
    const store = relayService.getStore();
    const out = new Map();
    for (const row of store?.latestPerConversation ? store.latestPerConversation() : []) out.set(row.conversationId, row);
    return out;
  };

  const relaySessions = async () => {
    if (typeof listSessionRows !== "function") return [];
    try {
      const rows = await listSessionRows();
      return (Array.isArray(rows) ? rows : [])
        .map((row) => ({ row, relay: parseRelaySession(row?.key) }))
        .filter((entry) => entry.relay);
    } catch {
      return [];
    }
  };

  // Text search over a bounded window of the newest top-level messages (the
  // engine has no text search); a match on a participant name always counts.
  const searchConversationIds = async (q) => {
    const needle = q.toLowerCase();
    const ids = new Set();
    let before = null;
    for (let page = 0; page < kSearchScanPages; page += 1) {
      const rows = await relayService.engine.consoleMessages(auth().workspaceKey, { limit: kConsolePage, ...(before ? { before } : {}) });
      const list = Array.isArray(rows) ? rows : [];
      for (const row of list) {
        if (String(row?.text || "").toLowerCase().includes(needle) && row?.conversation_id) ids.add(String(row.conversation_id));
      }
      if (list.length < kConsolePage) break;
      before = list[list.length - 1].id;
    }
    return ids;
  };

  const list = async ({ agent = "", q = "", from = null, to = null, before = null, limit = 50 } = {}) => {
    const { workspaceKey, agentName } = auth();
    const boxAgentId = resolveAgentId();
    const [conversations, sessions] = await Promise.all([relayService.engine.conversations(workspaceKey), relaySessions()]);
    const latest = latestBridgeRows();
    const peersWithConversation = new Set();
    const items = [];
    for (const conversation of Array.isArray(conversations) ? conversations : []) {
      if (!conversation?.id) continue;
      const participants = Array.isArray(conversation.participants) ? conversation.participants.map(String) : [];
      const peer = participants.includes(agentName) ? participants.find((name) => name !== agentName) || null : null;
      if (peer) peersWithConversation.add(peer.toLowerCase());
      const bridge = latest.get(conversation.id) || null;
      items.push({
        id: String(conversation.id),
        participants,
        peer,
        messageCount: Number(conversation.message_count) || 0,
        lastMessageAt: toIso(conversation.last_message?.created_at),
        lastFrom: conversation.last_message?.agent_name || null,
        lastText: typeof conversation.last_message?.text === "string" ? conversation.last_message.text : "",
        lastStatus: bridge ? bridge.state : null,
        lastCode: bridge ? bridge.code : null,
        sessionKey: peer ? relaySessionKeyFor(boxAgentId, peer) : null,
        sessionOnly: false,
      });
    }
    for (const { row, relay } of sessions) {
      if (peersWithConversation.has(relay.peer.toLowerCase())) continue;
      items.push({
        id: "session:" + row.key,
        participants: [agentName, relay.peer],
        peer: relay.peer,
        messageCount: null,
        lastMessageAt: toIso(row.updatedAt || row.lastActivityAt),
        lastFrom: null,
        lastText: "",
        lastStatus: null,
        lastCode: null,
        sessionKey: String(row.key),
        sessionOnly: true,
      });
    }
    let filtered = items;
    if (agent) filtered = filtered.filter((item) => item.participants.some((name) => name.toLowerCase() === agent.toLowerCase()));
    if (from) filtered = filtered.filter((item) => item.lastMessageAt && item.lastMessageAt >= from);
    if (to) filtered = filtered.filter((item) => item.lastMessageAt && item.lastMessageAt <= to);
    if (q) {
      const needle = q.toLowerCase();
      const textMatches = await searchConversationIds(q);
      filtered = filtered.filter(
        (item) =>
          textMatches.has(item.id) ||
          item.participants.some((name) => name.toLowerCase().includes(needle)) ||
          item.lastText.toLowerCase().includes(needle),
      );
    }
    filtered.sort((a, b) => String(b.lastMessageAt || "").localeCompare(String(a.lastMessageAt || "")) || a.id.localeCompare(b.id));
    if (before) filtered = filtered.filter((item) => String(item.lastMessageAt || "") < before);
    const pageSize = Math.min(kListLimitMax, Math.max(1, limit));
    const page = filtered.slice(0, pageSize);
    return {
      agentName,
      conversations: page,
      nextBefore: filtered.length > pageSize ? page[page.length - 1].lastMessageAt : null,
      searchScanned: q ? kSearchScanPages * kConsolePage : null,
    };
  };

  const toMessage = (row, bridgeByMessage) => {
    const bridge = bridgeByMessage.get(String(row.message_id || row.id)) || null;
    return {
      id: String(row.message_id || row.id),
      from: row.agent_name || null,
      text: typeof row.text === "string" ? row.text : "",
      createdAt: toIso(row.created_at),
      threadId: row.thread_id ? String(row.thread_id) : null,
      relayStatus: row.metadata?.relay_status || null,
      relayCode: row.metadata?.relay_code || null,
      inReplyTo: row.metadata?.relay_in_reply_to ? String(row.metadata.relay_in_reply_to) : null,
      bridge: bridge
        ? { state: bridge.state, code: bridge.code, hop: bridge.hop, sessionKey: bridge.sessionKey, receivedAt: toIso(bridge.receivedAt), endedAt: toIso(bridge.endedAt) }
        : null,
    };
  };

  // One page of a conversation's transcript, oldest first: the top-level
  // messages before the cursor (newest page first) and every reply in their
  // threads.
  const transcript = async (conversationId, { before = null, limit = kTranscriptPageMax } = {}) => {
    const { workspaceKey, agentName } = auth();
    const pageSize = Math.min(kTranscriptPageMax, Math.max(1, limit));
    const rows = await relayService.engine.consoleMessages(workspaceKey, {
      conversation_id: conversationId,
      limit: pageSize,
      ...(before ? { before } : {}),
    });
    const tops = (Array.isArray(rows) ? rows : []).filter((row) => String(row?.conversation_id || "") === conversationId);
    const bridgeByMessage = new Map(bridgeRowsFor(conversationId).map((row) => [String(row.messageId), row]));
    const messages = [];
    for (const top of tops) {
      messages.push(toMessage(top, bridgeByMessage));
      let thread = null;
      try {
        thread = await relayService.engine.thread(workspaceKey, top.message_id || top.id, kRepliesLimit);
      } catch {}
      for (const reply of Array.isArray(thread?.replies) ? thread.replies : []) messages.push(toMessage(reply, bridgeByMessage));
    }
    messages.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || a.id.localeCompare(b.id));
    const participants = new Set(messages.map((message) => message.from).filter(Boolean));
    const peer = [...participants].find((name) => name !== agentName) || null;
    return {
      id: conversationId,
      agentName,
      participants: [...participants],
      sessionKey: participants.has(agentName) && peer ? relaySessionKeyFor(resolveAgentId(), peer) : null,
      messages,
      nextBefore: tops.length === pageSize ? String(tops[tops.length - 1].id) : null,
    };
  };

  return { list, transcript };
};

module.exports = { createRelayConversations, parseRelaySession };
