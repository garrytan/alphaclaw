const crypto = require("crypto");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
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

// The usable-backup check (WI-6.1) runs `gzip -t` and extracts manifest.json
// through the same runner seam; the stub answers with a manifest that lists
// the global state DB (what a real `backup create` archive carries).
const kStubManifestTail = `${JSON.stringify({
  schemaVersion: 1,
  assets: [{ kind: "sqlite", sourcePath: "/data/.openclaw/state/openclaw.sqlite", archivePath: "state/openclaw.sqlite" }],
})}\n`;
const answerArchiveTool = (opts) => {
  if (opts.command === "gzip" && opts.args?.[0] === "-t") {
    return { ok: true, code: 0, tail: "", timedOut: false };
  }
  if (opts.command === "tar" && opts.args?.[0] === "-xzOf") {
    return { ok: true, code: 0, tail: kStubManifestTail, timedOut: false };
  }
  return null;
};

// Default runner: everything succeeds; `node <bin> --version` reports the
// version of the package.json two levels above the bin, like the real CLI.
const defaultRunnerImpl = async (opts) => {
  const archiveTool = answerArchiveTool(opts);
  if (archiveTool) return archiveTool;
  // Faithful model of the real CLI's --output contract (verified against the
  // pinned openclaw 2026.7.1-2 source, dist/backup-create resolveOutputPath):
  // an existing directory (or trailing separator) gets a timestamped archive
  // INSIDE it; any other path IS the archive file, refused if it already
  // exists; the parent is mkdir -p'd. The old stub only modeled the
  // directory branch — which is exactly why issues #7/#9 were invisible.
  if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
    const outIdx = opts.args.indexOf("--output");
    const out = outIdx >= 0 ? opts.args[outIdx + 1] : null;
    if (out) {
      try {
        const isDirTarget =
          out.endsWith(path.sep) ||
          (fs.existsSync(out) && fs.statSync(out).isDirectory());
        const outFile = isDirTarget
          ? path.join(out, `${crypto.randomUUID()}-openclaw-backup.tar.gz`)
          : out;
        if (fs.existsSync(outFile)) {
          return {
            ok: false,
            code: 1,
            tail: `Error: Refusing to overwrite existing backup archive: ${outFile}\n`,
            timedOut: false,
          };
        }
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, "stub backup archive\n");
        return {
          ok: true,
          code: 0,
          tail: `Backup archive: ${outFile}\nCreated ${outFile}\nArchive verification: passed\n`,
          timedOut: false,
        };
      } catch (error) {
        // e.g. ENOTDIR when a legacy archive file blocks the parent path.
        return {
          ok: false,
          code: 1,
          tail: `Error: ${error.message}\n`,
          timedOut: false,
        };
      }
    }
    return { ok: true, code: 0, tail: "backup verified\n", timedOut: false };
  }
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
      // The claim carries the writer's identity (this host, this process's
      // start time) — that is what makes it "the same process", not the pid.
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        stdio: "ignore",
      });
      try {
        fs.writeFileSync(
          store.serverPidPath,
          JSON.stringify({
            pid: child.pid,
            at: 1,
            host: require("os").hostname(),
            startTicks: store.readProcessStartTicks(child.pid),
          }),
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

    it("a stale pidfile from a REPLACED container does not block the boot sync (durability leg A regression)", async () => {
      // The pidfile lives on the volume and outlives its writer. In a fresh
      // container the same small pid is alive again as an unrelated process
      // (placeholder child / gateway launcher). Trusting the pid alone
      // skipped the sync, so the applied overlay never activated and the old
      // pin crash-looped against the migrated state DB.
      const { spawn } = require("child_process");
      const { sync, store } = createHarness({
        pin: "1.0.0",
        channel: "beta",
        installedVersion: "1.0.0",
      });
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        stdio: "ignore",
      });
      try {
        fs.mkdirSync(path.dirname(store.serverPidPath), { recursive: true });
        fs.writeFileSync(
          store.serverPidPath,
          JSON.stringify({
            pid: child.pid, // alive HERE — but the claim came from another container
            at: 1,
            host: "0ldc0ntainer1d",
            startTicks: store.readProcessStartTicks(child.pid),
          }),
        );
        const result = sync.syncAtBoot();
        expect(result.action).not.toBe("skipped_concurrent");
        // The boot re-claimed the pidfile for this process.
        const claim = JSON.parse(fs.readFileSync(store.serverPidPath, "utf8"));
        expect(claim.pid).toBe(process.pid);
        expect(claim.host).toBe(require("os").hostname());
      } finally {
        child.kill("SIGKILL");
      }
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

    it("notifies when the pin is re-activated from its overlay after an interrupted activation", async () => {
      const { sync, store, installDir, notify } = createHarness({
        pin: "1.0.0",
        channel: "stable",
        installedVersion: "1.0.0",
        // No sentinel: a crash mid-copy left a plausible package.json…
      });
      store.updateState((s) => {
        s.pinVersion = "1.0.0";
        return s;
      });
      expect(saveOverlayFixture(store, "1.0.0")).toEqual({ ok: true });
      // …over a gutted tree: remove dist so pinTreeLooksComplete() is false.
      fs.rmSync(path.join(installDir, "node_modules", "openclaw", "dist"), {
        recursive: true,
        force: true,
      });

      const result = sync.syncAtBoot();
      await flushAsync();

      expect(result.ok).toBe(true);
      expect(store.readSentinel({ installDir })).toEqual(
        expect.objectContaining({ version: "1.0.0" }),
      );
      // Previously a warnings.push that flushBootNotifications drops whenever
      // any notification is queued the same boot — now a real notice with a
      // day-bucketed dedupe id (boot loops collapse into one alert).
      const call = notify.mock.calls.find((entry) =>
        String(entry?.[0] || "").includes(
          "re-activated from its overlay after an interrupted activation",
        ),
      );
      expect(call).toBeTruthy();
      expect(call[1]).toEqual(
        expect.objectContaining({ eventType: "recovery" }),
      );
      expect(call[1].id).toMatch(/^pin-reactivated-1\.0\.0-\d{8}$/);
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

    it("getChannelInfo reports stateCorrupted while the state file is unparseable, and clears it once the store recovers", async () => {
      const { sync, store } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      fs.mkdirSync(path.dirname(store.statePath), { recursive: true });
      fs.writeFileSync(store.statePath, "{definitely not json", "utf8");
      // The hold gates read this flag: a corrupted file must never read as
      // "no hold".
      const info = sync.getChannelInfo();
      expect(info.stateCorrupted).toBe(true);
      expect(info.gatewayHold).toBeNull();

      sync.syncAtBoot();
      await flushAsync();
      expect(sync.getChannelInfo().stateCorrupted).toBe(false);
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

    it("409s gateway_busy while a settings migration holds the lifecycle lock (adv-5)", async () => {
      // A reconcile_retry/boot holder can legitimately run a 30-min doctor;
      // an apply's terminal restartProcess() would SIGKILL that migration
      // mid-write. Soft-gate applies never touch the lock, so the entry gate
      // is the only protection.
      const activeOp = { value: { kind: "reconcile_retry", startedAt: 1 } };
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        extraSyncOptions: {
          getActiveGatewayOperation: () => activeOp.value,
        },
      });
      const target = { channel: "beta", version: "1.1.0-beta.1" };

      const retryBusy = await harness.sync.applyUpdate(target);
      expect(retryBusy.status).toBe(409);
      expect(retryBusy.body.code).toBe("gateway_busy");
      expect(retryBusy.body.message).toMatch(/settings migration is running/i);
      expect(harness.runner.runStreamed).not.toHaveBeenCalled();
      expect(harness.installToTempDir).not.toHaveBeenCalled();

      activeOp.value = { kind: "boot", startedAt: 1 };
      const bootBusy = await harness.sync.applyUpdate(target);
      expect(bootBusy.status).toBe(409);
      expect(bootBusy.body.code).toBe("gateway_busy");

      // Non-migration holders keep the generic gateway-operation envelope.
      activeOp.value = { kind: "restart", startedAt: 1 };
      const restartBusy = await harness.sync.applyUpdate(target);
      expect(restartBusy.status).toBe(409);
      expect(restartBusy.body.code).toBe("gateway_operation_in_progress");

      // Lock released → the same apply proceeds.
      activeOp.value = null;
      const proceeded = await harness.sync.applyUpdate(target);
      expect(proceeded.status).toBe(202);
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

    it("persists the structured db-preflight verdict into the run record (issue #20 boot hint)", async () => {
      const { DatabaseSync } = require("node:sqlite");
      const preflightRunner = async (opts, fallback) => {
        if (Array.isArray(opts.args) && opts.args.includes("preflight")) {
          return {
            ok: true,
            code: 0,
            tail: '{"status":"migration-required","foundVersion":1,"targetVersion":12}\n',
            timedOut: false,
          };
        }
        return fallback(opts);
      };
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        runnerImpl: preflightRunner,
      });
      // A real state DB: the preflight snapshots it with VACUUM INTO before
      // probing, and dbSizesBytes must reflect it.
      const stateDir = path.join(harness.openclawDir, "state");
      fs.mkdirSync(stateDir, { recursive: true });
      const db = new DatabaseSync(path.join(stateDir, "openclaw.sqlite"));
      db.exec("CREATE TABLE t(x INTEGER)");
      db.close();

      const result = await harness.sync.applyUpdate({
        channel: "beta",
        version: "1.1.0",
      });

      expect(result.status).toBe(202);
      const runsDir = path.join(harness.openclawDir, ".alphaclaw", "runs");
      const records = fs
        .readdirSync(runsDir)
        .map((name) => JSON.parse(fs.readFileSync(path.join(runsDir, name), "utf8")));
      expect(records).toHaveLength(1);
      const [record] = records;
      // The verdict survives the restart: boot sizes its migration budget
      // from it and runs doctor without re-probing the live DBs.
      expect(record.state).toBe("restart_expected");
      expect(record.dbPreflight).toEqual(
        expect.objectContaining({
          migrationRequired: true,
          foundVersion: 1,
          targetVersion: 12,
        }),
      );
      expect(record.dbPreflight.dbSizesBytes).toBeGreaterThan(0);
      // The step timeline names the consequence for the operator.
      expect(record.steps).toContainEqual(
        expect.objectContaining({
          name: "db-preflight",
          status: "completed",
          detail: "schema migration will run at the next start",
        }),
      );
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
      // The CLI's actual last output line reaches the user-facing message —
      // the old catch-all claimed every failure "failed to verify" (#7).
      expect(downgradeResult.body.message).toMatch(/boom/);
      expect(downgradeResult.body.message).not.toMatch(/failed to verify/i);
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

    // Issues #7/#9: the backup step passed a fixed path as --output without
    // creating the directory — the CLI wrote the archive AS that path (#9's
    // false "no backup artifact produced"), then refused to overwrite it on
    // every later run (#7's permanent backup_failed).
    describe("backup step (issues #7/#9)", () => {
      const kArchiveClass = /openclaw-backup.*\.tar\.gz$/;
      const backupsDirOf = (harness) =>
        path.join(harness.rootDir, "backups", "openclaw");
      const archiveNames = (dir) =>
        fs.readdirSync(dir).filter((name) => kArchiveClass.test(name));
      const hardGateTarget = { channel: "beta", version: "1.1.0-beta.1" };
      const mkHarness = (options = {}) =>
        createHarness({
          pin: "1.0.0",
          installedVersion: "1.0.0",
          sentinelVersion: "1.0.0",
          ...options,
        });

      // X5: the 0600 chmod is best-effort (network filesystems may refuse
      // modes) but was silent — a 0644 archive recorded as verified with no
      // trace. The record now carries mode/modeError, the step warns, and the
      // operator is notified; the normal path records mode "0600" + mtime.
      it("records mode '0600' and the archive's mtime on a normal publish (the fence's record-vs-disk facts)", async () => {
        const harness = mkHarness();
        const result = await harness.sync.applyUpdate(hardGateTarget);
        expect(result.status).toBe(202);
        const recorded = harness.store.readState().backups[0];
        expect(recorded.mode).toBe("0600");
        expect(recorded.modeError).toBeUndefined();
        expect(recorded.mtimeMs).toBe(fs.statSync(recorded.file).mtimeMs);
        expect(recorded.bytes).toBe(fs.statSync(recorded.file).size);
        expect(harness.store.readState().lastUpdateRun.steps).not.toContainEqual(
          expect.objectContaining({
            name: "backup",
            detail: expect.stringMatching(/default mode/),
          }),
        );
        // The inventory projects the mode.
        const entry = harness.sync
          .listBackupInventory()
          .entries.find((candidate) => candidate.file === recorded.file);
        expect(entry.mode).toBe("0600");
      });

      it("a refused chmod 0600 still records the verified backup, but as mode 'default' with modeError, a backup warning step and a notification", async () => {
        const failingFs = {
          ...fs,
          promises: fs.promises,
          chmodSync: (target, mode) => {
            if (String(target).endsWith(".tar.gz")) {
              throw new Error("EPERM: operation not permitted, chmod");
            }
            return fs.chmodSync(target, mode);
          },
        };
        const harness = mkHarness({ extraSyncOptions: { fsModule: failingFs } });
        const result = await harness.sync.applyUpdate(hardGateTarget);
        expect(result.status).toBe(202);
        const recorded = harness.store.readState().backups[0];
        expect(recorded.verified).toBe(true);
        expect(recorded.mode).toBe("default");
        expect(recorded.modeError).toMatch(/EPERM/);
        expect(harness.store.readState().lastUpdateRun.steps).toContainEqual(
          expect.objectContaining({
            name: "backup",
            status: "warning",
            detail: expect.stringMatching(/archive left at the filesystem's default mode — chmod 0600 failed \(EPERM/),
          }),
        );
        expect(
          notifyMessages(harness.notify).some((message) =>
            /permissions could not be tightened: archive left at the filesystem's default mode/.test(message),
          ),
        ).toBe(true);
        const entry = harness.sync
          .listBackupInventory()
          .entries.find((candidate) => candidate.file === recorded.file);
        expect(entry.mode).toBe("default");
      });

      it("#9: first hard-gated apply writes a unique archive and records it", async () => {
        const harness = mkHarness();
        const backupsDir = backupsDirOf(harness);

        const result = await harness.sync.applyUpdate(hardGateTarget);

        expect(result.status).toBe(202);
        expect(result.body.restarting).toBe(true);
        const dirStat = fs.statSync(backupsDir);
        expect(dirStat.isDirectory()).toBe(true);
        // Archives carry credentials — the directory is owner-only.
        expect(dirStat.mode & 0o777).toBe(0o700);
        const archives = archiveNames(backupsDir);
        expect(archives).toHaveLength(1);
        const recorded = harness.store.readState().backups[0];
        expect(recorded).toEqual(
          expect.objectContaining({ dir: backupsDir, verified: true }),
        );
        expect(recorded.file).toBe(path.join(backupsDir, archives[0]));
        expect(fs.statSync(recorded.file).size).toBeGreaterThan(0);
      });

      // Issue #21 bug 6: a config-broken box cannot discover workspaces, so
      // `backup create` fails and the one action that could move the box to a
      // build that understands the migrated config was blocked. The CLI names
      // the escape hatch — pass it.
      const kWorkspaceFailTail =
        "Error: Config invalid at $OPENCLAW_HOME/.openclaw/openclaw.json.\n" +
        "OpenClaw cannot reliably discover custom workspaces for backup.\n" +
        "Fix the config or rerun with --no-include-workspace for a partial backup.\n";
      const workspaceFailRunner = async (opts, fallback) => {
        if (
          opts.command === "openclaw" &&
          opts.args?.[0] === "backup" &&
          !opts.args.includes("--no-include-workspace")
        ) {
          return { ok: false, code: 1, tail: kWorkspaceFailTail, timedOut: false };
        }
        return fallback(opts);
      };
      const backupInvocations = (harness) =>
        harness.runner.runStreamed.mock.calls
          .map((call) => call[0])
          .filter((opts) => opts.command === "openclaw" && opts.args?.[0] === "backup");

      it("retries a workspace-discovery backup failure with --no-include-workspace and records backup.partial", async () => {
        const harness = mkHarness({ runnerImpl: workspaceFailRunner });

        const result = await harness.sync.applyUpdate(hardGateTarget);
        await flushAsync();

        expect(result.status).toBe(202);
        const backups = backupInvocations(harness);
        expect(backups).toHaveLength(2);
        expect(backups[0].args).not.toContain("--no-include-workspace");
        expect(backups[1].args).toContain("--no-include-workspace");
        // Fresh output filename on the retry — the CLI refuses to overwrite.
        const outOf = (opts) => opts.args[opts.args.indexOf("--output") + 1];
        expect(outOf(backups[1])).not.toBe(outOf(backups[0]));
        const recorded = harness.store.readState().backups[0];
        expect(recorded).toEqual(
          expect.objectContaining({ partial: true, verified: true }),
        );
        expect(fs.statSync(recorded.file).size).toBeGreaterThan(0);
        expect(
          harness.notify.mock.calls.some(
            (call) =>
              String(call[1]?.id || "").startsWith("backup-partial-") &&
              /WITHOUT workspace files/.test(String(call[0])),
          ),
        ).toBe(true);
      });

      it("hard-gates still pass on a partial backup for downgrades (honestly marked)", async () => {
        const harness = createHarness({
          pin: "1.2.0",
          installedVersion: "1.2.0",
          sentinelVersion: "1.2.0",
          runnerImpl: workspaceFailRunner,
        });
        const result = await harness.sync.applyUpdate({
          channel: "stable",
          version: "1.1.0",
        });
        expect(result.status).toBe(202);
        expect(harness.store.readState().backups[0].partial).toBe(true);
      });

      it("does not retry when the backup failure is unrelated (ENOSPC)", async () => {
        const enospcRunner = async (opts, fallback) => {
          if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
            return {
              ok: false,
              code: 1,
              tail: "Error: ENOSPC: no space left on device\n",
              timedOut: false,
            };
          }
          return fallback(opts);
        };
        const harness = createHarness({
          pin: "1.2.0",
          installedVersion: "1.2.0",
          sentinelVersion: "1.2.0",
          runnerImpl: enospcRunner,
        });
        const result = await harness.sync.applyUpdate({
          channel: "stable",
          version: "1.1.0",
        });
        expect(result.status).toBe(409);
        expect(result.body.code).toBe("backup_failed");
        expect(backupInvocations(harness)).toHaveLength(1);
      });

      it("#7: a legacy archive FILE at the backups path is migrated in and the update succeeds", async () => {
        const harness = mkHarness();
        const backupsDir = backupsDirOf(harness);
        fs.mkdirSync(path.dirname(backupsDir), { recursive: true });
        fs.writeFileSync(backupsDir, "legacy 7GiB archive (stand-in)\n");

        const result = await harness.sync.applyUpdate(hardGateTarget);

        expect(result.status).toBe(202);
        expect(fs.statSync(backupsDir).isDirectory()).toBe(true);
        const names = archiveNames(backupsDir);
        const legacy = names.find((name) =>
          name.startsWith("openclaw-backup-legacy-"),
        );
        expect(legacy).toBeTruthy();
        expect(names).toHaveLength(2); // migrated legacy + this run's archive
        // The archive's contents survived the move byte-for-byte.
        expect(
          fs.readFileSync(path.join(backupsDir, legacy), "utf8"),
        ).toContain("legacy 7GiB");
      });

      it("keeps the legacy archive and fails honestly when migration cannot run", async () => {
        const failingFs = {
          ...fs,
          promises: fs.promises,
          renameSync: (src, dest) => {
            if (String(src).endsWith(path.join("backups", "openclaw"))) {
              throw new Error("EACCES: permission denied");
            }
            return fs.renameSync(src, dest);
          },
        };
        const harness = mkHarness({ extraSyncOptions: { fsModule: failingFs } });
        const backupsDir = backupsDirOf(harness);
        fs.mkdirSync(path.dirname(backupsDir), { recursive: true });
        fs.writeFileSync(backupsDir, "legacy archive\n");

        const result = await harness.sync.applyUpdate(hardGateTarget);

        expect(result.status).toBe(409);
        expect(result.body.code).toBe("backup_failed");
        // The CLI's own error (parent path blocked by the file) surfaces
        // verbatim instead of a misleading "failed to verify".
        expect(result.body.message).toMatch(/EEXIST|ENOTDIR|not a directory/i);
        expect(result.body.message).not.toMatch(/failed to verify/i);
        // A failed migration never deletes the user's only backup.
        expect(fs.statSync(backupsDir).isFile()).toBe(true);
        expect(fs.readFileSync(backupsDir, "utf8")).toContain("legacy archive");
      });

      it("recovers an interrupted legacy migration on the next run", async () => {
        const harness = mkHarness();
        const backupsDir = backupsDirOf(harness);
        fs.mkdirSync(backupsDir, { recursive: true });
        const stranded = `${backupsDir}.migrating-999-abcdef`;
        fs.writeFileSync(stranded, "stranded legacy archive\n");

        const result = await harness.sync.applyUpdate(hardGateTarget);

        expect(result.status).toBe(202);
        expect(fs.existsSync(stranded)).toBe(false);
        const legacy = archiveNames(backupsDir).find((name) =>
          name.startsWith("openclaw-backup-legacy-"),
        );
        expect(legacy).toBeTruthy();
        expect(
          fs.readFileSync(path.join(backupsDir, legacy), "utf8"),
        ).toContain("stranded");
      });

      it("refuses to write backups through a symlink", async () => {
        const harness = mkHarness();
        const backupsDir = backupsDirOf(harness);
        const realTarget = mkTemp("alphaclaw-symlink-target-");
        fs.mkdirSync(path.dirname(backupsDir), { recursive: true });
        fs.symlinkSync(realTarget, backupsDir);

        const result = await harness.sync.applyUpdate(hardGateTarget);

        expect(result.status).toBe(409);
        expect(result.body.code).toBe("backup_failed");
        expect(result.body.message).toMatch(/symlink/i);
        // Nothing was written through the redirect, and no backup CLI ran.
        expect(fs.readdirSync(realTarget)).toHaveLength(0);
        const backupCalls = harness.runner.runStreamed.mock.calls.filter(
          (call) => call?.[0]?.args?.[0] === "backup",
        );
        expect(backupCalls).toHaveLength(0);
      });

      it("quarantines a published-but-unverified archive on verify failure (hard gate)", async () => {
        const publishThenFailVerify = async (opts, fallback) => {
          if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
            // The real CLI publishes the archive at the final path BEFORE
            // --verify runs, so a verify failure leaves the file behind.
            const out = opts.args[opts.args.indexOf("--output") + 1];
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, "published archive, checksum bad\n");
            return {
              ok: false,
              code: 1,
              tail: "Archive verification failed: checksum mismatch\n",
              timedOut: false,
            };
          }
          return fallback(opts);
        };
        const harness = mkHarness({ runnerImpl: publishThenFailVerify });
        const backupsDir = backupsDirOf(harness);
        fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          path.join(backupsDir, "openclaw-backup-old.tar.gz"),
          "good old backup\n",
        );

        const result = await harness.sync.applyUpdate(hardGateTarget);

        expect(result.status).toBe(409);
        expect(result.body.message).toMatch(/failed to verify/i);
        const names = fs.readdirSync(backupsDir);
        // The unproven archive can't pose as the newest restore candidate —
        // and the pre-existing verified backup survives untouched.
        expect(names).toContain("openclaw-backup-old.tar.gz");
        expect(names.some((name) => name.endsWith(".unverified"))).toBe(true);
        expect(names.filter((name) => kArchiveClass.test(name))).toEqual([
          "openclaw-backup-old.tar.gz",
        ]);
      });

      it("quarantines on the soft gate too and continues with a warning", async () => {
        const publishThenFailVerify = async (opts, fallback) => {
          if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
            const out = opts.args[opts.args.indexOf("--output") + 1];
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, "published archive, checksum bad\n");
            return {
              ok: false,
              code: 1,
              tail: "Archive verification failed: checksum mismatch\n",
              timedOut: false,
            };
          }
          return fallback(opts);
        };
        const harness = mkHarness({ runnerImpl: publishThenFailVerify });
        const backupsDir = backupsDirOf(harness);

        // Non-prerelease upgrade → soft gate: warn and continue.
        const result = await harness.sync.applyUpdate({
          channel: "beta",
          version: "1.1.0",
        });
        await flushAsync();

        expect(result.status).toBe(202);
        expect(
          notifyMessages(harness.notify).some((message) =>
            /failed to verify/i.test(message),
          ),
        ).toBe(true);
        expect(
          fs.readdirSync(backupsDir).some((name) => name.endsWith(".unverified")),
        ).toBe(true);
      });

      it("removes an empty partial archive after a failed backup and spares older backups", async () => {
        const emptyThenFail = async (opts, fallback) => {
          if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
            const out = opts.args[opts.args.indexOf("--output") + 1];
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, "");
            return { ok: false, code: 1, tail: "boom", timedOut: false };
          }
          return fallback(opts);
        };
        const harness = mkHarness({ runnerImpl: emptyThenFail });
        const backupsDir = backupsDirOf(harness);
        fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          path.join(backupsDir, "openclaw-backup-old.tar.gz"),
          "good old backup\n",
        );

        const result = await harness.sync.applyUpdate(hardGateTarget);

        expect(result.status).toBe(409);
        // Own empty stub removed; nothing else touched (no global prune on
        // failure — it could evict the last verified backup).
        expect(fs.readdirSync(backupsDir)).toEqual([
          "openclaw-backup-old.tar.gz",
        ]);
      });

      it("maps timeout, disk-full, and refusal to honest messages", async () => {
        const withTail = (response) => async (opts, fallback) => {
          if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
            return response;
          }
          return fallback(opts);
        };

        const timedOut = mkHarness({
          runnerImpl: withTail({ ok: false, code: null, tail: "", timedOut: true }),
        });
        const timeoutResult = await timedOut.sync.applyUpdate(hardGateTarget);
        expect(timeoutResult.status).toBe(409);
        expect(timeoutResult.body.message).toMatch(/timed out after 10 minutes/i);

        const diskFull = mkHarness({
          runnerImpl: withTail({
            ok: false,
            code: 1,
            tail: "Error: ENOSPC: no space left on device, write\n",
            timedOut: false,
          }),
        });
        const diskResult = await diskFull.sync.applyUpdate(hardGateTarget);
        expect(diskResult.status).toBe(409);
        expect(diskResult.body.message).toMatch(/disk space/i);
        expect(diskResult.body.hint).toMatch(/free up space/i);

        const refused = mkHarness({
          runnerImpl: withTail({
            ok: false,
            code: 1,
            tail: "Error: Refusing to overwrite existing backup archive: /data/backups/openclaw\n",
            timedOut: false,
          }),
        });
        const refusedResult = await refused.sync.applyUpdate(hardGateTarget);
        expect(refusedResult.status).toBe(409);
        expect(refusedResult.body.message).toMatch(/already exists at/i);
        expect(refusedResult.body.message).not.toMatch(/failed to verify/i);
        expect(refusedResult.body.hint).toMatch(/remove or relocate/i);
      });

      it("releases the apply latch after a backup failure so a retry succeeds", async () => {
        let failFirst = true;
        const failOnce = async (opts, fallback) => {
          if (
            opts.command === "openclaw" &&
            opts.args?.[0] === "backup" &&
            failFirst
          ) {
            failFirst = false;
            return { ok: false, code: 1, tail: "boom", timedOut: false };
          }
          return fallback(opts);
        };
        const harness = mkHarness({ runnerImpl: failOnce });
        const backupsDir = backupsDirOf(harness);

        const first = await harness.sync.applyUpdate(hardGateTarget);
        expect(first.status).toBe(409);
        expect(harness.sync.isApplyInProgress()).toBe(false);

        const second = await harness.sync.applyUpdate(hardGateTarget);
        expect(second.status).toBe(202);
        expect(archiveNames(backupsDir)).toHaveLength(1);
      });

      it("prunes only archive-class files: keep-3, drop debris, spare operator files", async () => {
        const harness = mkHarness();
        const backupsDir = backupsDirOf(harness);
        fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
        const seed = (name, mtimeSec) => {
          const full = path.join(backupsDir, name);
          fs.writeFileSync(full, `seed ${name}\n`);
          fs.utimesSync(full, mtimeSec, mtimeSec);
        };
        seed("openclaw-backup-a.tar.gz", 1000);
        seed("openclaw-backup-b.tar.gz", 2000);
        seed("openclaw-backup-c.tar.gz", 3000);
        seed("openclaw-backup-d.tar.gz", 4000);
        seed("openclaw-backup-x.tar.gz.unverified", 1500);
        seed("openclaw-backup-y.tar.gz.unverified", 2500);
        seed("openclaw-backup-z.tar.gz.old.tmp", 500);
        seed("unrelated.txt", 100);
        seed("openclaw-backup-notes.txt", 100);

        const result = await harness.sync.applyUpdate(hardGateTarget);
        expect(result.status).toBe(202);

        const names = fs.readdirSync(backupsDir).sort();
        const archives = names.filter((name) => kArchiveClass.test(name));
        // keep-3 by mtime: this run's fresh archive + the two newest seeds.
        expect(archives).toHaveLength(3);
        expect(archives).toContain("openclaw-backup-c.tar.gz");
        expect(archives).toContain("openclaw-backup-d.tar.gz");
        // Debris: temps always go; only the newest quarantined archive stays.
        expect(names.filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
        expect(names.filter((name) => name.endsWith(".unverified"))).toEqual([
          "openclaw-backup-y.tar.gz.unverified",
        ]);
        // Operator files are never retention's business.
        expect(names).toContain("unrelated.txt");
        expect(names).toContain("openclaw-backup-notes.txt");
      });

      // Regression pin for the archive-class predicate (isBackupArchiveName):
      // the pre-#54 pattern was unanchored (/openclaw-backup.*\.tar\.gz$/), so
      // an operator's own "copy-of-openclaw-backup-….tar.gz" in the directory
      // counted as an archive and keep-3 could DELETE it. The anchored
      // predicate spares it, while the AlphaClaw offline-copy suffix
      // (.alphaclaw.tar.gz) stays inside retention.
      it("retention classifies by the anchored archive name: an operator's copy-of-… file is spared, an .alphaclaw.tar.gz counts toward keep-3", async () => {
        const harness = mkHarness();
        const backupsDir = backupsDirOf(harness);
        fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
        const seed = (name, mtimeSec) => {
          const full = path.join(backupsDir, name);
          fs.writeFileSync(full, `seed ${name}\n`);
          fs.utimesSync(full, mtimeSec, mtimeSec);
        };
        // Oldest of everything: the unanchored pattern would evict it first.
        seed("copy-of-openclaw-backup-a.tar.gz", 900);
        seed("openclaw-backup-a.tar.gz", 1000);
        seed("openclaw-backup-b.tar.gz", 2000);
        seed("openclaw-backup-c.tar.gz", 3000);
        seed("openclaw-backup-e.alphaclaw.tar.gz", 3500);
        seed("openclaw-backup-d.tar.gz", 4000);

        const result = await harness.sync.applyUpdate(hardGateTarget);
        expect(result.status).toBe(202);

        const names = fs.readdirSync(backupsDir).sort();
        // Never retention's business — it does not start with the producer prefix.
        expect(names).toContain("copy-of-openclaw-backup-a.tar.gz");
        // keep-3 by mtime among archive-class files: this run's fresh archive,
        // d, and the offline-copy-suffixed e; a, b, c are evicted.
        expect(names).toContain("openclaw-backup-d.tar.gz");
        expect(names).toContain("openclaw-backup-e.alphaclaw.tar.gz");
        expect(names).not.toContain("openclaw-backup-a.tar.gz");
        expect(names).not.toContain("openclaw-backup-b.tar.gz");
        expect(names).not.toContain("openclaw-backup-c.tar.gz");
        const archiveClass = names.filter((name) =>
          /^openclaw-backup-[^/]*\.(alphaclaw\.)?tar\.gz$/.test(name),
        );
        expect(archiveClass).toHaveLength(3);
      });
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

  describe("runUpdateRepair (2.3)", () => {
    const makeOperationEvents = () => ({
      publish: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
    });

    it("refuses repair on package channels (overlay ownership, E-C7)", async () => {
      const { sync, runner } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });

      const result = await sync.runUpdateRepair({ operationId: "op-r" });

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("repair_not_applicable");
      expect(result.body.hint).toContain("re-apply the version from the catalog");
      expect(runner.runStreamed).not.toHaveBeenCalled();
    });

    it("runs `openclaw update repair` on the dev checkout and completes the stream", async () => {
      const operationEvents = makeOperationEvents();
      const { sync, runner } = createHarness({
        channel: "dev",
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        extraSyncOptions: { operationEvents },
      });

      const result = await sync.runUpdateRepair({ operationId: "op-r" });

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      const repairCall = runner.runStreamed.mock.calls.find(
        ([opts]) => opts.command === "openclaw" && opts.args?.[0] === "update",
      );
      expect(repairCall).toBeTruthy();
      expect(repairCall[0].args).toEqual(["update", "repair"]);
      expect(operationEvents.complete).toHaveBeenCalledWith(
        "op-r",
        expect.objectContaining({ ok: true }),
      );
      expect(operationEvents.fail).not.toHaveBeenCalled();
      expect(sync.isApplyInProgress()).toBe(false);
    });

    it("surfaces a repair refusal verbatim and FAILS the stream (not complete)", async () => {
      const operationEvents = makeOperationEvents();
      const { sync } = createHarness({
        channel: "dev",
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        runnerImpl: async (opts, fallback) => {
          if (opts.command === "openclaw" && opts.args?.[0] === "update") {
            return {
              ok: false,
              code: 1,
              tail: "refused: supervisor mode is external",
              timedOut: false,
            };
          }
          return fallback(opts);
        },
        extraSyncOptions: { operationEvents },
      });

      const result = await sync.runUpdateRepair({ operationId: "op-r" });

      expect(result.status).toBe(500);
      expect(result.body.code).toBe("repair_failed");
      expect(result.body.hint).toContain(
        "refused: supervisor mode is external",
      );
      // Subscribers key success/failure off the SSE event name — a failed
      // repair must emit "error", never "done".
      expect(operationEvents.complete).not.toHaveBeenCalled();
      expect(operationEvents.fail).toHaveBeenCalledTimes(1);
      const [failedId, failedError] = operationEvents.fail.mock.calls[0];
      expect(failedId).toBe("op-r");
      expect(failedError.code).toBe("repair_failed");
      expect(sync.isApplyInProgress()).toBe(false);
    });

    it("409s while another update operation holds the latch", async () => {
      let releaseRepair;
      const gate = new Promise((resolve) => {
        releaseRepair = resolve;
      });
      const { sync } = createHarness({
        channel: "dev",
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        runnerImpl: async (opts, fallback) => {
          if (opts.command === "openclaw" && opts.args?.[0] === "update") {
            await gate;
            return { ok: true, code: 0, tail: "", timedOut: false };
          }
          return fallback(opts);
        },
      });

      const first = sync.runUpdateRepair({ operationId: "op-a" });
      // The latch is taken synchronously before the runner is awaited.
      const second = await sync.runUpdateRepair({ operationId: "op-b" });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe("operation_in_progress");

      releaseRepair();
      const firstResult = await first;
      expect(firstResult.status).toBe(200);
    });

    // Repairs are update runs too (merge resolution): they get a durable
    // ledger record and a redacting log sink, completed on BOTH outcomes.
    const makeLedgerSpy = () => {
      const sink = {
        writeLine: vi.fn(),
        write: vi.fn(),
        close: vi.fn(async () => {}),
      };
      return {
        sink,
        ledger: {
          createRun: vi.fn(),
          createLogSink: vi.fn(() => sink),
          updateRun: vi.fn(),
          completeRun: vi.fn(),
        },
      };
    };

    it("records the repair in the run ledger and completes it as activated on success", async () => {
      const { sink, ledger } = makeLedgerSpy();
      const { sync } = createHarness({
        channel: "dev",
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        extraSyncOptions: { runLedger: ledger },
      });

      const result = await sync.runUpdateRepair({ operationId: "op-r" });

      expect(result.status).toBe(200);
      expect(ledger.createRun).toHaveBeenCalledWith({
        operationId: "op-r",
        target: { channel: "dev", repair: true },
      });
      expect(ledger.createLogSink).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: "op-r" }),
      );
      expect(ledger.completeRun).toHaveBeenCalledTimes(1);
      expect(ledger.completeRun).toHaveBeenCalledWith(
        "op-r",
        expect.objectContaining({ state: "activated", ok: true }),
      );
      // The durable sink is detached and closed after the run.
      expect(sink.close).toHaveBeenCalled();
    });

    it("completes the ledger run as FAILED when the repair CLI refuses", async () => {
      const { sink, ledger } = makeLedgerSpy();
      const { sync } = createHarness({
        channel: "dev",
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        runnerImpl: async (opts, fallback) => {
          if (opts.command === "openclaw" && opts.args?.[0] === "update") {
            return { ok: false, code: 1, tail: "repair refused", timedOut: false };
          }
          return fallback(opts);
        },
        extraSyncOptions: { runLedger: ledger },
      });

      const result = await sync.runUpdateRepair({ operationId: "op-r" });

      expect(result.status).toBe(500);
      expect(ledger.completeRun).toHaveBeenCalledTimes(1);
      expect(ledger.completeRun).toHaveBeenCalledWith(
        "op-r",
        expect.objectContaining({
          state: "failed",
          ok: false,
          result: expect.objectContaining({ code: "repair_failed" }),
        }),
      );
      expect(sink.close).toHaveBeenCalled();
    });

    it("terminates the ledger run + SSE when the repair stream REJECTS (no hang)", async () => {
      const operationEvents = makeOperationEvents();
      const { sink, ledger } = makeLedgerSpy();
      const { sync } = createHarness({
        channel: "dev",
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        runnerImpl: async (opts, fallback) => {
          if (opts.command === "openclaw" && opts.args?.[0] === "update") {
            // A crash (spawn error, sink write throw) — runStreamed rejects.
            throw new Error("spawn ENOMEM");
          }
          return fallback(opts);
        },
        extraSyncOptions: { runLedger: ledger, operationEvents },
      });

      const result = await sync.runUpdateRepair({ operationId: "op-r" });

      // The route resolves (does not hang or throw) with a failure envelope.
      expect(result.status).toBe(500);
      expect(result.body.code).toBe("repair_failed");
      // The ledger run is completed as failed (not left "running"), the SSE
      // subscriber gets an error (not a hang), the sink closes, latch released.
      expect(ledger.completeRun).toHaveBeenCalledWith(
        "op-r",
        expect.objectContaining({ state: "failed", ok: false }),
      );
      expect(operationEvents.fail).toHaveBeenCalledTimes(1);
      expect(operationEvents.complete).not.toHaveBeenCalled();
      expect(sink.close).toHaveBeenCalled();
      expect(sync.isApplyInProgress()).toBe(false);
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

    it("fails a hard-gated apply with backup_failed when backup exits ok but writes no artifact", async () => {
      const { sync, rootDir, store, openclawDir, installToTempDir } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        runnerImpl: async (opts, fallback) => {
          if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
            // A defective/compromised build claiming success: exit 0 and a
            // clean tail, but NO backup file appears in --output.
            return { ok: true, code: 0, tail: "backup verified\n", timedOut: false };
          }
          return fallback(opts);
        },
      });
      writeCheckoutFixture(rootDir, { sha: kDevSha });
      // State exists → a silent no-op backup is a real integrity failure.
      fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
      fs.writeFileSync(path.join(openclawDir, "state", "openclaw.sqlite"), "db");

      const result = await sync.applyUpdate({ channel: "dev", devHead: true });

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("backup_failed");
      expect(result.body.message).toMatch(/produced no backup file/i);
      // The message names the exact path alphaclaw probed (#9 asked for
      // "artifact missing at expected path <X>", not "subsystem untrustworthy").
      expect(result.body.message).toMatch(/openclaw-backup-.*\.tar\.gz/);
      expect(result.body.expectedFile).toMatch(/openclaw-backup-.*\.tar\.gz$/);
      expect(result.body.hint).not.toMatch(/not trustworthy/i);
      expect(store.readState().applied).toBeNull();
      // The apply stopped at the gate — nothing was downloaded or built.
      expect(installToTempDir).not.toHaveBeenCalled();
      // The phantom backup was never recorded as a usable artifact.
      expect(store.readState().backups || []).toHaveLength(0);
    });

    it("soft-passes the artifact check on a fresh install with no state to back up", async () => {
      // Live-verified: the real stable binary exits 0 without writing a file
      // when there is nothing to back up — a fresh install's first channel
      // switch must not be bricked by the phantom-backup guard.
      const { sync, rootDir, store } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        runnerImpl: async (opts, fallback) => {
          if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
            return { ok: true, code: 0, tail: "nothing to back up\n", timedOut: false };
          }
          return fallback(opts);
        },
      });
      writeCheckoutFixture(rootDir, { sha: kDevSha });

      const result = await sync.applyUpdate({ channel: "dev", devHead: true });

      // The gate let the apply proceed (dev build continues past backup).
      expect(result.body.code).not.toBe("backup_failed");
      // No phantom artifact was recorded.
      expect(store.readState().backups || []).toHaveLength(0);
    });

    // WI-1.7: the fresh-install waiver fails CLOSED — only a literally empty
    // state tree waives the hard gate; a box with sessions, a populated
    // config, or an applied/LKG history that gets exit 0 + no artifact is a
    // phantom backup, not a fresh install.
    describe("fresh-install waiver fails closed (WI-1.7)", () => {
      const noArtifactRunner = async (opts, fallback) => {
        if (opts.command === "openclaw" && opts.args?.[0] === "backup") {
          return { ok: true, code: 0, tail: "nothing to back up\n", timedOut: false };
        }
        return fallback(opts);
      };
      const mkFresh = () =>
        createHarness({
          pin: "1.0.0",
          installedVersion: "1.0.0",
          sentinelVersion: "1.0.0",
          runnerImpl: noArtifactRunner,
        });
      const hardGateTarget = { channel: "beta", version: "1.1.0-beta.1" };

      it("refuses (no_artifact 409) when openclaw.json has content", async () => {
        const harness = mkFresh();
        fs.mkdirSync(harness.openclawDir, { recursive: true });
        fs.writeFileSync(path.join(harness.openclawDir, "openclaw.json"), '{"agents":{"list":[]}}\n');
        const result = await harness.sync.applyUpdate(hardGateTarget);
        expect(result.status).toBe(409);
        expect(result.body.code).toBe("backup_failed");
        expect(result.body.message).toMatch(/reported success but produced no backup file/);
        expect(result.body.hint).toMatch(/No earlier backup archive exists/);
      });

      it("refuses when a session transcript exists, even with no database and an empty config", async () => {
        const harness = mkFresh();
        const sessions = path.join(harness.openclawDir, "agents", "main", "sessions");
        fs.mkdirSync(sessions, { recursive: true });
        fs.writeFileSync(path.join(sessions, "abc.jsonl"), "{}\n");
        fs.writeFileSync(path.join(harness.openclawDir, "openclaw.json"), "{}\n");
        const result = await harness.sync.applyUpdate(hardGateTarget);
        expect(result.status).toBe(409);
        expect(result.body.code).toBe("backup_failed");
      });

      it("refuses when the channel state carries an applied/last-known-good history", async () => {
        const harness = mkFresh();
        harness.store.updateState((s) => {
          s.lastKnownGood.package = "0.9.9";
          return s;
        });
        const result = await harness.sync.applyUpdate(hardGateTarget);
        expect(result.status).toBe(409);
        expect(result.body.code).toBe("backup_failed");
      });

      it("still waives for a literally empty tree — an empty `{}` config and the pin's own LKG self-promotion are not history", async () => {
        const harness = mkFresh();
        fs.mkdirSync(harness.openclawDir, { recursive: true });
        fs.writeFileSync(path.join(harness.openclawDir, "openclaw.json"), "{}\n");
        harness.store.updateState((s) => {
          s.pinVersion = "1.0.0";
          s.lastKnownGood.package = "1.0.0";
          return s;
        });
        const result = await harness.sync.applyUpdate(hardGateTarget);
        expect(result.body.code).not.toBe("backup_failed");
        const steps = harness.store.readState().lastUpdateRun.steps;
        expect(steps).toContainEqual(
          expect.objectContaining({
            name: "backup",
            status: "warning",
            detail: "no state to back up yet — nothing a migration could lose",
          }),
        );
      });

      it("treats an unreadable config as NOT fresh (fs error fails closed)", async () => {
        const harness = mkFresh();
        fs.mkdirSync(path.join(harness.openclawDir, "openclaw.json"), { recursive: true });
        const result = await harness.sync.applyUpdate(hardGateTarget);
        expect(result.status).toBe(409);
        expect(result.body.code).toBe("backup_failed");
      });

      // "Fresh" is an allowlist: anything outside AlphaClaw's own bookkeeping
      // is state a migration could lose, whether or not this code knows its
      // name — credentials, identity, legacy auth profiles, cron, pairing.
      it.each([
        [
          "a credentials store",
          (dir) => {
            fs.mkdirSync(path.join(dir, "credentials"), { recursive: true });
            fs.writeFileSync(path.join(dir, "credentials", "telegram.json"), "{}\n");
          },
        ],
        [
          "a legacy auth-profiles.json",
          (dir) => {
            fs.mkdirSync(path.join(dir, "agents", "main", "agent"), { recursive: true });
            fs.writeFileSync(
              path.join(dir, "agents", "main", "agent", "auth-profiles.json"),
              '{"profiles":[]}\n',
            );
          },
        ],
        [
          "an identity dir",
          (dir) => {
            fs.mkdirSync(path.join(dir, "identity"), { recursive: true });
            fs.writeFileSync(path.join(dir, "identity", "device.json"), "{}\n");
          },
        ],
        [
          "cron state",
          (dir) => {
            fs.mkdirSync(path.join(dir, "cron"), { recursive: true });
            fs.writeFileSync(path.join(dir, "cron", "jobs.json"), "[]\n");
          },
        ],
        [
          "a file this code has no name for",
          (dir) => fs.writeFileSync(path.join(dir, "pairing-telegram.json"), "{}\n"),
        ],
        [
          "a symlink where a directory would be",
          (dir) => fs.symlinkSync("/etc", path.join(dir, "credentials")),
        ],
      ])(
        "refuses (no_artifact 409) when the tree holds %s and nothing else — no database, no config, no sessions",
        async (_label, plant) => {
          const harness = mkFresh();
          fs.mkdirSync(harness.openclawDir, { recursive: true });
          plant(harness.openclawDir);
          const result = await harness.sync.applyUpdate(hardGateTarget);
          expect(result.status).toBe(409);
          expect(result.body.code).toBe("backup_failed");
          expect(result.body.message).toMatch(/reported success but produced no backup file/);
        },
      );

      it("still waives with AlphaClaw's own bookkeeping and empty directories around an empty config (.alphaclaw, logs, backups, tmp, the .env link, empty state/ and agents/main/sessions/)", async () => {
        const harness = mkFresh();
        const dir = harness.openclawDir;
        fs.mkdirSync(path.join(dir, ".alphaclaw", "runs"), { recursive: true });
        fs.writeFileSync(path.join(dir, ".alphaclaw", "runs", "r.json"), "{}\n");
        fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
        fs.writeFileSync(path.join(dir, "logs", "gateway.log"), "log\n");
        fs.mkdirSync(path.join(dir, "backups"), { recursive: true });
        fs.mkdirSync(path.join(dir, "tmp"), { recursive: true });
        fs.symlinkSync(path.join(harness.rootDir, ".env"), path.join(dir, ".env"));
        fs.mkdirSync(path.join(dir, "state"), { recursive: true });
        fs.mkdirSync(path.join(dir, "agents", "main", "sessions"), { recursive: true });
        fs.writeFileSync(path.join(dir, "openclaw.json"), "{}\n");
        const result = await harness.sync.applyUpdate(hardGateTarget);
        expect(result.body.code).not.toBe("backup_failed");
        expect(harness.store.readState().lastUpdateRun.steps).toContainEqual(
          expect.objectContaining({
            name: "backup",
            status: "warning",
            detail: "no state to back up yet — nothing a migration could lose",
          }),
        );
      });

      // X3: the allowlist used to `continue` on the NAME before looking at
      // the entry — a symlink named `.env`/`logs`, a special file named `tmp`
      // or a credentials dump renamed `.env` all counted as fresh. The names
      // are accepted only in their expected shape.
      describe("allowlisted names are checked by SHAPE, not name (X3)", () => {
        const expectNotFresh = async (harness) => {
          const result = await harness.sync.applyUpdate(hardGateTarget);
          expect(result.status).toBe(409);
          expect(result.body.code).toBe("backup_failed");
          expect(result.body.message).toMatch(/reported success but produced no backup file/);
        };
        const expectFresh = async (harness) => {
          const result = await harness.sync.applyUpdate(hardGateTarget);
          expect(result.body.code).not.toBe("backup_failed");
          expect(harness.store.readState().lastUpdateRun.steps).toContainEqual(
            expect.objectContaining({
              name: "backup",
              status: "warning",
              detail: "no state to back up yet — nothing a migration could lose",
            }),
          );
        };

        it("a `.env` symlink that points anywhere but <rootDir>/.env is NOT fresh", async () => {
          const harness = mkFresh();
          fs.mkdirSync(harness.openclawDir, { recursive: true });
          fs.symlinkSync("/etc/passwd", path.join(harness.openclawDir, ".env"));
          await expectNotFresh(harness);
        });

        it("a `.env` symlink to <rootDir>/.env whose target is not a regular file is NOT fresh", async () => {
          const harness = mkFresh();
          fs.mkdirSync(harness.openclawDir, { recursive: true });
          fs.mkdirSync(path.join(harness.rootDir, ".env"));
          fs.symlinkSync(path.join(harness.rootDir, ".env"), path.join(harness.openclawDir, ".env"));
          await expectNotFresh(harness);
        });

        it("the onboarding `.env` link to an existing regular <rootDir>/.env stays fresh (secrets in AlphaClaw's own env are not OpenClaw state)", async () => {
          const harness = mkFresh();
          fs.mkdirSync(harness.openclawDir, { recursive: true });
          fs.writeFileSync(path.join(harness.rootDir, ".env"), "SETUP_PASSWORD=pw\nTELEGRAM_BOT_TOKEN=1:a\n");
          fs.symlinkSync(path.join(harness.rootDir, ".env"), path.join(harness.openclawDir, ".env"));
          await expectFresh(harness);
        });

        it("a small regular `.env` with only bookkeeping keys is fresh; one carrying OPENCLAW_*/TOKEN-shaped keys is NOT", async () => {
          const bookkeeping = mkFresh();
          fs.mkdirSync(bookkeeping.openclawDir, { recursive: true });
          fs.writeFileSync(path.join(bookkeeping.openclawDir, ".env"), "# planted by setup\nSETUP_PASSWORD=pw\n");
          await expectFresh(bookkeeping);

          const secretful = mkFresh();
          fs.mkdirSync(secretful.openclawDir, { recursive: true });
          fs.writeFileSync(
            path.join(secretful.openclawDir, ".env"),
            "SETUP_PASSWORD=pw\nOPENCLAW_GATEWAY_TOKEN=abc\n",
          );
          await expectNotFresh(secretful);

          const oversized = mkFresh();
          fs.mkdirSync(oversized.openclawDir, { recursive: true });
          fs.writeFileSync(path.join(oversized.openclawDir, ".env"), `# ${"x".repeat(5000)}\n`);
          await expectNotFresh(oversized);
        });

        it.each([".alphaclaw", "logs", "backups", "tmp"])(
          "a symlink named %s where a bookkeeping directory would be is NOT fresh",
          async (name) => {
            const harness = mkFresh();
            fs.mkdirSync(harness.openclawDir, { recursive: true });
            const elsewhere = path.join(harness.rootDir, "elsewhere");
            fs.mkdirSync(elsewhere, { recursive: true });
            fs.symlinkSync(elsewhere, path.join(harness.openclawDir, name));
            await expectNotFresh(harness);
          },
        );

        it("a regular file named `logs` is NOT fresh", async () => {
          const harness = mkFresh();
          fs.mkdirSync(harness.openclawDir, { recursive: true });
          fs.writeFileSync(path.join(harness.openclawDir, "logs"), "not a dir\n");
          await expectNotFresh(harness);
        });
      });
    });

    it("db-preflight: no database + a credentials store alone → warning step (same allowlist predicate), never a silent 'no state database' pass", async () => {
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      fs.mkdirSync(path.join(harness.openclawDir, "credentials"), { recursive: true });
      fs.writeFileSync(path.join(harness.openclawDir, "credentials", "telegram.json"), "{}\n");
      const result = await harness.sync.applyUpdate({ channel: "beta", version: "1.1.0" });
      expect(result.status).toBe(202);
      const steps = harness.store.readState().lastUpdateRun.steps;
      expect(steps).toContainEqual(
        expect.objectContaining({
          name: "db-preflight",
          status: "warning",
          detail: expect.stringMatching(/no state database to probe — the state tree is not empty/),
        }),
      );
      expect(steps).not.toContainEqual(
        expect.objectContaining({ name: "db-preflight", detail: "no state database" }),
      );
    });

    // Same predicate at the db-preflight blind spot: no database to probe is
    // "compatible" only for a fresh tree; otherwise the step says it could
    // not check, instead of claiming a pass.
    it("db-preflight: no database + non-empty state tree → warning step, never a silent pass", async () => {
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      fs.mkdirSync(harness.openclawDir, { recursive: true });
      fs.writeFileSync(path.join(harness.openclawDir, "openclaw.json"), '{"agents":{}}\n');
      const result = await harness.sync.applyUpdate({ channel: "beta", version: "1.1.0" });
      expect(result.status).toBe(202);
      const steps = harness.store.readState().lastUpdateRun.steps;
      expect(steps).toContainEqual(
        expect.objectContaining({
          name: "db-preflight",
          status: "warning",
          detail: expect.stringMatching(/no state database to probe — the state tree is not empty/),
        }),
      );
      expect(steps).not.toContainEqual(
        expect.objectContaining({ name: "db-preflight", detail: "no state database" }),
      );
    });

    it("db-preflight: no database on a fresh tree still completes as 'no state database'", async () => {
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      const result = await harness.sync.applyUpdate({ channel: "beta", version: "1.1.0" });
      expect(result.status).toBe(202);
      expect(harness.store.readState().lastUpdateRun.steps).toContainEqual(
        expect.objectContaining({ name: "db-preflight", status: "completed", detail: "no state database" }),
      );
    });

    it("enumerateStateDbs honors OPENCLAW_STATE_DIR from the installed CLI's spawn env", async () => {
      const { DatabaseSync } = require("node:sqlite");
      const stateDir = mkTemp("alphaclaw-alt-state-dir-");
      fs.mkdirSync(path.join(stateDir, "state"), { recursive: true });
      const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
      db.exec("CREATE TABLE t(x INTEGER)");
      db.close();
      const preflightCalls = [];
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        runnerImpl: async (opts, fallback) => {
          if (Array.isArray(opts.args) && opts.args.includes("preflight")) {
            preflightCalls.push(opts.args);
            return { ok: true, code: 0, tail: '{"status":"ok"}\n', timedOut: false };
          }
          return fallback(opts);
        },
        extraSyncOptions: {
          openclawSpawnEnv: () => ({ ...process.env, OPENCLAW_STATE_DIR: stateDir }),
        },
      });

      const result = await harness.sync.applyUpdate({ channel: "beta", version: "1.1.0" });

      expect(result.status).toBe(202);
      // The preflight snapshotted the DB found under OPENCLAW_STATE_DIR, not
      // under the harness openclawDir (which has none).
      expect(preflightCalls).toHaveLength(1);
      expect(preflightCalls[0].some((arg) => /openclaw\.sqlite$/.test(String(arg)))).toBe(true);
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
          openclawSpawnEnv: () => ({
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

    // WI-3.4: the apply OUTCOME is important-class, never verbose — under
    // "Important only" (WATCHDOG_NOTIFICATIONS_QUIET) the operator still
    // hears that the activation was verified. The id is keyed to the
    // operation that produced the build so a boot loop dedupes.
    describe("auto-acceptance notification (WI-3.4)", () => {
      const kOperationId = "2f8c1f2e-0d2a-4b1e-9a11-6f2f8c1f2e0d";
      afterEach(() => {
        delete process.env.WATCHDOG_NOTIFICATIONS_QUIET;
      });

      it("is not verbose and carries apply-accepted-<operationId> when the applied record names its operation", async () => {
        process.env.WATCHDOG_NOTIFICATIONS_QUIET = "true";
        const { sync, store, nowRef, notify } = createHarness({
          pin: "1.0.0",
          installedVersion: "1.1.0",
          sentinelVersion: "1.1.0",
          acceptanceHoldMs: 0,
          // Simulates the release-channel normalizer preserving operationId
          // on both read paths (markGoodNow reads updateState's return).
          storeWrap: (inner) => {
            const withOperationId = (state) =>
              state?.applied ? { ...state, applied: { ...state.applied, operationId: kOperationId } } : state;
            return {
              ...inner,
              readState: () => withOperationId(inner.readState()),
              updateState: (mutator) => withOperationId(inner.updateState(mutator)),
            };
          },
        });
        store.updateState((s) => {
          s.pinVersion = "1.0.0";
          s.applied = { channel: "beta", version: "1.1.0", at: 1, acceptedAt: null };
          return s;
        });

        sync.onGatewayHealthy();
        nowRef.now += 1;
        sync.onGatewayHealthy();
        await flushAsync();

        const call = notify.mock.calls.find(([message]) => /healthy — activation verified/.test(String(message)));
        expect(call).toBeTruthy();
        expect(call[1]).toEqual({
          eventType: "recovery",
          id: `apply-accepted-${kOperationId}`,
          operationId: kOperationId,
        });
        expect(call[1].verbose).toBeUndefined();
      });

      it("falls back to apply-accepted-<appliedId>-<acceptedAt> for state files without an operationId (still not verbose)", async () => {
        process.env.WATCHDOG_NOTIFICATIONS_QUIET = "true";
        const { sync, store, nowRef, notify } = createHarness({
          pin: "1.0.0",
          installedVersion: "1.1.0",
          sentinelVersion: "1.1.0",
          acceptanceHoldMs: 0,
        });
        store.updateState((s) => {
          s.pinVersion = "1.0.0";
          s.applied = { channel: "beta", version: "1.1.0", at: 1, acceptedAt: null };
          return s;
        });

        sync.onGatewayHealthy();
        nowRef.now += 1;
        sync.onGatewayHealthy();
        await flushAsync();

        const acceptedAt = store.readState().applied.acceptedAt;
        const call = notify.mock.calls.find(([message]) => /healthy — activation verified/.test(String(message)));
        expect(call).toBeTruthy();
        expect(call[1]).toEqual({
          eventType: "recovery",
          id: `apply-accepted-1.1.0-${acceptedAt}`,
        });
      });

      it("applyUpdate stamps operationId onto the applied record it writes", async () => {
        const harness = createHarness({
          pin: "1.0.0",
          installedVersion: "1.0.0",
          sentinelVersion: "1.0.0",
        });
        const written = [];
        const originalUpdate = harness.store.updateState.bind(harness.store);
        harness.store.updateState = (mutator) =>
          originalUpdate((s) => {
            const next = mutator(s) || s;
            if (next.applied?.operationId) written.push(next.applied.operationId);
            return next;
          });
        const result = await harness.sync.applyUpdate({
          channel: "beta",
          version: "1.1.0",
          operationId: kOperationId,
        });
        expect(result.status).toBe(202);
        // Stamped at record time (the normalizer decides whether it persists).
        expect(written).toContain(kOperationId);
      });
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

  describe("pin stabilization window", () => {
    const bumpedPinHarness = (options = {}) => {
      const harness = createHarness({
        pin: "1.0.1",
        channel: "stable",
        installedVersion: "1.0.1",
        sentinelVersion: "1.0.1",
        ...options,
      });
      harness.store.updateState((s) => {
        s.pinVersion = "1.0.0";
        return s;
      });
      return harness;
    };

    it("pin_reconciled records the previous pin and opens the pin window once the install is on the new pin", async () => {
      const { sync, store, nowRef } = bumpedPinHarness();

      const result = sync.syncAtBoot();
      await flushAsync();

      expect(result.action).toBe("pin_reconciled");
      const state = store.readState();
      expect(state.previousPin).toEqual({ version: "1.0.0", at: nowRef.now });
      expect(state.pinWindow).toEqual({
        version: "1.0.1",
        openedAt: nowRef.now,
        acceptedAt: null,
        acceptedSource: null,
      });
      const info = sync.getChannelInfo();
      expect(info.isPin).toBe(true);
      expect(info.inStabilizationWindow).toBe(true);
      expect(info.stabilization).toEqual(
        expect.objectContaining({
          source: "pin",
          inWindow: true,
          blockedId: "1.0.1",
          acceptedAt: null,
          endsAt: null,
          target: null,
        }),
      );
    });

    it("a lagging install leaves the window pending; a later boot on the new pin arms it", async () => {
      const { sync, store, installDir } = bumpedPinHarness({
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });

      expect(sync.syncAtBoot().action).toBe("pin_reconciled");
      await flushAsync();
      expect(store.readState().pinWindow.openedAt).toBeNull();
      expect(sync.getChannelInfo().stabilization.source).toBeNull();
      expect(sync.getChannelInfo().inStabilizationWindow).toBe(false);

      writeInstallFixture(installDir, { version: "1.0.1" });
      store.writeSentinel({ installDir, version: "1.0.1" });
      expect(sync.syncAtBoot().ok).toBe(true);
      await flushAsync();
      expect(store.readState().pinWindow.openedAt).not.toBeNull();
      expect(sync.getChannelInfo().stabilization.source).toBe("pin");
    });

    it("markGoodNow accepts the pin window: auto-acceptance keeps it armed until it elapses, manual disarms it", async () => {
      const auto = bumpedPinHarness({ stabilizationWindowMs: 10_000 });
      expect(auto.sync.syncAtBoot().action).toBe("pin_reconciled");
      await flushAsync();
      expect(auto.sync.markGoodNow({ source: "acceptance" }).ok).toBe(true);
      expect(auto.sync.getChannelInfo().inStabilizationWindow).toBe(true);
      expect(auto.sync.getChannelInfo().stabilizationEndsAt).toBe(
        auto.nowRef.now + 10_000,
      );
      auto.nowRef.now += 10_001;
      expect(auto.sync.getChannelInfo().inStabilizationWindow).toBe(false);
      expect(auto.sync.getChannelInfo().stabilization.source).toBeNull();

      const manual = bumpedPinHarness({ stabilizationWindowMs: 10_000 });
      expect(manual.sync.syncAtBoot().action).toBe("pin_reconciled");
      await flushAsync();
      expect(manual.sync.markGoodNow().ok).toBe(true);
      expect(manual.sync.getChannelInfo().inStabilizationWindow).toBe(false);
      expect(manual.store.readState().pinWindow.acceptedSource).toBe("manual");
      expect(manual.sync.markGoodNow()).toEqual(
        expect.objectContaining({ ok: false, code: "nothing_to_accept" }),
      );
    });

    it("onGatewayHealthy auto-accepts the pin window after the health hold", async () => {
      const { sync, store, notify, nowRef } = bumpedPinHarness({
        acceptanceHoldMs: 5_000,
      });
      expect(sync.syncAtBoot().action).toBe("pin_reconciled");
      await flushAsync();

      sync.onGatewayHealthy();
      expect(store.readState().pinWindow.acceptedAt).toBeNull();
      nowRef.now += 5_000;
      sync.onGatewayHealthy();
      await flushAsync();

      expect(store.readState().pinWindow).toEqual(
        expect.objectContaining({
          acceptedAt: nowRef.now,
          acceptedSource: "acceptance",
        }),
      );
      expect(sync.getChannelInfo().inStabilizationWindow).toBe(true);
      // Same class as the channel acceptance (issue #54 / WI-3.4): the outcome
      // of a pin bump under watch is important-class, never verbose, and keyed
      // to the pin + acceptance stamp so a boot loop dedupes.
      const acceptedCall = notify.mock.calls.find(([message]) =>
        /new pinned version\) is healthy/.test(message),
      );
      expect(acceptedCall).toBeTruthy();
      expect(acceptedCall[1]).toEqual({
        eventType: "recovery",
        id: `pin-accepted-${store.readState().pinVersion}-${nowRef.now}`,
      });
      expect(acceptedCall[1].verbose).toBeUndefined();
    });

    it("rolls a failing new pin back to the previous pin's overlay and blocklists the pin", async () => {
      vi.useFakeTimers();
      const { sync, store, restartProcess, notify } = bumpedPinHarness();
      expect(sync.syncAtBoot().action).toBe("pin_reconciled");
      await flushAsync();
      expect(saveOverlayFixture(store, "1.0.0")).toEqual({ ok: true });
      // A healthy hold already promoted the new pin to last-known-good.
      store.updateState((s) => {
        s.lastKnownGood.package = "1.0.1";
        return s;
      });
      expect(sync.getChannelInfo().stabilization.target).toEqual({
        kind: "package",
        channel: "stable",
        version: "1.0.0",
      });

      const result = sync.requestChannelRollback({
        reason: "crash_loop",
        exitCode: 1,
      });

      expect(result.ok).toBe(true);
      expect(result.blockedId).toBe("1.0.1");
      // LKG re-points to the build we are landing on, not the blocklisted pin.
      expect(store.readState().lastKnownGood.package).toBe("1.0.0");
      expect(result.target).toEqual({
        kind: "package",
        channel: "stable",
        version: "1.0.0",
      });
      expect(store.readMarker()).toEqual(
        expect.objectContaining({
          source: "pin",
          blockedId: "1.0.1",
          target: { kind: "package", channel: "stable", version: "1.0.0" },
        }),
      );
      expect(store.isBlocklisted("1.0.1")).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(restartProcess).toHaveBeenCalledTimes(1);
      await flushAsync();
      expect(
        notifyMessages(notify).some((message) =>
          message.includes("rolling back to the previous version 1.0.0"),
        ),
      ).toBe(true);
    });

    it("refuses a pin rollback when no earlier version exists locally — never targets the blocked pin", async () => {
      vi.useFakeTimers();
      const { sync, store, restartProcess, watchdogLatch, notify } =
        bumpedPinHarness();
      expect(sync.syncAtBoot().action).toBe("pin_reconciled");
      await flushAsync();

      const result = sync.requestChannelRollback({
        reason: "crash_loop",
        exitCode: 1,
      });
      await flushAsync();

      expect(result.ok).toBe(false);
      expect(result.code).toBe("pin_rollback_unavailable");
      expect(store.readMarker()).toBeNull();
      // A refusal leaves the pin runnable: no blocklist entry it could never
      // leave, and the watchdog latches on the unhandled result itself.
      expect(store.isBlocklisted("1.0.1")).toBe(false);
      expect(store.readState().rollbackRefused).toEqual(
        expect.objectContaining({
          blockedId: "1.0.1",
          reason: "no_pin_rollback_target",
        }),
      );
      expect(watchdogLatch).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(restartProcess).not.toHaveBeenCalled();
      expect(
        notifyMessages(notify).some((message) =>
          message.includes("no earlier version is available locally"),
        ),
      ).toBe(true);
      expect(sync.requestChannelRollback({ reason: "crash_loop" }).code).toBe(
        "rollback_refused_previously",
      );
    });

    const installedTreeVersion = (installDir) =>
      JSON.parse(
        fs.readFileSync(
          path.join(installDir, "node_modules", "openclaw", "package.json"),
          "utf8",
        ),
      ).version;

    it("a manual Roll back now on a pin with no local target is a side-effect-free refusal", async () => {
      const { sync, store, notify } = bumpedPinHarness();
      expect(sync.syncAtBoot().action).toBe("pin_reconciled");
      await flushAsync();
      notify.mockClear();

      const result = sync.requestChannelRollback({ reason: "manual" });
      await flushAsync();

      expect(result.code).toBe("pin_rollback_unavailable");
      expect(store.readState().rollbackRefused).toBeNull();
      expect(store.isBlocklisted("1.0.1")).toBe(false);
      expect(store.readMarker()).toBeNull();
      expect(notify).not.toHaveBeenCalled();
    });

    it("falls back to a usable last-known-good overlay when the previous pin has none", async () => {
      vi.useFakeTimers();
      const { sync, store } = bumpedPinHarness();
      expect(sync.syncAtBoot().action).toBe("pin_reconciled");
      await flushAsync();
      store.updateState((s) => {
        s.lastKnownGood.package = "0.9.9";
        return s;
      });
      expect(saveOverlayFixture(store, "0.9.9")).toEqual({ ok: true });
      expect(sync.getChannelInfo().stabilization.target).toEqual({
        kind: "package",
        channel: "stable",
        version: "0.9.9",
      });

      const result = sync.requestChannelRollback({ reason: "crash_loop" });

      expect(result.ok).toBe(true);
      expect(result.target).toEqual({
        kind: "package",
        channel: "stable",
        version: "0.9.9",
      });
      expect(store.isBlocklisted("1.0.1")).toBe(true);
    });

    it("after a pin rollback, the next bump remembers the parked stable as the previous pin", async () => {
      const { sync, store } = createHarness({
        pin: "1.0.2",
        channel: "stable",
        installedVersion: "1.0.2",
        sentinelVersion: "1.0.2",
      });
      store.updateState((s) => {
        s.pinVersion = "1.0.1";
        s.applied = {
          channel: "stable",
          version: "1.0.0",
          at: 1,
          acceptedAt: 1,
          reason: "pin_rollback",
        };
        s.blocklist.push({ id: "1.0.1", reason: "crash_loop", exitCode: 1, at: 2 });
        return s;
      });
      expect(saveOverlayFixture(store, "1.0.0")).toEqual({ ok: true });

      expect(sync.syncAtBoot().action).toBe("pin_reconciled");
      await flushAsync();

      const state = store.readState();
      expect(state.pinVersion).toBe("1.0.2");
      expect(state.previousPin.version).toBe("1.0.0");
      expect(state.applied).toBeNull();
      expect(state.pinWindow.version).toBe("1.0.2");
      expect(sync.getChannelInfo().stabilization.target).toEqual({
        kind: "package",
        channel: "stable",
        version: "1.0.0",
      });
    });

    it("a channel rollback never lands on a blocklisted pin", async () => {
      vi.useFakeTimers();
      const withFloor = createHarness({
        pin: "1.0.1",
        installedVersion: "1.2.0",
        sentinelVersion: "1.2.0",
      });
      withFloor.store.updateState((s) => {
        s.pinVersion = "1.0.1";
        s.previousPin = { version: "1.0.0", at: 1 };
        s.applied = { channel: "beta", version: "1.2.0", at: 1, acceptedAt: null };
        s.blocklist.push({ id: "1.0.1", reason: "crash_loop", exitCode: 1, at: 2 });
        return s;
      });
      expect(saveOverlayFixture(withFloor.store, "1.0.0")).toEqual({ ok: true });
      const rolled = withFloor.sync.requestChannelRollback({ reason: "crash_loop" });
      expect(rolled.ok).toBe(true);
      expect(rolled.target).toEqual({
        kind: "package",
        channel: "stable",
        version: "1.0.0",
      });

      const noFloor = createHarness({
        pin: "1.0.1",
        installedVersion: "1.2.0",
        sentinelVersion: "1.2.0",
      });
      noFloor.store.updateState((s) => {
        s.pinVersion = "1.0.1";
        s.applied = { channel: "beta", version: "1.2.0", at: 1, acceptedAt: null };
        s.blocklist.push({ id: "1.0.1", reason: "crash_loop", exitCode: 1, at: 2 });
        return s;
      });
      const refused = noFloor.sync.requestChannelRollback({ reason: "crash_loop" });
      await flushAsync();
      expect(refused.code).toBe("rollback_floor_blocklisted");
      expect(noFloor.store.readMarker()).toBeNull();
      expect(noFloor.store.readState().rollbackRefused).toEqual(
        expect.objectContaining({ blockedId: "1.2.0", reason: "pin_floor_blocklisted" }),
      );
      expect(
        notifyMessages(noFloor.notify).some((message) =>
          message.includes("is blocklisted from an earlier failure"),
        ),
      ).toBe(true);
    });

    it("boot never offers a blocklisted pin as a rollback candidate", async () => {
      const { sync, store, installDir } = createHarness({
        pin: "1.0.1",
        channel: "stable",
        installedVersion: "1.0.1",
        sentinelVersion: "1.0.1",
      });
      store.updateState((s) => {
        s.pinVersion = "1.0.1";
        s.applied = { channel: "dev", sha: kDevSha, at: 1, acceptedAt: null };
        s.blocklist.push({ id: "1.0.1", reason: "crash_loop", exitCode: 1, at: 2 });
        return s;
      });
      store.writeMarker({
        target: { kind: "pin" },
        blockedId: kDevSha,
        reason: "crash_loop",
        exitCode: 1,
      });

      const result = sync.syncAtBoot();
      await sync.flushBootNotifications();

      expect(result.action).toBe("rollback_refused");
      expect(store.readMarker()).toBeNull();
      expect(store.readState().rollbackRefused).toEqual(
        expect.objectContaining({ blockedId: kDevSha, reason: "no_compatible_target" }),
      );
      expect(installedTreeVersion(installDir)).toBe("1.0.1");
    });

    it("keeps the previous pin's overlay through an apply while the pin window is armed", async () => {
      const { sync, store } = bumpedPinHarness();
      expect(sync.syncAtBoot().action).toBe("pin_reconciled");
      await flushAsync();
      expect(saveOverlayFixture(store, "1.0.0")).toEqual({ ok: true });
      expect(saveOverlayFixture(store, "0.5.0")).toEqual({ ok: true });

      const applied = await sync.applyUpdate({ channel: "beta", version: "1.1.0" });
      await flushAsync();

      expect(applied.status).toBe(202);
      expect(store.hasOverlay("1.0.0")).toBe(true);
      expect(store.hasOverlay("0.5.0")).toBe(false);
    });

    const pinRollbackMarkerHarness = ({
      withOverlay = true,
      markerSource = "pin",
      extraSyncOptions = {},
    } = {}) => {
      const harness = createHarness({
        pin: "1.0.1",
        channel: "stable",
        installedVersion: "1.0.1",
        sentinelVersion: "1.0.1",
        extraSyncOptions,
      });
      harness.store.updateState((s) => {
        s.pinVersion = "1.0.1";
        s.previousPin = { version: "1.0.0", at: 1 };
        s.pinWindow = {
          version: "1.0.1",
          openedAt: 1,
          acceptedAt: null,
          acceptedSource: null,
        };
        s.blocklist.push({ id: "1.0.1", reason: "crash_loop", exitCode: 1, at: 2 });
        return s;
      });
      if (withOverlay) {
        expect(saveOverlayFixture(harness.store, "1.0.0")).toEqual({ ok: true });
      }
      harness.store.writeMarker({
        target: { kind: "package", channel: "stable", version: "1.0.0" },
        blockedId: "1.0.1",
        reason: "crash_loop",
        exitCode: 1,
        ...(markerSource ? { source: markerSource } : {}),
      });
      return harness;
    };

    // A real state DB makes the boot preflight prober run; the CLI stub then
    // answers like a line that has no `database preflight` at all.
    const seedStateDbAndUnsupportedPreflight = () => {
      const execFileSyncImpl = vi.fn(() => {
        const error = new Error("Command failed");
        error.stdout = "";
        error.stderr = "error: unknown command 'database'\n";
        throw error;
      });
      const seed = (openclawDir) => {
        const dir = path.join(openclawDir, "state");
        fs.mkdirSync(dir, { recursive: true });
        const db = new DatabaseSync(path.join(dir, "openclaw.sqlite"));
        db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1);");
        db.close();
      };
      return { execFileSyncImpl, seed };
    };

    it("inside a pin window an unsupported database preflight from a pre-2026.8 target is a block, not a warn-and-proceed", async () => {
      const { execFileSyncImpl, seed } = seedStateDbAndUnsupportedPreflight();
      const { sync, store, openclawDir, installDir } = pinRollbackMarkerHarness({
        extraSyncOptions: { execFileSyncImpl },
      });
      seed(openclawDir);

      const result = sync.syncAtBoot();
      await sync.flushBootNotifications();

      expect(execFileSyncImpl).toHaveBeenCalled();
      expect(result.action).toBe("rollback_refused");
      expect(installedTreeVersion(installDir)).toBe("1.0.1");
      expect(store.readState().applied).toBeNull();
      expect(
        result.warnings.some((warning) =>
          warning.includes("cannot safely read the current database"),
        ),
      ).toBe(true);
    });

    it("outside a pin window the same unsupported preflight still warns and proceeds", async () => {
      const { execFileSyncImpl, seed } = seedStateDbAndUnsupportedPreflight();
      const { sync, store, openclawDir, installDir } = pinRollbackMarkerHarness({
        markerSource: null,
        extraSyncOptions: { execFileSyncImpl },
      });
      // A channel-style marker: the failing build is an applied beta, not the pin.
      store.updateState((s) => {
        s.pinVersion = "1.0.1";
        s.blocklist = [];
        s.applied = { channel: "beta", version: "1.2.0", at: 1, acceptedAt: null };
        return s;
      });
      store.writeMarker({
        target: { kind: "package", channel: "stable", version: "1.0.0" },
        blockedId: "1.2.0",
        reason: "crash_loop",
      });
      seed(openclawDir);

      const result = sync.syncAtBoot();
      await sync.flushBootNotifications();

      expect(result.action).toBe("rollback");
      expect(installedTreeVersion(installDir)).toBe("1.0.0");
      expect(
        result.warnings.some((warning) =>
          warning.includes("cannot verify state written by the newer version"),
        ),
      ).toBe(true);
    });

    it("boot consumes a pin-window marker onto the previous pin and stays there across reboots", async () => {
      const { sync, store, installDir, notify } = pinRollbackMarkerHarness();

      const first = sync.syncAtBoot();
      await sync.flushBootNotifications();

      expect(first.action).toBe("rollback");
      expect(installedTreeVersion(installDir)).toBe("1.0.0");
      expect(store.readMarker()).toBeNull();
      expect(store.readState().applied).toEqual(
        expect.objectContaining({
          channel: "stable",
          version: "1.0.0",
          reason: "pin_rollback",
        }),
      );
      expect(sync.getChannelInfo().stabilization.source).toBe("channel");
      expect(
        notifyMessages(notify).some((message) => /rolled back/i.test(message)),
      ).toBe(true);

      // Declared pin 1.0.1 is blocklisted: the next boot must keep the
      // previous pin active instead of re-activating the bad pin.
      const second = sync.syncAtBoot();
      await flushAsync();
      expect(second.ok).toBe(true);
      expect(second.action).not.toBe("pin_reconciled");
      expect(installedTreeVersion(installDir)).toBe("1.0.0");
      expect(store.readState().applied).toEqual(
        expect.objectContaining({ version: "1.0.0", reason: "pin_rollback" }),
      );
      expect(store.isBlocklisted("1.0.1")).toBe(true);
    });

    it("a pin-window marker whose overlay fails to activate reports a refusal, not a rollback", async () => {
      const { sync, store, installDir, notify } = pinRollbackMarkerHarness();
      const realActivate = store.activateOverlay;
      store.activateOverlay = vi.fn(() => ({ ok: false, error: "EACCES" }));
      try {
        const result = sync.syncAtBoot();
        await sync.flushBootNotifications();

        expect(result.action).toBe("rollback_refused");
        expect(installedTreeVersion(installDir)).toBe("1.0.1");
        expect(store.readState().applied).toBeNull();
        expect(store.readState().rollbackRefused).toEqual(
          expect.objectContaining({
            blockedId: "1.0.1",
            reason: "pin_rollback_activation_failed",
          }),
        );
        expect(
          notifyMessages(notify).some((message) =>
            message.includes("could not activate 1.0.0"),
          ),
        ).toBe(true);
        expect(
          notifyMessages(notify).some((message) => /rolled back/i.test(message)),
        ).toBe(false);
      } finally {
        store.activateOverlay = realActivate;
      }
    });

    it("a pin-window marker whose target overlay is missing refuses instead of falling back to the blocked pin", async () => {
      const { sync, store, installDir } = pinRollbackMarkerHarness({
        withOverlay: false,
      });

      const result = sync.syncAtBoot();
      await sync.flushBootNotifications();

      expect(result.action).toBe("rollback_refused");
      expect(installedTreeVersion(installDir)).toBe("1.0.1");
      expect(store.readState().applied).toBeNull();
      expect(store.readMarker()).toBeNull();
      expect(store.readState().rollbackRefused).toEqual(
        expect.objectContaining({
          blockedId: "1.0.1",
          reason: "no_compatible_target",
        }),
      );
      expect(
        result.warnings.some((warning) =>
          warning.includes("has no local overlay to activate"),
        ),
      ).toBe(true);
    });

    it("the pin supersedes an older stable pick only when the new pin is not blocklisted", async () => {
      const { sync, store } = createHarness({
        pin: "1.0.2",
        channel: "stable",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      store.updateState((s) => {
        s.pinVersion = "1.0.1";
        s.applied = {
          channel: "stable",
          version: "1.0.0",
          at: 1,
          acceptedAt: 1,
          reason: "pin_rollback",
        };
        s.blocklist.push({ id: "1.0.2", reason: "crash_loop", exitCode: 1, at: 2 });
        return s;
      });
      expect(saveOverlayFixture(store, "1.0.0")).toEqual({ ok: true });

      const result = sync.syncAtBoot();
      await flushAsync();

      expect(result.action).toBe("pin_reconciled");
      expect(store.readState().pinVersion).toBe("1.0.2");
      expect(store.readState().applied).toEqual(
        expect.objectContaining({ version: "1.0.0", reason: "pin_rollback" }),
      );
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

describe("pinDiverged legibility (post-incident 2026-09-01)", () => {
  it("an applied build over the pin: boot log names the expected divergence, action is NOT drift_reverted, and getChannelInfo carries pinDiverged + appliedVersion", async () => {
    const logs = [];
    const { sync, store, installDir } = createHarness({
      pin: "1.0.0",
      installedVersion: "1.0.0",
      sentinelVersion: "1.0.0",
      extraSyncOptions: {
        logger: { log: (m) => logs.push(String(m)), warn() {}, error() {} },
      },
    });
    expect(sync.syncAtBoot().ok).toBe(true);
    expect((await sync.applyUpdate({ channel: "beta", version: "1.1.0" })).status).toBe(202);

    // The apply records the pick; the OVERLAY activates on the next boot —
    // exactly the incident host's steady state (beta over the declared pin).
    const boot = sync.syncAtBoot();
    await flushAsync();
    expect(boot.ok).toBe(true);
    expect(boot.action).not.toBe("drift_reverted");
    expect(store.readInstalledVersion({ installDir })).toBe("1.1.0");

    const info = sync.getChannelInfo();
    expect(info).toMatchObject({
      installedVersion: "1.1.0",
      pinVersion: "1.0.0",
      appliedVersion: "1.1.0",
      pinDiverged: true,
    });
    // The greppable boot line the next incident responder needs.
    expect(
      logs.some((m) =>
        m.includes('over declared pin 1.0.0') && m.includes('npm ls'),
      ),
    ).toBe(true);
  });

  it("pinDiverged never legitimizes anomalies: pin path false, installed≠applied false, dev channel false", async () => {
    // Pin path (nothing applied).
    const pinOnly = createHarness({
      pin: "1.0.0",
      installedVersion: "1.0.0",
      sentinelVersion: "1.0.0",
    });
    expect(pinOnly.sync.syncAtBoot().ok).toBe(true);
    expect(pinOnly.sync.getChannelInfo().pinDiverged).toBe(false);

    // Anomaly: applied recorded but the live tree matches NEITHER pin nor
    // applied (stale state / foreign drift) — not "expected".
    const anomaly = createHarness({
      pin: "1.0.0",
      installedVersion: "9.9.9",
      sentinelVersion: "9.9.9",
    });
    anomaly.store.updateState((s) => {
      s.pinVersion = "1.0.0";
      s.applied = {
        channel: "beta",
        version: "1.1.0",
        sha: null,
        at: 1,
        acceptedAt: null,
        acceptedSource: null,
      };
      return s;
    });
    expect(anomaly.sync.getChannelInfo().pinDiverged).toBe(false);

    // Dev channel: installedVersion is the dormant fallback, not what runs.
    const dev = createHarness({
      pin: "1.0.0",
      installedVersion: "1.1.0",
      sentinelVersion: "1.1.0",
    });
    dev.store.updateState((s) => {
      s.pinVersion = "1.0.0";
      s.applied = {
        channel: "dev",
        version: "1.1.0",
        sha: "abc123",
        at: 1,
        acceptedAt: null,
        acceptedSource: null,
      };
      return s;
    });
    expect(dev.sync.getChannelInfo().pinDiverged).toBe(false);
  });
});
