import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { useModelCheck } from "./use-model-check.js";
import { formatLocaleDateTime } from "../../lib/format.js";

const html = htm.bind(h);

const kSeverityBadge = {
  ok: { tone: "success", label: "OK" },
  info: { tone: "neutral", label: "Not tested" },
  warn: { tone: "warning", label: "Check again" },
  error: { tone: "danger", label: "Won't run" },
};
const kSeverityOrder = { error: 0, warn: 1, info: 2, ok: 3 };

const ResultRow = ({ result }) => {
  const badge = kSeverityBadge[result.severity] || kSeverityBadge.info;
  return html`
    <div class="py-2 px-2 rounded-lg space-y-1">
      <div class="flex items-center gap-2 min-w-0">
        <span class="text-sm text-body truncate font-mono">${result.ref}</span>
        <${Badge} tone=${badge.tone}>${badge.label}</${Badge}>
        ${result.aliases?.length
          ? html`<span class="text-xs text-fg-dim truncate">alias ${result.aliases.join(", ")}</span>`
          : null}
      </div>
      <p class="text-xs text-fg-muted break-words">${result.reason}</p>
      ${result.fix
        ? html`<p class="text-xs text-body break-words"><span class="font-medium">Fix:</span> ${result.fix}</p>`
        : null}
      ${(result.notes || []).map((note) => html`<p class="text-xs text-status-warning-muted break-words">${note}</p>`)}
    </div>
  `;
};

const summaryOf = (lastRun, total) =>
  lastRun.problems ? `${lastRun.problems} of ${total} won't run` : `none of ${total} is known to fail`;

export const ModelCheckCard = () => {
  const { lastRun, failures, loading, error, running, runCheck } = useModelCheck();
  const results = [...(lastRun?.results || [])].sort(
    (a, b) => (kSeverityOrder[a.severity] ?? 9) - (kSeverityOrder[b.severity] ?? 9) || a.ref.localeCompare(b.ref),
  );
  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div class="flex items-center justify-between gap-2">
        <h2 class="card-label">Model check</h2>
        <${ActionButton}
          onClick=${runCheck}
          disabled=${running}
          loading=${running}
          loadingMode="inline"
          tone="secondary"
          size="sm"
          idleLabel="Check models"
          loadingLabel="Checking…"
          className="text-xs"
        />
      </div>
      <p class="text-xs text-fg-muted">
        Tests every model this box offers, including the ones a chat can pick with /model. Custom providers get one request
        of at most 16 tokens per model. Nothing is changed.
      </p>
      ${failures.length
        ? html`<div class="space-y-1">
            <p class="text-xs font-medium text-status-error-muted">Recent "model not found" failures</p>
            ${failures.slice(0, 5).map(
              (failure) => html`<p class="text-xs text-fg-muted break-words">
                <span class="font-mono text-body">${failure.model}</span> · ${formatLocaleDateTime(failure.at)}${failure.override
                  ? " · picked with /model, so fallbacks were off"
                  : ""}${failure.detail ? html`<br />${failure.detail}` : null}
              </p>`,
            )}
          </div>`
        : null}
      ${loading
        ? html`<p class="text-xs text-fg-dim">Loading the last check…</p>`
        : !lastRun
          ? html`<p class="text-xs text-fg-dim">No check has run since AlphaClaw started.</p>`
          : html`
              <p class="text-xs text-fg-dim">Last checked ${formatLocaleDateTime(lastRun.checkedAt)}: ${summaryOf(lastRun, results.length)}.</p>
              <div class="space-y-1">${results.map((result) => html`<${ResultRow} key=${result.ref} result=${result} />`)}</div>
            `}
      ${error ? html`<p class="text-xs text-status-error-muted">${error}</p>` : null}
    </div>
  `;
};
