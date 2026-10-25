const childProcess = require("child_process");

// One supervised sidecar: spawn, watch, restart with backoff, crash-loop
// detection, clean stop. Every sidecar runs in its own session and process
// group (detached), so it never needs `setsid -f` and a stop reaches
// everything it started. Output goes straight to the sidecar's log file fd,
// so a chatty child never blocks on a pipe and a daemon it starts keeps
// logging after its parent exits.
//
//   simple   spawn ─▶ running ─exit─▶ restart policy ─▶ backoff ─▶ spawn …
//   forking  check ok? adopt : run command (must exit 0) ─▶ running,
//            check every checkIntervalSeconds; a failing check runs `stop`
//            and counts as an exit
//   oneshot  spawn once ─▶ exited (restart only on-failure, if asked)
//
// Backoff doubles from 1 s to 5 min and resets after a run of 60 s. Five
// exits inside 10 min open a crash-loop episode (one onEvent, the service
// alerts once); a run that then lasts 10 min closes it with "recovered".
const kBackoffMs = Object.freeze([1000, 2000, 4000, 8000, 16000, 32000, 60000, 120000, 300000]);
const kStableRunMs = 60 * 1000;
const kCrashLoopThreshold = 5;
const kCrashLoopWindowMs = 10 * 60 * 1000;
const kRecoveryStableMs = 10 * 60 * 1000;
const kQuickExitMs = 3000;
const kForkingCommandTimeoutMs = 30 * 1000;
const kCheckTimeoutMs = 10 * 1000;
const kFirstCheckDelayMs = 2000;
const kKillWaitMs = 1000;

const kDaemonizeHint =
  "it exits right after starting; if it backgrounds itself (setsid -f, nohup … &, tmux new-session -d), run it in the foreground or use type forking with a check command";

const describeExit = ({ code, signal }) =>
  signal ? `signal ${signal}` : `exit code ${code}`;

