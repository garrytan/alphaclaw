// boot-report.json — one machine-readable, self-consistent statement per boot
// (issue #76 Part A, plan A1 / CEO 4.1 / Codex D16).
//
// Two phases write ONE file under the managed dir (`<openclawDir>/.alphaclaw`,
// always the store's `managedDir` — never recomputed here):
//
//   bin phase   (bin/alphaclaw.js, single-threaded, before the server spawns)
//     writeBinPhase(report)     rotates the ring and writes the new report with
//                               serverPhase: { status: "pending" }
//     writeRefusedBinPhase      a refused start (corroborated live-owner
//                               pidfile claim → bin exits 1): the report goes
//                               to boot-report-refused.json, ring untouched,
//                               serverPhase already { status: "not_reached" }
//     markServerPhaseNotReached bin-exit paths that never reach the server
//   server phase (runOnboardedBootSequence, after the port bind)
//     mergeServerPhase(patch)   read-modify-write; merges ONLY into the report
//                               THIS process's bin phase wrote (bootId guard)
//     pinIncidentReport(report) keeps the first INCONSISTENT report of a
//                               restart loop where the ring cannot evict it
//
//   boot-report.json ──▶ boot-report.1.json ──▶ boot-report.2.json ──▶ (gone)
//         ▲ rotation happens ONLY in writeBinPhase: the bin phase is the one
//           single-threaded moment of a boot; the server phase never rotates,
//           so a merge can never shift the ring under a concurrent reader.
//   boot-report-incident.json — pinned copy of a report with a non-empty
//         verdict[]; replaced only when the installed version changes, the
//         verdict set differs, or the pin is 7+ days old (a crash loop must
//         not evict the report that explains it).
//   boot-report-refused.json — the last REFUSED start (a second instance
//         that exited 1 because a live server provably owns the dir). Kept
//         out of the ring on purpose: the live server's completed report
//         stays at slot 0, and three refused starts cannot empty a 3-slot
//         ring (the eviction the incident pin exists to prevent).
//
// Rule of record: boot-report.json is the diagnostic SUPERSET; the channel
// state's `lastBoot` stays the authority for boot ACTION. Every method is
// best-effort and never throws into the boot — a report that cannot be
// written costs one warning, never a start.
const fs = require("fs");
const path = require("path");

const { writeFileAtomic } = require("./utils/safe-file");

const kBootReportSchema = "alphaclaw.boot-report.v1";
const kBootReportFileName = "boot-report.json";
const kBootReportIncidentFileName = "boot-report-incident.json";
const kBootReportRefusedFileName = "boot-report-refused.json";
// Current + two rotated predecessors.
const kBootReportRingSize = 3;
// A pinned incident report older than this is replaced even when the verdict
// and version match: a week-old explanation is a stale explanation.
const kIncidentPinMaxAgeMs = 7 * 24 * 60 * 60 * 1000;

// binPhase.status — how the bin-phase half of the file came to be:
//   ok          written by writeBinPhase in this boot
//   missing     the server phase found no file (bin phase never wrote, or the
//               write failed) and created the report itself
//   mismatch    the file belonged to another boot (bootId differs); replaced
//               instead of merged, previousBootId kept for the diagnose view
//   unreadable  the file was corrupt; rewritten from scratch
const kBinPhaseStatuses = Object.freeze({
  ok: "ok",
  missing: "missing",
  mismatch: "mismatch",
  unreadable: "unreadable",
});

// serverPhase.status — pending (bin wrote, server not yet), recorded (at
// least one merge), not_reached (a bin-exit or non-onboarded boot).
const kServerPhaseStatuses = Object.freeze({
  pending: "pending",
  recorded: "recorded",
  notReached: "not_reached",
});

// serverPhase.reason for the bin-exit path the sync itself knows about: the
// pidfile guard skipped for a corroborated live owner and bin/alphaclaw.js
// refuses to start (the not-onboarded reason lives in boot-report-steps.js).
const kPidfileSkipReason = "pidfile_skip";

