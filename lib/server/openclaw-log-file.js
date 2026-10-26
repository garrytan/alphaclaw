const path = require("path");
const { kOpenclawLogDir } = require("./constants");

// The literal openclaw-YYYY-MM-DD.log basename keeps OpenClaw's rolling mode:
// it substitutes the local date per day and prunes openclaw-*.log files older
// than 24 h in this directory. Any other basename is a fixed, never-pruned file.
const kManagedOpenclawLogFile = path.join(kOpenclawLogDir, "openclaw-YYYY-MM-DD.log");

const applyManagedOpenclawLogFile = (cfg, { logFile = kManagedOpenclawLogFile } = {}) => {
  if (cfg.logging === undefined) cfg.logging = {};
  const { logging } = cfg;
  if (!logging || typeof logging !== "object" || Array.isArray(logging)) return false;
  const current = logging.file;
  if (current !== undefined && current !== null && !(typeof current === "string" && current.trim() === "")) {
    return false;
  }
  logging.file = logFile;
  return true;
};

module.exports = { applyManagedOpenclawLogFile, kManagedOpenclawLogFile };
