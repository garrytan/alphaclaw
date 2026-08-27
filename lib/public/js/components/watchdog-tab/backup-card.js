import { h } from "preact";
import htm from "htm";
import { useCallback, useState } from "preact/hooks";
import { createOpenclawSqliteBackup } from "../../lib/api.js";
import { useOpenclawFeatures } from "../../hooks/use-openclaw-features.js";
import { ActionButton } from "../action-button.js";
import { showToast } from "../toast.js";

const html = htm.bind(h);

// Verified SQLite backup (OpenClaw 2026.8.1-beta.1+). Version-gated on both
// sides: this card renders nothing unless the feature map says the installed
// gateway ships `openclaw backup sqlite`, and the route 503s otherwise —
// with the feature absent, the Watchdog tab is unchanged.
export const WatchdogSqliteBackupCard = () => {
  const { features } = useOpenclawFeatures();
  const [running, setRunning] = useState(false);
  const [lastTail, setLastTail] = useState("");

  const onCreateBackup = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setLastTail("");
    try {
      const result = await createOpenclawSqliteBackup();
      setLastTail(String(result?.tail || "").trim());
      showToast("Verified SQLite backup created", "success");
    } catch (err) {
      showToast(err?.message || "SQLite backup failed", "error");
    } finally {
      setRunning(false);
    }
  }, [running]);

  if (features?.sqliteBackup !== true) return null;

  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-2">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="card-label">SQLite backup</h2>
        <${ActionButton}
          onClick=${onCreateBackup}
          tone="secondary"
          idleLabel="Create verified SQLite backup"
          loadingLabel="Backing up..."
          loading=${running}
        />
      </div>
      <p class="text-xs text-fg-muted">
        Snapshots the gateway's SQLite state (sessions, auth profiles) with
        verification — safe while the gateway is running.
      </p>
      ${lastTail
        ? html`<pre
            class="ac-surface-inset border border-border rounded-lg p-2 text-xs overflow-x-auto whitespace-pre-wrap"
          >
${lastTail.slice(-2000)}</pre
          >`
        : null}
    </div>
  `;
};
