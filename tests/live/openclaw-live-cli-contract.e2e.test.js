// LIVE TIER — CLI contract assumptions AlphaClaw encodes, probed against the
// REAL pinned OpenClaw (package.json dependencies.openclaw, installed in
// node_modules — the build production runs). The hermetic suites drive these
// behaviors through mocks; this tier screams when a pin bump drifts:
//   1. `backup create` names --output/--verify/--json (the "Back up now"
//      button runs exactly that command).
//   2. `approvals` lists `pending` and `get` in the PARENT help — the
//      execApprovalsSqlite era-probe contract.
//   3. `approvals get --json` wraps the document ({ path, exists, hash,
//      file, effectivePolicy }) — the CLI-backed routes unwrap `.file` (a
//      bare-doc assumption corrupted the round-trip).
//   4. The exec-defaults era layer, the config set/get flow and the pairing
//      store behave as the routes assume against a real state dir.
//
// Requires: a supported Node; offline (no install). Runtime: ~1-3 min.
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

const { describeExecutingBuild } = require("../../lib/server/openclaw-build");
const { kLiveEnabled, kSilentLogger, mkTemp, scrubTestRunnerEnv } = liveHelpers;

const describeLive = kLiveEnabled ? describe : describe.skip;

const kTestTimeoutMs = 12 * 60 * 1000;
const kUnknownCommandPattern =
  /unknown command|unrecognized|unexpected argument|not a valid|no such (?:command|subcommand)/i;

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
  "LIVE openclaw CLI contract against the pinned build",
  { retry: 1 },
  () => {
    it(
      "the pin supports the backup, approvals, exec-config and pairing contracts",
      { timeout: kTestTimeoutMs },
      async () => {
        const build = describeExecutingBuild({ installDir: path.resolve(__dirname, "../..") });
        const pin = require("../../package.json").dependencies.openclaw;
        expect(build?.version).toBe(pin);
        const pinBin = build.bin;

        // 1. The "Back up now" contract (openclaw-runtime.js startBackup):
        // the CLI names every flag AlphaClaw passes. The end-to-end run
        // against the real CLI lives in openclaw-live-backup.e2e.test.js.
        const backupHelp = helpText(pinBin, ["backup", "create", "--help"]);
        expect(backupHelp).not.toMatch(kUnknownCommandPattern);
        for (const flag of ["--output", "--verify", "--json"]) expect(backupHelp).toContain(flag);
        // 2. The era-probe contract: the sqlite era lists `pending` in the
        // PARENT approvals help (probing `approvals pending --help` is
        // useless — commander 15 prints the parent help and exits 0 for an
        // unknown subcommand + --help, on both eras).
        const approvalsHelp = helpText(pinBin, ["approvals", "--help"]);
        expect(approvalsHelp).not.toMatch(kUnknownCommandPattern);
        expect(approvalsHelp).toMatch(/^\s*pending\b/m);
        expect(approvalsHelp).toMatch(/^\s*get\b/m);
        // 3. The get/set round-trip contract the CLI-backed routes encode:
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
            execFileSync(process.execPath, [pinBin, ...args], {
              timeout: 120_000,
              stdio: "pipe",
              env: cliEnv,
              ...(input === null ? {} : { input }),
            }),
          );
        // `--json` reads: stdout must be exactly ONE JSON document (fix wave
        // F222/F115) — a banner or a second object FAILS the contract with
        // the command, exit status and stderr instead of a bare parse error.
        const runCliJson = (args) =>
          liveHelpers.runCliJson(pinBin, args, { env: cliEnv, label: "pin" });
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
        const wrapped = runCliJson(["approvals", "get", "--json"]);
        expect(wrapped.file).toBeTruthy();
        // The get output redacts the socket token…
        expect(wrapped.file.socket.token).toBeUndefined();
        // …and a redacted round-trip re-merges it server-side.
        const mutated = wrapped.file;
        mutated.agents["*"].allowlist.push({ pattern: "git status", id: "a2" });
        fs.writeFileSync(docPath, JSON.stringify(mutated));
        runCli(["approvals", "set", "--file", docPath]);
        const roundTripped = runCliJson(["approvals", "get", "--json"]);
        expect(
          roundTripped.file.agents["*"].allowlist.map((entry) => entry.pattern),
        ).toEqual(["ls *", "git status"]);
        expect(
          fs.existsSync(path.join(stateDir, "exec-approvals.json")),
        ).toBe(false);
        // 4. Our own era layer against the REAL pinned state dir: the row the
        // set above created makes the backend sqlite; the boot seeding must
        // never create the legacy file, and a poisoned one is reaped once.
        const { createStateEra } = require("../../lib/server/openclaw-state-era");
        const {
          ensureManagedExecDefaults,
        } = require("../../lib/server/exec-defaults-config");
        const sqliteEra = createStateEra({
          openclawDir: stateDir,
          gatesInfo: () => ({
            version: pin,
            features: { execApprovalsSqlite: true },
          }),
        });
        const seedResult = await ensureManagedExecDefaults({
          openclawDir: stateDir,
          resolveExecApprovalsBackend: sqliteEra.resolveExecApprovalsBackend,
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
          resolveExecApprovalsBackend: sqliteEra.resolveExecApprovalsBackend,
          logger: kSilentLogger,
        });
        expect(reapResult.reaped).toBe(true);
        expect(fs.existsSync(path.join(stateDir, "exec-approvals.json"))).toBe(false);
        // 5. The read-merge-write config flow the exec-config routes use.
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
        const execCfg = runCliJson(["config", "get", "tools.exec", "--json"]);
        expect(execCfg.mode).toBe("ask");
        // 6. Pairing-store propagation (X5, CLI-level): a direct row write
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
        // Verified against 2026.9.1-beta.1 (and every pin since): `pairing list` hides pending
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

        // The v0.9.43 regression case, against the same real pin: its state
        // db eagerly creates exec_approvals_config EMPTY — a live legacy file
        // must survive boot byte-identical (seeded, never renamed) when the
        // gate reports the file era.
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
        const runPinCliJson = (args) =>
          liveHelpers.runCliJson(pinBin, args, { env: pinEnv, label: "pin" });
        // A successful CLI call materializes the current pin's state db (all
        // tables, no rows). `approvals get --json` is the one the routes
        // depend on and exits 0 on an empty config — `config get <missing
        // path>` exits 1 on the pin ("Config path not found"), verified live.
        const pinApprovals = runPinCliJson(["approvals", "get", "--json"]);
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
        const pinExecCfg = runPinCliJson(["config", "get", "tools.exec", "--json"]);
        expect(pinExecCfg.mode).toBe("full");
      },
    );
  },
);
