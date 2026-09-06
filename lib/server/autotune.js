const fs = require("fs");
const { utcDayBucket } = require("./notification-policy");
const path = require("path");
const {
  getMachineProfile,
  refreshMachineProfile,
  whenGpuEnriched,
  capacityOf,
  sameCapacity,
} = require("./machine-profile");
const {
  readAutotuneEnabled,
  readAutotuneSettings,
} = require("./alphaclaw-config");
const {
  kOpenclawManagedDir,
  OPENCLAW_DIR,
  kAgentConcurrencyLegacyCap,
  kSubagentConcurrencyDelta,
} = require("./constants");
const { writeFileAtomic } = require("./utils/safe-file");

// Resource autotune: derives resource-dependent settings from the machine
// profile and applies them, recording every decision in a ledger so the UI,
// the API, and the agent can see what was detected, derived, and applied.
//
//   profile ──▶ deriveTunings(profile, overrides) ──▶ values + notes (pure)
//                        │
//        ┌───────────────┼──────────────────────────────────────┐
//        ▼               ▼                                      ▼
//   gatewayEnv()   applyResourceAutotune()                consumers at load
//   (pull: heap,   (push: openclaw.json concurrency,      (body limits,
//    UV per spawn)  ledger, resize events)                 sqlite caches)
//
// Gating: every getter returns null unless autotune is ACTIVE (config enabled
// AND no ALPHACLAW_AUTOTUNE_DISABLED=1 kill-switch) — disabled must reproduce
// legacy tuning behavior exactly. Getters NEVER throw: any internal error
// degrades to null (legacy behavior), because gatewayEnv() and CLI paths
// consume them.
//
// Suppression: when cgroup limits are unreadable AND we are (or may be) in a
// container, host totals lie about the box (512MB container on a 64GB host
// would derive an 8GB heap) — derivation is suppressed and defaults hold.
// Only a detected bare-metal environment tunes on host values.
//
// Ownership (openclaw.json concurrency): durable ledger provenance, never
// value comparison alone. We only ever adopt a key we created from ABSENT;
// the intent is persisted before the config write and confirmed after
// (unconfirmed intent = not owned — fail-safe). If the config value no longer
// matches our last confirmed write, someone else changed it → relinquish.

const kLedgerFileName = "autotune-ledger.json";
const kLedgerVersion = 1;
const kConcurrencyKey = "agents.defaults.maxConcurrent";

const kMb = 1024 * 1024;
const kGb = 1024 * kMb;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// The one heap ceiling: an override above this fraction of the container's
// memory is an OOM instruction, not a preference. Shared with the watchdog's
// OOM-remediation suggestion so the suggested override is always acceptable.
const kGatewayHeapCeilingFraction = 0.85;
const maxGatewayHeapMbFor = (memMb) =>
  Math.max(128, Math.round(kGatewayHeapCeilingFraction * memMb));

const isKillSwitchActive = (env = process.env) =>
  String(env.ALPHACLAW_AUTOTUNE_DISABLED || "").trim() === "1";

// Config reads default to the real state dir — resolveAlphaclawConfigPath's
// own fallback is process.cwd(), which is never where alphaclaw.json lives.
const withConfigDir = ({ env = process.env, openclawDir = OPENCLAW_DIR, ...rest } = {}) => ({
  env,
  openclawDir,
  ...rest,
});

const isAutotuneActive = (options = {}) => {
  const { env, ...configOptions } = withConfigDir(options);
  try {
    if (isKillSwitchActive(env)) return false;
    return readAutotuneEnabled(configOptions) === true;
  } catch {
    return false;
  }
};

const isSuppressedProfile = (profile) =>
  profile?.memory?.source === "host" && profile?.environment !== "bare-metal";

