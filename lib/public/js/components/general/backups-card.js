import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { InlineErrorChip } from "../inline-error-chip.js";
import { useCachedFetch } from "../../hooks/use-cached-fetch.js";
import { usePolling } from "../../hooks/usePolling.js";
import {
  createOpenclawBackup,
  fetchOpenclawBackupStatus,
} from "../../lib/api.js";
import { formatBytes, formatLocaleDateTime } from "../../lib/format.js";

const html = htm.bind(h);

const kBackupStatusKey = "/api/openclaw/backup";
const kBackupPollMs = 3000;

export const buildBackupResultModel = (last = null) => {
  if (!last || typeof last !== "object") return null;
  const when = formatLocaleDateTime(last.finishedAt || last.startedAt, {
    fallback: null,
  });
  if (last.ok) {
    return {
      ok: true,
      archivePath: last.archivePath || null,
      size: Number.isFinite(last.bytes) ? formatBytes(last.bytes) : null,
      when,
    };
  }
  return { ok: false, error: last.error || "Backup failed.", when };
};

export const BackupsCard = ({ isActive = true }) => {
  const status = useCachedFetch(kBackupStatusKey, fetchOpenclawBackupStatus, {
    enabled: isActive,
  });
  const running = status.data?.running === true;
  usePolling(fetchOpenclawBackupStatus, kBackupPollMs, {
    enabled: isActive && running,
    cacheKey: kBackupStatusKey,
  });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(null);

  const onBackUp = async () => {
    if (starting || running) return;
    setStarting(true);
    setStartError(null);
    try {
      await createOpenclawBackup();
    } catch (err) {
      if (err?.code !== "backup_in_progress") setStartError(err);
    }
    await status.refresh({ force: true }).catch(() => null);
    setStarting(false);
  };

  const result = buildBackupResultModel(status.data?.last);

  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-2">
      <div class="flex items-center justify-between gap-3">
        <h2 class="font-semibold text-sm">Backups</h2>
        <${ActionButton}
          onClick=${onBackUp}
          tone="secondary"
          idleLabel="Back up now"
          loadingLabel="Backing up…"
          loading=${running || starting}
        />
      </div>
      <p class="text-xs text-fg-muted">
        Runs OpenClaw's own backup (<code>openclaw backup create</code>) into
        the backups folder.
      </p>
      ${result?.ok
        ? html`<p class="text-xs text-body break-all">
            Last backup: <code>${result.archivePath || "archive path unavailable"}</code>${result.size
              ? ` · ${result.size}`
              : ""}${result.when ? ` · ${result.when}` : ""}
          </p>`
        : null}
      ${result && !result.ok
        ? html`<p class="text-xs text-status-error break-words">
            Last backup failed${result.when ? ` (${result.when})` : ""}:
            ${result.error}
          </p>`
        : null}
      <${InlineErrorChip}
        error=${startError}
        headline=${startError ? "Couldn't start the backup." : null}
      />
      ${status.error && !status.data
        ? html`<${InlineErrorChip}
            error=${status.error}
            headline="Couldn't read the backup status."
            onRetry=${() => status.refresh({ force: true }).catch(() => null)}
          />`
        : null}
    </div>
  `;
};
