const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Identifies only our generated option, including an older package path after
// an upgrade. Other --import/--require options belong to the operator.
const kOwnOptionPattern = /(^|\s)--import=data:text\/javascript,%2F%2Falphaclaw-memory-v1%0A\S+/g;
const stripTelemetryNodeOptions = (options = "") =>
  String(options).replace(kOwnOptionPattern, "").trim();

const buildTelemetryBootstrapOption = ({
  preloadPath = path.join(__dirname, "telemetry-preload.js"),
  workerPoolCapPath = path.join(__dirname, "worker-pool-cap.js"),
} = {}) => {
  const moduleUrl = pathToFileURL(preloadPath).href;
  const workerPoolCapUrl = pathToFileURL(workerPoolCapPath).href;
  // The guard lives in the data URL: a removed or half-replaced package must
  // not make Node fail before a file-based preload's try/catch can execute.
  const code = String.raw`//alphaclaw-memory-v1
const strip=()=>{const value=String(process.env.NODE_OPTIONS||"").replace(${kOwnOptionPattern},"").trim();if(value)process.env.NODE_OPTIONS=value;else delete process.env.NODE_OPTIONS;const arena=process.env.ALPHACLAW_GATEWAY_MALLOC_ARENA_MAX;if(arena!==undefined){if(process.env.MALLOC_ARENA_MAX===arena)delete process.env.MALLOC_ARENA_MAX;delete process.env.ALPHACLAW_GATEWAY_MALLOC_ARENA_MAX;}};
try{const {isMainThread}=await import("node:worker_threads");const a=process.argv;const entry=String(a[1]||"").split(String.fromCharCode(92)).join("/").split("/").at(-1);const eligible=isMainThread&&/^(?:openclaw(?:\.m?js)?|entry\.m?js)$/.test(entry)&&a[2]==="gateway"&&(a[3]==="run"||a[3]==="--force")&&!a.includes("--help")&&!a.includes("-h");if(!eligible){strip();}else{try{const cap=await import(${JSON.stringify(workerPoolCapUrl)});cap.default.capLegacyWorkerPoolSizing();}catch{}const module=await import(${JSON.stringify(moduleUrl)});module.default.startGatewayTelemetryPreload({stripOwnOptions:strip});}}catch{strip();}`;
  return `--import=data:text/javascript,${encodeURIComponent(code)}`;
};

const withGatewayTelemetryEnv = (env) => {
  const next = { ...env };
  const original = stripTelemetryNodeOptions(next.NODE_OPTIONS || "");
  const disabled = String(env.ALPHACLAW_GATEWAY_MEMORY_TELEMETRY || "")
    .trim().toLowerCase() === "off";
  const options = disabled
    ? original
    : [original, buildTelemetryBootstrapOption()].filter(Boolean).join(" ");
  if (options) next.NODE_OPTIONS = options;
  else delete next.NODE_OPTIONS;
  return next;
};

// OpenClaw before 2026.10.10 runs ~40 allocating threads on a many-CPU host,
// and glibc gives each its own malloc arena (up to 8 per CPU) that keeps what
// it freed: large-session reads left gigabytes of resident arena memory with a
// flat JS heap. Two arenas held RSS flat under the same load. The gateway
// reads the cap at its own start; the bootstrap removes it (by the marker)
// once the gateway runs, so its tool children keep glibc's default. Without
// the bootstrap nothing would remove it, so telemetry off means no cap. An
// operator's MALLOC_ARENA_MAX goes to the gateway as set, on any version.
const kArenaCapMarker = "ALPHACLAW_GATEWAY_MALLOC_ARENA_MAX";
const kLegacyMallocArenaMax = "2";

const readInstalledOpenclawVersion = () => {
  try {
    const { readOpenclawVersion } = require("./worker-pool-cap");
    return readOpenclawVersion(require.resolve("openclaw"));
  } catch {
    return null;
  }
};

const withGatewayMallocArenaCap = (env, {
  operatorEnv = process.env,
  version = readInstalledOpenclawVersion(),
} = {}) => {
  const next = { ...env };
  delete next[kArenaCapMarker];
  const operatorValue = String(operatorEnv.MALLOC_ARENA_MAX || "").trim();
  if (operatorValue) return { ...next, MALLOC_ARENA_MAX: operatorValue };
  const { sizesWorkerPoolsFromCpuCount } = require("./worker-pool-cap");
  const bootstrapped = stripTelemetryNodeOptions(next.NODE_OPTIONS || "") !== String(next.NODE_OPTIONS || "").trim();
  if (!bootstrapped || !sizesWorkerPoolsFromCpuCount(version)) return next;
  return { ...next, MALLOC_ARENA_MAX: kLegacyMallocArenaMax, [kArenaCapMarker]: kLegacyMallocArenaMax };
};

module.exports = {
  buildTelemetryBootstrapOption,
  withGatewayMallocArenaCap,
  stripTelemetryNodeOptions,
  withGatewayTelemetryEnv,
};
