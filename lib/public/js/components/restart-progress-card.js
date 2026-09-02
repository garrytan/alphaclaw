import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "./action-button.js";
import { LoadingSpinner } from "./loading-spinner.js";
import { formatElapsed } from "./upgrade-tab/helpers.js";

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
  restartRequired: false,
  restartReasons: [],
  // online | reconnecting | unreachable | alphaclaw_restarting
  connectivityMode: "online",
  upgradeRestartActive: false,
  lastFrameAtMs: 0,
  actions: {},
});

const createGatewayShellStore = () => {
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
  useEffect(() => gatewayShellStore.subscribe(setShell), []);
  return shell;
};

// Shared step visuals for streamed operations: gateway restarts emit
// "running"/"done", channel applies emit "running"/"completed"/"failed".
// "interrupted" is client-derived: a step that was in flight when the
// operation reached a terminal failure (stopped, no motion).
export const kStepDotClassByStatus = {
  running: "bg-cyan-400/90 animate-pulse",
  done: "bg-green-500/90",
  completed: "bg-green-500/90",
  failed: "bg-red-500/90",
  interrupted: "bg-gray-500/60",
  warning: "bg-yellow-400/90",
};

export const OperationStepRow = ({ step = {}, isCurrent = false }) => html`
  <li
    class="flex items-start gap-2"
    aria-current=${isCurrent ? "step" : null}
  >
    <span
      class=${`mt-1 h-2 w-2 shrink-0 rounded-full ${
        kStepDotClassByStatus[step.status] || "bg-gray-500/60"
      }`}
      aria-hidden="true"
    ></span>
    <span class="min-w-0">
      <span
        class=${`text-sm ${
          step.status === "failed"
            ? "text-status-error"
            : step.status === "warning"
              ? "text-status-warning-muted"
              : "text-body"
        }`}
        >${step.label}</span
      >
      ${step.detail
        ? html`<span
            class=${`ml-2 text-xs ${
              step.status === "warning" ? "text-status-warning-muted" : "text-fg-muted"
            }`}
            >${step.detail}</span
          >`
        : null}
      ${step.error
        ? html`<span class="ml-2 text-xs text-status-error-muted"
            >${step.error}</span
          >`
        : null}
    </span>
  </li>
`;

export const OperationStepList = ({
  steps = [],
  currentName = null,
  className = "space-y-1.5",
}) => html`
  <ol class=${className}>
    ${steps.map(
      (step) => html`<${OperationStepRow}
        key=${step.name}
        step=${step}
        isCurrent=${currentName != null && step.name === currentName}
      />`,
    )}
  </ol>
`;

// Collapses the raw restart step event stream (one event per status change)
// into one row per step, in first-seen order. Labels are rendered verbatim
// from the server — internal step names never render.
export const buildRestartStepModels = (steps = []) => {
  const byName = new Map();
  for (const step of Array.isArray(steps) ? steps : []) {
    const name = String(step?.name || "").trim();
    if (!name) continue;
    if (!byName.has(name)) {
      byName.set(name, {
        name,
        label: String(step?.label || name),
        status: null,
      });
    }
    const entry = byName.get(name);
    if (step.label) entry.label = String(step.label);
    if (step.status) entry.status = step.status;
  }
  return [...byName.values()];
};

export const getCurrentStepName = (stepModels = []) => {
  for (let i = stepModels.length - 1; i >= 0; i -= 1) {
    if (stepModels[i]?.status === "running") return stepModels[i].name;
  }
  return null;
};

const readySecondsLabel = (operation) => {
  const ms = Number.isFinite(operation?.downtimeMs)
    ? operation.downtimeMs
    : Number.isFinite(operation?.durationMs)
      ? operation.durationMs
      : null;
  if (ms == null) return null;
  return `${Math.max(1, Math.round(ms / 1000))}s`;
};

const kEvidenceSummaryLines = 2;

const EvidenceDisclosure = ({
  operationId = null,
  onLoadEvidence = null,
}) => {
  const [open, setOpen] = useState(false);
  const [evidence, setEvidence] = useState({ status: "idle", text: "" });
  const [expanded, setExpanded] = useState(false);

  const handleToggle = () => {
    const nextOpen = !open;
    setOpen(nextOpen);
    if (
      nextOpen &&
      evidence.status === "idle" &&
      typeof onLoadEvidence === "function"
    ) {
      setEvidence({ status: "loading", text: "" });
      Promise.resolve(onLoadEvidence(operationId))
        .then((text) =>
          setEvidence(
            text
              ? { status: "loaded", text: String(text) }
              : { status: "expired", text: "" },
          ),
        )
        // A failed fetch is not expiry — keep "expired" for the server's
        // genuine no-longer-available answer.
        .catch((error) =>
          setEvidence({ status: "error", text: String(error?.message || "") }),
        );
    }
  };

  const lines = evidence.text ? evidence.text.split("\n") : [];
  const summary = lines.slice(-kEvidenceSummaryLines).join("\n");
  const hasMore = lines.length > kEvidenceSummaryLines;

  return html`
    <div>
      <button
        type="button"
        class="text-xs text-fg-muted hover:text-body ac-touch"
        onclick=${handleToggle}
        aria-expanded=${open ? "true" : "false"}
      >
        ${open ? "▾ Hide evidence" : "▸ Show evidence"}
      </button>
      ${open
        ? evidence.status === "loading"
          ? html`<p class="mt-1 text-xs text-fg-muted">Loading evidence…</p>`
          : evidence.status === "expired"
            ? html`<p class="mt-1 text-xs text-fg-muted">Evidence expired</p>`
            : evidence.status === "error"
              ? html`<p class="mt-1 text-xs text-fg-muted">
                  ${evidence.text
                    ? `Couldn't load evidence — ${evidence.text}`
                    : "Couldn't load evidence"}
                </p>`
              : html`
                <pre
                  class="mt-2 bg-field rounded p-2 text-xs whitespace-pre-wrap break-words max-h-64 overflow-auto"
                >
${expanded ? evidence.text : summary}</pre
                >
                ${hasMore
                  ? html`<button
                      type="button"
                      class="mt-1 text-xs text-fg-muted hover:text-body ac-touch"
                      onclick=${() => setExpanded(!expanded)}
                      aria-expanded=${expanded ? "true" : "false"}
                    >
                      ${expanded ? "Show less" : "Show more"}
                    </button>`
                  : null}
              `
        : null}
    </div>
  `;
};

