import { h } from "preact";
import htm from "htm";
import { Badge } from "../../badge.js";
import { InlineErrorChip } from "../../inline-error-chip.js";
import { formatBytes } from "../helpers.js";
import { formatDurationCompactMs, formatRelativeTime } from "../../../lib/format.js";

const html = htm.bind(h);

const kOwnerLabels = { gateway: "Gateway", tool: "Tools", alphaclaw: "AlphaClaw", other: "Other" };
const kRestartTones = { ready: "success", running: "info" };
const kFailingCronOutcomes = new Set(["error", "failed", "timeout"]);

// Pure view model of the five box views (exported for tests). Each section is
// null until its view has loaded; a section with a problem carries a tone the
// header can surface without expanding.
export const buildBoxSummary = ({ processes = null, restart = null, schedules = null, disk = null, mcp = null } = {}, { nowMs = Date.now() } = {}) => {
  const processSection = processes?.totals
    ? {
      total: processes.total ?? null,
      partial: processes.status === "partial",
      owners: Object.entries(kOwnerLabels)
        .map(([owner, label]) => ({ owner, label, count: processes.totals[owner]?.count ?? 0, rssBytes: processes.totals[owner]?.rssBytes ?? 0 }))
        .filter((entry) => entry.count > 0),
      top: (processes.processes || []).slice(0, 5).map((row) => ({ pid: row.pid, name: row.name, owner: row.owner, rssBytes: row.rssBytes })),
    }
    : null;

  const gateway = restart?.gateway || null;
  const restartSection = restart
    ? {
      outcome: gateway?.outcome ?? null,
      tone: gateway ? kRestartTones[gateway.outcome] || "warning" : "neutral",
      when: gateway?.requestedAt ? formatRelativeTime(gateway.requestedAt, { nowMs }) : null,
      source: gateway?.source ?? null,
      reason: gateway?.reason ?? null,
      downtime: Number.isFinite(gateway?.downtimeMs) ? formatDurationCompactMs(gateway.downtimeMs) : null,
      lastExit: restart.lastGatewayExit?.at
        ? { when: formatRelativeTime(restart.lastGatewayExit.at, { nowMs }), cause: restart.lastGatewayExit.cause || restart.lastGatewayExit.signal || (restart.lastGatewayExit.code != null ? `exit ${restart.lastGatewayExit.code}` : null) }
        : null,
    }
    : null;

  const mcpServers = Array.isArray(mcp?.servers) ? mcp.servers : null;
  const mcpSection = mcpServers
    ? {
      total: mcpServers.length,
      failing: mcpServers.filter((server) => server.failing).map((server) => ({ name: server.name, message: server.lastError?.message || null })),
      disabled: mcpServers.filter((server) => server.enabled === false).length,
    }
    : null;

  let scheduleSection = null;
  if (schedules?.ok) {
    const jobs = schedules.openclaw?.jobs || [];
    const upcoming = [
      ...jobs.filter((job) => job.enabled && job.nextRunAt).map((job) => ({ label: job.name || job.id, at: job.nextRunAt })),
      ...(schedules.alphaclaw || []).filter((entry) => entry.nextRunAt).map((entry) => ({ label: entry.title, at: entry.nextRunAt })),
      ...(schedules.system?.entries || []).filter((entry) => entry.nextRunAt).map((entry) => ({ label: entry.command, at: entry.nextRunAt })),
    ].filter((entry) => Date.parse(entry.at) > nowMs).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    scheduleSection = {
      openclawStatus: schedules.openclaw?.status ?? null,
      openclawJobs: jobs.length,
      failingJobs: jobs.filter((job) => kFailingCronOutcomes.has(String(job.lastOutcome || "").toLowerCase())).map((job) => job.name || job.id),
      alphaclawTimers: (schedules.alphaclaw || []).length,
      systemEntries: schedules.system?.total ?? 0,
      cronDaemon: schedules.system?.cronDaemon?.status ?? null,
      next: upcoming[0] ? { label: upcoming[0].label, in: formatRelativeTime(upcoming[0].at, { nowMs, allowFuture: true }) } : null,
    };
  }

  const diskSection = disk?.ok
    ? {
      volume: disk.volumes?.find((volume) => volume.status === "fresh") || null,
      partial: disk.census?.status === "partial",
      folders: (disk.stateDir?.entries || []).slice(0, 5),
      copies: (disk.temp || []).filter((group) => group.count > 0).map((group) => ({ id: group.id, title: group.title, count: group.count, bytes: group.bytes, due: group.retention?.due ?? 0 })),
    }
    : null;

  const alerts = [];
  if (mcpSection?.failing.length) alerts.push(`${mcpSection.failing.length} MCP server${mcpSection.failing.length === 1 ? "" : "s"} failing`);
  if (restartSection && restartSection.tone === "warning") alerts.push(`last restart ${restartSection.outcome}`);
  if (scheduleSection?.failingJobs.length) alerts.push(`${scheduleSection.failingJobs.length} cron job${scheduleSection.failingJobs.length === 1 ? "" : "s"} failing`);
  if (scheduleSection && scheduleSection.systemEntries > 0 && scheduleSection.cronDaemon === "not_running") alerts.push("no cron daemon");

  return { processes: processSection, restart: restartSection, mcp: mcpSection, schedules: scheduleSection, disk: diskSection, alerts };
};

