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
  // online | reconnecting | unreachable | alphaclaw_restarting
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

  if (isRunning) {
    const copy = describeRestartPhase(operation.steps) || "preparing";
    const startedAt = restartStartedAtMs(operation);
    const elapsed = formatDurationLongMs(startedAt > 0 ? nowMs - startedAt : 0);
    return html`
      <p
        ref=${lineRef}
        tabindex="-1"
        class="ac-restart-line text-sm text-body outline-none"
        aria-live="polite"
      >
        <span class="ac-gateway-dot ac-gateway-dot--cyan ac-gateway-dot--pulse" aria-hidden="true"></span>
        <span>${`Restarting: ${copy} · ${elapsed}`}</span>
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

  const failure = describeRestartFailure({ ...operation.error, recovery: operation.error?.recovery || operation.recovery || null });
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
        ${failure.canRetry && typeof onRetry === "function"
          ? html`<${ActionButton}
              onClick=${() => onRetry()}
              tone="primary"
              size="sm"
              idleLabel="Try again"
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
