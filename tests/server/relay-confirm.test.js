const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const { classifyRisk, checkConfirmation } = require("../../lib/plugin/relay-guard/confirm");
const { createRelayGuardPlugin } = require("../../lib/plugin/relay-guard");
const { openBridgeStore } = require("../../lib/server/relay/bridge-store");
const { openRemoteStore, sha256 } = require("../../lib/server/relay/remote-store");
const { createRelayConfirmations } = require("../../lib/server/relay/confirmations");
const { registerRelayConfirmRoutes } = require("../../lib/server/routes/relay-confirm");
const { relayPaths } = require("../../lib/server/relay/constants");

// Relay trust v2 PR2 (GST-2090): a delegate's high-risk call waits for the
// owner's one-tap confirmation, which admits that one call once.
const kClient = "d1df4e9e-8f1b-4520-98f6-2db9ab5d035f";
const kAgent = "capy-25cf4e98b5b6";
const kHour = 60 * 60 * 1000;
const quiet = { log: () => {}, warn: () => {}, info: () => {}, error: () => {} };

describe("relay confirmations: the risk kinds", () => {
  const root = "/data/.alphaclaw";
  it.each([
    ["a workspace write", { toolName: "write", params: { path: "/data/.openclaw/workspace/notes.md" } }, "low", null],
    ["openclaw.json", { toolName: "write", params: { path: "/data/.openclaw/openclaw.json" } }, "high", "write openclaw.json"],
    ["an edit of .env", { toolName: "edit", params: { file_path: "/data/.env" } }, "high", "edit .env"],
    ["a .env.local", { toolName: "write", params: { path: "x/.env.local" } }, "high", "write .env.local"],
    ["the relay guard's own code", { toolName: "edit", params: { path: "/app/node_modules/alphaclaw/lib/plugin/relay-guard/policy.js" } }, "high", "edit policy.js"],
    ["wm-guards", { toolName: "write", params: { path: "/data/.openclaw/extensions/wm-guards/index.js" } }, "high", "write index.js"],
    ["remote.db under the relay dir", { toolName: "write", params: { path: root + "/relay/remote.db" } }, "high", "write remote.db"],
    ["a patch touching auth-profiles.json", { toolName: "apply_patch", params: { input: "*** Begin Patch\n*** Update File: agents/main/auth-profiles.json\n@@\n-a\n+b\n*** End Patch" } }, "high", "apply_patch auth-profiles.json"],
    ["a patch of plain files", { toolName: "apply_patch", params: { input: "*** Begin Patch\n*** Add File: notes/a.md\n+hi\n*** End Patch" } }, "low", null],
    ["an alphaclaw admin read", { toolName: "exec", params: { command: "alphaclaw admin GET /api/status" } }, "low", null],
    ["an alphaclaw admin grant", { toolName: "exec", params: { command: "alphaclaw admin POST /api/relay/remote/grants --data '{}'" } }, "high", "alphaclaw admin POST /api/relay/remote/grants"],
    ["openclaw config get", { toolName: "exec", params: { command: "openclaw config get gateway.bind" } }, "low", null],
    ["openclaw config set", { toolName: "exec", params: { command: "openclaw config set gateway.bind lan" } }, "high", "openclaw config set gateway.bind"],
    ["openclaw secrets set", { toolName: "exec", params: { command: "openclaw secrets set OPENAI_API_KEY sk-live-abc123" } }, "high", "openclaw secrets set OPENAI_API_KEY"],
    ["openclaw plugins install", { toolName: "exec", params: { command: "cd /tmp && openclaw plugins install ./evil" } }, "high", "openclaw plugins install ./evil"],
    ["a plain shell command", { toolName: "exec", params: { command: "ls -la" } }, "low", null],
    ["a message", { toolName: "message", params: { to: "@lupe" } }, "medium", null],
    ["a read of openclaw.json", { toolName: "read", params: { path: "/data/.openclaw/openclaw.json" } }, "low", null],
  ])("%s", (_name, call, kind, action) => {
    const risk = classifyRisk({ ...call, rootDir: root });
    expect(risk.kind).toBe(kind);
    expect(risk.action).toBe(action);
  });

  it("cuts what the delegate chose to plain path characters, so nothing in it can render as a link or markup", () => {
    const risk = classifyRisk({ toolName: "write", params: { path: "/tmp/[Approve](https://evil.example/login)/<x|y>\u202e cookie: z/.env" } });
    expect(risk.kind).toBe("high");
    expect(risk.target).toMatch(/^[A-Za-z0-9._/@+,?-]+$/);
    const config = classifyRisk({ toolName: "exec", params: { command: "openclaw config set [a](https://evil.example) b" } });
    expect(config.action).toMatch(/^openclaw config set [A-Za-z0-9._/@+,?-]*$/);
  });

  it("binds an approved command to that exact command, flags and value included", () => {
    const a = classifyRisk({ toolName: "exec", params: { command: "openclaw config set gateway.bind lan" } });
    const b = classifyRisk({ toolName: "exec", params: { command: "openclaw config set gateway.bind custom" } });
    const flag = classifyRisk({ toolName: "exec", params: { command: "openclaw config set --json gateway.auth '{}'" } });
    expect(a.action).toBe(b.action);
    expect(a.target).not.toBe(b.target);
    expect(a.target).toMatch(/^openclaw config set gateway\.bind #[a-f0-9]{16}$/);
    expect(flag.action).toBe("openclaw config set");
    expect(flag.target).not.toBe(classifyRisk({ toolName: "exec", params: { command: "openclaw config set --json gateway.bind '{}'" } }).target);
  });

  it("names key names and paths only, never a value", () => {
    const risk = classifyRisk({ toolName: "exec", params: { command: "openclaw secrets set OPENAI_API_KEY sk-live-abc123" } });
    expect(JSON.stringify(risk)).not.toContain("sk-live-abc123");
    const config = classifyRisk({ toolName: "exec", params: { command: "openclaw config set gateway.auth.token hunter2" } });
    expect(JSON.stringify(config)).not.toContain("hunter2");
  });
});

const makeBox = ({ clock = { now: Date.now() } } = {}) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-confirm-"));
  const paths = relayPaths(rootDir);
  fs.mkdirSync(paths.dir, { recursive: true });
  const bridge = openBridgeStore({ dbPath: paths.bridgeDb, now: () => clock.now });
  const remote = openRemoteStore({ dbPath: paths.remoteDb });
  remote.clients.insert({ client_id: kClient, client_name: "Capy", redirect_uris: ["https://capy.ai/web/callbacks/mcp"] });
  remote.clients.markConsented(kClient);
  remote.bindings.upsert({ agent: kAgent, threadId: "jam_A", clientId: kClient, webhookUrl: "https://api.capy.ai/w/x", until: Date.now() + kHour, capabilityHash: sha256("arcap_test"), agentToken: "at_capy" });
  const grant = remote.grants.create({ agent: kAgent, createdBy: "admin" });
  let next = 800;
  // A delegate turn in flight, as the bridge stamps it right before chat.send.
  const running = ({ lane = null, generation = 1, confirmationRef = null } = {}) => {
    const id = String(++next);
    const sessionKey = "agent:main:relay-" + kAgent + (lane ? ":lane-" + lane : "");
    bridge.insert({ messageId: id, sender: kAgent, conversationId: "dm_1", threadRoot: id, sessionKey, state: "queued", lane, bindingGeneration: generation, confirmationRef });
    bridge.update(id, { state: "dispatched", runId: "relay-" + id, trust: "delegate", grantId: grant.id, dispatchedAt: Date.now() });
    return { id, ctx: { sessionKey, runId: "relay-" + id } };
  };
  const handlers = {};
  const warnings = [];
  createRelayGuardPlugin().register({
    pluginConfig: { rootDir },
    logger: { info: () => {}, warn: (line) => warnings.push(line), error: (line) => warnings.push(line) },
    on: (name, handler) => (handlers[name] = handler),
  });
  const call = (run, toolName, params) => handlers.before_tool_call({ toolName, params }, run.ctx);
  const notices = [];
  const digests = [];
  const told = [];
  const confirmations = createRelayConfirmations({
    getStore: () => bridge,
    notify: (text, opts) => (opts.eventType === "relay_digest" ? digests : notices).push({ text, opts }),
    resolveSetupUrl: () => "https://box.example.test/",
    sendToAgent: async (row, text, data) => told.push({ row, text, data }),
    readRevokes: () => 0,
    now: () => clock.now,
    setTimer: () => null,
    clearTimer: () => {},
    logger: quiet,
  });
  return {
    rootDir,
    paths,
    bridge,
    remote,
    grant,
    running,
    call,
    warnings,
    notices,
    digests,
    told,
    confirmations,
    clock,
    cleanup: () => {
      bridge.close();
      remote.close();
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
};

const linkToken = (notice) => notice.text.match(/\/relay\/confirm\/(rcl_[a-f0-9]{48})/)[1];
const refOf = (result) => result.blockReason.match(/rc_[a-f0-9]{16}/)[0];

describe("relay confirmations: the guard, the owner's link and the retry", () => {
  let box;
  afterEach(() => {
    box?.cleanup();
    box = null;
  });

  const configPath = () => path.join(box.rootDir, ".openclaw", "openclaw.json");
  const approve = async (notice) => box.confirmations.decide({ token: linkToken(notice), approve: true, by: "owner" });

  it("holds a high-risk call, sends the owner one link, and admits the retry once after Approve", async () => {
    box = makeBox();
    const first = box.running({ lane: "gbrain" });
    const held = box.call(first, "write", { path: configPath(), content: "{}" });
    expect(held.block).toBe(true);
    expect(held.blockReason).toMatch(/^\[relay-guard\] write openclaw\.json needs your owner's confirmation rc_[a-f0-9]{16}\. AlphaClaw is sending them a one-tap link now/);
    const ref = refOf(held);
    expect(box.call(first, "write", { path: configPath(), content: "{}" }).blockReason).toContain("is waiting for your owner's confirmation " + ref);
    // Low-risk work in the same turn is untouched.
    expect(box.call(first, "write", { path: path.join(box.rootDir, "notes.md"), content: "x" })).toEqual({});
    expect(box.call(first, "exec", { command: "ls" })).toEqual({});

    box.confirmations.tick();
    box.confirmations.tick();
    expect(box.notices).toHaveLength(1);
    const [notice] = box.notices;
    expect(notice.text).toContain("@" + kAgent + " (lane gbrain) wants to `write openclaw.json`");
    expect(notice.text).toContain("https://box.example.test/relay/confirm/rcl_");
    expect(notice.opts).toEqual({ eventType: "relay_confirm", id: "relay-confirm-" + ref });
    expect(box.bridge.confirmations.get(ref)).toMatchObject({ state: "pending", sender: kAgent, lane: "gbrain", generation: 1, kind: "high" });

    const decided = await approve(notice);
    expect(decided).toMatchObject({ ok: true, state: "confirmed" });
    expect(box.told).toHaveLength(1);
    expect(box.told[0].text).toContain("approved: write openclaw.json (confirmation " + ref + ")");
    expect(box.told[0].data).toEqual({ relay_status: "confirmation", relay_confirmation_ref: ref, relay_confirmation_state: "confirmed" });
    // The link works once.
    expect(await approve(notice)).toEqual({ ok: false });
    expect(box.confirmations.resolveToken(linkToken(notice))).toBeNull();

    const retry = box.running({ lane: "gbrain", confirmationRef: ref });
    expect(box.call(retry, "write", { path: configPath(), content: "{}" })).toEqual({});
    expect(box.bridge.confirmations.get(ref)).toMatchObject({ state: "spent", spentMessageId: retry.id });
    // Spent: the same call again asks anew.
    const again = box.call(retry, "write", { path: configPath(), content: "{}" });
    expect(again.block).toBe(true);
    expect(refOf(again)).not.toBe(ref);
    const replay = box.running({ lane: "gbrain", confirmationRef: ref });
    expect(box.call(replay, "write", { path: configPath(), content: "{}" }).block).toBe(true);
  });

  it("keeps markup in a delegate's target out of the owner's notice on every transport, after redaction too", () => {
    const { renderTelegramHtml } = require("../../lib/server/utils/telegram-html");
    const { formatSlackMessage } = require("../../lib/server/watchdog-notify");
    const { redactSecretText } = require("../../lib/server/utils/redact");
    box = makeBox();
    const run = box.running();
    for (const target of ["/tmp/[Approve on the secure page](https://evil.example/login)/.env", "/tmp/cookie: x [Approve](https://evil.example/a)/.env", "/tmp/<https://evil.example/b|Approve>/.env"]) {
      expect(box.call(run, "write", { path: target, content: "x" }).block).toBe(true);
    }
    box.confirmations.tick();
    expect(box.notices).toHaveLength(3);
    for (const notice of box.notices) {
      const text = redactSecretText(notice.text);
      expect(text).toMatch(/Target: \x60[A-Za-z0-9._/@+,?-]+\x60\n/);
      expect(text).not.toMatch(/https?:\/\/evil/);
      const { html } = renderTelegramHtml(text);
      expect(html).not.toMatch(/href="[^"]*evil/);
      expect(formatSlackMessage(text)).not.toMatch(/<https?:\/\/evil/);
    }
  });


  it("a confirmation admits nothing for another target, another generation or another lane's message", async () => {
    box = makeBox();
    const first = box.running({ lane: "gbrain" });
    const ref = refOf(box.call(first, "exec", { command: "openclaw config set gateway.bind lan" }));
    box.confirmations.tick();
    await approve(box.notices[0]);

    const otherTarget = box.running({ lane: "gbrain", confirmationRef: ref });
    expect(box.call(otherTarget, "exec", { command: "openclaw config set gateway.auth.mode none" }).block).toBe(true);
    const otherGeneration = box.running({ lane: "gbrain", generation: 2, confirmationRef: ref });
    expect(box.call(otherGeneration, "exec", { command: "openclaw config set gateway.bind lan" }).block).toBe(true);
    const otherLane = box.running({ lane: "evals" });
    expect(box.call(otherLane, "exec", { command: "openclaw config set gateway.bind lan" }).block).toBe(true);
    expect(box.bridge.confirmations.get(ref).state).toBe("confirmed");
    // The message that carries the ref, on its own lane, still spends it.
    const retry = box.running({ lane: "gbrain", confirmationRef: ref });
    expect(box.call(retry, "exec", { command: "openclaw config set gateway.bind lan" })).toEqual({});
  });

  it("Deny tells the sender and refuses the retry", async () => {
    box = makeBox();
    const first = box.running();
    const ref = refOf(box.call(first, "edit", { path: path.join(box.rootDir, ".env"), old_string: "a", new_string: "b" }));
    box.confirmations.tick();
    expect(await box.confirmations.decide({ token: linkToken(box.notices[0]), approve: false, by: "owner" })).toMatchObject({ ok: true, state: "denied" });
    expect(box.told[0].text).toContain("denied: edit .env");
    const retry = box.running({ confirmationRef: ref });
    const refused = box.call(retry, "edit", { path: path.join(box.rootDir, ".env"), old_string: "a", new_string: "b" });
    expect(refused.blockReason).toContain("was denied by your owner (confirmation " + ref + ")");
  });

  it("an unanswered link expires after 15 minutes, and so does an approval nobody used", async () => {
    const clock = { now: Date.now() };
    box = makeBox({ clock });
    const action = { kind: "high", action: "write openclaw.json", target: "/x/openclaw.json" };
    const asked = checkConfirmation({ rootDir: box.rootDir, sender: kAgent, messageId: "m1", generation: 1, ...action, now: clock.now });
    expect(asked).toMatchObject({ admitted: false, state: "requested" });
    box.confirmations.tick();
    const token = linkToken(box.notices[0]);
    clock.now += 15 * 60 * 1000 + 1;
    expect(box.confirmations.resolveToken(token)).toBeNull();
    expect(await box.confirmations.decide({ token, approve: true, by: "owner" })).toEqual({ ok: false });
    box.confirmations.tick();
    expect(box.bridge.confirmations.get(asked.ref).state).toBe("expired");

    const second = checkConfirmation({ rootDir: box.rootDir, sender: kAgent, messageId: "m2", generation: 1, ...action, now: clock.now });
    box.confirmations.tick();
    await box.confirmations.decide({ token: linkToken(box.notices[1]), approve: true, by: "owner" });
    clock.now += 15 * 60 * 1000 + 1;
    const late = checkConfirmation({ rootDir: box.rootDir, sender: kAgent, messageId: "m3", generation: 1, confirmationRef: second.ref, ...action, now: clock.now });
    expect(late).toMatchObject({ admitted: false, state: "requested" });
  });

  it("refuses with no bridge database, and a revoke cancels the sender's open confirmations", () => {
    box = makeBox();
    const missing = checkConfirmation({ rootDir: path.join(box.rootDir, "nope"), sender: kAgent, messageId: "m1", kind: "high", action: "a", target: "t" });
    expect(missing).toEqual({ admitted: false, state: "unavailable", ref: null });
    const run = box.running();
    const ref = refOf(box.call(run, "write", { path: configPath(), content: "{}" }));
    box.bridge.demoteSender(kAgent, "grant_revoked");
    expect(box.bridge.confirmations.get(ref).state).toBe("cancelled");
  });

  it("the owner's message names the action and key, never the value or the message text", () => {
    box = makeBox();
    const run = box.running();
    box.call(run, "exec", { command: "openclaw secrets set OPENAI_API_KEY sk-live-abc123def456" });
    box.confirmations.tick();
    expect(box.notices[0].text).toContain("openclaw secrets set OPENAI_API_KEY");
    expect(box.notices[0].text).not.toContain("sk-live");
    expect(JSON.stringify(box.bridge.confirmations.listOpen())).not.toContain("sk-live");
  });

  it("sends the daily digest once a day after 15:00 UTC, counts only", () => {
    const clock = { now: Date.parse("2026-11-09T14:00:00Z") };
    box = makeBox({ clock });
    box.running({ lane: "gbrain" });
    box.running();
    box.confirmations.tick();
    expect(box.digests).toEqual([]);
    clock.now = Date.parse("2026-11-09T15:05:00Z");
    box.confirmations.tick();
    box.confirmations.tick();
    expect(box.digests).toHaveLength(1);
    expect(box.digests[0].opts).toEqual({ eventType: "relay_digest", id: "relay-digest-2026-11-09" });
    expect(box.digests[0].text).toContain("@" + kAgent + ": 2 delegate messages, lanes default, gbrain, grant " + box.grant.id);
    expect(box.digests[0].text).toContain("Confirmations: 0 asked");
    // The next day's digest covers that day only: nothing new, nothing sent.
    clock.now = Date.parse("2026-11-10T15:05:00Z");
    box.confirmations.tick();
    expect(box.digests).toHaveLength(1);
  });
});

describe("relay confirmations: the owner's page", () => {
  let box;
  afterEach(() => {
    box?.cleanup();
    box = null;
  });

  const setup = (identity = { kind: "legacy", role: "admin" }) => {
    box = makeBox();
    const run = box.running({ lane: "gbrain" });
    box.call(run, "write", { path: path.join(box.rootDir, ".openclaw", "openclaw.json"), content: "{}" });
    box.confirmations.tick();
    const app = express();
    let who = identity;
    registerRelayConfirmRoutes({ app, resolveRequestIdentity: () => who, confirmations: box.confirmations, resolveSetupUrl: () => "https://box.example.test", logger: quiet });
    return { app, token: linkToken(box.notices[0]), setIdentity: (value) => (who = value) };
  };
  const csrfOf = (html) => html.match(/name="csrf" value="([a-f0-9]+)"/)[1];

  it("shows the request to a signed-in admin and takes one answer, same origin with the page's CSRF", async () => {
    const { app, token } = setup();
    const page = await request(app).get("/relay/confirm/" + token);
    expect(page.status).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.text).toContain("write openclaw.json");
    expect(page.text).toContain("lane <code>gbrain</code>");
    const csrf = csrfOf(page.text);
    const crossOrigin = await request(app).post("/relay/confirm/" + token).set("Origin", "https://evil.test").type("form").send({ csrf, decision: "approve" });
    expect(crossOrigin.status).toBe(403);
    const badCsrf = await request(app).post("/relay/confirm/" + token).set("Origin", "https://box.example.test").type("form").send({ csrf: "0".repeat(32), decision: "approve" });
    expect(badCsrf.status).toBe(403);
    const approved = await request(app).post("/relay/confirm/" + token).set("Origin", "https://box.example.test").type("form").send({ csrf, decision: "approve" });
    expect(approved.status).toBe(200);
    expect(approved.text).toContain("Approved");
    expect(box.told).toHaveLength(1);
    const again = await request(app).post("/relay/confirm/" + token).set("Origin", "https://box.example.test").type("form").send({ csrf, decision: "deny" });
    expect(again.status).toBe(410);
    expect((await request(app).get("/relay/confirm/" + token)).status).toBe(410);
  });

  it("sends a signed-out visitor to the login page and refuses a member who is not an admin", async () => {
    const { app, token, setIdentity } = setup(null);
    const signedOut = await request(app).get("/relay/confirm/" + token);
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.location).toBe("/login.html?next=" + encodeURIComponent("/relay/confirm/" + token));
    expect((await request(app).post("/relay/confirm/" + token).type("form").send({ decision: "approve" })).status).toBe(401);
    setIdentity({ kind: "member", memberId: "m1", role: "member" });
    expect((await request(app).get("/relay/confirm/" + token)).status).toBe(403);
    expect((await request(app).get("/relay/confirm/not-a-token")).status).toBe(410);
    expect(box.bridge.confirmations.listOpen()[0].state).toBe("pending");
  });
});
