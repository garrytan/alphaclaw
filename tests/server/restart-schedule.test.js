const fs = require("fs");
const os = require("os");
const path = require("path");

const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-restart-schedule-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;

const { createRestartRequiredState } = require("../../lib/server/restart-required-state");
const {
  createRestartScheduler,
  validateScheduleTime,
  kRestartScheduleMaxAheadMs,
  kRestartScheduleRetryMs,
  kRestartScheduleRetryWindowMs,
} = require("../../lib/server/restart-schedule");

const kHour = 60 * 60 * 1000;
const kNow = Date.parse("2026-10-25T20:00:00Z");

const makeStateDir = () => fs.mkdtempSync(path.join(kTempRoot, "store-"));

const makeStore = ({ stateDir = makeStateDir(), clock } = {}) =>
  createRestartRequiredState({
    isGatewayRunning: async () => true,
    flagStore: { read: () => null, write: () => {}, clear: () => {} },
    stateDir,
    now: () => clock.nowMs,
  });

// Hand-driven timers: the scheduler's only clock besides now().
const makeTimers = () => {
  const timers = [];
  const live = () => timers.filter((t) => !t.cleared && !t.fired);
  return {
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cleared = true;
    },
    live,
    fireNext: () => {
      const [timer] = live();
      timer.fired = true;
      timer.fn();
    },
  };
};

const kSilentLogger = { log: () => {}, warn: () => {} };

const makeScheduler = ({ store, clock, timers, startRestart, recordSkipped = vi.fn() }) =>
  createRestartScheduler({
    restartRequiredState: store,
    startRestart,
    recordSkipped,
    now: () => clock.nowMs,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    logger: kSilentLogger,
  });

afterAll(() => {
  fs.rmSync(kTempRoot, { recursive: true, force: true });
});

describe("server/restart-schedule validation", () => {
  it("accepts an ISO time or epoch ms within 7 days, refuses invalid, past and too-far times", () => {
    expect(validateScheduleTime(new Date(kNow + kHour).toISOString(), { nowMs: kNow })).toEqual({ ok: true, at: kNow + kHour });
    expect(validateScheduleTime(kNow + kHour, { nowMs: kNow })).toEqual({ ok: true, at: kNow + kHour });
    expect(validateScheduleTime("tomorrow-ish", { nowMs: kNow }).code).toBe("invalid_time");
    expect(validateScheduleTime(undefined, { nowMs: kNow }).code).toBe("invalid_time");
    expect(validateScheduleTime(kNow, { nowMs: kNow }).code).toBe("time_in_past");
    expect(validateScheduleTime(kNow - kHour, { nowMs: kNow }).code).toBe("time_in_past");
    expect(validateScheduleTime(kNow + kRestartScheduleMaxAheadMs, { nowMs: kNow }).ok).toBe(true);
    expect(validateScheduleTime(kNow + kRestartScheduleMaxAheadMs + 1, { nowMs: kNow }).code).toBe("time_too_far");
  });
});

describe("server/restart-required-state pending since", () => {
  it("keeps the first time a reason was recorded across repeats and a reload", async () => {
    const clock = { nowMs: kNow };
    const stateDir = makeStateDir();
    const store = makeStore({ stateDir, clock });
    store.markRequired("env_vars_changed");
    clock.nowMs = kNow + kHour;
    store.markRequired("env_vars_changed");
    const [entry] = (await store.getSnapshot()).reasons;
    expect(entry).toMatchObject({ code: "env_vars_changed", addedAt: kNow + kHour, since: kNow });
    const [reloaded] = (await makeStore({ stateDir, clock }).getSnapshot()).reasons;
    expect(reloaded).toMatchObject({ addedAt: kNow + kHour, since: kNow });
  });

  it("reads a reasons file written before `since` existed, falling back to addedAt", async () => {
    const stateDir = makeStateDir();
    fs.writeFileSync(
      path.join(stateDir, "alphaclaw-restart-reasons.json"),
      JSON.stringify({ reasons: [{ code: "config_file_edited", label: "Configuration file edited", addedAt: 1234 }] }),
    );
    const [entry] = (await makeStore({ stateDir, clock: { nowMs: kNow } }).getSnapshot()).reasons;
    expect(entry).toEqual({ code: "config_file_edited", label: "Configuration file edited", addedAt: 1234, since: 1234 });
  });
});

