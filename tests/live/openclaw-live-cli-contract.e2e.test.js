// LIVE TIER — CLI contract assumptions the issue #21/#23 fixes encode,
// probed against REAL upstream builds (real npm install of the declared pin
// and the newest beta). The hermetic suites drive these behaviors through
// mocks; this tier screams when upstream drifts:
//   1. `backup create` on the beta names --no-include-workspace (the backup
//      retry in openclaw-channel-sync.js keys on the CLI naming the flag).
//   2. `approvals` exists on the beta (the #23 capability probe + CLI-backed
//      exec-approvals routes) and is ABSENT on the file-era pin (the legacy
//      file fallback path).
//   3. `database preflight` exists on the beta (rollback preflight probes).
//
// Requires: network, a supported Node. Runtime: ~2-6 min (two real installs).
// When this tier fails but the hermetic suite is green, suspect upstream
// OpenClaw drift first and update the encoded assumption, not the guard
// (AGENTS.md "test:live" note).

const fs = require("fs");
const path = require("path");
// live-helpers only touches fs/os/path — safe to load BEFORE the env below.
const liveHelpers = require("./live-helpers");
process.env.ALPHACLAW_ROOT_DIR = liveHelpers.mkTemp(
  "alphaclaw-live-cli-contract-root-",
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
// Mirror of kUnknownCommandPattern in openclaw-channel-sync.js (module-local
// there by design) — this tier pins the UPSTREAM half of that contract.
const kUnknownCommandPattern =
  /unknown command|unrecognized|unexpected argument|not a valid|no such (?:command|subcommand)/i;

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

describeLive(
  "LIVE openclaw CLI contract for the #21/#23 recovery paths",
  { retry: 1 },
  () => {
    it(
      "the newest beta supports --no-include-workspace, approvals, and database preflight; the pin stays file-era",
      { timeout: kTestTimeoutMs },
      async () => {
        const releases = createOpenclawReleasesService({
          fetchImpl: (...args) => global.fetch(...args),
          cacheDir: mkTemp("openclaw-live-cli-catalog-cache-"),
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
          const betaBin = resolveBin(betaInstall.openclawPackageDir);
          // 1. The backup retry contract: the CLI itself names the flag.
          const backupHelp = helpText(betaBin, ["backup", "create", "--help"]);
          expect(backupHelp).toMatch(/--no-include-workspace/);
          // 2. The #23 capability probe contract (sqlite-era approvals CLI).
          const approvalsHelp = helpText(betaBin, ["approvals", "--help"]);
          expect(approvalsHelp).not.toMatch(kUnknownCommandPattern);
          expect(approvalsHelp).toMatch(/get|set/i);
          // 3. The rollback-preflight probe contract.
          const preflightHelp = helpText(betaBin, [
            "database",
            "preflight",
            "--help",
          ]);
          expect(preflightHelp).not.toMatch(kUnknownCommandPattern);
        } finally {
          try {
            betaInstall.cleanup?.();
          } catch {}
        }

        // The declared pin is file-era: `approvals` must read as an unknown
        // command so the routes keep their legacy file fallback there.
        const pin = readDeclaredPin();
        expect(pin).toBeTruthy();
        const pinInstall = await installOpenclawVersionToTempDir({
          versionSpec: pin,
          timeoutMs: kInstallTimeoutMs,
          logger: kSilentLogger,
        });
        try {
          const pinBin = resolveBin(pinInstall.openclawPackageDir);
          const pinApprovalsHelp = helpText(pinBin, ["approvals", "--help"]);
          expect(pinApprovalsHelp).toMatch(kUnknownCommandPattern);
        } finally {
          try {
            pinInstall.cleanup?.();
          } catch {}
        }
      },
    );
  },
);
