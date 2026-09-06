const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const {
  initAuthDb,
  closeAuthDb,
  getAuthDb,
} = require("../../lib/server/db/auth");
const { createMembersStore } = require("../../lib/server/db/auth/members");

const loadAuthRoutes = () => {
  vi.resetModules();
  const modulePath = require.resolve("../../lib/server/routes/auth");
  delete require.cache[modulePath];
  return require(modulePath);
};

const createLoginThrottleMock = () => ({
  getClientKey: vi.fn(() => "client-key"),
  getOrCreateLoginAttemptState: vi.fn(() => ({ attempts: 0 })),
  evaluateLoginThrottle: vi.fn(() => ({ blocked: false, retryAfterSec: 0 })),
  recordLoginFailure: vi.fn(() => ({ lockMs: 0, locked: false })),
  recordLoginSuccess: vi.fn(),
  cleanupLoginAttemptStates: vi.fn(),
});

const cookieOf = (res) => {
  const header = res.headers["set-cookie"]?.[0] || "";
  return header.split(";")[0];
};

describe("server/routes/auth team mode (4.2/4.6)", () => {
  let rootDir;
  let membersStore;
  let teamSettings;
  let teamSettingsThrow;
  let throttle;
  let app;
  let authApi;
  let onMemberActivity;

  const buildApp = () => {
    const { registerAuthRoutes } = loadAuthRoutes();
    const built = express();
    built.use(express.json());
    throttle = createLoginThrottleMock();
    onMemberActivity = vi.fn();
    authApi = registerAuthRoutes({
      app: built,
      loginThrottle: throttle,
      membersStore,
      readTeamSettings: () => {
        if (teamSettingsThrow) throw new Error("settings unreadable");
        return teamSettings;
      },
      onMemberActivity,
    });
    // Representative surfaces for the 4.6 matrix.
    built.get("/api/status", (req, res) =>
      res.json({ ok: true, role: req.alphaclawIdentity?.role || null }),
    );
    built.get("/api/envars", (req, res) => res.json({ ok: true }));
    built.post("/api/openclaw/apply", (req, res) => res.json({ ok: true }));
    built.get("/api/usage/summary", (req, res) => res.json({ ok: true }));
    built.post("/api/cron/jobs", (req, res) => res.json({ ok: true }));
    return built;
  };

  beforeEach(() => {
    process.env.SETUP_PASSWORD = "owner-secret";
    delete process.env.ALPHACLAW_ALLOW_LEGACY_LOGIN;
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-auth-team-"));
    initAuthDb({ rootDir });
    membersStore = createMembersStore({ getDb: getAuthDb });
    teamSettings = { enabled: true, disableLegacyLogin: false };
    teamSettingsThrow = false;
    app = buildApp();
  });

  afterEach(() => {
    delete process.env.SETUP_PASSWORD;
    delete process.env.ALPHACLAW_ALLOW_LEGACY_LOGIN;
    closeAuthDb();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const createAdmin = () =>
    membersStore.createMember({
      email: "admin@example.com",
      displayName: "Admin",
      role: "admin",
      password: "admin password",
    });

  const loginMember = async (email, password) =>
    request(app).post("/api/auth/login").send({ email, password });

  it("logs a member in by email with a v2 token that authorizes /api", async () => {
    createAdmin();
    const member = membersStore.createMember({
      email: "member@example.com",
      displayName: "Member",
      password: "member password",
    });

    const login = await loginMember("Member@Example.com", "member password");
    expect(login.status).toBe(200);
    expect(login.body.member).toEqual({
      email: "member@example.com",
      displayName: "Member",
      role: "member",
    });
    const cookie = cookieOf(login);
    expect(cookie).toContain(`setup_token=v2.${member.id}.`);

    const status = await request(app).get("/api/status").set("Cookie", cookie);
    expect(status.status).toBe(200);
    expect(status.body.role).toBe("member");

    const identity = await request(app)
      .get("/api/auth/identity")
      .set("Cookie", cookie);
    expect(identity.body.identity).toEqual({
      kind: "member",
      role: "member",
      email: "member@example.com",
      displayName: "Member",
    });
  });

  it("exempts the exact OAuth callback pathnames from session auth (mount-prefix fix)", async () => {
    // Under app.use("/auth", requireAuth) Express strips the mount prefix
    // from req.path, so the old req.path check never matched and a cookie-less
    // browser was bounced to /login.html instead of completing the callback.
    app.get("/auth/google/callback", (req, res) => res.json({ reached: "google" }));
    app.get("/auth/google/callback-evil", (req, res) => res.json({ reached: "evil" }));
    app.get("/auth/codex/callback", (req, res) => res.json({ reached: "codex" }));

    const google = await request(app).get("/auth/google/callback?code=x&state=y");
    expect(google.status).toBe(200);
    expect(google.body).toEqual({ reached: "google" });

    const codex = await request(app).get("/auth/codex/callback?code=x&state=y");
    expect(codex.status).toBe(200);
    expect(codex.body).toEqual({ reached: "codex" });

    // Exact pathname compare: a prefix-shaped sibling must stay behind auth.
    const evil = await request(app).get("/auth/google/callback-evil");
    expect(evil.status).toBe(302);
    expect(evil.headers.location).toBe("/login.html");
  });

  it("rejects a wrong member password and records the failure", async () => {
    createAdmin();
    const res = await loginMember("admin@example.com", "wrong");
    expect(res.status).toBe(401);
    expect(throttle.recordLoginFailure).toHaveBeenCalledTimes(1);
  });

  it("accepts an invite PRE-AUTH, exactly once, and issues a session", async () => {
    const admin = createAdmin();
    const invite = membersStore.createInvite({
      role: "member",
      createdBy: admin.id,
    });

    // No cookie at all — the invitee has no session yet.
    const accept = await request(app).post("/api/auth/accept-invite").send({
      token: invite.token,
      email: "new@example.com",
      displayName: "New Member",
      password: "brand new password",
    });
    expect(accept.status).toBe(200);
    expect(accept.body.member.role).toBe("member");
    const cookie = cookieOf(accept);
    expect(cookie).toContain("setup_token=v2.");

    const status = await request(app).get("/api/status").set("Cookie", cookie);
    expect(status.status).toBe(200);

    // Single use: the same token cannot mint a second account.
    const again = await request(app).post("/api/auth/accept-invite").send({
      token: invite.token,
      email: "other@example.com",
      password: "another password",
    });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe("invite_invalid");
  });

  it("does not burn the invite when the email is already taken", async () => {
    const admin = createAdmin();
    const invite = membersStore.createInvite({ createdBy: admin.id });

    const taken = await request(app).post("/api/auth/accept-invite").send({
      token: invite.token,
      email: "admin@example.com",
      password: "whatever password",
    });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe("email_taken");

    // The invite is still consumable with a fresh email.
    const ok = await request(app).post("/api/auth/accept-invite").send({
      token: invite.token,
      email: "fresh@example.com",
      password: "whatever password",
    });
    expect(ok.status).toBe(200);
  });

  it("a pinned invite email is authoritative over the provided one", async () => {
    const admin = createAdmin();
    const invite = membersStore.createInvite({
      email: "pinned@example.com",
      createdBy: admin.id,
    });
    const accept = await request(app).post("/api/auth/accept-invite").send({
      token: invite.token,
      email: "attacker@example.com",
      password: "whatever password",
    });
    expect(accept.status).toBe(200);
    expect(accept.body.member.email).toBe("pinned@example.com");
    expect(membersStore.getMemberByEmail("attacker@example.com")).toBeNull();
  });

  it("blocks legacy shared-password login under lockdown, with break-glass env (C4/D11)", async () => {
    teamSettings = { enabled: true, disableLegacyLogin: true };
    app = buildApp();

    const blocked = await request(app)
      .post("/api/auth/login")
      .send({ password: "owner-secret" });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("legacy_login_disabled");
    expect(blocked.body.error).toContain("ALPHACLAW_ALLOW_LEGACY_LOGIN");
    // A policy rejection is not a credential failure.
    expect(throttle.recordLoginFailure).not.toHaveBeenCalled();

    // Member login still works under lockdown.
    createAdmin();
    const member = await loginMember("admin@example.com", "admin password");
    expect(member.status).toBe(200);

    process.env.ALPHACLAW_ALLOW_LEGACY_LOGIN = "1";
    const breakGlass = await request(app)
      .post("/api/auth/login")
      .send({ password: "owner-secret" });
    expect(breakGlass.status).toBe(200);
  });

  it("kills sessions when a member is disabled or their token secret rotates", async () => {
    createAdmin();
    const member = membersStore.createMember({
      email: "m@example.com",
      password: "member password",
    });
    const login = await loginMember("m@example.com", "member password");
    const cookie = cookieOf(login);
    expect(
      (await request(app).get("/api/status").set("Cookie", cookie)).status,
    ).toBe(200);

    membersStore.rotateTokenSecret(member.id);
    expect(
      (await request(app).get("/api/status").set("Cookie", cookie)).status,
    ).toBe(401);

    const relogin = await loginMember("m@example.com", "member password");
    const cookie2 = cookieOf(relogin);
    membersStore.updateMember({ memberId: member.id, disabled: true });
    expect(
      (await request(app).get("/api/status").set("Cookie", cookie2)).status,
    ).toBe(401);
  });

  it("enforces the member route matrix: reads allowed, everything else admin (4.6)", async () => {
    createAdmin();
    membersStore.createMember({
      email: "m@example.com",
      password: "member password",
    });
    const memberCookie = cookieOf(
      await loginMember("m@example.com", "member password"),
    );

    // Allowed reads.
    for (const url of ["/api/status", "/api/usage/summary"]) {
      const res = await request(app).get(url).set("Cookie", memberCookie);
      expect(res.status, url).toBe(200);
    }
    // Allowed write.
    const logout = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", memberCookie)
      .send({});
    expect(logout.status).toBe(200);

    // Denied: sensitive reads and every mutation.
    const deniedEnvars = await request(app)
      .get("/api/envars")
      .set("Cookie", memberCookie);
    expect(deniedEnvars.status).toBe(403);
    expect(deniedEnvars.body.code).toBe("admin_required");
    const deniedApply = await request(app)
      .post("/api/openclaw/apply")
      .set("Cookie", memberCookie)
      .send({});
    expect(deniedApply.status).toBe(403);
    const deniedCronWrite = await request(app)
      .post("/api/cron/jobs")
      .set("Cookie", memberCookie)
      .send({});
    expect(deniedCronWrite.status).toBe(403);
    // The Claude Code launcher fires billable autonomous sessions on the
    // owner's claude.ai account — members must be denied BOTH halves by the
    // default-deny matrix (the prefix is deliberately not in
    // kMemberApiReadPrefixes).
    const deniedLauncherStatus = await request(app)
      .get("/api/claude-code/status")
      .set("Cookie", memberCookie);
    expect(deniedLauncherStatus.status).toBe(403);
    const deniedLauncherFire = await request(app)
      .post("/api/claude-code/session")
      .set("Cookie", memberCookie)
      .send({ confirmed: true });
    expect(deniedLauncherFire.status).toBe(403);
  });

  it("denies members the credential-returning model endpoints even under the allowed prefix (F1)", async () => {
    createAdmin();
    membersStore.createMember({
      email: "m@example.com",
      password: "member password",
    });
    const memberCookie = cookieOf(
      await loginMember("m@example.com", "member password"),
    );
    // The two subpaths that return raw provider API keys / OAuth tokens —
    // including case variants, since Express matches routes case-insensitively.
    for (const url of [
      "/api/models/config",
      "/api/models/auth",
      "/api/models/Config",
      "/api/models/AUTH",
    ]) {
      const res = await request(app).get(url).set("Cookie", memberCookie);
      expect(res.status, url).toBe(403);
      expect(res.body.code).toBe("admin_required");
    }
  });

  it("makes a member session inert the moment team mode is turned off (F3)", async () => {
    createAdmin();
    membersStore.createMember({
      email: "m@example.com",
      password: "member password",
    });
    const memberCookie = cookieOf(
      await loginMember("m@example.com", "member password"),
    );
    // Works while team is on.
    expect(
      (await request(app).get("/api/status").set("Cookie", memberCookie)).status,
    ).toBe(200);

    // Admin disables team mode: the retained member's existing cookie dies
    // (401), and a fresh member login is refused (403) — no re-entry, no
    // silent escalation to the local-direct gateway caller.
    teamSettings = { enabled: false, disableLegacyLogin: false };
    const afterDisable = await request(app)
      .get("/api/status")
      .set("Cookie", memberCookie);
    expect(afterDisable.status).toBe(401);
    const reLogin = await loginMember("m@example.com", "member password");
    expect(reLogin.status).toBe(403);
    expect(reLogin.body.code).toBe("team_disabled");
  });

  it("kills EXISTING legacy sessions when shared-password login is locked down (F4)", async () => {
    const legacyCookie = cookieOf(
      await request(app)
        .post("/api/auth/login")
        .send({ password: "owner-secret" }),
    );
    expect(
      (await request(app).get("/api/status").set("Cookie", legacyCookie)).status,
    ).toBe(200);

    // Arm the lockdown: the already-issued legacy cookie must stop working,
    // not just new logins.
    teamSettings = { enabled: true, disableLegacyLogin: true };
    expect(
      (await request(app).get("/api/status").set("Cookie", legacyCookie)).status,
    ).toBe(401);

    // Break-glass env restores the existing session.
    process.env.ALPHACLAW_ALLOW_LEGACY_LOGIN = "1";
    expect(
      (await request(app).get("/api/status").set("Cookie", legacyCookie)).status,
    ).toBe(200);
  });

  it("legacy and member-admin sessions pass the matrix untouched (zero change for single-user)", async () => {
    // Legacy shared-password session = owner = admin.
    const legacy = await request(app)
      .post("/api/auth/login")
      .send({ password: "owner-secret" });
    const legacyCookie = cookieOf(legacy);
    for (const [method, url] of [
      ["get", "/api/envars"],
      ["post", "/api/openclaw/apply"],
    ]) {
      const res = await request(app)
        [method](url)
        .set("Cookie", legacyCookie)
        .send({});
      expect(res.status, url).toBe(200);
    }
    const identity = await request(app)
      .get("/api/auth/identity")
      .set("Cookie", legacyCookie);
    expect(identity.body.identity.kind).toBe("legacy");
    expect(identity.body.identity.role).toBe("admin");

    createAdmin();
    const adminCookie = cookieOf(
      await loginMember("admin@example.com", "admin password"),
    );
    const adminApply = await request(app)
      .post("/api/openclaw/apply")
      .set("Cookie", adminCookie)
      .send({});
    expect(adminApply.status).toBe(200);
  });

  it("a forged v2 token signed with another member's secret is rejected", async () => {
    createAdmin();
    const victim = membersStore.createMember({
      email: "victim@example.com",
      role: "admin",
      password: "victim password",
    });
    const attacker = membersStore.createMember({
      email: "attacker@example.com",
      password: "attacker password",
    });
    const attackerLogin = await loginMember(
      "attacker@example.com",
      "attacker password",
    );
    const attackerToken = cookieOf(attackerLogin).replace("setup_token=", "");
    // Splice the victim's member id into the attacker's token.
    const parts = attackerToken.split(".");
    parts[1] = victim.id;
    const forged = `setup_token=${parts.join(".")}`;
    const res = await request(app).get("/api/status").set("Cookie", forged);
    expect(res.status).toBe(401);
  });

  describe("resolveProxyIdentity (4.3 proxy-boundary identity)", () => {
    // Raw upgrade-style request: only a cookie header, no Express middleware.
    const rawRequest = (cookie) => ({ headers: { cookie } });

    it("resolves a member session from the raw cookie header and heartbeats presence", async () => {
      createAdmin();
      membersStore.createMember({
        email: "member@example.com",
        displayName: "Member",
        password: "member password",
      });
      const cookie = cookieOf(
        await loginMember("member@example.com", "member password"),
      );

      onMemberActivity.mockClear();
      const identity = authApi.resolveProxyIdentity(rawRequest(cookie));
      expect(identity).toEqual(
        expect.objectContaining({
          kind: "member",
          email: "member@example.com",
          role: "member",
        }),
      );
      // WS upgrades bypass requireAuth (and its heartbeat), so the resolver
      // itself must record presence for gateway-bound traffic.
      expect(onMemberActivity).toHaveBeenCalledTimes(1);
      expect(onMemberActivity).toHaveBeenCalledWith(
        expect.objectContaining({ email: "member@example.com" }),
      );

      // An identity already resolved by requireAuth is reused untouched.
      const preResolved = {
        kind: "member",
        memberId: "m1",
        email: "pre@example.com",
        role: "member",
      };
      expect(
        authApi.resolveProxyIdentity({
          alphaclawIdentity: preResolved,
          headers: {},
        }),
      ).toBe(preResolved);
    });

    it("returns null for a legacy shared-password session — the gateway sees the local-direct caller", async () => {
      const login = await request(app)
        .post("/api/auth/login")
        .send({ password: "owner-secret" });
      const cookie = cookieOf(login);
      // Sanity: the legacy session is fully authorized on the HTTP surface.
      expect(
        (await request(app).get("/api/status").set("Cookie", cookie)).status,
      ).toBe(200);

      onMemberActivity.mockClear();
      expect(authApi.resolveProxyIdentity(rawRequest(cookie))).toBeNull();
      // No member, no heartbeat.
      expect(onMemberActivity).not.toHaveBeenCalled();
    });

    it("returns null when team mode is off, even for a valid member session", async () => {
      createAdmin();
      const cookie = cookieOf(
        await loginMember("admin@example.com", "admin password"),
      );
      teamSettings = { enabled: false, disableLegacyLogin: false };
      expect(authApi.resolveProxyIdentity(rawRequest(cookie))).toBeNull();
    });

    it("returns null instead of throwing when the settings read fails", async () => {
      createAdmin();
      const cookie = cookieOf(
        await loginMember("admin@example.com", "admin password"),
      );
      teamSettingsThrow = true;
      expect(authApi.resolveProxyIdentity(rawRequest(cookie))).toBeNull();
    });

    it("returns null for anonymous requests and never throws on malformed input", () => {
      expect(authApi.resolveProxyIdentity(rawRequest(""))).toBeNull();
      expect(authApi.resolveProxyIdentity({ headers: {} })).toBeNull();
      expect(authApi.resolveProxyIdentity(undefined)).toBeNull();
    });
  });

  // Fix wave F049/F060/F061/F063 — auth hygiene.
  describe("fix-wave auth hygiene", () => {
    it("fails CLOSED when alphaclaw.json is unreadable: no shared-password login, no legacy cookie, no member session", async () => {
      createAdmin();
      const legacyCookie = cookieOf(
        await request(app).post("/api/auth/login").send({ password: "owner-secret" }),
      );
      const memberCookie = cookieOf(await loginMember("admin@example.com", "admin password"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      teamSettings = { enabled: true, disableLegacyLogin: false, configUnreadable: true };

      const legacyLogin = await request(app).post("/api/auth/login").send({ password: "owner-secret" });
      expect(legacyLogin.status).toBe(503);
      expect(legacyLogin.body.code).toBe("config_unreadable");
      const memberLogin = await loginMember("admin@example.com", "admin password");
      expect(memberLogin.status).toBe(503);
      expect((await request(app).get("/api/status").set("Cookie", legacyCookie)).status).toBe(401);
      expect((await request(app).get("/api/status").set("Cookie", memberCookie)).status).toBe(401);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("alphaclaw.json is unreadable"));
      expect(warn).toHaveBeenCalledTimes(1); // once per transition, not per request

      // Fixed file: everything comes back without a restart.
      teamSettings = { enabled: true, disableLegacyLogin: false };
      expect((await request(app).get("/api/status").set("Cookie", memberCookie)).status).toBe(200);
      expect((await request(app).get("/api/status").set("Cookie", legacyCookie)).status).toBe(200);
    });

    it("keeps the documented emergency hatch: ALPHACLAW_ALLOW_LEGACY_LOGIN=1 admits the shared password while the file is unreadable", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      teamSettings = { enabled: true, disableLegacyLogin: true, configUnreadable: true };
      process.env.ALPHACLAW_ALLOW_LEGACY_LOGIN = "1";
      const res = await request(app).post("/api/auth/login").send({ password: "owner-secret" });
      expect(res.status).toBe(200);
      expect(cookieOf(res)).toMatch(/^setup_token=/);
    });

    it("compares the shared password in constant time and answers 401 (not 500) to a non-string body", async () => {
      for (const password of [{ toString: () => "owner-secret" }, ["owner-secret"], 12345, null]) {
        const res = await request(app).post("/api/auth/login").send({ password });
        expect(res.status, JSON.stringify(password)).toBe(401);
      }
      expect((await request(app).post("/api/auth/login").send({ password: "owner-secret" })).status).toBe(200);
    });

    it("sets the Secure cookie flag only for a TLS request as seen through the configured trust-proxy hops", async () => {
      const plain = await request(app).post("/api/auth/login").send({ password: "owner-secret" });
      expect(plain.headers["set-cookie"][0]).not.toMatch(/;\s*Secure/i);
      // The raw header alone is NOT trusted…
      const spoofed = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-Proto", "https")
        .send({ password: "owner-secret" });
      expect(spoofed.headers["set-cookie"][0]).not.toMatch(/;\s*Secure/i);
      // …only under app-level trust proxy (lib/server.js sets kTrustProxyHops).
      app.set("trust proxy", 1);
      const proxied = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-Proto", "https")
        .send({ password: "owner-secret" });
      expect(proxied.headers["set-cookie"][0]).toMatch(/;\s*Secure/i);
    });

    it("no longer carries a prefix-based OAuth callback exemption in isAuthorizedRequest", () => {
      expect(
        authApi.isAuthorizedRequest({ path: "/auth/google/callback-evil", headers: {} }),
      ).toBe(false);
      expect(authApi.isAuthorizedRequest({ path: "/auth/google/callback", headers: {} })).toBe(false);
    });
  });
});
