const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createOpenclawReleaseChannelStore,
  formatServerPidDecision,
  isMigrationClassHold,
  kManagedDirName,
  kMigrationHoldReasons,
  kOpenclawActivationSentinelName,
  kOpenclawStagingDirPrefix,
  kOpenclawStagingMaxAgeMs,
  kStructuralHoldReasons,
  normalizeState,
} = require("../../lib/server/openclaw-release-channel");
const { getProcessBootId } = require("../../lib/server/boot-id");

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
        lastTransition: null,
        pinLag: null,
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
        // Structural-hold fields (#76 Codex 6) — absent on a migration hold.
        detail: null,
        installed: null,
        expected: null,
        bootId: null,
      });
      expect(gatewayHold.blamedKeys).toHaveLength(50);
    });

    describe("config-gate records (#76 RC3 / A5 / Codex 6)", () => {
      it("round-trips lastTransition and nulls unknown kinds/sources so a newer AlphaClaw's stamp authorizes nothing", () => {
        const { store } = createStore();
        const stamp = {
          at: 1_700_000_000_000,
          from: "2026.9.2",
          to: "2026.7.1-2",
          kind: "downgrade",
          source: "operator_apply",
          reason: null,
          operationId: "2f8c1f2e-0d2a-4b1e-9a11-6f2f8c1f2e0d",
          ok: true,
          consumedAt: null,
        };
        store.writeState({ lastTransition: stamp });
        expect(store.readState().lastTransition).toEqual(stamp);

        // Tri-state ok: true / false / anything else → null (in flight).
        expect(normalizeState({ lastTransition: { ...stamp, ok: false } }).lastTransition.ok).toBe(false);
        expect(normalizeState({ lastTransition: { ...stamp, ok: "yes" } }).lastTransition.ok).toBe(null);
        expect(normalizeState({ lastTransition: { ...stamp, ok: undefined } }).lastTransition.ok).toBe(null);
        // consumedAt is a number or null.
        expect(normalizeState({ lastTransition: { ...stamp, consumedAt: 5 } }).lastTransition.consumedAt).toBe(5);
        expect(normalizeState({ lastTransition: { ...stamp, consumedAt: "5" } }).lastTransition.consumedAt).toBe(null);
        // Unknown vocabulary → null fields; a missing `to` → no stamp at all.
        const foreign = normalizeState({
          lastTransition: { ...stamp, kind: "sideways", source: "time_travel", reason: 7, operationId: 9 },
        }).lastTransition;
        expect(foreign).toMatchObject({ kind: null, source: null, reason: null, operationId: null, to: "2026.7.1-2" });
        expect(normalizeState({ lastTransition: { ...stamp, to: "" } }).lastTransition).toBe(null);
        expect(normalizeState({ lastTransition: { ...stamp, to: 42 } }).lastTransition).toBe(null);
        for (const bogus of ["stamp", ["a"], 42, null]) {
          expect(normalizeState({ lastTransition: bogus }).lastTransition).toBe(null);
        }
        // `at` must be a finite number.
        expect(normalizeState({ lastTransition: { ...stamp, at: "now" } }).lastTransition.at).toBe(null);
        // A dev apply has no version order: kind "dev" is vocabulary, not junk.
        expect(normalizeState({ lastTransition: { ...stamp, kind: "dev", to: "a1b2c3d" } }).lastTransition).toMatchObject({ kind: "dev", to: "a1b2c3d" });
      });

      it("round-trips pinLag through its whitelist and nulls anything that cannot name the lagging pair", () => {
        const { store } = createStore();
        const pinLag = {
          pin: "2026.9.2",
          installed: "2026.7.1-2",
          at: 1_700_000_000_000,
          bootId: "123:1700000000000",
          bootsSeen: 2,
        };
        store.writeState({ pinLag });
        expect(store.readState().pinLag).toEqual(pinLag);
        // Pre-#76 state files have no pinLag: explicit null, never undefined.
        expect(normalizeState({}).pinLag).toBe(null);
        // Whitelist: unknown keys are dropped, wrong-typed fields null out.
        expect(
          normalizeState({ pinLag: { ...pinLag, extra: "x", at: "now", bootId: 7, bootsSeen: "2" } }).pinLag,
        ).toEqual({ pin: "2026.9.2", installed: "2026.7.1-2", at: null, bootId: null, bootsSeen: null });
        // A record that cannot name both the pin and the lagging tree can
        // never excuse a divergence — it is null, not a half-record.
        expect(normalizeState({ pinLag: { ...pinLag, pin: "" } }).pinLag).toBe(null);
        expect(normalizeState({ pinLag: { ...pinLag, installed: 42 } }).pinLag).toBe(null);
        expect(normalizeState({ pinLag: { at: 1, bootsSeen: 1 } }).pinLag).toBe(null);
        for (const bogus of ["yes", ["2026.9.2"], 42, null, true]) {
          expect(normalizeState({ pinLag: bogus }).pinLag).toBe(null);
        }
        // Malformed on disk → null after a read/write round trip, not junk.
        store.writeState({ pinLag: "yes" });
        expect(store.readState().pinLag).toBe(null);
      });

      it("keeps configMigration.lastRestore through normalization and nulls a malformed one", () => {
        const { store } = createStore();
        const lastRestore = {
          at: 1_700_000_000_000,
          from: "openclaw.json.pre-fix-2026.7.1-2.bak",
          previousCompletedForVersion: "2026.9.2",
          diffPath: "/data/.openclaw/.alphaclaw/config-gate/1700000000000.json",
          preRestorePath: "/data/.openclaw/openclaw.json.pre-restore-1700000000000.bak",
          bootId: "123:1700000000000",
          source: "round_trip",
        };
        store.writeState({
          configMigration: {
            completedForVersion: "2026.7.1-2",
            lastAttempt: { version: "2026.7.1-2", at: 1, ok: true },
            lastRestore,
          },
        });
        const migration = store.readState().configMigration;
        expect(migration.lastRestore).toEqual(lastRestore);
        expect(migration.completedForVersion).toBe("2026.7.1-2");
        // Pre-#76 records have no lastRestore: explicit null, never undefined.
        expect(
          normalizeState({ configMigration: { completedForVersion: "1.0.0" } }).configMigration.lastRestore,
        ).toBe(null);
        // Non-string / non-numeric fields normalize to null; junk shapes to null.
        expect(
          normalizeState({
            configMigration: { lastRestore: { at: "yesterday", from: 7, source: ["x"], bootId: 1 } },
          }).configMigration.lastRestore,
        ).toEqual({
          at: null,
          from: null,
          previousCompletedForVersion: null,
          diffPath: null,
          preRestorePath: null,
          bootId: null,
          source: null,
        });
        expect(
          normalizeState({ configMigration: { lastRestore: "restored" } }).configMigration.lastRestore,
        ).toBe(null);
      });

      it("carries the structural-hold fields (detail/installed/expected/bootId) of a version_mismatch hold", () => {
        const { store } = createStore();
        const hold = {
          reason: "version_mismatch",
          at: 5,
          operationId: null,
          blamedKeys: [],
          detail: "OpenClaw 2026.7.1-2 is installed but 2026.9.2 is the recorded build",
          installed: "2026.7.1-2",
          expected: "2026.9.2",
          bootId: "123:1700000000000",
        };
        store.writeState({ gatewayHold: hold });
        expect(store.readState().gatewayHold).toEqual(hold);
        // Non-string structural fields normalize to null rather than leaking.
        expect(
          normalizeState({ gatewayHold: { reason: "version_mismatch", installed: 1, expected: {}, bootId: [], detail: 0 } }).gatewayHold,
        ).toMatchObject({ installed: null, expected: null, bootId: null, detail: null });
      });

      it("ONE hold model: a pre-#76 free-text {reason} hold round-trips unchanged and stays migration-class", () => {
        const { store } = createStore();
        // The shape the boot reconciler wrote before structural holds existed
        // (and still writes today for its doctor/snapshot/gateway-running holds).
        const legacy = {
          reason: "settings migration for 2026.9.2 failed: doctor exit 1",
          at: 1_700_000_000_000,
          operationId: "2f8c1f2e-0d2a-4b1e-9a11-6f2f8c1f2e0d",
          blamedKeys: ["gateway.controlUi.legacy"],
        };
        store.writeState({ gatewayHold: legacy });
        const hold = store.readState().gatewayHold;
        expect(hold).toEqual({ ...legacy, detail: null, installed: null, expected: null, bootId: null });
        // No `error` key materializes for a hold written without one — the
        // reconciler compares the hold it set with the one it reads back.
        expect(Object.prototype.hasOwnProperty.call(hold, "error")).toBe(false);
        expect(isMigrationClassHold(hold)).toBe(true);
        // The bare {reason} shape (nothing else) normalizes the same way.
        expect(
          normalizeState({ gatewayHold: { reason: "config snapshot failed: EACCES" } }).gatewayHold,
        ).toEqual({
          reason: "config snapshot failed: EACCES",
          at: null,
          operationId: null,
          blamedKeys: [],
          detail: null,
          installed: null,
          expected: null,
          bootId: null,
        });
      });

      it("round-trips the structured activation_failed hold ({ reason, at, installed, expected, bootId, error }) and drops a non-string error", () => {
        const { store } = createStore();
        const structured = {
          reason: "activation_failed",
          at: 1_700_000_000_500,
          operationId: null,
          blamedKeys: [],
          detail: "OpenClaw 2026.9.2 could not be activated: the copy failed after the old tree was removed",
          installed: "2026.7.1-2",
          expected: "2026.9.2",
          bootId: "123:1700000000000",
          error: "ENOSPC: no space left on device, copyfile",
        };
        store.writeState({ gatewayHold: structured });
        expect(store.readState().gatewayHold).toEqual(structured);
        expect(isMigrationClassHold(structured)).toBe(false);
        for (const bogus of [new Error("x"), 42, null, ""]) {
          const hold = normalizeState({ gatewayHold: { ...structured, error: bogus } }).gatewayHold;
          expect(Object.prototype.hasOwnProperty.call(hold, "error"), String(bogus)).toBe(false);
          expect(hold).toMatchObject({ reason: "activation_failed", installed: "2026.7.1-2", expected: "2026.9.2" });
        }
      });

      it("kMigrationHoldReasons / kStructuralHoldReasons partition isMigrationClassHold; garbage is never a hold", () => {
        expect(kMigrationHoldReasons).toEqual(["config_migration_failed", "migration_gate_error", "doctor_failed"]);
        expect(kStructuralHoldReasons).toEqual(["version_mismatch", "state_db_unreadable", "activation_failed"]);
        expect(Object.isFrozen(kMigrationHoldReasons)).toBe(true);
        expect(Object.isFrozen(kStructuralHoldReasons)).toBe(true);
        for (const reason of kMigrationHoldReasons) {
          expect(isMigrationClassHold({ reason, at: 1 }), reason).toBe(true);
        }
        for (const reason of kStructuralHoldReasons) {
          expect(isMigrationClassHold({ reason, at: 1 }), reason).toBe(false);
        }
        for (const garbage of [null, undefined, {}, { reason: "" }, { reason: 42 }, "held", ["held"]]) {
          expect(isMigrationClassHold(garbage)).toBe(false);
        }
      });
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

  describe("managed-dir and overlay path exports (plan pre-flight)", () => {
    it("exposes managedDir / kManagedDirName / overlayCompletePath so no module recomputes <openclawDir>/.alphaclaw", () => {
      const { store, openclawDir } = createStore();
      expect(store.kManagedDirName).toBe(".alphaclaw");
      expect(kManagedDirName).toBe(".alphaclaw");
      expect(store.managedDir).toBe(path.join(openclawDir, ".alphaclaw"));
      expect(path.dirname(store.serverPidPath)).toBe(store.managedDir);
      expect(path.dirname(store.statePath)).toBe(store.managedDir);
      expect(store.overlayCompletePath("1.2.3")).toBe(
        path.join(store.overlayDir("1.2.3"), ".overlay-complete.json"),
      );
    });

    it("overlayPresent is the weaker 'directory exists' test: true for a half-saved entry hasOverlay rejects", () => {
      const { store } = createStore();
      expect(store.overlayPresent("1.2.3")).toBe(false);
      fs.mkdirSync(path.join(store.overlayDir("1.2.3"), "openclaw"), { recursive: true });
      expect(store.overlayPresent("1.2.3")).toBe(true);
      expect(store.hasOverlay("1.2.3")).toBe(false);
      // Unsafe / non-string names are false, never a throw.
      expect(store.overlayPresent("../etc")).toBe(false);
      expect(store.overlayPresent(null)).toBe(false);
      expect(store.overlayPresent("")).toBe(false);
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

  describe("listOverlays (#76 B1.4)", () => {
    it("lists complete entries only, newest first; a missing store is []", () => {
      const { store } = createStore();
      expect(store.listOverlays()).toEqual([]);
      for (const version of ["2026.7.1-2", "2026.9.2", "2026.9.1-beta.1", "2026.8.2"]) {
        store.saveOverlayFromTempInstall({
          openclawPackageDir: writeOpenclawPackageFixture(path.join(createTempRoot(), "openclaw"), { version }),
          version,
        });
      }
      // A half-saved entry (no completion file) and a stray file are not overlays.
      fs.mkdirSync(path.join(store.overlayDir("2026.10.0"), "openclaw"), { recursive: true });
      fs.writeFileSync(path.join(store.overlayStoreDir, ".DS_Store"), "");
      // A completion file naming another version is a torn entry, too.
      store.saveOverlayFromTempInstall({
        openclawPackageDir: writeOpenclawPackageFixture(path.join(createTempRoot(), "openclaw"), { version: "2026.6.0" }),
        version: "2026.6.0",
      });
      fs.writeFileSync(store.overlayCompletePath("2026.6.0"), JSON.stringify({ version: "2026.5.0" }));

      expect(store.listOverlays()).toEqual(["2026.9.2", "2026.9.1-beta.1", "2026.8.2", "2026.7.1-2"]);
      expect(store.listOverlays().every((version) => store.hasOverlay(version))).toBe(true);
    });
  });

  describe("activateOverlayAsync — staged, verified, atomic swap (#76 B1.2 / Codex 3)", () => {
    const kBin = { openclaw: "dist/entry.js" };
    const saveOverlay = (store, version, { bin = kBin, mutate = null } = {}) => {
      const packageDir = writeOpenclawPackageFixture(path.join(createTempRoot(), "openclaw"), { version, bin });
      if (mutate) mutate(packageDir);
      expect(store.saveOverlayFromTempInstall({ openclawPackageDir: packageDir, version })).toEqual({ ok: true });
    };
    const stagingEntries = (installDir) =>
      fs.readdirSync(path.join(installDir, "node_modules")).filter((name) => name.startsWith(kOpenclawStagingDirPrefix));
    const sentinelFile = (installDir) => path.join(installDir, "node_modules", kOpenclawActivationSentinelName);
    const kBootId = "77:1700000000000";

    it("happy path: stages beside the live tree, swaps by rename, writes the sentinel, leaves no staging dir", async () => {
      const { store } = createStore({ nowFn: () => 42 });
      const installDir = createTempRoot();
      const liveDir = writeInstallFixture(installDir, { version: "1.0.0" });
      fs.writeFileSync(path.join(liveDir, "old-file.js"), "// stale\n");
      store.writeSentinel({ installDir, version: "1.0.0" });
      saveOverlay(store, "2.0.0");

      await expect(store.activateOverlayAsync({ installDir, version: "2.0.0", bootId: kBootId })).resolves.toEqual({ ok: true });

      expect(fs.existsSync(path.join(liveDir, "old-file.js"))).toBe(false);
      expect(store.readInstalledVersion({ installDir })).toBe("2.0.0");
      expect(fs.existsSync(path.join(liveDir, "dist", "entry.js"))).toBe(true);
      expect(JSON.parse(fs.readFileSync(sentinelFile(installDir), "utf8"))).toEqual({ version: "2.0.0", completedAt: 42 });
      expect(store.needsActivation({ installDir, expectedVersion: "2.0.0" })).toBe(false);
      expect(stagingEntries(installDir)).toEqual([]);
      expect(store.overlayStagingDir({ installDir, bootId: kBootId })).toBe(
        path.join(installDir, "node_modules", `${kOpenclawStagingDirPrefix}${kBootId}`),
      );
      // The overlay itself is untouched: a later rollback can re-activate it.
      expect(store.hasOverlay("2.0.0")).toBe(true);
      expect(kOpenclawStagingMaxAgeMs).toBe(10 * 60 * 1000);
    });

    it("orders the swap: copy → verify → sentinel unlink → rm old tree → rename → sentinel LAST", async () => {
      const ops = [];
      const note = (name, target) => ops.push(`${name}:${path.basename(String(target))}`);
      const fsModule = new Proxy(fs, {
        get(target, prop) {
          if (prop === "promises") {
            return new Proxy(target.promises, {
              get(promises, method) {
                const fn = Reflect.get(promises, method);
                if (!["cp", "rm", "rename", "unlink"].includes(method)) return fn;
                return (...args) => {
                  note(method, args[0]);
                  return fn.apply(promises, args);
                };
              },
            });
          }
          if (prop === "writeFileSync") {
            return (file, ...rest) => {
              note("writeFileSync", file);
              return target.writeFileSync(file, ...rest);
            };
          }
          return Reflect.get(target, prop);
        },
      });
      const { store } = createStore({ fsModule });
      const installDir = createTempRoot();
      writeInstallFixture(installDir, { version: "1.0.0" });
      store.writeSentinel({ installDir, version: "1.0.0" });
      saveOverlay(store, "2.0.0");
      ops.length = 0;

      await expect(store.activateOverlayAsync({ installDir, version: "2.0.0", bootId: kBootId })).resolves.toEqual({ ok: true });

      const staging = `${kOpenclawStagingDirPrefix}${kBootId}`;
      expect(ops).toEqual([
        `rm:${staging}`, // a leftover from an earlier attempt by this boot
        "cp:openclaw", // overlay package → staging (verify reads follow, not recorded)
        `unlink:${kOpenclawActivationSentinelName}`,
        "rm:openclaw", // the OLD live tree, only after verification passed
        `rename:${staging}`,
        expect.stringMatching(new RegExp(`^writeFileSync:\\.${kOpenclawActivationSentinelName.replace(/\./g, "\\.")}\\.\\d+\\.tmp$`)),
      ]);
    });

    it("verify failure (version disagrees, bin missing, bin unresolvable) leaves the old tree, its sentinel and the overlay intact — nothing is removed before verification", async () => {
      const { store } = createStore({ nowFn: () => 7 });
      const installDir = createTempRoot();
      const liveDir = writeInstallFixture(installDir, { version: "1.0.0" });
      fs.writeFileSync(path.join(liveDir, "old-file.js"), "// still here\n");
      store.writeSentinel({ installDir, version: "1.0.0" });
      const expectUntouched = () => {
        expect(store.readInstalledVersion({ installDir })).toBe("1.0.0");
        expect(fs.existsSync(path.join(liveDir, "old-file.js"))).toBe(true);
        expect(store.readSentinel({ installDir })).toEqual({ version: "1.0.0", completedAt: 7 });
        expect(stagingEntries(installDir)).toEqual([]);
      };

      // Completion file says 2.0.0, package.json says 2.0.1 (a torn or tampered entry).
      saveOverlay(store, "2.0.0");
      fs.writeFileSync(
        path.join(store.overlayPackageDir("2.0.0"), "package.json"),
        JSON.stringify({ name: "openclaw", version: "2.0.1", bin: kBin }),
      );
      await expect(store.activateOverlayAsync({ installDir, version: "2.0.0", bootId: kBootId })).resolves.toEqual({
        ok: false,
        stage: "verify",
        error: expect.stringContaining("openclaw@2.0.1, expected 2.0.0"),
      });
      expectUntouched();
      expect(store.hasOverlay("2.0.0")).toBe(true);

      // No bin at all.
      saveOverlay(store, "3.0.0", { bin: null });
      await expect(store.activateOverlayAsync({ installDir, version: "3.0.0", bootId: kBootId })).resolves.toEqual({
        ok: false,
        stage: "verify",
        error: expect.stringContaining("no resolvable bin"),
      });
      expectUntouched();

      // A bin entry that names a file the tree does not contain.
      saveOverlay(store, "4.0.0", { bin: { openclaw: "dist/missing.js" } });
      await expect(store.activateOverlayAsync({ installDir, version: "4.0.0", bootId: kBootId })).resolves.toEqual({
        ok: false,
        stage: "verify",
        error: expect.stringContaining("no resolvable bin"),
      });
      expectUntouched();
    });

    it("refuses a missing overlay, an install-guard overlay and a traversal-shaped name before staging anything", async () => {
      const { store } = createStore();
      const installDir = createTempRoot();
      writeInstallFixture(installDir, { version: "1.0.0" });
      store.writeSentinel({ installDir, version: "1.0.0" });

      await expect(store.activateOverlayAsync({ installDir, version: "9.9.9", bootId: kBootId })).resolves.toEqual({
        ok: false,
        stage: "overlay",
        error: expect.stringContaining("no complete overlay for openclaw@9.9.9"),
      });
      saveOverlay(store, "2.0.0", {
        mutate: (dir) => fs.writeFileSync(path.join(dir, "dist", "openclaw-install-guard"), "OpenClaw package preinstall has not completed."),
      });
      await expect(store.activateOverlayAsync({ installDir, version: "2.0.0", bootId: kBootId })).resolves.toEqual({
        ok: false,
        stage: "overlay",
        error: expect.stringMatching(/incomplete \(install guard present\)/),
      });
      await expect(store.activateOverlayAsync({ installDir, version: "../x", bootId: kBootId })).resolves.toEqual(
        expect.objectContaining({ ok: false, stage: "overlay" }),
      );

      expect(stagingEntries(installDir)).toEqual([]);
      expect(store.readInstalledVersion({ installDir })).toBe("1.0.0");
      expect(store.readSentinel({ installDir })).toEqual(expect.objectContaining({ version: "1.0.0" }));
    });

    it("a sentinel write failure after the swap leaves the NEW tree without a sentinel (the next boot re-activates) — the sentinel is last", async () => {
      const fsModule = new Proxy(fs, {
        get(target, prop) {
          if (prop !== "writeFileSync") return Reflect.get(target, prop);
          return (file, ...rest) => {
            if (String(file).includes(kOpenclawActivationSentinelName)) {
              throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
            }
            return target.writeFileSync(file, ...rest);
          };
        },
      });
      const { store } = createStore({ fsModule });
      const installDir = createTempRoot();
      writeInstallFixture(installDir, { version: "1.0.0" });
      saveOverlay(store, "2.0.0");

      await expect(store.activateOverlayAsync({ installDir, version: "2.0.0", bootId: kBootId })).resolves.toEqual({
        ok: false,
        stage: "sentinel",
        error: expect.stringContaining("EROFS"),
      });

      expect(store.readInstalledVersion({ installDir })).toBe("2.0.0");
      expect(store.readSentinel({ installDir })).toBeNull();
      expect(store.needsActivation({ installDir, expectedVersion: "2.0.0" })).toBe(true);
      expect(stagingEntries(installDir)).toEqual([]);
    });

    it("a caller-supplied bootId is sanitized (separators can never move the staging dir out of node_modules); the default is this process's boot id", async () => {
      const { store } = createStore();
      const installDir = createTempRoot();
      writeInstallFixture(installDir, { version: "1.0.0" });
      saveOverlay(store, "2.0.0");
      saveOverlay(store, "3.0.0");

      expect(store.overlayStagingDir({ installDir, bootId: "../../escape/12:34" })).toBe(
        path.join(installDir, "node_modules", `${kOpenclawStagingDirPrefix}..-..-escape-12:34`),
      );
      expect(() => store.overlayStagingDir({ installDir, bootId: "" })).toThrow(/unsafe staging boot id/);
      expect(store.overlayStagingDir({ installDir, bootId: getProcessBootId() })).toBe(
        path.join(installDir, "node_modules", `${kOpenclawStagingDirPrefix}${getProcessBootId()}`),
      );

      await expect(store.activateOverlayAsync({ installDir, version: "2.0.0", bootId: "../../escape/12:34" })).resolves.toEqual({ ok: true });
      expect(fs.existsSync(path.join(installDir, "escape"))).toBe(false);
      expect(fs.existsSync(path.join(path.dirname(installDir), "escape"))).toBe(false);
      expect(store.readInstalledVersion({ installDir })).toBe("2.0.0");

      await expect(store.activateOverlayAsync({ installDir, version: "3.0.0", bootId: "" })).resolves.toEqual({
        ok: false,
        stage: "staging",
        error: expect.stringContaining("unsafe staging boot id"),
      });
      expect(store.readInstalledVersion({ installDir })).toBe("2.0.0");

      // No bootId → getProcessBootId().
      await expect(store.activateOverlayAsync({ installDir, version: "3.0.0" })).resolves.toEqual({ ok: true });
      expect(store.readInstalledVersion({ installDir })).toBe("3.0.0");
      expect(stagingEntries(installDir)).toEqual([]);
    });

    it("sweepStaleStagingDirs removes staging dirs older than 10 min, keeps young ones and this boot's own, and never touches the live tree or sentinel", () => {
      const { store } = createStore();
      const installDir = createTempRoot();
      writeInstallFixture(installDir, { version: "1.0.0" });
      store.writeSentinel({ installDir, version: "1.0.0" });
      const nodeModules = path.join(installDir, "node_modules");
      const plant = (name, ageMs) => {
        const dir = path.join(nodeModules, name);
        fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
        fs.writeFileSync(path.join(dir, "package.json"), "{}");
        const seconds = (Date.now() - ageMs) / 1000;
        fs.utimesSync(dir, seconds, seconds);
      };
      const own = `${kOpenclawStagingDirPrefix}${getProcessBootId()}`;
      plant(`${kOpenclawStagingDirPrefix}11:1000`, 11 * 60 * 1000); // a dead boot's copy: rename never ran
      plant(`${kOpenclawStagingDirPrefix}12:2000`, 60 * 1000); // young: possibly a sibling mid-copy
      plant(own, 11 * 60 * 1000); // this boot's in-flight copy: never swept, whatever its age
      plant(".other-dotdir", 11 * 60 * 1000); // not ours

      // Missing node_modules → empty, never a throw.
      expect(store.sweepStaleStagingDirs({ installDir: createTempRoot() })).toEqual({ removed: [], kept: [] });

      const result = store.sweepStaleStagingDirs({ installDir });
      expect(result.removed).toEqual([`${kOpenclawStagingDirPrefix}11:1000`]);
      expect([...result.kept].sort()).toEqual([`${kOpenclawStagingDirPrefix}12:2000`, own].sort());
      expect(fs.existsSync(path.join(nodeModules, `${kOpenclawStagingDirPrefix}11:1000`))).toBe(false);
      expect(fs.existsSync(path.join(nodeModules, `${kOpenclawStagingDirPrefix}12:2000`))).toBe(true);
      expect(fs.existsSync(path.join(nodeModules, own))).toBe(true);
      expect(fs.existsSync(path.join(nodeModules, ".other-dotdir"))).toBe(true);
      expect(store.readInstalledVersion({ installDir })).toBe("1.0.0");
      expect(store.readSentinel({ installDir })).toEqual(expect.objectContaining({ version: "1.0.0" }));

      // Clock seam: once the young dir ages past the limit it goes too; the own dir still stays.
      const later = store.sweepStaleStagingDirs({ installDir, nowMs: Date.now() + kOpenclawStagingMaxAgeMs });
      expect(later.removed).toEqual([`${kOpenclawStagingDirPrefix}12:2000`]);
      expect(later.kept).toEqual([own]);
    });

    it("staging-rename crash case: a stale staging dir beside a gutted live tree is swept and the overlay re-activates cleanly", async () => {
      const { store } = createStore();
      const installDir = createTempRoot();
      saveOverlay(store, "2.0.0");
      // Crash after rm(old tree), before rename: no live tree, no sentinel, a
      // complete staging copy owned by a boot that is gone.
      const nodeModules = path.join(installDir, "node_modules");
      const stale = path.join(nodeModules, `${kOpenclawStagingDirPrefix}9:9`);
      fs.mkdirSync(nodeModules, { recursive: true });
      fs.cpSync(store.overlayPackageDir("2.0.0"), stale, { recursive: true });
      const seconds = (Date.now() - 11 * 60 * 1000) / 1000;
      fs.utimesSync(stale, seconds, seconds);
      expect(store.readInstalledVersion({ installDir })).toBeNull();
      expect(store.needsActivation({ installDir, expectedVersion: "2.0.0" })).toBe(true);

      expect(store.sweepStaleStagingDirs({ installDir }).removed).toEqual([`${kOpenclawStagingDirPrefix}9:9`]);
      await expect(store.activateOverlayAsync({ installDir, version: "2.0.0", bootId: "10:10" })).resolves.toEqual({ ok: true });

      expect(store.readInstalledVersion({ installDir })).toBe("2.0.0");
      expect(store.needsActivation({ installDir, expectedVersion: "2.0.0" })).toBe(false);
      expect(stagingEntries(installDir)).toEqual([]);
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
    // A lookalike SERVER carries the bin entry AND the `start` verb (the argv
    // test is verb-scoped since #76 — `alphaclaw diagnose` is not a server).
    const spawnHolder = (...argvTags) =>
      spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 30000)", ...argvTags],
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
      const server = spawnHolder("/opt/alphaclaw/bin/alphaclaw.js", "start");
      // The bin entry WITHOUT the server verb: an operator's `alphaclaw
      // diagnose`, the /usr/local/bin shim for any other verb — live, argv
      // names alphaclaw, and still not a server (Eng 3A / CEO 6.3).
      const otherVerb = spawnHolder("/opt/alphaclaw/bin/alphaclaw.js");
      try {
        writeClaim(store, { pid: stranger.pid, at: Date.now() });
        expect(store.readLiveServerPid()).toBeNull();
        writeClaim(store, { pid: otherVerb.pid, at: Date.now() });
        expect(store.readLiveServerPidEvidence()).toBeNull();
        expect(store.describeServerPidDecision().reason).toBe("not_alphaclaw");
        writeClaim(store, { pid: server.pid, at: Date.now() });
        expect(store.readLiveServerPid()).toBe(server.pid);
      } finally {
        stranger.kill("SIGKILL");
        server.kill("SIGKILL");
        otherVerb.kill("SIGKILL");
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

  // F004 follow-up: the single-instance refusal must be backed by evidence.
  // A hard-killed predecessor (`docker rm -f`) leaves its pidfile on the
  // volume and a fresh container's early processes reuse low pid numbers, so
  // kill(pid, 0) alone says "alive". The record now carries the owner's
  // kernel start time; a mismatch means the pid was recycled.
  describe("server pid guard evidence (recycled pid after a hard kill)", () => {
    const { spawn } = require("child_process");
    const { readProcStartTicks } = require("../../lib/server/utils/safe-file");
    const spawnSleeper = () =>
      spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    const writePidRecord = (store, record) => {
      fs.mkdirSync(path.dirname(store.serverPidPath), { recursive: true });
      fs.writeFileSync(store.serverPidPath, JSON.stringify(record));
    };
    const hasProc = process.platform === "linux" && fs.existsSync(`/proc/${process.pid}/stat`);

    it("records the owner's kernel start time alongside the pid", () => {
      const { store } = createStore();
      fs.mkdirSync(path.dirname(store.serverPidPath), { recursive: true });
      store.writeServerPid();
      const record = JSON.parse(fs.readFileSync(store.serverPidPath, "utf8"));
      expect(record.pid).toBe(process.pid);
      // Format 2 (#76): the claim also names the container it was written in.
      expect(record.format).toBe(2);
      expect(record.legacyClaim).toBeUndefined();
      if (hasProc) {
        expect(record.startTicks).toBe(readProcStartTicks(process.pid, fs));
        expect(record.containerStartTicks).toBe(readProcStartTicks(1, fs));
      } else {
        expect(record.startTicks).toBeNull();
        expect(record.containerStartTicks).toBeNull();
      }
    });

    it.skipIf(!hasProc)("corroborates a live owner whose start time matches the record", () => {
      const child = spawnSleeper();
      try {
        const { store } = createStore();
        writePidRecord(store, { pid: child.pid, at: 1, startTicks: readProcStartTicks(child.pid, fs) });
        expect(store.readLiveServerPidEvidence()).toEqual({ pid: child.pid, corroborated: true });
        expect(store.readLiveServerPid()).toBe(child.pid);
      } finally {
        child.kill("SIGKILL");
      }
    });

    it.skipIf(!hasProc)("treats a live pid with a DIFFERENT start time as recycled — no owner, claim replaceable", () => {
      const child = spawnSleeper();
      try {
        const { store } = createStore();
        writePidRecord(store, {
          pid: child.pid,
          at: 1,
          startTicks: readProcStartTicks(child.pid, fs) - 12345,
        });
        expect(store.readLiveServerPidEvidence()).toBeNull();
        expect(store.readLiveServerPid()).toBeNull();
        store.writeServerPid();
        expect(JSON.parse(fs.readFileSync(store.serverPidPath, "utf8")).pid).toBe(process.pid);
      } finally {
        child.kill("SIGKILL");
      }
    });

    it("a legacy record (no startTicks) naming a live alphaclaw-looking process is live but UNcorroborated; a stranger is stale", () => {
      // Reconciled with #64: identity-less claims are trusted only when the
      // live process's argv names the alphaclaw entry, and even then the
      // launcher gets corroborated:false (skip the sync, keep booting).
      const { spawn } = require("child_process");
      const lookalike = spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 30000)", "/opt/alphaclaw/bin/alphaclaw.js", "start"],
        { stdio: "ignore" },
      );
      const stranger = spawnSleeper();
      try {
        const { store } = createStore();
        // A real wall-clock `at`: a legacy claim older than this container is
        // provably from a previous one (#76) — a fresh claim is not.
        writePidRecord(store, { pid: lookalike.pid, at: Date.now() });
        expect(store.readLiveServerPidEvidence()).toEqual({ pid: lookalike.pid, corroborated: false });
        expect(store.readLiveServerPid()).toBe(lookalike.pid);
        if (hasProc) {
          writePidRecord(store, { pid: stranger.pid, at: Date.now() });
          expect(store.readLiveServerPidEvidence()).toBeNull();
        }
      } finally {
        lookalike.kill("SIGKILL");
        stranger.kill("SIGKILL");
      }
    });

    it("returns null for this process, a dead pid, or garbage", () => {
      const { store } = createStore();
      writePidRecord(store, { pid: process.pid, at: 1 });
      expect(store.readLiveServerPidEvidence()).toBeNull();
      writePidRecord(store, { pid: 2 ** 22 - 1, at: 1 }); // above default pid_max → ESRCH
      expect(store.readLiveServerPidEvidence()).toBeNull();
      fs.writeFileSync(store.serverPidPath, "not json");
      expect(store.readLiveServerPidEvidence()).toBeNull();
    });
  });

  // Issue #76 RC1/RC2. A pid number can name a THREAD: for a thread `tid` of
  // process `pid`, kill(tid, 0) succeeds and /proc/<tid>/cmdline is the
  // leader's argv, so a stale legacy {pid, at} claim colliding with one of
  // our own V8/libuv threads passed as "another alphaclaw server is live"
  // and the boot sync (the step that activates the applied overlay) was
  // skipped for 45 minutes. And a legacy claim that survives every check
  // used to stay a legacy claim forever — nothing ever disproved it.
  describe("server pid guard — thread ids, container identity and legacy convergence (#76)", () => {
    const os = require("os");
    const { spawn } = require("child_process");
    const {
      readProcStartTicks,
      readContainerStartTicks,
    } = require("../../lib/server/openclaw-lock-contention");
    const hasProc = process.platform === "linux" && fs.existsSync(`/proc/${process.pid}/status`);
    const kServerArgv = ["/opt/alphaclaw/bin/alphaclaw.js", "start", "--root-dir", "/data"];
    const spawnLookalike = (argv = kServerArgv) =>
      spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", ...argv], { stdio: "ignore" });
    // Node starts its platform threads immediately; poll only for a racing
    // kernel on slow CI hosts, then ASSERT the fixture really is multi-threaded
    // (CEO 6.1) so a single-threaded child can never make the test vacuous.
    const readSiblingTid = async (pid) => {
      let tids = [];
      for (let i = 0; i < 100; i += 1) {
        try {
          tids = fs.readdirSync(`/proc/${pid}/task`).map(Number);
          if (tids.length > 1) break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(tids.length).toBeGreaterThan(1);
      const tid = tids.find((candidate) => candidate !== pid);
      expect(tid).toEqual(expect.any(Number));
      return tid;
    };
    const writePidRecord = (store, record) => {
      fs.mkdirSync(path.dirname(store.serverPidPath), { recursive: true });
      fs.writeFileSync(store.serverPidPath, JSON.stringify(record));
    };
    // /proc/<pid>/stat as the kernel prints it (starttime is field 22).
    const statLine = (pid, ticks) =>
      `${pid} (node) S 1 ${pid} ${pid} 0 -1 4194304 623 1997 0 0 0 0 0 0 20 0 7 0 ${ticks} 4558848 825 18446744073709551615 0 0\n`;
    const statusText = (pid, tgid) => `Name:\tnode\nUmask:\t0022\nState:\tS (sleeping)\nTgid:\t${tgid}\nNgid:\t0\nPid:\t${pid}\nPPid:\t1\n`;
    // A planted /proc over the REAL fs (the store keeps writing its files to
    // the temp root): `procs[pid] = { tgid, ticks, cmdline }` describes each
    // live task; `pid1Ticks` is the container's identity. Inline on purpose
    // — gateway.test.js's installFakeProc is describe-local.
    const fakeProcFs = ({ procs = {}, pid1Ticks = 3431, uptimeSeconds = 900 } = {}) => {
      const table = () => procs;
      const readProc = (target) => {
        const text = String(target);
        if (text === "/proc/uptime") return `${uptimeSeconds}.00 ${uptimeSeconds * 4}.00\n`;
        if (text === "/proc/1/stat") return statLine(1, pid1Ticks);
        const match = /^\/proc\/(\d+)\/(stat|status|cmdline)$/.exec(text);
        if (!match) return undefined;
        const entry = table()[match[1]];
        if (!entry) throw Object.assign(new Error(`ENOENT: ${text}`), { code: "ENOENT" });
        if (match[2] === "stat") return statLine(Number(match[1]), entry.ticks);
        if (match[2] === "status") return statusText(Number(match[1]), entry.tgid ?? Number(match[1]));
        return entry.cmdline == null ? "" : entry.cmdline.split(" ").join("\0") + "\0";
      };
      return new Proxy(fs, {
        get(target, prop) {
          if (prop === "readFileSync") {
            return (file, ...rest) => {
              if (/^\/proc\//.test(String(file))) {
                const planted = readProc(file);
                if (planted !== undefined) return planted;
              }
              return target.readFileSync(file, ...rest);
            };
          }
          return Reflect.get(target, prop);
        },
      });
    };
    // Liveness oracle over the same table: ESRCH for an unknown pid.
    const fakeKill = (procs) => (pid) => {
      if (!procs[pid]) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    };
    const kNow = Date.now();
    const createFakeStore = ({ procs, pid1Ticks, containerStartMs = kNow - 10 * 60 * 1000, ...rest } = {}) =>
      createStore({
        fsModule: fakeProcFs({ procs, pid1Ticks }),
        killFn: fakeKill(procs),
        readContainerStartMs: () => containerStartMs,
        ...rest,
      });
    const kLookalikeCmdline = "node /app/bin/alphaclaw.js start --root-dir /data";

    it.skipIf(!hasProc)("a legacy claim naming a THREAD of a live lookalike server is not a server: null (reason thread), never a skip", async () => {
      const child = spawnLookalike();
      try {
        const tid = await readSiblingTid(child.pid);
        // The two checks the pre-#76 guard relied on both pass for the tid.
        expect(() => process.kill(tid, 0)).not.toThrow();
        expect(fs.readFileSync(`/proc/${tid}/cmdline`, "utf8")).toMatch(/alphaclaw\.js\0start/);
        const { store } = createStore();
        writePidRecord(store, { pid: tid, at: Date.now() });
        const decision = store.describeServerPidDecision();
        expect(decision.evidence).toBeNull();
        expect(decision.decision).toBe("proceed");
        expect(decision.reason).toBe("thread");
        expect(decision.tgid).toBe(child.pid);
        expect(decision.killOk).toBe(true);
        expect(decision.record).toEqual({ raw: { pid: tid, at: expect.any(Number) }, format: "legacy", legacyClaim: true });
        expect(store.readLiveServerPidEvidence()).toBeNull();
        // The judge is pure: nothing was written or converged.
        expect(JSON.parse(fs.readFileSync(store.serverPidPath, "utf8")).pid).toBe(tid);
        expect(store.convergeLegacyServerPidClaim(decision)).toEqual({ converged: false, reason: "not_legacy_skip" });
        // The LEADER itself is still a live lookalike server — uncorroborated.
        writePidRecord(store, { pid: child.pid, at: Date.now() });
        expect(store.describeServerPidDecision()).toEqual(
          expect.objectContaining({ reason: "legacy_argv_match", tgid: child.pid, evidence: { pid: child.pid, corroborated: false } }),
        );
      } finally {
        child.kill("SIGKILL");
      }
    });

    it.skipIf(!hasProc)("a legacy claim naming one of OUR OWN threads is own_thread → proceed, even when its argv looks like a server", async () => {
      const tid = await readSiblingTid(process.pid);
      // Our real argv is vitest's; plant a server-shaped cmdline for the tid
      // so the test proves the Tgid check fires BEFORE the argv check.
      const realFs = fs;
      const fsModule = new Proxy(realFs, {
        get(target, prop) {
          if (prop === "readFileSync") {
            return (file, ...rest) =>
              String(file) === `/proc/${tid}/cmdline`
                ? "node\0/app/bin/alphaclaw.js\0start\0"
                : target.readFileSync(file, ...rest);
          }
          return Reflect.get(target, prop);
        },
      });
      const { store } = createStore({ fsModule });
      writePidRecord(store, { pid: tid, at: Date.now() });
      const decision = store.describeServerPidDecision();
      expect(decision).toEqual(
        expect.objectContaining({ evidence: null, decision: "proceed", reason: "own_thread", tgid: process.pid, selfPid: process.pid, pid: tid }),
      );
      expect(store.readLiveServerPidEvidence()).toBeNull();
      // ...so the boot may claim the file for itself, as format 2.
      store.writeServerPid();
      const written = JSON.parse(fs.readFileSync(store.serverPidPath, "utf8"));
      expect(written).toEqual(expect.objectContaining({ pid: process.pid, format: 2, containerStartTicks: readContainerStartTicks() }));
    });

    it("a legacy claim older than this container (by > 5 min) predates it → null; a fresh one is still an uncorroborated live owner", () => {
      const procs = { 21: { tgid: 21, ticks: 5000, cmdline: kLookalikeCmdline } };
      const { store } = createFakeStore({ procs, containerStartMs: kNow - 10 * 60 * 1000 });
      writePidRecord(store, { pid: 21, at: kNow - 60 * 60 * 1000 });
      const stale = store.describeServerPidDecision();
      expect(stale).toEqual(
        expect.objectContaining({
          evidence: null,
          reason: "predates_container",
          pid: 21,
          killOk: true,
          tgid: 21,
          liveTicks: 5000,
          containerStartMs: kNow - 10 * 60 * 1000,
          claimAt: kNow - 60 * 60 * 1000,
        }),
      );
      // Inside the margin: not provably older than the container.
      writePidRecord(store, { pid: 21, at: kNow - 12 * 60 * 1000 });
      expect(store.readLiveServerPidEvidence()).toEqual({ pid: 21, corroborated: false });
      // A logical-clock stamp (test harnesses) is never compared with the container.
      writePidRecord(store, { pid: 21, at: 1 });
      expect(store.describeServerPidDecision().reason).toBe("legacy_argv_match");
      // No container estimate → the check is skipped, not failed.
      const { store: blind } = createFakeStore({ procs, readContainerStartMs: () => null });
      writePidRecord(blind, { pid: 21, at: kNow - 60 * 60 * 1000 });
      expect(blind.readLiveServerPidEvidence()).toEqual({ pid: 21, corroborated: false });
    });

    it("convergeLegacyServerPidClaim rewrites a positively identified legacy claim as format 2 with observedTicks — never startTicks — and it stays uncorroborated", () => {
      const procs = { 21: { tgid: 21, ticks: 5000, cmdline: kLookalikeCmdline } };
      const nowRef = { now: kNow };
      const { store } = createFakeStore({ procs, pid1Ticks: 3431, nowFn: () => nowRef.now, hostnameFn: () => "render-web-1" });
      writePidRecord(store, { pid: 21, at: kNow - 60 * 1000 });
      const decision = store.describeServerPidDecision();
      expect(decision.evidence).toEqual({ pid: 21, corroborated: false });
      expect(decision.reason).toBe("legacy_argv_match");
      const result = store.convergeLegacyServerPidClaim(decision);
      expect(result.converged).toBe(true);
      const record = JSON.parse(fs.readFileSync(store.serverPidPath, "utf8"));
      expect(record).toEqual({
        pid: 21,
        at: kNow - 60 * 1000, // the original claim time is preserved
        upgradedAt: kNow,
        host: "render-web-1",
        observedTicks: 5000,
        containerStartTicks: 3431,
        format: 2,
        legacyClaim: true,
      });
      expect(record.startTicks).toBeUndefined();
      // Same live process next boot: still a legacy claim, permanently
      // corroborated: false (the launcher can never refuse on it).
      const again = store.describeServerPidDecision();
      expect(again.evidence).toEqual({ pid: 21, corroborated: false });
      expect(again.record).toEqual(expect.objectContaining({ format: 2, legacyClaim: true }));
      expect(again.recordedTicks).toBe(5000);
      expect(again.recordedContainerTicks).toBe(3431);
      expect(store.readLiveServerPidEvidence()).toEqual({ pid: 21, corroborated: false });
      // The pid was recycled since (different start ticks): disproved → proceed.
      procs[21].ticks = 9001;
      const recycled = store.describeServerPidDecision();
      expect(recycled).toEqual(expect.objectContaining({ evidence: null, reason: "recycled", recordedTicks: 5000, liveTicks: 9001 }));
      expect(store.readLiveServerPidEvidence()).toBeNull();
    });

    it("a converged claim from a PREVIOUS container (pid 1 differs) is other_container → proceed, whatever pid 21 is doing now", () => {
      const procs = { 21: { tgid: 21, ticks: 5000, cmdline: kLookalikeCmdline } };
      const { store } = createFakeStore({ procs, pid1Ticks: 9999 });
      writePidRecord(store, {
        pid: 21,
        at: kNow - 60 * 1000,
        upgradedAt: kNow - 30 * 1000,
        host: os.hostname(), // a Render instance name survives the redeploy
        observedTicks: 5000, // and the ticks happen to match
        containerStartTicks: 3431,
        format: 2,
        legacyClaim: true,
      });
      const decision = store.describeServerPidDecision();
      expect(decision).toEqual(
        expect.objectContaining({ evidence: null, reason: "other_container", recordedContainerTicks: 3431, liveContainerTicks: 9999 }),
      );
      expect(store.readLiveServerPidEvidence()).toBeNull();
    });

    it("the pidfile changes at most once: repeated reads write nothing and a converged record is never re-converged (identity stays)", () => {
      const procs = { 21: { tgid: 21, ticks: 5000, cmdline: kLookalikeCmdline } };
      const { store } = createFakeStore({ procs });
      writePidRecord(store, { pid: 21, at: kNow - 60 * 1000 });
      const before = fs.statSync(store.serverPidPath).mtimeMs;
      // The grace loop re-reads the decision many times before converging.
      let decision = null;
      for (let i = 0; i < 6; i += 1) decision = store.describeServerPidDecision();
      expect(store.readLiveServerPidEvidence()).toEqual({ pid: 21, corroborated: false });
      expect(fs.statSync(store.serverPidPath).mtimeMs).toBe(before);
      expect(store.convergeLegacyServerPidClaim(decision).converged).toBe(true);
      const converged = fs.readFileSync(store.serverPidPath, "utf8");
      const afterFirst = fs.statSync(store.serverPidPath).mtimeMs;
      // Next boot on the same live process: skip again, no second write.
      const next = store.describeServerPidDecision();
      expect(next.evidence).toEqual({ pid: 21, corroborated: false });
      expect(store.convergeLegacyServerPidClaim(next)).toEqual({ converged: false, reason: "already_converged" });
      expect(fs.readFileSync(store.serverPidPath, "utf8")).toBe(converged);
      expect(fs.statSync(store.serverPidPath).mtimeMs).toBe(afterFirst);
      // writeServerPid never clobbers the live (uncorroborated) owner either.
      store.writeServerPid();
      expect(fs.readFileSync(store.serverPidPath, "utf8")).toBe(converged);
    });

    it("weak evidence never converges: an unreadable or empty cmdline skips (legacy_no_argv) but leaves the file untouched", () => {
      const procs = { 21: { tgid: 21, ticks: 5000, cmdline: null } };
      const { store } = createFakeStore({ procs });
      const raw = JSON.stringify({ pid: 21, at: kNow - 60 * 1000 });
      writePidRecord(store, JSON.parse(raw));
      const decision = store.describeServerPidDecision();
      expect(decision).toEqual(expect.objectContaining({ evidence: { pid: 21, corroborated: false }, reason: "legacy_no_argv", cmdline: "", argvMatched: null }));
      expect(store.convergeLegacyServerPidClaim(decision)).toEqual({ converged: false, reason: "weak_argv" });
      expect(fs.readFileSync(store.serverPidPath, "utf8")).toBe(raw);
      // No /proc at all (macOS): liveness alone is trusted, still no convergence.
      const noProc = createStore({
        fsModule: new Proxy(fs, {
          get(target, prop) {
            if (prop !== "readFileSync") return Reflect.get(target, prop);
            return (file, ...rest) => {
              if (/^\/proc\//.test(String(file))) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
              return target.readFileSync(file, ...rest);
            };
          },
        }),
        killFn: () => {},
        readContainerStartMs: () => null,
      }).store;
      writePidRecord(noProc, JSON.parse(raw));
      const blind = noProc.describeServerPidDecision();
      expect(blind).toEqual(expect.objectContaining({ evidence: { pid: 21, corroborated: false }, reason: "legacy_no_argv", tgid: null, liveTicks: null, liveContainerTicks: null }));
      expect(noProc.convergeLegacyServerPidClaim(blind)).toEqual({ converged: false, reason: "weak_argv" });
    });

    it("the argv test is verb-scoped: a live `alphaclaw diagnose`, the bare shim and the placeholder child are not servers (CEO 6.3)", () => {
      for (const cmdline of [
        "node /app/bin/alphaclaw.js diagnose",
        "/usr/local/bin/alphaclaw diagnose --json",
        "/usr/local/bin/alphaclaw",
        "node /app/bin/alphaclaw.js",
        "node /app/bin/alphaclaw.js start boot-placeholder-child",
        "node /app/node_modules/openclaw/dist/entry.js gateway run",
      ]) {
        const procs = { 21: { tgid: 21, ticks: 5000, cmdline } };
        const { store } = createFakeStore({ procs });
        writePidRecord(store, { pid: 21, at: kNow - 60 * 1000 });
        const decision = store.describeServerPidDecision();
        expect(decision.reason, cmdline).toBe("not_alphaclaw");
        expect(decision.evidence, cmdline).toBeNull();
        expect(store.convergeLegacyServerPidClaim(decision).converged, cmdline).toBe(false);
      }
      for (const cmdline of [
        "node /app/bin/alphaclaw.js start",
        "/usr/local/bin/alphaclaw start --root-dir /data",
        "node /opt/alphaclaw/bin/alphaclaw start",
      ]) {
        const procs = { 21: { tgid: 21, ticks: 5000, cmdline } };
        const { store } = createFakeStore({ procs });
        writePidRecord(store, { pid: 21, at: kNow - 60 * 1000 });
        expect(store.describeServerPidDecision().reason, cmdline).toBe("legacy_argv_match");
      }
    });

    it("planted /proc: a thread of another leader, a dead pid, an EPERM pid and a garbage record each proceed with their own reason", () => {
      const procs = {
        18: { tgid: 18, ticks: 4000, cmdline: kLookalikeCmdline },
        21: { tgid: 18, ticks: 4000, cmdline: kLookalikeCmdline }, // a thread of 18
      };
      const { store } = createFakeStore({ procs });
      writePidRecord(store, { pid: 21, at: kNow });
      expect(store.describeServerPidDecision()).toEqual(expect.objectContaining({ evidence: null, reason: "thread", tgid: 18, pid: 21 }));
      writePidRecord(store, { pid: 77, at: kNow });
      expect(store.describeServerPidDecision()).toEqual(expect.objectContaining({ evidence: null, reason: "dead", killOk: false, pid: 77 }));
      writePidRecord(store, { pid: "twenty-one", at: kNow });
      expect(store.describeServerPidDecision()).toEqual(expect.objectContaining({ evidence: null, reason: "garbage", pid: null }));
      fs.writeFileSync(store.serverPidPath, "[1, 2]");
      expect(store.describeServerPidDecision().reason).toBe("garbage");
      fs.unlinkSync(store.serverPidPath);
      expect(store.describeServerPidDecision()).toEqual(expect.objectContaining({ evidence: null, reason: "absent", pid: null }));
      // EPERM keeps its historical meaning: a pid we may not signal is not a
      // server we could be racing (throw → null).
      const eperm = createStore({
        fsModule: fakeProcFs({ procs }),
        killFn: () => {
          throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
        },
      }).store;
      writePidRecord(eperm, { pid: 18, at: kNow });
      expect(eperm.describeServerPidDecision()).toEqual(expect.objectContaining({ evidence: null, reason: "kill_failed", killOk: false }));
      // An identity (format 1/2) record with matching ticks is the corroborated skip.
      writePidRecord(store, { pid: 18, at: kNow, host: os.hostname(), startTicks: 4000 });
      expect(store.describeServerPidDecision()).toEqual(
        expect.objectContaining({ evidence: { pid: 18, corroborated: true }, reason: "corroborated", record: expect.objectContaining({ format: 1, legacyClaim: false }) }),
      );
    });

    it("formatServerPidDecision renders the one-line audit and tolerates a null record", () => {
      const procs = { 21: { tgid: 21, ticks: 5000, cmdline: kLookalikeCmdline } };
      const { store } = createFakeStore({ procs, pid1Ticks: 3431 });
      writePidRecord(store, { pid: 21, at: kNow - 60 * 1000 });
      const line = formatServerPidDecision(store.describeServerPidDecision());
      expect(line).toBe(
        `format=legacy pid=21 kill=ok tgid=21 self=${process.pid} ticks=–/5000 container=–/3431 → legacy_argv_match (skip)`,
      );
      expect(formatServerPidDecision(null)).toBe("format=– pid=– kill=– tgid=– self=– ticks=–/– container=–/– → – (–)");
      procs[21].tgid = 18;
      expect(formatServerPidDecision(store.describeServerPidDecision())).toMatch(/tgid=18 .*→ thread \(proceed\)$/);
    });

    it("persisted-format fixtures (C5): every alphaclaw-server.pid era is classified by format/legacyClaim and judged on its own evidence", () => {
      const procs = { 21: { tgid: 21, ticks: 5000, cmdline: kLookalikeCmdline } };
      const host = os.hostname();
      const at = kNow - 60 * 1000;
      const eras = [
        {
          era: "pre-v0.9.73 legacy {pid, at}",
          raw: { pid: 21, at },
          format: "legacy", legacyClaim: true, reason: "legacy_argv_match", evidence: { pid: 21, corroborated: false },
        },
        {
          era: "v0.9.73 identity (format 1: host + startTicks)",
          raw: { pid: 21, at, host, startTicks: 5000 },
          format: 1, legacyClaim: false, reason: "corroborated", evidence: { pid: 21, corroborated: true },
        },
        {
          era: "v0.9.73 identity, recycled pid",
          raw: { pid: 21, at, host, startTicks: 4999 },
          format: 1, legacyClaim: false, reason: "recycled", evidence: null,
        },
        {
          era: "v0.9.77 format 2, server-written (startTicks + containerStartTicks)",
          raw: { pid: 21, at, host, startTicks: 5000, containerStartTicks: 3431, format: 2 },
          format: 2, legacyClaim: false, reason: "corroborated", evidence: { pid: 21, corroborated: true },
        },
        {
          era: "v0.9.77 format 2, converged legacy claim (observedTicks, never startTicks)",
          raw: { pid: 21, at, upgradedAt: kNow - 30 * 1000, host, observedTicks: 5000, containerStartTicks: 3431, format: 2, legacyClaim: true },
          format: 2, legacyClaim: true, reason: "legacy_argv_match", evidence: { pid: 21, corroborated: false },
        },
        {
          era: "v0.9.77 converged claim from a previous container",
          raw: { pid: 21, at, upgradedAt: kNow - 30 * 1000, host, observedTicks: 5000, containerStartTicks: 1111, format: 2, legacyClaim: true },
          format: 2, legacyClaim: true, reason: "other_container", evidence: null,
        },
        {
          era: "v0.9.77 converged claim, recycled pid",
          raw: { pid: 21, at, upgradedAt: kNow - 30 * 1000, host, observedTicks: 4000, containerStartTicks: 3431, format: 2, legacyClaim: true },
          format: 2, legacyClaim: true, reason: "recycled", evidence: null,
        },
      ];
      for (const fixture of eras) {
        const { store } = createFakeStore({ procs, pid1Ticks: 3431 });
        writePidRecord(store, fixture.raw);
        const decision = store.describeServerPidDecision();
        expect(decision.record, fixture.era).toEqual({ raw: fixture.raw, format: fixture.format, legacyClaim: fixture.legacyClaim });
        expect(decision.reason, fixture.era).toBe(fixture.reason);
        expect(decision.evidence, fixture.era).toEqual(fixture.evidence);
      }
      // The record THIS version writes is the v0.9.77 shape, key for key — a
      // change here is a persisted-format change and needs a new era above.
      const { store } = createFakeStore({ procs, pid1Ticks: 3431 });
      store.writeServerPid();
      const written = JSON.parse(fs.readFileSync(store.serverPidPath, "utf8"));
      expect(Object.keys(written).sort()).toEqual(["at", "containerStartTicks", "format", "host", "pid", "startTicks"]);
      expect(written).toEqual(expect.objectContaining({ pid: process.pid, host, format: 2, containerStartTicks: 3431 }));
      expect(written.legacyClaim).toBeUndefined();
    });
  });
});
