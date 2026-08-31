// The ONE shared multiplexed gateway socket for all browser chat traffic.
// Moved intact from the old chat-ws.js (connect/challenge/auth, protocol pin,
// connect backoff); additions: WS ping keepalive (a wedged gateway socket is
// terminated instead of silently eating runs) and an onFrameWritten hook so
// the send service can record rpcWritten — the line between "retryable
// failure" and "unknown outcome" (D9b).
//
// NOTE: AlphaClaw's chat tab runs over this ONE multiplexed backend bridge,
// so chat traffic is NOT attributed per-operator in team mode v1 — every
// browser chat rides the shared internal credential.
const { readOpenclawConfig } = require("../openclaw-config");
const { getGatewayCredential } = require("../gateway-credential");

const kWsOpen = 1;
const kEnvRefPattern = /^\$\{([A-Z0-9_]+)\}$/i;
const kConnectTimeoutMs = 8000;
const kGatewayReqTimeoutMs = 15000;
const kGatewayProtocolVersion = 4;
// Gateway method auth (see OpenClaw method-scopes): chat.history needs operator.read;
// chat.send / chat.abort need operator.write. Align with CLI_DEFAULT_OPERATOR_SCOPES plus admin.
const kGatewayChatBridgeScopes = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
];
// 1.9: the beta gateway locks a client origin out for ~5 minutes after 10
// failed auth attempts — hammering reconnects walks straight into that
// breaker. Back off exponentially (1s → 60s cap) on connect failures and
// reset on the first successful connect.
const kConnectBackoffBaseMs = 1000;
const kConnectBackoffMaxMs = 60_000;
const kGatewayPingIntervalMs = 30_000;

const resolveTokenValue = (candidate = "") => {
  const normalizedCandidate = String(candidate || "").trim();
  if (!normalizedCandidate) return "";
  const envMatch = normalizedCandidate.match(kEnvRefPattern);
  if (!envMatch) return normalizedCandidate;
  const envKey = String(envMatch[1] || "").trim();
  if (!envKey) return "";
  return String(process.env[envKey] || "").trim();
};

