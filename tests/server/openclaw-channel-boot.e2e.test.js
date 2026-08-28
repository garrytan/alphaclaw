const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createOpenclawChannelSync,
} = require("../../lib/server/openclaw-channel-sync");
const {
  createOpenclawReleaseChannelStore,
} = require("../../lib/server/openclaw-release-channel");

// End-to-end coverage for syncAtBoot: the real channel-sync service + real
// store recovering real on-disk trees, with the environment poisoned so any
// network fetch or spawned command fails the test — boot activation must be
// fully offline (overlay store + checkout fs checks only).

const kSilentLogger = { log() {}, warn() {}, error() {} };
const kDevSha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

const kOriginalFetch = global.fetch;

const mkTemp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const flushAsync = () => new Promise((resolve) => process.nextTick(resolve));

const writePackageFixture = (
  packageDir,
  {
    version,
    bin = { openclaw: "bin/entry.js" },
    thinking = true,
    extensions = true,
  } = {},
) => {
  fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ name: "openclaw", version, ...(bin ? { bin } : {}) }, null, 2)}\n`,
  );
  if (bin) {
    const relative = typeof bin === "string" ? bin : Object.values(bin)[0];
    const binPath = path.join(packageDir, relative);
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, "#!/usr/bin/env node\nconsole.log('ok');\n");
  }
  if (thinking) {
    fs.writeFileSync(
      path.join(packageDir, "dist", "thinking-levels.js"),
      "exports.listThinkingLevelOptions = () => [];\n",
    );
  }
  if (extensions) {
    fs.mkdirSync(path.join(packageDir, "dist", "extensions"), {
      recursive: true,
    });
  }
  return packageDir;
};

const writeInstallFixture = (installDir, options) =>
  writePackageFixture(
    path.join(installDir, "node_modules", "openclaw"),
    options,
  );

const writeCheckoutFixture = (rootDir, { sha, bin = true } = {}) => {
  const checkoutDir = path.join(rootDir, "openclaw");
  fs.mkdirSync(path.join(checkoutDir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(checkoutDir, ".git", "HEAD"), `${sha}\n`);
  fs.writeFileSync(
    path.join(checkoutDir, "package.json"),
    `${JSON.stringify({ name: "openclaw", version: "0.0.0-dev", bin: { openclaw: "./bin/entry.js" } }, null, 2)}\n`,
  );
  if (bin) {
    fs.mkdirSync(path.join(checkoutDir, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(checkoutDir, "bin", "entry.js"),
      "#!/usr/bin/env node\n",
    );
  }
  return checkoutDir;
};

const saveOverlayFixture = (store, version) =>
  store.saveOverlayFromTempInstall({
    openclawPackageDir: writePackageFixture(
      path.join(mkTemp("alphaclaw-boot-overlay-src-"), "openclaw"),
      { version },
    ),
    version,
  });

// Boot harness: releases is null, the runner throws if ever invoked, and
// installToTempDir throws too. Combined with the poisoned global.fetch in
// beforeEach, no boot path can reach the network or spawn a process.
const createHarness = ({
  pin = "1.0.0",
  channel = "stable",
  installedVersion = null,
  sentinelVersion = null,
  storeWrap = (store) => store,
  execFileSyncImpl = undefined,
} = {}) => {
  delete process.env.OPENCLAW_GIT_DIR;
  const rootDir = mkTemp("alphaclaw-boot-e2e-root-");
  const openclawDir = path.join(rootDir, ".openclaw");
  const packageRoot = mkTemp("alphaclaw-boot-e2e-pkgroot-");
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "@chrysb/alphaclaw", dependencies: { openclaw: pin } })}\n`,
  );
  const installDir = mkTemp("alphaclaw-boot-e2e-install-");
  if (installedVersion) {
    writeInstallFixture(installDir, { version: installedVersion });
  }

  const nowRef = { now: 1_000_000 };
  const nowFn = () => nowRef.now;
  const store = createOpenclawReleaseChannelStore({
    rootDir,
    openclawDir,
    nowFn,
    logger: kSilentLogger,
  });
  if (sentinelVersion) {
    store.writeSentinel({ installDir, version: sentinelVersion });
  }

  const runner = {
    runStreamed: vi.fn(() => {
      throw new Error("runStreamed must never be called during boot sync");
    }),
  };
  const installToTempDir = vi.fn(() => {
    throw new Error("installToTempDir must never be called during boot sync");
  });
  const notify = vi.fn(async () => {});
  const restartProcess = vi.fn();

  const sync = createOpenclawChannelSync({
    rootDir,
    openclawDir,
    packageRoot,
    store: storeWrap(store),
    runStream: runner,
    installToTempDir,
    resolveInstallDir: () => installDir,
    readReleaseChannel: () => channel,
    releases: null,
    isOnboarded: () => true,
    restartProcess,
    clearVersionCache: vi.fn(),
    notify,
    nowFn,
    logger: kSilentLogger,
    backupsDir: path.join(rootDir, "backups", "openclaw"),
    ...(execFileSyncImpl ? { execFileSyncImpl } : {}),
  });

  return {
    sync,
    store,
    rootDir,
    openclawDir,
    installDir,
    runner,
    installToTempDir,
    notify,
    restartProcess,
    nowRef,
  };
};