// Pure derivation. Returns { suppressed, values, notes } where notes carry
// override-clamp records (a formula hitting its own floor/ceiling is normal
// derivation and gets NO note — the `clamped` status is reserved for
// overridden-then-clamped).
const deriveTunings = (profile, { overrides = {} } = {}) => {
  if (!profile?.memory?.limitBytes) {
    return { suppressed: true, reason: "memory_unknown", values: {}, notes: {} };
  }
  if (isSuppressedProfile(profile)) {
    return {
      suppressed: true,
      reason: "container_limits_unavailable",
      values: {},
      notes: {},
    };
  }
  const M = profile.memory.limitBytes / kMb; // MB
  const C = profile.cpu?.cores || 1;
  const notes = {};

  const applyOverride = (knob, derived, { min, max }) => {
    const override = overrides[knob];
    if (override == null) return derived;
    const applied = clamp(override, min, max);
    if (applied !== override) {
      notes[knob] = { clamped: true, requested: override, applied };
    }
    return applied;
  };

  // Overrides may exceed the formula defaults but never the machine: every
  // memory-shaped override is clamped against the live profile at apply time
  // (the manifest promises exactly this to the agent).
  // The DERIVED heap honors the machine ceiling too: below ~301MB the 256MB
  // floor would exceed 0.85×M — autotune must never issue the OOM instruction
  // its own override clamp exists to prevent.
  const gatewayHeapMb = applyOverride(
    "gatewayHeapMb",
    Math.min(clamp(Math.round(0.5 * M), 256, 8192), maxGatewayHeapMbFor(M)),
    { min: 128, max: maxGatewayHeapMbFor(M) },
  );
  const uvThreadpoolSize = applyOverride(
    "uvThreadpoolSize",
    clamp(Math.ceil(C) * 2, 4, 16),
    { min: 1, max: Math.min(64, Math.max(8, Math.ceil(C) * 8)) },
  );
  // Floor 8 (not 1): every consumer assumes the pre-feature floor — a cap
  // below it would make bootMaxConcurrent EXCEED the requested cap and let
  // the telegram subagent formula (mc-2 floored at 4) rise above agents.
  const agentConcurrencyCap = applyOverride(
    "agentConcurrencyCap",
    clamp(Math.min(Math.round(M / 64), Math.round(C * 8)), 8, 128),
    {
      min: 8,
      max: Math.min(
        1024,
        Math.max(8, Math.min(Math.round(C * 16), Math.round(M / 32))),
      ),
    },
  );
  const bootMaxConcurrent = clamp(agentConcurrencyCap, 8, 32);

  const tier = profile.tier;
  // Body-limit overrides are memory-shaped too: parsing a body transiently
  // needs several times its size, so the machine cap is ~10% of memory (the
  // stored 256MB bound alone would let a 256MB limit onto a 512MB box).
  const bodyLimitMachineMaxMb = Math.max(20, Math.min(256, Math.round(0.1 * M)));
  const openAiCompatBodyLimitMb = applyOverride(
    "openAiCompatBodyLimitMb",
    tier === "xl" ? 64 : tier === "large" ? 48 : tier === "medium" ? 32 : 20,
    { min: 1, max: bodyLimitMachineMaxMb },
  );
  const localBodyLimitMb = applyOverride(
    "localBodyLimitMb",
    tier === "micro" || tier === "small" ? 5 : 10,
    { min: 1, max: bodyLimitMachineMaxMb },
  );
  // The pragma applies per connection (~5 long-lived DBs), so the machine cap
  // is M/32 — 4× the derived M/128, never the flat 64MB on a small box.
  const sqliteCacheMb = applyOverride(
    "sqliteCacheMb",
    clamp(Math.round(M / 128), 2, 64),
    { min: 2, max: Math.min(64, Math.max(2, Math.round(M / 32))) },
  );

  const diskGb = profile.disk?.totalBytes
    ? profile.disk.totalBytes / kGb
    : null;
  const backupMaxTotalGb =
    diskGb == null
      ? null
      : applyOverride("backupMaxTotalGb", clamp(Math.round(0.2 * diskGb), 2, 60), {
          min: 2,
          // An override above the volume itself can never trip the advisory —
          // the budget's only surfacing — so it dies silently. Cap at the disk.
          max: Math.min(60, Math.max(2, Math.round(diskGb))),
        });

  // Report-only; dropped on micro (recommending 25% of a 512MB box next to a
  // 256MB gateway heap was self-contradictory — the recommendation there is a
  // bigger container).
  const adminHeapRecommendedMb =
    tier === "micro" ? null : clamp(Math.round(0.25 * M), 192, 2048);

  return {
    suppressed: false,
    values: {
      gatewayHeapMb,
      uvThreadpoolSize,
      agentConcurrencyCap,
      bootMaxConcurrent,
      openAiCompatBodyLimitMb,
      localBodyLimitMb,
      sqliteCacheMb,
      backupMaxTotalGb,
      adminHeapRecommendedMb,
    },
    notes,
  };
};

// ---------------------------------------------------------------------------
// Module state: in-memory ledger + persisted copy. The persisted file lives in
// the managed (non-git-synced) state dir — it describes THIS machine.
// ---------------------------------------------------------------------------

const state = {
  managedDir: kOpenclawManagedDir,
  fsModule: fs,
  ledger: null, // loaded lazily
  // Values consumers actually installed in the running admin process (body
  // limits at module load, sqlite caches at DB open) — "applied" means ACTIVE,
  // not merely derived.
  installed: { openAiCompatBodyLimitMb: null, localBodyLimitMb: null, sqliteCacheMb: null },
  // Values the last gateway spawn actually consumed.
  activeGatewayEnv: null, // { gatewayHeapMb, uvThreadpoolSize, at }
  applyChain: Promise.resolve(),
};

const ledgerPath = () => path.join(state.managedDir, kLedgerFileName);

const loadLedger = () => {
  if (state.ledger) return state.ledger;
  let parsed = null;
  try {
    parsed = JSON.parse(state.fsModule.readFileSync(ledgerPath(), "utf8"));
  } catch {
    // Missing/corrupt ledger = first boot: no ownership, no resize history.
  }
  // Shape-normalize, never trust: a hand-edited or older-schema ledger that
  // parses as valid JSON must degrade field-by-field to first-boot defaults
  // instead of crashing every apply on a missing ownedKeys.
  const base = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  state.ledger = {
    ...base,
    version: kLedgerVersion,
    ownedKeys:
      base.ownedKeys && typeof base.ownedKeys === "object" && !Array.isArray(base.ownedKeys)
        ? base.ownedKeys
        : {},
    rows: Array.isArray(base.rows) ? base.rows : [],
    lastObservedProfile:
      base.lastObservedProfile && typeof base.lastObservedProfile === "object"
        ? base.lastObservedProfile
        : null,
    lastResize:
      base.lastResize && typeof base.lastResize === "object" ? base.lastResize : null,
    activeGatewayEnv:
      base.activeGatewayEnv && typeof base.activeGatewayEnv === "object"
        ? base.activeGatewayEnv
        : null,
  };
  state.activeGatewayEnv = state.ledger.activeGatewayEnv;
  return state.ledger;
};

