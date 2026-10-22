import { formatBytes, kTierLabels } from "../helpers.js";

// "Resource autotune" card: AlphaClaw sizes its own and the gateway's
// resource-dependent settings to the container (default ON). The ledger from
// GET /api/autotune is the single source of truth; every row states what was
// applied, what is still pending, and WHICH process a pending change waits on
// (restartTarget) — a gateway-restart affordance must never render on a row
// that only an AlphaClaw restart can apply.

export const kAutotuneCacheKey = "/api/autotune";
export const kAutotuneEnabledContext = "enabled";
export const kAutotuneHeapContext = "gatewayHeapMb";

// Plain-language labels for the ledger knobs (spec'd copy — not the raw keys).
export const kAutotuneKnobLabels = {
  gatewayHeapMb: "Gateway memory limit (V8 heap)",
  adminHeapRecommendedMb: "AlphaClaw memory limit (recommendation)",
  agentConcurrencyCap: "Agent concurrency cap",
  openAiCompatBodyLimitMb: "API request size limit",
  localBodyLimitMb: "Local request size limit",
  sqliteCacheMb: "Database cache (per DB)",
  uvThreadpoolSize: "I/O thread pool",
};

// Exact badge.js tone map for row statuses. `skipped` is a warning, not
// danger — it is an environment condition, not a fault. `clamped` is reserved
// for override-clamps (the server never marks a formula floor/ceiling as
// clamped). Gateway-pending rows override the label to "Restart gateway".
export const kAutotuneStatusChips = {
  applied: { tone: "success", label: "Applied" },
  pending_restart: { tone: "warning", label: "Pending restart" },
  skipped: { tone: "warning", label: "Skipped" },
  clamped: { tone: "info", label: "Clamped" },
  manual: { tone: "neutral", label: "Manual" },
};

export const kAutotuneAlphaclawRestartReason =
  "Applies the next time AlphaClaw itself restarts — redeploy or restart from your host dashboard (Render/Railway).";

export const kAutotuneCardCopy =
  "AlphaClaw sizes its own settings to this container — gateway memory, agent concurrency, request size limits, and database caches. Values re-derive at boot and when the container is resized. Every change is recorded below; anything requiring a restart says so.";

export const kAutotuneFootnote =
  "Without autotune, Node caps the gateway heap near 4 GB regardless of container size and agent concurrency is capped at 64.";

export const kAutotuneMicroTierNote =
  "This is a very small container — memory is tight; 1 GB+ is recommended.";

export const kAutotuneOverridesExampleCommand =
  `alphaclaw admin PUT /api/autotune/settings --data '{"overrides":{"gatewayHeapMb":4096}}'`;

// Humanized values: MB/GB knobs render through formatBytes (never pragma-KB
// or Express strings); count knobs get their unit spelled out.
export const formatAutotuneValue = (knob, value) => {
  if (value == null) return "—";
  if (knob === "agentConcurrencyCap") return `${value} agents`;
  if (knob === "uvThreadpoolSize")
    return `${value} thread${value === 1 ? "" : "s"}`;
  return formatBytes(value * 1024 * 1024);
};

// Card is self-sufficient: the machine echo line answers "what box is this"
// without the Resources card. Pure — exported for tests.
export const buildAutotuneMachineEcho = (profile = null) => {
  if (!profile) return null;
  const parts = [];
  if (profile.memory?.limitBytes != null) {
    parts.push(`${formatBytes(profile.memory.limitBytes)} RAM`);
  }
  if (profile.cpu?.cores != null) parts.push(`${profile.cpu.cores} vCPU`);
  if (profile.tier) parts.push(`${profile.tier} tier`);
  return parts.length ? `Detected: ${parts.join(" · ")}` : null;
};

