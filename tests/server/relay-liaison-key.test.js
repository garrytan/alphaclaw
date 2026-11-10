const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");
const { readRelayConfig } = require("../../lib/server/relay/config");
const { keySigningInput, kKeyPath, kKeyContentType } = require("../../lib/server/relay/key-auth");
const { resolveRelayTrust, ownerThreadBasisOf } = require("../../lib/plugin/relay-guard/trust");
const { setup, kOauthClient, expectHeldWithTap } = require("./helpers/relay-attested-harness");

// GST-2323 PR4: a liaison key. The holder keeps an Ed25519 private key in a
// 0600 file (relay-client.mjs keygen); the box knows only its public key
// from ALPHACLAW_RELAY_TRUSTED_BINDING_KEYS. A binding pinned that way is
// trusted like the owner only for messages it sent over the signed key path;
// the same binding over the MCP connector, whose capability sits in a
// transcript, stays a plain delegate and taps.
const kScript = path.resolve(__dirname, "../../scripts/relay-client.mjs");
const kAgent = "capy-25cf4e98b5b6";

const runClient = (args, env = {}) =>
  new Promise((resolve) => {
    childProcess.execFile(process.execPath, [kScript, ...args], { env: { PATH: process.env.PATH, HOME: env.HOME || os.tmpdir(), ...env }, timeout: 20000 }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });

const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });

