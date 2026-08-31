// Shared `openclaw sessions --json --all-agents` plumbing. Extracted from
// lib/server/routes/system.js so the Doctor fix dispatch can validate a
// sessionKey against the SAME live session list POST /api/agent/message uses
// — a hand-rolled second copy is the divergent-parser bug class this branch
// exists to kill.

// The ONE command string that defines the sendable-session list — the fix
// dispatch validates against the SAME list POST /api/agent/message serves,
// so a flag added to one call site must not silently fork the two.
const kSessionsListCommand = "sessions --json --all-agents";

// Tolerant JSON extraction: openclaw sometimes prefixes/suffixes human lines
// around the JSON payload.
const parseJsonFromStdout = (stdout) => {
  const raw = String(stdout || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!(line.startsWith("{") || line.startsWith("["))) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  // Last resort, BOUNDED: only try slices ending at actual closer characters
  // (the old per-character end-decrement was O(n²) on large malformed output
  // and this now runs on every Doctor fix dispatch, not just list routes).
  const candidateStarts = [raw.indexOf("{"), raw.indexOf("[")].filter((idx) => idx >= 0);
  const kMaxCloserCandidates = 64;
  for (const start of candidateStarts) {
    let tried = 0;
    for (
      let end = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
      end > start && tried < kMaxCloserCandidates;
      end = Math.max(raw.lastIndexOf("}", end - 1), raw.lastIndexOf("]", end - 1))
    ) {
      tried += 1;
      try {
        return JSON.parse(raw.slice(start, end + 1).trim());
      } catch {}
    }
  }
  return null;
};

const getRawSessionKey = (sessionRow = {}) =>
  String(sessionRow?.key || sessionRow?.sessionKey || sessionRow?.id || "").trim();

const getRawSessionsFromPayload = (payload) => {
  if (Array.isArray(payload)) return payload;
  const candidates = [
    payload?.sessions,
    payload?.items,
    payload?.data?.sessions,
    payload?.data?.items,
    payload?.result?.sessions,
    payload?.result?.items,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
};

// Lookup factory for consumers that only need "does this sessionKey exist" —
// returns the raw session row or null. Throws on a failed CLI call so callers
// can distinguish "not found" from "could not list".
// A payload is only trustworthy for a NOT-FOUND verdict when it has a
// recognizable sessions shape — the tolerant JSON extraction can adopt a
// stray log line (`{"level":"warn",...}`), and "your session doesn't exist"
// must never be derived from that.
const hasRecognizableSessionsShape = (payload) =>
  Array.isArray(payload) ||
  [
    payload?.sessions,
    payload?.items,
    payload?.data?.sessions,
    payload?.data?.items,
    payload?.result?.sessions,
    payload?.result?.items,
  ].some((candidate) => Array.isArray(candidate));

const createSendableSessionLookup = ({ clawCmd }) => async (sessionKey) => {
  const key = String(sessionKey || "").trim();
  if (!key) return null;
  const result = await clawCmd(kSessionsListCommand, { quiet: true });
  if (!result?.ok) {
    // Tagged so routes map this to a 5xx: a failing sessions CLI is an
    // infrastructure outage, never the caller's fault.
    const error = new Error(result?.stderr || "Could not load agent sessions");
    error.sessionLookupFailed = true;
    throw error;
  }
  const payload = parseJsonFromStdout(result.stdout);
  if (!hasRecognizableSessionsShape(payload)) {
    const error = new Error("Could not parse agent sessions output");
    error.sessionLookupFailed = true;
    throw error;
  }
  const sessions = getRawSessionsFromPayload(payload);
  return sessions.find((sessionRow) => getRawSessionKey(sessionRow) === key) || null;
};

module.exports = {
  kSessionsListCommand,
  parseJsonFromStdout,
  getRawSessionKey,
  getRawSessionsFromPayload,
  createSendableSessionLookup,
};
