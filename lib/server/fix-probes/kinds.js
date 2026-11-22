const fs = require("fs");
const path = require("path");
const { resolveLogFiles } = require("../telegram-join-watch");

// Fix probe readers (GST-3436). Each one reads a single source and returns
// { ok, code, observed, coverage }: counts, booleans and a char count only,
// never a log line, file content, payload, configured substring or marker.
// A source that shows no sign of life is never a pass: it is no_coverage.
const kMaxLogBytes = 64 * 1024 * 1024;
const kMaxFileBytes = 2 * 1024 * 1024;
const kProtectedName = /^(openclaw\.json|alphaclaw\.json|exec-approvals\.json|\.env(\..+)?|secrets\.json|internal\.secret|provenance-key\.json|auth-profiles\.json|\.git-credentials)$/i;
const kProtectedSegment = /^(relay|guest-writes|credentials|.*-relay-backup)$/i;

const pass = (observed, coverage = { ok: true }) => ({ ok: true, code: "ok", observed, coverage });
const fail = (code, observed, coverage = { ok: true }) => ({ ok: false, code, observed, coverage });
const noCoverage = (observed, coverage) => ({ ok: false, code: "no_coverage", observed, coverage: { ...coverage, ok: false } });
const probeError = (reason) => ({ ok: false, code: "probe_error", observed: {}, coverage: { ok: false }, reason });

// The first expectation a count breaks, as a code and the numbers the alert
// shows, or null when every expectation holds.
const firstBreak = (checks) => {
  for (const [code, label, found, limit, kind] of checks) {
    if (limit === undefined) continue;
    if (kind === "min" ? found < limit : found > limit) return { code, label, found, limit, kind };
  }
  return null;
};
const judge = (observed, checks, coverage) => {
  const broken = firstBreak(checks);
  if (!broken) return pass(observed, coverage);
  return { ...fail(broken.code, observed, coverage), expected: { label: broken.label, kind: broken.kind, limit: broken.limit, found: broken.found } };
};

// One pass over OpenClaw's file log for every log_count probe of a run. Lines
// are JSON objects whose "time" is matched as text, so an envelope change
// in the logger cannot hide a line; a line with no time counts nowhere.
const scanLogs = ({ probes, logFile, nowMs, fsModule = fs, maxBytes = kMaxLogBytes }) => {
  const counts = probes.map(() => ({ matches: 0, liveness: 0 }));
  const files = resolveLogFiles({ logFile, fsModule, nowMs });
  if (files.length === 0) return { counts, filesRead: 0 };
  let budget = maxBytes;
  let unread = false;
  let oldestReadMs = Infinity;
  for (const { file, stat } of files.slice().reverse()) {
    if (budget <= 0) {
      unread = true;
      break;
    }
    const length = Math.min(stat.size, budget);
    if (length < stat.size) unread = true;
    budget -= length;
    let text = "";
    const fd = fsModule.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      fsModule.readSync(fd, buffer, 0, length, stat.size - length);
      text = buffer.toString("utf8");
    } finally {
      fsModule.closeSync(fd);
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      const at = Date.parse(/"time"\s*:\s*"([^"]{10,40})"/.exec(line)?.[1] || /"date"\s*:\s*"([^"]{10,40})"/.exec(line)?.[1] || "");
      if (!Number.isFinite(at)) continue;
      oldestReadMs = Math.min(oldestReadMs, at);
      probes.forEach((probe, index) => {
        if (at < nowMs - probe.windowHours * 3_600_000 || at > nowMs + 60_000) return;
        if (probe.match.every((part) => line.includes(part))) counts[index].matches += 1;
        if (line.includes(probe.expect.liveness)) counts[index].liveness += 1;
      });
    }
  }
  if (unread) {
    probes.forEach((probe, index) => {
      if (oldestReadMs > nowMs - probe.windowHours * 3_600_000) counts[index].trimmed = true;
    });
  }
  return { counts, filesRead: files.length };
};

const judgeLogCount = (probe, { matches, liveness, trimmed = false }) => {
  const observed = { matches, liveness };
  const coverage = { ok: true, liveness };
  if (trimmed) return noCoverage(observed, { ...coverage, trimmed: true });
  if (liveness < probe.expect.sourceMin) return noCoverage(observed, coverage);
  return judge(observed, [
    ["above_max", "matching lines in " + probe.windowHours + " h", matches, probe.expect.max, "max"],
    ["below_min", "matching lines in " + probe.windowHours + " h", matches, probe.expect.min, "min"],
  ], coverage);
};

// Delivery classes from webhook_requests.auth_method: rejected:* rows are
// deliveries AlphaClaw refused, counted on their own and never as unsigned
// or failed.
const judgeWebhookDeliveries = (probe, summary, { minRowsNeverTrimmed }) => {
  const observed = { signed2xx: summary.signed2xx, admittedUnsigned: summary.admittedUnsigned, rejected: summary.rejected, failed: summary.failed };
  const windowStart = summary.windowStart;
  const startMs = Date.parse(windowStart);
  const neverTrimmed = summary.rowCount < minRowsNeverTrimmed && Boolean(summary.globalOldestAt) && Date.parse(summary.globalOldestAt) <= startMs;
  const covered = neverTrimmed || (summary.oldestAt && Date.parse(summary.oldestAt) <= startMs);
  const coverage = { ok: Boolean(covered), retainedFromWindowStart: Boolean(covered) };
  if (!covered) return noCoverage(observed, coverage);
  if (summary.signed2xx + summary.admittedUnsigned + summary.rejected + summary.failed === 0) return noCoverage(observed, { ...coverage, deliveries: 0 });
  const span = probe.windowHours + " h";
  return judge(observed, [
    ["admitted_unsigned", "deliveries admitted without a signature in " + span, summary.admittedUnsigned, probe.expect.maxAdmittedUnsigned, "max"],
    ["below_min_signed", "signed deliveries the gateway accepted in " + span, summary.signed2xx, probe.expect.minSigned2xx, "min"],
    ["above_max_failed", "failed deliveries in " + span, summary.failed, probe.expect.maxFailed, "max"],
  ], coverage);
};

