import { h } from "preact";
import htm from "htm";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  acknowledgeAutotuneResize,
  fetchAutotune,
  reapplyAutotune,
  updateAutotuneSettings,
} from "../../lib/api.js";
import { getCached, invalidateCache, setCached } from "../../lib/api-cache.js";
import { copyTextToClipboard } from "../../lib/clipboard.js";
import { useCachedFetch } from "../../hooks/use-cached-fetch.js";
import { useSavedSetting } from "../../hooks/use-saved-setting.js";
import { ActionButton } from "../action-button.js";
import { AsyncSection } from "../async-section.js";
import { Badge } from "../badge.js";
import { InlineErrorChip } from "../inline-error-chip.js";
import { SavedToggle } from "../saved-toggle.js";
import { showToast } from "../toast.js";
import { formatBytes, kTierLabels } from "./helpers.js";

const html = htm.bind(h);

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
  backupMaxTotalGb: "Backup storage budget",
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
  "AlphaClaw sizes its own settings to this container — gateway memory, agent concurrency, request size limits, database caches, and backup retention. Values re-derive at boot and when the container is resized. Every change is recorded below; anything requiring a restart says so.";

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
  if (knob === "backupMaxTotalGb")
    return formatBytes(value * 1024 * 1024 * 1024);
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

const pluralSettings = (n) => `${n} setting${n === 1 ? "" : "s"}`;

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

const handleCopy = async (value, what) => {
  const copied = await copyTextToClipboard(value);
  showToast(
    copied ? `${what} copied` : `Could not copy ${what.toLowerCase()}`,
    copied ? "success" : "error",
  );
};

// Stacked setting row — NOT a table (tables don't survive phone widths, and
// self-hosters debug OOMs from phones). Reasons render inline, never
// tooltip-gated.
const AutotuneRow = ({ row, onRestartGateway, restartingGateway = false }) => html`
  <div class="py-2 space-y-0.5" data-knob=${row.knob}>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-sm text-body">${row.label}</p>
      <${Badge} tone=${row.chip.tone}>${row.chip.label}</${Badge}>
    </div>
    <p class="text-xs text-fg-muted">${row.valueLine}</p>
    ${row.effectiveLine
      ? html`<p class="text-xs text-fg-muted">${row.effectiveLine}</p>`
      : null}
    ${row.reasonLine
      ? html`<p
          class=${`text-xs ${row.reasonTone === "warning" ? "text-status-warning-muted" : "text-fg-muted"}`}
        >
          ${row.reasonLine}
        </p>`
      : null}
    ${row.showGatewayRestart && typeof onRestartGateway === "function"
      ? html`<button
          type="button"
          class="text-xs text-status-warning-muted hover:text-status-warning underline underline-offset-2 ${restartingGateway
            ? "opacity-50 cursor-not-allowed"
            : ""}"
          disabled=${restartingGateway}
          onclick=${onRestartGateway}
        >
          ${restartingGateway ? "Restarting gateway..." : "Restart gateway now"}
        </button>`
      : null}
  </div>
`;

