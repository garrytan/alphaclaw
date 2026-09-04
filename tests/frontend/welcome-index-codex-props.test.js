// The onboarding step's honesty states (a FIRST quiet-period read is not a
// checked status; a deferred Codex exchange is "saved after the backup") only
// render when welcome/index.js threads the two props use-welcome.js exposes —
// the coverage audit found them dropped, which made both states unreachable
// in the real app while every unit test passed. Source pin, like the server
// wiring pins.
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "..", "lib", "public", "js", "components", "welcome", "index.js"),
  "utf8",
);

describe("welcome/index.js threads the Codex honesty props into WelcomeFormStep", () => {
  it("passes codexStatusKnown and codexDeferredSavePending from the hook state", () => {
    const start = source.indexOf("<${WelcomeFormStep}");
    const block = source.slice(start, source.indexOf("codexManualInput=", start));
    expect(block).toContain("codexStatusUnknown=${state.codexStatusUnknown}");
    expect(block).toContain("codexStatusKnown=${state.codexStatusKnown}");
    expect(block).toContain("codexDeferredSavePending=${state.codexDeferredSavePending}");
  });
});
