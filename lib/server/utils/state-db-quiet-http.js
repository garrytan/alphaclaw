const {
  StateDbQuietError,
  kBackupInProgressMessage,
  kStateDbQuietRetryAfterSec,
} = require("../state-db-quiet");

// One HTTP shape for every route whose writer hit the state-DB quiet barrier:
// 409 + Retry-After so clients (and the agent-admin CLI) retry after the
// backup instead of treating a paused box as broken. Returns true when the
// error was handled so callers can `if (sendIfStateDbQuietError(res, err)) return;`
// ahead of their existing 500 mapping.
const sendIfStateDbQuietError = (res, error) => {
  if (!(error instanceof StateDbQuietError)) return false;
  res.set("Retry-After", String(kStateDbQuietRetryAfterSec));
  res.status(409).json({ ok: false, code: error.code, error: kBackupInProgressMessage });
  return true;
};

module.exports = { sendIfStateDbQuietError };
