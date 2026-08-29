// Feature-detect what the INSTALLED OpenClaw can do, never version-gate (repo
// philosophy — behavior is probed, not gated on a version string). Every probe is
// lazy and cached: keyed on the installed version for stable capabilities, and given
// a short TTL for plugin/config-dependent ones (buzz, clickclack, trustedProxyTeam)
// whose answer can change without the version changing (plugin install/uninstall,
// channel add/remove). Callers MUST invalidate after those mutations.
//
// HOT-PATH RULE: never call these from getChannelInfo() or the 2s status-SSE tick.
// Probe on first consumer demand (Upgrade page, watchdog transitions, Team page) and
// serve the cache everywhere else.

// A probe failure (timeout, crash, unparseable) is treated as "not supported" and
// cached only briefly, so a transient error never permanently hides a real capability.
const kNegativeTtlMs = 60 * 1000;
// Plugin/config-dependent capabilities can flip without a version change; bound how
// long a positive answer is trusted before a fresh probe.
const kPluginDependentTtlMs = 5 * 60 * 1000;

const kUnknownCommand = /unknown command|unrecognized|unexpected argument|not a valid|no such (?:command|subcommand)/i;
const kUnknownConfigPath = /unknown (?:config )?(?:path|key)|no such (?:path|key)|not a (?:known|valid) (?:config )?(?:path|key)/i;

