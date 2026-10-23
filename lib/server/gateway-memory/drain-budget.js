// Memory-mitigation drain budget (ALPH-17, plan D2). A mitigation restart
// asks OpenClaw to drain for as long as the memory headroom allows, so an
// agent turn in flight can finish instead of being cut at 30 s, and only an
// imminent OOM takes the short ladder.
//
//   eta   = the soonest of the policy-cap crossing (worker memory → budget at
//           the fitted slope), the physical one (container working set →
//           limit at the same slope) and the V8 heap's (heap used → heap
//           limit at the same slope, ALPH-22), never later than the
//           exhaustion time fixed when the mitigation was decided
//   grace = clamp(eta / 2 − (term + kill), 30 s, OpenClaw's own 300 s)
//   imminent (eta ≤ 120 s, container or heap ≥ 97%, or no projection at
//   ≥ 97% policy pressure) → the 30 s short ladder
//
// The half-ETA factor leaves the worst case (grace + the CLI's ack window +
// OpenClaw's shutdown reserve + term + kill) well inside the projection. Pure:
// the watchdog evaluates it at the decision and again from a fresh sample
// right before the ask spawns, after preflight and notification awaits.
const {
  kOpenclawDefaultRestartDrainMs,
  kGatewayStopAskGraceMs,
  kGatewayStopTermGraceMs,
  kGatewayStopKillGraceMs,
} = require("../constants");

const kImminentEtaMs = 120_000;
const kImminentPressure = 0.97;
const kDrainReasons = Object.freeze(["derived", "imminent", "no_projection"]);

const etaToCrossing = ({ usedBytes, limitBytes, slopeBytesPerMs }) => {
  if (!Number.isFinite(usedBytes) || !Number.isFinite(limitBytes) || limitBytes <= 0) return null;
  if (usedBytes >= limitBytes) return 0;
  if (!Number.isFinite(slopeBytesPerMs) || slopeBytesPerMs <= 0) return null;
  return (limitBytes - usedBytes) / slopeBytesPerMs;
};

const resolveMemoryDrainBudget = ({
  nowMs,
  rssBytes = null,
  capBytes = null,
  slopeBytesPerMs = null,
  cgroupUsedBytes = null,
  containerLimitBytes = null,
  heapUsedBytes = null,
  heapLimitBytes = null,
  exhaustionDeadlineAtMs = null,
} = {}) => {
  const short = (reason, etaMs) => ({ askGraceMs: kGatewayStopAskGraceMs, reason, etaMs });
  const containerPressure = Number.isFinite(cgroupUsedBytes) && Number.isFinite(containerLimitBytes) &&
    containerLimitBytes > 0 ? cgroupUsedBytes / containerLimitBytes : null;
  const policyPressure = Number.isFinite(rssBytes) && Number.isFinite(capBytes) && capBytes > 0
    ? rssBytes / capBytes : null;
  const candidates = [
    etaToCrossing({ usedBytes: rssBytes, limitBytes: capBytes, slopeBytesPerMs }),
    etaToCrossing({ usedBytes: cgroupUsedBytes, limitBytes: containerLimitBytes, slopeBytesPerMs }),
    etaToCrossing({ usedBytes: heapUsedBytes, limitBytes: heapLimitBytes, slopeBytesPerMs }),
    Number.isFinite(exhaustionDeadlineAtMs) ? Math.max(0, exhaustionDeadlineAtMs - nowMs) : null,
  ].filter((value) => value !== null);
  const etaMs = candidates.length ? Math.round(Math.min(...candidates)) : null;
  const heapPressure = Number.isFinite(heapUsedBytes) && Number.isFinite(heapLimitBytes) && heapLimitBytes > 0
    ? heapUsedBytes / heapLimitBytes : null;
  if ([containerPressure, heapPressure].some((value) => value !== null && value >= kImminentPressure)) {
    return short("imminent", etaMs);
  }
  if (etaMs === null) {
    return short(policyPressure !== null && policyPressure >= kImminentPressure ? "imminent" : "no_projection", null);
  }
  if (etaMs <= kImminentEtaMs) return short("imminent", etaMs);
  const derived = etaMs / 2 - (kGatewayStopTermGraceMs + kGatewayStopKillGraceMs);
  const askGraceMs = Math.round(Math.min(kOpenclawDefaultRestartDrainMs, Math.max(kGatewayStopAskGraceMs, derived)));
  return { askGraceMs, reason: "derived", etaMs };
};

module.exports = { resolveMemoryDrainBudget, kDrainReasons, kImminentEtaMs, kImminentPressure };