// Count arithmetic (spec'd): "tuned" = applied + pending_restart; manual
// recommendation rows and skipped rows are excluded from the tuned count and
// reported separately. `clamped` is a FLAG on a lifecycle status (an
// override-clamped heap can still be pending a restart — both facts must
// survive), counted independently as an annotation.
export const buildAutotuneCounts = (rows = []) => {
  const counts = {
    applied: 0,
    pendingGateway: 0,
    pendingAlphaclaw: 0,
    clamped: 0,
    skipped: 0,
    manual: 0,
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    const status = row?.status;
    if (row?.clamped === true || status === "clamped") counts.clamped += 1;
    if (status === "applied") counts.applied += 1;
    else if (status === "pending_restart") {
      if (row?.restartTarget === "gateway") counts.pendingGateway += 1;
      else counts.pendingAlphaclaw += 1;
    } else if (status === "clamped") counts.applied += 1; // legacy-server shape
    else if (status === "skipped") counts.skipped += 1;
    else if (status === "manual") counts.manual += 1;
  }
  counts.pending = counts.pendingGateway + counts.pendingAlphaclaw;
  counts.tuned = counts.applied + counts.pending;
  return counts;
};

export const pluralSettings = (n) => `${n} setting${n === 1 ? "" : "s"}`;

// The anchor line: answers "what happened". Tone = worst status present.
export const buildAutotuneSummaryModel = (ledger = null) => {
  const rows = Array.isArray(ledger?.rows) ? ledger.rows : [];
  const counts = buildAutotuneCounts(rows);
  if (counts.tuned + counts.skipped === 0) return null;
  if (counts.pending === 0 && counts.skipped === 0 && counts.clamped === 0) {
    // Older servers may omit the profile (or parts of it) from the ledger —
    // never render a "— / — vCPU" container description.
    const profile = ledger?.profile || null;
    const limitBytes = profile?.memory?.limitBytes;
    const cores = profile?.cpu?.cores;
    return {
      tone: "muted",
      partial: false,
      counts,
      text:
        limitBytes != null && cores != null
          ? `Tuned for this ${formatBytes(limitBytes)} / ${cores} vCPU container — no action needed.`
          : "Tuned for this container — no action needed.",
    };
  }
  if (counts.tuned === 0) {
    // Suppressed/held state: nothing was tuned, everything is reported.
    return {
      tone: "warning",
      partial: false,
      counts,
      text: `No settings tuned — ${pluralSettings(counts.skipped)} skipped`,
    };
  }
  const parts = [
    `${pluralSettings(counts.tuned)} tuned — ${counts.applied} applied`,
  ];
  if (counts.pendingGateway > 0) {
    parts.push(`${counts.pendingGateway} pending gateway restart`);
  }
  if (counts.pendingAlphaclaw > 0) {
    parts.push(`${counts.pendingAlphaclaw} pending AlphaClaw restart`);
  }
  if (counts.clamped > 0) parts.push(`${counts.clamped} clamped`);
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  return {
    tone: counts.pending + counts.skipped > 0 ? "warning" : "muted",
    partial: counts.tuned > 0 && counts.pending + counts.skipped > 0,
    counts,
    text: parts.join(", "),
  };
};

// Host-fallback is NOT an empty state: bare metal with host values is a
// neutral note + normal tuning; a container with unreadable limits means
// autotune HELD the built-in defaults (suppressed) and the copy says so.
export const buildAutotuneEnvironmentNote = (ledger = null) => {
  if (ledger?.suppressed === true) {
    return {
      tone: "warning",
      text: "Autotune held the built-in defaults because this container's limits are unreadable.",
    };
  }
  const profile = ledger?.profile || null;
  if (profile?.memory?.source !== "host") return null;
  const capacity = `${formatBytes(profile?.memory?.limitBytes)} / ${profile?.cpu?.cores ?? "—"} cores`;
  if (profile?.environment === "bare-metal") {
    return {
      tone: "muted",
      text: `Running on bare metal — tunings use the host's ${capacity}.`,
    };
  }
  return {
    tone: "warning",
    text: `Container limits couldn't be detected — tunings are based on the host's full ${capacity}.`,
  };
};

