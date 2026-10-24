const fs = require("fs");
const os = require("os");
const path = require("path");

// The GIT_ASKPASS helper, one copy for every caller: the git shim installs
// lib/scripts/git-askpass itself, and the CLI and server write this text into
// a private temp dir. It answers GITHUB_TOKEN only to Git's exact HTTPS prompt
// whose authority is github.com (H9), and answers nothing otherwise.
const kGitAskpassScript = fs.readFileSync(
  path.join(__dirname, "scripts", "git-askpass"),
  "utf8",
);

// Write the askpass helper into a fresh private (0700) temp dir. H14: a
// predictable ${pid}-named path in a shared tmp dir lets a pre-planted symlink
// redirect this write to clobber an arbitrary server-writable file — which git
// then executes as GIT_ASKPASS (write + exec). mkdtempSync yields an
// unguessable directory, closing that.
const writeGitAskpassScript = ({ fsModule = fs, osModule = os } = {}) => {
  const dir = fsModule.mkdtempSync(
    path.join(osModule.tmpdir(), "alphaclaw-askpass-"),
  );
  const scriptPath = path.join(dir, "askpass.sh");
  fsModule.writeFileSync(scriptPath, kGitAskpassScript, { mode: 0o700 });
  return { scriptPath, dir };
};

module.exports = { kGitAskpassScript, writeGitAskpassScript };
