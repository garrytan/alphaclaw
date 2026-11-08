import { h } from "preact";
import htm from "htm";
import { AsyncSection } from "../../async-section.js";
import { Badge } from "../../badge.js";
import { TooltipBadge } from "../../tooltip-badge.js";
import { InlineErrorChip } from "../../inline-error-chip.js";
import { formatBytes, kTierLabels } from "../helpers.js";
import { ResourceBar } from "../resource-bar.js";
import { InfoTooltip } from "../../info-tooltip.js";
import { MemoryDetails, MemoryTrendRow, ContainerMemoryRow, buildMemoryTrendModel } from "./memory-details.js";
export { buildMemoryTrendModel } from "./memory-details.js";

// Display-only warning threshold for sustained event-loop lag; interpolated
// into the help text below so the copy can't drift from the highlight.
const kEventLoopP99WarnMs = 500;

const html = htm.bind(h);

// Capacity header view-model (pure — exported for tests). The anchor is TEXT
// (`4 vCPU · 8.0 GB memory · 80 GB disk`) with one neutral tier badge beside
// it; a source badge appears ONLY when degraded to host values (never a happy
// path "cgroup v2" badge) and a GPU chip ONLY when a GPU is present (never
// "no GPU"). On genuine bare metal host values ARE the correct values, so no
// source badge renders at all — the warning is reserved for container/unknown
// environments where host fallback means degraded detection. Returns null
// when the server doesn't send a profile (older server) — the card renders
// exactly as before.
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
    hostValues:
      profile.memory?.source === "host" &&
      profile.environment !== "bare-metal",
    gpuLabel,
  };
};

// The three meters' text values (pure — exported for tests): memory with the
// gateway's own share, disk with its mount, CPU as a share of the cores. CPU
// is null (the meter is hidden, never "0%") when the sample has no percent.
const knownNumber = (value) =>
  value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);

export const buildResourceMeters = (resources = null) => {
  if (!resources) return [];
  const process = resources.gatewayMemory?.process || null;
  // A missing reading is unknown, never 0 B (Number(null) is 0): the worker's
  // RSS, else the process group's, else no gateway detail at all.
  const gatewayBytes = knownNumber(process?.workerRssBytes) ?? knownNumber(process?.groupRssBytes);
  const meters = [
    {
      key: "memory",
      label: "Memory",
      percent: resources.memory?.percent,
      detail: `${formatBytes(resources.memory?.usedBytes)} of ${formatBytes(resources.memory?.totalBytes)}${
        gatewayBytes != null ? ` · gateway ${formatBytes(gatewayBytes)}` : ""
      }`,
    },
    {
      key: "disk",
      label: "Disk",
      percent: resources.disk?.percent,
      detail: `${formatBytes(resources.disk?.usedBytes)} of ${formatBytes(resources.disk?.totalBytes)}${
        resources.disk?.path ? ` on ${resources.disk.path}` : ""
      }`,
    },
  ];
  const cpuPercent = resources.cpu?.percent;
  if (cpuPercent != null && Number.isFinite(Number(cpuPercent))) {
    const cores = Number(resources.cpu?.cores) || 0;
    meters.push({
      key: "cpu",
      label: "CPU",
      percent: Number(cpuPercent),
      detail: cores ? `${cpuPercent}% of ${cores} core${cores === 1 ? "" : "s"}` : `${cpuPercent}%`,
    });
  }
  return meters;
};

