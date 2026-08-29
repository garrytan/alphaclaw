const { isValidOperatorId, kMaxOperators } = require("../operators-store");

// Team (named operators) management API. All routes live under /api and are
// requireAuth-gated by the auth middleware registered in routes/auth.js
// (matching the nodes/system route modules). The unauthenticated
// /api/team/login-info endpoint lives in routes/auth.js because it must be
// registered ahead of the auth middleware.
const registerTeamRoutes = ({ app, teamService }) => {
  app.get("/api/team", async (req, res) => {
    const enabled = teamService.isTeamEnabled();
    res.json({
      ok: true,
      enabled,
      operatorCount: teamService.listOperators().length,
      identityProbe: enabled ? await teamService.getIdentityProbe() : null,
    });
  });

  // Toggling enabled drives the gateway auth-mode transition (snapshot ->
  // trusted-proxy config -> restart -> probe -> auto-restore on failure).
  app.put("/api/team", async (req, res) => {
    if (typeof req.body?.enabled !== "boolean") {
      return res.status(400).json({ ok: false, error: "enabled must be a boolean" });
    }
    // Express 4 does not forward async rejections; a throw below must become
    // a 500, never an unhandled rejection that kills the process.
    try {
    const result = await teamService.setEnabled(req.body.enabled);
    if (!result.ok) {
      // A transition already in flight is a client conflict, not a gateway
      // failure — 409 so callers can distinguish "retry later" from "the
      // auth switch itself failed (and was auto-restored)".
      const inFlight = /already running/i.test(String(result.error || ""));
      return res.status(inFlight ? 409 : 502).json({
        ok: false,
        enabled: teamService.isTeamEnabled(),
        restored: result.restored === true,
        error: result.error || "Team mode transition failed",
      });
    }
    res.json({ ok: true, enabled: result.enabled, changed: result.changed === true });
  } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  app.get("/api/team/operators", (req, res) => {
    res.json({
      ok: true,
      operators: teamService.listOperators(),
      operatorsVersion: teamService.getOperatorsVersion(),
    });
  });

  // PUT replaces the whole list (the editor works on the full roster).
  app.put("/api/team/operators", (req, res) => {
    const operators = req.body?.operators;
    if (!Array.isArray(operators)) {
      return res.status(400).json({ ok: false, error: "operators must be an array" });
    }
    if (operators.length > kMaxOperators) {
      return res.status(400).json({
        ok: false,
        error: `At most ${kMaxOperators} operators are supported`,
      });
    }
    const seen = new Set();
    for (const operator of operators) {
      const id = String(operator?.id || "").trim();
      if (!isValidOperatorId(id)) {
        return res.status(400).json({
          ok: false,
          error: `Invalid operator id "${id}": use letters, digits, and . _ @ + - (max 128 chars)`,
        });
      }
      if (seen.has(id)) {
        return res.status(400).json({ ok: false, error: `Duplicate operator id "${id}"` });
      }
      seen.add(id);
    }
    if (teamService.isTeamEnabled() && operators.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "Team mode needs at least one operator. Disable team mode first.",
      });
    }
    const state = teamService.setOperators(operators);
    res.json({
      ok: true,
      operators: state.operators,
      operatorsVersion: state.operatorsVersion,
    });
  });
};

module.exports = { registerTeamRoutes };
