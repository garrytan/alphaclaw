const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const { createTeamStateStore } = require("../../lib/server/team/state");
const { createSecretDropApplier } = require("../../lib/server/secret-drop/apply");
const { createSlackOauth, resolveTokenEnvKey, kReadUserScopes, kStateTtlMs, kInstallsFileName } = require("../../lib/server/slack-oauth");
const { registerSlackConnectRoutes } = require("../../lib/server/routes/slack-connect");
const { createTerminalErrorHandler } = require("../../lib/server/terminal-error-handler");

const kOrigin = "https://box.example.com";
const kToken = "xoxp-1111-2222-3333-cnry7Q2xVb9LmZp4Wt8sK3dF";
const kClientSecret = "cs-cnryS3cr3tV4lu3Xq9";
const kSession = "s1.session-cookie";
const kReadScopes = [...kReadUserScopes, "identify"].join(",");

// Slack's API, answered from a script; records each call (never asserted on
// the token beyond where it must go).
const createFakeSlack = ({ scope = kReadScopes, botToken = "", teamId = "T02A11S1M", teamName = "YC", url = "https://ycombinator.slack.com/", exchangeOk = true } = {}) => {
  const calls = [];
  const fetchImpl = vi.fn(async (target, init) => {
    const method = String(target).split("/api/")[1];
    const body = init?.body ? Object.fromEntries(new URLSearchParams(init.body)) : {};
    calls.push({ method, body, auth: init?.headers?.Authorization || "" });
    const json = (data) => ({ ok: true, status: 200, json: async () => data });
    if (method === "oauth.v2.access") {
      if (!exchangeOk) return json({ ok: false, error: "invalid_code" });
      return json({
        ok: true,
        ...(botToken ? { access_token: botToken, token_type: "bot", scope: "chat:write" } : {}),
        authed_user: { id: "U1", scope, access_token: kToken, token_type: "user" },
        team: { id: teamId, name: teamName },
      });
    }
    if (method === "auth.test") return json({ ok: true, url, team: teamName, user: "garry" });
    if (method === "auth.revoke") return json({ ok: true, revoked: true });
    return json({ ok: false, error: "unknown_method" });
  });
  return { fetchImpl, calls };
};

const createHarness = ({ slack = {}, configured = true } = {}) => {
  const fake = createFakeSlack(slack);
  const lines = [];
  const logger = { log: (l) => lines.push(String(l)), warn: (l) => lines.push(String(l)), error: (l) => lines.push(String(l)) };
  const envWrites = [];
  const cliCalls = [];
  const applier = createSecretDropApplier({
    execFileCmd: vi.fn(async (file, args, opts) => {
      cliCalls.push({ args: [...args], input: opts?.input ?? null });
      return args.join(" ") === "secrets store list --json" ? "[]" : "ok";
    }),
    gatewayEnv: () => ({}),
    readEnvFile: () => [],
    setEnvKey: async (req, key, value) => {
      envWrites.push({ key, value });
      return { ok: true };
    },
    resolveEnvKeyReach: () => "next_gateway_start",
  });
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-oauth-"));
  const installsStore = createTeamStateStore({ rootDir, fileName: kInstallsFileName });
  let now = 1_800_000_000_000;
  const slackOauth = createSlackOauth({
    readConfig: () => (configured ? { clientId: "123.456", clientSecret: kClientSecret } : { clientId: "", clientSecret: "" }),
    applier,
    installsStore,
    fetchImpl: fake.fetchImpl,
    nowFn: () => now,
    logger,
  });
  const app = express();
  // As in production: requireAuth is not on these paths, and the agent's
  // bearer is never a session identity.
  const resolveRequestIdentity = (req) => {
    const who = req.get("x-test-identity");
    if (who === "admin") return { kind: "legacy", role: "admin" };
    if (who === "member") return { kind: "member", role: "member", memberId: "m1" };
    return null;
  };
  registerSlackConnectRoutes({ app, resolveRequestIdentity, slackOauth, resolveSetupUrl: () => kOrigin, logger });
  app.use(createTerminalErrorHandler({ logger }));
  return { app, fake, lines, envWrites, cliCalls, installsStore, advance: (ms) => { now += ms; } };
};

const admin = (req, session = kSession) => req.set("x-test-identity", "admin").set("Cookie", "setup_token=" + session);

const csrfOf = async (h, session = kSession) => {
  const page = await admin(request(h.app).get("/slack/connect"), session);
  expect(page.status).toBe(200);
  return page.text.match(/name="csrf" value="([^"]+)"/)[1];
};

// Press Connect and return the state Slack would send back.
const startFlow = async (h, session = kSession) => {
  const csrf = await csrfOf(h, session);
  const res = await admin(request(h.app).post("/slack/connect"), session).set("Origin", kOrigin).type("form").send({ csrf });
  expect(res.status).toBe(303);
  const url = new URL(res.headers.location);
  return { url, state: url.searchParams.get("state") };
};

const callback = (h, query, session = kSession) => admin(request(h.app).get("/slack/oauth/callback").query(query), session);

