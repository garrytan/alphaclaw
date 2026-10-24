import { h } from "preact";
import htm from "htm";
import { Badge } from "../../badge.js";
import { InfoTooltip } from "../../info-tooltip.js";
import { formatBytes } from "../helpers.js";
import { formatRelativeTime } from "../../../lib/format.js";

const html = htm.bind(h);
const kCauseLabels = {
  child_growth: "Child-process RSS grew",
  child_accumulation: "Child-process count and RSS grew",
  possible_heap_retention: "Post-GC heap floors rose: possible retention",
  external_growth: "Reported external memory grew",
  unexplained_process_growth: "Process RSS growth is unexplained by reported heap/external measurements",
};
const sampledMs = (value) => typeof value === "number" ? value : Date.parse(value || "");
const isStale = (status, at, nowMs = Date.now(), maxAgeMs = 90_000) =>
  (status && status !== "fresh") || (Number.isFinite(sampledMs(at)) && nowMs - sampledMs(at) > maxAgeMs);
const displayStatus = (evidence, maxAgeMs) => evidence?.status === "fresh" &&
  isStale(evidence.status, evidence.atMs, Date.now(), maxAgeMs)
  ? "stale" : evidence?.status || "unavailable";
const age = (at) => Number.isFinite(sampledMs(at))
  ? formatRelativeTime(new Date(sampledMs(at)).toISOString()) : "collection time unavailable";

// Where the memory budget came from (ALPH-22).
export const describeBudgetSource = (trend = null) => {
  const share = Number.isFinite(trend?.capFraction) ? `${Math.round(trend.capFraction * 100)}%` : "a share";
  switch (trend?.capSource) {
    case "budget": return "operator setting (watchdog.memory.budgetMb)";
    case "container_share": return `${share} of the ${trend.capPhysicalMb ?? "?"} MB container memory limit`;
    case "host_share": return `${share} of the host's ${trend.capPhysicalMb ?? "?"} MB (no container memory limit)`;
    case "derived_group_budget":
    case "heap": return "derived from configured heap + 192 MiB";
    default: return null;
  }
};

export const buildMemoryTrendModel = (trend = null, { nowMs = Date.now() } = {}) => {
  if (!trend || typeof trend !== "object") return null;
  const worker = trend.rssBasis === "worker";
  const budget = worker ? "gateway memory budget" : "group budget";
  const measured = worker && trend.memoryMeasure === "private" && trend.memoryMb != null
    ? `${trend.memoryMb} MB gateway worker private memory`
    : trend.rssMb != null ? `${trend.rssMb} MB ${worker ? "gateway worker" : "group"} RSS` : null;
  const stats = [
    measured ? `${measured}${trend.effectiveCapMb != null ? ` of ${trend.effectiveCapMb} MB ${budget}` : ""}` : null,
    trend.slopeMbPerHour > 0 ? `+${trend.slopeMbPerHour} MB/h` : null,
  ];
  const projected = trend.projectedBudgetCrossingAt ?? trend.projectedExhaustionAt;
  if (Date.parse(projected || "") > nowMs) {
    const eta = formatRelativeTime(projected, { nowMs, style: "unit", allowFuture: true, fallback: "" });
    if (eta) stats.push(`projected to cross its ${budget} in ~${eta}`);
  }
  const stale = isStale(trend.sampleStatus, trend.sampledAt, nowMs);
  if (stale) stats.push("Current measurement unavailable; last known evidence shown");
  const detail = stats.filter(Boolean).join(" · ");
  switch (trend.state) {
    case "disabled": return { tone: "neutral", label: "Detection off", detail: "Enable memory growth detection in Settings.", alwaysVisible: false };
    case "warming_up":
    case "insufficient_samples": return { tone: "neutral", label: "Collecting", detail: `Collecting samples… (${trend.sampleCount ?? 0}/${trend.requiredSamples ?? 24})`, alwaysVisible: false };
    case "normal": return { tone: stale ? "neutral" : "success", label: stale ? "Evidence unavailable" : "Stable", detail, alwaysVisible: false };
    case "watch": return { tone: "warning", label: "Rising", detail: `${detail} · unconfirmed — watching`, alwaysVisible: false };
    case "leak_suspected": return { tone: "warning", label: "Sustained growth", detail: ["Memory rising steadily", detail].filter(Boolean).join(" · "), alwaysVisible: true };
    case "critical": return { tone: "danger", label: "Critical", detail: `${worker ? "Gateway worker" : "Group"} growth under memory pressure · ${detail}`, alwaysVisible: true };
    default: return null;
  }
};

export const MemoryTrendRow = ({ trend }) => {
  const model = buildMemoryTrendModel(trend);
  return model ? html`<div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
    <span class="inline-flex items-center gap-1 text-fg-muted">${trend?.rssBasis === "worker" ? "Gateway worker trend" : "Gateway group trend"}
      <${InfoTooltip} text=${trend?.rssBasis === "worker"
        ? "Measured on the gateway worker alone: tool processes it starts are listed separately and cannot trigger a gateway restart. A rising RSS floor establishes growth; critical also needs the worker near its budget or the V8 heap near its limit, plus a heap signal. The budget is a share of the memory the gateway can use, or the operator's setting; the V8 heap has its own limit."
        : "Group RSS includes the gateway, its descendants, and any managed launcher branches, because the gateway worker could not be identified; the watchdog alerts but does not restart on it. A rising RSS floor establishes growth; heap, child, and external measurements help explain it. A group budget is a policy threshold, not a V8 heap limit."} />
    </span><${Badge} tone=${model.tone}>${model.label}</${Badge}>
    <span class="text-fg-muted">${model.detail}</span>
  </div>` : null;
};

