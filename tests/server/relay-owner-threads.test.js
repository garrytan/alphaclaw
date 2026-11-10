const fs = require("fs");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { registerRelayRoutes } = require("../../lib/server/routes/relay");
const { relayPaths } = require("../../lib/server/relay/constants");
const { kRelayGuardPluginId } = require("../../lib/server/relay/guard-entry");
const { classifyAnchor, classifyRisk, gatewayRestartOf } = require("../../lib/plugin/relay-guard/confirm");
const { kOwnerThreadPluginActions } = require("../../lib/plugin/relay-guard/policy");
const { kOtherOwner, guardedConfig, setup, expectHeld, expectHeldWithTap } = require("./helpers/relay-attested-harness");

// GST-2323 PR2: the owner's own attested Capy thread (attested binding, the
// box's org, an owner on ALPHACLAW_RELAY_CAPY_OWNERS) is trusted like the
// owner. On top of PR1's untapped high-risk calls it gets the delegate
// never-list items the owner's own turn has: sends without a carried
// approval, cron, plugin installs, secret-store reads, gateway config reads,
// and a gateway restart, which runs through AlphaClaw's attributed restart
// ladder and never inside OpenClaw. No confirmation row, link or notice
// anywhere. The trust anchor stays refused. Every other sender keeps
// today's policy, holds and taps.
const kSecret = "a".repeat(64);

const ownerCalls = [
  ["message without an approval", "message", { action: "send", channel: "telegram", target: "123", message: "the deploy finished" }],
  ["cron add", "cron", { action: "add", job: { name: "nightly", prompt: "summarize the day" } }],
  ["cron run", "cron", { action: "run", jobId: "job-1" }],
  ["plugins install", "plugins", { action: "install", source: "official", pluginId: "voice-call" }],
  ["plugins list", "plugins", { action: "list" }],
  ["secrets list", "secrets", { action: "list" }],
  ["gateway config.get", "gateway", { action: "config.get", path: "gateway.bind" }],
  ["gateway config.schema.lookup", "gateway", { action: "config.schema.lookup", path: "gateway" }],
];

