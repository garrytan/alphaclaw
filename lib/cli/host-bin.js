const fs = require("fs");
const path = require("path");

// Where `alphaclaw start` installs the binaries it provides (the git auth
// shim, the systemctl shim, gog). A root install (the Docker images) keeps the
// machine-wide /usr/local/bin. A non-root install keeps them under its own
// root (<ALPHACLAW_ROOT_DIR>/bin, put first on the runtime PATH): writing
// /usr/local/bin as a normal user (writable on Homebrew setups and some dev
// boxes) shadowed git for every process on the machine.
const kSystemBinDir = "/usr/local/bin";

const isRootProcess = ({ getuid = process.getuid } = {}) =>
  typeof getuid !== "function" || getuid() === 0;

const resolveHostBinDir = ({ rootDir, isRoot = isRootProcess() } = {}) =>
  isRoot ? kSystemBinDir : path.join(rootDir, "bin");

const prependPathDir = (dir, currentPath = "") => {
  const entries = String(currentPath || "")
    .split(path.delimiter)
    .filter((entry) => entry && entry !== dir);
  return [dir, ...entries].join(path.delimiter);
};

const kGitShimHeader = "# Git auth shim -- injects GITHUB_TOKEN credentials";

// A non-root install that an earlier AlphaClaw put at /usr/local/bin/git keeps
// shadowing git machine-wide after the move. Remove it only when it is
// provably this install's shim: the managed header and this install's repo
// root. Anything else (another install's shim, a real git) is left alone.
const removeStaleSystemGitShim = ({
  fsModule = fs,
  shimPath = path.join(kSystemBinDir, "git"),
  openclawDir,
} = {}) => {
  let content;
  try {
    if (!fsModule.lstatSync(shimPath).isFile()) return false;
    content = fsModule.readFileSync(shimPath, "utf8");
  } catch {
    return false;
  }
  const ownsRepoRoot = content
    .split("\n")
    .includes(`OPENCLAW_REPO_ROOT="${openclawDir}"`);
  if (!content.includes(kGitShimHeader) || !ownsRepoRoot) return false;
  try {
    fsModule.unlinkSync(shimPath);
    return true;
  } catch {
    return false;
  }
};

module.exports = {
  kSystemBinDir,
  isRootProcess,
  resolveHostBinDir,
  prependPathDir,
  removeStaleSystemGitShim,
};
