// Revert-safety of the on-disk state files touched by #54 (lanes A/B/I), both
// ways:
//   forward  — files written by PRE-change code (none of the new fields) load
//              under the current normalizers with defaults, never a throw;
//   backward — files written WITH the new fields (backup.reused / diagnosis /
//              usableCheck / offlineCopy, applied.operationId, outbox
//              abandonedAt-terminal / partialAt / errorCode) load under the
//              current normalizers with every field intact, and — because the
//              new fields live either in additive normalized slots or inside
//              opaque pass-through objects (lastUpdateRun, backups[], run
//              record `backup`) — an older normalizer would drop at most
//              applied.operationId (which has a documented fallback id).
// Fixtures are literal JSON on real temp dirs: exactly what a box has.
//
// Issue #76 C5 extends this to the boot spine's persisted formats: the
// describes at the bottom plant the literal files under
// tests/server/fixtures/persisted-formats/<file>/<era>.json (README.md there
// has the provenance of every era) and feed each through the CURRENT reader.
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createOpenclawReleaseChannelStore,
  formatServerPidDecision,
  normalizeState,
} = require("../../lib/server/openclaw-release-channel");
const { createRunLedger } = require("../../lib/server/openclaw-run-ledger");
const { createNotifyOutbox } = require("../../lib/server/notify-outbox");
const { createRestartRequiredState } = require("../../lib/server/restart-required-state");
const { kRestartOperationRetentionMs } = require("../../lib/server/constants");
const { createGatewayStateTracker } = require("../../lib/server/gateway-state");
const {
  kBootReportFileName,
  kBootVerdicts,
  createBootReportWriter,
  computeVerdict,
  describeReportVersions,
  normalizeVerdict,
} = require("../../lib/server/boot-report");
const {
  kSelfVersionFileName,
  readSelfVersionStamp,
  stampSelfVersionAtBoot,
} = require("../../lib/server/alphaclaw-self-version");
const {
  kSchemaVersionsFileName,
  kSeededSchemaVersions,
  createSchemaVersionTable,
} = require("../../lib/server/openclaw-schema-versions");

const kSilentLogger = { log() {}, warn() {}, error() {} };
const mkTemp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

const kOperationId = "2f8c1f2e-0d2a-4b1e-9a11-6f2f8c1f2e0d";

// A lane-A backup record as channel-sync persists it on the run + channel state.
const kNewBackupRecord = {
  ok: true,
  file: "/data/.openclaw/backups/openclaw-backup-1000-2f8c1f2e.alphaclaw.tar.gz",
  sha256: "a".repeat(64),
  bytes: 4096,
  reused: true,
  attempts: 2,
  quiesced: true,
  diagnosis: {
    journalMode: "wal",
    fsType: "ext4",
    stateBytes: 40_960,
    dbCount: 2,
    otherProcesses: [],
    predictedUpstreamMs: 1800,
  },
  usableCheck: { ok: true, gzip: "ok", manifest: "ok", checkedAt: 1_700_000_000_000 },
  offlineCopy: {
    ok: true,
    reason: "lock_contention",
    durationMs: 1200,
    bytes: 4096,
    partial: false,
  },
};

describe("state-file compat: openclaw-channel-state.json", () => {
  const createStore = () => {
    const rootDir = mkTemp("alphaclaw-compat-channel-");
    const openclawDir = path.join(rootDir, ".openclaw");
    const store = createOpenclawReleaseChannelStore({
      rootDir,
      openclawDir,
      logger: kSilentLogger,
    });
    return { store };
  };

  it("loads a file written WITH the new fields: applied.operationId survives, lastUpdateRun/backups carry the lane-A backup fields verbatim", () => {
    const { store } = createStore();
    writeJson(store.statePath, {
      applied: {
        channel: "beta",
        version: "2026.9.1-beta.1",
        sha: null,
        at: 1_700_000_000_000,
        acceptedAt: null,
        acceptedSource: null,
        operationId: kOperationId,
      },
      pinVersion: "2026.7.1-2",
      lastKnownGood: { package: "2026.7.1-2", dev: null },
      blocklist: [],
      lastUpdateRun: {
        operationId: kOperationId,
        startedAt: 1_700_000_000_000,
        finishedAt: 1_700_000_090_000,
        ok: true,
        backup: kNewBackupRecord,
      },
      lastBoot: null,
      configMigration: null,
      gatewayHold: null,
      backups: [
        {
          file: kNewBackupRecord.file,
          sha256: kNewBackupRecord.sha256,
          bytes: 4096,
          at: 1_700_000_000_000,
          operationId: kOperationId,
          reused: false,
          producer: "alphaclaw-offline-copy",
          usableCheck: kNewBackupRecord.usableCheck,
        },
      ],
    });

    const state = store.readState();
    expect(state.corrupted).toBeUndefined();
    expect(state.applied.operationId).toBe(kOperationId);
    expect(state.lastUpdateRun.backup).toEqual(kNewBackupRecord);
    expect(state.backups[0]).toMatchObject({
      reused: false,
      producer: "alphaclaw-offline-copy",
      usableCheck: kNewBackupRecord.usableCheck,
    });
    // Round trip keeps every new field on disk.
    store.writeState(state);
    const onDisk = JSON.parse(fs.readFileSync(store.statePath, "utf8"));
    expect(onDisk.applied.operationId).toBe(kOperationId);
    expect(onDisk.lastUpdateRun.backup.offlineCopy).toEqual(kNewBackupRecord.offlineCopy);
    expect(onDisk.backups[0].usableCheck).toEqual(kNewBackupRecord.usableCheck);
  });

  it("loads a PRE-change file (no operationId, no backup diagnosis/usableCheck/offlineCopy/reused) with defaults", () => {
    const { store } = createStore();
    writeJson(store.statePath, {
      applied: {
        channel: "beta",
        version: "2026.8.2",
        sha: null,
        at: 1_690_000_000_000,
        acceptedAt: 1_690_000_120_000,
        acceptedSource: "acceptance",
      },
      pinVersion: "2026.7.1-2",
      lastKnownGood: { package: "2026.8.2", dev: null },
      blocklist: [],
      lastUpdateRun: {
        operationId: "11111111-2222-4333-8444-555555555555",
        startedAt: 1_690_000_000_000,
        finishedAt: 1_690_000_060_000,
        ok: true,
        backup: { ok: true, file: "/data/.openclaw/backups/openclaw-backup-1-abcdef12.tar.gz", bytes: 10 },
      },
      lastBoot: null,
      backups: [
        { file: "/data/.openclaw/backups/openclaw-backup-1-abcdef12.tar.gz", bytes: 10, at: 1 },
      ],
    });

    const state = store.readState();
    expect(state.applied).toEqual({
      channel: "beta",
      version: "2026.8.2",
      sha: null,
      at: 1_690_000_000_000,
      acceptedAt: 1_690_000_120_000,
      acceptedSource: "acceptance",
      operationId: null,
      // Pin-window fields (PR #57) default the same way for a pre-change file.
      reason: null,
    });
    expect(state.previousPin).toBeNull();
    expect(state.pinWindow).toBeNull();
    // The consumer-side defaults channel-sync applies to an old backup record.
    const backup = state.lastUpdateRun.backup;
    expect(backup.reused === true).toBe(false);
    expect(backup.diagnosis ?? null).toBeNull();
    expect(backup.usableCheck || null).toBeNull();
    expect(backup.offlineCopy ?? null).toBeNull();
    expect(state.backups[0].usableCheck || null).toBeNull();
  });

  it("the very oldest shape ({applied, pinVersion} only) and an empty object both normalize without throwing", () => {
    expect(() =>
      normalizeState({ applied: { channel: "beta", version: "1.0.0" }, pinVersion: "0.9.0" }),
    ).not.toThrow();
    const oldest = normalizeState({ applied: { channel: "beta", version: "1.0.0" }, pinVersion: "0.9.0" });
    expect(oldest.applied.operationId).toBe(null);
    expect(oldest.lastUpdateRun).toBe(null);
    expect(oldest.backups).toEqual([]);
    expect(normalizeState({}).applied).toBe(null);
  });
});