// The internal route as AlphaClaw serves it, with a recording ladder in
// place of routes/system.js requestGatewayRestart.
const startAlphaclaw = async (ctx, { refusal = null } = {}) => {
  fs.writeFileSync(path.join(ctx.rootDir, "relay", "internal.secret"), kSecret, { mode: 0o600 });
  const asked = [];
  const app = express();
  app.use(express.json());
  registerRelayRoutes({
    app,
    requireAuth: (req, res, next) => next(),
    relayService: { config: { enabled: true }, paths: relayPaths(ctx.rootDir), isInternalSecret: (value) => value === kSecret, isReady: () => true },
    requestGatewayRestart: (options) => {
      asked.push(options);
      return refusal ? { refusal } : { operationId: "abcd1234-5678-op" };
    },
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  return { app, asked, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
};

describe("relay owner threads (GST-2323 PR2): the never-list opens for the owner's attested thread only", () => {
  let ctx;
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });

  it("opens sends, cron, plugin installs, secret-store reads and gateway config reads with zero rows and zero notices", async () => {
    ctx = setup();
    const { agent } = await ctx.attestedAgent();
    const run = await ctx.deliver(agent);
    expect(ctx.admin.sends.at(-1).message).toContain("To restart the gateway, run openclaw gateway restart as a command of its own");
    for (const [label, toolName, params] of ownerCalls) expect(await ctx.call(run, toolName, params), label).toEqual({});
    expect(ctx.confirmationCount()).toBe(0);
    ctx.confirmations.tick();
    expect(ctx.notices).toEqual([]);
  });

  it("keeps the rest of each tool and the rest of the never-list withheld from the owner's thread", async () => {
    ctx = setup();
    const { agent } = await ctx.attestedAgent();
    const run = await ctx.deliver(agent);
    for (const [label, toolName, params] of [
      ["secrets request", "secrets", { action: "request", name: "STRIPE_KEY" }],
      ["secrets delete", "secrets", { action: "delete", name: "STRIPE_KEY" }],
      ["gateway update.run", "gateway", { action: "update.run" }],
      ["plugins with an unknown action", "plugins", { action: "publish" }],
      ["cron with an unknown action", "cron", { action: "purge" }],
      ["sessions_spawn", "sessions_spawn", { task: "x" }],
      ["subagents", "subagents", { action: "list" }],
      ["browser", "browser", { action: "open" }],
      ["the relay's own MCP tools", "relay__relay_send", { to: "x", text: "y" }],
    ]) {
      const result = await ctx.call(run, toolName, params);
      expect(result.block, label).toBe(true);
      expect(result.blockReason, label).toContain("[relay-guard]");
    }
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("refuses the same calls to an unattested delegate, another owner's attested thread and a peer, as today", async () => {
    ctx = setup();
    const unattested = await ctx.deliver(ctx.oauthDelegate().agent);
    const other = await ctx.deliver((await ctx.attestedAgent({ user: kOtherOwner, thread: "OTHR-2", sub: "org/org_garry/project/proj_1/thread/OTHR-2" })).agent);
    const peer = await ctx.deliver("lupe");
    expect(ctx.admin.sends.find((sent) => sent.message.includes("@" + unattested.ctx.sessionKey.split("relay-")[1]))?.message).toContain("A delegate session cannot send to other people");
    for (const run of [unattested, other, peer]) {
      for (const [label, toolName, params] of [...ownerCalls, ["gateway restart", "gateway", { action: "restart" }]]) {
        const result = await ctx.call(run, toolName, params);
        expect(result.block, label).toBe(true);
        expect(result.blockReason, label).toMatch(/is not available (to a delegate relay session|in a relay session)/);
      }
    }
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("decides the owner thread per call: a revoked Capy grant closes the never-list again mid-turn", async () => {
    ctx = setup();
    const { agent } = await ctx.attestedAgent();
    const run = await ctx.deliver(agent);
    expect(await ctx.call(run, "secrets", { action: "list" })).toEqual({});
    const capy = ctx.store().grants.list().find((grant) => grant.principalKind === "capy");
    ctx.relayRemote.revokeGrant({ id: capy.id, actor: "legacy" });
    expect((await ctx.call(run, "secrets", { action: "list" })).block).toBe(true);
  });

  it("lists the plugins tool actions of the pinned OpenClaw", () => {
    expect(kOwnerThreadPluginActions).toEqual(["list", "inspect", "search", "install", "enable", "disable", "uninstall", "reload", "reloadandresume"]);
  });
});

describe("relay owner threads (GST-2323 PR2): a gateway restart runs through AlphaClaw's attributed ladder", () => {
  let ctx;
  let alphaclaw;
  const savedPort = process.env.PORT;
  afterEach(async () => {
    await alphaclaw?.close();
    alphaclaw = null;
    ctx?.cleanup();
    ctx = null;
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
  });

  it.each([
    ["openclaw gateway restart", "exec", { command: "openclaw gateway restart" }],
    ["openclaw gateway restart with options", "exec", { command: "openclaw --log-level info gateway restart --wait 30000ms 2>&1" }],
    ["alphaclaw admin POST /api/gateway/restart", "exec", { command: "alphaclaw admin POST /api/gateway/restart" }],
    ["the gateway tool's restart", "gateway", { action: "restart" }],
  ])("asks AlphaClaw for %s with source relay:<thread code>, with zero rows and zero notices", async (_label, toolName, params) => {
    ctx = setup();
    alphaclaw = await startAlphaclaw(ctx);
    process.env.PORT = String(alphaclaw.port);
    const { agent } = await ctx.attestedAgent();
    const run = await ctx.deliver(agent);
    const result = await ctx.call(run, toolName, params);
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain("AlphaClaw is restarting the gateway through its restart ladder (operation abcd1234, recorded as relay:ALPH-85)");
    expect(alphaclaw.asked).toEqual([{ actor: "relay", source: "relay:ALPH-85", reason: "relay_message=" + run.messageId }]);
    expect(ctx.guardLogs.some((line) => line.includes("gateway restart asked of AlphaClaw") && line.includes("outcome=started op=abcd1234"))).toBe(true);
    expect(ctx.confirmationCount()).toBe(0);
    ctx.confirmations.tick();
    expect(ctx.notices).toEqual([]);
  });

  it("refuses a restart asked inside another command, so none runs around the ladder", async () => {
    ctx = setup();
    alphaclaw = await startAlphaclaw(ctx);
    process.env.PORT = String(alphaclaw.port);
    const { agent } = await ctx.attestedAgent();
    const run = await ctx.deliver(agent);
    for (const command of [
      "openclaw gateway restart && echo done",
      "nohup openclaw gateway restart &",
      "sh -c 'openclaw gateway restart'",
      "openclaw gateway call gateway.restart.request",
      "alphaclaw admin POST /api/gateway/restart; sleep 1",
    ]) {
      const result = await ctx.call(run, "exec", { command });
      expect(result.block, command).toBe(true);
      expect(result.blockReason, command).toContain("restarts the gateway only through AlphaClaw's restart ladder");
    }
    expect(alphaclaw.asked).toEqual([]);
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("passes on AlphaClaw's refusal and an unreachable server, and starts nothing", async () => {
    ctx = setup();
    alphaclaw = await startAlphaclaw(ctx, { refusal: { statusCode: 409, body: { ok: false, code: "operation_in_progress", error: "Another gateway operation or relaunch is in progress." } } });
    process.env.PORT = String(alphaclaw.port);
    const { agent } = await ctx.attestedAgent();
    const run = await ctx.deliver(agent);
    expect((await ctx.call(run, "exec", { command: "openclaw gateway restart" })).blockReason).toContain(
      "AlphaClaw did not restart the gateway (operation_in_progress: Another gateway operation or relaunch is in progress.)",
    );
    await alphaclaw.close();
    alphaclaw = null;
    expect((await ctx.call(run, "exec", { command: "openclaw gateway restart" })).blockReason).toContain("AlphaClaw could not be reached to restart the gateway, so nothing was restarted");
  });

  it("answers the internal route only for a running turn of the owner's attested thread, with the internal secret", async () => {
    ctx = setup();
    alphaclaw = await startAlphaclaw(ctx);
    const { agent } = await ctx.attestedAgent();
    const owner = await ctx.deliver(agent);
    const unattested = await ctx.deliver(ctx.oauthDelegate().agent);
    const other = await ctx.deliver((await ctx.attestedAgent({ user: kOtherOwner, thread: "OTHR-2", sub: "org/org_garry/project/proj_1/thread/OTHR-2" })).agent);
    const post = (messageId, secret = kSecret) => request(alphaclaw.app).post("/relay/internal/gateway-restart").set("Authorization", "Bearer " + secret).send({ message_id: messageId });
    expect((await post(owner.messageId, "b".repeat(64))).status).toBe(404);
    expect((await post(unattested.messageId)).body).toMatchObject({ ok: false, code: "not_owner_thread" });
    expect((await post(other.messageId)).body).toMatchObject({ ok: false, code: "not_owner_thread" });
    expect((await post("999999")).body).toMatchObject({ ok: false, code: "not_owner_thread" });
    expect((await post("../x")).body).toMatchObject({ ok: false, code: "invalid_input" });
    expect(alphaclaw.asked).toEqual([]);
    const accepted = await post(owner.messageId);
    expect(accepted.status).toBe(202);
    expect(accepted.body).toEqual({ ok: true, operationId: "abcd1234-5678-op", attached: false, source: "relay:ALPH-85" });
  });

  it("leaves every other sender's restart paths as they are today", async () => {
    ctx = setup();
    alphaclaw = await startAlphaclaw(ctx);
    process.env.PORT = String(alphaclaw.port);
    const run = await ctx.deliver(ctx.oauthDelegate().agent);
    expectHeldWithTap(ctx, run, "exec", { command: "alphaclaw admin POST /api/gateway/restart" });
    expect((await ctx.call(run, "gateway", { action: "restart" })).blockReason).toContain("gateway is not available to a delegate relay session");
    expect(alphaclaw.asked).toEqual([]);
  });
});

describe("relay owner threads (GST-2323 PR2): the trust anchor stays refused", () => {
  let ctx;
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });

  const expectAnchor = (result, label) => {
    expect(result.block, label).toBe(true);
    expect(result.blockReason, label).toContain("would change what decides relay trust on this box");
    expect(result.blockReason, label).not.toMatch(/rc_[a-f0-9]{16}/);
  };

  it("refuses an openclaw config or plugins change whose group, verb or key the shell fills in", async () => {
    ctx = setup();
    const run = await ctx.deliver((await ctx.attestedAgent()).agent);
    for (const command of [
      "openclaw config $(echo set) plugins.entries.relay-guard.enabled false",
      "openclaw config \x60echo set\x60 plugins.entries.relay-guard.enabled false",
      "V=set; openclaw config $V plugins.entries.relay-guard.enabled false",
      "openclaw config \"$V\" plugins.entries.relay-guard.enabled false",
      "openclaw $(echo config) set plugins.entries.relay-guard.enabled false",
      "G=config; openclaw $G set plugins.entries.relay-guard.enabled false",
      "OC=openclaw; $OC config set plugins.entries.relay-guard.enabled false",
      "$(which openclaw) config set plugins.entries.relay-guard.enabled false",
      "P=plugins; openclaw $P disable relay-guard",
      "openclaw plugins $(echo disable) relay-guard",
      "echo plugins.entries.relay-guard.enabled | xargs openclaw config unset",
      "openclaw config patch --file ./guard-off.json5",
      "openclaw config set --batch-file ./batch.json",
      "openclaw gateway call config.patch --params '{}'",
      "openclaw plugins reload",
    ]) {
      expectAnchor(await ctx.call(run, "exec", { command }), command);
    }
    expect(ctx.confirmationCount()).toBe(0);
    ctx.confirmations.tick();
    expect(ctx.notices).toEqual([]);
  });

  it("refuses a guard change written into a file openclaw.json includes, resolved as OpenClaw does, and keeps other include edits open", async () => {
    ctx = setup();
    const dir = path.dirname(ctx.openclawJson);
    const root = guardedConfig(ctx.rootDir);
    fs.mkdirSync(path.join(dir, "parts"), { recursive: true });
    fs.writeFileSync(ctx.openclawJson, JSON.stringify({ ...root, $include: "./parts/extra.json" }, null, 2));
    fs.writeFileSync(path.join(dir, "parts", "extra.json"), JSON.stringify({ $include: "./deeper.json", gateway: { mode: "local" } }, null, 2));
    fs.writeFileSync(path.join(dir, "parts", "deeper.json"), JSON.stringify({ agents: { defaults: {} } }, null, 2));
    const run = await ctx.deliver((await ctx.attestedAgent()).agent);
    const extra = path.join(dir, "parts", "extra.json");
    const deeper = path.join(dir, "parts", "deeper.json");
    for (const [label, toolName, params] of [
      ["write the included file", "write", { path: extra, content: JSON.stringify({ plugins: { deny: [kRelayGuardPluginId] } }) }],
      ["edit the included file", "edit", { path: extra, old_string: '"mode": "local"', new_string: '"mode": "local" }, "plugins": { "enabled": false' }],
      ["write a file two includes deep", "write", { path: deeper, content: JSON.stringify({ plugins: { deny: [kRelayGuardPluginId] } }) }],
      ["relative path into the include", "write", { path: "../parts/deeper.json", content: JSON.stringify({ plugins: { load: { paths: ["/tmp/evil"] } } }) }],
      ["an include that no longer parses", "write", { path: extra, content: "{ plugins: " }],
      ["a patch to the included file", "apply_patch", { input: "*** Begin Patch\n*** Update File: " + extra + "\n@@\n-x\n+y\n*** End Patch" }],
      ["a new include in the included file", "write", { path: extra, content: JSON.stringify({ $include: ["./deeper.json", "./more.json"] }) }],
      ["a shell edit of the included file", "exec", { command: "sed -i s/local/remote/ " + extra }],
      ["a shell edit by its name", "exec", { command: "cd " + path.join(dir, "parts") + " && python3 -c 'x' > deeper.json" }],
    ]) {
      expectAnchor(await ctx.call(run, toolName, params), label);
    }
    for (const [label, toolName, params] of [
      ["write the included file", "write", { path: extra, content: JSON.stringify({ $include: "./deeper.json", gateway: { mode: "remote" } }) }],
      ["edit two includes deep", "edit", { path: deeper, old_string: '"defaults": {}', new_string: '"defaults": { "model": "x" }' }],
      ["read the include", "exec", { command: "cat " + extra }],
    ]) {
      expect(await ctx.call(run, toolName, params), label).toEqual({});
    }
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("refuses the plugins tool's changes to the guard", async () => {
    ctx = setup();
    const run = await ctx.deliver((await ctx.attestedAgent()).agent);
    for (const params of [
      { action: "disable", pluginId: kRelayGuardPluginId },
      { action: "uninstall", pluginId: kRelayGuardPluginId },
      { action: "reload", pluginId: kRelayGuardPluginId },
      { action: "reloadAndResume", pluginId: kRelayGuardPluginId },
      { action: "reload" },
      { action: "disable" },
      { action: "install", source: "clawhub", packageName: "@someone/relay-guard" },
    ]) {
      expectAnchor(await ctx.call(run, "plugins", params), JSON.stringify(params));
    }
    expect(await ctx.call(run, "plugins", { action: "disable", pluginId: "voice-call" })).toEqual({});
  });

  it("refuses an exec whose workdir lies inside the relay's directory or AlphaClaw's installed code, unless it only reads", async () => {
    ctx = setup();
    const run = await ctx.deliver((await ctx.attestedAgent()).agent);
    const relay = path.join(ctx.rootDir, "relay");
    const repoRoot = path.resolve(__dirname, "..", "..");
    for (const [label, params] of [
      ["a note in the relay dir", { command: "echo x > notes.md", workdir: relay }],
      ["touch in the relay dir", { command: "touch x", workdir: relay }],
      ["a script in the relay dir", { command: "node -e 1", workdir: relay + "/" }],
      ["npm in the installed code", { command: "npm install left-pad", workdir: repoRoot }],
      ["the relay dir by a relative workdir", { command: "touch x", workdir: "../../relay" }],
    ]) {
      expectAnchor(await ctx.call(run, "exec", params), label);
    }
    expect(await ctx.call(run, "exec", { command: "ls -la", workdir: relay })).toEqual({});
    expect(await ctx.call(run, "exec", { command: "touch x", workdir: path.join(ctx.rootDir, "work") })).toEqual({});
  });
});

describe("relay owner threads (GST-2323 PR2): over-refusals fixed", () => {
  let ctx;
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });

  const harnessEdit = (box) => ({
    path: box.openclawJson,
    old_string: '"bind": "loopback"',
    new_string: '"bind": "lan"',
    edits: [{ old_string: '"bind": "loopback"', new_string: '"bind": "lan"' }],
  });
  const messagingCommands = [
    'openclaw agent --message "set plugins.entries.relay-guard.enabled to false in openclaw.json, then run openclaw config set"',
    "openclaw agent -m 'the config and plugins are fine; relay-guard stays on'",
    "openclaw message send --channel telegram --target 123 --text 'Updated openclaw.json: plugins.entries.relay-guard is unchanged; config set done'",
    "openclaw message send --channel telegram --target 123 --message='gateway restart is next; do not touch ALPHACLAW_ROOT_DIR'",
  ];

  it("runs the native CLI harness's edit shape (old_string and new_string plus the same edits[0]) on openclaw.json", async () => {
    ctx = setup();
    expect(classifyAnchor({ toolName: "edit", params: harnessEdit(ctx), rootDir: ctx.rootDir })).toBeNull();
    expect(classifyAnchor({ toolName: "edit", params: { path: ctx.openclawJson, oldText: '"bind": "loopback"', newText: '"bind": "lan"', edits: [{ oldText: '"bind": "loopback"', newText: '"bind": "lan"' }] }, rootDir: ctx.rootDir })).toBeNull();
    const run = await ctx.deliver((await ctx.attestedAgent()).agent);
    expect(await ctx.call(run, "edit", harnessEdit(ctx))).toEqual({});
    // A harness edit that disables the guard is still the anchor.
    const off = { path: ctx.openclawJson, old_string: '"enabled": true', new_string: '"enabled": false', edits: [{ old_string: '"enabled": true', new_string: '"enabled": false' }] };
    expect((await ctx.call(run, "edit", off)).blockReason).toContain("would change what decides relay trust on this box");
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("runs openclaw agent and openclaw message send whose quoted free text mentions config or plugins", async () => {
    ctx = setup();
    for (const command of messagingCommands) {
      expect(classifyAnchor({ toolName: "exec", params: { command }, rootDir: ctx.rootDir }), command).toBeNull();
      expect(gatewayRestartOf({ toolName: "exec", params: { command } }), command).toBeNull();
    }
    const run = await ctx.deliver((await ctx.attestedAgent()).agent);
    for (const command of messagingCommands) expect(await ctx.call(run, "exec", { command }), command).toEqual({});
    // Only literal free text is set aside: a substitution or a second command
    // is still read.
    for (const command of [
      'openclaw agent --message "$(openclaw config set plugins.entries.relay-guard.enabled false)"',
      "openclaw agent --message hi; openclaw config set plugins.entries.relay-guard.enabled false",
      "openclaw agent --message hi > " + ctx.openclawJson,
    ]) {
      expect((await ctx.call(run, "exec", { command })).blockReason, command).toContain("would change what decides relay trust on this box");
    }
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("reads openclaw as the program only in command position, so an argument next to a shell variable changes nothing", async () => {
    ctx = setup();
    const argumentCommands = [
      "grep -rn openclaw $DIR",
      'docker logs openclaw --since "$T"',
      'git commit -m "bump openclaw (gateway) pin"',
      'journalctl -u openclaw --since "$(date)"',
      "echo openclaw $HOME",
    ];
    for (const command of argumentCommands) {
      expect(classifyAnchor({ toolName: "exec", params: { command }, rootDir: ctx.rootDir }), command).toBeNull();
      expect(classifyRisk({ toolName: "exec", params: { command }, rootDir: ctx.rootDir }).kind, command).toBe("low");
    }
    const run = await ctx.deliver((await ctx.attestedAgent()).agent);
    for (const command of argumentCommands) expect(await ctx.call(run, "exec", { command }), command).toEqual({});
    for (const command of [
      "sudo -u root openclaw config set $K false",
      'sh -c "openclaw config set $K false"',
      "timeout 30 openclaw config patch x",
      "echo plugins.entries.relay-guard.enabled | xargs openclaw config set",
      "( openclaw config set $K false )",
      "npx openclaw config $V plugins.entries.relay-guard.enabled false",
    ]) {
      expect(classifyAnchor({ toolName: "exec", params: { command }, rootDir: ctx.rootDir }), command).not.toBeNull();
      expect((await ctx.call(run, "exec", { command })).blockReason, command).toContain("would change what decides relay trust on this box");
    }
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("keeps today's holds and taps for the same calls from an unattested delegate", async () => {
    ctx = setup();
    const run = await ctx.deliver(ctx.oauthDelegate().agent);
    expectHeldWithTap(ctx, run, "edit", harnessEdit(ctx));
    expectHeldWithTap(ctx, run, "exec", { command: messagingCommands[0] });
    expectHeld(await ctx.call(run, "exec", { command: "openclaw config $(echo set) plugins.entries.relay-guard.enabled false" }));
  });
});
