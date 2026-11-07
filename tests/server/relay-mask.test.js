const fs = require("fs");
const os = require("os");
const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { createRelayMasker } = require("../../lib/server/relay/mask");
const express = require("express");
const request = require("supertest");
const { createRelayMcpServer } = require("../../lib/server/relay/mcp-stdio");
const { createRelayService } = require("../../lib/server/relay/index");
const { registerRelayRoutes } = require("../../lib/server/routes/relay");

// One AlphaClaw root holding every kind of secret the relay must never send:
// a .env value under a plain name, openclaw.json credentials, and the relay's
// own workspace key, agent token and internal secret.
const kSecrets = {
  envFile: "envfilevalue-9f8e7d6c5b",
  botToken: "telegrambot-123456:AAbbCCddEE",
  gatewayToken: "gatewaytoken-abcdef0123",
  workspaceKey: "rk_live_workspacekey0123",
  agentToken: "at_live_agenttoken4567",
  internal: "a".repeat(32) + "b".repeat(32),
};

const makeRoot = () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-mask-"));
  fs.writeFileSync(path.join(rootDir, ".env"), "PLAIN_SETTING=" + kSecrets.envFile + "\n");
  fs.mkdirSync(path.join(rootDir, ".openclaw"));
  fs.writeFileSync(
    path.join(rootDir, ".openclaw", "openclaw.json"),
    JSON.stringify({ channels: { telegram: { botToken: kSecrets.botToken } }, gateway: { auth: { token: kSecrets.gatewayToken } } }),
  );
  fs.mkdirSync(path.join(rootDir, "relay"));
  fs.writeFileSync(
    path.join(rootDir, "relay", "secrets.json"),
    JSON.stringify({ workspaceKey: kSecrets.workspaceKey, boxAgent: "wintermute", agents: { wintermute: { token: kSecrets.agentToken } } }),
  );
  fs.writeFileSync(path.join(rootDir, "relay", "internal.secret"), kSecrets.internal + "\n");
  return rootDir;
};

const leakText = () => "here you go: " + Object.values(kSecrets).join(" | ");

const expectMasked = (text) => {
  for (const value of Object.values(kSecrets)) expect(text).not.toContain(value);
  expect(text).toContain("***");
};

