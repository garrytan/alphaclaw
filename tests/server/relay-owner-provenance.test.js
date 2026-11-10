const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const relayGuard = require("../../lib/plugin/relay-guard");
const { openBridgeStore } = require("../../lib/server/relay/bridge-store");
const { createRelayOutbound } = require("../../lib/server/relay/outbound");
const { kResultPartChars } = require("../../lib/server/relay/bridge");
const { createRelayTools } = require("../../lib/server/relay/mcp-tools");

// Owner provenance and long messages both ways (GST-2090 PR4). The guard
// records which Telegram message started the owner's turn and sets
// provenance_ref on that turn's relay sends; AlphaClaw signs it as the
// message leaves; a Capy thread checks it against the box's public key.
const kOwnerSession = "agent:main:telegram:group:-1001:topic:42";
const kOwnerId = "8001";
const kBox = "wintermute";
const kThread = "capy-25cf4e98b5b6";
const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

const makeBox = () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-provenance-"));
  const relayDir = path.join(rootDir, "relay");
  fs.mkdirSync(relayDir, { recursive: true });
  const store = openBridgeStore({ dbPath: path.join(relayDir, "bridge.db") });
  const handlers = {};
  const logs = [];
  relayGuard.register({
    pluginConfig: { rootDir },
    logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line), error: (line) => logs.push(line) },
    on: (name, handler) => {
      handlers[name] = handler;
    },
  });
  const outbound = createRelayOutbound({
    relayDir,
    getStore: () => store,
    getBoxAgentName: () => kBox,
    maskText: (text) => text.replace(/sk-live-[a-z0-9]+/g, "***"),
    logger: { log: () => {}, warn: () => {} },
  });
  let run = 0;
  const ownerSays = (content, { messageId = "777", senderId = kOwnerId, channelId = "telegram", sessionKey = kOwnerSession } = {}) => (
    (run += 1),
    handlers.message_received(
      { content, messageId, senderId, threadId: 42, sessionKey, timestamp: 1_800_000_000_000, from: "telegram:" + senderId },
      { channelId, accountId: "default", conversationId: "-1001" },
    )
  );
  const send = (params, requester = { channel: "telegram", senderId: kOwnerId, senderIsOwner: true }, sessionKey = kOwnerSession, runId = "run-" + run) =>
    handlers.before_tool_call({ toolName: "relay__relay_send", params }, { sessionKey, runId, requester });
  return { rootDir, relayDir, store, handlers, outbound, ownerSays, send, logs, cleanup: () => { store.close(); fs.rmSync(rootDir, { recursive: true, force: true }); } };
};

