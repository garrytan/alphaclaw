const {
  kBrowseRestartRules,
  shouldRequireRestartForBrowsePath,
} = require("../../lib/server/routes/browse/restart-rules");
const shared = require("../../lib/public/shared/browse-restart-rules.json");

// The server module and the client mirror read ONE JSON file; this pins the
// server side of that contract (the client fetches the same URL).
describe("server/routes/browse/restart-rules", () => {
  it("loads the shared rules verbatim", () => {
    expect(kBrowseRestartRules).toEqual(shared.rules);
    expect(shared.rules).toEqual([
      { type: "file", path: "openclaw.json" },
      { type: "directory", path: "hooks/transforms" },
    ]);
  });

  it("matches the config file exactly and the transforms directory by prefix", () => {
    expect(shouldRequireRestartForBrowsePath("openclaw.json")).toBe(true);
    expect(shouldRequireRestartForBrowsePath("/openclaw.json/")).toBe(true);
    expect(shouldRequireRestartForBrowsePath("openclaw.json.bak")).toBe(false);
    expect(shouldRequireRestartForBrowsePath("hooks/transforms")).toBe(true);
    expect(shouldRequireRestartForBrowsePath("hooks/transforms/x.js")).toBe(true);
    expect(shouldRequireRestartForBrowsePath("hooks/transforms-old/x.js")).toBe(false);
    expect(shouldRequireRestartForBrowsePath("hooks/bootstrap/AGENTS.md")).toBe(false);
    expect(shouldRequireRestartForBrowsePath("")).toBe(false);
  });
});
