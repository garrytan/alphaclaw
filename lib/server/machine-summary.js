// Numeric-only machine summary for TRUSTED prompt sections (gateway medic,
// upgrade overseer). Numbers + the internally-derived tier enum ONLY — never
// GPU names or any other external string, so nothing injectable can ride the
// trusted block. `activeGatewayHeapMb` is what the LAST SPAWN actually
// consumed (spawn-stamped); `pendingGatewayHeapMb` appears only when the
// current derivation differs — never describe a heap the crashed process
// never ran with.
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
  return summary;
};

module.exports = { getMachineSummaryForPrompt };
