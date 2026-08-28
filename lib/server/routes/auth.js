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

const registerAuthRoutes = ({
  app,
  loginThrottle,
  membersStore = null,
  readTeamSettings = () => ({ enabled: false, disableLegacyLogin: false }),
  // Called with every resolved MEMBER identity (presence heartbeat).
  onMemberActivity = () => {},
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

  const verifySessionToken = (token) => {
    if (!SETUP_PASSWORD || !token || typeof token !== "string") return false;
    const parts = token.split(".");
    if (parts.length !== 2) return false;
    const [payload, signature] = parts;
    if (!payload || !signature) return false;
    if (!timingSafeStringEqual(signSessionPayload(payload), signature)) {
      return false;
    }
    return parseSessionPayload(payload) !== null;
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
    return { kind: "legacy", memberId: null, email: null, role: "admin" };
  };

  const isAuthorizedRequest = (req) => {
    if (kAuthMisconfigured) return false;
    const requestPath = req.path || "";
    if (requestPath.startsWith("/auth/google/callback")) return true;
    if (requestPath.startsWith("/auth/codex/callback")) return true;
    return resolveRequestIdentity(req) !== null;
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
      // Member login (team mode).
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
  app.post("/api/auth/accept-invite", (req, res) => {
    if (kAuthMisconfigured) {
      return res.status(503).json({ ok: false, error: "Auth not configured" });
    }
    if (!membersStore) {
      return res
        .status(409)
        .json({ ok: false, error: "Team access is not enabled" });
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

    // Pre-validate what we can BEFORE burning the single-use token: a taken
    // email should not consume the invite.
    if (providedEmail && membersStore.getMemberByEmail?.(providedEmail)) {
      loginThrottle.recordLoginFailure(gate.state, gate.now);
      return res.status(409).json({
        ok: false,
        code: "email_taken",
        error: "A member with that email already exists — sign in instead.",
      });
    }

    const invite = membersStore.consumeInvite({ token });
    if (!invite) {
      loginThrottle.recordLoginFailure(gate.state, gate.now);
      return res.status(400).json({
        ok: false,
        code: "invite_invalid",
        error:
          "This invite is invalid, already used, or expired. Ask your admin for a new one.",
      });
    }
    // A pinned invite email is authoritative; otherwise the invitee supplies one.
    const email = invite.email || providedEmail;
    if (!email) {
      return res
        .status(400)
        .json({ ok: false, error: "An email address is required" });
    }
    let member;
    try {
      member = membersStore.createMember({
        email,
        displayName,
        role: invite.role,
        password,
      });
    } catch (err) {
      return res.status(err?.code === "email_taken" ? 409 : 400).json({
        ok: false,
        code: err?.code || "invite_failed",
        error: err?.message || "Could not create the member account",
      });
    }
    membersStore.markInviteUsedBy?.({ inviteId: invite.id, memberId: member.id });
    loginThrottle.recordLoginSuccess(gate.clientKey);
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
    if (req.path.startsWith("/auth/google/callback")) return next();
    if (req.path.startsWith("/auth/codex/callback")) return next();
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
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.redirect("/login.html");
  };

  // 4.6: runs after requireAuth on every /api request. Admin and legacy
  // identities pass untouched; members are default-deny outside the allowlist.
  const requireMemberScope = (req, res, next) => {
    const identity = req.alphaclawIdentity;
    if (!identity || identity.role === "admin") return next();
    const fullPath = `${req.baseUrl || ""}${req.path || ""}`;
    const method = String(req.method || "GET").toUpperCase();
    if (method === "GET" || method === "HEAD") {
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

  return {
    requireAuth,
    requireAdmin,
    isAuthorizedRequest,
    isAdminRequest,
    resolveRequestIdentity,
  };
};

module.exports = { registerAuthRoutes };
