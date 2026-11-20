const os = require("os");
const path = require("path");
const WebSocket = require("ws");
const { execFileSync } = require("child_process");
const { kLiveEnabled, openclawCliUsable, repoOpenclawBin, scrubTestRunnerEnv, waitFor } = require("./live-helpers");
const { kBootTimeoutMs, startControlUiInstall } = require("./control-ui-live");
const { connectGateway, newDevice } = require("./gateway-protocol-probe");

// LIVE tier: an internet client that reaches the gateway through AlphaClaw
// without a session must get what the pinned OpenClaw gives a remote client,
// not its local-client exemptions.
//
//   client on a non-loopback address ── ws://<addr>:<alphaclaw>/ ──▶ AlphaClaw catch-all
//        ──▶ gateway on 127.0.0.1 with X-Forwarded-For: <addr> (trustedProxies: 127.0.0.1)
//
// OpenClaw counts a loopback socket with no forwarded headers as local
// ("direct-local"): it then keeps a shared-token client's self-declared
// scopes with no device, pairs new devices, nodes and setup codes without the
// owner, allows host-only methods, skips the auth lockout and counts every
// such client against one pre-auth socket budget. Before this, AlphaClaw
// stripped forwarded headers on these forwards, so every internet client got
// all of that. The signed-in Control UI, a paired device's token and a client
// on this host keep working as before.
//
// Run: OPENCLAW_LIVE_E2E=1 npx vitest run tests/live/gateway-public-client-locality.e2e.test.js --no-file-parallelism
const describeLive = kLiveEnabled ? describe : describe.skip;

const kGatewayToken = `live-locality-${Date.now().toString(36)}-gwtoken`;
const kSetupPassword = "live-locality-pass";
const kAdminScopes = ["operator.admin", "operator.read", "operator.write"];
const kPublicAddress =
  Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address || "";
if (kLiveEnabled && !kPublicAddress) console.warn("[locality] no non-loopback IPv4 address: suite skipped");

