const { kIncidentKeyByTrigger } = require("./watchdog-incidents");
const { kGatewayCrashCauses } = require("./gateway-crash-cause");
// Closed readiness enums for the trusted status projection (#87).
const {
  kReadinessStatuses,
  kReadinessProbeKinds,
} = require("./gateway-readiness");

// Recurrence context rides the TRUSTED tier, so every field is validated
// against a closed set the server itself defines — a corrupt or tampered
// rollup blob cannot smuggle free text (degradedReason, triggerDetail are
// gateway-influenced and never appear here).
const kTrustedIncidentKeys = new Set(Object.values(kIncidentKeyByTrigger));
const kTrustedSeverities = new Set(["warning", "critical"]);
const kTrustedIncidentStatuses = new Set(["open", "resolved", "abandoned"]);
const kTrustedOutcomes = new Set(["recovered", "abandoned"]);
// The crash classifier's closed cause enum (#76 A3). The watchdog reads the
// cause OUT of stderr, but only the enum VALUE rides the trusted tier — the
// matched line and detail are gateway text and stay in the event rows.
const kTrustedCrashCauses = new Set(kGatewayCrashCauses);
const kTrustedReadinessStatuses = new Set(kReadinessStatuses);
const kTrustedReadinessProbeKinds = new Set(kReadinessProbeKinds);

const rollupRecurrenceEntry = (incident = {}) => {
  const summary =
    incident.summary && typeof incident.summary === "object" ? incident.summary : {};
  return {
    id: Number.isFinite(incident.id) ? incident.id : null,
    trigger: pickClosedEnum(
      summary.trigger || incident.incidentKey || null,
      kTrustedIncidentKeys,
    ),
    severity: pickClosedEnum(summary.severity, kTrustedSeverities),
    status: pickClosedEnum(incident.status, kTrustedIncidentStatuses),
    outcome: pickClosedEnum(summary.outcome, kTrustedOutcomes),
    durationMs: Number.isFinite(summary.durationMs) ? summary.durationMs : null,
    openedAt: pickIsoTimestamp(incident.openedAt),
  };
};

// Trusted-tier snapshot projection is an ALLOWLIST, not a denylist: every
// field named here is an enum/number/timestamp/boolean the server itself
// computes. A new getStatus() field — including a future gateway-echoed
// string — stays OUT of the trusted tier until deliberately added.
const pickTrustedStatus = (s) =>
  s && typeof s === "object"
    ? {
        lifecycle: s.lifecycle,
        health: s.health,
        phase: s.phase,
        uptimeMs: s.uptimeMs,
        uptimeStartedAt: s.uptimeStartedAt,
        lastHealthCheckAt: s.lastHealthCheckAt,
        repairAttempts: s.repairAttempts,
        repairAttemptLimit: s.repairAttemptLimit,
        autoRepair: s.autoRepair,
        crashCountInWindow: s.crashCountInWindow,
        crashLoopThreshold: s.crashLoopThreshold,
        crashLoopWindowMs: s.crashLoopWindowMs,
        operationInProgress: s.operationInProgress,
        gatewayPid: s.gatewayPid,
        // Serving identity + readiness axis (v0.9.75): numbers/enums the
        // watchdog computes. readinessReason (gateway-echoed component names)
        // deliberately stays OUT of the trusted tier.
        servingPid: s.servingPid ?? null,
        supervisionMode: s.supervisionMode ?? null,
        readiness: s.readiness ?? null,
        // #87: what the last /readyz body said about its phase and how the
        // last read went — closed enums from watchdog.js; anything else
        // (a smuggled string) reads null.
        readinessStatus: pickClosedEnum(s.readinessStatus, kTrustedReadinessStatuses),
        readinessProbe: pickClosedEnum(s.readinessProbe, kTrustedReadinessProbeKinds),
        safeMode: s.safeMode,
        degradedSince: s.degradedSince,
        lastExit: s.lastExit
          ? {
              code: s.lastExit.code,
              signal: s.lastExit.signal,
              at: s.lastExit.at,
              // The classified cause (closed enum, #76 A3) and whether a fact
              // gathered independently of stderr corroborated it: true /
              // false once the async corroboration settled, null while it is
              // pending or when the cause has no corroborator.
              cause: pickClosedEnum(s.lastExit.cause, kTrustedCrashCauses),
              corroborated:
                typeof s.lastExit.corroborated === "boolean"
                  ? s.lastExit.corroborated
                  : null,
            }
          : null,
        startupGraceUntil: s.startupGraceUntil,
        expectedRestartUntil: s.expectedRestartUntil,
        backoff: s.backoff
          ? {
              active: s.backoff.active,
              untilMs: s.backoff.untilMs,
              attempt: s.backoff.attempt,
            }
          : null,
        serverNow: s.serverNow,
      }
    : null;

