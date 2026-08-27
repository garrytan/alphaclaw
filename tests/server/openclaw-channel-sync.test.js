const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createOpenclawChannelSync,
} = require("../../lib/server/openclaw-channel-sync");
const {
  createOpenclawReleaseChannelStore,
} = require("../../lib/server/openclaw-release-channel");

const kSilentLogger = { log() {}, warn() {}, error() {} };
const kDevSha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
const kOtherSha = "0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a";

const mkTemp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const flushAsync = () => new Promise((resolve) => process.nextTick(resolve));

// Builds a plausible openclaw npm-package tree: package.json (+bin file),
// dist/ with the thinking module sentinel and dist/extensions.
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

// Default runner: everything succeeds; `node <bin> --version` reports the
// version of the package.json two levels above the bin, like the real CLI.
const defaultRunnerImpl = async (opts) => {
  if (
    opts.command === "node" &&
    Array.isArray(opts.args) &&
    opts.args[1] === "--version"
  ) {
    let version = "";
    try {
      version =
        JSON.parse(
          fs.readFileSync(
            path.resolve(String(opts.args[0]), "..", "..", "package.json"),
            "utf8",
          ),
        ).version || "";
    } catch {}
    return { ok: true, code: 0, tail: `${version}\n`, timedOut: false };
  }
  return { ok: true, code: 0, tail: "", timedOut: false };
};

