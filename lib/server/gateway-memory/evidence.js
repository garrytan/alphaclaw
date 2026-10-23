// Public/trusted-prompt boundary for diagnostic memory evidence. Never spread
// a gateway-reported record: its writer shares our UID. Only independently
// sampled RSS/cgroup values may drive the watchdog's enforcement policy.
const kCauses = Object.freeze({
  child_growth: "child-process RSS grew",
  child_accumulation: "child-process count and RSS grew",
  possible_heap_retention: "post-GC heap floors rose (possible retention)",
  external_growth: "reported external memory grew",
  unexplained_process_growth: "process RSS grew without corresponding reported heap/external growth",
  mixed: "multiple memory signals grew",
});
const kStatuses = new Set(["fresh", "partial", "stale", "unavailable", "disabled", "collecting"]);
const kAttributionStates = new Set(["unknown", "observing", "attributed", "transient"]);
const kReasons = new Set([
  "no_gateway", "no_worker", "unsupported", "proc_unavailable", "identity_unavailable",
  "identity_changed", "identity_mismatch", "root_missing", "worker_missing", "scan_limit",
  "partial_tree", "missing_rss", "unreadable", "missing", "not_started", "disabled",
  "invalid", "invalid_file", "invalid_schema", "invalid_identity", "invalid_sequence",
  "invalid_timestamp", "invalid_values", "oversized", "non_regular", "symlink",
  "stale", "duplicate", "not_ready", "not_collected", "in_flight", "permission_denied",
  "deadline", "member_limit", "topology_changed", "partial", "read_failed", "write_failed",
  "insufficient_samples", "insufficient_coverage", "insufficient_gc", "telemetry_unavailable",
  "telemetry_stale", "process_unavailable", "joint_coverage", "no_growth", "confirming",
  "missing_process", "partial_process", "stale_process", "missing_telemetry", "stale_telemetry",
  "sample_gap", "no_sustained_growth", "growth_confirming", "unattributed_growth",
  "worker_outside_tree", "scan_deadline", "incomplete_tree", "invalid_sample", "process_changed",
  "membership_changed", "sample_stale",
  "not_published",
  "worker_unavailable",
]);
const num = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const choice = (value, allowed) => allowed.has(value) ? value : null;
const iso = (value) => {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
};
const identity = (value) => value && count(value.pid) > 0 ? {
  pid: value.pid,
  startTicks: typeof value.startTicks === "string" && /^\d{1,24}$/.test(value.startTicks)
    ? value.startTicks : null,
} : null;
const availability = (value) => ({
  status: choice(value?.status, kStatuses) || "unavailable",
  reason: choice(value?.reason, kReasons),
  atMs: num(value?.atMs),
});

const projectProcess = (value) => {
  if (!value || typeof value !== "object") return null;
  const out = {
    ...availability(value), root: identity(value.root), worker: identity(value.worker),
    rootSource: choice(value.rootSource, new Set(["serving_root", "managed_root", "serving_pid", "unknown"])),
  };
  for (const key of ["groupRssBytes", "workerRssBytes", "childRssBytes", "launcherRssBytes"])
    out[key] = num(value[key]);
  for (const key of ["childCount", "launcherCount", "processCount"])
    out[key] = count(value[key]);
  const roles = new Set(["gateway", "gateway_child", "launcher", "launcher_child", "unknown"]);
  out.contributors = (Array.isArray(value.contributors) ? value.contributors : [])
    .slice(0, 128).filter((p) => count(p?.pid) > 0)
    .map((p) => ({ pid: p.pid, role: choice(p.role, roles) || "unknown", rssBytes: num(p.rssBytes) }))
    .sort((a, b) => (b.rssBytes || 0) - (a.rssBytes || 0)).slice(0, 8);
  out.pss = { ...availability(value.pss) };
  for (const key of ["rssBytes", "pssBytes", "privateBytes", "durationMs", "workerAtMs", "workerPssBytes", "workerPrivateBytes"])
    out.pss[key] = num(value.pss?.[key]);
  out.pss.workerStatus = choice(value.pss?.workerStatus, kStatuses) || "unavailable";
  for (const key of ["readCount", "processCount"])
    out.pss[key] = count(value.pss?.[key]);
  return out;
};

const projectTelemetry = (value) => {
  // Internal readers retain history for the attribution window. The API and
  // incident summaries carry only the latest values and their availability.
  const latest = Array.isArray(value?.records) ? value.records.at(-1) : value;
  const out = { ...availability(value), trust: "gateway_reported" };
  for (const key of ["rssBytes", "heapUsedBytes", "heapTotalBytes", "heapLimitBytes", "externalBytes", "arrayBuffersBytes"])
    out[key] = num(latest?.[key]);
  return out;
};

