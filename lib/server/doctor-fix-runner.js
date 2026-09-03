// Streamed `openclaw doctor --fix` runner shared by the watchdog's
// auto-repair and the startup medic (lib/server.js wires it). Spawn-based (no
// shell, no 1MB maxBuffer), 10min ceiling, output tail captured — a real
// repair can actually finish instead of being SIGTERM'd at clawCmd's 15s
// default and parking the watchdog.
//
// Issue #20 bug 3: EVERY doctor --fix runs inside the restore guard — the
// last-known-good file is quarantined for the duration (doctor cannot
// silently swap in a stale config) and tripwires revert any restore that
// slips through another path. A rolling pre-doctor backup covers the
// watchdog repair path, which previously ran doctor with no backup at all.

const fs = require("fs");
const path = require("path");

const { buildDoctorRestoreBlockedNotification } = require("./doctor-guard");

const kDoctorFixTimeoutMs = 10 * 60 * 1000;

const createDoctorFixRunner = ({
  openclawDir,
  doctorGuard,
  runStream,
  gatewayEnv,
  notifier,
  fsModule = fs,
  nowFn = Date.now,
}) => {
  const runStreamedDoctorFix = async ({ timeoutMs = kDoctorFixTimeoutMs } = {}) => {
    // Rolling pre-doctor backup — best-effort: a missing config is exactly
    // the case doctor --fix can regenerate, and must never abort the run.
    try {
      fsModule.copyFileSync(
        path.join(openclawDir, "openclaw.json"),
        path.join(openclawDir, "openclaw.json.pre-doctor.bak"),
      );
    } catch {}
    const guarded = await doctorGuard.withDoctorRestoreGuard({
      run: () =>
        runStream.runStreamed({
          command: "openclaw",
          args: ["doctor", "--fix", "--yes"],
          env: gatewayEnv(),
          timeoutMs,
        }),
    });
    if (guarded.code === "doctor_restored_stale_config") {
      notifier.notify(
        buildDoctorRestoreBlockedNotification(guarded.droppedKeyPaths.length),
        { eventType: "health", id: `doctor-restore-blocked-${nowFn()}` },
      );
      return {
        ok: false,
        stdout: "",
        stderr: `doctor --fix attempted a stale last-known-good restore (${guarded.signals.join(", ")}); AlphaClaw reverted it`,
        code: "doctor_restored_stale_config",
      };
    }
    return {
      ok: !!guarded.ok,
      stdout: guarded.tail,
      stderr: guarded.timedOut ? "doctor --fix timed out after 10m" : "",
      code: guarded.code,
    };
  };
  return runStreamedDoctorFix;
};

module.exports = { createDoctorFixRunner };
