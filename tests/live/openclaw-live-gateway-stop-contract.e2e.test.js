// LIVE TIER — the `gateway stop --help` contract the capability-gated
// `--force` (WI-5.1, lib/server/openclaw-capabilities.js gatewayStopForce)
// depends on, pinned against the REAL binary AlphaClaw runs: the OpenClaw pin
// in package.json, installed in node_modules. The pin is the only version
// AlphaClaw runs; the probe stays for a broken or stale install. When this
// tier fails but the hermetic suite is green, suspect upstream drift first
// (AGENTS.md "test:live" note).
//
// Requires: offline (no install). Seconds.

const path = require("path");
const liveHelpers = require("./live-helpers");
process.env.ALPHACLAW_ROOT_DIR = liveHelpers.mkTemp(
  "alphaclaw-live-stop-contract-root-",
);
delete process.env.OPENCLAW_GIT_DIR;

const { execFileSync } = require("child_process");
const {
  kLiveEnabled,
  mkTemp,
  readDeclaredPin,
  repoOpenclawBin,
  scrubTestRunnerEnv,
} = liveHelpers;

const describeLive = kLiveEnabled ? describe : describe.skip;

const kTestTimeoutMs = 12 * 60 * 1000;

// The EXACT predicate the capability probe applies to the help text — one
// source of truth would be nicer, but the probe is module-local by design;
// this mirror pins the upstream half of the contract (drift shows up here).
const kForceFlagPattern = /(^|\s)--force\b/;
const kUnknownCommandPattern =
  /unknown command|unrecognized|unexpected argument|not a valid|no such (?:command|subcommand)/i;

// Help probes exit nonzero on some builds — the TEXT is the contract.
const helpText = (bin, args) => {
  const stateDir = mkTemp("openclaw-live-stop-help-state-");
  const env = {
    ...scrubTestRunnerEnv(),
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_NO_AUTO_UPDATE: "1",
  };
  try {
    return String(
      execFileSync(process.execPath, [bin, ...args], {
        timeout: 120_000,
        stdio: "pipe",
        env,
      }),
    );
  } catch (error) {
    return `${error?.stdout || ""}\n${error?.stderr || ""}\n${error?.message || ""}`;
  }
};

describeLive("LIVE `gateway stop --help` contract (capability-gated --force, WI-5.1)", () => {
  it(
    `the pin ${readDeclaredPin()} advertises gateway stop --force`,
    { timeout: kTestTimeoutMs },
    () => {
      const text = helpText(repoOpenclawBin(), ["gateway", "stop", "--help"]);
      expect(text).not.toMatch(kUnknownCommandPattern);
      expect(text).toMatch(/Usage: openclaw gateway stop/);
      expect(text).toMatch(kForceFlagPattern);
      // Recorded wording — the guard this flag bypasses is the
      // non-interactive stop refusal the incumbent-restart path reports.
      expect(text).toMatch(/--force\s+Allow stop from a non-interactive shell/);
    },
  );
});