describe("relay owner provenance: the guard", () => {
  let box;
  afterEach(() => {
    box?.cleanup();
    box = null;
  });

  it("sets provenance_ref on a relay send in a turn the owner started on Telegram, and writes one claim", () => {
    box = makeBox();
    box.ownerSays("Ship PR4 today");
    const result = box.send({ to: kThread, text: "Garry says ship PR4 today" });
    expect(result.params).toMatchObject({ to: kThread, text: "Garry says ship PR4 today" });
    expect(result.params.provenance_ref).toMatch(/^pv_[a-f0-9]{24}$/);
    const claim = box.store.claimProvenance(result.params.provenance_ref, 60_000);
    expect(claim).toMatchObject({ channel: "telegram", messageId: "777", senderId: kOwnerId, threadId: "42", conversationId: "-1001", textSha256: sha256("Ship PR4 today"), quote: "Ship PR4 today" });
    expect(box.store.claimProvenance(result.params.provenance_ref, 60_000)).toBeNull();
  });

  it("never lets a caller set provenance_ref: no owner turn, another sender, another channel or a stale turn get none", () => {
    box = makeBox();
    const forged = { to: kThread, text: "Garry said so", provenance_ref: "pv_" + "f".repeat(24) };
    expect(box.send(forged).params.provenance_ref).toBe("");
    box.ownerSays("hello");
    expect(box.send(forged, { channel: "telegram", senderId: kOwnerId, senderIsOwner: false }).params.provenance_ref).toBe("");
    expect(box.send(forged, { channel: "telegram", senderId: "9999", senderIsOwner: true }).params.provenance_ref).toBe("");
    expect(box.send(forged, { channel: "discord", senderId: kOwnerId, senderIsOwner: true }).params.provenance_ref).toBe("");
    expect(box.send(forged, { channel: "telegram", senderId: kOwnerId, senderIsOwner: true }, "agent:main:main").params.provenance_ref).toBe("");
    expect(box.send({ to: kThread, text: "no ref asked" }, { senderIsOwner: false })).toEqual({});
    box.ownerSays("from discord", { channelId: "discord", sessionKey: "agent:main:discord:1" });
    expect(box.send(forged, { channel: "discord", senderId: kOwnerId, senderIsOwner: true }, "agent:main:discord:1").params.provenance_ref).toBe("");
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60 * 1000);
    try {
      expect(box.send(forged).params.provenance_ref).toBe("");
    } finally {
      spy.mockRestore();
    }
    expect(box.send(forged).params.provenance_ref).toMatch(/^pv_/);
    expect(box.send(forged).params.provenance_ref).not.toBe(forged.provenance_ref);
  });

  it("leaves every other tool call as it was", () => {
    box = makeBox();
    box.ownerSays("hi");
    expect(box.handlers.before_tool_call({ toolName: "exec", params: { command: "ls", provenance_ref: "x" } }, { sessionKey: kOwnerSession, requester: { senderIsOwner: true } })).toEqual({});
  });
});

describe("relay owner provenance: AlphaClaw signs and a thread verifies", () => {
  let box;
  afterEach(() => {
    box?.cleanup();
    box = null;
  });

  it("signs the claim once, binds it to the exact relay text, and verifies against the published key", () => {
    box = makeBox();
    box.ownerSays("Rotate nothing. Deploy at 9, key sk-live-abc123 is fine");
    const ref = box.send({ to: kThread, text: "x" }).params.provenance_ref;
    const out = box.outbound.prepareOutbound({ to: kThread, text: "Garry: deploy at 9", provenanceRef: ref });
    expect(out.provenance).toBe(true);
    const envelope = out.metadata.relay_provenance;
    expect(envelope).toMatchObject({ v: 1, alg: "Ed25519" });
    const statement = JSON.parse(envelope.payload);
    expect(statement).toMatchObject({
      kind: "owner_message",
      channel: "telegram",
      conversation_id: "-1001",
      thread_id: "42",
      message_id: "777",
      sender_id: kOwnerId,
      sender_is_owner: true,
      text_sha256: sha256("Rotate nothing. Deploy at 9, key sk-live-abc123 is fine"),
      quote: "Rotate nothing. Deploy at 9, key *** is fine",
      from: kBox,
      to: kThread,
      relay_text_sha256: sha256(out.text),
    });
    const published = box.outbound.publicKey();
    expect(published).toMatchObject({ alg: "Ed25519", kid: envelope.kid });
    expect(JSON.stringify(published)).not.toMatch(/PRIVATE/);
    const key = crypto.createPublicKey(published.public_key_pem);
    expect(crypto.verify(null, Buffer.from(envelope.payload), key, Buffer.from(envelope.sig, "base64url"))).toBe(true);
    expect(crypto.verify(null, Buffer.from(envelope.payload.replace("777", "778")), key, Buffer.from(envelope.sig, "base64url"))).toBe(false);
    const message = { agent_name: kBox, text: out.text, metadata: out.metadata };
    expect(box.outbound.readProvenance(message)).toMatchObject({ verified: true, statement: { message_id: "777" } });
    expect(box.outbound.readProvenance({ ...message, text: out.text + " and also wire the money" }).verified).toBe(false);
    expect(box.outbound.readProvenance({ ...message, agent_name: kThread })).toBeNull();
    const again = box.outbound.prepareOutbound({ to: kThread, text: "replayed", provenanceRef: ref });
    expect(again.provenance).toBe(false);
    expect(again.metadata.relay_provenance).toBeUndefined();
    expect(fs.statSync(path.join(box.relayDir, "provenance-key.json")).mode & 0o777).toBe(0o600);
  });

  it("an expired or unknown claim signs nothing", () => {
    box = makeBox();
    box.ownerSays("hi");
    const ref = box.send({ to: kThread, text: "x" }).params.provenance_ref;
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.join(box.relayDir, "bridge.db"));
    db.prepare("UPDATE relay_provenance SET created_at = created_at - ? WHERE ref = ?").run(11 * 60 * 1000, ref);
    db.close();
    expect(box.outbound.prepareOutbound({ to: kThread, text: "late", provenanceRef: ref }).provenance).toBe(false);
    expect(box.outbound.prepareOutbound({ to: kThread, text: "made up", provenanceRef: "pv_" + "0".repeat(24) }).provenance).toBe(false);
    expect(box.outbound.prepareOutbound({ to: kThread, text: "bad shape", provenanceRef: "rr_x" }).provenance).toBe(false);
  });
});

