const Module = require("module");
const childProcess = require("child_process");

const {
  getActiveOpenclawVersion,
  getInstalledCodexPlugin,
  getPinnedOpenclawVersion,
  reconcileCodexPlugin,
} = require("../../lib/scripts/reconcile-codex-plugin");

const modulePath = require.resolve("../../lib/scripts/reconcile-codex-plugin");

// Command-dispatching exec mock: the reconcile flow now asks the ACTIVE
// openclaw for its version before touching the plugin (a release channel can
// activate a beta/dev build on top of the npm pin — reconciling to the pin
// force-downgraded the plugin on every boot against a newer core).
const buildExec = ({
  activeVersion = null, // null => `openclaw --version` fails (pin fallback)
  plugins = [],
  onInstall = () => "",
} = {}) =>
  vi.fn((file, args = []) => {
    if (args[0] === "--version") {
      if (activeVersion === null) throw new Error("spawn openclaw ENOENT");
      return `OpenClaw ${activeVersion}\n`;
    }
    if (args[0] === "plugins" && args[1] === "list") {
      return JSON.stringify({ plugins });
    }
    if (args[0] === "plugins" && args[1] === "install") {
      return onInstall(args);
    }
    throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
  });

describe("scripts/reconcile-codex-plugin", () => {
  it("reconciles a stale plugin to the ACTIVE openclaw version", () => {
    const exec = buildExec({
      activeVersion: "2026.9.1-beta.1",
      plugins: [{ id: "codex", origin: "global", version: "2026.5.28" }],
    });

    const result = reconcileCodexPlugin({ exec, logger: { log: vi.fn() } });

    expect(result).toEqual({
      changed: true,
      previousVersion: "2026.5.28",
      version: "2026.9.1-beta.1",
    });
    expect(exec).toHaveBeenLastCalledWith(
      "openclaw",
      ["plugins", "install", "@openclaw/codex@2026.9.1-beta.1", "--force"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("skips (never falls back to the pin) when the active version cannot be read", () => {
    // A failed --version probe on a box whose release channel has a beta
    // active would otherwise force-downgrade the plugin to the npm pin.
    const logger = { log: vi.fn() };
    const exec = buildExec({
      activeVersion: null,
      plugins: [{ id: "codex", origin: "global", version: "2026.5.28" }],
    });

    const result = reconcileCodexPlugin({ exec, logger });

    expect(result).toEqual({
      changed: false,
      reason: "active-version-unknown",
    });
    // Only the --version probe ran; nothing was listed or installed.
    expect(exec).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("could not determine the active openclaw version"),
    );
  });

  it("never force-downgrades the plugin under a dev-sha core — skips with a log", () => {
    const logger = { log: vi.fn() };
    const exec = buildExec({
      activeVersion: "abc1234",
      plugins: [{ id: "codex", origin: "global", version: "2026.5.28" }],
    });

    const result = reconcileCodexPlugin({ exec, logger });

    expect(result).toEqual({
      changed: false,
      reason: "unpublished-active-version",
      version: "abc1234",
    });
    // Only the --version probe ran; the plugin was never listed or touched.
    expect(exec).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("not a published release"),
    );
  });

  it("is a no-op when the installed plugin matches the active version", () => {
    const exec = buildExec({
      activeVersion: "2026.7.1-2",
      plugins: [{ id: "codex", origin: "global", version: "2026.7.1-2" }],
    });

    expect(reconcileCodexPlugin({ exec })).toEqual({
      changed: false,
      reason: "current",
      version: "2026.7.1-2",
    });
    // --version + plugins list; no install.
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("does not install Codex for users who do not already have it", () => {
    const exec = buildExec({ activeVersion: "2026.7.1-2", plugins: [] });

    expect(reconcileCodexPlugin({ exec })).toEqual({
      changed: false,
      reason: "not-installed",
    });
  });

  it("treats an unavailable openclaw CLI as unknown-version (skip), and helpers degrade cleanly", () => {
    const exec = vi.fn(() => {
      throw new Error("spawn openclaw ENOENT");
    });

    expect(getInstalledCodexPlugin({ exec })).toBe(null);
    expect(getActiveOpenclawVersion({ exec })).toBe("");
    expect(
      reconcileCodexPlugin({ exec, logger: { log: vi.fn() } }),
    ).toEqual({
      changed: false,
      reason: "active-version-unknown",
    });
  });

  it("runs reconciliation when executed as the main module and warns on failure", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const originalExecFileSync = childProcess.execFileSync;
    const originalMainModule = process.mainModule;
    const cachedModule = require.cache[modulePath];
    childProcess.execFileSync = buildExec({
      activeVersion: "2026.7.1-2",
      plugins: [{ id: "codex", origin: "global", version: "0.0.1" }],
      onInstall: () => {
        throw new Error("install blew up");
      },
    });

    try {
      delete require.cache[modulePath];
      Module._load(modulePath, null, true);

      // --version, plugins list, failed install.
      expect(childProcess.execFileSync).toHaveBeenCalledTimes(3);
      expect(warnSpy).toHaveBeenCalledWith(
        "[alphaclaw] Codex plugin reconciliation warning: install blew up",
      );
    } finally {
      process.mainModule = originalMainModule;
      childProcess.execFileSync = originalExecFileSync;
      delete require.cache[modulePath];
      if (cachedModule) require.cache[modulePath] = cachedModule;
    }
  });
});