// Non-fatal by contract: the in-memory ledger keeps serving when the disk
// write fails (ENOSPC etc.) — behavior never depends on ledger persistence.
const persistLedger = () => {
  try {
    state.fsModule.mkdirSync(state.managedDir, { recursive: true });
    writeFileAtomic(
      ledgerPath(),
      `${JSON.stringify(state.ledger, null, 2)}\n`,
      { fsModule: state.fsModule },
    );
    return true;
  } catch (error) {
    console.error(`[autotune] ledger write failed: ${error.message}`);
    return false;
  }
};

// ---------------------------------------------------------------------------
// Never-throw getters consumed by gatewayEnv(), runtime env, and load-time
// consumers. Each returns null when autotune is off/suppressed/errored so the
// caller falls back to today's exact behavior.
// ---------------------------------------------------------------------------

const safeDerivedValue = (knob, options = {}) => {
  try {
    const resolved = withConfigDir(options);
    if (!isAutotuneActive(resolved)) return null;
    const { env: _env, ...configOptions } = resolved;
    const settings = readAutotuneSettings(configOptions);
    const derivation = deriveTunings(getMachineProfile(), {
      overrides: settings.overrides,
    });
    if (derivation.suppressed) return null;
    return derivation.values[knob] ?? null;
  } catch {
    return null;
  }
};

const getDerivedGatewayHeapMb = (options = {}) =>
  safeDerivedValue("gatewayHeapMb", options);

const getGatewayNodeOptionsSuffix = (options = {}) => {
  const heapMb = getDerivedGatewayHeapMb(options);
  return heapMb == null ? null : `--max-old-space-size=${heapMb}`;
};

const getUvThreadpoolSize = (options = {}) =>
  safeDerivedValue("uvThreadpoolSize", options);

const getAgentConcurrencyCap = (options = {}) =>
  safeDerivedValue("agentConcurrencyCap", options);

// Called once at lib/server.js module load. Returns Express limit strings or
// null (legacy literals). Records what the process actually installed so the
// ledger can tell "applied" from "pending an AlphaClaw restart".
const deriveBodyLimits = (options = {}) => {
  const openAiCompatMb = safeDerivedValue("openAiCompatBodyLimitMb", options);
  const localMb = safeDerivedValue("localBodyLimitMb", options);
  state.installed.openAiCompatBodyLimitMb = openAiCompatMb;
  state.installed.localBodyLimitMb = localMb;
  if (openAiCompatMb == null || localMb == null) return null;
  return { openAiCompat: `${openAiCompatMb}mb`, local: `${localMb}mb` };
};

// Called at every DatabaseSync creation (via applyOperationalPragmas).
const getSqliteCacheMb = (options = {}) => {
  const value = safeDerivedValue("sqliteCacheMb", options);
  state.installed.sqliteCacheMb = value;
  return value;
};

const getBackupMaxTotalBytes = (options = {}) => {
  const valueGb = safeDerivedValue("backupMaxTotalGb", options);
  return valueGb == null ? null : valueGb * kGb;
};

// ---------------------------------------------------------------------------
// Spawn stamp: launchGatewayProcess() reports the env values a spawn actually
// consumed. Best-effort by contract — a ledger IO failure must never block a
// gateway launch — and a no-op when autotune is off.
// ---------------------------------------------------------------------------

const stampGatewayEnvApplied = ({ gatewayHeapMb = null, uvThreadpoolSize = null } = {}) => {
  try {
    const ledger = loadLedger();
    if (gatewayHeapMb == null && uvThreadpoolSize == null) {
      // This spawn consumed NO autotune values (disabled, kill-switched, or
      // suppressed). A stale stamp must not keep describing an older spawn —
      // the medic summary, OOM classifier, and "applied" rows all read it.
      if (state.activeGatewayEnv == null) return;
      state.activeGatewayEnv = null;
      ledger.activeGatewayEnv = null;
      persistLedger();
      return;
    }
    state.activeGatewayEnv = {
      gatewayHeapMb,
      uvThreadpoolSize,
      at: Date.now(),
    };
    ledger.activeGatewayEnv = state.activeGatewayEnv;
    // Flip the ledger rows this spawn satisfied — rows are otherwise only
    // rebuilt at the next apply (boot/PUT/reapply/resize), which never fires
    // on a plain gateway restart, and the UI's restartSignal refetch depends
    // on this server-side flip (stuck-amber otherwise).
    for (const row of ledger.rows) {
      if (row?.restartTarget !== "gateway" || row.status !== "pending_restart") {
        continue;
      }
      if (
        row.target === "gateway-env" &&
        state.activeGatewayEnv[row.knob] === row.value
      ) {
        row.status = "applied";
        row.restartTarget = null;
        row.appliedAt = state.activeGatewayEnv.at;
      } else if (row.target === "openclaw-config") {
        // A fresh spawn read the current openclaw.json by definition.
        row.status = "applied";
        row.restartTarget = null;
        row.appliedAt = state.activeGatewayEnv.at;
      }
    }
    // Record that a spawn consumed the current config write, so the next
    // apply's unchanged-value reapply reports "applied", not a fresh pending.
    const ownership = ledger.ownedKeys[kConcurrencyKey];
    if (ownership && !ownership.intent) {
      ownership.satisfiedAt = state.activeGatewayEnv.at;
    }
    persistLedger();
    return state.activeGatewayEnv;
  } catch (error) {
    console.error(`[autotune] spawn stamp failed: ${error.message}`);
  }
  return null;
};

