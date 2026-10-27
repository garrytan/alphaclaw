const fs = require("fs");
const path = require("path");
const { readSidecarRegistry, kSidecarsEnvKey } = require("./registry");
const { resolveSidecarUser, buildSidecarEnv } = require("./env");
const { createSidecarSupervisor } = require("./supervisor");
const { isServingObservation } = require("../gateway-downtime-note");

// Operator sidecars service: owns every supervisor, starts `startAfter: boot`
// entries when the server listens and the rest once the gateway first answers
// /readyz ready (or after the fallback, so a memory guard still runs on a box
// whose gateway never comes up), runs the post-boot hook once, stops them all
// on shutdown, and reports status. The registry is read once per process from
// the deployment environment (registry.js explains why never from a file).
//
// The same /readyz poll also tells the deploy announcer when the gateway first
// serves (onGatewayReady). The two are separate latches: the fallback starts
// the sidecars but is not "back", so after it the poll keeps going (every
// kServingPollAfterFallbackMs) until the gateway serves, and only then does
// the announcer measure the downtime. "Serving" is the downtime note's
// definition (gateway-downtime-note.js), so a gateway with one failing channel
// counts as back while the sidecar start still waits for a native ready.
//
// A pid file (sidecars-state.json in the AlphaClaw root) records each spawned
// sidecar's pid and kernel start time. An in-place AlphaClaw restart (self
// update) leaves detached sidecars running; the next boot stops exactly those
// processes (pid AND start time must match, so a reused pid is never
// signalled) before starting fresh copies, so nothing runs twice.
const kReadyPollMs = 2000;
const kReadyFallbackMs = 10 * 60 * 1000;
const kServingPollAfterFallbackMs = 5 * 1000;
const kLogMaxBytes = 10 * 1024 * 1024;
const kLeftoverStopWaitMs = 3000;
const kPostBootHookEnvKey = "ALPHACLAW_POST_BOOT_HOOK";
const kPostBootHookTimeoutMs = 120 * 1000;

const readProcStartTime = (pid, readFileSync = fs.readFileSync) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") return null;
    return fields[19] || null;
  } catch {
    return null;
  }
};

