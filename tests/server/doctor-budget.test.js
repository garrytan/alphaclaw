const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  kDoctorTimeoutCapMs,
  createDoctorTimeoutResolver,
  resolveDoctorLintTimeoutMs,
  resolveDoctorTimeoutMs,
} = require("../../lib/server/doctor-budget");

const kGib = 1024 ** 3;
const kMinute = 60 * 1000;

describe("doctor --fix ceiling sized from the state (ALPH-23)", () => {
  it("keeps the floor for a small state", () => {
    expect(resolveDoctorTimeoutMs({ stateBytes: 0, floorMs: 30 * kMinute })).toBe(30 * kMinute);
    expect(resolveDoctorTimeoutMs({ stateBytes: 4 * kGib, floorMs: 30 * kMinute })).toBe(30 * kMinute);
  });

  it("gives 150 s per GiB above the floor: three times the measured 50 s per GiB", () => {
    // The measured 16 GB upgrade took 747 s; its ceiling is 40 min.
    expect(resolveDoctorTimeoutMs({ stateBytes: 16 * kGib, floorMs: 30 * kMinute })).toBe(40 * kMinute);
    expect(resolveDoctorTimeoutMs({ stateBytes: 30 * kGib, floorMs: 30 * kMinute })).toBe(75 * kMinute);
    expect(resolveDoctorTimeoutMs({ stateBytes: 16 * kGib, floorMs: 10 * kMinute })).toBe(40 * kMinute);
  });

  it("caps the ceiling so a wedged Doctor still ends", () => {
    expect(resolveDoctorTimeoutMs({ stateBytes: 1000 * kGib, floorMs: 30 * kMinute })).toBe(kDoctorTimeoutCapMs);
  });

  it("measures each SQLite database with its sidecars", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-budget-"));
    const db = path.join(root, "openclaw-agent.sqlite");
    fs.writeFileSync(db, "");
    fs.writeFileSync(db + "-wal", "");
    const sizes = { [db]: 12 * kGib, [db + "-wal"]: 4 * kGib };
    const fsModule = {
      ...fs,
      lstatSync: (target) => ({ isFile: () => true, size: sizes[target] ?? 0 }),
    };
    const resolve = createDoctorTimeoutResolver({ listStateDbFiles: () => [db], fsModule });
    expect(resolve(30 * kMinute)).toBe(40 * kMinute);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("falls back to the floor when the state cannot be listed", () => {
    const logger = { warn: vi.fn() };
    const resolve = createDoctorTimeoutResolver({
      listStateDbFiles: () => {
        throw new Error("EACCES");
      },
      logger,
    });
    expect(resolve(30 * kMinute)).toBe(30 * kMinute);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
  });
});

describe("full doctor --lint ceiling adds the state term to its floor (#488)", () => {
  const kSecond = 1000;

  it("lets a lint of 0.72 GiB of state run past the 135 s it took by hand", () => {
    const stateBytes = 0.72 * kGib;
    expect(resolveDoctorLintTimeoutMs({ stateBytes, floorMs: 60 * kSecond })).toBeGreaterThanOrEqual(135 * kSecond);
    expect(resolveDoctorLintTimeoutMs({ stateBytes, floorMs: 60 * kSecond })).toBe(168 * kSecond);
  });

  it("keeps the floor for an empty state and caps a huge one", () => {
    expect(resolveDoctorLintTimeoutMs({ stateBytes: 0, floorMs: 60 * kSecond })).toBe(60 * kSecond);
    expect(resolveDoctorLintTimeoutMs({ stateBytes: 1000 * kGib, floorMs: 60 * kSecond })).toBe(kDoctorTimeoutCapMs);
  });

  it("is what a resolver built for the lint measures with, leaving the --fix resolver unchanged", () => {
    const db = "/state/openclaw-agent.sqlite";
    const fsModule = { ...fs, lstatSync: (target) => ({ isFile: () => true, size: target === db ? 0.72 * kGib : 0 }) };
    const lint = createDoctorTimeoutResolver({ listStateDbFiles: () => [db], fsModule, resolve: resolveDoctorLintTimeoutMs });
    const fix = createDoctorTimeoutResolver({ listStateDbFiles: () => [db], fsModule });
    expect(lint(60 * kSecond)).toBe(168 * kSecond);
    expect(fix(60 * kSecond)).toBe(108 * kSecond);
  });
});

describe("boot wiring of the lint ceiling (#488)", () => {
  it("sizes the lint runner's ceiling with the lint resolver", () => {
    const serverSource = fs.readFileSync(path.join(__dirname, "../../lib/server.js"), "utf8");
    expect(serverSource).toMatch(/resolve: resolveDoctorLintTimeoutMs,/);
    expect(serverSource).toMatch(/resolveTimeoutMs: \(floorMs\) => resolveDoctorLintCeilingMs\(floorMs\),/);
  });
});
