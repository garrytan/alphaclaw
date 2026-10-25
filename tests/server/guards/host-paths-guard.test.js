import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createHostPathsGuard,
  findTestLeftovers,
  fingerprintHostPath,
  kGuardedHostPaths,
} from "../../setup-host-paths-guard.js";

describe("tests/setup-host-paths-guard", () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-paths-guard-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("guards the default git shim path", () => {
    expect(kGuardedHostPaths).toContain("/usr/local/bin/git");
  });

  it("passes when nothing changed, an absent path included", () => {
    const present = path.join(dir, "present");
    fs.writeFileSync(present, "same");
    const teardown = createHostPathsGuard([present, path.join(dir, "absent")]);
    expect(() => teardown()).not.toThrow();
  });

  it("fails naming a created path", () => {
    const shim = path.join(dir, "git");
    const teardown = createHostPathsGuard([shim]);
    fs.writeFileSync(shim, "#!/bin/bash\n", { mode: 0o755 });
    expect(() => teardown()).toThrow(`${shim}: absent -> file:`);
  });

  it("finds a guarded file left by an earlier test run, and nothing else", () => {
    const leftover = path.join(dir, "git");
    const real = path.join(dir, "openclaw");
    fs.writeFileSync(leftover, 'OPENCLAW_REPO_ROOT="/tmp/alphaclaw-vitest-run-AbC123/alphaclaw-test-x/.openclaw"\n');
    fs.writeFileSync(real, 'OPENCLAW_REPO_ROOT="/data/.openclaw"\n');
    expect(findTestLeftovers([leftover, real, path.join(dir, "absent")])).toEqual([leftover]);
  });

  it("fails on rewritten content, a mode change, a replacement symlink and a removal", () => {
    const target = path.join(dir, "target");
    fs.writeFileSync(target, "one");
    const before = fingerprintHostPath(target);

    fs.writeFileSync(target, "two");
    expect(fingerprintHostPath(target)).not.toBe(before);

    fs.writeFileSync(target, "one");
    fs.chmodSync(target, 0o700);
    expect(fingerprintHostPath(target)).not.toBe(before);

    fs.rmSync(target);
    fs.symlinkSync("/usr/bin/git", target);
    expect(fingerprintHostPath(target)).toBe("symlink:/usr/bin/git");

    fs.rmSync(target);
    expect(fingerprintHostPath(target)).toBe("absent");
  });
});
