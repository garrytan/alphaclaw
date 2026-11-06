const fs = require("fs");
const os = require("os");
const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { createRelayMasker } = require("../../lib/server/relay/mask");
const { createRelayMcpServer } = require("../../lib/server/relay/mcp-stdio");

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

  it("the box agent's relay_send and relay_reply leave the box masked (stdio server wiring)", async () => {
    const posted = [];
    const fetchImpl = async (url, init) => {
      posted.push({ path: new URL(url).pathname, body: init.body ? JSON.parse(init.body) : null });
      const data = new URL(url).pathname === "/v1/dm" ? { conversation_id: "dm_1", message: { id: "11" } } : { id: "12", metadata: {} };
      return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const server = createRelayMcpServer({ relayDir: path.join(rootDir, "relay"), port: 18787, fetchImpl, env: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const sent = await client.callTool({ name: "relay_send", arguments: { to: "capy-1", text: leakText() } });
      expect(JSON.parse(sent.content[0].text)).toMatchObject({ message_id: "11", credentials_masked: true });
      const replied = await client.callTool({ name: "relay_reply", arguments: { message_id: "30", text: leakText() } });
      expect(JSON.parse(replied.content[0].text)).toMatchObject({ message_id: "12", credentials_masked: true });
      const outgoing = posted.filter((call) => call.body && typeof call.body.text === "string");
      expect(outgoing).toHaveLength(2);
      for (const call of outgoing) expectMasked(call.body.text);
    } finally {
      await client.close();
    }
  });
});
