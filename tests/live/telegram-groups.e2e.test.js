// LIVE TIER — Telegram group rules (GST-1975 PR 1) inside the REAL pinned
// OpenClaw gateway, against a fake Telegram Bot API (fixtures/fake-telegram.js)
// and a local model fixture that tries exec in every turn, once directly and
// once through Tool Search's dispatch_action wrapper, and records whether the
// command ran. OpenClaw 2026.11.2 keeps a session's tool definitions the same
// for every sender (prompt cache, #175309) and refuses a denied sender's call
// when it runs, so what the model is offered no longer says who has tools.
// The Groups module writes each group's mode through OpenClaw's own config
// check, the group guard plugin is loaded from lib/plugin/group-guard, and
// every Bot API call the gateway makes is recorded per case:
//   - Approved (Alfred and Wintermute): Garry gets a reply and tools; Alfred's
//     bot gets one reply and no tool, also when it asks for a post into
//     another chat; Mossab (blocked) gets no message;
//   - Trusted people: Harj (actions) gets tools in Security, Sylvia
//     (conversation) a reply with no tool in Home Team, Sylvia in Security
//     nothing;
//   - Silent, Blocked (TEST CHAT) and an unlisted group: no message for
//     anyone, the owner included; strangers and Mossab in DMs: nothing;
//   - the join watcher reads the gateway's own file log, tells the owner once
//     about the unlisted group and leaves TEST CHAT again when re-added;
//   - "Test this group" agrees with what the gateway did for every case;
//   - a mode change applies to the running gateway without a restart;
//   - a blocked person's message in a Trusted people group never reaches
//     another person's turn as context (in an Approved group OpenClaw's own
//     history window still carries it: recorded, not asserted, see the
//     telegram.md "Known limit");
//   - a gateway that starts over a damaged group-rules.json still drops a
//     blocked person, from the last-good copy AlphaClaw saves beside it, and
//     still serves the owner and everyone else in an Approved group.
// Run with:
//   OPENCLAW_LIVE_E2E=1 npx vitest run tests/live/telegram-groups.e2e.test.js
const fs = require("fs");
const http = require("http");
const path = require("path");

const liveHelpers = require("./live-helpers");
const kRootDir = liveHelpers.mkTemp("alphaclaw-live-telegram-groups-root-");
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
const kTestTimeoutMs = 12 * 60 * 1000;

const kGarry = "6167919517";
const kGarry2 = "8756803657";
const kHarj = "8793019333";
const kSylvia = "8771141478";
const kAlfredBot = "8460266606";
const kMossab = "435921418";
const kStranger = "7100000777";
const kAlfredGroup = "-1004458560180";
const kSecurity = "-1003864658058";
const kHomeTeam = "-1005297954291";
const kGarrysAgents = "-1003972409126";
const kTestChat = "-5235086834";
const kWintermute = "-1003883767414";
const kNewGroup = "-1009876543210";
const kBotToken = "7000000001:LIVEfakeTOKENforTHEgroupsTEST000000";

const world = {
  chats: {
    [kAlfredGroup]: { type: "supergroup", title: "Alfred and Wintermute" },
    [kSecurity]: { type: "supergroup", title: "Security" },
    [kHomeTeam]: { type: "supergroup", title: "Home Team" },
    [kGarrysAgents]: { type: "supergroup", title: "Garry's Agents" },
    [kTestChat]: { type: "group", title: "TEST CHAT" },
    [kWintermute]: { type: "supergroup", title: "Wintermute" },
    [kNewGroup]: { type: "supergroup", title: "Stranger Startup Chat" },
    [kStranger]: { type: "private", title: "Stranger" },
    [kMossab]: { type: "private", title: "Mossab" },
  },
  users: {
    [kGarry]: { first: "Garry" },
    [kHarj]: { first: "Harj" },
    [kSylvia]: { first: "Sylvia" },
    [kAlfredBot]: { first: "Alfred", bot: true, username: "alfred_bot" },
    [kMossab]: { first: "Mossab" },
    [kStranger]: { first: "Stranger" },
  },
};

const kSearchControls = new Set(["tool_search", "tool_describe", "dispatch_action"]);
const execMarker = (tag, via) => path.join(kRootDir, "exec-" + tag + "-" + via);

const textOf = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text || "").join(" ") : "";

