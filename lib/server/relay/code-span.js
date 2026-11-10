// Owner notices are house format, which each transport turns into links and
// bold. Text a remote agent wrote rides a code span, but Slack mints
// [label](url) links and reads raw <url|label> and <!channel> inside one too,
// so the span also swaps [ ] < > for lookalikes no transport acts on.
const kCodeSpanSwaps = Object.freeze({ "[": "(", "]": ")", "<": "\u2039", ">": "\u203a" });

const codeSpan = (value, { empty = "" } = {}) =>
  "`" + (String(value ?? "").replace(/[`\r\n]/g, "'").replace(/[[\]<>]/g, (ch) => kCodeSpanSwaps[ch]) || empty) + "`";

module.exports = { codeSpan };
