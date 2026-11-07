const { sanitizeLabel } = require("./sanitize-label");

// One line per sign-in outcome on the pre-auth routes (login, accept-invite),
// in the [input]/[origin] audit style. It names the outcome, the route, the
// limiter's client address, what kind of sign-in it was (owner, member or
// invitee) and the lane that counted it (shared, device or recovery). It
// never carries the password, the recovery code, the known-browser pass or
// the email.
//
// An attack must not flood the log: per address, the first
// kSignInAuditLinesPerMinute failed, refused or rate-limited lines in a minute
// are written, the rest are counted and summed up in one "suppressed" line
// once that minute is over. Success lines are always written. The counts live
// in memory for at most kSignInAuditMaxAddresses addresses, oldest dropped
// first (its pending summary is written as it goes).
const kSignInAuditLinesPerMinute = 5;
const kSignInAuditMaxAddresses = 1000;
const kWindowMs = 60_000;

const windows = new Map();
let lastSweepAt = 0;

const formatIp = (ip) => JSON.stringify(sanitizeLabel(ip, { maxLength: 64 }));

const writeSummary = (ip, entry) => {
  if (entry.suppressed > 0) {
    console.warn(`[auth] sign-in suppressed ip=${formatIp(ip)} count=${entry.suppressed} window=60s`);
  }
};

const sweepEndedWindows = (now) => {
  if (now - lastSweepAt < kWindowMs) return;
  lastSweepAt = now;
  for (const [ip, entry] of windows) {
    if (now - entry.startedAt < kWindowMs) continue;
    writeSummary(ip, entry);
    windows.delete(ip);
  }
};

// True when this non-success line may be written.
const admitLine = (ip, now) => {
  let entry = windows.get(ip);
  if (entry && now - entry.startedAt >= kWindowMs) {
    writeSummary(ip, entry);
    windows.delete(ip);
    entry = null;
  }
  if (!entry) {
    if (windows.size >= kSignInAuditMaxAddresses) {
      const [oldestIp, oldest] = windows.entries().next().value;
      writeSummary(oldestIp, oldest);
      windows.delete(oldestIp);
    }
    entry = { startedAt: now, written: 0, suppressed: 0 };
    windows.set(ip, entry);
  }
  if (entry.written < kSignInAuditLinesPerMinute) {
    entry.written += 1;
    return true;
  }
  entry.suppressed += 1;
  return false;
};

const logSignInAttempt = ({ req, ip, actor, outcome, lane }) => {
  const now = Date.now();
  sweepEndedWindows(now);
  if (outcome !== "ok" && !admitLine(String(ip), now)) return;
  const route = `${String(req?.method || "").toUpperCase()} ${String(req?.path || req?.url || "")}`;
  const line = `[auth] sign-in ${outcome} route=${sanitizeLabel(route, { maxLength: 96 })} ip=${formatIp(ip)} actor=${actor} lane=${lane}`;
  if (outcome === "ok") console.log(line);
  else console.warn(line);
};

const signInAuditTrackedAddresses = () => windows.size;

module.exports = {
  kSignInAuditLinesPerMinute,
  kSignInAuditMaxAddresses,
  logSignInAttempt,
  signInAuditTrackedAddresses,
};
