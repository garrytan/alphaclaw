const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createSecretDropPlugin } = require("../../lib/plugin/secret-drop");
const {
  applySecretDropCommandEntry,
  buildSecretDropCommandEntry,
  resolveDesiredSecretDropCommandEntry,
  kSecretDropPluginPath,
} = require("../../lib/server/secret-drop/command-entry");
const { createSecretDropRequests } = require("../../lib/server/secret-drop/requests");
const { registerSecretDropRoutes } = require("../../lib/server/routes/secret-drop");

const kCanary = "ghp_cnry7Q2xVb9LmZp4Wt8sK3dF";
const kFakeAgentToken = "a".repeat(64);
const kOrigin = "https://box.example.com";
const kInlineWarning =
  "It is still in this chat and in this session's history, so it will reach the model provider with your next message unless you send /new first to start a new session. Delete that message now (Telegram: long-press it, then Delete).";
const kAfterName = "Values never go in chat: what you typed after GITHUB_TOKEN was not saved. " + kInlineWarning;
// A real-shaped base32 TOTP seed (A-Z, 2-7), made fresh per run.
const kSeed = Array.from({ length: 32 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[Math.floor(Math.random() * 32)]).join("");

// A stand-in for AlphaClaw: the real secret-drop routes and request store
// behind a bearer check for the fake agent token. Every request it gets is
// recorded, with the time it arrived relative to the owner assert.
const startAlphaclaw = async ({ events }) => {
  const app = express();
  app.use(express.json());
  const requests = createSecretDropRequests();
  const seen = [];
  const requireAuth = (req, res, next) => {
    events.push("request");
    seen.push({ authorization: req.get("authorization"), body: req.body });
    if (req.get("authorization") !== "Bearer " + kFakeAgentToken) return res.status(401).json({ error: "Unauthorized" });
    req.alphaclawActor = { type: "agent" };
    return next();
  };
  registerSecretDropRoutes({
    app,
    requireAuth,
    resolveRequestIdentity: () => null,
    requests,
    applier: { apply: async () => ({ status: "failed" }) },
    resolveSetupUrl: () => kOrigin,
    logger: { log() {}, warn() {}, error() {} },
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  return { server, port: server.address().port, seen, requests };
};

const makeOpenclawDir = ({ token = kFakeAgentToken } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-drop-command-"));
  if (token) {
    fs.mkdirSync(path.join(dir, ".alphaclaw"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".alphaclaw", "agent-admin-token"), token + "\n", { mode: 0o600 });
  }
  return dir;
};

// Registers the plugin against a fake OpenClaw api and returns the command
// definition plus every log line it wrote.
const loadCommand = ({ openclawDir, port, plugin = createSecretDropPlugin() }) => {
  const lines = [];
  const logger = Object.fromEntries(["info", "warn", "error", "debug"].map((level) => [level, (line) => lines.push(String(line))]));
  let command = null;
  const hooks = {};
  plugin.register({
    on: (name, handler) => {
      hooks[name] = handler;
    },
    logger,
    pluginConfig: { _alphaclawManaged: "secret-drop", openclawDir, port },
    registerCommand: (definition) => {
      command = definition;
    },
  });
  return { command, hooks, lines };
};

const ownerCtx = (args, events, overrides = {}) => ({
  args,
  commandBody: "/secret" + (args ? " " + args : ""),
  channel: "telegram",
  senderId: "111",
  isAuthorizedSender: true,
  senderIsOwner: true,
  assertOwnerCurrent: vi.fn(() => events.push("assert")),
  ...overrides,
});

describe("/secret command plugin", () => {
  let alphaclaw;
  let events;
  let openclawDir;

  beforeEach(async () => {
    events = [];
    alphaclaw = await startAlphaclaw({ events });
    openclawDir = makeOpenclawDir();
  });

  afterEach(async () => {
    await new Promise((resolve) => alphaclaw.server.close(resolve));
  });

  it("registers /secret for operator.admin only, taking arguments, and no hooks", () => {
    const { command, hooks } = loadCommand({ openclawDir, port: alphaclaw.port });
    // Any before_message_write (or before_dispatch, before_agent_run,
    // reply_dispatch) hook makes OpenClaw skip restart-safe chat admission
    // for every turn on the box, so the plugin registers none at all.
    expect(hooks).toEqual({});
    expect(command).toMatchObject({ name: "secret", acceptsArgs: true, requiredScopes: ["operator.admin"] });
    expect(command.description).toMatch(/one-time/);
    expect(typeof command.handler).toBe("function");
    expect(command.requireAuth).toBeUndefined();
  });

  it("asks AlphaClaw for the link with the agent admin bearer after checking the owner is still current, and replies with the url", async () => {
    const { command, lines } = loadCommand({ openclawDir, port: alphaclaw.port });
    const ctx = ownerCtx("GITHUB_TOKEN", events);
    const reply = await command.handler(ctx);
    expect(events).toEqual(["assert", "request"]);
    expect(alphaclaw.seen).toEqual([{ authorization: "Bearer " + kFakeAgentToken, body: { name: "GITHUB_TOKEN", reason: "requested with /secret" } }]);
    expect(reply.text).toMatch(new RegExp("^" + kOrigin + "/secret/[A-Za-z0-9_-]{43}\n"));
    expect(reply.text).toContain("Open it signed in to AlphaClaw. It works once, for 15 minutes.");
    expect(lines.join("\n")).toContain("name=GITHUB_TOKEN");
    expect(lines.join("\n")).not.toContain(kFakeAgentToken);
    expect(lines.join("\n")).not.toMatch(/\/secret\/[A-Za-z0-9_-]{43}/);
  });

  it("captures the owner assert before its first await", async () => {
    const { command } = loadCommand({ openclawDir, port: alphaclaw.port });
    const ctx = ownerCtx("GITHUB_TOKEN", events);
    const assert = ctx.assertOwnerCurrent;
    const pending = command.handler(ctx);
    ctx.assertOwnerCurrent = undefined;
    const reply = await pending;
    expect(assert).toHaveBeenCalledTimes(1);
    expect(reply.text).toContain(kOrigin + "/secret/");
  });

  it("answers a value after the name with the link and a not-saved line, and never sends, repeats or logs the value", async () => {
    const { command, lines } = loadCommand({ openclawDir, port: alphaclaw.port });
    const shapes = ["GITHUB_TOKEN " + kCanary, "GITHUB_TOKEN = " + kCanary, "GITHUB_TOKEN\n" + kCanary];
    for (const args of shapes) {
      const ctx = ownerCtx(args, events);
      const reply = await command.handler(ctx);
      expect(reply.text).toMatch(new RegExp("^" + kOrigin + "/secret/[A-Za-z0-9_-]{43}\n"));
      expect(reply.text.endsWith("\n" + kAfterName)).toBe(true);
      expect(reply.text).not.toContain(kCanary.slice(0, 8));
      expect(ctx.assertOwnerCurrent).toHaveBeenCalledTimes(1);
    }
    expect(alphaclaw.seen).toHaveLength(shapes.length);
    for (const seen of alphaclaw.seen) expect(seen.body).toEqual({ name: "GITHUB_TOKEN", reason: "requested with /secret" });
    for (const args of [kCanary, kCanary + " GITHUB_TOKEN"]) {
      const lone = await command.handler(ownerCtx(args, events));
      expect(lone.text).toContain("not a variable name");
      expect(lone.text).toContain("Nothing was requested or saved. If you typed a secret value, it was not saved. " + kInlineWarning);
      expect(lone.text).not.toContain(kCanary.slice(0, 8));
    }
    expect(alphaclaw.seen).toHaveLength(shapes.length);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(kCanary.slice(0, 8));
  });

  it("refuses a lone base32 seed as a value: no link, the full warning, and the seed in no log line or request", async () => {
    const { command, lines } = loadCommand({ openclawDir, port: alphaclaw.port });
    for (const args of [kSeed, kSeed + " " + kSeed.slice(0, 16)]) {
      const reply = await command.handler(ownerCtx(args, events));
      expect(reply.text).toMatch(/^That is not a variable name: use uppercase letters, digits and at least one _/);
      expect(reply.text).toContain("For a name without an _, use AlphaClaw's Envars page.");
      expect(reply.text).toContain("Nothing was requested or saved. If you typed a secret value, it was not saved. " + kInlineWarning);
      expect(reply.text).not.toContain(kSeed.slice(0, 8));
    }
    const noUnderscore = await command.handler(ownerCtx("OPENAI", events));
    expect(noUnderscore.text).toContain("For a name without an _, use AlphaClaw's Envars page.");
    expect(alphaclaw.seen).toEqual([]);
    expect(events).toEqual([]);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(kSeed.slice(0, 8));
    expect(lines.join("\n")).not.toMatch(/name=/);
  });

  it("keeps the not-saved, next-message and delete lines on every failure path after a value", async () => {
    const value = "GITHUB_TOKEN " + kCanary;
    const replies = [];
    const allLines = [];
    const run = async (loaded, overrides) => {
      const reply = await loaded.command.handler(ownerCtx(value, events, overrides));
      replies.push(reply.text);
      allLines.push(...loaded.lines);
      return reply.text;
    };
    const { command, lines } = loadCommand({ openclawDir, port: alphaclaw.port });
    const base = { command, lines };
    expect(await run(base, { senderIsOwner: false, assertOwnerCurrent: undefined, gatewayClientScopes: ["operator.read"] })).toMatch(/^Only the owner can ask for a secret link\.\n/);
    expect(await run(base, { assertOwnerCurrent: () => { throw new Error("demoted"); } })).toMatch(/^Your owner access changed while this ran/);
    expect(await run(loadCommand({ openclawDir: makeOpenclawDir({ token: null }), port: alphaclaw.port }))).toMatch(/^Agent Administration is off/);
    expect(alphaclaw.seen).toEqual([]);

    expect(await run(loadCommand({ openclawDir: makeOpenclawDir({ token: "b".repeat(64) }), port: alphaclaw.port }))).toMatch(/^AlphaClaw refused the agent administration token \(HTTP 401\)/);
    const reserved = await base.command.handler(ownerCtx("SETUP_PASSWORD " + kCanary, events));
    replies.push(reserved.text);
    expect(reserved.text).toMatch(/^No link for SETUP_PASSWORD: \S/);
    expect(reserved.text.endsWith("Values never go in chat: what you typed after SETUP_PASSWORD was not saved. " + kInlineWarning)).toBe(true);
    for (let i = 0; i < 20; i += 1) alphaclaw.requests.create({ name: "FILLER_" + i });
    expect(await run(base)).toMatch(/^Too many secret links are open already/);

    const closedPort = await new Promise((resolve) => {
      const probe = require("net").createServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
    expect(await run(loadCommand({ openclawDir, port: closedPort }))).toMatch(/^AlphaClaw is not answering right now/);

    const sockets = [];
    const silent = await new Promise((resolve) => {
      const server = require("net").createServer((socket) => sockets.push(socket)).listen(0, "127.0.0.1", () => resolve(server));
    });
    const slow = loadCommand({ openclawDir, port: silent.address().port, plugin: createSecretDropPlugin({ timeoutMs: 200 }) });
    expect(await run(slow)).toMatch(/^AlphaClaw did not answer in time, so no link came back\. If one was made, it expires unused in 15 minutes\./);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => silent.close(resolve));

    const throwing = loadCommand({ openclawDir, port: alphaclaw.port, plugin: createSecretDropPlugin({ readAgentToken: () => { throw new Error("boom " + kCanary); } }) });
    expect(await run(throwing)).toMatch(/^The secret link could not be made\. Nothing was requested/);

    for (const text of replies.filter((t) => !t.startsWith("No link for SETUP_PASSWORD"))) expect(text.endsWith("\n" + kAfterName)).toBe(true);
    expect(replies).toHaveLength(9);
    for (const text of replies) expect(text).not.toContain(kCanary.slice(0, 8));
    for (const seen of alphaclaw.seen) expect(JSON.stringify(seen.body)).not.toContain(kCanary.slice(0, 8));
    expect(allLines.concat(lines).join("\n")).not.toContain(kCanary.slice(0, 8));
  });

  it("answers a bare /secret with one usage line", async () => {
    const { command } = loadCommand({ openclawDir, port: alphaclaw.port });
    for (const args of [undefined, "", "   "]) {
      const reply = await command.handler(ownerCtx(args, events));
      expect(reply.text).toMatch(/^Usage: \/secret NAME/);
      expect(reply.text.split("\n")).toHaveLength(1);
    }
    expect(alphaclaw.seen).toEqual([]);
  });

  it("serves an admin gateway client, and refuses a sender who is neither the owner nor an admin client", async () => {
    const { command } = loadCommand({ openclawDir, port: alphaclaw.port });
    const adminClient = await command.handler(ownerCtx("OPENAI_API_KEY", events, { senderIsOwner: undefined, assertOwnerCurrent: undefined, gatewayClientScopes: ["operator.admin"] }));
    expect(adminClient.text).toContain(kOrigin + "/secret/");
    const stranger = await command.handler(ownerCtx("OPENAI_API_KEY", events, { senderIsOwner: false, assertOwnerCurrent: undefined, gatewayClientScopes: ["operator.read"] }));
    expect(stranger.text).toBe("Only the owner can ask for a secret link.");
    expect(alphaclaw.seen).toHaveLength(1);
  });

  it("mints nothing when the owner is no longer current", async () => {
    const { command } = loadCommand({ openclawDir, port: alphaclaw.port });
    const reply = await command.handler(ownerCtx("GITHUB_TOKEN", events, { assertOwnerCurrent: () => { throw new Error("demoted"); } }));
    expect(reply.text).toBe("Your owner access changed while this ran, so nothing was requested.");
    expect(alphaclaw.seen).toEqual([]);
  });

  it("maps every failure to one plain sentence", async () => {
    const noToken = loadCommand({ openclawDir: makeOpenclawDir({ token: null }), port: alphaclaw.port });
    expect((await noToken.command.handler(ownerCtx("GITHUB_TOKEN", events))).text).toBe(
      "Agent Administration is off, so AlphaClaw cannot make the link: turn it on in AlphaClaw's Integrations page, then send /secret again.",
    );
    expect(alphaclaw.seen).toEqual([]);

    const { command } = loadCommand({ openclawDir, port: alphaclaw.port });
    const reserved = await command.handler(ownerCtx("SETUP_PASSWORD", events));
    expect(reserved.text).toMatch(/^No link for SETUP_PASSWORD: \S/);

    for (let i = 0; i < 20; i += 1) alphaclaw.requests.create({ name: "FILLER_" + i });
    expect((await command.handler(ownerCtx("GITHUB_TOKEN", events))).text).toBe(
      "Too many secret links are open already. Use one or wait for one to expire (they last 15 minutes), then try again.",
    );

    const wrongToken = loadCommand({ openclawDir: makeOpenclawDir({ token: "b".repeat(64) }), port: alphaclaw.port });
    expect((await wrongToken.command.handler(ownerCtx("GITHUB_TOKEN", events))).text).toMatch(/^AlphaClaw refused the agent administration token \(HTTP 401\)/);

    const closedPort = await new Promise((resolve) => {
      const probe = require("net").createServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
    const unreachable = loadCommand({ openclawDir, port: closedPort });
    expect((await unreachable.command.handler(ownerCtx("GITHUB_TOKEN", events))).text).toBe("AlphaClaw is not answering right now, so no link was made. Try again in a minute.");
  });

  it("turns an unexpected throw into a sentence that names no value", async () => {
    const plugin = createSecretDropPlugin({ readAgentToken: () => { throw new Error("boom " + kCanary); } });
    const { command, lines } = loadCommand({ openclawDir, port: alphaclaw.port, plugin });
    const reply = await command.handler(ownerCtx("GITHUB_TOKEN", events));
    expect(reply.text).toBe("The secret link could not be made. Nothing was requested; try again in a minute.");
    expect(lines.join("\n")).not.toContain(kCanary.slice(0, 8));
  });
});

describe("/secret command plugin entry (openclaw.json)", () => {
  const openclawDir = "/data/.openclaw";
  const desired = buildSecretDropCommandEntry({ openclawDir, port: 3000 });
  const quiet = { log: () => {} };

  it("loads AlphaClaw's bundled plugin, owner-marked, with only the state dir and port, unless ALPHACLAW_SECRET_DROP_COMMAND is off", () => {
    expect(resolveDesiredSecretDropCommandEntry({ env: {}, openclawDir, port: 3000 })).toEqual(desired);
    for (const off of ["off", "OFF", "0", "false", "no", "disabled"]) {
      expect(resolveDesiredSecretDropCommandEntry({ env: { ALPHACLAW_SECRET_DROP_COMMAND: off }, openclawDir, port: 3000 })).toBeNull();
    }
    const cfg = { plugins: { allow: ["usage-tracker"], load: { paths: ["/old/node_modules/alphaclaw/lib/plugin/secret-drop", "/x/plugin/usage-tracker"] }, entries: {} } };
    expect(applySecretDropCommandEntry(cfg, desired, quiet)).toEqual({ changed: true, conflict: false });
    expect(cfg.plugins.allow).toEqual(["usage-tracker", "secret-drop"]);
    expect(cfg.plugins.load.paths).toEqual(["/x/plugin/usage-tracker", kSecretDropPluginPath]);
    expect(kSecretDropPluginPath).toBe(path.resolve(__dirname, "../../lib/plugin/secret-drop"));
    expect(cfg.plugins.entries["secret-drop"]).toEqual({ enabled: true, config: { _alphaclawManaged: "secret-drop", openclawDir, port: 3000 } });
    expect(JSON.stringify(cfg.plugins.entries["secret-drop"])).not.toMatch(/token|secret"|Bearer/i);
    expect(applySecretDropCommandEntry(cfg, desired, quiet)).toEqual({ changed: false, conflict: false });
  });

  it("follows a port change, re-enables its own entry, never touches one someone else owns, and removes only its own when off", () => {
    const cfg = {};
    applySecretDropCommandEntry(cfg, desired, quiet);
    expect(applySecretDropCommandEntry(cfg, buildSecretDropCommandEntry({ openclawDir, port: 8080 }), quiet).changed).toBe(true);
    expect(cfg.plugins.entries["secret-drop"].config.port).toBe(8080);
    cfg.plugins.entries["secret-drop"].enabled = false;
    expect(applySecretDropCommandEntry(cfg, desired, quiet).changed).toBe(true);
    expect(cfg.plugins.entries["secret-drop"].enabled).toBe(true);

    const foreign = { plugins: { entries: { "secret-drop": { enabled: false } } } };
    const before = JSON.stringify(foreign);
    expect(applySecretDropCommandEntry(foreign, desired, quiet)).toEqual({ changed: false, conflict: true });
    expect(applySecretDropCommandEntry(foreign, null, quiet)).toEqual({ changed: false, conflict: false });
    expect(JSON.stringify(foreign)).toBe(before);

    const ours = { plugins: { allow: ["secret-drop", "usage-tracker"], load: { paths: [kSecretDropPluginPath, "/x/plugin/usage-tracker"] }, entries: {} } };
    applySecretDropCommandEntry(ours, desired, quiet);
    expect(applySecretDropCommandEntry(ours, null, quiet)).toEqual({ changed: true, conflict: false });
    expect(ours.plugins).toEqual({ allow: ["usage-tracker"], load: { paths: ["/x/plugin/usage-tracker"] }, entries: {} });
    expect(applySecretDropCommandEntry({}, null, quiet)).toEqual({ changed: false, conflict: false });
  });
});
