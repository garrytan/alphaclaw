const fs = require("fs");
const os = require("os");
const path = require("path");

// Point the constants-derived default paths at a temp root before any module
// under test is required, so nothing touches the real ~/.alphaclaw.
const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-boot-id-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;

const {
  getProcessBootId,
  resetProcessBootIdForTests,
} = require("../../lib/server/boot-id");
// Loading this module memoizes the process boot id (its kDefaultBootId is
// derived from getProcessBootId at load), which the first test below relies
// on. Tests that reset the id therefore run AFTER it.
const {
  createRestartRequiredState,
} = require("../../lib/server/restart-required-state");

const kBootIdPattern = /^\d+:\d+$/;

const nullFlagStore = () => ({
  read: vi.fn(() => null),
  write: vi.fn(),
  clear: vi.fn(),
});

afterAll(() => {
  fs.rmSync(kTempRoot, { recursive: true, force: true });
});

describe("server/boot-id", () => {
  it("restart-required-state's default bootId is the shared process boot id", () => {
    // Runs first: no reset has happened since restart-required-state loaded.
    const store = createRestartRequiredState({
      isGatewayRunning: async () => true,
      flagStore: nullFlagStore(),
      stateDir: fs.mkdtempSync(path.join(kTempRoot, "store-")),
    });
    store.beginRestart();
    const record = store.getActiveRestartOperation();
    expect(record).not.toBeNull();
    expect(record.bootId).toBe(getProcessBootId());
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
