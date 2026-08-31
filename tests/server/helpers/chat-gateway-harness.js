// Shared fake OpenClaw gateway + browser-socket test kit for the chat bridge
// suites (extracted from chat-ws-bridge.test.js so chat-send-reliability,
// chat-stop-lifecycle, and chat-gateway-disconnect reuse one harness).
//
// Usage:
//   const kit = createChatBridgeTestKit({ cleanups });
//   const harness = await kit.startGatewayHarness();
//   const service = kit.createService(harness, { chatRunsStore });
//   const browser = await kit.openBrowser(service);
// The caller owns the `cleanups` array and drains it in afterEach.
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

const { createChatWsService } = require("../../../lib/server/chat-ws");

const waitUntil = async (fn, label = "condition") => {
  const startedAt = Date.now();
  while (!fn()) {
    if (Date.now() - startedAt > 5000) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const createChatBridgeTestKit = ({ cleanups }) => {
  const startGatewayHarness = async ({
    connectResponse = null,
    garbageFirst = false,
  } = {}) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => wss.once("listening", resolve));
    const harness = {
      wss,
      socket: null,
      connectCount: 0,
      lastConnectParams: null,
      requests: [],
      onRequest: null,
      port: wss.address().port,
      emit(payload) {
        this.socket.send(JSON.stringify(payload));
      },
      respond(id, payload) {
        this.socket.send(JSON.stringify({ type: "res", id, ok: true, payload }));
      },
      fail(id, error) {
        this.socket.send(
          JSON.stringify({ type: "res", id, ok: false, ...(error ? { error } : {}) }),
        );
      },
    };
    wss.on("connection", (socket) => {
      harness.socket = socket;
      socket.on("message", (rawData) => {
        let frame;
        try {
          frame = JSON.parse(String(rawData || ""));
        } catch {
          return;
        }
        if (frame.method === "connect") {
          harness.connectCount += 1;
          harness.lastConnectParams = frame.params;
          if (connectResponse) {
            socket.send(
              JSON.stringify({ ...connectResponse, type: "res", id: frame.id }),
            );
          } else {
            harness.respond(frame.id, { type: "hello-ok" });
          }
          return;
        }
        harness.requests.push(frame);
        if (harness.onRequest) harness.onRequest(frame, socket);
      });
      if (garbageFirst) {
        socket.send("this is not json");
        socket.send("42");
        socket.send('"just a string"');
        socket.send(JSON.stringify({ type: "weird" }));
        socket.send(JSON.stringify({ type: "event", event: "health" }));
      }
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge" }));
    });
    cleanups.push(async () => {
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {}
      }
      await new Promise((resolve) => wss.close(resolve));
    });
    return harness;
  };

  const createService = (portOrHarness, { config, ...serviceOptions } = {}) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-chat-ws-bridge-"));
    cleanups.push(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    if (config !== undefined) {
      fs.writeFileSync(path.join(tempDir, "openclaw.json"), JSON.stringify(config));
    }
    return createChatWsService({
      fs,
      openclawDir: tempDir,
      getGatewayPort: () =>
        typeof portOrHarness === "number" ? portOrHarness : portOrHarness.port,
      ...serviceOptions,
    });
  };

  const openBrowser = async (service) => {
    const server = http.createServer((req, res) => {
      res.statusCode = 404;
      res.end();
    });
    server.on("upgrade", (request, socket, head) => {
      service.handleUpgrade(request, socket, head);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
    const messages = [];
    const listeners = new Set();
    client.on("message", (rawData) => {
      messages.push(JSON.parse(String(rawData || "")));
      for (const listener of [...listeners]) listener();
    });
    await new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    cleanups.push(() => {
      try {
        client.terminate();
      } catch {}
    });
    const waitFor = (predicate, label = "message") =>
      new Promise((resolve, reject) => {
        const check = () => {
          const found = messages.find(predicate);
          if (found) {
            clearTimeout(timer);
            listeners.delete(check);
            resolve(found);
          }
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(
            new Error(`timed out waiting for ${label}; saw ${JSON.stringify(messages)}`),
          );
        }, 5000);
        listeners.add(check);
        check();
      });
    return {
      client,
      messages,
      waitFor,
      send: (payload) => client.send(JSON.stringify(payload)),
      sendRaw: (raw) => client.send(raw),
      close: () => client.close(),
    };
  };

  const respondEmptyHistory = (harness) => (frame) => {
    if (frame.method === "chat.history") {
      harness.respond(frame.id, { messages: [] });
    }
  };

  // Start a browser run to completion of the `started` frame: responds to the
  // session's chat.send with the given runId, restoring any prior onRequest.
  const startRun = async ({ harness, browser, sessionKey, runId, clientMsgId }) => {
    const previous = harness.onRequest;
    harness.onRequest = (frame) => {
      if (frame.method === "chat.send" && frame.params.sessionKey === sessionKey) {
        harness.respond(frame.id, { runId });
        harness.onRequest = previous;
        return;
      }
      if (previous) previous(frame);
    };
    browser.send({
      type: "message",
      sessionKey,
      content: "go",
      ...(clientMsgId ? { clientMsgId } : {}),
    });
    return browser.waitFor(
      (m) => m.type === "started" && m.sessionKey === sessionKey,
      `started ${sessionKey}`,
    );
  };

  return {
    startGatewayHarness,
    createService,
    openBrowser,
    respondEmptyHistory,
    startRun,
  };
};

module.exports = { createChatBridgeTestKit, waitUntil };
