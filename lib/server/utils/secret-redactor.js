// Value-based secret redaction for text AlphaClaw persists or forwards from
// untrusted sources (doctor cards, upstream CLI output): only values whose KEY
// looks secret-shaped are scrubbed, and the redactor tolerates a secret split
// across stream chunks.

const kSecretShapedKeyPattern = /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE|CREDENTIAL)/i;
const kRedactedMarker = "[redacted]";
// Values shorter than this are too likely to collide with ordinary output
// (ports, "true", version numbers) to be safely scrubbed.
const kMinSecretLength = 6;

// Only values whose KEY looks secret-shaped are scrubbed. Passing a whole env
// as extraEnv applies that same key filter — critical because gatewayEnv holds
// benign entries (HOME, PATH, NODE_ENV, npm_config_cache) whose values pepper
// npm output; redacting those would riddle the log with [redacted] and feed
// the overseer mangled evidence. extraValues stays for genuinely known secrets.
const collectSecretValues = ({
  env = process.env,
  extraEnv = null,
  extraValues = [],
} = {}) => {
  const values = new Set();
  const scanEnv = (source) => {
    for (const [key, value] of Object.entries(source || {})) {
      if (!kSecretShapedKeyPattern.test(key)) continue;
      const trimmed = String(value || "").trim();
      if (trimmed.length >= kMinSecretLength) values.add(trimmed);
    }
  };
  scanEnv(env);
  if (extraEnv) scanEnv(extraEnv);
  for (const value of extraValues) {
    const trimmed = String(value || "").trim();
    if (trimmed.length >= kMinSecretLength) values.add(trimmed);
  }
  return Array.from(values);
};

// Line-buffered redactor: complete lines are scrubbed and flushed; the
// trailing partial line is held so a secret split across two stream chunks
// still matches. The carry is capped so a pathological no-newline stream
// cannot grow memory without bound (the cap flush is the documented residual
// risk: a secret split exactly at a 64KB no-newline boundary).
const kMaxCarryBytes = 64 * 1024;

const createRedactor = (secretValues = []) => {
  const secrets = [...secretValues].sort((a, b) => b.length - a.length);
  let carry = "";
  const scrub = (text) => {
    let out = text;
    for (const secret of secrets) {
      if (out.includes(secret)) out = out.split(secret).join(kRedactedMarker);
    }
    return out;
  };
  const push = (chunk) => {
    carry += String(chunk);
    const lastNewline = carry.lastIndexOf("\n");
    let complete = "";
    if (lastNewline >= 0) {
      complete = carry.slice(0, lastNewline + 1);
      carry = carry.slice(lastNewline + 1);
    }
    if (carry.length > kMaxCarryBytes) {
      complete += carry;
      carry = "";
    }
    return complete ? scrub(complete) : "";
  };
  const flush = () => {
    const rest = carry;
    carry = "";
    return rest ? scrub(rest) : "";
  };
  return { push, flush, scrub };
};

module.exports = { collectSecretValues, createRedactor };