describe("relay liaison key (GST-2323 PR4)", () => {
  let ctx;
  let server;
  let home;
  let box;
  let keyFile;
  afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    server = null;
    ctx?.cleanup();
    ctx = null;
    if (home) fs.rmSync(home, { recursive: true, force: true });
    home = null;
  });

  // A box with kAgent bound on the plain connector as a delegate, and a key
  // made on the "holder's machine" and registered in the deployment env.
  const start = async ({ register = true } = {}) => {
    ctx = setup({ env: {} });
    ctx.oauthDelegate(kAgent);
    server = await listen(ctx.app);
    box = "http://127.0.0.1:" + server.address().port;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "liaison-home-"));
    const made = await runClient(["keygen", "--box", box, "--agent", kAgent], { HOME: home });
    expect(made.code).toBe(0);
    const out = JSON.parse(made.stdout);
    keyFile = out.key_file;
    if (register) ctx.setConfig({ ALPHACLAW_RELAY_TRUSTED_BINDING_KEYS: out.env_entry });
    return out;
  };
  const keySend = (text = "please fix the box config") => runClient(["send", "--box", box, "--key-file", keyFile, "--to", "wintermute", "--text", text], { HOME: home });
  const lastMetadata = () => ctx.remoteSends.at(-1).data;
  const mcpSend = async () => {
    const tools = ctx.relayRemote.ensureOpen().tools;
    const result = await tools.call({ clientId: kOauthClient, name: "relay_send", args: { as: kAgent, capability: "arcap_" + kAgent, to: "wintermute", text: "x" } });
    expect(result.isError).toBeFalsy();
    return lastMetadata();
  };
  const signed = ({ agent = kAgent, body = JSON.stringify({ tool: "relay_history", args: { with: "wintermute" } }), timestamp = String(Date.now()), nonce = crypto.randomBytes(18).toString("base64url"), privateKey } = {}) => {
    const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
    const signature = crypto.sign(null, Buffer.from(keySigningInput({ method: "POST", path: kKeyPath, agent, timestamp, nonce, bodyHash })), privateKey).toString("base64url");
    return { body, headers: { "content-type": kKeyContentType, "x-relay-agent": agent, "x-relay-timestamp": timestamp, "x-relay-nonce": nonce, "x-relay-signature": signature } };
  };
  const post = ({ body, headers }) => {
    let req = request(ctx.app).post(kKeyPath);
    for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
    return req.send(body);
  };
  const holderKey = () => crypto.createPrivateKey({ key: Buffer.from(JSON.parse(fs.readFileSync(keyFile, "utf8")).private_key, "base64url"), format: "der", type: "pkcs8" });

  it("makes the key file 0600 and prints only the public key", async () => {
    const out = await start();
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    expect(out).toMatchObject({ agent: kAgent, public_key: stored.public_key, env_entry: kAgent + ":" + stored.public_key });
    expect(JSON.stringify(out)).not.toContain(stored.private_key);
    expect(path.dirname(keyFile)).toBe(path.join(home, ".capy", "work", "relay"));
    const again = await runClient(["keygen", "--box", box, "--agent", kAgent], { HOME: home });
    expect(again.code).toBe(1);
    expect(JSON.parse(again.stderr).error).toBe("key_exists");
  });

  it("trusts the binding like the owner for a message signed with its key: zero rows, zero notices", async () => {
    const out = await start();
    const sent = await keySend();
    expect(sent.code).toBe(0);
    expect(sent.stdout + sent.stderr).not.toContain(JSON.parse(fs.readFileSync(keyFile, "utf8")).private_key);
    const metadata = lastMetadata();
    expect(metadata.relay_key).toMatch(/^[a-f0-9]{16}$/);
    expect(readRelayConfig({ env: { ALPHACLAW_RELAY_TRUSTED_BINDING_KEYS: out.env_entry } }).trustedBindingKeys[kAgent].fingerprint).toBe(metadata.relay_key);
    const run = await ctx.deliver(kAgent, metadata);
    expect(ctx.bridgeStore.get(run.messageId)).toMatchObject({ trust: "delegate", pinnedBinding: kAgent, keyAuth: metadata.relay_key });
    for (const [label, toolName, params] of ctx.highRiskCalls) expect(ctx.call(run, toolName, params), label).toEqual({});
    expect(await ctx.call(run, "secrets", { action: "list" })).toEqual({});
    expect(ctx.confirmationCount()).toBe(0);
    ctx.confirmations.tick();
    expect(ctx.notices).toEqual([]);
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...run.ctx, requireTrustedOwner: true })).toMatchObject({ tier: "delegate", attested: false, attestationReason: "pinned_binding", ownerThread: true });
  });

  it("keeps the same binding's MCP-connector messages a plain delegate that taps, one sent just before the key went in included", async () => {
    const out = await start({ register: false });
    const metadata = await mcpSend();
    ctx.setConfig({ ALPHACLAW_RELAY_TRUSTED_BINDING_KEYS: out.env_entry });
    expect(metadata.relay_key).toBeUndefined();
    const run = await ctx.deliver(kAgent, metadata);
    expect(ctx.bridgeStore.get(run.messageId)).toMatchObject({ trust: "delegate", pinnedBinding: null, keyAuth: null });
    expectHeldWithTap(ctx, run, "write", { path: ctx.openclawJson, content: "{}" });
    expect((await ctx.call(run, "secrets", { action: "list" })).block).toBe(true);
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...run.ctx, requireTrustedOwner: true })).toMatchObject({ tier: "peer", reason: "owner_not_trusted" });
  });

  it("does not pin a message whose relay_key is not the registered key's, or once the key is removed", async () => {
    const out = await start();
    await keySend();
    const metadata = lastMetadata();
    const forged = await ctx.deliver(kAgent, { ...metadata, relay_key: "0123456789abcdef" });
    expect(ctx.bridgeStore.get(forged.messageId)).toMatchObject({ pinnedBinding: null });
    ctx.setConfig({});
    const removed = await ctx.deliver(kAgent, metadata);
    expect(ctx.bridgeStore.get(removed.messageId)).toMatchObject({ trust: "delegate", pinnedBinding: null });
    expectHeldWithTap(ctx, removed, "write", { path: ctx.openclawJson, content: "{}" });
    expect((await keySend()).stderr).toContain("key_not_registered");
    expect(out.env_entry).toContain(kAgent);
  });

  it("ends a running turn's pin at the next sweep once the key is replaced or removed", async () => {
    await start();
    await keySend();
    const run = await ctx.deliver(kAgent, lastMetadata());
    expect(await ctx.call(run, "secrets", { action: "list" })).toEqual({});
    const other = crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x;
    ctx.setConfig({ ALPHACLAW_RELAY_TRUSTED_BINDING_KEYS: kAgent + ":" + other });
    await ctx.tick();
    expect(ctx.bridgeStore.get(run.messageId)).toMatchObject({ trust: "delegate", pinnedBinding: null });
    expect((await ctx.call(run, "secrets", { action: "list" })).block).toBe(true);
  });

  it("refuses a bad signature, a replay, a stale timestamp, an unregistered agent and a malformed request, each with no send", async () => {
    await start();
    const privateKey = holderKey();
    const sends = ctx.remoteSends.length;
    const good = signed({ privateKey });
    expect((await post(good)).status).toBe(200);
    const replay = await post(good);
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe("key_auth_replayed");
    const tampered = signed({ privateKey });
    tampered.body = JSON.stringify({ tool: "relay_send", args: { to: "wintermute", text: "x" } });
    expect((await post(tampered)).body.error).toBe("key_auth_invalid");
    const stranger = crypto.generateKeyPairSync("ed25519").privateKey;
    expect((await post(signed({ privateKey: stranger }))).body.error).toBe("key_auth_invalid");
    expect((await post(signed({ privateKey, timestamp: String(Date.now() - 6 * 60 * 1000) }))).body.error).toBe("key_auth_stale");
    expect((await post(signed({ privateKey, agent: "capy-0a1b2c3d4e5f" }))).body.error).toBe("key_not_registered");
    const unsigned = signed({ privateKey });
    delete unsigned.headers["x-relay-signature"];
    expect((await post(unsigned)).body.error).toBe("key_auth_malformed");
    expect(ctx.remoteSends.length).toBe(sends);
    expect(ctx.store().db.prepare("SELECT COUNT(*) AS n FROM relay_key_nonces").get().n).toBe(1);
  });

  it("retires the capability once the key is registered, and renews the binding and its wake URL over the key path", async () => {
    await start();
    const tools = ctx.relayRemote.ensureOpen().tools;
    const capabilityCall = (name, extra = {}) => tools.call({ clientId: kOauthClient, name, args: { as: kAgent, capability: "arcap_" + kAgent, ...extra } });
    for (const [name, extra] of [
      ["relay_send", { to: "wintermute", text: "x" }],
      ["relay_history", { with: "wintermute" }],
      ["relay_handoff", { successor_thread: "jam_THIEF" }],
      ["relay_unbind", {}],
      ["relay_bind", { thread_id: "jam_A", webhook_url: "https://api.capy.ai/webhooks/automations/tok_thiefthiefthief" }],
    ]) {
      const result = await capabilityCall(name, extra);
      expect(result.isError, name).toBe(true);
      expect(JSON.parse(result.content[0].text).error, name).toBe("key_required");
    }
    expect(ctx.store().handoffs.openFor(kAgent)).toBeFalsy();
    const before = ctx.store().bindings.get(kAgent);
    const hook = "https://api.capy.ai/webhooks/automations/tok_successorsuccessor";
    const renewed = await runClient(["renew", "--box", box, "--key-file", keyFile, "--webhook-url", hook], { HOME: home });
    expect(renewed.code).toBe(0);
    expect(JSON.parse(renewed.stdout)).toMatchObject({ agent: kAgent, webhook_host: "api.capy.ai" });
    const after = ctx.store().bindings.get(kAgent);
    expect(after).toMatchObject({ webhookUrl: hook, generation: before.generation, capabilityHash: before.capabilityHash });
    expect(after.until).toBeGreaterThan(before.until);
    const refused = await runClient(["renew", "--box", box, "--key-file", keyFile, "--webhook-url", "https://evil.example/hook"], { HOME: home });
    expect(refused.code).toBe(1);
    const grant = ctx.store().grants.forAgent(kAgent)[0];
    ctx.store().db.prepare("UPDATE relay_grants SET require_route = 'tailnet' WHERE id = ?").run(grant.id);
    const offRoute = await runClient(["renew", "--box", box, "--key-file", keyFile], { HOME: home });
    expect(offRoute.code).toBe(1);
    expect(JSON.parse(offRoute.stderr).error).toBe("route_required");
    ctx.store().db.prepare("UPDATE relay_grants SET require_route = 'any' WHERE id = ?").run(grant.id);
    ctx.setConfig({});
    expect((await capabilityCall("relay_history", { with: "wintermute" })).isError).toBeFalsy();
  });

  it("serves send, history, result and renew only, and never the binding's other tools", async () => {
    await start();
    const privateKey = holderKey();
    const unbound = await post(signed({ privateKey, body: JSON.stringify({ tool: "relay_result", args: { result_ref: "rr_nope" } }) }));
    expect(unbound.status).toBe(404);
    for (const tool of ["relay_bind", "relay_unbind", "relay_handoff", "relay_claim", "relay_inbox", "relay_reply", "relay_agents"]) {
      const res = await post(signed({ privateKey, body: JSON.stringify({ tool, args: {} }) }));
      expect(res.status, tool).toBe(400);
      expect(res.body.error, tool).toBe("invalid_input");
    }
    const history = await runClient(["history", "--box", box, "--key-file", keyFile, "--with", "wintermute"], { HOME: home });
    expect(history.code).toBe(0);
    expect(JSON.parse(history.stdout)).toBeTypeOf("object");
  });

  it("refuses a key file anyone else can read", async () => {
    await start();
    fs.chmodSync(keyFile, 0o644);
    const sent = await keySend();
    expect(sent.code).toBe(2);
    expect(JSON.parse(sent.stderr).error).toBe("key_file_mode");
    expect(ctx.remoteSends.length).toBe(0);
  });

  it("refuses a key-pinned binding's change to the key list, with no row", async () => {
    await start();
    await keySend();
    const run = await ctx.deliver(kAgent, lastMetadata());
    const result = await ctx.call(run, "exec", { command: "echo ALPHACLAW_RELAY_TRUSTED_BINDING_KEYS=capy-ffffffffffff:x >> " + ctx.dotEnv });
    expect(result.block).toBe(true);
    expect(result.blockReason).toContain("would change what decides relay trust on this box");
    expect(ctx.confirmationCount()).toBe(0);
    expect(ownerThreadBasisOf({ rootDir: ctx.rootDir, sender: kAgent, messageId: run.messageId })).toBe("pinned_binding");
  });

  it("reads keys from the deployment env only and drops entries that do not fit", () => {
    const key = crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x;
    const config = readRelayConfig({ env: { ALPHACLAW_RELAY_TRUSTED_BINDING_KEYS: kAgent + ":" + key + ", lupe:" + key + ", " + kAgent + ":short" } });
    expect(Object.keys(config.trustedBindingKeys)).toEqual([kAgent]);
    expect(config.trustedBindingsRejected).toBe(2);
    expect(readRelayConfig({ env: {} }).trustedBindingKeys).toEqual({});
    expect(require("../../lib/server/deployment-only-env").kDeploymentOnlyEnvKeys).toContain("ALPHACLAW_RELAY_TRUSTED_BINDING_KEYS");
  });
});