// verdict[] entries. A non-empty verdict is an INCONSISTENT boot. This is the
// persisted vocabulary the diagnose renderer, the `boot` watchdog event and
// the INCONSISTENT notification line all print — extend it here only.
const kBootVerdicts = Object.freeze({
  installedNotExpected: "installed_not_expected",
  stateSchemaTooNew: "state_schema_too_new",
  agentSchemaTooNew: "agent_schema_too_new",
  legacyExecApprovalsPresent: "legacy_exec_approvals_present",
  pidfileContradiction: "pidfile_contradiction",
  stateDbUnreadable: "state_db_unreadable",
});

const kBinPhaseFields = Object.freeze({
  alphaclaw: ["version", "commit", "previousVersion", "firstBootOfVersion"],
  container: ["pid1StartTicks", "startMs"],
  openclaw: [
    "declaredPin",
    "channelApplied",
    "lastKnownGood",
    "expected",
    "installedAtBoot",
    "resolvedForLaunch",
    // computeInstalledDiverged over resolvedForLaunch (the canonical
    // predicate, honours a live pinLag); null when either side is unknown.
    "installedDiverged",
    "overlayPresent",
    "overlayComplete",
    "sentinelMatches",
  ],
});

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const nonEmptyString = (value) =>
  typeof value === "string" && value !== "" ? value : null;

// Every declared key present (null when unknown) so the persisted shape is
// stable across boxes and the diagnose renderer never sees a missing column.
const pickFields = (source, keys) => {
  const record = isPlainObject(source) ? source : {};
  const out = {};
  for (const key of keys) out[key] = record[key] === undefined ? null : record[key];
  return out;
};

const normalizeWarnings = (warnings) =>
  Array.isArray(warnings) ? warnings.map((warning) => String(warning)) : [];

// The verdict as a sorted, de-duplicated string set — the shape both the
// incident pin comparison and the notification line rely on.
const normalizeVerdict = (verdict) =>
  Array.isArray(verdict)
    ? [...new Set(verdict.filter((entry) => typeof entry === "string" && entry !== ""))].sort()
    : [];

const sameVerdictSet = (left, right) =>
  left.length === right.length && left.every((entry, index) => entry === right[index]);

// Shapes the bin-phase report from what bin/alphaclaw.js knows after the boot
// sync; pure. `pidDecision` is the store's describeServerPidDecision() record
// and is persisted AS-IS (its `record.raw` is the pidfile — pid/host/ticks,
// no secrets). `bootSync` is syncAtBoot's { action, reason, warnings,
// danglingRecords }.
const normalizeDanglingRecords = (value) => {
  if (!isPlainObject(value)) return null;
  const closedRuns = Array.isArray(value.closedRuns)
    ? value.closedRuns.map((id) => nonEmptyString(id)).filter(Boolean)
    : [];
  return { closedRuns, closedLastUpdateRun: value.closedLastUpdateRun === true };
};

const buildBinPhaseReport = ({
  bootId = null,
  at = null,
  alphaclaw = null,
  container = null,
  pidDecision = null,
  openclaw = null,
  bootSync = null,
} = {}) => ({
  schema: kBootReportSchema,
  bootId: nonEmptyString(bootId),
  at: Number.isFinite(Number(at)) && at !== null ? Number(at) : null,
  alphaclaw: pickFields(alphaclaw, kBinPhaseFields.alphaclaw),
  container: pickFields(container, kBinPhaseFields.container),
  pidfile: isPlainObject(pidDecision) ? pidDecision : null,
  openclaw: {
    ...pickFields(openclaw, kBinPhaseFields.openclaw),
    bootSync: {
      action: nonEmptyString(bootSync?.action),
      reason: nonEmptyString(bootSync?.reason),
      warnings: normalizeWarnings(bootSync?.warnings),
      // What the bin phase's dangling-record closer closed (#76 A7); null
      // when that boot never reached the closer. The server phase unions it
      // into serverPhase.danglingRecords.
      danglingRecords: normalizeDanglingRecords(bootSync?.danglingRecords),
    },
  },
  binPhase: { status: kBinPhaseStatuses.ok },
  serverPhase: { status: kServerPhaseStatuses.pending },
});