// Per-row view model. Restart ownership is keyed to restartTarget and ONLY an
// explicit "gateway" earns the inline restart affordance — anything else
// (alphaclaw, null, unknown) fails safe to the redeploy copy with no button.
export const buildAutotuneRowModel = (row, { trigger = null } = {}) => {
  const status = row?.status || "applied";
  const restartTarget = row?.restartTarget || null;
  const isGatewayPending =
    status === "pending_restart" && restartTarget === "gateway";
  const chip = isGatewayPending
    ? { tone: "warning", label: "Restart gateway" }
    : kAutotuneStatusChips[status] || { tone: "neutral", label: status };
  const context =
    status === "applied"
      ? trigger === "boot"
        ? "applied at boot"
        : "applied"
      : status === "pending_restart"
        ? isGatewayPending
          ? "applies on the next gateway restart"
          : "pending AlphaClaw restart"
        : status === "skipped"
          ? "not applied"
          : status === "clamped"
            ? "override clamped"
            : "manual — not applied automatically";
  const verifiedSuffix =
    row?.verified === true ? " · confirmed in openclaw.json" : "";
  // A clamped override's reason renders on ANY lifecycle status — the clamp
  // note and the restart signal are independent facts.
  const reasonLine =
    status === "pending_restart" && !isGatewayPending
      ? kAutotuneAlphaclawRestartReason
      : (row?.clamped === true || status === "skipped" || status === "clamped") &&
          row?.reason
        ? String(row.reason)
        : null;
  return {
    knob: row?.knob || "",
    label: kAutotuneKnobLabels[row?.knob] || row?.knob || "Setting",
    chip,
    valueLine: `${formatAutotuneValue(row?.knob, row?.value)} · ${context}${verifiedSuffix}`,
    effectiveLine:
      row?.effectiveValue != null
        ? `Effective: ${formatAutotuneValue(row?.knob, row.effectiveValue)}${row?.effectiveSource ? ` (${row.effectiveSource})` : ""}`
        : null,
    reasonLine,
    reasonTone: status === "skipped" ? "warning" : "muted",
    showGatewayRestart: isGatewayPending,
  };
};

// Resize banner: states the delta, the consequence, and the exit. Visibility
// derives from the LEDGER (lastResize.acknowledged + pending rows) — no
// invented client-side dismissed flag.
export const buildAutotuneResizeBanner = (ledger = null) => {
  const lastResize = ledger?.lastResize || null;
  if (!lastResize || lastResize.acknowledged === true) return null;
  const from = lastResize.from || {};
  const to = lastResize.to || {};
  const deltas = [];
  if (
    from.memoryLimitBytes != null &&
    to.memoryLimitBytes != null &&
    from.memoryLimitBytes !== to.memoryLimitBytes
  ) {
    deltas.push(
      `${formatBytes(from.memoryLimitBytes)} → ${formatBytes(to.memoryLimitBytes)}`,
    );
  }
  if (
    from.cpuCores != null &&
    to.cpuCores != null &&
    from.cpuCores !== to.cpuCores
  ) {
    deltas.push(`${from.cpuCores} vCPU → ${to.cpuCores} vCPU`);
  }
  const delta = deltas.join(", ") || "capacity changed";
  const counts = buildAutotuneCounts(ledger?.rows);
  const gatewayPending = counts.pendingGateway > 0;
  return {
    text: gatewayPending
      ? `Container resized ${delta} — settings retuned. Restart the gateway to finish applying.`
      : `Container resized ${delta} — settings retuned.`,
    showRestart: gatewayPending,
  };
};

