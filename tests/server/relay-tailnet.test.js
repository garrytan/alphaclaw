const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const request = require("supertest");
const { readRelayConfig } = require("../../lib/server/relay/config");
const { buildRelayBuiltinSidecars } = require("../../lib/server/relay");
const { relayPaths } = require("../../lib/server/relay/constants");
const {
  kTailscaledSidecarName,
  parseProxyV2,
  createTailnetIngress,
  createTailnetGate,
  createTailnetService,
} = require("../../lib/server/relay/tailnet");
const { buildRelayCards } = require("../../lib/server/relay/doctor-card");
const { classifyAnchor, classifyKeyRead } = require("../../lib/plugin/relay-guard/confirm");
const { setup } = require("./helpers/relay-attested-harness");

// GST-2368: the relay's client paths over the operator's tailnet. tailscaled
// (userspace) serves a tailnet port with a PROXY v2 header to a loopback
// ingress; the ingress asks tailscaled who the caller is and marks the
// socket. Here a small TCP forwarder plays tailscaled's serve (it writes the
// header a tailnet peer at kPeer would get) and a stub plays WhoIs.
const kScript = path.resolve(__dirname, "../../scripts/relay-client.mjs");
const kAgent = "capy-25cf4e98b5b6";
const kPeer = "100.64.0.2";
const kSignature = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
const quiet = { log() {}, warn() {}, error() {} };

const proxyHeaderV4 = (source, sourcePort = 41000, dest = "100.64.0.1", destPort = 80) => {
  const header = Buffer.alloc(28);
  kSignature.copy(header, 0);
  header[12] = 0x21;
  header[13] = 0x11;
  header.writeUInt16BE(12, 14);
  source.split(".").forEach((part, i) => (header[16 + i] = Number(part)));
  dest.split(".").forEach((part, i) => (header[20 + i] = Number(part)));
  header.writeUInt16BE(sourcePort, 24);
  header.writeUInt16BE(destPort, 26);
  return header;
};

const proxyHeaderV6 = () => {
  const header = Buffer.alloc(52);
  kSignature.copy(header, 0);
  header[12] = 0x21;
  header[13] = 0x21;
  header.writeUInt16BE(36, 14);
  Buffer.from("fd7a115ca1e000000000000000000002", "hex").copy(header, 16);
  Buffer.from("fd7a115ca1e000000000000000000001", "hex").copy(header, 32);
  header.writeUInt16BE(41000, 48);
  header.writeUInt16BE(80, 50);
  return header;
};

