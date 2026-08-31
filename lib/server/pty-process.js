// Shared PTY spawn helper: wrap an argv in script(1) so the child sees a real
// TTY. Extracted for the claude-code-local rescue feature (login PTY + the
// no-tmux hosting fallback); watchdog-terminal.js predates it and still
// carries its own interactive-shell variant (TODO: unify once this lands).
//
// Linux script(1) only takes the command as a -c STRING, so this helper
// refuses any token outside a strict allowlist instead of attempting shell
// quoting — callers pass fixed literals ("claude", "auth", "login", absolute
// paths), never user input, and a validator that throws is safer than an
// escaper that might be wrong (the tmux path avoids strings entirely; this is
// the one place a string is unavoidable).
const { spawn, spawnSync } = require("child_process");

const kSafeTokenPattern = /^[A-Za-z0-9._/=,:@%+-]+$/;

const hasScriptCommand = () => {
  try {
    const result = spawnSync("sh", ["-lc", "command -v script >/dev/null 2>&1"], {
      stdio: "ignore",
    });
    return result.status === 0;
  } catch {
    return false;
  }
};

const spawnInPty = (
  commandArgv,
  { cwd, env, spawnImpl = spawn } = {},
) => {
  if (!Array.isArray(commandArgv) || commandArgv.length === 0) {
    throw new Error("spawnInPty: commandArgv must be a non-empty array");
  }
  for (const token of commandArgv) {
    if (typeof token !== "string" || !kSafeTokenPattern.test(token)) {
      throw new Error(
        `spawnInPty: refusing token ${JSON.stringify(token)} — only fixed literal argv is supported`,
      );
    }
  }
  const options = {
    cwd,
    env: { ...env, TERM: env?.TERM || "xterm-256color" },
    stdio: "pipe",
  };
  if (process.platform === "darwin") {
    // BSD script takes the command as real argv — no string form needed.
    return spawnImpl("script", ["-q", "/dev/null", ...commandArgv], options);
  }
  // util-linux script: -f flushes per write so readers see output live.
  return spawnImpl(
    "script",
    ["-q", "-f", "-c", commandArgv.join(" "), "/dev/null"],
    options,
  );
};

module.exports = { spawnInPty, hasScriptCommand, kSafeTokenPattern };
