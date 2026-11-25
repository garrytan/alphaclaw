// GBrain's Google broker socket (contract v4): one JSON object per line,
// one reply per request, connections reused. Replies carry no id, so a
// connection carries one request at a time and is dropped after any reply
// it cannot match (a timeout, a bad line, a close), never reused. Each
// request opens its own connection and closes it after the reply, so one
// slow call never holds up another and no stale idle connection can turn
// into a false "outcome unknown". Bytes are decoded as one UTF-8 stream, so
// a character split across reads arrives whole.
const net = require("net");
const { StringDecoder } = require("string_decoder");
const os = require("os");
const path = require("path");

const kProtocolVersion = 4;
const kCaller = "alphaclaw-google-workspace";
const kConnectTimeoutMs = 3000;
const kMaxLineBytes = 32 * 1024 * 1024;

// configDir()/run/google.sock: $GBRAIN_HOME/.gbrain when GBRAIN_HOME is
// set, else ~/.gbrain. An absolute socketPath wins. AlphaClaw always writes
// one into the plugin config, resolved from the deployment env only
// (google-workspace-entry.js), so the agent's .env cannot move the socket.
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
  const open = new Set();

  const discard = (conn) => {
    open.delete(conn);
    try {
      conn?.destroy();
    } catch {}
  };

  const connect = () =>
    new Promise((resolve) => {
      let settled = false;
      const conn = netModule.createConnection({ path: socketPath });
      const timer = setTimeout(() => finish(null), connectTimeoutMs);
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!value) discard(conn);
        resolve(value);
      };
      conn.once("connect", () => {
        open.add(conn);
        conn.on("error", () => {});
        conn.on("close", () => open.delete(conn));
        finish(conn);
      });
      conn.once("error", () => finish(null));
    });

  const request = async (payload, { beforeWrite, signal, timeoutMs = defaultTimeoutMs } = {}) => {
    if (signal?.aborted) return { transport: "down" };
    const conn = await connect();
    if (!conn) return { transport: "down" };
    if (signal?.aborted) {
      discard(conn);
      return { transport: "down" };
    }
    try {
      beforeWrite?.();
    } catch (error) {
      discard(conn);
      throw error;
    }
    return new Promise((resolve) => {
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        conn.off("data", onData);
        conn.off("close", onClose);
        signal?.removeEventListener?.("abort", onAbort);
        discard(conn);
        resolve(result);
      };
      const onData = (chunk) => {
        buffer += decoder.write(chunk);
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          if (buffer.length > kMaxLineBytes) finish({ transport: "lost" });
          return;
        }
        const line = buffer.slice(0, newline);
        let reply;
        try {
          reply = JSON.parse(line);
        } catch {
          return finish({ transport: "lost" });
        }
        if (!reply || typeof reply !== "object" || Array.isArray(reply)) return finish({ transport: "lost" });
        finish({ reply });
      };
      const onClose = () => finish({ transport: "lost" });
      const onAbort = () => finish({ transport: "lost" });
      const timer = setTimeout(() => finish({ transport: "lost" }), timeoutMs);
      conn.on("data", onData);
      conn.on("close", onClose);
      signal?.addEventListener?.("abort", onAbort, { once: true });
      try {
        conn.write(JSON.stringify({ v: kProtocolVersion, ...payload }) + "\n");
      } catch {
        finish({ transport: "lost" });
      }
    });
  };

  const close = () => {
    for (const conn of [...open]) discard(conn);
  };

  return { request, close, socketPath };
};

module.exports = { kProtocolVersion, kCaller, resolveSocketPath, createBrokerClient };
