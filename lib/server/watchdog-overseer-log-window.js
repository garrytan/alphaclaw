const kLogWindowMinLines = 10;

const kSituationLogWindowMs = 30 * 60 * 1000;
const kSituationLogWindowLabel = `${Math.round(kSituationLogWindowMs / 60_000)} min`;
// A first kept line later than this past the requested window start means the
// window was not fully covered (either the tail was cut or the log begins).
const kLateStartSlackMs = 60_000;
// The log section of a situation prompt keeps the NEWEST chars up to this cap
// (events cap at 24k, doctor at 32k): a busy failure loop can fill the whole
// 256KB tail inside the window, which would dominate cost and latency.
const kLogEvidenceMaxChars = 64_000;

// Gateway log lines are ISO-timestamp prefixed (log-writer.js prepends one on
// write). Filter to the incident window; unparseable lines (multi-line stderr
// continuations, pre-rotation legacy) inherit the last parsed timestamp. If
// fewer than kLogWindowMinLines survive, fall back to the plain byte tail so
// the evidence section is never empty — flagged `partial` for the prompt.
const kIsoLinePattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/;

// Coverage of the lines actually RETURNED (the raw tail in the fallback case,
// never the discarded matches) so a prompt header or evidence line can state
// the real span instead of the requested one.
const spanOfLines = (lines) => {
  let firstTsMs = null;
  let lastTsMs = null;
  for (const line of lines) {
    const match = line.match(kIsoLinePattern);
    if (!match) continue;
    const parsed = Date.parse(match[1]);
    if (!Number.isFinite(parsed)) continue;
    if (firstTsMs == null) firstTsMs = parsed;
    lastTsMs = parsed;
  }
  return { firstTsMs, lastTsMs };
};

const filterLogWindow = (logText, { fromMs, toMs } = {}) => {
  const raw = String(logText || "");
  if (!raw.trim()) {
    return {
      text: "",
      partial: false,
      matchedLines: 0,
      lineCount: 0,
      firstTsMs: null,
      lastTsMs: null,
    };
  }
  const lines = raw.split("\n");
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return {
      text: raw,
      partial: true,
      matchedLines: 0,
      lineCount: lines.length,
      ...spanOfLines(lines),
    };
  }
  // One pass: the window filter plus the coverage span of both the kept lines
  // and the whole tail (needed if we fall back to the raw tail).
  const kept = [];
  let lastTsMs = null;
  let allFirst = null;
  let allLast = null;
  let keptFirst = null;
  let keptLast = null;
  for (const line of lines) {
    const match = line.match(kIsoLinePattern);
    if (match) {
      const parsed = Date.parse(match[1]);
      if (Number.isFinite(parsed)) {
        lastTsMs = parsed;
        if (allFirst == null) allFirst = parsed;
        allLast = parsed;
      }
    }
    if (lastTsMs != null && lastTsMs >= fromMs && lastTsMs <= toMs) {
      kept.push(line);
      if (match) {
        if (keptFirst == null) keptFirst = lastTsMs;
        keptLast = lastTsMs;
      }
    }
  }
  if (kept.length < kLogWindowMinLines) {
    return {
      text: raw,
      partial: true,
      matchedLines: kept.length,
      lineCount: lines.length,
      firstTsMs: allFirst,
      lastTsMs: allLast,
    };
  }
  return {
    text: kept.join("\n"),
    partial: false,
    matchedLines: kept.length,
    lineCount: kept.length,
    firstTsMs: keptFirst,
    lastTsMs: keptLast,
  };
};

// Keep the NEWEST chars of a log window under the evidence cap, cutting on a
// line boundary and recomputing the span of what survives.
const capLogWindow = (window, maxChars = kLogEvidenceMaxChars) => {
  const text = String(window?.text || "");
  if (text.length <= maxChars) return { ...window, capped: false };
  let cut = text.slice(-maxChars);
  const firstNewline = cut.indexOf("\n");
  if (firstNewline >= 0) cut = cut.slice(firstNewline + 1);
  const lines = cut.split("\n");
  return {
    ...window,
    text: cut,
    lineCount: lines.length,
    capped: true,
    ...spanOfLines(lines),
  };
};

// One place decides how a log window's coverage reads, for both the prompt
// header and the persisted evidence (they must never disagree).
const summarizeLogCoverage = ({ window, requestedFromMs, hitCap }) => {
  const lineCount = Number.isFinite(window?.lineCount)
    ? window.lineCount
    : window?.text
      ? window.text.split("\n").length
      : 0;
  const lateStart =
    !window?.partial &&
    Number.isFinite(window?.firstTsMs) &&
    Number.isFinite(requestedFromMs) &&
    window.firstTsMs > requestedFromMs + kLateStartSlackMs;
  const capped = !!window?.capped;
  return {
    lineCount,
    lateStart,
    // The front is missing when the byte tail hit its cap OR our own evidence
    // cap cut it; a late start with neither means the log simply begins there.
    frontTruncated: lateStart && (!!hitCap || capped),
    cutByCap: lateStart && !hitCap && capped,
    capped,
  };
};

// Human-readable coverage for the UNTRUSTED log header. `partial` = the
// window was not honored (too few lines matched, raw tail returned).
const describeLogCoverage = ({ window, requestedFromMs, hitCap }) => {
  const fmt = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 16) : "?");
  const span = `${fmt(window.firstTsMs)}–${fmt(window.lastTsMs)}`;
  const { lineCount, lateStart, frontTruncated, cutByCap, capped } = summarizeLogCoverage({
    window,
    requestedFromMs,
    hitCap,
  });
  const cappedNote = capped ? `; showing the newest ${Math.round(kLogEvidenceMaxChars / 1000)}k chars` : "";
  if (window.partial) {
    return `requested last ${kSituationLogWindowLabel}; ${window.matchedLines} lines matched — showing the full tail ${span}, ${lineCount} lines${cappedNote}`;
  }
  if (frontTruncated) {
    return `covers ${span}, ${lineCount} lines (${cutByCap ? "front cut to the evidence cap" : "tail did not reach the window start"})${cappedNote}`;
  }
  if (lateStart) {
    return `covers ${span}, ${lineCount} lines (log begins ${fmt(window.firstTsMs)})${cappedNote}`;
  }
  return `covers ${span}, ${lineCount} lines${cappedNote}`;
};

module.exports = {
  kSituationLogWindowLabel,
  kSituationLogWindowMs,
  kLogEvidenceMaxChars,
  filterLogWindow,
  capLogWindow,
  summarizeLogCoverage,
  describeLogCoverage,
};
