const fs = require("fs");
const os = require("os");
const path = require("path");

// Isolate this file's module graph onto a temp root BEFORE constants load, so
// gatewayEnv()'s config reads (which default to the real OPENCLAW_DIR) hit a
// clean directory instead of whatever the machine has.
const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autotune-env-test-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;
fs.mkdirSync(path.join(kTempRoot, ".openclaw", ".alphaclaw"), { recursive: true });

const { gatewayEnv } = require("../../lib/server/gateway");
const {
  resetMachineProfileForTests,
} = require("../../lib/server/machine-profile");
const { resetAutotuneForTests } = require("../../lib/server/autotune");

const kMb = 1024 * 1024;

const spyCgroupFiles = (files) => {
  const realReadFileSync = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((filePath, ...args) => {
    const key = String(filePath);
    if (key.startsWith("/sys/fs/cgroup")) {
      if (Object.prototype.hasOwnProperty.call(files, key)) return files[key];
      throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
    }
    return realReadFileSync(filePath, ...args);
  });
};

const containerFsModule = {
  existsSync: (p) => String(p) === "/.dockerenv",
  readFileSync: () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  },
};

describe("server/autotune gateway env integration", () => {
  const savedNodeOptions = process.env.NODE_OPTIONS;
  const savedUv = process.env.UV_THREADPOOL_SIZE;

  afterEach(() => {
    vi.restoreAllMocks();
    resetMachineProfileForTests();
    resetAutotuneForTests();
    process.env.ALPHACLAW_AUTOTUNE_DISABLED = "1"; // global test default
    if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = savedNodeOptions;
    if (savedUv === undefined) delete process.env.UV_THREADPOOL_SIZE;
    else process.env.UV_THREADPOOL_SIZE = savedUv;
  });

  it("REGRESSION: disabled autotune yields today's exact env — strip only, no re-add", () => {
    process.env.NODE_OPTIONS = "--max-old-space-size=4096 --inspect";
    delete process.env.UV_THREADPOOL_SIZE;

    const env = gatewayEnv();
    expect(env.NODE_OPTIONS).toBe("--inspect");
    expect(env.UV_THREADPOOL_SIZE).toBeUndefined();
  });

  it("enabled autotune re-adds the GATEWAY's derived heap after stripping the admin's, exactly once", () => {
    delete process.env.ALPHACLAW_AUTOTUNE_DISABLED;
    process.env.NODE_OPTIONS = "--max-old-space-size=4096 --inspect";
    delete process.env.UV_THREADPOOL_SIZE;
    spyCgroupFiles({
      "/sys/fs/cgroup/memory.max": `${2048 * kMb}\n`,
      "/sys/fs/cgroup/cpu.max": "100000 100000",
    });
    resetMachineProfileForTests({ fsModule: containerFsModule });

    const env = gatewayEnv();
    // Admin heap (4096) stripped; gateway heap (50% of 2GB = 1024) installed.
    expect(env.NODE_OPTIONS).toBe("--inspect --max-old-space-size=1024");
    expect(
      env.NODE_OPTIONS.match(/--max-old-space-size/g),
    ).toHaveLength(1);
    expect(env.UV_THREADPOOL_SIZE).toBe("4");
  });

  it("an operator-set UV_THREADPOOL_SIZE wins over the derived value", () => {
    delete process.env.ALPHACLAW_AUTOTUNE_DISABLED;
    process.env.UV_THREADPOOL_SIZE = "12";
    spyCgroupFiles({
      "/sys/fs/cgroup/memory.max": `${2048 * kMb}\n`,
      "/sys/fs/cgroup/cpu.max": "100000 100000",
    });
    resetMachineProfileForTests({ fsModule: containerFsModule });

    const env = gatewayEnv();
    expect(env.UV_THREADPOOL_SIZE).toBe("12");
  });

  it("suppressed detection (host values inside a container) leaves the env untouched", () => {
    delete process.env.ALPHACLAW_AUTOTUNE_DISABLED;
    delete process.env.NODE_OPTIONS;
    delete process.env.UV_THREADPOOL_SIZE;
    spyCgroupFiles({}); // no limit files readable
    resetMachineProfileForTests({ fsModule: containerFsModule });

    const env = gatewayEnv();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.UV_THREADPOOL_SIZE).toBeUndefined();
  });
});