const createSidecarSupervisor = ({
  entry,
  prepare,
  openLogFd,
  closeLogFd = () => {},
  note = () => {},
  onEvent = () => {},
  spawn = childProcess.spawn,
  killProcess = process.kill.bind(process),
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  backoffMs = kBackoffMs,
  stableRunMs = kStableRunMs,
  crashLoopThreshold = kCrashLoopThreshold,
  crashLoopWindowMs = kCrashLoopWindowMs,
  recoveryStableMs = kRecoveryStableMs,
  forkingCommandTimeoutMs = kForkingCommandTimeoutMs,
  checkTimeoutMs = kCheckTimeoutMs,
  firstCheckDelayMs = kFirstCheckDelayMs,
}) => {
  const state = {
    status: entry.enabled ? "idle" : "disabled",
    wanted: false,
    child: null,
    pid: null,
    startedAt: null,
    lastExit: null,
    lastError: null,
    starts: 0,
    attempt: 0,
    exits: [],
    crashLoop: null,
    nextStartAt: null,
    adopted: false,
    lastCheckAt: null,
    timers: new Set(),
    runSeq: 0,
  };

  const timer = (fn, ms) => {
    const handle = setTimer(() => {
      state.timers.delete(handle);
      fn();
    }, ms);
    handle?.unref?.();
    state.timers.add(handle);
    return handle;
  };
  const clearTimers = () => {
    for (const handle of state.timers) clearTimer(handle);
    state.timers.clear();
  };

  const emit = (event, details = {}) => {
    try {
      onEvent({ name: entry.name, event, ...details });
    } catch {}
  };

  // Runs argv to completion (forking command, check, stop) with the
  // sidecar's identity and env; resolves { code, signal, error }. The whole
  // process group is killed at the timeout. "exit", not "close": a daemon
  // that inherited the log fd must not keep the caller waiting.
  const runToCompletion = (argv, prepared, timeoutMs) =>
    new Promise((resolve) => {
      let settled = false;
      let fd = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimer(deadline);
        resolve(result);
      };
      let child;
      try {
        fd = openLogFd();
        child = spawn(argv[0], argv.slice(1), {
          cwd: entry.cwd || undefined,
          env: prepared.env,
          uid: prepared.identity?.uid,
          gid: prepared.identity?.gid,
          detached: true,
          stdio: ["ignore", fd, fd],
        });
      } catch (error) {
        closeLogFd(fd);
        resolve({ code: null, signal: null, error });
        return;
      }
      closeLogFd(fd);
      const deadline = setTimer(() => {
        try {
          killProcess(-child.pid, "SIGKILL");
        } catch {}
        finish({ code: null, signal: "SIGKILL", error: new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`) });
      }, timeoutMs);
      deadline?.unref?.();
      child.on("error", (error) => finish({ code: null, signal: null, error }));
      child.on("exit", (code, signal) => finish({ code, signal, error: null }));
    });

  const recordExitAndScheduleRestart = ({ code, signal, runMs, error }) => {
    const at = now();
    state.child = null;
    state.pid = null;
    state.adopted = false;
    state.lastExit = { code: code ?? null, signal: signal ?? null, at, runMs, error: error?.message || null };
    const success = !error && code === 0 && !signal;
    const quickDaemonize = entry.type === "simple" && success && runMs < kQuickExitMs;
    emit("exited", { code: code ?? null, signal: signal ?? null, runMs, error: error?.message || null });
    const policy = entry.restart;
    const stays =
      !state.wanted ||
      policy === "never" ||
      (policy === "on-failure" && success && !quickDaemonize);
    if (stays) {
      state.status = state.wanted && success ? "exited" : state.wanted ? "failed" : "stopped";
      return;
    }
    if (runMs >= stableRunMs) state.attempt = 0;
    state.exits = state.exits.filter((t) => at - t <= crashLoopWindowMs);
    state.exits.push(at);
    if (!state.crashLoop && state.exits.length >= crashLoopThreshold) {
      state.crashLoop = { since: at, exits: state.exits.length };
      emit("crash_loop", {
        exits: state.exits.length,
        windowMs: crashLoopWindowMs,
        lastExit: error ? `failed to start (${error.message})` : describeExit({ code, signal }),
        hint: quickDaemonize ? kDaemonizeHint : null,
      });
    }
    const delay = backoffMs[Math.min(state.attempt, backoffMs.length - 1)];
    state.attempt += 1;
    state.status = "backoff";
    state.nextStartAt = at + delay;
    note(`restart in ${Math.round(delay / 1000)}s after ${error ? `start failure (${error.message})` : describeExit({ code, signal })}`);
    timer(() => {
      state.nextStartAt = null;
      if (state.wanted) void launch();
    }, delay);
  };

  const armRecovery = (seq) => {
    timer(() => {
      if (state.runSeq !== seq || state.status !== "running") return;
      state.exits = [];
      state.attempt = 0;
      if (state.crashLoop) {
        const since = state.crashLoop.since;
        state.crashLoop = null;
        emit("recovered", { stableMs: recoveryStableMs, crashLoopSince: since });
      }
    }, recoveryStableMs);
  };

  const scheduleCheck = (prepared, seq, delayMs) => {
    timer(async () => {
      if (state.runSeq !== seq || !state.wanted) return;
      const result = await runToCompletion(entry.check, prepared, checkTimeoutMs);
      if (state.runSeq !== seq || !state.wanted) return;
      state.lastCheckAt = now();
      if (!result.error && result.code === 0) {
        scheduleCheck(prepared, seq, entry.checkIntervalSeconds * 1000);
        return;
      }
      note(`check failed (${result.error ? result.error.message : describeExit(result)})`);
      if (entry.stop) await runToCompletion(entry.stop, prepared, entry.stopTimeoutSeconds * 1000);
      if (state.runSeq !== seq || !state.wanted) return;
      state.runSeq += 1;
      recordExitAndScheduleRestart({
        code: result.code,
        signal: result.signal,
        runMs: now() - state.startedAt,
        error: result.error,
      });
    }, delayMs);
  };

  const launch = async () => {
    if (!state.wanted) return;
    state.runSeq += 1;
    const seq = state.runSeq;
    state.status = "starting";
    state.lastError = null;
    const startedAt = now();
    state.startedAt = startedAt;
    const prepared = prepare(entry);
    if (!prepared.ok) {
      state.lastError = prepared.error;
      note(`not started: ${prepared.error}`);
      recordExitAndScheduleRestart({ code: null, signal: null, runMs: 0, error: new Error(prepared.error) });
      return;
    }
    state.starts += 1;
    if (entry.type === "forking") {
      const precheck = await runToCompletion(entry.check, prepared, checkTimeoutMs);
      if (state.runSeq !== seq || !state.wanted) return;
      if (!precheck.error && precheck.code === 0) {
        state.adopted = true;
        state.status = "running";
        note("already running (check passed); adopted");
        emit("started", { adopted: true });
        scheduleCheck(prepared, seq, entry.checkIntervalSeconds * 1000);
        armRecovery(seq);
        return;
      }
      note(`starting: ${entry.command.join(" ")}`);
      const result = await runToCompletion(entry.command, prepared, forkingCommandTimeoutMs);
      if (state.runSeq !== seq || !state.wanted) return;
      if (result.error || result.code !== 0) {
        recordExitAndScheduleRestart({ ...result, runMs: now() - startedAt });
        return;
      }
      state.status = "running";
      emit("started", { adopted: false });
      scheduleCheck(prepared, seq, firstCheckDelayMs);
      armRecovery(seq);
      return;
    }
    let fd = null;
    let child;
    try {
      fd = openLogFd();
      note(`starting: ${entry.command.join(" ")}`);
      child = spawn(entry.command[0], entry.command.slice(1), {
        cwd: entry.cwd || undefined,
        env: prepared.env,
        uid: prepared.identity?.uid,
        gid: prepared.identity?.gid,
        detached: true,
        stdio: ["ignore", fd, fd],
      });
    } catch (error) {
      closeLogFd(fd);
      recordExitAndScheduleRestart({ code: null, signal: null, runMs: 0, error });
      return;
    }
    closeLogFd(fd);
    state.child = child;
    let exited = false;
    child.on("error", (error) => {
      if (exited) return;
      exited = true;
      if (state.runSeq !== seq) return;
      recordExitAndScheduleRestart({ code: null, signal: null, runMs: now() - startedAt, error });
    });
    child.on("exit", (code, signal) => {
      if (exited) return;
      exited = true;
      note(`exited (${describeExit({ code, signal })}) after ${Math.round((now() - startedAt) / 1000)}s`);
      child.emit("sidecar-exit");
      if (state.runSeq !== seq) return;
      recordExitAndScheduleRestart({ code, signal, runMs: now() - startedAt, error: null });
    });
    child.unref?.();
    if (!child.pid) return;
    state.pid = child.pid;
    state.status = "running";
    emit("started", { pid: child.pid });
    armRecovery(seq);
  };

  const start = () => {
    if (!entry.enabled) return;
    if (state.wanted && state.status !== "exited" && state.status !== "failed") return;
    state.wanted = true;
    void launch();
  };

  const waitForExit = (child, ms) =>
    new Promise((resolve) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        resolve(true);
        return;
      }
      const handle = setTimer(() => resolve(false), ms);
      handle?.unref?.();
      child.once("sidecar-exit", () => {
        clearTimer(handle);
        resolve(true);
      });
    });

  // Group only: every sidecar leads its own group (detached), and a bare-pid
  // fallback could hit a reused pid once the group is gone.
  const signalGroup = (pid, signal) => {
    try {
      killProcess(-pid, signal);
    } catch {}
  };

  const stop = async ({ reason = "stop" } = {}) => {
    const wasWanted = state.wanted;
    state.wanted = false;
    clearTimers();
    state.nextStartAt = null;
    state.runSeq += 1;
    if (entry.type === "forking") {
      if (wasWanted && entry.stop && (state.status === "running" || state.status === "starting")) {
        state.status = "stopping";
        const prepared = prepare(entry);
        if (prepared.ok) {
          const result = await runToCompletion(entry.stop, prepared, entry.stopTimeoutSeconds * 1000);
          note(`stopped (${reason}): stop command ${result.error ? result.error.message : describeExit(result)}`);
        }
      }
      state.adopted = false;
      if (entry.enabled) state.status = "stopped";
      return;
    }
    const child = state.child;
    if (!child || !state.pid) {
      if (entry.enabled) state.status = "stopped";
      return;
    }
    state.status = "stopping";
    const pid = state.pid;
    signalGroup(pid, "SIGTERM");
    let gone = await waitForExit(child, entry.stopTimeoutSeconds * 1000);
    if (!gone) {
      signalGroup(pid, "SIGKILL");
      gone = await waitForExit(child, kKillWaitMs);
    }
    signalGroup(pid, "SIGKILL");
    note(`stopped (${reason})${gone ? "" : ", exit not observed after SIGKILL"}`);
    state.child = null;
    state.pid = null;
    state.status = "stopped";
    emit("stopped", { pid, reason, exitObserved: gone });
  };

  const restart = async () => {
    await stop({ reason: "restart" });
    state.attempt = 0;
    state.exits = [];
    state.crashLoop = null;
    start();
  };

  const getStatus = () => ({
    status: state.status,
    pid: state.pid,
    adopted: state.adopted,
    startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
    starts: state.starts,
    lastExit: state.lastExit
      ? { ...state.lastExit, at: new Date(state.lastExit.at).toISOString() }
      : null,
    lastError: state.lastError,
    nextStartAt: state.nextStartAt ? new Date(state.nextStartAt).toISOString() : null,
    crashLoop: state.crashLoop
      ? { since: new Date(state.crashLoop.since).toISOString(), exits: state.crashLoop.exits }
      : null,
    lastCheckAt: state.lastCheckAt ? new Date(state.lastCheckAt).toISOString() : null,
  });

  return { start, stop, restart, getStatus, entry };
};

module.exports = {
  createSidecarSupervisor,
  kBackoffMs,
  kCrashLoopThreshold,
  kCrashLoopWindowMs,
  kDaemonizeHint,
};
