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
const { cancellationError, kRepairKillGraceMs } = require("./repair-operation");
const { redactLine, collectSecretValues } = require("./utils/redact");
const { createDoctorOutputFacts, summarizeDoctorResult } = require("./doctor-outcome");
const { recordDoctorCompletedForPin, recordDoctorOutcome } = require("./openclaw-boot-migration");
const { createDoctorTranscript } = require("./doctor-transcript");

const kDoctorFixTimeoutMs = 10 * 60 * 1000;
// Bug #137: on the incident box `doctor --fix` under the watchdog's repair
// printed nothing for minutes and the operator could not tell a hung Doctor
// from a slow one. An independent heartbeat logs elapsed time, seconds since
// the last output and the redacted last line every 30 s while doctor runs.
const kDoctorHeartbeatMs = 30_000;
// A trailing line with no newline yet is carried into the next chunk; a
// runaway single line (progress bar, minified dump) is capped at 4 KB, head
// dropped, so the buffer cannot grow with the run.
const kDoctorPartialLineCapBytes = 4096;

const formatDoctorHeartbeatLine = ({ elapsedMs, sinceOutputMs, lastLine }) =>
  `[alphaclaw] doctor heartbeat elapsed=${Math.round(elapsedMs / 1000)}s sinceOutput=${Math.round(sinceOutputMs / 1000)}s last=${JSON.stringify(lastLine || "-")}`;

// Tracks the last complete non-empty output line across chunk boundaries so
// the heartbeat (and a failed run's result) can name what doctor last said.
const createOutputLineTracker = ({ nowFn, startedAt }) => {
  let partial = "";
  let lastLine = null;
  let lastOutputAt = startedAt;
  const onOutput = (chunkText) => {
    lastOutputAt = nowFn();
    const lines = `${partial}${String(chunkText ?? "")}`.split("\n");
    partial = lines.pop();
    if (partial.length > kDoctorPartialLineCapBytes) {
      partial = partial.slice(-kDoctorPartialLineCapBytes);
    }
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].trim()) {
        lastLine = lines[i];
        break;
      }
    }
  };
  return {
    onOutput,
    lastOutputAgeMs: () => Math.max(0, nowFn() - lastOutputAt),
    lastLine: () => (lastLine == null
      ? null
      : redactLine(lastLine, { secrets: collectSecretValues({ env: process.env }) }) || null),
  };
};