// tailscale serve --tcp --proxy-protocol=2, played locally: every
// connection gets a PROXY header naming source, then the bytes as sent.
const startServe = (ingressPort, source = kPeer) =>
  new Promise((resolve) => {
    const server = net.createServer((client) => {
      const upstream = net.connect(ingressPort, "127.0.0.1", () => {
        upstream.write(proxyHeaderV4(source));
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });

const close = (server) => new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));

const runClient = (args, env = {}) =>
  new Promise((resolve) => {
    childProcess.execFile(process.execPath, [kScript, ...args], { env: { PATH: process.env.PATH, HOME: env.HOME || os.tmpdir(), ...env }, timeout: 20000 }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });

const whoisStub = (known = { [kPeer]: { node: "liaison.tailnet.ts.net", nodeId: "n1", tags: ["tag:relay-liaison"], user: null } }) => async (address) =>
  known[address] ? { ...known[address], address } : null;

describe("PROXY v2 header", () => {
  it("reads an IPv4 and an IPv6 source, waits for a partial header and refuses anything else", () => {
    expect(parseProxyV2(proxyHeaderV4(kPeer, 4242))).toEqual({ length: 28, address: kPeer, port: 4242 });
    expect(parseProxyV2(Buffer.concat([proxyHeaderV4(kPeer), Buffer.from("GET / HTTP/1.1\r\n")]))).toMatchObject({ length: 28, address: kPeer });
    expect(parseProxyV2(proxyHeaderV6())).toEqual({ length: 52, address: "fd7a:115c:a1e0:0:0:0:0:2", port: 41000 });
    expect(parseProxyV2(proxyHeaderV4(kPeer).subarray(0, 20))).toBeNull();
    expect(parseProxyV2(kSignature.subarray(0, 5))).toBeNull();
    expect(parseProxyV2(Buffer.from("GET / HTTP/1.1\r\nHost: x\r\n\r\n"))).toEqual({ error: "not_proxy_v2" });
    const local = proxyHeaderV4(kPeer);
    local[12] = 0x20;
    expect(parseProxyV2(local)).toEqual({ error: "not_proxy_command" });
    const unix = proxyHeaderV4(kPeer);
    unix[13] = 0x31;
    expect(parseProxyV2(unix)).toEqual({ error: "unsupported_family" });
  });
});

describe("relay over the tailnet route (GST-2368)", () => {
  let ctx;
  let ingress;
  let publicServer;
  let serve;
  let home;
  let mode;
  afterEach(async () => {
    await close(serve);
    await close(publicServer);
    await ingress?.close();
    ctx?.cleanup();
    if (home) fs.rmSync(home, { recursive: true, force: true });
    ctx = ingress = publicServer = serve = home = null;
  });

  const start = async ({ tailnetMode = "on", allowedTags = ["tag:relay-liaison"], whois = whoisStub(), source = kPeer } = {}) => {
    mode = tailnetMode;
    let identityOf = () => null;
    ctx = setup({
      env: {},
      routeOf: (req) => (identityOf(req) ? "tailnet" : "public"),
      gate: createTailnetGate({ getMode: () => mode, identityOf: (req) => identityOf(req) }),
    });
    ingress = createTailnetIngress({ handler: ctx.app, whois, allowedTags, logger: quiet });
    identityOf = ingress.identityOf;
    const ingressPort = await ingress.listen();
    serve = await startServe(ingressPort, source);
    publicServer = await listen(ctx.app);
    ctx.oauthDelegate(kAgent);
    home = fs.mkdtempSync(path.join(os.tmpdir(), "tailnet-home-"));
    const box = "http://127.0.0.1:" + publicServer.address().port;
    const made = await runClient(["keygen", "--box", box, "--agent", kAgent], { HOME: home });
    expect(made.code).toBe(0);
    const out = JSON.parse(made.stdout);
    ctx.setConfig({ ALPHACLAW_RELAY_TRUSTED_BINDING_KEYS: out.env_entry });
    return { box, keyFile: out.key_file, tailnet: "http://127.0.0.1:" + serve.address().port, ingressPort };
  };
  const send = (box, keyFile, extra = []) => runClient(["send", "--box", box, "--key-file", keyFile, "--to", "wintermute", "--text", "hello", ...extra], { HOME: home });

  it("stamps relay_route tailnet on a key-signed send that came through the ingress, and public otherwise", async () => {
    const { box, keyFile, tailnet } = await start();
    const overTailnet = await send(box, keyFile, ["--via", tailnet]);
    expect(overTailnet.code, overTailnet.stderr).toBe(0);
    expect(ctx.remoteSends.at(-1).data.relay_route).toBe("tailnet");
    const overPublic = await send(box, keyFile);
    expect(overPublic.code, overPublic.stderr).toBe(0);
    expect(ctx.remoteSends.at(-1).data.relay_route).toBe("public");
  });

  it("never takes the tailnet route from a header sent to the public port", async () => {
    const { box, keyFile } = await start();
    const res = await request(ctx.app).post("/relay/key/call").set("X-Forwarded-For", kPeer).set("Forwarded", "for=" + kPeer).send("{}");
    expect(res.status).not.toBe(404);
    expect((await send(box, keyFile)).code).toBe(0);
    expect(ctx.remoteSends.at(-1).data.relay_route).toBe("public");
  });

  it("in required mode refuses the client paths on the public port and keeps the pages a person opens", async () => {
    const { box, keyFile, tailnet } = await start({ tailnetMode: "required" });
    const refused = await send(box, keyFile);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stderr).error).toBe("tailnet_required");
    for (const route of ["/relay/key/call", "/relay/mcp", "/RELAY/MCP/", "/relay/key/call/"]) {
      const res = await request(ctx.app).post(route).send("{}");
      expect(res.status, route).toBe(403);
      expect(res.body.error, route).toBe("tailnet_required");
    }
    expect((await request(ctx.app).get("/.well-known/oauth-authorization-server")).status).toBe(200);
    expect((await request(ctx.app).get("/relay/oauth/consent?request=x")).status).not.toBe(403);
    expect(ctx.remoteSends).toHaveLength(0);
    const ok = await send(box, keyFile, ["--via", tailnet]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ctx.remoteSends.at(-1).data.relay_route).toBe("tailnet");
  });

  it("serves only the relay's client paths on the ingress", async () => {
    const { tailnet } = await start();
    for (const route of ["/api/relay/remote", "/.well-known/oauth-authorization-server", "/relay/oauth/consent", "/relay/internal/outbound"]) {
      const res = await fetch(tailnet + route);
      expect(res.status, route).toBe(404);
      expect((await res.json()).error, route).toBe("not_found");
    }
  });

  it("lets a grant that requires the tailnet through on the ingress only", async () => {
    const { box, keyFile, tailnet } = await start();
    const store = ctx.relayRemote.ensureOpen().store;
    for (const grant of store.grants.forAgent(kAgent)) ctx.relayRemote.revokeGrant?.({ id: grant.id, actor: "legacy" });
    ctx.relayRemote.createGrant({ agent: kAgent, requireRoute: "tailnet", actor: "legacy" });
    const publicSend = await send(box, keyFile);
    expect(publicSend.code).toBe(1);
    expect(JSON.parse(publicSend.stderr).error).toBe("route_required");
    const tailnetSend = await send(box, keyFile, ["--via", tailnet]);
    expect(tailnetSend.code, tailnetSend.stderr).toBe(0);
  });

  it("drops a connection with no PROXY header, an unknown tailnet peer, a tag that is not allowed, or any peer when no tag is allowed", async () => {
    const { ingressPort } = await start();
    const raw = (port, payload) =>
      new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1", () => socket.write(payload));
        let data = "";
        socket.on("data", (chunk) => (data += chunk));
        socket.on("close", () => resolve(data));
        socket.on("error", () => resolve(data));
      });
    const get = Buffer.from("POST /relay/key/call HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n");
    expect(await raw(ingressPort, get)).toBe("");
    expect(await raw(ingressPort, Buffer.concat([proxyHeaderV4("100.64.0.9"), get]))).toBe("");
    await ingress.close();
    ingress = createTailnetIngress({
      handler: ctx.app,
      whois: whoisStub({ [kPeer]: { node: "laptop", nodeId: "n2", tags: [], user: "someone@example.com" } }),
      allowedTags: ["tag:relay-liaison"],
      logger: quiet,
    });
    const port = await ingress.listen();
    expect(await raw(port, Buffer.concat([proxyHeaderV4(kPeer), get]))).toBe("");
    await ingress.close();
    ingress = createTailnetIngress({ handler: ctx.app, whois: whoisStub(), allowedTags: [], logger: quiet });
    const open = await ingress.listen();
    expect(await raw(open, Buffer.concat([proxyHeaderV4(kPeer), get]))).toBe("");
    expect(ctx.remoteSends).toHaveLength(0);
  });

  it("goes through a userspace tailscaled's loopback HTTP proxy with --proxy", async () => {
    const { box, keyFile, tailnet } = await start();
    const seen = [];
    const proxy = http.createServer((req, res) => {
      seen.push(req.url);
      const upstream = http.request({ host: "127.0.0.1", port: new URL(tailnet).port, method: req.method, path: new URL(req.url).pathname, headers: req.headers }, (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      });
      req.pipe(upstream);
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const sent = await send(box, keyFile, ["--via", "http://100.64.0.1", "--proxy", "http://127.0.0.1:" + proxy.address().port]);
      expect(sent.code, sent.stderr).toBe(0);
      expect(seen).toEqual(["http://100.64.0.1/relay/key/call"]);
      expect(ctx.remoteSends.at(-1).data.relay_route).toBe("tailnet");
    } finally {
      await close(proxy);
    }
  });
});