const parseJsonLoose = (text) => {
  if (typeof text !== "string" || text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    // Some commands print a warning line before the JSON body; try the last
    // brace-balanced object.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
};

// Each probe returns a plain-serializable value (boolean, or a small object). A probe
// that throws or returns undefined is normalized to the declared `falsy` value.
const kProbes = {
  // { supported, protocolVersion, consume } — supervisors must probe capabilities
  // rather than infer support from a version string (docs/cli/gateway.md).
  restartHandoff: {
    pluginDependent: false,
    falsy: { supported: false, protocolVersion: 0, consume: false },
    run: async (clawCmd) => {
      const r = await clawCmd(
        "gateway restart-handoff capabilities --json",
        { quiet: true, timeoutMs: 10000 },
      );
      if (!r.ok) return { supported: false, protocolVersion: 0, consume: false };
      const doc = parseJsonLoose(r.stdout);
      if (!doc || typeof doc !== "object") {
        return { supported: false, protocolVersion: 0, consume: false };
      }
      const protocolVersion = Number(doc.protocolVersion ?? doc.protocol ?? 0) || 0;
      const consume =
        doc.consume === true ||
        (Array.isArray(doc.operations) && doc.operations.includes("consume"));
      return { supported: protocolVersion >= 1 && consume, protocolVersion, consume };
    },
  },
  databasePreflight: helpProbe("database preflight --help"),
  backupSqlite: helpProbe("backup sqlite --help"),
  secretsStore: helpProbe("secrets store --help"),
  updateRepair: helpProbe("update repair --help"),
  buzzChannel: {
    pluginDependent: true,
    falsy: false,
    run: async (clawCmd) => {
      // `--help` short-circuits BEFORE the CLI validates --channel values, so
      // probing "channels add --channel buzz --help" reports true everywhere.
      // The reliable signal is the supported-channel enum inside the help
      // text: "(telegram|whatsapp|...|buzz|...)".
      const r = await clawCmd("channels add --help", {
        quiet: true,
        timeoutMs: 10000,
      });
      if (!r.ok) return false;
      const text = `${r.stdout}\n${r.stderr}`.replace(/\s+/g, "");
      return /[(|]buzz[|)]/.test(text);
    },
  },
  clickclackGuidedSetup: {
    pluginDependent: true,
    falsy: false,
    run: async (clawCmd) => {
      const r = await clawCmd("channels add clickclack --help", {
        quiet: true,
        timeoutMs: 10000,
      });
      const text = `${r.stdout}\n${r.stderr}`;
      if (kUnknownCommand.test(text)) return false;
      // The guided paste-code flow is signaled by the `--code` flag.
      return /--code\b/.test(text);
    },
  },
  // { ok, findings } (five-posture beta doctor) vs the legacy shape.
  doctorJsonShape: {
    pluginDependent: false,
    falsy: "legacy",
    run: async (clawCmd) => {
      const r = await clawCmd("doctor --json", { quiet: true, timeoutMs: 20000 });
      const doc = parseJsonLoose(r.stdout);
      if (doc && typeof doc === "object" && "ok" in doc && Array.isArray(doc.findings)) {
        return "structured";
      }
      return "legacy";
    },
  },
  trustedProxyTeam: {
    pluginDependent: true,
    falsy: false,
    run: async (clawCmd) => {
      const r = await clawCmd(
        "config get gateway.auth.trustedProxy.deviceAutoApprove.enabled --json",
        { quiet: true, timeoutMs: 10000 },
      );
      const text = `${r.stdout}\n${r.stderr}`;
      // Unknown path ⇒ the schema predates trusted-proxy team support.
      if (kUnknownConfigPath.test(text) || kUnknownCommand.test(text)) return false;
      // A recognized path (even when unset/null) proves the schema supports it.
      return true;
    },
  },
};

function helpProbe(cmd) {
  return {
    pluginDependent: false,
    falsy: false,
    run: async (clawCmd) => {
      const r = await clawCmd(cmd, { quiet: true, timeoutMs: 10000 });
      const text = `${r.stdout}\n${r.stderr}`;
      // `--help` on an existing subcommand prints usage and exits 0; a missing
      // subcommand errors with an unknown-command message.
      if (kUnknownCommand.test(text)) return false;
      return r.ok || /usage|options|--help/i.test(text);
    },
  };
}

const createOpenclawCapabilities = ({
  clawCmd,
  getInstalledVersion = () => null,
  nowFn = Date.now,
  logger = console,
} = {}) => {
  if (typeof clawCmd !== "function") {
    throw new Error("createOpenclawCapabilities requires a clawCmd function");
  }

  // Map<capabilityKey, { version, value, at, positive }>
  const cache = new Map();

  const isFresh = (entry, version) => {
    if (!entry || entry.version !== version) return false;
    const probe = kProbes[entry.key];
    const ttl = entry.positive
      ? probe?.pluginDependent
        ? kPluginDependentTtlMs
        : Infinity
      : kNegativeTtlMs;
    return nowFn() - entry.at < ttl;
  };

  const isPositive = (key, value) => {
    const falsy = kProbes[key].falsy;
    if (typeof falsy === "boolean") return value === true;
    if (typeof falsy === "string") return value !== falsy;
    // object-shaped (restartHandoff): positive when `supported` is true.
    return Boolean(value && value.supported);
  };

  const probe = async (key) => {
    const spec = kProbes[key];
    if (!spec) throw new Error(`unknown OpenClaw capability: ${key}`);
    const version = getInstalledVersion() || "unknown";
    const cached = cache.get(key);
    if (isFresh(cached, version)) return cached.value;

    let value = spec.falsy;
    try {
      const probed = await spec.run(clawCmd);
      if (probed !== undefined) value = probed;
    } catch (error) {
      logger.warn?.(
        `[openclaw-capabilities] probe ${key} failed: ${error.message}`,
      );
      value = spec.falsy;
    }
    cache.set(key, {
      key,
      version,
      value,
      at: nowFn(),
      positive: isPositive(key, value),
    });
    return value;
  };

  // Fetch several capabilities at once (each still individually cached).
  const getMany = async (keys) => {
    const out = {};
    for (const key of keys) out[key] = await probe(key);
    return out;
  };

  const getAll = () => getMany(Object.keys(kProbes));

  const invalidate = (key) => {
    if (key === undefined) {
      cache.clear();
    } else {
      cache.delete(key);
    }
  };

  return {
    get: probe,
    getMany,
    getAll,
    invalidate,
    // exposed for tests / diagnostics
    _cacheSize: () => cache.size,
  };
};

module.exports = {
  createOpenclawCapabilities,
  kCapabilityKeys: Object.keys(kProbes),
  kPluginDependentTtlMs,
  kNegativeTtlMs,
};