// Every byte the routes sent or logged, to check the token never left.
const everythingSeen = (h, responses) => [...h.lines, ...responses.map((r) => JSON.stringify(r.headers) + r.text)].join("\n");

describe("Connect Slack (read-only OAuth v2 user token)", () => {
  it("asks Slack for exactly the read user scopes and no bot scopes", async () => {
    const h = createHarness();
    const { url } = await startFlow(h);
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("scope")).toBe("");
    expect(url.searchParams.get("user_scope").split(",")).toEqual(kReadUserScopes);
    expect(url.searchParams.get("redirect_uri")).toBe(kOrigin + "/slack/oauth/callback");
    expect(url.searchParams.get("client_id")).toBe("123.456");
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  it("stores the user token as SLACK_USER_TOKEN_<WORKSPACE> and never logs or returns it", async () => {
    const h = createHarness();
    const { state } = await startFlow(h);
    const res = await callback(h, { code: "code-1", state });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/slack/connect?connected=SLACK_USER_TOKEN_YC");
    expect(h.envWrites).toEqual([{ key: "SLACK_USER_TOKEN_YC", value: kToken }]);
    expect(h.cliCalls.find((c) => c.args.join(" ") === "secrets store set SLACK_USER_TOKEN_YC --kind secret")?.input).toBe(kToken);
    const exchange = h.fake.calls.find((c) => c.method === "oauth.v2.access");
    expect(exchange.body).toEqual({ client_id: "123.456", client_secret: kClientSecret, code: "code-1", redirect_uri: kOrigin + "/slack/oauth/callback" });
    const page = await admin(request(h.app).get(res.headers.location));
    expect(page.text).toContain("YC is connected");
    const seen = everythingSeen(h, [res, page]);
    expect(seen).not.toContain(kToken);
    expect(seen).not.toContain("cnry7Q2xVb9LmZp4Wt8sK3dF");
    expect(seen).not.toContain(kClientSecret);
    expect(fs.readFileSync(h.installsStore.path, "utf8")).not.toContain("cnry7Q2x");
    expect(fs.statSync(h.installsStore.path).mode & 0o777).toBe(0o600);
  });

  it("uses a state once only", async () => {
    const h = createHarness();
    const { state } = await startFlow(h);
    expect((await callback(h, { code: "code-1", state })).headers.location).toContain("connected=");
    const again = await callback(h, { code: "code-2", state });
    expect(again.headers.location).toBe("/slack/connect?error=bad_state");
    expect(h.envWrites).toHaveLength(1);
    expect(h.fake.calls.filter((c) => c.method === "oauth.v2.access")).toHaveLength(1);
  });

  it("refuses a state older than 10 minutes, and a state it never issued", async () => {
    const h = createHarness();
    const { state } = await startFlow(h);
    h.advance(kStateTtlMs);
    expect((await callback(h, { code: "c", state })).headers.location).toBe("/slack/connect?error=expired_state");
    expect((await callback(h, { code: "c", state: "made-up-state-value-123456" })).headers.location).toBe("/slack/connect?error=bad_state");
    expect((await callback(h, { code: "c" })).headers.location).toBe("/slack/connect?error=bad_state");
    expect(h.fake.calls).toEqual([]);
    expect(h.envWrites).toEqual([]);
  });

  it("binds the state to the admin session that started it", async () => {
    const h = createHarness();
    const { state } = await startFlow(h, "s1.alice");
    const res = await callback(h, { code: "c", state }, "s1.mallory");
    expect(res.headers.location).toBe("/slack/connect?error=other_session");
    expect(h.fake.calls).toEqual([]);
    // The refused state is spent: the right session can't reuse it either.
    expect((await callback(h, { code: "c", state }, "s1.alice")).headers.location).toBe("/slack/connect?error=bad_state");
  });

  it("refuses a Connect press with no CSRF value, a wrong one, another session's or a cross-origin one", async () => {
    const h = createHarness();
    const csrf = await csrfOf(h, "s1.alice");
    const press = (session, body, origin = kOrigin) => admin(request(h.app).post("/slack/connect"), session).set("Origin", origin).type("form").send(body);
    for (const res of [
      await press("s1.alice", {}),
      await press("s1.alice", { csrf: "wrong" }),
      await press("s1.mallory", { csrf }),
      await press("s1.alice", { csrf }, "https://evil.example.com"),
    ]) {
      expect(res.status).toBe(403);
      expect(res.headers.location).toBeUndefined();
    }
    expect((await press("s1.alice", { csrf })).status).toBe(303);
  });

  it("refuses a grant with any scope beyond the read list and revokes its token", async () => {
    const h = createHarness({ slack: { scope: kReadScopes + ",chat:write" } });
    const { state } = await startFlow(h);
    const res = await callback(h, { code: "c", state });
    expect(res.headers.location).toBe("/slack/connect?error=extra_scopes");
    expect(h.envWrites).toEqual([]);
    expect(h.cliCalls).toEqual([]);
    expect(h.fake.calls.find((c) => c.method === "auth.revoke")?.auth).toBe("Bearer " + kToken);
    expect(fs.existsSync(h.installsStore.path)).toBe(false);
    expect(everythingSeen(h, [res])).not.toContain(kToken);
  });

  it("refuses a grant that came with a bot token", async () => {
    const h = createHarness({ slack: { botToken: "xoxb-cnryB0tT0k3n" } });
    const { state } = await startFlow(h);
    expect((await callback(h, { code: "c", state })).headers.location).toBe("/slack/connect?error=extra_scopes");
    expect(h.envWrites).toEqual([]);
    expect(h.fake.calls.filter((c) => c.method === "auth.revoke").map((c) => c.auth)).toEqual(["Bearer " + kToken, "Bearer xoxb-cnryB0tT0k3n"]);
    expect(h.lines.join("\n")).not.toContain("cnryB0tT0k3n");
  });

  it("replaces a workspace's token on a repeat install and lists it once", async () => {
    const h = createHarness();
    for (const code of ["first", "second"]) {
      const { state } = await startFlow(h);
      await callback(h, { code, state });
      h.advance(60_000);
    }
    expect(h.envWrites.map((w) => w.key)).toEqual(["SLACK_USER_TOKEN_YC", "SLACK_USER_TOKEN_YC"]);
    const installs = h.installsStore.read().installs;
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({ teamId: "T02A11S1M", teamName: "YC", envKey: "SLACK_USER_TOKEN_YC", installedAt: new Date(1_800_000_060_000).toISOString() });
    const page = await admin(request(h.app).get("/slack/connect"));
    expect(page.text.match(/<li>/g)).toHaveLength(1);
    expect(page.text).toContain("2027-01-15 08:01 UTC");
  });

  it("never starts or finishes a flow for the agent or a non-admin", async () => {
    const h = createHarness();
    const { state } = await startFlow(h);
    const agentPage = await request(h.app).get("/slack/connect").set("Authorization", "Bearer agent");
    expect(agentPage.status).toBe(302);
    expect(agentPage.headers.location).toBe("/login.html?next=%2Fslack%2Fconnect");
    const agentStart = await request(h.app).post("/slack/connect").set("Authorization", "Bearer agent").set("Origin", kOrigin).type("form").send({ csrf: "x" });
    expect(agentStart.status).toBe(403);
    const agentCallback = await request(h.app).get("/slack/oauth/callback").set("Authorization", "Bearer agent").set("Cookie", "setup_token=" + kSession).query({ code: "c", state });
    expect(agentCallback.status).toBe(403);
    const memberPage = await request(h.app).get("/slack/connect").set("x-test-identity", "member");
    expect(memberPage.status).toBe(403);
    const memberCallback = await request(h.app).get("/slack/oauth/callback").set("x-test-identity", "member").set("Cookie", "setup_token=" + kSession).query({ code: "c", state });
    expect(memberCallback.status).toBe(403);
    expect(h.fake.calls).toEqual([]);
    expect(h.envWrites).toEqual([]);
  });

  it("says Slack isn't set up when the client id or secret is missing", async () => {
    const h = createHarness({ configured: false });
    const page = await admin(request(h.app).get("/slack/connect"));
    expect(page.text).toContain("SLACK_OAUTH_CLIENT_ID and SLACK_OAUTH_CLIENT_SECRET are missing");
    expect(page.text).not.toContain('name="csrf"');
  });

  it("reports a cancelled consent without calling Slack", async () => {
    const h = createHarness();
    const { state } = await startFlow(h);
    expect((await callback(h, { error: "access_denied", state })).headers.location).toBe("/slack/connect?error=denied");
    expect(h.fake.calls).toEqual([]);
  });

  it("names workspaces from the fixed map, then the team domain", () => {
    expect(resolveTokenEnvKey({ teamId: "T02A11S1M", domain: "ycombinator" })).toBe("SLACK_USER_TOKEN_YC");
    expect(resolveTokenEnvKey({ teamId: "T0XXXX", domain: "ycx26" })).toBe("SLACK_USER_TOKEN_YCX26");
    expect(resolveTokenEnvKey({ teamId: "T0YYYY", domain: "overtonxyz" })).toBe("SLACK_USER_TOKEN_OVERTON");
    expect(resolveTokenEnvKey({ teamId: "T0ZZZZ", domain: "acme-corp" })).toBe("SLACK_USER_TOKEN_ACME_CORP");
    expect(resolveTokenEnvKey({ teamId: "T0ZZZZ", domain: "" })).toBe("SLACK_USER_TOKEN_T0ZZZZ");
  });

  it("names a workspace by its domain from auth.test", async () => {
    const h = createHarness({ slack: { teamId: "T0AAA111", teamName: "YC P2026", url: "https://ycx26.slack.com/" } });
    const { state } = await startFlow(h);
    expect((await callback(h, { code: "c", state })).headers.location).toBe("/slack/connect?connected=SLACK_USER_TOKEN_YCX26");
    expect(h.envWrites.map((w) => w.key)).toEqual(["SLACK_USER_TOKEN_YCX26"]);
  });
});
