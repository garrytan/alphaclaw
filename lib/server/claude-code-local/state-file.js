// Rescue-session state cache: {sessionName, sessionId, sessionUrl,
// permissionMode, cwd, hosting, startedAt, claudeVersion, panePid,
// spawnedBy, lastError}. This file is a CACHE of derivable truth, never
// authority — a corrupt or missing file costs one re-derivation from tmux
// liveness, so every read failure collapses to null-with-a-warning instead
// of throwing (a crashed box must not brick the rescue feature on boot).
const fs = require("fs");
const path = require("path");

const readStateFile = ({ filePath, fsModule = fs, logger = console } = {}) => {
  let raw;
  try {
    raw = fsModule.readFileSync(filePath, "utf8");
  } catch {
    return null; // absent = no prior session, the normal cold case
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    try {
      logger.warn?.(
        `[claude-code-local] state.json is corrupt — treating as absent (rebuilding from tmux liveness)`,
      );
    } catch {}
    return null;
  }
};

// Atomic temp+rename with 0600 (the URL and pane identity are operator-only
// data). Write failures (ENOSPC) are reported, not thrown: in-memory state
// stays authoritative until the next write succeeds.
const writeStateFile = ({ filePath, state, fsModule = fs, logger = console } = {}) => {
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.tmp`,
  );
  try {
    fsModule.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    fsModule.renameSync(tmpPath, filePath);
    return true;
  } catch (error) {
    try {
      fsModule.rmSync?.(tmpPath, { force: true });
    } catch {}
    try {
      logger.warn?.(
        `[claude-code-local] state.json write failed (${error?.message}) — in-memory state stays authoritative`,
      );
    } catch {}
    return false;
  }
};

const clearStateFile = ({ filePath, fsModule = fs } = {}) => {
  try {
    fsModule.rmSync(filePath, { force: true });
  } catch {}
};

module.exports = { readStateFile, writeStateFile, clearStateFile };