const createDoctorFixRunner = ({
  openclawDir,
  doctorGuard,
  runStream,
  gatewayEnv,
  notifier,
  // Every run's outcome lands in <managedDir>/openclaw-boot-migration.json
  // (lastOutcome), and a run that completes for the pinned version clears
  // the boot's remembered failure, whichever caller ran it.
  managedDir = null,
  getOpenclawVersion = () => null,
  fsModule = fs,
  nowFn = Date.now,
  logger = console,
}) => {
  const recordOutcome = ({ result, source, startedAt }) => {
    if (!managedDir) return;
    const openclawVersion = getOpenclawVersion() || null;
    const summary = summarizeDoctorResult(result, { secrets: collectSecretValues({ env: gatewayEnv() }) });
    try {
      recordDoctorOutcome({
        managedDir,
        fsModule,
        outcome: {
          status: summary.status,
          class: summary.class,
          reason: summary.reason,
          detail: summary.detail,
          captureState: summary.captureState,
          captureCause: summary.captureCause,
          ...(summary.bridgeVersion ? { bridgeVersion: summary.bridgeVersion } : {}),
          openclawVersion,
          source,
          durationMs: Math.max(0, nowFn() - startedAt),
          at: nowFn(),
        },
      });
      if (summary.status === "ok" && openclawVersion) {
        recordDoctorCompletedForPin({ managedDir, version: openclawVersion, fsModule, nowFn });
      }
    } catch (error) {
      logger.warn?.(`[alphaclaw] could not record the doctor --fix outcome: ${error.message}`);
    }
  };
  const runStreamedDoctorFix = async ({
    timeoutMs = kDoctorFixTimeoutMs,
    signal = null,
    deadlineAt = null,
    operation = null,
    source = "repair",
    // ({ elapsedMs, sinceOutputMs }) on every heartbeat: Retry upgrade keeps
    // its operation record alive and shows "no output for 2m" from it.
    onProgress = null,
    // Called on every output chunk (no content): the boot timeline's proof
    // of life while a long Doctor runs.
    onActivity = null,
  } = {}) => {
    signal = operation?.signal || signal;
    deadlineAt = operation?.deadlineAt ?? deadlineAt;
    const assertActive = () => {
      operation?.assertActive();
      if (signal?.aborted) throw cancellationError(signal);
      if (deadlineAt != null && nowFn() >= deadlineAt) {
        throw cancellationError({ reason: "deadline" });
      }
    };
    const execute = async () => {
    assertActive();
    // Rolling pre-doctor backup — best-effort: a missing config is exactly
    // the case doctor --fix can regenerate, and must never abort the run.
    try {
      fsModule.copyFileSync(
        path.join(openclawDir, "openclaw.json"),
        path.join(openclawDir, "openclaw.json.pre-doctor.bak"),
      );
    } catch {}
    const startedAt = nowFn();
    const output = createOutputLineTracker({ nowFn, startedAt });
    const facts = createDoctorOutputFacts();
    const transcript = managedDir
      ? createDoctorTranscript({
          managedDir,
          fsModule,
          logger,
          secrets: collectSecretValues({ env: gatewayEnv() }),
          header: `openclaw doctor --fix — source ${source}, OpenClaw ${getOpenclawVersion() || "unknown"}, started ${new Date(startedAt).toISOString()}`,
        })
      : null;
    transcript?.flush();
    const onOutput = (chunkText, streamName) => {
      output.onOutput(chunkText);
      facts.onOutput(chunkText, streamName);
      transcript?.onOutput(chunkText, streamName);
      try {
        onActivity?.();
      } catch {}
    };
    const finishTranscript = (result) =>
      transcript?.flush({
        footer: `[finished ${new Date(nowFn()).toISOString()} after ${Math.round((nowFn() - startedAt) / 1000)}s: ${result.ok ? "ok" : `failed (${result.code ?? result.signal ?? "no exit code"})`}]`,
      });
    // Independent of the run-stream's own stall/timeout machinery: it never
    // keeps the process alive (unref) and the finally clears it on EVERY
    // settle — ok, fail, timeout, cancel or a thrown run.
    const heartbeat = setInterval(() => {
      logger.log(formatDoctorHeartbeatLine({
        elapsedMs: nowFn() - startedAt,
        sinceOutputMs: output.lastOutputAgeMs(),
        lastLine: output.lastLine(),
      }));
      transcript?.flush();
      try {
        onProgress?.({ elapsedMs: nowFn() - startedAt, sinceOutputMs: output.lastOutputAgeMs() });
      } catch {}
    }, kDoctorHeartbeatMs);
    heartbeat.unref?.();
    let guarded;
    try {
      guarded = await doctorGuard.withDoctorRestoreGuard({
        run: () => {
          assertActive();
          return runStream.runStreamed({
            command: "openclaw",
            args: ["doctor", "--fix", "--yes"],
            env: gatewayEnv(),
            timeoutMs,
            killGraceMs: kRepairKillGraceMs,
            onOutput,
            ...(signal ? { signal } : {}),
            ...(deadlineAt != null ? { deadlineAt } : {}),
            ...(operation ? { onProcess: operation.noteProcess } : {}),
          });
        },
      });
    } finally {
      clearInterval(heartbeat);
    }
    if (guarded.code === "doctor_restored_stale_config") {
      notifier.notify(
        buildDoctorRestoreBlockedNotification(guarded.droppedKeyPaths.length),
        { eventType: "health", id: `doctor-restore-blocked-${nowFn()}` },
      );
      const blocked = {
        ok: false,
        stdout: "",
        stderr: `doctor --fix attempted a stale last-known-good restore (${guarded.signals.join(", ")}); AlphaClaw reverted it`,
        code: "doctor_restored_stale_config",
      };
      finishTranscript(blocked);
      recordOutcome({ result: blocked, source, startedAt });
      return blocked;
    }
    const result = {
      ok: !!guarded.ok,
      stdout: guarded.tail,
      stderr: guarded.timedOut ? "doctor --fix timed out after 10m" : "",
      code: guarded.code,
      ...(guarded.cancelled ? { cancelled: true, stderr: "doctor --fix cancelled", code: "operation_cancelled" } : {}),
      ...(guarded.timedOut ? { timedOut: true, stderr: `doctor --fix timed out after ${timeoutMs % 60_000 === 0 ? `${timeoutMs / 60_000}m` : `${Math.ceil(timeoutMs / 1000)}s`}` } : {}),
      // A failed/hung run carries what the heartbeat saw so the watchdog's
      // repair-failure row can name it; a success needs no hang diagnostics.
      ...(guarded.ok ? {} : { lastOutputAgeMs: output.lastOutputAgeMs(), lastOutputLine: output.lastLine() }),
      ...(guarded.signal ? { signal: guarded.signal } : {}),
      facts: facts.snapshot(),
    };
    finishTranscript(result);
    recordOutcome({ result, source, startedAt });
    return result;
    };
    return operation ? operation.runWriter(execute) : execute();
  };
  return runStreamedDoctorFix;
};

module.exports = {
  createDoctorFixRunner,
  createOutputLineTracker,
  kDoctorHeartbeatMs,
  kDoctorPartialLineCapBytes,
};
