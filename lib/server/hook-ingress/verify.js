// Pure helpers for the /hooks edge decision (GST-2134). No I/O: the caller
// supplies the gateway's headers, the configured hooks.token and the
// environment the gateway was launched with, so every rule here is testable
// against the pinned OpenClaw's own behavior.
const crypto = require("crypto");
const { timingSafeStringEqual } = require("../utils/timing-safe");

const kBuiltinOwnTokenWindowMs = 24 * 60 * 60 * 1000;
const kBuiltinTurnOnWindowMs = 7 * 24 * 60 * 60 * 1000;
// Headers a provider signs with; a POST carrying none of these and no token
// is refused before its body is read.
const kSignatureHeaderNames = Object.freeze([
  "webhook-signature",
  "x-signature",
  "verkada-signature",
  "openphone-signature",
]);
const kEnvVarNamePattern = /^[A-Z_][A-Z0-9_]*$/;
const kDefaultValueOperator = ":-";

const normalizeOptionalString = (value) => {
  if (typeof value !== "string") return "";
  return value.trim();
};

// Port of OpenClaw's extractHookToken (dist hooks-*.mjs): Bearer first, then
// x-openclaw-token. Reads the exact header object AlphaClaw forwards.
const extractHookToken = (headers = {}) => {
  const auth = normalizeOptionalString(headers.authorization);
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  return normalizeOptionalString(headers["x-openclaw-token"]);
};

// Resolves hooks.token the way the gateway's env substitution does
// (env-substitution-*.mjs): "${NAME}" and "${NAME:-default}" are read from
// the launch environment, "$${NAME}" is an escaped literal. A reference the
// launch environment does not hold is "unresolved": the gateway may still
// have it from its own .env load, so the edge leaves that call to the gateway.
const resolveHookCredential = ({ hooks, launchEnv }) => {
  if (!hooks || typeof hooks !== "object") return { ok: false, reason: "hooks_missing" };
  if (hooks.enabled !== true) return { ok: false, reason: "hooks_disabled" };
  const raw = hooks.token;
  if (typeof raw !== "string") return { ok: false, reason: raw == null ? "token_missing" : "token_not_string" };
  if (!raw.includes("$")) {
    const literal = raw.trim();
    return literal ? { ok: true, value: literal, source: "literal" } : { ok: false, reason: "token_missing" };
  }
  if (!launchEnv || typeof launchEnv !== "object") return { ok: false, reason: "no_launch_env" };
  const chunks = [];
  let end = 0;
  let referenced = false;
  for (let index = raw.indexOf("$"); index !== -1; index = raw.indexOf("$", index + 1)) {
    const escaped = raw[index + 1] === "$" && raw[index + 2] === "{";
    if (!escaped && raw[index + 1] !== "{") continue;
    const start = index + (escaped ? 3 : 2);
    const close = raw.indexOf("}", start);
    if (close === -1) continue;
    const body = raw.slice(start, close);
    const operatorIndex = body.indexOf(kDefaultValueOperator);
    const name = operatorIndex === -1 ? body : body.slice(0, operatorIndex);
    const defaultValue = operatorIndex === -1 ? undefined : body.slice(operatorIndex + 2);
    if (!kEnvVarNamePattern.test(name) || defaultValue?.includes("$") || defaultValue?.includes("{")) continue;
    chunks.push(raw.slice(end, index));
    end = close + 1;
    if (escaped) {
      chunks.push(defaultValue === undefined ? "${" + name + "}" : "${" + name + kDefaultValueOperator + defaultValue + "}");
      index = close;
      continue;
    }
    referenced = true;
    const envValue = Object.prototype.hasOwnProperty.call(launchEnv, name) ? launchEnv[name] : undefined;
    if (envValue === undefined || envValue === "") {
      if (defaultValue === undefined) return { ok: false, reason: "reference_unresolved", name };
      chunks.push(defaultValue);
    } else {
      chunks.push(String(envValue));
    }
    index = close;
  }
  chunks.push(raw.slice(end));
  const value = chunks.join("").trim();
  if (!value) return { ok: false, reason: "token_missing" };
  return { ok: true, value, source: referenced ? "reference" : "literal" };
};

const credentialMatches = (presented, expected) => timingSafeStringEqual(presented, expected);

const hashHookToken = (token) => crypto.createHash("sha256").update(String(token), "utf8").digest("hex");

const ownTokenMatches = (presented, storedSha256) =>
  typeof storedSha256 === "string" && !!storedSha256 && !!presented &&
  timingSafeStringEqual(hashHookToken(presented), storedSha256);

const toMs = (iso) => {
  const ms = Date.parse(String(iso || ""));
  return Number.isFinite(ms) ? ms : null;
};

// D3: an enabled built-in accepts the shared token until the earlier of
// 24 h after its first gateway-admitted own-token delivery and 7 days after
// it was turned on. A missing turn-on time is a closed window (fail closed).
const builtinSharedWindow = (entry, nowMs) => {
  const turnedOnAtMs = toMs(entry?.turnedOnAt);
  if (entry?.enabled !== true || turnedOnAtMs == null) {
    return { open: false, closesAtMs: null };
  }
  const firstOwnTokenAtMs = toMs(entry?.firstOwnTokenAt);
  const closesAtMs = Math.min(
    turnedOnAtMs + kBuiltinTurnOnWindowMs,
    firstOwnTokenAtMs == null ? Infinity : firstOwnTokenAtMs + kBuiltinOwnTokenWindowMs,
  );
  return { open: nowMs < closesAtMs, closesAtMs };
};

const hasCredentialHint = ({ headers = {}, url = "" }) => {
  if (normalizeOptionalString(headers.authorization)) return true;
  if (normalizeOptionalString(headers["x-openclaw-token"])) return true;
  if (kSignatureHeaderNames.some((name) => normalizeOptionalString(headers[name]))) return true;
  const raw = String(url || "");
  const queryIndex = raw.indexOf("?");
  if (queryIndex === -1) return false;
  return new URLSearchParams(raw.slice(queryIndex + 1)).has("token");
};

module.exports = {
  kBuiltinOwnTokenWindowMs,
  kBuiltinTurnOnWindowMs,
  kSignatureHeaderNames,
  builtinSharedWindow,
  credentialMatches,
  extractHookToken,
  hashHookToken,
  hasCredentialHint,
  ownTokenMatches,
  resolveHookCredential,
};
