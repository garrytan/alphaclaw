const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

// The tailnet route for the relay (GST-2368): a second lock in front of the
// relay's client paths, on top of the liaison key's signature.
//
//   ALPHACLAW_RELAY_TAILNET=on|required (deployment env only)
//   -> sidecar "relay-tailscaled": tailscaled in userspace mode (no TUN, no
//      capabilities), state and socket in <root>/relay/tailscale (0700)
//   -> login once with ALPHACLAW_RELAY_TAILNET_AUTHKEY, handed to
//      `tailscale up` in a 0600 file removed right after, never in argv, a
//      log or the status
//   -> `tailscale serve --tcp=<port> --proxy-protocol=2` to a loopback
//      listener (the ingress) that AlphaClaw opens on a random port
//   -> the ingress reads the PROXY v2 header tailscaled writes, asks
//      tailscaled who that tailnet address is (LocalAPI WhoIs), refuses
//      anyone else, and hands the connection to the app marked "tailnet".
//
// The mark lives on the socket (a WeakMap), never in a header, so nothing a
// caller sends on the public port can claim the tailnet route. The ingress
// serves only the relay's client paths; everything else is 404 there. With
// "required" the public port refuses those paths (tailnet_required), and
// the pages a person opens (confirmation links, OAuth consent) stay public.

const kTailscaledSidecarName = "relay-tailscaled";
const kTailnetPaths = Object.freeze(["/relay/key/call", "/relay/mcp", "/relay/oauth/token"]);
const kTailnetOnlyPaths = Object.freeze(["/relay/key/call", "/relay/mcp"]);
const kProxyV2Signature = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
const kProxyHeaderTimeoutMs = 5000;
const kWhoisTimeoutMs = 5000;
const kSocketWaitMs = 30 * 1000;
const kSettledStates = Object.freeze(["NeedsLogin", "NeedsMachineAuth", "Stopped", "Running"]);
const kRetryBaseMs = 30 * 1000;
const kHealthCheckMs = 60 * 1000;
const kRetryMaxMs = 30 * 60 * 1000;
const kForwardedHeaders = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "forwarded", "x-real-ip", "cf-connecting-ip", "cf-visitor"];

const tailnetPaths = (relayDir) => {
  const dir = path.join(relayDir, "tailscale");
  return { dir, socket: path.join(dir, "tailscaled.sock") };
};

const findOnPath = (name, env = process.env, fsModule = fs) => {
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      fsModule.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
};

const buildTailscaledSidecarEntry = ({ config, relayDir, tailscaled }) => {
  const paths = tailnetPaths(relayDir);
  return {
    name: kTailscaledSidecarName,
    command: [tailscaled, "--tun=userspace-networking", "--statedir=" + paths.dir, "--socket=" + paths.socket, "--port=0"],
    cwd: paths.dir,
    // TS_LOGS_DIR keeps tailscaled's log files and log identity in our own
    // directory: without it tailscaled falls back to /var/lib/tailscale,
    // which on a box that already runs Tailscale is that daemon's state.
    env: { HOME: paths.dir, TS_LOGS_DIR: paths.dir },
    restart: "always",
    stopTimeoutSeconds: 5,
  };
};

// One PROXY protocol v2 header at the start of buf. Returns null while
// more bytes are needed, { error } for anything that is not a v2 PROXY
// header over TCP/IPv4 or TCP/IPv6, else the source and the header length.
const parseProxyV2 = (buf) => {
  if (buf.length < 16) {
    const head = buf.subarray(0, Math.min(buf.length, kProxyV2Signature.length));
    return kProxyV2Signature.subarray(0, head.length).equals(head) ? null : { error: "not_proxy_v2" };
  }
  if (!buf.subarray(0, 12).equals(kProxyV2Signature)) return { error: "not_proxy_v2" };
  if (buf[12] !== 0x21) return { error: "not_proxy_command" };
  const length = 16 + buf.readUInt16BE(14);
  if (length > 16 + 216 + 512) return { error: "header_too_long" };
  if (buf.length < length) return null;
  const family = buf[13];
  if (family === 0x11 && length >= 16 + 12) {
    return { length, address: [...buf.subarray(16, 20)].join("."), port: buf.readUInt16BE(24) };
  }
  if (family === 0x21 && length >= 16 + 36) {
    const words = [];
    for (let i = 0; i < 16; i += 2) words.push(buf.readUInt16BE(16 + i).toString(16));
    return { length, address: net.isIPv6(words.join(":")) ? words.join(":") : null, port: buf.readUInt16BE(48) };
  }
  return { error: "unsupported_family" };
};

