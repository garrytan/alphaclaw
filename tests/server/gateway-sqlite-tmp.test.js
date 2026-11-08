const fs = require("fs");
const os = require("os");
const path = require("path");

// Same isolation idiom as gateway-env-allowlist.test.js: point the module
// graph at a temp root BEFORE constants load, then drive the real gatewayEnv().
const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gw-sqlite-tmp-test-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;
fs.mkdirSync(path.join(kTempRoot, ".openclaw", ".alphaclaw"), { recursive: true });

const { gatewayEnv } = require("../../lib/server/gateway");

const kGatewaySqliteTmpDir = path.join(kTempRoot, "tmp", "gateway-sqlite");

const withEnv = (overrides, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

const modeOf = (target) => fs.statSync(target).mode & 0o777;

afterAll(() => {
  fs.rmSync(kTempRoot, { recursive: true, force: true });
});

describe("gatewayEnv() gives SQLite a temp dir on the data volume", () => {
  beforeEach(() => {
    fs.rmSync(path.join(kTempRoot, "tmp"), { recursive: true, force: true });
  });

  it("supplies <root>/tmp/gateway-sqlite at mode 0700 when neither TMPDIR nor SQLITE_TMPDIR is set", () => {
    withEnv({ TMPDIR: undefined, SQLITE_TMPDIR: undefined }, () => {
      const env = gatewayEnv();
      expect(env.SQLITE_TMPDIR).toBe(kGatewaySqliteTmpDir);
      expect(env).not.toHaveProperty("TMPDIR");
      expect(fs.statSync(kGatewaySqliteTmpDir).isDirectory()).toBe(true);
      if (process.platform !== "win32") expect(modeOf(kGatewaySqliteTmpDir)).toBe(0o700);
    });
  });

  it("adds nothing when the deployment (a template) sets TMPDIR: SQLite already falls back to it", () => {
    withEnv({ TMPDIR: "/data/tmp", SQLITE_TMPDIR: undefined }, () => {
      const env = gatewayEnv();
      expect(env.TMPDIR).toBe("/data/tmp");
      expect(env).not.toHaveProperty("SQLITE_TMPDIR");
      expect(fs.existsSync(kGatewaySqliteTmpDir)).toBe(false);
    });
  });

  it("passes an operator-set SQLITE_TMPDIR through unchanged and adds nothing", () => {
    withEnv({ TMPDIR: undefined, SQLITE_TMPDIR: "/data/sqlite-tmp" }, () => {
      const env = gatewayEnv();
      expect(env.SQLITE_TMPDIR).toBe("/data/sqlite-tmp");
      expect(env).not.toHaveProperty("TMPDIR");
      expect(fs.existsSync(kGatewaySqliteTmpDir)).toBe(false);
    });
  });

  it("keeps both operator values when the template sets TMPDIR and SQLITE_TMPDIR", () => {
    withEnv({ TMPDIR: "/data/tmp", SQLITE_TMPDIR: "/data/tmp" }, () => {
      const env = gatewayEnv();
      expect(env.TMPDIR).toBe("/data/tmp");
      expect(env.SQLITE_TMPDIR).toBe("/data/tmp");
      expect(fs.existsSync(kGatewaySqliteTmpDir)).toBe(false);
    });
  });

  it.skipIf(process.platform === "win32")("tightens an existing dir back to 0700", () => {
    fs.mkdirSync(kGatewaySqliteTmpDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(kGatewaySqliteTmpDir, 0o755);
    withEnv({ TMPDIR: undefined, SQLITE_TMPDIR: undefined }, () => {
      expect(gatewayEnv().SQLITE_TMPDIR).toBe(kGatewaySqliteTmpDir);
      expect(modeOf(kGatewaySqliteTmpDir)).toBe(0o700);
    });
  });

  it.skipIf(process.platform === "win32")("refuses a symlink in place of the dir and leaves SQLite on its default", () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "gw-sqlite-elsewhere-"));
    fs.mkdirSync(path.join(kTempRoot, "tmp"), { recursive: true });
    fs.symlinkSync(elsewhere, kGatewaySqliteTmpDir);
    try {
      withEnv({ TMPDIR: undefined, SQLITE_TMPDIR: undefined }, () => {
        expect(gatewayEnv()).not.toHaveProperty("SQLITE_TMPDIR");
      });
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("sweepGatewaySqliteTmpDir", () => {
  let dir;
  const kNowMs = Date.parse("2026-11-08T18:30:00.000Z");
  const write = (name, ageMs) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "x".repeat(4096));
    const at = new Date(kNowMs - ageMs);
    fs.utimesSync(file, at, at);
    return file;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-sqlite-sweep-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("removes only stale SQLite temp files and leaves everything else", () => {
    const { sweepGatewaySqliteTmpDir } = require("../../lib/server/gateway-sqlite-tmp");
    const logger = { log: vi.fn(), warn: vi.fn() };
    const stale = write("etilqs_3f9a0c1d2b4e5f60", 60 * 60_000);
    const staleJournal = write("etilqs_aa01-journal", 60 * 60_000);
    const fresh = write("etilqs_77aa00", 60_000);
    const foreign = write("notes.txt", 60 * 60_000);
    const lookalike = write("etilqs_not-hex", 60 * 60_000);
    fs.mkdirSync(path.join(dir, "etilqs_abc"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gw-sqlite-outside-"));
    const target = path.join(outside, "keep.db");
    fs.writeFileSync(target, "keep");
    fs.symlinkSync(target, path.join(dir, "etilqs_dead"));
    try {
      const result = sweepGatewaySqliteTmpDir({ dir, nowMs: kNowMs, logger });
      expect(result).toMatchObject({ removed: 2, freedBytes: expect.any(Number) });
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(staleJournal)).toBe(false);
      for (const kept of [fresh, foreign, lookalike, path.join(dir, "etilqs_abc"), path.join(dir, "etilqs_dead"), target]) {
        expect(fs.existsSync(kept)).toBe(true);
      }
      expect(logger.log).toHaveBeenCalledTimes(1);
      expect(logger.log.mock.calls[0][0]).toMatch(/^\[alphaclaw\] gateway SQLite temp sweep: removed 2 stale file/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("is silent and harmless when the dir does not exist", () => {
    const { sweepGatewaySqliteTmpDir } = require("../../lib/server/gateway-sqlite-tmp");
    const logger = { log: vi.fn(), warn: vi.fn() };
    const result = sweepGatewaySqliteTmpDir({ dir: path.join(dir, "missing"), nowMs: kNowMs, logger });
    expect(result).toMatchObject({ removed: 0 });
    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
