// LIVE TIER — the delivery contract the Doctor "Ask Agent to Fix" dispatch
// (and POST /api/agent/message) encode, probed against REAL upstream builds:
//   1. `agent --help` names --deliver / --reply-channel / --reply-to /
//      --reply-account on the pin AND the newest beta (the CLI-flag send
//      path in routes/system.js composes exactly these).
//   2. The packaged gateway code carries `replyAccountId` (the JSON-params
//      send path in doctor/service.js includes it for account-scoped DMs).
// The hermetic suites assert the COMMANDS AlphaClaw composes; this tier
// screams when upstream renames/removes the params those commands rely on.
// When this tier fails but the hermetic suite is green, suspect upstream
// OpenClaw drift first and update the encoded assumption, not the guard
// (AGENTS.md "test:live" note).

const fs = require("fs");
const path = require("path");
// live-helpers only touches fs/os/path — safe to load BEFORE the env below.
const liveHelpers = require("./live-helpers");
process.env.ALPHACLAW_ROOT_DIR = liveHelpers.mkTemp(
  "alphaclaw-live-fix-dispatch-root-",
);
delete process.env.OPENCLAW_GIT_DIR;

const { execFileSync } = require("child_process");

const {
  installOpenclawVersionToTempDir,
} = require("../../lib/server/openclaw-version");
const {
  createOpenclawReleasesService,
} = require("../../lib/server/openclaw-releases");
const { readDeclaredPin } = require("../../lib/server/openclaw-channel-sync");
const { kLiveEnabled, kSilentLogger, mkTemp } = liveHelpers;

const describeLive = kLiveEnabled ? describe : describe.skip;

const kInstallTimeoutMs = 8 * 60 * 1000;
const kTestTimeoutMs = 12 * 60 * 1000;

const resolveBin = (openclawPackageDir) => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(openclawPackageDir, "package.json"), "utf8"),
  );
  const rel =
    typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin || {})[0];
  return path.join(openclawPackageDir, rel);
};

// Help probes exit nonzero on some builds — the TEXT is the contract.
const helpText = (bin, args) => {
  try {
    return String(
      execFileSync(process.execPath, [bin, ...args], {
        timeout: 120_000,
        stdio: "pipe",
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
      if (!entry.name.endsWith(".js")) continue;
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
const assertDeliveryContract = (openclawPackageDir, label) => {
  const bin = resolveBin(openclawPackageDir);
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
      "the pin and the newest beta both support the deliver/reply-* contract",
      { timeout: kTestTimeoutMs },
      async () => {
        const pin = readDeclaredPin();
        expect(pin).toBeTruthy();
        const pinInstall = await installOpenclawVersionToTempDir({
          versionSpec: pin,
          timeoutMs: kInstallTimeoutMs,
          logger: kSilentLogger,
        });
        try {
          assertDeliveryContract(pinInstall.openclawPackageDir, `pin ${pin}`);
        } finally {
          pinInstall.cleanup?.();
        }

        const releases = createOpenclawReleasesService({
          fetchImpl: (...args) => global.fetch(...args),
          cacheDir: mkTemp("openclaw-live-fix-dispatch-cache-"),
          getGithubToken: () => process.env.GITHUB_TOKEN || null,
          logger: kSilentLogger,
        });
        const catalog = await releases.getCatalog({});
        expect(catalog.ok).toBe(true);
        const newestBeta = catalog.beta?.[0]?.version;
        expect(newestBeta).toBeTruthy();
        const betaInstall = await installOpenclawVersionToTempDir({
          versionSpec: newestBeta,
          timeoutMs: kInstallTimeoutMs,
          logger: kSilentLogger,
        });
        try {
          assertDeliveryContract(betaInstall.openclawPackageDir, `beta ${newestBeta}`);
        } finally {
          betaInstall.cleanup?.();
        }
      },
    );
  },
);
