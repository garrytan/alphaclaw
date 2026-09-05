const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createOpenclawReleaseChannelStore,
  kOpenclawActivationSentinelName,
  normalizeState,
} = require("../../lib/server/openclaw-release-channel");

const kSilentLogger = { log() {}, warn() {}, error() {} };

const createTempRoot = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-release-channel-test-"));

const createStore = (overrides = {}) => {
  const rootDir = createTempRoot();
  const openclawDir = path.join(rootDir, ".openclaw");
  const store = createOpenclawReleaseChannelStore({
    rootDir,
    openclawDir,
    logger: kSilentLogger,
    ...overrides,
  });
  return { store, rootDir, openclawDir };
};

const writeOpenclawPackageFixture = (packageDir, { version, bin } = {}) => {
  fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ name: "openclaw", version, ...(bin ? { bin } : {}) }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(packageDir, "dist", "entry.js"),
    `// openclaw ${version}\n`,
  );
  return packageDir;
};

const writeInstallFixture = (installDir, { version } = {}) =>
  writeOpenclawPackageFixture(
    path.join(installDir, "node_modules", "openclaw"),
    { version },
  );

describe("server/openclaw-release-channel", () => {
  describe("state", () => {
    it("round-trips state and preserves unknown top-level keys through write", () => {
      const { store } = createStore();

      const written = store.writeState({
        applied: {
          channel: "beta",
          version: "2026.8.1",
          sha: "abc123",
          at: 111,
          acceptedAt: 222,
        },
        pinVersion: "2026.7.1-2",
        previousPin: { version: "2026.7.1-1", at: 333 },
        pinWindow: {
          version: "2026.7.1-2",
          openedAt: 444,
          acceptedAt: 555,
          acceptedSource: "acceptance",
        },
        futureKey: { keep: true },
      });

      expect(written.applied).toEqual({
        channel: "beta",
        version: "2026.8.1",
        sha: "abc123",
        at: 111,
        acceptedAt: 222,
        acceptedSource: null,
        reason: null,
        operationId: null,
      });
      expect(written.previousPin).toEqual({ version: "2026.7.1-1", at: 333 });
      expect(written.pinWindow).toEqual({
        version: "2026.7.1-2",
        openedAt: 444,
        acceptedAt: 555,
        acceptedSource: "acceptance",
      });
      expect(store.readState()).toEqual(written);
      const onDisk = JSON.parse(fs.readFileSync(store.statePath, "utf8"));
      expect(onDisk.futureKey).toEqual({ keep: true });
      expect(fs.readFileSync(store.statePath, "utf8").endsWith("\n")).toBe(true);
    });

    it("persists applied.operationId through normalization (apply-accepted-<operationId> dedupe key) and drops non-string values", () => {
      const { store } = createStore();
      const kOperationId = "2f8c1f2e-0d2a-4b1e-9a11-6f2f8c1f2e0d";

      // applyUpdate stamps the operation onto the applied record it writes;
      // the normalizer must carry it across write → disk → read.
      const written = store.writeState({
        applied: {
          channel: "beta",
          version: "2026.8.1",
          at: 111,
          acceptedAt: null,
          operationId: kOperationId,
        },
      });
      expect(written.applied.operationId).toBe(kOperationId);
      expect(store.readState().applied.operationId).toBe(kOperationId);
      // updateState's return (what markGoodNow / the acceptance hook read)
      // carries it too.
      const updated = store.updateState((s) => {
        s.applied.acceptedAt = 333;
        return s;
      });
      expect(updated.applied).toMatchObject({ acceptedAt: 333, operationId: kOperationId });

      // Non-string shapes normalize to null rather than leaking into the id.
      for (const bogus of [42, { id: "x" }, ["a"], true]) {
        expect(normalizeState({ applied: { channel: "beta", operationId: bogus } }).applied.operationId).toBe(null);
      }
    });

    it("normalizes missing/invalid shapes to the empty state", () => {
      const { store } = createStore();

      const expectedEmpty = {
        applied: null,
        pinVersion: null,
        lastKnownGood: { package: null, dev: null },
        blocklist: [],
        lastUpdateRun: null,
        lastBoot: null,
        configMigration: null,
        gatewayHold: null,
        backups: [],
        rollbackRefused: null,
        forwardRecovery: null,
        noBootableVersion: null,
        previousPin: null,
        pinWindow: null,
      };
      expect(store.readState()).toEqual(expectedEmpty);
      expect(normalizeState("not an object")).toEqual(expectedEmpty);
      expect(
        normalizeState({
          applied: "bogus",
          pinVersion: 42,
          lastKnownGood: [],
          blocklist: "nope",
          lastUpdateRun: [],
          lastBoot: 7,
          backups: {},
          previousPin: "2026.7.1-1",
          pinWindow: ["2026.7.1-2"],
        }),
      ).toEqual(expectedEmpty);
    });

    it("keeps applied.reason only when it is a string", () => {
      expect(
        normalizeState({ applied: { reason: "pin_rollback" } }).applied.reason,
      ).toBe("pin_rollback");
      expect(normalizeState({ applied: { reason: 7 } }).applied.reason).toBeNull();
      expect(normalizeState({ applied: {} }).applied.reason).toBeNull();
    });

    it("rejects malformed previousPin/pinWindow shapes (string, array, missing version)", () => {
      expect(normalizeState({ previousPin: "2026.7.1-1" }).previousPin).toBeNull();
      expect(normalizeState({ previousPin: ["2026.7.1-1"] }).previousPin).toBeNull();
      expect(normalizeState({ previousPin: { at: 1 } }).previousPin).toBeNull();
      expect(normalizeState({ previousPin: { version: "" } }).previousPin).toBeNull();
      expect(normalizeState({ previousPin: { version: 42 } }).previousPin).toBeNull();

      expect(normalizeState({ pinWindow: "2026.7.1-2" }).pinWindow).toBeNull();
      expect(normalizeState({ pinWindow: ["2026.7.1-2"] }).pinWindow).toBeNull();
      expect(normalizeState({ pinWindow: { openedAt: 1 } }).pinWindow).toBeNull();
      expect(normalizeState({ pinWindow: { version: "" } }).pinWindow).toBeNull();
      expect(normalizeState({ pinWindow: { version: 42 } }).pinWindow).toBeNull();
    });

    it("sanitizes previousPin/pinWindow fields to explicit nulls", () => {
      expect(normalizeState({ previousPin: { version: "2026.7.1-1" } }).previousPin).toEqual({
        version: "2026.7.1-1",
        at: null,
      });

      expect(normalizeState({ pinWindow: { version: "2026.7.1-2" } }).pinWindow).toEqual({
        version: "2026.7.1-2",
        openedAt: null,
        acceptedAt: null,
        acceptedSource: null,
      });
      // Non-numeric timestamps and unknown sources never survive — consumers
      // compare these against Date.now() and a closed enum.
      expect(
        normalizeState({
          pinWindow: {
            version: "2026.7.1-2",
            openedAt: "444",
            acceptedAt: Number.NaN,
            acceptedSource: "auto",
          },
        }).pinWindow,
      ).toEqual({
        version: "2026.7.1-2",
        openedAt: null,
        acceptedAt: null,
        acceptedSource: null,
      });
      expect(
        normalizeState({
          pinWindow: { version: "2026.7.1-2", openedAt: 444, acceptedSource: "manual" },
        }).pinWindow,
      ).toEqual({
        version: "2026.7.1-2",
        openedAt: 444,
        acceptedAt: null,
        acceptedSource: "manual",
      });
    });

    it("rejects malformed gatewayHold shapes (string, array, empty reason)", () => {
      // The hold is first-class state consumed by startup, watchdog, and UI —
      // a shape without a usable reason must normalize to "no hold", never a
      // half-formed object those consumers would treat as held.
      expect(normalizeState({ gatewayHold: "held" }).gatewayHold).toBeNull();
      expect(
        normalizeState({ gatewayHold: ["held"] }).gatewayHold,
      ).toBeNull();
      expect(
        normalizeState({ gatewayHold: { reason: "" } }).gatewayHold,
      ).toBeNull();
      expect(
        normalizeState({ gatewayHold: { reason: 42 } }).gatewayHold,
      ).toBeNull();
    });

    it("filters non-string blamedKeys and caps them at 50", () => {
      const manyKeys = Array.from({ length: 60 }, (_, i) => `key-${i}`);
      const { gatewayHold } = normalizeState({
        gatewayHold: {
          reason: "x",
          blamedKeys: [1, "a", null, ...manyKeys],
        },
      });

      expect(gatewayHold).toEqual({
        reason: "x",
        // Absent/non-conforming metadata normalizes to explicit nulls.
        at: null,
        operationId: null,
        // Strings survive the filter in order; the cap applies AFTER it.
        blamedKeys: ["a", ...manyKeys.slice(0, 49)],
      });
      expect(gatewayHold.blamedKeys).toHaveLength(50);
    });

    it("returns the empty state with corrupted:true on unparseable JSON without throwing", () => {
      const { store } = createStore();
      fs.mkdirSync(path.dirname(store.statePath), { recursive: true });
      fs.writeFileSync(store.statePath, "{not json", "utf8");

      let state = null;
      expect(() => {
        state = store.readState();
      }).not.toThrow();
      expect(state.corrupted).toBe(true);
      expect(state.blocklist).toEqual([]);
      expect(state.applied).toBeNull();

      // The corrupted flag is read-only and never persists through a write.
      store.writeState(state);
      const onDisk = JSON.parse(fs.readFileSync(store.statePath, "utf8"));
      expect(onDisk.corrupted).toBeUndefined();
    });
  });

  describe("blocklist", () => {
    it("adds entries stamped via nowFn and dedupes by id (first wins)", () => {
      const { store } = createStore({ nowFn: () => 1234 });

      store.addBlocklist({ id: "2026.8.1", reason: "crash loop", exitCode: 42 });
      store.addBlocklist({ id: "2026.8.1", reason: "second attempt" });

      const { blocklist } = store.readState();
      expect(blocklist).toEqual([
        { id: "2026.8.1", reason: "crash loop", exitCode: 42, at: 1234 },
      ]);
      expect(store.isBlocklisted("2026.8.1")).toBe(true);
      expect(store.isBlocklisted("2026.8.2")).toBe(false);
    });

    it("clears one id or all entries", () => {
      const { store } = createStore({ nowFn: () => 1 });
      store.addBlocklist({ id: "a", reason: "x" });
      store.addBlocklist({ id: "b", reason: "y" });

      store.clearBlocklist("a");
      expect(store.isBlocklisted("a")).toBe(false);
      expect(store.isBlocklisted("b")).toBe(true);

      store.addBlocklist({ id: "c", reason: "z" });
      store.clearBlocklist();
      expect(store.readState().blocklist).toEqual([]);
    });
  });

  describe("rollback marker", () => {
    it("writes, reads, and clears the marker", () => {
      const { store } = createStore();

      expect(store.readMarker()).toBeNull();
      expect(store.writeMarker({ reason: "boot-crash", version: "2026.8.1" })).toEqual({
        ok: true,
      });
      expect(store.readMarker()).toEqual({
        reason: "boot-crash",
        version: "2026.8.1",
      });

      store.clearMarker();
      expect(store.readMarker()).toBeNull();
      expect(() => store.clearMarker()).not.toThrow();
    });

    it("returns null for a corrupt marker file", () => {
      const { store } = createStore();
      fs.mkdirSync(path.dirname(store.markerPath), { recursive: true });
      fs.writeFileSync(store.markerPath, "{corrupt", "utf8");

      expect(store.readMarker()).toBeNull();
    });

    it("reports write failures (ENOSPC) instead of throwing", () => {
      const enospc = Object.assign(new Error("ENOSPC: no space left on device"), {
        code: "ENOSPC",
      });
      const fsModule = {
        ...fs,
        writeFileSync: () => {
          throw enospc;
        },
      };
      const { store } = createStore({ fsModule });

      let result = null;
      expect(() => {
        result = store.writeMarker({ reason: "rollback" });
      }).not.toThrow();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("ENOSPC");
    });
  });

  describe("overlay store", () => {
    it("saves an overlay from a temp install and writes the completion file", () => {
      const { store } = createStore({ nowFn: () => 999 });
      const packageDir = writeOpenclawPackageFixture(
        path.join(createTempRoot(), "openclaw"),
        { version: "2.0.0" },
      );

      expect(store.hasOverlay("2.0.0")).toBe(false);
      expect(
        store.saveOverlayFromTempInstall({
          openclawPackageDir: packageDir,
          version: "2.0.0",
        }),
      ).toEqual({ ok: true });

      expect(store.hasOverlay("2.0.0")).toBe(true);
      const entryDir = store.overlayDir("2.0.0");
      expect(entryDir).toBe(path.join(store.overlayStoreDir, "2.0.0"));
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(entryDir, "openclaw", "package.json"),
            "utf8",
          ),
        ).version,
      ).toBe("2.0.0");
      expect(
        fs.existsSync(path.join(entryDir, "openclaw", "dist", "entry.js")),
      ).toBe(true);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(entryDir, ".overlay-complete.json"), "utf8"),
        ),
      ).toEqual({ version: "2.0.0", savedAt: 999 });
    });

    it("treats an entry without a completion file as absent", () => {
      const { store } = createStore();
      // Simulate a mid-copy crash: package dir exists, no completion file.
      fs.mkdirSync(path.join(store.overlayDir("3.0.0"), "openclaw"), {
        recursive: true,
      });

      expect(store.hasOverlay("3.0.0")).toBe(false);
    });

    it("refuses to activate an overlay that still carries the install guard", () => {
      const { store, rootDir } = createStore();
      const installDir = path.join(rootDir, "install");
      writeInstallFixture(installDir, { version: "1.0.0" });
      const packageDir = writeOpenclawPackageFixture(
        path.join(createTempRoot(), "openclaw"),
        { version: "2026.8.1-beta.3" },
      );
      // A staged tree that never completed its lifecycle still has the guard.
      fs.writeFileSync(
        path.join(packageDir, "dist", "openclaw-install-guard"),
        "OpenClaw package preinstall has not completed.",
      );
      store.saveOverlayFromTempInstall({
        openclawPackageDir: packageDir,
        version: "2026.8.1-beta.3",
      });

      const result = store.activateOverlay({
        installDir,
        version: "2026.8.1-beta.3",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/incomplete \(install guard present\)/);
    });

    it("prunes every overlay entry not in the keep set", () => {
      const { store } = createStore();
      for (const version of ["1.0.0", "2.0.0", "3.0.0"]) {
        const packageDir = writeOpenclawPackageFixture(
          path.join(createTempRoot(), "openclaw"),
          { version },
        );
        store.saveOverlayFromTempInstall({
          openclawPackageDir: packageDir,
          version,
        });
      }

      store.pruneOverlays({ keep: ["2.0.0", "3.0.0"] });

      expect(fs.readdirSync(store.overlayStoreDir).sort()).toEqual([
        "2.0.0",
        "3.0.0",
      ]);
      expect(store.hasOverlay("1.0.0")).toBe(false);
      expect(store.hasOverlay("2.0.0")).toBe(true);
      expect(store.hasOverlay("3.0.0")).toBe(true);
    });

    it("pruneOverlaysAsync mirrors pruneOverlays: keep-list honored, removals reported, missing dir tolerated", async () => {
      const { store } = createStore();

      // Fresh store, overlay dir never created: a clean no-op, not a throw —
      // the live apply path calls this unconditionally after every download.
      await expect(
        store.pruneOverlaysAsync({ keep: ["1.0.0"] }),
      ).resolves.toEqual({ removed: [] });

      for (const version of ["1.0.0", "2.0.0", "3.0.0"]) {
        store.saveOverlayFromTempInstall({
          openclawPackageDir: writeOpenclawPackageFixture(
            path.join(createTempRoot(), "openclaw"),
            { version },
          ),
          version,
        });
      }

      const result = await store.pruneOverlaysAsync({ keep: ["2.0.0", "3.0.0"] });

      expect(result.removed).toEqual(["1.0.0"]);
      expect(fs.readdirSync(store.overlayStoreDir).sort()).toEqual([
        "2.0.0",
        "3.0.0",
      ]);
      expect(store.hasOverlay("1.0.0")).toBe(false);
      expect(store.hasOverlay("2.0.0")).toBe(true);
      expect(store.hasOverlay("3.0.0")).toBe(true);
    });

    it("rejects traversal-shaped overlay names", () => {
      const { store } = createStore();
      const packageDir = writeOpenclawPackageFixture(
        path.join(createTempRoot(), "openclaw"),
        { version: "1.0.0" },
      );

      for (const name of ["..", "a/b"]) {
        expect(() => store.overlayDir(name)).toThrow(/unsafe overlay name/);
        expect(store.hasOverlay(name)).toBe(false);
        const saved = store.saveOverlayFromTempInstall({
          openclawPackageDir: packageDir,
          version: name,
        });
        expect(saved.ok).toBe(false);
        expect(saved.error).toContain("unsafe overlay name");
      }
      // Nothing was created outside (or inside) the overlay store.
      expect(fs.existsSync(store.overlayStoreDir)).toBe(false);
    });

    it("snapshots the pin from an install dir and reports alreadyPresent on repeat", () => {
      const { store } = createStore();
      const installDir = createTempRoot();
      writeInstallFixture(installDir, { version: "2026.7.1-2" });

      const first = store.snapshotPinFromInstall({
        installDir,
        pinVersion: "2026.7.1-2",
      });
      expect(first).toEqual({ ok: true, alreadyPresent: false });
      expect(store.hasOverlay("2026.7.1-2")).toBe(true);

      const second = store.snapshotPinFromInstall({
        installDir,
        pinVersion: "2026.7.1-2",
      });
      expect(second).toEqual({ ok: true, alreadyPresent: true });
    });
  });

  describe("activation sentinel", () => {
    it("requires activation when the sentinel is missing even if package.json matches", () => {
      const { store } = createStore();
      const installDir = createTempRoot();
      // Mid-copy crash fixture: plausible tree with the right version, NO sentinel.
      writeInstallFixture(installDir, { version: "2.0.0" });

      expect(store.readInstalledVersion({ installDir })).toBe("2.0.0");
      expect(store.readSentinel({ installDir })).toBeNull();
      expect(
        store.needsActivation({ installDir, expectedVersion: "2.0.0" }),
      ).toBe(true);
    });

    it("clears needsActivation after activateOverlay and flags version drift", () => {
      const { store } = createStore({ nowFn: () => 555 });
      const installDir = createTempRoot();
      writeInstallFixture(installDir, { version: "2.0.0" });
      store.saveOverlayFromTempInstall({
        openclawPackageDir: writeOpenclawPackageFixture(
          path.join(createTempRoot(), "openclaw"),
          { version: "2.0.0" },
        ),
        version: "2.0.0",
      });

      expect(store.activateOverlay({ installDir, version: "2.0.0" })).toEqual({
        ok: true,
      });
      expect(
        store.needsActivation({ installDir, expectedVersion: "2.0.0" }),
      ).toBe(false);
      expect(
        store.needsActivation({ installDir, expectedVersion: "2.0.1" }),
      ).toBe(true);
    });

    it("writeSentinel alone satisfies needsActivation for the pin case", () => {
      const { store } = createStore({ nowFn: () => 777 });
      const installDir = createTempRoot();
      writeInstallFixture(installDir, { version: "2026.7.1-2" });

      expect(
        store.writeSentinel({ installDir, version: "2026.7.1-2" }),
      ).toEqual({ ok: true });
      expect(store.readSentinel({ installDir })).toEqual({
        version: "2026.7.1-2",
        completedAt: 777,
      });
      expect(
        store.needsActivation({ installDir, expectedVersion: "2026.7.1-2" }),
      ).toBe(false);
    });
  });

  describe("activateOverlay", () => {
    it("replaces the live tree and writes the sentinel last", () => {
      const { store } = createStore({ nowFn: () => 42 });
      const installDir = createTempRoot();
      const liveDir = writeInstallFixture(installDir, { version: "1.0.0" });
      fs.writeFileSync(path.join(liveDir, "old-file.js"), "// stale\n");
      store.saveOverlayFromTempInstall({
        openclawPackageDir: writeOpenclawPackageFixture(
          path.join(createTempRoot(), "openclaw"),
          { version: "2.0.0" },
        ),
        version: "2.0.0",
      });

      expect(store.activateOverlay({ installDir, version: "2.0.0" })).toEqual({
        ok: true,
      });

      expect(fs.existsSync(path.join(liveDir, "old-file.js"))).toBe(false);
      expect(store.readInstalledVersion({ installDir })).toBe("2.0.0");
      expect(fs.existsSync(path.join(liveDir, "dist", "entry.js"))).toBe(true);
      const sentinelPath = path.join(
        installDir,
        "node_modules",
        kOpenclawActivationSentinelName,
      );
      expect(JSON.parse(fs.readFileSync(sentinelPath, "utf8"))).toEqual({
        version: "2.0.0",
        completedAt: 42,
      });
    });

    it("fails without touching the sentinel when the overlay is missing", () => {
      const { store } = createStore();
      const installDir = createTempRoot();
      writeInstallFixture(installDir, { version: "1.0.0" });

      const result = store.activateOverlay({ installDir, version: "9.9.9" });

      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
      expect(store.readSentinel({ installDir })).toBeNull();
      // The existing live tree is untouched on this failure path.
      expect(store.readInstalledVersion({ installDir })).toBe("1.0.0");
    });
  });

  describe("server pid guard", () => {
    const os = require("os");
    const { spawn } = require("child_process");
    // A live child standing in for a foreign alphaclaw server. `argvTag`
    // lands in /proc/<pid>/cmdline so the legacy (identity-less) claim path
    // can tell an alphaclaw entry from an unrelated process.
    const spawnHolder = (argvTag = null) =>
      spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 30000)", ...(argvTag ? [argvTag] : [])],
        { stdio: "ignore" },
      );
    const waitForProc = async (pid) => {
      // /proc/<pid>/stat is readable as soon as spawn returns; the loop only
      // guards a racing kernel on slow CI hosts.
      for (let i = 0; i < 50; i += 1) {
        try {
          fs.readFileSync(`/proc/${pid}/stat`, "utf8");
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    };
    const fullClaim = (store, pid) => ({
      pid,
      at: 1,
      host: os.hostname(),
      startTicks: store.readProcessStartTicks(pid),
    });

    it("never clobbers a live foreign owner (identity matches) and clears only its own claim", () => {
      const { store } = createStore();
      const child = spawnHolder();
      try {
        fs.mkdirSync(path.dirname(store.serverPidPath), { recursive: true });
        fs.writeFileSync(
          store.serverPidPath,
          JSON.stringify(fullClaim(store, child.pid)),
        );
        // A live foreign owner is sacred — a second start must not replace it
        // (it would clear the claim on exit, leaving the live server unguarded).
        store.writeServerPid();
        expect(JSON.parse(fs.readFileSync(store.serverPidPath, "utf8")).pid).toBe(
          child.pid,
        );
        // clearServerPid only removes its OWN claim.
        store.clearServerPid();
        expect(fs.existsSync(store.serverPidPath)).toBe(true);
      } finally {
        child.kill("SIGKILL");
      }
    });
  });

  describe("server pid guard — identity, not just a pid", () => {
    const os = require("os");
    const { spawn } = require("child_process");
    const spawnHolder = (argvTag = null) =>
      spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 30000)", ...(argvTag ? [argvTag] : [])],
        { stdio: "ignore" },
      );
    const writeClaim = (store, claim) => {
      fs.mkdirSync(path.dirname(store.serverPidPath), { recursive: true });
      fs.writeFileSync(store.serverPidPath, JSON.stringify(claim));
    };

    it("a claim written by another container/host is stale even when the pid is alive here (fresh container on the same volume)", () => {
      const { store } = createStore();
      const child = spawnHolder();
      try {
        // The old container's server had this pid; in OUR pid namespace the
        // same number is a different, live process.
        writeClaim(store, {
          pid: child.pid,
          at: 1,
          host: "b7f0c0ffee11",
          startTicks: store.readProcessStartTicks(child.pid),
        });
        expect(store.readLiveServerPid()).toBeNull();
        // ...so the boot may claim the file for itself.
        store.writeServerPid();
        const written = JSON.parse(fs.readFileSync(store.serverPidPath, "utf8"));
        expect(written.pid).toBe(process.pid);
        expect(written.host).toBe(os.hostname());
      } finally {
        child.kill("SIGKILL");
      }
    });

    it("a reused pid (same host, different process start time) is stale", () => {
      const { store } = createStore();
      const liveTicks = store.readProcessStartTicks(process.pid);
      if (liveTicks == null) return; // no /proc on this platform — legacy path covered below
      const child = spawnHolder();
      try {
        const childTicks = store.readProcessStartTicks(child.pid);
        expect(childTicks).not.toBeNull();
        writeClaim(store, {
          pid: child.pid,
          at: 1,
          host: os.hostname(),
          startTicks: childTicks - 1, // the process that wrote this started earlier and is gone
        });
        expect(store.readLiveServerPid()).toBeNull();
        // Matching identity: live.
        writeClaim(store, { pid: child.pid, at: 1, host: os.hostname(), startTicks: childTicks });
        expect(store.readLiveServerPid()).toBe(child.pid);
      } finally {
        child.kill("SIGKILL");
      }
    });

    it("a legacy identity-less claim is trusted only if the live process looks like an alphaclaw server", () => {
      const { store } = createStore();
      if (store.readProcessStartTicks(process.pid) == null) return; // needs /proc
      const stranger = spawnHolder();
      const server = spawnHolder("/opt/alphaclaw/bin/alphaclaw.js");
      try {
        writeClaim(store, { pid: stranger.pid, at: 1 });
        expect(store.readLiveServerPid()).toBeNull();
        writeClaim(store, { pid: server.pid, at: 1 });
        expect(store.readLiveServerPid()).toBe(server.pid);
      } finally {
        stranger.kill("SIGKILL");
        server.kill("SIGKILL");
      }
    });

    it("a dead pid and a self pid are never live", () => {
      const { store } = createStore();
      const child = spawnHolder();
      child.kill("SIGKILL");
      writeClaim(store, { pid: process.pid, at: 1, host: os.hostname() });
      expect(store.readLiveServerPid()).toBeNull();
      writeClaim(store, { pid: 999999, at: 1, host: os.hostname() });
      expect(store.readLiveServerPid()).toBeNull();
    });
  });

  describe("bin shim", () => {
    // Shim targets must live inside the managed roots (overlay store or the
    // dev checkout) — validateBinShim rejects anything else.
    const createTargetBin = (store) => {
      const dir = path.join(store.overlayStoreDir, "1.2.3", "openclaw", "bin");
      fs.mkdirSync(dir, { recursive: true });
      const targetBin = path.join(dir, "openclaw.js");
      fs.writeFileSync(targetBin, "#!/usr/bin/env node\n");
      return targetBin;
    };

    it("writes an executable shim atomically with no leftover temp files", () => {
      const { store } = createStore();
      const targetBin = createTargetBin(store);

      expect(store.writeBinShim({ targetBin, label: "overlay 2.0.0" })).toEqual({
        ok: true,
      });

      const content = fs.readFileSync(store.shimPath, "utf8");
      expect(content.startsWith("#!/bin/sh\n")).toBe(true);
      expect(content).toContain("overlay 2.0.0");
      expect(content).toContain(`exec node "${targetBin}" "$@"`);
      expect(fs.statSync(store.shimPath).mode & 0o111).not.toBe(0);
      // Atomicity mechanics: the temp file was renamed onto shimPath, so the
      // shim directory holds exactly the shim and nothing else.
      expect(fs.readdirSync(store.shimDir)).toEqual(["openclaw"]);
    });

    it("round-trips the target through readBinShimTarget and overwrites in place", () => {
      const { store } = createStore();
      const firstTarget = createTargetBin(store);
      const secondTarget = createTargetBin(store);

      store.writeBinShim({ targetBin: firstTarget });
      expect(store.readBinShimTarget()).toBe(firstTarget);

      store.writeBinShim({ targetBin: secondTarget, label: "next" });
      expect(store.readBinShimTarget()).toBe(secondTarget);
      expect(fs.readdirSync(store.shimDir)).toEqual(["openclaw"]);
    });

    it("validateBinShim removes a dangling shim and reports state transitions", () => {
      const { store } = createStore();
      const targetBin = createTargetBin(store);

      expect(store.validateBinShim()).toEqual({
        present: false,
        valid: false,
        removed: false,
      });

      store.writeBinShim({ targetBin });
      expect(store.validateBinShim()).toEqual({
        present: true,
        valid: true,
        removed: false,
      });

      fs.unlinkSync(targetBin);
      expect(store.validateBinShim()).toEqual({
        present: true,
        valid: false,
        removed: true,
      });
      expect(fs.existsSync(store.shimPath)).toBe(false);
    });

    it("refuses shim targets that could smuggle shell into the exec line", () => {
      const { store } = createStore();

      for (const targetBin of [
        "/tmp/evil/$(rm -rf ~)/bin.js",
        "/tmp/evil/`id`/bin.js",
        '/tmp/evil/"quote"/bin.js',
      ]) {
        const result = store.writeBinShim({ targetBin });
        expect(result.ok).toBe(false);
        expect(result.error).toContain("unsafe target path");
      }
      expect(fs.existsSync(store.shimPath)).toBe(false);
    });

    it("validateBinShim sweeps unexpected files out of the shim dir, keeping the shim", () => {
      const { store } = createStore();
      const targetBin = createTargetBin(store);
      expect(store.writeBinShim({ targetBin })).toEqual({ ok: true });
      // shimDir sits on the agent-writable data volume and is prepended to
      // PATH — a planted "git" impostor would be a PATH hijack.
      fs.writeFileSync(path.join(store.shimDir, "git"), "#!/bin/sh\necho hijacked\n");

      const result = store.validateBinShim();

      expect(result).toEqual({ present: true, valid: true, removed: false });
      expect(fs.readdirSync(store.shimDir)).toEqual(["openclaw"]);
      expect(store.readBinShimTarget()).toBe(targetBin);

      // Containment: a shim pointing at an EXISTING file outside the managed
      // roots (overlay store / dev checkout) is invalid — shape alone must
      // not validate a planted shim.
      const outsideDir = createTempRoot();
      const outsideBin = path.join(outsideDir, "evil.js");
      fs.writeFileSync(outsideBin, "#!/usr/bin/env node\n");
      expect(store.writeBinShim({ targetBin: outsideBin })).toEqual({ ok: true });
      expect(store.validateBinShim()).toEqual({
        present: true,
        valid: false,
        removed: true,
      });
    });

    it("removeBinShim is idempotent", () => {
      const { store } = createStore();
      store.writeBinShim({ targetBin: createTargetBin(store) });

      expect(store.removeBinShim()).toEqual({ removed: true });
      expect(store.removeBinShim()).toEqual({ removed: false });
      expect(() => store.removeBinShim()).not.toThrow();
    });

    it("resolvePackageBin handles string bin, object bin, and missing package.json", () => {
      const { store } = createStore();

      const stringBinDir = writeOpenclawPackageFixture(
        path.join(createTempRoot(), "openclaw"),
        { version: "1.0.0", bin: "dist/entry.js" },
      );
      expect(store.resolvePackageBin(stringBinDir)).toBe(
        path.join(stringBinDir, "dist/entry.js"),
      );

      const objectBinDir = writeOpenclawPackageFixture(
        path.join(createTempRoot(), "openclaw"),
        {
          version: "1.0.0",
          bin: { other: "dist/other.js", openclaw: "dist/entry.js" },
        },
      );
      expect(store.resolvePackageBin(objectBinDir)).toBe(
        path.join(objectBinDir, "dist/entry.js"),
      );

      const fallbackBinDir = writeOpenclawPackageFixture(
        path.join(createTempRoot(), "openclaw"),
        { version: "1.0.0", bin: { anything: "dist/entry.js" } },
      );
      expect(store.resolvePackageBin(fallbackBinDir)).toBe(
        path.join(fallbackBinDir, "dist/entry.js"),
      );

      expect(store.resolvePackageBin(createTempRoot())).toBeNull();
    });

    it("resolvePackageBin refuses bin entries that escape their own package", () => {
      const { store } = createStore();

      // A hostile package.json must not be able to point the PATH shim at a
      // file outside the overlay tree ("../" escapes get no shim).
      const stringEscapeDir = writeOpenclawPackageFixture(
        path.join(createTempRoot(), "openclaw"),
        { version: "1.0.0", bin: "../../evil.js" },
      );
      expect(store.resolvePackageBin(stringEscapeDir)).toBeNull();

      const objectEscapeDir = writeOpenclawPackageFixture(
        path.join(createTempRoot(), "openclaw"),
        { version: "1.0.0", bin: { openclaw: "../outside/entry.js" } },
      );
      expect(store.resolvePackageBin(objectEscapeDir)).toBeNull();

      // An absolute path outside the package is refused too.
      const absoluteEscapeDir = writeOpenclawPackageFixture(
        path.join(createTempRoot(), "openclaw"),
        { version: "1.0.0", bin: { openclaw: "/etc/passwd" } },
      );
      expect(store.resolvePackageBin(absoluteEscapeDir)).toBeNull();

      // The package dir itself (empty relative resolving to the dir) is not a
      // valid bin either — only paths strictly inside the package pass.
      const insideDir = writeOpenclawPackageFixture(
        path.join(createTempRoot(), "openclaw"),
        { version: "1.0.0", bin: { openclaw: "dist/entry.js" } },
      );
      expect(store.resolvePackageBin(insideDir)).toBe(
        path.join(insideDir, "dist/entry.js"),
      );
    });
  });
});