// The LIGHT restart (in-place recycle via `openclaw gateway restart`) makes
// the gateway re-read openclaw.json but KEEPS the supervisor-era process env —
// it satisfies openclaw-config rows only, never gateway-env rows. Without
// this, a channel-sync-triggered light restart leaves a live concurrency row
// nagging amber until the next cold restart.
const stampOpenclawConfigConsumed = () => {
  try {
    const ledger = loadLedger();
    let changed = false;
    const at = Date.now();
    for (const row of ledger.rows || []) {
      if (
        row?.target === "openclaw-config" &&
        row.status === "pending_restart" &&
        row.restartTarget === "gateway"
      ) {
        row.status = "applied";
        row.restartTarget = null;
        row.appliedAt = at;
        changed = true;
      }
    }
    const ownership = ledger.ownedKeys[kConcurrencyKey];
    if (ownership && !ownership.intent && !ownership.satisfiedAt) {
      ownership.satisfiedAt = at;
      changed = true;
    }
    if (changed) persistLedger();
  } catch (error) {
    console.error(`[autotune] light-restart stamp failed: ${error.message}`);
  }
};

// A spawn that stamped but then FAILED (spawn 'error' event — binary missing
// mid-update, EACCES) consumed nothing; the ledger must not keep claiming a
// nonexistent gateway runs with these values. Reverts only if this stamp is
// still the active one — a newer successful spawn's stamp is never clobbered
// by a failed predecessor's cleanup.
const revertGatewayEnvStamp = (stamp) => {
  try {
    // Reference equality, not timestamps: two spawns in the same millisecond
    // would collide on `at`, and only the object identity says whose stamp is
    // still the active one.
    if (!stamp || state.activeGatewayEnv !== stamp) return;
    const ledger = loadLedger();
    for (const row of ledger.rows || []) {
      if (row?.appliedAt !== stamp.at || row.status !== "applied") continue;
      if (row.target === "gateway-env" || row.target === "openclaw-config") {
        row.status = "pending_restart";
        row.restartTarget = "gateway";
        row.appliedAt = null;
      }
    }
    const ownership = ledger.ownedKeys[kConcurrencyKey];
    if (ownership && ownership.satisfiedAt === stamp.at) {
      delete ownership.satisfiedAt;
    }
    state.activeGatewayEnv = null;
    ledger.activeGatewayEnv = null;
    persistLedger();
  } catch (error) {
    console.error(`[autotune] spawn stamp revert failed: ${error.message}`);
  }
};

const getActiveGatewayHeapMb = () => state.activeGatewayEnv?.gatewayHeapMb ?? null;

// ---------------------------------------------------------------------------
// Apply: boot / PUT settings / POST reapply / resize tick. Callers hold the
// gateway lifecycle lock; this chain additionally serializes overlapping
// callers inside the process.
// ---------------------------------------------------------------------------

const buildRows = ({ active, derivation, ledger, concurrencyRow }) => {
  const rows = [];
  const values = derivation.values || {};
  const notes = derivation.notes || {};
  const push = (row) => rows.push(row);

  if (!active) return rows;
  if (derivation.suppressed) {
    for (const knob of [
      "gatewayHeapMb",
      "uvThreadpoolSize",
      "agentConcurrencyCap",
      "openAiCompatBodyLimitMb",
      "localBodyLimitMb",
      "sqliteCacheMb",
    ]) {
      push({
        knob,
        value: null,
        target: "held-defaults",
        status: "skipped",
        restartTarget: null,
        reason:
          derivation.reason === "container_limits_unavailable"
            ? "container limits unavailable — holding built-in defaults"
            : "machine memory unknown — holding built-in defaults",
      });
    }
    return rows;
  }

  // NOTE: `clamped` is a FLAG, never a status — overwriting the status would
  // destroy the pending_restart signal (routes' markPendingGatewayRestart and
  // the UI's restart affordance both key on status; a clamped override that
  // still needs a restart must show both facts).
  const envRow = (knob, value) => {
    const activeValue = state.activeGatewayEnv?.[knob] ?? null;
    push({
      knob,
      value,
      target: "gateway-env",
      status: activeValue === value ? "applied" : "pending_restart",
      restartTarget: activeValue === value ? null : "gateway",
      clamped: !!notes[knob],
      reason: notes[knob]
        ? `override ${notes[knob].requested} exceeds this machine — ${notes[knob].applied} applied instead`
        : null,
      appliedAt: activeValue === value ? state.activeGatewayEnv?.at ?? null : null,
    });
  };
  // An operator's explicit gateway cap (ALPHACLAW_GATEWAY_MAX_OLD_SPACE_SIZE,
  // appended after autotune's suffix by gatewayLaunchEnv — V8 last-wins)
  // overrides the derived heap: the row is operator-owned, not endlessly
  // pending behind a restart that can never satisfy it.
  const operatorHeapCap = Number.parseInt(
    process.env.ALPHACLAW_GATEWAY_MAX_OLD_SPACE_SIZE || "",
    10,
  );
  if (Number.isInteger(operatorHeapCap) && operatorHeapCap > 0) {
    push({
      knob: "gatewayHeapMb",
      value: values.gatewayHeapMb,
      effectiveValue: operatorHeapCap,
      target: "gateway-env",
      status: "manual",
      restartTarget: null,
      reason:
        "operator-set ALPHACLAW_GATEWAY_MAX_OLD_SPACE_SIZE wins over the derived value",
    });
  } else {
    envRow("gatewayHeapMb", values.gatewayHeapMb);
  }
  // An operator-set UV_THREADPOOL_SIZE wins in the child env (never stamped as
  // ours) — the row is operator-owned, not endlessly pending behind a restart
  // that can never satisfy it.
  if (String(process.env.UV_THREADPOOL_SIZE || "").trim()) {
    push({
      knob: "uvThreadpoolSize",
      value: values.uvThreadpoolSize,
      effectiveValue: Number.parseInt(process.env.UV_THREADPOOL_SIZE, 10) || null,
      target: "gateway-env",
      status: "manual",
      restartTarget: null,
      reason: "operator-set UV_THREADPOOL_SIZE wins over the derived value",
    });
  } else {
    envRow("uvThreadpoolSize", values.uvThreadpoolSize);
  }

  if (concurrencyRow) push(concurrencyRow);

  const installedRow = (knob, value) => {
    const installed = state.installed[knob];
    push({
      knob,
      value,
      target: "alphaclaw",
      status: installed === value ? "applied" : "pending_restart",
      restartTarget: installed === value ? null : "alphaclaw",
      clamped: !!notes[knob],
      reason: notes[knob]
        ? `override ${notes[knob].requested} out of range — ${notes[knob].applied} applied instead`
        : null,
    });
  };
  installedRow("openAiCompatBodyLimitMb", values.openAiCompatBodyLimitMb);
  installedRow("localBodyLimitMb", values.localBodyLimitMb);
  installedRow("sqliteCacheMb", values.sqliteCacheMb);

  if (values.backupMaxTotalGb != null) {
    push({
      knob: "backupMaxTotalGb",
      value: values.backupMaxTotalGb,
      target: "advisory",
      status: "manual",
      restartTarget: null,
      reason: "advisory budget — retention keeps its keep-3 guarantee",
    });
  }
  if (values.adminHeapRecommendedMb != null) {
    // effectiveValue = the admin process's ACTUAL current heap ceiling, so the
    // UI can hide the recommendation when it's already close (±10%).
    const currentAdminHeapMb = (() => {
      try {
        return Math.round(
          require("v8").getHeapStatistics().heap_size_limit / kMb,
        );
      } catch {
        return null;
      }
    })();
    push({
      knob: "adminHeapRecommendedMb",
      value: values.adminHeapRecommendedMb,
      effectiveValue: currentAdminHeapMb,
      target: "operator",
      status: "manual",
      restartTarget: "alphaclaw",
      reason: null,
    });
  }
  return rows;
};

