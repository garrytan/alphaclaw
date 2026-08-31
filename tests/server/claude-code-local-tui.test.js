const fs = require("fs");
const path = require("path");
const {
  stripAnsi,
  extractRemoteControlUrl,
  extractOauthUrl,
  detectAuthGateError,
  detectTrustPrompt,
  detectAwaitingCode,
  detectBridgeDisconnect,
} = require("../../lib/server/claude-code-local/tui");

const kFixtureDir = path.join(__dirname, "fixtures", "claude-code-tui");
const fixture = (name) => fs.readFileSync(path.join(kFixtureDir, name), "utf8");

describe("claude-code-local tui parsers", () => {
  describe("stripAnsi", () => {
    it("removes CSI, OSC, charset, and cursor-visibility residue", () => {
      const noisy =
        "\x1b]0;title\x07\x1b[1;32mhello\x1b[0m [?25lworld[?25h\x1b(B\x1b=\r";
      expect(stripAnsi(noisy)).toBe("hello world");
    });

    it("is a no-op on plain text", () => {
      expect(stripAnsi("plain text\nline two")).toBe("plain text\nline two");
    });
  });

  describe("extractRemoteControlUrl", () => {
    it("extracts and canonicalizes the URL with a query suffix", () => {
      const found = extractRemoteControlUrl(
        "  Session ready!\n  https://claude.ai/code/abc123XYZ_-99?from=cli\n",
      );
      expect(found).toEqual({
        sessionId: "abc123XYZ_-99",
        sessionUrl: "https://claude.ai/code/abc123XYZ_-99",
      });
    });

    it("survives ANSI noise and single-logical-line reflow around the URL", () => {
      // The gstack failure shape: a whole boxed screen reflowed onto one
      // line with cursor-positioning escapes collapsed away.
      const reflowed =
        "\x1b[1m│\x1b[0m Scan with your phone [?25l✻[?25h https://claude.ai/code/sess_0123456789?from=cli │ press w to toggle";
      expect(extractRemoteControlUrl(reflowed)?.sessionUrl).toBe(
        "https://claude.ai/code/sess_0123456789",
      );
    });

    it("refuses short ids and foreign hosts", () => {
      expect(extractRemoteControlUrl("https://claude.ai/code/short")).toBeNull();
      expect(
        extractRemoteControlUrl("https://evil.example/code/abcdefgh1234"),
      ).toBeNull();
    });

    it("does not match the auth-gate fixture", () => {
      expect(extractRemoteControlUrl(fixture("rc-needs-login.txt"))).toBeNull();
    });
  });

  describe("extractOauthUrl (fixture-pinned: claude.com /cai/oauth path)", () => {
    it("extracts the real login URL from the captured buffer", () => {
      const url = extractOauthUrl(fixture("auth-login-oauth-url.txt"));
      expect(url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
      expect(url).toContain("code=true");
    });

    it("rejects lookalike hosts", () => {
      expect(extractOauthUrl("https://claude.evil.com/oauth/authorize?x=1")).toBeNull();
      expect(extractOauthUrl("visit http://claude.ai/oauth/x")).toBeNull();
    });
  });

  describe("detectAuthGateError (fixture-pinned)", () => {
    it("classifies the not-logged-in screen", () => {
      expect(detectAuthGateError(fixture("rc-needs-login.txt"))).toBe("needs_login");
    });

    it("classifies the api-key conflict and subscription screens", () => {
      expect(
        detectAuthGateError("Unset ANTHROPIC_API_KEY (or run in a shell without it) to use Remote Control."),
      ).toBe("env_conflict");
      expect(
        detectAuthGateError("Remote Control requires a claude.ai subscription. Run `claude auth login`."),
      ).toBe("subscription_required");
    });

    it("returns null on unrelated output", () => {
      expect(detectAuthGateError("compiling…\ndone.")).toBeNull();
    });
  });

  describe("prompt detectors", () => {
    it("detects the trust dialog and the bypass acknowledgment", () => {
      expect(detectTrustPrompt("Do you trust the files in this folder?")).toBe(true);
      expect(detectTrustPrompt("WARNING: Bypass Permissions mode ...")).toBe(true);
      expect(detectTrustPrompt("just some output")).toBe(false);
    });

    it("detects the awaiting-code prompt from the captured login buffer", () => {
      expect(detectAwaitingCode(fixture("auth-login-oauth-url.txt"))).toBe(true);
      expect(detectAwaitingCode("Opening browser…")).toBe(false);
    });

    it("scopes bridge-disconnect warnings to remote-control phrasing", () => {
      expect(detectBridgeDisconnect("Remote Control disconnected, reconnecting…")).toBe(true);
      expect(detectBridgeDisconnect("network disconnected while fetching npm")).toBe(false);
    });
  });
});
