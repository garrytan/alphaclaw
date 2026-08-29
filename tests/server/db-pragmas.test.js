const fs = require("fs");
const { applyOperationalPragmas } = require("../../lib/server/db/pragmas");
const {
  resetMachineProfileForTests,
} = require("../../lib/server/machine-profile");
const { resetAutotuneForTests } = require("../../lib/server/autotune");

const kMb = 1024 * 1024;

const makeDb = () => {
  const statements = [];
  return { statements, exec: (sql) => statements.push(sql) };
};

describe("server/db/pragmas", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetMachineProfileForTests();
    resetAutotuneForTests();
    process.env.ALPHACLAW_AUTOTUNE_DISABLED = "1";
  });

  it("REGRESSION: autotune off applies exactly the legacy pragma set — no cache pragma", () => {
    const db = makeDb();
    applyOperationalPragmas(db);
    expect(db.statements).toEqual([
      "PRAGMA busy_timeout = 10000;",
      "PRAGMA journal_mode=WAL;",
      "PRAGMA synchronous=NORMAL;",
    ]);
  });

  it("sizes the page cache with NEGATIVE KiB semantics when autotune is active", () => {
    // Positive cache_size is a PAGE count; KiB sizing requires negative.
    delete process.env.ALPHACLAW_AUTOTUNE_DISABLED;
    const realReadFileSync = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((filePath, ...args) => {
      const key = String(filePath);
      if (key === "/sys/fs/cgroup/memory.max") return `${2048 * kMb}\n`;
      if (key === "/sys/fs/cgroup/cpu.max") return "100000 100000";
      if (key.startsWith("/sys/fs/cgroup")) {
        throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
      }
      return realReadFileSync(filePath, ...args);
    });
    resetMachineProfileForTests({
      fsModule: {
        existsSync: (p) => String(p) === "/.dockerenv",
        readFileSync: () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
      },
    });

    const db = makeDb();
    applyOperationalPragmas(db, { busyTimeoutMs: 5000 });
    // 2GB → clamp(2048/128, 2, 64) = 16MB = -16384 KiB.
    expect(db.statements).toEqual([
      "PRAGMA busy_timeout = 5000;",
      "PRAGMA journal_mode=WAL;",
      "PRAGMA synchronous=NORMAL;",
      "PRAGMA cache_size = -16384;",
    ]);
  });
});
