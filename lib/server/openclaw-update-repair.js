const crypto = require("crypto");
const path = require("path");
const { kOpenclawApplyTimeoutMs } = require("./constants");
const { kGatewayMutationIntents } = require("./gateway-mutation-policy");
const { createRepairOperation, kRepairCleanupAllowanceMs, kRepairKillGraceMs } = require("./repair-operation");

// Dev repair mutates the installed checkout and configuration in place. Its
// latch, lifecycle lease, durable run and subprocess must describe ONE owner.
const createOpenclawUpdateRepair = ({
  getChannelInfo, isOnboarded, isSelfUpdateInProgress,
  isApplyInProgress, setApplyInProgress, getActiveGatewayOperation,
  acquireLifecycleLock, mutationPolicy, ledger, runner, devUpdateEnv,
  stepRecorder, makeOutputPublisher, setActiveSink, operationEvents,
  watchdogManagedOperation, channelError, rootDir, log,
  budgetMs = kOpenclawApplyTimeoutMs,
}) => {
  const failure = (code, message, hint = null, status = 409, extra = null) => ({
    status, body: channelError(code, message, hint, null, extra),
  });
  const fromError = (error) => error?.blocked
    ? failure(error.code || "gateway_held", error.error || error.message,
        error.hint || null, error.statusCode || 409,
        error.hold ? { hold: error.hold } : null)
    : failure(error?.code === "operation_timed_out" || error?.code === "operation_cancelled"
        ? error.code : "repair_failed", "OpenClaw repair did not complete.",
      error?.message ? `Details: ${String(error.message).slice(-400)}` : null, 500);

  const admissionFailure = (hold = null) => {
    if (!hold && isApplyInProgress()) {
      return failure("operation_in_progress", "Another OpenClaw update or backup is already running.",
        "Wait for it to finish — progress is on the Upgrade page.");
    }
    if (!hold) {
      const active = getActiveGatewayOperation?.();
      if (active) {
        const migration = active.kind === "boot" || active.kind === "reconcile_retry";
        return failure(migration ? "gateway_busy" : "gateway_operation_in_progress",
          migration ? "A settings migration is running — repair cannot start until it finishes."
            : "A gateway operation is in progress.",
          "Wait for the current operation to finish, then retry.");
      }
    }
    if (!isOnboarded()) {
      return failure("not_onboarded", "Finish onboarding before repairing OpenClaw.");
    }
    if (isSelfUpdateInProgress()) {
      return failure("self_update_in_progress", "An AlphaClaw update is installing or a provider deployment remains unresolved.",
        "Wait for the update to finish, or check the provider and resolve its deployment attempt on the Upgrade page before retrying repair.");
    }
    mutationPolicy.assert({ preLock: !hold, hold, intent: kGatewayMutationIntents.repair });
    const info = getChannelInfo();
    if (info.releaseChannel !== "dev" && info.applied?.channel !== "dev") {
      return failure("repair_not_applicable", "Repair only applies to dev builds from source.",
        "For stable or beta, re-apply the version from the catalog instead — AlphaClaw owns those installs and re-staging replaces the whole tree.");
    }
    return null;
  };

  return async ({ operationId = null } = {}) => {
    try {
      const blocked = admissionFailure();
      if (blocked) return blocked;
    } catch (error) {
      return fromError(error);
    }
    // Synchronous admission closes the second-click gap before lock.acquire's
    // microtask turn. Every subsequent exit releases this latch in finally.
    setApplyInProgress(true);
    if (!operationId) operationId = crypto.randomUUID();
    let hold = null;
    let sink = null;
    let createdRun = false;
    let steps = [];
    let result;
    const operation = createRepairOperation({
      isCurrent: () => isApplyInProgress() && (!hold || hold.isValid()),
    });
    try {
      hold = await acquireLifecycleLock("update_repair", {
        leaseMs: budgetMs + kRepairCleanupAllowanceMs,
        cleanup: operation.cleanup,
      });
      operation.start(budgetMs);
      const blocked = admissionFailure(hold);
      if (blocked) {
        result = blocked;
      } else {
        operation.assertActive();
        // Unlike informational logging, a missing run record refuses the
        // writer: the UI must be able to recover this operation after reload.
        try {
          ledger.createRun({ operationId, target: { channel: "dev", repair: true } });
          createdRun = true;
        } catch (error) {
          log(`repair run ledger unavailable: ${error.message}`);
          result = failure("run_ledger_unavailable", "Repair could not save its operation record.",
            "Check available disk space and permissions, then retry.", 503);
        }
        if (createdRun) {
          try { watchdogManagedOperation?.begin?.(); } catch {}
          sink = ledger.createLogSink({ operationId, extraSecretEnv: devUpdateEnv() });
          setActiveSink(sink);
          sink.writeLine(`[openclaw-update] repair ${operationId} started`);
          const recorder = stepRecorder(operationId, sink, { mirrorLastUpdateRun: false });
          steps = recorder.steps;
          const output = makeOutputPublisher(operationId);
          recorder.emit("repair", "running", { detail: "openclaw update repair" });
          const run = await operation.runWriter(() => {
            const blockedBeforeDispatch = admissionFailure(hold);
            if (blockedBeforeDispatch) {
              result = blockedBeforeDispatch;
              return null;
            }
            return runner.runStreamed({
              command: "openclaw", args: ["update", "repair"], env: devUpdateEnv(),
              timeoutMs: budgetMs, deadlineAt: operation.deadlineAt,
              killGraceMs: kRepairKillGraceMs,
              signal: operation.signal, onProcess: operation.noteProcess,
              logFile: path.join(rootDir, "logs", "openclaw-dev-update.log"),
              onOutput: output, tailBytes: 512 * 1024,
            });
          });
          output.flush();
          operation.assertActive();
          mutationPolicy.assert({ hold, intent: kGatewayMutationIntents.repair });
          if (run) {
            recorder.emit("repair", run.ok ? "completed" : "failed",
              run.ok ? {} : { tail: run.tail?.slice(-2000) });
            // Preserve upstream's supervisor-mode refusal; never remove the
            // external supervisor flag to make the command proceed.
            result = run.ok ? { status: 200, body: { ok: true } }
              : failure("repair_failed", "OpenClaw repair did not complete.",
                run.tail ? `OpenClaw said: ${run.tail.slice(-400)}`
                  : "Check the raw log, then retry or re-apply a version from the catalog.", 500);
          }
        }
      }
    } catch (error) {
      result = fromError(error);
    } finally {
      // A cancelled subprocess and its restore guard settle before another
      // operation can acquire the lease or observe the apply latch as clear.
      await operation.cleanup.wait();
      if (sink) {
        try { await sink.close(); } catch (error) { log(`repair log close failed: ${error.message}`); }
      }
      setActiveSink(null);
      if (hold) await hold();
      setApplyInProgress(false);
      if (createdRun) {
        try { watchdogManagedOperation?.end?.(); } catch {}
      }
    }
    const body = { ...result.body, steps };
    if (createdRun) {
      try {
        ledger.completeRun(operationId, {
          state: body.ok ? "completed" : "failed", ok: Boolean(body.ok),
          result: body.ok ? { ok: true } : {
            ok: false, code: body.code, message: body.message,
            hint: body.hint ?? null, docsUrl: body.docsUrl ?? null,
          },
        });
      } catch (error) { log(`repair run completion unavailable: ${error.message}`); }
    }
    try {
      if (body.ok) operationEvents?.complete(operationId, body);
      else operationEvents?.fail(operationId, Object.assign(new Error(body.message), {
        code: body.code, hint: body.hint, docsUrl: body.docsUrl,
      }));
    } catch (error) { log(`repair stream completion unavailable: ${error.message}`); }
    return { status: result.status, body };
  };
};

module.exports = { createOpenclawUpdateRepair };
