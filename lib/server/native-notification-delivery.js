const path = require("path");
const { createRepairOperation, waitForSignal, kRepairCleanupAllowanceMs, kRepairKillGraceMs } = require("./repair-operation");
const { createRunStream } = require("./openclaw-run-stream");
const { isStateDbQuiet } = require("./state-db-quiet");
const { expiredDelivery } = require("./notification-expiry");

const kDeliveryTimeoutMs = 30_000;
const kCompatibilityTimeoutMs = 5_000;
const refused = (reason) => ({ ok: false, reason, errorCode: null, deterministic: false });
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

const createNativeNotificationDelivery = ({
  isBootAdmitted,
  tryAcquire,
  getChannelInfo,
  isApplyInProgress,
  assessCompatibility,
  getExecutingBuild,
  getEnv,
  isQuiet = isStateDbQuiet,
  runStreamed = createRunStream().runStreamed,
  timeoutMs = kDeliveryTimeoutMs,
  compatibilityTimeoutMs = kCompatibilityTimeoutMs,
} = {}) => async ({ target, message, shouldDeliver = () => true } = {}) => {
  let hold = null;
  const admission = () => {
    if (!shouldDeliver()) fail("notification_expired");
    if (isBootAdmitted?.() !== true) fail("native_delivery_boot_unadmitted");
    if (isQuiet()) fail("native_delivery_state_db_quiet");
    if (isApplyInProgress?.() !== false) fail("native_delivery_apply_in_progress");
    const info = getChannelInfo?.();
    if (!info || typeof info !== "object" || Array.isArray(info) || info.stateCorrupted) fail("native_delivery_state_unreadable");
    if (info.gatewayHold) fail("native_delivery_gateway_held");
    if (info.installedDiverged) fail("native_delivery_build_diverged");
    if (hold && hold.isValid?.() !== true) fail("native_delivery_lease_expired");
  };
  const operation = createRepairOperation({ isCurrent: () => hold?.isValid?.() === true });
  const boundedRead = (read) => operation.read(() => waitForSignal(read,
    AbortSignal.any([operation.signal, AbortSignal.timeout(Math.max(1, Math.min(compatibilityTimeoutMs, kCompatibilityTimeoutMs)))])));
  try {
    admission();
    if (typeof tryAcquire !== "function" || typeof assessCompatibility !== "function" ||
        typeof getExecutingBuild !== "function" || typeof getEnv !== "function") fail("native_delivery_unconfigured");
    hold = tryAcquire({ leaseMs: kDeliveryTimeoutMs + kRepairCleanupAllowanceMs, cleanup: operation.cleanup });
    if (!hold) return refused("native_delivery_lifecycle_busy");
    operation.start(Math.max(1, Math.min(timeoutMs, kDeliveryTimeoutMs)), hold.expiresAt ?? Infinity);
    admission();
    const verdict = await boundedRead(assessCompatibility);
    operation.assertActive();
    admission();
    if (verdict?.compatible !== true || verdict.migrationRequired !== false) fail("native_delivery_compatibility_unverified");
    const expected = verdict.executingBuild;
    if (!expected || !["buildId", "version", "packageDir", "bin"].every((key) => typeof expected[key] === "string" && expected[key]) ||
        !path.isAbsolute(expected.bin)) fail("native_delivery_build_unverified");
    const current = await boundedRead(getExecutingBuild);
    operation.assertActive();
    admission();
    if (!current || !["buildId", "version", "packageDir", "bin"].every((key) => current[key] === expected[key])) fail("native_delivery_build_changed");
    const result = await operation.read(() => operation.runWriter(() => {
      const env = getEnv();
      admission();
      operation.assertActive();
      return runStreamed({
        command: process.execPath,
        args: [expected.bin, "message", "send", "--channel", "whatsapp", "--target", String(target || ""), "--message", String(message || "")],
        env,
        timeoutMs: operation.remainingMs(),
        deadlineAt: operation.deadlineAt,
        killGraceMs: kRepairKillGraceMs,
        signal: operation.signal,
        onProcess: operation.noteProcess,
      });
    }));
    operation.assertActive();
    return result?.ok ? { ok: true } : refused("native_whatsapp_send_failed");
  } catch (error) {
    if (error?.code === "notification_expired") return expiredDelivery({ skipped: 1 });
    return refused(typeof error?.code === "string" && error.code.startsWith("native_delivery_")
      ? error.code : "native_delivery_unavailable");
  } finally {
    operation.cancel("completed");
    if (hold) await hold();
    else await operation.cleanup.wait();
  }
};

module.exports = { createNativeNotificationDelivery };
