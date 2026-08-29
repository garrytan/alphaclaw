import { h } from "preact";
import htm from "htm";
import { formatBytes } from "../helpers.js";
import { ResourceBar } from "../resource-bar.js";
import { Tooltip } from "../../tooltip.js";

const html = htm.bind(h);

export const WatchdogResourcesCard = ({
  resources = null,
  memoryExpanded = false,
  onSetMemoryExpanded = () => {},
}) => {
  if (!resources) return null;
  const diskLabel = resources.disk?.path
    ? html`
        <${Tooltip}
          text=${resources.disk.path}
          widthClass="w-auto max-w-80 whitespace-normal break-all"
        >
          <span class="inline-block cursor-help">Disk</span>
        </${Tooltip}>
      `
    : "Disk";
  const memorySegments = (() => {
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
  })();

  return html`
    <div class="bg-surface border border-border rounded-xl p-4">
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
                      class=${Number(resources.eventLoop.p99Ms) > 500
                        ? "text-status-warning-muted"
                        : "text-fg-muted"}
                      title="Event-loop lag percentiles. Sustained p99 above 500ms means the admin process is starved — check recent gateway restarts and workspace size."
                    >
                      Event loop: p50 ${resources.eventLoop.p50Ms ?? "—"}ms ·
                      p99 ${resources.eventLoop.p99Ms ?? "—"}ms · max
                      ${resources.eventLoop.maxMs ?? "—"}ms
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
    </div>
  `;
};
