import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { InlineErrorChip } from "../inline-error-chip.js";
import { useGatewayShell } from "../restart-progress-card.js";
import { useCachedFetch } from "../../hooks/use-cached-fetch.js";
import { invalidateCache } from "../../lib/api-cache.js";
import { createOpenclawBackup, dismissUpgradeNotice, fetchUpgradeStatus } from "../../lib/api.js";
import { formatLocaleDateTime } from "../../lib/format.js";
import { describeBackupLine, describeUnchanged, kUpgradeStatusKey } from "./model.js";
import { RetryUpgradeDialog } from "./retry-upgrade-dialog.js";
import { EnableSnapshotsDialog } from "./enable-snapshots-dialog.js";
import { DoctorOutputDialog } from "./doctor-output-dialog.js";
import { consumeUpgradeRetryRequest, subscribeUpgradeRetryRequests } from "./retry-request.js";

const html = htm.bind(h);

const kToneBorder = {
  error: "border-status-error-border",
  warning: "border-status-warning-border",
  info: "border-border",
};
const kToneBadge = {
  error: { tone: "danger", label: "Needs attention" },
  warning: { tone: "warning", label: "Interrupted" },
  info: { tone: "info", label: "Notice" },
};

// The OpenClaw data upgrade alert, directly under the Gateway card. It
// persists while the gateway runs and clears when a Doctor completes for the
// installed pin. Members see the headline and "An administrator needs to
// finish this upgrade."; admins get the actions.
export const UpgradeAlert = ({ isActive = true }) => {
  const status = useCachedFetch(kUpgradeStatusKey, fetchUpgradeStatus, { enabled: isActive, maxAgeMs: 30_000 });
  const shell = useGatewayShell();
  const [dialog, setDialog] = useState(null);
  const [backingUp, setBackingUp] = useState(false);
  const [actionError, setActionError] = useState(null);
  const data = status.data || null;
  const alert = data?.alert || null;
  const isAdmin = Boolean(data && data.retry);

  useEffect(() => {
    if (consumeUpgradeRetryRequest()) setDialog("retry");
    return subscribeUpgradeRetryRequests(() => {
      consumeUpgradeRetryRequest();
      setDialog("retry");
    });
  }, []);

  const refresh = () => {
    shell.actions?.refreshUpgradeStatus?.();
    return status.refresh({ force: true }).catch(() => null);
  };
  const operationRunning = shell.restartOperation?.phase === "running";

  if (!alert && dialog !== "retry") return null;
  const actions = Array.isArray(alert?.actions) ? alert.actions : [];
  const has = (id) => isAdmin && actions.includes(id);
  const badge = kToneBadge[alert?.tone] || kToneBadge.info;
  const when = formatLocaleDateTime(alert?.at, { fallback: null });
  const unchangedLine = isAdmin ? describeUnchanged(data.retry) : null;
  const backupLine = isAdmin ? describeBackupLine(data.backup) : null;

  const backUp = async () => {
    if (backingUp) return;
    setBackingUp(true);
    setActionError(null);
    try {
      await createOpenclawBackup();
      invalidateCache("/api/openclaw/backup");
    } catch (err) {
      if (err?.code !== "backup_in_progress") setActionError(err);
    }
    setBackingUp(false);
    void refresh();
  };
  const dismiss = async () => {
    setActionError(null);
    try {
      await dismissUpgradeNotice(alert.dismissKey);
    } catch (err) {
      setActionError(err);
    }
    void refresh();
  };

  return html`
    ${alert
      ? html`<section
          id="upgrade-alert"
          tabindex="-1"
          aria-labelledby="upgrade-alert-title"
          class=${`bg-surface border ${kToneBorder[alert.tone] || kToneBorder.info} rounded-xl p-4 space-y-3 outline-none`}
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <h2 class="card-label">OpenClaw data upgrade</h2>
              <${Badge} tone=${badge.tone}>${badge.label}<//>
            </div>
            ${when ? html`<span class="text-xs text-fg-muted">${when}</span>` : null}
          </div>
          <div class="space-y-1">
            <p id="upgrade-alert-title" class="text-sm font-semibold text-body">${alert.headline}</p>
            <p class="text-sm text-body">${alert.sentence}</p>
            ${alert.memberLine ? html`<p class="text-xs text-fg-muted">${alert.memberLine}</p>` : null}
            ${unchangedLine ? html`<p class="text-xs text-status-warning">${unchangedLine}</p>` : null}
            ${isAdmin && alert.snapshot ? html`<p class="text-xs text-fg-muted">${alert.snapshot.sentence}</p>` : null}
            ${isAdmin && alert.manualFix ? html`<p class="text-xs text-body">To fix it: ${alert.manualFix}</p>` : null}
            ${isAdmin && alert.failingPath && alert.kind === "snapshotless"
              ? html`<p class="text-xs text-fg-muted">Folder: <span class="font-mono break-all">${alert.failingPath}</span></p>`
              : null}
          </div>
          ${isAdmin && Array.isArray(alert.steps)
            ? html`<ol class="list-decimal pl-5 space-y-1 text-xs text-body">
                ${alert.steps.map((stepText) => html`<li key=${stepText}>${stepText}</li>`)}
              </ol>`
            : null}
          ${isAdmin && (alert.detail || alert.snapshot?.cause || alert.cause)
            ? html`<details>
                <summary class="text-xs text-fg-muted cursor-pointer">What OpenClaw said</summary>
                <pre class="mt-2 ac-surface-inset border border-border rounded-lg p-2 text-xs font-mono whitespace-pre-wrap break-all">${[alert.detail, alert.snapshot?.cause || alert.cause].filter(Boolean).join("\n")}</pre>
              </details>`
            : null}
          ${backupLine ? html`<p class="text-xs text-fg-muted">${backupLine}</p>` : null}
          <${InlineErrorChip} error=${actionError} headline=${actionError ? "That didn't work." : null} />
          ${isAdmin
            ? html`<div class="flex flex-wrap items-center gap-2">
                ${has("enable_snapshots")
                  ? html`<${ActionButton} onClick=${() => setDialog("enable")} tone="secondary" size="sm" idleLabel="Enable snapshots" className="ac-touch" />`
                  : null}
                ${has("retry_upgrade")
                  ? html`<${ActionButton}
                      onClick=${() => setDialog("retry")}
                      tone="primary"
                      size="sm"
                      idleLabel=${alert.kind === "interrupted" ? "Retry upgrade now" : "Retry upgrade"}
                      disabled=${operationRunning}
                      title=${operationRunning ? "Another gateway operation is in progress." : ""}
                      className="ac-touch"
                    />`
                  : null}
                ${has("view_logs")
                  ? html`<${ActionButton} onClick=${() => setDialog("logs")} tone="secondary" size="sm" idleLabel="View Doctor output" className="ac-touch" />`
                  : null}
                ${has("back_up")
                  ? html`<${ActionButton} onClick=${backUp} tone="secondary" size="sm" idleLabel="Back up now" loadingLabel="Backing up…" loading=${backingUp} className="ac-touch" />`
                  : null}
                ${has("dismiss")
                  ? html`<${ActionButton} onClick=${dismiss} tone="subtle" size="sm" idleLabel="Dismiss" className="ac-touch" />`
                  : null}
              </div>`
            : null}
        </section>`
      : null}
    <${RetryUpgradeDialog}
      visible=${dialog === "retry"}
      retry=${data?.retry || null}
      onRetry=${(options) => shell.actions?.retryUpgrade?.(options)}
      onCancel=${() => setDialog(null)}
    />
    <${EnableSnapshotsDialog}
      visible=${dialog === "enable"}
      onDone=${() => {
        setDialog(null);
        void refresh();
      }}
      onCancel=${() => setDialog(null)}
    />
    <${DoctorOutputDialog} visible=${dialog === "logs"} onClose=${() => setDialog(null)} />
  `;
};
