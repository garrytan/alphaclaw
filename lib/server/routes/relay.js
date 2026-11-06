const { wrapAsync } = require("../utils/wrap-async");
const { sendRelayProblem, RelayError } = require("../relay/errors");

// Agent Relay API (read only in this release). Status and bridged-message
// states are readable by the agent actor; message bodies are stripped for it
// by the admin manifest (domains/relay.js), so only a signed-in human reads
// what agents said to each other. Nothing here returns a key or token.
const kMaxPage = 100;
const kMaxMaskChars = 16000;
const kLoopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const kCursorPattern = /^[0-9]{1,24}$/;

const pageLimit = (raw, fallback = 50) => {
  const value = Number.parseInt(String(raw ?? ""), 10);
  return Number.isInteger(value) && value > 0 ? Math.min(kMaxPage, value) : fallback;
};

const registerRelayRoutes = ({ app, requireAuth, relayService }) => {
  // The box agent's relay tools (mcp-stdio.js, started by OpenClaw with only
  // a default env) mask every outgoing text here, against AlphaClaw's full
  // secret set. Loopback only, never through a proxy, and the bearer must be
  // the relay's internal secret; anything else is answered like no route.
  // It returns only masked text.
  app.post("/relay/internal/mask", (req, res) => {
    res.set("Cache-Control", "no-store");
    const bearer = /^Bearer (.+)$/.exec(String(req.get("authorization") || ""))?.[1] || "";
    const proxied = Boolean(req.get("x-forwarded-for") || req.get("forwarded") || req.get("x-real-ip"));
    if (!kLoopbackAddresses.has(String(req.socket?.remoteAddress || "")) || proxied || !relayService.isInternalSecret(bearer)) {
      return res.status(404).end();
    }
    const text = req.body?.text;
    if (typeof text !== "string" || text.length > kMaxMaskChars) return res.status(400).json({ ok: false });
    try {
      return res.json({ ok: true, text: relayService.maskText(text) });
    } catch {
      return res.status(503).json({ ok: false });
    }
  });

  app.get(
    "/api/relay/status",
    requireAuth,
    wrapAsync(async (req, res) => {
      const status = relayService.getStatus();
      let agents = null;
      if (relayService.isReady()) {
        try {
          const { workspaceKey } = relayService.getAuth();
          const [list, presence] = await Promise.all([
            relayService.engine.listAgents(workspaceKey),
            relayService.engine.presence(workspaceKey).catch(() => []),
          ]);
          const online = new Set(
            (Array.isArray(presence) ? presence : []).map((row) => row?.agent_name || row?.name).filter(Boolean),
          );
          agents = (Array.isArray(list) ? list : []).map((agent) => ({
            name: agent.name,
            online: online.has(agent.name) || agent.status === "online",
            lastSeen: agent.last_seen || agent.last_seen_at || null,
            createdAt: agent.created_at || null,
          }));
        } catch {
          agents = null;
        }
      }
      res.json({ ok: true, ...status, agents, dbBytes: relayService.dbSizes() });
    }),
  );

  app.get(
    "/api/relay/messages",
    requireAuth,
    wrapAsync(async (req, res) => {
      if (!relayService.isReady()) return sendRelayProblem(res, new RelayError(relayService.config.enabled ? "provisioning_pending" : "relay_disabled"));
      const before = String(req.query.before || "").trim();
      if (before && !kCursorPattern.test(before)) return sendRelayProblem(res, new RelayError("invalid_input", "before must be a message log id."));
      const limit = pageLimit(req.query.limit);
      try {
        const { workspaceKey } = relayService.getAuth();
        const rows = await relayService.engine.consoleMessages(workspaceKey, { limit, ...(before ? { before } : {}) });
        const messages = (Array.isArray(rows) ? rows : []).map((row) => ({
          id: String(row.id),
          messageId: String(row.message_id || row.id),
          from: row.agent_name || null,
          to: row.metadata?.target_agent || null,
          kind: row.delivery_kind || null,
          conversationId: row.conversation_id || null,
          threadId: row.thread_id || row.metadata?.thread_id || null,
          createdAt: row.created_at || null,
          relayStatus: row.metadata?.relay_status || null,
          relayCode: row.metadata?.relay_code || null,
          text: typeof row.text === "string" ? row.text : "",
        }));
        res.json({ ok: true, messages, nextBefore: messages.length === limit ? messages[messages.length - 1].id : null });
      } catch (error) {
        sendRelayProblem(res, error);
      }
    }),
  );

  app.get("/api/relay/runs", requireAuth, (req, res) => {
    const store = relayService.getStore();
    if (!store) return res.json({ ok: true, runs: [], counts: {} });
    const beforeRaw = Number.parseInt(String(req.query.before ?? ""), 10);
    const runs = store.recent({ limit: pageLimit(req.query.limit), before: Number.isInteger(beforeRaw) && beforeRaw > 0 ? beforeRaw : null });
    res.json({
      ok: true,
      counts: store.counts(),
      runs: runs.map((row) => ({
        messageId: row.messageId,
        from: row.sender,
        state: row.state,
        code: row.code,
        hop: row.hop,
        attempts: row.attempts,
        receivedAt: new Date(row.receivedAt).toISOString(),
        dispatchedAt: row.dispatchedAt ? new Date(row.dispatchedAt).toISOString() : null,
        endedAt: row.endedAt ? new Date(row.endedAt).toISOString() : null,
        replyMessageId: row.replyMessageId,
        sessionKey: row.sessionKey,
      })),
      nextBefore: runs.length ? runs[runs.length - 1].receivedAt : null,
    });
  });
};

module.exports = { registerRelayRoutes };
