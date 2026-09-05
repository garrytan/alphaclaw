// Picks the line most likely to name a restart failure's blocking cause from
// an already-redacted evidence tail. Heuristic by design: the summary is only
// ENRICHED when a line matches a recognized error shape — there is NO
// last-line fallback (promoting arbitrary trailing noise into the durable
// errorSummary misleads the next incident's responder; the full tail is
// preserved separately as evidence). Born from the 2026-09-01 incident, where
// the real blocker (a stale openclaw state-lifecycle lock) never appeared in
// the operation record and the timeout symptom was all the operator saw.

// Error-shaped lines. `locks?` deliberately matches "state-locks"/"lock";
// "already in use" catches bind conflicts spelled out instead of EADDRINUSE.
const kErrorLinePattern =
  /\b(error|fatal|panic|refused|denied|failed|cannot|unable|locks?|timed?\s?out|already in use|EADDRINUSE|ENOENT|EACCES)\b/i;

// Benign lines that would otherwise match above: success-path lock chatter
// and zero-valued failure counters ("failed=0", "0 failed").
const kBenignLinePatterns = [
  /\block(s)?\s+(acquired|released)\b/i,
  /\b(?:failed|errors?)\s*[=:]\s*0\b/i,
  /\b0\s+(?:failed|errors?)\b/i,
];

// Explicit severity tags outrank general error-shaped words: in the
// 2026-09-01 tail the real blocker was an "ERROR ..." line followed by
// retry/progress chatter that also contained lock-ish words — the last
// severity-tagged line is the cause, not the last vaguely-errorish one.
// Case-SENSITIVE on purpose (F048): with /i, any trailing prose containing a
// lowercase "error" ("last error was a connection error") outranked the real
// "ERROR ..." blocker line. A tag is an upper-case word or a "Error:"/"error:"
// prefix with the colon — not the word in running text.
const kSeverityLinePattern = /(^|\s)(ERROR|FATAL|PANIC|ERR!?)\b|\b(?:[Ee]rror|[Ff]atal|[Pp]anic):/;

const pickCauseLine = (redactedTail) => {
  const text = String(redactedTail ?? "");
  if (!text) return null;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const lastMatch = (pattern) => {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!pattern.test(line)) continue;
      if (kBenignLinePatterns.some((benign) => benign.test(line))) continue;
      return line;
    }
    return null;
  };
  return lastMatch(kSeverityLinePattern) ?? lastMatch(kErrorLinePattern);
};

module.exports = { pickCauseLine };
