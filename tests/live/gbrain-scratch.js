// A throwaway gbrain brain for the live tier: its own HOME (a scratch PGLite
// brain, never the machine's real one), a "relay" source on a local Git
// checkout with no remote, not federated, like GBRA-295 sets it up on a box.
// Only for tests: on a box the archive runs gbrain as the box's own wrapper
// with its own environment, never a hand-set HOME.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { mkTemp, parseSingleJsonDocument, scrubTestRunnerEnv } = require("./live-helpers");

const createScratchBrain = (bin) => {
  const home = mkTemp("alphaclaw-live-gbrain-home-");
  const checkout = path.join(home, "relay-src");
  const env = { ...scrubTestRunnerEnv(), HOME: home };
  const run = (args, { input = null } = {}) =>
    spawnSync(bin, args, { env, encoding: "utf8", timeout: 180_000, ...(input === null ? {} : { input }) });
  const must = (args, options) => {
    const result = run(args, options);
    if (result.status !== 0) throw new Error("gbrain " + args.join(" ") + " exited " + result.status + ": " + String(result.stderr).slice(-1200));
    return result;
  };
  const json = (args, options) => parseSingleJsonDocument(must(args, options).stdout, { label: "gbrain " + args.join(" "), stderr: "" });
  const git = (args) => {
    const result = spawnSync("git", ["-C", checkout, ...args], { env, encoding: "utf8" });
    if (result.status !== 0) throw new Error("git " + args.join(" ") + ": " + result.stderr);
    return result.stdout;
  };
  fs.mkdirSync(checkout, { recursive: true });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "relay-live"]);
  git(["config", "user.email", "relay-live@example.invalid"]);
  fs.writeFileSync(path.join(checkout, "README.md"), "# relay (live test)\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "init"]);
  must(["init", "--pglite", "--non-interactive", "--no-embedding", "--skip-embed-check", "--json"]);
  must(["sources", "add", "relay", "--path", checkout, "--no-federated", "--json"]);
  // With relay the only non-default source that has a path and no brain
  // default set, gbrain resolves an unscoped command to relay
  // (sole_non_default): pin the default like GBRA-295 checks on a box.
  must(["sources", "default", "default"]);
  const current = parseSingleJsonDocument(must(["sources", "current", "--json"]).stdout, { label: "gbrain sources current" });
  if (current.source_id !== "default") throw new Error("scratch brain resolves unscoped commands to " + current.source_id);
  return {
    home,
    checkout,
    env,
    run,
    json,
    git,
    trackedFiles: (prefix) => git(["ls-files", prefix]).trim().split("\n").filter(Boolean),
    commitSubjects: () => git(["log", "--format=%s"]).trim().split("\n"),
  };
};

module.exports = { createScratchBrain };