// Memory-leak trend projection: field-wise VALIDATED, not just field-picked —
// enums checked against their closed sets, timestamps must ISO-parse, the
// episode id must match the detector's `${pid}-${latchAtMs}` shape, numerics
// must be finite. Anything failing validation is dropped (null), never passed
// through: these fields ride the trusted prompt tier.
// Built from the detector's exported enum/pattern (single source of truth)
// while staying structural allowlists — membership checked, never assumed.
const {
  kMemoryTrendStates,
  kEpisodeIdPattern,
} = require("./gateway-memory-monitor");
const kTrustedTrendStates = new Set(kMemoryTrendStates);
// "budget" = the operator's watchdog.memory.budgetMb was the tightest cap (issue #56).
const kTrustedCapSources = new Set(["heap", "container", "derived_group_budget", "budget", "none"]);
const kTrustedContainerStates = new Set(["unknown", "normal", "critical", "disabled"]);
const kTrustedMemorySampleStatuses = new Set(["fresh", "stale", "partial", "unavailable"]);
const kTrustedContainerEpisodeReasons = new Set(["recovered", "detection_disabled"]);
const kTrustedMemoryTriggers = new Set(["trend", "fast_pressure"]);
const { projectMemoryEvidence } = require("./gateway-memory/evidence");
const kTrustedEpisodeReasons = new Set([
  "recovered",
  "process_exited",
  "detection_disabled",
  "basis_changed",
]);
const kTrustedRssBases = new Set(["worker", "group"]);
const pickFiniteNumber = (value) => (Number.isFinite(value) ? value : null);
// Strict ISO shape, not mere parseability: Date.parse accepts strings like
// "May 1 2026 (arbitrary payload)" (V8 treats paren content as a comment),
// which would ride the trusted tier verbatim. Round-tripping through
// toISOString pins the exact format the detector emits.
const pickIsoTimestamp = (value) => {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString() === value ? value : null;
};
const pickEpisodeId = (value) =>
  typeof value === "string" && kEpisodeIdPattern.test(value) ? value : null;
