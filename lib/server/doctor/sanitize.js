const {
  collectSecretValues,
  createRedactor,
} = require("../openclaw-run-ledger");

// Doctor card/notification text can carry workspace- or CLI-derived content
// (skills descriptions, upstream doctor messages, LLM titles). Everything
// user-visible outside the authed UI — and everything persisted from an
// untrusted source — passes through here: secret-value redaction (same
// key-shaped env filter as the run ledger), control-character stripping, and
// a hard length cap. Markdown escaping is separate (notification lines only —
// card text renders as plain text in the UI).
const kControlCharsPattern = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

const createDoctorTextSanitizer = ({ env = process.env, extraValues = [] } = {}) => {
  const redactor = createRedactor(collectSecretValues({ env, extraValues }));
  const sanitize = (text, { maxChars = 0 } = {}) => {
    let value = redactor
      .scrub(String(text ?? ""))
      .replace(kControlCharsPattern, " ")
      .trim();
    if (maxChars > 0 && value.length > maxChars) {
      value = `${value.slice(0, Math.max(1, maxChars - 1))}…`;
    }
    return value;
  };
  const escapeMarkdown = (text) =>
    String(text ?? "").replace(/([_*`[\]])/g, "\\$1");
  return { sanitize, escapeMarkdown };
};

module.exports = {
  createDoctorTextSanitizer,
};