describe("relay client --via and --proxy", () => {
  const box = "https://box.example.com";
  const usage = async (args) => {
    const out = await runClient(["history", "--box", box, "--key-file", "/nonexistent", "--with", "x", ...args]);
    return { code: out.code, error: out.stderr ? JSON.parse(out.stderr).error : null };
  };
  it("takes plain http only to a tailnet address and a proxy only for one", async () => {
    expect(await usage(["--via", "http://8.8.8.8"])).toEqual({ code: 2, error: "insecure_box" });
    expect(await usage(["--via", "http://100.128.0.1"])).toEqual({ code: 2, error: "insecure_box" });
    expect(await usage(["--via", "http://box.example.com"])).toEqual({ code: 2, error: "insecure_box" });
    expect((await usage(["--via", "http://100.64.0.1/x"])).error).toBe("usage");
    expect((await usage(["--via", "https://box.example.com", "--proxy", "http://127.0.0.1:1055"])).error).toBe("usage");
    expect((await usage(["--via", "http://100.64.0.1", "--proxy", "http://10.0.0.1:1055"])).error).toBe("usage");
    for (const via of ["http://100.64.0.1", "http://100.127.255.254", "http://[fd7a:115c:a1e0::1]", "http://alphaclaw-relay.tail1234.ts.net"]) {
      expect((await usage(["--via", via])).error, via).not.toMatch(/insecure_box|usage/);
    }
  });
});

