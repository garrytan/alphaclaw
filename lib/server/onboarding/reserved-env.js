const { kDeploymentOnlyEnvKeys } = require("../deployment-only-env");

// Keys an imported repo's .env may never write into the live .env (fix wave
// F105): the deployment-controlled system vars (SETUP_PASSWORD, tokens, PORT,
// WATCHDOG_*) and the deployment-only knobs the agent must not self-grant. The
// wizard copy already tells the user "AlphaClaw controls deployment tokens and
// env vars"; this makes the server enforce it and report what was skipped.
const partitionReservedEnvVars = (envVars, systemVars) => {
  const reserved = new Set([
    ...(systemVars instanceof Set ? systemVars : []),
    ...kDeploymentOnlyEnvKeys,
  ]);
  const accepted = [];
  const skippedReservedKeys = [];
  for (const entry of Array.isArray(envVars) ? envVars : []) {
    const key = String(entry?.key || "").trim();
    if (!key) continue;
    if (reserved.has(key)) {
      skippedReservedKeys.push(key);
      continue;
    }
    accepted.push(entry);
  }
  return { accepted, skippedReservedKeys };
};

module.exports = { partitionReservedEnvVars };