const Row = ({ label, children }) => html`
  <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
    <span class="w-24 shrink-0 text-xs uppercase tracking-wide text-fg-muted">${label}</span>
    <div class="flex-1 min-w-0 text-body">${children}</div>
  </div>
`;

const muted = (text) => html`<span class="text-fg-muted">${text}</span>`;

export const WatchdogBoxCard = ({
  box = {},
  errors = {},
  expanded = false,
  onSetExpanded = () => {},
  onRetry = () => {},
  nowMs = Date.now(),
}) => {
  const summary = buildBoxSummary(box, { nowMs });
  const firstError = Object.values(errors).find(Boolean) || null;
  const { processes, restart, mcp, schedules, disk } = summary;

  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="card-label">Box</h2>
        ${summary.alerts.map((alert) => html`<${Badge} tone="warning">${alert}</${Badge}>`)}
        <button
          type="button"
          class="ml-auto text-xs text-fg-muted hover:text-body"
          aria-expanded=${expanded ? "true" : "false"}
          onClick=${() => onSetExpanded(!expanded)}
        >
          ${expanded ? "Less" : "Schedules and disk"}
        </button>
      </div>
      ${firstError
        ? html`<${InlineErrorChip} error=${firstError} headline="Couldn't load part of the box status." onRetry=${onRetry} />`
        : null}
      <${Row} label="Processes">
        ${processes
          ? html`
              ${processes.owners.map((entry) => html`<span class="mr-3">${entry.label} ${entry.count} · ${formatBytes(entry.rssBytes)}</span>`)}
              ${processes.partial ? html`<${Badge} tone="neutral">partial scan</${Badge}>` : null}
            `
          : muted("Loading…")}
      </${Row}>
      <${Row} label="Last restart">
        ${restart
          ? restart.outcome
            ? html`
                <${Badge} tone=${restart.tone}>${restart.outcome}</${Badge}>
                <span class="ml-2">${restart.when}${restart.source ? ` · ${restart.source}` : ""}${restart.downtime ? ` · down ${restart.downtime}` : ""}</span>
                ${restart.reason ? html`<div class="text-xs text-fg-muted truncate">${restart.reason}</div>` : null}
              `
            : muted("No gateway restart recorded yet")
          : muted("Loading…")}
        ${restart?.lastExit ? html`<div class="text-xs text-fg-muted">Last unexpected exit ${restart.lastExit.when}${restart.lastExit.cause ? ` (${restart.lastExit.cause})` : ""}</div>` : null}
      </${Row}>
      <${Row} label="MCP">
        ${mcp
          ? mcp.total === 0
            ? muted("No MCP servers")
            : html`
                <span>${mcp.total} server${mcp.total === 1 ? "" : "s"}${mcp.disabled ? ` (${mcp.disabled} disabled)` : ""}</span>
                ${mcp.failing.map((server) => html`<div class="text-xs text-status-warning-muted truncate">${server.name}: ${server.message || "failed to start"}</div>`)}
              `
          : muted("Loading…")}
      </${Row}>
      ${expanded
        ? html`
            <${Row} label="Schedules">
              ${schedules
                ? html`
                    <span class="mr-3">OpenClaw ${schedules.openclawStatus === "ok" ? schedules.openclawJobs : "unavailable"}</span>
                    <span class="mr-3">AlphaClaw ${schedules.alphaclawTimers}</span>
                    <span class="mr-3">System cron ${schedules.systemEntries}</span>
                    ${schedules.next ? html`<div class="text-xs text-fg-muted truncate">Next: ${schedules.next.label} ${schedules.next.in}</div>` : null}
                    ${schedules.failingJobs.length ? html`<div class="text-xs text-status-warning-muted truncate">Failing: ${schedules.failingJobs.join(", ")}</div>` : null}
                  `
                : muted("Loading…")}
            </${Row}>
            <${Row} label="Disk">
              ${disk
                ? html`
                    ${disk.volume ? html`<div>${formatBytes(disk.volume.freeBytes)} free of ${formatBytes(disk.volume.sizeBytes)}${disk.partial ? " · sizes are estimates" : ""}</div>` : null}
                    ${disk.folders.length ? html`<div class="text-xs text-fg-muted">${disk.folders.map((folder) => `${folder.name} ${formatBytes(folder.bytes)}`).join(" · ")}</div>` : null}
                    ${disk.copies.map((group) => html`<div class="text-xs text-fg-muted">${group.title}: ${group.count} · ${formatBytes(group.bytes)}${group.due ? ` · ${group.due} due for cleanup` : ""}</div>`)}
                  `
                : muted("Loading…")}
            </${Row}>
          `
        : null}
    </div>
  `;
};