// The disk row beside the meters (pure — exported for tests): the low-space
// warning and the days-to-full estimate from the watchdog's hourly disk
// samples. The warning's wording follows what is true now: free space under
// the warning line, min(10% of the disk, 20 GB); else the last hour's growth
// projecting the disk full within hours (above the line, currentTier is above
// ok only for that projection, whichever trigger opened the episode); else
// the episode is still open while free space sits between the line and the
// watchdog's 1.25x clear line, and the label claims neither. The estimate
// reads "not enough data yet" until the samples span a day, and is left out
// when the disk is not filling. Null when there is nothing to
// say or no fresh reading of the volume that holds OpenClaw's state.
export const buildDiskSpaceModel = (diskSpace = null) => {
  const volume = (Array.isArray(diskSpace?.volumes) ? diskSpace.volumes : [])
    .find((entry) => entry?.id === "state" && entry.sampleStatus === "fresh");
  if (!volume) return null;
  const critical = volume.state === "critical";
  const freeBytes = knownNumber(volume.freeBytes);
  const lineBytes = knownNumber(volume.lowThresholdBytes);
  const underLine = freeBytes != null && lineBytes != null && freeBytes < lineBytes;
  const fillingFast = !underLine && volume.currentTier != null && volume.currentTier !== "ok";
  const etaMs = knownNumber(volume.etaMs);
  const etaHours = Math.round((etaMs ?? 0) / 3_600_000);
  const etaText = etaMs == null || etaMs < 0
    ? ""
    : etaMs < 3_600_000
      ? ": full in less than an hour at the last hour's rate"
      : `: full in about ${etaHours} hour${etaHours === 1 ? "" : "s"} at the last hour's rate`;
  const warning = critical || volume.state === "low"
    ? {
      tone: critical ? "danger" : "warning",
      label: underLine ? (critical ? "Disk almost full" : "Disk space low") : fillingFast ? "Disk filling fast" : "Disk warning still open",
      text: underLine
        ? `${formatBytes(volume.freeBytes)} free, under the ${formatBytes(volume.lowThresholdBytes)} warning line`
        : fillingFast
          ? `${formatBytes(volume.freeBytes)} free and filling fast${etaText}`
          : `${formatBytes(volume.freeBytes)} free, above the ${formatBytes(volume.lowThresholdBytes)} warning line and not filling fast`,
    }
    : null;
  const estimate = volume.fillEstimate || null;
  const days = knownNumber(estimate?.daysToFull);
  const fill = estimate?.status === "filling" && days != null && days >= 0
    ? `Full in ${days < 1 ? "less than a day" : days < 2 ? "about 1 day" : `about ${Math.round(days)} days`} at the current rate`
    : estimate?.status === "not_enough_data"
      ? "Days until the disk is full: not enough data yet"
      : null;
  if (!warning && !fill) return null;
  return { warning, fill, filling: estimate?.status === "filling" };
};

const DiskSpaceRow = ({ diskSpace }) => {
  const model = buildDiskSpaceModel(diskSpace);
  if (!model) return null;
  return html`<div class="mt-2 flex flex-wrap items-center gap-2 text-xs" role="status">
    ${model.warning ? html`<${Badge} tone=${model.warning.tone}>${model.warning.label}</${Badge}>
      <span class="text-fg-muted">${model.warning.text}</span>` : null}
    ${model.fill
      ? html`<span class=${model.filling && model.warning ? "text-status-warning-muted" : "text-fg-muted"}>${model.warning ? "· " : ""}${model.fill}</span>`
      : null}
  </div>`;
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
  const memoryTrend = resources?.gatewayMemoryTrend || null;
  // The trend row lives in the expandable memory section, but an active
  // leak/critical verdict stays visible without expanding — hiding a live
  // warning behind a click would be dishonest.
  const memoryTrendVisible =
    memoryExpanded || buildMemoryTrendModel(memoryTrend)?.alwaysVisible === true;

  // The section never unmounts: a failed poll shows an inline error (with a
  // stale note when last-known-good meters are still on screen), never a blank.
  const bars = resources
    ? html`
        <div class="health-meters">
          ${buildResourceMeters(resources).map(
            (meter) => html`
              <${ResourceBar}
                key=${meter.key}
                label=${meter.label}
                percent=${meter.percent}
                detail=${meter.detail}
                expanded=${meter.key === "memory" ? memoryExpanded : false}
                onToggle=${meter.key === "memory" ? () => onSetMemoryExpanded(!memoryExpanded) : null}
              />
            `,
          )}
        </div>
        ${memoryExpanded ? html`<${MemoryDetails} memory=${resources.gatewayMemory} trend=${memoryTrend} />` : null}
        ${memoryTrendVisible ? html`<${MemoryTrendRow} trend=${memoryTrend} />` : null}
        <${ContainerMemoryRow} container=${memoryTrend?.container} />
        <${DiskSpaceRow} diskSpace=${resources.diskSpace} />
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
    <section class="briefing-section" aria-labelledby="health-resources-title">
      <div class="briefing-section-head">
        <h2 class="briefing-section-title" id="health-resources-title">Resources</h2>
      </div>
      ${capacity
        ? html`
            <div class="briefing-section-caption flex flex-wrap items-center gap-2">
              <span>${capacity.text}</span>
              ${capacity.tierLabel
                ? html`<${Badge} tone="neutral">${capacity.tierLabel}</${Badge}>`
                : null}
              ${capacity.hostValues
                ? html`<${TooltipBadge}
                    tone="warning"
                    label="Host values"
                    text="Container limits couldn't be detected — these numbers are the host's full capacity, not this container's share."
                  />`
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
            loadingLabel="Loading…"
            error=${error}
            errorHeadline="Couldn't load system resources."
            onRetry=${onRetry}
          />`}
    </section>
  `;
};
