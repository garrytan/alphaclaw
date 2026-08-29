const fs = require("fs");
const os = require("os");
const path = require("path");

// Shared POSIX-sh GIT_ASKPASS helper. git invokes it with the full prompt as
// $1, e.g.  Password for 'https://user@github.com': . Answer with GITHUB_TOKEN
// ONLY when the prompt's host is exactly github.com.
//
// H9: a substring check for "github.com" is bypassable via
// https://github.com@attacker.example/repo (the prompt contains "github.com"
// but the real host is attacker.example), so parse the host as the authority
// after the LAST '@' and compare it exactly. This keeps a git command aimed at
// any non-github host from leaking the token.
const kGitAskpassScript = [
  "#!/usr/bin/env sh",
  'case "$1" in',
  '  *Username*) printf "%s" "x-access-token" ;;',
  "  *Password*)",
  "    u=${1#*\\'}; u=${u%%\\'*}; a=${u#*://}; a=${a%%/*}; host=${a##*@}; host=${host%%:*}",
  '    [ "$host" = github.com ] && printf "%s" "${GITHUB_TOKEN:-}" || printf "" ;;',
  '  *) printf "" ;;',
  "esac",
  "",
].join("\n");

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
