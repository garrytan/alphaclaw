// Bounded ring of the last N COMPLETE output lines of a child process
// (v0.9.81, cross-model D19). Built for the upstream `backup create` rung:
// its tail is captured in the run log already, but the failure message, the
// live progress row and the run record need the last few lines in a shape
// that is safe to show — so every line is redacted, then clamped, BEFORE it
// is stored, and only a `\n`-terminated line is ever committed (a chunk that
// ends mid-line is carried over until the newline arrives, so a secret split
// across two chunks is still redacted as one string).
//
//   const ring = createOutputLineRing({ maxLines: 3, redact, clampChars: 400 });
//   ring.push(chunk)   // any string/Buffer chunk from stdout or stderr
//   ring.lines()       // [] … up to maxLines strings, oldest first
//   ring.last()        // the newest committed line, or null
//   ring.flush()       // commit a trailing partial line (child exited)
//
// `redact` is the caller's `(text) => text`; the default is the identity so a
// caller that has no secrets to mask can still use the ring. Whitespace-only
// lines are dropped (a CLI's blank spacer lines are not "output").
const kDefaultMaxLines = 3;
const kDefaultClampChars = 400;
// ANSI escape sequences (CSI `ESC [ … final`, OSC `ESC ] … BEL|ST`, and the
// two-byte `ESC x` forms) are stripped whole — a CLI spinner's `ESC[2K` must
// not leave `[2K` in an operator-facing line — then the remaining control
// characters other than \t (\r is handled separately: progress bars redraw
// with it).
const kAnsiEscapePattern =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/][0-~]|\x1b[@-Z\\-_]/g;
const kControlCharPattern = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

const createOutputLineRing = ({
  maxLines = kDefaultMaxLines,
  clampChars = kDefaultClampChars,
  redact = (text) => text,
} = {}) => {
  const cap = Number.isInteger(maxLines) && maxLines > 0 ? maxLines : kDefaultMaxLines;
  const clamp = Number.isInteger(clampChars) && clampChars > 0 ? clampChars : kDefaultClampChars;
  const lines = [];
  let carry = "";
  const commit = (rawLine) => {
    // The redaction runs over the WHOLE line first so a token is masked even
    // when the clamp would otherwise cut it in half.
    const cleaned = String(redact(rawLine))
      .replace(/\r/g, "")
      .replace(kAnsiEscapePattern, "")
      .replace(kControlCharPattern, "")
      .trim();
    if (!cleaned) return;
    lines.push(cleaned.length > clamp ? `${cleaned.slice(0, clamp - 1)}…` : cleaned);
    while (lines.length > cap) lines.shift();
  };
  return {
    push(chunk) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
      if (!text) return;
      const parts = (carry + text).split("\n");
      carry = parts.pop();
      for (const part of parts) commit(part);
      // A pathological child that never prints a newline must not grow the
      // carry without bound: commit an over-long partial as its own line.
      if (carry.length > clamp * 4) {
        commit(carry);
        carry = "";
      }
    },
    flush() {
      if (carry) commit(carry);
      carry = "";
    },
    lines: () => lines.slice(),
    last: () => (lines.length > 0 ? lines[lines.length - 1] : null),
    size: () => lines.length,
  };
};

module.exports = { createOutputLineRing, kDefaultMaxLines, kDefaultClampChars };