describe("relay masker (ALPH-63)", () => {
  let rootDir;
  beforeEach(() => {
    rootDir = makeRoot();
  });
  afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  it("masks .env values, openclaw.json credentials and the relay's own keys, not just secret-named env", () => {
    const mask = createRelayMasker({ rootDir, env: {} });
    const text = mask(leakText());
    expectMasked(text);
    expect(text).toContain("here you go:");
    expect(mask("nothing secret here")).toBe("nothing secret here");
  });

  it("leaves the keyring password's published default alone, and still masks real secrets, plain words included (ALPH-68)", () => {
    const mask = createRelayMasker({
      rootDir,
      env: { GOG_KEYRING_PASSWORD: "alphaclaw", DB_PASSWORD: "postgres", SETUP_PASSWORD: "bluemonkey" },
    });
    const answer = "Run the alphaclaw CLI next to OpenClaw from node_modules/alphaclaw. Token " + kSecrets.gatewayToken + ".";
    const text = mask(answer);
    expect(text).toContain("Run the alphaclaw CLI next to OpenClaw from node_modules/alphaclaw.");
    expect(text).not.toContain(kSecrets.gatewayToken);
    expect(mask("key " + kSecrets.envFile)).toBe("key ***");
    expect(mask("db postgres, setup bluemonkey")).toBe("db ***, setup ***");
    const sameValueElsewhere = createRelayMasker({ rootDir, env: { GOG_KEYRING_PASSWORD: "alphaclaw", ADMIN_PASSWORD: "alphaclaw" } });
    expect(sameValueElsewhere("the alphaclaw CLI")).toBe("the *** CLI");
    fs.appendFileSync(path.join(rootDir, ".env"), "GOG_KEYRING_PASSWORD=custom-keyring-pass\n");
    expect(createRelayMasker({ rootDir, env: {} })("pass custom-keyring-pass")).toBe("pass ***");
  });

  const kDeployOnly = "f".repeat(16) + "0123456789abcdef".repeat(3);

  // AlphaClaw's real mask route on a real port, backed by the real relay
  // service (its masker and internal-secret check). The deployment-only
  // secret is in the service's env only, like OPENCLAW_GATEWAY_TOKEN on a box.
  const startApp = async () => {
    const service = createRelayService({ env: { ALPHACLAW_RELAY: "on", OPENCLAW_GATEWAY_TOKEN: kDeployOnly }, rootDir, logger: { log: () => {}, warn: () => {} } });
    const app = express();
    app.use(express.json());
    registerRelayRoutes({ app, requireAuth: (req, res, next) => next(), relayService: service });
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    return { app, server, appPort: server.address().port };
  };

  const connectStdio = async ({ appPort }) => {
    const posted = [];
    const fetchImpl = async (url, init) => {
      const target = new URL(url);
      if (Number(target.port) === appPort) return globalThis.fetch(url, init);
      posted.push({ path: target.pathname, body: init.body ? JSON.parse(init.body) : null });
      const data = target.pathname === "/v1/dm" ? { conversation_id: "dm_1", message: { id: "11" } } : { id: "12", metadata: {} };
      return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const server = createRelayMcpServer({ relayDir: path.join(rootDir, "relay"), port: 18787, appPort, fetchImpl });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, posted };
  };

  it("the box agent's relay_send and relay_reply are masked by AlphaClaw's server, deployment-only secrets included", async () => {
    const app = await startApp();
    const { client, posted } = await connectStdio(app);
    try {
      const text = leakText() + " | " + kDeployOnly;
      const sent = await client.callTool({ name: "relay_send", arguments: { to: "capy-1", text } });
      expect(JSON.parse(sent.content[0].text)).toMatchObject({ message_id: "11", credentials_masked: true });
      const replied = await client.callTool({ name: "relay_reply", arguments: { message_id: "30", text } });
      expect(JSON.parse(replied.content[0].text)).toMatchObject({ message_id: "12", credentials_masked: true });
      const outgoing = posted.filter((call) => call.body && typeof call.body.text === "string");
      expect(outgoing).toHaveLength(2);
      for (const call of outgoing) {
        expectMasked(call.body.text);
        expect(call.body.text).not.toContain(kDeployOnly);
      }
    } finally {
      await client.close();
      app.server.close();
    }
  });

  it("fails closed: with AlphaClaw's server unreachable nothing is sent and the tool answers masking_unavailable", async () => {
    const app = await startApp();
    await new Promise((resolve) => app.server.close(resolve));
    const { client, posted } = await connectStdio(app);
    try {
      for (const [name, args] of [["relay_send", { to: "capy-1", text: "hello" }], ["relay_reply", { message_id: "30", text: "hello" }]]) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text).error).toBe("masking_unavailable");
      }
      expect(posted.filter((call) => call.path === "/v1/dm" || (call.body && typeof call.body.text === "string"))).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("the mask route answers only a loopback caller with the internal secret and no proxy headers", async () => {
    const app = await startApp();
    try {
      const post = () => request(app.app).post("/relay/internal/mask").send({ text: "key " + kDeployOnly });
      expect((await post()).status).toBe(404);
      expect((await post().set("Authorization", "Bearer " + "0".repeat(64))).status).toBe(404);
      expect((await post().set("Authorization", "Bearer " + kSecrets.internal).set("X-Forwarded-For", "203.0.113.9")).status).toBe(404);
      const ok = await post().set("Authorization", "Bearer " + kSecrets.internal);
      expect(ok.status).toBe(200);
      expect(ok.headers["cache-control"]).toBe("no-store");
      expect(ok.body).toEqual({ ok: true, text: "key ***" });
    } finally {
      app.server.close();
    }
  });
});