describe("relay long messages both ways (PR4)", () => {
  let box;
  afterEach(() => {
    box?.cleanup();
    box = null;
  });

  it("the box agent's long send to a Capy thread leaves as part 1 and a result_ref; to anyone else it keeps the 16,000 cap", () => {
    box = makeBox();
    const text = Array.from({ length: 700 }, (_, index) => "line " + index + " " + "q".repeat(20)).join("\n");
    const out = box.outbound.prepareOutbound({ to: kThread, text });
    const ref = out.metadata.relay_result_ref;
    expect(ref).toMatch(/^rr_[a-f0-9]{24}$/);
    const stored = box.store.getResult(ref);
    expect(stored).toMatchObject({ sender: kThread, lane: null });
    expect(stored.parts.join("")).toBe(text);
    expect(stored.parts.every((part) => part.length <= kResultPartChars)).toBe(true);
    expect(out.metadata.relay_result_parts).toBe(stored.parts.length);
    expect(out.text.startsWith(stored.parts[0])).toBe(true);
    expect(out.text).toContain("Read parts 2-" + stored.parts.length + " with relay_result, result_ref " + ref);
    expect(box.outbound.prepareOutbound({ to: kThread, text: "short" })).toEqual({ text: "short", metadata: {}, provenance: false });
    expect(box.outbound.prepareOutbound({ to: "scout", text: "s".repeat(15000) }).text).toHaveLength(15000);
    expect(() => box.outbound.prepareOutbound({ to: "scout", text: "s".repeat(16001) })).toThrow(/only a Capy thread/);
    expect(() => box.outbound.prepareOutbound({ to: kThread, text: "s".repeat(64001) })).toThrow(/64000/);
  });

  it("a Capy thread's long send to the box is stored whole and the engine carries part 1 with relay_long_ref", () => {
    box = makeBox();
    const text = "w".repeat(30000);
    const out = box.outbound.prepareInbound({ sender: kThread, text });
    expect(out.metadata.relay_long_ref).toMatch(/^rl_[a-f0-9]{24}$/);
    expect(out.text.startsWith("w".repeat(12000))).toBe(true);
    expect(out.text).toContain("30000 characters long; the box reads it whole");
    expect(box.store.getLongMessage(out.metadata.relay_long_ref)).toEqual({ ref: out.metadata.relay_long_ref, sender: kThread, text });
    expect(box.outbound.prepareInbound({ sender: kThread, text: "short" })).toEqual({ text: "short", metadata: {} });
  });

  it("the tools pass the shaped text and metadata to the engine and tell the sender", async () => {
    const sent = [];
    const engine = { sendDm: async (token, to, text, metadata) => (sent.push({ to, text, metadata }), { message: { id: "9" } }) };
    const tools = createRelayTools({
      engine,
      getAuth: () => ({ agentToken: "t", agentName: kBox }),
      maxTextChars: 64000,
      boxTools: true,
      shapeOutbound: async ({ to, text, provenanceRef }) => ({ text: "part1", metadata: { relay_result_ref: "rr_" + "1".repeat(24), relay_result_parts: 3, ...(provenanceRef ? { relay_provenance: { v: 1 } } : {}) }, provenance: Boolean(provenanceRef) }),
    });
    expect(tools.list().find((tool) => tool.name === "relay_send").inputSchema.properties.provenance_ref).toBeDefined();
    const result = JSON.parse((await tools.call("relay_send", { to: kThread, text: "y".repeat(20000), provenance_ref: "pv_" + "2".repeat(24) })).content[0].text);
    expect(result).toMatchObject({ message_id: "9", parts: 3, owner_provenance: true });
    expect(sent[0]).toMatchObject({ to: kThread, text: "part1", metadata: { relay_result_ref: "rr_" + "1".repeat(24), relay_provenance: { v: 1 } } });
    expect(createRelayTools({ engine, getAuth: () => ({}) }).list().find((tool) => tool.name === "relay_send").inputSchema.properties.provenance_ref).toBeUndefined();
  });
});

