const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const isEnabledEnvFlag = (value) =>
  ["1", "true", "yes", "on"].includes(
    String(value || "").trim().toLowerCase(),
  );

const shouldSkipSystemCronInstall = ({ env = process.env } = {}) =>
  isEnabledEnvFlag(env.ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL);

const resolveGitAskPassPath = ({ env = process.env, tmpDir = "/tmp" } = {}) => {
  const explicitPath = String(env.ALPHACLAW_GIT_ASKPASS_PATH || "").trim();
  if (explicitPath) return explicitPath;

  const runtimeTmpDir =
    String(env.TMPDIR || "").trim() || String(tmpDir || "").trim() || "/tmp";
  return path.join(runtimeTmpDir, "alphaclaw-git-askpass.sh");
};

const resolveGitShimPath = ({ env = process.env } = {}) => {
  const explicitPath = String(env.ALPHACLAW_GIT_SHIM_PATH || "").trim();
  return explicitPath || "/usr/local/bin/git";
};

const prependGitShimDirToPath = ({
  env = process.env,
  shimPath = resolveGitShimPath({ env }),
} = {}) => {
  if (!String(env.ALPHACLAW_GIT_SHIM_PATH || "").trim()) {
    return env.PATH || process.env.PATH || "";
  }
  const shimDir = path.dirname(String(shimPath || "").trim());
  if (!shimDir || shimDir === ".") return env.PATH || process.env.PATH || "";
  const pathEntries = String(env.PATH || process.env.PATH || "")
    .split(path.delimiter)
    .filter((entry) => entry && entry !== shimDir);
  return [shimDir, ...pathEntries].join(path.delimiter);
};

const normalizeGitSyncFilePath = (requestedFilePath) => {
  const rawPath = String(requestedFilePath || "").trim();
  if (!rawPath) return "";
  return rawPath.replace(/\\/g, "/").replace(/^\.\/+/, "");
};

const validateGitSyncFilePath = (normalizedFilePath) => {
  if (!normalizedFilePath) return { ok: true };
  if (
    normalizedFilePath.startsWith("/") ||
    normalizedFilePath.startsWith("../") ||
    normalizedFilePath.includes("/../")
  ) {
    return {
      ok: false,
      error: "[alphaclaw] --file must stay within /data/.openclaw",
    };
  }
  return { ok: true };
};

const listGitCandidates = ({ execSyncImpl = execSync } = {}) => {
  try {
    return String(
      execSyncImpl("which -a git", {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      }),
    )
      .split("\n")
      .map((candidate) => candidate.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

const canExecute = ({ fsModule = fs, candidatePath = "" } = {}) => {
  const normalizedCandidatePath = String(candidatePath || "").trim();
  if (!normalizedCandidatePath) return false;
  try {
    fsModule.accessSync(normalizedCandidatePath, fsModule.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const resolveRealGitPath = ({
  execSyncImpl = execSync,
  fsModule = fs,
  shimPath = "",
  hintedPath = "",
} = {}) => {
  const normalizedShimPath = String(shimPath || "").trim()
    ? path.resolve(String(shimPath || "").trim())
    : "";
  const candidates = [
    String(process.env.ALPHACLAW_REAL_GIT || "").trim(),
    String(hintedPath || "").trim(),
    "/usr/bin/git",
    "/bin/git",
    "/usr/libexec/git-core/git",
    "/usr/local/bin/git.real",
  ];

  for (const candidatePath of [...candidates, ...listGitCandidates({ execSyncImpl })]) {
    const normalizedCandidatePath = String(candidatePath || "").trim();
    if (!normalizedCandidatePath) continue;
    const resolvedCandidatePath = path.resolve(normalizedCandidatePath);
    if (normalizedShimPath && resolvedCandidatePath === normalizedShimPath) continue;
    if (!canExecute({ fsModule, candidatePath: resolvedCandidatePath })) continue;
    return resolvedCandidatePath;
  }

  return "";
};

const shouldRefreshHourlyGitSyncScript = ({
  packagedSyncScript = "",
  installedSyncScript = "",
} = {}) => {
  const nextPackagedSyncScript = String(packagedSyncScript || "");
  if (!nextPackagedSyncScript.trim()) return false;
  return nextPackagedSyncScript !== String(installedSyncScript || "");
};

module.exports = {
  shouldSkipSystemCronInstall,
  resolveGitAskPassPath,
  resolveGitShimPath,
  prependGitShimDirToPath,
  normalizeGitSyncFilePath,
  validateGitSyncFilePath,
  resolveRealGitPath,
  shouldRefreshHourlyGitSyncScript,
};
