// Post-relaunch wedge sweep (ALPH-17 PR 6): a safety net after every gateway
// relaunch (an AlphaClaw restart, a crash or OOM relaunch, a boot).
//
// OpenClaw 2026.10.5+ fixed the session wedge of the Oct 18/22 incidents
// upstream: a running session is no longer persisted as `running`, killed runs
// are normalized to `interrupted` at boot and its recovery owner resumes them.
// One case is still open upstream: a channel session whose interrupted turn is
// never resumed keeps refusing new messages. This sweep only looks through
// OpenClaw's supported read path (`sessions.list`: hasActiveRun,
// abortedLastRun, restartRecoveryStatus) and only clears through
// `sessions.recover`, where OpenClaw itself decides whether the session
// qualifies. Everything else is an alert to the admin targets. It never
// resets a session (that drops its context) and never reads SQLite.
//
// One loss OpenClaw cannot recover (ALPH-19): an exec still running after
// its yield window (at most 120 s) moves to a background process session and
// the turn ends. OpenClaw keeps those sessions in memory only, so a restart
// that stops the gateway before the command finishes loses it and its
// completion wake: no session is marked interrupted and nothing resumes.
// OpenClaw's own drain report (`... backgroundExecSessions=N` on its
// "draining active work before restart" lines) is the only place that count
// appears, so during an AlphaClaw restart the sweep reads it from the
// gateway output and tells the owner once after the relaunch.
const { probeGatewayReadiness } = require("./gateway-readiness");
const { kGatewayRestartReadyTimeoutMs } = require("./constants");
const { sanitizeLabel } = require("./utils/sanitize-label");
const { shellEscapeArg } = require("./agents/shared");

const kSettleAfterReadyMs = 90_000;
const kReadyPollMs = 5_000;
const kRecordTtlMs = 30 * 60 * 1000;
const kRecentWindowMs = 15 * 60 * 1000;
const kListActiveMinutes = 60;
const kListLimit = 200;
const kMaxRecoverAttempts = 10;
const kCliTimeoutMs = 20_000;
// sessions.recover answers INVALID_REQUEST with one of these when the session
// has nothing to recover: the normal case for a turn that finished cleanly.
const kNothingToRecoverPattern = /requires a restart-tombstoned session|Session is not recoverable/i;

const kDrainReportPattern = /draining active work before restart|restart drain budget \S+ exhausted; cutting short/;
const kDrainedPattern = /all active work drained/;
const kBackgroundExecPattern = /\bbackgroundExecSessions=(\d+)/;
const kMaxOutputCarry = 4096;

const kWedgeReasons = Object.freeze({
  NOT_RESUMED: "not_resumed",
  RECOVERY_GAVE_UP: "recovery_gave_up",
});

const kReasonCopy = {
  [kWedgeReasons.NOT_RESUMED]: "its interrupted turn was not resumed",
  [kWedgeReasons.RECOVERY_GAVE_UP]: "OpenClaw gave up resuming it",
};

const parseJson = (text) => {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return null;
  }
};

const callGateway = async (clawCmd, method, params) => {
  const result = await clawCmd(
    `gateway call ${shellEscapeArg(method)} --params ${shellEscapeArg(JSON.stringify(params))} --json`,
    { quiet: true, timeoutMs: kCliTimeoutMs },
  );
  return { ok: !!result?.ok, body: parseJson(result?.stdout), stderr: String(result?.stderr || "") };
};

// One sweep: which sessions still look stuck after the relaunch settled.
// recorded: keys OpenClaw reported running right before the restart.
// A session with live work is never touched.
const classifySessions = ({ rows = [], recorded = new Map(), launchAtMs, nowMs }) => {
  const recoverable = [];
  const wedged = [];
  for (const row of rows) {
    if (!row || typeof row.key !== "string" || row.hasActiveRun === true) continue;
    const wasRecorded = recorded.has(row.key);
    const updatedAt = Number(row.updatedAt);
    const recent = Number.isFinite(updatedAt) && updatedAt >= launchAtMs - kRecentWindowMs && updatedAt <= nowMs;
    if (!wasRecorded && !recent) continue;
    if (row.restartRecoveryStatus === "tombstoned") wedged.push({ row, reason: kWedgeReasons.RECOVERY_GAVE_UP, wasRecorded });
    else if (row.abortedLastRun === true) wedged.push({ row, reason: kWedgeReasons.NOT_RESUMED, wasRecorded });
    else if (wasRecorded) recoverable.push({ row, wasRecorded });
  }
  return { recoverable, wedged };
};