describe("state-file compat: run records (.alphaclaw/runs/<operationId>.json)", () => {
  const createLedger = () => {
    const openclawDir = mkTemp("alphaclaw-compat-runs-");
    const ledger = createRunLedger({ openclawDir, logger: kSilentLogger });
    return { ledger, openclawDir };
  };

  it("loads a record written WITH the lane-A backup fields (reused/diagnosis/usableCheck/offlineCopy) intact and round-trips them through updateRun", () => {
    const { ledger } = createLedger();
    writeJson(path.join(ledger.runsDir, `${kOperationId}.json`), {
      operationId: kOperationId,
      target: { channel: "beta", version: "2026.9.1-beta.1" },
      state: "activated",
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_090_000,
      ok: true,
      result: { status: 202 },
      steps: [{ name: "backup", status: "done", detail: "reused a verified backup" }],
      backup: kNewBackupRecord,
      dbPreflight: { migrationRequired: false },
      overseer: null,
      hasLog: true,
    });

    const record = ledger.readRun(kOperationId);
    expect(record).not.toBeNull();
    expect(record.backup).toEqual(kNewBackupRecord);
    expect(record.backup.reused).toBe(true);
    expect(record.backup.diagnosis.journalMode).toBe("wal");
    expect(record.backup.usableCheck.ok).toBe(true);
    expect(record.backup.offlineCopy.reason).toBe("lock_contention");

    const updated = ledger.updateRun(kOperationId, (r) => {
      r.steps.push({ name: "restart", status: "done" });
      return r;
    });
    expect(updated.backup).toEqual(kNewBackupRecord);
    expect(ledger.listRuns()).toHaveLength(1);
  });

  it("loads a PRE-change record (no backup sub-fields, no dbPreflight/overseer) with defaults; unknown future top-level keys are dropped, not fatal", () => {
    const { ledger } = createLedger();
    const oldId = "11111111-2222-4333-8444-555555555555";
    writeJson(path.join(ledger.runsDir, `${oldId}.json`), {
      operationId: oldId,
      target: { channel: "beta", version: "2026.8.2" },
      state: "activated",
      startedAt: 1_690_000_000_000,
      finishedAt: 1_690_000_060_000,
      ok: true,
      steps: [],
      backup: { ok: true, file: "/data/.openclaw/backups/openclaw-backup-1-abcdef12.tar.gz" },
      someFutureField: { from: "a-later-version" },
    });
    const record = ledger.readRun(oldId);
    expect(record).toMatchObject({
      operationId: oldId,
      state: "activated",
      dbPreflight: null,
      overseer: null,
      hasLog: false,
    });
    expect(record.someFutureField).toBeUndefined();
    expect(record.backup.reused === true).toBe(false);
    expect(record.backup.diagnosis ?? null).toBeNull();
    expect(record.backup.usableCheck || null).toBeNull();
    expect(record.backup.offlineCopy ?? null).toBeNull();

    // A record with no backup at all (a noop run) still loads.
    const noopId = "22222222-2222-4333-8444-555555555555";
    writeJson(path.join(ledger.runsDir, `${noopId}.json`), {
      operationId: noopId,
      state: "noop",
      startedAt: 1,
    });
    expect(ledger.readRun(noopId)).toMatchObject({ state: "noop", backup: null, steps: [] });
    expect(ledger.listRuns().map((r) => r.operationId)).toEqual([oldId, noopId]);
  });

  it("garbage or unknown state values load defensively (unknown state → running, non-object → null)", () => {
    const { ledger } = createLedger();
    const weirdId = "33333333-2222-4333-8444-555555555555";
    writeJson(path.join(ledger.runsDir, `${weirdId}.json`), {
      operationId: weirdId,
      state: "state_from_the_future",
      backup: "not-an-object",
      steps: "nope",
    });
    expect(ledger.readRun(weirdId)).toMatchObject({ state: "running", backup: null, steps: [] });
    fs.writeFileSync(path.join(ledger.runsDir, "44444444-2222-4333-8444-555555555555.json"), "{not json");
    expect(ledger.readRun("44444444-2222-4333-8444-555555555555")).toBeNull();
    expect(() => ledger.listRuns()).not.toThrow();
  });
});

describe("state-file compat: notify-outbox.json", () => {
  const createOutbox = () => {
    const openclawDir = mkTemp("alphaclaw-compat-outbox-");
    const nowRef = { now: 1_700_000_000_000 };
    const insertEvent = vi.fn();
    const outbox = createNotifyOutbox({
      openclawDir,
      nowFn: () => nowRef.now,
      logger: kSilentLogger,
      insertEvent,
    });
    return { outbox, nowRef, insertEvent };
  };

  it("loads a file written WITH the lane-B fields (terminal abandonment, partialAt, suppressedAt, errorCode in lastError-class failures): terminal rows stay terminal, pending rows still drain", async () => {
    const { outbox, insertEvent } = createOutbox();
    writeJson(outbox.outboxPath, {
      events: [
        {
          id: "abandoned-terminal",
          eventType: "health",
          operationId: null,
          message: "every target failed deterministically",
          verbose: false,
          audit: false,
          createdAt: 1_699_999_000_000,
          attempts: 1,
          deliveredAt: null,
          lastError: "telegram: 403 Forbidden (errorCode 403, deterministic)",
          nextAttemptAt: null,
          abandonedAt: 1_699_999_000_500,
          partialAt: null,
          suppressedAt: null,
          suppressedReason: null,
        },
        {
          id: "delivered-partial",
          eventType: "recovery",
          message: "delivered on one channel",
          createdAt: 1_699_999_100_000,
          attempts: 1,
          deliveredAt: 1_699_999_100_100,
          lastError: null,
          nextAttemptAt: null,
          abandonedAt: null,
          partialAt: 1_699_999_100_100,
        },
        {
          id: "suppressed",
          eventType: "info",
          message: "quiet mode dropped me",
          verbose: true,
          createdAt: 1_699_999_200_000,
          attempts: 1,
          suppressedAt: 1_699_999_200_100,
          suppressedReason: "verbose_suppressed",
        },
        {
          id: `apply-accepted-${kOperationId}`,
          eventType: "recovery",
          operationId: kOperationId,
          message: "still pending",
          createdAt: 1_699_999_900_000,
          attempts: 0,
          deliveredAt: null,
          lastError: null,
          nextAttemptAt: null,
          abandonedAt: null,
          partialAt: null,
        },
      ],
    });

    expect(outbox.listEvents()).toHaveLength(4);
    const deliver = vi.fn(async () => ({ ok: true, sent: 1, failed: 0 }));
    const result = await outbox.flush({ deliver });
    // Only the pending row was attempted; the terminal ones were left alone.
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0].id).toBe(`apply-accepted-${kOperationId}`);
    expect(result).toMatchObject({ delivered: 1, failed: 0, abandoned: 0, suppressed: 0, partial: 0, pending: 0 });
    expect(insertEvent).not.toHaveBeenCalled();
    const after = Object.fromEntries(outbox.listEvents().map((e) => [e.id, e]));
    expect(after["abandoned-terminal"].abandonedAt).toBe(1_699_999_000_500);
    expect(after["delivered-partial"].partialAt).toBe(1_699_999_100_100);
    expect(after.suppressed.suppressedReason).toBe("verbose_suppressed");
    expect(after[`apply-accepted-${kOperationId}`].deliveredAt).toBe(1_700_000_000_000);
  });

  it("a PRE-change file (no abandonedAt/partialAt/suppressed*/nextAttemptAt) drains unchanged and a terminal verdict on such a row stamps the new fields", async () => {
    const { outbox, nowRef, insertEvent } = createOutbox();
    writeJson(outbox.outboxPath, {
      events: [
        {
          id: "old-pending",
          eventType: "health",
          message: "old-format pending alert",
          createdAt: 1_699_999_990_000,
          attempts: 2,
          deliveredAt: null,
          lastError: "api down",
        },
        {
          id: "old-delivered",
          eventType: "info",
          message: "old-format delivered",
          createdAt: 1_699_999_980_000,
          attempts: 1,
          deliveredAt: 1_699_999_980_500,
          lastError: null,
        },
      ],
    });
    // Enqueueing a new-format event alongside old rows never throws.
    expect(() =>
      outbox.enqueue({ id: "new-one", message: "fresh", eventType: "prelaunch_hook" }),
    ).not.toThrow();
    expect(outbox.listEvents()).toHaveLength(3);

    // Every failed target deterministic → immediate terminal abandonment,
    // with the errorCode-bearing failures summarized on the persisted event.
    const deliver = vi.fn(async (event) =>
      event.id === "old-pending"
        ? {
            ok: false,
            terminal: true,
            reason: "telegram: 403 Forbidden",
            failures: [
              { channel: "telegram", reason: "403 Forbidden", errorCode: 403, deterministic: true },
            ],
          }
        : { ok: true, sent: 1, failed: 1, failures: [{ channel: "slack", reason: "500", errorCode: 500 }] },
    );
    const result = await outbox.flush({ deliver });
    expect(result).toMatchObject({ delivered: 1, failed: 1, abandoned: 1, partial: 1, pending: 0 });
    const after = Object.fromEntries(outbox.listEvents().map((e) => [e.id, e]));
    expect(after["old-pending"].abandonedAt).toBe(nowRef.now);
    expect(after["old-pending"].lastError).toBe("telegram: 403 Forbidden");
    expect(after["old-delivered"].deliveredAt).toBe(1_699_999_980_500);
    expect(after["new-one"]).toMatchObject({ deliveredAt: nowRef.now, partialAt: nowRef.now });
    expect(insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "notification_abandoned",
        details: expect.objectContaining({
          id: "old-pending",
          terminal: true,
          failures: [{ channel: "telegram", reason: "403 Forbidden", errorCode: 403 }],
        }),
      }),
    );
    expect(insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "notification_partial",
        details: expect.objectContaining({
          id: "new-one",
          failures: [{ channel: "slack", reason: "500", errorCode: 500 }],
        }),
      }),
    );
  });

  it("a corrupt or missing outbox file loads as empty (never throws)", async () => {
    const { outbox } = createOutbox();
    expect(outbox.listEvents()).toEqual([]);
    fs.mkdirSync(path.dirname(outbox.outboxPath), { recursive: true });
    fs.writeFileSync(outbox.outboxPath, "{not json");
    expect(outbox.listEvents()).toEqual([]);
    expect(() => outbox.enqueue({ id: "x", message: "y" })).not.toThrow();
    expect(await outbox.flush({ deliver: async () => ({ ok: true }) })).toMatchObject({ delivered: 1 });
  });
});

