// Evidence shown in the UI (stderr tails, error summaries) may echo secrets
// the gateway printed. Mask every known secret value before storage/display.
const kMinSecretLength = 6;

// Config keys whose string values are treated as secrets when written inline
// in openclaw.json instead of as ${ENV} references.
const kSecretConfigKeyPattern =
  /token|secret|password|passwd|credential|api[-_]?key|private[-_]?key|auth/i;

const collectConfigSecretValues = (config, values, depth = 0) => {
  if (!config || typeof config !== "object" || depth > 8) return;
  const considerSecretString = (value) => {
    const text = String(value ?? "").trim();
    // ${ENV} references resolve through env collection already; the raw
    // reference text itself is not a secret.
    if (!text || text.startsWith("${")) return;
    if (text.length >= kMinSecretLength) values.add(text);
  };
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string") {
      if (!kSecretConfigKeyPattern.test(key)) continue;
      considerSecretString(value);
    } else if (Array.isArray(value) && kSecretConfigKeyPattern.test(key)) {
      // e.g. { tokens: ["...", "..."] } — every string member is a secret.
      for (const member of value) {
        if (typeof member === "string") considerSecretString(member);
        else if (member && typeof member === "object") {
          collectConfigSecretValues(member, values, depth + 1);
        }
      }
    } else if (value && typeof value === "object") {
      collectConfigSecretValues(value, values, depth + 1);
    }
  }
};

const collectSecretValues = ({
  env = process.env,
  envFileVars = [],
  configObjects = [],
} = {}) => {
  const values = new Set();
  const consider = (value) => {
    const text = String(value ?? "").trim();
    if (text.length >= kMinSecretLength) values.add(text);
  };
  // process.env is full of benign values that appear in stderr constantly
  // (HOME, PATH, PWD, LANG...). Masking those would riddle the evidence with
  // *** and destroy its diagnostic value, so only secret-NAMED env keys are
  // collected. Env-FILE vars are user-declared secrets — collected as-is.
  for (const [key, value] of Object.entries(env || {})) {
    if (kSecretConfigKeyPattern.test(key)) consider(value);
  }
  for (const entry of envFileVars || []) consider(entry?.value);
  for (const config of configObjects || []) {
    collectConfigSecretValues(config, values);
  }
  return values;
};

const redactSecrets = (text, { secrets } = {}) => {
  let result = String(text ?? "");
  if (!result || !secrets) return result;
  // Longest first: when one collected value is a prefix/substring of another,
  // masking the shorter one first would split the longer secret and leak its
  // remainder around the "***".
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (result.includes(secret)) {
      result = result.split(secret).join("***");
    }
  }
  return result;
};

// Shape-based fallback for token-bearing URL params: values sourced outside
// the collected secret set (a URL another process printed, an upstream
// bootstrap handoff) are still masked by their param shape. Covers the
// shared-token (#token=) and one-time handoff (#bootstrapToken=) forms.
const scrubTokenParams = (text) =>
  String(text ?? "").replace(
    // Boundary includes start-of-line and whitespace so a bare `token=...`
    // outside a URL is still masked.
    /((?:^|[#?&\s])(?:bootstrapToken|token)=)[^\s&#]+/gim,
    "$1***",
  );

module.exports = { collectSecretValues, redactSecrets, scrubTokenParams };
