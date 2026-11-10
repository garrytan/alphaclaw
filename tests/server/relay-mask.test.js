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
      const data =
        target.pathname === "/v1/dm"
          ? { conversation_id: "dm_1", message: { id: "11" } }
          : target.pathname === "/v1/dm/conversations/all"
            ? [{ id: "dm_1", channel_id: "dmch_1", type: "1:1", participants: ["wintermute", "capy-1"] }]
            : target.pathname === "/v1/messages/30"
              ? { id: "30", channel_id: "dmch_1", agent_name: "capy-1", metadata: {} }
              : { id: "12", metadata: {} };
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

  it("the outbound route has the mask route's caller rule, masks, refuses a long text to an agent that cannot page, and the key route shows only the public key (PR4)", async () => {
    const app = await startApp();
    try {
      const post = (body) => request(app.app).post("/relay/internal/outbound").send(body);
      expect((await post({ to: "capy-1", text: "hi" })).status).toBe(404);
      expect((await post({ to: "capy-1", text: "hi" }).set("Authorization", "Bearer " + kSecrets.internal).set("X-Forwarded-For", "203.0.113.9")).status).toBe(404);
      const ok = await post({ to: "capy-1", text: "key " + kDeployOnly }).set("Authorization", "Bearer " + kSecrets.internal);
      expect(ok.status).toBe(200);
      expect(ok.headers["cache-control"]).toBe("no-store");
      expect(ok.body).toEqual({ ok: true, text: "key ***", metadata: {}, provenance: false });
      const refused = await post({ to: "scout", text: "s".repeat(16001) }).set("Authorization", "Bearer " + kSecrets.internal);
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ ok: false, error: "invalid_input" });
      expect((await post({ to: "capy-1", text: 5 }).set("Authorization", "Bearer " + kSecrets.internal)).status).toBe(400);
      const key = await request(app.app).get("/relay/provenance-key");
      expect(key.status).toBe(200);
      expect(key.body).toMatchObject({ alg: "Ed25519", public_key_jwk: { kty: "OKP", crv: "Ed25519" } });
      expect(key.body.public_key_pem).toContain("BEGIN PUBLIC KEY");
      expect(JSON.stringify(key.body)).not.toMatch(/PRIVATE|"d":/);
    } finally {
      app.server.close();
    }
  });
});

