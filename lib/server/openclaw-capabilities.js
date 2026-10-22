// What the installed OpenClaw can do. AlphaClaw runs only the OpenClaw its
// package.json pins (openclaw-pin-state.js surfaces a diverged or unreadable
// install on status, General and Doctor), and every capability the old CLI
// probes detected is present on the pin. So the public answers
// (GET /api/openclaw/capabilities, routes/team.js) are constants with the keys
// and value shapes the probes returned. Checked against the pinned 2026.10.4
// CLI: `gateway restart-handoff capabilities --json` answers protocol 1 with
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

// Two internal consumers still probe the CLI until the file-era exec-approval
// paths go (refactor plan PR 16b): routes/nodes.js (execApprovalsCli picks the
// approvals CLI over the legacy file) and openclaw-state-era.js
// (execApprovalsSqlite is the era evidence for a dev build the version gate
// cannot classify). Answers cache per installed version; a failure caches
// briefly so a transient error never hides the capability for long.
const kNegativeTtlMs = 60 * 1000;
// A TIMED-OUT probe retries sooner: every CLI invocation serializes on a
// startup-migration lease that a long doctor --fix can hold for minutes.
const kTimedOutTtlMs = 30 * 1000;

const kUnknownCommand = /unknown command|unrecognized|unexpected argument|not a valid|no such (?:command|subcommand)/i;

const kProbes = {
  execApprovalsCli: {
    falsy: false,
    run: async (clawCmd) => {
      const r = await clawCmd("approvals --help", { quiet: true, timeoutMs: 10000 });
      const text = `${r.stdout}\n${r.stderr}`;
      if (kUnknownCommand.test(text)) return false;
      return r.ok || /usage|options|--help/i.test(text);
    },
  },
  // Era discriminator (issue #23 follow-up): "sqlite" | "file" | "unknown".
  // The `approvals` group exists on BOTH eras; only the sqlite era lists the
  // `pending` subcommand. Probing the PARENT help is load-bearing: commander 15
  // prints the parent help and exits 0 for unknown-subcommand + --help.
  // "unknown" (probe failed/timed out) is the negative value so a transient
  // failure is retried, while both determinate answers cache for the version.
  execApprovalsSqlite: {
    falsy: "unknown",
    run: async (clawCmd) => {
      const r = await clawCmd("approvals --help", { quiet: true, timeoutMs: 10000 });
      if (r.timedOut) return "unknown";
      const text = `${r.stdout}\n${r.stderr}`;
      // No approvals group at all: an ancient build — file era. openclaw
      // rewrites commander's unknown-command error to `OpenClaw does not know
      // the command "…"`, which the shared kUnknownCommand regex misses.
      if (kUnknownCommand.test(text) || /does not know the command/i.test(text)) {
        return "file";
      }
      if (!r.ok && !/usage|options|--help/i.test(text)) return "unknown";
      return /^\s*pending\b/m.test(text) ? "sqlite" : "file";
    },
  },
};

const createOpenclawCapabilities = ({
  clawCmd,
  getInstalledVersion = () => null,
  nowFn = Date.now,
  logger = console,
} = {}) => {
  if (typeof clawCmd !== "function") {
    throw new Error("createOpenclawCapabilities requires a clawCmd function");
  }
  // Map<probeKey, { version, value, at, positive, timedOut }>
  const cache = new Map();

  const isFresh = (entry, version) => {
    if (!entry || entry.version !== version) return false;
    if (entry.positive) return true;
    return nowFn() - entry.at < (entry.timedOut ? kTimedOutTtlMs : kNegativeTtlMs);
  };

  const runProbe = async (key) => {
    const spec = kProbes[key];
    const version = getInstalledVersion() || "unknown";
    const cached = cache.get(key);
    if (isFresh(cached, version)) return cached.value;
    let sawTimeout = false;
    const trackingClawCmd = async (cmd, opts) => {
      const result = await clawCmd(cmd, opts);
      if (result?.timedOut) sawTimeout = true;
      return result;
    };
    let value = spec.falsy;
    try {
      const probed = await spec.run(trackingClawCmd);
      if (probed !== undefined) value = probed;
    } catch (error) {
      logger.warn?.(`[openclaw-capabilities] probe ${key} failed: ${error.message}`);
    }
    const positive = value !== spec.falsy;
    cache.set(key, { version, value, at: nowFn(), positive, timedOut: sawTimeout && !positive });
    return value;
  };

  // get() still probes the two keys the internal consumers read; every other
  // key, and the whole public map, is the pinned constant and never spawns.
  const get = async (key) => {
    if (!Object.hasOwn(kPinnedCapabilities, key)) {
      throw new Error(`unknown OpenClaw capability: ${key}`);
    }
    return kProbes[key] ? runProbe(key) : kPinnedCapabilities[key];
  };

  const getAll = async () => ({ ...kPinnedCapabilities });

  const invalidate = (key) => {
    if (key === undefined) cache.clear();
    else cache.delete(key);
  };

  return {
    get,
    getAll,
    invalidate,
    // exposed for tests / diagnostics
    _cacheSize: () => cache.size,
  };
};

module.exports = {
  createOpenclawCapabilities,
  kPinnedCapabilities,
  kCapabilityKeys: Object.keys(kPinnedCapabilities),
  kNegativeTtlMs,
  kTimedOutTtlMs,
};
