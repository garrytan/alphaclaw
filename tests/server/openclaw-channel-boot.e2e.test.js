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
  fsModule = undefined,
  extraSyncOptions = undefined,
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
    ...(fsModule ? { fsModule } : {}),
    ...(extraSyncOptions || {}),
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

// Recurring boot notifications must carry STABLE outbox ids (merge
// resolution): the notify outbox dedupes repeats by id across boots.
const notifyIds = (notify) =>
  notify.mock.calls.map((call) => call?.[1]?.id).filter(Boolean);

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

  it("boot rollback warns (never blocks) when the target cannot verify current state (C1)", async () => {
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
    // The warning notification carries its stable outbox id.
    await flushAsync();
    expect(notifyIds(harness.notify)).toContain(
      "boot-rollback-preflight-1.1.0",
    );
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

    it("keeps the trigger armed to retry after a failed migration", async () => {
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

      // Both boots emit the SAME stable outbox id — the dedupe key across
      // repeats of the recurring failure notification.
      await flushAsync();
      expect(
        notifyIds(harness.notify).filter((id) =>
          id.startsWith("config-migration-failed-"),
        ),
      ).toEqual([
        "config-migration-failed-2026.8.1",
        "config-migration-failed-2026.8.1",
      ]);
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
      // Strict-schema shape: exactly {label, color} (an extra marker key would
      // exit-78 the beta gateway); label carries the version (D17), managed-
      // ness is tracked in AlphaClaw state instead.
      expect(cfg.gateway.controlUi.environment).toEqual({
        label: "BETA · 2026.8.1",
        color: "amber",
      });
      expect(cfg.gateway.controlUi.environment.label.length).toBeLessThanOrEqual(24);
      expect(harness.store.readState().managedStripe).toEqual({
        label: "BETA · 2026.8.1",
        color: "amber",
      });

      // Switching to stable removes the managed stripe (recognized via the
      // recorded managedStripe, or the legacy marker for older installs).
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

    it("never writes a stripe while the stable pin runs on a beta channel selection", () => {
      // The user-facing failure mode: the channel selection says beta but a
      // fallback (overlay missing, activation failed, fresh install) left the
      // 2026.7.x pin running. That build hard-rejects
      // gateway.controlUi.environment with EX_CONFIG — the stripe must not be
      // written, or every boot crash-loops.
      const harness = createHarness({
        pin: "2026.7.1-2",
        channel: "beta",
        installedVersion: "2026.7.1-2",
        sentinelVersion: "2026.7.1-2",
        execFileSyncImpl: vi.fn(() => ""),
      });
      writeConfig(harness.openclawDir, { gateway: {} });

      harness.sync.syncAtBoot();
      const cfg = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(cfg.gateway?.controlUi?.environment).toBeUndefined();
      expect(harness.store.readState().managedStripe ?? null).toBe(null);
    });

    it("self-heals a poisoned config: removes the managed stripe when the pin runs", () => {
      // A stripe written before the capability gate existed (or before a
      // rollback to the pin) must be removed on the next boot, unblocking the
      // exit-78 crash-loop without any manual openclaw.json surgery.
      const harness = createHarness({
        pin: "2026.7.1-2",
        channel: "beta",
        installedVersion: "2026.7.1-2",
        sentinelVersion: "2026.7.1-2",
        execFileSyncImpl: vi.fn(() => ""),
      });
      const stripe = { label: "BETA · 2026.8.1", color: "amber" };
      harness.store.updateState((s) => {
        s.managedStripe = { ...stripe };
        return s;
      });
      writeConfig(harness.openclawDir, {
        gateway: { controlUi: { environment: { ...stripe } } },
      });

      harness.sync.syncAtBoot();
      const cfg = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(cfg.gateway?.controlUi?.environment).toBeUndefined();
      expect(harness.store.readState().managedStripe ?? null).toBe(null);
    });

    it("keeps the BETA stripe on a beta prerelease build (core-version capability)", () => {
      // compareVersionParts ranks 2026.8.1-beta.N below 2026.8.1 — the gate
      // must compare core parts only, or genuine beta builds lose the stripe.
      const harness = createHarness({
        pin: "2026.8.1-beta.2",
        channel: "beta",
        installedVersion: "2026.8.1-beta.2",
        sentinelVersion: "2026.8.1-beta.2",
        execFileSyncImpl: vi.fn(() => ""),
      });
      writeConfig(harness.openclawDir, { gateway: {} });

      harness.sync.syncAtBoot();
      const cfg = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(cfg.gateway.controlUi.environment).toEqual({
        label: "BETA · 2026.8.1-beta.2",
        color: "amber",
      });
    });

    it("removes the managed DEV stripe when the dev checkout is unavailable", () => {
      // dev_unavailable falls back to the pin — the DEV stripe would exit-78
      // the pin exactly like the beta case.
      const harness = createHarness({
        pin: "1.0.0",
        channel: "dev",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        execFileSyncImpl: vi.fn(() => ""),
      });
      const stripe = { label: `DEV · ${kDevSha.slice(0, 7)}`, color: "purple" };
      harness.store.updateState((s) => {
        s.applied = { channel: "dev", sha: kDevSha, at: 1 };
        s.managedStripe = { ...stripe };
        return s;
      });
      writeConfig(harness.openclawDir, {
        gateway: { controlUi: { environment: { ...stripe } } },
      });

      harness.sync.syncAtBoot();
      const cfg = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(cfg.gateway?.controlUi?.environment).toBeUndefined();
    });

    it("removes an orphaned managed-shaped stripe even when the ownership record is lost", () => {
      // Backup restores, corrupted-state resets, and torn writes can all
      // leave a managed stripe in openclaw.json with no managedStripe record;
      // the generated-shape predicate must still recognize and remove it, or
      // a pin boot crash-loops forever with no self-heal.
      const harness = createHarness({
        pin: "2026.7.1-2",
        channel: "beta",
        installedVersion: "2026.7.1-2",
        sentinelVersion: "2026.7.1-2",
        execFileSyncImpl: vi.fn(() => ""),
      });
      writeConfig(harness.openclawDir, {
        gateway: {
          controlUi: {
            environment: { label: "BETA · 2026.8.1-beta.3", color: "amber" },
          },
        },
      });

      harness.sync.syncAtBoot();
      const cfg = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(cfg.gateway?.controlUi?.environment).toBeUndefined();

      // Same heal for the DEV/purple shape (dev selection, checkout gone).
      const devHarness = createHarness({
        pin: "1.0.0",
        channel: "dev",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        execFileSyncImpl: vi.fn(() => ""),
      });
      writeConfig(devHarness.openclawDir, {
        gateway: {
          controlUi: { environment: { label: "DEV · a1b2c3d", color: "purple" } },
        },
      });
      devHarness.sync.syncAtBoot();
      const devCfg = JSON.parse(
        fs.readFileSync(path.join(devHarness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(devCfg.gateway?.controlUi?.environment).toBeUndefined();
    });

    it("writes the DEV stripe only when the dev checkout build knows the key", () => {
      const seedDev = (harness) => {
        harness.store.updateState((s) => {
          s.pinVersion = "1.0.0";
          s.applied = { channel: "dev", sha: kDevSha, at: 1, acceptedAt: null };
          return s;
        });
      };

      const capable = createHarness({
        pin: "1.0.0",
        channel: "dev",
        installedVersion: "1.0.0",
        execFileSyncImpl: vi.fn(() => ""),
      });
      seedDev(capable);
      const capableCheckout = writeCheckoutFixture(capable.rootDir, {
        sha: kDevSha,
      });
      fs.writeFileSync(
        path.join(capableCheckout, "package.json"),
        JSON.stringify({
          name: "openclaw",
          version: "2026.9.0",
          bin: { openclaw: "./bin/entry.js" },
        }),
      );
      writeConfig(capable.openclawDir, { gateway: {} });
      expect(capable.sync.syncAtBoot().action).toBe("dev_shim");
      let cfg = JSON.parse(
        fs.readFileSync(path.join(capable.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(cfg.gateway.controlUi.environment).toEqual({
        label: `DEV · ${kDevSha.slice(0, 7)}`,
        color: "purple",
      });

      // Placeholder-versioned checkout ("0.0.0-dev"): capability unprovable,
      // fail closed — a pre-2026.8.1 dev build would exit 78 on the key.
      const placeholder = createHarness({
        pin: "1.0.0",
        channel: "dev",
        installedVersion: "1.0.0",
        execFileSyncImpl: vi.fn(() => ""),
      });
      seedDev(placeholder);
      writeCheckoutFixture(placeholder.rootDir, { sha: kDevSha });
      writeConfig(placeholder.openclawDir, { gateway: {} });
      expect(placeholder.sync.syncAtBoot().action).toBe("dev_shim");
      cfg = JSON.parse(
        fs.readFileSync(
          path.join(placeholder.openclawDir, "openclaw.json"),
          "utf8",
        ),
      );
      expect(cfg.gateway?.controlUi?.environment).toBeUndefined();
    });

    it("does not record stripe ownership when the config write fails", () => {
      // Ownership is recorded AFTER the locked openclaw.json write commits: a
      // failed write must leave record and file consistent (both without the
      // stripe), or the two desync and later removal logic misfires.
      const failingFs = new Proxy(fs, {
        get(target, prop) {
          if (prop === "writeFileSync") {
            return (file, ...rest) => {
              const name = String(file);
              if (name.includes("openclaw.json") && !name.endsWith(".lock")) {
                throw new Error("ENOSPC: fake disk full");
              }
              return target.writeFileSync(file, ...rest);
            };
          }
          const value = target[prop];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const harness = createHarness({
        pin: "2026.8.1",
        channel: "beta",
        installedVersion: "2026.8.1",
        sentinelVersion: "2026.8.1",
        execFileSyncImpl: vi.fn(() => ""),
        fsModule: failingFs,
      });
      writeConfig(harness.openclawDir, { gateway: {} });

      const result = harness.sync.syncAtBoot();
      expect(result.ok).toBe(true); // fail-open boot
      // The write never committed, so no ownership was recorded and the
      // on-disk config still has no stripe.
      expect(harness.store.readState().managedStripe ?? null).toBe(null);
      const cfg = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(cfg.gateway?.controlUi?.environment).toBeUndefined();
    });

    it("re-checks stripe ownership inside the config lock (pre-lock TOCTOU)", () => {
      // stripeChanged is computed from a pre-lock read; a stripe hand-set by
      // a concurrent writer between that read and the locked mutate must not
      // be overwritten as "managed".
      const handSet = { label: "PROD FLEET", color: "red" };
      const racingFs = new Proxy(fs, {
        get(target, prop) {
          if (prop === "readFileSync") {
            return (file, ...rest) => {
              const raw = target.readFileSync(file, ...rest);
              // Simulate the concurrent hand-edit landing right before the
              // LOCKED read (the second read of openclaw.json this boot).
              if (String(file).endsWith("openclaw.json")) {
                racingFs.readCount = (racingFs.readCount || 0) + 1;
                if (racingFs.readCount === 2) {
                  const parsed = JSON.parse(raw);
                  parsed.gateway = { controlUi: { environment: { ...handSet } } };
                  const text = JSON.stringify(parsed, null, 2);
                  target.writeFileSync(file, text);
                  return text;
                }
              }
              return raw;
            };
          }
          const value = target[prop];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const harness = createHarness({
        pin: "2026.8.1",
        channel: "beta",
        installedVersion: "2026.8.1",
        sentinelVersion: "2026.8.1",
        execFileSyncImpl: vi.fn(() => ""),
        fsModule: racingFs,
      });
      writeConfig(harness.openclawDir, { gateway: {} });

      harness.sync.syncAtBoot();
      const cfg = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(cfg.gateway.controlUi.environment).toEqual(handSet);
      // Ownership was NOT recorded for a stripe we did not write.
      expect(harness.store.readState().managedStripe ?? null).toBe(null);
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

    it("restores a pre-fix backup on downgrade instead of running doctor", async () => {
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
      // The restore notification carries its stable outbox id.
      await flushAsync();
      expect(notifyIds(harness.notify)).toContain(
        "config-restore-2026.7.1-2",
      );
    });
  });

  describe("boot config migration timeout & diagnostics (issue #21 bug 1)", () => {
    const writeConfig = (openclawDir, obj) => {
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(
        path.join(openclawDir, "openclaw.json"),
        JSON.stringify(obj, null, 2),
      );
    };

    it("uses the tunable default, scales with state-DB size, and caps below the boot placeholder budget", () => {
      // Default (no state DBs): the 10-minute tunable default.
      const calls = [];
      const execFileSyncImpl = vi.fn((cmd, args, opts) => {
        if (args.includes("doctor")) calls.push(opts);
        return "";
      });
      const harness = createHarness({
        installedVersion: "2026.8.1",
        sentinelVersion: "2026.8.1",
        execFileSyncImpl,
      });
      writeConfig(harness.openclawDir, { audit: {} });
      harness.sync.syncAtBoot();
      expect(calls).toHaveLength(1);
      expect(calls[0].timeout).toBe(600_000);
      expect(calls[0].killSignal).toBe("SIGKILL");
      expect(calls[0].stdio).toBe("pipe");

      // A ~900MiB state DB scales the timeout up — but the 12-minute cap
      // holds (the boot placeholder flips /health to 503 at 15 minutes).
      const bigCalls = [];
      const bigImpl = vi.fn((cmd, args, opts) => {
        if (args.includes("doctor")) bigCalls.push(opts);
        return "";
      });
      const bigFs = {
        ...fs,
        statSync: (p, ...rest) => {
          const st = fs.statSync(p, ...rest);
          if (String(p).endsWith(path.join("state", "openclaw.sqlite"))) {
            return {
              size: 900 * 1024 * 1024,
              mtimeMs: st.mtimeMs,
              isFile: () => st.isFile(),
              isDirectory: () => st.isDirectory(),
            };
          }
          return st;
        },
      };
      const bigHarness = createHarness({
        installedVersion: "2026.8.1",
        sentinelVersion: "2026.8.1",
        execFileSyncImpl: bigImpl,
        fsModule: bigFs,
      });
      writeConfig(bigHarness.openclawDir, { audit: {} });
      fs.mkdirSync(path.join(bigHarness.openclawDir, "state"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(bigHarness.openclawDir, "state", "openclaw.sqlite"),
        "not-a-real-db",
      );
      bigHarness.sync.syncAtBoot();
      expect(bigCalls).toHaveLength(1);
      // The shared boot-ops clock may already have shaved a few ms off the
      // 12-minute cap (real wall clock) — assert the cap held, not the exact
      // millisecond.
      expect(bigCalls[0].timeout).toBeGreaterThan(11 * 60 * 1000);
      expect(bigCalls[0].timeout).toBeLessThanOrEqual(12 * 60 * 1000);

      // The DI seam (backing the OPENCLAW_DOCTOR_MIGRATION_TIMEOUT env knob,
      // which constants.js resolves at require time) lowers it too.
      const tunedCalls = [];
      const tunedImpl = vi.fn((cmd, args, opts) => {
        if (args.includes("doctor")) tunedCalls.push(opts);
        return "";
      });
      const tunedHarness = createHarness({
        installedVersion: "2026.8.1",
        sentinelVersion: "2026.8.1",
        execFileSyncImpl: tunedImpl,
        extraSyncOptions: { doctorMigrationTimeoutMs: 30_000 },
      });
      writeConfig(tunedHarness.openclawDir, { audit: {} });
      tunedHarness.sync.syncAtBoot();
      expect(tunedCalls[0].timeout).toBe(30_000);
    });

    it("captures the redacted doctor stderr tail into the warning and lastAttempt.error", async () => {
      const execFileSyncImpl = vi.fn(() => {
        const error = new Error("spawnSync /usr/local/bin/node failed");
        error.stderr = "Invalid config: Unrecognized key near supersecretvalue";
        error.stdout = "";
        throw error;
      });
      const harness = createHarness({
        installedVersion: "2026.8.1",
        sentinelVersion: "2026.8.1",
        execFileSyncImpl,
        extraSyncOptions: {
          gatewayEnv: () => ({ MY_API_KEY: "supersecretvalue" }),
        },
      });
      writeConfig(harness.openclawDir, { audit: {} });

      const result = harness.sync.syncAtBoot();
      const migration = harness.store.readState().configMigration;
      expect(migration.lastAttempt.ok).toBe(false);
      expect(migration.lastAttempt.error).toContain("Unrecognized key");
      expect(migration.lastAttempt.error).toContain("***");
      expect(migration.lastAttempt.error).not.toContain("supersecretvalue");
      expect(
        result.warnings.some((w) => w.includes("Unrecognized key")),
      ).toBe(true);
      expect(result.warnings.join("\n")).not.toContain("supersecretvalue");
    });

    it("reports a timeout distinctly when doctor is killed on the deadline", () => {
      const execFileSyncImpl = vi.fn(() => {
        const error = new Error("spawnSync /usr/local/bin/node ETIMEDOUT");
        error.killed = true;
        throw error;
      });
      const harness = createHarness({
        installedVersion: "2026.8.1",
        sentinelVersion: "2026.8.1",
        execFileSyncImpl,
      });
      writeConfig(harness.openclawDir, { audit: {} });
      harness.sync.syncAtBoot();
      const migration = harness.store.readState().configMigration;
      expect(migration.lastAttempt.error).toMatch(/timed out after \d+s/);
    });
  });

  describe("crash-rollback config restore (issue #21 bug 4)", () => {
    const writeConfig = (openclawDir, obj) => {
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(
        path.join(openclawDir, "openclaw.json"),
        JSON.stringify(obj, null, 2),
      );
    };

    const seedRollbackScenario = ({ execFileSyncImpl, fsModule } = {}) => {
      // The #21 shape: config migrated AWAY from the pin by a failed beta
      // (lastAttempt names the beta), then a crash-rollback marker lands on
      // the pin. completedForVersion === pin would previously skip the
      // restore forever.
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "2026.9.1-beta.1",
        sentinelVersion: "2026.9.1-beta.1",
        execFileSyncImpl: execFileSyncImpl || vi.fn(() => ""),
        ...(fsModule ? { fsModule } : {}),
      });
      saveOverlayFixture(harness.store, "1.0.0");
      writeConfig(harness.openclawDir, {
        agents: { entries: { main: {} } },
        meta: { migrations: 12 },
      });
      fs.writeFileSync(
        path.join(harness.openclawDir, "openclaw.json.pre-fix-1.0.0.bak"),
        JSON.stringify({ agents: { list: [] } }, null, 2),
      );
      harness.store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.configMigration = {
          completedForVersion: "1.0.0",
          lastAttempt: {
            version: "2026.9.1-beta.1",
            at: 1,
            ok: false,
            error: "timed out after 120s",
          },
        };
        return s;
      });
      harness.store.writeMarker({
        target: { kind: "pin" },
        blockedId: "2026.9.1-beta.1",
        reason: "config_error",
        exitCode: 78,
        at: 1,
      });
      return harness;
    };

    it("restores the pre-fix config when a rollback marker lands on its version", async () => {
      const harness = seedRollbackScenario();
      const result = harness.sync.syncAtBoot();

      expect(result.action).toBe("rollback");
      expect(installedPackageJsonVersion(harness.installDir)).toBe("1.0.0");
      const cfg = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      // The migrated shape is gone; only the boot's own update-channel mirror
      // stripe may have been added on top of the restored backup.
      expect(cfg.agents).toEqual({ list: [] });
      expect(cfg.meta).toBeUndefined();
      const migration = harness.store.readState().configMigration;
      expect(migration.completedForVersion).toBe("1.0.0");
      expect(migration.lastAttempt.ok).toBe(true);
      await flushAsync();
      expect(notifyIds(harness.notify)).toContain(
        "config-restore-rollback-1.0.0",
      );
      assertOffline(harness);
    });

    it("does not re-restore the pre-fix backup on subsequent steady-state boots", () => {
      const harness = seedRollbackScenario();
      harness.sync.syncAtBoot();

      // The operator edits the config after the rollback restore…
      writeConfig(harness.openclawDir, {
        agents: { list: [] },
        edited: true,
      });
      // …and a plain reboot must NOT clobber it back to the backup.
      harness.sync.syncAtBoot();
      const cfg = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(cfg.edited).toBe(true);
    });

    it("warns and notifies when the pre-fix backup cannot be written", async () => {
      const failingFs = {
        ...fs,
        copyFileSync: (src, dest, ...rest) => {
          if (String(dest).includes("openclaw.json.pre-fix-")) {
            throw new Error("ENOSPC: no space left on device");
          }
          return fs.copyFileSync(src, dest, ...rest);
        },
      };
      const harness = createHarness({
        installedVersion: "2026.8.1",
        sentinelVersion: "2026.8.1",
        execFileSyncImpl: vi.fn(() => ""),
        fsModule: failingFs,
      });
      writeConfig(harness.openclawDir, { audit: {} });

      const result = harness.sync.syncAtBoot();
      expect(
        result.warnings.some((w) =>
          w.includes("could not save pre-fix config backup"),
        ),
      ).toBe(true);
      await flushAsync();
      expect(
        notifyIds(harness.notify).some((id) =>
          id.startsWith("config-backup-write-failed-"),
        ),
      ).toBe(true);
    });

    it("names the pre-fix backup after the previously installed version when no history exists", () => {
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        execFileSyncImpl: vi.fn(() => ""),
      });
      saveOverlayFixture(harness.store, "2.0.0");
      writeConfig(harness.openclawDir, { audit: {} });
      harness.store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = {
          channel: "stable",
          version: "2.0.0",
          at: 1,
          acceptedAt: null,
        };
        return s;
      });

      harness.sync.syncAtBoot();
      expect(installedPackageJsonVersion(harness.installDir)).toBe("2.0.0");
      expect(
        fs.existsSync(
          path.join(harness.openclawDir, "openclaw.json.pre-fix-1.0.0.bak"),
        ),
      ).toBe(true);
      // Never named after the version being migrated TO.
      expect(
        fs.existsSync(
          path.join(harness.openclawDir, "openclaw.json.pre-fix-2.0.0.bak"),
        ),
      ).toBe(false);
    });
  });

  describe("boot config migration gate (issue #21 bug 2)", () => {
    const writeConfig = (openclawDir, obj) => {
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(
        path.join(openclawDir, "openclaw.json"),
        JSON.stringify(obj, null, 2),
      );
    };

    afterEach(() => {
      delete process.env.OPENCLAW_MIGRATION_GATE;
    });

    // The #21 box, in miniature: healthy pin, beta applied, the beta's
    // doctor --fix times out. The gate must stop the beta BEFORE it ever
    // runs (its first boot would one-way migrate the state DB).
    const seedIncident = ({ execFileSyncImpl } = {}) => {
      const impl =
        execFileSyncImpl ||
        vi.fn((cmd, args) => {
          if (args.includes("doctor")) {
            const error = new Error("spawnSync node ETIMEDOUT");
            error.killed = true;
            throw error;
          }
          return "";
        });
      const harness = createHarness({
        pin: "2026.7.1-2",
        installedVersion: "2026.7.1-2",
        sentinelVersion: "2026.7.1-2",
        channel: "beta",
        execFileSyncImpl: impl,
      });
      saveOverlayFixture(harness.store, "2026.9.1-beta.1");
      saveOverlayFixture(harness.store, "2026.7.1-2");
      writeConfig(harness.openclawDir, { audit: { enabled: true } });
      harness.store.updateState((s) => {
        s.pinVersion = "2026.7.1-2";
        s.applied = {
          channel: "beta",
          version: "2026.9.1-beta.1",
          at: 1,
          acceptedAt: null,
        };
        s.configMigration = {
          completedForVersion: "2026.7.1-2",
          lastAttempt: {
            version: "2026.7.1-2",
            at: 1,
            ok: true,
            error: null,
          },
        };
        return s;
      });
      return harness;
    };

    it("[REG #21] incident replay: reverts to the previous version, restores the config, and blocklists the target", async () => {
      const harness = seedIncident();
      const result = harness.sync.syncAtBoot();

      // The box never bricks: the pin is back, with its config restored.
      expect(result.action).toBe("migration_gate_reverted");
      expect(installedPackageJsonVersion(harness.installDir)).toBe(
        "2026.7.1-2",
      );
      const state = harness.store.readState();
      expect(state.applied).toBe(null);
      expect(state.blocklist).toEqual([
        expect.objectContaining({
          id: "2026.9.1-beta.1",
          reason: "config_migration_failed",
        }),
      ]);
      // The migration trigger stays armed for a retry after Clear.
      expect(state.configMigration.completedForVersion).toBe("2026.7.1-2");
      const cfg = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      // Restored pre-migration shape (the boot's own update-channel mirror
      // stripe may sit on top).
      expect(cfg.audit).toEqual({ enabled: true });
      await flushAsync();
      expect(notifyIds(harness.notify)).toContain(
        "config-migration-aborted-2026.9.1-beta.1",
      );
      assertOffline(harness);
    });

    it("OPENCLAW_MIGRATION_GATE=off keeps warn-and-continue on the new build", () => {
      process.env.OPENCLAW_MIGRATION_GATE = "off";
      const harness = seedIncident();
      const result = harness.sync.syncAtBoot();

      expect(result.action).not.toBe("migration_gate_reverted");
      expect(installedPackageJsonVersion(harness.installDir)).toBe(
        "2026.9.1-beta.1",
      );
      expect(harness.store.readState().blocklist).toEqual([]);
      expect(
        result.warnings.some((w) => w.includes("migration gate disabled")),
      ).toBe(true);
    });

    it("keeps the new build when the revert target cannot read the migrated state", () => {
      const { DatabaseSync } = require("node:sqlite");
      const impl = vi.fn((cmd, args) => {
        if (args.includes("doctor")) {
          const error = new Error("spawnSync node ETIMEDOUT");
          error.killed = true;
          throw error;
        }
        if (args.includes("preflight")) {
          const error = new Error("schema version 12; this build supports 1");
          throw error;
        }
        return "";
      });
      const harness = seedIncident({ execFileSyncImpl: impl });
      fs.mkdirSync(path.join(harness.openclawDir, "state"), {
        recursive: true,
      });
      const db = new DatabaseSync(
        path.join(harness.openclawDir, "state", "openclaw.sqlite"),
      );
      db.exec("CREATE TABLE t (x INTEGER)");
      db.close();

      const result = harness.sync.syncAtBoot();
      // A part-migrated DB belongs to the new build — staying forward is the
      // safer run; reverting would recreate the exact brick.
      expect(result.action).not.toBe("migration_gate_reverted");
      expect(installedPackageJsonVersion(harness.installDir)).toBe(
        "2026.9.1-beta.1",
      );
      expect(harness.store.readState().blocklist).toEqual([]);
      expect(
        result.warnings.some((w) =>
          w.includes("no revert target can read the current state"),
        ),
      ).toBe(true);
    });

    it("never gates a plain pin boot (no restore target)", () => {
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        execFileSyncImpl: vi.fn(() => {
          throw new Error("doctor exit 1");
        }),
      });
      writeConfig(harness.openclawDir, { audit: {} });

      const result = harness.sync.syncAtBoot();
      expect(result.action).not.toBe("migration_gate_reverted");
      expect(harness.store.readState().blocklist).toEqual([]);
      expect(installedPackageJsonVersion(harness.installDir)).toBe("1.0.0");
    });

    it("gates a steady-state reboot of an already-active build (already_active)", async () => {
      const impl = vi.fn((cmd, args) => {
        if (args.includes("doctor")) throw new Error("doctor exit 1");
        return "";
      });
      const harness = createHarness({
        pin: "2026.7.1-2",
        installedVersion: "2026.9.1-beta.1",
        sentinelVersion: "2026.9.1-beta.1",
        channel: "beta",
        execFileSyncImpl: impl,
      });
      saveOverlayFixture(harness.store, "2026.7.1-2");
      writeConfig(harness.openclawDir, { audit: {} });
      harness.store.updateState((s) => {
        s.pinVersion = "2026.7.1-2";
        s.applied = {
          channel: "beta",
          version: "2026.9.1-beta.1",
          at: 1,
          acceptedAt: 1,
        };
        s.configMigration = {
          completedForVersion: "2026.7.1-2",
          lastAttempt: {
            version: "2026.7.1-2",
            at: 1,
            ok: true,
            error: null,
          },
        };
        return s;
      });

      const result = harness.sync.syncAtBoot();
      expect(result.action).toBe("migration_gate_reverted");
      expect(installedPackageJsonVersion(harness.installDir)).toBe(
        "2026.7.1-2",
      );
    });
  });

  describe("boot rollback preflight & refusal (issue #21 bug 3)", () => {
    const writeConfig = (openclawDir, obj) => {
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(
        path.join(openclawDir, "openclaw.json"),
        JSON.stringify(obj, null, 2),
      );
    };

    afterEach(() => {
      delete process.env.ALPHACLAW_NOTIFY_WEBHOOK_URL;
    });

    const writeStateDb = (openclawDir) => {
      const { DatabaseSync } = require("node:sqlite");
      fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
      const db = new DatabaseSync(
        path.join(openclawDir, "state", "openclaw.sqlite"),
      );
      db.exec("CREATE TABLE t (x INTEGER)");
      db.close();
    };

    it("reroutes a blocked package target to a passing pin", async () => {
      const impl = vi.fn((cmd, args) => {
        if (args.includes("preflight")) {
          // The bin path (args[0]) carries the overlay version directory.
          if (String(args[0]).includes("2.0.0")) {
            throw new Error("cannot read schema");
          }
          return "";
        }
        return "";
      });
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "3.0.0",
        sentinelVersion: "3.0.0",
        execFileSyncImpl: impl,
      });
      saveOverlayFixture(harness.store, "2.0.0");
      saveOverlayFixture(harness.store, "1.0.0");
      writeConfig(harness.openclawDir, { audit: {} });
      writeStateDb(harness.openclawDir);
      harness.store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.configMigration = {
          completedForVersion: "3.0.0",
          lastAttempt: { version: "3.0.0", at: 1, ok: true, error: null },
        };
        return s;
      });
      harness.store.writeMarker({
        target: { kind: "package", channel: "stable", version: "2.0.0" },
        blockedId: "3.0.0",
        reason: "config_error",
        exitCode: 78,
        at: 1,
      });

      const result = harness.sync.syncAtBoot();
      expect(result.action).toBe("rollback");
      expect(installedPackageJsonVersion(harness.installDir)).toBe("1.0.0");
      expect(
        result.warnings.some((w) =>
          w.includes(
            "rollback target 2.0.0 reports it cannot safely read the current database",
          ),
        ),
      ).toBe(true);
      await flushAsync();
      expect(notifyIds(harness.notify)).toContain(
        "boot-rollback-preflight-2.0.0",
      );
    });

    it("refuses the rollback and keeps the blocked build when every target preflight-blocks", async () => {
      process.env.ALPHACLAW_NOTIFY_WEBHOOK_URL = "http://127.0.0.1:9/hook";
      const webhookFetch = vi.fn(async () => ({ ok: true, status: 200 }));
      global.fetch = webhookFetch;
      const impl = vi.fn((cmd, args) => {
        if (args.includes("preflight")) {
          throw new Error("schema version 12; this build supports 1");
        }
        return "";
      });
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "2.0.0",
        sentinelVersion: "2.0.0",
        execFileSyncImpl: impl,
      });
      saveOverlayFixture(harness.store, "1.0.0");
      writeConfig(harness.openclawDir, { audit: {} });
      writeStateDb(harness.openclawDir);
      harness.store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = {
          channel: "stable",
          version: "2.0.0",
          at: 1,
          acceptedAt: null,
        };
        s.configMigration = {
          completedForVersion: "2.0.0",
          lastAttempt: { version: "2.0.0", at: 1, ok: true, error: null },
        };
        return s;
      });
      harness.store.writeMarker({
        target: { kind: "pin" },
        blockedId: "2.0.0",
        reason: "config_error",
        exitCode: 78,
        at: 1,
      });

      const result = harness.sync.syncAtBoot();
      expect(result.action).toBe("rollback_refused");
      // The blocked-but-compatible build keeps running; the marker is gone.
      expect(installedPackageJsonVersion(harness.installDir)).toBe("2.0.0");
      expect(harness.store.readMarker()).toBe(null);
      const state = harness.store.readState();
      expect(state.rollbackRefused).toEqual(
        expect.objectContaining({
          blockedId: "2.0.0",
          reason: "no_compatible_target",
        }),
      );
      expect(harness.sync.getChannelInfo().rollbackRefused).toBeTruthy();
      await flushAsync();
      expect(notifyIds(harness.notify)).toContain("rollback-refused-2.0.0");

      // The refusal reached the out-of-band webhook (boot-direct path).
      await vi.waitFor(() => {
        expect(webhookFetch).toHaveBeenCalled();
      });
      const [url, opts] = webhookFetch.mock.calls[0];
      expect(String(url)).toBe("http://127.0.0.1:9/hook");
      expect(String(opts.body)).toContain("Rollback refused");

      // A re-request for the same build is refused without marker churn.
      const again = harness.sync.requestChannelRollback({
        reason: "config_error",
        exitCode: 78,
      });
      expect(again.ok).toBe(false);
      expect(again.code).toBe("rollback_refused_previously");
      expect(harness.store.readMarker()).toBe(null);
    });
  });

  describe("forward recovery (issue #21 bug 10)", () => {
    afterEach(() => {
      delete process.env.OPENCLAW_FORWARD_RECOVERY;
    });

    const seedPinWithBlockedNewer = () => {
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        execFileSyncImpl: vi.fn(() => ""),
      });
      saveOverlayFixture(harness.store, "2.0.0");
      harness.store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = null;
        return s;
      });
      harness.store.addBlocklist({
        id: "2.0.0",
        reason: "config_error",
        exitCode: 78,
      });
      return harness;
    };

    it("forward-recovers a pin failure to the blocklisted newer overlay exactly once", async () => {
      const harness = seedPinWithBlockedNewer();

      const first = harness.sync.requestForwardRecovery({ exitCode: 78 });
      expect(first.ok).toBe(true);
      expect(first.target).toEqual({
        kind: "package",
        channel: "stable",
        version: "2.0.0",
      });
      const marker = harness.store.readMarker();
      expect(marker.reason).toBe("forward_recovery");
      expect(marker.target.version).toBe("2.0.0");
      let state = harness.store.readState();
      expect(state.forwardRecovery.attemptedId).toBe("2.0.0");
      expect(state.blocklist).toEqual([]);
      await flushAsync();
      expect(notifyIds(harness.notify)).toContain("forward-recovery-2.0.0");

      // Boot consumes the marker: the forward build activates with a fresh
      // stabilization window (accepted once already).
      const result = harness.sync.syncAtBoot();
      expect(result.action).toBe("rollback");
      expect(installedPackageJsonVersion(harness.installDir)).toBe("2.0.0");
      state = harness.store.readState();
      expect(state.applied.version).toBe("2.0.0");
      expect(state.applied.acceptedAt).toBeTruthy();
      await flushAsync();
      expect(
        notifyMessages(harness.notify).some((m) =>
          m.includes("Moved forward to OpenClaw 2.0.0"),
        ),
      ).toBe(true);

      // Second cycle: the forward build failed too and the box rolled back
      // to the pin again — nothing bootable remains.
      harness.store.addBlocklist({
        id: "2.0.0",
        reason: "config_error",
        exitCode: 78,
      });
      harness.store.updateState((s) => {
        s.applied = null;
        return s;
      });
      const second = harness.sync.requestForwardRecovery({ exitCode: 78 });
      expect(second.ok).toBe(false);
      expect(second.code).toBe("forward_already_attempted");
      state = harness.store.readState();
      expect(state.noBootableVersion).toEqual(
        expect.objectContaining({ attemptedId: "2.0.0" }),
      );
      expect(harness.sync.getChannelInfo().noBootableVersion).toBeTruthy();
      await flushAsync();
      expect(notifyIds(harness.notify)).toContain(
        "no-bootable-version-2.0.0",
      );
    });

    it("OPENCLAW_FORWARD_RECOVERY=off disables forward recovery", () => {
      process.env.OPENCLAW_FORWARD_RECOVERY = "off";
      const harness = seedPinWithBlockedNewer();
      const result = harness.sync.requestForwardRecovery({ exitCode: 78 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("disabled");
      expect(harness.store.readMarker()).toBe(null);
    });

    it("skips blocklist entries whose reason does not imply migrated state", () => {
      const harness = seedPinWithBlockedNewer();
      harness.store.clearBlocklist("2.0.0");
      harness.store.addBlocklist({
        id: "2.0.0",
        reason: "crash_loop",
        exitCode: 1,
      });
      const result = harness.sync.requestForwardRecovery({ exitCode: 78 });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("no_forward_candidate");
    });
  });

  describe("pin last-known-good promotion (issue #21 bug 5)", () => {
    it("promotes the pin to lastKnownGood.package after the health hold and snapshots its overlay", async () => {
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        execFileSyncImpl: vi.fn(() => ""),
        extraSyncOptions: { acceptanceHoldMs: 1000 },
      });
      harness.sync.syncAtBoot();
      expect(harness.store.readState().lastKnownGood.package).toBe(null);

      harness.sync.onGatewayHealthy();
      harness.nowRef.now += 1000;
      harness.sync.onGatewayHealthy();

      await vi.waitFor(() => {
        expect(harness.store.readState().lastKnownGood.package).toBe("1.0.0");
      });
      const state = harness.store.readState();
      // Minimal state change: still a pin boot, nothing accepted.
      expect(state.applied).toBe(null);
      expect(harness.store.hasOverlay("1.0.0")).toBe(true);
    });
  });
});
