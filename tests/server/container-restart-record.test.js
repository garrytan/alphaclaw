const fs = require("fs");
const os = require("os");
const path = require("path");
const { createContainerPressureRecord, kRestartAtLimitWindowMs } = require("../../lib/server/gateway-memory/container-restart-record");

// ALPH-25: the last full container sample survives the process, and the next
// boot reads it as "the container restarted at its memory limit" only when
// the previous process ended uncleanly at >= 95% shortly before this one.
const kGb = 1024 ** 3;
const kLimit = 100 * kGb;
const kSampleMs = Date.parse("2026-10-24T07:21:00.000Z");

const setup = () => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "container-pressure-")), "container-pressure.json");
  const previous = createContainerPressureRecord({ filePath, bootIdFn: () => "1:previous" });
  const next = createContainerPressureRecord({ filePath, bootIdFn: () => "1:next" });
  return { filePath, previous, next };
};

describe("container restart at the memory limit (boot cause)", () => {
  it("an unclean end at 97% reads as a restart at the limit, once", () => {
    const { previous, next, filePath } = setup();
    previous.recordFull({ atMs: kSampleMs - 60_000, usedBytes: 93 * kGb, limitBytes: kLimit, largest: { command: "bun", rssBytes: 60 * kGb } });
    previous.recordFull({ atMs: kSampleMs, usedBytes: 97 * kGb, limitBytes: kLimit, largest: { command: "bun", rssBytes: 63 * kGb } });
    expect(next.consumeAtBoot({ processStartedAtMs: kSampleMs + 90_000 })).toEqual({
      atMs: kSampleMs, usedBytes: 97 * kGb, limitBytes: kLimit, largest: { command: "bun", rssBytes: 63 * kGb },
    });
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toMatchObject({ state: "reported" });
    expect(next.consumeAtBoot({ processStartedAtMs: kSampleMs + 90_000 })).toBeNull();
  });

  it("a clean shutdown, a cleared episode, or the same process is not a restart at the limit", () => {
    for (const end of ["markClean", "recordClear"]) {
      const { previous, next } = setup();
      previous.recordFull({ atMs: kSampleMs, usedBytes: 97 * kGb, limitBytes: kLimit });
      previous[end](kSampleMs + 10_000);
      expect(next.consumeAtBoot({ processStartedAtMs: kSampleMs + 60_000 })).toBeNull();
    }
    const { previous } = setup();
    previous.recordFull({ atMs: kSampleMs, usedBytes: 97 * kGb, limitBytes: kLimit });
    expect(previous.consumeAtBoot({ processStartedAtMs: kSampleMs + 60_000 })).toBeNull();
  });

  it("below 95% of the limit, or outside the window, is not a restart at the limit", () => {
    const low = setup();
    low.previous.recordFull({ atMs: kSampleMs, usedBytes: 94 * kGb, limitBytes: kLimit });
    expect(low.next.consumeAtBoot({ processStartedAtMs: kSampleMs + 60_000 })).toBeNull();
    const old = setup();
    old.previous.recordFull({ atMs: kSampleMs, usedBytes: 99 * kGb, limitBytes: kLimit });
    expect(old.next.consumeAtBoot({ processStartedAtMs: kSampleMs + kRestartAtLimitWindowMs + 1 })).toBeNull();
  });

  it("a container pinned at its limit counts below 95% when memory.events max was rising", () => {
    const hit = setup();
    hit.previous.recordFull({ atMs: kSampleMs, usedBytes: 92 * kGb, limitBytes: kLimit, limitHit: true });
    expect(hit.next.consumeAtBoot({ processStartedAtMs: kSampleMs + 60_000 })).toMatchObject({ usedBytes: 92 * kGb });
    const quiet = setup();
    quiet.previous.recordFull({ atMs: kSampleMs, usedBytes: 92 * kGb, limitBytes: kLimit, limitHit: false });
    expect(quiet.next.consumeAtBoot({ processStartedAtMs: kSampleMs + 60_000 })).toBeNull();
  });

  it("nothing is written while the container is not full, and a missing or torn file reads as no cause", () => {
    const { previous, next, filePath } = setup();
    previous.recordClear(kSampleMs);
    previous.markClean(kSampleMs);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(next.consumeAtBoot({ processStartedAtMs: kSampleMs })).toBeNull();
    fs.writeFileSync(filePath, "{not json");
    expect(next.consumeAtBoot({ processStartedAtMs: kSampleMs })).toBeNull();
  });

  it("a close that fails to write stays open and is retried, so no stale full record survives", () => {
    const { filePath, next } = setup();
    const fsModule = { ...fs, renameSync: vi.fn(() => { throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }); }) };
    const flaky = createContainerPressureRecord({ filePath, fsModule: { ...fs }, bootIdFn: () => "1:previous", logger: { warn: vi.fn() } });
    flaky.recordFull({ atMs: kSampleMs, usedBytes: 97 * kGb, limitBytes: kLimit });
    const failing = createContainerPressureRecord({ filePath, fsModule, bootIdFn: () => "1:previous", logger: { warn: vi.fn() } });
    failing.recordFull({ atMs: kSampleMs, usedBytes: 97 * kGb, limitBytes: kLimit });
    failing.recordClear(kSampleMs + 60_000);
    fsModule.renameSync = fs.renameSync;
    failing.markClean(kSampleMs + 120_000);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toMatchObject({ state: "clean_shutdown" });
    expect(next.consumeAtBoot({ processStartedAtMs: kSampleMs + 150_000 })).toBeNull();
  });

  it("a command that is not a plain token is withheld when read back", () => {
    const { previous, next } = setup();
    previous.recordFull({ atMs: kSampleMs, usedBytes: 97 * kGb, limitBytes: kLimit, largest: { command: "a b/../c", rssBytes: kGb } });
    expect(next.consumeAtBoot({ processStartedAtMs: kSampleMs + 60_000 }).largest).toEqual({ command: null, rssBytes: kGb });
  });
});
