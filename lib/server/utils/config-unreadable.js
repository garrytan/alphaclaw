// Fail-closed config refusals, one vocabulary (fix wave PR 7).
//
// Every state-file reader that feeds a write path throws an error carrying one
// of these codes when the file EXISTS but cannot be parsed; the write helpers
// refuse rather than rebuild the file from `{}`. Routes translate any of them
// into the same envelope the UI already renders for openclaw.json refusals:
//   { ok:false, error, code:"config_unreadable", hint, file }
// and the doctor's `det:config-unreadable:<file>` card explains the recovery
// without ever parsing the broken file itself.
const path = require("path");

const kConfigUnreadableCodes = Object.freeze(
  new Set([
    "OPENCLAW_CONFIG_UNREADABLE",
    "ALPHACLAW_CONFIG_UNREADABLE",
    "GOOGLE_STATE_UNREADABLE",
    "GOG_CONFIG_UNREADABLE",
    "EXEC_APPROVALS_UNREADABLE",
    "TOPIC_REGISTRY_UNREADABLE",
    "SYNC_CRON_CONFIG_UNREADABLE",
    "AUTH_STORE_UNREADABLE",
  ]),
);

const isConfigUnreadableError = (error) =>
  Boolean(error && typeof error === "object" && kConfigUnreadableCodes.has(error.code));

const kConfigUnreadableHint =
  "AlphaClaw will not rewrite a config file it cannot parse. Fix the JSON by hand or restore a backup (a .bak sibling if one exists), then retry. Nothing was changed.";

const kDefaultFileByCode = Object.freeze({
  OPENCLAW_CONFIG_UNREADABLE: "openclaw.json",
  ALPHACLAW_CONFIG_UNREADABLE: "alphaclaw.json",
  GOOGLE_STATE_UNREADABLE: "gogcli/state.json",
  GOG_CONFIG_UNREADABLE: "gogcli/config.json",
  EXEC_APPROVALS_UNREADABLE: "exec-approvals.json",
  TOPIC_REGISTRY_UNREADABLE: "topic-registry.json",
  SYNC_CRON_CONFIG_UNREADABLE: "cron/system-sync.json",
  AUTH_STORE_UNREADABLE: "openclaw-agent.sqlite",
});

const displayFile = (error) => {
  const raw = error?.configPath || error?.filePath || error?.file || "";
  if (raw) return path.basename(String(raw));
  return kDefaultFileByCode[error?.code] || "the config file";
};

// Copy contract (kept from the v0.9.73 models/team routes): "AlphaClaw will
// not rewrite <file> because it cannot parse it ...". openclaw.json gets the
// JSON5 explanation; every other file gets the generic torn-write one.
const configUnreadableEnvelope = (error) => {
  const file = displayFile(error);
  const why =
    error?.code === "OPENCLAW_CONFIG_UNREADABLE"
      ? "OpenClaw allows JSON5 and env includes that AlphaClaw does not"
      : "the file is not valid JSON — usually a torn write or a hand edit";
  return {
    ok: false,
    error: `AlphaClaw will not rewrite ${file} because it cannot parse it (${why}). Fix or restore the file, then retry.`,
    code: "config_unreadable",
    hint: kConfigUnreadableHint,
    file,
    sourceCode: error?.code || null,
  };
};

// `status` defaults to 503 (the models/team routes' existing contract); the
// google/nodes routes pass 409 to match their fail-closed neighbors.
const sendIfConfigUnreadable = (res, error, { status = 503 } = {}) => {
  if (!isConfigUnreadableError(error)) return false;
  noteConfigUnreadable({ error, source: "route" });
  res.status(status).json(configUnreadableEnvelope(error));
  return true;
};

// One persisted watchdog event per file per process, so the refusal shows in
// the incidents timeline without a loop of identical rows. Lazy require: this
// util is loaded by modules that boot before the watchdog DB exists.
const kNotedFiles = new Set();
const noteConfigUnreadable = ({ error, source = "unknown", insertWatchdogEvent = null } = {}) => {
  if (!isConfigUnreadableError(error)) return false;
  const filePath = String(error.configPath || error.filePath || error.file || error.code);
  if (kNotedFiles.has(filePath)) return false;
  kNotedFiles.add(filePath);
  try {
    console.warn(
      `[alphaclaw] refusing to rewrite unparseable config ${filePath} (${error.code}): ${error.message}`,
    );
  } catch {}
  try {
    const insert = insertWatchdogEvent || require("../db/watchdog").insertWatchdogEvent;
    insert?.({
      eventType: "config_unreadable",
      source: String(source || "unknown"),
      status: "warning",
      details: { file: filePath, code: error.code, message: String(error.message || "").slice(0, 400) },
    });
  } catch {
    // The watchdog DB may be unavailable (tests, pre-boot); the warn above stands.
  }
  return true;
};

const resetConfigUnreadableNotesForTests = () => kNotedFiles.clear();

module.exports = {
  kConfigUnreadableCodes,
  kConfigUnreadableHint,
  isConfigUnreadableError,
  configUnreadableEnvelope,
  sendIfConfigUnreadable,
  noteConfigUnreadable,
  resetConfigUnreadableNotesForTests,
};