const createSessionWedgeSweep = ({
  clawCmd,
  notify = null,
  insertEvent = null,
  resolveReadyzUrl = () => "",
  probeReadiness = probeGatewayReadiness,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
  now = () => Date.now(),
  settleAfterReadyMs = kSettleAfterReadyMs,
  readyTimeoutMs = kGatewayRestartReadyTimeoutMs,
} = {}) => {
  let recorded = new Map();
  let recordedAtMs = 0;
  let jobSeq = 0;
  let pendingJob = null;
  // Set when a restart is requested: the last background exec count OpenClaw
  // reported while draining for it. Taken by the next launch.
  let drainWatch = null;
  let outputCarry = "";
  let stoppedExec = null;
  const alerted = new Set();

  const log = (line) => console.log(`[alphaclaw] wedge-sweep ${line}`);
  const record = (status, details) => {
    try {
      insertEvent?.({ eventType: "session_wedge", source: "wedge_sweep", status, details });
    } catch {}
  };

  // Called when a restart is requested, while the gateway still admits work
  // (OpenClaw refuses reads once it drains). Best effort: a failed read only
  // means the sweep falls back to the recent-activity window.
  const recordRunningSessions = async ({ opId = null } = {}) => {
    drainWatch = { opId, backgroundExec: 0 };
    outputCarry = "";
    try {
      const { ok, body } = await callGateway(clawCmd, "sessions.list", { activeOnly: true, limit: kListLimit, rowMode: "compact" });
      if (!ok || !Array.isArray(body?.sessions)) {
        log(`record skipped op=${opId ? String(opId).slice(0, 8) : "-"} reason=read_failed`);
        return 0;
      }
      const next = new Map();
      for (const row of body.sessions) {
        if (row?.hasActiveRun === true && typeof row.key === "string") next.set(row.key, { agentId: row.agentId || null });
      }
      recorded = next;
      recordedAtMs = now();
      log(`recorded op=${opId ? String(opId).slice(0, 8) : "-"} running=${next.size}`);
      return next.size;
    } catch {
      return 0;
    }
  };

  const observeGatewayOutput = (text) => {
    if (!drainWatch) return;
    const lines = (outputCarry + String(text ?? "")).split("\n");
    outputCarry = lines.pop().slice(-kMaxOutputCarry);
    for (const line of lines) {
      if (kDrainedPattern.test(line)) drainWatch.backgroundExec = 0;
      else if (kDrainReportPattern.test(line)) drainWatch.backgroundExec = Number(kBackgroundExecPattern.exec(line)?.[1] || 0);
    }
  };

  const tellStoppedExec = async ({ generation }) => {
    const { count, opId } = stoppedExec;
    stoppedExec = null;
    const commands = count === 1 ? "1 command" : `${count} commands`;
    log(`exec-stopped generation=${generation ?? "-"} op=${opId ? String(opId).slice(0, 8) : "-"} count=${count}`);
    record("exec_stopped", { count, generation, opId: opId || null });
    if (typeof notify !== "function") return;
    try {
      await notify(
        [
          "🐺 *AlphaClaw Watchdog*",
          `⚠️ The gateway restart stopped ${commands} the agent was running in the background.`,
          "OpenClaw does not keep background commands across a restart, so the agent was not told and will not pick that work up on its own.",
          "If it mattered, ask the agent to check what it was running and start it again.",
        ].join("\n"),
        { eventType: "session_wedge", id: `exec-stopped-${generation ?? Date.now()}` },
      );
    } catch {}
  };

  const takeRecorded = () => {
    const taken = recordedAtMs && now() - recordedAtMs <= kRecordTtlMs ? recorded : new Map();
    recorded = new Map();
    recordedAtMs = 0;
    return taken;
  };

  const sweep = async ({ generation = null, launchAtMs, recordedKeys, isCurrent = () => true }) => {
    const { ok, body } = await callGateway(clawCmd, "sessions.list", {
      activeMinutes: kListActiveMinutes,
      limit: kListLimit,
      rowMode: "compact",
    });
    if (!isCurrent()) return { skipped: "superseded" };
    if (!ok || !Array.isArray(body?.sessions)) {
      log(`skipped generation=${generation ?? "-"} reason=read_failed`);
      return { skipped: "read_failed" };
    }
    const { recoverable, wedged } = classifySessions({ rows: body.sessions, recorded: recordedKeys, launchAtMs, nowMs: now() });
    const recovered = [];
    for (const { row } of recoverable.slice(0, kMaxRecoverAttempts)) {
      if (!isCurrent()) return { skipped: "superseded" };
      const agentId = row.agentId || recordedKeys.get(row.key)?.agentId || undefined;
      const result = await callGateway(clawCmd, "sessions.recover", { key: row.key, ...(agentId ? { agentId } : {}) });
      if (result.ok && result.body?.ok !== false) {
        recovered.push(row);
        log(`recovered session=${sanitizeLabel(row.key, { maxLength: 120 })} generation=${generation ?? "-"}`);
        record("recovered", { sessionKey: row.key, agentId: agentId || null, generation });
        continue;
      }
      const message = String(result.body?.error?.message || result.stderr || "");
      if (kNothingToRecoverPattern.test(message)) continue;
      log(`recover failed session=${sanitizeLabel(row.key, { maxLength: 120 })} error=${sanitizeLabel(message, { maxLength: 160 })}`);
      record("failed", { sessionKey: row.key, agentId: agentId || null, generation, error: sanitizeLabel(message, { maxLength: 240 }) });
    }
    const fresh = wedged.filter(({ row }) => !alerted.has(`${row.key}|${row.sessionId || ""}|${row.updatedAt ?? ""}`));
    for (const { row, reason, wasRecorded } of fresh) {
      alerted.add(`${row.key}|${row.sessionId || ""}|${row.updatedAt ?? ""}`);
      log(`alerted session=${sanitizeLabel(row.key, { maxLength: 120 })} reason=${reason} generation=${generation ?? "-"}`);
      record("alerted", { sessionKey: row.key, agentId: row.agentId || null, reason, generation, recorded: wasRecorded });
    }
    if (fresh.length && typeof notify === "function") {
      const lines = fresh.map(({ row, reason }) =>
        `• ${sanitizeLabel(row.displayName || row.label || row.key, { maxLength: 80 })}: ${kReasonCopy[reason]}`);
      try {
        await notify(
          [
            "🐺 *AlphaClaw Watchdog*",
            `⚠️ ${fresh.length === 1 ? "A session" : `${fresh.length} sessions`} may be stuck after the gateway restarted:`,
            ...lines,
            "New messages there can fail until it is cleared. Open the session in the Control UI and send a message, or start over with /new (that drops its context).",
          ].join("\n"),
          { eventType: "session_wedge", id: `session-wedge-${generation ?? launchAtMs}-${fresh.map(({ row }) => row.sessionId || row.key).join(",").slice(0, 120)}` },
        );
      } catch {}
    }
    log(`done generation=${generation ?? "-"} checked=${body.sessions.length} recorded=${recordedKeys.size} recovered=${recovered.length} alerted=${fresh.length}`);
    return { recovered: recovered.map((row) => row.key), alerted: fresh.map(({ row }) => row.key) };
  };

  // Every launch (restart, crash relaunch, boot) schedules one sweep once the
  // new gateway is ready and has had time to resume interrupted work. A newer
  // launch supersedes a pending one. A managed cold restart notifies its
  // launch twice (the "listening" line, then /readyz ready): the second
  // notice for a generation already pending joins that sweep, so the
  // sessions recorded at the restart request are not dropped.
  const onGatewayLaunch = ({ generation = null, startedAt = null } = {}) => {
    if (generation != null && pendingJob?.seq === jobSeq && pendingJob.generation === generation) {
      return pendingJob.promise;
    }
    const seq = ++jobSeq;
    const isCurrent = () => seq === jobSeq;
    const launchAtMs = Number.isFinite(Number(startedAt)) ? Number(startedAt) : now();
    const recordedKeys = takeRecorded();
    if (drainWatch) {
      if (drainWatch.backgroundExec > 0) stoppedExec = { count: drainWatch.backgroundExec, opId: drainWatch.opId };
      drainWatch = null;
      outputCarry = "";
    }
    const promise = (async () => {
      const deadline = now() + readyTimeoutMs;
      for (;;) {
        if (!isCurrent()) return { skipped: "superseded" };
        const observation = await probeReadiness({ url: resolveReadyzUrl() }).catch(() => null);
        if (observation?.ok && observation.kind === "ready") break;
        if (now() >= deadline) {
          log(`skipped generation=${generation ?? "-"} reason=not_ready`);
          return { skipped: "not_ready" };
        }
        await sleep(kReadyPollMs);
      }
      if (stoppedExec && isCurrent()) await tellStoppedExec({ generation });
      await sleep(settleAfterReadyMs);
      if (!isCurrent()) return { skipped: "superseded" };
      return sweep({ generation, launchAtMs, recordedKeys, isCurrent });
    })().catch((error) => {
      log(`failed generation=${generation ?? "-"} error=${sanitizeLabel(error?.message || error, { maxLength: 160 })}`);
      return { skipped: "error" };
    });
    pendingJob = { seq, generation, promise };
    return promise;
  };

  return { recordRunningSessions, observeGatewayOutput, onGatewayLaunch, sweep };
};

module.exports = { createSessionWedgeSweep, classifySessions, kWedgeReasons };
