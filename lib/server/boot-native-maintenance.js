const fs = require("node:fs");
const path = require("node:path");
const { collectSecretValues, redactLine } = require("./utils/redact");
const {
  collectCodexMaintenanceInputs,
  readCodexMaintenanceStamp,
  decideCodexMaintenance,
  writeCodexMaintenanceStamp,
  clearCodexMaintenanceStamp,
} = require("./boot-native-maintenance-stamp");

const kSteps = [
  { script: "migrate-openclaw-codex.js", label: "Codex migration", timeoutMs: 60_000 },
  { script: "reconcile-codex-plugin.js", label: "Codex plugin reconciliation", timeoutMs: 150_000 },
];
const kDiagnosticsCaptureBytes = 16 * 1024;
const kDiagnosticsShownLines = 3;

const maintenanceError = (code) => Object.assign(new Error(`Boot native maintenance stopped: ${code}`), { code });

const kSecretAssignmentPattern = /\b([\w.-]*(?:token|secret|password|passwd|credential|api[-_]?key|private[-_]?key|cookie|authorization|access|refresh)[\w.-]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi;

// A child's stderr, as one short redacted line: how many distinct lines it
// wrote and the first few. Each line is masked (the child env's and config's
// secret values, secret-named assignments, known token shapes) and clamped.
const summarizeDiagnostics = (text, { secrets = null } = {}) => {
  const lines = [...new Set(String(text).split(/\r?\n/)
    .map((line) => redactLine(line, { secrets, maxLength: 400 }).replace(kSecretAssignmentPattern, "$1***").slice(0, 160))
    .filter(Boolean))];
  if (lines.length === 0) return null;
  const shown = lines.slice(0, kDiagnosticsShownLines).join(" | ");
  const more = lines.length > kDiagnosticsShownLines ? ` (+${lines.length - kDiagnosticsShownLines} more)` : "";
  return `${lines.length} line${lines.length === 1 ? "" : "s"}: ${shown}${more}`;
};

const defaultLoadAuthStore = (agentId) => require("./auth-store").loadAuthStore(agentId);
const defaultResolvePackageDir = () => require("./openclaw-codex-migration-runtime").resolveCodexMigrationBuild()?.packageDir || null;

const runBootNativeMaintenance = async ({
  execFileCmd,
  gatewayEnv,
  hold,
  signal = null,
  logger = console,
  managedDir = null,
  loadAuthStore = defaultLoadAuthStore,
  resolvePackageDir = defaultResolvePackageDir,
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
  const collectInputs = () => collectCodexMaintenanceInputs({
    configPath: env.OPENCLAW_CONFIG_PATH,
    stateDir: env.OPENCLAW_STATE_DIR || path.dirname(env.OPENCLAW_CONFIG_PATH),
    packageDir: (() => { try { return resolvePackageDir(); } catch { return null; } })(),
    loadAuthStore,
  });
  if (managedDir) {
    const inputs = collectInputs();
    const stamp = readCodexMaintenanceStamp({ managedDir });
    const reason = decideCodexMaintenance({ stamp, inputs });
    if (!reason) {
      logger.log(`[alphaclaw] Codex migration and plugin reconciliation skipped: already done for OpenClaw ${inputs.openclawBuild} with this config (${stamp.completedAt})`);
      return { status: "skipped", reason: "current" };
    }
    logger.log(`[alphaclaw] Codex migration and plugin reconciliation running: ${reason}`);
    clearCodexMaintenanceStamp({ managedDir });
  }
  const secrets = (() => {
    let config = null;
    try { config = JSON.parse(fs.readFileSync(env.OPENCLAW_CONFIG_PATH, "utf8")); } catch {}
    return collectSecretValues({ env, configObjects: config ? [config] : [] });
  })();
  let failed = false;
  for (const { script, label, timeoutMs } of kSteps) {
    assertOwned();
    let diagnostics = "";
    try {
      assertOwned();
      await execFileCmd(process.execPath, [path.join(__dirname, "..", "scripts", script)], {
        env,
        timeoutMs,
        processGroup: true,
        signal,
        onOutput: (text, stream) => {
          if (stream === "stderr" && diagnostics.length < kDiagnosticsCaptureBytes) {
            diagnostics = (diagnostics + String(text)).slice(0, kDiagnosticsCaptureBytes);
          }
        },
      });
      const summary = summarizeDiagnostics(diagnostics, { secrets });
      if (summary) logger.warn(`[alphaclaw] ${label} completed with diagnostics, ${summary}`);
      else logger.log(`[alphaclaw] ${label} completed`);
    } catch (error) {
      assertOwned();
      if (error?.killed || error?.timedOut || error?.cancelled || error?.name === "AbortError") {
        throw maintenanceError("boot_native_timeout");
      }
      failed = true;
      const exit = Number.isInteger(error?.code) ? ` (exit ${error.code})` : "";
      const summary = summarizeDiagnostics(diagnostics, { secrets });
      logger.warn(`[alphaclaw] ${label} process failed${exit}; continuing admitted boot${summary ? `; diagnostics, ${summary}` : ""}`);
    }
    assertOwned();
  }
  if (managedDir && !failed) {
    const inputs = collectInputs();
    if (inputs) writeCodexMaintenanceStamp({ managedDir, inputs, logger });
  }
  return { status: "ok" };
};

module.exports = { runBootNativeMaintenance, summarizeDiagnostics };
