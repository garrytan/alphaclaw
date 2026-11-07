const crypto = require("crypto");
const fs = require("fs");
const { writeFileAtomic } = require("../utils/safe-file");
const { kLoginCleanupIntervalMs } = require("../constants");
const { wrapAsync } = require("../utils/wrap-async");
const { timingSafeStringEqual } = require("../utils/timing-safe");
const { readEnforcementGrant } = require("../agent-admin/grant");
const { sendApiRouteMiss } = require("../api-route-miss");
const { rosterReconciliationDeferredFields } = require("../team-service");
const {
  classifyControlUiAuthResponse,
  kControlUiBasePath,
} = require("../control-ui-mount");
const { kControlUiAttachCookie } = require("../control-ui-attach");
const {
  classifyBrowserOrigin,
  kOriginMismatchBody,
  logOriginRefusal,
} = require("../origin-guard");
const { kAgentTokenPattern } = require("../agent-admin/token-store");
const { logSignInAttempt } = require("../utils/sign-in-audit");
const { loginLimiterKey } = require("../login-client-ip");

// Owner lanes past the box-wide sign-in bucket (GST-1788). A known-browser
// pass is a signed cookie set at every successful sign-in; it lets that
// browser's later sign-ins as the same owner or member skip the shared and
// per-IP buckets for a bucket of its own. The recovery code comes from the
// deployment environment only (deployment-only-env.js) and does the same for
// a new device. Neither replaces the password.
const kDevicePassCookie = "alphaclaw_device";
const kDevicePassPath = "/api/auth";
const kDevicePassTtlMs = 90 * 24 * 60 * 60 * 1000;
const kDevicePassPattern =
  /^v1\.([A-Za-z0-9_-]{1,200})\.([0-9a-f]{32})\.(\d{1,16})\.([A-Za-z0-9_-]{43})$/;
const kRecoveryCodeEnvKey = "ALPHACLAW_LOGIN_RECOVERY_CODE";
const kMinRecoveryCodeLength = 32;
const kMinRecoveryCodeDistinctChars = 12;
const kRecoveryCodeLane = "recovery";

// True when the code is one shorter unit repeated ("abcd…abcd…").
const isRepeatedUnit = (code) => {
  for (let unit = 1; unit <= code.length / 2; unit += 1) {
    if (code.length % unit === 0 && code === code.slice(0, unit).repeat(code.length / unit)) return true;
  }
  return false;
};

