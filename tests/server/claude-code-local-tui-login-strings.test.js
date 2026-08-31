const fs = require("fs");
const path = require("path");
const {
  detectLoginSuccess,
  detectLoginFailure,
} = require("../../lib/server/claude-code-local/tui");

const kFixtureDir = path.join(__dirname, "fixtures", "claude-code-tui");
const fixture = (name) => fs.readFileSync(path.join(kFixtureDir, name), "utf8");

// These strings are provisional (the authoritative success signal is the
// `claude auth status` re-probe); pinning them keeps a detector regression
// from silently widening or narrowing the match set.
const kSuccessLines = [
  "Login successful",
  "Logged in as garry@example.com",
  "successfully logged in",
];

const kFailureLines = [
  "Invalid code",
  "code expired",
  "OAuth error",
  "Login failed",
  "invalid grant",
];

const kPlainOutput = "compiling...\nnpm install output\ndone.";

describe("claude-code-local login-flow string detectors", () => {
  describe("detectLoginSuccess", () => {
    it("matches every pinned success string", () => {
      for (const line of kSuccessLines) {
        expect(detectLoginSuccess(line)).toBe(true);
      }
    });

    it("does not match plain output", () => {
      expect(detectLoginSuccess(kPlainOutput)).toBe(false);
    });

    it("does not match the captured OAuth URL screen", () => {
      expect(detectLoginSuccess(fixture("auth-login-oauth-url.txt"))).toBe(false);
    });
  });

  describe("detectLoginFailure", () => {
    it("matches every pinned failure string", () => {
      for (const line of kFailureLines) {
        expect(detectLoginFailure(line)).toBe(true);
      }
    });

    it("does not match plain output", () => {
      expect(detectLoginFailure(kPlainOutput)).toBe(false);
    });

    it("does not match the captured OAuth URL screen", () => {
      // The URL carries code=true and code_challenge params, which must not
      // trip the invalid/expired-code patterns.
      expect(detectLoginFailure(fixture("auth-login-oauth-url.txt"))).toBe(false);
    });
  });
});
