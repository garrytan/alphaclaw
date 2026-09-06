const { WebSocketServer } = require("ws");
const { applyProxyIdentity, resolveWsClientIp } = require("./proxy-identity");
const { kTrustProxyHops } = require("./constants");

const kWatchdogTerminalWsPath = "/api/watchdog/terminal/ws";

// The client carries its fitted xterm size on the upgrade URL (#76). Only
// present params are forwarded — an absent param must NOT overwrite the
// service's recorded size with a min-clamped zero. Values are untrusted
// browser input; the service clamps them before any use.
const parseRequestedTerminalSize = (req) => {
  const requestedSize = {};
  try {
    const requestUrl = new URL(
      req?.url || "/",
      `http://${req?.headers?.host || "localhost"}`,
    );
    const colsParam = requestUrl.searchParams.get("cols");
    const rowsParam = requestUrl.searchParams.get("rows");
    if (colsParam !== null) requestedSize.cols = colsParam;
    if (rowsParam !== null) requestedSize.rows = rowsParam;
  } catch {}
  return requestedSize;
};

const createWatchdogTerminalWsBridge = ({
  server,
  proxy,
  getGatewayUrl,
  isAuthorizedRequest,
  // 4.6: the terminal runs host commands — members never get it. Defaults to
  // isAuthorizedRequest for callers predating team mode (legacy = admin).
  isAdminRequest = null,
  watchdogTerminal,
  chatWsService = null,
  resolveProxyIdentity = () => null,
}) => {
  const watchdogTerminalWss = new WebSocketServer({ noServer: true });

  watchdogTerminalWss.on("connection", (socket, req) => {
    let closed = false;
    const terminalSession = watchdogTerminal.createOrReuseSession(
      parseRequestedTerminalSize(req),
    );
    const sessionId = String(terminalSession?.id || "");
    if (!sessionId) {
      socket.close(1011, "No terminal session");
      return;
    }

    const send = (payload = {}) => {
      if (closed || socket.readyState !== 1) return;
      socket.send(JSON.stringify(payload));
    };

    send({
      type: "session",
      session: terminalSession,
    });

    const subscription = watchdogTerminal.subscribe({
      sessionId,
      replayBuffer: false,
      tailLines: 1,
      onEvent: (event) => {
        if (event?.type === "output") {
          send({ type: "output", data: String(event.data || "") });
          return;
        }
        if (event?.type === "exit") {
          send({
            type: "exit",
            code: event.code ?? null,
            signal: event.signal ?? null,
          });
        }
      },
    });
    if (!subscription.ok) {
      socket.close(1011, "Terminal subscribe failed");
      return;
    }

    socket.on("message", (rawData) => {
      let payload = null;
      try {
        payload = JSON.parse(String(rawData || ""));
      } catch {
        return;
      }
      const messageType = String(payload?.type || "");
      if (messageType !== "input") return;
      const data = String(payload?.data || "");
      if (!data) return;
      watchdogTerminal.writeInput({ sessionId, input: data });
    });

    socket.on("close", () => {
      closed = true;
      subscription.unsubscribe();
    });
    socket.on("error", () => {
      closed = true;
      subscription.unsubscribe();
    });
  });

  // Pre-auth hardening (fix wave F009/F204). This handler runs for EVERY
  // upgrade request before any auth check, so it must never throw: an
  // uncaught exception here is process-wide (uncaughtException →
  // gracefulExit(1)), taking AlphaClaw and the managed gateway down on a
  // single malformed request. Two things could throw: `new URL()` on a
  // malformed Host header or request-target (ERR_INVALID_URL), and a write
  // to a socket the client already reset (EPIPE surfaces as an 'error'
  // event, which is fatal without a listener).
  const rejectUpgrade = (socket, statusLine, body) => {
    try {
      socket.write(
        `HTTP/1.1 ${statusLine}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${body}`,
      );
    } catch {}
    try {
      socket.destroy();
    } catch {}
  };

  server.on("upgrade", (req, socket, head) => {
    if (typeof socket?.on === "function") socket.on("error", () => {});
    let requestUrl;
    try {
      requestUrl = new URL(
        req.url || "/",
        `http://${req.headers?.host || "localhost"}`,
      );
    } catch {
      rejectUpgrade(socket, "400 Bad Request", "Bad Request");
      return;
    }
    if (
      requestUrl.pathname.startsWith("/openclaw") ||
      requestUrl.pathname === kWatchdogTerminalWsPath ||
      requestUrl.pathname === "/api/ws/chat"
    ) {
      const upgradeReq = {
        headers: req.headers,
        path: requestUrl.pathname,
        query: Object.fromEntries(requestUrl.searchParams.entries()),
      };
      if (!isAuthorizedRequest(upgradeReq)) {
        socket.write(
          "HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nUnauthorized",
        );
        socket.destroy();
        return;
      }
    }
    if (requestUrl.pathname === kWatchdogTerminalWsPath) {
      const adminCheck =
        typeof isAdminRequest === "function"
          ? isAdminRequest
          : isAuthorizedRequest;
      if (
        !adminCheck({
          headers: req.headers,
          path: requestUrl.pathname,
          query: Object.fromEntries(requestUrl.searchParams.entries()),
        })
      ) {
        socket.write(
          "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nAdmin access required",
        );
        socket.destroy();
        return;
      }
      watchdogTerminalWss.handleUpgrade(req, socket, head, (ws) => {
        watchdogTerminalWss.emit("connection", ws, req);
      });
      return;
    }
    if (requestUrl.pathname === "/api/ws/chat") {
      if (!chatWsService || typeof chatWsService.handleUpgrade !== "function") {
        socket.write(
          "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nChat websocket unavailable",
        );
        socket.destroy();
        return;
      }
      chatWsService.handleUpgrade(req, socket, head);
      return;
    }
    // Catch-all WS proxy to the gateway. Same boundary rules as the HTTP
    // proxy: ALWAYS strip inbound identity headers + the setup_token cookie,
    // inject the operator identity only for a resolved operator session.
    let operator = null;
    try {
      operator = resolveProxyIdentity(req);
    } catch {
      operator = null;
    }
    // Raw upgrade requests have no Express req.ip — apply the same trust-proxy
    // hop logic manually so a member's rebuilt X-Forwarded-For carries the
    // real client, not the ingress. Inbound XFF is read here BEFORE the strip.
    const clientIp = resolveWsClientIp({
      remoteAddress: req.socket?.remoteAddress || "",
      xForwardedFor: req.headers?.["x-forwarded-for"] || "",
      trustProxyHops: kTrustProxyHops,
    });
    applyProxyIdentity(req, operator, clientIp);
    proxy.ws(req, socket, head, { target: getGatewayUrl() });
  });
};

module.exports = {
  createWatchdogTerminalWsBridge,
  parseRequestedTerminalSize,
};
