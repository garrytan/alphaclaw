import { h } from "preact";
import htm from "htm";
import { AsyncSection } from "../../async-section.js";
import { InlineErrorChip } from "../../inline-error-chip.js";
import { formatBytes } from "../helpers.js";
import { ResourceBar } from "../resource-bar.js";
import { Tooltip } from "../../tooltip.js";

const html = htm.bind(h);

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
  error = null,
  onRetry = () => {},
  memoryExpanded = false,
  onSetMemoryExpanded = () => {},
}) => {
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
      `
    : null;

  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
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