const createSidecarService = ({
  env = process.env,
  rootDir,
  logsDir = path.join(rootDir, "logs", "sidecars"),
  stateFile = path.join(rootDir, "sidecars-state.json"),
  fsModule = fs,
  notify = async () => {},
  insertEvent = () => {},
  resolveReadyzUrl = () => null,
  probeReadiness = async () => ({ ok: false }),
  runPostBootHook = null,
  onGatewayReady = null,
  getBootId = () => null,
  isShuttingDown = () => false,
  spawn,
  killProcess = process.kill.bind(process),
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  readyPollMs = kReadyPollMs,
  readyFallbackMs = kReadyFallbackMs,
  servingPollAfterFallbackMs = kServingPollAfterFallbackMs,
  logger = console,
  supervisorOptions = {},
}) => {
  const registry = readSidecarRegistry({ env });
  const pids = {};
  const state = {
    bootStarted: false,
    gatewayEntriesStarted: false,
    sidecarsStartedAt: null,
    readyAt: null,
    readySource: null,
    servingSeen: false,
    servingNotice: null,
    readyTimer: null,
    stopped: false,
    postBootHook: null,
  };

  const persistPids = () => {
    try {
      if (!Object.keys(pids).length) {
        fsModule.rmSync(stateFile, { force: true });
        return;
      }
      fsModule.writeFileSync(stateFile, `${JSON.stringify({ sidecars: pids }, null, 2)}\n`);
    } catch (error) {
      logger.warn(`[sidecar] could not record sidecar pids: ${error.message}`);
    }
  };

  const logPath = (name) => path.join(logsDir, `${name}.log`);

  const openLogFd = (name) => () => {
    fsModule.mkdirSync(logsDir, { recursive: true });
    const file = logPath(name);
    try {
      if (fsModule.statSync(file).size > kLogMaxBytes) fsModule.renameSync(file, `${file}.1`);
    } catch {}
    return fsModule.openSync(file, "a");
  };

  const closeLogFd = (fd) => {
    if (fd === null || fd === undefined) return;
    try {
      fsModule.closeSync(fd);
    } catch {}
  };

  const note = (name) => (line) => {
    logger.log(`[sidecar] ${name}: ${line}`);
    try {
      fsModule.mkdirSync(logsDir, { recursive: true });
      fsModule.appendFileSync(logPath(name), `--- ${new Date(now()).toISOString()} alphaclaw: ${line}\n`);
    } catch {}
  };

  const recordEvent = (status, details) => {
    try {
      insertEvent({ eventType: "sidecar", source: "sidecars", status, details });
    } catch {}
  };

  const onSupervisorEvent = ({ name, event, ...details }) => {
    if (event === "started") {
      if (details.pid) {
        const startTime = readProcStartTime(details.pid);
        pids[name] = { pid: details.pid, startTime };
        persistPids();
      }
      recordEvent("ok", { name, phase: "started", ...details });
      return;
    }
    if (event === "stopped") {
      if (pids[name]) {
        delete pids[name];
        persistPids();
      }
      recordEvent("ok", { name, phase: "stopped", ...details });
      return;
    }
    if (event === "exited") {
      if (pids[name]) {
        delete pids[name];
        persistPids();
      }
      const failed = details.error || details.code !== 0 || details.signal;
      recordEvent(failed ? "warn" : "ok", { name, phase: "exited", ...details });
      return;
    }
    if (event === "crash_loop") {
      recordEvent("failed", { name, phase: "crash_loop", ...details });
      const minutes = Math.round(details.windowMs / 60000);
      const hint = details.hint ? ` Hint: ${details.hint}.` : "";
      void notify(
        `⚠️ Sidecar ${name} is crash-looping: ${details.exits} exits in ${minutes} min (last: ${details.lastExit}). AlphaClaw keeps restarting it with backoff, at most every 5 min. Its output is in logs/sidecars/${name}.log.${hint}`,
        { eventType: "sidecar", id: `sidecar-crash-loop-${name}-${now()}` },
      ).catch(() => {});
      return;
    }
    if (event === "recovered") {
      recordEvent("ok", { name, phase: "recovered", ...details });
      void notify(`✅ Sidecar ${name} recovered: it has been running for ${Math.round(details.stableMs / 60000)} min.`, {
        eventType: "sidecar",
        id: `sidecar-recovered-${name}-${now()}`,
        verbose: true,
      }).catch(() => {});
    }
  };

  const prepare = (entry) => {
    const user = resolveSidecarUser(entry.user);
    if (!user.ok) return user;
    const built = buildSidecarEnv(entry, { baseEnv: env, identity: user.identity });
    if (!built.ok) return built;
    return { ok: true, env: built.env, identity: user.identity };
  };

  const supervisors = new Map(
    registry.entries.map((entry) => [
      entry.name,
      createSidecarSupervisor({
        entry,
        prepare,
        openLogFd: openLogFd(entry.name),
        closeLogFd,
        note: note(entry.name),
        onEvent: onSupervisorEvent,
        ...(spawn ? { spawn } : {}),
        killProcess,
        now,
        setTimer,
        clearTimer,
        ...supervisorOptions,
      }),
    ]),
  );

  // Stops sidecars a previous AlphaClaw process left running. Only a pid
  // whose kernel start time still matches the record is signalled.
  const stopLeftovers = async () => {
    let recorded = {};
    try {
      recorded = JSON.parse(fsModule.readFileSync(stateFile, "utf8"))?.sidecars || {};
    } catch {
      return;
    }
    const alive = Object.entries(recorded).filter(
      ([, record]) =>
        Number.isInteger(record?.pid) &&
        record.pid > 1 &&
        record.startTime &&
        readProcStartTime(record.pid) === record.startTime,
    );
    for (const [name, record] of alive) {
      logger.log(`[sidecar] ${name}: stopping the copy a previous AlphaClaw process left running`);
      try {
        killProcess(-record.pid, "SIGTERM");
      } catch {}
    }
    const deadline = now() + kLeftoverStopWaitMs;
    while (alive.some(([, record]) => readProcStartTime(record.pid) === record.startTime) && now() < deadline) {
      await new Promise((resolve) => setTimer(resolve, 100));
    }
    for (const [, record] of alive) {
      if (readProcStartTime(record.pid) !== record.startTime) continue;
      try {
        killProcess(-record.pid, "SIGKILL");
      } catch {}
    }
    try {
      fsModule.rmSync(stateFile, { force: true });
    } catch {}
  };

  const runHookOnce = async () => {
    const hookPath = String(env[kPostBootHookEnvKey] || "").trim();
    if (!hookPath || typeof runPostBootHook !== "function") return;
    const startedAt = now();
    try {
      await runPostBootHook({
        hookPath,
        timeoutMs: kPostBootHookTimeoutMs,
        readyAt: state.readyAt,
        sidecarsStartedAt: state.sidecarsStartedAt,
        bootId: getBootId(),
      });
      state.postBootHook = { status: "ran", at: new Date(now()).toISOString(), durationMs: now() - startedAt };
      recordEvent("ok", { phase: "post_boot_hook", ...state.postBootHook });
    } catch (error) {
      state.postBootHook = {
        status: error?.status === "refused" ? "refused" : "failed",
        code: error?.code || null,
        message: String(error?.message || error),
        at: new Date(now()).toISOString(),
      };
      recordEvent("failed", { phase: "post_boot_hook", ...state.postBootHook });
      void notify(`⚠️ The post-boot hook (${kPostBootHookEnvKey}) ${state.postBootHook.status}: ${state.postBootHook.message}`, {
        eventType: "sidecar",
        id: `post-boot-hook-${getBootId() || startedAt}`,
      }).catch(() => {});
    }
  };

  const startGatewayEntries = async (source) => {
    if (state.gatewayEntriesStarted || state.stopped) return;
    state.gatewayEntriesStarted = true;
    state.sidecarsStartedAt = new Date(now()).toISOString();
    state.readySource = source;
    if (source === "fallback") {
      logger.warn(
        `[sidecar] gateway not ready ${Math.round(readyFallbackMs / 60000)} min after boot; starting sidecars anyway`,
      );
    }
    for (const supervisor of supervisors.values()) {
      if (supervisor.entry.startAfter === "gateway") supervisor.start();
    }
    await state.servingNotice;
    await runHookOnce();
  };

  const noteGatewayServing = async () => {
    if (typeof onGatewayReady !== "function") return;
    try {
      await onGatewayReady({ readyAt: state.readyAt, source: "gateway_ready" });
    } catch (error) {
      logger.warn(`[sidecar] gateway-ready hook failed: ${error?.message || error}`);
    }
  };

  const waitForGatewayReady = () => {
    const deadline = now() + readyFallbackMs;
    const halted = () => state.stopped || isShuttingDown();
    const poll = async () => {
      state.readyTimer = null;
      if (halted()) return;
      const url = resolveReadyzUrl();
      const observation = url ? await probeReadiness({ url }).catch(() => null) : null;
      if (halted()) return;
      const observedAt = now();
      if (!state.servingSeen && isServingObservation(observation)) {
        state.servingSeen = true;
        state.readyAt = new Date(observedAt).toISOString();
        state.servingNotice = noteGatewayServing();
      }
      if (!state.gatewayEntriesStarted) {
        const source = observation?.ok && observation.kind === "ready"
          ? "gateway_ready"
          : observedAt >= deadline ? "fallback" : null;
        if (source) void startGatewayEntries(source).catch(() => {});
      }
      if (state.servingSeen && state.gatewayEntriesStarted) return;
      state.readyTimer = setTimer(poll, state.gatewayEntriesStarted ? servingPollAfterFallbackMs : readyPollMs);
      state.readyTimer?.unref?.();
    };
    void poll();
  };

  const hasWork = () =>
    supervisors.size > 0 ||
    Boolean(String(env[kPostBootHookEnvKey] || "").trim()) ||
    typeof onGatewayReady === "function";

  // Runs every running sidecar's announce command in parallel.
  const announceAll = async (extraEnv, timeoutMs) => {
    const targets = [...supervisors.values()].filter((supervisor) => supervisor.entry.announce);
    const results = await Promise.all(
      targets.map(async (supervisor) => ({ name: supervisor.entry.name, result: await supervisor.announce(extraEnv, timeoutMs) })),
    );
    return results
      .filter(({ result }) => result !== null)
      .map(({ name, result }) => ({ name, ok: result.ok, code: result.code ?? null, error: result.error || null }));
  };

  const start = async () => {
    if (state.bootStarted) return;
    state.bootStarted = true;
    for (const { index, name, errors } of registry.errors) {
      const label = name ? `sidecar ${name}` : index === null ? kSidecarsEnvKey : `sidecar #${index + 1}`;
      logger.error(`[sidecar] ${label} ignored: ${errors.join("; ")}`);
    }
    if (registry.errors.length) {
      recordEvent("failed", { phase: "registry_invalid", errors: registry.errors });
    }
    await stopLeftovers();
    if (!hasWork() || state.stopped) return;
    for (const supervisor of supervisors.values()) {
      if (supervisor.entry.startAfter === "boot") supervisor.start();
    }
    waitForGatewayReady();
  };

  const stopAll = async ({ reason = "shutdown" } = {}) => {
    state.stopped = true;
    if (state.readyTimer) clearTimer(state.readyTimer);
    await Promise.allSettled([...supervisors.values()].map((supervisor) => supervisor.stop({ reason })));
  };

  const find = (name) => supervisors.get(name) || null;

  const getStatus = () => ({
    configured: registry.configured,
    source: kSidecarsEnvKey,
    errors: registry.errors,
    gatewayReadyAt: state.readyAt,
    sidecarsStartedAt: state.sidecarsStartedAt,
    startedBy: state.readySource,
    postBootHook: {
      configured: Boolean(String(env[kPostBootHookEnvKey] || "").trim()),
      last: state.postBootHook,
    },
    sidecars: [...supervisors.values()].map(({ entry, getStatus: supervisorStatus }) => ({
      name: entry.name,
      type: entry.type,
      command: entry.command,
      check: entry.check,
      stop: entry.stop,
      announce: entry.announce,
      user: entry.user,
      cwd: entry.cwd,
      envFile: entry.envFile,
      envKeys: Object.keys(entry.env),
      envUnset: entry.envUnset,
      inheritEnv: entry.inheritEnv,
      restart: entry.restart,
      startAfter: entry.startAfter,
      stopTimeoutSeconds: entry.stopTimeoutSeconds,
      checkIntervalSeconds: entry.checkIntervalSeconds,
      enabled: entry.enabled,
      log: `logs/sidecars/${entry.name}.log`,
      ...supervisorStatus(),
    })),
  });

  return { start, stopAll, getStatus, find, hasWork, announceAll };
};

module.exports = {
  createSidecarService,
  kPostBootHookEnvKey,
  readProcStartTime,
};
