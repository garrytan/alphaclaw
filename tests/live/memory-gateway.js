const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { waitFor } = require("./live-helpers");

const kHeapOomPattern = /JavaScript heap out of memory|Reached heap limit/i;
const kCriticalPressurePattern = /\[diagnostics\/memory\] memory pressure: level=critical/;
const kStartupConvergenceRefusal = "OpenClaw plugin migration inputs changed during startup convergence; refusing to report the gateway ready.";
const kOutputTailChars = 128 * 1024;

const startGatewayCapture = ({ bin, port, env }) => {
  const child = spawn(process.execPath, [bin, "gateway", "run", "--port", String(port)], {
    env: { ...env, OPENCLAW_GATEWAY_PORT: String(port) },
    stdio: "pipe",
  });
  // Every callback belongs to this child. Late output from a stopped startup
  // attempt cannot change the next gateway's exit or pressure evidence.
  const capture = {
    child, output: "", criticalPressureLine: null,
    exitCode: null, exitSignal: null, spawnError: null, didExit: false,
  };
  const appendOutput = (chunk) => {
    capture.output = (capture.output + chunk.toString()).slice(-kOutputTailChars);
    if (!capture.criticalPressureLine) {
      capture.criticalPressureLine = capture.output.split(/\r?\n/)
        .find((line) => kCriticalPressurePattern.test(line)) || null;
    }
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);
  capture.exited = new Promise((resolve) => {
    child.once("error", (error) => {
      capture.spawnError = error;
      resolve();
    });
    child.once("exit", (code, signal) => {
      capture.didExit = true;
      capture.exitCode = code;
      capture.exitSignal = signal;
      resolve();
    });
  });
  return capture;
};

const waitForGatewayReady = (capture, port) => waitFor(async () => {
  if (capture.spawnError || capture.didExit) {
    throw Object.assign(new Error(
      `Gateway exited before /healthz (code ${capture.exitCode}, signal ${capture.exitSignal}, error ${capture.spawnError?.message || "none"}).\n${capture.output.slice(-8000)}`,
    ), { code: "GATEWAY_STARTUP_EXIT" });
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}, 150000, "gateway /healthz");

const isStartupConvergenceRefusal = (capture, error) =>
  error?.code === "GATEWAY_STARTUP_EXIT" &&
  capture.didExit && !capture.spawnError &&
  capture.exitCode === 1 && capture.exitSignal === null &&
  capture.output.includes(kStartupConvergenceRefusal) &&
  capture.output.includes("Doctor changes") &&
  !kHeapOomPattern.test(capture.output);

const stopGatewayCapture = async (capture) => {
  if (!capture || capture.didExit || capture.spawnError) return;
  try { capture.child.kill("SIGTERM"); } catch {}
  // A compile-cache launcher has its own three-second worker-reaping backstop.
  // Let it finish before escalation so the worker cannot be orphaned.
  await Promise.race([capture.exited, new Promise((resolve) => setTimeout(resolve, 4000))]);
  if (!capture.didExit && !capture.spawnError) {
    try { capture.child.kill("SIGKILL"); } catch {}
  }
  await Promise.race([capture.exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
};

const saveGatewayEvidence = ({ rootDir, betaVersion, capture, stage, samples, error }) => {
  const artifactsDir = path.join(__dirname, "artifacts", path.basename(rootDir), stage);
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.writeFileSync(path.join(artifactsDir, "gateway.log"), capture.output);
  fs.writeFileSync(path.join(artifactsDir, "memory-run.json"), JSON.stringify({
    nodeVersion: process.version, betaVersion, stage,
    exitCode: capture.exitCode, exitSignal: capture.exitSignal,
    spawnError: capture.spawnError?.message || null,
    criticalPressureLine: capture.criticalPressureLine, samples,
    error: String(error?.message || "").slice(-8000),
  }, null, 2));
  return artifactsDir;
};

module.exports = {
  kHeapOomPattern, kCriticalPressurePattern, kStartupConvergenceRefusal,
  startGatewayCapture, waitForGatewayReady, isStartupConvergenceRefusal,
  stopGatewayCapture, saveGatewayEvidence,
};
