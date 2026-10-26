// Pure formatting helpers for watchdog notices and status (no watchdog state).
const ownerLease = require("./openclaw-owner-lease");
const { describeRssBasis, describeMemorySplit } = require("./gateway-memory/evidence");
const { kPssStaleMs } = require("./gateway-memory/process-pss");
// Slack after the lease's recorded expiry before the relaunch: upstream deletes
// expired rows at acquire time (`expires_at <= now`), so a same-millisecond
// launch would still see it.
const kOwnerLeaseExpiryMarginMs = 2_000;

const humanizeToken = (value) => String(value ?? "").replace(/_/g, " ");
// ≥90 minutes reads better in hours (1 decimal); below that, minutes.
const kMemoryEtaHoursThresholdMins = 90;
const formatMemoryEta = (iso) => {
  const ts = Date.parse(String(iso || ""));
  if (!Number.isFinite(ts)) return "";
  const mins = Math.max(1, Math.round((ts - Date.now()) / 60000));
  if (mins < kMemoryEtaHoursThresholdMins) return `in ~${mins}m`;
  const hoursOneDecimal = Math.round((mins / 60) * 10) / 10;
  return `in ~${hoursOneDecimal}h`;
};
const bytesToMb = (bytes) => Number.isFinite(bytes) ? Math.round(bytes / (1024 * 1024)) : null;
// The monitor computes heap.fraction only from fresh, recent telemetry.
const describeWorkerHeap = (heap) => {
  if (heap?.usedMb == null || !heap.limitMb) return "Worker heap: unavailable (no V8 heap telemetry).";
  const stale = heap.status !== "fresh" || heap.fraction === null;
  return `Worker heap: V8 heap ${heap.usedMb} MB of its ${heap.limitMb} MB limit (${Math.round((heap.usedMb / heap.limitMb) * 100)}%)` +
    `${heap.floorsRising ? ", post-GC floors rising" : ""}${stale ? ", stale: the heap telemetry is not fresh" : ""}.`;
};
const describeWorkerPrivate = ({ memoryMb, memoryMeasure, evidence }, nowMs) => {
  const pss = evidence?.process?.pss;
  const ussMb = bytesToMb(pss?.workerPrivateBytes);
  const pssMb = bytesToMb(pss?.workerPssBytes);
  const ageMs = Number.isFinite(pss?.workerAtMs) ? nowMs - pss.workerAtMs : null;
  const pssFresh = pss?.workerStatus === "fresh" && ageMs !== null && ageMs >= 0 && ageMs <= kPssStaleMs;
  if (memoryMeasure === "private" && memoryMb != null) {
    return `Worker private memory: USS ${memoryMb} MB${pssFresh && pssMb !== null ? `, PSS ${pssMb} MB` : ""}.`;
  }
  if (ussMb === null && pssMb === null) return "Worker private memory: unavailable.";
  const values = [ussMb !== null && `USS ${ussMb} MB`, pssMb !== null && `PSS ${pssMb} MB`].filter(Boolean).join(", ");
  if (pssFresh) return `Worker private memory: ${values}.`;
  const age = ageMs !== null && ageMs >= 0 ? `sampled ${Math.max(1, Math.round(ageMs / 60_000))} min ago` : "sample age unknown";
  return `Worker private memory: ${values} (stale, ${age}).`;
};
const buildMemoryStatsLine = ({ rssMb, effectiveCapMb, slopeMbPerHour, rssBasis, evidence, memoryMb, memoryMeasure, heap, groupRssMb }) => {
  const { label, budget } = describeRssBasis(rssBasis);
  const cap = effectiveCapMb ? ` of ${effectiveCapMb}MB ${budget}` : "";
  const slope =
    slopeMbPerHour != null ? ` (+${slopeMbPerHour} MB/h)` : "";
  const groupLine = rssBasis === "worker"
    ? `Process group RSS (worker + launcher + tool children): ${groupRssMb != null ? `${groupRssMb} MB` : "unavailable"}, not the worker's own memory.`
    : "";
  return [
    `${label}: ${rssMb ?? "?"}MB${cap}${slope}`,
    describeWorkerHeap(heap),
    describeWorkerPrivate({ memoryMb, memoryMeasure, evidence }, Date.now()),
    groupLine,
    describeMemorySplit(evidence),
  ].filter(Boolean).join("\n");
};
// The container's memory PSI (cgroup memory.pressure, avg60), or "" when
// unreadable: the share of the last minute that tasks stalled on memory.
const describeContainerPsi = (pressure) => {
  const some = pressure?.psi?.some?.avg60;
  if (!Number.isFinite(some)) return "";
  const full = pressure.psi.full?.avg60;
  return `Container memory pressure (PSI, last 60 s): some ${some}%${Number.isFinite(full) ? `, full ${full}%` : ""} of the time stalled on memory.`;
};
// The memory mitigation's drain budget, as the restart notice states it.
const describeDrainBudget = ({ askGraceMs, reason } = {}) => {
  const seconds = Math.round((askGraceMs ?? 0) / 1000);
  if (reason === "imminent") return `Memory is nearly exhausted: OpenClaw gets the short ${seconds}s drain, so a running agent turn may be interrupted.`;
  if (reason === "derived") return `OpenClaw gets up to ${seconds}s to let running agent turns finish before it restarts (half the projected time to exhaustion).`;
  return `OpenClaw gets the default ${seconds}s drain (no exhaustion projection).`;
};
const createCorrelationId = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const asInlineCode = (value) =>
  `\`${String(value || "").replace(/`/g, "")}\``;
