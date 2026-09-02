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
// A TIMED-OUT probe gets an even shorter negative TTL: on openclaw >=
// 2026.9.1-beta.1 every CLI invocation serializes on a startup-migration
// lease that a long doctor --fix can hold for minutes — a capability probed
// during that window is not "unsupported", it is "try again shortly".
// Bounded (not uncached) so a wedged lease cannot cause a probe storm.
const kTimedOutTtlMs = 30 * 1000;
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
  // `gateway stop --force` ("Allow stop from a non-interactive shell"):
  // present on 2026.8.2 and 2026.9.1-beta.1, where the CLI REFUSES a stop
  // from a non-interactive shell without it ("re-run with --force", exit 1);
  // ABSENT on the 2026.7.1-2 pin, where passing it is an unknown option. The
  // managed stop (gateway.js runGatewayShortCmd) appends the flag only on
  // "supported". Tri-state like execApprovalsSqlite: both determinate
  // answers cache for the installed version (the pin's legitimate
  // "unsupported" must not re-spawn every 60s — the doctorJsonShape probe
  // storm), while "unknown" (probe failed/timed out) retries on the short
  // negative TTL.
  gatewayStopForce: {
    pluginDependent: false,
    falsy: "unknown",
    run: async (clawCmd) => {
      const r = await clawCmd("gateway stop --help", {
        quiet: true,
        timeoutMs: 10000,
      });
      if (r.timedOut) return "unknown";
      const text = `${r.stdout}\n${r.stderr}`;
      if (kUnknownCommand.test(text)) return "unsupported";
      if (!r.ok && !/usage|options|--help/i.test(text)) return "unknown";
      return /(^|\s)--force\b/.test(text) ? "supported" : "unsupported";
    },
  },
  secretsStore: helpProbe("secrets store --help"),
  updateRepair: helpProbe("update repair --help"),
  // SQLite-era exec approvals (issue #23): when present, the dashboard
  // routes read/write through `openclaw approvals get/set` instead of the
  // legacy exec-approvals.json (whose mere existence breaks that era).
  execApprovalsCli: helpProbe("approvals --help"),
  // Era discriminator (issue #23 follow-up): "sqlite" | "file" | "unknown".
  // The `approvals` group exists on BOTH eras (execApprovalsCli above is
  // deliberately non-discriminating); only the sqlite era lists the `pending`
  // subcommand. Probing the PARENT help is load-bearing: commander 15 prints
  // the parent help and exits 0 for unknown-subcommand + --help, so
  // `approvals pending --help` would report true everywhere. "unknown" (probe
  // failed/timed out) is the negative value so a transient failure is
  // retried, while both determinate answers cache for the installed version.
  execApprovalsSqlite: {
    pluginDependent: false,
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
  // doctorJsonShape was DELETED here (2026-09: "Supersedes recent work",
  // landed v0.9.38 #14). It had zero consumers and was the sole repeating
  // doctor-spawn path: its legitimate stable answer ("legacy") was defined
  // as the falsy value, so every healthy install negative-cached it for 60s
  // and re-spawned `doctor --json` on each capabilities fetch — ~530
  // spawns/day observed in the 2026-09-01 incident. Doctor output shape is
  // now decided per-run by doctor/classify-doctor-cli.js.
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

// Layer-wide suppression windows when the OpenClaw CLI itself is down.
// Startup-crash class ("Could not start the CLI" / bootstrap cli_error): by
// definition EVERY probe fails, so nothing unrelated can hide behind a
// 30-min window. Hang class (a wedged CLI times every probe out, producing
// NO crash text): a full all-timeout getAll pass arms a shorter window —
// otherwise a cold getAll re-pays up to 10 sequential 10s timeouts every 30s.
const kCliUnavailableTtlMs = 30 * 60 * 1000;
const kAllTimedOutTtlMs = 5 * 60 * 1000;

const createOpenclawCapabilities = ({
  clawCmd,
  getInstalledVersion = () => null,
  nowFn = Date.now,
  logger = console,
  // Optional doctor-availability tracker: the capability layer is the only
  // steady-state observer of a broken CLI, so it feeds the tracker's
  // "unavailable" side. Recovery is recorded by actual doctor runs, not by
  // --help probes succeeding.
  doctorAvailability = null,
} = {}) => {
  if (typeof clawCmd !== "function") {
    throw new Error("createOpenclawCapabilities requires a clawCmd function");
  }
  const { matchesCliStartupFailure } = require("./doctor/classify-doctor-cli");

  // Map<capabilityKey, { version, value, at, positive }>
  const cache = new Map();
  // Instance-level (NOT module-level: this factory is per-instance DI-clocked
  // and tests build many instances with fake clocks).
  let suppressedUntil = 0;
  let suppressionReason = null;

  const armSuppression = (ttlMs, reason, detail) => {
    const until = nowFn() + ttlMs;
    if (until <= suppressedUntil) return;
    suppressedUntil = until;
    suppressionReason = reason;
    logger.warn?.(
      `[openclaw-capabilities] OpenClaw CLI looks unavailable (${reason}${detail ? `: ${String(detail).slice(0, 200)}` : ""}) — serving cached capability answers, no probe spawns for ${Math.round(ttlMs / 60000)} min`,
    );
    try {
      doctorAvailability?.record(
        { status: "unavailable", reason, detail: detail || null },
        { source: "capabilities" },
      );
    } catch {}
  };

  const isFresh = (entry, version) => {
    if (!entry || entry.version !== version) return false;
    const probe = kProbes[entry.key];
    const ttl = entry.positive
      ? probe?.pluginDependent
        ? kPluginDependentTtlMs
        : Infinity
      : entry.timedOut
        ? kTimedOutTtlMs
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

  // `cmdOpts` (optional): per-call options merged over each probe command's
  // own clawCmd options for THIS probe run only (e.g. gateway.js's shutdown
  // stop passes { abortable:false, timeoutMs } so the gatewayStopForce probe
  // is neither pre-killed by the fired module abort nor longer than the stop's
  // budget). Cache-first regardless: a fresh answer never spawns.
  const probe = async (key, { cmdOpts = null } = {}) => {
    const spec = kProbes[key];
    if (!spec) throw new Error(`unknown OpenClaw capability: ${key}`);
    const version = getInstalledVersion() || "unknown";
    const cached = cache.get(key);
    if (isFresh(cached, version)) return cached.value;
    // Suppression window: the CLI itself is down, so new spawns are pure
    // waste. Serve a cached answer whenever one exists for this version —
    // even a stale one (an Infinity-TTL positive is still trustworthy; only
    // NEW spawns are unsafe). Falsy only on a true cache miss.
    if (nowFn() < suppressedUntil) {
      if (cached && cached.version === version) return cached.value;
      return spec.falsy;
    }

    // Track whether any underlying CLI call timed out: a lease-blocked CLI
    // (beta startup-migration lease) must retry sooner than a genuine "not
    // supported" answer — see kTimedOutTtlMs.
    let sawTimeout = false;
    const trackingClawCmd = async (cmd, opts) => {
      const result = await clawCmd(
        cmd,
        cmdOpts && typeof cmdOpts === "object" ? { ...opts, ...cmdOpts } : opts,
      );
      if (result?.timedOut) sawTimeout = true;
      // Startup-crash signature in ANY probe's output arms the layer-wide
      // window (T6-narrowed: bootstrap failures only — a sub-command
      // cli_error keeps normal per-probe caching).
      const combined = `${result?.stdout || ""}\n${result?.stderr || ""}`;
      if (matchesCliStartupFailure(combined)) {
        armSuppression(
          kCliUnavailableTtlMs,
          "cli_startup_crash",
          combined.split("\n").find((l) => /Could not start the CLI/i.test(l)) ||
            null,
        );
      }
      return result;
    };

    let value = spec.falsy;
    try {
      const probed = await spec.run(trackingClawCmd);
      if (probed !== undefined) value = probed;
    } catch (error) {
      logger.warn?.(
        `[openclaw-capabilities] probe ${key} failed: ${error.message}`,
      );
      value = spec.falsy;
    }
    const positive = isPositive(key, value);
    cache.set(key, {
      key,
      version,
      value,
      at: nowFn(),
      positive,
      timedOut: sawTimeout && !positive,
    });
    lastProbeStats.probed += 1;
    // Hang accounting is independent of the probe's ANSWER: a wedged CLI
    // times every spawn out regardless of how the probe interprets the empty
    // result (trustedProxyTeam, notably, reads an empty response as
    // positive).
    if (sawTimeout) lastProbeStats.timedOut += 1;
    return value;
  };

  // Per-getMany probe accounting for the hang-class arm below.
  let lastProbeStats = { probed: 0, timedOut: 0 };

  // Fetch several capabilities at once (each still individually cached).
  const getMany = async (keys) => {
    lastProbeStats = { probed: 0, timedOut: 0 };
    const out = {};
    for (const key of keys) out[key] = await probe(key);
    // Hang class: EVERY probe actually run in this pass timed out — a wedged
    // CLI (e.g. blocked on the upstream state-lifecycle lease) produces no
    // crash text, so the startup-signature arm never fires; without this a
    // cold getAll re-pays the full sequential timeout bill every 30s.
    if (
      lastProbeStats.probed >= 2 &&
      lastProbeStats.probed === lastProbeStats.timedOut
    ) {
      armSuppression(
        kAllTimedOutTtlMs,
        "all_probes_timed_out",
        `${lastProbeStats.timedOut} consecutive probe timeouts`,
      );
    }
    return out;
  };

  const getAll = () => getMany(Object.keys(kProbes));

  const invalidate = (key) => {
    if (key === undefined) {
      cache.clear();
      // A full invalidation accompanies channel applies/rollbacks — the new
      // build may have fixed the CLI, so the suppression window resets too.
      suppressedUntil = 0;
      suppressionReason = null;
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
  kTimedOutTtlMs,
  kCliUnavailableTtlMs,
  kAllTimedOutTtlMs,
};
