const fs = require("fs");
const os = require("os");
const path = require("path");

// Point the constants-derived default paths at a temp root before any module
// under test is required, so nothing touches the real ~/.alphaclaw. The
// runner's own value is restored in afterAll: this suite must not leak a
// dead temp path into whatever runs after it in the same worker.
const kOriginalRootDir = process.env.ALPHACLAW_ROOT_DIR;
const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-boot-id-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;

const kBootIdModule = "../../lib/server/boot-id";
const kRestartStateModule = "../../lib/server/restart-required-state";
const {
  getProcessBootId,
  resetProcessBootIdForTests,
} = require(kBootIdModule);

const kBootIdPattern = /^\d+:\d+$/;

const nullFlagStore = () => ({
  read: vi.fn(() => null),
  write: vi.fn(),
  clear: vi.fn(),
});

afterAll(() => {
  if (kOriginalRootDir === undefined) {
    delete process.env.ALPHACLAW_ROOT_DIR;
  } else {
    process.env.ALPHACLAW_ROOT_DIR = kOriginalRootDir;
  }
  fs.rmSync(kTempRoot, { recursive: true, force: true });
});

describe("server/boot-id", () => {
  it("restart-required-state's default bootId is the shared process boot id", () => {
    // Order-independent: restart-required-state derives its kDefaultBootId
    // from getProcessBootId() at LOAD, so a copy loaded before some other
    // case's reset would hold a stale id. Load fresh copies of BOTH modules
    // from one registry generation and compare inside it. This suite's
    // `require` resolves through Node's loader, whose cache vi.resetModules
    // does not touch, so that cache is cleared explicitly too.
    resetProcessBootIdForTests(); // simulate an earlier case's reset
    vi.resetModules();
    delete require.cache[require.resolve(kBootIdModule)];
    delete require.cache[require.resolve(kRestartStateModule)];
    const freshBootId = require(kBootIdModule);
    const { createRestartRequiredState } = require(kRestartStateModule);
    expect(freshBootId.getProcessBootId).not.toBe(getProcessBootId); // really a fresh copy

    const store = createRestartRequiredState({
      isGatewayRunning: async () => true,
      flagStore: nullFlagStore(),
      stateDir: fs.mkdtempSync(path.join(kTempRoot, "store-")),
    });
    store.beginRestart();
    const record = store.getActiveRestartOperation();
    expect(record).not.toBeNull();
    expect(record.bootId).toBe(freshBootId.getProcessBootId());
    expect(record.bootId).toMatch(kBootIdPattern);
    // A record from a previous process (different id) is foreign — the
    // reconciliation contract restart-required-state builds on.
    expect(record.bootId).not.toBe(`${process.pid + 1}:${Date.now()}`);
  });

  it("has the `${pid}:${startMs}` shape restart-required-state persisted before it", () => {
    const before = Date.now();
    resetProcessBootIdForTests();
    const id = getProcessBootId();
    const after = Date.now();
    expect(id).toMatch(kBootIdPattern);
    const [pid, startMs] = id.split(":").map(Number);
    expect(pid).toBe(process.pid);
    expect(startMs).toBeGreaterThanOrEqual(before);
    expect(startMs).toBeLessThanOrEqual(after);
  });

  it("is memoized: every call in a process returns the same value", () => {
    resetProcessBootIdForTests();
    const first = getProcessBootId({ nowFn: () => 1000 });
    // Later callers get the first value even when their clock moved on — one
    // id per process, so records written at different times still match.
    expect(getProcessBootId({ nowFn: () => 2000 })).toBe(first);
    expect(getProcessBootId()).toBe(first);
    expect(first).toBe(`${process.pid}:1000`);
  });

  it("resetProcessBootIdForTests forces a fresh id on the next call", () => {
    resetProcessBootIdForTests();
    const first = getProcessBootId({ nowFn: () => 1000 });
    resetProcessBootIdForTests();
    const second = getProcessBootId({ nowFn: () => 2000 });
    expect(second).toBe(`${process.pid}:2000`);
    expect(second).not.toBe(first);
    // Memoization resumes after the reset.
    expect(getProcessBootId({ nowFn: () => 3000 })).toBe(second);
  });
});
