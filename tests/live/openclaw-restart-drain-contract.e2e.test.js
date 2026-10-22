// LIVE TIER — the restart drain contract the memory mitigation's drain
// budget relies on (ALPH-17, lib/server/gateway-memory/drain-budget.js):
//   1. `gateway restart --help` still defines --wait (the ask passes the
//      drain budget there; the ask-outcome e2e shows the gateway announcing
//      it as its shutdown drain budget).
//   2. The pin's own default restart deferral is still what
//      kOpenclawDefaultRestartDrainMs encodes: the longest drain AlphaClaw
//      asks for, and what the restart operation budget is sized to cover.
// When this tier fails but the hermetic suite is green, suspect upstream
// OpenClaw drift first and update the encoded assumption, not the guard.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const liveHelpers = require("./live-helpers");
const { kOpenclawDefaultRestartDrainMs } = require("../../lib/server/constants");
const { kLiveEnabled } = liveHelpers;

const describeLive = kLiveEnabled ? describe : describe.skip;
const kInstallDir = process.env.OPENCLAW_CONTRACT_INSTALL_DIR || path.join(__dirname, "..", "..");
const kPackageDir = path.join(kInstallDir, "node_modules", "openclaw");
const kBin = path.join(kInstallDir, "node_modules", ".bin", "openclaw");

const helpText = (args) => {
  try {
    return String(execFileSync(kBin, args, { timeout: 120_000, stdio: "pipe", env: liveHelpers.scrubTestRunnerEnv() }));
  } catch (error) {
    return `${error?.stdout || ""}\n${error?.stderr || ""}`;
  }
};

describeLive("LIVE restart drain contract", () => {
  it("gateway restart takes --wait, and the pin's default restart deferral is still 300 000 ms", () => {
    expect(helpText(["gateway", "restart", "--help"])).toMatch(/--wait\b/);
    const distDir = path.join(kPackageDir, "dist");
    const values = [];
    for (const name of fs.readdirSync(distDir)) {
      if (!/\.(?:c|m)?js$/.test(name)) continue;
      const match = /DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS\s*=\s*([0-9][0-9_.e]*)/.exec(fs.readFileSync(path.join(distDir, name), "utf8"));
      if (match) values.push(Number(match[1].replace(/_/g, "")));
    }
    expect(values.length, "DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS not found in the pin's dist").toBeGreaterThan(0);
    expect(new Set(values)).toEqual(new Set([kOpenclawDefaultRestartDrainMs]));
  }, 180_000);
});
