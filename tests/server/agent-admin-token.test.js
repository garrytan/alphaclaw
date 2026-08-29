const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  kTokenFileName,
  resolveTokenPath,
  readToken,
  ensureToken,
  rotateToken,
  removeToken,
} = require("../../lib/server/agent-admin/token-store");

const createTempOpenclawDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "agent-admin-token-test-"));

// Some CI filesystems (Windows, certain overlay/tmpfs mounts) don't preserve
// POSIX mode bits; assert only where a probe file keeps the mode we set.
const platformPreservesFileMode = (openclawDir) => {
  try {
    const probe = path.join(openclawDir, ".mode-probe");
    fs.writeFileSync(probe, "x");
    fs.chmodSync(probe, 0o600);
    const preserved = (fs.statSync(probe).mode & 0o777) === 0o600;
    fs.unlinkSync(probe);
    return preserved;
  } catch {
    return false;
  }
};

describe("server/agent-admin/token-store", () => {
  it("mints a 64-hex-char token when absent and is idempotent", () => {
    const openclawDir = createTempOpenclawDir();

    const first = ensureToken({ openclawDir });
    expect(first.minted).toBe(true);
    expect(first.error).toBeNull();
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);

    const second = ensureToken({ openclawDir });
    expect(second.minted).toBe(false);
    expect(second.error).toBeNull();
    expect(second.token).toBe(first.token);
  });

  it("writes the token to <openclawDir>/.alphaclaw/agent-admin-token", () => {
    const openclawDir = createTempOpenclawDir();

    const { token } = ensureToken({ openclawDir });

    const expectedPath = path.join(openclawDir, ".alphaclaw", kTokenFileName);
    expect(resolveTokenPath({ openclawDir })).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
    // Persisted with a trailing newline; readToken hands back the trimmed value.
    expect(fs.readFileSync(expectedPath, "utf8")).toBe(`${token}\n`);
  });

  it("readToken returns the trimmed token and null when absent", () => {
    const openclawDir = createTempOpenclawDir();

    expect(readToken({ openclawDir })).toBeNull();

    const { token } = ensureToken({ openclawDir });
    expect(readToken({ openclawDir })).toBe(token);
    // No surrounding whitespace despite the on-disk trailing newline.
    expect(readToken({ openclawDir })).toBe(readToken({ openclawDir }).trim());
  });

  it("rotateToken produces a different token that readToken reflects", () => {
    const openclawDir = createTempOpenclawDir();

    const original = ensureToken({ openclawDir }).token;
    // Prime the mtime/size parse cache before rotating.
    expect(readToken({ openclawDir })).toBe(original);

    const rotated = rotateToken({ openclawDir });
    expect(rotated).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated).not.toBe(original);
    // The module nulls its cache on write, so the new value is observed.
    expect(readToken({ openclawDir })).toBe(rotated);
  });

  it("removeToken deletes the file and returns true, tolerating ENOENT", () => {
    const openclawDir = createTempOpenclawDir();
    const tokenPath = resolveTokenPath({ openclawDir });

    ensureToken({ openclawDir });
    expect(fs.existsSync(tokenPath)).toBe(true);

    expect(removeToken({ openclawDir })).toBe(true);
    expect(fs.existsSync(tokenPath)).toBe(false);
    expect(readToken({ openclawDir })).toBeNull();

    // Idempotent: removing an already-absent token still returns true.
    expect(removeToken({ openclawDir })).toBe(true);
  });

  it("returns an error (never throws) when the token dir cannot be created", () => {
    const openclawDir = createTempOpenclawDir();
    const fsModule = {
      // readToken's stat probe reports "absent" so ensureToken proceeds to write.
      statSync: () => {
        const error = new Error("ENOENT");
        error.code = "ENOENT";
        throw error;
      },
      mkdirSync: () => {
        throw new Error("mkdir denied");
      },
    };

    let result;
    expect(() => {
      result = ensureToken({ openclawDir, fsModule });
    }).not.toThrow();
    expect(result.token).toBeNull();
    expect(result.minted).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe("mkdir denied");
  });

  it("creates the token file with 0600 permissions where the FS supports it", () => {
    const openclawDir = createTempOpenclawDir();
    ensureToken({ openclawDir });
    const tokenPath = resolveTokenPath({ openclawDir });

    if (!platformPreservesFileMode(openclawDir)) return;
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
  });
});