const projectAttribution = (value) => {
  const causes = new Set(Object.keys(kCauses));
  return {
    state: choice(value?.state, kAttributionStates) || "unknown",
    causes: [...new Set((Array.isArray(value?.causes) ? value.causes : []).filter((c) => causes.has(c)))],
    since: iso(value?.since),
    reason: choice(value?.reason, kReasons),
    coverage: {
      sampleCount: count(value?.coverage?.sampleCount),
      spanMs: num(value?.coverage?.spanMs),
      gcCount: count(value?.coverage?.gcCount),
    },
    childGrowthMb: num(value?.childGrowthMb),
    externalGrowthMb: num(value?.externalGrowthMb),
    heapGrowthMb: num(value?.heapGrowthMb),
    processGrowthMb: num(value?.processGrowthMb),
  };
};

const projectMemoryEvidence = (value) => value && typeof value === "object" ? {
  process: projectProcess(value.process),
  telemetry: projectTelemetry(value.telemetry),
  attribution: projectAttribution(value.attribution),
} : null;

const describeMemoryEvidence = (value) => {
  const attribution = projectAttribution(value?.attribution);
  if (attribution.state === "transient") return "The observed growth recovered; transient growth is indicated.";
  const labels = attribution.causes.filter((cause) => cause !== "mixed").map((cause) => kCauses[cause]);
  return labels.length ? `Observed growth: ${labels.join("; ")}.`
    : "Attribution is unknown; inspect process, heap, and child evidence before diagnosing a leak.";
};

// Where the memory budget came from (ALPH-22), plus the informational
// expected-size line when the worker is above configured heap + 192 MiB.
const describeMemoryBudget = ({ capSource, effectiveCapMb, capPhysicalMb, capFraction, pressureSource,
  expectedSizeMb, aboveExpectedSize } = {}) => {
  const budgetMb = num(effectiveCapMb);
  const share = num(capFraction) !== null ? `${Math.round(capFraction * 100)}%` : "a share";
  const expected = aboveExpectedSize === true && num(expectedSizeMb) !== null
    ? ` The worker is above its expected size (${expectedSizeMb} MB: configured heap plus 192 MiB); that is informational, not a leak verdict.`
    : "";
  if (pressureSource === "container" || capSource === "container")
    return `Pressure is against the measured container working set; process RSS is a separate measurement.${expected}`;
  if (capSource === "budget")
    return `The gateway memory budget is the operator's ${budgetMb ?? "?"} MB (watchdog.memory.budgetMb).${expected}`;
  if (capSource === "container_share")
    return `The gateway memory budget is ${budgetMb ?? "?"} MB: ${share} of the ${num(capPhysicalMb) ?? "?"} MB container memory limit.${expected}`;
  if (capSource === "host_share")
    return `The gateway memory budget is ${budgetMb ?? "?"} MB: ${share} of the host's ${num(capPhysicalMb) ?? "?"} MB (no container memory limit).${expected}`;
  if (capSource === "derived_group_budget" || capSource === "heap")
    return `The derived group RSS budget is ${budgetMb ?? "?"} MB (configured heap plus 192 MiB); crossing it does not establish V8 heap exhaustion.`;
  return `No gateway memory budget is available.${expected}`;
};

// What the leak verdict measured (ALPH-17): the verified gateway worker, or
// the whole process group when the worker is not identified.
const describeRssBasis = (rssBasis) => rssBasis === "worker"
  ? { label: "Gateway worker RSS", budget: "gateway memory budget" }
  : { label: "Group RSS (gateway plus its tool children)", budget: "group budget" };

const kMbBytes = 1024 * 1024;
const mb = (bytes) => Math.round(bytes / kMbBytes);
// "Gateway worker 3837 MB; tool children 2754 MB across 1 process (largest:
// pid 4242, 2754 MB)." Pids and sizes only: no argv or process names leave
// the process collector. Empty when the split was not measured.
const describeMemorySplit = (value) => {
  const process = projectProcess(value?.process);
  if (!process || process.workerRssBytes === null) return "";
  const parts = [`Gateway worker ${mb(process.workerRssBytes)} MB`];
  if (process.childCount && process.childRssBytes !== null) {
    const largest = process.contributors.find((entry) => entry.role === "gateway_child" && entry.rssBytes !== null);
    parts.push(`tool children ${mb(process.childRssBytes)} MB across ${process.childCount} process${process.childCount === 1 ? "" : "es"}` +
      (largest ? ` (largest: pid ${largest.pid}, ${mb(largest.rssBytes)} MB)` : ""));
  }
  return `${parts.join("; ")}.`;
};

module.exports = { projectMemoryEvidence, projectTelemetry, projectAttribution, describeMemoryEvidence, describeMemoryBudget,
  describeRssBasis, describeMemorySplit };