// Applies (or reverts) the openclaw.json concurrency boot default under the
// ownership rules. Returns { row, change }: the ledger row describing the
// outcome, plus a change record when a persisted value actually moved —
// runApply composes ONE per-apply notification from it (never one per knob,
// never on unchanged reapplies).
const applyConcurrency = ({ active, derivation, ledger, deps }) => {
  const { updateOpenclawConfigFn, openclawDir, fsModule } = deps;
  const ownership = ledger.ownedKeys[kConcurrencyKey] || null;

  const readCurrent = (cfg) => cfg.agents?.defaults?.maxConcurrent;

  // Suppression (enabled, but container limits unreadable) HOLDS state:
  // config untouched, ownership retained. A transient cgroup misread on the
  // resize tick must never run the disable revert below — suppression means
  // "we can't see the box", not "the operator turned this off".
  if (active && derivation.suppressed) return { row: null, change: null };

  // Disable / kill-switch revert: restore pre-feature semantics.
  // A key we adopted from absent is deleted; a value the ledger can attribute
  // to autotune's own last confirmed write is clamped back under the legacy
  // 64 ceiling. UNATTRIBUTABLE values are left alone — operators could always
  // hand-set >64 in openclaw.json, and their intent outranks our cleanup
  // (cross-model ship-review finding, 2026-08-29).
  if (!active) {
    let reverted = true;
    let revertChange = null;
    try {
      updateOpenclawConfigFn({
        fsModule,
        openclawDir,
        mutate: (cfg) => {
          const current = readCurrent(cfg);
          const confirmed = ownership && !ownership.intent ? ownership : null;
          // Crash-window recovery on the revert path too (fix wave F082): a
          // stale intent whose value matches the config means OUR write landed
          // but the confirm never persisted. The enable path already treats
          // that as autotune-owned; the revert used to leave the value in
          // openclaw.json and then delete its provenance.
          const staleIntent = ownership?.intent || null;
          const recoveredFromIntent = Boolean(staleIntent && current === staleIntent.value);
          const attributable =
            (confirmed && current === confirmed.lastApplied) || recoveredFromIntent;
          const ownedFromAbsent = confirmed
            ? confirmed.ownedFromAbsent === true
            : recoveredFromIntent &&
              (ownership?.ownedFromAbsent === true || ownership?.lastApplied == null);
          if (attributable && ownedFromAbsent) {
            if (cfg.agents?.defaults) delete cfg.agents.defaults.maxConcurrent;
            revertChange = { kind: "deleted", from: current ?? null, to: null };
            return {};
          }
          if (
            attributable &&
            typeof current === "number" &&
            current > kAgentConcurrencyLegacyCap
          ) {
            cfg.agents.defaults.maxConcurrent = kAgentConcurrencyLegacyCap;
            revertChange = {
              kind: "clamped",
              from: current,
              to: kAgentConcurrencyLegacyCap,
            };
            const subCap = kAgentConcurrencyLegacyCap - kSubagentConcurrencyDelta;
            if (
              typeof cfg.agents.defaults.subagents?.maxConcurrent === "number" &&
              cfg.agents.defaults.subagents.maxConcurrent > subCap
            ) {
              cfg.agents.defaults.subagents.maxConcurrent = subCap;
            }
            console.log(
              `[autotune] disabled: agents.defaults.maxConcurrent ${current} was autotune-written — clamped back to the legacy ${kAgentConcurrencyLegacyCap} ceiling`,
            );
            return {};
          }
          if (typeof current === "number" && current > kAgentConcurrencyLegacyCap) {
            console.log(
              `[autotune] disabled: agents.defaults.maxConcurrent ${current} exceeds the legacy ${kAgentConcurrencyLegacyCap} ceiling but is not autotune-written — left untouched`,
            );
          }
          // Nothing changed: never round-trip the operator's file.
          return { skipWrite: true };
        },
      });
    } catch (error) {
      // Keep the provenance: a busy/JSON5 config retries the revert next boot.
      reverted = false;
      revertChange = null;
      console.error(`[autotune] concurrency revert skipped: ${error.message}`);
    }
    if (reverted) delete ledger.ownedKeys[kConcurrencyKey];
    return { row: null, change: revertChange };
  }

  const target = derivation.values.bootMaxConcurrent;
  // Intent BEFORE the config write: if the ledger can't persist the intent,
  // we must not create ownership we could lose track of.
  ledger.ownedKeys[kConcurrencyKey] = {
    ...(ownership || {}),
    intent: { value: target, at: Date.now() },
  };
  const intentPersisted = persistLedger();

  let outcome;
  try {
    const { action, current } = updateOpenclawConfigFn({
      fsModule,
      openclawDir,
      mutate: (cfg) => {
        const current = readCurrent(cfg);
        if (current == null) {
          if (!intentPersisted)
            return { action: "skipped_no_intent", current, skipWrite: true };
          if (!cfg.agents) cfg.agents = {};
          if (!cfg.agents.defaults) cfg.agents.defaults = {};
          cfg.agents.defaults.maxConcurrent = target;
          return { action: "adopted", current };
        }
        const confirmed = ownership && !ownership.intent ? ownership : null;
        if (confirmed && current === confirmed.lastApplied) {
          cfg.agents.defaults.maxConcurrent = target;
          return { action: "reapplied", current };
        }
        // Crash-window recovery: a stale intent whose value matches the config
        // means OUR write landed but the confirm never persisted. Confirm it
        // now instead of relinquishing — otherwise the autotune-written value
        // is orphaned as "operator intent" forever.
        const staleIntent = ownership?.intent || null;
        if (staleIntent && current === staleIntent.value) {
          cfg.agents.defaults.maxConcurrent = target;
          return { action: "recovered", current };
        }
        return {
          action: confirmed ? "relinquished" : "foreign",
          current,
          skipWrite: true,
        };
      },
    });
    outcome = { action, current };
  } catch (error) {
    // JSON5/${ENV}/$include configs fail closed in readOpenclawConfigForWrite;
    // a contended lock times out — both skip, never block the caller.
    delete ledger.ownedKeys[kConcurrencyKey].intent;
    if (!ownership) delete ledger.ownedKeys[kConcurrencyKey];
    persistLedger();
    return {
      row: {
        knob: "agentConcurrencyCap",
        value: derivation.values.agentConcurrencyCap,
        target: "openclaw-config",
        status: "skipped",
        restartTarget: null,
        reason:
          error.name === "OpenclawConfigReadError"
            ? "openclaw.json uses JSON5 features AlphaClaw won't rewrite — set agents.defaults.maxConcurrent yourself, or simplify the file"
            : "the config file was busy — use Recalculate to try again",
        error: error.message,
      },
      change: null,
    };
  }

  if (
    outcome.action === "adopted" ||
    outcome.action === "reapplied" ||
    outcome.action === "recovered"
  ) {
    // A gateway spawn AFTER our last confirmed write consumed this value
    // (spawn stamp sets satisfiedAt); an unchanged reapply keeps that truth —
    // a fresh value resets it and waits for the next spawn.
    const valueUnchanged =
      outcome.action === "reapplied" && ownership?.lastApplied === target;
    const satisfiedAt = valueUnchanged ? (ownership?.satisfiedAt ?? null) : null;
    ledger.ownedKeys[kConcurrencyKey] = {
      ownedFromAbsent:
        outcome.action === "adopted"
          ? true
          : outcome.action === "recovered"
            ? // No prior confirmed write → the crashed write was the adoption.
              (ownership?.lastApplied == null || ownership?.ownedFromAbsent === true)
            : ownership?.ownedFromAbsent === true,
      lastApplied: target,
      ...(satisfiedAt ? { satisfiedAt } : {}),
    };
    persistLedger();
    return {
      row: {
        knob: "agentConcurrencyCap",
        value: derivation.values.agentConcurrencyCap,
        effectiveValue: target,
        effectiveSource: "boot default",
        target: "openclaw-config",
        status: satisfiedAt ? "applied" : "pending_restart",
        restartTarget: satisfiedAt ? null : "gateway",
        appliedAt: satisfiedAt,
        verified: true,
        reason: null,
      },
      // Unchanged reapplies never announce (no every-boot spam): a change is
      // a persisted value that actually moved (adopt from absent counts).
      // Exception: a crash-window "recovered" confirm announces even when the
      // value already matches — the original write's announcement died with
      // the crash (enqueue happens after the config write), and an
      // unannounced mutation of the operator's file is exactly what this
      // invariant forbids (adversarial review F8).
      change:
        outcome.action === "recovered"
          ? { kind: "recovered", from: outcome.current ?? null, to: target }
          : outcome.current === target
            ? null
            : { kind: "set", from: outcome.current ?? null, to: target },
    };
  }

  // relinquished / foreign / skipped_no_intent: we do not manage this value.
  delete ledger.ownedKeys[kConcurrencyKey];
  persistLedger();
  return {
    row: {
      knob: "agentConcurrencyCap",
      value: derivation.values.agentConcurrencyCap,
      effectiveValue: outcome.current ?? null,
      effectiveSource:
        outcome.action === "relinquished"
          ? "changed outside autotune (operator or channel auto-scale) — no longer managed"
          : "operator or channel-managed",
      target: "openclaw-config",
      status: "manual",
      restartTarget: null,
      reason:
        outcome.action === "skipped_no_intent"
          ? "ledger not writable — refusing to adopt a value we could lose track of"
          : null,
    },
    change: null,
  };
};

