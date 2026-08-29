// Claude Code launcher endpoints — presence-only status for the sidebar
// tooltip, and the session-fire POST behind the one-time consent handshake.
// The fire starts an autonomous, billable Claude Code cloud run on the
// operator's claude.ai account; the admin manifest denies it to the agent
// actor (domains/claude-code.js).
const { wrapAsync } = require("../utils/wrap-async");

// Human copy for codes the SERVICE cannot message itself (absence of the
// service, and raw upstream statuses, which the service reports as code +
// logged detail only). For every other code the service's own message wins —
// it carries per-instance detail (the real timeout seconds, which Envars key
// is missing) that a static map here would shadow.
const kSessionRefusalMessages = {
  not_wired: "The Claude Code launcher is not available on this server.",
  upstream_400: "The routine refused to fire (it may be paused).",
  upstream_401:
    "The routine token was rejected — it may have been revoked. Check CLAUDE_CODE_ROUTINE_TOKEN in Envars.",
  upstream_403: "Your claude.ai account does not have access to routine fires.",
  upstream_404:
    "The routine was not found — check CLAUDE_CODE_ROUTINE_URL in Envars.",
  upstream_429: "The routine's run allowance is exhausted — try again later.",
};

// HTTP status per machine code; everything unlisted is an upstream/transport
// failure surfaced as 502. Upstream 401/403 must never surface as OUR status
// (authFetch treats a 401 as session expiry and force-logs the operator out).
const kStatusByCode = {
  not_configured: 409,
  invalid_config: 409,
  confirm_required: 409,
  busy: 409,
  cooldown: 429,
  upstream_429: 429,
  timeout: 504,
};

const registerClaudeCodeRoutes = ({ app, requireAuth, claudeCodeService }) => {
  // Presence-only availability for the sidebar tooltip: never echoes the
  // configured values, and degrades honestly when the service is absent.
  app.get("/api/claude-code/status", requireAuth, (req, res) => {
    try {
      if (!claudeCodeService?.getAvailability) {
        res.json({
          ok: true,
          availability: { available: false, reason: "not_wired" },
        });
        return;
      }
      res.json({ ok: true, availability: claudeCodeService.getAvailability() });
    } catch (err) {
      // Keep the surface's own envelope (machine code + human copy); raw
      // exception prose stays in the server log, never the client.
      console.error(`[claude-code] status failed: ${err.message}`);
      res.status(500).json({
        ok: false,
        error: "status_failed",
        message: "Could not read the launcher status.",
      });
    }
  });

  app.post(
    "/api/claude-code/session",
    requireAuth,
    wrapAsync(async (req, res) => {
      if (!claudeCodeService?.createSession) {
        res.status(503).json({
          ok: false,
          error: "not_wired",
          message: kSessionRefusalMessages.not_wired,
        });
        return;
      }
      // Strict boolean: only a literal true asserts consent; strings and
      // truthy junk stay false so a sloppy caller cannot skip the handshake.
      const confirmed = req.body?.confirmed === true;
      const result = await claudeCodeService.createSession({ confirmed });
      if (!result.ok) {
        const status = kStatusByCode[result.code] || 502;
        if (status === 429 && result.retryAfterSec) {
          res.set("Retry-After", String(result.retryAfterSec));
        }
        res.status(status).json({
          ok: false,
          error: result.code,
          message:
            result.message ||
            kSessionRefusalMessages[result.code] ||
            "Could not start a Claude Code session.",
        });
        return;
      }
      res.json({ ok: true, sessionId: result.sessionId, sessionUrl: result.sessionUrl });
    }),
  );
};

module.exports = { registerClaudeCodeRoutes };