// --- issue #76 C5: persisted-format fixtures ---------------------------------
// tests/server/fixtures/persisted-formats/<file>/<era>.json are the literal
// bytes each writer left on a real volume (README.md there has the provenance
// of every era and the one incident clock they share). Every fixture is
// planted VERBATIM on a temp dir and fed through the CURRENT reader.
const kFixturesDir = path.join(__dirname, "fixtures", "persisted-formats");
const fixturePath = (file, era) => path.join(kFixturesDir, file, `${era}.json`);
const fixtureText = (file, era) => fs.readFileSync(fixturePath(file, era), "utf8");
const fixtureJson = (file, era) => JSON.parse(fixtureText(file, era));
// Byte-for-byte copy: the reader sees exactly what the box has.
const plantFixture = (file, era, targetPath) => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(fixturePath(file, era), targetPath);
  return targetPath;
};
const readJsonFile = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
// The incident clock every fixture is keyed to (2026-09-06T08:00:00.000Z).
const kFixtureAt = 1_788_681_600_000;
const kFixtureHost = "srv-d3f9a1c2";
// The 0.9.77 boot the current-era fixtures name, and the 0.9.76 boot before it.
const kFixtureBootId = "7:1788681600000";
const kPreviousBootId = "7:1788681590000";
// A boot AFTER the fixtures' — the process reading them.
const kNextBootId = "8:1788681700000";
// The pid every pidfile era names — a small container pid on purpose (RC1:
// small pids are the ones that collide with threads and with the next
// container's processes).
const kFixturePid = 47;

