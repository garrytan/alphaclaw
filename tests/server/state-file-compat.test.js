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
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createOpenclawReleaseChannelStore,
  normalizeState,
} = require("../../lib/server/openclaw-release-channel");
const { createRunLedger } = require("../../lib/server/openclaw-run-ledger");
const { createNotifyOutbox } = require("../../lib/server/notify-outbox");

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
