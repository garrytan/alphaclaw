// Storage selection follows pinned OpenClaw v2026.9.3 home-dir semantics,
// using the operation's captured environment without loading its runtime.
const os = require("os");
const path = require("path");
const { OfflineCopyError } = require("./openclaw-backup-errors");
const normalizeHome = (value) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed && trimmed !== "undefined" && trimmed !== "null" ? trimmed : undefined;
};
const refuse = (reason) => { throw new OfflineCopyError("inventory", reason); };
const rejectInterpolation = (value) => {
  if (value.includes("${")) refuse("unresolved environment reference in a storage path");
  return value;
};
const resolveOsHome = (spawnEnv) => {
  const explicit = normalizeHome(spawnEnv.HOME) || normalizeHome(spawnEnv.USERPROFILE);
  if (explicit) return explicit;
  const prefix = normalizeHome(spawnEnv.PREFIX);
  if (prefix && normalizeHome(spawnEnv.ANDROID_DATA) && /(?:^|\/)com\.termux\/files\/usr\/?$/.test(prefix.replace(/\\/g, "/"))) {
    return path.resolve(prefix, "..", "home");
  }
  try { return normalizeHome(os.homedir()); } catch { return undefined; }
};
const resolveEffectiveHome = (spawnEnv) => {
  const explicit = normalizeHome(spawnEnv.OPENCLAW_HOME);
  let raw = explicit || resolveOsHome(spawnEnv);
  if (explicit && /^~(?=$|[\\/])/.test(explicit)) {
    const fallback = resolveOsHome(spawnEnv);
    raw = fallback ? explicit.replace(/^~(?=$|[\\/])/, () => fallback) : undefined;
  }
  return path.resolve(rejectInterpolation(raw || process.cwd()));
};
const resolveBackupPath = (value, { spawnEnv = process.env, fallback } = {}) => {
  if (value !== undefined && typeof value !== "string") refuse("storage path must be a string when configured");
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (typeof raw !== "string" || !raw.trim()) refuse("storage path could not be resolved");
  const selected = rejectInterpolation(raw.trim());
  return path.resolve(selected.replace(/^~(?=$|[\\/])/, () => resolveEffectiveHome(spawnEnv)));
};

module.exports = { resolveBackupPath };
