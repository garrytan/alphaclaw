// Pure helpers for the boot-time gog CLI installer (bin/alphaclaw.js §8).
// Fix wave F002: the installer used to interpolate the agent-writable
// GOG_VERSION into a root `curl … | tar … | mv` shell string and extract the
// whole archive into /tmp. These helpers make every step data, never shell:
// a validated version, an argv download plan, an archive listing that must
// contain exactly the expected binary, and optional checksum verification.
const crypto = require("crypto");
const fs = require("fs");

const kGogVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const kDefaultGogVersion = "0.11.0";
const kMaxGogBinaryBytes = 200 * 1024 * 1024;

const isValidGogVersion = (value) => kGogVersionPattern.test(String(value ?? "").trim());

const resolveGogVersion = (rawValue) => {
  const candidate = String(rawValue ?? "").trim();
  if (!candidate) return { version: kDefaultGogVersion, source: "default" };
  if (isValidGogVersion(candidate)) return { version: candidate, source: "env" };
  return {
    version: kDefaultGogVersion,
    source: "default",
    rejected: candidate,
  };
};

const buildGogDownloadPlan = ({ version, platform, arch }) => {
  if (!isValidGogVersion(version)) throw new Error(`invalid gog version ${JSON.stringify(version)}`);
  const goPlatform = platform === "darwin" ? "darwin" : "linux";
  const goArch = arch === "arm64" ? "arm64" : "amd64";
  const tarball = `gogcli_${version}_${goPlatform}_${goArch}.tar.gz`;
  const base = `https://github.com/steipete/gogcli/releases/download/v${version}`;
  return {
    tarball,
    url: `${base}/${tarball}`,
    checksumsUrl: `${base}/checksums.txt`,
    memberName: "gog",
  };
};

// `tar -tzf` output: one path per line. Accept only when the expected member
// is present as a plain top-level regular file (no directory, no "..", no
// absolute path) — a crafted archive with a symlink or a path outside the
// extraction dir is refused before anything is extracted.
const selectArchiveMember = (listingText, memberName = "gog") => {
  const entries = String(listingText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const suspicious = entries.filter(
    (entry) => entry.startsWith("/") || entry.split("/").includes("..") || entry.includes("\0"),
  );
  if (suspicious.length > 0) {
    return { ok: false, reason: "unsafe_entry", entry: suspicious[0] };
  }
  const matches = entries.filter((entry) => entry === memberName || entry === `./${memberName}`);
  if (matches.length !== 1) {
    return { ok: false, reason: matches.length === 0 ? "member_missing" : "member_ambiguous" };
  }
  return { ok: true, member: matches[0] };
};

// GitHub-release style checksums.txt: "<sha256>  <filename>" per line.
const parseChecksumsFile = (text, tarballName) => {
  for (const line of String(text || "").split("\n")) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (!match) continue;
    if (match[2].trim() === tarballName) return match[1].toLowerCase();
  }
  return null;
};

const sha256File = (filePath, fsModule = fs) =>
  crypto.createHash("sha256").update(fsModule.readFileSync(filePath)).digest("hex");

// The extracted member must be a regular file (never a symlink or device) of
// a sane size before it is copied into /usr/local/bin.
const verifyExtractedBinary = (binaryPath, fsModule = fs) => {
  let stat;
  try {
    stat = fsModule.lstatSync(binaryPath);
  } catch (error) {
    return { ok: false, reason: "missing", error: error.message };
  }
  if (!stat.isFile()) return { ok: false, reason: "not_regular_file" };
  if (stat.size === 0) return { ok: false, reason: "empty" };
  if (stat.size > kMaxGogBinaryBytes) return { ok: false, reason: "too_large", size: stat.size };
  return { ok: true, size: stat.size };
};

module.exports = {
  kDefaultGogVersion,
  kGogVersionPattern,
  kMaxGogBinaryBytes,
  isValidGogVersion,
  resolveGogVersion,
  buildGogDownloadPlan,
  selectArchiveMember,
  parseChecksumsFile,
  sha256File,
  verifyExtractedBinary,
};
