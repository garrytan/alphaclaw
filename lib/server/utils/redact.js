// Evidence shown in the UI (stderr tails, error summaries) may echo secrets
// the gateway printed. Mask every known secret value before storage/display.
const kMinSecretLength = 6;

const collectSecretValues = ({ env = process.env, envFileVars = [] } = {}) => {
  const values = new Set();
  const consider = (value) => {
    const text = String(value ?? "").trim();
    if (text.length >= kMinSecretLength) values.add(text);
  };
  for (const value of Object.values(env || {})) consider(value);
  for (const entry of envFileVars || []) consider(entry?.value);
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
