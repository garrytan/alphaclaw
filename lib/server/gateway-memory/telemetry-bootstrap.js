const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Identifies only our generated option, including an older package path after
// an upgrade. Other --import/--require options belong to the operator.
const kOwnOptionPattern = /(^|\s)--import=data:text\/javascript,%2F%2Falphaclaw-memory-v1%0A\S+/g;
const stripTelemetryNodeOptions = (options = "") =>
  String(options).replace(kOwnOptionPattern, "").trim();

const buildTelemetryBootstrapOption = ({
  preloadPath = path.join(__dirname, "telemetry-preload.js"),
} = {}) => {
  const moduleUrl = pathToFileURL(preloadPath).href;
  // The guard lives in the data URL: a removed or half-replaced package must
  // not make Node fail before a file-based preload's try/catch can execute.
  const code = String.raw`//alphaclaw-memory-v1
const strip=()=>{const value=String(process.env.NODE_OPTIONS||"").replace(${kOwnOptionPattern},"").trim();if(value)process.env.NODE_OPTIONS=value;else delete process.env.NODE_OPTIONS;};
try{const {isMainThread}=await import("node:worker_threads");const a=process.argv;const entry=String(a[1]||"").split(String.fromCharCode(92)).join("/").split("/").at(-1);const eligible=isMainThread&&/^(?:openclaw(?:\.m?js)?|entry\.m?js)$/.test(entry)&&a[2]==="gateway"&&(a[3]==="run"||a[3]==="--force")&&!a.includes("--help")&&!a.includes("-h");if(!eligible){strip();}else{const module=await import(${JSON.stringify(moduleUrl)});module.default.startGatewayTelemetryPreload({stripOwnOptions:strip});}}catch{strip();}`;
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

module.exports = {
  buildTelemetryBootstrapOption,
  stripTelemetryNodeOptions,
  withGatewayTelemetryEnv,
};
