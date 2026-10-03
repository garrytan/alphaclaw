// A secret-free environment for running untrusted package code (the Buzz
// plugin install): the base locale/terminal keys plus OpenClaw and tooling
// paths, never provider credentials or tokens, and never routed through the
// workspace git-auth shim or a planted ~/.gitconfig / ~/.npmrc.
const kBaseEnvKeys = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "NO_COLOR",
  // Supervisor contract: package code must know an external supervisor owns
  // installs and service mutation. Not secrets.
  "OPENCLAW_SUPERVISOR_MODE",
  "OPENCLAW_SERVICE_REPAIR_POLICY",
];
const kAllowedPrefixes = ["OPENCLAW_", "XDG_", "COREPACK_", "npm_config_"];
const kSecretShapedKeyPattern = /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE)/i;
const kDevNullPath = process.platform === "win32" ? "NUL" : "/dev/null";

const buildSecretFreeEnv = (source) => {
  const env = {};
  for (const key of kBaseEnvKeys) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  for (const [key, value] of Object.entries(source)) {
    if (!kAllowedPrefixes.some((prefix) => key.startsWith(prefix))) continue;
    // The prefix allowlist still admits OPENCLAW_GATEWAY_TOKEN and channel
    // credentials — package code must not inherit those.
    if (kSecretShapedKeyPattern.test(key)) continue;
    env[key] = value;
  }
  delete env.GIT_ASKPASS;
  env.GIT_CONFIG_GLOBAL = kDevNullPath;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.npm_config_userconfig = kDevNullPath;
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
};

module.exports = { buildSecretFreeEnv };
