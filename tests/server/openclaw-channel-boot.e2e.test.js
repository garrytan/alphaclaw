const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createOpenclawChannelSync,
} = require("../../lib/server/openclaw-channel-sync");
const {
  createOpenclawReleaseChannelStore,
} = require("../../lib/server/openclaw-release-channel");
const { createRunLedger } = require("../../lib/server/openclaw-run-ledger");

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

    it("restores a pre-fix backup on a genuine downgrade, once, consuming the snapshot", async () => {
      const doctorCalls = [];
      const harness = createHarness({
        installedVersion: "2026.7.1-2",
        sentinelVersion: "2026.7.1-2",
        runnerImpl: doctorRunner({ doctorCalls }),
      });
      // Genuine regression: a migration COMPLETED for the newer 2026.8.1 and
      // we are back on 2026.7.1-2 with its pre-migration backup on disk.
      harness.store.updateState((s) => {
        s.configMigration = {
          completedForVersion: "2026.8.1",
          lastAttempt: { version: "2026.8.1", at: 1, ok: true },
        };
        return s;
      });
      const bakPath = path.join(
        harness.openclawDir,
        "openclaw.json.pre-fix-2026.7.1-2.bak",
      );
      fs.mkdirSync(harness.openclawDir, { recursive: true });
      fs.writeFileSync(bakPath, JSON.stringify({ restored: true }, null, 2));
      writeConfig(harness.openclawDir, { migrated: "beta-shape" });

      harness.sync.syncAtBoot();
      const outcome = await harness.sync.reconcileBootConfig();

      // The backup was restored (migrated shape gone, restored key present);
      // doctor was NOT run. (reconcileOpenclawJsonMirror later adds update.* keys.)
      expect(outcome.status).toBe("ok");
      expect(outcome.reason).toBe("round-trip-restore");
      expect(doctorCalls).toHaveLength(0);
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(onDisk.restored).toBe(true);
      expect("migrated" in onDisk).toBe(false);
      expect(harness.store.readState().configMigration.completedForVersion).toBe(
        "2026.7.1-2",
      );
      // The snapshot was CONSUMED: it can never fire a second restore.
      expect(fs.existsSync(bakPath)).toBe(false);

      // A later forced retry must not restore again — the live config (edited
      // since the restore) survives.
      writeConfig(harness.openclawDir, { restored: true, edited: "since" });
      const retried = await harness.sync.reconcileBootConfig({ force: true });
      expect(retried.reason).not.toBe("round-trip-restore");
      const afterRetry = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(afterRetry.edited).toBe("since");

      // The restore notification carries its stable outbox id.
      await flushAsync();
      expect(notifyIds(harness.notify)).toContain(
        "config-restore-2026.7.1-2",
      );
    });

    it("never fires the round-trip restore on a forced same-version retry (red-team #1)", async () => {
      // Fresh-install shape: the FIRST reconcile snapshots
      // pre-fix-<pin>.bak while installedVersion === pin. A later forced
      // retry (the operator's Retry-migration button) must run a forward
      // migration, not silently overwrite live settings with that snapshot.
      const doctorCalls = [];
      let harness;
      harness = createHarness({
        pin: "2026.9.1-beta.1",
        installedVersion: "2026.9.1-beta.1",
        sentinelVersion: "2026.9.1-beta.1",
        runnerImpl: validateAwareRunner({
          openclawDirRef: () => harness.openclawDir,
          doctorCalls,
          dbPreflight: { ok: true, compatible: true },
        }),
      });
      writeConfig(harness.openclawDir, { marker: "first-boot" });
      harness.sync.syncAtBoot();

      const first = await harness.sync.reconcileBootConfig();
      expect(first.status).toBe("ok");
      // The first-boot snapshot exists under the installed version's name.
      const snapshots = fs
        .readdirSync(harness.openclawDir)
        .filter((n) => n.startsWith("openclaw.json.pre-fix-"));
      expect(snapshots.length).toBeGreaterThanOrEqual(1);

      // The operator edits settings, then forces a retry.
      writeConfig(harness.openclawDir, { marker: "user-edited" });
      const retried = await harness.sync.reconcileBootConfig({ force: true });

      expect(retried.status).toBe("ok");
      expect(retried.reason).not.toBe("round-trip-restore");
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(onDisk.marker).toBe("user-edited");
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

    // Boot-phase ledger steps need a pending restart_expected run — the same
    // record applyUpdate leaves behind before the activation restart. The
    // store's `applied` must target the installed build so syncAtBoot reports
    // already_active and leaves the run for the reconciler to resolve.
    const kBootOpId = "aaaabbbb-cccc-dddd-eeee-ffff00001111";
    const seedRestartExpectedRun = (harness, { dbPreflight = null } = {}) => {
      harness.store.updateState((s) => {
        s.applied = {
          channel: "beta",
          version: "2026.9.1-beta.1",
          at: 1,
          acceptedAt: null,
        };
        return s;
      });
      const ledger = createRunLedger({
        openclawDir: harness.openclawDir,
        nowFn: () => harness.nowRef.now,
        logger: kSilentLogger,
      });
      ledger.createRun({
        operationId: kBootOpId,
        target: { kind: "package", channel: "beta", version: "2026.9.1-beta.1" },
      });
      ledger.updateRun(kBootOpId, (record) => {
        record.state = "restart_expected";
        if (dbPreflight) record.dbPreflight = dbPreflight;
        return record;
      });
      return kBootOpId;
    };
    const readRunRecord = (harness, operationId = kBootOpId) =>
      JSON.parse(
        fs.readFileSync(
          path.join(harness.openclawDir, ".alphaclaw", "runs", `${operationId}.json`),
          "utf8",
        ),
      );
    const lastStepNamed = (record, name) =>
      [...(record.steps || [])].reverse().find((step) => step.name === name) ||
      null;

    it("keeps attempt 1's pristine snapshot on a retry of the same failed epoch (red-team #2)", async () => {
      let harness;
      harness = createHarness({
        installedVersion: "2026.9.1-beta.1",
        sentinelVersion: "2026.9.1-beta.1",
        runnerImpl: validateAwareRunner({
          openclawDirRef: () => harness.openclawDir,
          dbPreflight: { ok: true, compatible: true },
        }),
      });
      // Curated strip mutates the file on attempt 1; the unknown key keeps
      // the attempt failing.
      writeConfig(harness.openclawDir, {
        meta: { lastTouchedAt: "2026-07-01T00:00:00Z" },
        mystery: { operatorData: true },
      });
      harness.sync.syncAtBoot();

      const first = await harness.sync.reconcileBootConfig();
      expect(first.status).toBe("held");
      const snapshotPath = path.join(
        harness.openclawDir,
        "openclaw.json.pre-fix-1.0.0.bak",
      );
      const pristine = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
      expect(pristine.meta.lastTouchedAt).toBe("2026-07-01T00:00:00Z");
      // Attempt 1 really mutated the live config.
      const mutated = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(mutated.meta).toBeUndefined();

      // Forced retry of the SAME failed epoch: the snapshot must keep the
      // pristine pre-migration shape, not the already-mutated config.
      const retried = await harness.sync.reconcileBootConfig({ force: true });
      expect(retried.status).toBe("held");
      const kept = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
      expect(kept.meta.lastTouchedAt).toBe("2026-07-01T00:00:00Z");
    });

    it("holds the re-attempt gate across boots even when the failed attempt mutated the config (red-team #3)", async () => {
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
      writeConfig(harness.openclawDir, {
        meta: { lastTouchedAt: "x" },
        mystery: { operatorData: true },
      });
      harness.sync.syncAtBoot();

      const first = await harness.sync.reconcileBootConfig();
      expect(first.status).toBe("held");
      expect(doctorCalls).toHaveLength(1);

      // The next (crash-loop) boot recomputes the hash from the MUTATED
      // config — the stored hash must match it, or the sized doctor budget
      // re-runs on every restart.
      const second = await harness.sync.reconcileBootConfig();
      expect(second.status).toBe("held");
      expect(second.reused).toBe(true);
      expect(doctorCalls).toHaveLength(1);
    });

    it("persists a hold when the reconciler machinery itself throws (never a bare throw)", async () => {
      const explode = { on: false };
      const harness = createHarness({
        installedVersion: "2026.9.1-beta.1",
        sentinelVersion: "2026.9.1-beta.1",
        execFileSyncImpl: vi.fn(() => ""),
        storeWrap: (store) => ({
          ...store,
          readState: (...args) => {
            if (explode.on) throw new Error("EIO: state read failed");
            return store.readState(...args);
          },
        }),
      });
      writeConfig(harness.openclawDir, { clean: true });
      harness.sync.syncAtBoot();

      explode.on = true;
      const outcome = await harness.sync.reconcileBootConfig();
      explode.on = false;

      expect(outcome.status).toBe("held");
      expect(outcome.hold.reason).toMatch(/reconcile error: EIO/);
      // The hold is PERSISTED (startup.js only keeps an in-memory flag; the
      // watchdog consults state before relaunching the gateway).
      const state = harness.store.readState();
      expect(state.gatewayHold).toEqual(
        expect.objectContaining({
          reason: expect.stringContaining("reconcile error"),
        }),
      );
      expect(state.configMigration.lastAttempt).toEqual(
        expect.objectContaining({
          ok: false,
          error: expect.stringContaining("reconcile error"),
        }),
      );
    });

    it("returns held, never skipped, from the binary-unresolved path while a hold is persisted", async () => {
      const makeBinlessHarness = () =>
        createHarness({
          installedVersion: "2026.9.1-beta.1",
          sentinelVersion: "2026.9.1-beta.1",
          execFileSyncImpl: vi.fn(() => ""),
          storeWrap: (store) => ({
            ...store,
            resolvePackageBin: () => null,
          }),
        });

      const heldHarness = makeBinlessHarness();
      writeConfig(heldHarness.openclawDir, { clean: true });
      heldHarness.store.updateState((s) => {
        s.gatewayHold = {
          reason: "previous migration hold",
          at: 5,
          operationId: null,
          blamedKeys: [],
        };
        return s;
      });
      const heldOutcome = await heldHarness.sync.reconcileBootConfig();
      expect(heldOutcome.status).toBe("held");
      expect(heldOutcome.hold.reason).toBe("previous migration hold");

      // Without a hold the same path stays an honest skip.
      const freshHarness = makeBinlessHarness();
      writeConfig(freshHarness.openclawDir, { clean: true });
      const freshOutcome = await freshHarness.sync.reconcileBootConfig();
      expect(freshOutcome.status).toBe("skipped");
      expect(freshOutcome.reason).toBe("binary-unresolved");
    });

    it("closes the db-migrate probe step when the probe says no migration is needed", async () => {
      const { DatabaseSync } = require("node:sqlite");
      let harness;
      harness = createHarness({
        installedVersion: "2026.9.1-beta.1",
        sentinelVersion: "2026.9.1-beta.1",
        runnerImpl: validateAwareRunner({
          openclawDirRef: () => harness.openclawDir,
          dbPreflight: { ok: true, compatible: true },
        }),
      });
      writeConfig(harness.openclawDir, { clean: true });
      const stateDir = path.join(harness.openclawDir, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      const db = new DatabaseSync(path.join(stateDir, "openclaw.sqlite"));
      db.exec("CREATE TABLE t(x INTEGER)");
      db.close();
      seedRestartExpectedRun(harness);
      harness.sync.syncAtBoot();

      const outcome = await harness.sync.reconcileBootConfig();

      expect(outcome.status).toBe("ok");
      const record = readRunRecord(harness);
      const dbStep = lastStepNamed(record, "db-migrate");
      expect(dbStep).toEqual(
        expect.objectContaining({
          status: "completed",
          detail: "no database migration needed",
        }),
      );
      // Contract: no step may be left 'running' after the reconciler returns.
      const lastByName = new Map();
      for (const step of record.steps) lastByName.set(step.name, step.status);
      expect([...lastByName.values()]).not.toContain("running");
    });

    it("closes the db-migrate step on the hold path: failed doctor → failed, successful doctor → completed", async () => {
      const runHeld = async ({ doctorImpl }) => {
        let harness;
        harness = createHarness({
          installedVersion: "2026.9.1-beta.1",
          sentinelVersion: "2026.9.1-beta.1",
          runnerImpl: validateAwareRunner({
            openclawDirRef: () => harness.openclawDir,
            doctorImpl,
          }),
        });
        writeConfig(harness.openclawDir, { mystery: { operatorData: true } });
        seedRestartExpectedRun(harness, {
          dbPreflight: { migrationRequired: true },
        });
        harness.sync.syncAtBoot();
        const outcome = await harness.sync.reconcileBootConfig();
        expect(outcome.status).toBe("held");
        return readRunRecord(harness);
      };

      // Doctor failed outright: the DB migration did not happen.
      const failedRecord = await runHeld({
        doctorImpl: async () => ({
          ok: false,
          code: 1,
          tail: "doctor exit 1\n",
          timedOut: false,
        }),
      });
      expect(lastStepNamed(failedRecord, "db-migrate")).toEqual(
        expect.objectContaining({
          status: "failed",
          detail: "doctor did not repair the config",
        }),
      );

      // Doctor succeeded (DBs migrated) but the config stays invalid: the
      // db step is honestly complete while config-migrate carries the hold.
      const completedRecord = await runHeld({
        doctorImpl: async () => ({
          ok: true,
          code: 0,
          tail: "Doctor complete\n",
          timedOut: false,
        }),
      });
      expect(lastStepNamed(completedRecord, "db-migrate")).toEqual(
        expect.objectContaining({ status: "completed" }),
      );
      expect(lastStepNamed(completedRecord, "config-migrate")).toEqual(
        expect.objectContaining({ status: "failed" }),
      );
    });

    it("runs doctor from the apply-time dbPreflight hint without invoking the live probe", async () => {
      const { DatabaseSync } = require("node:sqlite");
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
      // A live DB exists — a probe WOULD find it, so zero preflight
      // invocations proves the hint was authoritative.
      const stateDir = path.join(harness.openclawDir, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      const db = new DatabaseSync(path.join(stateDir, "openclaw.sqlite"));
      db.exec("CREATE TABLE t(x INTEGER)");
      db.close();
      seedRestartExpectedRun(harness, {
        dbPreflight: {
          migrationRequired: true,
          foundVersion: 1,
          targetVersion: 12,
        },
      });
      harness.sync.syncAtBoot();

      const outcome = await harness.sync.reconcileBootConfig();

      expect(outcome.status).toBe("ok");
      // The config validated clean — ONLY the hint drove the doctor run.
      expect(doctorCalls).toHaveLength(1);
      const preflightCalls = harness.runner.runStreamed.mock.calls.filter(
        (call) => (call[0]?.args || []).includes("preflight"),
      );
      expect(preflightCalls).toHaveLength(0);
      expect(lastStepNamed(readRunRecord(harness), "db-migrate")).toEqual(
        expect.objectContaining({ status: "completed" }),
      );
    });

    it("holds on a doctor timeout with the sized-budget warning and an honest post-kill db verdict", async () => {
      const { DatabaseSync } = require("node:sqlite");
      const timeoutDoctor = async () => ({
        ok: false,
        code: null,
        tail: "",
        timedOut: true,
      });

      // (a) The post-kill probe finds no databases → consistent.
      let consistent;
      consistent = createHarness({
        installedVersion: "2026.9.1-beta.1",
        sentinelVersion: "2026.9.1-beta.1",
        runnerImpl: validateAwareRunner({
          openclawDirRef: () => consistent.openclawDir,
          doctorImpl: timeoutDoctor,
        }),
      });
      writeConfig(consistent.openclawDir, { mystery: { operatorData: true } });
      seedRestartExpectedRun(consistent, {
        dbPreflight: { migrationRequired: true },
      });
      consistent.sync.syncAtBoot();
      const consistentOutcome = await consistent.sync.reconcileBootConfig();
      expect(consistentOutcome.status).toBe("held");
      expect(consistentOutcome.hold.reason).toContain("doctor timed out");
      expect(
        consistentOutcome.warnings.some((warning) =>
          /timed out after its sized budget/.test(warning),
        ),
      ).toBe(true);
      expect(lastStepNamed(readRunRecord(consistent), "db-migrate")).toEqual(
        expect.objectContaining({
          status: "warning",
          detail: "databases report consistent after the timeout",
        }),
      );

      // (b) The post-kill probe is inconclusive → unverified.
      let unverified;
      unverified = createHarness({
        installedVersion: "2026.9.1-beta.1",
        sentinelVersion: "2026.9.1-beta.1",
        runnerImpl: validateAwareRunner({
          openclawDirRef: () => unverified.openclawDir,
          doctorImpl: timeoutDoctor,
          dbPreflight: "unsupported",
        }),
      });
      writeConfig(unverified.openclawDir, { mystery: { operatorData: true } });
      const stateDir = path.join(unverified.openclawDir, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      const db = new DatabaseSync(path.join(stateDir, "openclaw.sqlite"));
      db.exec("CREATE TABLE t(x INTEGER)");
      db.close();
      seedRestartExpectedRun(unverified, {
        dbPreflight: { migrationRequired: true },
      });
      unverified.sync.syncAtBoot();
      const unverifiedOutcome = await unverified.sync.reconcileBootConfig();
      expect(unverifiedOutcome.status).toBe("held");
      expect(lastStepNamed(readRunRecord(unverified), "db-migrate")).toEqual(
        expect.objectContaining({
          status: "warning",
          detail: "database state after the timeout is unverified",
        }),
      );
    });

    it("classifies a blamed-key tail as invalid even when unknown-command text co-occurs (parse-order pin)", async () => {
      // The blame parse must run BEFORE the unknown-command check: validator
      // output like 'Unrecognized key: "mystery"' matches the pattern's
      // "unrecognized", and the wrong order reports an INVALID config as
      // validate-missing (→ a false 'ok' once doctor exits 0).
      const runnerImpl = async (opts) => {
        const args = Array.isArray(opts.args) ? opts.args : [];
        if (args.includes("validate")) {
          return {
            ok: false,
            code: 1,
            tail: 'Unrecognized key: "mystery"\nerror: unknown command \'frobnicate\'\n',
            timedOut: false,
          };
        }
        if (args.includes("doctor")) {
          return { ok: true, code: 0, tail: "Doctor complete\n", timedOut: false };
        }
        return { ok: true, code: 0, tail: "", timedOut: false };
      };
      const harness = createHarness({
        installedVersion: "2026.9.1-beta.1",
        sentinelVersion: "2026.9.1-beta.1",
        runnerImpl,
      });
      writeConfig(harness.openclawDir, { mystery: { operatorData: true } });
      harness.sync.syncAtBoot();

      const outcome = await harness.sync.reconcileBootConfig();

      expect(outcome.status).toBe("held");
      expect(outcome.blamedKeys).toEqual(["mystery"]);
      expect(harness.store.readState().gatewayHold.blamedKeys).toContain(
        "mystery",
      );
    });

    it("scrubs secret values out of the persisted validator tail", async () => {
      const secret = "hunter2-secret-value";
      const runnerImpl = async (opts) => {
        const args = Array.isArray(opts.args) ? opts.args : [];
        if (args.includes("validate")) {
          return {
            ok: false,
            code: 78,
            tail: `Unrecognized key: "mystery"\nauth.apiToken must not equal ${secret}\n`,
            timedOut: false,
          };
        }
        if (args.includes("preflight")) {
          return {
            ok: true,
            code: 0,
            tail: '{"ok":true,"compatible":true}\n',
            timedOut: false,
          };
        }
        if (args.includes("doctor")) {
          return { ok: true, code: 0, tail: "Doctor complete\n", timedOut: false };
        }
        return { ok: true, code: 0, tail: "", timedOut: false };
      };
      const harness = createHarness({
        installedVersion: "2026.9.1-beta.1",
        sentinelVersion: "2026.9.1-beta.1",
        runnerImpl,
      });
      writeConfig(harness.openclawDir, {
        mystery: { operatorData: true },
        auth: { apiToken: secret },
      });
      harness.sync.syncAtBoot();

      const outcome = await harness.sync.reconcileBootConfig();

      expect(outcome.status).toBe("held");
      const tail = harness.store.readState().configMigration.lastAttempt.tail;
      expect(tail).toContain('Unrecognized key: "mystery"');
      expect(tail).not.toContain(secret);
      expect(tail).toContain("***");
    });

    it("holds when the validator says 'unrecognized' with no parsable blame (narrow capability pattern, adv-12)", async () => {
      // 'Unrecognized keys detected in configuration' carries no quoted key
      // for the blame parser and no unknown-command text — the broad
      // /unrecognized/ capability pattern misread this INVALID config as
      // validate-missing, configHealthy passed, and the gateway launched on
      // a rejected config. It must classify {available:true, valid:false}
      // and end in the fail-closed hold.
      const runnerImpl = async (opts) => {
        const args = Array.isArray(opts.args) ? opts.args : [];
        if (args.includes("validate")) {
          return {
            ok: false,
            code: 78,
            tail: "Unrecognized keys detected in configuration\n",
            timedOut: false,
          };
        }
        if (args.includes("preflight")) {
          return {
            ok: true,
            code: 0,
            tail: '{"ok":true,"compatible":true}\n',
            timedOut: false,
          };
        }
        if (args.includes("doctor")) {
          return { ok: true, code: 0, tail: "Doctor complete\n", timedOut: false };
        }
        return { ok: true, code: 0, tail: "", timedOut: false };
      };
      const harness = createHarness({
        installedVersion: "2026.9.1-beta.1",
        sentinelVersion: "2026.9.1-beta.1",
        runnerImpl,
      });
      writeConfig(harness.openclawDir, { mystery: { operatorData: true } });
      harness.sync.syncAtBoot();

      const outcome = await harness.sync.reconcileBootConfig();

      expect(outcome.status).toBe("held");
      expect(harness.store.readState().gatewayHold).toBeTruthy();
    });

    it("holds (fail-closed) instead of running doctor while a gateway process is live (adv-4)", async () => {
      // An externally-supervised `openclaw gateway run` (outside our managed
      // child) breaks the "gateway is NOT running at boot" assumption —
      // doctor --fix against its open DBs is the corruption the quiesce
      // machinery exists to prevent.
      const doctorCalls = [];
      const isRunning = vi.fn(async () => true);
      const harness = createHarness({
        installedVersion: "2026.8.1",
        sentinelVersion: "2026.8.1",
        runnerImpl: doctorRunner({ doctorCalls }),
        extraSyncOptions: { gatewayQuiesce: { isRunning } },
      });
      writeConfig(harness.openclawDir, { audit: { enabled: true } });
      harness.sync.syncAtBoot();

      const outcome = await harness.sync.reconcileBootConfig();

      expect(outcome.status).toBe("held");
      expect(doctorCalls).toHaveLength(0);
      expect(isRunning).toHaveBeenCalled();
      expect(outcome.hold.reason).toContain(
        "a gateway process is running — stop it, then Retry migration",
      );
      expect(harness.store.readState().gatewayHold.reason).toContain(
        "a gateway process is running",
      );
      // No gateHash on the failed attempt: stopping the gateway does not
      // change the config hash, so a plain next boot must retry the real
      // work instead of reusing the hold.
      expect(
        harness.store.readState().configMigration.lastAttempt.gateHash ?? null,
      ).toBe(null);
      await flushAsync();
      expect(notifyIds(harness.notify)).toContain(
        "config-migration-held-2026.8.1",
      );

      // Gateway stopped → the same reconcile proceeds to the guarded doctor.
      isRunning.mockResolvedValue(false);
      const retried = await harness.sync.reconcileBootConfig({ force: true });
      expect(retried.status).toBe("ok");
      expect(doctorCalls).toHaveLength(1);
      // (The bin-phase factory has no gatewayQuiesce dep at all — absence
      // skips the check, pinned by every other doctor test in this file.)
    });

    it("a forced retry after a COMPLETED migration never re-snapshots over the old epoch's pre-fix backup (adv-11)", async () => {
      let harness;
      harness = createHarness({
        pin: "1.0.0",
        installedVersion: "2026.9.1-beta.1",
        sentinelVersion: "2026.9.1-beta.1",
        channel: "beta",
        runnerImpl: validateAwareRunner({
          openclawDirRef: () => harness.openclawDir,
          dbPreflight: { ok: true, compatible: true },
        }),
      });
      // Old-epoch pristine snapshot — the only viable downgrade-restore
      // candidate for a later rollback to 1.0.0.
      const oldBak = path.join(
        harness.openclawDir,
        "openclaw.json.pre-fix-1.0.0.bak",
      );
      fs.mkdirSync(harness.openclawDir, { recursive: true });
      fs.writeFileSync(
        oldBak,
        JSON.stringify({ pristine: "pre-migration" }, null, 2),
      );
      writeConfig(harness.openclawDir, { migrated: "current-shape" });
      harness.store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = {
          channel: "beta",
          version: "2026.9.1-beta.1",
          at: 1,
          acceptedAt: 1,
        };
        s.configMigration = {
          completedForVersion: "2026.9.1-beta.1",
          lastAttempt: {
            version: "2026.9.1-beta.1",
            at: 1,
            ok: true,
            error: null,
          },
        };
        return s;
      });
      expect(harness.sync.syncAtBoot().action).toBe("already_active");

      const retried = await harness.sync.reconcileBootConfig({ force: true });
      expect(retried.status).toBe("ok");
      // The old epoch's snapshot keeps its pristine pre-migration shape…
      expect(JSON.parse(fs.readFileSync(oldBak, "utf8"))).toEqual({
        pristine: "pre-migration",
      });
      // …and the redundant retry's snapshot is SELF-named — content and name
      // agree, and both restore paths gate a same-version .bak out as a
      // candidate, so it is inert.
      const selfBak = path.join(
        harness.openclawDir,
        "openclaw.json.pre-fix-2026.9.1-beta.1.bak",
      );
      expect(fs.existsSync(selfBak)).toBe(true);
      expect(JSON.parse(fs.readFileSync(selfBak, "utf8")).migrated).toBe(
        "current-shape",
      );
      const baks = fs
        .readdirSync(harness.openclawDir)
        .filter((n) => n.startsWith("openclaw.json.pre-fix-"))
        .sort();
      expect(baks).toEqual([
        "openclaw.json.pre-fix-1.0.0.bak",
        "openclaw.json.pre-fix-2026.9.1-beta.1.bak",
      ]);

      // A second forced retry keeps the existing self-named snapshot as-is.
      writeConfig(harness.openclawDir, {
        migrated: "current-shape",
        edited: true,
      });
      const again = await harness.sync.reconcileBootConfig({ force: true });
      expect(again.status).toBe("ok");
      expect(
        JSON.parse(fs.readFileSync(selfBak, "utf8")).edited,
      ).toBeUndefined();
    });

    it("evicts '.restored.bak' artifacts before live pre-fix snapshots when pruning to keep-3", async () => {
      const doctorCalls = [];
      const harness = createHarness({
        installedVersion: "2026.8.1",
        sentinelVersion: "2026.8.1",
        runnerImpl: doctorRunner({ doctorCalls }),
      });
      writeConfig(harness.openclawDir, { audit: { enabled: true } });
      const seed = (name, ageMs) => {
        const p = path.join(harness.openclawDir, name);
        fs.writeFileSync(p, "{}");
        const when = new Date(Date.now() - ageMs);
        fs.utimesSync(p, when, when);
      };
      // Two OLD live snapshots and a NEWER consumed-restore artifact: a
      // pure-mtime prune would evict an old epoch's only live snapshot and
      // keep the inert .restored.bak leftover.
      seed("openclaw.json.pre-fix-0.7.0.bak", 60 * 60 * 1000);
      seed("openclaw.json.pre-fix-0.8.0.bak", 30 * 60 * 1000);
      seed("openclaw.json.pre-fix-0.9.0.restored.bak", 5 * 60 * 1000);
      harness.sync.syncAtBoot();

      const outcome = await harness.sync.reconcileBootConfig();
      expect(outcome.status).toBe("ok");
      const names = fs
        .readdirSync(harness.openclawDir)
        .filter((n) => n.startsWith("openclaw.json.pre-fix-"))
        .sort();
      // The reconcile's own snapshot plus both live snapshots survive; the
      // newest-but-consumed .restored.bak was evicted first.
      expect(names).toEqual([
        "openclaw.json.pre-fix-0.7.0.bak",
        "openclaw.json.pre-fix-0.8.0.bak",
        "openclaw.json.pre-fix-1.0.0.bak",
      ]);
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

    // Merged design (#20 engine + #21 knob): the doctor runs in the SERVER-
    // phase reconciler via runner.runStreamed, never execFileSync in the bin
    // phase. Budget formula: timeoutMs = min(max(30min, base),
    // round(base + stateDbGb * 5min)) where base is the injected
    // doctorMigrationTimeoutMs (default: OPENCLAW_DOCTOR_MIGRATION_TIMEOUT or
    // 10 min). The old 12-minute bin-phase cap is GONE — the boot placeholder
    // now resets its window on step progress (60-min ceiling), so the doctor
    // cap is 30 minutes, raised further only when the operator's base exceeds
    // it.
    const doctorTimeoutFor = async ({
      fakeDbBytes = null,
      doctorMigrationTimeoutMs = undefined,
    } = {}) => {
      const runnerImpl = async (opts) => {
        const args = Array.isArray(opts.args) ? opts.args : [];
        if (args.includes("doctor")) {
          return { ok: true, code: 0, tail: "Doctor complete\n", timedOut: false };
        }
        // `config validate` / `database preflight`: capability-probed stable
        // answers, routing the reconciler through the doctor path.
        return {
          ok: false,
          code: 1,
          tail: "error: unknown command\n",
          timedOut: false,
        };
      };
      // Size the state DB via a statSync seam so the test never writes GiBs.
      const fsModule =
        fakeDbBytes == null
          ? undefined
          : {
              ...fs,
              statSync: (p, ...rest) => {
                const st = fs.statSync(p, ...rest);
                if (String(p).endsWith(path.join("state", "openclaw.sqlite"))) {
                  return {
                    size: fakeDbBytes,
                    mtimeMs: st.mtimeMs,
                    isFile: () => st.isFile(),
                    isDirectory: () => st.isDirectory(),
                  };
                }
                return st;
              },
            };
      const harness = createHarness({
        installedVersion: "2026.8.1",
        sentinelVersion: "2026.8.1",
        runnerImpl,
        ...(fsModule ? { fsModule } : {}),
        ...(doctorMigrationTimeoutMs !== undefined
          ? { extraSyncOptions: { doctorMigrationTimeoutMs } }
          : {}),
      });
      writeConfig(harness.openclawDir, { audit: {} });
      if (fakeDbBytes != null) {
        fs.mkdirSync(path.join(harness.openclawDir, "state"), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(harness.openclawDir, "state", "openclaw.sqlite"),
          "not-a-real-db",
        );
      }
      harness.sync.syncAtBoot();
      // The bin phase never spawns the doctor anymore.
      expect(harness.runner.runStreamed).not.toHaveBeenCalled();
      const outcome = await harness.sync.reconcileBootConfig();
      expect(outcome.status).toBe("ok");
      const doctorCalls = harness.runner.runStreamed.mock.calls.filter(
        (call) => (call[0]?.args || []).includes("doctor"),
      );
      expect(doctorCalls).toHaveLength(1);
      expect(doctorCalls[0][0].args).toEqual(
        expect.arrayContaining(["doctor", "--fix", "--yes"]),
      );
      return doctorCalls[0][0].timeoutMs;
    };

    it("sizes the reconciler doctor budget: tunable base, per-GB scaling, and a 30-minute cap raised only by a larger base", async () => {
      // Default (no state DBs): the 10-minute tunable base, exact — the
      // budget is a pure formula, not shaved by a wall clock.
      expect(await doctorTimeoutFor()).toBe(600_000);
      // A ~900MiB state DB scales the budget up by 5 min/GB.
      expect(await doctorTimeoutFor({ fakeDbBytes: 900 * 1024 * 1024 })).toBe(
        Math.round(600_000 + (900 / 1024) * 300_000),
      );
      // 8GiB would ask for 50 minutes — the 30-minute cap holds (the old
      // 12-minute bin-phase cap is gone).
      expect(await doctorTimeoutFor({ fakeDbBytes: 8 * 1024 ** 3 })).toBe(
        30 * 60_000,
      );
      // The DI seam (backing OPENCLAW_DOCTOR_MIGRATION_TIMEOUT, which
      // constants.js resolves at require time) lowers the base…
      expect(await doctorTimeoutFor({ doctorMigrationTimeoutMs: 30_000 })).toBe(
        30_000,
      );
      // …and a base past the 30-minute ceiling raises the cap with it: the
      // operator explicitly asked for more than the default ceiling.
      expect(
        await doctorTimeoutFor({
          fakeDbBytes: 8 * 1024 ** 3,
          doctorMigrationTimeoutMs: 45 * 60_000,
        }),
      ).toBe(45 * 60_000);
    });

    // The old bin-phase tests 'captures the redacted doctor stderr tail into
    // the warning and lastAttempt.error' and 'reports a timeout distinctly
    // when doctor is killed on the deadline' pinned the DELETED execFileSync
    // doctor path. Their reconciler equivalents already exist in the
    // "boot config migration (doctor --fix)" describe above:
    //   - 'scrubs secret values out of the persisted validator tail' covers
    //     redaction of the persisted tail (redactValidatorTail →
    //     configMigration.lastAttempt.tail). The doctor's raw stderr no
    //     longer lands in lastAttempt.error — that field now carries the
    //     doctorNote verdict string.
    //   - 'holds on a doctor timeout with the sized-budget warning and an
    //     honest post-kill db verdict' covers the distinct timeout branch
    //     (runner timedOut → hold.reason 'doctor timed out' + the
    //     sized-budget warning), which replaced the killed-execFileSync
    //     "timed out after Ns" classification.
  });

  describe("crash-rollback config restore (issue #21 bug 4)", () => {
    const writeConfig = (openclawDir, obj) => {
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(
        path.join(openclawDir, "openclaw.json"),
        JSON.stringify(obj, null, 2),
      );
    };

    // A validate-clean runner for reconciles that should complete without a
    // doctor run (the restore paths return before any spawn; forced retries
    // validate the live config).
    const okRunner = async () => ({
      ok: true,
      code: 0,
      tail: "",
      timedOut: false,
    });

    const seedRollbackScenario = ({
      execFileSyncImpl,
      fsModule,
      runnerImpl,
    } = {}) => {
      // The #21 shape: config migrated AWAY from the pin by a failed beta
      // (lastAttempt names the beta), then a crash-rollback marker lands on
      // the pin. completedForVersion === pin would previously skip the
      // restore forever.
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "2026.9.1-beta.1",
        sentinelVersion: "2026.9.1-beta.1",
        execFileSyncImpl: execFileSyncImpl || vi.fn(() => ""),
        ...(runnerImpl ? { runnerImpl } : {}),
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
      // Merged design: the restore is now two-phase. The BIN phase
      // (syncAtBoot) consumes the marker and persists the boot context
      // (lastBoot.rollbackTargetVersion) — the SERVER phase
      // (reconcileBootConfig) keys the actual restore on it.
      const harness = seedRollbackScenario({ runnerImpl: okRunner });

      // Stage (a): the bin phase rolls back and persists the target, but
      // never touches the config and never spawns.
      const result = harness.sync.syncAtBoot();
      expect(result.action).toBe("rollback");
      expect(installedPackageJsonVersion(harness.installDir)).toBe("1.0.0");
      const lastBoot = harness.store.readState().lastBoot;
      expect(lastBoot.rollbackTargetVersion).toBe("1.0.0");
      expect(lastBoot.previousInstalledVersion).toBe("2026.9.1-beta.1");
      let cfg = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(cfg.meta).toEqual({ migrations: 12 }); // not restored yet
      expect(harness.runner.runStreamed).not.toHaveBeenCalled();

      // Stage (b): the reconciler sees rollback + a pre-fix backup for the
      // rolled-back-to version + a lastAttempt naming a NEWER version, and
      // restores — even though completedForVersion already equals this
      // version (the exact #21 blind spot).
      const outcome = await harness.sync.reconcileBootConfig();
      expect(outcome.status).toBe("ok");
      expect(outcome.reason).toBe("rollback-restore");
      cfg = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      // The migrated shape is gone: the backup was copied back verbatim.
      expect(cfg.agents).toEqual({ list: [] });
      expect(cfg.meta).toBeUndefined();
      const migration = harness.store.readState().configMigration;
      expect(migration.completedForVersion).toBe("1.0.0");
      expect(migration.lastAttempt.ok).toBe(true);
      await flushAsync();
      expect(notifyIds(harness.notify)).toContain(
        "config-restore-rollback-1.0.0",
      );

      // A FORCED retry (the operator's Retry-migration button) must never
      // replay the stale rollback restore over live edits.
      writeConfig(harness.openclawDir, {
        agents: { list: [] },
        edited: "since",
      });
      const retried = await harness.sync.reconcileBootConfig({ force: true });
      expect(retried.status).toBe("ok");
      expect(retried.reason).not.toBe("rollback-restore");
      const afterRetry = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(afterRetry.edited).toBe("since");
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

    it("holds the gateway (fail-closed) when the pre-fix backup cannot be written", async () => {
      // Merge policy change: #21's bin phase WARNED and continued when the
      // pre-fix backup write failed (id config-backup-write-failed-*). Under
      // the #20 F7 fail-CLOSED reconciler that path is gone: no snapshot
      // means no revert path, so no doctor runs and the gateway is HELD (the
      // held notification replaces the old warn-and-continue one).
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
        fsModule: failingFs,
      });
      writeConfig(harness.openclawDir, { audit: {} });
      harness.sync.syncAtBoot();

      const outcome = await harness.sync.reconcileBootConfig();

      expect(outcome.status).toBe("held");
      expect(
        outcome.warnings.some((w) => w.includes("config snapshot failed")),
      ).toBe(true);
      expect(harness.store.readState().gatewayHold).toEqual(
        expect.objectContaining({
          reason: expect.stringContaining("config snapshot failed"),
        }),
      );
      // Fail closed: nothing ran against the unprotected config (the poisoned
      // default runner would have thrown into a 'reconcile error' hold).
      expect(harness.runner.runStreamed).not.toHaveBeenCalled();
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(harness.openclawDir, "openclaw.json"), "utf8"),
      );
      expect(onDisk.audit).toEqual({});
      await flushAsync();
      expect(notifyIds(harness.notify)).toContain(
        "config-migration-held-2026.8.1",
      );
    });

    it("names the pre-fix backup after the previously installed version when no history exists", async () => {
      // Snapshot naming priority (merged): completedForVersion, then the
      // version installed BEFORE this boot's activation
      // (lastBoot.previousInstalledVersion, persisted by syncAtBoot), then
      // the pin — never the version being migrated TO. Pin === installed
      // here, so only the previous-installed source can name it.
      const harness = createHarness({
        pin: "2.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        runnerImpl: okRunner,
      });
      saveOverlayFixture(harness.store, "2.0.0");
      writeConfig(harness.openclawDir, { audit: {} });
      harness.store.updateState((s) => {
        s.pinVersion = "2.0.0";
        s.applied = {
          channel: "stable",
          version: "2.0.0",
          at: 1,
          acceptedAt: null,
        };
        return s;
      });

      const boot = harness.sync.syncAtBoot();
      expect(boot.action).toBe("activated");
      expect(installedPackageJsonVersion(harness.installDir)).toBe("2.0.0");
      expect(harness.store.readState().lastBoot.previousInstalledVersion).toBe(
        "1.0.0",
      );

      const outcome = await harness.sync.reconcileBootConfig();
      expect(outcome.status).toBe("ok");
      expect(
        fs.existsSync(
          path.join(harness.openclawDir, "openclaw.json.pre-fix-1.0.0.bak"),
        ),
      ).toBe(true);
      // Never named after the version being migrated TO (a same-version .bak
      // would read as a downgrade-restore candidate later), and never the
      // placeholder fallback.
      expect(
        fs.existsSync(
          path.join(harness.openclawDir, "openclaw.json.pre-fix-2.0.0.bak"),
        ),
      ).toBe(false);
      expect(
        fs.existsSync(
          path.join(harness.openclawDir, "openclaw.json.pre-fix-unknown.bak"),
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

    // The gate moved (merge resolution): it now runs INSIDE the server-phase
    // reconciler's failure path — after doctor failed and the config is still
    // invalid — not in the bin phase. syncAtBoot only activates and persists
    // the boot context; reconcileBootConfig snapshots the pre-fix backup,
    // runs validate/doctor, and calls the gate before falling back to the
    // fail-closed hold.
    const writeStateDb = (openclawDir) => {
      const { DatabaseSync } = require("node:sqlite");
      fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
      const db = new DatabaseSync(
        path.join(openclawDir, "state", "openclaw.sqlite"),
      );
      db.exec("CREATE TABLE t (x INTEGER)");
      db.close();
    };

    // Reconciler-phase failure: `config validate` keeps blaming a key the
    // beta rejects, doctor fails, and the live `database preflight` probe
    // (runner-driven) is capability-missing → migration assumed needed.
    const failingMigrationRunner = () => async (opts) => {
      const args = Array.isArray(opts.args) ? opts.args : [];
      if (args.includes("validate")) {
        return {
          ok: false,
          code: 78,
          tail: 'Unrecognized key: "legacyBridge"\n',
          timedOut: false,
        };
      }
      if (args.includes("doctor")) {
        return { ok: false, code: 1, tail: "doctor exit 1\n", timedOut: false };
      }
      return {
        ok: false,
        code: 1,
        tail: "error: unknown command 'database'\n",
        timedOut: false,
      };
    };

    // The #21 box, in miniature: healthy pin, beta freshly applied, the
    // beta's migration fails. The gate must stop the beta BEFORE it ever
    // launches (its first gateway run would one-way migrate the state DB).
    // probeExecFileSyncImpl scripts the gate's preflight prober spawns
    // (execFileSync `database preflight` against snapshot copies of the real
    // state DB — VACUUM INTO, same mechanics as the apply-time preflight).
    const seedIncident = ({ probeExecFileSyncImpl, runnerImpl } = {}) => {
      const impl = probeExecFileSyncImpl || vi.fn(() => "");
      const harness = createHarness({
        pin: "2026.7.1-2",
        installedVersion: "2026.7.1-2",
        sentinelVersion: "2026.7.1-2",
        channel: "beta",
        execFileSyncImpl: impl,
        runnerImpl: runnerImpl || failingMigrationRunner(),
      });
      saveOverlayFixture(harness.store, "2026.9.1-beta.1");
      saveOverlayFixture(harness.store, "2026.7.1-2");
      writeConfig(harness.openclawDir, {
        audit: { enabled: true },
        legacyBridge: { enabled: true },
      });
      writeStateDb(harness.openclawDir);
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

    // The apply left a restart_expected run behind — the gate must resolve it
    // honestly (activated:false — the code activation was undone before
    // anything launched on it).
    const kGateOpId = "bbbbcccc-dddd-eeee-ffff-000011112222";
    const seedGateRun = (harness) => {
      const ledger = createRunLedger({
        openclawDir: harness.openclawDir,
        nowFn: () => harness.nowRef.now,
        logger: kSilentLogger,
      });
      ledger.createRun({
        operationId: kGateOpId,
        target: { kind: "package", channel: "beta", version: "2026.9.1-beta.1" },
      });
      ledger.updateRun(kGateOpId, (record) => {
        record.state = "restart_expected";
        return record;
      });
      return kGateOpId;
    };
    const readGateRun = (harness) =>
      JSON.parse(
        fs.readFileSync(
          path.join(
            harness.openclawDir,
            ".alphaclaw",
            "runs",
            `${kGateOpId}.json`,
          ),
          "utf8",
        ),
      );

    it("[REG #21] incident replay: reverts to the previous version, restores the config, and blocklists the target", async () => {
      const probeExec = vi.fn(() => "");
      const harness = seedIncident({ probeExecFileSyncImpl: probeExec });
      seedGateRun(harness);

      // Bin phase: the fresh apply activates normally — no gate here anymore.
      const boot = harness.sync.syncAtBoot();
      expect(boot.action).toBe("activated");
      expect(installedPackageJsonVersion(harness.installDir)).toBe(
        "2026.9.1-beta.1",
      );

      // Server phase: validate fails, doctor fails, the gate fires.
      const outcome = await harness.sync.reconcileBootConfig();

      // The box never bricks: the pin is back, with its config restored.
      expect(outcome.status).toBe("ok");
      expect(outcome.reason).toBe("migration-gate-reverted");
      expect(installedPackageJsonVersion(harness.installDir)).toBe(
        "2026.7.1-2",
      );
      const state = harness.store.readState();
      expect(state.applied).toBe(null);
      expect(state.gatewayHold).toBe(null);
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
      // Restored pre-fix shape — including the key the beta rejected (the
      // reverted-to build accepts it; the boot's own mirror keys may sit on
      // top).
      expect(cfg.audit).toEqual({ enabled: true });
      expect(cfg.legacyBridge).toEqual({ enabled: true });
      // The revert target was preflight-proven against a snapshot copy of
      // the real state DB — via the STREAMED prober (the sync execFileSync
      // variant froze the event loop for the whole gate budget, so the gate
      // must never use it; scripted here as "unsupported" → proceed).
      expect(
        harness.runner.runStreamed.mock.calls.some(
          (call) =>
            (call[0]?.args || []).includes("preflight") &&
            (call[0]?.args || []).some((arg) =>
              String(arg).includes(".probe-"),
            ),
        ),
      ).toBe(true);
      expect(
        probeExec.mock.calls.some((call) =>
          (call[1] || []).includes("preflight"),
        ),
      ).toBe(false);
      // The pending restart_expected run resolved with activated:false.
      const record = readGateRun(harness);
      expect(record.state).toBe("activation_failed");
      expect(record.ok).toBe(false);
      await flushAsync();
      expect(notifyIds(harness.notify)).toContain(
        "config-migration-aborted-2026.9.1-beta.1",
      );
      // Still fully offline: the reconciler spawns, but never fetches.
      expect(global.fetch).not.toHaveBeenCalled();
      expect(harness.installToTempDir).not.toHaveBeenCalled();
    });

    it("OPENCLAW_MIGRATION_GATE=off falls through to the fail-closed hold", async () => {
      // Merge policy change (documented): under #21's bin-phase gate, =off
      // meant warn-and-continue — the new build launched anyway. Under the
      // merged fail-CLOSED reconciler (#20 F7), disabling the gate only
      // disables the REVERT: a failed migration still ends in a gateway
      // hold, never a launch on a config this build rejects.
      process.env.OPENCLAW_MIGRATION_GATE = "off";
      const harness = seedIncident();
      harness.sync.syncAtBoot();

      const outcome = await harness.sync.reconcileBootConfig();

      expect(outcome.status).toBe("held");
      expect(harness.store.readState().gatewayHold).toEqual(
        expect.objectContaining({
          reason: expect.stringContaining("2026.9.1-beta.1"),
        }),
      );
      // No revert happened: the new build stays installed (held, not run).
      expect(installedPackageJsonVersion(harness.installDir)).toBe(
        "2026.9.1-beta.1",
      );
      expect(harness.store.readState().blocklist).toEqual([]);
      expect(
        outcome.warnings.some((w) => w.includes("migration gate disabled")),
      ).toBe(true);
    });

    it("holds the gateway when the revert target cannot read the migrated state", async () => {
      // A part-migrated DB belongs to the new build — reverting would
      // recreate the exact brick. Merged policy: the gate DECLINES and the
      // reconciler falls through to the fail-closed HOLD (supersedes #21's
      // 'keeps the new build running' — the config is still rejected, so
      // launching on it would just crash-loop). The gate's revert preflights
      // run through the STREAMED prober, so the block is scripted on the
      // runner (the live db-probe sees the same failure and stays
      // inconclusive → migration assumed needed → doctor runs and fails).
      const blockedProbeRunner = async (opts) => {
        const args = Array.isArray(opts.args) ? opts.args : [];
        if (args.includes("validate")) {
          return {
            ok: false,
            code: 78,
            tail: 'Unrecognized key: "legacyBridge"\n',
            timedOut: false,
          };
        }
        if (args.includes("doctor")) {
          return { ok: false, code: 1, tail: "doctor exit 1\n", timedOut: false };
        }
        if (args.includes("preflight")) {
          return {
            ok: false,
            code: 1,
            tail: "schema version 12; this build supports 1\n",
            timedOut: false,
          };
        }
        return { ok: true, code: 0, tail: "", timedOut: false };
      };
      const harness = seedIncident({ runnerImpl: blockedProbeRunner });
      harness.sync.syncAtBoot();

      const outcome = await harness.sync.reconcileBootConfig();

      expect(outcome.status).toBe("held");
      expect(harness.store.readState().gatewayHold).toBeTruthy();
      // No blocklist-revert: the new build stays installed, gateway held.
      expect(installedPackageJsonVersion(harness.installDir)).toBe(
        "2026.9.1-beta.1",
      );
      expect(harness.store.readState().blocklist).toEqual([]);
      expect(
        outcome.warnings.some((w) =>
          w.includes("no revert target can read the current state"),
        ),
      ).toBe(true);
    });

    it("never gates a plain pin boot (no restore target)", async () => {
      // A pin boot has no applied build and no older target to return to —
      // the gate skips it, and the failed migration falls to the hold.
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        execFileSyncImpl: vi.fn(() => ""),
        runnerImpl: failingMigrationRunner(),
      });
      writeConfig(harness.openclawDir, {
        audit: {},
        legacyBridge: { enabled: true },
      });

      harness.sync.syncAtBoot();
      const outcome = await harness.sync.reconcileBootConfig();
      expect(outcome.reason).not.toBe("migration-gate-reverted");
      expect(outcome.status).toBe("held");
      expect(harness.store.readState().blocklist).toEqual([]);
      expect(installedPackageJsonVersion(harness.installDir)).toBe("1.0.0");
    });

    it("gates a steady-state reboot of an already-active build (already_active)", async () => {
      // Merged design: the gate is no longer keyed on the syncAtBoot action
      // allowlist — only rollback / rollback_refused boots are excluded
      // (those belong to the restore path). A reboot of an already-active
      // build whose migration fails still enters the gate.
      const harness = createHarness({
        pin: "2026.7.1-2",
        installedVersion: "2026.9.1-beta.1",
        sentinelVersion: "2026.9.1-beta.1",
        channel: "beta",
        execFileSyncImpl: vi.fn(() => ""),
        runnerImpl: failingMigrationRunner(),
      });
      saveOverlayFixture(harness.store, "2026.7.1-2");
      writeConfig(harness.openclawDir, {
        audit: {},
        legacyBridge: { enabled: true },
      });
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

      const boot = harness.sync.syncAtBoot();
      expect(boot.action).toBe("already_active");
      expect(harness.store.readState().lastBoot.action).toBe("already_active");

      const outcome = await harness.sync.reconcileBootConfig();
      expect(outcome.status).toBe("ok");
      expect(outcome.reason).toBe("migration-gate-reverted");
      expect(installedPackageJsonVersion(harness.installDir)).toBe(
        "2026.7.1-2",
      );
      expect(harness.store.readState().blocklist).toEqual([
        expect.objectContaining({
          id: "2026.9.1-beta.1",
          reason: "config_migration_failed",
        }),
      ]);
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
