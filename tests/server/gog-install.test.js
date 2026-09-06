const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const gog = require("../../lib/cli/gog-install");

// Fix wave F002 — the boot-time gog installer is data, never a shell string.
describe("lib/cli/gog-install", () => {
  it("accepts only semver-shaped GOG_VERSION values and falls back to the default otherwise", () => {
    expect(gog.resolveGogVersion("0.12.3")).toEqual({ version: "0.12.3", source: "env" });
    expect(gog.resolveGogVersion("")).toEqual({ version: gog.kDefaultGogVersion, source: "default" });
    for (const bad of ['0.11.0"; touch /tmp/pwned; echo "', "0.11.0 && id", "../x", "v0.11.0", "latest"]) {
      const resolved = gog.resolveGogVersion(bad);
      expect(resolved.version, bad).toBe(gog.kDefaultGogVersion);
      expect(resolved.rejected, bad).toBe(bad);
    }
  });

  it("builds an argv-friendly download plan without any shell metacharacters", () => {
    const plan = gog.buildGogDownloadPlan({ version: "0.11.0", platform: "linux", arch: "x64" });
    expect(plan).toEqual({
      tarball: "gogcli_0.11.0_linux_amd64.tar.gz",
      url: "https://github.com/steipete/gogcli/releases/download/v0.11.0/gogcli_0.11.0_linux_amd64.tar.gz",
      checksumsUrl: "https://github.com/steipete/gogcli/releases/download/v0.11.0/checksums.txt",
      memberName: "gog",
    });
    expect(() => gog.buildGogDownloadPlan({ version: "0.11.0; id", platform: "linux", arch: "x64" })).toThrow(/invalid gog version/);
  });

  it("accepts an archive listing with exactly one top-level `gog` member and refuses traversal, symlink-ish or ambiguous listings", () => {
    expect(gog.selectArchiveMember("gog\nREADME.md\nLICENSE\n")).toEqual({ ok: true, member: "gog" });
    expect(gog.selectArchiveMember("./gog\n")).toEqual({ ok: true, member: "./gog" });
    expect(gog.selectArchiveMember("README.md\n").ok).toBe(false);
    // Only the top-level member is ever extracted; a nested twin is ignored.
    expect(gog.selectArchiveMember("gog\nbin/gog\n")).toEqual({ ok: true, member: "gog" });
    expect(gog.selectArchiveMember("gog\n./gog\n").reason).toBe("member_ambiguous");
    expect(gog.selectArchiveMember("../../usr/local/bin/gog\n").reason).toBe("unsafe_entry");
    expect(gog.selectArchiveMember("/etc/passwd\ngog\n").reason).toBe("unsafe_entry");
  });

  it("parses a GitHub-style checksums.txt for the exact tarball and verifies a file hash", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-gog-"));
    try {
      const file = path.join(dir, "gogcli_0.11.0_linux_amd64.tar.gz");
      fs.writeFileSync(file, "not really a tarball");
      const digest = crypto.createHash("sha256").update("not really a tarball").digest("hex");
      const checksums = `${digest}  gogcli_0.11.0_linux_amd64.tar.gz\n${"0".repeat(64)}  gogcli_0.11.0_darwin_arm64.tar.gz\n`;
      expect(gog.parseChecksumsFile(checksums, "gogcli_0.11.0_linux_amd64.tar.gz")).toBe(digest);
      expect(gog.parseChecksumsFile(checksums, "gogcli_0.11.0_windows_amd64.zip")).toBeNull();
      expect(gog.sha256File(file)).toBe(digest);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifyExtractedBinary refuses symlinks, empty and oversized files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-gog-bin-"));
    try {
      const real = path.join(dir, "gog");
      fs.writeFileSync(real, "#!/bin/sh\necho gog\n");
      expect(gog.verifyExtractedBinary(real)).toMatchObject({ ok: true });
      const link = path.join(dir, "gog-link");
      fs.symlinkSync("/etc/passwd", link);
      expect(gog.verifyExtractedBinary(link)).toEqual({ ok: false, reason: "not_regular_file" });
      const empty = path.join(dir, "empty");
      fs.writeFileSync(empty, "");
      expect(gog.verifyExtractedBinary(empty)).toEqual({ ok: false, reason: "empty" });
      expect(gog.verifyExtractedBinary(path.join(dir, "missing")).reason).toBe("missing");
      const huge = { lstatSync: () => ({ isFile: () => true, size: gog.kMaxGogBinaryBytes + 1 }) };
      expect(gog.verifyExtractedBinary("/x", huge).reason).toBe("too_large");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
