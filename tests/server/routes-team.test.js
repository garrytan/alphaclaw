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
const { createTeamService } = require("../../lib/server/team-service");
const { createTeamPresence } = require("../../lib/server/team/presence");
const { updateOpenclawConfig } = require("../../lib/server/openclaw-config");
const {
  readTeamSettings: readTeamSettingsFromConfig,
  updateTeamSettings: updateTeamSettingsInConfig,
} = require("../../lib/server/alphaclaw-config");

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
  let app;
  let presence;
  let restartReasons;
  let restartGateway;
  let auditEvents;
  let capability;
  let probeIdentityOk;
  let probeTokenOk;

  // The merged stack end to end over REAL files: routes -> teamService
  // (transition: snapshot -> write -> restart -> probe -> restore) ->
  // team/gateway-config writer -> openclaw.json + alphaclaw.json in rootDir.
  // Only the gateway itself is faked (restart + loopback probe).
  const teamSettings = () => readTeamSettingsFromConfig({ openclawDir: rootDir });
  const configDoc = () =>
    JSON.parse(fs.readFileSync(path.join(rootDir, "openclaw.json"), "utf8"));

  beforeEach(() => {
    process.env.SETUP_PASSWORD = "owner-secret";
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-team-routes-"));
    initAuthDb({ rootDir });
    membersStore = createMembersStore({ getDb: getAuthDb });
    fs.writeFileSync(
      path.join(rootDir, "openclaw.json"),
      JSON.stringify({ gateway: { auth: { mode: "token", token: "t" } } }, null, 2),
    );
    presence = createTeamPresence();
    restartReasons = [];
    restartGateway = vi.fn(async () => {});
    auditEvents = [];
    capability = true;
    probeIdentityOk = true;
    probeTokenOk = true;

    const teamStateStore = createTeamStateStore({ rootDir });
    const teamGatewayConfig = createTeamGatewayConfig({
      openclawDir: rootDir,
      updateOpenclawConfig,
      teamStateStore,
      membersStore,
      env: {},
    });
    // Loopback probe fake: identity handshake passes for the injected owner
    // header; the post-disable shared-secret probe passes for the restored
    // token.
    const probeRequest = vi.fn(async ({ url, headers = {} }) => {
      if (String(url).endsWith("/health")) return { status: 200, error: null };
      if (headers["x-alphaclaw-user"]) {
        return { status: probeIdentityOk ? 400 : 401, error: null };
      }
      if (headers.authorization === "Bearer t") {
        return { status: probeTokenOk ? 400 : 401, error: null };
      }
      return { status: 401, error: null };
    });
    const teamService = createTeamService({
      fsModule: fs,
      openclawDir: rootDir,
      env: {},
      restartGateway,
      getGatewayUrl: () => "http://127.0.0.1:18789",
      membersStore,
      applyTeamGatewayConfig: () => teamGatewayConfig.applyTeamGatewayConfig(),
      request: probeRequest,
      probeOptions: { healthAttempts: 1, healthRetryDelayMs: 0 },
      logger: { warn() {} },
    });

    app = express();
    app.use(express.json());
    const { requireAdmin } = registerAuthRoutes({
      app,
      loginThrottle: createLoginThrottleMock(),
      membersStore,
      readTeamSettings: () => teamSettings(),
      // Mirrors lib/server.js wiring: invite acceptance reconciles the
      // gateway roster when team mode is on (E-C8).
      onMemberRosterChanged: async () => {
        if (!teamSettings().enabled) return;
        await teamGatewayConfig.applyTeamGatewayConfig();
        restartReasons.push("team_member_accepted");
      },
    });
    registerTeamRoutes({
      app,
      requireAdmin,
      membersStore,
      teamGatewayConfig,
      teamStateStore,
      teamService,
      presence,
      readTeamSettings: () => teamSettings(),
      updateTeamSettings: ({ enabled, disableLegacyLogin }) =>
        updateTeamSettingsInConfig({
          openclawDir: rootDir,
          enabled,
          disableLegacyLogin,
        }),
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
    expect(teamSettings().enabled).toBe(false);
    expect(configDoc().gateway.auth.mode).toBe("token");
  });

  it("blocks enable when the gateway lacks trusted-proxy team support", async () => {
    capability = false;
    const cookie = await legacyCookie();
    const res = await enableTeam(cookie);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("capability_missing");
    expect(res.body.error).toContain("beta channel");
  });

  it("enable creates the owner admin, writes trusted-proxy auth, restarts + probes inline", async () => {
    const cookie = await legacyCookie();
    const res = await enableTeam(cookie, { disableLegacyLogin: true });
    expect(res.status).toBe(200);
    expect(res.body.owner).toEqual({ email: "owner@example.com", role: "admin" });
    // The transition restarted the gateway and verified the handshake — no
    // restart-required banner.
    expect(res.body.restartRequired).toBe(false);
    expect(restartGateway).toHaveBeenCalledTimes(1);
    expect(teamSettings()).toEqual({ enabled: true, disableLegacyLogin: true });
    expect(configDoc().gateway.auth.mode).toBe("trusted-proxy");
    expect(configDoc().gateway.auth.trustedProxy.allowUsers).toEqual([
      "owner@example.com",
    ]);
    // Internal-caller password derived from the previous shared token; the
    // harness has no env-backed secret, so the literal lands in the config.
    expect(configDoc().gateway.auth.password).toBe("t");
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
    // E-C8: acceptance itself reconciles — the new member holds gateway
    // authority immediately, not after the next admin mutation.
    expect(configDoc().gateway.auth.trustedProxy.allowUsers).toContain(
      "member@example.com",
    );
    expect(
      configDoc().gateway.auth.identityScopes["member@example.com"],
    ).toEqual(["operator.read", "operator.write", "operator.approvals"]);
    expect(restartReasons).toContain("team_member_accepted");

    // Roster mutation → gateway config rebuilt from the current roster.
    const memberRow = membersStore.getMemberByEmail("member@example.com");
    const patch = await request(app)
      .patch(`/api/team/members/${memberRow.id}`)
      .set("Cookie", cookie)
      .send({ disabled: true });
    expect(patch.status).toBe(200);
    expect(configDoc().gateway.auth.trustedProxy.allowUsers).toEqual([
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
    expect(teamSettings()).toEqual({ enabled: false, disableLegacyLogin: false });
    // The transition restored the snapshotted pre-team auth verbatim.
    expect(configDoc().gateway.auth).toEqual({ mode: "token", token: "t" });
    expect(
      (await request(app).get("/api/team").set("Cookie", memberCookie)).status,
    ).toBe(401);
    // The legacy admin session survives the disable (owner never locked out).
    expect(
      (await request(app).get("/api/team").set("Cookie", adminCookie)).status,
    ).toBe(200);
  });

  it("does not flip the gateway to trusted-proxy when a member is mutated while team is OFF (H1)", async () => {
    // Team was enabled then disabled; the roster keeps its accounts.
    const adminCookie = await legacyCookie();
    await enableTeam(adminCookie);
    const invite = await request(app)
      .post("/api/team/invites")
      .set("Cookie", adminCookie)
      .send({});
    await request(app).post("/api/auth/accept-invite").send({
      token: invite.body.token,
      email: "leftover@example.com",
      password: "member password",
    });
    await request(app).post("/api/team/disable").set("Cookie", adminCookie).send({});
    expect(teamSettings().enabled).toBe(false);
    expect(configDoc().gateway.auth).toEqual({ mode: "token", token: "t" });

    // Now, with team OFF, an admin disables that leftover member. The gateway
    // auth on disk MUST stay single-user token auth — reconcile must not
    // rewrite it to trusted-proxy (which would 401 every request on the next
    // restart with no identity injection).
    const leftover = membersStore.getMemberByEmail("leftover@example.com");
    const patch = await request(app)
      .patch(`/api/team/members/${leftover.id}`)
      .set("Cookie", adminCookie)
      .send({ disabled: true });
    expect(patch.status).toBe(200);
    expect(configDoc().gateway.auth).toEqual({ mode: "token", token: "t" });
    // Nothing was written to the gateway, so no restart is claimed.
    expect(patch.body.restartRequired).toBe(false);
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

  it("a failed identity probe rolls enable back: 502 restored, flag off, lockdown never armed (D11)", async () => {
    probeIdentityOk = false;
    const cookie = await legacyCookie();
    const res = await enableTeam(cookie, { disableLegacyLogin: true });
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe("team_enable_failed");
    expect(res.body.restored).toBe(true);
    // The flag never flipped and the legacy-login lockdown never armed.
    expect(teamSettings()).toEqual({ enabled: false, disableLegacyLogin: false });
    // The snapshot was restored verbatim, via a second restart.
    expect(configDoc().gateway.auth).toEqual({ mode: "token", token: "t" });
    expect(restartGateway).toHaveBeenCalledTimes(2);
    expect(auditEvents.map((event) => event.eventType)).not.toContain(
      "team_enabled",
    );
  });

  it("reports restored:false when the probe fails AND the restore restart also fails", async () => {
    const cookie = await legacyCookie();
    // Both restarts reject: the post-write restart counts as a failed probe,
    // and the restore restart failing must surface restored:false so the
    // admin knows the gateway needs manual attention.
    restartGateway.mockRejectedValue(new Error("systemd said no"));
    const res = await enableTeam(cookie);
    expect(res.status).toBe(502);
    expect(res.body.restored).toBe(false);
    expect(teamSettings().enabled).toBe(false);
    // The restore CONFIG write still landed before the restart threw.
    expect(configDoc().gateway.auth).toEqual({ mode: "token", token: "t" });
  });

  it("a concurrent enable is rejected 409 transition_in_flight without a second transition", async () => {
    const cookie = await legacyCookie();
    let releaseRestart;
    restartGateway.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRestart = resolve;
        }),
    );
    const first = enableTeam(cookie).then((res) => res);
    await vi.waitFor(() => expect(restartGateway).toHaveBeenCalledTimes(1));

    const second = await enableTeam(cookie);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("transition_in_flight");

    releaseRestart();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    expect(teamSettings().enabled).toBe(true);
    // The rejected call never drove a second restart.
    expect(restartGateway).toHaveBeenCalledTimes(1);
  });

  it("a concurrent disable is rejected 409 transition_in_flight and leaves the flag untouched", async () => {
    const cookie = await legacyCookie();
    await enableTeam(cookie);
    let releaseRestart;
    restartGateway.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRestart = resolve;
        }),
    );
    const disable = () =>
      request(app).post("/api/team/disable").set("Cookie", cookie).send({});
    const first = disable().then((res) => res);
    await vi.waitFor(() => expect(restartGateway).toHaveBeenCalledTimes(2));

    const second = await disable();
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("transition_in_flight");
    // The early return skipped updateTeamSettings — the flag is still on
    // while the first transition finishes.
    expect(teamSettings().enabled).toBe(true);

    releaseRestart();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    expect(teamSettings()).toEqual({ enabled: false, disableLegacyLogin: false });
  });

  it("a failed post-disable probe is 502 gateway_probe_failed but team still lands off", async () => {
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

    probeTokenOk = false;
    const res = await request(app)
      .post("/api/team/disable")
      .set("Cookie", adminCookie)
      .send({});
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("gateway_probe_failed");
    expect(res.body.disabled).toBe(true);
    // Disabling always lands on off — a failed probe is reported, not stuck.
    expect(teamSettings()).toEqual({ enabled: false, disableLegacyLogin: false });
    expect(configDoc().gateway.auth).toEqual({ mode: "token", token: "t" });
    // Member sessions still die on the failure path.
    expect(
      (await request(app).get("/api/team").set("Cookie", memberCookie)).status,
    ).toBe(401);
    expect(auditEvents.map((event) => event.eventType)).toContain(
      "team_disabled",
    );
  });

  it("GET /api/team identityProbe: admin-only, null while off, re-probed after roster invalidation", async () => {
    const adminCookie = await legacyCookie();
    // Team off: admins get an explicit null (nothing to probe yet).
    const off = await request(app).get("/api/team").set("Cookie", adminCookie);
    expect(off.body.identityProbe).toBeNull();

    await enableTeam(adminCookie);
    const on = await request(app).get("/api/team").set("Cookie", adminCookie);
    expect(on.body.identityProbe).toEqual(
      expect.objectContaining({ ok: true, error: null }),
    );
    expect(typeof on.body.identityProbe.checkedAt).toBe("string");

    // Members never see the probe (or invites/account states).
    const invite = await request(app)
      .post("/api/team/invites")
      .set("Cookie", adminCookie)
      .send({});
    const accept = await request(app).post("/api/auth/accept-invite").send({
      token: invite.body.token,
      email: "member@example.com",
      password: "member password",
    });
    const memberView = await request(app)
      .get("/api/team")
      .set("Cookie", cookieOf(accept));
    expect(memberView.status).toBe(200);
    expect(memberView.body.identityProbe).toBeUndefined();

    // A roster mutation invalidates the cached probe; the next admin read
    // re-probes and surfaces the failure the Team page banner renders.
    probeIdentityOk = false;
    const memberRow = membersStore.getMemberByEmail("member@example.com");
    await request(app)
      .patch(`/api/team/members/${memberRow.id}`)
      .set("Cookie", adminCookie)
      .send({ disabled: true });
    const failing = await request(app)
      .get("/api/team")
      .set("Cookie", adminCookie);
    expect(failing.body.identityProbe.ok).toBe(false);
    expect(failing.body.identityProbe.error).toContain("rejected the credential");
  });
});
