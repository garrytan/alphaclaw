import { h } from "preact";
import htm from "htm";
import { AsyncSection } from "../../async-section.js";
import { Badge } from "../../badge.js";
import { InlineErrorChip } from "../../inline-error-chip.js";
import { formatBytes } from "../helpers.js";
import { ResourceBar } from "../resource-bar.js";
import { Tooltip } from "../../tooltip.js";
import { InfoTooltip } from "../../info-tooltip.js";

// Display-only warning threshold for sustained event-loop lag; interpolated
// into the help text below so the copy can't drift from the highlight.
const kEventLoopP99WarnMs = 500;

const html = htm.bind(h);

const kTierLabels = {
  micro: "Micro",
  small: "Small",
  medium: "Medium",
  large: "Large",
  xl: "XL",
};

// Capacity header view-model (pure — exported for tests). The anchor is TEXT
// (`4 vCPU · 8.0 GB memory · 80 GB disk`) with one neutral tier badge beside
// it; a source badge appears ONLY when degraded to host values (never a happy
// path "cgroup v2" badge) and a GPU chip ONLY when a GPU is present (never
// "no GPU"). Returns null when the server doesn't send a profile (older
// server) — the card renders exactly as before.
export const buildCapacityHeaderModel = (profile = null) => {
  if (!profile) return null;
  const parts = [];
  if (profile.cpu?.cores != null) parts.push(`${profile.cpu.cores} vCPU`);
  if (profile.memory?.limitBytes != null) {
    parts.push(`${formatBytes(profile.memory.limitBytes)} memory`);
  }
  // Disk is omitted when detection failed (statfs error) — no dash filler.
  if (profile.disk?.totalBytes != null) {
    parts.push(`${formatBytes(profile.disk.totalBytes)} disk`);
  }
  if (!parts.length) return null;
  const gpu = profile.gpu || null;
  const devices = Array.isArray(gpu?.devices) ? gpu.devices : [];
  const gpuLabel =
    gpu?.present === true
      ? `${devices[0]?.name || gpu.vendor || "GPU"}${devices.length > 1 ? ` +${devices.length - 1} more` : ""}`
      : null;
  return {
    text: parts.join(" · "),
    tierLabel: kTierLabels[profile.tier] || profile.tier || null,
    hostValues: profile.memory?.source === "host",
    gpuLabel,
  };
};

const buildMemorySegments = (resources) => {
  const processes = resources.processes;
  const totalBytes = resources.memory?.totalBytes;
  const usedBytes = resources.memory?.usedBytes;
  if (!processes || !totalBytes || !usedBytes) return null;
  const segments = [];
  let trackedBytes = 0;
  if (processes.gateway?.rssBytes != null) {
    trackedBytes += processes.gateway.rssBytes;
    segments.push({
      percent: (processes.gateway.rssBytes / totalBytes) * 100,
      color: "#22d3ee",
      label: `Gateway ${formatBytes(processes.gateway.rssBytes)}`,
    });
  }
  if (processes.alphaclaw?.rssBytes != null) {
    trackedBytes += processes.alphaclaw.rssBytes;
    segments.push({
      percent: (processes.alphaclaw.rssBytes / totalBytes) * 100,
      color: "#a78bfa",
      label: `AlphaClaw ${formatBytes(processes.alphaclaw.rssBytes)}`,
    });
  }
  const otherBytes = Math.max(0, usedBytes - trackedBytes);
  if (otherBytes > 0) {
    segments.push({
      percent: (otherBytes / totalBytes) * 100,
      color: "#4b5563",
      label: `Other ${formatBytes(otherBytes)}`,
    });
  }
  return segments.length ? segments : null;
};

