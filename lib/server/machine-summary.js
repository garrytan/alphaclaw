// Numeric-only machine summary for TRUSTED prompt sections (gateway medic,
// upgrade overseer). Numbers + the internally-derived tier enum ONLY — never
// GPU names or any other external string, so nothing injectable can ride the
// trusted block. `activeGatewayHeapMb` is what the LAST SPAWN actually
// consumed (spawn-stamped); `pendingGatewayHeapMb` appears only when the
// current derivation differs — never describe a heap the crashed process
// never ran with.

// Gateway memory-trend source: registered from lib/server.js after
// createWatchdog (this module cannot require the watchdog INSTANCE). The
// trend fields it contributes follow the same contract — a number and an
// internally-derived enum, per the existing `tier` precedent. Module-global
// registration needs an explicit teardown so tests can't contaminate each
// other (loop-lag stop precedent).
let gatewayMemoryTrendSource = null;

const registerGatewayMemoryTrendSource = (fn) => {
  gatewayMemoryTrendSource = typeof fn === "function" ? fn : null;
};

const resetGatewayMemoryTrendSourceForTests = () => {
  gatewayMemoryTrendSource = null;
};

// The closed enum this module will forward — anything else reads as null
// (the source is our own detector, but the allowlist keeps the trusted-tier
// guarantee structural, not assumed).
const kForwardableTrendStates = new Set([
  "disabled",
  "no_gateway",
  "warming_up",
  "insufficient_samples",
  "normal",
  "watch",
  "leak_suspected",
  "critical",
]);

const getMachineSummaryForPrompt = () => {
  const { getMachineProfile } = require("./machine-profile");
  const {
    getActiveGatewayHeapMb,
    getDerivedGatewayHeapMb,
  } = require("./autotune");
  const num = (value) => (Number.isFinite(value) ? value : null);
  const profile = getMachineProfile();
  const summary = {
    memoryMb: profile?.memory?.limitBytes
      ? num(Math.round(profile.memory.limitBytes / (1024 * 1024)))
      : null,
    cores: num(profile?.cpu?.cores),
    tier: typeof profile?.tier === "string" ? profile.tier : null,
    activeGatewayHeapMb: num(getActiveGatewayHeapMb()),
  };
  const derivedHeapMb = num(getDerivedGatewayHeapMb());
  if (derivedHeapMb != null && derivedHeapMb !== summary.activeGatewayHeapMb) {
    summary.pendingGatewayHeapMb = derivedHeapMb;
  }
  // Memory-leak trend line (number + enum only): reaches every consumer of
  // this summary with zero consumer changes. Absent when no source is
  // registered, the source throws, or the trend is null — fields never
  // appear half-filled.
  if (gatewayMemoryTrendSource) {
    try {
      const trend = gatewayMemoryTrendSource();
      if (trend && typeof trend === "object") {
        const state = kForwardableTrendStates.has(trend.state)
          ? trend.state
          : null;
        if (state) {
          summary.gatewayMemoryTrendState = state;
          const slope = num(trend.slopeMbPerHour);
          if (slope != null) summary.gatewayRssTrendMbPerHour = slope;
        }
      }
    } catch {}
  }
  return summary;
};

module.exports = {
  getMachineSummaryForPrompt,
  registerGatewayMemoryTrendSource,
  resetGatewayMemoryTrendSourceForTests,
};
