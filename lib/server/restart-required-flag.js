const fs = require("fs");
const path = require("path");
const { OPENCLAW_DIR } = require("./constants");
const { writeFileAtomic } = require("./utils/safe-file");

// Cross-process restart marker: the CLI (bin/alphaclaw.js) writes it when its
// config writes need a gateway restart; the server folds it into
// restartRequiredState so the existing banner surfaces it. Lives outside
// workspace/ so the workspace git audit never picks it up.
const kRestartRequiredFlagPath = path.join(
  OPENCLAW_DIR,
  "alphaclaw-restart-required.json",
);

const readRestartRequiredFlag = ({
  fsModule = fs,
  flagPath = kRestartRequiredFlagPath,
} = {}) => {
  try {
    const parsed = JSON.parse(fsModule.readFileSync(flagPath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return {
      reason: String(parsed.reason || "config_changed").trim() || "config_changed",
      source: String(parsed.source || "").trim(),
      markedAt: Number(parsed.markedAt) || 0,
    };
  } catch {
    return null;
  }
};

const writeRestartRequiredFlag = ({
  fsModule = fs,
  flagPath = kRestartRequiredFlagPath,
  reason = "config_changed",
  source = "",
} = {}) => {
  writeFileAtomic(
    flagPath,
    JSON.stringify(
      {
        reason: String(reason || "config_changed").trim() || "config_changed",
        source: String(source || "").trim(),
        markedAt: Date.now(),
      },
      null,
      2,
    ),
    { fsModule },
  );
  return flagPath;
};

const clearRestartRequiredFlag = ({
  fsModule = fs,
  flagPath = kRestartRequiredFlagPath,
} = {}) => {
  try {
    fsModule.unlinkSync(flagPath);
  } catch {}
};

module.exports = {
  kRestartRequiredFlagPath,
  readRestartRequiredFlag,
  writeRestartRequiredFlag,
  clearRestartRequiredFlag,
};
