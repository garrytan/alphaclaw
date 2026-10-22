// Pure formatting helpers for watchdog notices and status (no watchdog state).
const ownerLease = require("./openclaw-owner-lease");
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
const buildMemoryStatsLine = ({ rssMb, effectiveCapMb, slopeMbPerHour }) => {
  const cap = effectiveCapMb ? ` of ${effectiveCapMb}MB group budget` : "";
  const slope =
    slopeMbPerHour != null ? ` (+${slopeMbPerHour} MB/h)` : "";
  return `Group RSS: ${rssMb ?? "?"}MB${cap}${slope}`;
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
  createCorrelationId,
  asInlineCode,
  describeOwnerLease,
  ownerLeaseGraceUntilMs,
  describeRestartFailureNote,
};
