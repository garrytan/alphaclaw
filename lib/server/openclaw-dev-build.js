const path = require("path");
const { kOpenclawApplyTimeoutMs } = require("./constants");

const prepareDevBuild = async ({ sha = null, candidateDir, env, runner, emit, output, rootDir, readHead, resolveBin, channelError }) => {
  if (sha !== null && !/^[a-f0-9]{7,40}$/i.test(sha)) return channelError("invalid_commit", "Choose a valid OpenClaw commit.");
  const step = async (name, command, args) => {
    emit(name, "running");
    const result = await runner.runStreamed({ command, args, cwd: candidateDir,
      env: command === "pnpm" && args[0] === "build" ? { ...env, OPENCLAW_UPDATE_IN_PROGRESS: "1" } : env,
      timeoutMs: kOpenclawApplyTimeoutMs, logFile: path.join(rootDir, "logs", "openclaw-dev-update.log"),
      onOutput: output, tailBytes: 512 * 1024 });
    output.flush();
    emit(name, result.ok ? "completed" : "failed", result.ok ? {} : { tail: result.tail?.slice(-2000) });
    return result.ok;
  };
  if (!await step("fetch", "git", ["clone", "--filter=blob:none", "--no-checkout", "--single-branch", "--branch", "main",
    "https://github.com/openclaw/openclaw.git", candidateDir])) {
    return channelError("dev_build_failed", "Cloning the isolated OpenClaw candidate failed.", "Check network access and retry.");
  }
  if (sha && !await step("fetch", "git", ["fetch", "--all", "--tags"])) {
    return channelError("dev_build_failed", "Fetching the requested OpenClaw commit failed.", "Check network access and retry.");
  }
  if (!await step("checkout", "git", ["checkout", "--detach", sha || "origin/main"])) {
    return channelError("dev_build_failed", "The requested OpenClaw commit could not be checked out.", "Choose an available commit and retry.");
  }
  const preparedSha = readHead(candidateDir);
  if (!/^[a-f0-9]{40}$/i.test(preparedSha || "") || (sha && !preparedSha.startsWith(sha.toLowerCase()))) {
    return channelError("target_unverified", "The candidate does not match the requested OpenClaw commit.");
  }
  for (const [name, args] of [["install", ["install", "--frozen-lockfile"]], ["build", ["build"]], ["build", ["ui:build"]]]) {
    if (!await step(name, "pnpm", args)) return channelError("dev_build_failed", "The isolated OpenClaw source build failed.", "Review the build output or choose a different commit.");
  }
  const bin = resolveBin(candidateDir);
  if (!bin) return channelError("verify_failed", "The source build did not produce a runnable OpenClaw binary.");
  emit("doctor", "running");
  const doctor = await runner.runStreamed({ command: process.execPath, args: [bin, "doctor"], cwd: candidateDir, env,
    timeoutMs: kOpenclawApplyTimeoutMs, logFile: path.join(rootDir, "logs", "openclaw-dev-update.log"), onOutput: output });
  output.flush();
  emit("doctor", doctor.ok ? "completed" : "warning", doctor.ok ? {} : { tail: doctor.tail?.slice(-2000) });
  if (readHead(candidateDir) !== preparedSha) return channelError("target_unverified", "The prepared OpenClaw commit changed during its build.");
  return { ok: true, sha: preparedSha };
};

module.exports = { prepareDevBuild };