const createHarness = ({
  pin = "1.0.0",
  channel = "stable",
  installedVersion = null,
  sentinelVersion = null,
  runnerImpl = null,
  installFixture = {},
  releases = null,
  isOnboarded = () => true,
  storeWrap = (store) => store,
  stabilizationWindowMs = undefined,
  acceptanceHoldMs = undefined,
  // Escape hatch for DI seams the named options above don't cover
  // (isSelfUpdateInProgress, watchdogManagedOperation, notify: null, ...).
  extraSyncOptions = {},
} = {}) => {
  delete process.env.OPENCLAW_GIT_DIR;
  const rootDir = mkTemp("alphaclaw-channel-sync-root-");
  const openclawDir = path.join(rootDir, ".openclaw");
  const packageRoot = mkTemp("alphaclaw-channel-sync-pkgroot-");
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "@chrysb/alphaclaw", dependencies: { openclaw: pin } })}\n`,
  );
  const installDir = mkTemp("alphaclaw-channel-sync-install-");
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
      runnerImpl ? (opts) => runnerImpl(opts, defaultRunnerImpl) : defaultRunnerImpl,
    ),
  };
  const installResults = [];
  const installToTempDir = vi.fn(async ({ versionSpec }) => {
    const tmpDir = mkTemp("openclaw-fake-prepare-");
    const openclawPackageDir = writePackageFixture(
      path.join(tmpDir, "node_modules", "openclaw"),
      { version: versionSpec, ...installFixture },
    );
    const cleanup = vi.fn(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    });
    const result = { tmpDir, openclawPackageDir, cleanup };
    installResults.push(result);
    return result;
  });

  const notify = vi.fn(async () => {});
  const restartProcess = vi.fn();
  const clearVersionCache = vi.fn();
  const watchdogLatch = vi.fn();
  const channelRef = { channel };

  const sync = createOpenclawChannelSync({
    rootDir,
    openclawDir,
    packageRoot,
    store: storeWrap(store),
    runStream: runner,
    installToTempDir,
    resolveInstallDir: () => installDir,
    readReleaseChannel: () => channelRef.channel,
    releases,
    isOnboarded,
    restartProcess,
    clearVersionCache,
    notify,
    watchdogLatch,
    nowFn,
    logger: kSilentLogger,
    backupsDir: path.join(rootDir, "backups", "openclaw"),
    ...(stabilizationWindowMs !== undefined ? { stabilizationWindowMs } : {}),
    ...(acceptanceHoldMs !== undefined ? { acceptanceHoldMs } : {}),
    ...extraSyncOptions,
  });

  return {
    sync,
    store,
    rootDir,
    openclawDir,
    packageRoot,
    installDir,
    runner,
    installToTempDir,
    installResults,
    notify,
    restartProcess,
    clearVersionCache,
    watchdogLatch,
    nowRef,
    channelRef,
  };
};

const saveOverlayFixture = (store, version) =>
  store.saveOverlayFromTempInstall({
    openclawPackageDir: writePackageFixture(
      path.join(mkTemp("alphaclaw-overlay-src-"), "openclaw"),
      { version },
    ),
    version,
  });

const notifyMessages = (notify) =>
  notify.mock.calls.map((call) => String(call?.[0] || ""));

describe("server/openclaw-channel-sync", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.GIT_ASKPASS;
  });

  describe("syncAtBoot", () => {
    it("pin fast-path: no-op boot never runs commands or fetches", () => {
      const releases = { getCatalog: vi.fn() };
      const { sync, runner, installToTempDir } = createHarness({
        pin: "1.0.0",
        channel: "stable",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        releases,
      });

      const result = sync.syncAtBoot();

      expect(result.ok).toBe(true);
      expect(result.action).toBe("none");
      expect(runner.runStreamed).not.toHaveBeenCalled();
      expect(releases.getCatalog).not.toHaveBeenCalled();
      expect(installToTempDir).not.toHaveBeenCalled();
    });

    it("consumes an explicit package rollback marker (VPS activate)", async () => {
      const { sync, store, installDir, runner, notify, nowRef } = createHarness({
        pin: "1.0.0",
        channel: "beta",
        installedVersion: "1.2.0",
      });
      store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = { channel: "beta", version: "1.2.0", at: 1, acceptedAt: null };
        return s;
      });
      expect(saveOverlayFixture(store, "1.0.0")).toEqual({ ok: true });
      expect(saveOverlayFixture(store, "1.1.0")).toEqual({ ok: true });
      store.writeMarker({
        target: { kind: "package", channel: "beta", version: "1.1.0" },
        blockedId: "1.2.0",
        reason: "crash_loop",
      });

      const result = sync.syncAtBoot();
      await sync.flushBootNotifications();

      expect(result.ok).toBe(true);
      expect(result.action).toBe("rollback");
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(installDir, "node_modules", "openclaw", "package.json"),
            "utf8",
          ),
        ).version,
      ).toBe("1.1.0");
      expect(store.readSentinel({ installDir })).toEqual({
        version: "1.1.0",
        completedAt: nowRef.now,
      });
      expect(store.readMarker()).toBeNull();
      const state = store.readState();
      expect(state.applied).toEqual(
        expect.objectContaining({ channel: "beta", version: "1.1.0" }),
      );
      expect(state.applied.acceptedAt).toBe(nowRef.now);
      expect(
        notifyMessages(notify).some((message) => /rolled back/i.test(message)),
      ).toBe(true);
      expect(runner.runStreamed).not.toHaveBeenCalled();
    });

    it("consumes a pin rollback marker (container reset case)", () => {
      const { sync, store, installDir } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
      });
      store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = { channel: "beta", version: "1.2.0", at: 1, acceptedAt: null };
        return s;
      });
      store.writeMarker({ target: { kind: "pin" }, blockedId: "1.2.0" });

      const result = sync.syncAtBoot();

      expect(result.ok).toBe(true);
      expect(store.readState().applied).toBeNull();
      expect(store.readSentinel({ installDir })).toEqual(
        expect.objectContaining({ version: "1.0.0" }),
      );
      expect(store.readMarker()).toBeNull();
    });

    it("re-activates an applied beta from the overlay store, fully offline", () => {
      const { sync, store, installDir, runner } = createHarness({
        pin: "1.0.0",
        channel: "beta",
        installedVersion: "1.0.0",
        // No sentinel: a fresh container image never has one.
      });
      store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = { channel: "beta", version: "1.1.0", at: 1, acceptedAt: 2 };
        return s;
      });
      expect(saveOverlayFixture(store, "1.1.0")).toEqual({ ok: true });

      const result = sync.syncAtBoot();

      expect(result.ok).toBe(true);
      expect(result.action).toBe("activated");
      expect(store.readInstalledVersion({ installDir })).toBe("1.1.0");
      expect(store.readSentinel({ installDir })).toEqual(
        expect.objectContaining({ version: "1.1.0" }),
      );
      expect(runner.runStreamed).not.toHaveBeenCalled();
    });

    it("falls back to the pin with a warning when the overlay is missing", async () => {
      const { sync, store, installDir, notify } = createHarness({
        pin: "1.0.0",
        channel: "beta",
        installedVersion: "1.0.0",
      });
      store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = { channel: "beta", version: "1.1.0", at: 1, acceptedAt: 2 };
        return s;
      });
      expect(saveOverlayFixture(store, "1.0.0")).toEqual({ ok: true });

      const result = sync.syncAtBoot();
      await flushAsync();

      expect(result.ok).toBe(true);
      expect(result.action).toBe("overlay_missing");
      expect(store.readSentinel({ installDir })).toEqual(
        expect.objectContaining({ version: "1.0.0" }),
      );
      const state = store.readState();
      expect(
        state.lastBoot.warnings.some((warning) =>
          warning.includes("overlay for 1.1.0 missing"),
        ),
      ).toBe(true);
      expect(
        notifyMessages(notify).some((message) =>
          message.includes("missing from disk"),
        ),
      ).toBe(true);
      // The PIN is what actually runs after the fallback: `applied` must not
      // keep claiming the pick, or the watchdog would blocklist (and
      // acceptance would "verify") a build that never ran.
      expect(state.applied).toBeNull();
    });

    it("treats installed-lags-new-pin after a self-update as lag, not agent drift", async () => {
      // AlphaClaw self-update bumped the declared pin, but node_modules still
      // holds the old pin at first boot. That is expected reinstall lag — the
      // "changed outside this dashboard (possibly by your agent)" accusation
      // must NOT fire.
      const { sync, store, notify } = createHarness({
        pin: "1.0.1",
        channel: "stable",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      store.updateState((s) => {
        s.pinVersion = "1.0.0";
        return s;
      });

      const result = sync.syncAtBoot();
      await flushAsync();

      expect(result.ok).toBe(true);
      expect(result.action).toBe("pin_reconciled");
      expect(store.readState().pinVersion).toBe("1.0.1");
      expect(
        result.warnings.some((warning) => warning.includes("lags the new pin")),
      ).toBe(true);
      expect(
        notifyMessages(notify).some((message) =>
          message.includes("changed outside this dashboard"),
        ),
      ).toBe(false);
    });

    it("skips the destructive boot sync while another alphaclaw server is live", async () => {
      const { spawn } = require("child_process");
      const { sync, store, installDir } = createHarness({
        pin: "1.0.0",
        channel: "beta",
        installedVersion: "1.0.0",
      });
      store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = { channel: "beta", version: "1.1.0", at: 1, acceptedAt: 2 };
        return s;
      });
      // A live foreign pid in the server pidfile = another instance is
      // serving from this tree; the sync must no-op (fail open), not mutate.
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        stdio: "ignore",
      });
      try {
        fs.writeFileSync(
          store.serverPidPath,
          JSON.stringify({ pid: child.pid, at: 1 }),
        );
        const skipped = sync.syncAtBoot();
        expect(skipped.ok).toBe(false);
        expect(skipped.action).toBe("skipped_concurrent");
        expect(skipped.livePid).toBe(child.pid);
        // Nothing was mutated: applied still recorded, no lastBoot rewrite.
        expect(store.readState().applied).toEqual(
          expect.objectContaining({ version: "1.1.0" }),
        );
      } finally {
        child.kill("SIGKILL");
      }
      // A DEAD pid (or our own) clears the guard and the sync proceeds.
      await new Promise((resolve) => child.once("exit", resolve));
      const proceeded = sync.syncAtBoot();
      expect(proceeded.ok).toBe(true);
    });

    it("delivers bin-process boot notifications once via flushBootNotifications", async () => {
      // "Bin process": notify is not wired there, so the boot outcome persists
      // in state.lastBoot instead of being delivered directly.
      const binHarness = createHarness({
        pin: "1.0.0",
        channel: "beta",
        installedVersion: "1.0.0",
        extraSyncOptions: { notify: null },
      });
      binHarness.store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = { channel: "beta", version: "1.1.0", at: 1, acceptedAt: 2 };
        return s;
      });
      expect(saveOverlayFixture(binHarness.store, "1.0.0")).toEqual({ ok: true });

      const boot = binHarness.sync.syncAtBoot();
      expect(boot.action).toBe("overlay_missing");
      const persisted = binHarness.store.readState().lastBoot;
      // Entries are envelopes ({message, eventType, ...}) since the outbox
      // landed; the flush path still accepts bare-string legacy entries.
      expect(
        persisted.notifications.some((entry) =>
          String(entry?.message ?? entry).includes("missing from disk"),
        ),
      ).toBe(true);
      expect(persisted.notifiedAt).toBeFalsy();

      // "Server process": a fresh sync over the same store delivers the full
      // wording exactly once — a second flush must dedup via notifiedAt.
      const serverNotify = vi.fn(async () => {});
      const serverInsertEvent = vi.fn();
      const server = createOpenclawChannelSync({
        rootDir: binHarness.rootDir,
        openclawDir: binHarness.openclawDir,
        packageRoot: binHarness.packageRoot,
        store: binHarness.store,
        runStream: binHarness.runner,
        resolveInstallDir: () => binHarness.installDir,
        readReleaseChannel: () => "beta",
        isOnboarded: () => true,
        notify: serverNotify,
        insertEvent: serverInsertEvent,
        nowFn: () => binHarness.nowRef.now,
        logger: kSilentLogger,
      });

      await server.flushBootNotifications();
      expect(serverNotify).toHaveBeenCalledTimes(1);
      expect(String(serverNotify.mock.calls[0][0])).toContain("missing from disk");
      expect(binHarness.store.readState().lastBoot.notifiedAt).toBeTruthy();

      await server.flushBootNotifications();
      expect(serverNotify).toHaveBeenCalledTimes(1);

      // Warning-only rollback boots get the digest wording plus the
      // incident-timeline backfill (the bin process has no events DB wired).
      binHarness.store.updateState((s) => {
        s.lastBoot = {
          at: 7,
          action: "rollback",
          warnings: ["rolled back to 1.0.0"],
          notifications: [],
        };
        return s;
      });
      await server.flushBootNotifications();
      expect(serverNotify).toHaveBeenCalledTimes(2);
      const digest = String(serverNotify.mock.calls[1][0]);
      expect(digest).toContain("version notes from startup");
      expect(digest).toContain("• rolled back to 1.0.0");
      expect(serverInsertEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "channel_rollback_boot",
          status: "completed",
        }),
      );
    });

    it("writes the dev bin shim when HEAD matches, and falls back on mismatch", () => {
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

      const result = sync.syncAtBoot();

      expect(result.ok).toBe(true);
      expect(result.action).toBe("dev_shim");
      expect(store.readBinShimTarget()).toBe(
        path.join(checkoutDir, "bin", "entry.js"),
      );

      // HEAD mismatch: the checkout no longer holds the recorded commit.
      fs.writeFileSync(path.join(checkoutDir, ".git", "HEAD"), `${kOtherSha}\n`);
      const second = sync.syncAtBoot();

      expect(second.ok).toBe(true);
      expect(second.action).toBe("dev_unavailable");
      expect(store.readBinShimTarget()).toBeNull();
      expect(fs.existsSync(store.shimPath)).toBe(false);
      expect(
        second.warnings.some((warning) =>
          warning.includes("dev checkout unavailable or stale"),
        ),
      ).toBe(true);
      expect(store.readSentinel({ installDir })).toEqual(
        expect.objectContaining({ version: "1.0.0" }),
      );
    });

    it("reverts external drift to the pin snapshot and notifies", async () => {
      const { sync, store, installDir, notify } = createHarness({
        pin: "1.0.0",
        installedVersion: "9.9.9",
      });
      store.updateState((s) => {
        s.pinVersion = "1.0.0";
        return s;
      });
      expect(saveOverlayFixture(store, "1.0.0")).toEqual({ ok: true });

      const result = sync.syncAtBoot();
      await flushAsync();

      expect(result.ok).toBe(true);
      expect(result.action).toBe("drift_reverted");
      expect(store.readInstalledVersion({ installDir })).toBe("1.0.0");
      expect(
        notifyMessages(notify).some((message) =>
          message.includes("changed outside"),
        ),
      ).toBe(true);
    });

    it("reconciles a changed declared pin without a drift notification", async () => {
      const { sync, store, notify } = createHarness({
        pin: "1.0.1",
        installedVersion: "1.0.1",
      });
      store.writeState({ pinVersion: "1.0.0" });

      const result = sync.syncAtBoot();
      await flushAsync();

      expect(result.ok).toBe(true);
      expect(result.action).toBe("pin_reconciled");
      expect(store.readState().pinVersion).toBe("1.0.1");
      expect(store.hasOverlay("1.0.1")).toBe(true);
      expect(
        notifyMessages(notify).some((message) =>
          message.includes("changed outside"),
        ),
      ).toBe(false);
    });

    it("clears a stale explicit stable pick superseded by a newer pin, keeping beta picks", () => {
      // A stable pick OLDER than the new shipped pin is superseded: keeping it
      // would re-activate the older build on every boot after a self-update.
      const stable = createHarness({
        pin: "1.0.1",
        installedVersion: "1.0.1",
        sentinelVersion: "1.0.1",
      });
      stable.store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = { channel: "stable", version: "1.0.0", at: 1, acceptedAt: 2 };
        return s;
      });

      const stableResult = stable.sync.syncAtBoot();

      expect(stableResult.ok).toBe(true);
      expect(stableResult.action).toBe("pin_reconciled");
      const stableState = stable.store.readState();
      expect(stableState.pinVersion).toBe("1.0.1");
      expect(stableState.applied).toBeNull();

      // The same pin change must NOT clear an explicit beta pick.
      const beta = createHarness({
        pin: "1.0.1",
        installedVersion: "2.0.0-beta.1",
        sentinelVersion: "2.0.0-beta.1",
      });
      beta.store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = {
          channel: "beta",
          version: "2.0.0-beta.1",
          at: 1,
          acceptedAt: 2,
        };
        return s;
      });

      const betaResult = beta.sync.syncAtBoot();

      expect(betaResult.ok).toBe(true);
      const betaState = beta.store.readState();
      expect(betaState.pinVersion).toBe("1.0.1");
      expect(betaState.applied).toEqual(
        expect.objectContaining({ channel: "beta", version: "2.0.0-beta.1" }),
      );
    });

    it("recovers from a corrupted state file and notifies about the reset", async () => {
      const { sync, store, notify } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      fs.mkdirSync(path.dirname(store.statePath), { recursive: true });
      fs.writeFileSync(store.statePath, "{definitely not json", "utf8");

      let result = null;
      expect(() => {
        result = sync.syncAtBoot();
      }).not.toThrow();
      await flushAsync();

      expect(result.ok).toBe(true);
      expect(store.readState().pinVersion).toBe("1.0.0");
      expect(
        notifyMessages(notify).some(
          (message) => /corrupted/i.test(message) || /reset/i.test(message),
        ),
      ).toBe(true);
    });

    it("fails open when the store itself throws", () => {
      let threw = false;
      const { sync } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
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

      let result = null;
      expect(() => {
        result = sync.syncAtBoot();
      }).not.toThrow();

      expect(result).toEqual(
        expect.objectContaining({ ok: false, action: "failed" }),
      );
    });

    it("closes an update run interrupted by a restart and leaves finished runs alone", () => {
      // A process death mid-apply leaves lastUpdateRun.finishedAt = null
      // forever; without the boot close the UI resurrects it as a phantom
      // in-flight operation and locks every action.
      const interrupted = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      interrupted.store.updateState((s) => {
        s.lastUpdateRun = { startedAt: 1, finishedAt: null, ok: null, steps: [] };
        return s;
      });

      const result = interrupted.sync.syncAtBoot();

      expect(result.ok).toBe(true);
      expect(result.warnings).toContain(
        "closed an update run interrupted by a restart",
      );
      const run = interrupted.store.readState().lastUpdateRun;
      expect(run.finishedAt).toBe(interrupted.nowRef.now);
      expect(run.ok).toBe(false);
      expect(run.result).toEqual(
        expect.objectContaining({ ok: false, code: "interrupted" }),
      );
      expect(interrupted.store.readState().lastBoot.warnings).toContain(
        "closed an update run interrupted by a restart",
      );

      // A FINISHED run is history, not a phantom — boot must not rewrite it.
      const finished = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      const finishedRun = {
        target: { channel: "beta", version: "1.1.0", sha: null, devHead: false },
        startedAt: 1,
        finishedAt: 5,
        ok: true,
        result: { ok: true },
        steps: [],
      };
      finished.store.updateState((s) => {
        s.lastUpdateRun = JSON.parse(JSON.stringify(finishedRun));
        return s;
      });

      const finishedResult = finished.sync.syncAtBoot();

      expect(finishedResult.ok).toBe(true);
      expect(finishedResult.warnings).not.toContain(
        "closed an update run interrupted by a restart",
      );
      expect(finished.store.readState().lastUpdateRun).toEqual(finishedRun);
    });

    it("mirrors the channel into openclaw.json with auto-updates disabled", () => {
      const { sync, store, openclawDir } = createHarness({
        pin: "1.0.0",
        channel: "beta",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(
        path.join(openclawDir, "openclaw.json"),
        JSON.stringify({
          agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
          update: { channel: "stable", other: "keep", auto: { enabled: true, extra: 1 } },
        }),
      );
      store.updateState((s) => {
        s.pinVersion = "1.0.0";
        return s;
      });

      const result = sync.syncAtBoot();

      expect(result.ok).toBe(true);
      const config = JSON.parse(
        fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
      );
      expect(config.update.channel).toBe("beta");
      expect(config.update.auto.enabled).toBe(false);
      expect(config.update.auto.extra).toBe(1);
      expect(config.update.other).toBe("keep");
      expect(config.agents).toEqual({
        defaults: { model: "anthropic/claude-opus-4-8" },
      });
    });
  });

  describe("applyUpdate", () => {
    it("rejects when not onboarded, without running anything", async () => {
      const { sync, runner, installToTempDir } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        isOnboarded: () => false,
      });

      const result = await sync.applyUpdate({ channel: "beta", version: "1.1.0" });

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("not_onboarded");
      expect(runner.runStreamed).not.toHaveBeenCalled();
      expect(installToTempDir).not.toHaveBeenCalled();
    });

    it("no-ops when re-applying the active, sentinel-verified version", async () => {
      const { sync, runner, restartProcess } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.1.0",
        sentinelVersion: "1.1.0",
      });

      const result = await sync.applyUpdate({ channel: "beta", version: "1.1.0" });

      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true, noop: true, version: "1.1.0" });
      expect(runner.runStreamed).not.toHaveBeenCalled();
      expect(restartProcess).not.toHaveBeenCalled();
    });

    it("rejects blocklisted versions", async () => {
      const { sync, store, installToTempDir } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      store.addBlocklist({ id: "1.1.0", reason: "crash_loop" });

      const result = await sync.applyUpdate({ channel: "beta", version: "1.1.0" });

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("version_blocklisted");
      expect(installToTempDir).not.toHaveBeenCalled();
    });

    it("applies stable→beta: overlay + pin snapshot + record + restart", async () => {
      vi.useFakeTimers();
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      const { sync, store, restartProcess, clearVersionCache } = harness;
      expect(sync.syncAtBoot().ok).toBe(true);

      const result = await sync.applyUpdate({ channel: "beta", version: "1.1.0" });

      expect(result.status).toBe(202);
      expect(result.body.restarting).toBe(true);
      expect(store.hasOverlay("1.1.0")).toBe(true);
      expect(store.hasOverlay("1.0.0")).toBe(true); // pin snapshot
      const state = store.readState();
      expect(state.applied).toEqual(
        expect.objectContaining({ channel: "beta", version: "1.1.0" }),
      );
      expect(state.applied.acceptedAt).toBeNull();
      expect(clearVersionCache).toHaveBeenCalled();
      const stepNames = state.lastUpdateRun.steps.map((step) => step.name);
      for (const expected of ["preflight", "backup", "download", "verify", "record"]) {
        expect(stepNames).toContain(expected);
      }
      expect(restartProcess).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1500);
      expect(restartProcess).toHaveBeenCalledTimes(1);
      // The latch stays HELD after a restarting success: the process dies in
      // ~1.5s, and releasing it would let a second apply start only to be
      // killed mid-overlay-write by the pending restart.
      expect(sync.isApplyInProgress()).toBe(true);
    });

    it("blocks downgrades when the backup fails, but only warns on upgrades", async () => {
      const failBackupRunner = async (opts, fallback) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
          return { ok: false, code: 1, tail: "boom", timedOut: false };
        }
        return fallback(opts);
      };

      // Downgrade: hard gate.
      const downgrade = createHarness({
        pin: "1.2.0",
        installedVersion: "1.2.0",
        sentinelVersion: "1.2.0",
        runnerImpl: failBackupRunner,
      });
      const downgradeResult = await downgrade.sync.applyUpdate({
        channel: "stable",
        version: "1.1.0",
      });
      expect(downgradeResult.status).toBe(409);
      expect(downgradeResult.body.code).toBe("backup_failed");
      expect(downgrade.store.readState().applied).toBeNull();
      expect(downgrade.store.hasOverlay("1.1.0")).toBe(false);
      expect(downgrade.installToTempDir).not.toHaveBeenCalled();

      // Upgrade: proceeds with a warning notification.
      const upgrade = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        runnerImpl: failBackupRunner,
      });
      const upgradeResult = await upgrade.sync.applyUpdate({
        channel: "beta",
        version: "1.1.0",
      });
      await flushAsync();
      expect(upgradeResult.status).toBe(202);
      expect(
        notifyMessages(upgrade.notify).some((message) =>
          /backup failed/i.test(message),
        ),
      ).toBe(true);
    });

    it("rejects and cleans up artifacts that fail dist-shape verification", async () => {
      const { sync, store, installResults } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        installFixture: { thinking: false },
      });

      const result = await sync.applyUpdate({ channel: "beta", version: "1.1.0" });

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("verify_failed");
      expect(store.hasOverlay("1.1.0")).toBe(false);
      expect(installResults).toHaveLength(1);
      // The temp tree is removed asynchronously (fs.promises.rm on tmpDir) so
      // the outcome — no leftover artifacts — is the contract, not cleanup().
      expect(fs.existsSync(installResults[0].tmpDir)).toBe(false);
    });

    it("runs dev-head via the native updater with a stripped git env", async () => {
      process.env.GIT_ASKPASS = "/tmp/fake-askpass";
      const updateCalls = [];
      const { sync, store, rootDir } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        runnerImpl: async (opts, fallback) => {
          if (opts.command === "openclaw" && opts.args?.[0] === "update") {
            updateCalls.push(opts);
            return {
              ok: true,
              code: 0,
              tail: 'noise before\n{"status":"ok"}\nnoise after',
              timedOut: false,
            };
          }
          return fallback(opts);
        },
      });
      writeCheckoutFixture(rootDir, { sha: kDevSha });

      const result = await sync.applyUpdate({ channel: "dev", devHead: true });

      expect(result.status).toBe(202);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args).toEqual([
        "update",
        "--channel",
        "dev",
        "--json",
        "--yes",
        "--no-restart",
      ]);
      expect(updateCalls[0].env).not.toHaveProperty("GIT_ASKPASS");
      expect(updateCalls[0].env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(store.readState().applied).toEqual(
        expect.objectContaining({ channel: "dev", sha: kDevSha }),
      );

      // Updater-reported failure: nothing recorded.
      const failing = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        runnerImpl: async (opts, fallback) => {
          if (opts.command === "openclaw" && opts.args?.[0] === "update") {
            return {
              ok: true,
              code: 0,
              tail: '{"status":"error"}',
              timedOut: false,
            };
          }
          return fallback(opts);
        },
      });
      writeCheckoutFixture(failing.rootDir, { sha: kDevSha });
      const failure = await failing.sync.applyUpdate({
        channel: "dev",
        devHead: true,
      });
      expect(failure.status).toBe(409);
      expect(failure.body.code).toBe("dev_build_failed");
      expect(failing.store.readState().applied).toBeNull();
      // The step keeps ITS OWN status; the updater's status rides alongside.
      // (Live-verified clobber: a detail {status} key used to overwrite the
      // step status, recording a failed build as "unknown".)
      // Steps are append-only (running → terminal): inspect the LAST entry.
      const buildStep = failing.store
        .readState()
        .lastUpdateRun.steps.findLast((step) => step.name === "build");
      expect(buildStep.status).toBe("failed");
      expect(buildStep.updaterStatus).toBe("error");
    });

    it("parses updater status from a report larger than the default 64KB tail", async () => {
      // The real updater's final JSON report exceeds 64KB (live-verified);
      // the dev run must request a tail budget that keeps it intact.
      const bigReport = `${JSON.stringify({
        status: "ok",
        padding: "x".repeat(80 * 1024),
      })}\n`;
      const seen = { tailBytes: null };
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        runnerImpl: async (opts, fallback) => {
          if (opts.command === "openclaw" && opts.args?.[0] === "update") {
            seen.tailBytes = opts.tailBytes;
            // Simulate the runner honoring the requested tail budget.
            const budget = opts.tailBytes || 64 * 1024;
            return {
              ok: true,
              code: 0,
              tail: bigReport.slice(-budget),
              timedOut: false,
            };
          }
          return fallback(opts);
        },
      });
      writeCheckoutFixture(harness.rootDir, { sha: kDevSha });
      const applied = await harness.sync.applyUpdate({
        channel: "dev",
        devHead: true,
      });
      expect(applied.status).toBe(202);
      expect(seen.tailBytes).toBeGreaterThan(bigReport.length);
      const buildStep = harness.store
        .readState()
        .lastUpdateRun.steps.findLast((step) => step.name === "build");
      expect(buildStep.status).toBe("completed");
      expect(buildStep.updaterStatus).toBe("ok");
    });

    it("builds a pinned dev commit via fetch/checkout/install/build/doctor", async () => {
      const { sync, store, rootDir, runner } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      const checkoutDir = writeCheckoutFixture(rootDir, { sha: kDevSha });

      const result = await sync.applyUpdate({ channel: "dev", sha: kDevSha });

      expect(result.status).toBe(202);
      expect(store.readState().applied).toEqual(
        expect.objectContaining({ channel: "dev", sha: kDevSha }),
      );
      const checkoutBin = path.join(checkoutDir, "bin", "entry.js");
      const checkoutCalls = runner.runStreamed.mock.calls
        .map((call) => call[0])
        .filter((opts) => opts.cwd === checkoutDir)
        .map((opts) => [opts.command, opts.args]);
      expect(checkoutCalls).toEqual([
        ["git", ["fetch", "--all", "--tags"]],
        ["git", ["checkout", "--detach", kDevSha]],
        ["pnpm", ["install"]],
        ["pnpm", ["build"]],
        ["node", [checkoutBin, "doctor"]],
      ]);

      // pnpm build failure: nothing recorded.
      const failing = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        runnerImpl: async (opts, fallback) => {
          if (opts.command === "pnpm" && opts.args?.[0] === "build") {
            return { ok: false, code: 1, tail: "build exploded", timedOut: false };
          }
          return fallback(opts);
        },
      });
      writeCheckoutFixture(failing.rootDir, { sha: kDevSha });
      const failure = await failing.sync.applyUpdate({
        channel: "dev",
        sha: kDevSha,
      });
      expect(failure.status).toBe(409);
      expect(failure.body.code).toBe("dev_build_failed");
      expect(failing.store.readState().applied).toBeNull();
    });

    it("rejects versions whose engines.node the current runtime cannot satisfy", async () => {
      const releases = {
        getCatalog: vi.fn(async () => ({
          stable: [{ version: "1.1.0", engines: { node: ">=99" } }],
          beta: [],
        })),
      };
      const { sync, store, installToTempDir } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        releases,
      });

      const result = await sync.applyUpdate({
        channel: "stable",
        version: "1.1.0",
      });

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("engines_unsupported");
      expect(installToTempDir).not.toHaveBeenCalled();
      expect(store.readState().applied).toBeNull();
    });

    it("probes the downloaded binary with a minimal env carrying no gateway secrets", async () => {
      const previousSecret = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "sekrit";
      try {
        const { sync, runner } = createHarness({
          pin: "1.0.0",
          installedVersion: "1.0.0",
          sentinelVersion: "1.0.0",
        });

        const result = await sync.applyUpdate({
          channel: "beta",
          version: "1.1.0",
        });

        expect(result.status).toBe(202);
        const probe = runner.runStreamed.mock.calls
          .map((call) => call[0])
          .find(
            (opts) => opts.command === "node" && opts.args?.[1] === "--version",
          );
        expect(probe).toBeTruthy();
        // Verification exists because the code is not trusted yet: it must not
        // inherit provider API keys, but still needs PATH to run node.
        expect(probe.env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(probe.env.PATH).toBeTruthy();
      } finally {
        if (previousSecret === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = previousSecret;
      }
    });

    it("does not noop a recorded dev sha whose checkout is missing from disk", async () => {
      const { sync, store, runner } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = { channel: "dev", sha: kDevSha, at: 1, acceptedAt: null };
        return s;
      });
      // No checkout fixture on disk: recorded intent alone must not noop —
      // after a boot-time pin fallback the build has to be rebuilt.

      const result = await sync.applyUpdate({ channel: "dev", sha: kDevSha });

      expect(result.body.noop).toBeUndefined();
      expect(result.status).not.toBe(200);
      // It got past the noop check into the dev pipeline: the toolchain
      // preflight probe ran.
      const commands = runner.runStreamed.mock.calls.map((call) => [
        call[0].command,
        call[0].args?.[0],
      ]);
      expect(commands).toContainEqual(["git", "--version"]);
    });

    it("rejects a second apply while one is in flight", async () => {
      let releaseBackup;
      const backupGate = new Promise((resolve) => {
        releaseBackup = resolve;
      });
      const { sync } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        runnerImpl: async (opts, fallback) => {
          if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
            await backupGate;
            return { ok: true, code: 0, tail: "", timedOut: false };
          }
          return fallback(opts);
        },
      });

      const firstApply = sync.applyUpdate({ channel: "beta", version: "1.1.0" });
      expect(sync.isApplyInProgress()).toBe(true);

      const second = await sync.applyUpdate({ channel: "beta", version: "1.1.0" });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe("operation_in_progress");

      releaseBackup();
      const first = await firstApply;
      expect(first.status).toBe(202);
      // Restart is imminent — the latch stays held so nothing can start work
      // that the restart would kill mid-write.
      expect(sync.isApplyInProgress()).toBe(true);
      const third = await sync.applyUpdate({ channel: "beta", version: "1.1.0" });
      expect(third.status).toBe(409);
      expect(third.body.code).toBe("operation_in_progress");
    });

    it("rejects applies during a self-update and brackets applies in a managed operation", async () => {
      const begin = vi.fn();
      const end = vi.fn();
      let selfUpdate = true;
      const { sync, store, installToTempDir } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        extraSyncOptions: {
          isSelfUpdateInProgress: () => selfUpdate,
          watchdogManagedOperation: { begin, end },
        },
      });

      // A restartProcess() from the AlphaClaw self-updater mid-overlay-write
      // would corrupt the store: the apply must not even start.
      const rejected = await sync.applyUpdate({ channel: "beta", version: "1.1.0" });
      expect(rejected.status).toBe(409);
      expect(rejected.body.code).toBe("self_update_in_progress");
      expect(begin).not.toHaveBeenCalled();
      expect(installToTempDir).not.toHaveBeenCalled();

      // Gateway exits during a version swap must not feed crash accounting:
      // begin() brackets the run. On a RESTARTING success the latch stays held
      // (end() skipped) — the swap ends at the process restart, and releasing
      // early would let an old-gateway exit blocklist the never-run version.
      selfUpdate = false;
      const applied = await sync.applyUpdate({ channel: "beta", version: "1.1.0" });
      expect(applied.status).toBe(202);
      expect(begin).toHaveBeenCalledTimes(1);
      expect(end).not.toHaveBeenCalled();

      // The restarting success holds the apply latch too — a follow-up apply
      // in the pre-restart window is refused outright.
      const inWindow = await sync.applyUpdate({ channel: "beta", version: "1.3.0" });
      expect(inWindow.status).toBe(409);
      expect(inWindow.body.code).toBe("operation_in_progress");
      expect(begin).toHaveBeenCalledTimes(1);

      // end() must also fire on FAILED applies (fresh harness — no held
      // latch), or crash accounting would stay suspended forever.
      const failBegin = vi.fn();
      const failEnd = vi.fn();
      const failing = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        extraSyncOptions: {
          watchdogManagedOperation: { begin: failBegin, end: failEnd },
        },
      });
      failing.store.addBlocklist({ id: "1.3.0", reason: "crash_loop", exitCode: 1 });
      const failed = await failing.sync.applyUpdate({
        channel: "beta",
        version: "1.3.0",
      });
      expect(failed.status).toBe(409);
      expect(failed.body.code).toBe("version_blocklisted");
      expect(failBegin).toHaveBeenCalledTimes(1);
      expect(failEnd).toHaveBeenCalledTimes(1);
    });

    it("self-update gate: blocks with a hint, fails open on probe errors, defaults open", async () => {
      // Gate closed: full actionable envelope, no side effects, no latch.
      const gated = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        extraSyncOptions: { isSelfUpdateInProgress: () => true },
      });
      const rejected = await gated.sync.applyUpdate({
        channel: "beta",
        version: "1.1.0",
      });
      expect(rejected.status).toBe(409);
      expect(rejected.body.code).toBe("self_update_in_progress");
      // The envelope must tell the operator what to do, not just what broke.
      expect(typeof rejected.body.hint).toBe("string");
      expect(rejected.body.hint.length).toBeGreaterThan(0);
      // The gate fires before the apply latch and before any work starts.
      expect(gated.sync.isApplyInProgress()).toBe(false);
      expect(gated.runner.runStreamed).not.toHaveBeenCalled();
      expect(gated.installToTempDir).not.toHaveBeenCalled();
      expect(gated.store.readState().lastUpdateRun).toBeNull();

      // A THROWING probe fails open: a broken self-update service must not
      // permanently lock OpenClaw version changes.
      const throwing = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        extraSyncOptions: {
          isSelfUpdateInProgress: () => {
            throw new Error("self-update probe exploded");
          },
        },
      });
      const throwingResult = await throwing.sync.applyUpdate({
        channel: "beta",
        version: "1.1.0",
      });
      expect(throwingResult.status).toBe(202);
      expect(throwingResult.body.restarting).toBe(true);

      // Default wiring (option omitted): applies proceed normally.
      const defaulted = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      const defaultedResult = await defaulted.sync.applyUpdate({
        channel: "beta",
        version: "1.1.0",
      });
      expect(defaultedResult.status).toBe(202);
      expect(defaultedResult.body.restarting).toBe(true);
    });

    it("holds the managed latch through a restarting success; releases it on failure", async () => {
      // Success: one begin, one end.
      const okBegin = vi.fn();
      const okEnd = vi.fn();
      const ok = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        extraSyncOptions: {
          watchdogManagedOperation: { begin: okBegin, end: okEnd },
        },
      });
      const applied = await ok.sync.applyUpdate({ channel: "beta", version: "1.1.0" });
      expect(applied.status).toBe(202);
      expect(okBegin).toHaveBeenCalledTimes(1);
      // Restarting success: the latch is HELD until the process restart lands
      // (the latch dies with the process; releasing early re-arms rollback
      // against a version that never ran).
      expect(okEnd).not.toHaveBeenCalled();

      // Mid-run failure (verify rejects a bad --version): end() must STILL
      // fire exactly once, or crash accounting stays suspended forever.
      const failBegin = vi.fn();
      const failEnd = vi.fn();
      const failing = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        runnerImpl: async (opts, fallback) => {
          if (opts.command === "node" && opts.args?.[1] === "--version") {
            return { ok: true, code: 0, tail: "9.9.9\n", timedOut: false };
          }
          return fallback(opts);
        },
        extraSyncOptions: {
          watchdogManagedOperation: { begin: failBegin, end: failEnd },
        },
      });
      const failed = await failing.sync.applyUpdate({
        channel: "beta",
        version: "1.1.0",
      });
      expect(failed.status).toBe(409);
      expect(failed.body.code).toBe("verify_failed");
      expect(failBegin).toHaveBeenCalledTimes(1);
      expect(failEnd).toHaveBeenCalledTimes(1);
      expect(failing.sync.isApplyInProgress()).toBe(false);
    });
  });

  describe("codex-round hardening", () => {
    it("re-applies a blocklisted sha via dev-head only after Clear (post-build recheck)", async () => {
      const { sync, store, rootDir } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      writeCheckoutFixture(rootDir, { sha: kDevSha });
      // "Latest dev" carries no sha, so the pre-build blocklist gate cannot
      // fire — the RESOLVED sha must be rechecked after the build.
      store.addBlocklist({ id: kDevSha, reason: "crash_loop", exitCode: 1 });
      const result = await sync.applyUpdate({ channel: "dev", devHead: true });
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("version_blocklisted");
      expect(store.readState().applied).toBeNull();
    });

    it("hard-gates dev applies on a verified backup like downgrades", async () => {
      const { sync, rootDir, store } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        runnerImpl: async (opts, fallback) => {
          if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
            return { ok: false, code: 1, tail: "boom", timedOut: false };
          }
          return fallback(opts);
        },
      });
      writeCheckoutFixture(rootDir, { sha: kDevSha });
      const result = await sync.applyUpdate({ channel: "dev", devHead: true });
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(store.readState().applied).toBeNull();
    });

    it("aborts the apply when the pin rollback floor cannot be persisted", async () => {
      const { sync, rootDir, store } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      store.updateState((s) => {
        s.pinVersion = "1.0.0";
        return s;
      });
      // Poison the overlay store: a FILE where the store dir belongs makes
      // the pin snapshot fail while everything else would proceed.
      fs.writeFileSync(path.join(rootDir, "openclaw-overlay"), "not a dir");
      const result = await sync.applyUpdate({ channel: "beta", version: "1.1.0" });
      expect(result.status).toBe(507);
      expect(result.body.code).toBe("pin_snapshot_failed");
    });

    it("re-activates a gutted pin tree from its overlay instead of blessing it", async () => {
      const { sync, store, installDir } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: null,
      });
      store.updateState((s) => {
        s.pinVersion = "1.0.0";
        return s;
      });
      expect(saveOverlayFixture(store, "1.0.0")).toEqual({ ok: true });
      // Gut the live tree: plausible package.json, no bin/dist (mid-copy crash).
      const packageDir = path.join(installDir, "node_modules", "openclaw");
      fs.rmSync(path.join(packageDir, "bin"), { recursive: true, force: true });
      fs.rmSync(path.join(packageDir, "dist"), { recursive: true, force: true });

      const result = sync.syncAtBoot();
      expect(result.ok).toBe(true);
      // The overlay copy restored the full tree; the sentinel certifies a
      // COMPLETE tree, never the gutted one.
      expect(fs.existsSync(path.join(packageDir, "dist"))).toBe(true);
      expect(store.readSentinel({ installDir })?.version).toBe("1.0.0");
    });

    it("keeps OPENCLAW secret-shaped vars out of the dev build env", async () => {
      const seen = [];
      const { sync, rootDir } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        extraSyncOptions: {
          gatewayEnv: () => ({
            ...process.env,
            OPENCLAW_HOME: "/data",
            OPENCLAW_GATEWAY_TOKEN: "gw-secret",
            OPENCLAW_TWITCH_ACCESS_TOKEN: "twitch-secret",
          }),
        },
        runnerImpl: async (opts, fallback) => {
          if (opts.command === "openclaw" && opts.args?.[0] === "update") {
            seen.push(opts.env);
            return {
              ok: true,
              code: 0,
              tail: '{"status":"ok"}',
              timedOut: false,
            };
          }
          return fallback(opts);
        },
      });
      writeCheckoutFixture(rootDir, { sha: kDevSha });
      const result = await sync.applyUpdate({ channel: "dev", devHead: true });
      expect(result.status).toBe(202);
      expect(seen).toHaveLength(1);
      expect(seen[0].OPENCLAW_HOME).toBe("/data");
      expect(seen[0].OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
      expect(seen[0].OPENCLAW_TWITCH_ACCESS_TOKEN).toBeUndefined();
    });
  });

  describe("rollback and acceptance", () => {
    it("latches manual intervention when the rollback marker cannot be written", async () => {
      const { sync, restartProcess, watchdogLatch, notify, store } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.1.0",
        sentinelVersion: "1.1.0",
        storeWrap: (store) => ({
          ...store,
          writeMarker: vi.fn(() => ({ ok: false, error: "ENOSPC" })),
        }),
      });
      store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = { channel: "beta", version: "1.1.0", at: 1, acceptedAt: null };
        return s;
      });

      const result = sync.requestChannelRollback({
        reason: "crash_loop",
        exitCode: 1,
      });
      await flushAsync();

      expect(result.ok).toBe(false);
      expect(result.code).toBe("rollback_marker_write_failed");
      expect(watchdogLatch).toHaveBeenCalledWith({
        reason: "rollback_marker_write_failed",
      });
      expect(restartProcess).not.toHaveBeenCalled();
      expect(
        notifyMessages(notify).some((message) =>
          message.includes("manual action"),
        ),
      ).toBe(true);
    });

    it("rolls dev back to the pin and packages back to last-known-good", async () => {
      vi.useFakeTimers();
      const dev = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      dev.store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = { channel: "dev", sha: kDevSha, at: 1, acceptedAt: null };
        return s;
      });

      const devResult = dev.sync.requestChannelRollback({
        reason: "crash_loop",
        exitCode: 1,
      });
      expect(devResult.ok).toBe(true);
      expect(devResult.target).toEqual({ kind: "pin" });
      expect(dev.store.readMarker().target).toEqual({ kind: "pin" });
      expect(dev.store.isBlocklisted(kDevSha)).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(dev.restartProcess).toHaveBeenCalledTimes(1);
      await flushAsync();
      expect(dev.notify).toHaveBeenCalled();

      const beta = createHarness({
        pin: "1.0.0",
        installedVersion: "1.2.0",
        sentinelVersion: "1.2.0",
      });
      beta.store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = { channel: "beta", version: "1.2.0", at: 1, acceptedAt: null };
        s.lastKnownGood.package = "1.1.0";
        return s;
      });
      expect(saveOverlayFixture(beta.store, "1.1.0")).toEqual({ ok: true });

      const betaResult = beta.sync.requestChannelRollback({ reason: "degraded" });
      expect(betaResult.ok).toBe(true);
      expect(betaResult.target).toEqual({
        kind: "package",
        channel: "beta",
        version: "1.1.0",
      });
      expect(beta.store.readMarker().target).toEqual({
        kind: "package",
        channel: "beta",
        version: "1.1.0",
      });
      expect(beta.store.isBlocklisted("1.2.0")).toBe(true);
    });

    it("rescues a rollback to last-known-good when the pin tree is unrecoverable", () => {
      vi.useFakeTimers();
      // VPS case: the pin was bumped by a self-update while a dev build was
      // active — no pin overlay exists and the installed tree is not the pin.
      // A pin rollback could never materialize; prefer the usable LKG overlay.
      const harness = createHarness({
        pin: "1.0.0",
        channel: "dev",
        installedVersion: "1.2.0",
      });
      harness.store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = { channel: "dev", sha: kDevSha, at: 1, acceptedAt: null };
        s.lastKnownGood.package = "1.1.0";
        return s;
      });
      expect(saveOverlayFixture(harness.store, "1.1.0")).toEqual({ ok: true });

      const result = harness.sync.requestChannelRollback({
        reason: "crash_loop",
        exitCode: 1,
      });

      expect(result.ok).toBe(true);
      expect(result.target).toEqual({
        kind: "package",
        channel: "stable",
        version: "1.1.0",
      });
      expect(harness.store.readMarker().target).toEqual({
        kind: "package",
        channel: "stable",
        version: "1.1.0",
      });
      expect(harness.store.isBlocklisted(kDevSha)).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(harness.restartProcess).toHaveBeenCalledTimes(1);

      // A blocklisted LKG is NOT usable — the target stays the pin
      // (best-effort) instead of re-applying another known-bad build.
      const blocked = createHarness({
        pin: "1.0.0",
        channel: "dev",
        installedVersion: "1.2.0",
      });
      blocked.store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = { channel: "dev", sha: kDevSha, at: 1, acceptedAt: null };
        s.lastKnownGood.package = "1.1.0";
        return s;
      });
      expect(saveOverlayFixture(blocked.store, "1.1.0")).toEqual({ ok: true });
      blocked.store.addBlocklist({ id: "1.1.0", reason: "crash_loop", exitCode: 1 });

      const blockedResult = blocked.sync.requestChannelRollback({
        reason: "crash_loop",
        exitCode: 1,
      });
      expect(blockedResult.ok).toBe(true);
      expect(blockedResult.target).toEqual({ kind: "pin" });
    });

    it("defers the rollback restart until an in-flight apply settles", async () => {
      vi.useFakeTimers();
      let releaseBackup;
      const backupGate = new Promise((resolve) => {
        releaseBackup = resolve;
      });
      const { sync, store, restartProcess } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        runnerImpl: async (opts, fallback) => {
          if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
            await backupGate;
            return { ok: true, code: 0, tail: "", timedOut: false };
          }
          return fallback(opts);
        },
      });
      store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = { channel: "beta", version: "1.2.0", at: 1, acceptedAt: null };
        return s;
      });

      const applyPromise = sync.applyUpdate({ channel: "beta", version: "1.1.0" });
      await flushAsync();
      expect(sync.isApplyInProgress()).toBe(true);

      // A restartProcess() mid-overlay-write would corrupt the store: the
      // marker lands, but the restart waits for the apply to settle.
      const rollback = sync.requestChannelRollback({
        reason: "crash_loop",
        exitCode: 1,
      });
      expect(rollback.ok).toBe(true);
      expect(store.readMarker()).toBeTruthy();
      vi.advanceTimersByTime(5000);
      expect(restartProcess).not.toHaveBeenCalled();

      releaseBackup();
      const applied = await applyPromise;
      expect(applied.status).toBe(202);
      // The SUCCESSFUL apply supersedes the rollback: the crashing build is
      // blocklisted and no longer selected, so the stale marker is cleared and
      // only the apply's own restart (1.5s) fires — the marker must not roll
      // back the fresh version at the next boot.
      expect(store.readMarker()).toBeNull();
      vi.advanceTimersByTime(1000);
      expect(restartProcess).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);
      expect(restartProcess).toHaveBeenCalledTimes(1);
    });

    it("runs the deferred rollback restart when the in-flight apply FAILS", async () => {
      vi.useFakeTimers();
      let failBackup;
      const backupGate = new Promise((resolve) => {
        failBackup = resolve;
      });
      // installedVersion 1.2.0 -> target 1.1.0 is a DOWNGRADE, so the failed
      // backup hard-aborts the apply.
      const { sync, store, restartProcess } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.2.0",
        sentinelVersion: "1.2.0",
        runnerImpl: async (opts, fallback) => {
          if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
            await backupGate;
            return { ok: false, code: 1, tail: "backup failed", timedOut: false };
          }
          return fallback(opts);
        },
      });
      store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = { channel: "beta", version: "1.2.0", at: 1, acceptedAt: null };
        return s;
      });

      const applyPromise = sync.applyUpdate({ channel: "beta", version: "1.1.0" });
      await flushAsync();
      expect(sync.isApplyInProgress()).toBe(true);
      expect(
        sync.requestChannelRollback({ reason: "crash_loop", exitCode: 1 }).ok,
      ).toBe(true);
      expect(restartProcess).not.toHaveBeenCalled();

      failBackup();
      const applied = await applyPromise;
      expect(applied.status).toBe(409);
      // The apply failed, so the rollback still owns recovery: marker stays,
      // deferred restart fires 1s after the apply settles.
      expect(store.readMarker()).toBeTruthy();
      vi.advanceTimersByTime(1000);
      expect(restartProcess).toHaveBeenCalledTimes(1);
    });

    it("accepts a build only after the health hold elapses, resetting on unhealthy", async () => {
      const { sync, store, nowRef, notify } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.1.0",
        sentinelVersion: "1.1.0",
        acceptanceHoldMs: 5000,
      });
      store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = { channel: "beta", version: "1.1.0", at: 1, acceptedAt: null };
        return s;
      });

      sync.onGatewayHealthy();
      expect(store.readState().applied.acceptedAt).toBeNull();

      // Unhealthy resets the hold: a later healthy check starts over.
      sync.onGatewayUnhealthy();
      nowRef.now += 6000;
      sync.onGatewayHealthy();
      expect(store.readState().applied.acceptedAt).toBeNull();

      nowRef.now += 5000;
      sync.onGatewayHealthy();
      await flushAsync();

      const state = store.readState();
      expect(state.applied.acceptedAt).toBe(nowRef.now);
      expect(state.lastKnownGood.package).toBe("1.1.0");
      expect(
        notifyMessages(notify).some((message) => /healthy/i.test(message)),
      ).toBe(true);
    });

    it("markGoodNow without an applied build fails; getChannelInfo tracks the window", async () => {
      const empty = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      expect(empty.sync.markGoodNow()).toEqual(
        expect.objectContaining({ ok: false, code: "nothing_to_accept" }),
      );

      const { sync, store, nowRef } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        stabilizationWindowMs: 10_000,
      });
      expect(sync.syncAtBoot().ok).toBe(true);
      const applied = await sync.applyUpdate({ channel: "beta", version: "1.1.0" });
      expect(applied.status).toBe(202);
      expect(sync.getChannelInfo().inStabilizationWindow).toBe(true);
      expect(sync.getChannelInfo().isPin).toBe(false);

      // An AUTO acceptance keeps the 24h window armed (OV4)…
      expect(sync.markGoodNow({ source: "acceptance" }).ok).toBe(true);
      expect(sync.getChannelInfo().inStabilizationWindow).toBe(true);

      // …until the window elapses.
      nowRef.now += 10_001;
      expect(sync.getChannelInfo().inStabilizationWindow).toBe(false);
      expect(store.readState().lastKnownGood.package).toBe("1.1.0");

      // An explicit "Mark as good now" disarms the window immediately (U7).
      const manual = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        stabilizationWindowMs: 10_000,
      });
      expect(manual.sync.syncAtBoot().ok).toBe(true);
      expect(
        (await manual.sync.applyUpdate({ channel: "beta", version: "1.1.0" }))
          .status,
      ).toBe(202);
      expect(manual.sync.getChannelInfo().inStabilizationWindow).toBe(true);
      expect(manual.sync.markGoodNow().ok).toBe(true);
      expect(manual.sync.getChannelInfo().inStabilizationWindow).toBe(false);
      expect(manual.store.readState().applied.acceptedSource).toBe("manual");
    });
  });

  describe("enginesSatisfied", () => {
    const { enginesSatisfied } = require("../../lib/server/openclaw-channel-sync");

    it("gates on a >=major floor and passes everything unparseable or empty", () => {
      expect(enginesSatisfied(">=22", "20.0.0")).toBe(false);
      expect(enginesSatisfied(">=22", "22.1.0")).toBe(true);
      // No >=N floor to enforce: warn-only posture, like npm engines.
      expect(enginesSatisfied("^20 || ~18.17", "20.0.0")).toBe(true);
      expect(enginesSatisfied("", "20.0.0")).toBe(true);
      expect(enginesSatisfied(undefined, "20.0.0")).toBe(true);
    });
  });

  it("resolves the declared pin from the real package root by default", () => {
    // Regression: kPackageRoot is lib/ (no package.json); the default must be
    // the consumer app root or pinVersion stays null and the rollback floor
    // (pin snapshot) is never created. Caught live by the devex drill.
    const { readDeclaredPin } = require("../../lib/server/openclaw-channel-sync");
    const pin = readDeclaredPin();
    expect(typeof pin).toBe("string");
    expect(pin.length).toBeGreaterThan(0);
    expect(pin).toBe(
      require("../../package.json").dependencies.openclaw,
    );
  });
});