// process.pid === 47 would make every claim read as "self"; not a real-world
// worker pid, but the guard keeps the suite honest in a tiny pid namespace.
describe.skipIf(process.pid === kFixturePid)(
  "persisted-format fixtures: alphaclaw-server.pid (legacy → v0.9.73 → v0.9.77)",
  () => {
    const kFile = "alphaclaw-server.pid";
    const kTicks = 15_532;
    const kPid1Ticks = 3431;
    const kServerCmdline = "node /app/bin/alphaclaw.js start --root-dir /data";
    // /proc/<pid>/stat as the kernel prints it (starttime is field 22) and the
    // Tgid line of /proc/<pid>/status.
    const statLine = (pid, ticks) =>
      `${pid} (node) S 1 ${pid} ${pid} 0 -1 4194304 623 1997 0 0 0 0 0 0 20 0 7 0 ${ticks} 4558848 825 18446744073709551615 0 0\n`;
    const statusText = (pid, tgid) =>
      `Name:\tnode\nUmask:\t0022\nState:\tS (sleeping)\nTgid:\t${tgid}\nNgid:\t0\nPid:\t${pid}\nPPid:\t1\n`;
    // A planted /proc over the REAL fs (the store keeps its files on the temp
    // root): procs[pid] = { tgid, ticks, cmdline } describes each live task,
    // pid1Ticks is the container's identity. Same shape as the store tests'
    // describe-local fake; inline on purpose.
    const fakeProcFs = ({ procs = {}, pid1Ticks = kPid1Ticks } = {}) =>
      new Proxy(fs, {
        get(target, prop) {
          if (prop !== "readFileSync") return Reflect.get(target, prop);
          return (file, ...rest) => {
            const text = String(file);
            if (text === "/proc/uptime") return "900.00 3600.00\n";
            if (text === "/proc/1/stat") return statLine(1, pid1Ticks);
            const match = /^\/proc\/(\d+)\/(stat|status|cmdline)$/.exec(text);
            if (!match) return target.readFileSync(file, ...rest);
            const entry = procs[match[1]];
            if (!entry) throw Object.assign(new Error(`ENOENT: ${text}`), { code: "ENOENT" });
            if (match[2] === "stat") return statLine(Number(match[1]), entry.ticks);
            if (match[2] === "status") return statusText(Number(match[1]), entry.tgid ?? Number(match[1]));
            return entry.cmdline == null ? "" : `${entry.cmdline.split(" ").join("\0")}\0`;
          };
        },
      });
    // Liveness oracle over the same table: ESRCH for an unknown pid.
    const fakeKill = (procs) => (pid) => {
      if (!procs[pid]) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    };
    // pid 47 alive as its own thread-group leader running the server verb.
    const liveServer = (overrides = {}) => ({
      [kFixturePid]: { tgid: kFixturePid, ticks: kTicks, cmdline: kServerCmdline, ...overrides },
    });
    const createStoreWithPidfile = (
      era,
      {
        procs = {},
        pid1Ticks,
        // The container was born a minute BEFORE the claim unless a case says otherwise.
        containerStartMs = kFixtureAt - 60_000,
        hostname = kFixtureHost,
        now = kFixtureAt + 45_000,
      } = {},
    ) => {
      const rootDir = mkTemp("alphaclaw-compat-pid-");
      const store = createOpenclawReleaseChannelStore({
        fsModule: fakeProcFs({ procs, pid1Ticks }),
        rootDir,
        openclawDir: path.join(rootDir, ".openclaw"),
        nowFn: () => now,
        logger: kSilentLogger,
        hostnameFn: () => hostname,
        killFn: fakeKill(procs),
        readContainerStartMs: () => containerStartMs,
      });
      plantFixture(kFile, era, store.serverPidPath);
      return store;
    };
    const readPidfile = (store) => fs.readFileSync(store.serverPidPath, "utf8");

    it("legacy {pid, at}: reads as format legacy / legacyClaim; a dead pid proceeds, a live lookalike server is a skip that can NEVER corroborate", () => {
      const dead = createStoreWithPidfile("legacy");
      const deadDecision = dead.describeServerPidDecision();
      expect(deadDecision).toEqual(
        expect.objectContaining({ decision: "proceed", reason: "dead", evidence: null, pid: kFixturePid, killOk: false }),
      );
      expect(deadDecision.record).toEqual({ raw: fixtureJson(kFile, "legacy"), format: "legacy", legacyClaim: true });
      expect(dead.readLiveServerPid()).toBeNull();

      const live = createStoreWithPidfile("legacy", { procs: liveServer() });
      const decision = live.describeServerPidDecision();
      expect(decision).toEqual(
        expect.objectContaining({
          decision: "skip",
          reason: "legacy_argv_match",
          evidence: { pid: kFixturePid, corroborated: false },
          tgid: kFixturePid,
          recordedTicks: null,
          liveTicks: kTicks,
          argvMatched: true,
          cmdline: kServerCmdline,
        }),
      );
      expect(live.readLiveServerPid()).toBe(kFixturePid);
      expect(formatServerPidDecision(decision)).toBe(
        `format=legacy pid=47 kill=ok tgid=47 self=${process.pid} ticks=–/15532 container=–/3431 → legacy_argv_match (skip)`,
      );
    });

    it("legacy → v0.9.77: convergeLegacyServerPidClaim rewrites the legacy fixture into the v0.9.77 fixture byte-for-byte (observedTicks + containerStartTicks, never startTicks) and never twice", () => {
      const store = createStoreWithPidfile("legacy", { procs: liveServer() });
      const result = store.convergeLegacyServerPidClaim(store.describeServerPidDecision());
      expect(result.converged).toBe(true);
      expect(result.record).not.toHaveProperty("startTicks");
      expect(readPidfile(store)).toBe(fixtureText(kFile, "v0.9.77"));
      // The converged record is judged on the legacy path again: still a
      // skip, still uncorroborated, and the file is not rewritten (Codex D9).
      const again = store.describeServerPidDecision();
      expect(again).toEqual(
        expect.objectContaining({ decision: "skip", reason: "legacy_argv_match", evidence: { pid: kFixturePid, corroborated: false } }),
      );
      expect(again.record).toEqual({ raw: fixtureJson(kFile, "v0.9.77"), format: 2, legacyClaim: true });
      expect(store.convergeLegacyServerPidClaim(again)).toEqual({ converged: false, reason: "already_converged" });
      expect(readPidfile(store)).toBe(fixtureText(kFile, "v0.9.77"));
    });

    it("legacy: a claim that predates this container, or whose pid is a THREAD of a live process, proceeds (#76 RC2 / RC1)", () => {
      // Container born ten minutes AFTER the claim was written.
      const older = createStoreWithPidfile("legacy", {
        procs: liveServer(),
        containerStartMs: kFixtureAt + 10 * 60 * 1000,
      });
      expect(older.describeServerPidDecision()).toEqual(
        expect.objectContaining({ decision: "proceed", reason: "predates_container", evidence: null, claimAt: kFixtureAt }),
      );
      // pid 47 is a thread of leader 40: kill() passes and its cmdline is the
      // leader's argv — the two checks the pre-#76 guard relied on.
      const thread = createStoreWithPidfile("legacy", {
        procs: {
          40: { tgid: 40, ticks: kTicks, cmdline: kServerCmdline },
          [kFixturePid]: { tgid: 40, ticks: kTicks, cmdline: kServerCmdline },
        },
      });
      expect(thread.describeServerPidDecision()).toEqual(
        expect.objectContaining({ decision: "proceed", reason: "thread", tgid: 40, killOk: true, evidence: null }),
      );
      expect(thread.convergeLegacyServerPidClaim(thread.describeServerPidDecision())).toEqual({
        converged: false,
        reason: "not_legacy_skip",
      });
      expect(readPidfile(thread)).toBe(fixtureText(kFile, "legacy"));
    });

    it("v0.9.73 {pid, at, host, startTicks}: an identity claim — matching ticks corroborate, different ticks are a recycled pid, another host is not our namespace; never converged", () => {
      const same = createStoreWithPidfile("v0.9.73", { procs: liveServer() });
      const decision = same.describeServerPidDecision();
      expect(decision).toEqual(
        expect.objectContaining({
          decision: "skip",
          reason: "corroborated",
          evidence: { pid: kFixturePid, corroborated: true },
          recordedTicks: kTicks,
          liveTicks: kTicks,
        }),
      );
      expect(decision.record).toEqual({ raw: fixtureJson(kFile, "v0.9.73"), format: 1, legacyClaim: false });
      expect(same.convergeLegacyServerPidClaim(decision)).toEqual({ converged: false, reason: "not_legacy_skip" });
      expect(readPidfile(same)).toBe(fixtureText(kFile, "v0.9.73"));

      const recycled = createStoreWithPidfile("v0.9.73", { procs: liveServer({ ticks: kTicks + 9_000 }) });
      expect(recycled.describeServerPidDecision()).toEqual(
        expect.objectContaining({ decision: "proceed", reason: "recycled", evidence: null, recordedTicks: kTicks, liveTicks: kTicks + 9_000 }),
      );

      const elsewhere = createStoreWithPidfile("v0.9.73", { procs: liveServer(), hostname: "srv-00000000" });
      expect(elsewhere.describeServerPidDecision()).toEqual(
        expect.objectContaining({ decision: "proceed", reason: "other_host", evidence: null }),
      );
    });

    it("v0.9.77 {format: 2, legacyClaim, observedTicks, containerStartTicks}: disproved by a new container or a recycled pid; still an uncorroborated skip when everything matches", () => {
      const fresh = createStoreWithPidfile("v0.9.77", { procs: liveServer(), pid1Ticks: 9_999 });
      expect(fresh.describeServerPidDecision()).toEqual(
        expect.objectContaining({
          decision: "proceed",
          reason: "other_container",
          evidence: null,
          recordedContainerTicks: kPid1Ticks,
          liveContainerTicks: 9_999,
        }),
      );

      const recycled = createStoreWithPidfile("v0.9.77", { procs: liveServer({ ticks: kTicks + 1 }) });
      expect(recycled.describeServerPidDecision()).toEqual(
        expect.objectContaining({ decision: "proceed", reason: "recycled", recordedTicks: kTicks, liveTicks: kTicks + 1 }),
      );

      const same = createStoreWithPidfile("v0.9.77", { procs: liveServer() });
      const decision = same.describeServerPidDecision();
      expect(decision).toEqual(
        expect.objectContaining({
          decision: "skip",
          reason: "legacy_argv_match",
          evidence: { pid: kFixturePid, corroborated: false },
          recordedTicks: kTicks,
          liveTicks: kTicks,
          recordedContainerTicks: kPid1Ticks,
          liveContainerTicks: kPid1Ticks,
        }),
      );
      expect(decision.record).toEqual({ raw: fixtureJson(kFile, "v0.9.77"), format: 2, legacyClaim: true });
      expect(same.convergeLegacyServerPidClaim(decision)).toEqual({ converged: false, reason: "already_converged" });
      expect(readPidfile(same)).toBe(fixtureText(kFile, "v0.9.77"));
      expect(formatServerPidDecision(decision)).toMatch(/^format=2 pid=47 kill=ok tgid=47 .* container=3431\/3431 → legacy_argv_match \(skip\)$/);

      // A converged claim whose pid is gone proceeds like any other.
      expect(createStoreWithPidfile("v0.9.77").describeServerPidDecision().reason).toBe("dead");
    });
  },
);

