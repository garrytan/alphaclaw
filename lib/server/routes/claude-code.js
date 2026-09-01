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

// Local rescue-session refusals: 4xx for caller-fixable states, 502 for the
// box-side failures (the popup path closes and toasts on 502 — deliberately
// NO routine fallback there, per the consent rule).
const kLocalStatusByCode = {
  disabled: 409,
  not_installed: 409,
  needs_login: 409,
  login_in_progress: 409,
  already_logged_in: 409,
  no_login_in_progress: 409,
  session_running: 409,
  confirm_required: 409,
  busy: 409,
  memory_floor: 409,
  empty_code: 400,
  invalid_code: 400,
  no_buffer: 404,
};

const registerClaudeCodeRoutes = ({
  app,
  requireAuth,
  claudeCodeService,
  claudeCodeLocalService = null,
  getBaseUrl = null,
}) => {
  // The service returns the rescue link as a relative path (/rescue/<token>).
  // Absolutize preferring the VALIDATED configured base origin (same source
  // the notification line uses) — the link carries a live capability token,
  // and X-Forwarded-Host/Host are request-controlled, so a misconfigured
  // proxy must not be able to point the operator's QR code at a foreign
  // origin. Only when no base URL is configured do we fall back to the
  // request-derived origin (zero-config installs; same trust as the
  // webhooks' callback-URL builder).
  // Fail closed at the boundary: ONLY the wrapper shape may leave this API.
  // Anything else (a raw claude.ai URL from a regressed service, arbitrary
  // strings) is redacted to null with a loud log — the /^\/rescue\// test
  // pins upstream are the tripwire, this is the enforcement.
  const kWrapperPathPattern = /^\/rescue\/[0-9a-f]{64}$/;
  const absolutizeRescueLink = (req, value) => {
    if (value == null) return value;
    if (typeof value !== "string" || !kWrapperPathPattern.test(value)) {
      console.error(
        "[claude-code-local] redacted a non-wrapper sessionUrl shape from an API response",
      );
      return null;
    }
    const configuredOrigin = claudeCodeLocalService?.getExternalBaseOrigin?.() || null;
    if (configuredOrigin) return `${configuredOrigin}${value}`;
    if (typeof getBaseUrl === "function") return `${getBaseUrl(req)}${value}`;
    return value;
  };
  const sendLocalRefusal = (res, result) => {
    const status = kLocalStatusByCode[result.code] || 502;
    const body = {
      ok: false,
      error: result.code,
      message: result.message || "The local rescue session operation failed.",
    };
    // confirm_required carries the server's authoritative mode+cwd so the
    // client modal renders server truth, not a possibly-stale status snapshot.
    if (result.permissionMode != null) body.permissionMode = result.permissionMode;
    if (result.cwd != null) body.cwd = result.cwd;
    res.status(status).json(body);
  };

  // One 503 envelope for every local endpoint when the service isn't wired.
  const requireLocal = (res, method) => {
    if (claudeCodeLocalService?.[method]) return true;
    res.status(503).json({
      ok: false,
      error: "not_wired",
      message: kSessionRefusalMessages.not_wired,
    });
    return false;
  };

  // One status fetch for both launch paths: the routine availability block is
  // unchanged (old UIs keep working), the `local` block is additive (old
  // servers simply omit it and new UIs fall back to the routine path).
  app.get("/api/claude-code/status", requireAuth, (req, res) => {
    try {
      const availability = claudeCodeService?.getAvailability
        ? claudeCodeService.getAvailability()
        : { available: false, reason: "not_wired" };
      let local = null;
      try {
        local = claudeCodeLocalService?.getStatusSnapshot?.() ?? null;
      } catch (err) {
        console.error(`[claude-code-local] status snapshot failed: ${err.message}`);
      }
      if (local?.sessionUrl) {
        local = { ...local, sessionUrl: absolutizeRescueLink(req, local.sessionUrl) };
      }
      res.json({ ok: true, availability, local });
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
    "/api/claude-code/local/session",
    requireAuth,
    wrapAsync(async (req, res) => {
      if (!requireLocal(res, "startSession")) return;
      // Same strict-boolean consent discipline as the routine fire.
      const confirmed = req.body?.confirmed === true;
      // Optional server-verified consent mode (TOCTOU guard): when the client
      // names the mode its confirmation displayed, a mismatch with the live
      // config forces a fresh confirm instead of riding stale consent.
      const consentedMode =
        typeof req.body?.permissionMode === "string" ? req.body.permissionMode : null;
      const result = await claudeCodeLocalService.startSession({
        confirmed,
        consentedMode,
        source: "click",
      });
      if (!result.ok) {
        sendLocalRefusal(res, result);
        return;
      }
      if (result.status === "running") {
        res.json({
          ok: true,
          status: "running",
          sessionId: result.sessionId,
          sessionUrl: absolutizeRescueLink(req, result.sessionUrl),
        });
        return;
      }
      res.status(202).json({ ok: true, status: "starting" });
    }),
  );

  app.post(
    "/api/claude-code/local/session/stop",
    requireAuth,
    wrapAsync(async (req, res) => {
      if (!requireLocal(res, "stopSession")) return;
      const result = await claudeCodeLocalService.stopSession();
      if (!result.ok) {
        sendLocalRefusal(res, result);
        return;
      }
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/claude-code/local/login",
    requireAuth,
    wrapAsync(async (req, res) => {
      if (!requireLocal(res, "startLogin")) return;
      const result = await claudeCodeLocalService.startLogin();
      if (!result.ok) {
        sendLocalRefusal(res, result);
        return;
      }
      res.status(202).json({ ok: true, status: "starting" });
    }),
  );

  app.post(
    "/api/claude-code/local/login/code",
    requireAuth,
    wrapAsync(async (req, res) => {
      if (!requireLocal(res, "submitLoginCode")) return;
      const result = await claudeCodeLocalService.submitLoginCode({ code: req.body?.code });
      if (!result.ok) {
        sendLocalRefusal(res, result);
        return;
      }
      res.json({ ok: true, status: "verifying" });
    }),
  );

  app.post(
    "/api/claude-code/local/login/cancel",
    requireAuth,
    wrapAsync(async (req, res) => {
      if (!requireLocal(res, "cancelLogin")) return;
      await claudeCodeLocalService.cancelLogin();
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/claude-code/local/logout",
    requireAuth,
    wrapAsync(async (req, res) => {
      if (!requireLocal(res, "logout")) return;
      const result = await claudeCodeLocalService.logout();
      if (!result.ok) {
        sendLocalRefusal(res, result);
        return;
      }
      res.json({ ok: true });
    }),
  );

  app.get(
    "/api/claude-code/local/tail",
    requireAuth,
    wrapAsync(async (req, res) => {
      if (!requireLocal(res, "getTail")) return;
      const source = req.query?.source === "login" ? "login" : "session";
      const result = await claudeCodeLocalService.getTail({ source });
      if (!result.ok) {
        sendLocalRefusal(res, result);
        return;
      }
      res.json({ ok: true, source: result.source, tail: result.tail });
    }),
  );

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
