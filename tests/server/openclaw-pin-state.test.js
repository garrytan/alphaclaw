const fs = require("fs");
const os = require("os");
const path = require("path");
const { describeOpenclawPin } = require("../../lib/server/openclaw-pin-state");
const { createOpenclawRuntime } = require("../../lib/server/openclaw-runtime");

describe("server/openclaw-pin-state", () => {
  it("classifies the installed version against the pin", () => {
    expect(describeOpenclawPin({ installedVersion: "2026.10.4", pinnedVersion: "2026.10.4" })).toEqual({
      state: "match", installed: "2026.10.4", pinned: "2026.10.4",
    });
    expect(describeOpenclawPin({ installedVersion: "2026.10.3", pinnedVersion: "2026.10.4" })).toEqual({
      state: "diverged", installed: "2026.10.3", pinned: "2026.10.4",
    });
    expect(describeOpenclawPin({ installedVersion: null, pinnedVersion: "2026.10.4" })).toEqual({
      state: "unreadable", installed: null, pinned: "2026.10.4",
    });
    expect(describeOpenclawPin({ installedVersion: "2026.10.4", pinnedVersion: null })).toEqual({
      state: "unknown", installed: "2026.10.4", pinned: null,
    });
    expect(describeOpenclawPin(null)).toEqual({ state: "unknown", installed: null, pinned: null });
  });

  describe("from a real install tree (openclawRuntime.getInfo)", () => {
    let root;
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pin-state-"));
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { openclaw: "2026.10.4" } }));
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
    const packageDir = () => path.join(root, "node_modules", "openclaw");
    const install = (packageJson) => {
      fs.mkdirSync(packageDir(), { recursive: true });
      fs.writeFileSync(path.join(packageDir(), "package.json"), packageJson);
      fs.writeFileSync(path.join(packageDir(), "openclaw.mjs"), "");
    };
    const pinState = () =>
      describeOpenclawPin(
        createOpenclawRuntime({ packageRoot: root, resolveInstallDir: () => root, openclawDir: path.join(root, ".openclaw") }).getInfo(),
      );

    it("reports a stale install as diverged", () => {
      install(JSON.stringify({ name: "openclaw", version: "2026.10.2", bin: { openclaw: "openclaw.mjs" } }));
      expect(pinState()).toEqual({ state: "diverged", installed: "2026.10.2", pinned: "2026.10.4" });
    });

    it("reports a missing install as unreadable", () => {
      expect(pinState()).toEqual({ state: "unreadable", installed: null, pinned: "2026.10.4" });
    });

    it("reports a malformed package.json or a missing version as unreadable", () => {
      install("{ not json");
      expect(pinState().state).toBe("unreadable");
      install(JSON.stringify({ name: "openclaw", bin: { openclaw: "openclaw.mjs" } }));
      expect(pinState().state).toBe("unreadable");
    });

    it("reports the pinned install as match", () => {
      install(JSON.stringify({ name: "openclaw", version: "2026.10.4", bin: { openclaw: "openclaw.mjs" } }));
      expect(pinState().state).toBe("match");
    });
  });
});
