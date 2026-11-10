const path = require("path");
const { wrapAsync } = require("../utils/wrap-async");
const { sendRelayProblem, RelayError } = require("../relay/errors");
const { createRelayConversations } = require("../relay/conversations");
const { createRelayRestartRequests } = require("../relay/restart-request");

// Agent Relay API (read only in this release). Status and bridged-message
// states are readable by the agent actor; message bodies are stripped for it
// by the admin manifest (domains/relay.js), so only a signed-in human reads
// what agents said to each other. Nothing here returns a key or token.
const kMaxPage = 100;
const { kMaxLongTextChars } = require("../relay/mcp-tools");
const kMaxMaskChars = kMaxLongTextChars;
const kLoopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const kCursorPattern = /^[0-9]{1,24}$/;
const kConversationIdPattern = /^[A-Za-z0-9_-]{1,80}$/;
const kAgentNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const kIsoPattern = /^\d{4}-\d{2}-\d{2}(?:T[0-9:.]+Z?)?$/;

const pageLimit = (raw, fallback = 50) => {
  const value = Number.parseInt(String(raw ?? ""), 10);
  return Number.isInteger(value) && value > 0 ? Math.min(kMaxPage, value) : fallback;
};

const registerRelayRoutes = ({ app, requireAuth, relayService, listSessionRows = null, requestGatewayRestart = null }) => {
  const conversations = createRelayConversations({
    relayService,
    listSessionRows,
    resolveAgentId: () => relayService.resolveAgentId?.() || "main",
  });
  const notReady = (res) =>
    sendRelayProblem(res, new RelayError(relayService.config.enabled ? "provisioning_pending" : "relay_disabled"));

  // The box agent's relay tools (mcp-stdio.js, started by OpenClaw with only
  // a default env) mask every outgoing text here, against AlphaClaw's full
  // secret set. Loopback only, never through a proxy, and the bearer must be
  // the relay's internal secret; anything else is answered like no route.
  // It returns only masked text.
  const internalCaller = (req) => {
    const bearer = /^Bearer (.+)$/.exec(String(req.get("authorization") || ""))?.[1] || "";
    const proxied = Boolean(req.get("x-forwarded-for") || req.get("forwarded") || req.get("x-real-ip"));
    return kLoopbackAddresses.has(String(req.socket?.remoteAddress || "")) && !proxied && relayService.isInternalSecret(bearer);
  };
  app.post("/relay/internal/mask", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!internalCaller(req)) return res.status(404).end();
    const text = req.body?.text;
    if (typeof text !== "string" || text.length > kMaxMaskChars) return res.status(400).json({ ok: false });
    try {
      return res.json({ ok: true, text: relayService.maskText(text) });
    } catch {
      return res.status(503).json({ ok: false });
    }
  });

  // The box agent's sends after masking (mcp-stdio.js): a long text to a
  // Capy thread leaves as its first part and a result_ref, and a turn the
  // owner started gets its signed owner-provenance statement (outbound.js).
  // Same caller rule as /relay/internal/mask.
  app.post("/relay/internal/outbound", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!internalCaller(req)) return res.status(404).end();
    const { to, text, provenance_ref: provenanceRef = null } = req.body || {};
    if (typeof to !== "string" || typeof text !== "string" || (provenanceRef !== null && typeof provenanceRef !== "string")) {
      return res.status(400).json({ ok: false, error: "invalid_input" });
    }
    try {
      return res.json({ ok: true, ...relayService.outbound.prepareOutbound({ to, text, provenanceRef }) });
    } catch (error) {
      if (error instanceof RelayError) return res.status(400).json({ ok: false, error: error.code, message: error.message });
      return res.status(503).json({ ok: false, error: "outbound_unavailable" });
    }
  });

  // A gateway restart the owner's own attested Capy thread asked for
  // (GST-2323 PR2): the relay guard posts the relay message id here instead
  // of letting the turn restart the gateway. relay/restart-request.js checks
  // the message against the box's records and runs AlphaClaw's restart
  // ladder with source relay:<thread code>. Same caller rule as
  // /relay/internal/mask.
  const restartRequests = createRelayRestartRequests({
    rootDir: relayService.paths?.dir ? path.dirname(relayService.paths.dir) : null,
    requestGatewayRestart,
  });
  app.post("/relay/internal/gateway-restart", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!internalCaller(req)) return res.status(404).end();
    const { statusCode, body } = restartRequests(req.body?.message_id);
    return res.status(statusCode).json(body);
  });

  // The public half of the relay's owner-provenance key, for a remote agent
  // that checks a statement itself. No secret: nothing else is returned.
  app.get("/relay/provenance-key", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!relayService.config.enabled) return sendRelayProblem(res, new RelayError("relay_disabled"));
    try {
      return res.json(relayService.outbound.publicKey());
    } catch {
      return res.status(503).json({ error: "provenance_key_unavailable" });
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
            // The box agent answers through the bridge, not a live
            // connection: while the relay is ready, it is online.
            online: online.has(agent.name) || agent.status === "online" || agent.name === status.agentName,
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

  // Conversations (ALPH-68): DM conversations grouped by agent pair, plus
  // relay sessions whose engine messages retention removed. Text goes to
  // signed-in people only (domains/relay.js strips it for the agent).
  app.get(
    "/api/relay/conversations",
    requireAuth,
    wrapAsync(async (req, res) => {
      if (!relayService.isReady()) return notReady(res);
      const agent = String(req.query.agent || "").trim();
      const q = String(req.query.q || "").trim().slice(0, 200);
      const from = String(req.query.from || "").trim();
      const to = String(req.query.to || "").trim();
      const before = String(req.query.before || "").trim();
      if (agent && !kAgentNamePattern.test(agent)) return sendRelayProblem(res, new RelayError("invalid_input", "agent must be a relay agent name."));
      // Searching message text would let the agent actor test for words in
      // DMs whose text it never receives.
      if (q && req.alphaclawActor?.type === "agent") {
        return sendRelayProblem(res, new RelayError("invalid_input", "Text search is for signed-in people only."));
      }
      for (const value of [from, to, before]) {
        if (value && !kIsoPattern.test(value)) return sendRelayProblem(res, new RelayError("invalid_input", "from, to and before must be ISO dates."));
      }
      try {
        res.json({ ok: true, ...(await conversations.list({ agent, q, from: from || null, to: to || null, before: before || null, limit: pageLimit(req.query.limit) })) });
      } catch (error) {
        sendRelayProblem(res, error);
      }
    }),
  );

  app.get(
    "/api/relay/conversations/:id",
    requireAuth,
    wrapAsync(async (req, res) => {
      if (!relayService.isReady()) return notReady(res);
      const id = String(req.params.id || "");
      const before = String(req.query.before || "").trim();
      if (!kConversationIdPattern.test(id)) return sendRelayProblem(res, new RelayError("invalid_input", "That is not a relay conversation id."));
      if (before && !kCursorPattern.test(before)) return sendRelayProblem(res, new RelayError("invalid_input", "before must be a message log id."));
      try {
        res.json({ ok: true, ...(await conversations.transcript(id, { before: before || null, limit: pageLimit(req.query.limit) })) });
      } catch (error) {
        sendRelayProblem(res, error);
      }
    }),
  );

  // Retry the brain archive: every parked or backed-off conversation is
  // written again now, and a page that changed in the brain since this box
  // last wrote it is replaced. Signed-in people only: it is not in the admin
  // manifest, so the agent actor is refused before it gets here.
  app.post("/api/relay/archive/retry", requireAuth, (req, res) => {
    if (req.alphaclawActor?.type === "agent") return res.status(403).json({ ok: false, code: "admin_required", error: "Admin access required" });
    const result = relayService.retryArchive?.() || null;
    if (!result) return sendRelayProblem(res, new RelayError(relayService.config.enabled ? "provisioning_pending" : "relay_disabled"));
    res.json({ ok: true, ...result, archive: relayService.getStatus().archive });
  });

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
