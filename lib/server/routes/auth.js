const crypto = require("crypto");
const { kLoginCleanupIntervalMs } = require("../constants");

// agentAdmin (optional): the machine-auth dependency bundle —
// { isEnabled(), readToken(), throttle, onAuthEvent({event, clientKey}) }.
// Absent ⇒ the bearer branch is inert and auth behaves exactly as before.
const registerAuthRoutes = ({
  app,
  loginThrottle,
  teamService = null,
  agentAdmin = null,
}) => {
  const SETUP_PASSWORD = String(process.env.SETUP_PASSWORD || "").trim();
  const kAuthMisconfigured = !SETUP_PASSWORD;
  const kSessionTtlMs = 7 * 24 * 60 * 60 * 1000;

  const signSessionPayload = (payload) =>
    crypto
      .createHmac("sha256", SETUP_PASSWORD)
      .update(payload)
      .digest("base64url");

  // sub/opsv are optional operator-identity claims (team mode). Legacy
  // cookies without them stay valid as anonymous sessions.
  const createSessionToken = ({ operatorId = "", operatorsVersion = null } = {}) => {
    const now = Date.now();
    const payload = Buffer.from(
      JSON.stringify({
        iat: now,
        exp: now + kSessionTtlMs,
        nonce: crypto.randomBytes(16).toString("hex"),
        ...(operatorId
          ? { sub: operatorId, opsv: Number(operatorsVersion) || 1 }
          : {}),
      }),
    ).toString("base64url");
    const signature = signSessionPayload(payload);
    return `${payload}.${signature}`;
  };

  // Returns the parsed session claims for a valid unexpired token, or null.
  // Tolerates missing sub/opsv: only signature + exp are required.
  const getSessionClaims = (token) => {
    if (!SETUP_PASSWORD || !token || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [payload, signature] = parts;
    if (!payload || !signature) return null;
    const expectedSignature = signSessionPayload(payload);
    const expectedBuffer = Buffer.from(expectedSignature);
    const signatureBuffer = Buffer.from(signature);
    if (expectedBuffer.length !== signatureBuffer.length) return null;
    if (!crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) return null;
    try {
      const parsed = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      );
      if (!Number.isFinite(parsed?.exp) || parsed.exp <= Date.now()) return null;
      return parsed;
    } catch {
      return null;
    }
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

  app.post("/api/auth/login", (req, res) => {
    if (kAuthMisconfigured) {
      return res.status(503).json({
        ok: false,
        error:
          "Server misconfigured: SETUP_PASSWORD is missing. Set it in your deployment environment variables and restart.",
      });
    }
    const now = Date.now();
    const clientKey = loginThrottle.getClientKey(req);
    const state = loginThrottle.getOrCreateLoginAttemptState(clientKey, now);
    const throttle = loginThrottle.evaluateLoginThrottle(state, now);
    if (throttle.blocked) {
      res.set("Retry-After", String(throttle.retryAfterSec));
      return res.status(429).json({
        ok: false,
        error: "Too many attempts. Try again shortly.",
        retryAfterSec: throttle.retryAfterSec,
      });
    }
    const requestedOperatorId = String(req.body?.operatorId || "").trim();
    if (req.body.password !== SETUP_PASSWORD) {
      const failure = loginThrottle.recordLoginFailure(state, now);
      if (failure.locked) {
        const retryAfterSec = Math.max(1, Math.ceil(failure.lockMs / 1000));
        res.set("Retry-After", String(retryAfterSec));
        return res.status(429).json({
          ok: false,
          error: "Too many attempts. Try again shortly.",
          retryAfterSec,
        });
      }
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }
    loginThrottle.recordLoginSuccess(clientKey);
    // Operator selection is best-effort identity, not authentication: the
    // shared password is the only credential. Unknown/disabled operator ids
    // simply produce an anonymous session.
    let sessionClaims = {};
    if (requestedOperatorId && teamService?.isTeamEnabled?.()) {
      const operator = teamService.getOperator(requestedOperatorId);
      if (operator) {
        sessionClaims = {
          operatorId: operator.id,
          operatorsVersion: teamService.getOperatorsVersion(),
        };
      }
    }
    const token = createSessionToken(sessionClaims);
    res.cookie("setup_token", token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: kSessionTtlMs,
    });
    res.json({
      ok: true,
      ...(sessionClaims.operatorId ? { operatorId: sessionClaims.operatorId } : {}),
    });
  });

  // Unauthenticated on purpose: the login page needs the operator picker
  // before any session exists. Names only — never emails/avatars.
  app.get("/api/team/login-info", (req, res) => {
    if (!teamService) {
      return res.json({ teamEnabled: false, operators: [] });
    }
    res.json(teamService.getLoginInfo());
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
  // agent-admin flag is on AND a token file exists.
  const isValidAgentBearer = (req) => {
    if (!agentAdmin?.isEnabled?.()) return false;
    const bearer = extractBearerToken(req);
    if (!bearer) return false;
    const stored = agentAdmin.readToken?.();
    if (!stored) return false;
    return timingSafeTokenEqual(bearer, stored);
  };

  // allowBearer is OPT-IN PER CALL SITE (A16): WebSocket upgrades and the
  // manual /api/chat/history check call this with the default false, so the
  // agent token can never open the watchdog terminal or chat WS — upgrades
  // bypass Express middleware and would see no tier enforcement.
  const isAuthorizedRequest = (req, { allowBearer = false } = {}) => {
    if (kAuthMisconfigured) return false;
    const requestPath = req.path || "";
    if (requestPath.startsWith("/auth/google/callback")) return true;
    if (requestPath.startsWith("/auth/codex/callback")) return true;
    const cookies = cookieParser(req);
    const token = cookies.setup_token;
    if (verifySessionToken(token)) return true;
    return allowBearer && isValidAgentBearer(req);
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
    if (req.path.startsWith("/auth/google/callback")) return next();
    if (req.path.startsWith("/auth/codex/callback")) return next();
    if (isAuthorizedRequest(req)) return next();
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

  app.get("/api/auth/status", (req, res) => {
    res.json({ authEnabled: !!SETUP_PASSWORD });
  });

  app.post("/api/auth/logout", (req, res) => {
    res.clearCookie("setup_token", { path: "/" });
    res.json({ ok: true });
  });

  app.use("/setup", requireAuth);
  app.use("/api", requireAuth);
  app.use("/auth", requireAuth);

  // Resolves the request's operator identity, or null for anonymous sessions
  // (legacy cookies, removed operators, stale opsv, or team mode off). Never
  // affects authorization — that stays cookie-signature based.
  const resolveRequestOperator = (req) => {
    if (kAuthMisconfigured || !teamService?.isTeamEnabled?.()) return null;
    const cookies = cookieParser(req);
    const claims = getSessionClaims(cookies.setup_token);
    if (!claims) return null;
    return teamService.resolveOperatorForSession(claims);
  };

  // Actor identity for the enforcement/redaction layer: {type:"agent"} for
  // bearer-authed requests, null for cookie sessions (humans stay untouched).
  const resolveRequestActor = (req) => req?.alphaclawActor || null;

  return {
    requireAuth,
    isAuthorizedRequest,
    resolveRequestOperator,
    resolveRequestActor,
  };
};

module.exports = { registerAuthRoutes };
