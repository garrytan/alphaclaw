import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { useSavedSetting } from "../../hooks/use-saved-setting.js";
import { fetchDoctorSettings, updateDoctorSettings } from "../../lib/api.js";
import { SavedToggle } from "../saved-toggle.js";
import { InlineErrorChip } from "../inline-error-chip.js";
import { showToast } from "../toast.js";
import { getDoctorAutoRunStatusLine } from "./helpers.js";
import { formatInteger } from "../../lib/format.js";

const html = htm.bind(h);

const kDoctorSettingsCacheKey = "/api/doctor/settings";

// Chip headline after a failed save (SavedToggle renders it inline).
const describeScheduledScansSaveError = (attempted) =>
  attempted?.autoRunEnabled
    ? "Couldn't enable scheduled scans — still disabled."
    : "Couldn't disable scheduled scans — still enabled.";

const selectSettingsDoc = (data) => ({
  autoRunEnabled: data?.settings?.autoRunEnabled === true,
  scan: {
    maxFiles: data?.settings?.scan?.maxFiles?.configured ?? null,
    maxFileMb: data?.settings?.scan?.maxFileMb?.configured ?? null,
  },
  scanEffective: {
    maxFiles: data?.settings?.scan?.maxFiles?.effective ?? null,
    maxFileMb: data?.settings?.scan?.maxFileMb?.effective ?? null,
  },
});

// Parses one scan-limit input: "" = null (built-in default), else the raw
// number (server validates bounds loudly — an invalid save reverts + chips).
export const parseScanInputValue = (raw) => {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : trimmed;
};

const ScanLimitInput = ({
  label,
  hint = "",
  configured,
  effective,
  disabled,
  onCommit,
}) => {
  const [draft, setDraft] = useState(configured == null ? "" : String(configured));
  // Server truth changed (save landed or reverted) — resync the draft.
  useEffect(() => {
    setDraft(configured == null ? "" : String(configured));
  }, [configured]);
  const commitDraft = async () => {
    const next = parseScanInputValue(draft);
    const current = configured ?? null;
    if (next === current) return;
    const outcome = await onCommit(next);
    // Failed/busy commits revert server-side truth without changing
    // `configured` — resync the draft so the field never displays a rejected
    // value as if it were accepted.
    if (!outcome?.ok) setDraft(configured == null ? "" : String(configured));
  };
  return html`
    <label class="flex flex-col gap-1 text-xs text-fg-muted min-w-0">
      <span>${label}</span>
      <input
        type="text"
        inputmode="numeric"
        value=${draft}
        placeholder=${effective != null ? `default (${formatInteger(effective)})` : "default"}
        disabled=${disabled}
        onInput=${(event) => setDraft(String(event.currentTarget?.value || ""))}
        onBlur=${commitDraft}
        onKeyDown=${(event) => {
          if (event.key === "Enter") event.currentTarget?.blur?.();
        }}
        class="w-36 bg-field border border-border rounded-lg px-2 py-1.5 text-xs text-body focus:border-fg-muted font-mono"
      />
      ${hint ? html`<span class="text-[10px] text-fg-dim">${hint}</span>` : null}
    </label>
  `;
};

