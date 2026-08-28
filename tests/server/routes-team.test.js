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
const { registerAuthRoutes } = require("../../lib/server/routes/auth");
const { registerTeamRoutes } = require("../../lib/server/routes/team");
const { createTeamStateStore } = require("../../lib/server/team/state");
const {
  createTeamGatewayConfig,
} = require("../../lib/server/team/gateway-config");
const { createTeamPresence } = require("../../lib/server/team/presence");

const createLoginThrottleMock = () => ({
  getClientKey: vi.fn(() => "client-key"),
  getOrCreateLoginAttemptState: vi.fn(() => ({ attempts: 0 })),
  evaluateLoginThrottle: vi.fn(() => ({ blocked: false, retryAfterSec: 0 })),
  recordLoginFailure: vi.fn(() => ({ lockMs: 0, locked: false })),
  recordLoginSuccess: vi.fn(),
  cleanupLoginAttemptStates: vi.fn(),
});

const cookieOf = (res) => (res.headers["set-cookie"]?.[0] || "").split(";")[0];

describe("server/routes/team (4.5)", () => {
  let rootDir;
  let membersStore;
  let teamSettings;
  let configDoc;
  let app;
  let presence;
  let restartReasons;
  let auditEvents;
  let capability;

  beforeEach(() => {
    process.env.SETUP_PASSWORD = "owner-secret";
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-team-routes-"));
    initAuthDb({ rootDir });
    membersStore = createMembersStore({ getDb: getAuthDb });
    teamSettings = { enabled: false, disableLegacyLogin: false };
    configDoc = { gateway: { auth: { mode: "token", token: "t" } } };
    presence = createTeamPresence();
    restartReasons = [];
    auditEvents = [];
    capability = true;

    const teamStateStore = createTeamStateStore({ rootDir });
    const teamGatewayConfig = createTeamGatewayConfig({
      openclawDir: rootDir,
      // Real contract: mutate in place; the writer persists the same object.
      updateOpenclawConfig: ({ mutate }) => {
        mutate(configDoc);
        return { config: configDoc };
      },
      teamStateStore,
      membersStore,
    });

    app = express();
    app.use(express.json());
    const { requireAdmin } = registerAuthRoutes({
      app,
      loginThrottle: createLoginThrottleMock(),
      membersStore,
      readTeamSettings: () => teamSettings,
    });
    registerTeamRoutes({
      app,
      requireAdmin,
      membersStore,
      teamGatewayConfig,
      teamStateStore,
      presence,
      readTeamSettings: () => teamSettings,
      updateTeamSettings: ({ enabled, disableLegacyLogin }) => {
        if (enabled !== undefined) teamSettings.enabled = enabled === true;
        if (disableLegacyLogin !== undefined) {
          teamSettings.disableLegacyLogin = disableLegacyLogin === true;
        }
        return { changed: true };
      },
      restartRequiredState: {
        markRequired: (reason) => restartReasons.push(reason),
      },
      openclawCapabilities: {
        getAll: async () => ({ trustedProxyTeam: capability }),
      },
      insertWatchdogEvent: (event) => auditEvents.push(event),
      resolveSetupUrl: () => "https://claw.example.com/",
    });
  });

  afterEach(() => {
    delete process.env.SETUP_PASSWORD;
    closeAuthDb();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const legacyCookie = async () =>
    cookieOf(
      await request(app)
        .post("/api/auth/login")
        .send({ password: "owner-secret" }),
    );

  const enableTeam = async (cookie, overrides = {}) =>
    request(app)
      .post("/api/team/enable")
      .set("Cookie", cookie)
      .send({
        ownerEmail: "owner@example.com",
        ownerPassword: "owner member pw",
        ownerDisplayName: "Owner",
        confirmHostIsolation: true,
        ...overrides,
      });

  it("blocks enable without the host-isolation confirmation (D8/E-C3)", async () => {
    const cookie = await legacyCookie();
    const res = await enableTeam(cookie, { confirmHostIsolation: false });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("host_isolation_unconfirmed");
    expect(teamSettings.enabled).toBe(false);
    expect(configDoc.gateway.auth.mode).toBe("token");
  });

  it("blocks enable when the gateway lacks trusted-proxy team support", async () => {
    capability = false;
    const cookie = await legacyCookie();
    const res = await enableTeam(cookie);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("capability_missing");
    expect(res.body.error).toContain("beta channel");
  });

  it("enable creates the owner admin, writes trusted-proxy auth, flags restart", async () => {
    const cookie = await legacyCookie();
    const res = await enableTeam(cookie, { disableLegacyLogin: true });
    expect(res.status).toBe(200);
    expect(res.body.owner).toEqual({ email: "owner@example.com", role: "admin" });
    expect(res.body.restartRequired).toBe(true);
    expect(teamSettings).toEqual({ enabled: true, disableLegacyLogin: true });
    expect(configDoc.gateway.auth.mode).toBe("trusted-proxy");
    expect(configDoc.gateway.auth.trustedProxy.allowUsers).toEqual([
      "owner@example.com",
    ]);
    expect(restartReasons).toContain("team_enabled");
    expect(auditEvents.map((event) => event.eventType)).toContain("team_enabled");
  });

  it("invite lifecycle: create returns the URL once, accept adds the member, reconcile on change", async () => {
    const cookie = await legacyCookie();
    await enableTeam(cookie);

    const invite = await request(app)
      .post("/api/team/invites")
      .set("Cookie", cookie)
      .send({ role: "member" });
    expect(invite.status).toBe(200);
    expect(invite.body.url).toBe(
      `https://claw.example.com/login.html?invite=${encodeURIComponent(invite.body.token)}`,
    );

    // Listed invites never carry the raw token.
    const listed = await request(app).get("/api/team").set("Cookie", cookie);
    expect(listed.body.invites).toHaveLength(1);
    expect(listed.body.invites[0].token).toBeUndefined();

    const accept = await request(app).post("/api/auth/accept-invite").send({
      token: invite.body.token,
      email: "member@example.com",
      password: "member password",
    });
    expect(accept.status).toBe(200);

    // Roster mutation → gateway config rebuilt from the current roster.
    const memberRow = membersStore.getMemberByEmail("member@example.com");
    const patch = await request(app)
      .patch(`/api/team/members/${memberRow.id}`)
      .set("Cookie", cookie)
      .send({ disabled: true });
    expect(patch.status).toBe(200);
    expect(configDoc.gateway.auth.trustedProxy.allowUsers).toEqual([
      "owner@example.com",
    ]);
    expect(restartReasons).toContain("team_member_changed");
  });

  it("disabling a member revokes their session immediately (E-C8)", async () => {
    const adminCookie = await legacyCookie();
    await enableTeam(adminCookie);
    const invite = await request(app)
      .post("/api/team/invites")
      .set("Cookie", adminCookie)
      .send({});
    const accept = await request(app).post("/api/auth/accept-invite").send({
      token: invite.body.token,
      email: "member@example.com",
      password: "member password",
    });
    const memberCookie = cookieOf(accept);
    expect(
      (await request(app).get("/api/team").set("Cookie", memberCookie)).status,
    ).toBe(200);

    const memberRow = membersStore.getMemberByEmail("member@example.com");
    await request(app)
      .patch(`/api/team/members/${memberRow.id}`)
      .set("Cookie", adminCookie)
      .send({ disabled: true });

    expect(
      (await request(app).get("/api/team").set("Cookie", memberCookie)).status,
    ).toBe(401);
  });

  it("members can read the team page but never mutate it (4.6)", async () => {
    const adminCookie = await legacyCookie();
    await enableTeam(adminCookie);
    const invite = await request(app)
      .post("/api/team/invites")
      .set("Cookie", adminCookie)
      .send({});
    const accept = await request(app).post("/api/auth/accept-invite").send({
      token: invite.body.token,
      email: "member@example.com",
      password: "member password",
    });
    const memberCookie = cookieOf(accept);

    const view = await request(app).get("/api/team").set("Cookie", memberCookie);
    expect(view.status).toBe(200);
    // Members get the lightweight roster — no invites, no account states.
    expect(view.body.invites).toBeUndefined();
    expect(view.body.members[0].disabled).toBeUndefined();

    const inviteAttempt = await request(app)
      .post("/api/team/invites")
      .set("Cookie", memberCookie)
      .send({});
    expect(inviteAttempt.status).toBe(403);
    const memberRow = membersStore.getMemberByEmail("member@example.com");
    const promoteAttempt = await request(app)
      .patch(`/api/team/members/${memberRow.id}`)
      .set("Cookie", memberCookie)
      .send({ role: "admin" });
    expect(promoteAttempt.status).toBe(403);
  });

  it("disable restores the previous gateway auth and kills all member sessions", async () => {
    const adminCookie = await legacyCookie();
    await enableTeam(adminCookie);
    const invite = await request(app)
      .post("/api/team/invites")
      .set("Cookie", adminCookie)
      .send({});
    const accept = await request(app).post("/api/auth/accept-invite").send({
      token: invite.body.token,
      email: "member@example.com",
      password: "member password",
    });
    const memberCookie = cookieOf(accept);

    const disable = await request(app)
      .post("/api/team/disable")
      .set("Cookie", adminCookie)
      .send({});
    expect(disable.status).toBe(200);
    expect(teamSettings).toEqual({ enabled: false, disableLegacyLogin: false });
    expect(configDoc.gateway.auth).toEqual({ mode: "token", token: "t" });
    expect(
      (await request(app).get("/api/team").set("Cookie", memberCookie)).status,
    ).toBe(401);
    // The legacy admin session survives the disable (owner never locked out).
    expect(
      (await request(app).get("/api/team").set("Cookie", adminCookie)).status,
    ).toBe(200);
  });

  it("guards the last admin through the member routes (D9)", async () => {
    const adminCookie = await legacyCookie();
    await enableTeam(adminCookie);
    const owner = membersStore.getMemberByEmail("owner@example.com");
    const demote = await request(app)
      .patch(`/api/team/members/${owner.id}`)
      .set("Cookie", adminCookie)
      .send({ role: "member" });
    expect(demote.status).toBe(409);
    expect(demote.body.code).toBe("last_admin");
    const remove = await request(app)
      .delete(`/api/team/members/${owner.id}`)
      .set("Cookie", adminCookie)
      .send();
    expect(remove.status).toBe(409);
  });
});