// The versions a report speaks for, by evidence quality — ONE reader for the
// verdict rule, the `boot` event and the INCONSISTENT line:
//   expected  the bin phase's expectedVersionOf(state), else the live channel
//             info the server phase snapshotted (no usable bin phase)
//   running   the tree the gateway will RUN: the bin phase's post-sync read
//             (resolvedForLaunch), else the server phase's own read, else the
//             snapshotted channel info. NEVER installedAtBoot — the pre-sync
//             tree is evidence about the sync (an activation boot legitimately
//             differs there), not about the launch.
//   diverged  the canonical computeInstalledDiverged answer where a phase
//             recorded one (bin over resolvedForLaunch, else the channel
//             snapshot — both honour a live pinLag, the expected npm lag of
//             an AlphaClaw self-update), else the plain comparison of running
//             vs expected; null when neither side is known.
const describeReportVersions = (report) => {
  const openclaw = isPlainObject(report?.openclaw) ? report.openclaw : {};
  const server = isPlainObject(report?.serverPhase) ? report.serverPhase : {};
  const channel = isPlainObject(server.channelInfo) ? server.channelInfo : {};
  const expected =
    nonEmptyString(openclaw.expected) ?? nonEmptyString(channel.expectedVersion);
  const running =
    nonEmptyString(openclaw.resolvedForLaunch) ??
    nonEmptyString(server.installedVersion) ??
    nonEmptyString(channel.installedVersion);
  const predicate = [openclaw.installedDiverged, channel.installedDiverged].find(
    (value) => typeof value === "boolean",
  );
  const diverged =
    predicate !== undefined
      ? predicate
      : expected !== null && running !== null
        ? running !== expected
        : null;
  return { expected, running, diverged };
};

// Pure verdict over the WHOLE report (bin + server phase); the caller never
// hand-writes verdict entries. Each rule fires only on evidence that is
// present — an unknown value is silence, never a finding:
//   installed_not_expected        describeReportVersions().diverged — the tree
//                                 the gateway will RUN is not the expected
//                                 build (never the pre-sync installedAtBoot)
//   state_schema_too_new /        a stateDb entry of that kind whose
//   agent_schema_too_new          userVersion exceeds supportedSchema.<kind>
//   state_db_unreadable           a stateDb entry read as `corrupt`
//                                 (SQLITE_CORRUPT / SQLITE_NOTADB, CEO 2.1)
//   legacy_exec_approvals_present serverPhase.legacyExecApprovalsPresent
//   pidfile_contradiction         the bin phase SKIPPED the sync because a
//                                 live server supposedly owned the dir, yet
//                                 this process reached the server phase — the
//                                 claim named something that was not a server
//                                 (#76 RC1: a thread id passed as a pid)
const computeVerdict = (report) => {
  const verdict = [];
  const server = isPlainObject(report?.serverPhase) ? report.serverPhase : {};

  if (describeReportVersions(report).diverged === true) {
    verdict.push(kBootVerdicts.installedNotExpected);
  }

  const supported = isPlainObject(server.supportedSchema) ? server.supportedSchema : {};
  const stateDb = Array.isArray(server.stateDb) ? server.stateDb.filter(isPlainObject) : [];
  const tooNew = (kind) =>
    Number.isInteger(supported[kind]) &&
    stateDb.some(
      (entry) =>
        entry.kind === kind &&
        Number.isInteger(entry.userVersion) &&
        entry.userVersion > supported[kind],
    );
  if (tooNew("state")) verdict.push(kBootVerdicts.stateSchemaTooNew);
  if (tooNew("agent")) verdict.push(kBootVerdicts.agentSchemaTooNew);
  if (stateDb.some((entry) => entry.status === "corrupt")) {
    verdict.push(kBootVerdicts.stateDbUnreadable);
  }

  if (server.legacyExecApprovalsPresent === true) {
    verdict.push(kBootVerdicts.legacyExecApprovalsPresent);
  }

  const serverReached =
    server.status === kServerPhaseStatuses.recorded;
  if (serverReached && report?.pidfile?.decision === "skip") {
    verdict.push(kBootVerdicts.pidfileContradiction);
  }

  return verdict;
};

