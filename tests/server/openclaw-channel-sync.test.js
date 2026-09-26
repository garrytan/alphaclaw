const crypto = require("crypto");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const os = require("os");
const path = require("path");

const {
  createOpenclawChannelSync,
  kPinLagMaxBoots,
  kPinLagMaxAgeMs,
} = require("../../lib/server/openclaw-channel-sync");
const {
  createOpenclawReleaseChannelStore,
} = require("../../lib/server/openclaw-release-channel");
const { getProcessBootId } = require("../../lib/server/boot-id");
const {
  kBootReportSchema,
  kPidfileSkipReason,
  computeVerdict,
  createBootReportWriter,
} = require("../../lib/server/boot-report");

const kSilentLogger = { log() {}, warn() {}, error() {} };
const kDevSha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
const kOtherSha = "0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a";

const mkTemp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const flushAsync = () => new Promise((resolve) => process.nextTick(resolve));

// Declared schema constants the way upstream's dist chunks carry them
// (openclaw-{agent,state}-db-contract-<hash>.js, issue #78). Only the kinds
// given are written, so `{ agent: 19 }` alone leaves the state line unknown.
const writeSchemaContractFixture = (packageDir, { state, agent } = {}) => {
  const distDir = path.join(packageDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  if (Number.isInteger(state)) {
    fs.writeFileSync(
      path.join(distDir, "openclaw-state-db-contract-test.js"),
      `const OPENCLAW_STATE_SCHEMA_VERSION = ${state};\nexport { OPENCLAW_STATE_SCHEMA_VERSION as O };\n`,
    );
  }
  if (Number.isInteger(agent)) {
    fs.writeFileSync(
      path.join(distDir, "openclaw-agent-db-contract-test.js"),
      `const OPENCLAW_AGENT_SCHEMA_VERSION = ${agent};\nexport { OPENCLAW_AGENT_SCHEMA_VERSION as O };\n`,
    );
  }
};

// Builds a plausible openclaw npm-package tree: package.json (+bin file),
// dist/ with the thinking module sentinel and dist/extensions, and — when
// `schema` is given — the declared schema-constant chunks.
const writePackageFixture = (
  packageDir,
  {
    version,
    bin = { openclaw: "bin/entry.js" },
    thinking = true,
    extensions = true,
    schema = null,
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
  if (schema) writeSchemaContractFixture(packageDir, schema);
  return packageDir;
};

// A real SQLite file with an explicit PRAGMA user_version — the schema line
// the #78 agent arm reads (same shape as openclaw-schema-versions.test.js).
const writeSqliteDb = (file, { userVersion = 0, dbKind = "state", agentId = null } = {}) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE t(x INTEGER)");
  db.exec("CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL, agent_id TEXT)");
  db.exec(`PRAGMA user_version = ${userVersion}`);
  db.prepare("INSERT INTO schema_meta(meta_key, role, schema_version, agent_id) VALUES ('primary', ?, ?, ?)")
    .run(dbKind === "state" ? "global" : "agent", userVersion, agentId);
  db.close();
  return file;
};
const writeStateDb = (stateRoot, options) =>
  writeSqliteDb(path.join(stateRoot, "state", "openclaw.sqlite"), { dbKind: "state", ...options });
const writeAgentDb = (stateRoot, agentId, options) =>
  writeSqliteDb(
    path.join(stateRoot, "agents", agentId, "agent", "openclaw-agent.sqlite"),
    { dbKind: "agent", agentId, ...options },
  );
const readRunRecords = (openclawDir) => {
  const runsDir = path.join(openclawDir, ".alphaclaw", "runs");
  return fs
    .readdirSync(runsDir)
    .map((name) => JSON.parse(fs.readFileSync(path.join(runsDir, name), "utf8")));
};

const writeInstallFixture = (installDir, options) =>
  writePackageFixture(
    path.join(installDir, "node_modules", "openclaw"),
    options,
  );

const writeCheckoutFixture = (rootDir, { sha, bin = true, checkoutDir = path.join(rootDir, "openclaw") } = {}) => {
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
  openclawDir: selectedOpenclawDir = null,
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
  const openclawDir = selectedOpenclawDir || path.join(rootDir, ".openclaw");
  fs.mkdirSync(openclawDir, { recursive: true });
  fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}\n");
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
    runStreamed: vi.fn(async (opts) => {
      if (opts.args?.includes("update") && !opts.args.includes("repair")) {
        throw new Error("Dev preparation must not execute the native updater");
      }
      const result = await (runnerImpl ? runnerImpl(opts, defaultRunnerImpl) : defaultRunnerImpl(opts));
      const candidate = opts.env?.OPENCLAW_GIT_DIR;
      const fixture = path.join(rootDir, "openclaw");
      if (result.ok && candidate && path.dirname(candidate) === `${fixture}-candidates`) {
        if (opts.command === "git" && opts.args?.[0] === "clone") {
          expect(opts.args.at(-1)).toBe(candidate);
          expect(opts.cwd).toBe(candidate);
          if (fs.existsSync(fixture)) fs.cpSync(fixture, candidate, { recursive: true });
          else writeCheckoutFixture(rootDir, { sha: kDevSha, checkoutDir: candidate });
        }
        if (opts.command === "git" && opts.args?.[0] === "checkout") {
          expect(opts.cwd).toBe(candidate);
          const requested = opts.args.at(-1);
          const sha = requested === "origin/main"
            ? fs.readFileSync(path.join(candidate, ".git", "HEAD"), "utf8").trim()
            : [kDevSha, kOtherSha].find((commit) => commit.startsWith(requested)) || requested;
          expect(sha).toMatch(/^[a-f0-9]{40}$/);
          fs.writeFileSync(path.join(candidate, ".git", "HEAD"), `${sha}\n`);
        }
      }
      return result;
    }),
  };
  const installResults = [];
  const installToTempDir = vi.fn(async ({ versionSpec }) => {
    const tmpDir = mkTemp("openclaw-fake-prepare-");
    const openclawPackageDir = writePackageFixture(
      path.join(tmpDir, "node_modules", "openclaw"),
      { version: versionSpec, schema: { state: 17, agent: 21 }, ...installFixture },
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
  const gatewayQuiesce = {
    isRunning: vi.fn(async () => false),
    suppress: vi.fn(() => ({ id: "test-suppression" })),
    unsuppress: vi.fn(),
    stop: vi.fn(async () => true),
    start: vi.fn(async () => {}),
  };
  const dbQuiet = vi.fn(async () => ({ token: { disabled: false }, isValid: () => true, release: vi.fn() }));
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
    gatewayQuiesce,
    dbQuiet,
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
    gatewayQuiesce,
    dbQuiet,
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
      // Intent stamp (#76 RC3): a pin bump is a chosen transition from what
      // ran before — a pin that moves backwards restores its settings at boot
      // instead of reading as drift.
      expect(store.readState().lastTransition).toEqual(
        expect.objectContaining({
          from: "1.0.0",
          to: "1.0.1",
          kind: "upgrade",
          source: "pin_bump",
          reason: "declared_pin_changed",
          ok: true,
          consumedAt: null,
        }),
      );
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
      const logs = [];
      const { sync, store, installDir } = createHarness({
        pin: "1.0.0",
        channel: "beta",
        installedVersion: "1.0.0",
        extraSyncOptions: {
          logger: { log: (message) => logs.push(String(message)), warn() {}, error() {} },
        },
      });
      const pidfileAuditLines = () =>
        logs.filter((line) => /^\[openclaw-channel\] pidfile: format=/.test(line));
      store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = { channel: "beta", version: "1.1.0", at: 1, acceptedAt: 2 };
        return s;
      });
      // A live foreign pid in the server pidfile = another instance is
      // serving from this tree; the sync must no-op (fail open), not mutate.
      // The claim carries the writer's identity (this host, this process's
      // start time) — that is what makes it "the same process", not the pid.
      // The applied build's overlay is complete on disk while the installed
      // tree is still the pin — exactly the contradiction a skipped sync
      // hides (#76: the applied overlay never activated for 45 minutes).
      saveOverlayFixture(store, "1.1.0");
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
        // The claim carries host + start time and both match: a VERIFIED live
        // owner — the launcher refuses to start a second instance on this.
        expect(skipped.corroborated).toBe(true);
        // The skip path carries the judge's record and names the contradiction
        // (read-only: no state.lastBoot write beside a live sibling).
        expect(skipped.pidDecision).toEqual(
          expect.objectContaining({ decision: "skip", reason: "corroborated", pid: child.pid }),
        );
        expect(skipped.warnings).toEqual([
          expect.stringMatching(/installed openclaw 1\.0\.0 ≠ applied 1\.1\.0 with a complete overlay while a live sibling \(pid \d+\) is claimed/),
        ]);
        // Nothing was mutated: applied still recorded, no lastBoot rewrite.
        expect(store.readState().applied).toEqual(
          expect.objectContaining({ version: "1.1.0" }),
        );
        expect(store.readState().lastBoot).toBeNull();
        // ONE audit line for the whole boot, on the skip path too — the
        // judge's reasoning, not "pid N is live" (#76 RC1). The formatter is
        // unit-tested; this pins that the skip path emits it exactly once.
        expect(pidfileAuditLines()).toEqual([
          expect.stringMatching(
            new RegExp(
              `^\\[openclaw-channel\\] pidfile: format=1 pid=${child.pid} kill=ok tgid=${child.pid} self=${process.pid} ticks=\\d+/\\d+ container=.+ → corroborated \\(skip\\)$`,
            ),
          ),
        ]);
      } finally {
        child.kill("SIGKILL");
      }
      // A DEAD pid (or our own) clears the guard and the sync proceeds.
      await new Promise((resolve) => child.once("exit", resolve));
      const proceeded = sync.syncAtBoot();
      expect(proceeded.ok).toBe(true);
      // The second boot adds its own single line — a proceed verdict — and
      // never re-emits the skip.
      expect(pidfileAuditLines()).toHaveLength(2);
      expect(pidfileAuditLines()[1]).toMatch(/→ dead \(proceed\)$/);
      expect(pidfileAuditLines().filter((line) => /\(skip\)$/.test(line))).toHaveLength(1);
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

    it("marks the skip corroborated only when /proc confirms the pid's identity; a recycled pid does not skip", () => {
      const { spawn } = require("child_process");
      const { readProcStartTicks } = require("../../lib/server/utils/safe-file");
      const hasProc = process.platform === "linux" && fs.existsSync(`/proc/${process.pid}/stat`);
      if (!hasProc) return;
      const { sync, store } = createHarness({
        pin: "1.0.0",
        channel: "beta",
        installedVersion: "1.0.0",
      });
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        stdio: "ignore",
      });
      try {
        const ticks = readProcStartTicks(child.pid, fs);
        fs.mkdirSync(path.dirname(store.serverPidPath), { recursive: true });
        // Same host (no `host` field = a claim from this pid namespace),
        // matching start time: a verified live owner.
        fs.writeFileSync(
          store.serverPidPath,
          JSON.stringify({ pid: child.pid, at: 1, startTicks: ticks }),
        );
        const corroborated = sync.syncAtBoot();
        expect(corroborated.action).toBe("skipped_concurrent");
        expect(corroborated.corroborated).toBe(true);

        // Same pid number, different start time = the pid was recycled after a
        // hard kill; the sync must proceed as if no owner existed.
        fs.writeFileSync(
          store.serverPidPath,
          JSON.stringify({ pid: child.pid, at: 1, startTicks: ticks - 4242 }),
        );
        const proceeded = sync.syncAtBoot();
        expect(proceeded.action).not.toBe("skipped_concurrent");
        // ...and the surviving process now owns the claim.
        expect(JSON.parse(fs.readFileSync(store.serverPidPath, "utf8")).pid).toBe(process.pid);
      } finally {
        child.kill("SIGKILL");
      }
    });

    // Issue #76 RC1: a pid number can name a THREAD. kill(tid, 0) succeeds
    // and /proc/<tid>/cmdline is the leader's argv, so a stale legacy claim
    // colliding with one of a live server's (or our own) threads used to skip
    // the sync — and with it the activation of the applied overlay.
    it("a legacy pidfile naming a THREAD of a live lookalike server never skips the sync; the boot re-claims the file as format 2 (#76 RC1)", async () => {
      const { spawn } = require("child_process");
      const hasProc = process.platform === "linux" && fs.existsSync(`/proc/${process.pid}/status`);
      if (!hasProc) return;
      const { sync, store } = createHarness({
        pin: "1.0.0",
        channel: "beta",
        installedVersion: "1.0.0",
      });
      const child = spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 30000)", "/opt/alphaclaw/bin/alphaclaw.js", "start"],
        { stdio: "ignore" },
      );
      try {
        let tids = [];
        for (let i = 0; i < 100 && tids.length < 2; i += 1) {
          try {
            tids = fs.readdirSync(`/proc/${child.pid}/task`).map(Number);
          } catch {}
          if (tids.length < 2) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(tids.length).toBeGreaterThan(1); // CEO 6.1: the fixture is really multi-threaded
        const tid = tids.find((candidate) => candidate !== child.pid);
        fs.mkdirSync(path.dirname(store.serverPidPath), { recursive: true });
        fs.writeFileSync(store.serverPidPath, JSON.stringify({ pid: tid, at: Date.now() }));
        const result = sync.syncAtBoot();
        expect(result.action).not.toBe("skipped_concurrent");
        expect(result.ok).toBe(true);
        expect(result.warnings).toEqual(expect.any(Array));
        expect(result.pidDecision).toEqual(
          expect.objectContaining({ evidence: null, decision: "proceed", reason: "thread", pid: tid, tgid: child.pid }),
        );
        // The boot claimed the file for this process, in the current format.
        const claim = JSON.parse(fs.readFileSync(store.serverPidPath, "utf8"));
        expect(claim).toEqual(
          expect.objectContaining({ pid: process.pid, format: 2, startTicks: expect.any(Number), containerStartTicks: expect.any(Number) }),
        );
        expect(claim.legacyClaim).toBeUndefined();
      } finally {
        child.kill("SIGKILL");
      }
    });

    it("syncAtBoot converges a positively identified legacy claim ONCE (format 2 + legacyClaim, never startTicks) and still skips uncorroborated (#76 RC2)", () => {
      const { spawn } = require("child_process");
      const { readProcStartTicks } = require("../../lib/server/openclaw-lock-contention");
      const hasProc = process.platform === "linux" && fs.existsSync(`/proc/${process.pid}/status`);
      if (!hasProc) return;
      const { sync, store } = createHarness({
        pin: "1.0.0",
        channel: "beta",
        installedVersion: "1.0.0",
      });
      const child = spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 30000)", "/opt/alphaclaw/bin/alphaclaw.js", "start"],
        { stdio: "ignore" },
      );
      try {
        const claimedAt = Date.now() - 60 * 1000;
        fs.mkdirSync(path.dirname(store.serverPidPath), { recursive: true });
        fs.writeFileSync(store.serverPidPath, JSON.stringify({ pid: child.pid, at: claimedAt }));
        const first = sync.syncAtBoot();
        expect(first.action).toBe("skipped_concurrent");
        expect(first.corroborated).toBe(false); // a legacy claim can never refuse the boot
        expect(first.pidDecision).toEqual(
          expect.objectContaining({ decision: "skip", reason: "legacy_argv_match", record: expect.objectContaining({ format: "legacy", legacyClaim: true }) }),
        );
        const converged = JSON.parse(fs.readFileSync(store.serverPidPath, "utf8"));
        expect(converged).toEqual({
          pid: child.pid,
          at: claimedAt,
          upgradedAt: expect.any(Number),
          host: require("os").hostname(),
          observedTicks: readProcStartTicks(child.pid),
          containerStartTicks: readProcStartTicks(1),
          format: 2,
          legacyClaim: true,
        });
        expect(converged.startTicks).toBeUndefined();
        expect(store.readState().lastBoot).toBeNull();
        // The next boot on the same live process: still skipped, still
        // uncorroborated, and the file is NOT rewritten (identity stays).
        const mtime = fs.statSync(store.serverPidPath).mtimeMs;
        const second = sync.syncAtBoot();
        expect(second.action).toBe("skipped_concurrent");
        expect(second.corroborated).toBe(false);
        expect(second.pidDecision.record).toEqual(expect.objectContaining({ format: 2, legacyClaim: true }));
        expect(fs.statSync(store.serverPidPath).mtimeMs).toBe(mtime);
        expect(JSON.parse(fs.readFileSync(store.serverPidPath, "utf8"))).toEqual(converged);
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

    it("activates a RECORDED return-to-pin apply at boot as 'activated' — no drift alarm (v0.9.89; the container journey's historical→pin activation read as tampering)", async () => {
      const { sync, store, installDir, notify } = createHarness({
        pin: "1.0.0",
        installedVersion: "9.9.9",
      });
      store.updateState((s) => {
        s.pinVersion = "1.0.0";
        // applyUpdate's record step for a pin target: applied = null plus the
        // in-flight transition stamp (ok stays null until the run settles).
        s.applied = null;
        s.lastTransition = {
          at: Date.now(),
          from: "9.9.9",
          to: "1.0.0",
          kind: "downgrade",
          source: "operator_apply",
          reason: null,
          operationId: "op-return-to-pin",
          ok: null,
          consumedAt: null,
        };
        return s;
      });
      expect(saveOverlayFixture(store, "1.0.0")).toEqual({ ok: true });

      const result = sync.syncAtBoot();
      await flushAsync();

      expect(result.ok).toBe(true);
      expect(result.action).toBe("activated");
      expect(store.readInstalledVersion({ installDir })).toBe("1.0.0");
      expect(result.warnings.some((warning) => warning.includes("recorded return to the pin"))).toBe(true);
      expect(notifyMessages(notify).some((message) => message.includes("changed outside"))).toBe(false);

      // The same mismatch WITHOUT the stamp (or with a stale/settled one) is still drift.
      const drift = createHarness({ pin: "1.0.0", installedVersion: "9.9.9" });
      drift.store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.lastTransition = { at: Date.now() - 8 * 24 * 60 * 60 * 1000, from: "9.9.9", to: "1.0.0", kind: "downgrade", source: "operator_apply", reason: null, operationId: "old", ok: null, consumedAt: null };
        return s;
      });
      expect(saveOverlayFixture(drift.store, "1.0.0")).toEqual({ ok: true });
      const driftResult = drift.sync.syncAtBoot();
      await flushAsync();
      expect(driftResult.action).toBe("drift_reverted");
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
      // v0.9.80: the runtime the Upgrade tab judges catalog rows' engines against.
      expect(info.nodeVersion).toBe(process.versions.node);
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

  // ── Control UI mount contract (control-ui-mount.js) ──────────────────────
  describe("Control UI mount key (gateway.controlUi.basePath)", () => {
    const configPathOf = (openclawDir) => path.join(openclawDir, "openclaw.json");
    const writeConfig = (openclawDir, config) => {
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(configPathOf(openclawDir), `${JSON.stringify(config, null, 2)}\n`);
    };
    const readConfig = (openclawDir) =>
      JSON.parse(fs.readFileSync(configPathOf(openclawDir), "utf8"));
    const kManagedStripe = { label: "BETA · 1.0.0", color: "amber" };

    it("removing the managed environment stripe leaves controlUi.basePath in place", () => {
      // The stripe remover prunes an EMPTY controlUi parent; with basePath
      // beside the stripe that delete can never fire, so the mount key
      // survives the beta → stable transition.
      const stableHarness = () => {
        const h = createHarness({
          pin: "1.0.0",
          channel: "stable",
          installedVersion: "1.0.0",
          sentinelVersion: "1.0.0",
        });
        h.store.updateState((s) => {
          s.pinVersion = "1.0.0";
          return s;
        });
        return h;
      };

      const withBasePath = stableHarness();
      writeConfig(withBasePath.openclawDir, {
        gateway: {
          controlUi: { basePath: "/openclaw", environment: { ...kManagedStripe } },
        },
      });
      expect(withBasePath.sync.syncAtBoot().ok).toBe(true);
      const cfg = readConfig(withBasePath.openclawDir);
      expect(cfg.gateway.controlUi.environment).toBeUndefined();
      expect(cfg.gateway.controlUi.basePath).toBe("/openclaw");

      // Control: the stripe alone still prunes the parent (existing
      // behavior) — the two runs differ by exactly the mount key.
      const stripeOnly = stableHarness();
      writeConfig(stripeOnly.openclawDir, {
        gateway: { controlUi: { environment: { ...kManagedStripe } } },
      });
      expect(stripeOnly.sync.syncAtBoot().ok).toBe(true);
      expect(readConfig(stripeOnly.openclawDir).gateway.controlUi).toBeUndefined();
    });

    // The round-trip restore is the one whole-file restore reachable without
    // a doctor run or a crash first (the rollback and migration-gate restores
    // need one); all three go through the same restoreConfigFromBackup, so
    // this path pins the repair for every restore source.
    const kRestoredBackup = {
      gateway: { controlUi: { allowedOrigins: ["https://setup.example.com"] } },
      restoredMarker: true,
    };
    const kLiveNewerShape = {
      gateway: {
        controlUi: {
          allowedOrigins: ["https://setup.example.com"],
          basePath: "/openclaw",
        },
      },
      migrated: "newer-shape",
    };
    const seedRoundTripRestore = ({ ensureGatewayProxyConfig } = {}) => {
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        extraSyncOptions: {
          logger,
          ...(ensureGatewayProxyConfig ? { ensureGatewayProxyConfig } : {}),
        },
      });
      harness.store.updateState((s) => {
        s.pinVersion = "1.0.0";
        // A migration completed for the newer 2.0.0 …
        s.configMigration = {
          completedForVersion: "2.0.0",
          lastAttempt: { version: "2.0.0", at: 1, ok: true },
        };
        // … and the operator's landed, unconsumed downgrade stamp authorizes
        // restoring 1.0.0's pre-fix backup (describeVersionRegressionIntent).
        s.lastTransition = {
          at: harness.nowRef.now,
          from: "2.0.0",
          to: "1.0.0",
          kind: "downgrade",
          source: "operator_apply",
          reason: null,
          operationId: "op-downgrade",
          ok: true,
          consumedAt: null,
        };
        return s;
      });
      writeConfig(harness.openclawDir, kLiveNewerShape);
      const backupBytes = `${JSON.stringify(kRestoredBackup, null, 2)}\n`;
      fs.writeFileSync(
        path.join(harness.openclawDir, "openclaw.json.pre-fix-1.0.0.bak"),
        backupBytes,
      );
      return {
        harness,
        configPath: configPathOf(harness.openclawDir),
        backupBytes,
        logLines: () => logger.log.mock.calls.map((call) => String(call[0])),
      };
    };
    const mountRepairWarnings = (warnings) =>
      warnings.filter((w) => String(w).includes("control UI mount repair failed"));

    it("re-applies the gateway proxy config after a round-trip restore and verifies the key is back", async () => {
      // Stands in for gateway.js ensureGatewayProxyConfig: a read-modify-write
      // that puts the mount key into the live file.
      const seen = [];
      const ref = { configPath: null };
      const ensureGatewayProxyConfig = vi.fn((origin) => {
        const raw = fs.readFileSync(ref.configPath, "utf8");
        seen.push({ origin, raw });
        const cfg = JSON.parse(raw);
        cfg.gateway.controlUi = { ...(cfg.gateway.controlUi || {}), basePath: "/openclaw" };
        fs.writeFileSync(ref.configPath, `${JSON.stringify(cfg, null, 2)}\n`);
        return true;
      });
      const seeded = seedRoundTripRestore({ ensureGatewayProxyConfig });
      ref.configPath = seeded.configPath;

      const outcome = await seeded.harness.sync.reconcileBootConfig();

      expect(outcome).toEqual(
        expect.objectContaining({ status: "ok", reason: "round-trip-restore" }),
      );
      // Called once, origin-less, AFTER the restore committed the backup
      // bytes (the file lock is not re-entrant — the hook runs outside it).
      expect(ensureGatewayProxyConfig).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([{ origin: undefined, raw: seeded.backupBytes }]);
      const after = readConfig(seeded.harness.openclawDir);
      expect(after.restoredMarker).toBe(true);
      expect(after.migrated).toBeUndefined();
      expect(after.gateway.controlUi.basePath).toBe("/openclaw");
      expect(after.gateway.controlUi.allowedOrigins).toEqual(["https://setup.example.com"]);
      // Postcondition satisfied: the success line, no failure code, no warning.
      expect(mountRepairWarnings(outcome.warnings)).toEqual([]);
      const lines = seeded.logLines();
      expect(
        lines.some((line) =>
          line.includes(
            "re-applied the gateway proxy config after the round_trip restore (control_ui_mount=basepath)",
          ),
        ),
      ).toBe(true);
      expect(lines.some((line) => line.includes("control_ui_mount_repair_failed"))).toBe(false);
    });

    it.each([
      [
        "throws",
        () => {
          throw new Error("disk full");
        },
        "(disk full)",
      ],
      ["is a no-op that leaves the key absent", () => false, null],
    ])(
      "reports a loud, non-fatal repair failure when the re-ensure hook %s",
      async (_label, hookImpl, errorText) => {
        const ensureGatewayProxyConfig = vi.fn(hookImpl);
        const seeded = seedRoundTripRestore({ ensureGatewayProxyConfig });

        const outcome = await seeded.harness.sync.reconcileBootConfig();

        // The restore itself still lands and the boot goes on — a failed
        // repair is a warning, never a throw.
        expect(outcome).toEqual(
          expect.objectContaining({ status: "ok", reason: "round-trip-restore" }),
        );
        expect(ensureGatewayProxyConfig).toHaveBeenCalledTimes(1);
        expect(fs.readFileSync(seeded.configPath, "utf8")).toBe(seeded.backupBytes);
        expect(
          readConfig(seeded.harness.openclawDir).gateway.controlUi.basePath,
        ).toBeUndefined();
        // Postcondition unmet → the fixed, greppable code in the log …
        const failureLines = seeded
          .logLines()
          .filter((line) =>
            line.includes("control_ui_mount_repair_failed source=round_trip mount=basepath"),
          );
        expect(failureLines).toHaveLength(1);
        expect(failureLines[0]).toContain("Styles failed to load");
        if (errorText) expect(failureLines[0]).toContain(errorText);
        else expect(failureLines[0]).not.toContain("disk full");
        expect(
          seeded.logLines().some((line) => line.includes("re-applied the gateway proxy config")),
        ).toBe(false);
        // … and ONE warning on the restore caller's warnings[] (the boot
        // report / notification surface).
        const warnings = mountRepairWarnings(outcome.warnings);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("after the round_trip config restore");
        expect(warnings[0]).toContain("Styles failed to load");
      },
    );

    it("treats an unparseable openclaw.json after the hook as a FAILED repair (strict verification read)", async () => {
      // The verification must read the file strictly: the lenient reader's
      // `fallback: {}` would make an unreadable file look satisfied in legacy
      // mode ("no key" is exactly what legacy wants) and mask the failure. So
      // a hook that corrupts the file — or a disk that hands back garbage —
      // must surface as control_ui_mount_repair_failed, whatever the mode.
      let configPath = null;
      const ensureGatewayProxyConfig = vi.fn(() => {
        fs.writeFileSync(configPath, "{ not json");
        return true;
      });
      const seeded = seedRoundTripRestore({ ensureGatewayProxyConfig });
      configPath = seeded.configPath;

      const outcome = await seeded.harness.sync.reconcileBootConfig();

      expect(outcome).toEqual(
        expect.objectContaining({ status: "ok", reason: "round-trip-restore" }),
      );
      expect(ensureGatewayProxyConfig).toHaveBeenCalledTimes(1);
      const failureLines = seeded
        .logLines()
        .filter((line) =>
          line.includes("control_ui_mount_repair_failed source=round_trip mount=basepath"),
        );
      expect(failureLines).toHaveLength(1);
      expect(
        seeded.logLines().some((line) => line.includes("re-applied the gateway proxy config")),
      ).toBe(false);
      expect(mountRepairWarnings(outcome.warnings)).toHaveLength(1);
    });

    it("skips the repair entirely when no hook is injected (the bin boot-sync instance)", async () => {
      const seeded = seedRoundTripRestore();

      const outcome = await seeded.harness.sync.reconcileBootConfig();

      expect(outcome).toEqual(
        expect.objectContaining({ status: "ok", reason: "round-trip-restore" }),
      );
      expect(fs.readFileSync(seeded.configPath, "utf8")).toBe(seeded.backupBytes);
      expect(mountRepairWarnings(outcome.warnings)).toEqual([]);
      expect(
        seeded
          .logLines()
          .some(
            (line) =>
              line.includes("control_ui_mount_repair_failed") ||
              line.includes("re-applied the gateway proxy config"),
          ),
      ).toBe(false);
    });
  });

  describe("applyUpdate", () => {
    it("never lets old apply steps or completion rewrite a replacement history pointer", async () => {
      let store;
      let replacement;
      const operationEvents = {
        publish: vi.fn((_id, event) => {
          if (replacement || event.data?.name !== "preflight") return;
          store.updateState((state) => {
            state.lastUpdateRun = {
              operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              target: { channel: "beta", version: "9.0.0" },
              startedAt: 5, finishedAt: null, ok: null,
              steps: [{ name: "prepare", status: "running", at: 5 }],
            };
            return state;
          });
          replacement = store.readState().lastUpdateRun;
        }),
        complete: vi.fn(), fail: vi.fn(),
      };
      const h = createHarness({
        installedVersion: "1.0.0", sentinelVersion: "1.0.0",
        extraSyncOptions: { operationEvents },
      });
      store = h.store;
      await h.sync.applyUpdate({ channel: "beta", version: "1.1.0" });
      expect(replacement).toBeTruthy();
      expect(store.readState().lastUpdateRun).toEqual(replacement);
    });

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
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
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
      // Intent stamp (#76 RC3): the operator chose this transition and it
      // landed — the boot config gate reads this, never `applied.reason`.
      expect(state.lastTransition).toEqual({
        at: expect.any(Number),
        from: "1.0.0",
        to: "1.1.0",
        kind: "upgrade",
        source: "operator_apply",
        reason: null,
        operationId: state.lastUpdateRun.operationId,
        ok: true,
        consumedAt: null,
      });
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

    it("persists read-only state metadata and explicit database recovery coverage in the run record", async () => {
      const harness = createHarness({ pin: "1.0.0", installedVersion: "1.0.0", sentinelVersion: "1.0.0", installFixture: { schema: { state: 17, agent: 21 } } });
      const file = writeStateDb(harness.openclawDir, { userVersion: 15 });
      const result = await harness.sync.applyUpdate({ channel: "beta", version: "1.1.0", recoveryMode: "database_set" });
      expect(result.status).toBe(202);
      const [record] = readRunRecords(harness.openclawDir);
      expect(record.state).toBe("restart_expected");
      expect(record.dbPreflight).toMatchObject({ migrationRequired: true, byKind: {
        state: { count: 1, foundVersion: 15, targetVersion: 17, migrationRequired: true },
        agent: { count: 0, foundVersion: null, migrationRequired: false },
      } });
      expect(record.dbPreflight.dbSizesBytes[file]).toBe(fs.statSync(file).size);
      expect(record.recovery).toMatchObject({ kind: "database_set", databases: { complete: true, verified: true, requiredPaths: ["state/openclaw.sqlite"] } });
      expect(record.recoveryIntent).toMatchObject({ approved: true, migrationRequired: true });
      expect(harness.runner.runStreamed.mock.calls.some(([opts]) => opts.args?.includes("preflight") || opts.args?.includes("backup"))).toBe(false);
      expect(record.steps).toContainEqual(expect.objectContaining({ name: "db-preflight", status: "completed" }));

      const disagreement = createHarness({ pin: "1.0.0", installedVersion: "1.0.0", sentinelVersion: "1.0.0" });
      const mismatchedFile = writeStateDb(disagreement.openclawDir, { userVersion: 15 });
      const mismatchedDb = new DatabaseSync(mismatchedFile);
      mismatchedDb.prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'").run(16);
      mismatchedDb.close();
      const mismatchedBytes = fs.readFileSync(mismatchedFile);
      const refused = await disagreement.sync.applyUpdate({ channel: "beta", version: "1.1.0" });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("db_preflight_failed");
      expect(refused.body.preflight.reasons).toContain("database_owner_or_schema_metadata_mismatch");
      expect(disagreement.gatewayQuiesce.stop).not.toHaveBeenCalled();
      expect(disagreement.restartProcess).not.toHaveBeenCalled();
      expect(fs.readFileSync(mismatchedFile)).toEqual(mismatchedBytes);
    });

    it("refuses both downgrade and upgrade when the owned config checkpoint cannot be captured", async () => {
      for (const [pin, kind] of [["1.2.0", "downgrade"], ["1.0.0", "upgrade"]]) {
        const harness = createHarness({ pin, installedVersion: pin, sentinelVersion: pin, extraSyncOptions: {
          dbQuiet: async () => { throw Object.assign(new Error("barrier unavailable"), { code: "state_db_quiet_unavailable" }); },
        } });
        const result = await harness.sync.applyUpdate({ channel: "stable", version: "1.1.0" });
        expect(result.status).toBe(409);
        expect(result.body.code).toBe("state_db_quiet_unavailable");
        expect(harness.store.readState().lastTransition).toMatchObject({ from: pin, to: "1.1.0", kind, source: "operator_apply", ok: false, consumedAt: null });
        expect(harness.store.readState().applied).toBeNull();
        expect(harness.installToTempDir).toHaveBeenCalledTimes(1);
        expect(harness.restartProcess).not.toHaveBeenCalled();
        expect(harness.runner.runStreamed.mock.calls.some(([opts]) => opts.args?.includes("backup"))).toBe(false);
      }
    });

    // Issues #7/#9: the backup step passed a fixed path as --output without
    // creating the directory — the CLI wrote the archive AS that path (#9's
    // false "no backup artifact produced"), then refused to overwrite it on
    // every later run (#7's permanent backup_failed).
    describe("backup step (issues #7/#9)", () => {
      const backupsDirOf = (harness) => path.join(harness.rootDir, "backups", "openclaw");
      const hardGateTarget = { channel: "beta", version: "1.1.0-beta.1" };
      const mkHarness = (options = {}) => createHarness({
        pin: "1.0.0", installedVersion: "1.0.0", sentinelVersion: "1.0.0", ...options,
      });
      const backupInvocations = (harness) => harness.runner.runStreamed.mock.calls
        .map(([opts]) => opts).filter((opts) => opts.args?.includes("backup") || ["tar", "gzip"].includes(opts.command));
      const assertCheckpoint = (harness, result) => {
        expect(result.status).toBe(202);
        expect(backupInvocations(harness)).toEqual([]);
        const record = readRunRecords(harness.openclawDir).find((run) => run.operationId === result.body.operationId);
        expect(record.recovery).toMatchObject({ kind: "config_only", checkpoint: { verified: true }, databases: { complete: false, verified: false } });
        const root = record.recovery.checkpoint.file;
        expect(fs.statSync(root).isDirectory()).toBe(true);
        expect(fs.statSync(root).mode & 0o777).toBe(0o700);
        for (const relative of ["manifest.json", "ready.json", "payload/openclaw.json"]) {
          expect(fs.statSync(path.join(root, relative)).mode & 0o777).toBe(0o600);
        }
        const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
        expect(manifest.files.map((entry) => entry.archivePath)).toEqual(["openclaw.json"]);
        expect(manifest.databases).toEqual([]);
        expect(harness.sync.listBackupInventory().entries).toContainEqual(expect.objectContaining({ file: root, eligible: false }));
        return root;
      };
      const failCapture = (code = "CHECKPOINT_PERMISSIONS", enabled = () => true) => ({
        ...fs,
        openSync(file, flags, mode) {
          if (enabled() && flags === "wx" && String(file).includes(".staging")) {
            throw Object.assign(new Error(code), { code });
          }
          return fs.openSync(file, flags, mode);
        },
      });

      it("records private checkpoint permissions and verifies the published file manifest", async () => {
        const harness = mkHarness();
        const root = assertCheckpoint(harness, await harness.sync.applyUpdate(hardGateTarget));
        const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
        const payload = fs.readFileSync(path.join(root, "payload/openclaw.json"));
        expect(manifest.files[0]).toMatchObject({ bytes: payload.length, sha256: crypto.createHash("sha256").update(payload).digest("hex") });
      });

      it("refuses a checkpoint when private file creation fails instead of recording weaker permissions", async () => {
        const harness = mkHarness({ extraSyncOptions: { fsModule: failCapture() } });
        const result = await harness.sync.applyUpdate(hardGateTarget);
        expect(result.status).toBe(409);
        expect(result.body.code).toBe("CHECKPOINT_PERMISSIONS");
        expect(harness.store.readState().applied).toBeNull();
        expect(harness.restartProcess).not.toHaveBeenCalled();
        expect(fs.readdirSync(backupsDirOf(harness))).toEqual([]);
        expect(backupInvocations(harness)).toEqual([]);

        const failingChmod = { ...fs, chmodSync(file, mode) {
          if (String(file).includes(".staging") && String(file).endsWith(".sqlite")) {
            throw Object.assign(new Error("EPERM: chmod refused"), { code: "EPERM" });
          }
          return fs.chmodSync(file, mode);
        } };
        const databaseHarness = mkHarness({ extraSyncOptions: { fsModule: failingChmod } });
        writeStateDb(databaseHarness.openclawDir, { userVersion: 17 });
        const refused = await databaseHarness.sync.applyUpdate({ ...hardGateTarget, recoveryMode: "database_set" });
        expect(refused.status).toBeGreaterThanOrEqual(400);
        expect(databaseHarness.store.readState().applied).toBeNull();
        expect(databaseHarness.restartProcess).not.toHaveBeenCalled();
        expect(fs.readdirSync(backupsDirOf(databaseHarness))).toEqual([]);
        expect(backupInvocations(databaseHarness)).toEqual([]);
      });

      it("#9: the first cross-channel apply writes a unique directory checkpoint and records it", async () => {
        const harness = mkHarness();
        const result = await harness.sync.applyUpdate(hardGateTarget);
        const root = assertCheckpoint(harness, result);
        expect(path.basename(root)).toMatch(/^recovery-[0-9a-f-]{36}$/);
        expect(fs.readdirSync(backupsDirOf(harness))).toEqual([path.basename(root)]);
        expect(result.body.restarting).toBe(true);
      });

      it("does not invoke the retired workspace-discovery retry or include workspace files", async () => {
        const harness = mkHarness({ runnerImpl: async (opts, fallback) => {
          if (opts.args?.includes("backup")) throw new Error("workspace discovery must never run");
          return fallback(opts);
        } });
        fs.mkdirSync(path.join(harness.openclawDir, "workspace"));
        fs.writeFileSync(path.join(harness.openclawDir, "workspace", "important.md"), "preserve workspace");
        const root = assertCheckpoint(harness, await harness.sync.applyUpdate(hardGateTarget));
        expect(fs.existsSync(path.join(root, "payload/workspace"))).toBe(false);
        expect(fs.readFileSync(path.join(harness.openclawDir, "workspace/important.md"), "utf8")).toBe("preserve workspace");
      });

      it("a compatible downgrade captures config with explicit database omissions rather than a partial archive", async () => {
        const harness = mkHarness({ pin: "1.2.0", installedVersion: "1.2.0", sentinelVersion: "1.2.0" });
        assertCheckpoint(harness, await harness.sync.applyUpdate({ channel: "stable", version: "1.1.0" }));
        expect(harness.store.readState().lastTransition).toMatchObject({ kind: "downgrade", ok: true });
      });

      it("does not retry or pause when checkpoint disk space is insufficient", async () => {
        const harness = mkHarness({ extraSyncOptions: { diskSpace: () => ({ ok: false, free: 0 }) } });
        const result = await harness.sync.applyUpdate(hardGateTarget);
        expect(result.status).toBe(507);
        expect(result.body.code).toBe("insufficient_disk");
        expect(harness.gatewayQuiesce.stop).not.toHaveBeenCalled();
        expect(harness.restartProcess).not.toHaveBeenCalled();
        expect(backupInvocations(harness)).toEqual([]);
      });

      it("#7: a legacy archive FILE at the checkpoint directory is preserved and refuses capture", async () => {
        const harness = mkHarness();
        const dir = backupsDirOf(harness);
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        fs.writeFileSync(dir, "legacy archive\n");
        const result = await harness.sync.applyUpdate(hardGateTarget);
        expect(result.status).toBeGreaterThanOrEqual(400);
        expect(fs.readFileSync(dir, "utf8")).toBe("legacy archive\n");
        expect(harness.restartProcess).not.toHaveBeenCalled();
        expect(backupInvocations(harness)).toEqual([]);
      });

      it("keeps the legacy archive when an attempted destination repair cannot run", async () => {
        const failingFs = { ...fs, renameSync: vi.fn(() => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); }) };
        const harness = mkHarness({ extraSyncOptions: { fsModule: failingFs } });
        const dir = backupsDirOf(harness);
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        fs.writeFileSync(dir, "legacy archive\n");
        expect((await harness.sync.applyUpdate(hardGateTarget)).status).toBeGreaterThanOrEqual(400);
        expect(fs.statSync(dir).isFile()).toBe(true);
        expect(fs.readFileSync(dir, "utf8")).toBe("legacy archive\n");
        expect(harness.store.readState().applied).toBeNull();
      });

      it("preserves an interrupted legacy migration artifact while creating a fresh checkpoint", async () => {
        const harness = mkHarness();
        const dir = backupsDirOf(harness);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const stranded = `${dir}.migrating-999-abcdef`;
        fs.writeFileSync(stranded, "stranded legacy archive\n");
        assertCheckpoint(harness, await harness.sync.applyUpdate(hardGateTarget));
        expect(fs.readFileSync(stranded, "utf8")).toBe("stranded legacy archive\n");
      });

      it("refuses to write checkpoints through a symlink", async () => {
        const harness = mkHarness();
        const dir = backupsDirOf(harness);
        const realTarget = mkTemp("alphaclaw-symlink-target-");
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        fs.symlinkSync(realTarget, dir);
        const result = await harness.sync.applyUpdate(hardGateTarget);
        expect(result.status).toBe(409);
        expect(fs.readdirSync(realTarget)).toEqual([]);
        expect(harness.restartProcess).not.toHaveBeenCalled();
        expect(backupInvocations(harness)).toEqual([]);
      });

      it("removes an unverified checkpoint on validation failure and preserves existing archives", async () => {
        const harness = mkHarness({ extraSyncOptions: { fsModule: failCapture("CHECKPOINT_PAYLOAD_INVALID") } });
        const dir = backupsDirOf(harness);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(dir, "openclaw-backup-old.tar.gz"), "good old backup\n");
        const result = await harness.sync.applyUpdate(hardGateTarget);
        expect(result.status).toBe(409);
        expect(result.body.code).toBe("CHECKPOINT_PAYLOAD_INVALID");
        expect(fs.readdirSync(dir)).toEqual(["openclaw-backup-old.tar.gz"]);
        expect(fs.readFileSync(path.join(dir, "openclaw-backup-old.tar.gz"), "utf8")).toBe("good old backup\n");
      });

      it("a same-channel stable upgrade also refuses an invalid checkpoint rather than warning and continuing", async () => {
        const harness = mkHarness({ extraSyncOptions: { fsModule: failCapture("CHECKPOINT_PAYLOAD_INVALID") } });
        const result = await harness.sync.applyUpdate({ channel: "stable", version: "1.1.0" });
        expect(result.status).toBe(409);
        expect(result.body.code).toBe("CHECKPOINT_PAYLOAD_INVALID");
        expect(harness.store.readState().applied).toBeNull();
        expect(harness.restartProcess).not.toHaveBeenCalled();
        expect(fs.readdirSync(backupsDirOf(harness))).toEqual([]);
      });

      it("removes failed checkpoint staging and spares older backups", async () => {
        const failingFs = { ...fs, writeFileSync(file, ...args) {
          if (typeof file === "number") throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
          return fs.writeFileSync(file, ...args);
        } };
        const harness = mkHarness({ extraSyncOptions: { fsModule: failingFs } });
        const dir = backupsDirOf(harness);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(dir, "openclaw-backup-old.tar.gz"), "good old backup\n");
        expect((await harness.sync.applyUpdate(hardGateTarget)).status).toBeGreaterThanOrEqual(400);
        expect(fs.readdirSync(dir)).toEqual(["openclaw-backup-old.tar.gz"]);
        expect(harness.restartProcess).not.toHaveBeenCalled();
      });

      it("reports checkpoint timeout, disk-full, and unsafe-path refusal without a broader fallback", async () => {
        for (const code of ["CHECKPOINT_BUDGET", "CHECKPOINT_DISK_SPACE", "CHECKPOINT_SOURCE_ALIAS"]) {
          const harness = mkHarness({ extraSyncOptions: { fsModule: failCapture(code) } });
          const result = await harness.sync.applyUpdate(hardGateTarget);
          expect(result.status).toBe(409);
          expect(result.body.code).toBe(code);
          expect(result.body.hint).toContain("no broader backup");
          expect(harness.restartProcess).not.toHaveBeenCalled();
          expect(backupInvocations(harness)).toEqual([]);
        }
      });

      it("releases the apply latch after a checkpoint failure so a retry succeeds", async () => {
        let fail = true;
        const harness = mkHarness({ extraSyncOptions: { fsModule: failCapture("CHECKPOINT_PERMISSIONS", () => fail) } });
        expect((await harness.sync.applyUpdate(hardGateTarget)).status).toBe(409);
        expect(harness.sync.isApplyInProgress()).toBe(false);
        fail = false;
        assertCheckpoint(harness, await harness.sync.applyUpdate(hardGateTarget));
        expect(fs.readdirSync(backupsDirOf(harness))).toHaveLength(1);
      });

      it("a config checkpoint cannot prune actual database archives, debris or operator files as if it replaced them", async () => {
        const harness = mkHarness();
        const dir = backupsDirOf(harness);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const names = ["openclaw-backup-a.tar.gz", "openclaw-backup-b.tar.gz", "openclaw-backup-c.tar.gz", "openclaw-backup-d.tar.gz", "openclaw-backup-x.tar.gz.unverified", "openclaw-backup-z.tar.gz.old.tmp", "unrelated.txt", "openclaw-backup-notes.txt"];
        for (const name of names) fs.writeFileSync(path.join(dir, name), name);
        assertCheckpoint(harness, await harness.sync.applyUpdate(hardGateTarget));
        for (const name of names) expect(fs.readFileSync(path.join(dir, name), "utf8")).toBe(name);
      });

      it("checkpoint creation preserves operator copy-of files and legacy alphaclaw archives independently of directory checkpoints", async () => {
        const harness = mkHarness();
        const dir = backupsDirOf(harness);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const names = ["copy-of-openclaw-backup-a.tar.gz", "openclaw-backup-a.tar.gz", "openclaw-backup-b.tar.gz", "openclaw-backup-c.tar.gz", "openclaw-backup-e.alphaclaw.tar.gz", "openclaw-backup-d.tar.gz"];
        for (const name of names) fs.writeFileSync(path.join(dir, name), name);
        assertCheckpoint(harness, await harness.sync.applyUpdate(hardGateTarget));
        for (const name of names) expect(fs.readFileSync(path.join(dir, name), "utf8")).toBe(name);
        expect(fs.readdirSync(dir)).toHaveLength(names.length + 1);
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

    it("builds dev-head in an isolated candidate with a stripped git env and never runs the native updater", async () => {
      process.env.GIT_ASKPASS = "/tmp/fake-askpass";
      const buildCalls = [];
      const { sync, store, rootDir, runner } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        runnerImpl: async (opts, fallback) => {
          if (opts.command === "pnpm" && opts.args?.[0] === "build") {
            buildCalls.push(opts);
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
      expect(buildCalls).toHaveLength(1);
      expect(buildCalls[0].args).toEqual(["build"]);
      expect(buildCalls[0].env).not.toHaveProperty("GIT_ASKPASS");
      expect(buildCalls[0].env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(runner.runStreamed.mock.calls.some(([opts]) => opts.command === "openclaw" && opts.args?.[0] === "update")).toBe(false);
      expect(store.readState().applied).toEqual(
        expect.objectContaining({ channel: "dev", sha: kDevSha }),
      );
      const candidate = buildCalls[0].env.OPENCLAW_GIT_DIR;
      expect(path.dirname(candidate)).toBe(path.join(rootDir, "openclaw-candidates"));
      expect(store.readState().applied.checkoutDir).toBe(candidate);
      expect(fs.readFileSync(path.join(rootDir, "openclaw", ".git", "HEAD"), "utf8")).toBe(`${kDevSha}\n`);
      const preparationCalls = runner.runStreamed.mock.calls.map(([opts]) => opts).filter((opts) => opts.cwd === candidate);
      expect(preparationCalls.map((opts) => [opts.command, opts.args])).toEqual([
        ["git", ["clone", "--filter=blob:none", "--no-checkout", "--single-branch", "--branch", "main", "https://github.com/openclaw/openclaw.git", candidate]],
        ["git", ["checkout", "--detach", "origin/main"]],
        ["pnpm", ["install", "--frozen-lockfile"]],
        ["pnpm", ["build"]],
        ["pnpm", ["ui:build"]],
        [process.execPath, [path.join(candidate, "bin", "entry.js"), "doctor"]],
      ]);
      for (const call of preparationCalls) {
        expect(call.env.OPENCLAW_GIT_DIR).toBe(candidate);
        expect(call.env.OPENCLAW_STATE_DIR).toBe(path.join(call.env.HOME, "state"));
        expect(call.env.OPENCLAW_STATE_DIR).not.toBe(path.join(rootDir, ".openclaw"));
        expect(call.env.OPENCLAW_CONFIG_PATH).toBe(path.join(call.env.OPENCLAW_STATE_DIR, "openclaw.json"));
      }
      expect(fs.existsSync(preparationCalls[0].env.HOME)).toBe(false);
      // Intent stamp (#76 RC3): a dev apply has no version order — kind
      // "dev", so it can never read as a "downgrade" that authorizes a
      // settings restore. A HEAD apply stamps before the sha is known.
      expect(store.readState().lastTransition).toEqual({
        at: expect.any(Number),
        from: "1.0.0",
        to: "dev",
        kind: "dev",
        source: "operator_apply",
        reason: null,
        operationId: store.readState().lastUpdateRun.operationId,
        ok: true,
        consumedAt: null,
      });

      const failing = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        runnerImpl: async (opts, fallback) => {
          if (opts.command === "pnpm" && opts.args?.[0] === "build") {
            return {
              ok: false,
              code: 1,
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
      const buildStep = failing.store
        .readState()
        .lastUpdateRun.steps.findLast((step) => step.name === "build");
      expect(buildStep.status).toBe("failed");
      expect(buildStep).not.toHaveProperty("updaterStatus");
      expect(failing.restartProcess).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(failing.rootDir, "openclaw", ".git", "HEAD"), "utf8").trim()).toBe(kDevSha);
    });

    it("retains candidate build output larger than the default 64KB tail without treating embedded JSON as updater authority", async () => {
      const bigReport = `${JSON.stringify({
        status: "error",
        padding: "x".repeat(80 * 1024),
      })}\n`;
      const seen = { tailBytes: null };
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        runnerImpl: async (opts, fallback) => {
          if (opts.command === "pnpm" && opts.args?.[0] === "build") {
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
      expect(buildStep).not.toHaveProperty("updaterStatus");
    });

    it.each([
      {
        name: "migrated state without rollback",
        report: { reason: "state-migrated-no-rollback",
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" } },
        evidence: { updaterReason: "state-migrated-no-rollback",
          updaterRecovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" } },
        hint: "state was migrated and the update was not rolled back",
      },
      {
        name: "unverified rollback safety",
        report: { reason: "rollback-state-unverified", recovery: { serviceRestartSafe: false } },
        evidence: { updaterReason: "rollback-state-unverified", updaterRecovery: { serviceRestartSafe: false } },
        hint: "could not verify that state is safe to roll back",
      },
      {
        name: "verified package restoration with unverified runtime",
        report: { recovery: { packageRollbackVerified: true, serviceRestartSafe: false } },
        evidence: { updaterRecovery: { packageRollbackVerified: true, serviceRestartSafe: false } },
        hint: "previous package was restored. The installation has not been verified safe to restart",
      },
      {
        name: "verified package restoration and runnable fallback",
        report: { recovery: { packageRollbackVerified: true, serviceRestartSafe: true } },
        evidence: { updaterRecovery: { packageRollbackVerified: true, serviceRestartSafe: true } },
        hint: "previous package was restored. Inspect the raw update log",
      },
      {
        name: "runnable installation without rollback evidence",
        report: { recovery: { serviceRestartSafe: true } },
        evidence: { updaterRecovery: { serviceRestartSafe: true } },
        hint: "runnable installation remains, but did not confirm a rollback",
      },
      {
        name: "no recovery metadata",
        report: {}, evidence: {}, hint: "did not confirm recovery of the previous installation",
      },
      {
        name: "malformed recovery fields cannot claim successful restoration",
        report: { reason: "x".repeat(121), recovery: { serviceRestartSafe: "true",
          packageRollbackVerified: 1, reason: "invalid reason/path", privateDetail: { token: "not-public" } } },
        evidence: {}, hint: "did not confirm recovery of the previous installation",
      },
      {
        name: "no-rollback refusal takes precedence over conflicting recovery metadata",
        report: { reason: "state-migrated-no-rollback",
          recovery: { packageRollbackVerified: true, serviceRestartSafe: true } },
        evidence: { updaterReason: "state-migrated-no-rollback",
          updaterRecovery: { packageRollbackVerified: true, serviceRestartSafe: true } },
        hint: "state was migrated and the update was not rolled back",
      },
    ])("keeps the active installation untouched when candidate build output claims $name", async ({ report, evidence, hint }) => {
      const operationEvents = { publish: vi.fn(), complete: vi.fn(), fail: vi.fn() };
      const h = createHarness({
        extraSyncOptions: { operationEvents },
        runnerImpl: async (options, fallback) => options.command === "pnpm" && options.args?.[0] === "build"
          ? { ok: false, code: 1, tail: `build complete\n${JSON.stringify({ status: "error", ...report })}\n`, timedOut: false }
          : fallback(options),
      });
      const checkoutDir = writeCheckoutFixture(h.rootDir, { sha: kOtherSha });
      const activeHead = fs.readFileSync(path.join(checkoutDir, ".git", "HEAD"));
      const activeConfig = fs.readFileSync(path.join(h.openclawDir, "openclaw.json"));
      const failure = await h.sync.applyUpdate({ channel: "dev", devHead: true });
      expect(failure.status).toBe(409);
      expect(failure.body).toMatchObject({ ok: false, code: "dev_build_failed",
        message: "The isolated OpenClaw source build failed." });
      expect(failure.body.hint).toContain("Review the build output");
      expect(failure.body.hint).not.toContain(hint);
      for (const key of Object.keys(evidence)) expect(failure.body).not.toHaveProperty(key);
      expect(fs.readFileSync(path.join(checkoutDir, ".git", "HEAD"))).toEqual(activeHead);
      expect(fs.readFileSync(path.join(h.openclawDir, "openclaw.json"))).toEqual(activeConfig);
      expect(h.runner.runStreamed.mock.calls.some(([opts]) => opts.command === "openclaw" && opts.args?.[0] === "update")).toBe(false);
      expect(failure.body.hint).not.toContain("reverted the checkout");
      expect(failure.body).not.toHaveProperty("updaterReason");
      expect(failure.body).not.toHaveProperty("updaterRecovery");
      const state = h.store.readState();
      expect(state.applied).toBeNull();
      expect(state.lastUpdateRun.result).toMatchObject({ hint: failure.body.hint });
      expect(h.sync.runLedger.readRun(state.lastUpdateRun.operationId)).toMatchObject({
        state: "failed", result: { code: "dev_build_failed", hint: failure.body.hint },
      });
      expect(state.lastUpdateRun.steps.findLast((step) => step.name === "build"))
        .toMatchObject({ status: "failed", tail: expect.stringContaining("build complete") });
      expect(operationEvents.fail).toHaveBeenCalledWith(state.lastUpdateRun.operationId,
        expect.objectContaining({ hint: failure.body.hint }));
      expect(h.restartProcess).not.toHaveBeenCalled();
    });

    it("does not infer rollback from timeout log prose without a structured updater result", async () => {
      const h = createHarness({ runnerImpl: async (options, fallback) =>
        options.command === "pnpm" && options.args?.[0] === "build"
          ? { ok: false, code: null, timedOut: true, tail: "Attempting rollback before timeout..." }
          : fallback(options) });
      const failure = await h.sync.applyUpdate({ channel: "dev", devHead: true });
      expect(failure.body).toMatchObject({ code: "dev_build_failed", message: "The isolated OpenClaw source build failed." });
      expect(failure.body.hint).toContain("Review the build output");
      expect(failure.body.hint).not.toMatch(/restored|reverted|safe to restart/i);
      expect(failure.body).not.toHaveProperty("updaterRecovery");
      expect(h.restartProcess).not.toHaveBeenCalled();
    });

    it("builds a pinned dev commit via clone/fetch/checkout/install/build/ui-build/isolated doctor", async () => {
      const { sync, store, rootDir, runner } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      const checkoutDir = writeCheckoutFixture(rootDir, { sha: kOtherSha });

      const result = await sync.applyUpdate({ channel: "dev", sha: kDevSha });

      expect(result.status).toBe(202);
      expect(store.readState().applied).toEqual(
        expect.objectContaining({ channel: "dev", sha: kDevSha }),
      );
      // A pinned-sha dev apply names the sha as its `to`; still kind "dev".
      expect(store.readState().lastTransition).toEqual(
        expect.objectContaining({ from: "1.0.0", to: kDevSha, kind: "dev", source: "operator_apply", ok: true }),
      );
      const candidate = store.readState().applied.checkoutDir;
      expect(path.dirname(candidate)).toBe(`${checkoutDir}-candidates`);
      expect(fs.readFileSync(path.join(checkoutDir, ".git", "HEAD"), "utf8")).toBe(`${kOtherSha}\n`);
      expect(fs.readFileSync(path.join(candidate, ".git", "HEAD"), "utf8")).toBe(`${kDevSha}\n`);
      const checkoutBin = path.join(candidate, "bin", "entry.js");
      const checkoutCalls = runner.runStreamed.mock.calls
        .map((call) => call[0])
        .filter((opts) => opts.cwd === candidate)
        .map((opts) => [opts.command, opts.args]);
      expect(checkoutCalls).toEqual([
        ["git", ["clone", "--filter=blob:none", "--no-checkout", "--single-branch", "--branch", "main", "https://github.com/openclaw/openclaw.git", candidate]],
        ["git", ["fetch", "--all", "--tags"]],
        ["git", ["checkout", "--detach", kDevSha]],
        ["pnpm", ["install", "--frozen-lockfile"]],
        ["pnpm", ["build"]],
        ["pnpm", ["ui:build"]],
        [process.execPath, [checkoutBin, "doctor"]],
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

    it("refuses a REAL range the running major satisfies but the minor floor does not (v0.9.80)", async () => {
      // The pre-0.9.80 gate compared majors only, so this spec — same major as
      // the running Node, floor one minor above it — passed and the box
      // downloaded a build that refuses to start. Built from the live runtime
      // so it fails on every CI lane and every developer machine alike.
      const [major, minor] = process.versions.node.split(".").map(Number);
      const spec = `>=${major}.${minor + 1}.0 <${major + 1}`;
      const releases = {
        getCatalog: vi.fn(async () => ({
          stable: [{ version: "1.1.0", engines: { node: spec } }],
          beta: [],
        })),
      };
      const { sync, store, installToTempDir } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        releases,
      });

      const result = await sync.applyUpdate({ channel: "stable", version: "1.1.0" });

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("engines_unsupported");
      expect(result.body.message).toContain(spec);
      expect(result.body.message).toContain(process.versions.node);
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
      expect(failBegin).not.toHaveBeenCalled();
      expect(failEnd).not.toHaveBeenCalled();
      failing.installToTempDir.mockRejectedValue(new Error("fixture preparation failed"));
      const preparedFailure = await failing.sync.applyUpdate({ channel: "beta", version: "1.4.0" });
      expect(preparedFailure.status).toBeGreaterThanOrEqual(400);
      expect(failBegin).toHaveBeenCalledTimes(1);
      expect(failEnd).toHaveBeenCalledTimes(1);
    });

    it("self-update gate: blocks with a hint, fails closed on probe errors, defaults open", async () => {
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
      expect(throwingResult.status).toBe(409);
      expect(throwingResult.body.code).toBe("self_update_unverified");
      expect(throwing.gatewayQuiesce.stop).not.toHaveBeenCalled();
      expect(throwing.restartProcess).not.toHaveBeenCalled();
      expect(throwing.store.readState().applied).toBeNull();

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

      const result = await sync.runUpdateRepair({ operationId: "11111111-1111-4111-8111-111111111111" });

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

      const result = await sync.runUpdateRepair({ operationId: "11111111-1111-4111-8111-111111111111" });

      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      const repairCall = runner.runStreamed.mock.calls.find(
        ([opts]) => opts.command === "openclaw" && opts.args?.[0] === "update",
      );
      expect(repairCall).toBeTruthy();
      expect(repairCall[0].args).toEqual(["update", "repair"]);
      expect(operationEvents.complete).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
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

      const result = await sync.runUpdateRepair({ operationId: "11111111-1111-4111-8111-111111111111" });

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
      expect(failedId).toBe("11111111-1111-4111-8111-111111111111");
      expect(failedError.code).toBe("repair_failed");
      expect(sync.isApplyInProgress()).toBe(false);
    });

    it("leaves the preceding apply history intact while recording its own repair", async () => {
      const { sync, store } = createHarness({ channel: "dev" });
      const previous = {
        operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        target: { channel: "dev", sha: kDevSha },
        startedAt: 1, finishedAt: 2, ok: false,
        steps: [{ name: "verify", status: "failed", at: 2 }],
        result: { ok: false, code: "verify_failed" },
      };
      store.updateState((state) => { state.lastUpdateRun = previous; return state; });
      const before = store.readState().lastUpdateRun;
      const operationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      expect(await sync.runUpdateRepair({ operationId })).toMatchObject({ status: 200 });
      expect(store.readState().lastUpdateRun).toEqual(before);
      expect(sync.runLedger.readRun(operationId)).toMatchObject({
        operationId, state: "completed", target: { channel: "dev", repair: true },
      });
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

      const first = sync.runUpdateRepair({ operationId: "22222222-2222-4222-8222-222222222222" });
      // The latch is taken synchronously before the runner is awaited.
      const second = await sync.runUpdateRepair({ operationId: "33333333-3333-4333-8333-333333333333" });
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

    it("records the repair in the run ledger and completes it in place on success", async () => {
      const { sink, ledger } = makeLedgerSpy();
      const { sync } = createHarness({
        channel: "dev",
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        extraSyncOptions: { runLedger: ledger },
      });

      const result = await sync.runUpdateRepair({ operationId: "11111111-1111-4111-8111-111111111111" });

      expect(result.status).toBe(200);
      expect(ledger.createRun).toHaveBeenCalledWith({
        operationId: "11111111-1111-4111-8111-111111111111",
        target: { channel: "dev", repair: true },
      });
      expect(ledger.createLogSink).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: "11111111-1111-4111-8111-111111111111" }),
      );
      expect(ledger.completeRun).toHaveBeenCalledTimes(1);
      expect(ledger.completeRun).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
        expect.objectContaining({ state: "completed", ok: true }),
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

      const result = await sync.runUpdateRepair({ operationId: "11111111-1111-4111-8111-111111111111" });

      expect(result.status).toBe(500);
      expect(ledger.completeRun).toHaveBeenCalledTimes(1);
      expect(ledger.completeRun).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
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

      const result = await sync.runUpdateRepair({ operationId: "11111111-1111-4111-8111-111111111111" });

      // The route resolves (does not hang or throw) with a failure envelope.
      expect(result.status).toBe(500);
      expect(result.body.code).toBe("repair_failed");
      // The ledger run is completed as failed (not left "running"), the SSE
      // subscriber gets an error (not a hang), the sink closes, latch released.
      expect(ledger.completeRun).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
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

    it("dev applies require a verified config checkpoint without invoking a full archive producer", async () => {
      const { sync, rootDir, store, runner } = createHarness({
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
      expect(result.status).toBe(202);
      expect(result.body.recovery).toMatchObject({ kind: "config_only", checkpoint: { verified: true }, databases: { complete: false } });
      expect(store.readState().applied).toMatchObject({ channel: "dev" });
      expect(runner.runStreamed.mock.calls.some(([opts]) => opts.args?.includes("backup"))).toBe(false);
    });

    it("a corrupt state database refuses dev preparation commit regardless of a phantom archive success", async () => {
      const { sync, rootDir, store, openclawDir, gatewayQuiesce, restartProcess, runner } = createHarness({
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
      fs.mkdirSync(path.join(openclawDir, "state"), { recursive: true });
      fs.writeFileSync(path.join(openclawDir, "state", "openclaw.sqlite"), "db");

      const result = await sync.applyUpdate({ channel: "dev", devHead: true });

      expect(result.status, JSON.stringify(result.body)).toBe(409);
      expect(result.body.code).toBe("db_preflight_failed");
      expect(result.body.backupRiskEligible).toBe(false);
      expect(result.body.repairApplicable).toBeUndefined();
      expect(result.body.preflight.perDb).toContainEqual(expect.objectContaining({
        status: "corrupt",
        sourcePath: path.join(openclawDir, "state", "openclaw.sqlite"),
      }));
      expect(store.readState().applied).toBeNull();
      expect(store.readState().backups || []).toHaveLength(0);
      expect(fs.readFileSync(path.join(openclawDir, "state", "openclaw.sqlite"), "utf8")).toBe("db");
      expect(gatewayQuiesce.stop).not.toHaveBeenCalled();
      expect(restartProcess).not.toHaveBeenCalled();
      expect(runner.runStreamed.mock.calls.some(([opts]) => opts.args?.includes("backup"))).toBe(false);
    });

    it("creates a real config checkpoint on a fresh install instead of accepting a phantom archive", async () => {
      const { sync, rootDir, store, runner } = createHarness({
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

      expect(result.status).toBe(202);
      expect(result.body.recovery).toMatchObject({ kind: "config_only", checkpoint: { verified: true } });
      expect(fs.statSync(result.body.recovery.checkpoint.file).isDirectory()).toBe(true);
      expect(runner.runStreamed.mock.calls.some(([opts]) => opts.args?.includes("backup"))).toBe(false);
      expect(store.readState().backups || []).toHaveLength(0);
    });

    describe("config-only coverage replaces fresh-install waivers (WI-1.7)", () => {
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

      const assertConfigOnly = (harness, result, expectedPaths = ["openclaw.json"]) => {
        expect(result.status).toBe(202);
        expect(result.body.recovery).toMatchObject({ kind: "config_only", checkpoint: { verified: true }, databases: { complete: false, verified: false } });
        const manifest = result.body.recovery.manifest;
        expect(manifest.files.map((entry) => entry.archivePath).sort()).toEqual([...expectedPaths].sort());
        expect(manifest.databases).toEqual([]);
        expect(harness.runner.runStreamed.mock.calls.filter(([opts]) => opts.args?.includes("backup") || ["gzip", "tar"].includes(opts.command))).toEqual([]);
        for (const entry of manifest.files) {
          const captured = fs.readFileSync(path.join(result.body.recovery.checkpoint.file, "payload", entry.archivePath));
          expect(crypto.createHash("sha256").update(captured).digest("hex")).toBe(entry.sha256);
        }
      };


      it("captures a populated openclaw.json without invoking a legacy archive producer", async () => {
        const harness = mkFresh();
        fs.mkdirSync(harness.openclawDir, { recursive: true });
        fs.writeFileSync(path.join(harness.openclawDir, "openclaw.json"), '{"agents":{"list":[]}}\n');
        const result = await harness.sync.applyUpdate(hardGateTarget);
        assertConfigOnly(harness, result);
      });

      it("omits a session transcript without discarding it or claiming database recovery", async () => {
        const harness = mkFresh();
        const sessions = path.join(harness.openclawDir, "agents", "main", "sessions");
        fs.mkdirSync(sessions, { recursive: true });
        fs.writeFileSync(path.join(sessions, "abc.jsonl"), "{}\n");
        fs.writeFileSync(path.join(harness.openclawDir, "openclaw.json"), "{}\n");
        const result = await harness.sync.applyUpdate(hardGateTarget);
        assertConfigOnly(harness, result);
      });

      it("does not let earlier build history replace a fresh config checkpoint", async () => {
        const harness = mkFresh();
        harness.store.updateState((s) => {
          s.lastKnownGood.package = "0.9.9";
          return s;
        });
        const result = await harness.sync.applyUpdate(hardGateTarget);
        assertConfigOnly(harness, result);
      });

      it("checkpoints even an empty config rather than applying a fresh-install waiver", async () => {
        const harness = mkFresh();
        fs.mkdirSync(harness.openclawDir, { recursive: true });
        fs.writeFileSync(path.join(harness.openclawDir, "openclaw.json"), "{}\n");
        harness.store.updateState((s) => {
          s.pinVersion = "1.0.0";
          s.lastKnownGood.package = "1.0.0";
          return s;
        });
        const result = await harness.sync.applyUpdate(hardGateTarget);
        assertConfigOnly(harness, result);
      });

      it("refuses unreadable config before pause or checkpoint creation", async () => {
        const harness = mkFresh();
        fs.unlinkSync(path.join(harness.openclawDir, "openclaw.json"));
        fs.mkdirSync(path.join(harness.openclawDir, "openclaw.json"), { recursive: true });
        const result = await harness.sync.applyUpdate(hardGateTarget);
        expect(result.status).toBe(409);
        expect(result.body.code).toBe("RECOVERY_INVENTORY_UNSUPPORTED");
        expect(harness.gatewayQuiesce.stop).not.toHaveBeenCalled();
        expect(harness.restartProcess).not.toHaveBeenCalled();
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
          "absolute_symlinks",
        ],
      ])(
        "captures only exact config and optional auth/identity paths when the tree holds %s",
        async (_label, plant, veto) => {
          const harness = mkFresh();
          fs.mkdirSync(harness.openclawDir, { recursive: true });
          plant(harness.openclawDir);
          const result = await harness.sync.applyUpdate(hardGateTarget);
          const optionalPath = _label === "a legacy auth-profiles.json" ? "agents/main/agent/auth-profiles.json" : _label === "an identity dir" ? "identity/device.json" : null;
          assertConfigOnly(harness, result, ["openclaw.json", ...(optionalPath ? [optionalPath] : [])]);
        },
      );

      it("omits AlphaClaw bookkeeping, logs, backups, tmp, env and empty session directories from the checkpoint", async () => {
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
        assertConfigOnly(harness, result);
      });

      // X3: the allowlist used to `continue` on the NAME before looking at
      // the entry — a symlink named `.env`/`logs`, a special file named `tmp`
      // or a credentials dump renamed `.env` all counted as fresh. The names
      // are accepted only in their expected shape.
      describe("excluded content is never captured or followed (X3)", () => {
        const expectOmitted = async (harness, veto = null) => {
          const result = await harness.sync.applyUpdate(hardGateTarget);
          assertConfigOnly(harness, result);
        };


        it("never follows a .env symlink outside the state root", async () => {
          const harness = mkFresh();
          fs.mkdirSync(harness.openclawDir, { recursive: true });
          fs.symlinkSync("/etc/passwd", path.join(harness.openclawDir, ".env"));
          await expectOmitted(harness, "env_files_excluded");
        });

        it("never follows a .env symlink targeting a directory", async () => {
          const harness = mkFresh();
          fs.mkdirSync(harness.openclawDir, { recursive: true });
          fs.mkdirSync(path.join(harness.rootDir, ".env"));
          fs.symlinkSync(path.join(harness.rootDir, ".env"), path.join(harness.openclawDir, ".env"));
          await expectOmitted(harness, "env_files_excluded");
        });

        it("omits the onboarding .env link and its secret-bearing target", async () => {
          const harness = mkFresh();
          fs.mkdirSync(harness.openclawDir, { recursive: true });
          fs.writeFileSync(path.join(harness.rootDir, ".env"), "SETUP_PASSWORD=pw\nTELEGRAM_BOT_TOKEN=1:a\n");
          fs.symlinkSync(path.join(harness.rootDir, ".env"), path.join(harness.openclawDir, ".env"));
          await expectOmitted(harness);
        });

        it("omits regular env files regardless of bookkeeping keys, secret keys, or size", async () => {
          const bookkeeping = mkFresh();
          fs.mkdirSync(bookkeeping.openclawDir, { recursive: true });
          fs.writeFileSync(path.join(bookkeeping.openclawDir, ".env"), "# planted by setup\nSETUP_PASSWORD=pw\n");
          await expectOmitted(bookkeeping);

          const secretful = mkFresh();
          fs.mkdirSync(secretful.openclawDir, { recursive: true });
          fs.writeFileSync(
            path.join(secretful.openclawDir, ".env"),
            "SETUP_PASSWORD=pw\nOPENCLAW_GATEWAY_TOKEN=abc\n",
          );
          await expectOmitted(secretful, "env_files_excluded");

          const oversized = mkFresh();
          fs.mkdirSync(oversized.openclawDir, { recursive: true });
          fs.writeFileSync(path.join(oversized.openclawDir, ".env"), `# ${"x".repeat(5000)}\n`);
          await expectOmitted(oversized, "env_files_excluded");
        });

        it.each([".alphaclaw", "logs", "backups", "tmp"])(
          "does not capture or recurse into a bookkeeping symlink named %s",
          async (name) => {
            const harness = mkFresh();
            fs.mkdirSync(harness.openclawDir, { recursive: true });
            const elsewhere = path.join(harness.rootDir, "elsewhere");
            fs.mkdirSync(elsewhere, { recursive: true });
            fs.symlinkSync(elsewhere, path.join(harness.openclawDir, name));
            await expectOmitted(harness);
          },
        );

        it("omits a regular file named logs from the checkpoint", async () => {
          const harness = mkFresh();
          fs.mkdirSync(harness.openclawDir, { recursive: true });
          fs.writeFileSync(path.join(harness.openclawDir, "logs"), "not a dir\n");
          await expectOmitted(harness);
        });
      });
    });

    it("db-preflight: no database + a credentials store alone records an empty database set without claiming data backup", async () => {
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      fs.mkdirSync(path.join(harness.openclawDir, "credentials"), { recursive: true });
      fs.writeFileSync(path.join(harness.openclawDir, "credentials", "telegram.json"), "{}\n");
      const result = await harness.sync.applyUpdate({ channel: "beta", version: "1.1.0" });
      expect(result.status).toBe(202);
      const [record] = readRunRecords(harness.openclawDir);
      expect(record.dbPreflight).toMatchObject({ ok: true, migrationRequired: false, perDb: [], byKind: { state: { count: 0 }, agent: { count: 0 } } });
      expect(record.recovery).toMatchObject({ kind: "config_only", databases: { complete: false, verified: false } });
      expect(record.recovery.manifest.files.map((entry) => entry.archivePath)).toEqual(["openclaw.json"]);
      expect(record.steps).toContainEqual(expect.objectContaining({ name: "db-preflight", status: "completed" }));
    });

    // Same predicate at the db-preflight blind spot: no database to probe is
    // "compatible" only for a fresh tree; otherwise the step says it could
    // not check, instead of claiming a pass.
    it("db-preflight: no database + non-empty state tree records an empty database set without claiming data backup", async () => {
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      fs.mkdirSync(harness.openclawDir, { recursive: true });
      fs.writeFileSync(path.join(harness.openclawDir, "openclaw.json"), '{"agents":{}}\n');
      const result = await harness.sync.applyUpdate({ channel: "beta", version: "1.1.0" });
      expect(result.status).toBe(202);
      const [record] = readRunRecords(harness.openclawDir);
      expect(record.dbPreflight).toMatchObject({ ok: true, migrationRequired: false, perDb: [], byKind: { state: { count: 0 }, agent: { count: 0 } } });
      expect(record.recovery).toMatchObject({ kind: "config_only", databases: { complete: false, verified: false } });
      expect(record.recovery.manifest.files.map((entry) => entry.archivePath)).toEqual(["openclaw.json"]);
      expect(record.steps).toContainEqual(expect.objectContaining({ name: "db-preflight", status: "completed" }));
    });

    it("db-preflight: no database on a fresh tree records an empty database set without claiming data backup", async () => {
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      const result = await harness.sync.applyUpdate({ channel: "beta", version: "1.1.0" });
      expect(result.status).toBe(202);
      const [record] = readRunRecords(harness.openclawDir);
      expect(record.dbPreflight).toMatchObject({ ok: true, migrationRequired: false, perDb: [], byKind: { state: { count: 0 }, agent: { count: 0 } } });
      expect(record.recovery).toMatchObject({ kind: "config_only", databases: { complete: false, verified: false } });
      expect(record.recovery.manifest.files.map((entry) => entry.archivePath)).toEqual(["openclaw.json"]);
      expect(record.steps).toContainEqual(expect.objectContaining({ name: "db-preflight", status: "completed" }));
    });

    it("enumerateStateDbs honors OPENCLAW_STATE_DIR from the installed CLI's spawn env", async () => {
      const stateDir = mkTemp("alphaclaw-alt-state-dir-");
      fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}\n");
      const stateFile = writeStateDb(stateDir, { userVersion: 17 });
      const agentFile = writeAgentDb(stateDir, "main", { userVersion: 21 });
      const preflightCalls = [];
      const harness = createHarness({
        openclawDir: stateDir,
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

      // A routine same-channel apply (stable pin → stable: a stable→beta move is a channel-boundary HARD gate since #79 (a)).
      const result = await harness.sync.applyUpdate({ channel: "stable", version: "1.1.0" });

      expect(result.status).toBe(202);
      expect(preflightCalls).toEqual([]);
      const [record] = readRunRecords(harness.openclawDir);
      expect(record.dbPreflight.byKind.agent.count).toBe(1);
      expect(record.dbPreflight.byKind.state.count).toBe(1);
      expect(Object.keys(record.dbPreflight.dbSizesBytes).sort()).toEqual([stateFile, agentFile].sort());
      expect(record.recovery.manifest.stateDir).toBe(stateDir);
      expect(record.recovery.manifest.databases).toEqual([]);
      expect(record.recovery.manifest.files.map((entry) => entry.sourcePath)).toEqual([path.join(stateDir, "openclaw.json")]);
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
          if (opts.command === "git" && opts.args?.[0] === "clone") {
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
      expect(seen[0].OPENCLAW_HOME).not.toBe("/data");
      expect(path.basename(seen[0].OPENCLAW_HOME)).toMatch(/^alphaclaw-dev-preparation-/);
      expect(seen[0].OPENCLAW_STATE_DIR).toBe(path.join(seen[0].OPENCLAW_HOME, "state"));
      expect(seen[0].OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
      expect(seen[0].OPENCLAW_TWITCH_ACCESS_TOKEN).toBeUndefined();
    });
  });

  // Issue #78: upstream's `database preflight` compares a file with the
  // release's STATE schema only. Agent DBs carry their own schema line and
  // must be judged against the target's declared OPENCLAW_AGENT_SCHEMA_VERSION,
  // never fed to the verb.
  describe("db-preflight agent arm (issue #78)", () => {
    // The fake target CLI answers the state-schema verb with the given
    // verdict and records every invocation.
    const stateVerbRunner = (verdict, preflightCalls) => async (opts, fallback) => {
      if (Array.isArray(opts.args) && opts.args.includes("preflight")) {
        preflightCalls.push(opts.args);
        return { ok: true, code: 0, tail: `${JSON.stringify(verdict)}\n`, timedOut: false };
      }
      return fallback(opts);
    };
    const sawAgentSnapshot = (preflightCalls) =>
      preflightCalls.some((args) =>
        args.some((arg) => /openclaw-agent\.sqlite/.test(String(arg))),
      );

    it("a lagging agent schema requires a pre-stop recovery choice and carries both read-only metadata verdicts", async () => {
      const preflightCalls = [];
      const harness = createHarness({ pin: "1.0.0", installedVersion: "1.0.0", sentinelVersion: "1.0.0", installFixture: { schema: { state: 17, agent: 19 } }, runnerImpl: stateVerbRunner({}, preflightCalls) });
      const stateFile = writeStateDb(harness.openclawDir, { userVersion: 15 });
      const agentFile = writeAgentDb(harness.openclawDir, "main", { userVersion: 17 });
      const before = [stateFile, agentFile].map((file) => fs.readFileSync(file));
      const result = await harness.sync.applyUpdate({ channel: "stable", version: "1.1.0" });
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("recovery_choice_required");
      expect(result.body.choices).toContain("database_set");
      expect(result.body.choices).toContain("cancel");
      expect(preflightCalls).toEqual([]);
      expect(harness.gatewayQuiesce.stop).not.toHaveBeenCalled();
      expect(harness.dbQuiet).not.toHaveBeenCalled();
      const [record] = readRunRecords(harness.openclawDir);
      expect(record.dbPreflight).toMatchObject({ migrationRequired: true, byKind: { state: { count: 1, foundVersion: 15, targetVersion: 17, migrationRequired: true }, agent: { count: 1, foundVersion: 17, targetVersion: 19, migrationRequired: true } } });
      expect(record.dbPreflight.dbSizesBytes[stateFile]).toBe(fs.statSync(stateFile).size);
      expect(record.dbPreflight.dbSizesBytes[agentFile]).toBe(fs.statSync(agentFile).size);
      for (const [i,file] of [stateFile,agentFile].entries()) expect(fs.readFileSync(file)).toEqual(before[i]);
      expect(harness.store.readState().applied).toBeNull();
    });

    it("an agent DB newer than the declared target fails closed before checkpoint or pause", async () => {
      const preflightCalls = [];
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        installFixture: { schema: { state: 15, agent: 19 } },
        // The state line alone would PASS — the block must come from the agent arm.
        runnerImpl: stateVerbRunner(
          { status: "exact", foundVersion: 15, targetVersion: 15 },
          preflightCalls,
        ),
      });
      writeStateDb(harness.openclawDir, { userVersion: 15 });
      writeAgentDb(harness.openclawDir, "main", { userVersion: 21 });

      // A routine same-channel apply (stable pin → stable: a stable→beta move is a channel-boundary HARD gate since #79 (a)).
      const result = await harness.sync.applyUpdate({ channel: "stable", version: "1.1.0" });

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("db_preflight_failed");
      expect(result.body.preflight.byKind.agent).toMatchObject({ count: 1, foundVersion: 21, targetVersion: 19, compatible: false });
      expect(result.body.preflight.perDb).toContainEqual(expect.objectContaining({ dbKind: "agent", agentId: "main", userVersion: 21, supported: 19, reasons: ["database_schema_newer_than_target"] }));
      expect(preflightCalls).toEqual([]);
      expect(harness.gatewayQuiesce.stop).not.toHaveBeenCalled();
      expect(harness.dbQuiet).not.toHaveBeenCalled();
      expect(harness.store.readState().applied).toBeNull();
      expect(harness.restartProcess).not.toHaveBeenCalled();
      expect(readRunRecords(harness.openclawDir)[0].steps).toContainEqual(expect.objectContaining({ name: "db-preflight", status: "failed" }));
    });

    it("a target with unknown agent schema fails closed without a database copy or consent offer", async () => {
      const preflightCalls = [];
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        // No contract chunks in the target's dist; "1.1.0" is not seeded either.
        installFixture: { schema: { state: 15 } },
        runnerImpl: stateVerbRunner(
          { status: "exact", foundVersion: 15, targetVersion: 15 },
          preflightCalls,
        ),
      });
      writeStateDb(harness.openclawDir, { userVersion: 15 });
      writeAgentDb(harness.openclawDir, "main", { userVersion: 17 });

      // A routine same-channel apply (stable pin → stable: a stable→beta move is a channel-boundary HARD gate since #79 (a)).
      const result = await harness.sync.applyUpdate({ channel: "stable", version: "1.1.0" });

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("db_preflight_failed");
      expect(result.body.preflight.reasons).toContain("unsupported_target_schema_contract");
      expect(result.body.preflight.byKind.agent).toMatchObject({ count: 1, targetVersion: null, compatible: null });
      expect(result.body.backupRiskEligible).not.toBe(true);
      expect(preflightCalls).toEqual([]);
      expect(harness.gatewayQuiesce.stop).not.toHaveBeenCalled();
      expect(harness.store.readState().applied).toBeNull();
      expect(harness.restartProcess).not.toHaveBeenCalled();
    });

    it("a corrupt agent database refuses apply and is never copied, migrated, or consent-waived", async () => {
      const preflightCalls = [];
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        installFixture: { schema: { state: 15, agent: 19 } },
        runnerImpl: stateVerbRunner(
          { status: "exact", foundVersion: 15, targetVersion: 15 },
          preflightCalls,
        ),
      });
      writeStateDb(harness.openclawDir, { userVersion: 15 });
      const agentDb = path.join(
        harness.openclawDir,
        "agents",
        "main",
        "agent",
        "openclaw-agent.sqlite",
      );
      fs.mkdirSync(path.dirname(agentDb), { recursive: true });
      const garbage = "not a sqlite database — just bytes ".repeat(64);
      fs.writeFileSync(agentDb, garbage);

      // A routine same-channel apply (stable pin → stable: a stable→beta move is a channel-boundary HARD gate since #79 (a)).
      const result = await harness.sync.applyUpdate({ channel: "stable", version: "1.1.0" });

      expect(result.status).toBe(409);
      expect(result.body.code).toBe("db_preflight_failed");
      expect(result.body.preflight.byKind.agent).toMatchObject({ count: 1, compatible: null });
      expect(result.body.backupRiskEligible).not.toBe(true);
      expect(preflightCalls).toEqual([]);
      expect(harness.gatewayQuiesce.stop).not.toHaveBeenCalled();
      expect(harness.restartProcess).not.toHaveBeenCalled();
      expect(harness.store.readState().applied).toBeNull();
      expect(fs.readFileSync(agentDb, "utf8")).toBe(garbage);
    });

    it("dev applies use the exact checkout metadata and explicit complete database-set recovery", async () => {
      const preflightCalls = [];
      const harness = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        runnerImpl: async (opts, fallback) => {
          // Dev applies hard-gate on a usable backup (WI-6.1): the archive
          // manifest must list EVERY state DB, agent DBs included.
          if (opts.command === "tar" && opts.args?.[0] === "-xzOf") {
            return {
              ok: true,
              code: 0,
              tail: `${JSON.stringify({
                schemaVersion: 1,
                assets: [
                  { kind: "sqlite", sourcePath: "/data/.openclaw/state/openclaw.sqlite", archivePath: "state/openclaw.sqlite" },
                  { kind: "sqlite", sourcePath: "/data/.openclaw/agents/main/agent/openclaw-agent.sqlite", archivePath: "agents/main/agent/openclaw-agent.sqlite" },
                ],
              })}\n`,
              timedOut: false,
            };
          }
          return stateVerbRunner(
            { status: "exact", foundVersion: 15, targetVersion: 15 },
            preflightCalls,
          )(opts, fallback);
        },
      });
      // The just-built checkout declares agent 19; a dev build has no overlay,
      // so packageDirOverride must point the scan at the checkout.
      const checkoutDir = writeCheckoutFixture(harness.rootDir, { sha: kDevSha });
      writeSchemaContractFixture(checkoutDir, { state: 15, agent: 19 });
      writeStateDb(harness.openclawDir, { userVersion: 15 });
      writeAgentDb(harness.openclawDir, "main", { userVersion: 17 });

      const result = await harness.sync.applyUpdate({ channel: "dev", devHead: true, recoveryMode: "database_set" });

      expect(result.status).toBe(202);
      expect(preflightCalls).toEqual([]);
      const [record] = readRunRecords(harness.openclawDir);
      expect(record.dbPreflight).toMatchObject({ migrationRequired: true, byKind: { state: { foundVersion: 15, targetVersion: 15, migrationRequired: false }, agent: { foundVersion: 17, targetVersion: 19, migrationRequired: true } } });
      expect(record.recovery).toMatchObject({ kind: "database_set", databases: { complete: true, verified: true } });
      expect(record.recovery.databases.entries).toHaveLength(2);
      expect(record.recovery.checkpoint.targetBuild.buildId).toBe(kDevSha);
      expect(harness.runner.runStreamed.mock.calls.some(([opts]) => ["gzip", "tar"].includes(opts.command) || opts.args?.includes("backup"))).toBe(false);
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
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
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
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
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
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      let releaseBackup;
      const backupGate = new Promise((resolve) => {
        releaseBackup = resolve;
      });
      // The applied build IS the installed tree: a rollback only blocklists
      // a build that was running (#76 RC4 — installed ≠ applied is refused
      // as installed_diverged, covered separately).
      const { sync, store, restartProcess } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.5",
        sentinelVersion: "1.0.5",
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
        s.applied = { channel: "beta", version: "1.0.5", at: 1, acceptedAt: null };
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
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      let failCheckpoint;
      const checkpointGate = new Promise((resolve) => {
        failCheckpoint = resolve;
      });
      const { sync, store, restartProcess } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.2.0",
        sentinelVersion: "1.2.0",
        extraSyncOptions: {
          dbQuiet: async () => {
            await checkpointGate;
            throw Object.assign(new Error("checkpoint barrier failed"), { code: "state_db_quiet_unavailable" });
          },
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

      failCheckpoint();
      const applied = await applyPromise;
      expect(applied.status).toBe(409);
      expect(applied.body.code).toBe("state_db_quiet_unavailable");
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
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
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
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
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
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
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
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
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

      expect(execFileSyncImpl).not.toHaveBeenCalled();
      expect(result.action).toBe("rollback_refused");
      expect(installedTreeVersion(installDir)).toBe("1.0.1");
      expect(store.readState().applied).toBeNull();
      expect(
        result.warnings.some((warning) =>
          warning.includes("cannot safely read the current database"),
        ),
      ).toBe(true);
    });

    it("outside a pin window an unknown target also refuses rollback without copying the database", async () => {
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

      expect(result.action).toBe("rollback_refused");
      expect(installedTreeVersion(installDir)).toBe("1.0.1");
      expect(execFileSyncImpl).not.toHaveBeenCalled();
      expect(
        result.warnings.some((warning) =>
          warning.includes("cannot safely read the current database"),
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
      // Outside the published grammar: warn-only posture, like npm engines.
      expect(enginesSatisfied("^20 || ~18.17", "20.0.0")).toBe(true);
      expect(enginesSatisfied("", "20.0.0")).toBe(true);
      expect(enginesSatisfied(undefined, "20.0.0")).toBe(true);
    });

    it("judges the full range, not the major alone (v0.9.80 — OpenClaw 2026.9.3)", () => {
      // The old major-only gate waved Node 24.14 through to a build that
      // refuses to start, and Node 25 through although the range excludes it.
      const spec = ">=24.16.0 <25 || >=26.1.0";
      expect(enginesSatisfied(spec, "22.22.3")).toBe(false);
      expect(enginesSatisfied(spec, "24.14.1")).toBe(false);
      expect(enginesSatisfied(spec, "24.16.0")).toBe(true);
      expect(enginesSatisfied(spec, "v24.20.0")).toBe(true);
      expect(enginesSatisfied(spec, "25.9.0")).toBe(false);
      expect(enginesSatisfied(spec, "26.0.0")).toBe(false);
      expect(enginesSatisfied(spec, "26.1.0")).toBe(true);
      // Same evaluator as the boot floor and the UI rows.
      const { satisfiesEngines } = require("../../lib/engines-range");
      expect(enginesSatisfied(spec, "24.14.1")).toBe(satisfiesEngines(spec, "24.14.1"));
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

// Issue #76 A1 — the bin-phase boot report. syncAtBoot leaves ONE
// boot-report.json (serverPhase pending) on EVERY return path when a writer
// is injected; the report is evidence about the sync and can never change its
// outcome. The writer is the real createBootReportWriter over the store's
// managed dir (what runOpenclawChannelBootSync constructs in production).
describe("syncAtBoot bin-phase boot report (#76 A1)", () => {
  const kBootId = "40:1700000000000";
  const hasProc = process.platform === "linux" && fs.existsSync("/proc/1/stat");
  const readReport = (store) =>
    JSON.parse(fs.readFileSync(path.join(store.managedDir, "boot-report.json"), "utf8"));
  const readRefusedReport = (store) =>
    JSON.parse(fs.readFileSync(path.join(store.managedDir, "boot-report-refused.json"), "utf8"));

  // createHarness builds the store and the sync in one call, so the injected
  // `bootReport` is a thin delegate bound to the real writer over the
  // harness store's managed dir once that store exists.
  const createReportingHarness = (harnessOptions = {}, { selfVersion = null } = {}) => {
    let writer = null;
    const bootReport = {
      bootId: kBootId,
      writeBinPhase: (report) => writer.writeBinPhase(report),
      writeRefusedBinPhase: (report, reason) => writer.writeRefusedBinPhase(report, reason),
    };
    const harness = createHarness({
      ...harnessOptions,
      extraSyncOptions: {
        ...(harnessOptions.extraSyncOptions || {}),
        ...(selfVersion ? { selfVersion } : {}),
        bootReport,
      },
    });
    writer = createBootReportWriter({
      managedDir: harness.store.managedDir,
      bootId: kBootId,
      nowFn: () => harness.nowRef.now,
      logger: kSilentLogger,
    });
    return { ...harness, bootReport: writer };
  };

  it("a normal pin boot writes the report: stamp facts, pin/expected/installed/resolved, sentinel, pending server phase", () => {
    const { sync, store, runner, installToTempDir, packageRoot, openclawDir } = createReportingHarness(
      { pin: "1.0.0", installedVersion: "1.0.0", sentinelVersion: "1.0.0" },
      {
        selfVersion: {
          changed: true,
          previousVersion: "0.9.76",
          record: { version: "0.9.77", commit: "abc123", bootCount: 1, previous: { version: "0.9.76" } },
        },
      },
    );

    const result = sync.syncAtBoot();

    expect(result).toEqual(expect.objectContaining({ ok: true, action: "none" }));
    const report = readReport(store);
    expect(report).toEqual({
      schema: kBootReportSchema,
      bootId: kBootId,
      at: 1_000_000,
      alphaclaw: { version: "0.9.77", commit: "abc123", previousVersion: "0.9.76", firstBootOfVersion: true },
      // /proc-derived container identity; null where there is no /proc.
      container: {
        pid1StartTicks: hasProc ? expect.any(Number) : null,
        startMs: hasProc ? expect.any(Number) : null,
      },
      pidfile: expect.objectContaining({ decision: "proceed", reason: "absent" }),
      openclaw: {
        stateDir: openclawDir,
        declaredPin: "1.0.0",
        channelApplied: null,
        lastKnownGood: { package: null, dev: null },
        expected: "1.0.0",
        installedAtBoot: "1.0.0",
        resolvedForLaunch: "1.0.0",
        installedDiverged: false,
        overlayPresent: false,
        overlayComplete: false,
        sentinelMatches: true,
        bootSync: {
          action: "none",
          reason: null,
          warnings: [],
          // The bin-phase closer ran (nothing to close on a fresh box).
          danglingRecords: { closedRuns: [], closedLastUpdateRun: false },
        },
      },
      binPhase: { status: "ok" },
      serverPhase: { status: "pending" },
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).dependencies.openclaw,
    ).toBe(report.openclaw.declaredPin);
    // Offline and spawn-free: the report is reads only.
    expect(runner.runStreamed).not.toHaveBeenCalled();
    expect(installToTempDir).not.toHaveBeenCalled();
  });

  it("records the configured symlink spelling in the boot report", () => {
    const env = {};
    const { sync, store, openclawDir } = createReportingHarness({
      pin: "1.0.0", installedVersion: "1.0.0", sentinelVersion: "1.0.0",
      extraSyncOptions: { openclawSpawnEnv: () => env },
    });
    const alias = path.join(path.dirname(openclawDir), "state-alias");
    fs.symlinkSync(openclawDir, alias);
    env.OPENCLAW_STATE_DIR = alias;
    expect(sync.syncAtBoot().ok).toBe(true);
    expect(readReport(store).openclaw.stateDir).toBe(alias);
  });

  it("an applied build activated at boot records installedAtBoot (before) and resolvedForLaunch (after) as different versions", () => {
    const { sync, store, installDir, runner, openclawDir } = createReportingHarness({
      pin: "1.0.0",
      channel: "beta",
      installedVersion: "1.0.0",
    });
    store.updateState((s) => {
      s.pinVersion = "1.0.0";
      s.applied = { channel: "beta", version: "1.1.0", at: 1, acceptedAt: 2 };
      s.lastKnownGood.package = "1.0.0";
      return s;
    });
    expect(saveOverlayFixture(store, "1.1.0")).toEqual({ ok: true });

    const result = sync.syncAtBoot();

    expect(result.action).toBe("activated");
    expect(store.readInstalledVersion({ installDir })).toBe("1.1.0");
    const report = readReport(store);
    expect(report.openclaw).toEqual({
      stateDir: openclawDir,
      declaredPin: "1.0.0",
      channelApplied: "beta:1.1.0",
      lastKnownGood: { package: "1.0.0", dev: null },
      expected: "1.1.0",
      installedAtBoot: "1.0.0",
      resolvedForLaunch: "1.1.0",
      // The canonical predicate over the tree that will RUN: activated = not
      // diverged, so the server phase's verdict stays empty for this boot.
      installedDiverged: false,
      overlayPresent: true,
      overlayComplete: true,
      sentinelMatches: true,
      bootSync: {
        action: "activated",
        reason: null,
        warnings: [],
        danglingRecords: { closedRuns: [], closedLastUpdateRun: false },
      },
    });
    expect(computeVerdict({ ...report, serverPhase: { status: "recorded", installedVersion: "1.1.0" } })).toEqual([]);
    // No stamp passed and none on disk: the alphaclaw block is null-shaped,
    // never a throw.
    expect(report.alphaclaw).toEqual({
      version: null,
      commit: null,
      previousVersion: null,
      firstBootOfVersion: null,
    });
    expect(runner.runStreamed).not.toHaveBeenCalled();
  });

  it("reads the stamp file when the bin did not pass one (bootCount 1 = first boot of that version)", () => {
    const { sync, store } = createReportingHarness({
      pin: "1.0.0",
      installedVersion: "1.0.0",
      sentinelVersion: "1.0.0",
    });
    fs.mkdirSync(store.managedDir, { recursive: true });
    fs.writeFileSync(
      path.join(store.managedDir, "alphaclaw-version.json"),
      JSON.stringify({
        version: "0.9.77",
        commit: null,
        firstBootAt: 1,
        lastBootAt: 2,
        bootCount: 4,
        previous: { version: "0.9.75", commit: "f00", lastBootAt: 0 },
      }),
    );
    sync.syncAtBoot();
    expect(readReport(store).alphaclaw).toEqual({
      version: "0.9.77",
      commit: null,
      previousVersion: "0.9.75",
      firstBootOfVersion: false,
    });
  });

  it("a run left `running` by a dead process is closed by the bin phase and NAMED in bootSync.danglingRecords (#76 A7 — the server phase's closer finds nothing left, so this is the list the report must carry)", () => {
    const { sync, store } = createReportingHarness({
      pin: "1.0.0",
      installedVersion: "1.0.0",
      sentinelVersion: "1.0.0",
    });
    const danglingRunId = "0f76b007-e2e0-4c0d-9a1e-000000000076";
    const runsDir = path.join(store.managedDir, "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    // openclaw-run-ledger.js record shape: `running`, no finishedAt.
    fs.writeFileSync(
      path.join(runsDir, `${danglingRunId}.json`),
      JSON.stringify({
        operationId: danglingRunId,
        target: { version: "1.0.0", channel: "stable", kind: "apply" },
        state: "running",
        startedAt: 900_000,
        finishedAt: null,
        ok: null,
        result: null,
        steps: [{ name: "download", status: "running", at: 900_000 }],
        backup: null,
        dbPreflight: null,
        overseer: null,
        hasLog: false,
      }),
    );

    const result = sync.syncAtBoot();

    expect(result).toEqual(expect.objectContaining({ ok: true, action: "none" }));
    expect(readReport(store).openclaw.bootSync.danglingRecords).toEqual({
      closedRuns: [danglingRunId],
      closedLastUpdateRun: false,
    });
    const run = JSON.parse(fs.readFileSync(path.join(runsDir, `${danglingRunId}.json`), "utf8"));
    expect(run.state).toBe("interrupted");
    expect(run.ok).toBe(false);
    expect(run.result?.code).toBe("interrupted");
    // Idempotent: a second closer pass (what the server phase does) closes
    // nothing more — which is exactly why the report must carry THIS list.
    expect(sync.closeDanglingRecordsAtBoot()).toEqual(
      expect.objectContaining({ closedRuns: [], closedLastUpdateRun: false }),
    );
  });

  it("v0.9.81 (C3): a dangling `kind: backup` run (AlphaClaw died mid-backup) is closed `interrupted` at boot and the boot still proceeds to a normal pin sync", () => {
    const { sync, store } = createReportingHarness({
      pin: "1.0.0",
      channel: "stable",
      installedVersion: "1.0.0",
    });
    const danglingRunId = "0f76b007-e2e0-4c0d-9a1e-000000000081";
    const runsDir = path.join(store.managedDir, "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(
      path.join(runsDir, `${danglingRunId}.json`),
      JSON.stringify({
        operationId: danglingRunId,
        target: { kind: "backup" },
        state: "running",
        startedAt: 900_000,
        finishedAt: null,
        ok: null,
        result: null,
        steps: [{ name: "backup", status: "running", at: 900_000 }],
        backup: null,
        dbPreflight: null,
        overseer: null,
        hasLog: false,
      }),
    );

    const result = sync.syncAtBoot();

    expect(result).toEqual(expect.objectContaining({ ok: true, action: "none" }));
    expect(readReport(store).openclaw.bootSync.danglingRecords).toEqual({
      closedRuns: [danglingRunId],
      closedLastUpdateRun: false,
    });
    const run = JSON.parse(fs.readFileSync(path.join(runsDir, `${danglingRunId}.json`), "utf8"));
    expect(run.state).toBe("interrupted");
    expect(run.ok).toBe(false);
    expect(run.result?.code).toBe("interrupted");
    expect(run.target).toEqual({ kind: "backup" });
    // lastUpdateRun was never written by the backup — nothing to close there.
    expect(store.readState().lastUpdateRun ?? null).toBeNull();
  });

  it("the CORROBORATED skipped_concurrent path (bin refuses to start) writes boot-report-refused.json — serverPhase not_reached/pidfile_skip — and leaves the live sibling's boot-report.json and ring untouched", async () => {
    const { spawn } = require("child_process");
    const { sync, store, installDir } = createReportingHarness({
      pin: "1.0.0",
      channel: "beta",
      installedVersion: "1.0.0",
    });
    store.updateState((s) => {
      s.pinVersion = "1.0.0";
      s.applied = { channel: "beta", version: "1.1.0", at: 1, acceptedAt: 2 };
      return s;
    });
    saveOverlayFixture(store, "1.1.0");
    // The live sibling's COMPLETED report at slot 0 and one rotated predecessor.
    fs.mkdirSync(store.managedDir, { recursive: true });
    const liveReport = JSON.stringify({ schema: kBootReportSchema, bootId: "1:1", serverPhase: { status: "recorded", verdict: [] } });
    const rotatedReport = JSON.stringify({ schema: kBootReportSchema, bootId: "0:1", serverPhase: { status: "recorded", verdict: [] } });
    fs.writeFileSync(path.join(store.managedDir, "boot-report.json"), liveReport);
    fs.writeFileSync(path.join(store.managedDir, "boot-report.1.json"), rotatedReport);
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
      expect(skipped.action).toBe("skipped_concurrent");
      expect(skipped.corroborated).toBe(true);

      // No rotation, no slot-0 write: three refused starts could otherwise
      // empty the ring of every report a live server ever completed.
      expect(fs.readFileSync(path.join(store.managedDir, "boot-report.json"), "utf8")).toBe(liveReport);
      expect(fs.readFileSync(path.join(store.managedDir, "boot-report.1.json"), "utf8")).toBe(rotatedReport);
      expect(fs.existsSync(path.join(store.managedDir, "boot-report.2.json"))).toBe(false);
      const report = readRefusedReport(store);
      expect(report.bootId).toBe(kBootId);
      expect(report.pidfile).toEqual(
        expect.objectContaining({ decision: "skip", reason: "corroborated", pid: child.pid }),
      );
      // The decision record is persisted AS-IS (raw pidfile included: pid,
      // host, ticks — no secrets).
      expect(report.pidfile.record.raw).toEqual(expect.objectContaining({ pid: child.pid }));
      expect(report.openclaw).toEqual(
        expect.objectContaining({
          channelApplied: "beta:1.1.0",
          expected: "1.1.0",
          // Nothing activated behind the claim: both reads see the pin tree,
          // and the running tree IS diverged from the applied build.
          installedAtBoot: "1.0.0",
          resolvedForLaunch: "1.0.0",
          installedDiverged: true,
          overlayPresent: true,
          overlayComplete: true,
          sentinelMatches: false,
          bootSync: {
            action: "skipped_concurrent",
            reason: "live_server_corroborated",
            warnings: [
              expect.stringMatching(
                /installed openclaw 1\.0\.0 ≠ applied 1\.1\.0 with a complete overlay/,
              ),
            ],
            // A skipped boot never runs the dangling-record closer (it must not
            // close a live sibling's run), so the report says null — not [].
            danglingRecords: null,
          },
        }),
      );
      // The process exits right after the sync: the server phase is closed
      // here, with the verdict over the bin half (never pidfile_contradiction).
      expect(report.serverPhase).toEqual({
        status: "not_reached",
        reason: kPidfileSkipReason,
        at: expect.any(Number),
        verdict: ["installed_not_expected"],
      });
      // The skip path still never writes state.lastBoot (a live sibling may
      // be writing the state file) — the report is the only new file.
      expect(store.readState().lastBoot).toBeNull();
      expect(store.readInstalledVersion({ installDir })).toBe("1.0.0");
    } finally {
      child.kill("SIGKILL");
    }
    await new Promise((resolve) => child.once("exit", resolve));
  });

  it.skipIf(!hasProc)("an UNVERIFIED skipped_concurrent (legacy claim, live lookalike) boots on, so its report takes slot 0 with serverPhase pending — the server phase or pidfile_contradiction is still to come", async () => {
    const { spawn } = require("child_process");
    const { sync, store } = createReportingHarness({
      pin: "1.0.0",
      installedVersion: "1.0.0",
      sentinelVersion: "1.0.0",
    });
    // A lookalike carrying the server verb: the legacy argv path trusts it,
    // UNverified (no start time to corroborate).
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "--", "alphaclaw.js", "start"], {
      stdio: "ignore",
    });
    try {
      fs.mkdirSync(store.managedDir, { recursive: true });
      fs.writeFileSync(store.serverPidPath, JSON.stringify({ pid: child.pid, at: 1 }));
      const skipped = sync.syncAtBoot();
      expect(skipped.action).toBe("skipped_concurrent");
      expect(skipped.corroborated).toBe(false);
      const report = readReport(store);
      expect(report.bootId).toBe(kBootId);
      expect(report.serverPhase).toEqual({ status: "pending" });
      expect(report.openclaw.bootSync).toEqual(
        expect.objectContaining({ action: "skipped_concurrent", reason: "live_server_unverified" }),
      );
      expect(fs.existsSync(path.join(store.managedDir, "boot-report-refused.json"))).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
    await new Promise((resolve) => child.once("exit", resolve));
  });

  it("a pin-lag boot (AlphaClaw self-update, npm not yet reconciled) records installedDiverged false — the same excuse getChannelInfo gives — so the boot-report verdict stays empty", async () => {
    const { sync, store } = createReportingHarness({
      pin: "1.0.1",
      channel: "stable",
      installedVersion: "1.0.0",
      sentinelVersion: "1.0.0",
    });
    store.updateState((s) => {
      s.pinVersion = "1.0.0";
      return s;
    });
    const boot = sync.syncAtBoot();
    await flushAsync();
    expect(boot.action).toBe("pin_reconciled");
    expect(store.readState().pinLag).toEqual(expect.objectContaining({ pin: "1.0.1", installed: "1.0.0" }));
    const report = readReport(store);
    expect(report.openclaw).toEqual(
      expect.objectContaining({
        expected: "1.0.1",
        installedAtBoot: "1.0.0",
        resolvedForLaunch: "1.0.0",
        installedDiverged: false,
      }),
    );
    expect(sync.getChannelInfo().installedDiverged).toBe(report.openclaw.installedDiverged);
    expect(computeVerdict({ ...report, serverPhase: { status: "recorded", installedVersion: "1.0.0" } })).toEqual([]);
  });

  it("the failed path writes the report with the error as the reason", () => {
    const { sync, store } = createReportingHarness({
      pin: "1.0.0",
      installedVersion: "1.0.0",
      sentinelVersion: "1.0.0",
      // The shim validation blows up → the inner catch returns "failed".
      storeWrap: (store) => ({
        ...store,
        validateBinShim: () => {
          throw new Error("shim exploded");
        },
      }),
    });
    const result = sync.syncAtBoot();
    expect(result).toEqual(
      expect.objectContaining({ ok: false, action: "failed", error: "shim exploded" }),
    );
    expect(readReport(store).openclaw.bootSync).toEqual({
      action: "failed",
      reason: "shim exploded",
      warnings: ["shim exploded"],
      // The closer runs BEFORE the shim check, so even a failed boot reports it.
      danglingRecords: { closedRuns: [], closedLastUpdateRun: false },
    });
    expect(readReport(store).pidfile).toEqual(expect.objectContaining({ decision: "proceed" }));
  });

  it("a throwing writer never changes the outcome (one log line); no writer → no file", () => {
    const logs = [];
    const exploding = createHarness({
      pin: "1.0.0",
      installedVersion: "1.0.0",
      sentinelVersion: "1.0.0",
      extraSyncOptions: {
        logger: { log: (m) => logs.push(String(m)), warn() {}, error() {} },
        bootReport: {
          bootId: kBootId,
          writeBinPhase: () => {
            throw new Error("disk full");
          },
        },
      },
    });
    expect(exploding.sync.syncAtBoot()).toEqual(
      expect.objectContaining({ ok: true, action: "none" }),
    );
    expect(
      logs.filter((line) => line.includes("boot report not written (disk full)")),
    ).toHaveLength(1);
    expect(fs.existsSync(path.join(exploding.store.managedDir, "boot-report.json"))).toBe(false);

    // Default (no writer): server-side instances and the other harnesses
    // write nothing.
    const plain = createHarness({ pin: "1.0.0", installedVersion: "1.0.0", sentinelVersion: "1.0.0" });
    expect(plain.sync.syncAtBoot().ok).toBe(true);
    expect(fs.existsSync(path.join(plain.store.managedDir, "boot-report.json"))).toBe(false);
  });
});

describe("getChannelInfo installed-tree predicates (#76 RC4 / Stage 1d)", () => {
  // getChannelInfo is the single owner of expectedVersion / installedIsPin /
  // installedDiverged: values it already reads, on the injected clock.
  const infoFor = ({ installedVersion, pin = "1.0.0", mutate = (s) => s, now }) => {
    const harness = createHarness({
      pin,
      installedVersion,
      sentinelVersion: installedVersion,
    });
    harness.store.updateState((s) => {
      s.pinVersion = pin;
      return mutate(s) || s;
    });
    if (now !== undefined) harness.nowRef.now = now;
    return { info: harness.sync.getChannelInfo(), harness };
  };
  const liveLag = (harness, extra = {}) => ({
    pin: "1.0.1",
    installed: "1.0.0",
    at: harness.nowRef.now,
    bootId: "1:1",
    bootsSeen: 1,
    ...extra,
  });

  it("truth table: applied / pin / dev / pinLag / expired pinLag", () => {
    const rows = [
      [
        "pin only, installed IS the pin",
        { installedVersion: "1.0.0" },
        { expectedVersion: "1.0.0", expectedKind: "pin", installedIsPin: true, installedDiverged: false, pinLag: null },
      ],
      [
        "pin only, installed is something else (no lag recorded)",
        { installedVersion: "1.0.5" },
        { expectedVersion: "1.0.0", expectedKind: "pin", installedIsPin: false, installedDiverged: true },
      ],
      [
        "applied package matches installed",
        {
          installedVersion: "2.0.0",
          mutate: (s) => {
            s.applied = { channel: "beta", version: "2.0.0", at: 1, acceptedAt: null };
          },
        },
        { expectedVersion: "2.0.0", expectedKind: "applied", installedIsPin: false, installedDiverged: false },
      ],
      [
        "applied recorded but the pin is what is installed (the #76 shape)",
        {
          installedVersion: "1.0.0",
          mutate: (s) => {
            s.applied = { channel: "beta", version: "2.0.0", at: 1, acceptedAt: null };
          },
        },
        { expectedVersion: "2.0.0", expectedKind: "applied", installedIsPin: true, installedDiverged: true },
      ],
      [
        "dev apply: no expected version, never the pin, never diverged",
        {
          installedVersion: "1.0.0",
          mutate: (s) => {
            s.applied = { channel: "dev", sha: kDevSha, at: 1, acceptedAt: null };
          },
        },
        { expectedVersion: null, expectedKind: "dev", installedIsPin: false, installedDiverged: false },
      ],
      [
        "no pin and no apply: nothing is expected",
        {
          installedVersion: "1.0.0",
          mutate: (s) => {
            s.pinVersion = null;
          },
        },
        { expectedVersion: null, expectedKind: null, installedIsPin: false, installedDiverged: false },
      ],
    ];
    for (const [label, setup, expected] of rows) {
      expect(infoFor(setup).info, label).toEqual(expect.objectContaining(expected));
    }
  });

  it("a live pinLag excuses exactly the lagging (pin, installed) pair; it stops excusing after 24 h or 3 boots on the injected clock", () => {
    const lagging = ({ mutateLag = (lag) => lag, advanceMs = 0 } = {}) => {
      const harness = createHarness({
        pin: "1.0.1",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      harness.store.updateState((s) => {
        s.pinVersion = "1.0.1";
        s.pinLag = mutateLag(liveLag(harness));
        return s;
      });
      harness.nowRef.now += advanceMs;
      return harness.sync.getChannelInfo();
    };
    expect(lagging()).toEqual(
      expect.objectContaining({
        expectedVersion: "1.0.1",
        expectedKind: "pin",
        installedIsPin: false,
        installedDiverged: false,
        pinLag: expect.objectContaining({ pin: "1.0.1", installed: "1.0.0", bootsSeen: 1 }),
      }),
    );
    expect(lagging({ advanceMs: kPinLagMaxAgeMs }).installedDiverged).toBe(false);
    expect(lagging({ advanceMs: kPinLagMaxAgeMs + 1 }).installedDiverged).toBe(true);
    expect(
      lagging({ mutateLag: (lag) => ({ ...lag, bootsSeen: kPinLagMaxBoots }) }).installedDiverged,
    ).toBe(false);
    expect(
      lagging({ mutateLag: (lag) => ({ ...lag, bootsSeen: kPinLagMaxBoots + 1 }) }).installedDiverged,
    ).toBe(true);
    expect(
      lagging({ mutateLag: (lag) => ({ ...lag, installed: "0.9.0" }) }).installedDiverged,
    ).toBe(true);
  });

  describe("syncAtBoot pin-lag bookkeeping (Codex D12)", () => {
    const laggingBump = () => {
      const harness = createHarness({
        pin: "1.0.1",
        channel: "stable",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      harness.store.updateState((s) => {
        s.pinVersion = "1.0.0";
        return s;
      });
      return harness;
    };

    it("the pin_reconciled lag boot records pinLag with this process's bootId; later lagging boots count; the record dies after kPinLagMaxBoots boots", async () => {
      const { sync, store, nowRef } = laggingBump();
      const boot = sync.syncAtBoot();
      await flushAsync();
      expect(boot.action).toBe("pin_reconciled");
      expect(boot.warnings.some((w) => w.includes("lags the new pin 1.0.1"))).toBe(true);
      expect(store.readState().pinLag).toEqual({
        pin: "1.0.1",
        installed: "1.0.0",
        at: nowRef.now,
        bootId: getProcessBootId(),
        bootsSeen: 1,
      });
      expect(sync.getChannelInfo()).toEqual(
        expect.objectContaining({ installedDiverged: false, installedIsPin: false }),
      );

      // Boots 2..kPinLagMaxBoots still lag: each counts once, the excuse holds.
      for (let boot = 2; boot <= kPinLagMaxBoots; boot += 1) {
        nowRef.now += 60_000;
        expect(sync.syncAtBoot().ok).toBe(true);
        await flushAsync();
        expect(store.readState().pinLag).toEqual(
          expect.objectContaining({ pin: "1.0.1", installed: "1.0.0", bootsSeen: boot }),
        );
        expect(sync.getChannelInfo().installedDiverged).toBe(false);
      }
      // One boot too many: the record is dropped and divergence is visible.
      nowRef.now += 60_000;
      expect(sync.syncAtBoot().ok).toBe(true);
      await flushAsync();
      expect(store.readState().pinLag).toBeNull();
      expect(sync.getChannelInfo().installedDiverged).toBe(true);
    });

    it("a lag older than 24 h is dropped at the next boot", async () => {
      const { sync, store, nowRef } = laggingBump();
      expect(sync.syncAtBoot().action).toBe("pin_reconciled");
      await flushAsync();
      nowRef.now += kPinLagMaxAgeMs + 1;
      expect(sync.getChannelInfo().installedDiverged).toBe(true);
      expect(sync.syncAtBoot().ok).toBe(true);
      await flushAsync();
      expect(store.readState().pinLag).toBeNull();
    });

    it("the lag clears the moment the installed tree is the pin", async () => {
      const { sync, store, installDir, nowRef } = laggingBump();
      expect(sync.syncAtBoot().action).toBe("pin_reconciled");
      await flushAsync();
      expect(store.readState().pinLag).not.toBeNull();

      writeInstallFixture(installDir, { version: "1.0.1" });
      store.writeSentinel({ installDir, version: "1.0.1" });
      nowRef.now += 60_000;
      expect(sync.syncAtBoot().ok).toBe(true);
      await flushAsync();
      expect(store.readState().pinLag).toBeNull();
      expect(sync.getChannelInfo()).toEqual(
        expect.objectContaining({
          installedVersion: "1.0.1",
          installedIsPin: true,
          installedDiverged: false,
          pinLag: null,
        }),
      );
    });
  });

  describe("requestChannelRollback judges the installed tree", () => {
    it("refuses installed_diverged before blocklisting when the applied build is not what runs; the recorded build survives", () => {
      const { sync, store, notify } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = { channel: "beta", version: "2.0.0", at: 1, acceptedAt: null };
        return s;
      });
      const result = sync.requestChannelRollback({ reason: "crash_loop", exitCode: 1 });
      expect(result).toEqual(
        expect.objectContaining({
          ok: false,
          code: "installed_diverged",
          installedVersion: "1.0.0",
          expectedVersion: "2.0.0",
        }),
      );
      expect(result.message).toBe(
        "The crashing build (1.0.0) is not the recorded applied build (2.0.0) — refusing to blocklist a build that was not running.",
      );
      expect(store.readState().blocklist).toHaveLength(0);
      expect(store.readMarker()).toBeNull();
      expect(store.readState().applied.version).toBe("2.0.0");
      expect(notify).not.toHaveBeenCalled();
    });

    it("a dev apply still rolls back (its pin tree is the dormant fallback, not divergence)", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const { sync, store } = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = { channel: "dev", sha: kDevSha, at: 1, acceptedAt: null };
        return s;
      });
      expect(sync.getChannelInfo()).toEqual(
        expect.objectContaining({ expectedKind: "dev", installedDiverged: false }),
      );
      const result = sync.requestChannelRollback({ reason: "crash_loop", exitCode: 1 });
      expect(result.ok).toBe(true);
      expect(store.isBlocklisted(kDevSha)).toBe(true);
    });

    it("a pin-window rollback with a tampered tree is refused as installed_diverged, naming the pinned build", () => {
      const { sync, store, nowRef } = createHarness({
        pin: "1.0.1",
        installedVersion: "0.9.9",
        sentinelVersion: "0.9.9",
      });
      store.updateState((s) => {
        s.pinVersion = "1.0.1";
        s.previousPin = { version: "1.0.0", at: 1 };
        s.pinWindow = {
          version: "1.0.1",
          openedAt: nowRef.now,
          acceptedAt: null,
          acceptedSource: null,
        };
        return s;
      });
      expect(saveOverlayFixture(store, "1.0.0")).toEqual({ ok: true });
      const result = sync.requestChannelRollback({ reason: "crash_loop", exitCode: 1 });
      expect(result).toEqual(
        expect.objectContaining({ ok: false, code: "installed_diverged" }),
      );
      expect(result.message).toContain("recorded pinned build (1.0.1)");
      expect(store.isBlocklisted("1.0.1")).toBe(false);
      expect(store.readMarker()).toBeNull();
    });
  });

  describe("requestForwardRecovery judges the installed tree", () => {
    const withCandidate = (options) => {
      const harness = createHarness({
        pin: "1.0.0",
        ...options,
      });
      harness.store.updateState((s) => {
        s.pinVersion = "1.0.0";
        return s;
      });
      expect(saveOverlayFixture(harness.store, "3.0.0")).toEqual({ ok: true });
      harness.store.addBlocklist({ id: "3.0.0", reason: "config_error", exitCode: 78 });
      return harness;
    };

    it("moves forward when the pin is installed even though a recorded apply never activated", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const insertEvent = vi.fn();
      const { sync, store } = withCandidate({
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        extraSyncOptions: { insertEvent },
      });
      store.updateState((s) => {
        s.applied = { channel: "beta", version: "2.0.0", at: 1, acceptedAt: null };
        return s;
      });
      const result = sync.requestForwardRecovery({ exitCode: 78, installedVersion: "1.0.0" });
      expect(result.ok).toBe(true);
      expect(store.readMarker()).toEqual(
        expect.objectContaining({
          reason: "forward_recovery",
          target: expect.objectContaining({ version: "3.0.0" }),
        }),
      );
      expect(store.readState().forwardRecovery.attemptedId).toBe("3.0.0");
      // The audit event carries BOTH views of the tree (#76 RC4): the
      // authoritative read the gate used and the caller's observation.
      expect(insertEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "forward_recovery",
          status: "requested",
          details: expect.objectContaining({
            reason: "forward_recovery",
            exitCode: 78,
            target: expect.objectContaining({ version: "3.0.0" }),
            installedVersion: "1.0.0",
            observedInstalledVersion: "1.0.0",
          }),
        }),
      );
    });

    it("records the caller's stale view beside the authoritative read, and gates on the read (#76 RC4)", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const insertEvent = vi.fn();
      const { sync, store } = withCandidate({
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        extraSyncOptions: { insertEvent },
      });
      // The watchdog's view lags (it cached the tree before an activation);
      // the gate re-reads the installed tree itself and still moves forward.
      const result = sync.requestForwardRecovery({ exitCode: 78, installedVersion: "0.9.9" });
      expect(result.ok).toBe(true);
      expect(store.readState().forwardRecovery.attemptedId).toBe("3.0.0");
      const requested = insertEvent.mock.calls
        .map((call) => call[0])
        .find((event) => event.eventType === "forward_recovery" && event.status === "requested");
      expect(requested.details).toEqual(
        expect.objectContaining({
          installedVersion: "1.0.0",
          observedInstalledVersion: "0.9.9",
        }),
      );
      // No caller view at all is recorded as null, never dropped.
      const silentInsertEvent = vi.fn();
      const silent = withCandidate({
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        extraSyncOptions: { insertEvent: silentInsertEvent },
      });
      expect(silent.sync.requestForwardRecovery({ exitCode: 78 }).ok).toBe(true);
      expect(silentInsertEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "forward_recovery",
          status: "requested",
          details: expect.objectContaining({
            installedVersion: "1.0.0",
            observedInstalledVersion: null,
          }),
        }),
      );
    });

    it("refuses not_pin for a dev apply, and for a pin that is recorded but not installed", () => {
      const dev = withCandidate({
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      dev.store.updateState((s) => {
        s.applied = { channel: "dev", sha: kDevSha, at: 1, acceptedAt: null };
        return s;
      });
      expect(dev.sync.requestForwardRecovery({ exitCode: 78 })).toEqual(
        expect.objectContaining({ ok: false, code: "not_pin" }),
      );
      expect(dev.store.readMarker()).toBeNull();
      expect(dev.store.isBlocklisted("3.0.0")).toBe(true);

      const lagging = withCandidate({
        installedVersion: "0.9.9",
        sentinelVersion: "0.9.9",
      });
      const result = lagging.sync.requestForwardRecovery({ exitCode: 78 });
      expect(result).toEqual(expect.objectContaining({ ok: false, code: "not_pin" }));
      expect(result.message).toContain("installed 0.9.9, pin 1.0.0");
      expect(lagging.store.readMarker()).toBeNull();
      expect(lagging.store.isBlocklisted("3.0.0")).toBe(true);
    });
  });
});

// ── Installed-tree reconcile (#76 B1.2 / B1.4 / B1.5 / C6) ───────────────────
describe("reconcileInstalled (#76 B1.2)", () => {
  const { beginStateDbQuiet } = require("../../lib/server/state-db-quiet");
  const kReconcileLease = require("../../lib/server/constants").kOpenclawReconcileLifecycleLeaseMs;

  // A lifecycle-lock double with the real release() contract (callable,
  // isValid()/isExpired() accessors) so the re-entrancy and lease-fence rules
  // can be pinned without the real lock.
  const makeLock = () => {
    const acquires = [];
    const releases = [];
    const acquireLifecycleLock = vi.fn(async (kind, options) => {
      acquires.push({ kind, options });
      let valid = true;
      const release = Object.assign(
        vi.fn(() => {
          valid = false;
        }),
        { kind, isValid: () => valid, isExpired: () => false },
      );
      releases.push(release);
      return release;
    });
    return { acquires, releases, acquireLifecycleLock };
  };
  const makeHold = ({ valid = true } = {}) =>
    Object.assign(vi.fn(), {
      kind: "structural_repair",
      isValid: () => valid,
      isExpired: () => !valid,
    });
  // Like the real seam, a confirmed stop flips isRunning() to false; a stop
  // that fails (stopped: false) leaves the gateway reported running.
  const makeQuiesce = ({ running = true, stopped = true } = {}) => {
    let live = running;
    return {
      isRunning: vi.fn(async () => live),
      stop: vi.fn(async () => {
        if (stopped) live = false;
        return stopped;
      }),
      suppress: vi.fn(),
      unsuppress: vi.fn(),
      acquireLock: vi.fn(),
      start: vi.fn(),
    };
  };
  const saveOverlayWithSchema = (store, version, schema) =>
    store.saveOverlayFromTempInstall({
      openclawPackageDir: writePackageFixture(
        path.join(mkTemp("alphaclaw-overlay-src-"), "openclaw"),
        { version, schema },
      ),
      version,
    });

  // Installed 1.0.0 (the pin) with a recorded, overlay-complete beta 2.0.0 —
  // the #76 shape: installedDiverged is true, nothing has activated.
  const divergedHarness = ({
    expected = "2.0.0",
    installed = "1.0.0",
    overlay = true,
    schema = null,
    extra = {},
  } = {}) => {
    const lock = makeLock();
    const insertEvent = vi.fn();
    const harness = createHarness({
      pin: "1.0.0",
      installedVersion: installed,
      sentinelVersion: installed,
      extraSyncOptions: {
        insertEvent,
        acquireLifecycleLock: lock.acquireLifecycleLock,
        // Hermetic: never scan this box's /proc for the exclusivity sample,
        // and never wait the 5 s settle in a test.
        backupProbes: { listProcesses: () => [] },
        backupTuning: { exclusivitySettleMs: 0 },
        ...extra,
      },
    });
    harness.store.updateState((s) => {
      s.pinVersion = "1.0.0";
      s.applied = { channel: "beta", version: expected, at: 1, acceptedAt: null };
      return s;
    });
    if (overlay) {
      expect(saveOverlayWithSchema(harness.store, expected, schema)).toEqual({ ok: true });
    }
    return { ...harness, lock, insertEvent };
  };
  const installedVersionOf = (installDir) =>
    JSON.parse(
      fs.readFileSync(path.join(installDir, "node_modules", "openclaw", "package.json"), "utf8"),
    ).version;
  const eventsOf = (insertEvent, type) =>
    insertEvent.mock.calls.map((call) => call[0]).filter((event) => event.eventType === type);
  const stepNames = (run) => run.steps.map((step) => `${step.name}:${step.status}`);

  afterEach(() => {
    delete process.env.OPENCLAW_RUNTIME_RECONCILE;
  });

  it("happy path: confirmed stop → activate (sentinel last) → verify; run steps, hold clearing, cache invalidation, event + notification", async () => {
    const quiesce = makeQuiesce();
    const h = divergedHarness({ extra: { gatewayQuiesce: quiesce } });
    // A structural hold this path owns (set by the boot config gate).
    h.store.updateState((s) => {
      s.gatewayHold = {
        reason: "version_mismatch",
        at: 5,
        blamedKeys: [],
        detail: "held",
        installed: "1.0.0",
        expected: "2.0.0",
        bootId: "boot-x",
      };
      return s;
    });
    expect(h.sync.getChannelInfo().installedDiverged).toBe(true);

    const result = await h.sync.reconcileInstalled({ source: "operator", relaunch: true });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        action: "activated",
        from: "1.0.0",
        to: "2.0.0",
        schemaRecovery: false,
      }),
    );
    expect(typeof result.runId).toBe("string");
    // The tree flipped and the sentinel names the new build (written LAST).
    expect(installedVersionOf(h.installDir)).toBe("2.0.0");
    expect(h.store.readSentinel({ installDir: h.installDir })).toEqual(
      expect.objectContaining({ version: "2.0.0" }),
    );
    expect(h.sync.getChannelInfo().installedDiverged).toBe(false);
    // Its own lock (no hold passed), the reconcile lease, released after.
    expect(h.lock.acquires).toEqual([
      { kind: "reconcile_installed", options: { leaseMs: kReconcileLease } },
    ]);
    expect(h.lock.releases[0]).toHaveBeenCalledTimes(1);
    // Stop was confirmed through the quiesce seam with the watchdog suppressed.
    expect(quiesce.stop).toHaveBeenCalledTimes(1);
    expect(quiesce.suppress).toHaveBeenCalledTimes(1);
    expect(quiesce.unsuppress).toHaveBeenCalledTimes(1);
    // The ledger run: target kind reconcile, steps stop → activate → verify,
    // left `running` for the CALLER's relaunch step (Codex 7).
    const run = h.sync.runLedger.listRuns().find((r) => r.operationId === result.runId);
    expect(run.target).toEqual({ kind: "reconcile", version: "2.0.0", from: "1.0.0" });
    expect(run.state).toBe("running");
    expect(stepNames(run)).toEqual([
      "stop:running",
      "stop:completed",
      "activate:running",
      "activate:completed",
      "verify:running",
      "verify:completed",
    ]);
    // Only the structural hold this path owns was cleared.
    expect(h.store.readState().gatewayHold).toBeNull();
    // The apply record-step invalidation hook ran.
    expect(h.clearVersionCache).toHaveBeenCalledTimes(1);
    expect(eventsOf(h.insertEvent, "reconcile_installed")).toEqual([
      expect.objectContaining({
        status: "activated",
        details: expect.objectContaining({
          source: "operator",
          from: "1.0.0",
          to: "2.0.0",
          relaunch: true,
          operationId: result.runId,
        }),
      }),
    ]);
    await flushAsync();
    expect(notifyMessages(h.notify).some((m) => m.includes("re-activated OpenClaw 2.0.0"))).toBe(true);

    // The caller books the relaunch and completes the run.
    h.sync.completeReconcileRun({
      runId: result.runId,
      relaunch: { ok: true, verdict: "replacement_ready" },
    });
    const completed = h.sync.runLedger.listRuns().find((r) => r.operationId === result.runId);
    expect(completed.state).toBe("activated");
    expect(completed.ok).toBe(true);
    expect(stepNames(completed).slice(-1)).toEqual(["relaunch:completed"]);
    // A relaunch that did not verify is an honest failure, not a silent success.
    const again = await h.sync.reconcileInstalled({ source: "test" });
    expect(again).toEqual(expect.objectContaining({ ok: true, action: "none", runId: null }));
  });

  it("a passed hold is used as-is: never re-acquired, never released here (lock re-entrancy, Codex 1)", async () => {
    const h = divergedHarness();
    const hold = makeHold();
    const result = await h.sync.reconcileInstalled({ hold, source: "structural_repair" });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("activated");
    expect(h.lock.acquireLifecycleLock).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
    expect(installedVersionOf(h.installDir)).toBe("2.0.0");
  });

  it("an expired hold refuses lease_expired before anything is touched", async () => {
    const h = divergedHarness();
    const result = await h.sync.reconcileInstalled({ hold: makeHold({ valid: false }) });
    expect(result).toEqual(expect.objectContaining({ ok: false, code: "lease_expired", action: "none" }));
    expect(installedVersionOf(h.installDir)).toBe("1.0.0");
    expect(h.sync.runLedger.listRuns()).toEqual([]);
  });

  it("nothing to do: installed === expected with a matching sentinel is action none, no lock, no run", async () => {
    const h = divergedHarness({ expected: "1.0.0", overlay: false });
    const result = await h.sync.reconcileInstalled();
    expect(result).toEqual({ ok: true, action: "none", from: "1.0.0", to: "1.0.0", runId: null });
    expect(h.lock.acquireLifecycleLock).not.toHaveBeenCalled();
  });

  it("refusal codes: disabled (kill switch), overlay_missing, dev_channel, gateway_held (migration-class only), state_corrupted, state_db_quiet", async () => {
    process.env.OPENCLAW_RUNTIME_RECONCILE = "off";
    const off = divergedHarness();
    expect(await off.sync.reconcileInstalled()).toEqual(
      expect.objectContaining({ ok: false, code: "disabled", action: "none" }),
    );
    expect(eventsOf(off.insertEvent, "reconcile_installed")).toEqual([
      expect.objectContaining({ status: "skipped", details: expect.objectContaining({ code: "disabled" }) }),
    ]);
    // The switch is a RUNTIME lever (README: "boot-time activation is
    // unaffected"): the boot C1 belt — source "boot", under the boot lock —
    // is exempt, so a diverged box with the switch set still boots the
    // recorded build instead of being held. Any other source is refused.
    const boot = divergedHarness();
    expect(await boot.sync.reconcileInstalled({ source: "boot", relaunch: false })).toEqual(
      expect.objectContaining({ ok: true, action: "activated", from: "1.0.0", to: "2.0.0" }),
    );
    expect(installedVersionOf(boot.installDir)).toBe("2.0.0");
    const structuralOff = divergedHarness();
    expect(await structuralOff.sync.reconcileInstalled({ source: "repair/structural" })).toEqual(
      expect.objectContaining({ ok: false, code: "disabled", action: "none" }),
    );
    expect(installedVersionOf(structuralOff.installDir)).toBe("1.0.0");
    delete process.env.OPENCLAW_RUNTIME_RECONCILE;

    const missing = divergedHarness({ overlay: false });
    expect(await missing.sync.reconcileInstalled()).toEqual(
      expect.objectContaining({ ok: false, code: "overlay_missing", expected: "2.0.0", installed: "1.0.0" }),
    );

    const dev = divergedHarness();
    dev.store.updateState((s) => {
      s.applied = { channel: "dev", sha: kDevSha, at: 1, acceptedAt: null };
      return s;
    });
    expect(await dev.sync.reconcileInstalled()).toEqual(
      expect.objectContaining({ ok: false, code: "dev_channel" }),
    );

    // A MIGRATION-class hold refuses; a structural one does not (it is what
    // this path clears).
    const held = divergedHarness();
    held.store.updateState((s) => {
      s.gatewayHold = { reason: "settings migration for 2.0.0 failed: doctor exited 1", at: 1, blamedKeys: ["x"] };
      return s;
    });
    expect(await held.sync.reconcileInstalled()).toEqual(
      expect.objectContaining({ ok: false, code: "gateway_held" }),
    );
    expect(installedVersionOf(held.installDir)).toBe("1.0.0");
    expect(held.store.readState().gatewayHold?.reason).toContain("doctor exited 1");
    const structural = divergedHarness();
    structural.store.updateState((s) => {
      s.gatewayHold = { reason: "activation_failed", at: 1, blamedKeys: [], error: "ENOSPC" };
      return s;
    });
    expect((await structural.sync.reconcileInstalled()).action).toBe("activated");
    expect(structural.store.readState().gatewayHold).toBeNull();

    const corrupt = divergedHarness();
    fs.writeFileSync(corrupt.store.statePath, "{ not json");
    expect(await corrupt.sync.reconcileInstalled()).toEqual(
      expect.objectContaining({ ok: false, code: "state_corrupted" }),
    );

    const quiet = divergedHarness();
    const barrier = await beginStateDbQuiet({ owner: "reconcile-test", maxMs: 30_000 });
    try {
      expect(await quiet.sync.reconcileInstalled()).toEqual(
        expect.objectContaining({ ok: false, code: "state_db_quiet" }),
      );
    } finally {
      barrier.release();
    }
    expect(installedVersionOf(quiet.installDir)).toBe("1.0.0");
  });

  it("refuses incumbent_running when a serving identity or a live openclaw process survives the stop — nothing is changed", async () => {
    const serving = divergedHarness({
      extra: {
        gatewayQuiesce: makeQuiesce(),
        discoverServingIdentity: () => ({ rootPid: 4242, workerPid: 4243, pids: [4242, 4243] }),
      },
    });
    const result = await serving.sync.reconcileInstalled({ source: "operator" });
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        code: "incumbent_running",
        incumbent: { kind: "serving_identity", pids: [4242, 4243] },
      }),
    );
    expect(installedVersionOf(serving.installDir)).toBe("1.0.0");
    expect(serving.store.readSentinel({ installDir: serving.installDir })).toEqual(
      expect.objectContaining({ version: "1.0.0" }),
    );
    const run = serving.sync.runLedger.listRuns()[0];
    expect(run.state).toBe("failed");
    expect(stepNames(run)).toEqual(["stop:running", "stop:failed"]);
    expect(run.result).toEqual(expect.objectContaining({ code: "incumbent_running" }));
    await flushAsync();
    expect(notifyMessages(serving.notify).some((m) => m.includes("still running"))).toBe(true);

    const live = divergedHarness({
      extra: { backupProbes: { listProcesses: () => [{ pid: 77, cmdline: "openclaw gateway run" }] } },
    });
    expect(await live.sync.reconcileInstalled()).toEqual(
      expect.objectContaining({
        ok: false,
        code: "incumbent_running",
        incumbent: { kind: "live_processes", pids: [77] },
      }),
    );
    // A stop the quiesce seam could not confirm is an incumbent too.
    const unstopped = divergedHarness({
      extra: { gatewayQuiesce: makeQuiesce({ running: true, stopped: false }) },
    });
    expect((await unstopped.sync.reconcileInstalled()).code).toBe("incumbent_running");
    expect(installedVersionOf(unstopped.installDir)).toBe("1.0.0");
  });

  it("refuses insufficient_disk from the injected probe (1.2 × overlay bytes, beside node_modules) before any rm", async () => {
    const diskSpace = vi.fn(() => ({ ok: false, free: 1024 }));
    const h = divergedHarness({ extra: { diskSpace } });
    const result = await h.sync.reconcileInstalled();
    expect(result).toEqual(expect.objectContaining({ ok: false, code: "insufficient_disk", freeBytes: 1024 }));
    expect(diskSpace).toHaveBeenCalledTimes(1);
    const [required, dir] = diskSpace.mock.calls[0];
    expect(dir).toBe(path.join(h.installDir, "node_modules"));
    expect(required).toBe(result.requiredBytes);
    // 1.2 × the overlay's bytes, rounded up (the fixture is a handful of files).
    const overlayDir = h.store.overlayPackageDir("2.0.0");
    const bytes = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
        const full = path.join(dir, entry.name);
        return sum + (entry.isDirectory() ? bytes(full) : fs.statSync(full).size);
      }, 0);
    expect(required).toBe(Math.ceil(bytes(overlayDir) * 1.2));
    expect(installedVersionOf(h.installDir)).toBe("1.0.0");
    expect(h.sync.runLedger.listRuns()[0].state).toBe("failed");
  });

  it("target compatibility FIRST: an expected build whose declared schema is below the live user_version is skipped for the newest compatible overlay (schema_recovery)", async () => {
    const h = divergedHarness({ schema: { state: 15, agent: 19 } });
    writeStateDb(h.openclawDir, { userVersion: 17 });
    expect(saveOverlayWithSchema(h.store, "3.0.0", { state: 17, agent: 19 })).toEqual({ ok: true });
    // Blocklisted overlays are never candidates.
    expect(saveOverlayWithSchema(h.store, "4.0.0", { state: 17, agent: 19 })).toEqual({ ok: true });
    h.store.addBlocklist({ id: "4.0.0", reason: "crash_loop", exitCode: 1 });

    const result = await h.sync.reconcileInstalled({ source: "structural_repair" });

    expect(result).toEqual(
      expect.objectContaining({ ok: true, action: "activated", to: "3.0.0", expected: "2.0.0", schemaRecovery: true }),
    );
    expect(installedVersionOf(h.installDir)).toBe("3.0.0");
    const state = h.store.readState();
    expect(state.applied).toEqual(
      expect.objectContaining({ channel: "stable", version: "3.0.0", reason: "schema_recovery", operationId: result.runId }),
    );
    expect(eventsOf(h.insertEvent, "reconcile_installed").map((e) => e.status)).toEqual([
      "target_incompatible",
      "activated",
    ]);
    expect(eventsOf(h.insertEvent, "reconcile_installed")[0].details.reasons).toEqual(["database_schema_newer_than_target"]);
    const run = h.sync.runLedger.listRuns().find((r) => r.operationId === result.runId);
    expect(run.target).toEqual(
      expect.objectContaining({ kind: "reconcile", version: "3.0.0", expected: "2.0.0", schemaRecovery: true }),
    );
  });

  it("target incompatible and nothing else bootable → no_bootable_version, tree untouched", async () => {
    const h = divergedHarness({ schema: { state: 15, agent: 19 } });
    writeStateDb(h.openclawDir, { userVersion: 17 });
    const result = await h.sync.reconcileInstalled();
    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: "no_bootable_version", reasons: ["database_schema_newer_than_target"] }),
    );
    expect(installedVersionOf(h.installDir)).toBe("1.0.0");
    expect(h.sync.runLedger.listRuns()[0]).toEqual(
      expect.objectContaining({ state: "failed", result: expect.objectContaining({ code: "no_bootable_version" }) }),
    );
  });

  // Stage 3 I3 (#76 B1.1 rung 3): `recover: true` — the watchdog's structural
  // repair on a NON-diverged tree that cannot read the databases.
  const recoverHarness = ({ installedSchema = { state: 15, agent: 19 }, userVersion = 15 } = {}) => {
    const lock = makeLock();
    const insertEvent = vi.fn();
    const harness = createHarness({
      pin: "1.0.0",
      installedVersion: "1.0.0",
      sentinelVersion: "1.0.0",
      extraSyncOptions: {
        insertEvent,
        acquireLifecycleLock: lock.acquireLifecycleLock,
        backupProbes: { listProcesses: () => [] },
        backupTuning: { exclusivitySettleMs: 0 },
      },
    });
    // The pin is recorded in state (syncAtBoot's job on a real box); the
    // installed pin declares its schema; the live DB is ahead of it.
    harness.store.updateState((s) => {
      s.pinVersion = "1.0.0";
      s.applied = null;
      return s;
    });
    writeSchemaContractFixture(path.join(harness.installDir, "node_modules", "openclaw"), installedSchema);
    writeStateDb(harness.openclawDir, { userVersion });
    return { ...harness, lock, insertEvent };
  };

  it("recover: a compatible non-diverged tree is left alone and unknown compatibility refuses without activation; without recover it is plain none", async () => {
    const h = recoverHarness({ installedSchema: { state: 17, agent: 19 }, userVersion: 17 });
    expect(h.sync.getChannelInfo().installedDiverged).toBe(false);
    expect(await h.sync.reconcileInstalled({ source: "structural_repair" })).toEqual(
      expect.objectContaining({ ok: true, action: "none", from: "1.0.0", to: "1.0.0", runId: null }),
    );
    const result = await h.sync.reconcileInstalled({ source: "structural_repair", recover: true });
    expect(result).toEqual(
      expect.objectContaining({ ok: true, action: "none", reason: "target_compatible", runId: null }),
    );
    expect(installedVersionOf(h.installDir)).toBe("1.0.0");
    expect(h.lock.acquireLifecycleLock).not.toHaveBeenCalled(); // decided before the lock
    expect(eventsOf(h.insertEvent, "reconcile_installed").at(-1)).toEqual(
      expect.objectContaining({ status: "skipped", details: expect.objectContaining({ code: "target_compatible", recover: true }) }),
    );
    const unknown = recoverHarness({ installedSchema: {}, userVersion: 17 });
    expect(await unknown.sync.reconcileInstalled({ recover: true })).toEqual(
      expect.objectContaining({ ok: false, action: "none", code: "db_preflight_failed" }),
    );
    expect(installedVersionOf(unknown.installDir)).toBe("1.0.0");
    expect(unknown.store.readState().applied).toBeNull();
    expect(unknown.runner.runStreamed).not.toHaveBeenCalled();
    expect(unknown.installToTempDir).not.toHaveBeenCalled();
    expect(unknown.lock.acquireLifecycleLock).not.toHaveBeenCalled();
  });

  it("recover: a non-diverged pin whose declared schema is below the live user_version activates the newest compatible overlay as schema_recovery under the caller's hold (no own acquire), records applied.reason and completes the run's stop → activate → verify", async () => {
    const h = recoverHarness({ installedSchema: { state: 15, agent: 19 }, userVersion: 17 });
    expect(saveOverlayWithSchema(h.store, "3.0.0", { state: 17, agent: 19 })).toEqual({ ok: true });
    const hold = makeHold();
    const result = await h.sync.reconcileInstalled({ hold, source: "structural_repair", relaunch: true, recover: true });
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        action: "activated",
        from: "1.0.0",
        to: "3.0.0",
        expected: "1.0.0",
        schemaRecovery: true,
      }),
    );
    expect(installedVersionOf(h.installDir)).toBe("3.0.0");
    expect(h.lock.acquireLifecycleLock).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
    expect(h.store.readState().applied).toEqual(
      expect.objectContaining({ version: "3.0.0", reason: "schema_recovery", operationId: result.runId }),
    );
    expect(eventsOf(h.insertEvent, "reconcile_installed").map((e) => e.status)).toEqual([
      "target_incompatible",
      "activated",
    ]);
    const run = h.sync.runLedger.listRuns().find((r) => r.operationId === result.runId);
    expect(run.state).toBe("running"); // the caller books the relaunch (Codex 7)
    expect(stepNames(run)).toEqual([
      "stop:running",
      "stop:completed",
      "activate:running",
      "activate:completed",
      "verify:running",
      "verify:completed",
    ]);
    // Nothing else bootable: the refusal names it and the tree is untouched.
    const stuck = recoverHarness({ installedSchema: { state: 15, agent: 19 }, userVersion: 17 });
    expect(await stuck.sync.reconcileInstalled({ recover: true })).toEqual(
      expect.objectContaining({ ok: false, code: "no_bootable_version" }),
    );
    expect(installedVersionOf(stuck.installDir)).toBe("1.0.0");
  });

  it("a failure AFTER the rm writes no sentinel, sets an activation_failed hold carrying the error, notifies, and tries the chooser once", async () => {
    // Fail the swap for 2.0.0 only (delegating everything else to the real
    // store) after gutting the live tree the way a real swap failure leaves it.
    const failSwapFor = (version) => (store) => ({
      ...store,
      activateOverlayAsync: async (args) => {
        if (args.version !== version) return store.activateOverlayAsync(args);
        fs.rmSync(store.sentinelPath({ installDir: args.installDir }), { force: true });
        fs.rmSync(path.join(args.installDir, "node_modules", "openclaw"), { recursive: true, force: true });
        return { ok: false, stage: "swap", error: "ENOSPC: no space left on device, rename" };
      },
    });
    const gutted = divergedHarness({ extra: { storeWrap: failSwapFor("2.0.0") } });
    // createHarness applies storeWrap itself; re-create through the option.
    const lock = makeLock();
    const insertEvent = vi.fn();
    const h = createHarness({
      pin: "1.0.0",
      installedVersion: "1.0.0",
      sentinelVersion: "1.0.0",
      storeWrap: failSwapFor("2.0.0"),
      extraSyncOptions: {
        insertEvent,
        acquireLifecycleLock: lock.acquireLifecycleLock,
        backupProbes: { listProcesses: () => [] },
        backupTuning: { exclusivitySettleMs: 0 },
      },
    });
    void gutted;
    h.store.updateState((s) => {
      s.pinVersion = "1.0.0";
      s.applied = { channel: "beta", version: "2.0.0", at: 1, acceptedAt: null };
      return s;
    });
    expect(saveOverlayFixture(h.store, "2.0.0")).toEqual({ ok: true });

    const result = await h.sync.reconcileInstalled({ source: "operator" });
    expect(result).toEqual(expect.objectContaining({ ok: false, code: "activation_failed", stage: "swap" }));
    expect(fs.existsSync(h.store.sentinelPath({ installDir: h.installDir }))).toBe(false);
    expect(h.store.readState().gatewayHold).toEqual(
      expect.objectContaining({
        reason: "activation_failed",
        error: "ENOSPC: no space left on device, rename",
        expected: "2.0.0",
        installed: "1.0.0",
      }),
    );
    expect(h.watchdogLatch).toHaveBeenCalled();
    await flushAsync();
    expect(notifyMessages(h.notify).some((m) => m.includes("HELD"))).toBe(true);
    const run = h.sync.runLedger.listRuns()[0];
    expect(run.state).toBe("activation_failed");
    expect(stepNames(run)).toEqual(["stop:running", "stop:completed", "activate:running", "activate:failed"]);

    // With another local build that can read the DBs, the chooser retry
    // activates it and the hold this path set is cleared again.
    const rescued = createHarness({
      pin: "1.0.0",
      installedVersion: "1.0.0",
      sentinelVersion: "1.0.0",
      storeWrap: failSwapFor("2.0.0"),
      extraSyncOptions: {
        acquireLifecycleLock: makeLock().acquireLifecycleLock,
        backupProbes: { listProcesses: () => [] },
        backupTuning: { exclusivitySettleMs: 0 },
      },
    });
    rescued.store.updateState((s) => {
      s.pinVersion = "1.0.0";
      s.applied = { channel: "beta", version: "2.0.0", at: 1, acceptedAt: null };
      return s;
    });
    expect(saveOverlayFixture(rescued.store, "2.0.0")).toEqual({ ok: true });
    expect(saveOverlayFixture(rescued.store, "1.5.0")).toEqual({ ok: true });
    const second = await rescued.sync.reconcileInstalled();
    expect(second).toEqual(expect.objectContaining({ ok: true, action: "activated", to: "1.5.0", schemaRecovery: true }));
    expect(installedVersionOf(rescued.installDir)).toBe("1.5.0");
    expect(rescued.store.readState().gatewayHold).toBeNull();
    expect(rescued.store.readSentinel({ installDir: rescued.installDir })).toEqual(
      expect.objectContaining({ version: "1.5.0" }),
    );
  });

  it("a pre-rm failure (verify stage) leaves the live tree intact with no hold", async () => {
    const h = createHarness({
      pin: "1.0.0",
      installedVersion: "1.0.0",
      sentinelVersion: "1.0.0",
      storeWrap: (store) => ({
        ...store,
        activateOverlayAsync: async () => ({ ok: false, stage: "verify", error: "staged bin missing" }),
      }),
      extraSyncOptions: {
        acquireLifecycleLock: makeLock().acquireLifecycleLock,
        backupProbes: { listProcesses: () => [] },
        backupTuning: { exclusivitySettleMs: 0 },
      },
    });
    h.store.updateState((s) => {
      s.pinVersion = "1.0.0";
      s.applied = { channel: "beta", version: "2.0.0", at: 1, acceptedAt: null };
      return s;
    });
    expect(saveOverlayFixture(h.store, "2.0.0")).toEqual({ ok: true });
    const result = await h.sync.reconcileInstalled();
    expect(result).toEqual(expect.objectContaining({ ok: false, code: "activation_failed", stage: "verify" }));
    expect(installedVersionOf(h.installDir)).toBe("1.0.0");
    expect(h.store.readState().gatewayHold).toBeNull();
    expect(h.store.readSentinel({ installDir: h.installDir })).toEqual(expect.objectContaining({ version: "1.0.0" }));
  });

  describe("which binary (#76 C6 / Codex 8)", () => {
    // Route a `node <bin> backup ...` spawn to the stub's `openclaw backup`
    // model so the archive contract stays faithful while the command is pinned.
    const binAwareRunner = (seen) => (opts, fallback) => {
      if (opts.command === process.execPath && opts.args?.[1] === "backup") {
        seen.push(opts);
        return fallback({ ...opts, command: "openclaw", args: opts.args.slice(1) });
      }
      if (opts.command === "openclaw" && opts.args?.[0] === "backup") seen.push(opts);
      return fallback(opts);
    };

    it("a diverged tree checkpoints the executing build identity without invoking either backup CLI", async () => {
      const seen = [];
      const lock = require("../../lib/server/gateway-lifecycle-lock").createGatewayLifecycleLock({ logger: kSilentLogger });
      const h = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        installFixture: { schema: { state: 15, agent: 19 } },
        runnerImpl: binAwareRunner(seen),
        extraSyncOptions: {
          acquireLifecycleLock: lock.acquire,
          gatewayMutationPolicy: require("../../lib/server/gateway-mutation-policy").createGatewayMutationPolicy({
            lock, getChannelInfo: () => h.sync.getChannelInfo(), isApplyInProgress: () => h.sync.isApplyInProgress(),
          }),
          backupProbes: { listProcesses: () => [] },
          backupTuning: { exclusivitySettleMs: 0 },
        },
      });
      h.store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = { channel: "beta", version: "2.0.0", at: 1, acceptedAt: null };
        return s;
      });
      expect(saveOverlayWithSchema(h.store, "2.0.0", { state: 15, agent: 19 })).toEqual({ ok: true });
      writeStateDb(h.openclawDir, { userVersion: 15 });
      // Read before the apply: recording the new target prunes the 2.0.0 overlay.
      const expectedBin = h.store.resolvePackageBin(h.store.overlayPackageDir("2.0.0"));
      expect(expectedBin).toBeTruthy();
      expect(h.sync.resolveExpectedBin()).toBe(expectedBin);
      const result = await h.sync.applyUpdate({ channel: "beta", version: "1.1.0-beta.1" });
      expect(seen).toEqual([]);
      expect(result.status, JSON.stringify(result.body)).toBe(202);
      expect(result.body.recovery).toMatchObject({ kind: "config_only", checkpoint: { verified: true }, databases: { complete: false } });
      expect(result.body.recovery.checkpoint.sourceBuild.buildId).toBe("1.0.0");
      expect(result.body.recovery.checkpoint.targetBuild.buildId).toBe("1.1.0-beta.1");
    });

    it("both cross-channel and same-channel applies refuse a target older than the live schemas without a backup fallback", async () => {
      const seen = [];
      const mk = (extra = {}) => {
        const h = createHarness({
          pin: "1.0.0",
          installedVersion: "1.0.0",
          sentinelVersion: "1.0.0",
          installFixture: { schema: { state: 15, agent: 19 } },
          runnerImpl: binAwareRunner(seen),
          extraSyncOptions: extra,
        });
        // Both trees declare a schema below the live user_version.
        writeSchemaContractFixture(path.join(h.installDir, "node_modules", "openclaw"), {
          state: 15,
          agent: 19,
        });
        h.store.updateState((s) => {
          s.pinVersion = "1.0.0";
          s.applied = { channel: "beta", version: "2.0.0", at: 1, acceptedAt: null };
          return s;
        });
        expect(saveOverlayWithSchema(h.store, "2.0.0", { state: 15, agent: 19 })).toEqual({ ok: true });
        writeStateDb(h.openclawDir, { userVersion: 17 });
        return h;
      };
      const hard = mk();
      const refused = await hard.sync.applyUpdate({ channel: "beta", version: "1.1.0-beta.1" });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.body).toEqual(expect.objectContaining({ ok: false, code: "db_preflight_failed" }));
      expect(refused.body.preflight.reasons).toContain("database_schema_newer_than_target");
      expect(seen.length).toBe(0);
      expect(hard.store.readState().lastUpdateRun.steps).toContainEqual(
        expect.objectContaining({ name: "db-preflight", status: "failed" }),
      );

      const soft = mk();
      // Same channel as the applied beta record — beta→stable would cross the boundary (#79 (a)).
      const warned = await soft.sync.applyUpdate({ channel: "beta", version: "2.0.1" });
      expect(warned.status).toBe(409);
      expect(warned.body.code).toBe("db_preflight_failed");
      expect(warned.body.preflight.reasons).toContain("database_schema_newer_than_target");
      expect(soft.store.readState().lastUpdateRun.steps).toContainEqual(
        expect.objectContaining({ name: "db-preflight", status: "failed" }),
      );
      expect(seen.length).toBe(0);
      for (const harness of [hard, soft]) {
        expect(harness.gatewayQuiesce.stop).not.toHaveBeenCalled();
        expect(harness.restartProcess).not.toHaveBeenCalled();
        expect(harness.store.readState().applied.version).toBe("2.0.0");
      }
    });

    it("resolveExpectedBin names the recorded build's overlay bin while the tree diverges, null for dev or no overlay", () => {
      const h = divergedHarness();
      expect(h.sync.resolveExpectedBin()).toBe(
        h.store.resolvePackageBin(h.store.overlayPackageDir("2.0.0")),
      );
      const missing = divergedHarness({ overlay: false });
      expect(missing.sync.resolveExpectedBin()).toBeNull();
      const dev = divergedHarness();
      dev.store.updateState((s) => {
        s.applied = { channel: "dev", sha: kDevSha, at: 1, acceptedAt: null };
        return s;
      });
      expect(dev.sync.resolveExpectedBin()).toBeNull();
      // The pin's own complete tree IS the expected bin when nothing is applied.
      const pinned = divergedHarness({ expected: "1.0.0", overlay: false });
      expect(pinned.sync.resolveExpectedBin()).toBe(
        h.store.resolvePackageBin(path.join(pinned.installDir, "node_modules", "openclaw")),
      );
    });

    it("compatibleBinForCurrentDb prefers the expected bin, falls back to the installed tree when the expected build cannot read the DBs, and is null when neither can", async () => {
      const preferred = divergedHarness({ schema: { state: 17, agent: 19 } });
      writeStateDb(preferred.openclawDir, { userVersion: 17 });
      expect(await preferred.sync.compatibleBinForCurrentDb()).toEqual(
        expect.objectContaining({ version: "2.0.0", source: "overlay", compatible: true }),
      );

      const fallback = divergedHarness({ schema: { state: 15, agent: 19 } });
      writeStateDb(fallback.openclawDir, { userVersion: 17 });
      writeSchemaContractFixture(path.join(fallback.installDir, "node_modules", "openclaw"), { state: 17, agent: 19 });
      expect(await fallback.sync.compatibleBinForCurrentDb()).toEqual(
        expect.objectContaining({ version: "1.0.0", source: "installed", compatible: true }),
      );

      const neither = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
      });
      // The INSTALLED tree declares a schema too old for the DB as well.
      writeSchemaContractFixture(path.join(neither.installDir, "node_modules", "openclaw"), {
        state: 15,
        agent: 19,
      });
      neither.store.updateState((s) => {
        s.pinVersion = "1.0.0";
        s.applied = { channel: "beta", version: "2.0.0", at: 1, acceptedAt: null };
        return s;
      });
      expect(saveOverlayWithSchema(neither.store, "2.0.0", { state: 15, agent: 19 })).toEqual({ ok: true });
      writeStateDb(neither.openclawDir, { userVersion: 17 });
      expect(await neither.sync.compatibleBinForCurrentDb()).toBeNull();
    });
  });

  describe("undoLastConfigRestore (#76 B1.5)", () => {
    const bootId = getProcessBootId();
    const managedDir = (h) => h.store.managedDir;
    const withRestore = (h, { restoreBootId = bootId, verdict = ["installed_not_expected"], report = true } = {}) => {
      const configPath = path.join(h.openclawDir, "openclaw.json");
      const preRestorePath = path.join(h.openclawDir, "openclaw.json.pre-restore-500.bak");
      fs.mkdirSync(h.openclawDir, { recursive: true });
      fs.writeFileSync(configPath, '{"live":true}\n');
      fs.writeFileSync(preRestorePath, '{"preRestore":true}\n');
      h.store.updateState((s) => {
        s.configMigration = {
          completedForVersion: "2.0.0",
          lastAttempt: { version: "2.0.0", at: 1, ok: true, error: null },
          lastRestore: {
            at: 500,
            from: "openclaw.json.pre-fix-1.0.0.bak",
            previousCompletedForVersion: "1.0.0",
            diffPath: null,
            preRestorePath,
            bootId: restoreBootId,
            source: "crash_rollback",
          },
        };
        return s;
      });
      if (report) {
        fs.mkdirSync(managedDir(h), { recursive: true });
        fs.writeFileSync(
          path.join(managedDir(h), "boot-report.json"),
          `${JSON.stringify({ bootId, serverPhase: { verdict } })}\n`,
        );
      }
      return { configPath, preRestorePath };
    };

    it("undoes a restore THIS inconsistent boot performed: byte copy back, completedForVersion reset, record cleared, event + notification", async () => {
      const insertEvent = vi.fn();
      const h = createHarness({ pin: "1.0.0", installedVersion: "1.0.0", extraSyncOptions: { insertEvent } });
      const { configPath, preRestorePath } = withRestore(h);
      const result = h.sync.undoLastConfigRestore({ bootId });
      expect(result).toEqual(
        expect.objectContaining({ ok: true, restoredFrom: preRestorePath, completedForVersion: "1.0.0" }),
      );
      expect(fs.readFileSync(configPath, "utf8")).toBe('{"preRestore":true}\n');
      const migration = h.store.readState().configMigration;
      expect(migration.completedForVersion).toBe("1.0.0");
      expect(migration.lastRestore).toBeNull();
      expect(migration.lastAttempt).toEqual(expect.objectContaining({ version: "2.0.0", ok: true }));
      expect(insertEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "config_migration_gate",
          status: "restore_undone",
          details: expect.objectContaining({ bootId, completedForVersion: "1.0.0" }),
        }),
      );
      await flushAsync();
      expect(notifyMessages(h.notify).some((m) => m.includes("was undone"))).toBe(true);
    });

    it("declines for a consistent boot, a foreign boot, a missing record, and a missing pre-restore copy; an explicit inconsistent=true skips the report", () => {
      const consistent = createHarness({ pin: "1.0.0", installedVersion: "1.0.0" });
      const { configPath } = withRestore(consistent, { verdict: [] });
      expect(consistent.sync.undoLastConfigRestore({ bootId })).toEqual(
        expect.objectContaining({ ok: false, code: "boot_consistent" }),
      );
      expect(fs.readFileSync(configPath, "utf8")).toBe('{"live":true}\n');

      const foreign = createHarness({ pin: "1.0.0", installedVersion: "1.0.0" });
      withRestore(foreign, { restoreBootId: "999:1" });
      expect(foreign.sync.undoLastConfigRestore({ bootId })).toEqual(
        expect.objectContaining({ ok: false, code: "foreign_boot", restoreBootId: "999:1" }),
      );

      const none = createHarness({ pin: "1.0.0", installedVersion: "1.0.0" });
      expect(none.sync.undoLastConfigRestore({ bootId })).toEqual({ ok: false, code: "no_restore" });

      const gone = createHarness({ pin: "1.0.0", installedVersion: "1.0.0" });
      const files = withRestore(gone);
      fs.rmSync(files.preRestorePath);
      expect(gone.sync.undoLastConfigRestore({ bootId })).toEqual(
        expect.objectContaining({ ok: false, code: "pre_restore_missing" }),
      );

      // No report on disk, but the caller (structural repair) already holds
      // the verdict.
      const told = createHarness({ pin: "1.0.0", installedVersion: "1.0.0" });
      const toldFiles = withRestore(told, { report: false });
      expect(told.sync.undoLastConfigRestore({ bootId })).toEqual(
        expect.objectContaining({ ok: false, code: "boot_consistent" }),
      );
      expect(told.sync.undoLastConfigRestore({ bootId, inconsistent: true }).ok).toBe(true);
      expect(fs.readFileSync(toldFiles.configPath, "utf8")).toBe('{"preRestore":true}\n');
    });
  });

  describe("requestForwardRecoveryAsync — schema-driven second path (#76 B1.4)", () => {
    const pinHarness = () => {
      const insertEvent = vi.fn();
      const h = createHarness({
        pin: "1.0.0",
        installedVersion: "1.0.0",
        sentinelVersion: "1.0.0",
        extraSyncOptions: { insertEvent },
      });
      h.store.updateState((s) => {
        s.pinVersion = "1.0.0";
        return s;
      });
      return { ...h, insertEvent };
    };

    it("moves forward to the newest complete overlay whose declared schema can read the migrated state, without a blocklist entry", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const h = pinHarness();
      writeStateDb(h.openclawDir, { userVersion: 15 });
      expect(saveOverlayWithSchema(h.store, "2.0.0", { state: 12, agent: 19 })).toEqual({ ok: true });
      expect(saveOverlayWithSchema(h.store, "3.0.0", { state: 15, agent: 19 })).toEqual({ ok: true });
      const result = await h.sync.requestForwardRecoveryAsync({ exitCode: 78, installedVersion: "1.0.0" });
      expect(result).toEqual({ ok: true, target: { kind: "package", channel: "stable", version: "3.0.0" } });
      expect(h.store.readMarker()).toEqual(
        expect.objectContaining({ reason: "forward_recovery", target: expect.objectContaining({ version: "3.0.0" }) }),
      );
      expect(h.store.readState().forwardRecovery).toEqual(
        expect.objectContaining({ attemptedId: "3.0.0", clearedEntry: null, selection: "schema" }),
      );
      expect(h.insertEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "forward_recovery",
          status: "requested",
          details: expect.objectContaining({ selection: "schema", installedVersion: "1.0.0" }),
        }),
      );
      // Second cycle latches exactly like the blocklist path.
      const again = await h.sync.requestForwardRecoveryAsync({ exitCode: 78 });
      expect(again).toEqual(expect.objectContaining({ ok: false, code: "forward_already_attempted" }));
      expect(h.store.readState().noBootableVersion).toEqual(expect.objectContaining({ attemptedId: "3.0.0" }));
    });

    it("prefers the blocklist path when it qualifies, and reports no_forward_candidate when no overlay can read the state", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const blocklisted = pinHarness();
      expect(saveOverlayFixture(blocklisted.store, "2.5.0")).toEqual({ ok: true });
      blocklisted.store.addBlocklist({ id: "2.5.0", reason: "config_error", exitCode: 78 });
      const first = await blocklisted.sync.requestForwardRecoveryAsync({ exitCode: 78 });
      expect(first.ok).toBe(true);
      expect(blocklisted.store.readState().forwardRecovery).toEqual(
        expect.objectContaining({ attemptedId: "2.5.0", selection: "blocklist" }),
      );
      expect(blocklisted.store.isBlocklisted("2.5.0")).toBe(false);

      const none = pinHarness();
      writeStateDb(none.openclawDir, { userVersion: 15 });
      expect(saveOverlayWithSchema(none.store, "2.0.0", { state: 12, agent: 19 })).toEqual({ ok: true });
      expect(await none.sync.requestForwardRecoveryAsync({ exitCode: 78 })).toEqual(
        expect.objectContaining({ ok: false, code: "no_forward_candidate" }),
      );
      expect(none.store.readMarker()).toBeNull();
      // The sync entry point is unchanged for the watchdog's inline call.
      expect(none.sync.requestForwardRecovery({ exitCode: 78 })).toEqual(
        expect.objectContaining({ ok: false, code: "no_forward_candidate" }),
      );
    });
  });
});
