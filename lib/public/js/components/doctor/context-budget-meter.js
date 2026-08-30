import { h } from "preact";
import htm from "htm";
import { Badge } from "../badge.js";
import { formatInteger } from "../../lib/format.js";
import { formatDoctorCharCount } from "./helpers.js";

const html = htm.bind(h);

const kFileStateChips = {
  ok: { tone: "success", label: "OK" },
  "near-limit": { tone: "warning", label: "Near limit" },
  truncated: { tone: "danger", label: "Truncated" },
  starved: { tone: "warning", label: "Starved" },
  blocked: { tone: "danger", label: "Blocked" },
};

const kBarToneClasses = {
  danger: "bg-status-error",
  warning: "bg-status-warning",
  ok: "bg-status-success",
};

const getMeterFileState = (file = {}) => {
  if (file.skipped) {
    return file.reason === "starved" ? "starved" : "blocked";
  }
  if (file.injectable === false) return "blocked";
  // An extra that OpenClaw is not injecting (active:false with any
  // activeReason — hook_disabled or invalid_basename) never reaches the
  // agent; it must not read as OK when the hardening badge says blocked.
  if (file.kind === "extra" && file.active === false) return "blocked";
  if (file.truncated) return "truncated";
  if (file.nearFileLimit) return "near-limit";
  return "ok";
};

export const buildContextBudgetMeterModel = (doctorStatus = null) => {
  const bootstrapContext = doctorStatus?.bootstrapContext || null;
  // Old server payloads lack `files`/`hardening`; hide the meter entirely.
  if (
    !bootstrapContext ||
    !Array.isArray(bootstrapContext.files) ||
    !bootstrapContext.hardening ||
    typeof bootstrapContext.hardening !== "object"
  ) {
    return null;
  }
  const files = bootstrapContext.files.filter(
    (file) => file?.exists && (file.active || file.kind === "extra"),
  );
  if (!files.length) return null;
  const usedChars = Number(bootstrapContext.activeInjectedChars || 0);
  const budgetChars = Number(bootstrapContext.bootstrapTotalMaxChars || 0);
  const percentUsed =
    budgetChars > 0
      ? Math.min(100, Math.round((usedChars / budgetChars) * 100))
      : 0;
  const barTone =
    bootstrapContext.hasActiveTruncation || bootstrapContext.totalLimitReached
      ? "danger"
      : bootstrapContext.nearTotalLimit ||
          bootstrapContext.hasActiveNearLimitFiles
        ? "warning"
        : "ok";
  const rows = files.map((file) => {
    const state = getMeterFileState(file);
    return {
      path: String(file.path || ""),
      detail: `${formatInteger(file.injectedChars)} / ${formatInteger(
        file.rawChars,
      )} chars`,
      state,
      chip: kFileStateChips[state] || kFileStateChips.ok,
    };
  });
  const summary =
    budgetChars > 0
      ? `${formatInteger(usedChars)} / ${formatDoctorCharCount(budgetChars)}`
      : formatDoctorCharCount(usedChars);
  return { usedChars, budgetChars, percentUsed, barTone, rows, summary };
};

export const ContextBudgetMeter = ({
  doctorStatus = null,
  onOpenFile = () => {},
}) => {
  if (!doctorStatus) return null;
  const model = buildContextBudgetMeterModel(doctorStatus);
  if (!model) return null;
  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="card-label">Estimated context injection</h2>
        <span class="text-xs text-fg-muted">${model.summary}</span>
      </div>
      <div
        class="h-1.5 w-full rounded-full bg-field overflow-hidden"
        role="meter"
        aria-label="Estimated context injection"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow=${model.percentUsed}
      >
        <div
          class="h-full rounded-full ${kBarToneClasses[model.barTone] ||
          kBarToneClasses.ok}"
          style="width: ${model.percentUsed}%"
        ></div>
      </div>
      <div class="space-y-2">
        ${model.rows.map(
          (row) => html`
            <div
              key=${row.path}
              class="flex items-center justify-between gap-3 text-xs"
            >
              <button
                type="button"
                class="font-mono text-body ac-tip-link hover:underline text-left cursor-pointer truncate"
                onClick=${() => onOpenFile(row.path)}
              >
                ${row.path}
              </button>
              <span class="flex items-center gap-3 whitespace-nowrap">
                <span class="text-fg-muted">${row.detail}</span>
                <${Badge} tone=${row.chip.tone}>${row.chip.label}<//>
              </span>
            </div>
          `,
        )}
      </div>
      <p class="text-xs text-fg-dim leading-5">
        These numbers are an estimate — run${" "}
        <code class="font-mono">/context</code>${" "}
        on your agent for the authoritative view.
      </p>
    </div>
  `;
};
