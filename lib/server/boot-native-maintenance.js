const fs = require("node:fs");
const path = require("node:path");

const kSteps = [
  { script: "migrate-openclaw-codex.js", label: "Codex migration", timeoutMs: 60_000 },
  { script: "reconcile-codex-plugin.js", label: "Codex plugin reconciliation", timeoutMs: 150_000 },
];

const maintenanceError = (code) => Object.assign(new Error(`Boot native maintenance stopped: ${code}`), { code });

const runBootNativeMaintenance = async ({
  execFileCmd,
  gatewayEnv,
  hold,
  signal = null,
  logger = console,
}) => {
  const assertOwned = () => {
    if (signal?.aborted) throw maintenanceError("boot_native_cancelled");
    if (typeof hold?.isValid !== "function" || !hold.isValid()) {
      throw maintenanceError("boot_lease_expired");
    }
  };
  assertOwned();
  const env = gatewayEnv();
  if (!env.OPENCLAW_CONFIG_PATH || !fs.existsSync(env.OPENCLAW_CONFIG_PATH)) {
    return { status: "skipped", reason: "no-config" };
  }
  for (const { script, label, timeoutMs } of kSteps) {
    assertOwned();
    let diagnostics = false;
    try {
      assertOwned();
      await execFileCmd(process.execPath, [path.join(__dirname, "..", "scripts", script)], {
        env,
        timeoutMs,
        processGroup: true,
        signal,
        onOutput: (_text, stream) => { if (stream === "stderr") diagnostics = true; },
      });
      if (diagnostics) logger.warn(`[alphaclaw] ${label} emitted diagnostics; child output withheld`);
      else logger.log(`[alphaclaw] ${label} completed`);
    } catch (error) {
      assertOwned();
      if (error?.killed || error?.timedOut || error?.cancelled || error?.name === "AbortError") {
        throw maintenanceError("boot_native_timeout");
      }
      const exit = Number.isInteger(error?.code) ? ` (exit ${error.code})` : "";
      logger.warn(`[alphaclaw] ${label} process failed${exit}; continuing admitted boot`);
    }
    assertOwned();
  }
  return { status: "ok" };
};

module.exports = { runBootNativeMaintenance };
