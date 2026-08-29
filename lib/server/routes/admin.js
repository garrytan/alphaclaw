const { getManifest, getManifestVersion } = require("../admin-manifest");

// /api/admin: the agent-admin namespace. Registered like every setup route —
// remember SETUP_API_PREFIXES, or these silently proxy to the gateway.
// All handlers 404 when the feature flag is off: with the flag off, nothing
// about this namespace is observable beyond a static 404.
const registerAdminRoutes = ({
  app,
  isAgentAdminEnabled,
  resolveRequestActor,
  tokenStore,
  openclawDir,
  getAgentAdminEvents = null,
  confirmService = null,
  undoService = null,
  insertWatchdogEvent = null,
}) => {
  const flagGate = (req, res) => {
    if (!isAgentAdminEnabled()) {
      // Generic 404 — with the flag off the namespace is meant to be
      // indistinguishable from an unmounted route (matches the openai-compat
      // /v1 disabled path); don't advertise the feature in the body.
      res.status(404).json({ ok: false, error: "Not found" });
      return false;
    }
    return true;
  };

  // Defense-in-depth for credential/confirm governance: the manifest already
  // denies these to the agent actor, but a mount-order regression must not
  // let the agent rotate its own token or read confirm codes.
  const humanOnly = (req, res) => {
    if (resolveRequestActor(req)?.type === "agent") {
      res.status(403).json({
        ok: false,
        error: "Operator session required",
        code: "denied",
        hint: "This endpoint is dashboard-only.",
      });
      return false;
    }
    return true;
  };

  app.get("/api/admin/manifest", (req, res) => {
    if (!flagGate(req, res)) return;
    const manifest = getManifest();
    const domainFilter = String(req.query?.domain || "").trim();
    const opFilter = String(req.query?.op || "").trim();
    let ops = manifest.ops;
    if (domainFilter) ops = ops.filter((op) => op.domain === domainFilter);
    if (opFilter) ops = ops.filter((op) => op.id === opFilter);
    res.json({
      ok: true,
      manifestVersion: manifest.manifestVersion,
      source: "live",
      ops,
    });
  });

  app.get("/api/admin/audit", (req, res) => {
    if (!flagGate(req, res)) return;
    if (typeof getAgentAdminEvents !== "function") {
      return res.status(503).json({
        ok: false,
        error: "Audit store unavailable",
        code: "unavailable",
      });
    }
    const result = getAgentAdminEvents({
      op: String(req.query?.op || ""),
      tier: String(req.query?.tier || ""),
      code: String(req.query?.code || ""),
      since: String(req.query?.since || ""),
      limit: req.query?.limit,
      summary: String(req.query?.summary || "") === "1",
    });
    res.json({ ok: true, manifestVersion: getManifestVersion(), ...result });
  });

  app.post("/api/admin/token/rotate", (req, res) => {
    if (!flagGate(req, res)) return;
    if (!humanOnly(req, res)) return;
    try {
      tokenStore.rotateToken({ openclawDir });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: `Token rotation failed: ${error.message}`,
        code: "rotate_failed",
      });
    }
    try {
      insertWatchdogEvent?.({
        eventType: "agent_admin",
        source: "agent-admin",
        status: "info",
        details: { phase: "token_rotated", actor: "operator" },
      });
    } catch {}
    res.json({ ok: true, rotatedAt: new Date().toISOString() });
  });

  app.get("/api/admin/confirms", (req, res) => {
    if (!flagGate(req, res)) return;
    if (!humanOnly(req, res)) return;
    if (!confirmService) return res.json({ ok: true, confirms: [] });
    res.json({ ok: true, confirms: confirmService.listPending() });
  });

  if (undoService) {
    app.get("/api/admin/undo-candidate", (req, res) => {
      if (!flagGate(req, res)) return;
      res.json({ ok: true, candidate: undoService.getCandidate() });
    });

    app.post("/api/admin/undo-last", (req, res) => {
      if (!flagGate(req, res)) return;
      const result = undoService.undoLast();
      if (!result.ok) {
        return res.status(result.status || 409).json({
          ok: false,
          error: result.error,
          code: result.code,
          ...(result.hint ? { hint: result.hint } : {}),
        });
      }
      res.json({
        ok: true,
        restored: result.restored,
        notRestored: result.notRestored,
        restartRequired: result.restartRequired === true,
      });
    });
  }
};

module.exports = { registerAdminRoutes };
