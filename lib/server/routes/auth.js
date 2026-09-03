const crypto = require("crypto");
const { kLoginCleanupIntervalMs } = require("../constants");

// Route-authorization matrix (4.6): members are default-deny — they may READ
// the surfaces chat needs and nothing else; every mutation and every
// operational surface (updates, envars, terminal, agents, team) is admin.
// Legacy shared-password sessions are the owner and count as admin, so
// single-user installs see zero behavior change.
const kMemberApiReadPrefixes = [
  "/api/auth",
  "/api/status",
  "/api/events",
  "/api/gateway-status",
  "/api/restart-status",
  // Prefix matches apply to GET/HEAD only, so this exposes just the
  // status/progress reads the app shell needs — never POST /api/onboard.
  "/api/onboard",
  "/api/usage",
  "/api/cron",
  "/api/chat",
  "/api/models",
  "/api/team",
];
const kMemberApiWritePaths = new Set(["/api/auth/logout"]);
// Denied to members even though they sit under an allowed prefix: these GETs
// return UNREDACTED provider credentials (raw API keys + OAuth access/refresh
// tokens), which the 4.6 matrix makes admin-only. Member chat only needs the
// model list/status reads (/api/models, /api/models/thinking-options,
// /api/models/status), not the config/auth editor endpoints.
const kMemberApiReadDenyPrefixes = [
  "/api/models/config",
  "/api/models/auth",
];

