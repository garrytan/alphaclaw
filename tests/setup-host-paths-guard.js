// Vitest globalSetup: fail the run if it created or changed a host path that
// AlphaClaw's `start` verb writes by default.
//
// WHY: `alphaclaw start` installs its git auth shim at /usr/local/bin/git
// unless ALPHACLAW_GIT_SHIM_PATH names another path, and /usr/local/bin is
// writable on many dev boxes (Homebrew) and on Capy machines (777). A bin test
// that booted without the override left a shim behind that pointed at a
// deleted temp askpass and shadowed git for the whole machine. Each guarded
// path has a test override (ALPHACLAW_GIT_SHIM_PATH,
// ALPHACLAW_OPENCLAW_WRAPPER_PATH, ALPHACLAW_PROFILE_SNIPPET_PATH,
// ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL): a test that runs `start` must set it.
import crypto from "node:crypto";
import fs from "node:fs";

export const kGuardedHostPaths = Object.freeze([
  "/usr/local/bin/git",
  "/usr/local/bin/openclaw",
  "/etc/profile.d/alphaclaw-openclaw.sh",
  "/etc/cron.d/openclaw-hourly-sync",
]);

export const fingerprintHostPath = (filePath) => {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return "absent";
    return `unreadable:${error?.code || error?.message}`;
  }
  if (stat.isSymbolicLink()) return `symlink:${fs.readlinkSync(filePath)}`;
  if (!stat.isFile()) return `other:mode=${stat.mode}`;
  try {
    const digest = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    return `file:mode=${stat.mode}:sha256=${digest}`;
  } catch (error) {
    return `file:mode=${stat.mode}:size=${stat.size}:mtime=${stat.mtimeMs}:unreadable=${error?.code}`;
  }
};

export const describeHostPathChanges = (before, after) =>
  Object.keys(before)
    .filter((filePath) => before[filePath] !== after[filePath])
    .map((filePath) => `${filePath}: ${before[filePath]} -> ${after[filePath]}`);

export const createHostPathsGuard = (paths) => {
  const snapshot = () =>
    Object.fromEntries(paths.map((filePath) => [filePath, fingerprintHostPath(filePath)]));
  const before = snapshot();
  return () => {
    const changes = describeHostPathChanges(before, snapshot());
    if (!changes.length) return;
    throw new Error(
      "[host-paths-guard] the test run created or changed host paths that `alphaclaw start` writes by default. " +
        "Give the test that boots `start` a temp ALPHACLAW_GIT_SHIM_PATH / ALPHACLAW_OPENCLAW_WRAPPER_PATH / " +
        "ALPHACLAW_PROFILE_SNIPPET_PATH or ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL=true, then remove the leftover:\n" +
        changes.join("\n"),
    );
  };
};

export default function guardHostPaths() {
  return createHostPathsGuard(kGuardedHostPaths);
}