describe("tailnet service", () => {
  const kKey = "tskey-auth-kTEST1234-0123456789abcdef";
  const make = ({ backend = "NeedsLogin", authKey = kKey, upFails = false, binaries = true, startingReads = 0, tags = "tag:relay-liaison" } = {}) => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "tailnet-svc-"));
    const calls = [];
    let state = backend;
    const runTailscale = async ({ args }) => {
      const keyFile = args.find((arg) => arg.startsWith("--auth-key=file:"))?.slice("--auth-key=file:".length) || null;
      const input = keyFile ? fs.readFileSync(keyFile, "utf8") : undefined;
      if (keyFile) expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
      calls.push({ args, input, keyFile });
      if (args[0] === "status") {
        if (startingReads > 0) {
          startingReads -= 1;
          return JSON.stringify({ BackendState: "NoState" });
        }
        return JSON.stringify({ BackendState: state, Self: { DNSName: "alphaclaw-relay.tail1234.ts.net.", TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::1"], Tags: ["tag:wintermute"] } });
      }
      if (args[0] === "up") {
        if (upFails) throw new Error("tailscale up exited 1: invalid key " + fs.readFileSync(args.find((arg) => arg.startsWith("--auth-key=file:")).slice(16), "utf8"));
        state = "Running";
      }
      return "";
    };
    const supervisor = { start: vi.fn(), getStatus: () => ({ status: "running", starts: 1, pid: 42 }) };
    const ingressPort = 45678;
    const config = readRelayConfig({ env: { ALPHACLAW_RELAY_TAILNET: "required", ALPHACLAW_RELAY_TAILNET_TAGS: tags } });
    const timers = [];
    const callbacks = [];
    const service = createTailnetService({
      config,
      relayDir: relayPaths(rootDir).dir,
      env: authKey ? { ALPHACLAW_RELAY_TAILNET_AUTHKEY: authKey } : {},
      getSupervisor: () => supervisor,
      ingress: { listen: async () => ingressPort, close: async () => {} },
      tailscale: binaries ? "/usr/bin/tailscale" : null,
      tailscaled: binaries ? "/usr/sbin/tailscaled" : null,
      runTailscale,
      setTimer: (fn, ms) => (timers.push(ms), callbacks.push(fn), 1),
      clearTimer: () => {},
      sleep: async () => {},
      logger: quiet,
    });
    return { service, calls, supervisor, timers, callbacks, setBackend: (next) => (state = next), rootDir, cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }) };
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("logs in once with the key in a 0600 file removed right after, never in argv, and serves the tailnet port to the ingress", async () => {
    const t = make();
    t.service.start();
    for (let i = 0; i < 10 && t.service.getStatus().phase !== "ready"; i += 1) await settle();
    const up = t.calls.find((call) => call.args[0] === "up");
    expect(up.input).toBe(kKey);
    expect(path.dirname(up.keyFile)).toBe(path.join(relayPaths(t.rootDir).dir, "tailscale"));
    expect(fs.existsSync(up.keyFile)).toBe(false);
    expect(JSON.stringify(t.calls.map((call) => call.args))).not.toContain(kKey);
    expect(t.calls.map((call) => call.args.join(" "))).toEqual(
      expect.arrayContaining(["serve reset", "serve --bg --tcp=80 --proxy-protocol=2 tcp://127.0.0.1:45678"]),
    );
    const status = t.service.getStatus();
    expect(status).toMatchObject({ mode: "required", phase: "ready", node: { name: "alphaclaw-relay.tail1234.ts.net", addresses: ["100.64.0.1", "fd7a:115c:a1e0::1"], port: 80 }, allowedTags: ["tag:relay-liaison"], authKeySet: true });
    expect(JSON.stringify(status)).not.toContain(kKey);
    expect(fs.statSync(path.join(relayPaths(t.rootDir).dir, "tailscale")).mode & 0o777).toBe(0o700);
    t.cleanup();
  });

  it("refuses to open the route when no valid tag is configured, without retrying", async () => {
    const t = make({ tags: "relay-liaison" });
    t.service.start();
    for (let i = 0; i < 10 && t.service.getStatus().phase !== "failed"; i += 1) await settle();
    expect(t.service.getStatus().error.code).toBe("tailnet_no_tags");
    expect(t.calls.some((call) => call.args[0] === "serve")).toBe(false);
    expect(t.timers).toEqual([]);
    t.cleanup();
  });

  it("notices a node that stops after it was ready and starts it again, and resets serve on stop", async () => {
    const t = make({ backend: "Running" });
    t.service.start();
    for (let i = 0; i < 10 && t.service.getStatus().phase !== "ready"; i += 1) await settle();
    expect(t.timers).toEqual([60000]);
    await t.callbacks[0]();
    expect(t.timers).toEqual([60000, 60000]);
    t.setBackend("Stopped");
    const before = t.calls.length;
    await t.callbacks[1]();
    for (let i = 0; i < 10 && !t.calls.slice(before).some((call) => call.args[0] === "up"); i += 1) await settle();
    expect(t.calls.slice(before).map((call) => call.args[0])).toContain("up");
    for (let i = 0; i < 10 && t.service.getStatus().phase !== "ready"; i += 1) await settle();
    expect(t.service.getStatus().phase).toBe("ready");
    await t.service.stop();
    expect(t.calls.at(-1).args).toEqual(["serve", "reset"]);
    t.cleanup();
  });

  it("does not log in again once the node is on the tailnet, even while tailscaled first answers NoState", async () => {
    const t = make({ backend: "Running", startingReads: 3 });
    t.service.start();
    for (let i = 0; i < 10 && t.service.getStatus().phase !== "ready"; i += 1) await settle();
    expect(t.calls.some((call) => call.args[0] === "up")).toBe(false);
    expect(t.service.getStatus().phase).toBe("ready");
    t.cleanup();
  });

  it("waits for a key without retrying, redacts the key from a failed login, and stops on a missing binary", async () => {
    const noKey = make({ authKey: "" });
    noKey.service.start();
    for (let i = 0; i < 10 && noKey.service.getStatus().phase !== "needs_login"; i += 1) await settle();
    expect(noKey.service.getStatus()).toMatchObject({ phase: "needs_login", error: { code: "tailnet_needs_login" } });
    expect(noKey.timers).toEqual([]);
    noKey.cleanup();

    const bad = make({ upFails: true });
    bad.service.start();
    for (let i = 0; i < 10 && bad.service.getStatus().phase !== "failed"; i += 1) await settle();
    expect(bad.service.getStatus().error.code).toBe("tailnet_login_failed");
    expect(JSON.stringify(bad.service.getStatus())).not.toContain(kKey);
    expect(bad.timers).toHaveLength(1);
    bad.cleanup();

    const missing = make({ binaries: false });
    missing.service.start();
    for (let i = 0; i < 10 && missing.service.getStatus().phase !== "failed"; i += 1) await settle();
    expect(missing.service.getStatus().error.code).toBe("tailnet_binary_missing");
    expect(missing.timers).toEqual([]);
    missing.cleanup();
  });
});

