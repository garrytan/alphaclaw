// LIVE TIER — the delivery contract the Doctor "Ask Agent to Fix" dispatch
// (and POST /api/agent/message) encode, probed against the REAL pinned
// OpenClaw (package.json dependencies.openclaw, installed in node_modules):
//   1. `agent --help` names --deliver / --reply-channel / --reply-to /
//      --reply-account (the CLI-flag send path in routes/system.js composes
//      exactly these).
//   2. The packaged gateway code carries `replyAccountId` (the JSON-params
//      send path in doctor/service.js includes it for account-scoped DMs).
// The hermetic suites assert the COMMANDS AlphaClaw composes; this tier
// screams when upstream renames/removes the params those commands rely on.
// When this tier fails but the hermetic suite is green, suspect upstream
// OpenClaw drift first and update the encoded assumption, not the guard
// (AGENTS.md "test:live" note).

const fs = require("fs");
const path = require("path");
const liveHelpers = require("./live-helpers");
const { execFileSync } = require("child_process");
const { describeExecutingBuild } = require("../../lib/server/openclaw-build");
const { kLiveEnabled } = liveHelpers;

const describeLive = kLiveEnabled ? describe : describe.skip;

const kTestTimeoutMs = 12 * 60 * 1000;

// Help probes exit nonzero on some builds — the TEXT is the contract.
const helpText = (bin, args) => {
  try {
    return String(
      execFileSync(process.execPath, [bin, ...args], {
        timeout: 120_000,
        stdio: "pipe",
        env: liveHelpers.scrubTestRunnerEnv(),
      }),
    );
  } catch (error) {
    return `${error?.stdout || ""}\n${error?.stderr || ""}\n${error?.message || ""}`;
  }
};

const packageDistMentions = (openclawPackageDir, needle) => {
  const distDir = path.join(openclawPackageDir, "dist");
  const stack = [distDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      // OpenClaw 2026.9.3 packages executable chunks as .mjs; keep checking
      // code across module formats without accepting source maps or types.
      if (!/\.(?:c|m)?js$/.test(entry.name)) continue;
      try {
        if (fs.readFileSync(full, "utf8").includes(needle)) return true;
      } catch {}
    }
  }
  return false;
};

// NOTE (documented narrowing of plan item C5): a live-gateway boot +
// `gateway call agent` schema-acceptance probe is deferred — none of the
// live tiers run a real gateway today. These static contracts (CLI flag
// names + packaged param identifiers) are the drift tripwires the hermetic
// suite's composed commands depend on.
const assertDeliveryContract = ({ bin, packageDir: openclawPackageDir }, label) => {
  const agentHelp = helpText(bin, ["agent", "--help"]);
  for (const flag of ["--deliver", "--reply-channel", "--reply-to", "--reply-account"]) {
    expect(agentHelp, `${label}: agent --help must name ${flag}`).toContain(flag);
  }
  for (const param of ["replyAccountId", "replyChannel", "replyTo"]) {
    expect(
      packageDistMentions(openclawPackageDir, param),
      `${label}: packaged gateway code must carry ${param}`,
    ).toBe(true);
  }
};

describeLive(
  "LIVE openclaw delivery contract for the Doctor fix dispatch",
  { retry: 1 },
  () => {
    it(
      "the pin supports the deliver/reply-* contract",
      { timeout: kTestTimeoutMs },
      () => {
        const pin = require("../../package.json").dependencies.openclaw;
        const build = describeExecutingBuild({ installDir: path.resolve(__dirname, "../..") });
        expect(build?.version).toBe(pin);
        assertDeliveryContract(build, `pin ${pin}`);
      },
    );
  },
);
