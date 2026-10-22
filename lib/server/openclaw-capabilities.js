// What the pinned OpenClaw can do. AlphaClaw runs only the OpenClaw its
// package.json pins (openclaw-pin-state.js surfaces a diverged or unreadable
// install on status, General and Doctor), and every capability the old CLI
// probes detected is present on the pin. So GET /api/openclaw/capabilities and
// routes/team.js read constants with the keys and value shapes the probes
// returned. Checked against the pinned 2026.10.4 CLI:
// `gateway restart-handoff capabilities --json` answers protocol 1 with
// `consume`; `database preflight`, `backup sqlite`, `secrets store` and
// `update repair` print usage; `approvals --help` lists `pending`; the
// `channels add` enum lists `buzz`; `channels add clickclack --help` has
// `--code`; and `gateway.auth.trustedProxy.deviceAutoApprove.enabled` is a
// valid config path.
const kPinnedCapabilities = Object.freeze({
  restartHandoff: Object.freeze({ supported: true, protocolVersion: 1, consume: true }),
  databasePreflight: true,
  backupSqlite: true,
  secretsStore: true,
  updateRepair: true,
  execApprovalsCli: true,
  execApprovalsSqlite: "sqlite",
  buzzChannel: true,
  clickclackGuidedSetup: true,
  trustedProxyTeam: true,
});

const createOpenclawCapabilities = () => {
  const get = async (key) => {
    if (!Object.hasOwn(kPinnedCapabilities, key)) {
      throw new Error(`unknown OpenClaw capability: ${key}`);
    }
    return kPinnedCapabilities[key];
  };

  const getAll = async () => ({ ...kPinnedCapabilities });

  return { get, getAll };
};

module.exports = {
  createOpenclawCapabilities,
  kPinnedCapabilities,
  kCapabilityKeys: Object.keys(kPinnedCapabilities),
};