describe("persisted-format fixtures: openclaw-channel-state.json (v0.9.76 → v0.9.77)", () => {
  const kFile = "openclaw-channel-state.json";
  const createStore = () => {
    const rootDir = mkTemp("alphaclaw-compat-channel-fx-");
    return createOpenclawReleaseChannelStore({
      rootDir,
      openclawDir: path.join(rootDir, ".openclaw"),
      logger: kSilentLogger,
    });
  };

  it("v0.9.76 (no lastTransition / pinLag / configMigration.lastRestore): loads with those null, every 0.9.76 field intact, and a rewrite only ADDS the null slots", () => {
    const store = createStore();
    plantFixture(kFile, "v0.9.76", store.statePath);
    const fixture = fixtureJson(kFile, "v0.9.76");
    expect(fixture).not.toHaveProperty("lastTransition");
    expect(fixture).not.toHaveProperty("pinLag");

    const state = store.readState();
    expect(state.corrupted).toBeUndefined();
    expect(state.lastTransition).toBeNull();
    expect(state.pinLag).toBeNull();
    expect(state.configMigration).toEqual({ ...fixture.configMigration, lastRestore: null,
      completedForBuild: null, lastAttempt: { ...fixture.configMigration.lastAttempt, buildId: null } });
    expect(state).toMatchObject({
      applied: fixture.applied,
      pinVersion: "2026.9.2",
      lastKnownGood: fixture.lastKnownGood,
      blocklist: fixture.blocklist,
      lastUpdateRun: fixture.lastUpdateRun,
      lastBoot: fixture.lastBoot,
      gatewayHold: null,
      backups: fixture.backups,
      previousPin: fixture.previousPin,
      pinWindow: fixture.pinWindow,
    });
    expect(normalizeState(fixture)).toEqual(state);

    store.writeState(state);
    expect(readJsonFile(store.statePath)).toEqual({
      ...fixture,
      configMigration: { ...fixture.configMigration, lastRestore: null,
        completedForBuild: null, lastAttempt: { ...fixture.configMigration.lastAttempt, buildId: null } },
      lastTransition: null,
      pinLag: null,
    });
  });

  it("v0.9.77: adds null build identity slots and round-trips every historical field byte-for-byte", () => {
    const store = createStore();
    plantFixture(kFile, "v0.9.77", store.statePath);
    const fixture = fixtureJson(kFile, "v0.9.77");

    const state = store.readState();
    expect(state.corrupted).toBeUndefined();
    expect(state.lastTransition).toEqual(fixture.lastTransition);
    expect(state.lastTransition).toMatchObject({
      from: "2026.8.2",
      to: "2026.9.2",
      kind: "upgrade",
      source: "operator_apply",
      ok: true,
      consumedAt: null,
    });
    expect(state.pinLag).toEqual(fixture.pinLag);
    expect(state.pinLag).toMatchObject({ pin: "2026.9.2", installed: "2026.8.2", bootId: kFixtureBootId, bootsSeen: 1 });
    expect(state.configMigration.lastRestore).toEqual(fixture.configMigration.lastRestore);
    expect(state.configMigration.lastRestore).toMatchObject({ source: "round_trip", bootId: kFixtureBootId });

    store.writeState(state);
    const rewritten = readJsonFile(store.statePath);
    expect(rewritten).toEqual({ ...fixture, configMigration: { ...fixture.configMigration,
      completedForBuild: null, lastAttempt: { ...fixture.configMigration.lastAttempt, buildId: null } } });
    // The only forward-format change is those two explicitly unknown slots.
    // Removing them must reproduce the historical fixture's exact bytes.
    delete rewritten.configMigration.completedForBuild;
    delete rewritten.configMigration.lastAttempt.buildId;
    expect(`${JSON.stringify(rewritten, null, 2)}\n`).toBe(fixtureText(kFile, "v0.9.77"));
  });
});

describe("persisted-format fixtures: runs/<operationId>.json (v0.9.76 apply, v0.9.77 reconcile)", () => {
  const kFile = "runs";
  const kBootNow = kFixtureAt + 60_000;
  const createLedger = () =>
    createRunLedger({
      openclawDir: mkTemp("alphaclaw-compat-runs-fx-"),
      logger: kSilentLogger,
      nowFn: () => kBootNow,
    });
  const plantRun = (ledger, era) => {
    const fixture = fixtureJson(kFile, era);
    const target = plantFixture(kFile, era, path.join(ledger.runsDir, `${fixture.operationId}.json`));
    return { fixture, target };
  };
  const kInterruptedResult = {
    ok: false,
    code: "interrupted",
    message: "AlphaClaw restarted before the update finished.",
    hint: "Nothing was activated. Start the update again from the Upgrade page.",
    docsUrl: null,
  };

  it("v0.9.76: a run left `running` by a process that died mid-apply loads whole and is closed as interrupted at boot with steps/backup/dbPreflight intact", () => {
    const ledger = createLedger();
    const { fixture, target } = plantRun(ledger, "v0.9.76");
    expect(fixture).toMatchObject({ state: "running", target: { channel: "stable", version: "2026.9.2" } });
    expect(ledger.readRun(fixture.operationId)).toEqual(fixture);

    const closed = ledger.closeInterruptedRuns();
    expect(closed).toEqual([
      {
        ...fixture,
        state: "interrupted",
        ok: false,
        finishedAt: kBootNow,
        result: kInterruptedResult,
      },
    ]);
    expect(readJsonFile(target)).toEqual(closed[0]);
    // Idempotent: nothing is left running for the next boot to close.
    expect(ledger.closeInterruptedRuns()).toEqual([]);
  });

  it("v0.9.77: a reconcile ledger run (target.kind reconcile, steps stop → activate) that died mid-copy is closed the same way (Codex 7)", () => {
    const ledger = createLedger();
    const { fixture, target } = plantRun(ledger, "v0.9.77");
    expect(fixture).toMatchObject({
      state: "running",
      target: { kind: "reconcile", version: "2026.9.2" },
      steps: [
        { name: "stop", status: "done" },
        { name: "activate", status: "running" },
      ],
    });
    expect(ledger.readRun(fixture.operationId)).toEqual(fixture);

    const closed = ledger.closeInterruptedRuns();
    expect(closed).toEqual([
      { ...fixture, state: "interrupted", ok: false, finishedAt: kBootNow, result: kInterruptedResult },
    ]);
    expect(readJsonFile(target).steps).toEqual(fixture.steps);
    expect(ledger.listRuns().map((run) => run.state)).toEqual(["interrupted"]);
  });
});

