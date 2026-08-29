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
// C0 controls (minus tab/LF), DEL, and the C1 range (\u0080-\u009F — NEL
// U+0085 renders as a line break in some clients).
const kControlCharsPattern = /[\u0000-\u0008\u000B-\u001F\u007F\u0080-\u009F]/g;

// Tab/LF pass the control-char strip by design (card text is multi-line);
// singleLine collapses them so untrusted text cannot forge extra lines inside
// a trusted notification (each notification line must stay one line). Unicode
// line separators (NEL U+0085, LS U+2028, PS U+2029) collapse too — Telegram
// renders U+2028 as a newline.
const kLineBreakingCharsPattern = /[\r\n\t\u0085\u2028\u2029]+/g;

const createDoctorTextSanitizer = ({ env = process.env, extraValues = [] } = {}) => {
  const redactor = createRedactor(collectSecretValues({ env, extraValues }));
  const sanitize = (text, { maxChars = 0, singleLine = false } = {}) => {
    let value = redactor.scrub(String(text ?? ""));
    if (singleLine) value = value.replace(kLineBreakingCharsPattern, " ");
    value = value.replace(kControlCharsPattern, " ").trim();
    if (maxChars > 0 && value.length > maxChars) {
      let keepChars = Math.max(1, maxChars - 1);
      // Never split a surrogate pair at the cap: a trailing lone high
      // surrogate renders as U+FFFD garbage in notification clients.
      const lastKeptCharCode = value.charCodeAt(keepChars - 1);
      if (lastKeptCharCode >= 0xd800 && lastKeptCharCode <= 0xdbff) {
        keepChars -= 1;
      }
      value = `${value.slice(0, keepChars)}…`;
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
