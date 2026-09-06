// Keep-the-newest-N retention shared by every "<file>.<kind>-<stamp>.bak keep
// 3" family (doctor-guard's pre-doctor copies, the config gate's pre-restore
// copies and key-path diffs). Best-effort by contract: housekeeping must never
// turn the write that triggered it into a failure.
const fs = require("fs");
const os = require("os");
const path = require("path");

const { pruneFilesMatching } = require("../../lib/server/utils/file-retention");

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-file-retention-"));
const kPattern = /^openclaw\.json\.pre-restore-\d+\.bak$/;

// Distinct, ordered mtimes without sleeping: the retention sort reads mtime,
// so stamp it explicitly (seconds since epoch, ascending with `index`).
const writeStamped = (dir, name, index) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, name);
  const seconds = 1_700_000_000 + index * 60;
  fs.utimesSync(file, seconds, seconds);
  return file;
};

describe("server/utils/file-retention pruneFilesMatching", () => {
  it("keeps the newest N members by mtime and only touches files matching the pattern", () => {
    const dir = mkDir();
    for (let i = 0; i < 5; i += 1) {
      writeStamped(dir, `openclaw.json.pre-restore-${i}.bak`, i);
    }
    // Neighbours that must survive untouched.
    writeStamped(dir, "openclaw.json", 99);
    writeStamped(dir, "openclaw.json.pre-fix-1.0.0.bak", 0);

    const removed = pruneFilesMatching({ fsModule: fs, dir, pattern: kPattern, keep: 3 });

    expect(removed.sort()).toEqual([
      "openclaw.json.pre-restore-0.bak",
      "openclaw.json.pre-restore-1.bak",
    ]);
    expect(fs.readdirSync(dir).sort()).toEqual([
      "openclaw.json",
      "openclaw.json.pre-fix-1.0.0.bak",
      "openclaw.json.pre-restore-2.bak",
      "openclaw.json.pre-restore-3.bak",
      "openclaw.json.pre-restore-4.bak",
    ]);
  });

  it("evicts higher-ranked members first regardless of age (the consumed-snapshot rule)", () => {
    const dir = mkDir();
    // The NEWEST file is a consumed artifact that must not push older live
    // members out of the keep set.
    writeStamped(dir, "openclaw.json.pre-restore-1.bak", 1);
    writeStamped(dir, "openclaw.json.pre-restore-2.bak", 2);
    writeStamped(dir, "openclaw.json.pre-restore-3.consumed.bak", 3);
    const removed = pruneFilesMatching({
      fsModule: fs,
      dir,
      pattern: /^openclaw\.json\.pre-restore-.+\.bak$/,
      keep: 2,
      rank: (name) => (name.endsWith(".consumed.bak") ? 1 : 0),
    });
    expect(removed).toEqual(["openclaw.json.pre-restore-3.consumed.bak"]);
  });

  it("is best-effort: a missing dir, a bad pattern, a bad keep or a failing unlink never throw", () => {
    const dir = mkDir();
    writeStamped(dir, "openclaw.json.pre-restore-1.bak", 1);
    writeStamped(dir, "openclaw.json.pre-restore-2.bak", 2);

    expect(pruneFilesMatching({ fsModule: fs, dir: path.join(dir, "nope"), pattern: kPattern, keep: 1 })).toEqual([]);
    expect(pruneFilesMatching({ fsModule: fs, dir, pattern: "not-a-regexp", keep: 1 })).toEqual([]);
    expect(pruneFilesMatching()).toEqual([]);
    // keep: 0 (or garbage) means "keep nothing"; a failing unlink is skipped
    // and reported as NOT removed.
    const failingFs = {
      ...fs,
      unlinkSync: (file) => {
        if (file.endsWith("pre-restore-1.bak")) throw new Error("EBUSY");
        return fs.unlinkSync(file);
      },
    };
    expect(pruneFilesMatching({ fsModule: failingFs, dir, pattern: kPattern, keep: "many" })).toEqual([
      "openclaw.json.pre-restore-2.bak",
    ]);
    expect(fs.readdirSync(dir)).toEqual(["openclaw.json.pre-restore-1.bak"]);
  });
});
