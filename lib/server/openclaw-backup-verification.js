// Format 3 lists files individually. Upstream's directory coverage contract
// deliberately stays in the old verifier; it cannot prove a minimal archive.
const kListingTailBytes = 16 * 1024 * 1024;
const path = require("path");
const safeRelative = (value) => typeof value === "string" && value.length > 0 &&
  !value.startsWith("/") && !/[\x00-\x1f\x7f\\]/.test(value) &&
  value.split("/").every((part) => part && part !== "." && part !== "..");
const keyOf = (asset) => `${asset?.sourcePath}\0${asset?.archivePath}\0${asset?.kind}`;

const verifyFormat3Payload = async ({ manifest, requiredAssets, file, runCommand, timeoutMs }) => {
  const fail = (reason) => ({ ok: false, stage: "assets", reason, manifest });
  if (!["full", "migration-minimal"].includes(manifest.profile) || !safeRelative(manifest.archiveRoot) || manifest.archiveRoot.includes("/")) {
    return fail("format 3 has an invalid profile or archive root");
  }
  if (manifest.schemaVersion !== 1 || !Number.isFinite(manifest.snapshotStartedAt) ||
    !Number.isFinite(manifest.snapshotCompletedAt) || manifest.snapshotCompletedAt < manifest.snapshotStartedAt) {
    return fail("format 3 has an invalid snapshot interval");
  }
  if (manifest.profile === "migration-minimal" && (manifest.partial !== true || manifest.options?.includeWorkspace !== false ||
    manifest.coverage?.migration !== "complete" || manifest.coverage?.workspace !== "omitted" || manifest.coverage?.core !== "partial")) {
    return fail("migration-minimal archive has inconsistent coverage");
  }
  if (!Array.isArray(manifest.requiredAssets) || !Array.isArray(manifest.assets) || typeof manifest.paths?.stateDir !== "string") return fail("format 3 is missing its required file inventory or state root");
  if (manifest.profile === "migration-minimal" && !Array.isArray(requiredAssets)) {
    return fail("migration-minimal verification requires an independent required file inventory");
  }
  const expected = requiredAssets || manifest.requiredAssets;
  if (new Set(expected.map(keyOf)).size !== expected.length) return fail("duplicate independent required asset");
  const assetKeys = new Set();
  const paths = new Set();
  const directories = new Set([manifest.archiveRoot]);
  for (const asset of manifest.assets) {
    if (!safeRelative(asset?.archivePath) || asset.archivePath === "manifest.json" || typeof asset.sourcePath !== "string" ||
      !["file", "sqlite", "config", "workspace"].includes(asset.kind)) return fail("invalid format 3 file asset");
    if (path.resolve(manifest.paths.stateDir, asset.archivePath) !== path.resolve(asset.sourcePath)) return fail("format 3 asset names a foreign source root");
    if (paths.has(asset.archivePath)) return fail(`duplicate archive path ${asset.archivePath}`);
    paths.add(asset.archivePath);
    assetKeys.add(keyOf(asset));
    let parent = path.posix.dirname(asset.archivePath);
    while (parent !== ".") {
      directories.add(`${manifest.archiveRoot}/${parent}`);
      parent = path.posix.dirname(parent);
    }
  }
  const declaredKeys = new Set(manifest.requiredAssets.map(keyOf));
  if (declaredKeys.size !== manifest.requiredAssets.length) return fail("duplicate required asset");
  if (declaredKeys.size !== assetKeys.size || [...assetKeys].some((key) => !declaredKeys.has(key))) {
    return fail("declared files do not match the complete required inventory");
  }
  for (const required of expected) {
    if (!safeRelative(required?.archivePath) || !assetKeys.has(keyOf(required)) || !declaredKeys.has(keyOf(required))) {
      return fail(`required file inventory does not match ${required?.archivePath || "an asset"}`);
    }
  }
  if (requiredAssets && (expected.length !== manifest.requiredAssets.length || expected.some((asset) => !declaredKeys.has(keyOf(asset))))) {
    return fail("required file inventory changed during archive creation");
  }
  let listed;
  try {
    listed = await runCommand({ command: "tar", args: ["-tvzf", file, "--numeric-owner", "--full-time", "--quoting-style=literal"],
      timeoutMs, tailBytes: kListingTailBytes });
  } catch (error) { return fail(`archive members could not be listed: ${error.message}`); }
  if (!listed?.ok) return fail("archive members could not be listed");
  if (listed.truncated === true || Buffer.byteLength(String(listed.tail || "")) >= kListingTailBytes) {
    return fail("archive member listing was truncated; complete payload membership cannot be verified");
  }
  const members = new Map();
  for (const line of String(listed.tail || "").split("\n").filter(Boolean)) {
    const match = /^([^-\s]|-)\S*\s+\S+\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)? (.+)$/.exec(line);
    if (!match) return fail("archive member listing is incomplete or malformed");
    const member = match[1] === "d" ? match[2].replace(/\/$/, "") : match[2];
    if (!safeRelative(member) || !(member === manifest.archiveRoot || member.startsWith(`${manifest.archiveRoot}/`))) {
      return fail("archive member lies outside the expected root");
    }
    if (match[1] !== "-" && match[1] !== "d") return fail("archive contains a non-regular file or directory member");
    const relative = member.slice(manifest.archiveRoot.length + 1);
    if ((match[1] === "d" && !directories.has(member)) ||
      (match[1] === "-" && relative !== "manifest.json" && !paths.has(relative))) {
      return fail(`archive contains an undeclared member ${member}`);
    }
    if (members.has(member)) return fail(`duplicate archive member ${member}`);
    members.set(member, match[1]);
  }
  if (members.get(`${manifest.archiveRoot}/manifest.json`) !== "-") return fail("archive is missing its regular-file manifest");
  // Every declared file is verified, including full-profile workspace files.
  // A smaller caller-required subset cannot excuse a missing declared asset.
  for (const required of manifest.assets) {
    if (members.get(`${manifest.archiveRoot}/${required.archivePath}`) !== "-") {
      return fail(`required regular-file payload is missing: ${required.archivePath}`);
    }
  }
  return { ok: true };
};

module.exports = { verifyFormat3Payload, safeRelative };
