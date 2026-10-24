// Guard (g): no log line carries an env value. reloadEnv printed
// `Env updated: KEY=value` and masked the value only when the key looked like
// a token, so FOO_DATABASE_URL=postgres://user:password@… was written to the
// log on every .env change. The env-change line now names keys only, and the
// scanner flags any console/logger call whose evaluated arguments read an env
// value (process.env.X, env.X / env[k], envMap.get(k), the .env arrays, a
// KEY=${value} pair, a whole-env dump) unless a redactor from
// lib/server/utils/redact.js wraps it. The log sink (log-writer) also masks
// credential shapes as a backstop, which is not a reason to log a value.
const fs = require("fs");
const { auditTree, formatHits } = require("./guard-utils");
const { scanEnvValueLogs } = require("./scanners");

// Content-keyed (`<call>(<env source>)`, #n for repeats). Add one only with a
// why-comment saying why the logged text can never be a credential.
const kKnownOffenders = {
  // Reads the env var only to decide whether to print " (default)"; the line
  // shows the parsed, clamped number of seconds, never the raw value.
  "lib/server/constants.js::console.warn(process.env.WATCHDOG_DEGRADED_CHECK_MAX_INTERVAL)":
    "presence check only; prints the clamped number",
};

const kRoots = [
  "lib/server",
  "lib/cli",
  "lib/scripts",
  "lib/plugin",
  "lib/setup",
  "bin",
  ...fs
    .readdirSync(require("path").join(__dirname, "..", "..", "..", "lib"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => `lib/${name}`),
];

describe("guard: log lines never carry env values", () => {
  it("flags log calls that interpolate an env value (self-test)", () => {
    const fixture = [
      "console.log(`[alphaclaw] Env updated: ${key}=${kSensitiveEnvKeyPattern.test(key) ? '***' : value}`);",
      'console.log("db", process.env.APP_DATABASE_URL);',
      "logger.warn?.(`retrying ${env.APP_DB_URL}`);",
      "console.error(`child env: ${JSON.stringify(process.env)}`);",
      "console.info(`token ${envMap.get(envKey)}`);",
      "logger.log(`${envKey}=${envValue}`);",
      "console.log(`vars: ${envVars.map((v) => v.value)}`);",
    ].join("\n");
    const keys = scanEnvValueLogs(fixture, "lib/server/planted.js").map((hit) => hit.key);
    expect(keys).toEqual([
      "lib/server/planted.js::console.log(${key}=${value})",
      "lib/server/planted.js::console.log(process.env.APP_DATABASE_URL)",
      "lib/server/planted.js::logger.warn(env.APP_DB_URL)",
      "lib/server/planted.js::console.error(JSON.stringify(process.env)",
      "lib/server/planted.js::console.info(envMap.get(envKey))",
      "lib/server/planted.js::logger.log(${key}=${value})",
      "lib/server/planted.js::console.log(envVars)",
    ]);
  });

  it("ignores key-name-only lines, redacted values, literals and comments (self-test)", () => {
    const fixture = [
      "console.log(`[alphaclaw] Env updated: added ${added.join(\", \")}`);",
      "console.log(`[alphaclaw] ${key} = ${redactEnvValue(key, process.env[key])}`);",
      "console.warn(`[alphaclaw] ${redactSecretText(String(process.env.HOOK_URL))}`);",
      'console.log("set process.env.FOO in the deployment env");',
      "console.log(`saved ${envVars.length} vars`);",
      "// console.log(process.env.SECRET_THING);",
    ].join("\n");
    expect(scanEnvValueLogs(fixture, "lib/server/planted.js")).toEqual([]);
  });

  it("has no new env values in log calls outside the allowlist, and no stale allowlist entries", () => {
    const { unexpected, stale } = auditTree({
      roots: kRoots,
      scan: scanEnvValueLogs,
      allowlist: kKnownOffenders,
    });
    expect(
      unexpected,
      `New log call(s) carrying an env value. Log the key name only, or wrap the value in redactEnvValue/redactSecretText from lib/server/utils/redact.js:\n${formatHits(unexpected)}`,
    ).toEqual([]);
    expect(
      stale,
      `Allowlist entries no longer match — the offender was fixed, remove them:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });
});
