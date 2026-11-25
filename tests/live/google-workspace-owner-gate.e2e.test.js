// LIVE TIER — the Google Workspace plugin's owner gate (GST-3848) inside the
// REAL pinned OpenClaw gateway, against a fake Telegram Bot API
// (fixtures/fake-telegram.js), a fake GBrain broker on a unix socket and a
// local model fixture that tries a Google tool in every turn, once directly
// (when offered) and once through Tool Search's dispatch_action wrapper,
// by bare name and by catalog id:
//   - the owner's DM: the broker gets the calls, as v4 call ops with the run
//     id as turn id;
//   - a group member allowed to talk to the agent (not the owner): the
//     broker gets no call at all, and the model sees the gw_not_owner
//     refusal.
// Run with:
//   OPENCLAW_LIVE_E2E=1 npx vitest run tests/live/google-workspace-owner-gate.e2e.test.js
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");

const liveHelpers = require("./live-helpers");
const kRootDir = liveHelpers.mkTemp("alphaclaw-live-gw-root-");
process.env.ALPHACLAW_ROOT_DIR = kRootDir;
delete process.env.OPENCLAW_GIT_DIR;
delete process.env.OPENCLAW_NO_RESPAWN;
for (const key of ["VITEST", "VITEST_MODE", "VITEST_POOL_ID", "VITEST_WORKER_ID", "NODE_ENV", "TEST"]) {
  delete process.env[key];
}
process.env.NODE_COMPILE_CACHE = path.join(kRootDir, "cache", "openclaw-compile-cache");
process.env.PATH = [liveHelpers.repoBinDir(), process.env.PATH].filter(Boolean).join(path.delimiter);

const { createFakeTelegram } = require("./fixtures/fake-telegram");
const { kLiveEnabled, waitFor, readDeclaredPin } = liveHelpers;
const describeLive = kLiveEnabled && process.platform === "linux" ? describe : describe.skip;
const kTestTimeoutMs = 8 * 60 * 1000;

const kOwner = "6100000001";
const kMember = "6100000002";
const kGroup = "-1006100000003";
const kBotToken = "7000000001:LIVEfakeTOKENforTHEgwGATEtest0000000";
const kTool = "gw_calendar_list_events";

const world = {
  chats: {
    [kGroup]: { type: "supergroup", title: "Team" },
    [kOwner]: { type: "private", title: "Owner" },
  },
  users: {
    [kOwner]: { first: "Owner" },
    [kMember]: { first: "Member" },
  },
};

const textOf = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text || "").join(" ") : "";

