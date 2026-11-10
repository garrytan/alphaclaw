const fs = require("fs");
const os = require("os");
const path = require("path");
const { describeOpenclawPin, describeHoldRejection, kOpenclawHoldFloor, readOpenclawHold } = require("../../lib/server/openclaw-pin-state");
const { resolveSelfDependency } = require("../../lib/server/self-dependency");
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

  describe("a deliberate hold (the app package.json's exact overrides.openclaw, GST-2293)", () => {
    const at = (installedVersion, heldVersion) =>
      describeOpenclawPin({ installedVersion, pinnedVersion: "2026.11.2", heldVersion });

    it("held: the installed tree is the declared hold, older than the pin and at or above the floor", () => {
      expect(kOpenclawHoldFloor).toBe("2026.10.9");
      expect(at("2026.10.9", "2026.10.9")).toEqual({
        state: "held", installed: "2026.10.9", pinned: "2026.11.2", held: "2026.10.9",
      });
      expect(at("2026.11.1", "2026.11.1").state).toBe("held");
      expect(at("2026.11.2", "2026.10.9").state).toBe("match");
    });

    it("unexpected: no hold declared, or a hold that names another version, stays diverged", () => {
      expect(at("2026.10.9", null)).toEqual({ state: "diverged", installed: "2026.10.9", pinned: "2026.11.2" });
      expect(at("2026.10.10", "2026.10.9")).toEqual({
        state: "diverged", installed: "2026.10.10", pinned: "2026.11.2", held: "2026.10.9", reason: "not_held",
      });
      expect(at("2026.11.5", "2026.11.5")).toMatchObject({ state: "diverged", reason: "above_pin" });
    });

    it("too old: a hold below the supported floor stays diverged", () => {
      expect(at("2026.10.4", "2026.10.4")).toEqual({
        state: "diverged", installed: "2026.10.4", pinned: "2026.11.2", held: "2026.10.4", floor: "2026.10.9", reason: "below_floor",
      });
      expect(at("2026.10.9-beta.1", "2026.10.9-beta.1")).toMatchObject({ state: "diverged", reason: "below_floor" });
    });

    it("says why a declared hold does not cover the install", () => {
      expect(describeHoldRejection(at("2026.10.4", "2026.10.4"))).toMatch(/older than 2026\.10\.9/);
      expect(describeHoldRejection(at("2026.10.10", "2026.10.9"))).toMatch(/holds OpenClaw at 2026\.10\.9, but 2026\.10\.10 is installed/);
      expect(describeHoldRejection(at("2026.10.9", null))).toBe(null);
      expect(describeHoldRejection(at("2026.10.9", "2026.10.9"))).toBe(null);
    });

    describe("readOpenclawHold from the app that depends on AlphaClaw", () => {
      let root;
      beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hold-"));
        fs.mkdirSync(path.join(root, "app", "node_modules", "alphaclaw"), { recursive: true });
      });
      afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
      const readWith = (appPackageJson) => {
        fs.writeFileSync(path.join(root, "app", "package.json"), JSON.stringify(appPackageJson));
        return readOpenclawHold({
          resolveDependency: () => resolveSelfDependency({ startDir: path.join(root, "app", "node_modules", "alphaclaw") }),
        });
      };
      const dependsOnAlphaclaw = { dependencies: { alphaclaw: "git+https://github.com/garrytan/alphaclaw.git#abc" } };

      it("reads an exact version, as a string or npm's { \".\": version } form", () => {
        expect(readWith({ ...dependsOnAlphaclaw, overrides: { openclaw: "2026.10.9" } })).toBe("2026.10.9");
        expect(readWith({ ...dependsOnAlphaclaw, overrides: { openclaw: { ".": "2026.10.9" } } })).toBe("2026.10.9");
      });

      it("a range, a $reference, no override or an app that does not depend on AlphaClaw is no hold", () => {
        expect(readWith({ ...dependsOnAlphaclaw, overrides: { openclaw: "^2026.10.9" } })).toBe(null);
        expect(readWith({ ...dependsOnAlphaclaw, overrides: { openclaw: "$openclaw" } })).toBe(null);
        expect(readWith(dependsOnAlphaclaw)).toBe(null);
        expect(readWith({ overrides: { openclaw: "2026.10.9" } })).toBe(null);
      });
    });
  });
});