describe("persisted-format fixtures: alphaclaw-restart-operation.json (v0.9.76 → v0.9.77)", () => {
  const kFile = "alphaclaw-restart-operation.json";
  const nullFlagStore = () => ({ read: () => null, write() {}, clear() {} });
  const createState = ({ stateDir, now, bootId }) =>
    createRestartRequiredState({
      isGatewayRunning: async () => true,
      flagStore: nullFlagStore(),
      stateDir,
      now: () => now,
      getBootId: () => bootId,
    });
  const plantOperation = (era) => {
    const stateDir = mkTemp("alphaclaw-compat-restart-fx-");
    const target = plantFixture(kFile, era, path.join(stateDir, kFile));
    return { stateDir, target, fixture: fixtureJson(kFile, era) };
  };

  it("v0.9.76: a `running` record from the previous boot is closed as interrupted by reconcileOnBoot and the closure is persisted (no #76 fields invented)", () => {
    const { stateDir, target, fixture } = plantOperation("v0.9.76");
    expect(fixture).toMatchObject({ status: "running", bootId: kPreviousBootId, lastStep: "stopping_gateway" });
    const bootNow = kFixtureAt + 20_000;
    const state = createState({ stateDir, now: bootNow, bootId: kFixtureBootId });
    state.reconcileOnBoot();

    expect(state.getActiveRestartOperation()).toBeNull();
    const last = state.getLastRestartOperation();
    expect(last).toMatchObject({
      operationId: fixture.operationId,
      kind: "gateway_restart",
      startedAt: fixture.startedAt,
      bootId: kPreviousBootId,
      expiresAt: fixture.expiresAt,
      status: "interrupted",
      lastStep: "stopping_gateway",
      errorSummary: "AlphaClaw restarted before the operation finished",
      completedAt: bootNow,
      reasonsSnapshot: ["env_vars_changed", "channel_token_updated"],
      code: null,
    });
    expect(last).not.toHaveProperty("stateDb");
    expect(last).not.toHaveProperty("cause");

    const onDisk = readJsonFile(target);
    expect(onDisk).toMatchObject({ status: "interrupted", completedAt: bootNow, errorSummary: last.errorSummary });
    expect(onDisk).not.toHaveProperty("stateDb");
    expect(onDisk).not.toHaveProperty("cause");
  });

  it("v0.9.77: a `failed` record with stateDb + cause loads intact, is left untouched by reconcile (terminal), and is swept only past the 24h retention", () => {
    const { stateDir, target, fixture } = plantOperation("v0.9.77");
    expect(fixture).toMatchObject({ status: "failed", bootId: kFixtureBootId });
    const state = createState({ stateDir, now: kFixtureAt + 20_000, bootId: kNextBootId });
    state.reconcileOnBoot();

    expect(state.getActiveRestartOperation()).toBeNull();
    expect(state.getLastRestartOperation()).toMatchObject({
      operationId: fixture.operationId,
      status: "failed",
      bootId: kFixtureBootId,
      lastStep: "waiting_for_gateway",
      errorSummary: "gateway exited (code 1) before becoming healthy",
      stateDb: { userVersion: 15, agentUserVersions: [19, 19] },
      cause: "state_schema_too_new",
      evidenceTail: fixture.evidenceTail,
      code: null,
      reasonsSnapshot: ["env_vars_changed"],
    });
    expect(fs.readFileSync(target, "utf8")).toBe(fixtureText(kFile, "v0.9.77"));

    const later = createState({
      stateDir,
      now: fixture.completedAt + kRestartOperationRetentionMs + 1,
      bootId: "9:1788768100000",
    });
    later.reconcileOnBoot();
    expect(later.getLastRestartOperation()).toBeNull();
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe("persisted-format fixtures: gateway-state.json (v0.9.76 → v0.9.77)", () => {
  const kFile = "gateway-state.json";
  const plantState = (era) => {
    const persistPath = path.join(mkTemp("alphaclaw-compat-gwstate-fx-"), kFile);
    plantFixture(kFile, era, persistPath);
    return { persistPath, fixture: fixtureJson(kFile, era) };
  };

  it("v0.9.76 {state, since, bootId} (no cause): persist → restore keeps state + since across the restart and invents no annotation", () => {
    const { persistPath, fixture } = plantState("v0.9.76");
    expect(fixture).toEqual({ state: "running", since: 1_788_680_700_000, bootId: kPreviousBootId });
    let now = kFixtureAt;
    const tracker = createGatewayStateTracker({ persistPath, now: () => now, bootId: kFixtureBootId });

    const tracked = tracker.track({ state: "running" });
    expect(tracked).toEqual({ state: "running", since: fixture.since });
    // The whitelist writes its two annotation SLOTS as null — no value is
    // invented for a file that never had one.
    expect(readJsonFile(persistPath)).toEqual({
      state: "running",
      since: fixture.since,
      cause: null,
      versionMismatch: null,
      bootId: kFixtureBootId,
    });

    // The next process restores the same continuity from what this one wrote.
    now += 30_000;
    const next = createGatewayStateTracker({ persistPath, now: () => now, bootId: kNextBootId });
    expect(next.track({ state: "running" }).since).toBe(fixture.since);
    now += 1_000;
    expect(next.track({ state: "down" })).toEqual({ state: "down", since: now });
    expect(readJsonFile(persistPath)).toEqual({
      state: "down",
      since: now,
      cause: null,
      versionMismatch: null,
      bootId: kNextBootId,
    });
  });

  it("v0.9.77 {state, since, cause, versionMismatch, bootId}: both annotations restore intact, an identical annotation is a no-op write, and a transition carries them", () => {
    const { persistPath, fixture } = plantState("v0.9.77");
    expect(fixture).toMatchObject({
      state: "down",
      cause: "state_schema_too_new",
      versionMismatch: { expected: "2026.9.2", running: "2026.7.1-2", source: "boot" },
      bootId: kFixtureBootId,
    });
    let now = kFixtureAt;
    const tracker = createGatewayStateTracker({ persistPath, now: () => now, bootId: kNextBootId });

    const writeSpy = vi.spyOn(fs, "writeFileSync");
    try {
      expect(tracker.setCause(fixture.cause)).toBe("state_schema_too_new");
      expect(tracker.setVersionMismatch(fixture.versionMismatch)).toEqual(fixture.versionMismatch);
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
    expect(fs.readFileSync(persistPath, "utf8")).toBe(fixtureText(kFile, "v0.9.77"));

    expect(tracker.track({ state: "down" })).toEqual({ state: "down", since: fixture.since });
    expect(readJsonFile(persistPath)).toEqual({ ...fixture, bootId: kNextBootId });
    now += 5_000;
    expect(tracker.track({ state: "starting" })).toEqual({ state: "starting", since: now });
    expect(readJsonFile(persistPath)).toEqual({
      state: "starting",
      since: now,
      cause: fixture.cause,
      versionMismatch: fixture.versionMismatch,
      bootId: kNextBootId,
    });
  });
});

describe("persisted-format fixtures: boot-report.json (v0.9.77 incident shape, torn write)", () => {
  const kFile = "boot-report.json";
  const kMergeAt = kFixtureAt + 10_000;
  const createWriter = ({ bootId = kFixtureBootId } = {}) => {
    const logger = { warn: vi.fn() };
    const managedDir = path.join(mkTemp("alphaclaw-compat-bootreport-fx-"), ".alphaclaw");
    return { writer: createBootReportWriter({ managedDir, bootId, nowFn: () => kMergeAt, logger }), logger };
  };

  it("v0.9.77: the #76 shape reads back whole, its verdict is reproducible from the evidence, the same boot still merges into it and another boot never does", () => {
    const { writer, logger } = createWriter();
    plantFixture(kFile, "v0.9.77", writer.reportPath);
    const fixture = fixtureJson(kFile, "v0.9.77");

    expect(writer.readBootReports()).toEqual({ current: fixture, previous: [], incident: null, refused: null, unreadable: [] });
    expect(computeVerdict(fixture)).toEqual(fixture.serverPhase.verdict);
    expect(normalizeVerdict(fixture.serverPhase.verdict)).toEqual([
      kBootVerdicts.installedNotExpected,
      kBootVerdicts.stateSchemaTooNew,
    ]);
    expect(describeReportVersions(fixture)).toEqual({ expected: "2026.9.2", running: "2026.7.1-2", diverged: true });
    expect(fixture.openclaw.installedAtBoot).toBe("2026.7.1-2");
    expect(fixture.serverPhase).toMatchObject({
      supportedSchema: { state: 1, agent: null, source: "seeded" },
      compat: { compatible: false, hold: "version_mismatch" },
      gatewayHeld: true,
    });

    expect(writer.pinIncidentReport(fixture)).toEqual({ pinned: true, reason: "first" });
    const merged = writer.mergeServerPhase({ gatewayHeld: false });
    expect(merged.binPhase).toEqual({ status: "ok" });
    expect(merged.alphaclaw).toEqual(fixture.alphaclaw);
    expect(merged.pidfile).toEqual(fixture.pidfile);
    expect(merged.serverPhase).toMatchObject({
      status: "recorded",
      gatewayHeld: false,
      at: kMergeAt,
      stateDb: fixture.serverPhase.stateDb,
      verdict: fixture.serverPhase.verdict,
    });
    expect(readJsonFile(writer.incidentPath)).toEqual({ ...fixture, pinnedAt: kMergeAt });
    expect(logger.warn).not.toHaveBeenCalled();

    // Another boot never merges into it (Codex D16).
    const { writer: other } = createWriter({ bootId: kNextBootId });
    plantFixture(kFile, "v0.9.77", other.reportPath);
    expect(other.mergeServerPhase({}).binPhase).toEqual({ status: "mismatch", previousBootId: kFixtureBootId });
  });

  it("corrupt (torn write): reads as unreadable and never throws; the server phase rewrites it from scratch with binPhase unreadable + previous \"unreadable\" and one warning", () => {
    const { writer, logger } = createWriter();
    plantFixture(kFile, "corrupt", writer.reportPath);
    expect(() => JSON.parse(fixtureText(kFile, "corrupt"))).toThrow();

    expect(writer.readBootReports()).toEqual({
      current: null,
      previous: [],
      incident: null,
      refused: null,
      unreadable: [kBootReportFileName],
    });
    expect(logger.warn).not.toHaveBeenCalled();

    const merged = writer.mergeServerPhase({ installedVersion: "2026.7.1-2" });
    expect(merged).toMatchObject({
      bootId: kFixtureBootId,
      binPhase: { status: "unreadable" },
      previous: "unreadable",
      alphaclaw: null,
      pidfile: null,
      serverPhase: { status: "recorded", installedVersion: "2026.7.1-2", at: kMergeAt, verdict: [] },
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/is unreadable .*rewriting it from scratch/);
    expect(writer.readBootReports()).toMatchObject({ current: merged, unreadable: [] });
  });
});

describe("persisted-format fixtures: alphaclaw-version.json (missing, v0.9.77, torn write)", () => {
  const kFile = "alphaclaw-version.json";
  const kSpec = "github:garrytan/alphaclaw#a1b2c3d";
  const createManagedDir = () => path.join(mkTemp("alphaclaw-compat-selfversion-fx-"), ".alphaclaw");
  const makeLogger = () => ({ warn: vi.fn(), log: vi.fn(), error: vi.fn() });

  it("missing: the first boot of a box — a null stamp without a warning; stamping writes bootCount 1 with no previous", () => {
    const managedDir = createManagedDir();
    const logger = makeLogger();
    expect(readSelfVersionStamp({ managedDir, logger })).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();

    const result = stampSelfVersionAtBoot({ version: "0.9.77", spec: kSpec, nowFn: () => kFixtureAt, managedDir, logger });
    expect(result).toEqual({
      changed: true,
      previousVersion: null,
      record: { version: "0.9.77", commit: "a1b2c3d", firstBootAt: kFixtureAt, lastBootAt: kFixtureAt, bootCount: 1, previous: null },
    });
    expect(readSelfVersionStamp({ managedDir, logger })).toEqual(result.record);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("v0.9.77: reads back whole; a repeat boot increments bootCount and keeps firstBootAt/previous; a version change carries the stamp into previous", () => {
    const managedDir = createManagedDir();
    const logger = makeLogger();
    plantFixture(kFile, "v0.9.77", path.join(managedDir, kSelfVersionFileName));
    const fixture = fixtureJson(kFile, "v0.9.77");
    expect(fixture).toMatchObject({ version: "0.9.77", bootCount: 2, previous: { version: "0.9.76" } });
    expect(readSelfVersionStamp({ managedDir, logger })).toEqual(fixture);

    const repeat = stampSelfVersionAtBoot({ version: "0.9.77", spec: kSpec, nowFn: () => kFixtureAt + 7_200_000, managedDir, logger });
    expect(repeat).toEqual({
      changed: false,
      previousVersion: "0.9.77",
      record: { ...fixture, lastBootAt: kFixtureAt + 7_200_000, bootCount: 3 },
    });

    const upgrade = stampSelfVersionAtBoot({
      version: "0.9.78",
      spec: "github:garrytan/alphaclaw#e4f5a6b",
      nowFn: () => kFixtureAt + 86_400_000,
      managedDir,
      logger,
    });
    expect(upgrade).toEqual({
      changed: true,
      previousVersion: "0.9.77",
      record: {
        version: "0.9.78",
        commit: "e4f5a6b",
        firstBootAt: kFixtureAt + 86_400_000,
        lastBootAt: kFixtureAt + 86_400_000,
        bootCount: 1,
        previous: { version: "0.9.77", commit: "a1b2c3d", lastBootAt: kFixtureAt + 7_200_000 },
      },
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("corrupt (torn write): null with ONE warning naming the file, and the next stamp starts over as a first boot", () => {
    const managedDir = createManagedDir();
    const logger = makeLogger();
    const target = plantFixture(kFile, "corrupt", path.join(managedDir, kSelfVersionFileName));
    expect(() => JSON.parse(fixtureText(kFile, "corrupt"))).toThrow();

    expect(readSelfVersionStamp({ managedDir, logger })).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain(target);

    const result = stampSelfVersionAtBoot({ version: "0.9.77", nowFn: () => kFixtureAt, managedDir, logger });
    expect(result).toEqual({
      changed: true,
      previousVersion: null,
      record: { version: "0.9.77", commit: null, firstBootAt: kFixtureAt, lastBootAt: kFixtureAt, bootCount: 1, previous: null },
    });
    expect(readJsonFile(target)).toEqual(result.record);
  });
});

describe("persisted-format fixtures: openclaw-schema-versions.json (v0.9.77, torn write)", () => {
  const kFile = "openclaw-schema-versions.json";
  const createTable = () => {
    const managedDir = path.join(mkTemp("alphaclaw-compat-schema-fx-"), ".alphaclaw");
    const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn() };
    return {
      table: createSchemaVersionTable({ managedDir, nowFn: () => kFixtureAt, logger }),
      logger,
      filePath: path.join(managedDir, kSchemaVersionsFileName),
    };
  };
  const seededView = () =>
    Object.fromEntries(
      Object.entries(kSeededSchemaVersions).map(([version, seed]) => [
        version,
        { state: seed.state, agent: seed.agent, source: "seeded", at: null, observed: null },
      ]),
    );

  it("corrupt (torn write): the seeded table answers with exactly one warning and never a throw; the next declaration rewrites the file whole (CEO 1.1)", () => {
    const { table, logger, filePath } = createTable();
    plantFixture(kFile, "corrupt", filePath);
    expect(() => JSON.parse(fixtureText(kFile, "corrupt"))).toThrow();

    expect(table.read()).toEqual({ byVersion: seededView(), origin: "unreadable" });
    expect(table.supportedFor("2026.9.2")).toEqual({ state: 15, agent: 19, source: "seeded" });
    // 2026.9.9 is not seeded (2026.9.3 has been since v0.9.80): an unknown version answers nulls.
    expect(table.supportedFor("2026.9.9")).toEqual({ state: null, agent: null, source: null });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain("seeded");

    expect(table.recordDeclared("2026.9.2", { state: 15, agent: 19 })).toEqual({ state: 15, agent: 19, source: "declared" });
    expect(table.read().origin).toBe("file");
    expect(readJsonFile(filePath)).toEqual({
      byVersion: { "2026.9.2": { state: 15, agent: 19, source: "declared", at: kFixtureAt } },
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("v0.9.77: learned declared entries override the seeds, observed evidence rides along and never becomes supported, and reading never writes", () => {
    const { table, logger, filePath } = createTable();
    plantFixture(kFile, "v0.9.77", filePath);
    const fixture = fixtureJson(kFile, "v0.9.77");

    const view = table.read();
    expect(view.origin).toBe("file");
    expect(view.byVersion["2026.9.2"]).toEqual(fixture.byVersion["2026.9.2"]);
    expect(view.byVersion["2026.9.2"]).toMatchObject({ source: "declared", observed: { state: 15, agent: 19 } });
    expect(view.byVersion["2026.9.3"]).toEqual({ ...fixture.byVersion["2026.9.3"], observed: null });
    // Seeds the file does not mention are still there.
    expect(view.byVersion["2026.7.1-2"]).toEqual({ state: 1, agent: null, source: "seeded", at: null, observed: null });
    expect(table.supportedFor("2026.9.2")).toEqual({ state: 15, agent: 19, source: "declared" });
    expect(table.supportedFor("2026.9.3")).toEqual({ state: 16, agent: 20, source: "declared" });

    expect(fs.readFileSync(filePath, "utf8")).toBe(fixtureText(kFile, "v0.9.77"));
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("persisted-format fixtures: auto-repair-pause.json (reader lands in Stage 3 I3)", () => {
  const kFile = "auto-repair-pause.json";

  it("v0.9.77 fixture carries the identity the pause is keyed by ({ installedVersion, fingerprint }) plus cause / attempts / lastPlan / reason", () => {
    expect(fixtureJson(kFile, "v0.9.77")).toEqual({
      at: expect.any(Number),
      cause: "state_schema_too_new",
      fingerprint: expect.any(String),
      installedVersion: "2026.7.1-2",
      attempts: 3,
      lastPlan: { rung: "reconcile_installed", outcome: "overlay_missing" },
      reason: "structural_repair_failed",
    });
  });

  // Stage 3 I3: createWatchdog re-arms `state.autoRepairPaused` from
  // <managedDir>/auto-repair-pause.json through the store seams
  // (createAutoRepairPauseStore → readPersistedPause / writePersistedPause);
  // v0.9.77.json is regenerated from the real writer (serializeAutoRepairPause).
  const { createWatchdog } = require("../../lib/server/watchdog");
  const {
    createAutoRepairPauseStore,
    serializeAutoRepairPause,
    kAutoRepairPauseFileName,
  } = require("../../lib/server/watchdog-structural-repair");
  const { fingerprintGatewayCrash } = require("../../lib/server/gateway-crash-cause");
  const pausedWatchdog = ({ managedDir, installedVersion }) => {
    const store = createAutoRepairPauseStore({
      filePath: path.join(managedDir, kAutoRepairPauseFileName),
      logger: kSilentLogger,
    });
    const insertWatchdogEvent = vi.fn();
    const watchdog = createWatchdog({
      clawCmd: vi.fn(async () => ({ ok: true })),
      launchGatewayProcess: vi.fn(async () => null),
      insertWatchdogEvent,
      notifier: { notify: vi.fn(async () => ({ ok: true })) },
      readEnvFile: vi.fn(() => ""),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      resolveSetupUrl: () => "http://localhost",
      resolveGatewayHealthUrl: () => "http://gateway/health",
      resolveGatewayReadyzUrl: () => "http://gateway/readyz",
      releaseChannelHooks: {
        getInfo: () => ({ installedVersion, expectedVersion: "2026.9.2", installedDiverged: installedVersion !== "2026.9.2" }),
      },
      readPersistedPause: () => store.read(),
      writePersistedPause: (pause) => store.write(pause),
    });
    return { watchdog, store, insertWatchdogEvent };
  };

  it("v0.9.77 fixture is byte-for-byte what the current writer produces for the incident record (fingerprint of the 2026.7.1-2 line, at = incident clock + 5 min)", () => {
    const matchedLine =
      "OpenClaw state database /data/.openclaw/state/openclaw.sqlite uses newer schema version 15; this OpenClaw build supports 1.";
    const fingerprint = fingerprintGatewayCrash({ cause: "state_schema_too_new", code: 1, signal: null, matchedLine });
    expect(fixtureText(kFile, "v0.9.77")).toBe(
      serializeAutoRepairPause({
        at: kFixtureAt + 5 * 60 * 1000,
        cause: "state_schema_too_new",
        fingerprint,
        installedVersion: "2026.7.1-2",
        attempts: 3,
        lastPlan: { rung: "reconcile_installed", outcome: "overlay_missing" },
        reason: "structural_repair_failed",
      }),
    );
  });

  it("absent file → createWatchdog starts with no pause (getStatus().autoRepairPaused === null) and the ladder is armed", () => {
    const managedDir = path.join(mkTemp("alphaclaw-pause-compat-"), ".openclaw", ".alphaclaw");
    const { watchdog, store, insertWatchdogEvent } = pausedWatchdog({ managedDir, installedVersion: "2026.7.1-2" });
    expect(store.read()).toBe(null);
    expect(watchdog.getStatus().autoRepairPaused).toBe(null);
    expect(insertWatchdogEvent).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it("v0.9.77 fixture → re-armed from disk for the SAME installedVersion + fingerprint; a different installedVersion clears it (file unlinked)", () => {
    const fixture = fixtureJson(kFile, "v0.9.77");
    const same = path.join(mkTemp("alphaclaw-pause-compat-"), ".openclaw", ".alphaclaw");
    plantFixture(kFile, "v0.9.77", path.join(same, kAutoRepairPauseFileName));
    const rearmed = pausedWatchdog({ managedDir: same, installedVersion: fixture.installedVersion });
    expect(rearmed.watchdog.getStatus().autoRepairPaused).toEqual({
      ...fixture,
      at: new Date(fixture.at).toISOString(),
      corroborated: null,
      expected: "2026.9.2",
    });
    expect(rearmed.insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "repair",
        source: "structural",
        status: "skipped",
        details: expect.objectContaining({ reason: "auto_repair_paused", rearmed: true, fingerprint: fixture.fingerprint }),
      }),
    );
    // The file is untouched by a re-arm.
    expect(fs.readFileSync(path.join(same, kAutoRepairPauseFileName), "utf8")).toBe(fixtureText(kFile, "v0.9.77"));
    rearmed.watchdog.stop();

    const changed = path.join(mkTemp("alphaclaw-pause-compat-"), ".openclaw", ".alphaclaw");
    plantFixture(kFile, "v0.9.77", path.join(changed, kAutoRepairPauseFileName));
    const dropped = pausedWatchdog({ managedDir: changed, installedVersion: "2026.9.2" });
    expect(dropped.watchdog.getStatus().autoRepairPaused).toBe(null);
    expect(fs.existsSync(path.join(changed, kAutoRepairPauseFileName))).toBe(false);
    dropped.watchdog.stop();

    // Torn write: lenient — no pause, no throw.
    const torn = path.join(mkTemp("alphaclaw-pause-compat-"), ".openclaw", ".alphaclaw");
    fs.mkdirSync(torn, { recursive: true });
    fs.writeFileSync(path.join(torn, kAutoRepairPauseFileName), fixtureText(kFile, "v0.9.77").slice(0, 60));
    const lenient = pausedWatchdog({ managedDir: torn, installedVersion: fixture.installedVersion });
    expect(lenient.watchdog.getStatus().autoRepairPaused).toBe(null);
    lenient.watchdog.stop();
  });
});