const installedPackageJsonVersion = (installDir) =>
  JSON.parse(
    fs.readFileSync(
      path.join(installDir, "node_modules", "openclaw", "package.json"),
      "utf8",
    ),
  ).version;

const installedBinPath = (installDir) =>
  path.join(installDir, "node_modules", "openclaw", "bin", "entry.js");

const notifyMessages = (notify) =>
  notify.mock.calls.map((call) => String(call?.[0] || ""));

const assertOffline = (harness) => {
  expect(harness.runner.runStreamed).not.toHaveBeenCalled();
  expect(harness.installToTempDir).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
};

describe("server/openclaw-channel boot sync (e2e)", () => {
  beforeEach(() => {
    global.fetch = vi.fn(() => {
      throw new Error("network poisoned: boot sync must be offline");
    });
  });

  afterEach(() => {
    if (kOriginalFetch == null) {
      delete global.fetch;
    } else {
      global.fetch = kOriginalFetch;
    }
    vi.useRealTimers();
  });

  it("re-activates an applied beta on a fresh container image, fully offline", () => {
    const harness = createHarness({
      pin: "1.0.0",
      channel: "beta",
      installedVersion: "1.0.0",
      // No sentinel: a container image reset never carries one.
    });
    const { sync, store, installDir } = harness;
    store.updateState((s) => {
      s.pinVersion = "1.0.0";
      s.applied = { channel: "beta", version: "1.1.0", at: 1, acceptedAt: 2 };
      return s;
    });
    expect(saveOverlayFixture(store, "1.1.0")).toEqual({ ok: true });
    // A leftover dev shim must be removed on package-channel boots.
    expect(
      store.writeBinShim({
        targetBin: installedBinPath(installDir),
        label: "stale",
      }),
    ).toEqual({ ok: true });
    expect(fs.existsSync(store.shimPath)).toBe(true);

    const result = sync.syncAtBoot();

    expect(result.ok).toBe(true);
    expect(result.action).toBe("activated");
    expect(installedPackageJsonVersion(installDir)).toBe("1.1.0");
    expect(store.readSentinel({ installDir })).toEqual({
      version: "1.1.0",
      completedAt: harness.nowRef.now,
    });
    expect(fs.existsSync(store.shimPath)).toBe(false);
    expect(store.readState().lastBoot).toEqual(
      expect.objectContaining({ action: "activated" }),
    );
    assertOffline(harness);
  });

  it("recovers a mid-copy crash: plausible package.json but no sentinel", () => {
    const harness = createHarness({
      pin: "1.0.0",
      channel: "beta",
      installedVersion: "1.1.0",
      // Sentinel intentionally missing: the copy never completed.
    });
    const { sync, store, installDir } = harness;
    store.updateState((s) => {
      s.pinVersion = "1.0.0";
      s.applied = { channel: "beta", version: "1.1.0", at: 1, acceptedAt: 2 };
      return s;
    });
    expect(saveOverlayFixture(store, "1.1.0")).toEqual({ ok: true });
    // Simulate the interrupted copy: one marker directory vanished from the
    // live tree even though package.json already reads the target version.
    const extensionsDir = path.join(
      installDir,
      "node_modules",
      "openclaw",
      "dist",
      "extensions",
    );
    fs.rmSync(extensionsDir, { recursive: true, force: true });
    expect(fs.existsSync(extensionsDir)).toBe(false);

    const result = sync.syncAtBoot();

    expect(result.ok).toBe(true);
    expect(result.action).toBe("activated");
    expect(installedPackageJsonVersion(installDir)).toBe("1.1.0");
    expect(fs.existsSync(extensionsDir)).toBe(true); // restored from overlay
    expect(store.readSentinel({ installDir })).toEqual(
      expect.objectContaining({ version: "1.1.0" }),
    );
    assertOffline(harness);
  });

  it("boot rollback warns (never blocks) when the target cannot verify current state (C1)", () => {
    const { DatabaseSync } = require("node:sqlite");
    // The rollback target's `database preflight` rejects the snapshot with an
    // unknown-command error — the stable-target case. Boot must activate
    // anyway and surface the honest warning naming the backup as recovery.
    const execFileSyncImpl = vi.fn((cmd, args) => {
      if (Array.isArray(args) && args.includes("preflight")) {
        const err = new Error("exit 1");
        err.stderr = "error: unknown command 'database'";
        throw err;
      }
      return "";
    });
    const harness = createHarness({
      pin: "1.0.0",
      channel: "beta",
      installedVersion: "1.2.0",
      execFileSyncImpl,
    });
    // A real state DB so enumerateStateDbs has something to snapshot.
    const stateDir = path.join(harness.openclawDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const db = new DatabaseSync(path.join(stateDir, "openclaw.sqlite"));
    db.exec("CREATE TABLE t(x INTEGER)");
    db.close();
    harness.store.updateState((s) => {
      s.pinVersion = "1.0.0";
      s.applied = { channel: "beta", version: "1.2.0", at: 1, acceptedAt: null };
      return s;
    });
    expect(saveOverlayFixture(harness.store, "1.1.0")).toEqual({ ok: true });
    harness.store.writeMarker({
      target: { kind: "package", channel: "beta", version: "1.1.0" },
      blockedId: "1.2.0",
      reason: "crash_loop",
    });

    const result = harness.sync.syncAtBoot();

    expect(result.ok).toBe(true);
    expect(result.action).toBe("rollback");
    // Warned, not blocked: the rollback still activated.
    expect(installedPackageJsonVersion(harness.installDir)).toBe("1.1.0");
    const lastBoot = harness.store.readState().lastBoot;
    expect(
      lastBoot.warnings.some((warning) =>
        /cannot verify state written by the newer version/.test(warning),
      ),
    ).toBe(true);
    expect(
      lastBoot.warnings.some((warning) =>
        /backup taken before the update/.test(warning),
      ),
    ).toBe(true);
  });

  it("consumes rollback markers: container pin reset and VPS package rollback", async () => {
    // (a) Container variant: marker targets the pin and the image reset has
    // already restored the pin tree.
    const container = createHarness({
      pin: "1.0.0",
      channel: "beta",
      installedVersion: "1.0.0",
    });
    container.store.updateState((s) => {
      s.pinVersion = "1.0.0";
      s.applied = { channel: "beta", version: "1.2.0", at: 1, acceptedAt: null };
      return s;
    });
    container.store.writeMarker({
      target: { kind: "pin" },
      blockedId: "1.2.0",
      reason: "crash_loop",
    });

    const containerResult = container.sync.syncAtBoot();

    expect(containerResult.ok).toBe(true);
    expect(containerResult.action).toBe("rollback");
    expect(container.store.readState().applied).toBeNull();
    expect(container.store.readSentinel({ installDir: container.installDir })).toEqual(
      expect.objectContaining({ version: "1.0.0" }),
    );
    expect(container.store.readMarker()).toBeNull();
    assertOffline(container);

    // (b) VPS variant: the broken 1.2.0 tree is still installed; the marker
    // targets the last-known-good package overlay.
    const vps = createHarness({
      pin: "1.0.0",
      channel: "beta",
      installedVersion: "1.2.0",
    });
    vps.store.updateState((s) => {
      s.pinVersion = "1.0.0";
      s.applied = { channel: "beta", version: "1.2.0", at: 1, acceptedAt: null };
      return s;
    });
    expect(saveOverlayFixture(vps.store, "1.1.0")).toEqual({ ok: true });
    vps.store.writeMarker({
      target: { kind: "package", channel: "beta", version: "1.1.0" },
      blockedId: "1.2.0",
      reason: "crash_loop",
    });

    const vpsResult = vps.sync.syncAtBoot();
    await vps.sync.flushBootNotifications();

    expect(vpsResult.ok).toBe(true);
    expect(vpsResult.action).toBe("rollback");
    expect(installedPackageJsonVersion(vps.installDir)).toBe("1.1.0");
    expect(vps.store.readSentinel({ installDir: vps.installDir })).toEqual(
      expect.objectContaining({ version: "1.1.0" }),
    );
    expect(vps.store.readMarker()).toBeNull();
    expect(vps.store.readState().applied).toEqual(
      expect.objectContaining({ channel: "beta", version: "1.1.0" }),
    );
    expect(
      notifyMessages(vps.notify).some(
        (message) => /rolled back/i.test(message) && message.includes("1.1.0"),
      ),
    ).toBe(true);
    assertOffline(vps);
  });

  it("fails open and never blocks the server require, like bin/alphaclaw.js", () => {
    // Corrupt state file AND a store whose first read throws (EIO-style).
    let threw = false;
    const failing = createHarness({
      pin: "1.0.0",
      installedVersion: "1.0.0",
      sentinelVersion: "1.0.0",
      storeWrap: (store) => ({
        ...store,
        readState: () => {
          if (!threw) {
            threw = true;
            throw new Error("EIO: disk read failed");
          }
          return store.readState();
        },
      }),
    });
    fs.mkdirSync(path.dirname(failing.store.statePath), { recursive: true });
    fs.writeFileSync(failing.store.statePath, "{definitely not json", "utf8");

    let result = null;
    expect(() => {
      result = failing.sync.syncAtBoot();
    }).not.toThrow();
    expect(result).toEqual(
      expect.objectContaining({ ok: false, action: "failed" }),
    );
    assertOffline(failing);

    // The bin harness contract (bin/alphaclaw.js section 7b + final require):
    // whatever boot sync does, the server module load must still run.
    const serverRequire = vi.fn();
    const bootLikeBin = (syncFn) => {
      try {
        syncFn();
      } catch {
        // fail-open: swallowed exactly like bin/alphaclaw.js does
      } finally {
        serverRequire();
      }
    };

    // A store that throws deep inside EVERY method.
    const poisoned = createHarness({
      pin: "1.0.0",
      installedVersion: "1.0.0",
      storeWrap: (store) =>
        Object.fromEntries(
          Object.entries(store).map(([key, value]) => [
            key,
            typeof value === "function"
              ? () => {
                  throw new Error("ENOSPC: store exploded");
                }
              : value,
          ]),
        ),
    });
    expect(() => bootLikeBin(() => poisoned.sync.syncAtBoot())).not.toThrow();
    expect(serverRequire).toHaveBeenCalledTimes(1);

    // Worst case: syncAtBoot itself throws — serverRequire still runs.
    expect(() =>
      bootLikeBin(() => {
        throw new Error("hard synchronous boot failure");
      }),
    ).not.toThrow();
    expect(serverRequire).toHaveBeenCalledTimes(2);
  });

  it("restores the dev shim while the checkout is intact, then falls back to the pin", () => {
    const harness = createHarness({
      pin: "1.0.0",
      channel: "dev",
      installedVersion: "1.0.0",
    });
    const { sync, store, rootDir, installDir } = harness;
    store.updateState((s) => {
      s.pinVersion = "1.0.0";
      s.applied = { channel: "dev", sha: kDevSha, at: 1, acceptedAt: null };
      return s;
    });
    const checkoutDir = writeCheckoutFixture(rootDir, { sha: kDevSha });

    const first = sync.syncAtBoot();

    expect(first.ok).toBe(true);
    expect(first.action).toBe("dev_shim");
    expect(fs.existsSync(store.shimPath)).toBe(true);
    expect(fs.statSync(store.shimPath).mode & 0o111).not.toBe(0); // executable
    expect(store.readBinShimTarget()).toBe(
      path.join(checkoutDir, "bin", "entry.js"),
    );

    // The checkout disappears (volume wipe / manual delete): the shim must
    // never dangle and the pin takes over.
    fs.rmSync(checkoutDir, { recursive: true, force: true });
    const second = sync.syncAtBoot();

    expect(second.ok).toBe(true);
    expect(second.action).toBe("dev_unavailable");
    expect(fs.existsSync(store.shimPath)).toBe(false);
    expect(store.readBinShimTarget()).toBeNull();
    expect(store.readSentinel({ installDir })).toEqual(
      expect.objectContaining({ version: "1.0.0" }),
    );
    const lastBoot = store.readState().lastBoot;
    expect(
      lastBoot.warnings.some((warning) =>
        warning.includes("dev checkout unavailable"),
      ),
    ).toBe(true);
    assertOffline(harness);
  });

  describe("boot config migration (doctor --fix)", () => {
    const writeConfig = (openclawDir, obj) => {
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(
        path.join(openclawDir, "openclaw.json"),
        JSON.stringify(obj, null, 2),
      );
    };

    it("runs doctor --fix once per version and records success", () => {
      const doctorCalls = [];
      const execFileSyncImpl = vi.fn((cmd, args) => {
        doctorCalls.push(args);
        return "";
      });
      const harness = createHarness({
        installedVersion: "2026.8.1",
        sentinelVersion: "2026.8.1",
        execFileSyncImpl,
      });
      writeConfig(harness.openclawDir, { audit: { enabled: true } });

      harness.sync.syncAtBoot();

      // doctor --fix --yes was invoked exactly once against the activated bin.
      expect(doctorCalls).toHaveLength(1);
      expect(doctorCalls[0]).toEqual(
        expect.arrayContaining(["doctor", "--fix", "--yes"]),
      );
      expect(doctorCalls[0]).not.toContain("--json");
      const migration = harness.store.readState().configMigration;
      expect(migration.completedForVersion).toBe("2026.8.1");
      expect(migration.lastAttempt.ok).toBe(true);
      // A pre-fix backup of the from-version config was kept.
      const backups = fs
        .readdirSync(harness.openclawDir)
        .filter((n) => n.startsWith("openclaw.json.pre-fix-"));
      expect(backups.length).toBeGreaterThanOrEqual(1);

      // A second boot on the same version does NOT re-run doctor.
      execFileSyncImpl.mockClear();
      harness.sync.syncAtBoot();
      expect(execFileSyncImpl).not.toHaveBeenCalled();
    });

    it("keeps the trigger armed to retry after a failed migration", () => {
      const execFileSyncImpl = vi.fn(() => {
        throw new Error("doctor exit 1");
      });
      const harness = createHarness({
        installedVersion: "2026.8.1",
        sentinelVersion: "2026.8.1",
        execFileSyncImpl,
      });
      writeConfig(harness.openclawDir, { bridge: { legacy: true } });

      harness.sync.syncAtBoot();
      const migration = harness.store.readState().configMigration;
      expect(migration.completedForVersion).toBe(null);
      expect(migration.lastAttempt.ok).toBe(false);

      // Next boot retries (trigger still armed).
      harness.sync.syncAtBoot();
      expect(execFileSyncImpl).toHaveBeenCalledTimes(2);
    });

    it("writes a BETA environment stripe on beta and removes it on stable", () => {
      const harness = createHarness({
        channel: "beta",
        installedVersion: "2026.8.1",
        sentinelVersion: "2026.8.1",
        execFileSyncImpl: vi.fn(() => ""),
      });
      writeConfig(harness.openclawDir, { gateway: {} });

      harness.sync.syncAtBoot();
      let cfg = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(cfg.gateway.controlUi.environment).toEqual({
        label: "BETA",
        color: "amber",
        _alphaclawManaged: true,
      });

      // Switching to stable removes the managed stripe.
      const stableHarness = createHarness({
        channel: "stable",
        installedVersion: "2026.8.1",
        sentinelVersion: "2026.8.1",
        execFileSyncImpl: vi.fn(() => ""),
      });
      writeConfig(stableHarness.openclawDir, {
        gateway: {
          controlUi: {
            environment: { label: "BETA", color: "amber", _alphaclawManaged: true },
          },
        },
      });
      stableHarness.sync.syncAtBoot();
      cfg = JSON.parse(
        fs.readFileSync(
          path.join(stableHarness.openclawDir, "openclaw.json"),
          "utf8",
        ),
      );
      expect(cfg.gateway?.controlUi?.environment).toBeUndefined();
    });

    it("leaves a hand-set (unmanaged) environment stripe untouched", () => {
      const harness = createHarness({
        channel: "stable",
        installedVersion: "2026.8.1",
        sentinelVersion: "2026.8.1",
        execFileSyncImpl: vi.fn(() => ""),
      });
      writeConfig(harness.openclawDir, {
        gateway: { controlUi: { environment: { label: "PROD", color: "red" } } },
      });
      harness.sync.syncAtBoot();
      const cfg = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(cfg.gateway.controlUi.environment).toEqual({
        label: "PROD",
        color: "red",
      });
    });

    it("restores a pre-fix backup on downgrade instead of running doctor", () => {
      const execFileSyncImpl = vi.fn(() => "");
      const harness = createHarness({
        installedVersion: "2026.7.1-2",
        sentinelVersion: "2026.7.1-2",
        execFileSyncImpl,
      });
      // A backup saved before we migrated away from 2026.7.1-2.
      fs.mkdirSync(harness.openclawDir, { recursive: true });
      fs.writeFileSync(
        path.join(harness.openclawDir, "openclaw.json.pre-fix-2026.7.1-2.bak"),
        JSON.stringify({ restored: true }, null, 2),
      );
      writeConfig(harness.openclawDir, { migrated: "beta-shape" });

      harness.sync.syncAtBoot();

      // The backup was restored (migrated shape gone, restored key present);
      // doctor was NOT run. (reconcileOpenclawJsonMirror later adds update.* keys.)
      expect(execFileSyncImpl).not.toHaveBeenCalled();
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(onDisk.restored).toBe(true);
      expect("migrated" in onDisk).toBe(false);
      expect(harness.store.readState().configMigration.completedForVersion).toBe(
        "2026.7.1-2",
      );
    });
  });
});