describe("relay owner provenance: fix round (GST-2090 PR4 review)", () => {
  let box;
  afterEach(() => {
    box?.cleanup();
    box = null;
  });

  it("a requester OpenClaw names no sender for gets no ref, even on an owner turn", () => {
    box = makeBox();
    box.ownerSays("from someone in the group", { senderId: "5555" });
    expect(box.send({ to: kThread, text: "x" }, { channel: "telegram", senderIsOwner: true }).params?.provenance_ref ?? "").toBe("");
    expect(box.send({ to: kThread, text: "x" }, { channel: "telegram", senderId: null, senderIsOwner: true }).params?.provenance_ref ?? "").toBe("");
  });

  it("masks a credential that crosses the 2,000-character quote cut", () => {
    box = makeBox();
    const secret = "sk-live-" + "a1".repeat(20);
    box.ownerSays("x".repeat(1990) + " " + secret + " and more");
    const ref = box.send({ to: kThread, text: "x" }).params.provenance_ref;
    const outbound = createRelayOutbound({
      relayDir: box.relayDir,
      getStore: () => box.store,
      getBoxAgentName: () => kBox,
      maskText: (text) => text.split(secret).join("***"),
      logger: { log: () => {}, warn: () => {} },
    });
    const statement = JSON.parse(outbound.prepareOutbound({ to: kThread, text: "ok", provenanceRef: ref }).metadata.relay_provenance.payload);
    expect(statement.quote).toBe(("x".repeat(1990) + " *** and more").slice(0, 2000));
  });

  it("a send to an agent that is not a Capy thread spends the claim and carries no statement", () => {
    box = makeBox();
    box.ownerSays("Tell scout hello. Keep the acquisition private.");
    const ref = box.send({ to: "scout", text: "hello" }).params.provenance_ref;
    const out = box.outbound.prepareOutbound({ to: "scout", text: "hello", provenanceRef: ref });
    expect(out).toEqual({ text: "hello", metadata: {}, provenance: false });
    expect(box.store.claimProvenance(ref, 60_000)).toBeNull();
  });

  it("never replaces a signing key it cannot read: the send goes out unsigned and the file is kept", () => {
    box = makeBox();
    const file = path.join(box.relayDir, "provenance-key.json");
    fs.writeFileSync(file, "{ not json", { mode: 0o600 });
    box.ownerSays("hi");
    const ref = box.send({ to: kThread, text: "x" }).params.provenance_ref;
    expect(box.outbound.prepareOutbound({ to: kThread, text: "hi", provenanceRef: ref })).toEqual({ text: "hi", metadata: {}, provenance: false });
    expect(box.outbound.readProvenance({ agent_name: kBox, text: "hi", metadata: { relay_provenance: { v: 1 } } })).toMatchObject({ verified: false, statement: null });
    expect(() => box.outbound.publicKey()).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
    fs.writeFileSync(file, JSON.stringify({ version: 1 }));
    expect(() => box.outbound.publicKey()).toThrow(/no private key/);
  });

  it("keeps the signing key on the box: masked in relay text, its changes held for the owner, and backed up", () => {
    box = makeBox();
    box.outbound.publicKey();
    const file = path.join(box.relayDir, "provenance-key.json");
    const raw = fs.readFileSync(file, "utf8");
    const body = JSON.parse(raw).privateKeyPem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
    const { createRelayMasker } = require("../../lib/server/relay/mask");
    const masked = createRelayMasker({ rootDir: box.rootDir, env: {} })(raw);
    expect(masked).not.toContain(body);
    const { classifyRisk } = require("../../lib/plugin/relay-guard/confirm");
    expect(classifyRisk({ toolName: "exec", params: { command: "rm " + file } }).kind).toBe("high");
    expect(classifyRisk({ toolName: "exec", params: { command: "cp /tmp/k.json relay/provenance-key.json" } }).kind).toBe("high");
    expect(classifyRisk({ toolName: "write", params: { path: file, content: "{}" }, rootDir: box.rootDir }).kind).toBe("high");
    const { backupRelay } = require("../../lib/server/relay/backup");
    const { relayPaths } = require("../../lib/server/relay/constants");
    fs.writeFileSync(path.join(box.relayDir, "secrets.json"), "{}", { mode: 0o600 });
    const backupsDir = path.join(box.rootDir, "backups");
    const result = backupRelay({ paths: relayPaths(box.rootDir), backupsDir });
    expect(result.ok).toBe(true);
    expect(Object.keys(result.files)).toContain("provenance-key.json");
    expect(fs.readFileSync(path.join(result.path, "provenance-key.json"), "utf8")).toBe(raw);
    expect(fs.statSync(path.join(result.path, "provenance-key.json")).mode & 0o777).toBe(0o600);
  });
});