describeLive("live: sessionless clients through AlphaClaw are remote to the gateway", () => {
  const itLive = openclawCliUsable() && kPublicAddress ? it : it.skip;
  let install;
  let publicUrl;
  let gatewayUrl;
  let publicOrigin;
  let loginJar = "";

  const viaPublic = (options) => connectGateway({ url: publicUrl, localAddress: kPublicAddress, ...options });
  const onGatewayHost = (options) => connectGateway({ url: gatewayUrl, ...options });
  const pairAdminDevice = async () => {
    const device = newDevice();
    const seeded = await onGatewayHost({ device, auth: { token: kGatewayToken }, scopes: kAdminScopes });
    expect(seeded.connect).toMatchObject({ ok: true });
    return { device, deviceToken: seeded.deviceToken };
  };
  const mintLimitedSetupCode = () => {
    const env = {
      ...scrubTestRunnerEnv(),
      HOME: install.rootDir,
      OPENCLAW_HOME: install.rootDir,
      OPENCLAW_CONFIG_PATH: path.join(install.rootDir, ".openclaw", "openclaw.json"),
      OPENCLAW_STATE_DIR: path.join(install.rootDir, ".openclaw"),
      XDG_CONFIG_HOME: path.join(install.rootDir, ".openclaw"),
      OPENCLAW_NO_AUTO_UPDATE: "1",
    };
    const out = execFileSync(process.execPath, [repoOpenclawBin(), "qr", "--url", "wss://box.example/", "--limited", "--json"], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 120_000,
    });
    const { setupCode } = JSON.parse(out.slice(out.indexOf("{")));
    return JSON.parse(Buffer.from(setupCode, "base64url").toString("utf8")).bootstrapToken;
  };

  beforeAll(async () => {
    if (!openclawCliUsable() || !kPublicAddress) return;
    install = await startControlUiInstall({
      label: "public-client-locality",
      setupPassword: kSetupPassword,
      gatewayToken: kGatewayToken,
      extraEnv: (port) => ({ ALPHACLAW_SETUP_URL: `http://box.example:${port}` }),
    });
    publicUrl = `ws://${kPublicAddress}:${install.port}/`;
    publicOrigin = `http://box.example:${install.port}`;
    gatewayUrl = `ws://127.0.0.1:${install.readOpenclawJson().gateway.port}/`;
    // /health turns ready before the gateway admits connects (it answers
    // UNAVAILABLE while its startup finishes).
    await waitFor(
      async () => (await onGatewayHost({ clientId: "gateway-client", clientMode: "backend", auth: { token: kGatewayToken }, timeoutMs: 5_000 })).connect?.ok === true,
      kBootTimeoutMs,
      "gateway admits a connect",
    );
    const login = await fetch(`http://${kPublicAddress}:${install.port}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: kSetupPassword }),
    });
    expect(login.status).toBe(200);
    loginJar = (login.headers.getSetCookie?.() || []).map((entry) => entry.split(";")[0]).join("; ");
  }, kBootTimeoutMs + 60_000);

  afterAll(async () => {
    await install?.stop();
  });

  const signedInControlUi = (device) =>
    viaPublic({
      url: `ws://${kPublicAddress}:${install.port}/openclaw`,
      origin: publicOrigin,
      headers: { cookie: loginJar, host: `box.example:${install.port}` },
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
      platform: "web",
      device,
      auth: { token: kGatewayToken },
      scopes: kAdminScopes,
    });

  // Keeps working.

  itLive("a signed-in admin's Control UI still pairs its browser without a prompt", async () => {
    const result = await signedInControlUi(newDevice());
    expect(result.connect).toMatchObject({ ok: true, role: "operator" });
    expect(result.connect.scopes).toEqual(expect.arrayContaining(kAdminScopes));
  }, 60_000);

  itLive("a paired device's token still works over the public URL with its own scopes", async () => {
    const device = newDevice();
    const seeded = await onGatewayHost({ clientId: "openclaw-ios", clientMode: "ui", platform: "ios", device, auth: { token: kGatewayToken }, scopes: ["operator.read", "operator.write"] });
    const result = await viaPublic({ clientId: "openclaw-ios", clientMode: "ui", platform: "ios", device, auth: { deviceToken: seeded.deviceToken }, scopes: ["operator.read", "operator.write"], calls: [{ method: "config.get" }] });
    expect(result.connect).toMatchObject({ ok: true, scopes: ["operator.read", "operator.write"] });
    expect(result.calls).toEqual([{ method: "config.get", ok: true, error: null }]);
  }, 60_000);

  itLive("a client on this host that comes through AlphaClaw is still local", async () => {
    const result = await connectGateway({ url: `ws://127.0.0.1:${install.port}/`, auth: { token: kGatewayToken }, scopes: kAdminScopes });
    expect(result.connect).toMatchObject({ ok: true });
    expect(result.connect.scopes).toEqual(expect.arrayContaining(kAdminScopes));
  }, 60_000);

  // Local-client exemptions a public client no longer gets.

  itLive("the gateway token alone, with no device, grants no scopes", async () => {
    for (const [clientId, clientMode] of [["cli", "cli"], ["gateway-client", "backend"]]) {
      const result = await viaPublic({ clientId, clientMode, auth: { token: kGatewayToken }, scopes: kAdminScopes, calls: [{ method: "config.get" }] });
      expect(result.connect, clientId).toMatchObject({ ok: true, scopes: [] });
      expect(result.calls[0].ok, clientId).toBe(false);
    }
  }, 60_000);

  itLive("a new operator device or node with the gateway token waits for the owner's approval", async () => {
    const operator = await viaPublic({ device: newDevice(), auth: { token: kGatewayToken }, scopes: kAdminScopes });
    expect(operator.connect).toMatchObject({ ok: false, code: "NOT_PAIRED", detailCode: "PAIRING_REQUIRED" });
    const nodeDevice = newDevice();
    let node = null;
    for (const deadline = Date.now() + 30_000; ; await new Promise((resolve) => setTimeout(resolve, 1_000))) {
      node = await viaPublic({ clientId: "node-host", clientMode: "node", role: "node", device: nodeDevice, auth: { token: kGatewayToken } });
      if (node.connect?.code !== "UNAVAILABLE" || Date.now() > deadline) break;
    }
    expect(node.connect, JSON.stringify(node.connect)).toMatchObject({ ok: false, code: "NOT_PAIRED", detailCode: "PAIRING_REQUIRED" });
  }, 60_000);

  itLive("a setup code pairs only after the owner approves", async () => {
    const result = await viaPublic({ clientId: "openclaw-ios", clientMode: "ui", platform: "ios", device: newDevice(), auth: { bootstrapToken: mintLimitedSetupCode() }, scopes: ["operator.read", "operator.write"] });
    expect(result.connect).toMatchObject({ ok: false, code: "NOT_PAIRED", detailCode: "PAIRING_REQUIRED" });
  }, 180_000);

  itLive("host-only methods are refused even to an admin device", async () => {
    const { device, deviceToken } = await pairAdminDevice();
    const result = await viaPublic({ device, auth: { deviceToken }, scopes: kAdminScopes, calls: [{ method: "plugins.install", params: { source: "local", path: "/nonexistent-locality-test" } }] });
    expect(result.connect).toMatchObject({ ok: true });
    expect(result.calls[0].ok).toBe(false);
    expect(result.calls[0].error).toMatch(/connection from the Gateway host/);
  }, 60_000);

  itLive("a loopback Origin from a public client is not accepted", async () => {
    const result = await viaPublic({ origin: "http://localhost:5173", clientId: "openclaw-control-ui", clientMode: "webchat", platform: "web", device: newDevice(), auth: { token: kGatewayToken }, scopes: kAdminScopes });
    expect(result.connect).toMatchObject({ ok: false, detailCode: "CONTROL_UI_ORIGIN_NOT_ALLOWED" });
  }, 60_000);

  itLive("idle unauthenticated sockets from the internet cannot lock out the box's own clients", async () => {
    const sockets = [];
    await Promise.all(
      Array.from({ length: 140 }, () =>
        new Promise((resolve) => {
          const ws = new WebSocket(publicUrl, { localAddress: kPublicAddress });
          sockets.push(ws);
          setTimeout(resolve, 5_000);
          ws.on("open", resolve);
          ws.on("error", resolve);
          ws.on("unexpected-response", resolve);
        }),
      ),
    );
    try {
      const local = await onGatewayHost({ clientId: "gateway-client", clientMode: "backend", auth: { token: kGatewayToken }, scopes: ["operator.read"], timeoutMs: 8_000 });
      expect(local.upgradeStatus).toBe(101);
      expect(local.connect).toMatchObject({ ok: true });
    } finally {
      for (const ws of sockets) ws.terminate();
    }
  }, 120_000);

  // Last: these lock this test's address out of the gateway for a while.
  itLive("token guesses from the internet are locked out, and the signed-in Control UI is not", async () => {
    const guess = (i, origin) => viaPublic({ origin, device: newDevice(), auth: { token: `wrong-${i}` } });
    const firstLockout = async (origin) => {
      for (let i = 1; i <= 15; i += 1) {
        if ((await guess(i, origin)).connect?.reason === "rate_limited") return i;
      }
      return null;
    };
    expect(await firstLockout(null)).not.toBeNull();
    expect(await firstLockout(publicOrigin)).not.toBeNull();
    const result = await signedInControlUi(newDevice());
    expect(result.connect).toMatchObject({ ok: true });
  }, 240_000);
});
