const fs = require("fs");
const path = require("path");

// MW5: the HTTP history fallback must not latch realtime OFF for the page
// lifetime when the WebSocket is merely still CONNECTING. onopen clears the
// latch, and the fallback only latches when the socket is genuinely down.
// Source-level guard: chat-route pulls in preact/htm and isn't unit-mountable.
const chatRouteSource = fs.readFileSync(
  path.join(__dirname, "../../lib/public/js/components/routes/chat-route.js"),
  "utf8",
);

describe("frontend/chat-route realtime latch (MW5)", () => {
  it("clears the realtime latch on ws.onopen", () => {
    const onopenBlock = chatRouteSource.slice(
      chatRouteSource.indexOf("ws.onopen = () => {"),
      chatRouteSource.indexOf("ws.onclose = () => {"),
    );
    expect(onopenBlock).toContain("realtimeDisabledRef.current = false");
  });

  it("does not latch off a CONNECTING socket in the HTTP fallback", () => {
    // The latch is now gated on the socket NOT being connecting/open.
    expect(chatRouteSource).toContain("ws.readyState === 0 || ws.readyState === 1");
    expect(chatRouteSource).toContain("if (!isConnected && !wsConnectingOrOpen)");
    // The old unconditional close of the (possibly connecting) socket is gone
    // from this branch.
    expect(chatRouteSource).not.toContain(
      "if (!isConnected) {\n          // If HTTP history works",
    );
  });
});
