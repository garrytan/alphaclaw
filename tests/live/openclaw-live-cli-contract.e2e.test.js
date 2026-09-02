// LIVE TIER — CLI contract assumptions the issue #21/#23 fixes encode,
// probed against REAL upstream builds (real npm install of the declared pin
// and the newest beta). The hermetic suites drive these behaviors through
// mocks; this tier screams when upstream drifts:
//   1. `backup create` on the beta names --no-include-workspace (the backup
//      retry in openclaw-channel-sync.js keys on the CLI naming the flag).
//   2. `approvals` exists on BOTH versions (verified live: the pin ships
//      get/set/allowlist too — an earlier revision of this tier wrongly
//      assumed the pin lacked the group). What discriminates the eras is the
//      `pending` subcommand in the PARENT help, which only the sqlite era
//      lists — the execApprovalsSqlite probe contract.
//   3. `database preflight` exists on the beta (rollback preflight probes).
//   4. `approvals get --json` wraps the document ({ path, exists, hash,
//      file, effectivePolicy }) on BOTH versions — the CLI-backed routes
//      unwrap `.file` (a bare-doc assumption corrupted the round-trip).
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

// Real installs go through the tracked wrapper (tests/live/live-helpers.js
// stageTempInstall): the prepare dir is swept even when the run is killed
// before the finally blocks below reach cleanup().
const installOpenclawVersionToTempDir = liveHelpers.stageTempInstall;
const {
  createOpenclawReleasesService,
} = require("../../lib/server/openclaw-releases");
const { readDeclaredPin } = require("../../lib/server/openclaw-channel-sync");
const { kLiveEnabled, kSilentLogger, mkTemp, scrubTestRunnerEnv } = liveHelpers;

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
        env: scrubTestRunnerEnv(),
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
      "the newest beta supports --no-include-workspace, approvals, and database preflight; the pin exposes approvals too",
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
          // 2. The era-probe contract: the sqlite era lists `pending` in the
          // PARENT approvals help (probing `approvals pending --help` is
          // useless — commander 15 prints the parent help and exits 0 for an
          // unknown subcommand + --help, on both eras).
          const approvalsHelp = helpText(betaBin, ["approvals", "--help"]);
          expect(approvalsHelp).not.toMatch(kUnknownCommandPattern);
          expect(approvalsHelp).toMatch(/^\s*pending\b/m);
          expect(approvalsHelp).toMatch(/^\s*get\b/m);
          // 3. The rollback-preflight probe contract.
          const preflightHelp = helpText(betaBin, [
            "database",
            "preflight",
            "--help",
          ]);
          expect(preflightHelp).not.toMatch(kUnknownCommandPattern);
          // 4. The get/set round-trip contract the CLI-backed routes encode:
          // the doc is wrapped under `file`, `set --file` accepts alphaclaw's
          // entry shape ({pattern, id, lastUsedAt}), a redacted get→set
          // round-trip preserves the stored socket token server-side, and no
          // legacy exec-approvals.json ever appears.
          const stateDir = mkTemp("openclaw-live-approvals-state-");
          const cliEnv = {
            ...scrubTestRunnerEnv(),
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
          };
          fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}");
          const runCli = (args, input = null) =>
            String(
              execFileSync(process.execPath, [betaBin, ...args], {
                timeout: 120_000,
                stdio: "pipe",
                env: cliEnv,
                ...(input === null ? {} : { input }),
              }),
            );
          const docPath = path.join(stateDir, "seed-doc.json");
          fs.writeFileSync(
            docPath,
            JSON.stringify({
              version: 1,
              socket: { path: "/x.sock", token: "tok-live" },
              defaults: { security: "full", ask: "off", askFallback: "full" },
              agents: {
                "*": { allowlist: [{ pattern: "ls *", id: "a1", lastUsedAt: 5 }] },
              },
            }),
          );
          runCli(["approvals", "set", "--file", docPath]);
          const wrapped = JSON.parse(runCli(["approvals", "get", "--json"]));
          expect(wrapped.file).toBeTruthy();
          // The get output redacts the socket token…
          expect(wrapped.file.socket.token).toBeUndefined();
          // …and a redacted round-trip re-merges it server-side.
          const mutated = wrapped.file;
          mutated.agents["*"].allowlist.push({ pattern: "git status", id: "a2" });
          fs.writeFileSync(docPath, JSON.stringify(mutated));
          runCli(["approvals", "set", "--file", docPath]);
          const roundTripped = JSON.parse(runCli(["approvals", "get", "--json"]));
          expect(
            roundTripped.file.agents["*"].allowlist.map((entry) => entry.pattern),
          ).toEqual(["ls *", "git status"]);
          expect(
            fs.existsSync(path.join(stateDir, "exec-approvals.json")),
          ).toBe(false);
          // 5. Our own era layer against the REAL beta state dir: the row the
          // set above created makes the backend sqlite; the boot seeding must
          // never create the legacy file, and a poisoned one is reaped once.
          const { createStateEra } = require("../../lib/server/openclaw-state-era");
          const {
            ensureManagedExecDefaults,
          } = require("../../lib/server/exec-defaults-config");
          const betaEra = createStateEra({
            openclawDir: stateDir,
            gatesInfo: () => ({
              version: newestBeta,
              features: { execApprovalsSqlite: true },
            }),
          });
          const seedResult = await ensureManagedExecDefaults({
            openclawDir: stateDir,
            resolveExecApprovalsBackend: betaEra.resolveExecApprovalsBackend,
            logger: kSilentLogger,
          });
          expect(seedResult.approvalsBackend).toBe("sqlite");
          expect(fs.existsSync(path.join(stateDir, "exec-approvals.json"))).toBe(false);
          fs.writeFileSync(
            path.join(stateDir, "exec-approvals.json"),
            JSON.stringify({ version: 1 }),
          );
          const reapResult = await ensureManagedExecDefaults({
            openclawDir: stateDir,
            resolveExecApprovalsBackend: betaEra.resolveExecApprovalsBackend,
            logger: kSilentLogger,
          });
          expect(reapResult.reaped).toBe(true);
          expect(fs.existsSync(path.join(stateDir, "exec-approvals.json"))).toBe(false);
          // 6. The read-merge-write config flow the exec-config routes use.
          fs.writeFileSync(
            path.join(stateDir, "openclaw.json"),
            JSON.stringify({ tools: { exec: { mode: "full", strictInlineEval: false } } }),
          );
          runCli([
            "config",
            "set",
            "tools.exec",
            JSON.stringify({ mode: "ask", host: "gateway", node: "", strictInlineEval: false }),
            "--strict-json",
          ]);
          const execCfg = JSON.parse(runCli(["config", "get", "tools.exec", "--json"]));
          expect(execCfg.mode).toBe("ask");
          // 7. Pairing-store propagation (X5, CLI-level): a direct row write
          // is visible to openclaw's own pairing tooling, and our direct
          // DELETE removes it. (In-gateway memory visibility would need a
          // booted gateway + live channel — out of this tier's scope; the
          // pairing CLI reads the same store the gateway daemon does.)
          const {
            openWritableOpenclawStateDb,
          } = require("../../lib/server/openclaw-state-db");
          const {
            deletePairingRequestByCode,
          } = require("../../lib/server/openclaw-state-era");
          const opened = openWritableOpenclawStateDb({ openclawDir: stateDir });
          expect(opened).toBeTruthy();
          // Verified against 2026.9.1-beta.1: `pairing list` hides pending
          // requests older than the CLI's pending TTL (PAIRING_PENDING_TTL_MS)
          // and reads ISO-8601 strings, not epoch ms — a stale or numeric
          // created_at makes the row invisible while our DELETE still works.
          const seededAt = new Date().toISOString();
          try {
            opened.db
              .prepare(
                "INSERT INTO channel_pairing_requests (channel_key, account_id, request_id, code, created_at, last_seen_at) VALUES ('telegram', 'default', 'live-r1', 'LIVE1234', ?, ?)",
              )
              .run(seededAt, seededAt);
          } finally {
            opened.db.close();
          }
          const pendingOut = runCli(["pairing", "list", "--channel", "telegram", "--json"]);
          expect(pendingOut).toContain("LIVE1234");
          const deletion = deletePairingRequestByCode({
            openclawDir: stateDir,
            channel: "telegram",
            code: "live1234",
          });
          expect(deletion).toEqual({ ok: true, deleted: 1 });
          const pendingAfter = runCli(["pairing", "list", "--channel", "telegram", "--json"]);
          expect(pendingAfter).not.toContain("LIVE1234");
        } finally {
          try {
            betaInstall.cleanup?.();
          } catch {}
        }

        // Discovered against the LIVE registry (2026-08-29): the declared pin
        // 2026.7.1-2 ALREADY ships the `approvals` CLI (get/set/allowlist),
        // contrary to the original "pin is file-era" assumption — verified by
        // installing the immutable package and running `approvals --help`.
        // Only `pending` is missing on the pin; the era probe and the
        // CLI-backed routes both depend on exactly this split, and the
        // routes' legacy-file fallback matters only for builds whose CLI
        // lacks the command, which the runtime capability probe detects
        // per-build. Pin the contract the probe actually sees.
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
          expect(pinApprovalsHelp).not.toMatch(kUnknownCommandPattern);
          expect(pinApprovalsHelp).toMatch(/^\s*get\b/m);
          expect(pinApprovalsHelp).not.toMatch(/^\s*pending\b/m);
          // The v0.9.43 regression case, against the REAL pin: its state db
          // eagerly creates exec_approvals_config EMPTY — a live legacy file
          // must survive boot byte-identical (seeded, never renamed).
          const pinStateDir = mkTemp("openclaw-live-pin-state-");
          const pinEnv = {
            ...scrubTestRunnerEnv(),
            OPENCLAW_STATE_DIR: pinStateDir,
            OPENCLAW_CONFIG_PATH: path.join(pinStateDir, "openclaw.json"),
          };
          fs.writeFileSync(path.join(pinStateDir, "openclaw.json"), "{}");
          const runPinCli = (args) =>
            String(
              execFileSync(process.execPath, [pinBin, ...args], {
                timeout: 120_000,
                stdio: "pipe",
                env: pinEnv,
              }),
            );
          // Any successful CLI call materializes the pin's v1 state db (all
          // tables, no rows). `approvals get --json` is the one the routes
          // depend on and exits 0 on an empty config — `config get <missing
          // path>` exits 1 on the pin ("Config path not found"), verified live.
          const pinApprovals = JSON.parse(runPinCli(["approvals", "get", "--json"]));
          expect(pinApprovals.file).toBeTruthy();
          expect(
            fs.existsSync(path.join(pinStateDir, "state", "openclaw.sqlite")),
          ).toBe(true);
          const liveDoc =
            JSON.stringify({
              version: 1,
              socket: { path: "/x.sock", token: "pin-tok" },
              defaults: { security: "full", ask: "off", askFallback: "full" },
              agents: { "*": { allowlist: [{ pattern: "ls *", id: "a1" }] } },
            }) + "\n";
          fs.writeFileSync(path.join(pinStateDir, "exec-approvals.json"), liveDoc);
          const { createStateEra } = require("../../lib/server/openclaw-state-era");
          const {
            ensureManagedExecDefaults,
          } = require("../../lib/server/exec-defaults-config");
          const pinEra = createStateEra({
            openclawDir: pinStateDir,
            gatesInfo: () => ({ version: pin, features: { execApprovalsSqlite: false } }),
          });
          const pinResult = await ensureManagedExecDefaults({
            openclawDir: pinStateDir,
            resolveExecApprovalsBackend: pinEra.resolveExecApprovalsBackend,
            logger: kSilentLogger,
          });
          expect(pinResult.approvalsBackend).toBe("file");
          expect(pinResult.reaped).toBe(false);
          expect(
            fs.readFileSync(path.join(pinStateDir, "exec-approvals.json"), "utf8"),
          ).toBe(liveDoc);
          // The read-merge-write config flow validates on the pin too.
          runPinCli([
            "config",
            "set",
            "tools.exec",
            JSON.stringify({ mode: "full", strictInlineEval: false }),
            "--strict-json",
          ]);
          const pinExecCfg = JSON.parse(runPinCli(["config", "get", "tools.exec", "--json"]));
          expect(pinExecCfg.mode).toBe("full");
        } finally {
          try {
            pinInstall.cleanup?.();
          } catch {}
        }
      },
    );
  },
);
