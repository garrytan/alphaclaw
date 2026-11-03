// LIVE TIER — the measured-context read (GST-176) against the REAL pinned
// OpenClaw: one turn on an onboarded install, then AlphaClaw's reader goes
// through sessions.list and a key-scoped sessions.usage includeContextWeight,
// exactly as the Doctor tab does. It pins the run-report contract the
// normalizer depends on (source "run", absolute injectedWorkspaceFiles paths,
// rawChars as the file's trimEnd length) and that AlphaClaw's own bootstrap
// files reach the prompt untruncated. When this tier fails but the hermetic
// suite is green, suspect upstream OpenClaw drift first (AGENTS.md).
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const liveHelpers = require("./live-helpers");
const { startControlUiInstall } = require("./control-ui-live");
const { createMeasuredContextReader } = require("../../lib/server/context-measure");

const describeLive = liveHelpers.kLiveEnabled ? describe : describe.skip;
const kTestTimeoutMs = 6 * 60 * 1000;

// Async on purpose: the mock model answers from this process, so a
// synchronous CLI call would block it and the turn would time out.
const runOpenclaw = (args, env, timeoutMs = 120_000) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [liveHelpers.repoOpenclawBin(), ...args], {
      env: liveHelpers.scrubTestRunnerEnv(env),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });

describeLive("live: measured context from OpenClaw's run report", () => {
  let install = null;

  afterAll(async () => {
    await install?.stop();
  });

  it(
    "reads the last run's injected files, workspace-relative, with AlphaClaw's files untruncated",
    async () => {
      install = await startControlUiInstall({
        label: "context-measured",
        setupPassword: "live-setup-password-1",
        gatewayToken: "live-gateway-token-0123456789",
        extraEnv: () => ({}),
      });
      const stateDir = path.join(install.rootDir, ".openclaw");
      const env = {
        HOME: install.rootDir,
        OPENCLAW_HOME: install.rootDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        OPENCLAW_STATE_DIR: stateDir,
        XDG_CONFIG_HOME: stateDir,
        OPENCLAW_NO_AUTO_UPDATE: "1",
      };
      const turn = await runOpenclaw(
        ["agent", "--session-key", "agent:main:main", "--message", "Reply to ping-ctx001", "--json", "--timeout", "90"],
        env,
      );
      expect(turn.ok, `agent turn failed: ${turn.stderr.slice(-400)} ${turn.stdout.slice(-400)}`).toBe(true);

      const clawCmd = async (cmd, { timeoutMs = 20_000 } = {}) =>
        new Promise((resolve) => {
          const child = spawn("/bin/sh", ["-c", `"${process.execPath}" "${liveHelpers.repoOpenclawBin()}" ${cmd}`], {
            env: liveHelpers.scrubTestRunnerEnv(env),
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d) => {
            stdout += d;
          });
          child.stderr.on("data", (d) => {
            stderr += d;
          });
          const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
          child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ ok: code === 0, stdout, stderr });
          });
        });

      const measured = await createMeasuredContextReader({ clawCmd }).read("main");
      expect(measured, JSON.stringify(measured)).toMatchObject({ available: true, agentId: "main", sessionKind: "main" });
      expect(measured.systemPrompt.chars).toBeGreaterThan(measured.systemPrompt.projectContextChars);
      expect(JSON.stringify(measured)).not.toContain(install.rootDir);

      const workspaceDir = path.join(install.rootDir, "workspace");
      const managed = measured.files.filter((file) => file.managed);
      expect(managed.map((file) => file.path)).toEqual(
        expect.arrayContaining(["hooks/bootstrap/AGENTS.md", "hooks/bootstrap/reference/AGENTS.md"]),
      );
      for (const file of managed) {
        const onDisk = fs.readFileSync(path.join(workspaceDir, file.path), "utf8");
        expect(file, file.path).toMatchObject({ verified: true, truncated: false, missing: false });
        expect(file.rawChars, file.path).toBe(onDisk.trimEnd().length);
        expect(file.injectedChars, file.path).toBe(file.rawChars);
      }
      expect(measured.filesTotal.managedInjectedChars).toBe(
        managed.reduce((sum, file) => sum + file.injectedChars, 0),
      );
    },
    kTestTimeoutMs,
  );
});
