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
  for (const key of ["rssBytes", "pssBytes", "privateBytes", "durationMs"])
    out.pss[key] = num(value.pss?.[key]);
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

const describeMemoryBudget = ({ capSource, effectiveCapMb, pressureSource } = {}) => {
  const budgetMb = num(effectiveCapMb);
  if (pressureSource === "container" || capSource === "container")
    return "Pressure is against measured container usage; process RSS is a separate measurement.";
  if (capSource === "budget")
    return `Pressure is against the operator memory budget (${budgetMb ?? "?"} MB, watchdog.memory.budgetMb). This is a group RSS policy budget.`;
  if (capSource === "derived_group_budget" || capSource === "heap")
    return `The derived group RSS budget is ${budgetMb ?? "?"} MB (configured heap plus 192 MiB); crossing it does not establish V8 heap exhaustion.`;
  return "No group RSS budget is available.";
};

module.exports = { projectMemoryEvidence, projectTelemetry, projectAttribution, describeMemoryEvidence, describeMemoryBudget };
