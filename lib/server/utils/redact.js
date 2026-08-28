// Evidence shown in the UI (stderr tails, error summaries) may echo secrets
// the gateway printed. Mask every known secret value before storage/display.
const kMinSecretLength = 6;

// Config keys whose string values are treated as secrets when written inline
// in openclaw.json instead of as ${ENV} references.
const kSecretConfigKeyPattern =
  /token|secret|password|passwd|credential|api[-_]?key|private[-_]?key|auth/i;

const collectConfigSecretValues = (config, values, depth = 0) => {
  if (!config || typeof config !== "object" || depth > 8) return;
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string") {
      if (!kSecretConfigKeyPattern.test(key)) continue;
      const text = value.trim();
      // ${ENV} references resolve through env collection already; the raw
      // reference text itself is not a secret.
      if (!text || text.startsWith("${")) continue;
      if (text.length >= kMinSecretLength) values.add(text);
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
  for (const value of Object.values(env || {})) consider(value);
  for (const entry of envFileVars || []) consider(entry?.value);
  for (const config of configObjects || []) {
    collectConfigSecretValues(config, values);
  }
  return values;
};

const redactSecrets = (text, { secrets } = {}) => {
  let result = String(text ?? "");
  if (!result || !secrets) return result;
  for (const secret of secrets) {
    if (result.includes(secret)) {
      result = result.split(secret).join("***");
    }
  }
  return result;
};

module.exports = { collectSecretValues, redactSecrets };
