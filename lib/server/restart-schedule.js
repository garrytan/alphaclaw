// "Restart at <time>": one pending gateway restart an operator scheduled for
// later (a quiet hour), persisted by the restart-required store and run
// through the same restart path as POST /api/gateway/restart. The store drops
// the schedule when the pending reasons clear; this module owns the timer.

const kScheduledRestartSource = "api:scheduled_restart";
const kRestartScheduleMaxAheadMs = 7 * 24 * 60 * 60 * 1000;
// A refused attempt (another operation running, AlphaClaw still booting) is
// retried every minute; past this window after the chosen time the restart is
// skipped, so a schedule missed while AlphaClaw was down never fires at a
// busy hour.
const kRestartScheduleRetryMs = 60 * 1000;
const kRestartScheduleRetryWindowMs = 15 * 60 * 1000;

const parseScheduleTime = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const validateScheduleTime = (value, { nowMs, maxAheadMs = kRestartScheduleMaxAheadMs }) => {
  const at = parseScheduleTime(value);
  if (at == null) {
    return { ok: false, code: "invalid_time", error: "Pick a valid time for the restart." };
  }
  if (at <= nowMs) {
    return { ok: false, code: "time_in_past", error: "That time has already passed. Pick a later time." };
  }
  if (at - nowMs > maxAheadMs) {
    return { ok: false, code: "time_too_far", error: "Pick a time within the next 7 days." };
  }
  return { ok: true, at };
};

const formatScheduledFor = (at) => new Date(at).toISOString();

const createRestartScheduler = ({
  restartRequiredState,
  // ({ schedule }) → { started: true, operationId } | { started: false, code }
  startRestart,
  // ({ code, scheduledFor }) → void: books a skipped scheduled restart.
  recordSkipped = () => {},
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  retryMs = kRestartScheduleRetryMs,
  retryWindowMs = kRestartScheduleRetryWindowMs,
  logger = console,
}) => {
  let timer = null;

  const disarm = () => {
    if (timer) clearTimer(timer);
    timer = null;
  };

  const skip = (schedule, code) => {
    restartRequiredState.clearRestartSchedule();
    logger.warn(`[alphaclaw] scheduled restart skipped scheduledFor=${formatScheduledFor(schedule.at)} reason=${code}`);
    try {
      recordSkipped({ code, scheduledFor: schedule.at });
    } catch {}
  };

  const fire = () => {
    timer = null;
    const schedule = restartRequiredState.getRestartSchedule();
    if (!schedule) return;
    const nowMs = now();
    if (schedule.at > nowMs) {
      startTimer(schedule.at - nowMs);
      return;
    }
    if (nowMs - schedule.at > retryWindowMs) {
      skip(schedule, "missed_window");
      return;
    }
    let result;
    try {
      result = startRestart({ schedule });
    } catch {
      result = { started: false, code: "start_failed" };
    }
    if (result?.started) {
      restartRequiredState.clearRestartSchedule();
      logger.log(
        `[alphaclaw] scheduled restart started scheduledFor=${formatScheduledFor(schedule.at)} op=${String(result.operationId || "").slice(0, 8)}`,
      );
      return;
    }
    logger.warn(
      `[alphaclaw] scheduled restart refused scheduledFor=${formatScheduledFor(schedule.at)} code=${result?.code || "unknown"} retryInSeconds=${Math.round(retryMs / 1000)}`,
    );
    startTimer(retryMs);
  };

  const startTimer = (delayMs) => {
    timer = setTimer(fire, Math.max(0, delayMs));
    timer?.unref?.();
  };

  // (Re)arms from the persisted schedule: at boot, and after every change.
  const arm = () => {
    disarm();
    const schedule = restartRequiredState.getRestartSchedule?.();
    if (schedule) startTimer(schedule.at - now());
  };

  const schedule = ({ at } = {}) => {
    const validation = validateScheduleTime(at, { nowMs: now() });
    if (!validation.ok) return { ...validation, status: 400 };
    const stored = restartRequiredState.setRestartSchedule({ at: validation.at });
    if (!stored) {
      return {
        ok: false,
        status: 409,
        code: "no_restart_required",
        error: "No gateway restart is pending, so there is nothing to schedule.",
      };
    }
    arm();
    logger.log(`[alphaclaw] scheduled restart set scheduledFor=${formatScheduledFor(stored.at)}`);
    return { ok: true, schedule: stored };
  };

  const cancel = () => {
    const existing = restartRequiredState.getRestartSchedule();
    restartRequiredState.clearRestartSchedule();
    disarm();
    if (existing) logger.log(`[alphaclaw] scheduled restart cancelled scheduledFor=${formatScheduledFor(existing.at)}`);
    return { cancelled: Boolean(existing) };
  };

  return { arm, schedule, cancel, stop: disarm };
};

module.exports = {
  createRestartScheduler,
  validateScheduleTime,
  kScheduledRestartSource,
  kRestartScheduleMaxAheadMs,
  kRestartScheduleRetryMs,
  kRestartScheduleRetryWindowMs,
};