describe("tailnet settings, sidecar, Doctor and guard", () => {
  it("reads the settings, defaulting to off", () => {
    expect(readRelayConfig({ env: {} }).tailnet).toMatchObject({ mode: "off", hostname: "alphaclaw-relay", port: 80, tags: [], loginServer: "" });
    expect(
      readRelayConfig({
        env: {
          ALPHACLAW_RELAY_TAILNET: "Required",
          ALPHACLAW_RELAY_TAILNET_TAGS: "tag:relay-liaison, nope",
          ALPHACLAW_RELAY_TAILNET_HOSTNAME: "Wintermute-Relay",
          ALPHACLAW_RELAY_TAILNET_PORT: "8080",
          ALPHACLAW_RELAY_TAILNET_LOGIN_SERVER: "http://evil.example.com",
        },
      }).tailnet,
    ).toMatchObject({ mode: "required", tags: ["tag:relay-liaison"], tagsRejected: 1, hostname: "wintermute-relay", port: 8080, loginServer: "", loginServerRejected: true });
    expect(readRelayConfig({ env: { ALPHACLAW_RELAY_TAILNET: "maybe" } }).tailnet).toMatchObject({ mode: "off", modeRejected: true });
  });

  it("adds tailscaled beside the engine only when the route is on and the binary is there", () => {
    const paths = relayPaths("/data/.alphaclaw");
    const names = (env, found = "/usr/sbin/tailscaled") =>
      buildRelayBuiltinSidecars({ config: readRelayConfig({ env }), paths, target: "linux-x64", findBinary: () => found }).map((entry) => entry.name);
    expect(names({})).not.toContain(kTailscaledSidecarName);
    expect(names({ ALPHACLAW_RELAY_TAILNET: "on" })).toContain(kTailscaledSidecarName);
    expect(names({ ALPHACLAW_RELAY_TAILNET: "on" }, null)).not.toContain(kTailscaledSidecarName);
    const entry = buildRelayBuiltinSidecars({ config: readRelayConfig({ env: { ALPHACLAW_RELAY_TAILNET: "required" } }), paths, target: "linux-x64", findBinary: () => "/usr/sbin/tailscaled" }).find(
      (item) => item.name === kTailscaledSidecarName,
    );
    expect(entry.command).toEqual([
      "/usr/sbin/tailscaled",
      "--tun=userspace-networking",
      "--statedir=/data/.alphaclaw/relay/tailscale",
      "--socket=/data/.alphaclaw/relay/tailscale/tailscaled.sock",
      "--port=0",
    ]);
    expect(Object.keys(entry.env)).toEqual(["HOME"]);
  });

  it("shows one Doctor card while the route is on and down, P1 when required", () => {
    const status = (tailnet) => ({ enabled: true, phase: "ready", settings: {}, tailnet });
    expect(buildRelayCards(status({ mode: "off", phase: "off" }))).toEqual([]);
    expect(buildRelayCards(status({ mode: "on", phase: "ready" }))).toEqual([]);
    const [needsLogin] = buildRelayCards(status({ mode: "required", phase: "needs_login", error: { code: "tailnet_needs_login", message: "Set the key." } }));
    expect(needsLogin).toMatchObject({ sourceKey: "det:relay-tailnet-tailnet_needs_login", priority: "P1" });
    expect(needsLogin.recommendation).toContain("ALPHACLAW_RELAY_TAILNET_AUTHKEY");
    const [down] = buildRelayCards(status({ mode: "on", phase: "failed", error: { code: "tailnet_not_running", message: "tailscaled is Stopped." } }));
    expect(down.priority).toBe("P2");
    expect(down.summary).toContain("can still use the public URL");
    const [typo] = buildRelayCards(status({ mode: "off", phase: "off", settingsRejected: { mode: true, tags: 0, loginServer: false } }));
    expect(typo).toMatchObject({ sourceKey: "det:relay-tailnet-settings" });
    expect(typo.summary).toContain("still served on the public URL");
    expect(buildRelayCards(status({ mode: "on", phase: "ready", settingsRejected: { mode: false, tags: 1, loginServer: false } })).map((card) => card.sourceKey)).toEqual(["det:relay-tailnet-settings"]);
  });

  it("refuses a relay session's change to the tailnet settings and any read of the node key", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "tailnet-guard-"));
    try {
      fs.mkdirSync(path.join(rootDir, "relay", "tailscale"), { recursive: true });
      expect(classifyAnchor({ toolName: "exec", params: { command: "echo ALPHACLAW_RELAY_TAILNET=off >> /etc/environment" }, rootDir })).not.toBeNull();
      expect(classifyAnchor({ toolName: "exec", params: { command: "export ALPHACLAW_RELAY_TAILNET_TAGS=tag:anyone" }, rootDir })).not.toBeNull();
      expect(classifyKeyRead({ toolName: "read", params: { path: path.join(rootDir, "relay", "tailscale", "tailscaled.state") }, rootDir })).not.toBeNull();
      expect(classifyKeyRead({ toolName: "exec", params: { command: "cat /tmp/x/tailscaled.state" }, rootDir })).not.toBeNull();
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