export const WatchdogResourcesCard = ({
  resources = null,
  profile = null,
  error = null,
  onRetry = () => {},
  memoryExpanded = false,
  onSetMemoryExpanded = () => {},
}) => {
  const capacity = buildCapacityHeaderModel(profile);
  const diskLabel = resources?.disk?.path
    ? html`
        <${Tooltip}
          text=${resources.disk.path}
          widthClass="w-auto max-w-80 whitespace-normal break-all"
        >
          <span class="inline-block cursor-help">Disk</span>
        </${Tooltip}>
      `
    : "Disk";
  const memorySegments = resources ? buildMemorySegments(resources) : null;

  // The frame never unmounts: a failed poll shows an inline error (with a
  // stale note when last-known-good bars are still on screen), never a blank.
  const bars = resources
    ? html`
        ${memoryExpanded
          ? html`
              <${ResourceBar}
                label="Memory"
                detail=${`${formatBytes(resources.memory?.usedBytes)} / ${formatBytes(resources.memory?.totalBytes)}`}
                percent=${resources.memory?.percent}
                expanded=${true}
                onToggle=${() => onSetMemoryExpanded(false)}
                segments=${memorySegments}
              />
            `
          : html`
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <${ResourceBar}
                  label="Memory"
                  percent=${resources.memory?.percent}
                  detail=${`${formatBytes(resources.memory?.usedBytes)} / ${formatBytes(resources.memory?.totalBytes)}`}
                  onToggle=${() => onSetMemoryExpanded(true)}
                />
                <${ResourceBar}
                  label=${diskLabel}
                  percent=${resources.disk?.percent}
                  detail=${`${formatBytes(resources.disk?.usedBytes)} / ${formatBytes(resources.disk?.totalBytes)}`}
                />
                <${ResourceBar}
                  label=${`CPU${resources.cpu?.cores ? ` (${resources.cpu.cores} vCPU)` : ""}`}
                  percent=${resources.cpu?.percent}
                  detail=${resources.cpu?.percent != null
                    ? `${resources.cpu.percent}%`
                    : "—"}
                />
              </div>
            `}
        ${resources.eventLoop || resources.unhandledRejections
          ? html`
              <div
                class="mt-3 pt-3 border-t border-border flex flex-wrap items-center gap-x-4 gap-y-1 text-xs"
              >
                ${resources.eventLoop
                  ? html`
                      <span
                        class=${`inline-flex items-center gap-1 ${
                          Number(resources.eventLoop.p99Ms) > kEventLoopP99WarnMs
                            ? "text-status-warning-muted"
                            : "text-fg-muted"
                        }`}
                      >
                        Event loop: p50 ${resources.eventLoop.p50Ms ?? "—"}ms ·
                        p99 ${resources.eventLoop.p99Ms ?? "—"}ms · max
                        ${resources.eventLoop.maxMs ?? "—"}ms
                        <${InfoTooltip}
                          text=${`Event-loop lag percentiles. Sustained p99 above ${kEventLoopP99WarnMs}ms means the admin process is starved — check recent gateway restarts and workspace size.`}
                        />
                      </span>
                    `
                  : null}
                ${resources.unhandledRejections
                  ? html`
                      <span
                        class=${Number(resources.unhandledRejections.total) > 0
                          ? "text-status-warning-muted"
                          : "text-fg-muted"}
                      >
                        Unhandled rejections:
                        ${resources.unhandledRejections.total ?? 0} total
                        (${resources.unhandledRejections.inWindow ?? 0} recent)
                      </span>
                    `
                  : null}
              </div>
            `
          : null}
      `
    : null;

  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      ${capacity
        ? html`
            <div class="flex flex-wrap items-center gap-2">
              <p class="text-sm text-body">${capacity.text}</p>
              ${capacity.tierLabel
                ? html`<${Badge} tone="neutral">${capacity.tierLabel}</${Badge}>`
                : null}
              ${capacity.hostValues
                ? html`<${Badge} tone="warning">host values</${Badge}>`
                : null}
              ${capacity.gpuLabel
                ? html`<${Badge} tone="cyan">${capacity.gpuLabel}</${Badge}>`
                : null}
            </div>
          `
        : null}
      ${resources && error
        ? html`<${InlineErrorChip}
            error=${error}
            headline="Couldn't refresh system resources — showing the last loaded values."
            onRetry=${onRetry}
          />`
        : null}
      ${resources
        ? bars
        : html`<${AsyncSection}
            loading=${!error}
            loadingLabel="Loading system resources..."
            error=${error}
            errorHeadline="Couldn't load system resources."
            onRetry=${onRetry}
          />`}
    </div>
  `;
};
