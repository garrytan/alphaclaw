// The lsof shim must SHIP: it lives under lib/ (package.json "files") and is
// found by the pinned CLI through PATH, so it needs its executable bit in the
// tarball — npm pack preserves the on-disk mode, which git tracks as 100755.
// `--ignore-scripts` skips prepack's UI build; the file list is the same.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const kRepoRoot = path.resolve(__dirname, "../..");
const kShimRel = "lib/server/lsof-shim/lsof";

describe("packaging: the lsof shim ships executable", () => {
  it("npm pack lists lib/server/lsof-shim/lsof and the file carries an execute bit", () => {
    const [pack] = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: kRepoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 60000,
      }),
    );
    const entry = pack.files.find((file) => file.path === kShimRel);
    expect(entry, `${kShimRel} missing from the tarball`).toBeTruthy();
    expect(pack.files.some((file) => file.path === "lib/server/lsof-shim/index.js")).toBe(true);
    expect(fs.statSync(path.join(kRepoRoot, kShimRel)).mode & 0o111).not.toBe(0);
    if (typeof entry.mode === "number") expect(entry.mode & 0o111).not.toBe(0);
  });

  it("git tracks the shim as an executable (mode 100755) so clones keep the bit", () => {
    let listing;
    try {
      listing = execFileSync("git", ["ls-files", "-s", "--", kShimRel], { cwd: kRepoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return; // not a git checkout (a packed install) — the stat check above covers it
    }
    if (!listing.trim()) return; // not yet staged in this working tree
    expect(listing.split(/\s+/)[0]).toBe("100755");
  });
});