// Recommendation row (admin heap is report-only: no self-re-exec). Renders
// only when the recommendation meaningfully differs from the heap AlphaClaw is
// actually running with — the server reports that as the row's effectiveValue;
// without it (older ledger) the recommendation is shown as-is.
export const buildAutotuneRecommendationModel = (ledger = null) => {
  const rows = Array.isArray(ledger?.rows) ? ledger.rows : [];
  const row = rows.find((r) => r?.knob === "adminHeapRecommendedMb") || null;
  if (!row || row.value == null) return null;
  if (
    row.effectiveValue != null &&
    Math.abs(row.value - row.effectiveValue) <= row.effectiveValue * 0.1
  ) {
    return null;
  }
  // README's per-process heap-budget form on purpose: the flag goes on the
  // AlphaClaw start command, never a blanket NODE_OPTIONS env var — children
  // (the gateway, the self-update npm install) would inherit that.
  return {
    command: `node --max-old-space-size=${row.value} bin/alphaclaw.js start`,
    text: `Optional — add --max-old-space-size=${row.value} to your AlphaClaw start command (node --max-old-space-size=${row.value} bin/alphaclaw.js start) to cap AlphaClaw's own memory. Avoid a blanket NODE_OPTIONS env var — child processes would inherit it.`,
    owner:
      "AlphaClaw restart required — this does not apply on a gateway restart.",
  };
};

export const buildAutotuneOverridesLine = (overrides = null) => {
  const entries = Object.entries(overrides || {}).filter(
    ([, value]) => value != null,
  );
  if (!entries.length) return null;
  return `Overrides: ${entries
    .map(([knob, value]) => `${knob} ${formatAutotuneValue(knob, value)}`)
    .join(", ")}`;
};

// The tier clause renders through the shared display labels (never the raw
// lowercase token) and is omitted entirely when the tier is missing/unknown.
// activeGatewayEnv (from the ledger) is non-null while the RUNNING gateway was
// spawned with autotune values — it keeps them until its next restart, so the
// copy must not claim built-in defaults are active until that restart happens.
export const buildAutotuneDisabledParagraph = (
  profile = null,
  activeGatewayEnv = null,
) => {
  const tier = profile?.tier && profile.tier !== "unknown" ? profile.tier : null;
  const tierLabel = tier ? kTierLabels[tier] || tier : null;
  const capacity = profile
    ? `${formatBytes(profile.memory?.limitBytes)} / ${profile.cpu?.cores ?? "—"} vCPU`
    : null;
  const detection = tierLabel
    ? `Detection stays on — ${tierLabel} tier (${capacity}).`
    : capacity
      ? `Detection stays on — ${capacity}.`
      : "Detection stays on.";
  const status = activeGatewayEnv
    ? "Autotune is off, but the running gateway still uses its previous tuned values — built-in defaults apply after the next gateway restart."
    : "Autotune is off. AlphaClaw and the gateway run with built-in defaults sized for small containers.";
  return `${status} ${detection}`;
};

// Chip headline after a failed/unconfirmed toggle save — the hook reconciles
// with a fresh GET, so the copy promises server truth.
export const describeAutotuneSaveError = (attempted) =>
  attempted?.enabled
    ? "Couldn't confirm enabling autotune — showing the server's current state."
    : "Couldn't confirm disabling autotune — showing the server's current state.";

export const kAutotuneKillSwitchToast =
  "Autotune stays off: the ALPHACLAW_AUTOTUNE_DISABLED environment kill-switch is set on this deployment — remove it to enable.";

// Kill-switch honesty: a PUT that "succeeds" while the environment
// kill-switch is set cannot actually enable autotune — the adopted ledger
// comes back enabled=false with killSwitchActive, and the toast must say so
// instead of claiming success. Pure — exported for tests.
export const buildAutotuneToggleToast = (requestedEnabled, ledger = null) => {
  if (
    requestedEnabled === true &&
    ledger?.enabled === false &&
    ledger?.killSwitchActive === true
  ) {
    return { message: kAutotuneKillSwitchToast, tone: "info" };
  }
  return {
    message: requestedEnabled
      ? "Resource autotune enabled — settings now scale to this machine."
      : "Resource autotune disabled — built-in defaults will be restored; a gateway restart may be needed to fully revert.",
    tone: "info",
  };
};
