const path = require("path");
const { createRepairOperation, waitForSignal, kRepairCleanupAllowanceMs, kRepairKillGraceMs } = require("./repair-operation");
const { createRunStream } = require("./openclaw-run-stream");
const { expiredDelivery } = require("./notification-expiry");

const kDeliveryTimeoutMs = 30_000;
const kBuildReadTimeoutMs = 5_000;
const refused = (reason) => ({ ok: false, reason, errorCode: null, deterministic: false });
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

// WhatsApp owner notifications go through the installed OpenClaw's
// `message send`, run under the current node against the build's own bin and
// under the gateway lifecycle lock, so a delivery never overlaps a restart or
// repair.
const createNativeNotificationDelivery = ({
  isBootAdmitted,
  tryAcquire,
  getExecutingBuild,
  getEnv,
  runStreamed = createRunStream().runStreamed,
  timeoutMs = kDeliveryTimeoutMs,
  buildReadTimeoutMs = kBuildReadTimeoutMs,
} = {}) => async ({ target, message, shouldDeliver = () => true } = {}) => {
  let hold = null;
  const admission = () => {
    if (!shouldDeliver()) fail("notification_expired");
    if (isBootAdmitted?.() !== true) fail("native_delivery_boot_unadmitted");
    if (hold && hold.isValid?.() !== true) fail("native_delivery_lease_expired");
  };
  const operation = createRepairOperation({ isCurrent: () => hold?.isValid?.() === true });
  try {
    admission();
    if (typeof tryAcquire !== "function" || typeof getExecutingBuild !== "function" ||
        typeof getEnv !== "function") fail("native_delivery_unconfigured");
    hold = tryAcquire({ leaseMs: kDeliveryTimeoutMs + kRepairCleanupAllowanceMs, cleanup: operation.cleanup });
    if (!hold) return refused("native_delivery_lifecycle_busy");
    operation.start(Math.max(1, Math.min(timeoutMs, kDeliveryTimeoutMs)), hold.expiresAt ?? Infinity);
    admission();
    const expected = await operation.read(() => waitForSignal(getExecutingBuild,
      AbortSignal.any([operation.signal, AbortSignal.timeout(Math.max(1, Math.min(buildReadTimeoutMs, kBuildReadTimeoutMs)))])));
    operation.assertActive();
    admission();
    if (!expected || typeof expected.bin !== "string" || !path.isAbsolute(expected.bin)) fail("native_delivery_build_unverified");
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