// LocalAPI WhoIs over tailscaled's socket: the node and tags behind a
// tailnet address, or null when tailscaled does not know it.
const whoisOverSocket = (socketPath) => (address, port) =>
  new Promise((resolve, reject) => {
    const addr = (net.isIPv6(address) ? "[" + address + "]" : address) + ":" + port;
    const req = http.request(
      { socketPath, path: "/localapi/v0/whois?addr=" + encodeURIComponent(addr), headers: { Host: "local-tailscaled.sock" }, timeout: kWhoisTimeoutMs },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > 256 * 1024) req.destroy(new Error("whois answer too large"));
        });
        res.on("end", () => {
          if (res.statusCode === 404) return resolve(null);
          if (res.statusCode !== 200) return reject(new Error("whois answered HTTP " + res.statusCode));
          try {
            const parsed = JSON.parse(body);
            const node = parsed?.Node;
            if (!node) return resolve(null);
            resolve({
              node: String(node.Name || node.ComputedName || "").replace(/\.$/, ""),
              nodeId: String(node.StableID || node.ID || ""),
              tags: Array.isArray(node.Tags) ? node.Tags.map(String) : [],
              user: node.Tags?.length ? null : String(parsed?.UserProfile?.LoginName || "") || null,
              address,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("whois timed out")));
    req.on("error", reject);
    req.end();
  });

const createTailnetIngress = ({ handler, whois, allowedTags = [], logger = console, headerTimeoutMs = kProxyHeaderTimeoutMs }) => {
  const identities = new WeakMap();
  const httpServer = http.createServer(handler);
  httpServer.on("clientError", (error, socket) => socket.destroy());
  const logSafe = (value) => String(value || "-").slice(0, 80).replace(/[^A-Za-z0-9_.:@-]/g, "?");
  const refuse = (socket, reason, detail = "") => {
    logger.warn("[relay] tailnet ingress refused " + reason + (detail ? " " + detail : ""));
    socket.destroy();
  };
  const accept = (socket) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => refuse(socket, "header_timeout"), headerTimeoutMs);
    timer.unref?.();
    const onData = async (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const parsed = parseProxyV2(buffered);
      if (!parsed) return;
      socket.off("data", onData);
      socket.pause();
      clearTimeout(timer);
      if (parsed.error || !parsed.address) return refuse(socket, parsed.error || "bad_address");
      let who;
      try {
        who = await whois(parsed.address, parsed.port);
      } catch (error) {
        return refuse(socket, "whois_failed", logSafe(error?.message));
      }
      if (!who) return refuse(socket, "unknown_peer", logSafe(parsed.address));
      if (!who.tags.some((tag) => allowedTags.includes(tag))) {
        return refuse(socket, "tag_not_allowed", "node=" + logSafe(who.node) + " tags=" + logSafe(who.tags.join(",")));
      }
      if (socket.destroyed) return;
      identities.set(socket, Object.freeze({ ...who, tags: Object.freeze([...who.tags]) }));
      const rest = buffered.subarray(parsed.length);
      if (rest.length) socket.unshift(rest);
      httpServer.emit("connection", socket);
      socket.resume();
    };
    socket.on("data", onData);
    socket.on("error", () => {});
  };
  const server = net.createServer({ pauseOnConnect: false }, accept);
  let port = null;
  const listen = () =>
    port !== null
      ? Promise.resolve(port)
      : new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            port = server.address().port;
            resolve(port);
          });
        });
  const close = () =>
    new Promise((resolve) => {
      httpServer.closeAllConnections?.();
      if (port === null) return resolve();
      server.close(() => resolve());
      port = null;
    });
  return { listen, close, identityOf: (req) => identities.get(req?.socket) || null, getPort: () => port };
};

const normalizePath = (value) => {
  const lowered = String(value || "").toLowerCase().replace(/\/+$/, "");
  return lowered || "/";
};

// Mounted first on the app. On the ingress, only the relay's client paths
// exist and forwarding headers are dropped (the PROXY header already named
// the caller). On the public port, "required" refuses the tailnet-only paths.
const createTailnetGate = ({ getMode, identityOf }) => (req, res, next) => {
  const route = normalizePath(req.path);
  if (identityOf(req)) {
    for (const header of kForwardedHeaders) delete req.headers[header];
    if (!kTailnetPaths.includes(route)) return res.status(404).json({ error: "not_found", message: "Only the relay's client paths are served on the tailnet." });
    return next();
  }
  if (getMode() === "required" && kTailnetOnlyPaths.includes(route)) {
    res.set("Cache-Control", "no-store");
    return res.status(403).json({ error: "tailnet_required", message: "This box serves the relay's client paths only over its tailnet." });
  }
  return next();
};

