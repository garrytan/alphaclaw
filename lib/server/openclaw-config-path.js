const fs = require("fs");
const path = require("path");

// OPENCLAW_CONFIG_PATH for every OpenClaw child. OpenClaw 2026.10's atomic
// writer (@openclaw/fs-safe) opens the parent of each replaced file with
// O_NOFOLLOW, so a config path whose parent is a symlinked state dir
// (/data/.openclaw -> /data/stronghold-wm/wintermute) fails every config
// write with "Atomic replace parent must be a real directory" (issue #144).
// Only the directory is resolved: OPENCLAW_STATE_DIR and XDG_CONFIG_HOME stay
// lexical because OpenClaw partitions cron rows by the lexical state path
// (#118), and an openclaw.json that is itself a symlink stays a symlink for
// OpenClaw's own write-safety checks. Dependency-free: bin/alphaclaw.js calls
// it before the server modules load.
const resolveOpenclawChildConfigPath = (openclawDir, { fsModule = fs } = {}) => {
  const lexical = path.join(openclawDir, "openclaw.json");
  try {
    if (!fsModule.lstatSync(openclawDir).isSymbolicLink()) return lexical;
    return path.join(fsModule.realpathSync(openclawDir), "openclaw.json");
  } catch {
    return lexical;
  }
};

module.exports = { resolveOpenclawChildConfigPath };