const runApply = async ({
  trigger = "boot",
  refreshProfile = false,
  deps = {},
} = {}) => {
  const {
    fsModule = state.fsModule,
    openclawDir = OPENCLAW_DIR,
    updateOpenclawConfigFn = require("./openclaw-config").updateOpenclawConfig,
    emitWatchdogEvent = null,
    notify = null,
    markRestartRequired = null,
    syncPromptFiles = null,
    env = process.env,
  } = deps;

  const profile = refreshProfile ? refreshMachineProfile() : getMachineProfile();
  await whenGpuEnriched();

  const ledger = loadLedger();
  const active = isAutotuneActive({ env, fsModule, openclawDir });
  let settings;
  try {
    settings = readAutotuneSettings({ fsModule, openclawDir });
  } catch {
    settings = { enabled: false, overrides: {} };
  }
  const derivation = active
    ? deriveTunings(profile, { overrides: settings.overrides })
    : { suppressed: false, values: {}, notes: {} };

  // Resize detection on capacity fields only. The retune side-effects
  // (notification, watchdog event, restart-required flag) fire ONLY when
  // tuning is actually active — a disabled/kill-switched/suppressed autotune
  // must never announce "settings retuned" for settings it did not touch.
  const tuningActive = active && !derivation.suppressed;
  const capacity = capacityOf(profile);
  const previous = ledger.lastObservedProfile;
  let resized = false;
  const resizeParts = [];
  if (previous && !sameCapacity(previous, capacity)) {
    resized = true;
    ledger.lastResize = {
      from: previous,
      to: capacity,
      at: Date.now(),
      // No banner nagging for a restart that would apply nothing.
      acknowledged: !tuningActive,
    };
    const fmt = (bytes) =>
      bytes == null ? "?" : `${Math.round((bytes / kGb) * 10) / 10}GB`;
    if (previous.memoryLimitBytes !== capacity.memoryLimitBytes) {
      resizeParts.push(`memory ${fmt(previous.memoryLimitBytes)}→${fmt(capacity.memoryLimitBytes)}`);
    }
    if (previous.cpuCores !== capacity.cpuCores) {
      resizeParts.push(`cpu ${previous.cpuCores}→${capacity.cpuCores} cores`);
    }
    if ((previous.diskTotalBytes ?? null) !== (capacity.diskTotalBytes ?? null)) {
      resizeParts.push(`disk ${fmt(previous.diskTotalBytes)}→${fmt(capacity.diskTotalBytes)}`);
    }
    if (tuningActive) {
      // The user-facing notification is deferred below so the concurrency
      // delta folds into ONE composed message per apply (never two alerts
      // for one resize); the event row and restart flag fire immediately.
      const message = `Container resized (${resizeParts.join(", ")}) — settings retuned`;
      console.log(`[autotune] ${message}`);
      try {
        emitWatchdogEvent?.({ eventType: "autotune", message });
      } catch {}
      try {
        markRestartRequired?.("autotune_resize");
      } catch {}
    } else {
      console.log(
        `[autotune] container capacity changed (${resizeParts.join(", ")}) — ${
          active && derivation.suppressed
            ? "autotune is suppressed (container limits unreadable), holding defaults"
            : "autotune is off, nothing retuned"
        }`,
      );
    }
  }
  ledger.lastObservedProfile = capacity;

  const { row: concurrencyRow, change: concurrencyChange } = applyConcurrency({
    active,
    derivation,
    ledger,
    deps: {
      updateOpenclawConfigFn,
      openclawDir,
      fsModule,
    },
  });
  if (concurrencyRow?.status === "skipped") {
    try {
      emitWatchdogEvent?.({
        eventType: "autotune",
        message: `Autotune skipped agents.defaults.maxConcurrent: ${concurrencyRow.reason}`,
      });
    } catch {}
  }

  // ONE composed notification per apply transaction. Autotune writes the
  // operator's openclaw.json — an automatic fix that must announce itself
  // (important class: quiet mode still delivers it). Stable day-bucketed ids:
  // boot loops dedupe in the outbox, a new episode later re-fires.
  const dayBucket = utcDayBucket();
  const concurrencyLine =
    concurrencyChange == null
      ? null
      : concurrencyChange.kind === "deleted"
        ? `Autotune disabled — agents.defaults.maxConcurrent restored to the default (removed ${concurrencyChange.from ?? "the autotune-set value"}).`
        : concurrencyChange.kind === "clamped"
          ? `Autotune disabled — agents.defaults.maxConcurrent clamped back to ${concurrencyChange.to} (was ${concurrencyChange.from}).`
          : concurrencyChange.kind === "recovered"
            ? `Autotune confirmed agents.defaults.maxConcurrent = ${concurrencyChange.to} in openclaw.json (written just before a restart).`
            : `Autotune set agents.defaults.maxConcurrent to ${concurrencyChange.to} in openclaw.json (was ${concurrencyChange.from ?? "unset"}).`;
  if (resized && tuningActive) {
    // A downsize is operator-relevant (less headroom, OOM risk); growth is
    // routine. Any shrinking dimension wins the urgent branch.
    const shrank =
      (previous?.memoryLimitBytes != null &&
        capacity.memoryLimitBytes != null &&
        capacity.memoryLimitBytes < previous.memoryLimitBytes) ||
      (previous?.cpuCores != null &&
        capacity.cpuCores != null &&
        capacity.cpuCores < previous.cpuCores) ||
      (previous?.diskTotalBytes != null &&
        capacity.diskTotalBytes != null &&
        capacity.diskTotalBytes < previous.diskTotalBytes);
    const headline = shrank
      ? `⚠️ Container downsized (${resizeParts.join(", ")}) — OpenClaw was retuned to fit. Watch for OOM pressure.`
      : `Container resized (${resizeParts.join(", ")}) — settings retuned.`;
    const capacitySignature = `${capacity.memoryLimitBytes ?? "x"}-${capacity.cpuCores ?? "x"}-${capacity.diskTotalBytes ?? "x"}`;
    try {
      notify?.(
        [headline, ...(concurrencyLine ? [concurrencyLine] : [])].join("\n"),
        {
          eventType: "autotune",
          id: `autotune-retune-${capacitySignature}-${dayBucket}`,
        },
      );
    } catch {}
  } else if (concurrencyLine) {
    try {
      notify?.(concurrencyLine, {
        eventType: "autotune",
        id: `autotune-concurrency-${concurrencyChange.from ?? "unset"}-${concurrencyChange.to ?? "default"}-${dayBucket}`,
      });
    } catch {}
  }

  const rows = buildRows({ active, derivation, ledger, concurrencyRow });

  state.ledger = {
    ...ledger,
    version: kLedgerVersion,
    enabled: active,
    trigger,
    updatedAt: Date.now(),
    profile,
    derived: derivation.values,
    suppressed: derivation.suppressed === true,
    suppressedReason: derivation.suppressed ? derivation.reason : null,
    overrides: settings.overrides,
    rows,
    activeGatewayEnv: state.activeGatewayEnv,
  };
  persistLedger();

  if (resized && typeof syncPromptFiles === "function") {
    try {
      syncPromptFiles();
    } catch {}
  }
  return getAutotuneLedger();
};