const runTailscaleCli = ({ tailscale, socket, args, timeoutMs = 90 * 1000 }) =>
  new Promise((resolve, reject) => {
    const child = spawn(tailscale, ["--socket=" + socket, ...args], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH || "", HOME: path.dirname(socket) } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => (stdout = (stdout + chunk).slice(-256 * 1024)));
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-16 * 1024)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      reject(Object.assign(new Error("tailscale " + args[0] + " exited " + code + ": " + stderr.trim().split("\n").pop()), { code }));
    });
    child.stdin.on("error", () => {});
    child.stdin.end();
  });

const createTailnetService = ({
  config,
  relayDir,
  env = process.env,
  getSupervisor = () => null,
  ingress,
  tailscale = findOnPath("tailscale", env),
  tailscaled = findOnPath("tailscaled", env),
  runTailscale = runTailscaleCli,
  fsModule = fs,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger = console,
}) => {
  const tailnet = config.tailnet;
  const paths = tailnetPaths(relayDir);
  const state = { phase: tailnet.mode === "off" ? "off" : "idle", error: null, attempts: 0, retryTimer: null, healthTimer: null, startedAt: null, readyAt: null, node: null, stopped: false };
  const cli = (args) => runTailscale({ tailscale, socket: paths.socket, args });
  const setPhase = (phase, error = null) => {
    state.phase = phase;
    state.error = error ? { code: error.code || "tailnet_failed", message: String(error.message || error).slice(0, 300) } : null;
  };
  const readStatus = async () => JSON.parse(await cli(["status", "--json"]));
  // A starting tailscaled answers NoState (then Starting) before it has read
  // its saved node, so only a settled state counts: reading NoState as
  // "needs a login" would log a known node in again.
  const waitForDaemon = async () => {
    const deadline = now() + kSocketWaitMs;
    let last = null;
    for (;;) {
      try {
        last = await readStatus();
        if (kSettledStates.includes(last.BackendState)) return last;
      } catch {}
      if (now() >= deadline || state.stopped) {
        throw last
          ? Object.assign(new Error("tailscaled stayed " + last.BackendState + " for 30 s."), { code: "tailnet_not_running" })
          : Object.assign(new Error("tailscaled did not answer on its socket within 30 s."), { code: "tailnet_daemon_unavailable" });
      }
      await sleep(500);
    }
  };
  const upArgs = () => [
    "up",
    "--hostname=" + tailnet.hostname,
    ...(tailnet.loginServer ? ["--login-server=" + tailnet.loginServer] : []),
    "--accept-dns=false",
    "--timeout=60s",
  ];
  const scheduleRetry = () => {
    state.attempts += 1;
    const delay = Math.min(kRetryMaxMs, kRetryBaseMs * 2 ** Math.min(state.attempts - 1, 6));
    state.retryTimer = setTimer(() => {
      state.retryTimer = null;
      void run();
    }, delay);
    state.retryTimer?.unref?.();
  };
  // Once ready, the node is rechecked every minute: a node that logged out
  // or stopped goes back through run(), so the status and the Doctor card
  // never say ready for a route that is gone.
  const scheduleHealthCheck = () => {
    state.healthTimer = setTimer(async () => {
      state.healthTimer = null;
      if (state.stopped || state.phase !== "ready") return;
      let backend = null;
      try {
        backend = (await readStatus()).BackendState;
      } catch {}
      if (state.stopped) return;
      if (backend === "Running") return scheduleHealthCheck();
      setPhase("failed", { code: "tailnet_not_running", message: "tailscaled is " + (backend || "not answering") + ", not Running." });
      logger.warn("[relay] tailnet went " + (backend || "silent") + " after it was ready; starting it again");
      void run();
    }, kHealthCheckMs);
    state.healthTimer?.unref?.();
  };
  const run = async () => {
    if (state.stopped) return;
    try {
      if (!tailnet.tags.length) {
        throw Object.assign(new Error("ALPHACLAW_RELAY_TAILNET_TAGS names no valid tag (tag:<name>), so no tailnet node could be let in."), { code: "tailnet_no_tags" });
      }
      if (!tailscaled || !tailscale) {
        throw Object.assign(new Error("tailscale and tailscaled are not on this box's PATH."), { code: "tailnet_binary_missing" });
      }
      setPhase("starting");
      fsModule.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
      fsModule.chmodSync(paths.dir, 0o700);
      for (const name of fsModule.readdirSync(paths.dir)) {
        if (name.startsWith("authkey.")) fsModule.rmSync(path.join(paths.dir, name), { force: true });
      }
      const supervisor = getSupervisor();
      if (!supervisor) throw Object.assign(new Error("The tailscaled sidecar is not registered."), { code: "tailnet_daemon_unavailable" });
      supervisor.start();
      let status = await waitForDaemon();
      if (status.BackendState === "NeedsLogin") {
        const authKey = String(env.ALPHACLAW_RELAY_TAILNET_AUTHKEY || "").trim();
        if (!authKey) {
          setPhase("needs_login", { code: "tailnet_needs_login", message: "Set ALPHACLAW_RELAY_TAILNET_AUTHKEY to a pre-approved, tagged auth key in the deployment environment and redeploy." });
          logger.warn("[relay] tailnet needs a login: ALPHACLAW_RELAY_TAILNET_AUTHKEY is not set");
          return;
        }
        setPhase("logging_in");
        // tailscale reads the key from a file (file:<path>): a 0600 file in
        // the 0700 tailscale directory, removed as soon as up returns. Not
        // argv (other processes read it) and not stdin (Node's stdin pipe is
        // a socket, which /dev/stdin cannot open).
        const keyFile = path.join(paths.dir, "authkey." + process.pid + "." + now());
        try {
          fsModule.writeFileSync(keyFile, authKey, { mode: 0o600, flag: "wx" });
          await cli([...upArgs(), "--auth-key=file:" + keyFile]);
        } catch (error) {
          throw Object.assign(new Error(String(error?.message || error).split(authKey).join("[redacted]")), { code: "tailnet_login_failed" });
        } finally {
          fsModule.rmSync(keyFile, { force: true });
        }
        status = await readStatus();
      } else if (status.BackendState === "Stopped") {
        await cli(upArgs());
        status = await readStatus();
      }
      if (status.BackendState !== "Running") {
        throw Object.assign(new Error("tailscaled is " + status.BackendState + ", not Running."), { code: "tailnet_not_running" });
      }
      const ingressPort = await ingress.listen();
      if (state.stopped) {
        await ingress.close().catch(() => {});
        return;
      }
      await cli(["serve", "reset"]);
      await cli(["serve", "--bg", "--tcp=" + tailnet.port, "--proxy-protocol=2", "tcp://127.0.0.1:" + ingressPort]);
      const self = status.Self || {};
      state.node = {
        name: String(self.DNSName || "").replace(/\.$/, ""),
        addresses: Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.map(String) : [],
        tags: Array.isArray(self.Tags) ? self.Tags.map(String) : [],
        port: tailnet.port,
      };
      state.attempts = 0;
      state.readyAt = new Date(now()).toISOString();
      scheduleHealthCheck();
      setPhase("ready");
      logger.log("[relay] tailnet ready: " + (state.node.name || "-") + " " + state.node.addresses.join(",") + " port " + tailnet.port + " (" + tailnet.mode + ")");
    } catch (error) {
      setPhase("failed", error);
      logger.warn("[relay] tailnet " + (error?.code || "tailnet_failed") + ": " + String(error?.message || error).slice(0, 300));
      if (error?.code !== "tailnet_binary_missing" && error?.code !== "tailnet_no_tags") scheduleRetry();
    }
  };
  const start = () => {
    if (tailnet.mode === "off" || state.startedAt) return;
    state.startedAt = new Date(now()).toISOString();
    void run();
  };
  // serve config is saved in tailscaled's state, so it is reset on the way
  // out: until the next run() sets it again, the tailnet port leads nowhere
  // instead of to a loopback port another process may have taken.
  const stop = async () => {
    state.stopped = true;
    if (state.retryTimer) clearTimer(state.retryTimer);
    if (state.healthTimer) clearTimer(state.healthTimer);
    if (state.phase === "ready") await cli(["serve", "reset"]).catch(() => {});
    await ingress.close().catch(() => {});
  };
  const getStatus = () => {
    const daemon = tailnet.mode !== "off" ? getSupervisor()?.getStatus?.() || null : null;
    return {
    mode: tailnet.mode,
    phase: state.phase,
    error: state.error,
    readyAt: state.readyAt,
    node: state.node,
    allowedTags: tailnet.tags,
    hostname: tailnet.hostname,
    port: tailnet.port,
    authKeySet: Boolean(String(env.ALPHACLAW_RELAY_TAILNET_AUTHKEY || "").trim()),
    settingsRejected: { mode: tailnet.modeRejected, tags: tailnet.tagsRejected, loginServer: tailnet.loginServerRejected },
    process: daemon ? { status: daemon.status || null, starts: daemon.starts ?? null, lastExit: daemon.lastExit || null, crashLoop: daemon.crashLoop || null } : null,
    };
  };
  return { start, stop, getStatus, getMode: () => tailnet.mode };
};

module.exports = {
  kTailscaledSidecarName,
  kTailnetPaths,
  kTailnetOnlyPaths,
  tailnetPaths,
  findOnPath,
  buildTailscaledSidecarEntry,
  parseProxyV2,
  whoisOverSocket,
  createTailnetIngress,
  createTailnetGate,
  createTailnetService,
};
