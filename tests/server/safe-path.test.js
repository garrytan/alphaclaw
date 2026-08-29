const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  resolveCanonicalPath,
  resolveContainedPath,
  isPathInsideRoot,
} = require("../../lib/server/utils/safe-path");

const createRoot = () =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-safe-path-")));

describe("utils/safe-path", () => {
  it("resolves an existing file to its canonical path", () => {
    const root = createRoot();
    fs.writeFileSync(path.join(root, "a.txt"), "hi", "utf8");
    const result = resolveContainedPath(path.join(root, "a.txt"), root);
    expect(result.ok).toBe(true);
    expect(result.absolutePath).toBe(path.join(root, "a.txt"));
  });

  it("allows a not-yet-existing target under the root (write path)", () => {
    const root = createRoot();
    const result = resolveContainedPath(path.join(root, "sub", "new.txt"), root);
    expect(result.ok).toBe(true);
    expect(result.absolutePath).toBe(path.join(root, "sub", "new.txt"));
  });

  it("rejects a symlink inside the root pointing outside it", () => {
    const root = createRoot();
    const outside = createRoot();
    fs.writeFileSync(path.join(outside, "secret.txt"), "s", "utf8");
    fs.symlinkSync(outside, path.join(root, "esc"));
    const result = resolveContainedPath(
      path.join(root, "esc", "secret.txt"),
      root,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a dangling symlink escaping the root (never treated as missing tail)", () => {
    const root = createRoot();
    const outside = createRoot();
    // Points outside root; target does not exist yet.
    fs.symlinkSync(path.join(outside, "planted.txt"), path.join(root, "esc"));
    const result = resolveContainedPath(path.join(root, "esc"), root);
    expect(result.ok).toBe(false);
  });

  it("resolveCanonicalPath re-appends the missing tail to the real base", () => {
    const root = createRoot();
    const canonical = resolveCanonicalPath(path.join(root, "x", "y.txt"));
    expect(canonical).toBe(path.join(root, "x", "y.txt"));
  });

  it("isPathInsideRoot treats the root itself as inside", () => {
    expect(isPathInsideRoot("/a/b", "/a/b")).toBe(true);
    expect(isPathInsideRoot("/a/b/c", "/a/b")).toBe(true);
    expect(isPathInsideRoot("/a/bc", "/a/b")).toBe(false);
  });
});