const readRecoveryCode = () => {
  const configured = String(process.env[kRecoveryCodeEnvKey] || "").trim();
  if (!configured) return "";
  if (
    configured.length >= kMinRecoveryCodeLength &&
    new Set(configured).size >= kMinRecoveryCodeDistinctChars &&
    !isRepeatedUnit(configured)
  ) {
    return configured;
  }
  console.warn(
    `[auth] ${kRecoveryCodeEnvKey} is ignored because it is too short or too repetitive to be a recovery code. Set at least 32 random characters, e.g. openssl rand -hex 32, then redeploy.`,
  );
  return "";
};

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
  // Called once a logout has ended sessions: { kind: "legacy" } ended every
  // owner session, { kind: "member", memberId } that member's. Sockets are
  // authorized only at upgrade, so their servers close them on this.
  onLogout = () => {},
  agentAdmin = null,
  // { code, message } while the disk is full (disk-full.js), for the login page.
  readDiskFullNotice = () => null,
  // Where the legacy session secret and epoch live (0600). Absent ⇒ an
  // in-memory secret: sessions end with the process.
  legacySessionStatePath = null,
  // The canonical public origin (resolveSetupUrl) for the same-origin check
  // on cookie-authenticated /api writes (origin-guard.js).
  getTrustedBrowserOrigin = () => "",
}) => {
  const SETUP_PASSWORD = String(process.env.SETUP_PASSWORD || "").trim();
  const kAuthMisconfigured = !SETUP_PASSWORD;
  const kRecoveryCode = readRecoveryCode();
  const kSessionTtlMs = 7 * 24 * 60 * 60 * 1000;

  const signWithSecret = (secret, payload) =>
    crypto.createHmac("sha256", secret).update(payload).digest("base64url");

  // Legacy owner sessions (CSO ALPH-71 L-2) are signed with a key derived
  // from a random secret kept in AlphaClaw's state, never with SETUP_PASSWORD
  // alone, so a stolen cookie is no offline oracle for the password. The key
  // also binds a session epoch that logout bumps, and SETUP_PASSWORD itself, so
  // logout and a password change both end every legacy session. Cookies signed
  // before this change stop working once.
  const isLegacySessionState = (value) =>
    /^[0-9a-f]{64}$/.test(String(value?.secret || "")) && Number.isSafeInteger(value?.epoch) && value.epoch >= 0;
  // Returns the error code when the state could not be saved, else null.
  const persistLegacySessionState = (state) => {
    if (!legacySessionStatePath) return null;
    try {
      writeFileAtomic(legacySessionStatePath, JSON.stringify(state), { mode: 0o600 });
      return null;
    } catch (error) {
      return error?.code || "error";
    }
  };
  const legacySessionState = (() => {
    if (legacySessionStatePath) {
      try {
        const stored = JSON.parse(fs.readFileSync(legacySessionStatePath, "utf8"));
        if (isLegacySessionState(stored)) return stored;
      } catch {}
    }
    const fresh = { secret: crypto.randomBytes(32).toString("hex"), epoch: 0 };
    const saveError = persistLegacySessionState(fresh);
    if (saveError) {
      console.warn(`[alphaclaw] Could not save the session state (${saveError}); sessions end when AlphaClaw restarts.`);
    }
    return fresh;
  })();
  const deriveLegacySessionKey = () =>
    signWithSecret(legacySessionState.secret, `alphaclaw-legacy-session|${legacySessionState.epoch}|${SETUP_PASSWORD}`);
  let legacySessionKey = deriveLegacySessionKey();
  // The bump holds in memory even when the save fails; the error code is
  // returned so logout can say the stored epoch is still the old one.
  const endLegacySessions = () => {
    legacySessionState.epoch += 1;
    legacySessionKey = deriveLegacySessionKey();
    return persistLegacySessionState(legacySessionState);
  };

  const signSessionPayload = (payload) =>
    signWithSecret(legacySessionKey, payload);

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

  // Known-browser pass: `v1.<subject>.<device id>.<issued at>.<mac>`. An owner
  // pass is keyed like owner sessions (state secret, epoch, SETUP_PASSWORD),
  // so logout and a password change revoke every one; a member pass is keyed
  // on that member's token secret, which their logout rotates and removal
  // deletes.
  const devicePassKey = (subject) => {
    if (subject === "owner") {
      return signWithSecret(
        legacySessionState.secret,
        `alphaclaw-device-pass|${legacySessionState.epoch}|${SETUP_PASSWORD}`,
      );
    }
    if (!String(subject || "").startsWith("member:")) return null;
    const secret = membersStore?.getTokenSecret?.(subject.slice("member:".length));
    return secret ? signWithSecret(secret, "alphaclaw-device-pass") : null;
  };

  const setDevicePass = (req, res, subject) => {
    const key = devicePassKey(subject);
    if (!key) return;
    const body = `v1.${Buffer.from(subject).toString("base64url")}.${crypto.randomBytes(16).toString("hex")}.${Date.now()}`;
    res.cookie(kDevicePassCookie, `${body}.${signWithSecret(key, body)}`, {
      httpOnly: true,
      sameSite: "strict",
      path: kDevicePassPath,
      maxAge: kDevicePassTtlMs,
      secure: req?.secure === true,
    });
  };

  // The device id of a valid, unexpired pass issued to exactly this subject,
  // else null. Nothing is stored before the MAC checks out.
  const readDevicePass = (req, subject) => {
    if (!subject) return null;
    const match = String(cookieParser(req)[kDevicePassCookie] || "").match(kDevicePassPattern);
    if (!match) return null;
    const [value, encodedSubject, deviceId, issuedAt, mac] = match;
    if (encodedSubject !== Buffer.from(subject).toString("base64url")) return null;
    const age = Date.now() - Number(issuedAt);
    if (!(age >= -60_000 && age < kDevicePassTtlMs)) return null;
    const key = devicePassKey(subject);
    if (!key) return null;
    const expected = signWithSecret(key, value.slice(0, value.lastIndexOf(".")));
    return timingSafeStringEqual(expected, mac) ? deviceId : null;
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
    // The OAuth callbacks are exempted by requireAuth on the EXACT pathname
    // (below); the prefix exemption that used to live here was dead for the
    // /api and WS paths this helper serves and let "/auth/google/callback-x"
    // shapes through — removed (fix wave F062).
    if (resolveRequestIdentity(req) !== null) return true;
    return allowBearer && isValidAgentBearer(req);
  };

  const isAdminRequest = (req) =>
    resolveRequestIdentity(req)?.role === "admin";

  const setSessionCookie = (req, res, token) => {
    res.cookie("setup_token", token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: kSessionTtlMs,
      // Express derives req.secure from X-Forwarded-Proto ONLY under the
      // configured `trust proxy` hops (lib/server.js), never from the raw
      // header — a TLS-terminating proxy gets a Secure cookie, a plain-HTTP
      // LAN install keeps a cookie the browser will actually send (F063).
      secure: req?.secure === true,
    });
  };

  const sendTooManyAttempts = (res, retryAfterSec) => {
    res.set("Retry-After", String(retryAfterSec));
    res.status(429).json({
      ok: false,
      error: "Too many attempts. Try again shortly.",
      retryAfterSec,
    });
  };

  // Picks the bucket that counts this attempt. Callers answer every policy
  // refusal first. A valid pass for this subject uses its own bucket, unless
  // that bucket is locked and a code was sent: then the code decides. A
  // blocked address, or a locked recovery bucket, gets 429 before the code is
  // compared. A wrong code gets the 401 a right code with a wrong password
  // gets and counts against its address, never the recovery bucket, which
  // junk codes could otherwise lock for the owner. On a member sign-in it
  // also pays a decoy password hash while the box-wide bucket is open, and
  // that hash counts against the box-wide bucket, so junk codes from rotating
  // addresses stop buying hashes at the box-wide limit. A right code moves the
  // attempt to the recovery bucket. Everything else uses the per-IP bucket and
  // the box-wide bucket. With hold, the attempt keeps its slot in the buckets
  // it will be counted in until recordFailure or recordSuccess, so a password
  // check that awaits cannot let concurrent attempts past the limits.
  const openSignInGate = async (req, res, { actor, subject = null, allowRecovery = false, hold = false }) => {
    const now = Date.now();
    const ip = loginThrottle.getClientKey(req);
    const refuse = (lane, retryAfterSec) => {
      logSignInAttempt({ req, ip, actor, outcome: "rate_limited", lane });
      sendTooManyAttempts(res, retryAfterSec);
      return null;
    };
    const open = (gate) => ({
      ...gate,
      now,
      ip,
      actor,
      release:
        (hold &&
          loginThrottle.holdAttempt?.(gate.laneKey ? { laneKey: gate.laneKey } : { clientKey: gate.clientKey }, now)) ||
        (() => {}),
    });
    const addressKey = loginLimiterKey(ip);
    // Any email takes the code path when a code is sent, known member or not,
    // so the answer never says whether the member exists (an unknown email
    // with the right code fails the password check like a wrong password).
    const presented = req.body?.recoveryCode;
    const codeSent = allowRecovery && typeof presented === "string" && presented.length > 0;
    const deviceId = readDevicePass(req, subject);
    if (deviceId) {
      const laneKey = `device:${deviceId}`;
      const lane = loginThrottle.evaluateLaneThrottle(laneKey, now);
      if (!lane.blocked) return open({ lane: "device", laneKey });
      if (!codeSent) return refuse("device", lane.retryAfterSec);
    }
    if (codeSent) {
      const address = loginThrottle.evaluateClientThrottle(addressKey, now);
      if (address.blocked) return refuse("recovery", address.retryAfterSec);
      const lane = loginThrottle.evaluateLaneThrottle(kRecoveryCodeLane, now);
      if (lane.blocked) return refuse("recovery", lane.retryAfterSec);
      if (kRecoveryCode && timingSafeStringEqual(presented, kRecoveryCode)) {
        return open({ lane: "recovery", laneKey: kRecoveryCodeLane });
      }
      const decoy = actor === "member" && !loginThrottle.evaluateGlobalThrottle(now).blocked;
      if (decoy) loginThrottle.recordGlobalFailure(now);
      const failure = loginThrottle.recordClientFailure(addressKey, now);
      if (decoy) await membersStore?.burnDecoyVerification?.(String(req.body?.password || ""));
      if (failure.locked) return refuse("recovery", Math.max(1, Math.ceil(failure.lockMs / 1000)));
      logSignInAttempt({ req, ip, actor, outcome: "failed", lane: "recovery" });
      res.status(401).json({ ok: false, error: "Invalid credentials" });
      return null;
    }
    const state = loginThrottle.getOrCreateLoginAttemptState(addressKey, now);
    const throttle = loginThrottle.evaluateLoginThrottle(state, now);
    if (throttle.blocked) return refuse("shared", throttle.retryAfterSec);
    return open({ lane: "shared", clientKey: addressKey, state });
  };

  const countFailure = (gate) => {
    gate.release();
    return gate.lane === "shared"
      ? loginThrottle.recordLoginFailure(gate.state, gate.now)
      : loginThrottle.recordLaneFailure(gate.laneKey, gate.now);
  };

  const recordFailure = (req, res, gate) => {
    const failure = countFailure(gate);
    const { ip, actor, lane } = gate;
    if (failure.locked) {
      logSignInAttempt({ req, ip, actor, outcome: "rate_limited", lane });
      sendTooManyAttempts(res, Math.max(1, Math.ceil(failure.lockMs / 1000)));
      return;
    }
    logSignInAttempt({ req, ip, actor, outcome: "failed", lane });
    res.status(401).json({ ok: false, error: "Invalid credentials" });
  };

  const recordSuccess = (req, gate) => {
    gate.release();
    if (gate.lane === "shared") loginThrottle.recordLoginSuccess(gate.clientKey);
    else loginThrottle.recordLaneSuccess(gate.laneKey);
    logSignInAttempt({ req, ip: gate.ip, actor: gate.actor, outcome: "ok", lane: gate.lane });
  };


  const lookUpMemberSubject = (email) => {
    try {
      const member = membersStore?.getMemberByEmail?.(email);
      return member?.id ? `member:${member.id}` : null;
    } catch {
      return null;
    }
  };

  // Team settings at the auth boundary fail CLOSED (fix wave F049): a read
  // that throws, or a reader that reports `configUnreadable` (alphaclaw.json
  // exists but does not parse), grants NOTHING — no shared-password login, no
  // legacy cookie, no member session — instead of silently merging onto
  // defaults (which re-enabled legacy login and locked members out). The
  // documented emergency hatch ALPHACLAW_ALLOW_LEGACY_LOGIN=1 stays the way
  // back in. Logged once per transition so the incident is visible.
  const legacyHatchOpen = () => process.env.ALPHACLAW_ALLOW_LEGACY_LOGIN === "1";
  let teamSettingsUnreadableLogged = false;
  const readTeamSettingsSafe = () => {
    let settings = null;
    let unreadable = false;
    try {
      settings = readTeamSettings() || null;
      unreadable = settings?.configUnreadable === true;
    } catch (error) {
      unreadable = true;
      settings = null;
    }
    if (unreadable && !teamSettingsUnreadableLogged) {
      teamSettingsUnreadableLogged = true;
      console.warn(
        "[auth] alphaclaw.json is unreadable — failing closed: shared-password login and legacy sessions are refused until the file is fixed (ALPHACLAW_ALLOW_LEGACY_LOGIN=1 is the emergency hatch)",
      );
    } else if (!unreadable) {
      teamSettingsUnreadableLogged = false;
    }
    return { settings, unreadable };
  };

  const legacyLoginDisabled = () => {
    if (legacyHatchOpen()) return false;
    const { settings, unreadable } = readTeamSettingsSafe();
    if (unreadable) return true;
    return settings?.disableLegacyLogin === true;
  };

  const teamModeEnabled = () => {
    const { settings, unreadable } = readTeamSettingsSafe();
    if (unreadable) return false;
    return settings?.enabled === true;
  };

  const kConfigUnreadableLoginCopy =
    "AlphaClaw cannot read alphaclaw.json, so sign-in is refused until the file is fixed or restored. Set ALPHACLAW_ALLOW_LEGACY_LOGIN=1 on the server for emergency shared-password access.";

  app.post("/api/auth/login", wrapAsync(async (req, res) => {
    if (kAuthMisconfigured) {
      return res.status(503).json({
        ok: false,
        error:
          "Server misconfigured: SETUP_PASSWORD is missing. Set it in your deployment environment variables and restart.",
      });
    }
    if (!legacyHatchOpen() && readTeamSettingsSafe().unreadable) {
      return res.status(503).json({
        ok: false,
        code: "config_unreadable",
        error: kConfigUnreadableLoginCopy,
      });
    }
    const email = String(req.body?.email || "").trim();
    const actor = email ? "member" : "owner";
    // Policy refusals come before any throttle or recovery-code work, so their
    // answer and cost are the same whatever code was sent, and neither is
    // counted against the throttle. Member login is only valid while team
    // mode is on (F3): with team off the gateway is back in single-user auth,
    // where a member session would escalate to full gateway control. The
    // shared-password lockdown is the other policy answer.
    const refusal = email
      ? !teamModeEnabled() && {
          code: "team_disabled",
          error: "Team access is turned off on this AlphaClaw. Sign in with the shared password.",
        }
      : legacyLoginDisabled() && {
          code: "legacy_login_disabled",
          error:
            "Shared-password login is disabled for this install. Sign in with your member email, or set ALPHACLAW_ALLOW_LEGACY_LOGIN=1 on the server for emergency access.",
        };
    if (refusal) {
      logSignInAttempt({ req, ip: loginThrottle.getClientKey(req), actor, outcome: "refused", lane: "shared" });
      return res.status(403).json({ ok: false, ...refusal });
    }
    const gate = await openSignInGate(req, res, {
      actor,
      subject: email ? lookUpMemberSubject(email) : "owner",
      allowRecovery: true,
      hold: true,
    });
    if (!gate) return;

    if (email) {
      const member = await membersStore?.verifyMemberPasswordAsync?.({
        email,
        password: String(req.body?.password || ""),
      });
      if (!member) return recordFailure(req, res, gate);
      const token = createMemberSessionToken(member.id);
      if (!token) return recordFailure(req, res, gate);
      recordSuccess(req, gate);
      setSessionCookie(req, res, token);
      setDevicePass(req, res, `member:${member.id}`);
      return res.json({
        ok: true,
        member: {
          email: member.email,
          displayName: member.displayName,
          role: member.role,
        },
      });
    }

    // Legacy shared-password login. Constant-time compare (F060). Only a STRING body password can match:
    // String(["owner-secret"]) would coerce to the secret itself (the array
    // class PR #45 closed elsewhere), and a non-string is a plain 401, never
    // a 500.
    const submittedPassword = req.body?.password;
    if (
      typeof submittedPassword !== "string" ||
      !timingSafeStringEqual(submittedPassword, SETUP_PASSWORD)
    ) {
      return recordFailure(req, res, gate);
    }
    recordSuccess(req, gate);
    setSessionCookie(req, res, createSessionToken());
    setDevicePass(req, res, "owner");
    res.json({ ok: true });
  }));

  // Invite acceptance is PRE-AUTH by necessity (the invitee has no session
  // yet) — registered before the requireAuth mounts below, throttled like
  // login. The invite token is single-use via the store's atomic consume.
  app.post("/api/auth/accept-invite", wrapAsync(async (req, res) => {
    if (kAuthMisconfigured) {
      return res.status(503).json({ ok: false, error: "Auth not configured" });
    }
    if (!membersStore || !teamModeEnabled()) {
      return res
        .status(409)
        .json({ ok: false, code: "team_disabled", error: "Team access is not enabled" });
    }
    const gate = await openSignInGate(req, res, { actor: "invitee" });
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
      countFailure(gate);
      logSignInAttempt({ req, ip: gate.ip, actor: gate.actor, outcome: "failed", lane: gate.lane });
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
    recordSuccess(req, gate);
    // Reconcile the gateway roster NOW (E-C8) — the response does not wait on
    // failure (the next admin mutation re-reconciles), but success must not
    // depend on someone else touching the roster.
    let rosterOutcome = {};
    try {
      await onMemberRosterChanged({ reason: "invite_accepted", member });
    } catch (err) {
      rosterOutcome = rosterReconciliationDeferredFields(err);
      console.error(
        `[team] gateway reconcile after invite accept failed: ${err?.message}`,
      );
    }
    const sessionToken = createMemberSessionToken(member.id);
    if (sessionToken) {
      setSessionCookie(req, res, sessionToken);
      setDevicePass(req, res, `member:${member.id}`);
    }
    res.json({
      ok: true,
      ...rosterOutcome,
      member: {
        email: member.email,
        displayName: member.displayName,
        role: member.role,
      },
    });
  }));

  setInterval(() => {
    loginThrottle.cleanupLoginAttemptStates();
  }, kLoginCleanupIntervalMs).unref();

  const extractBearerToken = (req) => {
    const header = req?.headers?.authorization;
    if (typeof header !== "string") return null;
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
  };

  // Pure validity check, no throttle bookkeeping. Only meaningful while the
  // agent-admin flag is on AND a token file exists. Fed into isAuthorizedRequest's
  // opt-in bearer fallback below.
  const isValidAgentBearer = (req) => {
    if (!agentAdmin?.isEnabled?.()) return false;
    const bearer = extractBearerToken(req);
    if (!bearer) return false;
    const stored = agentAdmin.readToken?.();
    if (!stored) return false;
    return timingSafeStringEqual(bearer, stored);
  };

  const kUnauthorizedBearer = Object.freeze({
    ok: false,
    status: 401,
    body: Object.freeze({
      ok: false,
      error: "Unauthorized",
      code: "unauthorized",
      hint: "Bearer token invalid — it may have been rotated; re-read the token file.",
    }),
  });

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
    // A bearer that cannot be an agent token (another service's key, a
    // scanner's guess) is refused without counting: only token-shaped
    // guesses use up the agent's attempts (ALPH-71 L-3).
    if (!kAgentTokenPattern.test(bearer)) return kUnauthorizedBearer;
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
    if (timingSafeStringEqual(bearer, stored)) {
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
    return kUnauthorizedBearer;
  };

  // Cookie sessions only: a bearer request never carries the browser's
  // ambient credential, so it cannot be forged cross-site. Reads stay open;
  // a missing Origin is a non-browser client (classifyBrowserOrigin).
  const kSafeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
  const refuseCrossOriginWrite = (req, res, identity) => {
    // Express routes /API/... to the same handlers, so compare in lower case.
    if (!String(req.originalUrl || "").toLowerCase().startsWith("/api/")) return false;
    if (kSafeMethods.has(String(req.method || "GET").toUpperCase())) return false;
    const verdict = classifyBrowserOrigin({
      headers: req.headers,
      trustedOrigin: getTrustedBrowserOrigin(),
    });
    if (verdict !== "cross") return false;
    logOriginRefusal({
      surface: "http",
      method: req.method,
      path: String(req.originalUrl || "").split("?")[0],
      headers: req.headers,
      actor: identity.kind === "member" ? "member" : "human",
    });
    res.status(403).json(kOriginMismatchBody);
    return true;
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
      if (refuseCrossOriginWrite(req, res, identity)) return undefined;
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
    // Control UI resources (fonts, chunks, themes, sw.js, bootstrap config)
    // never get the HTML login redirect: the browser refuses text/html as a
    // stylesheet ("Styles failed to load"), and a Control UI service worker
    // from an older pin cached any `ok` response under the asset URL — a
    // redirected 200 login page would be served for that asset forever
    // (2026.10.2's worker no longer caches redirects or HTML; a 401 is safe
    // under every worker version — see control-ui-mount.js).
    // Documents keep the redirect (a stale tab still lands on the login page)
    // and so does HEAD (the UI's stale-chunk recovery probe). The rule table
    // lives in control-ui-mount.js.
    if (
      classifyControlUiAuthResponse({
        method: req.method,
        path: requestPathname,
        headers: req.headers,
      }) === "unauthorized"
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.redirect("/login.html");
  };

  // 4.6: runs after requireAuth on every /api request. Admin and legacy
  // identities pass untouched; members are default-deny outside the allowlist.
  // A member refused outside the allowlist learns whether the route exists:
  // an unknown path is 404 (405 for a routed path under another method), a
  // real route is 403. Members are authenticated; requireAuth already gave
  // every unauthenticated caller the same 401.
  const denyMember = (req, res) => {
    if (sendApiRouteMiss(req, res)) return undefined;
    return res.status(403).json({
      error: "Admin access required",
      code: "admin_required",
    });
  };

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
        return denyMember(req, res);
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
    return denyMember(req, res);
  };

  // Human sessions pass on role exactly as before. The agent actor never has a
  // role; it passes ONLY with an enforcement grant — the frozen, Symbol-keyed
  // record the agent-admin enforcement layer attaches after the manifest tier
  // and confirm gate passed for this exact method/path/query/body (F067). A
  // handler mounted without enforcement in front, a forged plain property, or a
  // body rewritten after the grant all fail closed with 403.
  const requireAdmin = (req, res, next) => {
    const identity = req.alphaclawIdentity || resolveRequestIdentity(req);
    if (identity?.role === "admin") return next();
    if (req.alphaclawActor?.type === "agent" && readEnforcementGrant(req)) return next();
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
    let notice = null;
    try {
      notice = readDiskFullNotice();
    } catch {}
    res.json({
      authEnabled: !!SETUP_PASSWORD,
      team: {
        ...team,
        legacyLoginDisabled: legacyLoginDisabled(),
      },
      notice,
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

  // Logout ends the session server-side, not only in this browser: a legacy
  // session bumps the epoch (every owner session on every device ends), a
  // member session rotates that member's token secret, and onLogout closes
  // the terminal and chat sockets the ended sessions opened. An unauthenticated
  // call changes nothing but this browser's cookies. When the new epoch cannot
  // be saved, the sessions end in this process but the stored epoch is the
  // old one, so after a restart they would work again; when a member's
  // secret cannot be rotated, that member's other sessions keep working.
  // Either way the cookie is still cleared and the caller gets a 500 that
  // says so. Logout is registered
  // before requireAuth, so it runs the same origin check itself: another
  // origin cannot log the owner out.
  app.post("/api/auth/logout", (req, res) => {
    if (refuseCrossOriginWrite(req, res, resolveRequestIdentity(req) || {})) return undefined;
    const token = cookieParser(req).setup_token;
    let saveError = null;
    let ended = null;
    if (typeof token === "string" && token.startsWith("v2.")) {
      const member = verifyMemberSessionToken(token);
      if (member) {
        try {
          membersStore?.rotateTokenSecret?.(member.id);
        } catch (error) {
          saveError = error?.code || error?.message || "rotate_failed";
        }
        ended = { kind: "member", memberId: member.id };
      }
    } else if (getSessionClaims(token)) {
      saveError = endLegacySessions();
      ended = { kind: "legacy" };
    }
    if (ended) {
      try {
        onLogout(ended);
      } catch (error) {
        console.warn(`[alphaclaw] Logout could not close open sockets: ${error.message}`);
      }
    }
    res.clearCookie("setup_token", { path: "/" });
    res.clearCookie(kControlUiAttachCookie, { path: kControlUiBasePath });
    res.clearCookie(kDevicePassCookie, { path: kDevicePassPath });
    if (saveError && ended?.kind === "member") {
      console.warn(
        `[alphaclaw] Logout could not rotate the member's session secret (${saveError}): this member's sessions on other devices still work.`,
      );
      return res.status(500).json({ ok: false, error: "logout could not be saved; your other sessions may still be signed in" });
    }
    if (saveError) {
      console.warn(
        `[alphaclaw] Logout could not save the session epoch (${saveError}): owner sessions on other devices are ended only until AlphaClaw restarts, and may work again after a restart.`,
      );
      return res.status(500).json({ ok: false, error: "logout could not be saved; other sessions may survive a restart" });
    }
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