// Streamed gateway-restart progress: step list (completed / current /
// pending), elapsed time, success line with measured downtime, and a
// persistent failure block with the server's remediation action.
export const RestartProgressCard = ({
  operation = null,
  nowMs = Date.now(),
  primaryAction = null,
  onPrimaryAction = () => {},
  onDismiss = null,
  onLoadEvidence = null,
}) => {
  const headingRef = useRef(null);
  const failureRef = useRef(null);
  const phase = operation?.phase || "running";
  const isFailed = phase === "failed";
  const isSucceeded = phase === "succeeded";
  const isRunning = !isFailed && !isSucceeded;

  // Focus management: restart start → progress heading; failure → failure
  // block (screen-reader users land on the outcome, not stale steps).
  useEffect(() => {
    if (!operation) return;
    if (isFailed) {
      failureRef.current?.focus?.({ preventScroll: true });
    } else if (isRunning) {
      headingRef.current?.focus?.({ preventScroll: true });
    }
  }, [operation?.operationId, isFailed, isRunning]);

  if (!operation) return null;

  const stepModels = buildRestartStepModels(operation.steps);
  // The server never emits terminal step statuses on failure (and "launching"
  // never gets one at all), so on a terminal error the in-flight steps must
  // not keep pulsing "running" forever: the step that was current renders as
  // failed, any other in-flight step as interrupted (stopped, no motion).
  const failedStepName = isFailed ? getCurrentStepName(stepModels) : null;
  const displaySteps = isSucceeded
    ? stepModels.map((step) => ({ ...step, status: "done" }))
    : isFailed
      ? stepModels.map((step) =>
          step.status === "running"
            ? {
                ...step,
                status: step.name === failedStepName ? "failed" : "interrupted",
              }
            : step,
        )
      : stepModels;
  const currentName = isRunning ? getCurrentStepName(displaySteps) : null;
  const readySeconds = readySecondsLabel(operation);
  const elapsedLabel = formatElapsed(operation.startedAt, nowMs);

  return html`
    <div class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          ${isRunning ? html`<${LoadingSpinner} className="h-4 w-4" />` : null}
          <h3
            ref=${headingRef}
            tabindex="-1"
            class="text-sm font-semibold outline-none"
          >
            ${isFailed
              ? "Gateway restart failed"
              : isSucceeded
                ? "Gateway restarted"
                : "Restarting gateway"}
          </h3>
        </div>
        ${isRunning
          ? html`<span class="text-xs text-fg-muted"
              >elapsed ${elapsedLabel}</span
            >`
          : null}
      </div>

      ${displaySteps.length > 0
        ? html`<${OperationStepList}
            steps=${displaySteps}
            currentName=${currentName}
          />`
        : isRunning
          ? html`<p class="text-sm text-fg-muted">Starting restart…</p>`
          : null}

      ${isSucceeded
        ? html`
            <div
              class="flex flex-wrap items-center justify-between gap-2"
              role="status"
            >
              <p class="text-sm text-body">
                Gateway is running${readySeconds
                  ? ` — ready in ${readySeconds}`
                  : ""}
              </p>
              ${typeof onDismiss === "function"
                ? html`<${ActionButton}
                    onClick=${onDismiss}
                    tone="secondary"
                    size="sm"
                    idleLabel="Dismiss"
                    className="ac-touch"
                  />`
                : null}
            </div>
          `
        : null}

      ${isFailed
        ? html`
            <div
              ref=${failureRef}
              tabindex="-1"
              role="alert"
              class="ac-surface-inset border border-red-500/40 rounded-lg p-3 space-y-2 outline-none"
            >
              <p class="text-sm text-status-error">
                <span aria-hidden="true">✕ </span>${operation.error?.message ||
                "The restart did not complete."}
              </p>
              ${operation.error?.hint
                ? html`<p class="text-xs text-fg-muted">
                    ${operation.error.hint}
                  </p>`
                : null}
              <${EvidenceDisclosure}
                operationId=${operation.operationId || null}
                onLoadEvidence=${onLoadEvidence}
              />
              <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
                ${typeof onDismiss === "function"
                  ? html`<${ActionButton}
                      onClick=${onDismiss}
                      tone="secondary"
                      size="sm"
                      idleLabel="Dismiss"
                      className="ac-touch"
                    />`
                  : null}
                ${primaryAction
                  ? html`<${ActionButton}
                      onClick=${() => onPrimaryAction(primaryAction)}
                      tone="primary"
                      size="sm"
                      idleLabel=${primaryAction.label}
                      title=${primaryAction.description || ""}
                      className="ac-touch"
                    />`
                  : null}
              </div>
            </div>
          `
        : null}
    </div>
  `;
};
