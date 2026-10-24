const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  kDoctorTimeoutCapMs,
  createDoctorTimeoutResolver,
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