describeLive("LIVE Telegram group rules against the " + readDeclaredPin() + " pin", () => {
  let gateway;
  let model;
  let telegram;
  let groups;
  let joinWatch;
  let port;
  const notices = [];
  const offered = new Map();
  const probeStage = new Map();
  const contexts = new Map();
  const results = [];

  const readyzOk = async () => {
    try {
      return (await fetch("http://127.0.0.1:" + port + "/readyz")).status === 200;
    } catch {
      return false;
    }
  };

  // One case: inject a message carrying a tag, then wait for either the
  // tagged reply in that chat or a quiet window, and return what happened.
  let caseNo = 0;
  const runCase = async ({ name, from, chat, text = "hello", expectReply }) => {
    caseNo += 1;
    const tag = "gr" + caseNo + "x" + Math.random().toString(36).slice(2, 7);
    const startedAt = Date.now();
    telegram.inject({ from, chat, text: text + " (case " + tag + ")" });
    await waitFor(async () => telegram.pending() === 0, 60_000, name + " update consumed");
    const replied = () => telegram.delivered.some((entry) => entry.chat === String(chat) && entry.text.includes(tag));
    if (expectReply) await waitFor(async () => replied(), 150_000, name + " reply");
    else await new Promise((resolve) => setTimeout(resolve, 12_000));
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const calls = telegram.calls.filter((call) => call.at >= startedAt);
    const outcome = {
      name,
      from,
      chat,
      tag,
      replied: replied(),
      sends: calls.filter((call) => /^send(Message|Photo|Document|MediaGroup)$/.test(call.method)).map((call) => call.chat + ":" + (call.text || "").slice(0, 60)),
      calls: calls.map((call) => call.method + (call.action ? "(" + call.action + ")" : "") + "@" + call.chat),
      offered: offered.has(tag) ? offered.get(tag) : null,
      ran: { direct: fs.existsSync(execMarker(tag, "direct")), wrapped: fs.existsSync(execMarker(tag, "wrapped")) },
    };
    outcome.actions = outcome.offered === null ? null : outcome.ran.direct || outcome.ran.wrapped ? "all" : "none";
    results.push(outcome);
    console.log("[live] telegram-groups case " + JSON.stringify({ name: outcome.name, replied: outcome.replied, sends: outcome.sends, calls: outcome.calls, offered: outcome.offered ? outcome.offered.length : null, ran: outcome.ran, actions: outcome.actions }));
    return outcome;
  };

  beforeAll(async () => {
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
        // OpenClaw appends a runtime-context message that quotes earlier turns,
        // so the case being answered is the highest-numbered tag in the request.
        const tags = messages
          .filter((m) => m.role === "user")
          .flatMap((m) => [...textOf(m.content).matchAll(/case (gr(\d+)x[a-z0-9]+)/g)])
          .sort((a, b) => Number(b[2]) - Number(a[2]));
        const tag = tags[0]?.[1];
        if (tag && !contexts.has(tag)) contexts.set(tag, messages.map((m) => textOf(m.content)).join("\n"));
        const stage = tag ? probeStage.get(tag) || 0 : 0;
        if (tag) probeStage.set(tag, stage + 1);
        const lastTool = [...messages].reverse().find((m) => m.role === "tool");
        console.log("[live] model request " + JSON.stringify({ tag: tag || null, stage, messages: messages.length, tools: names.length, lastTool: lastTool ? textOf(lastTool.content).slice(0, 160) : null }));
        const chunk = (delta, finish = null) =>
          "data: " + JSON.stringify({ id: "groups-live", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (tag && !offered.has(tag)) offered.set(tag, names.filter((name) => !kSearchControls.has(name)));
        const probe =
          tag && stage === 0 && names.includes("exec")
            ? { name: "exec", args: { command: "touch " + execMarker(tag, "direct") } }
            : tag && stage === 1 && names.includes("dispatch_action")
              ? { name: "dispatch_action", args: { id: "exec", args: { command: "touch " + execMarker(tag, "wrapped") } } }
              : null;
        if (probe) {
          res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_probe_" + stage + "_" + tag, type: "function", function: { name: probe.name, arguments: JSON.stringify(probe.args) } }] }));
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
    const telegramRoot = "http://127.0.0.1:" + telegramPort;

    const { OPENCLAW_DIR, kOnboardingMarkerPath } = require("../../lib/server/constants");
    port = 19500 + Math.floor(Math.random() * 90);
    const token = "live-telegram-groups-token-000000000000";
    const workspace = path.join(OPENCLAW_DIR, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(process.env.NODE_COMPILE_CACHE, { recursive: true });
    const logDir = path.join(kRootDir, "logs", "openclaw");
    fs.mkdirSync(logDir, { recursive: true });
    const { ensureManagedOpenclawExecDefaults } = require("../../lib/server/exec-defaults-config");
    const { applyGroupGuardEntry } = require("../../lib/server/telegram-group-guard-entry");
    const { config } = ensureManagedOpenclawExecDefaults({
      gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
      // heartbeat.target "none": OpenClaw's first heartbeat alert DMs the
      // owner (Garry here) at a moment no case controls, and a case that
      // expects no sends then counts it.
      agents: { defaults: { workspace, model: { primary: "fixture/fixture" }, heartbeat: { target: "none" } } },
      models: { providers: { fixture: {
        baseUrl: "http://127.0.0.1:" + model.address().port + "/v1",
        api: "openai-completions",
        apiKey: "local-model-fixture",
        models: [{ id: "fixture", name: "fixture", contextWindow: 128000, maxTokens: 1024 }],
      } } },
      logging: { file: path.join(logDir, "openclaw-YYYY-MM-DD.log") },
      commands: { ownerAllowFrom: ["telegram:" + kGarry, "telegram:" + kGarry2] },
      channels: {
        telegram: {
          enabled: true,
          botToken: kBotToken,
          apiRoot: telegramRoot,
          dmPolicy: "allowlist",
          allowFrom: [kGarry, kGarry2],
          groupPolicy: "allowlist",
          groupAllowFrom: [kGarry, kGarry2],
          groups: {
            [kWintermute]: { requireMention: false },
            [kAlfredGroup]: { requireMention: false },
            [kSecurity]: { requireMention: false },
            [kHomeTeam]: { requireMention: false },
            [kGarrysAgents]: { requireMention: false },
            [kTestChat]: { requireMention: false },
          },
        },
      },
      plugins: { entries: { telegram: { enabled: true } } },
    });
    applyGroupGuardEntry(config, { rootDir: kRootDir, log: () => {} });
    fs.writeFileSync(path.join(OPENCLAW_DIR, "openclaw.json"), JSON.stringify(config));
    fs.writeFileSync(kOnboardingMarkerPath, JSON.stringify({ live: true }));
    process.env.OPENCLAW_GATEWAY_TOKEN = token;
    gateway = require("../../lib/server/gateway");
    const { execFileCmd } = require("../../lib/server/commands").createCommands({ gatewayEnv: gateway.gatewayEnv });
    const { createTelegramApi } = require("../../lib/server/telegram-api");
    const { createTelegramGroups, createOpenclawPatchValidator } = require("../../lib/server/telegram-groups");
    const { createTelegramJoinWatch } = require("../../lib/server/telegram-join-watch");
    groups = createTelegramGroups({
      openclawDir: OPENCLAW_DIR,
      rootDir: kRootDir,
      telegramApi: createTelegramApi(kBotToken, { apiBase: telegramRoot }),
      validatePatch: createOpenclawPatchValidator({ execFileCmd, gatewayEnv: gateway.gatewayEnv }),
      log: (line) => console.log(line),
    });
    joinWatch = createTelegramJoinWatch({
      openclawDir: OPENCLAW_DIR,
      rootDir: kRootDir,
      groups,
      notify: async (message, opts) => {
        notices.push({ message, opts });
        return { ok: true };
      },
      log: (line) => console.log(line),
    });

    const set = async (groupId, body) => {
      const listed = groups.list().groups.find((group) => group.groupId === groupId);
      return groups.setPolicy({ groupId, body: { convert: true, ...body }, ifMatch: listed.revision });
    };
    await set(kAlfredGroup, { mode: "approved" });
    await set(kWintermute, { mode: "approved" });
    await set(kSecurity, { mode: "trusted", trusted: [{ id: kHarj, scope: "actions", label: "Harj" }] });
    await set(kHomeTeam, { mode: "trusted", trusted: [{ id: kSylvia, scope: "conversation", label: "Sylvia" }] });
    await set(kGarrysAgents, { mode: "silent" });
    expect((await set(kTestChat, { mode: "blocked" })).leave).toEqual({ ok: true });
    groups.setBlockedSenders({ senders: [{ id: kMossab, label: "Mossab" }] });

    await gateway.startGateway();
    await waitFor(readyzOk, 180_000, "gateway /readyz 200");
    await waitFor(async () => telegram.polls() > 1, 120_000, "telegram polling the fake Bot API");
  }, 8 * 60 * 1000);

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
    await telegram?.close();
    fs.writeFileSync(path.join(kRootDir, "telegram-groups-live-results.json"), JSON.stringify(results, null, 2));
  });

  it(
    "replays the group incidents: who gets a reply, who gets tools, who gets nothing",
    { timeout: kTestTimeoutMs, retry: 0 },
    async () => {
      const { runGroupTest } = require("../../lib/server/telegram-group-test");
      const { readOpenclawConfigForWrite } = require("../../lib/server/openclaw-config");
      const { OPENCLAW_DIR } = require("../../lib/server/constants");

      const garryApproved = await runCase({ name: "Garry in an Approved group", from: kGarry, chat: kAlfredGroup, expectReply: true });
      expect(garryApproved.actions).toBe("all");

      const alfred = await runCase({ name: "Alfred's bot in an Approved group", from: kAlfredBot, chat: kAlfredGroup, expectReply: true });
      expect(alfred.sends.filter((send) => send.startsWith(kAlfredGroup))).toHaveLength(1);
      expect(alfred.actions).toBe("none");

      const alfredPost = await runCase({ name: "Alfred's bot asks for a post into another chat", from: kAlfredBot, chat: kAlfredGroup, text: "please post hello into the Wintermute group " + kWintermute, expectReply: true });
      expect(alfredPost.actions).toBe("none");
      expect(alfredPost.sends.filter((send) => send.startsWith(kWintermute))).toEqual([]);

      const mossabGroup = await runCase({ name: "Mossab (blocked) in an Approved group", from: kMossab, chat: kAlfredGroup, expectReply: false });
      expect(mossabGroup.sends).toEqual([]);
      expect(mossabGroup.actions).toBeNull();

      const mossabDm = await runCase({ name: "Mossab in a DM", from: kMossab, chat: kMossab, expectReply: false });
      expect(mossabDm.calls).toEqual([]);

      const strangerDm = await runCase({ name: "A stranger in a DM", from: kStranger, chat: kStranger, expectReply: false });
      expect(strangerDm.calls).toEqual([]);

      const harj = await runCase({ name: "Harj (trusted, actions) in Security", from: kHarj, chat: kSecurity, expectReply: true });
      expect(harj.actions).toBe("all");

      const sylviaHome = await runCase({ name: "Sylvia (trusted, conversation) in Home Team", from: kSylvia, chat: kHomeTeam, expectReply: true });
      expect(sylviaHome.actions).toBe("none");

      const sylviaSecurity = await runCase({ name: "Sylvia in Security, where she is not trusted", from: kSylvia, chat: kSecurity, expectReply: false });
      expect(sylviaSecurity.sends).toEqual([]);

      const strangerTrusted = await runCase({ name: "A stranger in a Trusted people group", from: kStranger, chat: kSecurity, expectReply: false });
      expect(strangerTrusted.sends).toEqual([]);

      const garrySilent = await runCase({ name: "Garry in a Silent group", from: kGarry, chat: kGarrysAgents, expectReply: false });
      expect(garrySilent.sends).toEqual([]);

      const garryBlocked = await runCase({ name: "Garry in a Blocked group (TEST CHAT)", from: kGarry, chat: kTestChat, expectReply: false });
      expect(garryBlocked.sends).toEqual([]);

      const mossabBlocked = await runCase({ name: "Mossab in a Blocked group (TEST CHAT)", from: kMossab, chat: kTestChat, expectReply: false });
      expect(mossabBlocked.sends).toEqual([]);

      telegram.injectAdded({ chat: kNewGroup, by: kStranger });
      const strangerNew = await runCase({ name: "A stranger in a group nobody approved", from: kStranger, chat: kNewGroup, expectReply: false });
      expect(strangerNew.sends).toEqual([]);

      for (const outcome of [garrySilent, garryBlocked, mossabBlocked, strangerNew, sylviaSecurity, strangerTrusted]) {
        expect(outcome.calls.every((call) => call.startsWith("getChat@")), outcome.name + ": " + outcome.calls.join(", ")).toBe(true);
      }

      // "Test this group" must say what the gateway just did.
      const cfg = readOpenclawConfigForWrite({ openclawDir: OPENCLAW_DIR });
      const state = groups.readState();
      const mismatches = [];
      for (const outcome of results) {
        if (!String(outcome.chat).startsWith("-")) continue;
        const answer = await runGroupTest({ cfg, state, groupId: String(outcome.chat), senderIds: [String(outcome.from)] });
        const row = answer.senders.find((sender) => sender.id === String(outcome.from));
        const predictedReply = row.reply !== "never";
        const observedActions = outcome.actions;
        const ok = predictedReply === outcome.replied && (!outcome.replied || observedActions === row.actions);
        console.log("[live] test-button " + JSON.stringify({ name: outcome.name, predicted: { reply: row.reply, actions: row.actions, reason: row.reason }, observed: { replied: outcome.replied, actions: observedActions }, ok }));
        if (!ok) mismatches.push(outcome.name);
      }
      expect(mismatches).toEqual([]);

      // The join watcher reads the gateway's own file log.
      await waitFor(async () => {
        await joinWatch.check();
        return notices.some((notice) => notice.message.includes(kNewGroup));
      }, 60_000, "join watch notice for the unlisted group");
      expect(notices.filter((notice) => notice.message.includes(kNewGroup))).toHaveLength(1);

      const leavesBefore = telegram.calls.filter((call) => call.method === "leaveChat" && call.chat === kTestChat).length;
      telegram.injectAdded({ chat: kTestChat, by: kMossab });
      await waitFor(async () => {
        await joinWatch.check();
        return telegram.calls.filter((call) => call.method === "leaveChat" && call.chat === kTestChat).length > leavesBefore;
      }, 60_000, "join watch leaves TEST CHAT again");
      await joinWatch.check();
      expect(notices.filter((notice) => notice.message.includes(kTestChat))).toEqual([]);
      expect(telegram.delivered.filter((entry) => entry.chat === kTestChat || entry.chat === kNewGroup)).toEqual([]);

      // A mode change applies to the running gateway without a restart.
      const listed = groups.list().groups.find((group) => group.groupId === kGarrysAgents);
      await groups.setPolicy({ groupId: kGarrysAgents, body: { mode: "approved" }, ifMatch: listed.revision });
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      const garryReopened = await runCase({ name: "Garry in the same group after it is approved", from: kGarry, chat: kGarrysAgents, expectReply: true });
      expect(garryReopened.actions).toBe("all");
      expect(await readyzOk()).toBe(true);
    },
  );

  it(
    "keeps a blocked person's message out of another person's turn in a Trusted people group",
    { timeout: kTestTimeoutMs, retry: 0 },
    async () => {
      const trustedMarker = "blocked-context-trusted-" + Math.random().toString(36).slice(2, 8);
      const mossabTrusted = await runCase({ name: "Mossab (blocked) in a Trusted people group", from: kMossab, chat: kSecurity, text: trustedMarker, expectReply: false });
      expect(mossabTrusted.sends).toEqual([]);
      const harjAfter = await runCase({ name: "Harj in the same group right after", from: kHarj, chat: kSecurity, expectReply: true });
      expect(contexts.get(harjAfter.tag)).toBeTruthy();
      expect(contexts.get(harjAfter.tag)).not.toContain(trustedMarker);

      const approvedMarker = "blocked-context-approved-" + Math.random().toString(36).slice(2, 8);
      const mossabApproved = await runCase({ name: "Mossab (blocked) in an Approved group, as context", from: kMossab, chat: kAlfredGroup, text: approvedMarker, expectReply: false });
      expect(mossabApproved.sends).toEqual([]);
      const garryAfter = await runCase({ name: "Garry in the same Approved group right after", from: kGarry, chat: kAlfredGroup, expectReply: true });
      console.log("[live] blocked-context " + JSON.stringify({ mode: "approved", presentInOwnersTurn: String(contexts.get(garryAfter.tag) || "").includes(approvedMarker) }));
    },
  );

  it(
    "drops a blocked person and still serves the owner when the gateway starts over a damaged rules file",
    { timeout: kTestTimeoutMs, retry: 0 },
    async () => {
      const { resolveStatePaths } = require("../../lib/server/telegram-groups");
      const { statePath } = resolveStatePaths(kRootDir);
      const saved = fs.readFileSync(statePath, "utf8");
      fs.writeFileSync(statePath, "{ damaged by hand");
      try {
        const restart = await gateway.restartGateway(() => {}, { source: "api:restart", reason: "live damaged group rules file" });
        console.log("[live] telegram-groups restart " + JSON.stringify({ ok: restart?.ok ?? null }));
        await waitFor(readyzOk, 180_000, "gateway /readyz 200 after the restart");
        const pollsBefore = telegram.polls();
        await waitFor(async () => telegram.polls() > pollsBefore + 1, 120_000, "telegram polling again after the restart");

        const mossab = await runCase({ name: "Mossab (blocked) after a restart over a damaged rules file", from: kMossab, chat: kAlfredGroup, expectReply: false });
        expect(mossab.sends).toEqual([]);
        expect(mossab.actions).toBeNull();
        const guest = await runCase({ name: "Alfred's bot after a restart over a damaged rules file", from: kAlfredBot, chat: kAlfredGroup, expectReply: true });
        expect(guest.sends.length).toBeGreaterThan(0);
        const garry = await runCase({ name: "Garry after a restart over a damaged rules file", from: kGarry, chat: kAlfredGroup, expectReply: true });
        expect(garry.actions).toBe("all");
      } finally {
        fs.writeFileSync(statePath, saved);
      }
    },
  );
});