describe("relay owner provenance: a run never names a newer owner message (PR4 review)", () => {
  let box;
  afterEach(() => {
    box?.cleanup();
    box = null;
  });

  it("a message that arrives after a run's first tool call is not signed for that run, and is for the next run", () => {
    box = makeBox();
    const owner = { channel: "telegram", senderId: kOwnerId, senderIsOwner: true };
    box.ownerSays("do X", { messageId: "1" });
    box.handlers.before_tool_call({ toolName: "exec", params: { command: "ls" } }, { sessionKey: kOwnerSession, runId: "run-a", requester: owner });
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + 1000);
    try {
      box.ownerSays("stop, don't send that", { messageId: "2" });
      expect(box.send({ to: kThread, text: "x" }, owner, kOwnerSession, "run-a")).toEqual({});
      const ref = box.send({ to: kThread, text: "x" }, owner, kOwnerSession, "run-b").params.provenance_ref;
      expect(box.store.claimProvenance(ref, 60_000)).toMatchObject({ messageId: "2" });
      expect(box.send({ to: kThread, text: "x" }, owner, kOwnerSession, null)).toEqual({});
    } finally {
      spy.mockRestore();
    }
  });
});

describe("relay_reply names the other participant (PR4 review)", () => {
  it("the box replying to its own earlier message in a Capy DM pages and signs for the Capy thread, not itself", async () => {
    const shapes = [];
    const engine = {
      getMessage: async () => ({ id: "m1", agent_name: kBox, channel_id: "dm-1", metadata: {} }),
      conversations: async () => [{ channel_id: "dm-1", participants: [kBox, kThread] }],
      reply: async () => ({ id: "m2" }),
    };
    const tools = createRelayTools({
      engine,
      getAuth: () => ({ agentToken: "t", agentName: kBox, workspaceKey: "w" }),
      maxTextChars: 64000,
      boxTools: true,
      shapeOutbound: async ({ to, text }) => (shapes.push(to), { text, metadata: {}, provenance: false }),
    });
    const result = JSON.parse((await tools.call("relay_reply", { message_id: "m1", text: "y".repeat(20000) })).content[0].text);
    expect(result).toMatchObject({ message_id: "m2", in_reply_to: "m1" });
    expect(shapes).toEqual([kThread]);
    engine.conversations = async () => [{ channel_id: "dm-1", participants: ["scout", kThread] }];
    expect((await tools.call("relay_reply", { message_id: "m1", text: "hi" })).isError).toBe(true);
  });
});

