// GBrain's Google broker socket (contract v4): one JSON object per line,
// one reply per request, connections reused. Replies carry no id, so a
// connection carries one request at a time and is dropped after any reply
// it cannot match (a timeout, a bad line, a close), never reused.
const net = require("net");
const os = require("os");
const path = require("path");

const kProtocolVersion = 4;
const kCaller = "alphaclaw-google-workspace";
const kConnectTimeoutMs = 3000;
const kMaxLineBytes = 32 * 1024 * 1024;

// configDir()/run/google.sock: $GBRAIN_HOME/.gbrain when GBRAIN_HOME is
// set, else ~/.gbrain. An absolute socketPath in the plugin config wins.
const resolveSocketPath = ({ socketPath, env = process.env, homedir = os.homedir() } = {}) => {
  const configured = typeof socketPath === "string" ? socketPath.trim() : "";
  if (configured && path.isAbsolute(configured)) return configured;
  const home = String(env.GBRAIN_HOME || "").trim();
  return path.join(home ? path.join(home, ".gbrain") : path.join(homedir, ".gbrain"), "run", "google.sock");
};

// request(payload, { beforeWrite, signal, timeoutMs }) resolves to
// { reply } or { transport: "down" } (nothing was written) or
// { transport: "lost" } (written, no reply: the broker may have acted).
// beforeWrite runs synchronously right before the write; if it throws,
// nothing is written and the error propagates.
const createBrokerClient = ({ socketPath, netModule = net, connectTimeoutMs = kConnectTimeoutMs, timeoutMs: defaultTimeoutMs = 120_000 } = {}) => {
  let socket = null;
  let chain = Promise.resolve();

  const drop = () => {
    const current = socket;
    socket = null;
    try {
      current?.destroy();
    } catch {}
  };

  const connect = () =>
    new Promise((resolve) => {
      if (socket && !socket.destroyed) return resolve(socket);
      let settled = false;
      const conn = netModule.createConnection({ path: socketPath });
      const timer = setTimeout(() => finish(null), connectTimeoutMs);
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!value) {
          try {
            conn.destroy();
          } catch {}
        }
        resolve(value);
      };
      conn.once("connect", () => {
        socket = conn;
        conn.on("error", () => {});
        conn.on("close", () => {
          if (socket === conn) socket = null;
        });
        finish(conn);
      });
      conn.once("error", () => finish(null));
    });

  const exchange = async (payload, { beforeWrite, signal, timeoutMs = defaultTimeoutMs } = {}) => {
    if (signal?.aborted) return { transport: "down" };
    const conn = await connect();
    if (!conn) return { transport: "down" };
    if (signal?.aborted) return { transport: "down" };
    beforeWrite?.();
    return new Promise((resolve) => {
      let buffer = "";
      let settled = false;
      const finish = (result, keep) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        conn.off("data", onData);
        conn.off("close", onClose);
        signal?.removeEventListener?.("abort", onAbort);
        if (!keep) drop();
        resolve(result);
      };
      const onData = (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          if (buffer.length > kMaxLineBytes) finish({ transport: "lost" }, false);
          return;
        }
        const line = buffer.slice(0, newline);
        const rest = buffer.slice(newline + 1);
        let reply;
        try {
          reply = JSON.parse(line);
        } catch {
          return finish({ transport: "lost" }, false);
        }
        if (!reply || typeof reply !== "object" || Array.isArray(reply)) return finish({ transport: "lost" }, false);
        finish({ reply }, rest.trim() === "");
      };
      const onClose = () => finish({ transport: "lost" }, false);
      const onAbort = () => finish({ transport: "lost" }, false);
      const timer = setTimeout(() => finish({ transport: "lost" }, false), timeoutMs);
      conn.on("data", onData);
      conn.on("close", onClose);
      signal?.addEventListener?.("abort", onAbort, { once: true });
      try {
        conn.write(JSON.stringify({ v: kProtocolVersion, ...payload }) + "\n");
      } catch {
        finish({ transport: "lost" }, false);
      }
    });
  };

  const request = (payload, options) => {
    const run = chain.then(() => exchange(payload, options));
    chain = run.catch(() => {});
    return run;
  };

  return { request, close: drop, socketPath };
};

module.exports = { kProtocolVersion, kCaller, resolveSocketPath, createBrokerClient };
