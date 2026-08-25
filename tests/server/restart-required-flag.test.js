const fs = require("fs");
const os = require("os");
const path = require("path");

// Point the constants-derived default flag path at a temp root before any
// module under test is required, so nothing touches the real ~/.alphaclaw.
const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-flag-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;

const {
  kRestartRequiredFlagPath,
  readRestartRequiredFlag,
  writeRestartRequiredFlag,
  clearRestartRequiredFlag,
} = require("../../lib/server/restart-required-flag");
const {
  createRestartRequiredState,
} = require("../../lib/server/restart-required-state");

describe("server/restart-required-flag", () => {
  afterEach(() => {
    clearRestartRequiredFlag();
  });

  afterAll(() => {
    fs.rmSync(kTempRoot, { recursive: true, force: true });
  });

  it("resolves the default flag path outside workspace/", () => {
    expect(kRestartRequiredFlagPath).toBe(
      path.join(kTempRoot, ".openclaw", "alphaclaw-restart-required.json"),
    );
    expect(kRestartRequiredFlagPath).not.toContain(`${path.sep}workspace${path.sep}`);
  });

  it("round-trips write → read → clear", () => {
    expect(readRestartRequiredFlag()).toBeNull();

    const flagPath = writeRestartRequiredFlag({
      reason: "telegram_actions_enabled",
      source: "cli",
    });
    expect(flagPath).toBe(kRestartRequiredFlagPath);
    expect(fs.existsSync(kRestartRequiredFlagPath)).toBe(true);

    const flag = readRestartRequiredFlag();
    expect(flag.reason).toBe("telegram_actions_enabled");
    expect(flag.source).toBe("cli");
    expect(flag.markedAt).toBeGreaterThan(0);

    clearRestartRequiredFlag();
    expect(fs.existsSync(kRestartRequiredFlagPath)).toBe(false);
    expect(readRestartRequiredFlag()).toBeNull();
  });

  it("defaults reason to config_changed and survives clearing a missing file", () => {
    writeRestartRequiredFlag({ reason: "   " });
    expect(readRestartRequiredFlag().reason).toBe("config_changed");
    clearRestartRequiredFlag();
    // Clearing again is a no-op, never a throw.
    expect(() => clearRestartRequiredFlag()).not.toThrow();
  });

  it("returns null for unreadable or malformed flag files", () => {
    fs.mkdirSync(path.dirname(kRestartRequiredFlagPath), { recursive: true });
    fs.writeFileSync(kRestartRequiredFlagPath, "not-json{");
    expect(readRestartRequiredFlag()).toBeNull();
    fs.writeFileSync(kRestartRequiredFlagPath, '"just-a-string"');
    expect(readRestartRequiredFlag()).toBeNull();
  });
});

describe("server/restart-required-state (persisted flag adoption)", () => {
  afterEach(() => {
    clearRestartRequiredFlag();
  });

  it("adopts a flag written by another process and surfaces its reason", async () => {
    // "Another process" (the CLI) writes the file directly.
    fs.mkdirSync(path.dirname(kRestartRequiredFlagPath), { recursive: true });
    fs.writeFileSync(
      kRestartRequiredFlagPath,
      JSON.stringify({
        reason: "telegram_actions_enabled",
        source: "cli",
        markedAt: Date.now(),
      }),
    );

    const state = createRestartRequiredState({
      isGatewayRunning: async () => true,
    });
    const snapshot = await state.getSnapshot();
    expect(snapshot.restartRequired).toBe(true);
    expect(snapshot.reason).toBe("telegram_actions_enabled");
    expect(snapshot.gatewayRunning).toBe(true);
  });

  it("markRequired persists the flag; clearRequired removes the file", async () => {
    const state = createRestartRequiredState({
      isGatewayRunning: async () => true,
    });
    state.markRequired("config_changed", { source: "server" });
    expect(fs.existsSync(kRestartRequiredFlagPath)).toBe(true);
    expect(readRestartRequiredFlag().source).toBe("server");

    state.clearRequired();
    expect(fs.existsSync(kRestartRequiredFlagPath)).toBe(false);
    const snapshot = await state.getSnapshot();
    expect(snapshot.restartRequired).toBe(false);
    expect(snapshot.reason).toBe("");
  });

  it("clears after a gateway down→up cycle (restart recovery)", async () => {
    let gatewayRunning = true;
    const state = createRestartRequiredState({
      isGatewayRunning: async () => gatewayRunning,
    });
    state.markRequired("telegram_actions_enabled");

    // Still pending while the gateway has not restarted yet.
    let snapshot = await state.getSnapshot();
    expect(snapshot.restartRequired).toBe(true);

    // Gateway goes down (restart in flight)…
    gatewayRunning = false;
    snapshot = await state.getSnapshot();
    expect(snapshot.restartRequired).toBe(true);

    // …and comes back: the pending restart is considered done.
    gatewayRunning = true;
    snapshot = await state.getSnapshot();
    expect(snapshot.restartRequired).toBe(false);
    expect(snapshot.reason).toBe("");
    // The persisted flag is gone too, so it cannot be re-adopted.
    expect(fs.existsSync(kRestartRequiredFlagPath)).toBe(false);
  });

  it("does not clear while a restart is explicitly in progress", async () => {
    let gatewayRunning = false;
    const state = createRestartRequiredState({
      isGatewayRunning: async () => gatewayRunning,
    });
    state.markRequired();
    state.markRestartInProgress();

    gatewayRunning = true;
    const snapshot = await state.getSnapshot();
    expect(snapshot.restartRequired).toBe(true);
    expect(snapshot.restartInProgress).toBe(true);

    state.markRestartComplete();
    expect((await state.getSnapshot()).restartInProgress).toBe(false);
  });

  it("uses an injected flagStore when provided", async () => {
    const store = { read: vi.fn(() => null), write: vi.fn(), clear: vi.fn() };
    const state = createRestartRequiredState({
      isGatewayRunning: async () => true,
      flagStore: store,
    });
    state.markRequired("custom_reason", { source: "test" });
    expect(store.write).toHaveBeenCalledWith("custom_reason", "test");
    state.clearRequired();
    expect(store.clear).toHaveBeenCalledTimes(1);
    // Injected store means the default file is never touched.
    expect(fs.existsSync(kRestartRequiredFlagPath)).toBe(false);

    store.read.mockReturnValue({ reason: "from_store" });
    const snapshot = await state.getSnapshot();
    expect(snapshot.restartRequired).toBe(true);
    expect(snapshot.reason).toBe("from_store");
  });
});