// agentAdmin (optional): the machine-auth dependency bundle —
// { isEnabled(), readToken(), throttle, onAuthEvent({event, clientKey}) }.
// Absent ⇒ the bearer branch is inert and auth behaves exactly as before.
const registerAuthRoutes = ({
  app,
  loginThrottle,
  membersStore = null,
  readTeamSettings = () => ({ enabled: false, disableLegacyLogin: false }),
  // Called with every resolved MEMBER identity (presence heartbeat).
  onMemberActivity = () => {},
  // Called after the member roster changes outside the admin routes (invite
  // acceptance) so the gateway auth config reconciles immediately (E-C8) —
  // a new member must appear in allowUsers/identityScopes without waiting
  // for the next admin mutation.
  onMemberRosterChanged = async () => {},
  agentAdmin = null,
}) => {
  const SETUP_PASSWORD = String(process.env.SETUP_PASSWORD || "").trim();
  const kAuthMisconfigured = !SETUP_PASSWORD;
  const kSessionTtlMs = 7 * 24 * 60 * 60 * 1000;

  const signWithSecret = (secret, payload) =>
    crypto.createHmac("sha256", secret).update(payload).digest("base64url");

  const signSessionPayload = (payload) =>
    signWithSecret(SETUP_PASSWORD, payload);

  const encodeSessionPayload = () => {
    const now = Date.now();
    return Buffer.from(
      JSON.stringify({
        iat: now,
        exp: now + kSessionTtlMs,
        nonce: crypto.randomBytes(16).toString("hex"),
      }),
    ).toString("base64url");
  };

  const createSessionToken = () => {
    const payload = encodeSessionPayload();
    return `${payload}.${signSessionPayload(payload)}`;
  };

  // Token v2 (4.2): `v2.<memberId>.<payload>.<sig>`, HMAC'd with the member's
  // OWN token_secret — rotating that secret revokes only that member's
  // sessions. Legacy 2-segment HMAC(SETUP_PASSWORD) tokens keep working and
  // identify the owner (admin).
  const createMemberSessionToken = (memberId) => {
    const secret = membersStore?.getTokenSecret?.(memberId);
    if (!secret) return null;
    const payload = encodeSessionPayload();
    const signature = signWithSecret(secret, `${memberId}.${payload}`);
    return `v2.${memberId}.${payload}.${signature}`;
  };

  const timingSafeStringEqual = (a, b) => {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
  };

  const parseSessionPayload = (payload) => {
    try {
      const parsed = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      );
      return Number.isFinite(parsed?.exp) && parsed.exp > Date.now()
        ? parsed
        : null;
    } catch {
      return null;
    }
  };

  // Returns the parsed session claims for a valid unexpired legacy token, or
  // null — only signature + exp are required.
  const getSessionClaims = (token) => {
    if (!SETUP_PASSWORD || !token || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [payload, signature] = parts;
    if (!payload || !signature) return null;
    if (!timingSafeStringEqual(signSessionPayload(payload), signature)) {
      return null;
    }
    return parseSessionPayload(payload);
  };

  const verifyMemberSessionToken = (token) => {
    if (!membersStore || !token || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 4 || parts[0] !== "v2") return null;
    const [, memberId, payload, signature] = parts;
    if (!memberId || !payload || !signature) return null;
    // getTokenSecret returns null for disabled/removed members — a disabled
    // member's outstanding cookies die immediately.
    const secret = membersStore.getTokenSecret?.(memberId);
    if (!secret) return null;
    const expected = signWithSecret(secret, `${memberId}.${payload}`);
    if (!timingSafeStringEqual(expected, signature)) return null;
    if (parseSessionPayload(payload) === null) return null;
    const member = membersStore.getMember?.(memberId);
    if (!member || member.disabled) return null;
    return member;
  };

  const verifySessionToken = (token) => getSessionClaims(token) !== null;

  const cookieParser = (req) => {
    const cookies = {};
    const cookieHeader =
      req && req.headers && typeof req.headers.cookie === "string"
        ? req.headers.cookie
        : "";
    cookieHeader.split(";").forEach((c) => {
      const [k, ...v] = c.trim().split("=");
      if (k) cookies[k] = v.join("=");
    });
    return cookies;
  };

  // Identity resolution (4.2): the boolean isAuthorizedRequest is retained as
  // a wrapper for existing call sites; new authorization decisions read the
  // full identity.
  const resolveRequestIdentity = (req) => {
    if (kAuthMisconfigured) return null;
    const cookies = cookieParser(req);
    const token = cookies.setup_token;
    if (!token) return null;
    if (token.startsWith("v2.")) {
      // A member cookie is inert whenever team mode is off (F3). Disable keeps
      // member accounts for a future re-enable but must not leave a former
      // member holding an authenticated session — and, because team-off
      // restores the gateway to single-user auth where a header-less proxied
      // request is the trusted local-direct caller, an ungated member cookie
      // would silently ESCALATE to full gateway control.
      if (!teamModeEnabled()) return null;
      const member = verifyMemberSessionToken(token);
      if (!member) return null;
      return {
        kind: "member",
        memberId: member.id,
        email: member.email,
        displayName: member.displayName,
        role: member.role,
      };
    }
    if (!verifySessionToken(token)) return null;
    // The shared-password lockdown (F4) kills EXISTING legacy sessions too, not
    // just new logins — otherwise a stolen owner cookie stays admin for its
    // full 7-day life after the admin turns legacy login off.
    if (legacyLoginDisabled()) return null;
    return { kind: "legacy", memberId: null, email: null, role: "admin" };
  };

  // allowBearer is OPT-IN PER CALL SITE (A16): WS upgrades and the manual
  // /api/chat/history check call this with the default false, so the agent
  // bearer token can never open the watchdog terminal or chat WS (upgrades
  // bypass Express middleware and would see no tier enforcement). The /api
  // requireAuth path handles the agent bearer explicitly below, not here.
  const isAuthorizedRequest = (req, { allowBearer = false } = {}) => {
    if (kAuthMisconfigured) return false;
    const requestPath = req.path || "";
    if (requestPath.startsWith("/auth/google/callback")) return true;
    if (requestPath.startsWith("/auth/codex/callback")) return true;
    if (resolveRequestIdentity(req) !== null) return true;
    return allowBearer && isValidAgentBearer(req);
  };

  const isAdminRequest = (req) =>
    resolveRequestIdentity(req)?.role === "admin";

  const setSessionCookie = (res, token) => {
    res.cookie("setup_token", token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: kSessionTtlMs,
    });
  };

  const checkThrottle = (req, res) => {
    const now = Date.now();
    const clientKey = loginThrottle.getClientKey(req);
    const state = loginThrottle.getOrCreateLoginAttemptState(clientKey, now);
    const throttle = loginThrottle.evaluateLoginThrottle(state, now);
    if (throttle.blocked) {
      res.set("Retry-After", String(throttle.retryAfterSec));
      res.status(429).json({
        ok: false,
        error: "Too many attempts. Try again shortly.",
        retryAfterSec: throttle.retryAfterSec,
      });
      return null;
    }
    return { now, clientKey, state };
  };

  const recordFailure = (res, state, now) => {
    const failure = loginThrottle.recordLoginFailure(state, now);
    if (failure.locked) {
      const retryAfterSec = Math.max(1, Math.ceil(failure.lockMs / 1000));
      res.set("Retry-After", String(retryAfterSec));
      res.status(429).json({
        ok: false,
        error: "Too many attempts. Try again shortly.",
        retryAfterSec,
      });
      return;
    }
    res.status(401).json({ ok: false, error: "Invalid credentials" });
  };

  const legacyLoginDisabled = () => {
    if (process.env.ALPHACLAW_ALLOW_LEGACY_LOGIN === "1") return false;
    try {
      return readTeamSettings()?.disableLegacyLogin === true;
    } catch {
      return false;
    }
  };

  const teamModeEnabled = () => {
    try {
      return readTeamSettings()?.enabled === true;
    } catch {
      return false;
    }
  };

  app.post("/api/auth/login", (req, res) => {
    if (kAuthMisconfigured) {
      return res.status(503).json({
        ok: false,
        error:
          "Server misconfigured: SETUP_PASSWORD is missing. Set it in your deployment environment variables and restart.",
      });
    }
    const gate = checkThrottle(req, res);
    if (!gate) return;
    const email = String(req.body?.email || "").trim();

    if (email) {
      // Member login is only valid while team mode is on (F3). With team off
      // the gateway is back in single-user auth, where a member session would
      // escalate to full gateway control — refuse the credential outright.
      if (!teamModeEnabled()) {
        return res.status(403).json({
          ok: false,
          code: "team_disabled",
          error:
            "Team access is turned off on this AlphaClaw. Sign in with the shared password.",
        });
      }
      const member = membersStore?.verifyMemberPassword?.({
        email,
        password: String(req.body?.password || ""),
      });
      if (!member) return recordFailure(res, gate.state, gate.now);
      const token = createMemberSessionToken(member.id);
      if (!token) return recordFailure(res, gate.state, gate.now);
      loginThrottle.recordLoginSuccess(gate.clientKey);
      setSessionCookie(res, token);
      return res.json({
        ok: true,
        member: {
          email: member.email,
          displayName: member.displayName,
          role: member.role,
        },
      });
    }

    // Legacy shared-password login. A lockdown rejection is a policy answer,
    // not a bad credential — it is not counted against the throttle.
    if (legacyLoginDisabled()) {
      return res.status(403).json({
        ok: false,
        code: "legacy_login_disabled",
        error:
          "Shared-password login is disabled for this install. Sign in with your member email, or set ALPHACLAW_ALLOW_LEGACY_LOGIN=1 on the server for emergency access.",
      });
    }
    if (req.body.password !== SETUP_PASSWORD) {
      return recordFailure(res, gate.state, gate.now);
    }
    loginThrottle.recordLoginSuccess(gate.clientKey);
    setSessionCookie(res, createSessionToken());
    res.json({ ok: true });
  });

  // Invite acceptance is PRE-AUTH by necessity (the invitee has no session
  // yet) — registered before the requireAuth mounts below, throttled like
  // login. The invite token is single-use via the store's atomic consume.
  app.post("/api/auth/accept-invite", async (req, res) => {
    if (kAuthMisconfigured) {
      return res.status(503).json({ ok: false, error: "Auth not configured" });
    }
    if (!membersStore || !teamModeEnabled()) {
      return res
        .status(409)
        .json({ ok: false, code: "team_disabled", error: "Team access is not enabled" });
    }
    const gate = checkThrottle(req, res);
    if (!gate) return;
    const token = String(req.body?.token || "").trim();
    const password = String(req.body?.password || "");
    const displayName = String(req.body?.displayName || "").trim();
    const providedEmail = String(req.body?.email || "").trim();
    if (!token) {
      return res.status(400).json({ ok: false, error: "Invite token required" });
    }
    if (password.length < 8) {
      return res.status(400).json({
        ok: false,
        error: "Password must be at least 8 characters",
      });
    }

    // Atomic accept: validates the token BEFORE any email check (no
    // enumeration oracle), validates the email format (blocks header/config
    // injection), and consumes + creates in one transaction so a failure
    // never burns the single-use invite.
    const result = membersStore.acceptInvite({
      token,
      providedEmail,
      password,
      displayName,
    });
    if (!result.ok) {
      const status =
        result.code === "email_taken"
          ? 409
          : result.code === "invite_invalid"
            ? 400
            : 400;
      // A wrong/expired token or a bad email is a failed attempt; a taken
      // email is a real conflict but still throttled to blunt enumeration.
      loginThrottle.recordLoginFailure(gate.state, gate.now);
      const messages = {
        invite_invalid:
          "This invite is invalid, already used, or expired. Ask your admin for a new one.",
        email_taken:
          "A member with that email already exists — sign in instead.",
        email_required: "An email address is required",
        invalid_email: "Enter a valid email address",
        weak_password: "Password must be at least 8 characters",
      };
      return res.status(status).json({
        ok: false,
        code: result.code,
        error: result.error || messages[result.code] || "Could not accept the invite",
      });
    }
    const member = result.member;
    loginThrottle.recordLoginSuccess(gate.clientKey);
    // Reconcile the gateway roster NOW (E-C8) — the response does not wait on
    // failure (the next admin mutation re-reconciles), but success must not
    // depend on someone else touching the roster.
    try {
      await onMemberRosterChanged({ reason: "invite_accepted", member });
    } catch (err) {
      console.error(
        `[team] gateway reconcile after invite accept failed: ${err?.message}`,
      );
    }
    const sessionToken = createMemberSessionToken(member.id);
    if (sessionToken) setSessionCookie(res, sessionToken);
    res.json({
      ok: true,
      member: {
        email: member.email,
        displayName: member.displayName,
        role: member.role,
      },
    });
  });

  setInterval(() => {
    loginThrottle.cleanupLoginAttemptStates();
  }, kLoginCleanupIntervalMs).unref();

  const extractBearerToken = (req) => {
    const header = req?.headers?.authorization;
    if (typeof header !== "string") return null;
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
  };

  // Hash both sides before timingSafeEqual: it throws on length mismatch, and
  // digest comparison also avoids leaking the stored token's length (F4).
  const sha256 = (value) =>
    crypto.createHash("sha256").update(String(value)).digest();
  const timingSafeTokenEqual = (a, b) =>
    crypto.timingSafeEqual(sha256(a), sha256(b));

  // Pure validity check, no throttle bookkeeping. Only meaningful while the
  // agent-admin flag is on AND a token file exists. Fed into isAuthorizedRequest's
  // opt-in bearer fallback below.
  const isValidAgentBearer = (req) => {
    if (!agentAdmin?.isEnabled?.()) return false;
    const bearer = extractBearerToken(req);
    if (!bearer) return false;
    const stored = agentAdmin.readToken?.();
    if (!stored) return false;
    return timingSafeTokenEqual(bearer, stored);
  };

  // Full bearer flow with throttle bookkeeping, used only by requireAuth's
  // /api branch. Distinct failure codes so a stale-skill agent never guesses:
  // disabled vs unavailable (mint failure) vs plain bad token (A29/A39).
  const authorizeAgentBearer = (req, bearer) => {
    if (!agentAdmin?.isEnabled?.()) {
      return {
        ok: false,
        status: 401,
        body: {
          ok: false,
          error: "Agent Administration is disabled",
          code: "agent_admin_disabled",
          hint: "Ask an operator to enable Agent Administration (Setup UI → General).",
        },
      };
    }
    const throttle = agentAdmin.throttle || loginThrottle;
    const now = Date.now();
    const clientKey = throttle.getClientKey
      ? throttle.getClientKey(req)
      : loginThrottle.getClientKey(req);
    const state = throttle.getOrCreateLoginAttemptState(clientKey, now);
    const evaluated = throttle.evaluateLoginThrottle(state, now);
    if (evaluated.blocked) {
      return {
        ok: false,
        status: 429,
        retryAfterSec: evaluated.retryAfterSec,
        body: {
          ok: false,
          error: "Too many attempts. Try again shortly.",
          code: "rate_limited",
          retryAfterSec: evaluated.retryAfterSec,
        },
      };
    }
    const stored = agentAdmin.readToken?.();
    if (!stored) {
      return {
        ok: false,
        status: 401,
        body: {
          ok: false,
          error: "Agent Administration token unavailable",
          code: "agent_admin_unavailable",
          hint: "The flag is on but no token exists (mint failure?) — check GET /api/status agentAdmin state.",
        },
      };
    }
    if (timingSafeTokenEqual(bearer, stored)) {
      throttle.recordLoginSuccess(clientKey);
      return { ok: true };
    }
    const failure = throttle.recordLoginFailure(state, now);
    if (failure.locked) {
      // Operator-visible signal for a misbehaving/compromised client (F7).
      agentAdmin.onAuthEvent?.({ event: "bearer_lockout", clientKey });
      const retryAfterSec = Math.max(1, Math.ceil(failure.lockMs / 1000));
      return {
        ok: false,
        status: 429,
        retryAfterSec,
        body: {
          ok: false,
          error: "Too many attempts. Try again shortly.",
          code: "rate_limited",
          retryAfterSec,
        },
      };
    }
    return {
      ok: false,
      status: 401,
      body: {
        ok: false,
        error: "Unauthorized",
        code: "unauthorized",
        hint: "Bearer token invalid — it may have been rotated; re-read the token file.",
      },
    };
  };

  const requireAuth = (req, res, next) => {
    if (kAuthMisconfigured) {
      if (req.originalUrl.startsWith("/api/")) {
        return res.status(503).json({
          error:
            "Server misconfigured: SETUP_PASSWORD is missing. Set it in your deployment environment variables and restart.",
        });
      }
      return res
        .status(503)
        .send(
          "Setup auth is not configured. Set SETUP_PASSWORD in your deployment environment and restart.",
        );
    }
    // Express strips the mount prefix from req.path inside app.use("/auth",
    // requireAuth), so a req.path check never matched here and the intended
    // no-session exemption was dead — a logged-out browser got bounced to
    // /login.html instead of completing the OAuth callback. req.originalUrl
    // keeps the full path (same precedent as the /api branch below); compare
    // the exact pathname, not a prefix, so /auth/google/callback-evil never
    // rides the exemption.
    const requestPathname = String(req.originalUrl || "").split("?")[0];
    if (requestPathname === "/auth/google/callback") return next();
    if (requestPathname === "/auth/codex/callback") return next();
    const identity = resolveRequestIdentity(req);
    if (identity) {
      req.alphaclawIdentity = identity;
      if (identity.kind === "member") {
        try {
          onMemberActivity(identity);
        } catch {}
      }
      return next();
    }
    if (req.originalUrl.startsWith("/api/")) {
      // Machine credential: /api only — never /setup or /auth mounts, never
      // WS upgrades (those call isAuthorizedRequest with allowBearer=false).
      const bearer = extractBearerToken(req);
      if (bearer) {
        const result = authorizeAgentBearer(req, bearer);
        if (result.ok) {
          req.alphaclawActor = { type: "agent" };
          return next();
        }
        if (result.retryAfterSec) {
          res.set("Retry-After", String(result.retryAfterSec));
        }
        return res.status(result.status).json(result.body);
      }
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.redirect("/login.html");
  };

  // 4.6: runs after requireAuth on every /api request. Admin and legacy
  // identities pass untouched; members are default-deny outside the allowlist.
  const requireMemberScope = (req, res, next) => {
    const identity = req.alphaclawIdentity;
    if (!identity || identity.role === "admin") return next();
    // Lowercased: Express route matching is case-insensitive by default, so
    // /api/models/Config reaches the handler — the prefix checks must match
    // case-insensitively too, or the deny list is trivially bypassed (F1).
    const fullPath = `${req.baseUrl || ""}${req.path || ""}`.toLowerCase();
    const method = String(req.method || "GET").toUpperCase();
    if (method === "GET" || method === "HEAD") {
      // The deny list wins over the allow prefix: a member's GET of an
      // allowed prefix (/api/models) must still be refused for the
      // credential-returning subpaths (F1).
      if (
        kMemberApiReadDenyPrefixes.some(
          (prefix) =>
            fullPath === prefix || fullPath.startsWith(`${prefix}/`),
        )
      ) {
        return res.status(403).json({
          error: "Admin access required",
          code: "admin_required",
        });
      }
      if (
        kMemberApiReadPrefixes.some(
          (prefix) =>
            fullPath === prefix || fullPath.startsWith(`${prefix}/`),
        )
      ) {
        return next();
      }
    }
    if (kMemberApiWritePaths.has(fullPath)) return next();
    return res.status(403).json({
      error: "Admin access required",
      code: "admin_required",
    });
  };

  const requireAdmin = (req, res, next) => {
    const identity = req.alphaclawIdentity || resolveRequestIdentity(req);
    if (identity?.role === "admin") return next();
    return res
      .status(403)
      .json({ error: "Admin access required", code: "admin_required" });
  };

  app.get("/api/auth/status", (req, res) => {
    let team = { enabled: false, disableLegacyLogin: false };
    try {
      const settings = readTeamSettings() || {};
      team = {
        enabled: settings.enabled === true,
        disableLegacyLogin: settings.disableLegacyLogin === true,
      };
    } catch {}
    res.json({
      authEnabled: !!SETUP_PASSWORD,
      team: {
        ...team,
        legacyLoginDisabled: legacyLoginDisabled(),
      },
    });
  });

  app.get("/api/auth/identity", (req, res) => {
    const identity = resolveRequestIdentity(req);
    if (!identity) return res.status(401).json({ error: "Unauthorized" });
    res.json({
      ok: true,
      identity: {
        kind: identity.kind,
        role: identity.role,
        email: identity.email,
        displayName: identity.displayName || null,
      },
    });
  });

  app.post("/api/auth/logout", (req, res) => {
    res.clearCookie("setup_token", { path: "/" });
    res.json({ ok: true });
  });

  app.use("/setup", requireAuth);
  app.use("/api", requireAuth);
  app.use("/api", requireMemberScope);
  app.use("/auth", requireAuth);

  // Proxy-boundary identity (4.3): resolves the request to a MEMBER identity
  // or null — legacy/anonymous sessions carry no identity header, so the
  // gateway treats them as the local-direct caller. Works on raw WS upgrade
  // requests too (cookie-header based, no Express middleware required).
  const resolveProxyIdentity = (req) => {
    try {
      if (readTeamSettings()?.enabled !== true) return null;
    } catch {
      return null;
    }
    const identity = req?.alphaclawIdentity || resolveRequestIdentity(req);
    if (identity?.kind !== "member") return null;
    // Presence heartbeat: WS upgrades bypass requireAuth (and its
    // onMemberActivity call), so gateway-bound traffic touches here.
    try {
      onMemberActivity(identity);
    } catch {}
    return identity;
  };

  // Actor identity for the enforcement/redaction layer: {type:"agent"} for
  // bearer-authed requests, null for cookie sessions (humans stay untouched).
  const resolveRequestActor = (req) => req?.alphaclawActor || null;

  return {
    requireAuth,
    requireAdmin,
    isAuthorizedRequest,
    isAdminRequest,
    resolveRequestIdentity,
    resolveProxyIdentity,
    resolveRequestActor,
  };
};

module.exports = { registerAuthRoutes };
