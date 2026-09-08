import { authFetch } from "../../../lib/api.js";
import { formatWatchdogCopyAllText } from "../helpers.js";

const kDiagnosticTimeoutMs = 10_000;
const kSafeStatusWords = new Set([
  "healthy", "unhealthy", "degraded", "unknown", "running", "starting", "stopped",
  "stopping", "idle", "down", "up", "ready", "pending", "disabled", "paused",
]);

// The browser cannot collect the server's known secrets while it is down.
// Fail closed for free text/tails: retain only operational scalars whose
// shapes are safe and disclose that this is a limited, last-loaded snapshot.
export const buildLimitedDiagnostics = ({ status = null, incidents = [] } = {}) => {
  const safeStatus = {};
  for (const field of ["lifecycle", "health", "readiness"]) {
    if (kSafeStatusWords.has(status?.[field])) safeStatus[field] = status[field];
  }
  for (const field of ["gatewayPid", "servingPid", "repairAttempts", "repairAttemptLimit", "crashCountInWindow", "lastHealthCheckAt"]) {
    if (typeof status?.[field] === "number" && Number.isFinite(status[field])) safeStatus[field] = status[field];
  }
  for (const field of ["autoRepair", "safeMode", "replacementPending"]) {
    if (typeof status?.[field] === "boolean") safeStatus[field] = status[field];
  }
  safeStatus.visibleIncidentCount = Array.isArray(incidents) ? incidents.length : 0;
  return "LIMITED BROWSER SNAPSHOT — last loaded data; freshness is unknown.\n" +
    "The server diagnostic export was unavailable. Free text and logs are omitted because server secret redaction is unavailable.\n\n" +
    formatWatchdogCopyAllText({ status: safeStatus, logs: "Omitted from this limited browser snapshot." });
};

export const loadDiagnosticsForCopy = async ({ copyExtras = {}, fetcher = authFetch, timeoutMs = kDiagnosticTimeoutMs } = {}) => {
  const controller = new AbortController();
  let timeout;
  try {
    const result = await Promise.race([
      (async () => {
        const response = await fetcher("/api/diagnose?format=text", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Diagnostic export unavailable");
        const text = await response.text();
        if (!text.trim() || /^\s*</.test(text)) throw new Error("Invalid diagnostic export");
        return text;
      })(),
      new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error("Diagnostic export timed out")); }, timeoutMs); }),
    ]);
    return { text: result, limited: false };
  } catch {
    return { text: buildLimitedDiagnostics(copyExtras), limited: true };
  } finally {
    clearTimeout(timeout);
  }
};
