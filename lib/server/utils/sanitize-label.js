const kMaxLabelLength = 64;

// Chokepoint for every live-state string that reaches an agent prompt
// (TOOLS.md, SKILL.md) or the openclaw config: strip control chars, collapse
// whitespace, cap length. Lifted from topic-registry.js so exactly one copy
// exists now that the agent-admin skill renders live strings too.
const sanitizeLabel = (value, { maxLength = kMaxLabelLength } = {}) => {
  const cleaned = String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
};

// Markdown-table cell: sanitized label with pipes escaped so a hostile string
// cannot add columns or break out of the table.
const toTableCell = (value, options) =>
  sanitizeLabel(value, options).replace(/\|/g, "\\|");

module.exports = { kMaxLabelLength, sanitizeLabel, toTableCell };
