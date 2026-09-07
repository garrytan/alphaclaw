const fs = require("fs");

// Read at most `maxBytes` from the END of a file. Single bounded read — never
// the whole file. Shared by the process-log tail and the cron `.jsonl`
// readers so there is exactly one clamp policy and one partial-line rule.
const kTailAbsoluteMaxBytes = 4 * 1024 * 1024;

const tailBytes = (filePath, maxBytes) => {
  const requested = Number.parseInt(String(maxBytes || 0), 10);
  const clamped = Math.min(
    kTailAbsoluteMaxBytes,
    Math.max(1024, Number.isFinite(requested) && requested > 0 ? requested : 65536),
  );
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    const startPos = Math.max(0, stat.size - clamped);
    const len = stat.size - startPos;
    if (len <= 0) return { text: "", truncated: startPos > 0 };
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(len);
    const bytesRead = fs.readSync(fd, buffer, 0, len, startPos);
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      truncated: startPos > 0,
    };
  } catch {
    return { text: "", truncated: false };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
};

// Tail a file and split into COMPLETE lines. When the read started mid-file,
// the first (partial) line is dropped; when the file does not end with a
// newline, the final segment is a record still being written concurrently —
// dropped too, one rule for every caller.
const tailLines = (filePath, maxBytes) => {
  const { text, truncated } = tailBytes(filePath, maxBytes);
  if (!text) return [];
  let lines = text.split("\n");
  if (truncated) lines = lines.slice(1);
  if (!text.endsWith("\n")) lines = lines.slice(0, -1);
  return lines.filter((line) => line.length > 0);
};

// Keep the lines matching `pattern` — a RegExp tested against the WHOLE line
// (substring semantics, never startsWith: process.log lines carry timestamps
// and writer prefixes ahead of the `[subsystem]` tag a caller filters on) or
// a literal substring. Non-string entries are dropped; a non-array is empty.
const filterLogLines = (lines, pattern) => {
  if (!Array.isArray(lines)) return [];
  if (pattern instanceof RegExp) {
    // A /g or /y regex carries lastIndex across test() calls and would skip
    // every other matching line; strip those flags so each line is judged
    // independently.
    const re =
      pattern.global || pattern.sticky
        ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""))
        : pattern;
    return lines.filter((line) => typeof line === "string" && re.test(line));
  }
  const needle = String(pattern ?? "");
  return lines.filter(
    (line) => typeof line === "string" && (needle === "" || line.includes(needle)),
  );
};

module.exports = { tailBytes, tailLines, filterLogLines, kTailAbsoluteMaxBytes };
