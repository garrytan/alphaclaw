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
  let throttle;
  let app;

  const buildApp = () => {
    const { registerAuthRoutes } = loadAuthRoutes();
    const built = express();
    built.use(express.json());
    throttle = createLoginThrottleMock();
    registerAuthRoutes({
      app: built,
      loginThrottle: throttle,
      membersStore,
      readTeamSettings: () => teamSettings,
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
});