export const DoctorScheduledScans = ({ doctorStatus = null }) => {
  // ONE hook for the whole /api/doctor/settings document (toggle + scan
  // limits) — per the one-hook-per-document convention; each control commits
  // with its own context and the save narrows the PUT body to that field.
  const setting = useSavedSetting({
    cacheKey: kDoctorSettingsCacheKey,
    load: fetchDoctorSettings,
    select: selectSettingsDoc,
    selectSaved: (response) =>
      response?.settings ? selectSettingsDoc(response) : undefined,
    save: (nextDoc, { context } = {}) =>
      String(context || "").startsWith("scan:")
        ? // Single edited cap only — a stale local copy of the SIBLING cap
          // must never be written back (server: undefined = untouched).
          updateDoctorSettings({
            scan: {
              [context.slice("scan:".length)]:
                nextDoc.scan?.[context.slice("scan:".length)] ?? null,
            },
          })
        : updateDoctorSettings({ autoRunEnabled: !!nextDoc.autoRunEnabled }),
    label: "doctor settings",
  });
  if (!doctorStatus) return null;

  const doc = setting.value || null;
  // Until the settings GET resolves, seed the checkbox position from the
  // status payload (SavedToggle still renders it disabled + "Loading...").
  const enabled = setting.hydrated
    ? doc?.autoRunEnabled === true
    : doctorStatus?.autoRun?.enabled === true;
  const autoRunLine = enabled
    ? getDoctorAutoRunStatusLine(doctorStatus?.autoRun)
    : "";
  const currentFileCount = doctorStatus?.workspaceScan?.stats?.totalFiles ?? null;
  const scanSaveError = String(setting.saveError?.context || "").startsWith("scan:")
    ? setting.saveError
    : null;

  const handleToggle = async (next) => {
    // No manual checkbox rollback needed: commit() flips optimistically and,
    // on failure, reverts the value and re-loads server truth — SavedToggle
    // re-renders the switch back and surfaces an inline error chip.
    const outcome = await setting.commit(
      { ...(doc || {}), autoRunEnabled: next === true },
      { context: "autoRun" },
    );
    if (outcome.ok) {
      showToast(
        next ? "Scheduled scans enabled" : "Scheduled scans disabled",
        "success",
      );
    }
  };

  const handleScanCommit = (field) => async (nextValue) => {
    const outcome = await setting.commit(
      {
        ...(doc || {}),
        scan: { ...(doc?.scan || {}), [field]: nextValue },
      },
      { context: `scan:${field}` },
    );
    if (outcome.ok) showToast("Scan limits saved", "success");
    return outcome;
  };

  return html`
    <div
      id="doctor-scan-limits"
      class="bg-surface border border-border rounded-xl p-4 space-y-3"
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="space-y-1 min-w-0">
          <h2 class="card-label">Scheduled scans</h2>
          <p class="text-xs text-fg-muted leading-5">
            Runs Drift Doctor automatically when the workspace goes stale.
            Uses your agent's tokens.
          </p>
        </div>
        <${SavedToggle}
          value=${enabled}
          hydrated=${setting.hydrated}
          saving=${setting.saving}
          savingContext=${setting.savingContext}
          saveError=${String(setting.saveError?.context || "").startsWith("scan:") ? null : setting.saveError}
          loadError=${setting.loadError}
          onRetryLoad=${setting.retryLoad}
          onChange=${handleToggle}
          describe=${describeScheduledScansSaveError}
        />
      </div>
      ${autoRunLine
        ? html`<p class="text-xs text-fg-dim">${autoRunLine}</p>`
        : null}
      <div class="border-t border-border pt-3 space-y-2">
        <div class="space-y-1">
          <h3 class="ac-small-heading">Scan limits</h3>
          <p class="text-xs text-fg-dim leading-5">
            Bounds the workspace fingerprint scan. Leave blank for the
            defaults; changes re-scan immediately, no restart. Tool-owned
            folders (dist, caches, virtualenvs) are always skipped.
          </p>
        </div>
        <div class="flex flex-wrap items-start gap-4">
          <${ScanLimitInput}
            label="Max files"
            hint=${currentFileCount != null
              ? `Current workspace: ${formatInteger(currentFileCount)} files`
              : ""}
            configured=${doc?.scan?.maxFiles ?? null}
            effective=${doc?.scanEffective?.maxFiles ?? null}
            disabled=${!setting.hydrated || setting.saving}
            onCommit=${handleScanCommit("maxFiles")}
          />
          <${ScanLimitInput}
            label="Max file size (MB)"
            configured=${doc?.scan?.maxFileMb ?? null}
            effective=${doc?.scanEffective?.maxFileMb ?? null}
            disabled=${!setting.hydrated || setting.saving}
            onCommit=${handleScanCommit("maxFileMb")}
          />
          ${setting.saving && String(setting.savingContext || "").startsWith("scan:")
            ? html`<span class="text-xs text-fg-dim self-center">Saving...</span>`
            : null}
        </div>
        ${scanSaveError
          ? html`<${InlineErrorChip}
              headline="Couldn't save scan limits — reverted."
              error=${scanSaveError.error}
            />`
          : null}
      </div>
    </div>
  `;
};