const createBootReportWriter = ({
  fsModule = fs,
  managedDir,
  nowFn = Date.now,
  bootId,
  logger = console,
} = {}) => {
  if (typeof managedDir !== "string" || managedDir === "") {
    throw new TypeError("createBootReportWriter: managedDir is required");
  }
  const ownBootId = nonEmptyString(bootId);
  if (ownBootId === null) {
    throw new TypeError("createBootReportWriter: bootId is required");
  }
  const reportPath = path.join(managedDir, kBootReportFileName);
  const incidentPath = path.join(managedDir, kBootReportIncidentFileName);
  const refusedPath = path.join(managedDir, kBootReportRefusedFileName);
  const ringPath = (index) =>
    index === 0 ? reportPath : path.join(managedDir, `boot-report.${index}.json`);

  const warn = (message) => {
    try {
      logger.warn(`[boot-report] ${message}`);
    } catch {}
  };

  const now = () => {
    const value = Number(nowFn());
    return Number.isFinite(value) ? value : Date.now();
  };

  const writeReport = (filePath, report) => {
    writeFileAtomic(filePath, `${JSON.stringify(report, null, 2)}\n`, { fsModule });
    return report;
  };

  // { status: "ok", report } | { status: "missing" } | { status: "unreadable", error }
  const readReportFile = (filePath) => {
    let raw;
    try {
      raw = fsModule.readFileSync(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { status: "missing" };
      return { status: "unreadable", error };
    }
    try {
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed)) {
        return { status: "unreadable", error: new Error("not a JSON object") };
      }
      return { status: "ok", report: parsed };
    } catch (error) {
      return { status: "unreadable", error };
    }
  };

  // A report the server phase has to create itself (no usable bin half).
  // Same key set as buildBinPhaseReport with nulls, so readers see one shape.
  const freshReport = (binPhase, extra = {}) => ({
    ...buildBinPhaseReport({ bootId: ownBootId, at: now() }),
    alphaclaw: null,
    container: null,
    pidfile: null,
    openclaw: null,
    ...extra,
    binPhase,
  });

  // The report a server-phase write starts from, and why.
  const resolveBase = () => {
    const read = readReportFile(reportPath);
    if (read.status === "ok") {
      const fileBootId = nonEmptyString(read.report.bootId);
      if (fileBootId === ownBootId) return { base: read.report, origin: "merge" };
      warn(
        `${reportPath} belongs to boot ${fileBootId ?? "?"}, not ${ownBootId} — writing a fresh report instead of merging`,
      );
      return {
        base: freshReport({ status: kBinPhaseStatuses.mismatch, previousBootId: fileBootId }),
        origin: kBinPhaseStatuses.mismatch,
      };
    }
    if (read.status === "missing") {
      warn(`${reportPath} is missing (no bin phase) — creating it from the server phase`);
      return { base: freshReport({ status: kBinPhaseStatuses.missing }), origin: kBinPhaseStatuses.missing };
    }
    warn(
      `${reportPath} is unreadable (${read.error?.message || read.error}) — rewriting it from scratch`,
    );
    return {
      base: freshReport({ status: kBinPhaseStatuses.unreadable }, { previous: "unreadable" }),
      origin: kBinPhaseStatuses.unreadable,
    };
  };

  // Rotation: current → .1 → .2, the oldest falls off. ENOENT is the normal
  // state of a young box; anything else is logged and the write proceeds.
  const rotateRing = () => {
    for (let index = kBootReportRingSize - 2; index >= 0; index -= 1) {
      try {
        fsModule.renameSync(ringPath(index), ringPath(index + 1));
      } catch (error) {
        if (error?.code !== "ENOENT") {
          warn(`could not rotate ${ringPath(index)} (${error?.message || error})`);
        }
      }
    }
  };

  // The bin-phase half as persisted: schema and the writer's own bootId
  // stamped over whatever the source carried (the merge guard compares
  // against the writer's id; a report stamped with another id could never be
  // completed, so the writer's wins).
  const stampBinPhase = (report) => {
    const source = isPlainObject(report) ? report : buildBinPhaseReport({ at: now() });
    const fileBootId = nonEmptyString(source.bootId);
    if (fileBootId !== null && fileBootId !== ownBootId) {
      warn(`bin-phase report carries bootId ${fileBootId}; stamping ${ownBootId}`);
    }
    return {
      ...source,
      schema: kBootReportSchema,
      bootId: ownBootId,
      binPhase: isPlainObject(source.binPhase) ? source.binPhase : { status: kBinPhaseStatuses.ok },
    };
  };

  const writeBinPhase = (report) => {
    try {
      fsModule.mkdirSync(managedDir, { recursive: true });
      rotateRing();
      return writeReport(reportPath, {
        ...stampBinPhase(report),
        serverPhase: { status: kServerPhaseStatuses.pending },
      });
    } catch (error) {
      warn(`could not write ${reportPath} (${error?.message || error})`);
      return null;
    }
  };

  // A refused start: the pidfile guard skipped for a CORROBORATED live owner
  // and bin/alphaclaw.js exits 1 right after the sync, so no server phase
  // will ever merge. The ring is not rotated and slot 0 is not written — the
  // live server's completed report stays current (a doomed second instance
  // must never evict it; three refused starts would empty a 3-slot ring).
  // The refused attempt is written whole to boot-report-refused.json with
  // its server phase already not_reached and the verdict over the bin half.
  const writeRefusedBinPhase = (report, reason = kPidfileSkipReason) => {
    try {
      fsModule.mkdirSync(managedDir, { recursive: true });
      const refused = {
        ...stampBinPhase(report),
        serverPhase: {
          status: kServerPhaseStatuses.notReached,
          reason: nonEmptyString(reason) ?? "unknown",
          at: now(),
        },
      };
      refused.serverPhase.verdict = computeVerdict(refused);
      return writeReport(refusedPath, refused);
    } catch (error) {
      warn(`could not write ${refusedPath} (${error?.message || error})`);
      return null;
    }
  };

  const writeServerPhase = (buildServerPhase) => {
    try {
      const { base } = resolveBase();
      const previous = isPlainObject(base.serverPhase) ? base.serverPhase : {};
      const merged = { ...base, serverPhase: buildServerPhase(previous) };
      if (!Array.isArray(merged.serverPhase.verdict)) {
        merged.serverPhase.verdict = computeVerdict(merged);
      }
      return writeReport(reportPath, merged);
    } catch (error) {
      warn(`could not write ${reportPath} (${error?.message || error})`);
      return null;
    }
  };

  // Shallow-merges `patch` into serverPhase. The verdict is DERIVED from the
  // merged report unless the patch carries one, so an early merge (before the
  // compat gate) holds the partial verdict and the final merge the full one.
  // The verdict a previous merge persisted is dropped first — it described
  // less evidence than this merge has, so carrying it would freeze it.
  // Returns the merged report (the caller logs/replays it) or null.
  const mergeServerPhase = (patch) =>
    writeServerPhase((previous) => {
      const fields = isPlainObject(patch) ? patch : {};
      const { verdict: _stale, ...carried } = previous;
      const status =
        nonEmptyString(fields.status) ??
        (carried.status && carried.status !== kServerPhaseStatuses.pending
          ? carried.status
          : kServerPhaseStatuses.recorded);
      return { ...carried, ...fields, status, at: now() };
    });

  // Non-onboarded boots and bin-exit paths: the server phase will never run.
  const markServerPhaseNotReached = (reason) =>
    writeServerPhase(() => ({
      status: kServerPhaseStatuses.notReached,
      reason: nonEmptyString(reason) ?? "unknown",
      at: now(),
    }));

  const installedOf = (report) => nonEmptyString(report?.openclaw?.installedAtBoot);

  // { pinned, reason } — reason ∈ no_report | consistent | already_pinned |
  // first | version_changed | verdict_changed | expired | replaced_unreadable
  const pinIncidentReport = (report) => {
    try {
      if (!isPlainObject(report)) return { pinned: false, reason: "no_report" };
      const verdict = normalizeVerdict(report.serverPhase?.verdict);
      if (verdict.length === 0) return { pinned: false, reason: "consistent" };
      const existing = readReportFile(incidentPath);
      let reason = "first";
      if (existing.status === "ok") {
        const pin = existing.report;
        const pinnedAt = Number(pin.pinnedAt ?? pin.at);
        const fresh = Number.isFinite(pinnedAt) && now() - pinnedAt < kIncidentPinMaxAgeMs;
        const sameVersion = installedOf(pin) === installedOf(report);
        const sameVerdict = sameVerdictSet(normalizeVerdict(pin.serverPhase?.verdict), verdict);
        if (fresh && sameVersion && sameVerdict) {
          return { pinned: false, reason: "already_pinned" };
        }
        reason = !sameVersion ? "version_changed" : !sameVerdict ? "verdict_changed" : "expired";
      } else if (existing.status === "unreadable") {
        reason = "replaced_unreadable";
      }
      writeReport(incidentPath, { ...report, pinnedAt: now() });
      return { pinned: true, reason };
    } catch (error) {
      warn(`could not write ${incidentPath} (${error?.message || error})`);
      return { pinned: false, reason: "write_failed" };
    }
  };

  // Lenient: a missing or corrupt file is a null (or an absent ring slot),
  // never an exception; `unreadable` names the corrupt files for diagnose.
  // `refused` is the last refused start (boot-report-refused.json), if any.
  const readBootReports = () => {
    const out = { current: null, previous: [], incident: null, refused: null, unreadable: [] };
    try {
      const note = (read, filePath) => {
        if (read.status === "unreadable") out.unreadable.push(path.basename(filePath));
        return read.status === "ok" ? read.report : null;
      };
      out.current = note(readReportFile(reportPath), reportPath);
      for (let index = 1; index < kBootReportRingSize; index += 1) {
        const report = note(readReportFile(ringPath(index)), ringPath(index));
        if (report) out.previous.push(report);
      }
      out.incident = note(readReportFile(incidentPath), incidentPath);
      out.refused = note(readReportFile(refusedPath), refusedPath);
    } catch (error) {
      warn(`could not read boot reports (${error?.message || error})`);
    }
    return out;
  };

  // The report THIS boot's bin phase wrote, or null when slot 0 is missing,
  // unreadable or belongs to another boot (the server steps read the bin
  // phase's facts — e.g. bootSync.danglingRecords — through this, never by
  // parsing the file themselves). Never throws.
  const readOwnReport = () => {
    try {
      const read = readReportFile(reportPath);
      if (read.status !== "ok") return null;
      return nonEmptyString(read.report.bootId) === ownBootId ? read.report : null;
    } catch {
      return null;
    }
  };

  return {
    reportPath,
    incidentPath,
    refusedPath,
    bootId: ownBootId,
    writeBinPhase,
    writeRefusedBinPhase,
    mergeServerPhase,
    readOwnReport,
    markServerPhaseNotReached,
    pinIncidentReport,
    readBootReports,
  };
};

module.exports = {
  kBootReportSchema,
  kBootReportFileName,
  kBootReportIncidentFileName,
  kBootReportRefusedFileName,
  kBootReportRingSize,
  kIncidentPinMaxAgeMs,
  kBinPhaseStatuses,
  kServerPhaseStatuses,
  kPidfileSkipReason,
  kBootVerdicts,
  buildBinPhaseReport,
  describeReportVersions,
  computeVerdict,
  normalizeVerdict,
  createBootReportWriter,
};