// git-push-checks' counts-only summary: did the checker run lately, probe the
// write path of the listed checkouts, and tell the owner about every problem
// it found. Its own verdicts are its own alerts and are never repeated here.
const judgePushChecks = (probe, summary, nowMs) => {
  if (!summary || !summary.finishedAt) return noCoverage({}, { ok: false, ran: false });
  const ageMinutes = Math.max(0, Math.round((nowMs - Date.parse(summary.finishedAt)) / 60_000));
  const observed = { ageMinutes, listed: summary.listed, listedProbed: summary.listedProbed, discovered: summary.discovered, discoveredProbed: summary.discoveredProbed, untold: summary.untold };
  const coverage = { ok: true, ran: true };
  return judge(observed, [
    ["checker_stale", "minutes since the push checker last finished", ageMinutes, probe.expect.maxAgeMinutes, "max"],
    ["write_path_unprobed", "listed checkouts whose write path was probed", summary.listedProbed, probe.expect.minListedProbed, "min"],
    ["problems_untold", "push problems the owner was never told about", summary.untold, probe.expect.maxUntold, "max"],
  ], coverage);
};

const isInside = (child, root) => child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

// The file a file_check may read: inside an allowed root once every symlink
// is resolved, never a protected name or folder, a regular file of at most
// kMaxFileBytes. Refusals happen before the file is opened.
const resolveCheckedFile = ({ file, roots, fsModule = fs }) => {
  const realRoots = roots.map((root) => {
    try {
      return fsModule.realpathSync(root);
    } catch {
      return null;
    }
  }).filter(Boolean);
  const named = path.resolve(file);
  if (!realRoots.some((root) => isInside(named, root)) && !roots.some((root) => isInside(named, path.resolve(root)))) return { refused: "outside_roots" };
  let real;
  try {
    real = fsModule.realpathSync(named);
  } catch (error) {
    return error?.code === "ENOENT" ? { missing: true } : { refused: "unresolvable" };
  }
  if (!realRoots.some((root) => isInside(real, root))) return { refused: "outside_roots" };
  for (const candidate of [named, real]) {
    const segments = candidate.split(path.sep).filter(Boolean);
    if (kProtectedName.test(segments[segments.length - 1] || "")) return { refused: "protected_name" };
    if (segments.slice(0, -1).some((segment) => kProtectedSegment.test(segment))) return { refused: "protected_folder" };
    if (segments[0] === "proc") return { refused: "protected_folder" };
  }
  return { real };
};

const readCheckedFile = (real, fsModule = fs) => {
  const fd = fsModule.openSync(real, fsModule.constants.O_RDONLY | fsModule.constants.O_NONBLOCK);
  try {
    const stat = fsModule.fstatSync(fd);
    if (!stat.isFile()) return { refused: "not_a_file" };
    if (stat.size > kMaxFileBytes) return { refused: "too_large" };
    return { text: fsModule.readFileSync(fd, "utf8") };
  } finally {
    fsModule.closeSync(fd);
  }
};

const runFileCheck = (probe, { roots, fsModule = fs }) => {
  const located = resolveCheckedFile({ file: probe.file, roots, fsModule });
  if (located.refused) return { ...probeError("file " + located.refused), code: "file_refused" };
  if (located.missing) {
    if (probe.expect.exists === false) return pass({ exists: false });
    return fail("file_missing", { exists: false }, { ok: true });
  }
  let read;
  try {
    read = readCheckedFile(located.real, fsModule);
  } catch (error) {
    return probeError("file unreadable (" + (error?.code || "error") + ")");
  }
  if (read.refused) return { ...probeError("file " + read.refused), code: "file_refused" };
  if (probe.expect.exists === false) return fail("file_present", { exists: true });
  const markers = probe.expect.containsAll || [];
  const markersFound = markers.filter((marker) => read.text.includes(marker)).length;
  const observed = { exists: true, chars: read.text.length, markersFound, markers: markers.length };
  return judge(observed, [
    ["marker_missing", "fix markers found in the file", markersFound, markers.length || undefined, "min"],
    ["above_max_chars", "characters in the file", read.text.length, probe.expect.maxChars, "max"],
  ], { ok: true });
};

const judgeRelayLongReplies = (probe, counts) => {
  if (counts === null) return { ok: true, code: "not_checked", observed: {}, coverage: { ok: true, relay: "off" } };
  if (!counts) return probeError("relay counters unreadable");
  const observed = { seen: counts.seen, whole: counts.whole, cut: counts.cut };
  const coverage = { ok: true, seen: counts.seen };
  if (counts.seen < (probe.expect.minSeen || 0)) return noCoverage(observed, coverage);
  return judge(observed, [["replies_cut", "long relay answers sent cut in " + probe.windowDays + " days", counts.cut, probe.expect.maxCut, "max"]], coverage);
};

module.exports = {
  scanLogs,
  judgeLogCount,
  judgeWebhookDeliveries,
  judgePushChecks,
  runFileCheck,
  resolveCheckedFile,
  judgeRelayLongReplies,
  kMaxLogBytes,
};
