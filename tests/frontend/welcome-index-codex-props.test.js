// The onboarding step's honesty state (a FIRST unavailable read is not a
// checked status) only renders when welcome/index.js threads the props
// use-welcome.js exposes — the coverage audit found them dropped, which made
// the state unreachable in the real app while every unit test passed. Source pin, like the server
// wiring pins.
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "..", "lib", "public", "js", "components", "welcome", "index.js"),
  "utf8",
);

describe("welcome/index.js threads the Codex honesty props into WelcomeFormStep", () => {
  it("passes codexStatusUnknown and codexStatusKnown from the hook state", () => {
    const start = source.indexOf("<${WelcomeFormStep}");
    const block = source.slice(start, source.indexOf("codexManualInput=", start));
    expect(block).toContain("codexStatusUnknown=${state.codexStatusUnknown}");
    expect(block).toContain("codexStatusKnown=${state.codexStatusKnown}");
  });
});