describe("server/restart-schedule scheduler", () => {
  it("refuses a schedule while no restart is pending", () => {
    const clock = { nowMs: kNow };
    const store = makeStore({ clock });
    const timers = makeTimers();
    const scheduler = makeScheduler({ store, clock, timers, startRestart: vi.fn() });
    expect(scheduler.schedule({ at: kNow + kHour })).toMatchObject({ ok: false, status: 409, code: "no_restart_required" });
    expect(scheduler.schedule({ at: kNow - 1 })).toMatchObject({ ok: false, status: 400, code: "time_in_past" });
    expect(store.getRestartSchedule()).toBeNull();
    expect(timers.live()).toHaveLength(0);
  });

  it("persists the schedule, re-arms it after a reload and starts the restart when due", async () => {
    const clock = { nowMs: kNow };
    const stateDir = makeStateDir();
    const store = makeStore({ stateDir, clock });
    store.markRequired("env_vars_changed");
    const first = makeScheduler({ store, clock, timers: makeTimers(), startRestart: vi.fn() });
    expect(first.schedule({ at: new Date(kNow + 3 * kHour).toISOString() })).toEqual({
      ok: true,
      schedule: { at: kNow + 3 * kHour, createdAt: kNow },
    });
    expect((await store.getSnapshot()).schedule).toEqual({ at: kNow + 3 * kHour, createdAt: kNow });
    first.stop();

    // AlphaClaw restarts an hour later: the new process re-arms from disk.
    clock.nowMs = kNow + kHour;
    const reloaded = makeStore({ stateDir, clock });
    const timers = makeTimers();
    const startRestart = vi.fn(() => ({ started: true, operationId: "op-scheduled" }));
    makeScheduler({ store: reloaded, clock, timers, startRestart }).arm();
    expect(timers.live().map((t) => t.ms)).toEqual([2 * kHour]);

    clock.nowMs = kNow + 3 * kHour;
    timers.fireNext();
    expect(startRestart).toHaveBeenCalledTimes(1);
    expect(startRestart.mock.calls[0][0].schedule.at).toBe(kNow + 3 * kHour);
    expect(reloaded.getRestartSchedule()).toBeNull();
    expect(fs.existsSync(path.join(stateDir, "alphaclaw-restart-schedule.json"))).toBe(false);
    expect(timers.live()).toHaveLength(0);
  });

  it("a timer that fires early (clock moved) re-arms for the rest instead of restarting", () => {
    const clock = { nowMs: kNow };
    const store = makeStore({ clock });
    store.markRequired("env_vars_changed");
    const timers = makeTimers();
    const startRestart = vi.fn(() => ({ started: true, operationId: "op" }));
    makeScheduler({ store, clock, timers, startRestart }).schedule({ at: kNow + kHour });
    clock.nowMs = kNow + kHour - 5000;
    timers.fireNext();
    expect(startRestart).not.toHaveBeenCalled();
    expect(timers.live().map((t) => t.ms)).toEqual([5000]);
  });

  it("retries a refused start every minute, then skips once the window has passed", () => {
    const clock = { nowMs: kNow };
    const store = makeStore({ clock });
    store.markRequired("env_vars_changed");
    const timers = makeTimers();
    const recordSkipped = vi.fn();
    const startRestart = vi.fn(() => ({ started: false, code: "operation_in_progress" }));
    makeScheduler({ store, clock, timers, startRestart, recordSkipped }).schedule({ at: kNow + kHour });

    clock.nowMs = kNow + kHour;
    timers.fireNext();
    expect(startRestart).toHaveBeenCalledTimes(1);
    expect(store.getRestartSchedule()).not.toBeNull();
    expect(timers.live().map((t) => t.ms)).toEqual([kRestartScheduleRetryMs]);

    startRestart.mockReturnValueOnce({ started: true, operationId: "op-late" });
    clock.nowMs += kRestartScheduleRetryMs;
    timers.fireNext();
    expect(startRestart).toHaveBeenCalledTimes(2);
    expect(store.getRestartSchedule()).toBeNull();
    expect(recordSkipped).not.toHaveBeenCalled();
  });

  it("skips a schedule missed by more than the retry window (AlphaClaw was down) without restarting", () => {
    const clock = { nowMs: kNow };
    const stateDir = makeStateDir();
    const store = makeStore({ stateDir, clock });
    store.markRequired("env_vars_changed");
    makeScheduler({ store, clock, timers: makeTimers(), startRestart: vi.fn() }).schedule({ at: kNow + kHour });

    clock.nowMs = kNow + kHour + kRestartScheduleRetryWindowMs + 1;
    const timers = makeTimers();
    const recordSkipped = vi.fn();
    const startRestart = vi.fn();
    makeScheduler({ store: makeStore({ stateDir, clock }), clock, timers, startRestart, recordSkipped }).arm();
    timers.fireNext();
    expect(startRestart).not.toHaveBeenCalled();
    expect(recordSkipped).toHaveBeenCalledWith({ code: "missed_window", scheduledFor: kNow + kHour });
  });

  it("drops the schedule when the pending reasons clear before it fires, and after a reload with none left", async () => {
    const clock = { nowMs: kNow };
    const stateDir = makeStateDir();
    const store = makeStore({ stateDir, clock });
    store.markRequired("env_vars_changed");
    const timers = makeTimers();
    const startRestart = vi.fn();
    makeScheduler({ store, clock, timers, startRestart }).schedule({ at: kNow + kHour });

    // A manual restart succeeded first: its completion clears the reasons.
    const { operationId } = store.beginRestart();
    store.completeRestart({ operationId, ok: true });
    expect(store.getRestartSchedule()).toBeNull();
    expect((await store.getSnapshot()).schedule).toBeNull();
    clock.nowMs = kNow + kHour;
    timers.fireNext();
    expect(startRestart).not.toHaveBeenCalled();

    // A schedule file left behind with no reasons is dropped at load.
    fs.writeFileSync(path.join(stateDir, "alphaclaw-restart-schedule.json"), JSON.stringify({ at: kNow + 2 * kHour, createdAt: kNow }));
    expect(makeStore({ stateDir, clock }).getRestartSchedule()).toBeNull();
    expect(fs.existsSync(path.join(stateDir, "alphaclaw-restart-schedule.json"))).toBe(false);
  });

  it("dismissing the banner and cancelling both clear the schedule", () => {
    const clock = { nowMs: kNow };
    const store = makeStore({ clock });
    store.markRequired("env_vars_changed");
    const timers = makeTimers();
    const scheduler = makeScheduler({ store, clock, timers, startRestart: vi.fn() });
    scheduler.schedule({ at: kNow + kHour });
    expect(scheduler.cancel()).toEqual({ cancelled: true });
    expect(store.getRestartSchedule()).toBeNull();
    expect(timers.live()).toHaveLength(0);
    expect(scheduler.cancel()).toEqual({ cancelled: false });

    scheduler.schedule({ at: kNow + kHour });
    store.clearRequired();
    expect(store.getRestartSchedule()).toBeNull();
  });
});
