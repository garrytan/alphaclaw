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
const { readCompletedForVersion, recordDoctorCompletedForPin, recordDoctorOutcome } = require("./openclaw-boot-migration");
const { createDoctorTranscript } = require("./doctor-transcript");
const { createDoctorPhaseTracker } = require("./doctor-progress");

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

const formatDoctorHeartbeatLine = ({ elapsedMs, sinceOutputMs, lastLine, progress = null }) =>
  `[alphaclaw] doctor heartbeat elapsed=${Math.round(elapsedMs / 1000)}s sinceOutput=${Math.round(sinceOutputMs / 1000)}s last=${JSON.stringify(lastLine || "-")}` +
  (progress?.words ? ` progress=${JSON.stringify(progress.words)}` : "");

// OpenClaw's documented startup trace (docs/gateway/doctor/running.md):
// "[gateway] startup trace: <step> <ms>ms total=… start=…" on stderr for each
// Doctor phase and contribution check. Set on the Doctor child only (never the
// gateway's env), so every Doctor run says where its time went.
const kDoctorStartupTraceEnvKey = "OPENCLAW_GATEWAY_STARTUP_TRACE";
const kStartupTraceLinePattern = /startup trace: /;

// Tracks the last complete non-empty output line across chunk boundaries so
// the heartbeat can name what doctor last said. A failed run's result names
// the last line that is not a trace timing: OpenClaw prints the trace in a
// finally, after the line that explains the failure.
const createOutputLineTracker = ({ nowFn, startedAt }) => {
  let partial = "";
  let lastLine = null;
  let lastDetailLine = null;
  let lastOutputAt = startedAt;
  const onOutput = (chunkText) => {
    lastOutputAt = nowFn();
    const lines = `${partial}${String(chunkText ?? "")}`.split("\n");
    partial = lines.pop();
    if (partial.length > kDoctorPartialLineCapBytes) {
      partial = partial.slice(-kDoctorPartialLineCapBytes);
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      lastLine = line;
      if (!kStartupTraceLinePattern.test(line)) lastDetailLine = line;
    }
  };
  const redacted = (line) => (line == null
    ? null
    : redactLine(line, { secrets: collectSecretValues({ env: process.env }) }) || null);
  return {
    onOutput,
    lastOutputAgeMs: () => Math.max(0, nowFn() - lastOutputAt),
    lastLine: () => redacted(lastLine),
    lastDetailLine: () => redacted(lastDetailLine),
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
  // ({ phase, migrated, startedAtMs }) → { phase, words, doneBytes, totalBytes }
  // (doctor-progress.js): what Doctor is doing, read on every heartbeat.
  readProgress = null,
  // () → evaluateUpgradeDiskCheck(...) (upgrade-disk-check.js): consulted
  // only while the pin's data upgrade is still pending.
  checkUpgradeDisk = null,
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
          ...(summary.workspaceMove ? { workspaceMove: summary.workspaceMove } : {}),
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
    // ({ elapsedMs, sinceOutputMs, progress }) on every heartbeat: Retry
    // upgrade keeps its operation record alive and shows the phase from it,
    // the boot card shows it too.
    onProgress = null,
    // Called on every output chunk (no content): the boot timeline's proof
    // of life while a long Doctor runs.
    onActivity = null,
    // Adds --force: only "Confirm the workspace moved" passes it, after an
    // operator confirmed the move OpenClaw asked about (never automatic).
    force = false,
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
    // ALPH-23: while the pin's data upgrade is pending, Doctor backs up every
    // database before migrating. Without room for those backups it fills the
    // disk and fails with nothing migrated, so it is not started at all.
    // Every caller (boot, Retry upgrade, watchdog repair, medic) gets the same
    // refusal and records it like any other failed run.
    const disk = (() => {
      if (typeof checkUpgradeDisk !== "function" || !managedDir) return null;
      const installed = getOpenclawVersion() || null;
      if (!installed || readCompletedForVersion({ managedDir, fsModule }) === installed) return null;
      try {
        return checkUpgradeDisk();
      } catch (error) {
        logger.warn?.(`[alphaclaw] could not check free disk space before doctor --fix: ${error.message}`);
        return null;
      }
    })();
    for (const sentence of disk?.sentences || []) logger.warn?.(`[alphaclaw] doctor --fix (${source}): ${sentence}`);
    if (disk?.verdict === "refuse") {
      const refused = { ok: false, stdout: "", stderr: disk.sentences[0], code: "insufficient_disk" };
      recordOutcome({ result: refused, source, startedAt });
      return refused;
    }
    const output = createOutputLineTracker({ nowFn, startedAt });
    const facts = createDoctorOutputFacts({ env: gatewayEnv() });
    const phases = createDoctorPhaseTracker();
    const readHeartbeatProgress = () => {
      if (typeof readProgress !== "function") return null;
      try {
        return readProgress({ ...phases.snapshot(), startedAtMs: startedAt });
      } catch {
        return null;
      }
    };
    const transcript = managedDir
      ? createDoctorTranscript({
          managedDir,
          fsModule,
          logger,
          secrets: collectSecretValues({ env: gatewayEnv() }),
          header: `openclaw doctor --fix${force ? " --force" : ""} — source ${source}, OpenClaw ${getOpenclawVersion() || "unknown"}, started ${new Date(startedAt).toISOString()}`,
        })
      : null;
    transcript?.flush();
    const onOutput = (chunkText, streamName) => {
      output.onOutput(chunkText);
      phases.onOutput(chunkText);
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
      const progress = readHeartbeatProgress();
      logger.log(formatDoctorHeartbeatLine({
        elapsedMs: nowFn() - startedAt,
        sinceOutputMs: output.lastOutputAgeMs(),
        lastLine: output.lastLine(),
        progress,
      }));
      transcript?.flush();
      try {
        onProgress?.({ elapsedMs: nowFn() - startedAt, sinceOutputMs: output.lastOutputAgeMs(), progress });
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
            args: ["doctor", "--fix", ...(force ? ["--force"] : []), "--yes"],
            env: { ...gatewayEnv(), [kDoctorStartupTraceEnvKey]: "1" },
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
      ...(guarded.ok ? {} : { lastOutputAgeMs: output.lastOutputAgeMs(), lastOutputLine: output.lastDetailLine() }),
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