const withTimeout = async (promise, timeoutMs, label) => {
  let timeoutId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const createGatewayClient = ({
  fs,
  openclawDir = "",
  getGatewayPort = () => 18789,
  WebSocketImpl,
  onEvent = () => {},
  onDisconnect = () => {},
}) => {
  let gatewaySocket = null;
  let gatewayConnectPromise = null;
  let gatewayPingTimer = null;
  const pendingGatewayRequests = new Map();
  let gatewayConnectFailures = 0;
  let gatewayConnectBlockedUntil = 0;

  const getGatewayToken = () => {
    const config = readOpenclawConfig({
      fsModule: fs,
      openclawDir,
      fallback: {},
    });
    const envToken = String(process.env.OPENCLAW_GATEWAY_TOKEN || "").trim();
    if (envToken) return envToken;
    return resolveTokenValue(config?.gateway?.auth?.token);
  };

  // Lazy credential-aware connect auth: token auth normally, the internal
  // password fallback when team mode has the gateway in trusted-proxy mode
  // (connect.params.auth.password, see gateway protocol doc).
  const getGatewayConnectAuth = () => {
    const credential = getGatewayCredential({
      fsModule: fs,
      openclawDir,
      env: process.env,
    });
    if (credential.mode === "password") {
      return { password: credential.value };
    }
    // Preserve the pre-credential fallback order for token auth.
    return { token: credential.value || getGatewayToken() };
  };

  const settleGatewayRequest = (id, payload) => {
    const pending = pendingGatewayRequests.get(id);
    if (!pending) return;
    pendingGatewayRequests.delete(id);
    if (payload?.ok) {
      pending.resolve(payload.payload || null);
      return;
    }
    const error = new Error(
      payload?.error?.message ||
        payload?.error?.code ||
        "Gateway request failed",
    );
    // An explicit ok:false response is a CONFIRMED failure — the gateway
    // answered. Only post-write timeouts/disconnects are ambiguous (D9b).
    error.gatewayResponded = true;
    pending.reject(error);
  };

  const rejectAllGatewayRequests = (reason = "Gateway disconnected") => {
    for (const [id, pending] of pendingGatewayRequests.entries()) {
      pendingGatewayRequests.delete(id);
      pending.reject(new Error(reason));
    }
  };

  const stopGatewayPing = () => {
    if (gatewayPingTimer) {
      clearInterval(gatewayPingTimer);
      gatewayPingTimer = null;
    }
  };

  const markGatewayDisconnected = (reason = "Gateway disconnected") => {
    const hadSocket = gatewaySocket !== null;
    gatewaySocket = null;
    gatewayConnectPromise = null;
    stopGatewayPing();
    rejectAllGatewayRequests(reason);
    // Notify AFTER the pending RPCs reject so send-side catch blocks observe a
    // consistent "gateway gone" world (registry cleanup + terminal frames).
    if (hadSocket) onDisconnect(reason);
  };

  const startGatewayPing = (socket) => {
    stopGatewayPing();
    let awaitingPong = false;
    socket.on("pong", () => {
      awaitingPong = false;
    });
    gatewayPingTimer = setInterval(() => {
      if (socket.readyState !== kWsOpen) return;
      if (awaitingPong) {
        // Two intervals without a pong: the socket is wedged — terminate so
        // close/disconnect handling produces honest terminals instead of a
        // silently frozen stream.
        try {
          socket.terminate();
        } catch {}
        return;
      }
      awaitingPong = true;
      try {
        socket.ping();
      } catch {}
    }, kGatewayPingIntervalMs);
    if (typeof gatewayPingTimer?.unref === "function") gatewayPingTimer.unref();
  };

  const ensureGatewayConnected = async () => {
    if (gatewaySocket && gatewaySocket.readyState === kWsOpen) return gatewaySocket;
    const nowMs = Date.now();
    if (!gatewayConnectPromise && nowMs < gatewayConnectBlockedUntil) {
      throw new Error(
        `OpenClaw gateway connect backing off after ${gatewayConnectFailures} failure(s) — retrying in ${Math.ceil(
          (gatewayConnectBlockedUntil - nowMs) / 1000,
        )}s`,
      );
    }
    if (!gatewayConnectPromise) {
      gatewayConnectPromise = withTimeout(
        new Promise((resolve, reject) => {
          const socket = new WebSocketImpl(`ws://127.0.0.1:${getGatewayPort()}`);
          const connectRequestId = crypto.randomUUID();
          const connectParams = {
            minProtocol: kGatewayProtocolVersion,
            maxProtocol: kGatewayProtocolVersion,
            client: {
              id: "gateway-client",
              version: "0.1.0",
              platform: process.platform,
              mode: "backend",
            },
            role: "operator",
            scopes: kGatewayChatBridgeScopes,
            caps: ["tool-events"],
            commands: [],
            permissions: {},
            auth: getGatewayConnectAuth(),
            locale: "en-US",
            userAgent: "alphaclaw-chat-bridge/0.1.0",
          };

          socket.on("message", (rawData) => {
            let payload = null;
            try {
              payload = JSON.parse(String(rawData || ""));
            } catch {
              return;
            }
            if (!payload || typeof payload !== "object") return;
            if (
              payload.type === "event" &&
              String(payload.event || "") === "connect.challenge"
            ) {
              socket.send(
                JSON.stringify({
                  type: "req",
                  id: connectRequestId,
                  method: "connect",
                  params: connectParams,
                }),
              );
              return;
            }
            if (payload.type === "res") {
              if (String(payload.id || "") === connectRequestId) {
                if (payload.ok && payload?.payload?.type === "hello-ok") {
                  gatewaySocket = socket;
                  startGatewayPing(socket);
                  resolve(socket);
                  return;
                }
                reject(
                  new Error(
                    payload?.error?.message ||
                      payload?.error?.code ||
                      "OpenClaw gateway connect failed",
                  ),
                );
                try {
                  socket.close();
                } catch {}
                return;
              }
              settleGatewayRequest(String(payload.id || ""), payload);
              return;
            }
            if (payload.type === "event") {
              onEvent(payload);
            }
          });

          socket.on("error", (err) => {
            const message = err instanceof Error ? err.message : String(err || "");
            reject(new Error(message || "OpenClaw gateway websocket failed"));
            markGatewayDisconnected("OpenClaw gateway websocket failed");
          });

          socket.on("close", (code) => {
            markGatewayDisconnected(`Gateway disconnected (code ${code})`);
          });
        }),
        kConnectTimeoutMs,
        "OpenClaw client connect",
      )
        .then((socket) => {
          gatewayConnectFailures = 0;
          gatewayConnectBlockedUntil = 0;
          return socket;
        })
        .catch((error) => {
          gatewayConnectFailures += 1;
          gatewayConnectBlockedUntil =
            Date.now() +
            Math.min(
              kConnectBackoffBaseMs * 2 ** (gatewayConnectFailures - 1),
              kConnectBackoffMaxMs,
            );
          throw error;
        })
        .finally(() => {
          gatewayConnectPromise = null;
        });
    }
    return gatewayConnectPromise;
  };

  /**
   * Issue a gateway RPC. `onFrameWritten` fires after the request frame is
   * handed to the gateway socket — from that instant a failure is an UNKNOWN
   * outcome (the gateway may have accepted the request), never a retryable
   * one (D9b).
   */
  const requestGateway = async (
    method = "",
    params = {},
    timeoutMs = kGatewayReqTimeoutMs,
    { onFrameWritten = null } = {},
  ) => {
    const socket = await ensureGatewayConnected();
    if (!socket || socket.readyState !== kWsOpen) {
      throw new Error("OpenClaw gateway is not connected");
    }
    const requestId = crypto.randomUUID();
    const responsePromise = new Promise((resolve, reject) => {
      pendingGatewayRequests.set(requestId, { resolve, reject });
    });
    socket.send(
      JSON.stringify({
        type: "req",
        id: requestId,
        method,
        params,
      }),
    );
    if (typeof onFrameWritten === "function") onFrameWritten();
    return withTimeout(responsePromise, timeoutMs, `OpenClaw ${method} request`).finally(
      () => {
        pendingGatewayRequests.delete(requestId);
      },
    );
  };

  return { requestGateway };
};

module.exports = {
  createGatewayClient,
  kGatewayReqTimeoutMs,
  kGatewayProtocolVersion,
};