// Serialized entry point: overlapping callers (route PUT racing a resize
// tick) chain instead of interleaving ledger writes.
const applyResourceAutotune = (options = {}) => {
  const next = state.applyChain.then(() => runApply(options));
  // Keep the chain alive on failure; callers see their own rejection.
  state.applyChain = next.catch(() => {});
  return next;
};

const getAutotuneLedger = () => {
  const ledger = loadLedger();
  return {
    enabled: ledger.enabled ?? null,
    // The env kill-switch is a second OFF that config alone can't explain —
    // the UI needs it to avoid a false success toast on toggle-on.
    killSwitchActive: isKillSwitchActive(),
    suppressed: ledger.suppressed ?? false,
    suppressedReason: ledger.suppressedReason ?? null,
    updatedAt: ledger.updatedAt ?? null,
    trigger: ledger.trigger ?? null,
    profile: ledger.profile ?? null,
    derived: ledger.derived ?? null,
    overrides: ledger.overrides ?? {},
    rows: ledger.rows ?? [],
    lastResize: ledger.lastResize ?? null,
    activeGatewayEnv: state.activeGatewayEnv,
  };
};

const acknowledgeResize = () => {
  const ledger = loadLedger();
  if (ledger.lastResize && !ledger.lastResize.acknowledged) {
    ledger.lastResize = { ...ledger.lastResize, acknowledged: true };
    persistLedger();
    return true;
  }
  return false;
};

const resetAutotuneForTests = ({
  fsModule = fs,
  managedDir = kOpenclawManagedDir,
} = {}) => {
  state.fsModule = fsModule;
  state.managedDir = managedDir;
  state.ledger = null;
  state.installed = {
    openAiCompatBodyLimitMb: null,
    localBodyLimitMb: null,
    sqliteCacheMb: null,
  };
  state.activeGatewayEnv = null;
  state.applyChain = Promise.resolve();
};

module.exports = {
  deriveTunings,
  getDerivedGatewayHeapMb,
  maxGatewayHeapMbFor,
  applyResourceAutotune,
  getAutotuneLedger,
  acknowledgeResize,
  getGatewayNodeOptionsSuffix,
  getUvThreadpoolSize,
  getAgentConcurrencyCap,
  deriveBodyLimits,
  getSqliteCacheMb,
  getBackupMaxTotalBytes,
  stampGatewayEnvApplied,
  revertGatewayEnvStamp,
  stampOpenclawConfigConsumed,
  getActiveGatewayHeapMb,
  isAutotuneActive,
  resetAutotuneForTests,
};