// Presentational shell — every piece of state arrives as props so the
// per-state renders are directly testable (no hooks in here).
export const AutotuneCardView = ({
  ledger = null,
  error = null,
  onRetry = () => {},
  enabled = true,
  settingHydrated = false,
  settingSaving = false,
  settingSavingContext = null,
  settingSaveError = null,
  settingLoadError = null,
  onRetryLoadSetting = () => {},
  onToggleEnabled = () => {},
  heapDraftValue = "",
  heapDirty = false,
  onHeapInput = () => {},
  onHeapSave = () => {},
  reapplying = false,
  reapplyError = null,
  onReapply = () => {},
  dismissingResize = false,
  onDismissResize = () => {},
  onRestartGateway = null,
  restartingGateway = false,
}) => {
  const profile = ledger?.profile || null;
  const machineEcho = buildAutotuneMachineEcho(profile);
  const resizeBanner = ledger ? buildAutotuneResizeBanner(ledger) : null;
  const summary = ledger && enabled ? buildAutotuneSummaryModel(ledger) : null;
  const environmentNote =
    ledger && enabled ? buildAutotuneEnvironmentNote(ledger) : null;
  const recommendation =
    ledger && enabled ? buildAutotuneRecommendationModel(ledger) : null;
  const trigger = ledger?.trigger || null;
  const allRows = Array.isArray(ledger?.rows) ? ledger.rows : [];
  // The admin-heap recommendation renders as its own labeled row (item 7),
  // never among the tuned settings.
  const settingRows = allRows
    .filter((row) => row?.knob !== "adminHeapRecommendedMb")
    .map((row) => buildAutotuneRowModel(row, { trigger }));
  const counts = buildAutotuneCounts(allRows);
  const pendingNotice =
    enabled && counts.pendingGateway > 0
      ? `${pluralSettings(counts.pendingGateway)} waiting on a gateway restart.`
      : null;
  const overridesLine = buildAutotuneOverridesLine(ledger?.overrides);
  const heapSaving =
    settingSaving && settingSavingContext === kAutotuneHeapContext;
  const heapSaveError =
    settingSaveError && settingSaveError.context === kAutotuneHeapContext
      ? settingSaveError
      : null;

  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="card-label">Resource autotune</h2>
        <${SavedToggle}
          value=${enabled}
          hydrated=${settingHydrated}
          saving=${settingSaving}
          savingContext=${settingSavingContext}
          saveError=${settingSaveError}
          loadError=${settingLoadError}
          onRetryLoad=${onRetryLoadSetting}
          onChange=${onToggleEnabled}
          describe=${describeAutotuneSaveError}
          context=${kAutotuneEnabledContext}
          disabled=${reapplying}
        />
      </div>

      ${ledger && error
        ? html`<${InlineErrorChip}
            error=${error}
            headline="Couldn't refresh autotune status — showing the last loaded values."
            onRetry=${onRetry}
          />`
        : null}
      ${!ledger
        ? html`<${AsyncSection}
            loading=${!error}
            loadingLabel="Loading autotune status..."
            error=${error}
            errorHeadline="Couldn't load autotune status."
            onRetry=${onRetry}
          />`
        : html`
            ${resizeBanner
              ? html`
                  <div
                    class="ac-surface-inset border border-yellow-500/35 rounded-lg px-3 py-2 flex flex-wrap items-center justify-between gap-2"
                  >
                    <p class="text-xs text-status-warning-muted min-w-0">
                      ${resizeBanner.text}
                    </p>
                    <div class="flex items-center gap-2 shrink-0">
                      ${resizeBanner.showRestart &&
                      typeof onRestartGateway === "function"
                        ? html`<button
                            type="button"
                            class="text-xs text-status-warning-muted hover:text-status-warning underline underline-offset-2 ${restartingGateway
                              ? "opacity-50 cursor-not-allowed"
                              : ""}"
                            disabled=${restartingGateway}
                            onclick=${onRestartGateway}
                          >
                            ${restartingGateway
                              ? "Restarting..."
                              : "Restart gateway"}
                          </button>`
                        : null}
                      <button
                        type="button"
                        class="text-xs text-fg-muted hover:text-body ${dismissingResize
                          ? "opacity-50 cursor-not-allowed"
                          : ""}"
                        disabled=${dismissingResize}
                        onclick=${onDismissResize}
                      >
                        ${dismissingResize ? "Dismissing..." : "Dismiss"}
                      </button>
                    </div>
                  </div>
                `
              : null}
            ${pendingNotice
              ? html`<p class="text-xs text-status-warning-muted">
                  ${pendingNotice}
                </p>`
              : null}

            <p class="text-xs text-fg-muted">${kAutotuneCardCopy}</p>

            ${machineEcho
              ? html`<p class="text-xs text-fg-muted">${machineEcho}</p>`
              : null}
            ${!enabled
              ? html`<p class="text-sm text-fg-muted">
                  ${buildAutotuneDisabledParagraph(
                    profile,
                    ledger?.activeGatewayEnv ?? null,
                  )}
                </p>`
              : html`
                  ${environmentNote
                    ? html`<p
                        class=${`text-xs ${environmentNote.tone === "warning" ? "text-status-warning-muted" : "text-fg-muted"}`}
                      >
                        ${environmentNote.text}
                      </p>`
                    : null}
                  ${summary
                    ? html`
                        <div class="flex flex-wrap items-center gap-2">
                          <p
                            class=${`text-sm ${summary.tone === "warning" ? "text-status-warning-muted" : "text-fg-muted"}`}
                          >
                            ${summary.text}
                          </p>
                          ${summary.partial
                            ? html`<${Badge} tone="warning">Partially applied</${Badge}>`
                            : null}
                        </div>
                      `
                    : html`<p class="text-sm text-fg-muted">
                        No tunings applied yet — they apply at boot.
                      </p>`}
                  ${profile?.tier === "micro"
                    ? html`<p class="text-xs text-status-warning-muted">
                        ${kAutotuneMicroTierNote}
                      </p>`
                    : null}
                  ${settingRows.length
                    ? html`
                        <div class="divide-y divide-border">
                          ${settingRows.map(
                            (row) => html`
                              <${AutotuneRow}
                                key=${row.knob}
                                row=${row}
                                onRestartGateway=${onRestartGateway}
                                restartingGateway=${restartingGateway}
                              />
                            `,
                          )}
                        </div>
                        <p class="text-xs text-fg-dim">${kAutotuneFootnote}</p>
                      `
                    : null}
                `}

            <div class="border-t border-border pt-3 space-y-2">
              ${overridesLine
                ? html`<p class="text-xs text-fg-muted">${overridesLine}</p>`
                : html`
                    <div class="flex flex-wrap items-center gap-2">
                      <p class="text-xs text-fg-muted">
                        Overrides: none set — pin a value via the API or the
                        OpenClaw agent
                      </p>
                      <button
                        type="button"
                        class="text-xs text-fg-muted hover:text-body underline underline-offset-2"
                        onclick=${() =>
                          handleCopy(
                            kAutotuneOverridesExampleCommand,
                            "Example command",
                          )}
                      >
                        Copy example command
                      </button>
                    </div>
                  `}
              <div class="flex flex-wrap items-center gap-2">
                <label class="text-xs text-fg-muted" for="autotune-heap-override">
                  Gateway heap override (MB)
                </label>
                <input
                  id="autotune-heap-override"
                  type="number"
                  min="128"
                  step="1"
                  inputmode="numeric"
                  placeholder="auto"
                  class="bg-field border border-border rounded-lg px-2 py-1 text-xs text-body w-28 focus:outline-none focus:border-fg-muted"
                  value=${heapDraftValue}
                  disabled=${!settingHydrated || settingSaving}
                  oninput=${onHeapInput}
                />
                <${ActionButton}
                  tone="secondary"
                  idleLabel="Save"
                  loadingLabel="Saving..."
                  loading=${heapSaving}
                  disabled=${!heapDirty || !settingHydrated}
                  onClick=${onHeapSave}
                />
              </div>
              <p class="text-xs text-fg-dim">
                Pins the gateway's V8 heap; leave the field empty to return to
                the derived value. Applies on the next gateway restart.
              </p>
              ${heapSaveError
                ? html`<${InlineErrorChip}
                    error=${heapSaveError.error}
                    headline="Couldn't save the gateway heap override — showing the server's current state."
                  />`
                : null}
            </div>

            ${recommendation && enabled
              ? html`
                  <div class="border-t border-border pt-3 space-y-1">
                    <p class="text-xs text-body">Recommendation</p>
                    <div class="flex flex-wrap items-center gap-2">
                      <p class="text-xs text-fg-muted min-w-0">
                        ${recommendation.text}
                      </p>
                      <button
                        type="button"
                        class="text-xs text-fg-muted hover:text-body underline underline-offset-2 shrink-0"
                        onclick=${() =>
                          handleCopy(recommendation.command, "Start command")}
                      >
                        Copy
                      </button>
                    </div>
                    <p class="text-xs text-fg-dim">${recommendation.owner}</p>
                  </div>
                `
              : null}
            ${enabled
              ? html`
                  <div class="border-t border-border pt-3 space-y-2">
                    <${ActionButton}
                      tone="secondary"
                      idleLabel="Recalculate and apply settings"
                      loadingLabel="Recalculating..."
                      loading=${reapplying}
                      disabled=${settingSaving}
                      onClick=${onReapply}
                    />
                    <p class="text-xs text-fg-dim">
                      Re-reads container limits and reapplies. Manual overrides
                      stay in place. Settings that need a gateway restart will
                      say so.
                    </p>
                    ${reapplyError
                      ? html`<${InlineErrorChip}
                          error=${reapplyError}
                          headline="Couldn't recalculate autotune settings."
                          onRetry=${onReapply}
                        />`
                      : null}
                  </div>
                `
              : null}
          `}
    </div>
  `;
};

const selectAutotuneSettingsDoc = (data) => ({
  enabled: data?.ledger?.enabled !== false,
  gatewayHeapMb: data?.ledger?.overrides?.gatewayHeapMb ?? null,
});

// Container: owns the ledger fetch, the shared settings document (the toggle
// and the gatewayHeapMb field save through ONE useSavedSetting so they can't
// clobber each other), and the freshness triggers — restartSignal (spawn-time
// pending_restart → applied flips happen server-side, an event the card never
// observes otherwise) and the shared resources poll's profile.detectedAt
// (live resizes surface without a second poll loop).
export const WatchdogAutotuneCard = ({
  restartSignal = 0,
  resourcesProfile = null,
  onRestartGateway = null,
  restartingGateway = false,
}) => {
  const ledgerFetch = useCachedFetch(kAutotuneCacheKey, fetchAutotune);
  const ledger = ledgerFetch.data?.ledger || null;

  const setting = useSavedSetting({
    cacheKey: kAutotuneCacheKey,
    load: fetchAutotune,
    select: selectAutotuneSettingsDoc,
    selectSaved: (response) =>
      response?.ledger ? selectAutotuneSettingsDoc(response) : undefined,
    // The endpoint merges per key, so each save sends ONLY what its context
    // changed — the enabled toggle never writes back a stale override copy
    // and the heap field never writes back a stale enabled flag.
    save: (next, { context } = {}) =>
      updateAutotuneSettings(
        context === kAutotuneEnabledContext
          ? { enabled: next?.enabled === true }
          : context === kAutotuneHeapContext
            ? { overrides: { gatewayHeapMb: next?.gatewayHeapMb ?? null } }
            : {
                enabled: next?.enabled === true,
                overrides: { gatewayHeapMb: next?.gatewayHeapMb ?? null },
              },
      ),
    onSaved: async (next, response) => {
      // The PUT returns the fresh ledger — seed the shared cache so the row
      // list converges without a second GET (refresh() adopts the cache).
      if (response?.ledger) {
        setCached(kAutotuneCacheKey, { ok: true, ledger: response.ledger });
      }
      await ledgerFetch.refresh().catch(() => {});
    },
    label: "autotune settings",
  });

  const enabled =
    setting.hydrated && setting.value !== undefined
      ? setting.value?.enabled === true
      : ledger?.enabled !== false;

  const [heapDraft, setHeapDraft] = useState(null); // null = not editing
  const savedHeap = setting.value?.gatewayHeapMb ?? null;
  const savedHeapText = savedHeap === null ? "" : String(savedHeap);
  const heapDraftValue = heapDraft !== null ? heapDraft : savedHeapText;
  const heapDirty = heapDraft !== null && heapDraft.trim() !== savedHeapText;

  const [reapplying, setReapplying] = useState(false);
  const [reapplyError, setReapplyError] = useState(null);
  const [dismissingResize, setDismissingResize] = useState(false);

  // Gateway restarts flip pending rows server-side at spawn: invalidate and
  // refetch on the tab's restart signal (immediate + settled, mirroring the
  // incidents hook), or the chips stay amber forever.
  useEffect(() => {
    if (!restartSignal) return;
    invalidateCache(kAutotuneCacheKey);
    ledgerFetch.refresh({ force: true }).catch(() => {});
    const timer = setTimeout(() => {
      ledgerFetch.refresh({ force: true }).catch(() => {});
    }, 3500);
    return () => clearTimeout(timer);
  }, [restartSignal, ledgerFetch.refresh]);

  // Live-resize freshness: the Resources card's 5s poll carries the machine
  // profile; a detectedAt CHANGE (never the first observation) means the
  // server re-detected capacity, so the ledger is stale.
  const detectedAt = resourcesProfile?.detectedAt ?? null;
  const lastDetectedAtRef = useRef(null);
  useEffect(() => {
    if (detectedAt == null) return;
    if (lastDetectedAtRef.current == null) {
      lastDetectedAtRef.current = detectedAt;
      return;
    }
    if (lastDetectedAtRef.current === detectedAt) return;
    lastDetectedAtRef.current = detectedAt;
    invalidateCache(kAutotuneCacheKey);
    ledgerFetch.refresh({ force: true }).catch(() => {});
  }, [detectedAt, ledgerFetch.refresh]);

  const onToggleEnabled = useCallback(
    async (next) => {
      const outcome = await setting.commit(
        (current) => ({ ...(current || {}), enabled: next === true }),
        { context: kAutotuneEnabledContext },
      );
      if (outcome.ok) {
        // The commit's onSaved seeded the shared cache with the returned
        // ledger (and reconciled via refresh), so the cache holds the
        // server's adopted state — including killSwitchActive.
        const toast = buildAutotuneToggleToast(
          next === true,
          getCached(kAutotuneCacheKey)?.ledger || null,
        );
        showToast(toast.message, toast.tone);
      } else if (!outcome.busy) {
        // The SavedToggle's inline chip is the loud revert; the toast echoes
        // the failure for users who already scrolled away.
        showToast(
          outcome.error?.message || "Could not save autotune settings",
          "error",
        );
      }
    },
    [setting.commit],
  );

  const onHeapInput = useCallback((event) => {
    setHeapDraft(String(event?.target?.value ?? ""));
  }, []);

  const onHeapSave = useCallback(async () => {
    const raw = String(heapDraft ?? "").trim();
    let nextValue = null;
    if (raw !== "") {
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== raw) {
        showToast(
          "Enter a whole number of MB, or leave the field empty to clear the override",
          "error",
        );
        return;
      }
      nextValue = parsed;
    }
    const outcome = await setting.commit(
      (current) => ({ ...(current || {}), gatewayHeapMb: nextValue }),
      { context: kAutotuneHeapContext },
    );
    if (outcome.ok) {
      setHeapDraft(null);
      showToast(
        nextValue === null
          ? "Gateway heap override cleared — the derived value applies on the next gateway restart"
          : `Gateway heap override saved (${formatAutotuneValue("gatewayHeapMb", nextValue)}) — applies on the next gateway restart`,
        "success",
      );
    } else if (!outcome.busy) {
      // The hook reverted and is reconciling with the server; drop the
      // rejected draft too, or the field would keep showing a value the
      // error chip just said was never adopted.
      setHeapDraft(null);
    }
  }, [heapDraft, setting.commit]);

  const onReapply = useCallback(async () => {
    if (reapplying) return;
    setReapplying(true);
    setReapplyError(null);
    try {
      const data = await reapplyAutotune();
      if (data?.ledger) {
        setCached(kAutotuneCacheKey, { ok: true, ledger: data.ledger });
      }
      await ledgerFetch.refresh({ force: !data?.ledger }).catch(() => {});
      // The toast derives from the RETURNED ledger — honest about skips.
      const counts = buildAutotuneCounts(data?.ledger?.rows);
      showToast(
        counts.skipped > 0
          ? `Recalculated with ${pluralSettings(counts.skipped)} skipped — see the card for why`
          : `Recalculated — ${pluralSettings(counts.tuned)} tuned`,
        "info",
      );
    } catch (error) {
      setReapplyError(error);
      showToast(
        error?.message || "Could not recalculate autotune settings",
        "error",
      );
    } finally {
      setReapplying(false);
    }
  }, [reapplying, ledgerFetch.refresh]);

  const onDismissResize = useCallback(async () => {
    if (dismissingResize) return;
    setDismissingResize(true);
    try {
      await acknowledgeAutotuneResize();
      invalidateCache(kAutotuneCacheKey);
      await ledgerFetch.refresh({ force: true }).catch(() => {});
    } catch (error) {
      showToast(
        error?.message || "Could not dismiss the resize notice",
        "error",
      );
    } finally {
      setDismissingResize(false);
    }
  }, [dismissingResize, ledgerFetch.refresh]);

  return html`
    <${AutotuneCardView}
      ledger=${ledger}
      error=${ledgerFetch.error}
      onRetry=${() => ledgerFetch.refresh({ force: true }).catch(() => {})}
      enabled=${enabled}
      settingHydrated=${setting.hydrated}
      settingSaving=${setting.saving}
      settingSavingContext=${setting.savingContext}
      settingSaveError=${setting.saveError}
      settingLoadError=${setting.loadError}
      onRetryLoadSetting=${setting.retryLoad}
      onToggleEnabled=${onToggleEnabled}
      heapDraftValue=${heapDraftValue}
      heapDirty=${heapDirty}
      onHeapInput=${onHeapInput}
      onHeapSave=${onHeapSave}
      reapplying=${reapplying}
      reapplyError=${reapplyError}
      onReapply=${onReapply}
      dismissingResize=${dismissingResize}
      onDismissResize=${onDismissResize}
      onRestartGateway=${onRestartGateway}
      restartingGateway=${restartingGateway}
    />
  `;
};
