const { WebSocketServer } = require("ws");
const { applyProxyIdentity, resolveWsClientIp } = require("./proxy-identity");
const { kTrustProxyHops } = require("./constants");
const {
  isUnsafeGatewayProxyPath,
  kControlUiBasePath,
  resolveGatewayBrowserOrigin,
} = require("./control-ui-mount");
const {
  kLogoutEvent,
  isSocketEndedByLogout,
  closeLoggedOutSocket,
} = require("./logout-sockets");
const {
  classifyBrowserOrigin,
  kOriginMismatchBody,
  logOriginRefusal,
} = require("./origin-guard");

const kWatchdogTerminalWsPath = "/api/watchdog/terminal/ws";
const kChatWsPath = "/api/ws/chat";

// The gateway WebSocket paths the catch-all forwards (ALPH-71 L-1); any other
// upgrade is 404 here instead of reaching the gateway unauthenticated.
//   /openclaw, /openclaw/*      the Control UI (cookie-checked above)
//   /                           the gateway root: `openclaw node run`, remote
//                               CLI and app clients (gateway.remote.url)
//   /__openclaw__/*             gateway namespaces: worker ingress, node worker
//                               transfers, plugin node capabilities (cap/*)
//   /node-desktop/attach,       node stream attach (ticketed)
//   /node-portal/attach
//   /desktop/observe,           viewer streams the Control UI's desktop and
//   /desktop/audio,             browser panels open with a minted token
//   /browser/screencast
//   /browser/extension          the OpenClaw Chrome extension relay
// Paths from OpenClaw 2026.10.9 (server-start's upgrade handler,
// gateway-http-route-contracts, plugin-node-capability, node-desktop-stream).
const kGatewayWsExactPaths = new Set([
  "/",
  "/node-desktop/attach",
  "/node-portal/attach",
  "/desktop/observe",
  "/desktop/audio",
  "/browser/screencast",
  "/browser/extension",
]);
const kGatewayWsNamespacePrefix = "/__openclaw__/";
const isForwardedGatewayWsPath = (pathname) =>
  pathname === kControlUiBasePath ||
  pathname.startsWith(`${kControlUiBasePath}/`) ||
  kGatewayWsExactPaths.has(pathname) ||
  pathname.startsWith(kGatewayWsNamespacePrefix);

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
  getTrustedBrowserOrigin = () => "",
  // The upgrading session's identity (routes/auth.js): its memberId is kept
  // per socket so a member's logout closes that member's sockets.
  resolveRequestIdentity = () => null,
  // Emits kLogoutEvent when a logout ends sessions (logout-sockets.js).
  authSessionEvents = null,
}) => {
  const watchdogTerminalWss = new WebSocketServer({ noServer: true });
  const socketMemberIds = new WeakMap();
  const endSocketOnLogout = new WeakMap();
  authSessionEvents?.on(kLogoutEvent, (event) => {
    for (const socket of watchdogTerminalWss.clients) {
      endSocketOnLogout.get(socket)?.(event);
    }
  });

  watchdogTerminalWss.on("connection", (socket, req) => {
    let closed = false;
    const memberId = socketMemberIds.get(socket) || null;
    endSocketOnLogout.set(socket, (event) => {
      if (!isSocketEndedByLogout(event, memberId)) return;
      closed = true;
      closeLoggedOutSocket(socket);
    });
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
      if (closed) return;
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
  const rejectUpgrade = (socket, statusLine, body, contentType = "text/plain") => {
    try {
      socket.write(
        `HTTP/1.1 ${statusLine}\r\nContent-Type: ${contentType}\r\nConnection: close\r\n\r\n${body}`,
      );
    } catch {}
    try {
      socket.destroy();
    } catch {}
  };

  const resolveUpgradeMemberId = (req) => {
    try {
      return resolveRequestIdentity({ headers: req.headers })?.memberId || null;
    } catch {
      return null;
    }
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
    // Traversal guard on the RAW request-target, for EVERY upgrade: `new URL()`
    // above already collapsed `..` (and turned `\` into `/`) out of
    // `pathname`, which is exactly how a `/openclaw/../x` or `/openclaw\..`
    // upgrade would slip past the /openclaw auth branch below and reach the
    // gateway on another path. No legitimate upgrade target here carries a
    // dot segment or a backslash (/api/watchdog/terminal/ws, /api/ws/chat,
    // /openclaw, the gateway root), so the guard is unconditional rather than
    // prefix-gated — a prefix test on the raw bytes has the same blind spots
    // it is trying to close. Same predicate as routes/proxy.js.
    if (isUnsafeGatewayProxyPath(req.url)) {
      rejectUpgrade(socket, "404 Not Found", "Not Found");
      return;
    }
    if (
      requestUrl.pathname.startsWith("/openclaw") ||
      requestUrl.pathname === kWatchdogTerminalWsPath ||
      requestUrl.pathname === kChatWsPath
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
    // The terminal and chat sockets ride the session cookie alone (the agent
    // bearer is never admitted on an upgrade), and a browser always sends
    // Origin on one: a page on another site must not open them (L-4).
    if (
      (requestUrl.pathname === kWatchdogTerminalWsPath ||
        requestUrl.pathname === kChatWsPath) &&
      classifyBrowserOrigin({
        headers: req.headers,
        trustedOrigin: getTrustedBrowserOrigin(),
      }) === "cross"
    ) {
      logOriginRefusal({
        surface: "ws",
        method: "GET",
        path: requestUrl.pathname,
        headers: req.headers,
        actor: "human",
      });
      rejectUpgrade(socket, "403 Forbidden", JSON.stringify(kOriginMismatchBody), "application/json");
      return;
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
      const memberId = resolveUpgradeMemberId(req);
      watchdogTerminalWss.handleUpgrade(req, socket, head, (ws) => {
        socketMemberIds.set(ws, memberId);
        watchdogTerminalWss.emit("connection", ws, req);
      });
      return;
    }
    if (requestUrl.pathname === kChatWsPath) {
      if (!chatWsService || typeof chatWsService.handleUpgrade !== "function") {
        socket.write(
          "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nChat websocket unavailable",
        );
        socket.destroy();
        return;
      }
      chatWsService.handleUpgrade(req, socket, head, {
        memberId: resolveUpgradeMemberId(req),
      });
      return;
    }
    if (!isForwardedGatewayWsPath(requestUrl.pathname)) {
      rejectUpgrade(socket, "404 Not Found", "Not Found");
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
    // Same-origin Control UI connects from any hostname (control-ui-mount.js);
    // read before applyProxyIdentity strips X-Forwarded-Host.
    const gatewayOrigin = resolveGatewayBrowserOrigin({
      headers: req.headers,
      trustedOrigin: getTrustedBrowserOrigin(),
    });
    applyProxyIdentity(req, operator, clientIp);
    if (gatewayOrigin) req.headers.origin = gatewayOrigin;
    proxy.ws(req, socket, head, { target: getGatewayUrl() });
  });
};

module.exports = {
  createWatchdogTerminalWsBridge,
  parseRequestedTerminalSize,
};
