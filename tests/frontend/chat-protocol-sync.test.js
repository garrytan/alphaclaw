// Pins the browser protocol mirror against the server source of truth so the
// two frame-type lists (and the protocol version) can never drift silently.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  contentByteLength,
  kBrowserFrameTypes,
  kProtocolVersion,
  kServerFrameTypes,
} from "../../lib/public/js/components/chat/chat-protocol.js";

const require = createRequire(import.meta.url);
const serverProtocol = require("../../lib/server/chat/protocol.js");

describe("frontend/chat protocol sync (client mirror vs server)", () => {
  it("kBrowserFrameTypes is exactly equal (same order) on both sides", () => {
    expect(kBrowserFrameTypes).toEqual(serverProtocol.kBrowserFrameTypes);
  });

  it("kServerFrameTypes is exactly equal (same order) on both sides", () => {
    expect(kServerFrameTypes).toEqual(serverProtocol.kServerFrameTypes);
  });

  it("kProtocolVersion matches", () => {
    expect(kProtocolVersion).toBe(serverProtocol.kProtocolVersion);
  });

  it("client contentByteLength measures UTF-8 bytes like the server", () => {
    // "héllo" is 5 code points but 6 UTF-8 bytes — a length-based count
    // would disagree with the server's Buffer.byteLength cap.
    expect(contentByteLength("héllo")).toBe(Buffer.byteLength("héllo", "utf8"));
    expect(contentByteLength("héllo")).toBe(serverProtocol.contentByteLength("héllo"));
  });
});
