import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "./action-button.js";
import { formatDurationLongMs, formatLocaleTime } from "../lib/format.js";

const html = htm.bind(h);

// ---------------------------------------------------------------------------
// Gateway shell store
//
// The Gateway card and the global banner render deep in page trees the
// app-shell controller's props don't reach, so the controller publishes its
// gateway-facing slice (unified server state, restart operation, restart
// reasons, connectivity) here and those components subscribe. It lives in
// this dependency-light module (no api.js import) so page hooks can publish
// to it without dragging the whole controller graph into their tests.
// Components never write back — they call the published `actions`.
// ---------------------------------------------------------------------------

const kGatewayShellDefaults = Object.freeze({
  hasStatus: false,
  statusState: null,
  legacyGatewayStatus: null,
  watchdogStatus: null,
  restartOperation: null,
  // { message } when the server refused to start a restart (policy, 409):
  // nothing ran, so it is an info line rather than a failed operation.
  restartNotice: null,
  restartRequired: false,
  restartReasons: [],
  // { kind, headline } of the OpenClaw data upgrade alert
  // (/api/openclaw/upgrade-status) — the banner's lowest-precedence line and
  // the Gateway card's "see below" pointer.
  upgradeAlert: null,
  // The status frame's boot timeline (human shape), null without one.
  bootProgress: null,
  // { mode, count, label, stageLabel } from lib/boot-reconnect.js while
  // AlphaClaw itself restarts.
  bootReconnect: null,
  // online | reconnecting | unreachable | alphaclaw_restarting |
  // alphaclaw_booting | alphaclaw_stalled | alphaclaw_stuck | restart_loop
  connectivityMode: "online",
  lastFrameAtMs: 0,
  statusFreshness: null,
  actions: {},
});

