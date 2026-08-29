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
  // reconcileBootConfig (the server-phase migration) legitimately spawns; the
  // default poison below still guards syncAtBoot itself, which must stay
  // offline and spawn-free.
  runnerImpl = null,
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
    runStreamed: vi.fn(
      runnerImpl ||
        (() => {
          throw new Error("runStreamed must never be called during boot sync");
        }),
    ),
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

    // Issue #20: the migration moved out of syncAtBoot (which stamped runs
    // activated before migrating, under a hardcoded 120s execFileSync) into
    // the async server-phase reconciler — sized budgets, doctor-guard, and a
    // fail-CLOSED gateway hold.
    const doctorRunner = ({ doctorOk = true, doctorCalls = [] } = {}) =>
      async (opts) => {
        const args = Array.isArray(opts.args) ? opts.args : [];
        if (args.includes("doctor")) {
          doctorCalls.push(args);
          return {
            ok: doctorOk,
            code: doctorOk ? 0 : 1,
            tail: doctorOk ? "Doctor complete\n" : "doctor exit 1\n",
            timedOut: false,
          };
        }
        // `config validate` / `database preflight` are capability-probed:
        // the pinned stable answers "unknown command" for both, which routes
        // the reconciler through the conservative doctor path.
        return {
          ok: false,
          code: 1,
          tail: "error: unknown command\n",
          timedOut: false,
        };
      };

    it("reconciles config once per version with a guarded doctor run", async () => {
      const doctorCalls = [];
      const harness = createHarness({
        installedVersion: "2026.8.1",
        sentinelVersion: "2026.8.1",
        runnerImpl: doctorRunner({ doctorCalls }),
      });
      writeConfig(harness.openclawDir, { audit: { enabled: true } });

      harness.sync.syncAtBoot();
      // syncAtBoot itself never spawns — the migration is the server phase's.
      expect(doctorCalls).toHaveLength(0);

      const outcome = await harness.sync.reconcileBootConfig();
      expect(outcome.status).toBe("ok");
      expect(doctorCalls).toHaveLength(1);
      expect(doctorCalls[0]).toEqual(
        expect.arrayContaining(["doctor", "--fix", "--yes"]),
      );
      expect(doctorCalls[0]).not.toContain("--json");
      const migration = harness.store.readState().configMigration;
      expect(migration.completedForVersion).toBe("2026.8.1");
      expect(migration.lastAttempt.ok).toBe(true);
      expect(harness.store.readState().gatewayHold).toBe(null);
      // A pre-fix backup of the from-version config was kept.
      const backups = fs
        .readdirSync(harness.openclawDir)
        .filter((n) => n.startsWith("openclaw.json.pre-fix-"));
      expect(backups.length).toBeGreaterThanOrEqual(1);

      // A second reconcile on the same version does NOT re-run doctor.
      const second = await harness.sync.reconcileBootConfig();
      expect(second.status).toBe("ok");
      expect(doctorCalls).toHaveLength(1);
    });

    it("holds the gateway after a failed migration and re-runs only on change or operator force", async () => {
      const doctorCalls = [];
      const harness = createHarness({
        installedVersion: "2026.8.1",
        sentinelVersion: "2026.8.1",
        runnerImpl: doctorRunner({ doctorOk: false, doctorCalls }),
      });
      writeConfig(harness.openclawDir, { bridge: { legacy: true } });

      harness.sync.syncAtBoot();
      const first = await harness.sync.reconcileBootConfig();
      expect(first.status).toBe("held");
      const migration = harness.store.readState().configMigration;
      expect(migration.completedForVersion).toBe(null);
      expect(migration.lastAttempt.ok).toBe(false);
      // Fail CLOSED: the hold is first-class state (issue #20 — the old
      // fail-open path let the gateway crash-loop on the rejected config).
      expect(harness.store.readState().gatewayHold).toEqual(
        expect.objectContaining({ reason: expect.stringContaining("2026.8.1") }),
      );
      expect(doctorCalls).toHaveLength(1);

      // Unchanged config + version + policy: the next boot keeps the hold
      // WITHOUT re-running a potentially 30-minute doctor (re-attempt gate).
      const second = await harness.sync.reconcileBootConfig();
      expect(second.status).toBe("held");
      expect(second.reused).toBe(true);
      expect(doctorCalls).toHaveLength(1);

      // Operator retry forces a fresh attempt.
      const forced = await harness.sync.reconcileBootConfig({ force: true });
      expect(forced.status).toBe("held");
      expect(doctorCalls).toHaveLength(2);

      // The recurring hold notification keeps its stable outbox dedupe id.
      await flushAsync();
      expect(
        notifyIds(harness.notify).filter((id) =>
          id.startsWith("config-migration-held-"),
        ).length,
      ).toBeGreaterThanOrEqual(2);
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
      const doctorCalls = [];
      const harness = createHarness({
        installedVersion: "2026.7.1-2",
        sentinelVersion: "2026.7.1-2",
        runnerImpl: doctorRunner({ doctorCalls }),
      });
      // A backup saved before we migrated away from 2026.7.1-2.
      fs.mkdirSync(harness.openclawDir, { recursive: true });
      fs.writeFileSync(
        path.join(harness.openclawDir, "openclaw.json.pre-fix-2026.7.1-2.bak"),
        JSON.stringify({ restored: true }, null, 2),
      );
      writeConfig(harness.openclawDir, { migrated: "beta-shape" });

      harness.sync.syncAtBoot();
      const outcome = await harness.sync.reconcileBootConfig();

      // The backup was restored (migrated shape gone, restored key present);
      // doctor was NOT run. (reconcileOpenclawJsonMirror later adds update.* keys.)
      expect(outcome.status).toBe("ok");
      expect(doctorCalls).toHaveLength(0);
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

    // Issue #20 end-to-end shapes: a validate-capable target build. The
    // runner answers `config validate` from the CURRENT on-disk config so
    // strips/doctor visibly change the verdict.
    const validateAwareRunner = ({
      openclawDirRef,
      doctorCalls = [],
      doctorImpl = null,
      dbPreflight = "unsupported",
    }) =>
      async (opts) => {
        const args = Array.isArray(opts.args) ? opts.args : [];
        if (args.includes("validate")) {
          let config = {};
          try {
            config = JSON.parse(
              fs.readFileSync(
                path.join(openclawDirRef(), "openclaw.json"),
                "utf8",
              ),
            );
          } catch {}
          const blamedLines = [];
          if (config.meta?.lastTouchedAt !== undefined) {
            blamedLines.push('meta: Unrecognized key: "lastTouchedAt"');
          }
          if (config.mystery !== undefined) {
            blamedLines.push('Unrecognized key: "mystery"');
          }
          if (blamedLines.length) {
            return {
              ok: false,
              code: 78,
              tail: `${blamedLines.join("\n")}\n`,
              timedOut: false,
            };
          }
          return { ok: true, code: 0, tail: "config ok\n", timedOut: false };
        }
        if (args.includes("preflight")) {
          if (dbPreflight === "unsupported") {
            return {
              ok: false,
              code: 1,
              tail: "error: unknown command 'database'\n",
              timedOut: false,
            };
          }
          return {
            ok: true,
            code: 0,
            tail: `${JSON.stringify(dbPreflight)}\n`,
            timedOut: false,
          };
        }
        if (args.includes("doctor")) {
          doctorCalls.push(args);
          if (doctorImpl) return doctorImpl(opts);
          return { ok: true, code: 0, tail: "Doctor complete\n", timedOut: false };
        }
        return { ok: true, code: 0, tail: "", timedOut: false };
      };

    it("strips curated retired keys (#20's exact set) while preserving MCP servers and env-ref secrets", async () => {
      const doctorCalls = [];
      let harness;
      harness = createHarness({
        installedVersion: "2026.9.1-beta.1",
        sentinelVersion: "2026.9.1-beta.1",
        runnerImpl: validateAwareRunner({
          openclawDirRef: () => harness.openclawDir,
          doctorCalls,
        }),
      });
      writeConfig(harness.openclawDir, {
        meta: { lastTouchedAt: "2026-07-01T00:00:00Z" },
        cron: { maxConcurrentRuns: 3 },
        mcp: {
          servers: {
            nessie: {
              url: "https://example.com/mcp",
              headers: { Authorization: "${NESSIE_TOKEN}" },
            },
          },
        },
      });

      harness.sync.syncAtBoot();
      const outcome = await harness.sync.reconcileBootConfig();

      expect(outcome.status).toBe("ok");
      expect(outcome.removedKeys).toContain("meta.lastTouchedAt");
      expect(outcome.removedKeys).toContain("cron.maxConcurrentRuns");
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(onDisk.meta).toBeUndefined();
      // The incident's data loss must be impossible here: MCP servers and
      // env-ref secrets survive untouched.
      expect(onDisk.mcp.servers.nessie.headers.Authorization).toBe(
        "${NESSIE_TOKEN}",
      );
      // Config validated clean after the curated strip: no doctor needed
      // (db preflight is unsupported on this fake and the hint is absent —
      // but a clean validate + strip means dbMigrationNeeded drove doctor).
      expect(harness.store.readState().gatewayHold).toBe(null);
    });

    it("migrates agents.list → agents.entries on disk", async () => {
      let harness;
      harness = createHarness({
        installedVersion: "2026.9.1-beta.1",
        sentinelVersion: "2026.9.1-beta.1",
        runnerImpl: validateAwareRunner({
          openclawDirRef: () => harness.openclawDir,
          dbPreflight: { ok: true, compatible: true },
        }),
      });
      writeConfig(harness.openclawDir, {
        agents: { list: [{ id: "main", name: "Main" }] },
      });

      harness.sync.syncAtBoot();
      const outcome = await harness.sync.reconcileBootConfig();

      expect(outcome.status).toBe("ok");
      expect(outcome.renamedKeys).toContain("agents.list → agents.entries");
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(onDisk.agents.list).toBeUndefined();
      expect(onDisk.agents.entries.main).toEqual(
        expect.objectContaining({ name: "Main" }),
      );
    });

    it("never auto-strips UNKNOWN blamed keys — holds, then removes them only with operator consent", async () => {
      const doctorCalls = [];
      let harness;
      harness = createHarness({
        installedVersion: "2026.9.1-beta.1",
        sentinelVersion: "2026.9.1-beta.1",
        runnerImpl: validateAwareRunner({
          openclawDirRef: () => harness.openclawDir,
          doctorCalls,
          // Doctor does NOT fix the unknown key (models the #20 shape).
          doctorImpl: async () => ({
            ok: true,
            code: 0,
            tail: "Doctor complete\n",
            timedOut: false,
          }),
          dbPreflight: { ok: true, compatible: true },
        }),
      });
      writeConfig(harness.openclawDir, {
        mystery: { operatorData: true },
        keep: { me: true },
      });

      harness.sync.syncAtBoot();
      const outcome = await harness.sync.reconcileBootConfig();

      // Unknown ≠ obsolete: the key survives, the gateway holds, the hold
      // names the exact key for the operator.
      expect(outcome.status).toBe("held");
      expect(outcome.blamedKeys).toContain("mystery");
      const held = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(held.mystery).toEqual({ operatorData: true });
      expect(harness.store.readState().gatewayHold.blamedKeys).toContain(
        "mystery",
      );

      // Operator consent removes exactly the blamed keys and clears the hold.
      const retried = await harness.sync.reconcileBootConfig({
        force: true,
        stripBlamedKeys: true,
      });
      expect(retried.status).toBe("ok");
      const after = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(after.mystery).toBeUndefined();
      expect(after.keep).toEqual({ me: true });
      expect(harness.store.readState().gatewayHold).toBe(null);
    });

    it("holds WITHOUT attempting doctor when the pre-migration snapshot cannot be written", async () => {
      const doctorCalls = [];
      let harness;
      harness = createHarness({
        installedVersion: "2026.9.1-beta.1",
        sentinelVersion: "2026.9.1-beta.1",
        runnerImpl: validateAwareRunner({
          openclawDirRef: () => harness.openclawDir,
          doctorCalls,
        }),
      });
      writeConfig(harness.openclawDir, { meta: { lastTouchedAt: "x" } });
      harness.sync.syncAtBoot();
      // Snapshot target becomes unwritable: a directory squats on the name.
      fs.mkdirSync(
        path.join(harness.openclawDir, "openclaw.json.pre-fix-1.0.0.bak"),
        { recursive: true },
      );

      const outcome = await harness.sync.reconcileBootConfig();

      // No revert path = no doctor, no strips — fail closed with the hold.
      expect(outcome.status).toBe("held");
      expect(doctorCalls).toHaveLength(0);
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(onDisk.meta.lastTouchedAt).toBe("x");
    });

    it("blocks and reverts a doctor stale-restore, holding the gateway (quarantine + tripwires)", async () => {
      const doctorCalls = [];
      let harness;
      const liveConfig = {
        mystery: { keepsConfigInvalid: true },
        mcp: { servers: { nessie: { url: "https://example.com/mcp" } } },
        meta2: { marker: "live" },
      };
      harness = createHarness({
        installedVersion: "2026.9.1-beta.1",
        sentinelVersion: "2026.9.1-beta.1",
        runnerImpl: validateAwareRunner({
          openclawDirRef: () => harness.openclawDir,
          doctorCalls,
          // Doctor "repairs" by swapping in a stale config that drops the
          // MCP server — the #20 bug-3 shape.
          doctorImpl: async () => {
            fs.writeFileSync(
              path.join(harness.openclawDir, "openclaw.json"),
              JSON.stringify({ mystery: {}, mcp: { servers: {} } }, null, 2),
            );
            return {
              ok: true,
              code: 0,
              tail: "Config auto-restored from last-known-good: openclaw.json (doctor-invalid-config)\n",
              timedOut: false,
            };
          },
          dbPreflight: { ok: true, compatible: true },
        }),
      });
      writeConfig(harness.openclawDir, liveConfig);

      harness.sync.syncAtBoot();
      const outcome = await harness.sync.reconcileBootConfig();
      await flushAsync();

      expect(outcome.status).toBe("held");
      // The stale swap was reverted: the live config is intact.
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(onDisk.mcp.servers.nessie.url).toBe("https://example.com/mcp");
      expect(onDisk.meta2.marker).toBe("live");
      expect(
        notifyIds(harness.notify).some((id) =>
          id.startsWith("doctor-restore-blocked-"),
        ),
      ).toBe(true);
    });

    it("skips doctor entirely when the config validates and the DBs need no migration", async () => {
      const doctorCalls = [];
      let harness;
      harness = createHarness({
        installedVersion: "2026.9.1-beta.1",
        sentinelVersion: "2026.9.1-beta.1",
        runnerImpl: validateAwareRunner({
          openclawDirRef: () => harness.openclawDir,
          doctorCalls,
          dbPreflight: { ok: true, compatible: true },
        }),
      });
      writeConfig(harness.openclawDir, { clean: true });
      // A state DB exists, so the db probe actually runs (and reports clean).
      fs.mkdirSync(path.join(harness.openclawDir, "state"), { recursive: true });
      fs.writeFileSync(
        path.join(harness.openclawDir, "state", "openclaw.sqlite"),
        "not-really-sqlite-but-present",
      );

      harness.sync.syncAtBoot();
      const outcome = await harness.sync.reconcileBootConfig();

      expect(outcome.status).toBe("ok");
      expect(doctorCalls).toHaveLength(0);
      expect(harness.store.readState().configMigration.completedForVersion).toBe(
        "2026.9.1-beta.1",
      );
    });
  });
});
