const crypto = require("crypto");

// Rescue-link capability redirect — the ONLY unauthenticated surface of the
// local rescue session. GET /rescue/<256-bit token> 302s to the live
// claude.ai Remote Control URL while the session runs, and uniformly 404s
// otherwise (stop/reap revokes every distributed copy of the link).
//
//   GET /rescue/:token ─▶ resolveRescueRedirect(token)   [timing-safe, live-state]
//        │                      │null                        │url
//        ▼                      ▼                            ▼
//   no-store,no-referrer   uniform friendly 404      claude.ai origin+path guard
//                          (bad token / no session        │pass         │fail
//                           / starting — no oracle)       ▼             ▼
//                                                    302 Location   uniform 404
//                                                    (empty body)   + error log
//
// Audit (best-effort, never blocks the response): rescue_link_redeemed /
// rescue_link_probe_failed operation events, write-capped by the injected
// gates so probing or hammering can never flood watchdog.db. Caps gate event
// WRITES only — the response shape never changes (no oracle, and a break-
// glass path must never lock the operator out). HEAD gets the same redirect
// but no audit event and no liveness kick (Express auto-HEAD runs this
// handler, and link scanners must not pollute the audit trail).
const kMissBody =
  "This rescue link is no longer active. Start a new session from the AlphaClaw Watchdog tab.\n";
const kUserAgentMaxChars = 120;

// Correlation id for logs: hash prefix, never the raw token (the token rides
// the URL path, which query-string redaction does not cover).
const tokenLogId = (token) =>
  crypto.createHash("sha256").update(String(token || "")).digest("hex").slice(0, 8);

// tui.js canonicalizes both Remote Control URL shapes; this route re-checks
// at the boundary so a future scraper bug cannot become an open redirect.
const isAllowedRescueTarget = (target) => {
  let parsed;
  try {
    parsed = new URL(String(target || ""));
  } catch {
    return false;
  }
  if (parsed.origin !== "https://claude.ai") return false;
  if (/^\/code\/[A-Za-z0-9_-]+$/.test(parsed.pathname)) return true;
  return parsed.pathname === "/code" && Boolean(parsed.searchParams.get("environment"));
};

const registerRescueLinkRoutes = ({
  app,
  claudeCodeLocalService = null,
  recordOperationEvent = null,
  // { probe, redeem } event-rate gates (login-throttle instances). Optional:
  // absent gates fail OPEN (events flow) — caps are flood control, not auth.
  throttle = null,
  nowFn = Date.now,
  logger = console,
} = {}) => {
  // Consume one slot in the gate's window; true = the event may be written.
  // Fail-open on any gate error: a broken cap store must cost bounded noise,
  // never forensics.
  const allowEvent = (gate, clientKey) => {
    if (!gate) return true;
    try {
      const now = nowFn();
      const bundle = gate.getOrCreateLoginAttemptState(String(clientKey || "unknown"), now);
      const verdict = gate.evaluateLoginThrottle(bundle, now);
      if (verdict.blocked) return false;
      gate.recordLoginFailure(bundle, now);
      return true;
    } catch {
      return true;
    }
  };

  const recordEvent = ({ kind, req, token }) => {
    if (typeof recordOperationEvent !== "function") return;
    try {
      recordOperationEvent({
        kind,
        status: "ok",
        details: {
          ip: String(req.ip || "unknown"),
          userAgent: String(req.headers?.["user-agent"] || "").slice(0, kUserAgentMaxChars),
          tokenId: tokenLogId(token),
        },
      });
    } catch (error) {
      try {
        logger.warn?.(`[rescue-link] audit event failed: ${error?.message}`);
      } catch {}
    }
  };

  app.get("/rescue/:token", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    const token = String(req.params?.token || "");
    const isHead = req.method === "HEAD";
    let target = null;
    try {
      target = claudeCodeLocalService?.resolveRescueRedirect?.(token) || null;
    } catch {
      target = null;
    }
    if (target && !isAllowedRescueTarget(target)) {
      // Uniform miss on guard refusal too — but loudly logged: this firing
      // means the TUI scraper produced a non-canonical URL.
      try {
        logger.error?.(
          `[rescue-link] refused non-claude.ai redirect target (token ${tokenLogId(token)})`,
        );
      } catch {}
      target = null;
    }
    if (!target) {
      if (!isHead && allowEvent(throttle?.probe, req.ip)) {
        recordEvent({ kind: "rescue_link_probe_failed", req, token });
      }
      return res.status(404).type("text/plain").send(kMissBody);
    }
    if (!isHead) {
      if (allowEvent(throttle?.redeem, req.ip)) {
        recordEvent({ kind: "rescue_link_redeemed", req, token });
      }
      // Self-healing revocation: the first click after an unexpected pane
      // death discovers it. Promise rejection MUST be handled here — a sync
      // try/catch does not catch a rejected promise.
      try {
        Promise.resolve(claudeCodeLocalService?.checkSessionLiveness?.()).catch(() => {});
      } catch {}
    }
    return res.status(302).set("Location", target).end();
  });

  // Malformed percent-encoding in the token segment fails Express's param
  // decoding BEFORE the handler runs; without this, the default error
  // handler's HTML body echoes the raw malformed path. Keep the reply
  // uniform and path-free. (Four args: Express only treats arity-4
  // middleware as an error handler.)
  // eslint-disable-next-line no-unused-vars
  app.use("/rescue", (err, req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.status(400).type("text/plain").send("Bad request.\n");
  });
};

module.exports = { registerRescueLinkRoutes };