export const createGatewayShellStore = () => {
  let snapshot = { ...kGatewayShellDefaults };
  const listeners = new Set();
  const notify = () => {
    for (const listener of [...listeners]) listener(snapshot);
  };
  return {
    get: () => snapshot,
    publish: (partial) => {
      // The controller publishes on every render (its actions object is
      // rebuilt each pass); a shallow no-change publish must not re-render
      // every subscriber. `actions` is compared by its function identities.
      let changed = false;
      for (const [key, value] of Object.entries(partial || {})) {
        const previous = snapshot[key];
        if (key === "actions" && previous && value) {
          for (const actionKey of Object.keys(value)) {
            if (previous[actionKey] !== value[actionKey]) {
              changed = true;
              break;
            }
          }
          continue;
        }
        if (previous !== value) changed = true;
      }
      if (!changed) return;
      snapshot = { ...snapshot, ...partial };
      notify();
    },
    reset: () => {
      snapshot = { ...kGatewayShellDefaults };
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

export const gatewayShellStore = createGatewayShellStore();

export const useGatewayShell = () => {
  const [shell, setShell] = useState(() => gatewayShellStore.get());
  useEffect(() => {
    const unsubscribe = gatewayShellStore.subscribe(setShell);
    setShell(gatewayShellStore.get());
    return unsubscribe;
  }, []);
  return shell;
};

// ---------------------------------------------------------------------------
// Restart status line
//
// The server streams one "step" event per status change
// ({ name, label, status, at, budgetMs?, detail? }); the card collapses the
// stream into ONE sentence for the current phase. Internal step names never
// render — every string below is operator copy.
// ---------------------------------------------------------------------------

export const kOptimisticStepName = "__requesting";

// Retry upgrade rides the restart pipeline with its own kind; everything the
// card and banner say about it is kind-aware.
export const kUpgradeOperationKind = "openclaw_upgrade";
export const isUpgradeOperation = (operation) => operation?.kind === kUpgradeOperationKind;
// Where Try again leads: the server persists it (retryTarget) because only
// it knows which step failed — stop or Doctor → the Retry upgrade confirm,
// a launch/readiness failure after a completed Doctor → a plain Restart.
export const retryTargetFor = (operation) => {
  if (!isUpgradeOperation(operation)) return "restart";
  const target = operation?.retryTarget || operation?.error?.retryTarget;
  if (target === "restart" || target === "upgrade") return target;
  const upgrade = operation?.upgrade || operation?.error?.upgrade;
  return upgrade?.doctor === "ok" ? "restart" : "upgrade";
};
// Doctor heartbeats carry how long OpenClaw has been silent; after two
// minutes the line says so instead of looking frozen.
const kSilentDoctorMs = 120_000;

const kTerminalStepStatuses = new Set(["done", "skipped", "completed", "failed"]);

const stepDetail = (step) =>
  step?.detail && typeof step.detail === "object" ? step.detail : {};

const lowerFirst = (text) => text.charAt(0).toLowerCase() + text.slice(1);

const phaseCopyForStep = (step = {}) => {
  const name = String(step?.name || "");
  if (name === kOptimisticStepName) return "contacting AlphaClaw…";
  if (name === "ready") return "OpenClaw is ready";
  const status = String(step?.status || "running");
  if (name === "preparing_plugins") {
    if (status === "warning") return "checking plugins (plugin check had warnings)";
    if (status === "running") return "checking plugins (gateway still running)";
    return null;
  }
  if (kTerminalStepStatuses.has(status)) return null;
  const detail = stepDetail(step);
  switch (name) {
    case "stopping": {
      if (detail.phase === "asking") {
        // The ask was skipped (no lsof on the host, NO_RESPAWN pinned, no
        // budget…): the card says so in one clause; the reason and the fix
        // are in the Watchdog tab and the log.
        if (detail.status === "skipped") {
          return detail.reason === "no_lsof"
            ? "stopping OpenClaw (graceful stop unavailable: lsof is not installed on this host)"
            : "stopping OpenClaw (graceful stop unavailable)";
        }
        const active = Number(detail.activeWork);
        const scope = Number.isFinite(active) && active > 0
          ? ` (${active} task${active === 1 ? "" : "s"})`
          : "";
        return `asking OpenClaw to finish its current work${scope}`;
      }
      if (detail.phase === "forcing") {
        const grace = Number(detail.graceSeconds);
        return `OpenClaw didn't stop in ${Number.isFinite(grace) ? grace : "?"}s, forcing it (active work may be interrupted)`;
      }
      return "stopping OpenClaw";
    }
    case "upgrading_data": {
      const silentMs = Number(detail.sinceOutputMs);
      return Number.isFinite(silentMs) && silentMs >= kSilentDoctorMs
        ? `running OpenClaw's doctor --fix — no output for ${formatDurationLongMs(silentMs)}, still running`
        : "running OpenClaw's doctor --fix (gateway stopped)";
    }
    case "converging":
      return "re-applying AlphaClaw settings";
    case "launching":
      return "starting OpenClaw";
    case "waiting_ready":
      return detail.phase === "lock_wait"
        ? "waiting for OpenClaw's state lock (another OpenClaw process is finishing)"
        : "checking readiness";
    case "waiting_for_lock":
      return "waiting for the current operation to finish";
    default:
      return step?.label ? lowerFirst(String(step.label)) : null;
  }
};

// The current phase sentence for a running operation: the latest step event
// that carries copy wins; terminal statuses (stopping done, plugin check
// skipped) keep the previous line until the next step starts.
export const describeRestartPhase = (steps = []) => {
  let copy = null;
  for (const step of Array.isArray(steps) ? steps : []) {
    const next = phaseCopyForStep(step);
    if (next) copy = next;
  }
  return copy;
};

// Elapsed time is anchored to the server's own step timestamps so a reload
// or a second tab shows the same timer; the client's request time is only
// the fallback before the first step lands.
export const restartStartedAtMs = (operation = null) => {
  let earliest = Infinity;
  for (const step of Array.isArray(operation?.steps) ? operation.steps : []) {
    const at = Number(step?.at);
    if (Number.isFinite(at) && at > 0 && at < earliest) earliest = at;
  }
  if (earliest !== Infinity) return earliest;
  const startedAt = Number(operation?.startedAt);
  return Number.isFinite(startedAt) && startedAt > 0 ? startedAt : 0;
};

const seconds = (ms) => `${Math.max(1, Math.round(ms / 1000))}s`;

const finiteMs = (value) => value != null && Number.isFinite(Number(value));

// A forced stop is never reported as a clean one (bug #137): the sentence
// says "forced" when SIGTERM/SIGKILL did the stopping and names how many
// non-gateway processes exited with it; the Watchdog tab holds the list.
export const describeRestartSuccess = (operation = {}) => {
  const qualifiers = [];
  if (finiteMs(operation?.downtimeMs)) qualifiers.push(`down for ${seconds(Number(operation.downtimeMs))}`);
  if (operation?.how === "sigterm" || operation?.how === "sigkill") qualifiers.push("forced");
  const exits = Number(operation?.observedExitsCount);
  if (Number.isFinite(exits) && exits > 0) {
    qualifiers.push(`${exits} other process${exits === 1 ? "" : "es"} exited`);
  }
  const suffix = qualifiers.length ? ` (${qualifiers.join("; ")})` : "";
  if (!finiteMs(operation?.durationMs)) return `Running: gateway restarted${suffix}`;
  return `Running: restarted in ${seconds(Number(operation.durationMs))}${suffix}`;
};

// Retry upgrade's outcomes. "unfinished": the gateway runs again, but the
// Doctor failed — gateway recovery is never shown as upgrade success.
export const describeUpgradeSuccess = (operation = {}) =>
  finiteMs(operation?.durationMs)
    ? `OpenClaw data upgraded in ${formatDurationLongMs(Number(operation.durationMs))}`
    : "OpenClaw data upgraded";
export const isUnfinishedUpgrade = (operation = {}) =>
  isUpgradeOperation(operation) && operation?.phase === "succeeded" && operation?.upgrade?.doctor === "failed";
export const describeUnfinishedUpgrade = (operation = {}) => {
  const reason = stripPeriod(operation?.upgrade?.sentence);
  return reason
    ? `OpenClaw is running again, but the data upgrade didn't finish: ${lowerFirst(reason)}.`
    : "OpenClaw is running again, but the data upgrade didn't finish.";
};
// The server already wrote the whole sentence for an upgrade failure (which
// step failed, combined Doctor + relaunch outcomes); the card appends the
// recovery clause only.
export const describeUpgradeFailure = (error = {}) => {
  const text = stripPeriod(error?.message || error?.error) || "The upgrade retry failed";
  const recovery = describeRecoveryClause(error?.recovery);
  return {
    message: recovery ? `${text}. ${recovery}` : `${text}.`,
    canRetry: error?.code !== "stop_refused" && error?.code !== "response_lost",
  };
};

// A failed restart whose gateway came back (the record's `recovered` stamp,
// bug #137 PR 2). Browser-local time; the truth about the user's changes
// comes from the server (`changesLive`), never from "the dot is green".
const clockTime = (ms) => {
  const at = Number(ms);
  if (!Number.isFinite(at) || at <= 0) return "";
  return formatLocaleTime(at, { hour: "2-digit", minute: "2-digit" });
};
export const describeRestartRecovered = (recovered = {}) => {
  const at = clockTime(recovered?.at);
  const when = at ? ` at ${at}` : "";
  if (recovered?.changesLive) {
    return recovered.by === "restart_child"
      ? `The gateway finished starting${when} — your changes are live.`
      : `Automatic repair brought the gateway back${when} — your changes are live.`;
  }
  return `The gateway came back${when}, but AlphaClaw cannot tell whether your changes are live — press Restart to be sure.`;
};

// What automatic recovery will do about a failed restart — from the
// `recovery` stream event or the persisted record's {status, reason}. One
// plain clause, no enums.
export const describeRecoveryClause = (recovery = null) => {
  if (!recovery || typeof recovery !== "object") return "";
  if (recovery.text) return String(recovery.text);
  switch (String(recovery.status || "")) {
    case "will_check":
      return "Automatic recovery is checking now.";
    case "watching":
      return "AlphaClaw keeps watching it.";
    case "auto_repair_paused":
      return "Automatic recovery is paused — press Resume repair once to let it run.";
    case "auto_repair_disabled":
      return "Automatic recovery is off — press Repair to run it.";
    case "repair_attempts_exhausted":
      return "Automatic recovery has used all its attempts — press Repair to run it.";
    case "operation_in_progress":
    case "replacement_pending":
      return "Another gateway operation is already in progress; it will take over.";
    case "":
    case "unknown":
      return "";
    default:
      return `Automatic recovery is blocked: ${String(recovery.reason || recovery.status).replace(/_/g, " ")}.`;
  }
};

export const humanDuration = (ms) => {
  const total = Math.max(1, Math.round(Number(ms) / 1000));
  return total >= 60 && total % 60 === 0 ? `${total / 60} min` : `${total} s`;
};

const stripPeriod = (text) => String(text || "").trim().replace(/\.$/, "");

// One sentence per failure code (the server's `error` text only fills the
// slots that need it). `canRetry` hides "Try again" where a retry cannot
// help: the server refused to touch an unidentified gateway, or the
// response was lost and the outcome is still being reconciled.
export const describeRestartFailure = (error = {}) => {
  const text = stripPeriod(error?.message || error?.error);
  const recovery = describeRecoveryClause(error?.recovery);
  const withRecovery = (message) => (recovery ? `${message} ${recovery}` : message);
  switch (error?.code) {
    case "stop_refused":
      return {
        message: "Couldn't safely identify the running gateway, so nothing was stopped. Open View logs to see what holds the gateway port.",
        canRetry: false,
      };
    case "stop_failed":
      // The server sentence names a COUNT ("2 gateway processes did not
      // exit after SIGKILL…"); pids live in the Watchdog tab's evidence.
      return {
        message: withRecovery(
          text && /gateway process/.test(text)
            ? `${text}.`
            : "Couldn't confirm the old gateway stopped, so your changes are not live yet.",
        ),
        canRetry: true,
      };
    case "launch_failed":
      return {
        message: withRecovery(
          text
            ? `The old gateway stopped, but OpenClaw didn't start: ${text}.`
            : "The old gateway stopped, but OpenClaw didn't start.",
        ),
        canRetry: true,
      };
    case "ready_timeout":
      return {
        message: withRecovery(
          finiteMs(error?.budgetMs) && Number(error.budgetMs) > 0
            ? `OpenClaw started but wasn't ready within ${humanDuration(error.budgetMs)}.`
            : "OpenClaw started but wasn't ready in time.",
        ),
        canRetry: true,
      };
    case "aborted":
      return {
        message: "Restart was cancelled (AlphaClaw is shutting down or another operation took over).",
        canRetry: true,
      };
    case "response_lost":
      return {
        message: "Couldn't confirm whether the restart started — the connection dropped. Checking with AlphaClaw…",
        canRetry: false,
      };
    default:
      return { message: text ? `Restart failed: ${text}.` : "Restart failed.", canRetry: true };
  }
};

// One status line for a gateway restart: pulsing dot + phase + elapsed
// while running, the measured outcome on success, a sentence with
// Try again / View logs on failure.
export const RestartProgressCard = ({
  operation = null,
  nowMs = Date.now(),
  onRetry = null,
  // Opens the Retry upgrade confirm (never the restart endpoint).
  onRetryUpgrade = null,
  onViewLogs = null,
}) => {
  const lineRef = useRef(null);
  const phase = operation?.phase || "running";
  const isFailed = phase === "failed";
  const isSucceeded = phase === "succeeded";
  const isRecovered = phase === "recovered";
  const isRunning = !isFailed && !isSucceeded && !isRecovered;

  // Focus lands on the line when a restart starts and again on failure so
  // keyboard and screen-reader users land on the outcome, not stale buttons.
  useEffect(() => {
    if (!operation || isSucceeded || isRecovered) return;
    lineRef.current?.focus?.({ preventScroll: true });
  }, [operation?.operationId, isFailed, isSucceeded, isRecovered]);

  if (!operation) return null;
  const upgrade = isUpgradeOperation(operation);
  const retryTarget = retryTargetFor(operation);
  const retryHandler = retryTarget === "upgrade" ? onRetryUpgrade : onRetry;

  if (isRunning) {
    const copy = describeRestartPhase(operation.steps) || "preparing";
    const startedAt = restartStartedAtMs(operation);
    const elapsed = formatDurationLongMs(startedAt > 0 ? nowMs - startedAt : 0);
    // Only the phase is announced: a once-a-second clock inside a live
    // region would make screen readers read every tick.
    return html`
      <p
        ref=${lineRef}
        tabindex="-1"
        class="ac-restart-line text-sm text-body outline-none"
      >
        <span class="ac-gateway-dot ac-gateway-dot--cyan ac-gateway-dot--pulse" aria-hidden="true"></span>
        <span
          ><span aria-live="polite">${`${upgrade ? "Upgrading OpenClaw data" : "Restarting"}: ${copy}`}</span
          ><span>${` · ${elapsed}`}</span></span
        >
      </p>
    `;
  }

  if (isSucceeded && upgrade && operation.upgrade?.doctor === "failed") {
    return html`
      <div
        ref=${lineRef}
        tabindex="-1"
        role="status"
        class="ac-restart-line text-sm text-body outline-none"
      >
        <span class="ac-gateway-dot ac-gateway-dot--yellow" aria-hidden="true"></span>
        <span class="text-status-warning font-semibold" aria-hidden="true">!</span>
        <span>${describeUnfinishedUpgrade(operation)}</span>
        <span class="ac-restart-line-actions">
          ${typeof onRetryUpgrade === "function"
            ? html`<${ActionButton} onClick=${() => onRetryUpgrade()} tone="primary" size="sm" idleLabel="Try again" className="ac-touch" />`
            : null}
          ${typeof onViewLogs === "function"
            ? html`<${ActionButton} onClick=${() => onViewLogs()} tone="secondary" size="sm" idleLabel="View logs" className="ac-touch" />`
            : null}
        </span>
      </div>
    `;
  }

  if (isSucceeded && upgrade) {
    return html`
      <p class="ac-restart-line text-sm text-body" role="status">
        <span class="ac-gateway-dot ac-gateway-dot--green" aria-hidden="true"></span>
        <span>${describeUpgradeSuccess(operation)}</span>
      </p>
    `;
  }

  if (isSucceeded) {
    return html`
      <p class="ac-restart-line text-sm text-body" role="status">
        <span class="ac-gateway-dot ac-gateway-dot--green" aria-hidden="true"></span>
        <span>${describeRestartSuccess(operation)}</span>
      </p>
    `;
  }

  if (isRecovered) {
    const changesLive = operation.recovered?.changesLive === true;
    return html`
      <p class="ac-restart-line text-sm text-body" role="status">
        <span class="ac-gateway-dot ${changesLive ? "ac-gateway-dot--green" : "ac-gateway-dot--yellow"}" aria-hidden="true"></span>
        <span>${describeRestartRecovered(operation.recovered)}</span>
        ${!changesLive && typeof onRetry === "function"
          ? html`<span class="ac-restart-line-actions"
              ><${ActionButton} onClick=${() => onRetry()} tone="primary" size="sm" idleLabel="Restart" className="ac-touch"
            /></span>`
          : null}
      </p>
    `;
  }

  const failureInput = { ...operation.error, recovery: operation.error?.recovery || operation.recovery || null };
  const failure = upgrade ? describeUpgradeFailure(failureInput) : describeRestartFailure(failureInput);
  return html`
    <div
      ref=${lineRef}
      tabindex="-1"
      role="alert"
      class="ac-restart-line ac-restart-line--failed text-sm outline-none"
    >
      <span class="text-status-error font-semibold" aria-hidden="true">✕</span>
      <span class="text-status-error">${failure.message}</span>
      <span class="ac-restart-line-actions">
        ${failure.canRetry && typeof retryHandler === "function"
          ? html`<${ActionButton}
              onClick=${() => retryHandler()}
              tone="primary"
              size="sm"
              idleLabel=${upgrade && retryTarget === "restart" ? "Restart" : "Try again"}
              className="ac-touch"
            />`
          : null}
        ${typeof onViewLogs === "function"
          ? html`<${ActionButton}
              onClick=${() => onViewLogs()}
              tone="secondary"
              size="sm"
              idleLabel="View logs"
              className="ac-touch"
            />`
          : null}
      </span>
    </div>
  `;
};
