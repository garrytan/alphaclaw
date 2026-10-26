const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  classifyBootCause,
  consumeShutdownRecord,
  writeShutdownRecord,
  kShutdownRecordFileName,
} = require("../../lib/server/box-status/boot-cause");

const kStart = Date.parse("2026-10-26T12:00:00Z");

describe("boot cause", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "boot-cause-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("a graceful shutdown record reads as a clean shutdown, with the gap from the last serving stamp", () => {
    writeShutdownRecord({ managedDir: dir, kind: "shutdown", reason: "SIGTERM", code: 0, now: () => kStart - 50_000 });
    const shutdown = consumeShutdownRecord({ managedDir: dir });
    expect(shutdown).toEqual({ kind: "shutdown", reason: "SIGTERM", code: 0, atMs: kStart - 50_000 });
    expect(classifyBootCause({ shutdown, lastServingAt: kStart - 60_000, startedAtMs: kStart, hasHistory: true })).toEqual({
      kind: "shutdown",
      label: "Clean shutdown (SIGTERM)",
      reason: "SIGTERM",
      shutdownAt: "2026-10-26T11:59:10.000Z",
      gapMs: 60_000,
    });
  });

  it("a crash guard's drain is recorded too, and reads as an AlphaClaw error, not an unclean exit", () => {
    const shutdown = { kind: "shutdown", reason: "uncaught exception", code: 1, atMs: kStart - 5_000 };
    expect(classifyBootCause({ shutdown, lastServingAt: kStart - 10_000, startedAtMs: kStart, hasHistory: true })).toMatchObject({
      kind: "shutdown",
      label: "AlphaClaw exited on an error (uncaught exception)",
    });
  });

  it("a self-update restart reads as an AlphaClaw restart", () => {
    writeShutdownRecord({ managedDir: dir, kind: "restart", reason: "update", now: () => kStart - 20_000 });
    expect(classifyBootCause({ shutdown: consumeShutdownRecord({ managedDir: dir }), lastServingAt: kStart - 25_000, startedAtMs: kStart, hasHistory: true })).toEqual({
      kind: "restart",
      label: "AlphaClaw restart (update)",
      reason: "update",
      shutdownAt: "2026-10-26T11:59:40.000Z",
      gapMs: 25_000,
    });
  });

  it("no shutdown record and no restart is an unclean exit (platform or crash) with the unaccounted gap", () => {
    expect(classifyBootCause({ shutdown: consumeShutdownRecord({ managedDir: dir }), lastServingAt: kStart - 47 * 60_000, startedAtMs: kStart, hasHistory: true })).toEqual({
      kind: "unclean_exit",
      label: "Platform or crash",
      reason: null,
      shutdownAt: null,
      gapMs: 47 * 60_000,
    });
    expect(classifyBootCause({ lastServingAt: null, startedAtMs: kStart, hasHistory: true })).toMatchObject({ kind: "unclean_exit", gapMs: null });
  });

  it("a box with no stamp and no boot history is on its first boot", () => {
    expect(classifyBootCause({ lastServingAt: null, startedAtMs: kStart, hasHistory: false })).toEqual({
      kind: "first_boot", label: "First boot", reason: null, shutdownAt: null, gapMs: null,
    });
  });

  it("a record is consumed once: the boot after an unclean exit of the next process does not reuse it", () => {
    writeShutdownRecord({ managedDir: dir, kind: "shutdown", reason: "SIGTERM", code: 0, now: () => kStart - 10_000 });
    expect(consumeShutdownRecord({ managedDir: dir })).not.toBeNull();
    expect(fs.existsSync(path.join(dir, kShutdownRecordFileName))).toBe(false);
    expect(consumeShutdownRecord({ managedDir: dir })).toBeNull();
  });

  it("ignores a record a later serving gateway outlived, and an unreadable or foreign record", () => {
    const shutdown = { kind: "shutdown", reason: "SIGTERM", code: 0, atMs: kStart - 3_600_000 };
    expect(classifyBootCause({ shutdown, lastServingAt: kStart - 600_000, startedAtMs: kStart, hasHistory: true }).kind).toBe("unclean_exit");
    expect(classifyBootCause({ shutdown, lastServingAt: shutdown.atMs + 30_000, startedAtMs: kStart, hasHistory: true }).kind).toBe("shutdown");
    fs.writeFileSync(path.join(dir, kShutdownRecordFileName), "{nope");
    expect(consumeShutdownRecord({ managedDir: dir })).toBeNull();
    fs.writeFileSync(path.join(dir, kShutdownRecordFileName), JSON.stringify({ kind: "other", atMs: kStart }));
    expect(consumeShutdownRecord({ managedDir: dir })).toBeNull();
    expect(fs.existsSync(path.join(dir, kShutdownRecordFileName))).toBe(false);
  });

  it("a failed write logs one line and never throws", () => {
    const warn = vi.fn();
    const notADir = path.join(dir, "file");
    fs.writeFileSync(notADir, "");
    expect(writeShutdownRecord({ managedDir: notADir, kind: "shutdown", reason: "SIGINT", code: 0, logger: { warn } })).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not record the shutdown"));
  });
});