// Transient contention is outside the gateway's control: a state writer
// (another embedded OpenClaw writer holds the state directory) releases by
// itself, and a 2026.9.4+ owner lease left by a dead gateway lapses by
// itself (300 s after its last heartbeat). Neither Doctor nor `gateway stop`
// can resolve either. Sustained failure gets backoff relaunches only —
// for the lease, not before its recorded expiry — capped like a crash loop
// into a latched notice.
const describeOwnerLease = (lease) =>
  lease
    ? {
        status: lease.status,
        expiresAt: lease.expiresAt ?? null,
        heartbeatAt: lease.heartbeatAt ?? null,
        host: lease.owner?.host ?? null,
        pid: lease.owner?.pid ?? null,
      }
    : null;
// When the relaunch may run: the lease's recorded expiry plus a margin; an
// unreadable/missing read falls back to the full TTL from now (the lease can
// be no older than that); an expired/absent lease is ready now.
const ownerLeaseGraceUntilMs = (lease, nowMs = Date.now()) => {
  const ttl = ownerLease.kGatewayOwnerLeaseTtlMs + kOwnerLeaseExpiryMarginMs;
  if (!lease || lease.status === "unreadable" || lease.status === "missing") return nowMs + ttl;
  if (lease.status !== "held" || !Number.isFinite(lease.expiresAt)) return nowMs;
  return Math.min(lease.expiresAt + kOwnerLeaseExpiryMarginMs, nowMs + ttl);
};
// OpenClaw 2026.10's namespace refusal counts down to the moment it accepts a
// takeover ("wait N s and retry", openclaw-lock-contention.js): relaunch then,
// with the same margin as a lease expiry.
const ownerHeartbeatLapseAtMs = (retryAfterMs, nowMs = Date.now()) =>
  nowMs + retryAfterMs + kOwnerLeaseExpiryMarginMs;
const describeRestartFailureNote = (note) =>
  note
    ? {
        version: note.version,
        operationId: note.operationId,
        code: note.code,
        phase: note.phase,
        signalled: note.signalled,
        gatewayDown: note.gatewayDown,
        at: note.at,
        expiresAt: new Date(note.expiresAtMs).toISOString(),
        transferredToGeneration: note.transferredToGeneration,
      }
    : null;

module.exports = {
  humanizeToken,
  formatMemoryEta,
  buildMemoryStatsLine,
  describeContainerPsi,
  describeDrainBudget,
  createCorrelationId,
  asInlineCode,
  describeOwnerLease,
  ownerLeaseGraceUntilMs,
  ownerHeartbeatLapseAtMs,
  describeRestartFailureNote,
};
