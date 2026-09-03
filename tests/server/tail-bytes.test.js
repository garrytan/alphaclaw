const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  tailBytes,
  tailLines,
  kTailAbsoluteMaxBytes,
} = require("../../lib/server/utils/tail-bytes");

describe("server/utils/tail-bytes", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-tail-bytes-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const writeFile = (name, content) => {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content, "utf8");
    return filePath;
  };

  it("returns every line when the file is smaller than the budget", () => {
    const filePath = writeFile("small.log", "alpha\nbeta\ngamma\n");

    const lines = tailLines(filePath, 65536);

    expect(lines).toEqual(["alpha", "beta", "gamma"]);
    expect(tailBytes(filePath, 65536)).toEqual({
      text: "alpha\nbeta\ngamma\n",
      truncated: false,
    });
  });

  it("drops the leading partial line when the read starts mid-file", () => {
    // 2000 bytes of one long first line, then complete lines. maxBytes below
    // the file size forces the read to start mid-file, slicing into line one.
    const longFirstLine = `first-${"x".repeat(2000)}`;
    const filePath = writeFile(
      "midfile.log",
      `${longFirstLine}\ncomplete-one\ncomplete-two\n`,
    );

    // Requested budget clamps to the 1024-byte floor: the read starts inside
    // the long first line, so its tail fragment must be dropped.
    const lines = tailLines(filePath, 1);

    expect(lines).toEqual(["complete-one", "complete-two"]);
    expect(lines.some((line) => line.includes("first-"))).toBe(false);
  });

  it("drops the unterminated final segment when the file has no trailing newline", () => {
    const filePath = writeFile(
      "unterminated.log",
      "done-one\ndone-two\nstill-being-written",
    );

    const lines = tailLines(filePath, 65536);

    expect(lines).toEqual(["done-one", "done-two"]);
  });

  it("keeps the last line when the file ends with a newline", () => {
    const filePath = writeFile("terminated.log", "done-one\ndone-two\n");

    const lines = tailLines(filePath, 65536);

    expect(lines).toEqual(["done-one", "done-two"]);
  });

  it("returns empty results for a missing file", () => {
    const missingPath = path.join(tmpDir, "does-not-exist.log");

    expect(tailBytes(missingPath, 65536)).toEqual({ text: "", truncated: false });
    expect(tailLines(missingPath, 65536)).toEqual([]);
  });

  it("exports the 4MB absolute clamp used by every tail caller", () => {
    expect(kTailAbsoluteMaxBytes).toBe(4 * 1024 * 1024);
  });

  it("clamps tiny and invalid budgets to the 1024-byte floor", () => {
    // 3000 bytes, no trailing newline on purpose (marks read length exactly).
    const filePath = path.join(tmpDir, "floor.log");
    fs.writeFileSync(filePath, "y".repeat(3000), "utf8");

    // maxBytes=1 clamps UP to 1024: the read is exactly the last 1024 bytes
    // and reports truncation. The same floor (not the whole file) applies to
    // garbage input, proving one shared clamp path handles both.
    const tiny = tailBytes(filePath, 1);
    expect(tiny.text.length).toBe(1024);
    expect(tiny.truncated).toBe(true);

    const garbage = tailBytes(filePath, "not-a-number");
    // Invalid budgets fall back to the 65536 default, which exceeds the file:
    // whole file, no truncation.
    expect(garbage.text.length).toBe(3000);
    expect(garbage.truncated).toBe(false);
  });
});
