const { createGmailAccountOperations, operationError } = require("./gmail-account-operations");
const { createGmailServeManager } = require("./gmail-serve");
const { quoteShellArg } = require("./utils/shell");
const {
  getGoogleAccountById, getAccountGmailWatch, listWatchEnabledAccounts,
  setAccountGmailWatch, getGmailPushConfig, setGmailPushConfig,
} = require("./google-state");

const kRestartBaseMs = 5000;
const kRestartMaxMs = 5 * 60 * 1000;
const kHealthyUptimeMs = 60_000;

const createGmailWatchLifecycle = ({ constants, readState, updateState, prepareStart, runGogForAccount, parseExpiration }) => {
  const reservations = new Map();
  const restartTimers = new Map();
  const restartAttempts = new Map();
  let stopping = false;
  let generation = 0;
  let bootstrapTimer = null;
  let bootstrapWork = null;
  let renewalTimer = null;
  let renewalWork = null;
  let stopWork = null;

  const readAccount = (accountId) => getGoogleAccountById(readState(), accountId);
  const saveWatch = (accountId, watch) => updateState((state) =>
    setAccountGmailWatch({ state, accountId, watch }).state);
  const remote = (kind, status, code = "", message = "") => ({ kind, status, code, message, updatedAt: Date.now() });
  const releaseIfUnused = (accountId) => {
    if (!operations.isBusy(accountId) && !serveManager.getServeStatus(accountId).pid) reservations.delete(accountId);
  };
  const operations = createGmailAccountOperations({ onIdle: releaseIfUnused });
  const cancelRestart = (accountId) => {
    clearTimeout(restartTimers.get(accountId));
    restartTimers.delete(accountId);
  };
  const serveManager = createGmailServeManager({
    constants,
    onServeExit: (payload) => {
      const accountId = String(payload?.accountId || "");
      if (!accountId) return;
      if (payload.pid) {
        try {
          const watch = getAccountGmailWatch(readAccount(accountId));
          if (watch.pid === payload.pid) saveWatch(accountId, { pid: null, ...(!watch.enabled ? { port: null } : {}) });
        } catch (error) { console.error("[alphaclaw] Failed to record Gmail serve exit:", error); }
      }
      releaseIfUnused(accountId);
      if (stopping || payload.expected || operations.isDisconnecting(accountId)) return;
      const attempts = Number(payload.uptimeMs) >= kHealthyUptimeMs ? 0 : restartAttempts.get(accountId) || 0;
      restartAttempts.set(accountId, attempts + 1);
      const delayMs = Math.min(kRestartBaseMs * 2 ** attempts, kRestartMaxMs);
      const detail = payload.error ? `spawn error: ${payload.error}` : `code ${payload.code ?? "null"}, signal ${payload.signal ?? "null"}`;
      console.warn(`[alphaclaw] gog serve for ${payload.email || accountId} exited after ${Math.round((payload.uptimeMs || 0) / 1000)}s (${detail}); restarting in ${Math.round(delayMs / 1000)}s` +
        (payload.stderrTail ? ` — stderr: ${String(payload.stderrTail).slice(-300)}` : ""));
      cancelRestart(accountId);
      const gen = generation;
      const timer = setTimeout(async () => {
        restartTimers.delete(accountId);
        if (stopping || generation !== gen) return;
        try { await restoreServe(accountId); }
        catch (error) {
          if (error.code !== "superseded" && error.code !== "account_disconnecting") console.error("[alphaclaw] Gmail serve auto-restart failed:", error);
        }
      }, delayMs);
      timer.unref?.();
      restartTimers.set(accountId, timer);
    },
  });

  const firstAvailablePort = (used) => {
    for (let offset = 0; offset < constants.kMaxGoogleAccounts; offset += 1) {
      const candidate = constants.kGmailServeBasePort + offset;
      if (!used.has(candidate)) return candidate;
    }
    return null;
  };
  const reservePort = (accountId) => {
    if (reservations.has(accountId)) return reservations.get(accountId);
    const serving = serveManager.getServeStatus(accountId);
    if (serving.pid && serving.port) { reservations.set(accountId, serving.port); return serving.port; }
    const state = readState();
    const account = getGoogleAccountById(state, accountId);
    if (!account) throw operationError("account_not_found", "Google account not found");
    const used = new Set([...reservations].filter(([id]) => id !== accountId).map(([, port]) => port));
    for (const other of state.accounts || []) {
      if (other.id !== accountId && other.gmailWatch?.port) used.add(other.gmailWatch.port);
    }
    let port = getAccountGmailWatch(account).port;
    if (!port || used.has(port)) port = firstAvailablePort(used);
    if (!port) throw operationError("gmail_ports_exhausted", "No available Gmail watch serve ports");
    reservations.set(accountId, port);
    return port;
  };

  const assertPriorChildStopped = (account) => {
    const child = serveManager.getServeStatus(account.id);
    const watch = getAccountGmailWatch(account);
    if (child.stopping || (!child.pid && watch.pid && serveManager.isPidRunning(watch.pid))) {
      throw Object.assign(operationError("gmail_serve_stop_unconfirmed",
        "The previous Gmail serve process has not exited. Retry stopping it before starting another watch."), { retryable: true });
    }
  };

  const stopExternal = async (account, { remoteRequired = true } = {}) => {
    const recorded = getAccountGmailWatch(account);
    if (!serveManager.getServeStatus(account.id).pid && recorded.pid && serveManager.isPidRunning(recorded.pid)) {
      throw Object.assign(operationError("gmail_serve_stop_unconfirmed",
        "Gmail delivery is disabled, but an earlier watch process still exists. Its exit must be confirmed before retrying."), { retryable: true });
    }
    const result = await serveManager.stopServe({ accountId: account.id });
    if (!result.stopped) throw Object.assign(operationError("gmail_serve_stop_unconfirmed",
      "Gmail delivery is disabled, but the local watch process has not exited. Retry stopping it."), { retryable: true });
    if (!remoteRequired) return;
    const stopped = await runGogForAccount({ account,
      command: `gmail watch stop --account ${quoteShellArg(account.email)} --force` });
    if (!stopped.ok) {
      console.warn(`[alphaclaw] Gmail watch stop failed (${account.email}): ${stopped.stderr || "unknown"}`);
      throw Object.assign(operationError("gmail_remote_stop_failed",
        "Gmail delivery is disabled, but Google watch cancellation failed. Retry stopping it."), { retryable: true });
    }
  };

  const markStopped = (accountId, kind, status, error = null) => {
    const child = serveManager.getServeStatus(accountId);
    const previous = getAccountGmailWatch(readAccount(accountId));
    const unconfirmed = status === "failed" && error?.code === "gmail_serve_stop_unconfirmed";
    saveWatch(accountId, {
      enabled: false, port: child.pid ? child.port : unconfirmed ? previous.port : null,
      pid: child.pid || (unconfirmed ? previous.pid : null),
      remoteOperation: remote(kind, status, error?.code || "", error?.message || ""),
    });
  };

  const startWatch = ({ accountId, req = null, destination = null, conditional = false }) =>
    operations.request({
      accountId, kind: "start", key: conditional ? "renew" : `start:${JSON.stringify(destination)}`,
      conditional,
      prepare: () => {
        const account = readAccount(accountId);
        if (!account) throw operationError("account_not_found", "Google account not found");
        if (conditional && !getAccountGmailWatch(account).enabled) return { skipped: true };
        assertPriorChildStopped(account);
        cancelRestart(accountId);
        // Reserve before any external command can yield to another account.
        const port = reservePort(accountId);
        const prepared = prepareStart({ accountId, req, destination });
        saveWatch(accountId, { remoteOperation: remote("start", "pending") });
        return { ...prepared, port };
      },
      run: async (owner, prepared) => {
        if (prepared.skipped) return { ok: true, accountId, skipped: true, reason: "disabled" };
        const { account, client, topicPath, webhookToken, pushToken, port } = prepared;
        let startedRemote = false;
        let obsolete = false;
        try {
          owner.assertCurrent();
          if (conditional && !getAccountGmailWatch(readAccount(accountId)).enabled) return { ok: true, accountId, skipped: true, reason: "disabled" };
          startedRemote = true;
          const watchStart = await runGogForAccount({ account,
            command: `gmail watch start --json --account ${quoteShellArg(account.email)} --topic ${quoteShellArg(topicPath)} --label INBOX` });
          // Even a failed/timed-out command may have reached Google. Any
          // superseding stop runs compensation before the next lane owner.
          owner.assertCurrent();
          if (!watchStart.ok) throw new Error(watchStart.stderr || "Failed to start Gmail watch");
          const serve = await serveManager.startServe({ account, port, webhookToken });
          owner.assertCurrent();
          const expiration = parseExpiration(watchStart.stdout);
          let updatedAccount;
          updateState((current) => {
            const freshAccount = getGoogleAccountById(current, accountId);
            if (!freshAccount || (conditional && !getAccountGmailWatch(freshAccount).enabled)) {
              obsolete = true;
              throw operationError("superseded", "The account was removed or its Gmail watch was disabled.");
            }
            const freshPush = getGmailPushConfig(current);
            const next = setGmailPushConfig({ state: current, config: {
              ...freshPush, token: freshPush.token || pushToken, topics: { ...freshPush.topics, [client]: topicPath },
            } }).state;
            const result = setAccountGmailWatch({ state: next, accountId, watch: {
              enabled: true, port, expiration, pid: serve.pid || null, remoteOperation: remote("start", "succeeded"),
            } });
            updatedAccount = result.account;
            return result.state;
          });
          return { ok: true, accountId, client, topicPath, watch: getAccountGmailWatch(updatedAccount), serve };
        } catch (error) {
          if (owner.isCurrent() && !obsolete) {
            let cleanupError = null;
            // A failed first start must not orphan a watch at Google. A
            // failed renewal leaves the existing watch running until expiry.
            if (startedRemote && !getAccountGmailWatch(account).enabled) {
              try { await stopExternal(account); } catch (failure) { cleanupError = failure; }
            }
            if (owner.isCurrent()) {
              if (cleanupError) markStopped(accountId, "stop", "failed", {
                code: cleanupError.code || "gmail_cleanup_failed",
                message: "Gmail watch setup failed and cleanup did not finish. Delivery is disabled; retry stopping the watch.",
              });
              else saveWatch(accountId, { remoteOperation: remote("start", "failed", "gmail_start_failed", "Gmail watch could not start. Retry or check the account setup.") });
            }
          }
          throw error;
        } finally {
          if ((!owner.isCurrent() || obsolete) && startedRemote) {
            // Shutdown preserves enabled intent for the next boot; only reap
            // its local child. A newer account intent must also cancel the
            // obsolete remote start while this operation still owns the lane.
            if (stopping) await serveManager.stopServe({ accountId });
            else {
              try { await stopExternal(account); }
              catch (error) { console.warn("[alphaclaw] Superseded Gmail watch cleanup failed:", error.message); }
            }
          }
        }
      },
    });

  const requestStop = ({ accountId, kind = "stop", run = null }) => operations.request({
    accountId, kind,
    prepare: () => {
      cancelRestart(accountId);
      const account = readAccount(accountId);
      if (!account) return null;
      // This is synchronous, even when an old gog command still owns the lane.
      saveWatch(accountId, { enabled: false, remoteOperation: remote(kind, "pending") });
      return account;
    },
    run: async (owner, account) => {
      if (!account) return { ok: true, accountId, skipped: true };
      try {
        const watch = getAccountGmailWatch(account);
        await stopExternal(account, { remoteRequired: kind !== "disconnect" ||
          account.services?.includes("gmail:read") || Boolean(watch.port || watch.pid || watch.expiration) });
        owner.assertCurrent();
        if (run) {
          const result = await run();
          if (result?.ok === false) throw Object.assign(new Error(result.error || "Google disconnect failed"), { code: result.code || "google_disconnect_failed", retryable: true });
          return result;
        }
        markStopped(accountId, kind, "succeeded");
        return { ok: true, accountId, watch: getAccountGmailWatch(readAccount(accountId)) };
      } catch (error) {
        if (owner.isCurrent()) markStopped(accountId, kind, "failed", {
          code: error.code || "google_disconnect_failed",
          message: kind === "disconnect" ? "Google disconnect did not finish. Gmail delivery is disabled; retry disconnecting this account." :
            "Gmail delivery is disabled, but watch cancellation did not finish. Retry stopping it.",
        });
        throw error;
      }
    },
  });
  const stopWatch = ({ accountId }) => requestStop({ accountId });
  const disconnectAccount = ({ accountId, run }) => requestStop({ accountId, kind: "disconnect", run });

  const restoreServe = (accountId) => operations.request({
    accountId, kind: "restore", conditional: true,
    prepare: () => {
      const account = readAccount(accountId);
      const watch = getAccountGmailWatch(account);
      const webhookToken = String(process.env.WEBHOOK_TOKEN || "").trim();
      if (!account || !watch.enabled || !webhookToken) return null;
      assertPriorChildStopped(account);
      return { account, port: reservePort(accountId), webhookToken };
    },
    run: async (owner, prepared) => {
      if (!prepared) return;
      owner.assertCurrent();
      if (!getAccountGmailWatch(readAccount(accountId)).enabled) return;
      const status = await serveManager.startServe(prepared);
      if (!owner.isCurrent()) { await serveManager.stopServe({ accountId }); owner.assertCurrent(); }
      saveWatch(accountId, { port: prepared.port, pid: status.pid || null });
    },
  });

  const renewWatch = async ({ accountId = "", force = false } = {}) => {
    if (accountId && operations.isDisconnecting(accountId)) throw operationError("account_disconnecting", "This Google account is being disconnected.");
    const gen = generation;
    const state = readState();
    const targets = accountId ? [getGoogleAccountById(state, accountId)].filter(Boolean) : listWatchEnabledAccounts(state);
    const results = [];
    for (const account of targets) {
      if (stopping || gen !== generation) break;
      const watch = getAccountGmailWatch(readAccount(account.id));
      if (!watch.enabled) { results.push({ accountId: account.id, skipped: true, reason: "disabled" }); continue; }
      if (!force && watch.expiration && watch.expiration - Date.now() > constants.kGmailWatchRenewalThresholdMs) {
        results.push({ accountId: account.id, skipped: true, reason: "not_due" }); continue;
      }
      try {
        const renewed = await startWatch({ accountId: account.id, conditional: true });
        results.push(renewed.skipped ? { accountId: account.id, skipped: true, reason: renewed.reason } :
          { accountId: account.id, renewed: true, expiration: renewed.watch.expiration || null });
      } catch (error) {
        if (["superseded", "account_disconnecting", "service_stopping"].includes(error.code)) results.push({ accountId: account.id, skipped: true, reason: error.code });
        else results.push({ accountId: account.id, renewed: false, error: error.message || "renew_failed" });
      }
    }
    return { ok: true, results };
  };

  const runRenewal = () => {
    if (stopping || renewalWork) return renewalWork;
    renewalWork = renewWatch({ force: false }).catch((error) => console.error("[alphaclaw] Gmail watch renewal error:", error))
      .finally(() => { renewalWork = null; });
    return renewalWork;
  };
  const clearTimers = () => {
    clearTimeout(bootstrapTimer); bootstrapTimer = null;
    clearInterval(renewalTimer); renewalTimer = null;
    for (const accountId of restartTimers.keys()) cancelRestart(accountId);
  };
  const bootPredecessorError = () => ({
    code: "gmail_serve_stop_unconfirmed",
    message: "An earlier Gmail watch process is still running. Delivery is disabled; confirm its exit, then retry stopping the watch.",
  });
  const prepareBootWatches = () => {
    const planned = new Map(reservations);
    const prepared = updateState((state) => {
      let next = state;
      const accounts = [...(state.accounts || [])].sort((a, b) => a.id.localeCompare(b.id));
      // A surviving process owns its recorded port regardless of account
      // ordering. Never "repair" that port while its exit is unconfirmed.
      for (const account of accounts) {
        const watch = getAccountGmailWatch(account);
        const child = serveManager.getServeStatus(account.id);
        if (child.pid && child.port) planned.set(account.id, child.port);
        const untrackedAlive = !child.pid && watch.pid && serveManager.isPidRunning(watch.pid);
        if (untrackedAlive && watch.port) planned.set(account.id, watch.port);
        if (operations.isBusy(account.id)) continue;
        if (untrackedAlive && watch.enabled) {
          const error = bootPredecessorError();
          next = setAccountGmailWatch({ state: next, accountId: account.id, watch: {
            enabled: false, remoteOperation: remote("stop", "failed", error.code, error.message),
          } }).state;
          continue;
        }
        if (!child.pid && watch.pid && !untrackedAlive) {
          next = setAccountGmailWatch({ state: next, accountId: account.id, watch: {
            pid: null, ...(!watch.enabled ? { port: null } : {}),
          } }).state;
        }
        if (watch.remoteOperation?.status === "pending") {
          next = setAccountGmailWatch({ state: next, accountId: account.id, watch: {
            remoteOperation: remote(watch.remoteOperation.kind, "failed", "operation_interrupted",
              "AlphaClaw restarted before this Gmail operation finished. Review its current state and retry."),
          } }).state;
        }
      }
      const enabled = listWatchEnabledAccounts(next).sort((a, b) => a.id.localeCompare(b.id));
      const used = new Set(planned.values());
      for (const account of next.accounts || []) {
        const watch = getAccountGmailWatch(account);
        if (!watch.enabled && watch.port) used.add(watch.port);
      }
      // Preserve every non-conflicting saved port before assigning new ones.
      // The first account ID owns a duplicated port unless a live process
      // already owns it. No spawn or external command has happened yet.
      for (const account of enabled) {
        const port = getAccountGmailWatch(account).port;
        if (port && !used.has(port) && !planned.has(account.id)) {
          planned.set(account.id, port);
          used.add(port);
        }
      }
      for (const account of enabled) {
        const port = planned.get(account.id) || firstAvailablePort(used);
        if (!port) throw operationError("gmail_ports_exhausted", "No available Gmail watch serve ports");
        planned.set(account.id, port);
        used.add(port);
        next = setAccountGmailWatch({ state: next, accountId: account.id, watch: { port } }).state;
      }
      return next;
    });
    // Publish reservations only after the complete assignment is durable.
    for (const [accountId, port] of planned) reservations.set(accountId, port);
    return listWatchEnabledAccounts(prepared).sort((a, b) => a.id.localeCompare(b.id));
  };
  const start = () => {
    if (stopWork) { void stopWork.then(start); return; }
    if (bootstrapTimer || bootstrapWork || renewalTimer) return;
    stopping = false;
    operations.start();
    const gen = ++generation;
    renewalTimer = setInterval(runRenewal, constants.kGmailWatchRenewalIntervalMs);
    renewalTimer.unref?.();
    bootstrapTimer = setTimeout(() => {
      bootstrapTimer = null;
      bootstrapWork = (async () => {
        if (stopping || generation !== gen) return;
        const enabled = prepareBootWatches();
        for (const account of enabled) {
          if (stopping || generation !== gen) return;
          try { await restoreServe(account.id); }
          catch (error) {
            if (error.code === "gmail_serve_stop_unconfirmed" && !operations.isBusy(account.id)) {
              markStopped(account.id, "stop", "failed", bootPredecessorError());
            }
            if (error.code !== "superseded") console.error(`[alphaclaw] Failed to restore Gmail serve for ${account.email}: ${error.message || "unknown"}`);
          }
        }
        if (!stopping && generation === gen) await runRenewal();
      })().catch((error) => console.error("[alphaclaw] Failed to bootstrap Gmail watch services:", error))
        .finally(() => { bootstrapWork = null; });
    }, 0);
    bootstrapTimer.unref?.();
  };
  const stop = () => {
    if (stopWork) return stopWork;
    stopping = true;
    generation += 1;
    clearTimers();
    stopWork = (async () => {
      await operations.stop();
      await Promise.allSettled([bootstrapWork, renewalWork].filter(Boolean));
      await serveManager.stopAll();
      for (const accountId of reservations.keys()) releaseIfUnused(accountId);
    })().finally(() => { stopWork = null; });
    return stopWork;
  };

  return { serveManager, startWatch, stopWatch, renewWatch, disconnectAccount, start, stop, isDisconnecting: operations.isDisconnecting };
};

module.exports = { createGmailWatchLifecycle };
