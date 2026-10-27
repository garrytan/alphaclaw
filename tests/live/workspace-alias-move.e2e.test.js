// LIVE TIER — OpenClaw's workspace-alias stop and "Confirm the workspace
// moved", against the REAL pinned OpenClaw:
//   1. Onboard a state dir, then move it behind a symlink (the layout a box
//      gets when its state dir later becomes a link into a bigger repo).
//      doctor --fix --yes stops on core/doctor/workspace-alias, and
//      AlphaClaw's parser classifies it as workspace_moved with both real
//      paths (OPENCLAW_HOME expanded).
//   2. doctor --fix --force --yes rebinds the records, and a plain
//      doctor --fix --yes then completes.
//   3. The set of doctor modules --force reaches is unchanged. The confirm
//      dialog tells the operator that --force only adds the workspace move
//      (and a Control UI rebuild from a source checkout, which an npm install
//      doesn't have); a new consumer must be reviewed before that stays true.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const liveHelpers = require("./live-helpers");
const { createDoctorOutputFacts, summarizeDoctorResult } = require("../../lib/server/doctor-outcome");

const { kLiveEnabled, mkTemp, scrubTestRunnerEnv } = liveHelpers;
const describeLive = kLiveEnabled ? describe : describe.skip;
const kTestTimeoutMs = 10 * 60 * 1000;
const kPackageDir = path.resolve(__dirname, "../../node_modules/openclaw");
const kOpenclawMjs = path.join(kPackageDir, "openclaw.mjs");

const openclawEnv = (root, stateDir) => ({
    ...scrubTestRunnerEnv(),
    HOME: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(fs.realpathSync(stateDir), "openclaw.json"),
    XDG_CONFIG_HOME: stateDir,
    OPENCLAW_NO_AUTO_UPDATE: "1",
});

const runOpenclaw = (args, env) =>
  spawnSync(process.execPath, [kOpenclawMjs, ...args], { env, encoding: "utf8", timeout: 5 * 60 * 1000, stdio: ["ignore", "pipe", "pipe"] });

const summarize = (result, env) => {
  const facts = createDoctorOutputFacts({ env });
  facts.onOutput(result.stdout || "", "stdout");
  facts.onOutput(result.stderr || "", "stderr");
  return summarizeDoctorResult({ ok: result.status === 0, code: result.status, facts: facts.snapshot() });
};

describeLive("live: OpenClaw's workspace-alias stop and the confirmed move", () => {
  it(
    "a state dir moved behind a symlink stops doctor --fix --yes as workspace_moved; --force rebinds it",
    () => {
      const root = mkTemp("alphaclaw-live-alias-");
      const stateDir = path.join(root, ".openclaw");
      fs.mkdirSync(path.join(stateDir, "workspace"), { recursive: true });
      const onboard = runOpenclaw(
        [
          "onboard", "--non-interactive", "--accept-risk", "--flow", "quickstart", "--gateway-bind", "loopback",
          "--gateway-port", "18997", "--gateway-auth", "token", "--gateway-token", "live-alias-token-0000000000000000",
          "--no-install-daemon", "--skip-health", "--workspace", path.join(stateDir, "workspace"), "--auth-choice", "skip",
        ],
        openclawEnv(root, stateDir),
      );
      expect(onboard.status, onboard.stderr.slice(-1500)).toBe(0);

      fs.mkdirSync(path.join(root, "repo"));
      fs.renameSync(stateDir, path.join(root, "repo", "sub"));
      fs.symlinkSync(path.join("repo", "sub"), stateDir);
      const env = openclawEnv(root, stateDir);
      const realRoot = fs.realpathSync(root);

      const stopped = runOpenclaw(["doctor", "--fix", "--yes"], env);
      expect(stopped.status).not.toBe(0);
      const summary = summarize(stopped, env);
      expect(summary).toMatchObject({ reason: "workspace_moved", class: "deterministic" });
      expect(summary.workspaceMove).toEqual({
        aliasPath: path.join(root, ".openclaw", "workspace"),
        from: path.join(root, ".openclaw", "workspace"),
        to: path.join(realRoot, "repo", "sub", "workspace"),
      });
      expect(summary.workspaceMove.blocked).toBeUndefined();

      const forced = runOpenclaw(["doctor", "--fix", "--force", "--yes"], env);
      expect(forced.status, `${forced.stdout.slice(-1500)}\n${forced.stderr.slice(-1500)}`).toBe(0);
      expect(forced.stdout.replace(/[│\s]+/g, " ")).toContain("Rebound workspace state for");

      const after = runOpenclaw(["doctor", "--fix", "--yes"], env);
      expect(after.status, after.stderr.slice(-1500)).toBe(0);
      expect(summarize(after, env).status).toBe("ok");
      expect(fs.lstatSync(stateDir).isSymbolicLink()).toBe(true);
    },
    kTestTimeoutMs,
  );

  it("--force reaches the same doctor modules as when the confirm dialog's wording was checked", () => {
    const distDir = path.join(kPackageDir, "dist");
    const consumers = fs
      .readdirSync(distDir)
      .filter((name) => name.endsWith(".mjs"))
      .filter((name) => /confirmAggressiveAutoFix|prompter\.shouldForce|repairMode\.shouldForce|requiresForce/.test(fs.readFileSync(path.join(distDir, name), "utf8")))
      .map((name) => name.replace(/-[A-Za-z0-9_-]{8}\.mjs$/, ""))
      .sort();
    // doctor-prompter / doctor-repair-mode define the flag; doctor-workspace-alias
    // (the move), doctor-ui (stale Control UI rebuild, needs <package>/ui sources)
    // and doctor-gateway-services (a note only under --yes; AlphaClaw installs no
    // gateway service) consume it.
    expect(consumers).toEqual(["doctor-gateway-services", "doctor-prompter", "doctor-repair-mode", "doctor-ui", "doctor-workspace-alias"]);
    expect(fs.existsSync(path.join(kPackageDir, "ui", "package.json"))).toBe(false);
  });
});