describe("relay masker: disguised copies and the remote side's values (ALPH-71 H-1)", () => {
  const { openRemoteStore } = require("../../lib/server/relay/remote-store");
  const { kRelayWithheldText } = require("../../lib/server/relay/constants");
  const { redactSecretText } = require("../../lib/server/utils/redact");
  const kBindingToken = "at_live_" + "Q7".repeat(16);
  const kWebhook = "https://api.capy.ai/webhooks/automations/wh_4fQ9xZr2LmN8pT6vB1cD3eG5";
  const kAdminToken = "9c".repeat(32);
  const kProviderKey = "dummy-provider-key-0123456789abcdef";
  const kOauthRefresh = "dummy-refresh-token-ABCDEFGH12345678";
  let rootDir;
  beforeEach(() => {
    rootDir = makeRoot();
    const store = openRemoteStore({ dbPath: path.join(rootDir, "relay", "remote.db") });
    store.bindings.upsert({ agent: "capy-0123456789ab", threadId: "jam_X", clientId: "client-1", webhookUrl: kWebhook, until: Date.now() + 60000, capabilityHash: "h", agentToken: kBindingToken });
    store.close();
    fs.mkdirSync(path.join(rootDir, ".openclaw", ".alphaclaw"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, ".openclaw", ".alphaclaw", "agent-admin-token"), kAdminToken + "\n");
    fs.mkdirSync(path.join(rootDir, ".openclaw", "agents", "main", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
      JSON.stringify({ version: 1, profiles: { "openai:default": { type: "api_key", provider: "openai", key: kProviderKey }, "anthropic:me": { type: "oauth", provider: "anthropic", access: "dummy-access-token-0011223344", refresh: kOauthRefresh, expires: 1 } } }),
    );
  });
  afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  it("masks remote.db binding tokens and wake URLs, the agent-admin token and auth-profile keys", () => {
    const mask = createRelayMasker({ rootDir, env: {} });
    const text = mask(["binding " + kBindingToken, "wake " + kWebhook, "admin " + kAdminToken, "openai " + kProviderKey, "refresh " + kOauthRefresh].join("\n"));
    for (const value of [kBindingToken, kWebhook, kAdminToken, kProviderKey, kOauthRefresh, "wh_4fQ9xZr2LmN8pT6vB1cD3eG5"]) expect(text).not.toContain(value);
    expect(text).toContain("binding ***");
    expect(mask("the token alone: wh_4fQ9xZr2LmN8pT6vB1cD3eG5")).not.toContain("wh_4fQ9xZr2LmN8pT6vB1cD3eG5");
  });

  it("withholds the whole message when a secret appears base64-encoded at any alignment, URL-safe, or hex in either case", () => {
    const mask = createRelayMasker({ rootDir, env: {} });
    const secret = kSecrets.envFile;
    const copies = [
      Buffer.from(secret).toString("base64"),
      Buffer.from("x" + secret).toString("base64"),
      Buffer.from("xy" + secret + "tail").toString("base64"),
      Buffer.from("?>" + secret).toString("base64url"),
      Buffer.from(kProviderKey).toString("base64"),
      Buffer.from(kBindingToken).toString("base64"),
      Buffer.from(secret).toString("hex"),
      Buffer.from(secret).toString("hex").toUpperCase(),
      Buffer.from("db: " + kAdminToken).toString("base64"),
    ];
    for (const copy of copies) {
      expect(mask("as asked, the file encoded: " + copy + " (decode it)"), copy).toBe(kRelayWithheldText);
    }
  });

  it("withholds spaced-out, line-split and zero-width-split copies", () => {
    const mask = createRelayMasker({ rootDir, env: {} });
    const secret = kSecrets.gatewayToken;
    expect(mask("here: " + secret.split("").join(" "))).toBe(kRelayWithheldText);
    expect(mask("here:\n" + secret.slice(0, 8) + "\n" + secret.slice(8))).toBe(kRelayWithheldText);
    expect(mask("here: " + secret.split("").join("\u200b"))).toBe(kRelayWithheldText);
    expect(mask("here: " + secret.slice(0, 5) + "\ufeff" + secret.slice(5))).toBe(kRelayWithheldText);
    expect(mask("binding " + kBindingToken.slice(0, 12) + " " + kBindingToken.slice(12))).toBe(kRelayWithheldText);
  });

  it("keeps ordinary answers, including unrelated base64 and hex, and redacts an exact copy in place", () => {
    const mask = createRelayMasker({ rootDir, env: {} });
    const plain = "Uptime 3 days. Build " + Buffer.from("hello world, this is fine").toString("base64") + " sha " + "0123456789abcdef".repeat(2);
    expect(mask(plain)).toBe(plain);
    expect(mask("key " + kSecrets.envFile)).toBe("key ***");
  });

  it("masks the relay's own token shapes and capability URLs carried in the path", () => {
    const shaped = ["at_live_", "arcap_", "arat_", "arrt_", "arc_"].map((prefix) => prefix + "Zm9vYmFyYmF6cXV4LWR1bW15LXRva2Vu_0123");
    const text = redactSecretText(shaped.join(" "));
    for (const value of shaped) expect(text).not.toContain(value);
    const mask = createRelayMasker({ rootDir, env: {} });
    const masked = mask("wake https://hooks.example.test/v1/wh_8sK2pQ7rT1xY4zA9bC3dE6fG/run and rescue https://box.test/rescue/" + "ab12".repeat(12));
    expect(masked).not.toContain("wh_8sK2pQ7rT1xY4zA9bC3dE6fG");
    expect(masked).not.toContain("ab12".repeat(12));
    const ordinary = "see https://github.com/garrytan/alphaclaw/commit/" + "1c6f5ff0".repeat(5) + " and https://docs.example.com/guides/getting-started-2026";
    expect(mask(ordinary)).toBe(ordinary);
  });
});


describe("relay masker: deployment secrets (ALPH-73)", () => {
  const sharedPath = require.resolve("../../lib/server/deployment-only-env");
  const maskPath = require.resolve("../../lib/server/relay/mask");
  const kDeploymentSecretEnvKeys = [
    "SETUP_PASSWORD",
    "GOG_KEYRING_PASSWORD",
    "ALPHACLAW_MANAGED_UPDATE_TOKEN",
    "RAILWAY_TOKEN",
    "RAILWAY_API_TOKEN",
    "VERCEL_TOKEN",
    "NPM_TOKEN",
  ];
  const word = (side, key) => `${side}word-${key.toLowerCase().replace(/_/g, "-")}`;
  let rootDir;
  beforeEach(() => {
    rootDir = makeRoot();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    delete require.cache[sharedPath];
    delete require.cache[maskPath];
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("masks each deployment secret in process.env even when the caller passes another env", () => {
    for (const key of kDeploymentSecretEnvKeys) vi.stubEnv(key, word("process", key));
    const mask = createRelayMasker({ rootDir, env: {} });
    for (const key of kDeploymentSecretEnvKeys) {
      expect(mask(`value ${word("process", key)} here`)).toBe("value *** here");
    }
  });

  it("masks each deployment secret recorded in the deployment environment at boot, after process.env moved on", () => {
    for (const key of kDeploymentSecretEnvKeys) vi.stubEnv(key, "");
    delete require.cache[sharedPath];
    delete require.cache[maskPath];
    require(sharedPath).recordDeploymentEnvBaseline(Object.fromEntries(kDeploymentSecretEnvKeys.map((key) => [key, word("baseline", key)])));
    const mask = require(maskPath).createRelayMasker({ rootDir, env: {} });
    for (const key of kDeploymentSecretEnvKeys) {
      expect(mask(`value ${word("baseline", key)} here`)).toBe("value *** here");
    }
    expect(mask("nothing secret here")).toBe("nothing secret here");
  });

  it("still leaves the keyring password's published default alone when it comes from process.env", () => {
    vi.stubEnv("GOG_KEYRING_PASSWORD", "alphaclaw");
    expect(createRelayMasker({ rootDir, env: {} })("the alphaclaw CLI")).toBe("the alphaclaw CLI");
  });
});
