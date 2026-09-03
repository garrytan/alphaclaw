const fs = require("fs");
const os = require("os");
const path = require("path");

// Resource-cap plumbing: the telegram auto-scale formula's hard ceiling comes
// from autotune when active (machine supply) and falls back to the legacy 64
// when autotune is off. Driven through the REAL autotune path (repo style: no
// module mocks) by pointing the root at a temp dir and mocking cgroup files.
const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-tg-cap-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;
fs.mkdirSync(path.join(kTempRoot, ".openclaw", ".alphaclaw"), { recursive: true });

const {
  syncConfigForTelegram,
  resolveAgentConcurrencyCap,
} = require("../../lib/server/telegram-workspace");
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

const enableAutotuneOn = ({ memMb, cores }) => {
  delete process.env.ALPHACLAW_AUTOTUNE_DISABLED;
  spyCgroupFiles({
    "/sys/fs/cgroup/memory.max": `${memMb * kMb}\n`,
    "/sys/fs/cgroup/cpu.max": `${Math.round(cores * 100000)} 100000`,
  });
  resetMachineProfileForTests({ fsModule: containerFsModule });
};

const makeRegistry = (activeTopics) => ({
  getActiveTopicCount: () => activeTopics,
  getTotalTopicCount: () => activeTopics,
  getGroup: () => ({ topics: {} }),
});

const runSync = ({ activeTopics }) => {
  const openclawDir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "tg-cap-cfg-")),
    ".openclaw",
  );
  fs.mkdirSync(openclawDir, { recursive: true });
  fs.writeFileSync(
    path.join(openclawDir, "openclaw.json"),
    JSON.stringify({ channels: { telegram: { groups: { "-100": {} } } } }),
    "utf8",
  );
  syncConfigForTelegram({
    fs,
    openclawDir,
    groupId: "-100",
    topicRegistry: makeRegistry(activeTopics),
  });
  return JSON.parse(
    fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
  );
};

describe("server/telegram-workspace resource cap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetMachineProfileForTests();
    resetAutotuneForTests();
    process.env.ALPHACLAW_AUTOTUNE_DISABLED = "1"; // global test default
  });

  afterAll(() => {
    fs.rmSync(kTempRoot, { recursive: true, force: true });
  });

  it("caps the demand formula at the machine-derived ceiling", () => {
    // 1GB / 2 cores → cap = clamp(min(1024/64=16, 2*8=16), 8, 128) = 16.
    enableAutotuneOn({ memMb: 1024, cores: 2 });
    expect(resolveAgentConcurrencyCap()).toBe(16);
    // 20 topics × 3 = 60 demand, machine cap 16 wins.
    const cfg = runSync({ activeTopics: 20 });
    expect(cfg.agents.defaults.maxConcurrent).toBe(16);
    expect(cfg.agents.defaults.subagents.maxConcurrent).toBe(14);
  });

  it("lets big machines scale past the legacy 64 ceiling", () => {
    // 32GB / 16 cores → cap 128.
    enableAutotuneOn({ memMb: 32768, cores: 16 });
    expect(resolveAgentConcurrencyCap()).toBe(128);
    // 30 topics × 3 = 90 demand — allowed under the 128 machine cap.
    const cfg = runSync({ activeTopics: 30 });
    expect(cfg.agents.defaults.maxConcurrent).toBe(90);
  });

  it("REGRESSION: autotune off (kill-switch) keeps the legacy 64 ceiling", () => {
    expect(resolveAgentConcurrencyCap()).toBe(64);
    const cfg = runSync({ activeTopics: 30 });
    expect(cfg.agents.defaults.maxConcurrent).toBe(64);
  });
});