const pickClosedEnum = (value, allowed) => (allowed.has(value) ? value : null);
const pickContainerEpisodeId = (value) => typeof value === "string" && /^container-\d{1,16}$/.test(value) ? value : null;
const pickNonnegativeNumber = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const pickTrustedContainerMemory = (value) => value && typeof value === "object" ? {
  state: pickClosedEnum(value.state, kTrustedContainerStates),
  since: pickIsoTimestamp(value.since),
  usedBytes: pickNonnegativeNumber(value.usedBytes),
  limitBytes: Number.isFinite(value.limitBytes) && value.limitBytes > 0 ? value.limitBytes : null,
  pressureFraction: pickNonnegativeNumber(value.pressureFraction),
  sampledAt: pickIsoTimestamp(value.sampledAt),
  sampleStatus: pickClosedEnum(value.sampleStatus, kTrustedMemorySampleStatuses),
  episodeId: pickContainerEpisodeId(value.episodeId),
  lastEpisodeSummary: value.lastEpisodeSummary && typeof value.lastEpisodeSummary === "object" ? {
    episodeId: pickContainerEpisodeId(value.lastEpisodeSummary.episodeId),
    endedAt: pickIsoTimestamp(value.lastEpisodeSummary.endedAt),
    reason: pickClosedEnum(value.lastEpisodeSummary.reason, kTrustedContainerEpisodeReasons),
  } : null,
} : null;
const pickTrustedMemoryTrend = (trend) =>
  trend && typeof trend === "object"
    ? {
        state: pickClosedEnum(trend.state, kTrustedTrendStates),
        rssMb: pickFiniteNumber(trend.rssMb),
        slopeMbPerHour: pickFiniteNumber(trend.slopeMbPerHour),
        effectiveCapMb: pickFiniteNumber(trend.effectiveCapMb),
        capSource: pickClosedEnum(trend.capSource, kTrustedCapSources),
        pressureFraction: pickFiniteNumber(trend.pressureFraction),
        projectedExhaustionAt: pickIsoTimestamp(trend.projectedBudgetCrossingAt) ?? pickIsoTimestamp(trend.projectedExhaustionAt),
        projectedBudgetCrossingAt: pickIsoTimestamp(trend.projectedBudgetCrossingAt) ?? pickIsoTimestamp(trend.projectedExhaustionAt),
        episodeId: pickEpisodeId(trend.episodeId),
        ...(trend.sampleStatus !== undefined ? {
          sampleStatus: pickClosedEnum(trend.sampleStatus, kTrustedMemorySampleStatuses),
          sampledAt: pickIsoTimestamp(trend.sampledAt),
          groupPressureFraction: pickNonnegativeNumber(trend.groupPressureFraction),
          containerPressureFraction: pickNonnegativeNumber(trend.containerPressureFraction),
        } : {}),
        ...(trend.container ? { container: pickTrustedContainerMemory(trend.container) } : {}),
        ...(trend.evidence ? { scope: "gateway_group", evidence: projectMemoryEvidence(trend.evidence) } : {}),
        ...(trend.pressureSource ? { pressureSource: pickClosedEnum(trend.pressureSource, kTrustedCapSources) } : {}),
        ...(trend.rssBasis ? {
          rssBasis: pickClosedEnum(trend.rssBasis, kTrustedRssBases),
          groupRssMb: pickFiniteNumber(trend.groupRssMb),
        } : {}),
        lastEpisodeSummary:
          trend.lastEpisodeSummary && typeof trend.lastEpisodeSummary === "object"
            ? {
                episodeId: pickEpisodeId(trend.lastEpisodeSummary.episodeId),
                pid: pickFiniteNumber(trend.lastEpisodeSummary.pid),
                peakRssMb: pickFiniteNumber(trend.lastEpisodeSummary.peakRssMb),
                slopeMbPerHour: pickFiniteNumber(
                  trend.lastEpisodeSummary.slopeMbPerHour,
                ),
                endedAt: pickIsoTimestamp(trend.lastEpisodeSummary.endedAt),
                reason: pickClosedEnum(
                  trend.lastEpisodeSummary.reason,
                  kTrustedEpisodeReasons,
                ),
                mitigationCount: pickFiniteNumber(
                  trend.lastEpisodeSummary.mitigationCount,
                ),
                ...(trend.lastEpisodeSummary.evidence ? { evidence: projectMemoryEvidence(trend.lastEpisodeSummary.evidence) } : {}),
                ...(trend.lastEpisodeSummary.capSource ? {
                  effectiveCapMb: pickFiniteNumber(trend.lastEpisodeSummary.effectiveCapMb),
                  capSource: pickClosedEnum(trend.lastEpisodeSummary.capSource, kTrustedCapSources),
                  pressureSource: pickClosedEnum(trend.lastEpisodeSummary.pressureSource, kTrustedCapSources),
                  trigger: pickClosedEnum(trend.lastEpisodeSummary.trigger, kTrustedMemoryTriggers),
                  groupPressureFraction: pickNonnegativeNumber(trend.lastEpisodeSummary.groupPressureFraction),
                  containerPressureFraction: pickNonnegativeNumber(trend.lastEpisodeSummary.containerPressureFraction),
                  projectedBudgetCrossingAt: pickIsoTimestamp(trend.lastEpisodeSummary.projectedBudgetCrossingAt),
                } : {}),
              }
            : null,
      }
    : null;

const pickTrustedResources = (r) =>
  r && typeof r === "object"
    ? {
        memory: r.memory
          ? {
              usedBytes: r.memory.usedBytes,
              totalBytes: r.memory.totalBytes,
              percent: r.memory.percent,
            }
          : null,
        disk: r.disk
          ? {
              usedBytes: r.disk.usedBytes,
              totalBytes: r.disk.totalBytes,
              percent: r.disk.percent,
              path: r.disk.path,
            }
          : null,
        cpu: r.cpu ? { percent: r.cpu.percent, cores: r.cpu.cores } : null,
        gatewayMemoryTrend: pickTrustedMemoryTrend(r.gatewayMemoryTrend),
      }
    : null;

module.exports = {
  kTrustedIncidentKeys,
  kTrustedIncidentStatuses,
  pickTrustedStatus,
  pickFiniteNumber,
  pickIsoTimestamp,
  pickClosedEnum,
  pickTrustedResources,
  rollupRecurrenceEntry,
};