describeLive("LIVE Google Workspace owner gate against the " + readDeclaredPin() + " pin", () => {
  let gateway;
  let model;
  let telegram;
  let broker;
  let port;
  const brokerRequests = [];
  const probeStage = new Map();
  const toolResults = new Map();

  const readyzOk = async () => {
    try {
      return (await fetch("http://127.0.0.1:" + port + "/readyz")).status === 200;
    } catch {
      return false;
    }
  };

  let caseNo = 0;
  const runCase = async ({ name, from, chat }) => {
    caseNo += 1;
    const tag = "gw" + caseNo + "x" + Math.random().toString(36).slice(2, 7);
    const before = brokerRequests.length;
    telegram.inject({ from, chat, text: "what is on my calendar (case " + tag + ")" });
    await waitFor(async () => telegram.pending() === 0, 60_000, name + " update consumed");
    await waitFor(async () => telegram.delivered.some((entry) => entry.chat === String(chat) && entry.text.includes(tag)), 150_000, name + " reply");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const outcome = { name, tag, stages: probeStage.get(tag) || 0, results: toolResults.get(tag) || [], broker: brokerRequests.slice(before).filter((request) => request.op !== "tools") };
    console.log("[live] gw-gate case " + JSON.stringify({ name, stages: outcome.stages, results: outcome.results.map((text) => text.slice(0, 120)), broker: outcome.broker.map((request) => request.op + ":" + request.tool) }));
    return outcome;
  };

  beforeAll(async () => {
    const socketPath = path.join(kRootDir, "google.sock");
    broker = net.createServer((conn) => {
      let buffer = "";
      conn.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const request = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          brokerRequests.push(request);
          const reply =
            request.op === "tools"
              ? { v: 4, ok: true, tools: [] }
              : { v: 4, ok: true, request_id: "req-" + brokerRequests.length, result: { content: [{ type: "text", text: "no events today" }] }, quota: { product: request.server, used_today: brokerRequests.length, cap: 1500, day: new Date().toISOString().slice(0, 10) } };
          conn.write(JSON.stringify(reply) + "\n");
        }
      });
    });
    await new Promise((resolve) => broker.listen(socketPath, resolve));

    model = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let payload = {};
        try {
          payload = JSON.parse(body || "{}");
        } catch {}
        const messages = payload.messages || [];
        const names = (payload.tools || []).map((tool) => tool.function?.name || tool.name).filter(Boolean);
        const tags = messages
          .filter((m) => m.role === "user")
          .flatMap((m) => [...textOf(m.content).matchAll(/case (gw(\d+)x[a-z0-9]+)/g)])
          .sort((a, b) => Number(b[2]) - Number(a[2]));
        const tag = tags[0]?.[1];
        const stage = tag ? probeStage.get(tag) || 0 : 0;
        if (tag) probeStage.set(tag, stage + 1);
        const lastTool = [...messages].reverse().find((m) => m.role === "tool");
        if (tag && lastTool && stage > 0) toolResults.set(tag, [...(toolResults.get(tag) || []), textOf(lastTool.content)]);
        const chunk = (delta, finish = null) =>
          "data: " + JSON.stringify({ id: "gw-live", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
        res.writeHead(200, { "content-type": "text/event-stream" });
        const probes = [
          names.includes(kTool) ? { name: kTool, args: { calendarId: "primary" } } : null,
          names.includes("dispatch_action") ? { name: "dispatch_action", args: { id: kTool, args: { calendarId: "primary" } } } : null,
          names.includes("dispatch_action") ? { name: "dispatch_action", args: { id: "openclaw:google-workspace:" + kTool, args: { calendarId: "primary" } } } : null,
        ].filter(Boolean);
        const probe = tag ? probes[stage] : null;
        if (probe) {
          res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_gw_" + stage + "_" + tag, type: "function", function: { name: probe.name, arguments: JSON.stringify(probe.args) } }] }));
          res.write(chunk({}, "tool_calls"));
          res.end("data: [DONE]\n\n");
          return;
        }
        res.write(chunk({ role: "assistant", content: "ok " + (tag || "no-tag") }));
        res.write(chunk({}, "stop"));
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
    telegram = createFakeTelegram({ world });
    const telegramPort = await telegram.listen();

    const { OPENCLAW_DIR, kOnboardingMarkerPath } = require("../../lib/server/constants");
    port = 19600 + Math.floor(Math.random() * 90);
    const token = "live-gw-gate-token-0000000000000000000";
    const workspace = path.join(OPENCLAW_DIR, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(process.env.NODE_COMPILE_CACHE, { recursive: true });
    const { ensureManagedOpenclawExecDefaults } = require("../../lib/server/exec-defaults-config");
    const { applyGoogleWorkspaceEntry, resolveDesiredGoogleWorkspaceEntry } = require("../../lib/server/google-workspace-entry");
    const { config } = ensureManagedOpenclawExecDefaults({
      gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
      agents: { defaults: { workspace, model: { primary: "fixture/fixture" }, heartbeat: { target: "none" } } },
      models: { providers: { fixture: {
        baseUrl: "http://127.0.0.1:" + model.address().port + "/v1",
        api: "openai-completions",
        apiKey: "local-model-fixture",
        models: [{ id: "fixture", name: "fixture", contextWindow: 128000, maxTokens: 1024 }],
      } } },
      commands: { ownerAllowFrom: ["telegram:" + kOwner] },
      channels: {
        telegram: {
          enabled: true,
          botToken: kBotToken,
          apiRoot: "http://127.0.0.1:" + telegramPort,
          dmPolicy: "allowlist",
          allowFrom: [kOwner],
          groupPolicy: "allowlist",
          groupAllowFrom: [kOwner, kMember],
          groups: { [kGroup]: { requireMention: false } },
        },
      },
      plugins: { entries: { telegram: { enabled: true } } },
    });
    const desired = resolveDesiredGoogleWorkspaceEntry({ env: { ALPHACLAW_GOOGLE_WORKSPACE_ACCOUNTS: "owner@example.com", ALPHACLAW_GOOGLE_WORKSPACE_SOCKET: socketPath }, rootDir: kRootDir });
    applyGoogleWorkspaceEntry(config, desired, { log: () => {} });
    fs.writeFileSync(path.join(OPENCLAW_DIR, "openclaw.json"), JSON.stringify(config));
    fs.writeFileSync(kOnboardingMarkerPath, JSON.stringify({ live: true }));
    process.env.OPENCLAW_GATEWAY_TOKEN = token;
    gateway = require("../../lib/server/gateway");
    await gateway.startGateway();
    await waitFor(readyzOk, 180_000, "gateway /readyz 200");
    await waitFor(async () => telegram.polls() > 1, 120_000, "telegram polling the fake Bot API");
  }, 6 * 60 * 1000);

  afterAll(async () => {
    try {
      await gateway?.stopGatewayForShutdown?.({ budgetMs: 8000 });
    } catch {}
    for (const pid of require("../../lib/server/gateway-identity").findPortListenerPids?.(port) || []) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    model?.close();
    broker?.close();
    await telegram?.close();
  });

  it(
    "lets the owner's DM reach the broker and keeps a group member's turn off the socket",
    { timeout: kTestTimeoutMs, retry: 0 },
    async () => {
      const owner = await runCase({ name: "the owner in a DM", from: kOwner, chat: kOwner });
      expect(owner.broker.length).toBeGreaterThan(0);
      for (const request of owner.broker) expect(request).toMatchObject({ v: 4, op: "call", account: "owner@example.com", server: "calendar", tool: "list_events", caller: "alphaclaw-google-workspace" });
      expect(owner.broker.every((request) => typeof request.turn_id === "string" && request.turn_id.length > 0)).toBe(true);
      expect(owner.results.some((text) => text.includes("no events today"))).toBe(true);

      const member = await runCase({ name: "a group member who is not the owner", from: kMember, chat: kGroup });
      expect(member.stages).toBeGreaterThan(1);
      expect(member.broker).toEqual([]);
      expect(member.results.length).toBeGreaterThan(0);
      expect(member.results.some((text) => text.includes("no events today"))).toBe(false);
    },
  );
});