export const ContainerMemoryRow = ({ container }) => {
  if (container?.state !== "critical") return null;
  return html`<div class="mt-2 flex flex-wrap items-center gap-2 text-xs" role="status">
    <${Badge} tone="danger">Container memory critical</${Badge}>
    <span class="text-fg-muted">${formatBytes(container.usedBytes)} / ${formatBytes(container.limitBytes)}
      ${isStale(container.sampleStatus, container.sampledAt) ? " · Last known pressure; fresh evidence unavailable" : " · Container memory in use (excludes reclaimable page cache)"}
    </span>
  </div>`;
};

export const MemoryDetails = ({ memory, trend }) => {
  const process = memory?.process;
  const telemetry = memory?.telemetry;
  const attribution = memory?.attribution;
  const labels = (attribution?.causes || []).map((cause) => kCauseLabels[cause]).filter(Boolean);
  const heapStatus = displayStatus(telemetry);
  const heapReady = heapStatus === "fresh";
  const heapMessage = heapReady ? `Gateway-reported · ${age(telemetry.atMs)}`
    : telemetry?.reason === "disabled" ? "Heap telemetry disabled"
    : telemetry?.reason === "unsupported" ? "Heap telemetry unavailable on this platform"
    : telemetry?.atMs ? `Heap telemetry ${heapStatus} · last collected ${age(telemetry.atMs)}`
    : ["invalid_sample", "invalid_file", "read_failed"].includes(telemetry?.reason) ? "Heap telemetry unavailable: could not read a valid sample"
    : "Heap telemetry unavailable until next gateway launch";
  const rows = [
    ["Gateway worker RSS", process?.workerRssBytes],
    [`Worker descendants (${process?.childCount ?? "?"}) RSS`, process?.childRssBytes],
    [`Launcher / sibling processes (${process?.launcherCount ?? "?"}) RSS`, process?.launcherRssBytes],
    ["Whole-group RSS", process?.groupRssBytes],
  ];
  const pss = process?.pss;
  return html`<div class="mt-3 space-y-3 text-xs text-fg-muted">
    <div><div class="font-medium text-fg mb-1">How much memory?</div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
        ${rows.map(([label, bytes]) => html`<div class="flex flex-wrap justify-between gap-x-3"><span>${label}</span><span>${formatBytes(bytes)}</span></div>`)}
      </div>
      <p class="mt-1">Process RSS counts shared pages in each process. These values do not divide up the container bar.</p>
      <p class="mt-1">Process evidence: ${displayStatus(process)} · ${age(process?.atMs)}
        ${process?.root?.pid ? ` · root PID ${process.root.pid}` : ""}${process?.worker?.pid ? ` · worker PID ${process.worker.pid}` : ""}</p>
      <p class="mt-1">Group PSS: ${formatBytes(pss?.pssBytes)} · private: ${formatBytes(pss?.privateBytes)}
        · ${displayStatus(pss, 6 * 60_000)} (${pss?.readCount ?? 0}/${pss?.processCount ?? "?"} processes) · ${age(pss?.atMs)}</p>
      <p class="mt-1">${heapMessage}</p>
      ${telemetry?.heapUsedBytes != null ? html`<p class="mt-1">Main-thread heap: ${formatBytes(telemetry.heapUsedBytes)} / ${formatBytes(telemetry.heapLimitBytes)} actual V8 limit
        · external: ${formatBytes(telemetry.externalBytes)} · ArrayBuffers: ${formatBytes(telemetry.arrayBuffersBytes)} (included in external)</p>` : null}
    </div>
    <div><div class="font-medium text-fg mb-1">What grew?</div>
      <p>${attribution?.state === "transient" ? "The observed growth recovered; transient growth is indicated."
        : labels.length ? labels.join(" · ") : "Attribution unknown — collecting process and heap evidence."}</p>
      <p class="mt-1">${attribution?.coverage?.sampleCount ?? 0} covered samples · ${attribution?.coverage?.gcCount ?? 0} major-GC observations. Session ownership and activity are unknown.</p>
    </div>
    <div><div class="font-medium text-fg mb-1">Which budget?</div>
      <p>${trend?.effectiveCapMb != null ? `${trend.effectiveCapMb} MB gateway memory budget · ${describeBudgetSource(trend) ?? "source unknown"}` : "No gateway memory budget available."}</p>
      ${telemetry?.heapLimitBytes != null ? html`<p class="mt-1">V8 heap limit ${formatBytes(telemetry.heapLimitBytes)}: the cap for the heap signal (critical needs heap used at 70% of it, or rising post-GC floors, while telemetry is fresh).</p>` : null}
      ${trend?.expectedSizeMb != null ? html`<p class="mt-1">Expected worker size ${trend.expectedSizeMb} MB (configured heap + 192 MiB)${trend.aboveExpectedSize ? " · the worker is above it" : ""} · informational, never a leak verdict.</p>` : null}
      <p class="mt-1">Heap measurements are gateway-reported diagnostics. Container usage and process RSS are sampled independently for pressure protection.</p>
    </div>
  </div>`;
};
