// Line breaks never survive into .env (issue #26 hardening): a value with an
// embedded newline injects arbitrary extra lines into a file two root-cron
// shell scripts parse — value smuggling at best, key smuggling at worst.
// Stripped (not rejected) so every writer stays non-throwing; all .env writes
// funnel through env.js's writeEnvFile/updateEnvFile.
const stripLineBreaks = (value) =>
  String(value ?? "").replace(/[\r\n\u2028\u2029]/g, "");

// The single key-normalization the write path applies before persisting.
// Exported so the agent-admin tier resolver classifies the SAME canonical
// key the file will hold \u2014 otherwise a padded/linebroken protected key
// ("CLAUDE_CODE_ROUTINE_URL ") misses the raw-key Set check (base tier, no
// operator confirm) yet persists canonical, repointing the launcher.
const normalizeEnvKey = (key) => {
  const raw = String(key ?? "");
  return raw.includes("\0") ? "" : stripLineBreaks(raw).trim();
};

module.exports = { stripLineBreaks, normalizeEnvKey };
