import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { InfoTooltip } from "../../info-tooltip.js";
import { InlineErrorChip } from "../../inline-error-chip.js";
import { SavedToggle } from "../../saved-toggle.js";
import { showToast } from "../../toast.js";
import { formatInteger } from "../../../lib/format.js";
import {
  fetchOpenclawNotifications,
  triggerWatchdogTestNotification,
  updateOpenclawNotifications,
} from "../../../lib/api.js";
import {
  describeAutoRepairSaveError,
  describeMemoryAutoRestartSaveError,
  describeMemoryBudgetSaveError,
  describeMemoryEnabledSaveError,
  describeMemoryMaxRestartsSaveError,
  describeNotificationsSaveError,
  describeVerboseSaveError,
  kAutoRepairContext,
  kMemoryAutoRestartContext,
  kMemoryBudgetContext,
  kMemoryDefaults,
  kMemoryEnabledContext,
  kMemoryMaxRestartsContext,
  kNotificationsContext,
  kNotificationsVerboseContext,
  parseMemoryBudgetMbInput,
  parseMemoryMaxRestartsPerDayInput,
  useWatchdogMemorySettings,
} from "./use-settings.js";
import {
  buildTestNotificationOutcome,
  formatTestNotificationFailure,
} from "./test-notification.js";

const html = htm.bind(h);

// Fallback only — the live list comes from GET /api/openclaw/notifications
// (supportedChannels), so the select can never drift from what the server
// store accepts.
const kNotifyChannelsFallback = ["telegram", "slack", "discord", "whatsapp"];

const kChannelTargetHelp =
  "Targets: telegram = chat id · slack = user/channel id (+ optional account id) · discord = user id · whatsapp = number";

export const kDefaultRoutingNote =
  "No admin targets set — updates notify every paired user on every channel (default).";

const kSelectClass =
  "bg-field border border-border rounded-lg px-2 py-1 text-xs text-body";
const kInputClass =
  "bg-field border border-border rounded-lg px-2 py-1 text-xs text-body min-w-0 flex-1";

const AdminTargetRow = ({
  target = {},
  index = 0,
  disabled = false,
  channels = kNotifyChannelsFallback,
  onChange = () => {},
  onRemove = () => {},
}) => html`
  <div class="flex flex-wrap items-center gap-2">
    <select
      class=${kSelectClass}
      aria-label="Notification channel"
      value=${target.channel || "telegram"}
      disabled=${disabled}
      onchange=${(event) => onChange(index, { channel: event.target.value })}
    >
      ${(channels || kNotifyChannelsFallback).map(
        (channel) => html`<option value=${channel}>${channel}</option>`,
      )}
    </select>
    <input
      type="text"
      class=${kInputClass}
      aria-label="Notification target" placeholder="target (chat/user id or number)"
      value=${target.target || ""}
      disabled=${disabled}
      oninput=${(event) => onChange(index, { target: event.target.value })}
    />
    <input
      type="text"
      class=${kInputClass}
      aria-label="Account id (optional)" placeholder="account id (optional)"
      value=${target.accountId || ""}
      disabled=${disabled}
      oninput=${(event) => onChange(index, { accountId: event.target.value })}
    />
    <button
      type="button"
      class="text-xs text-fg-muted hover:text-status-error disabled:opacity-50 disabled:cursor-not-allowed"
      disabled=${disabled}
      onclick=${() => onRemove(index)}
    >
      Remove
    </button>
  </div>
`;

// Update-notification routing: preferred channel + explicit admin targets
// (PUT /api/openclaw/notifications). Empty targets = default broadcast.
export const UpdateNotificationsSection = ({
  testButton = null,
}) => {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const [preferredChannel, setPreferredChannel] = useState("");
  const [adminTargets, setAdminTargets] = useState([]);
  const [saving, setSaving] = useState(false);
  const [notifyChannels, setNotifyChannels] = useState(kNotifyChannelsFallback);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data = await fetchOpenclawNotifications();
        if (!active) return;
        if (Array.isArray(data?.supportedChannels) && data.supportedChannels.length) {
          setNotifyChannels(data.supportedChannels);
        }
        setPreferredChannel(data?.notifications?.preferredChannel || "");
        setAdminTargets(
          Array.isArray(data?.notifications?.adminTargets)
            ? data.notifications.adminTargets
            : [],
        );
        setLoadError(null);
      } catch (err) {
        if (!active) return;
        setLoadError(err?.message || "Could not load notification settings");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [loadNonce]);

  const onRetryLoad = () => {
    setLoadError(null);
    setLoading(true);
    setLoadNonce((nonce) => nonce + 1);
  };

  const onChangeTarget = (index, patch) =>
    setAdminTargets((targets) =>
      targets.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    );

  const onRemoveTarget = (index) =>
    setAdminTargets((targets) => targets.filter((_, i) => i !== index));

  const onAddTarget = () =>
    setAdminTargets((targets) => [
      ...targets,
      { channel: "telegram", target: "", accountId: "" },
    ]);

  const onSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const data = await updateOpenclawNotifications({
        preferredChannel: preferredChannel || null,
        adminTargets: adminTargets
          .map((entry) => ({
            channel: entry.channel,
            target: String(entry.target || "").trim(),
            accountId: String(entry.accountId || "").trim() || null,
          }))
          .filter((entry) => entry.target),
      });
      setPreferredChannel(data?.notifications?.preferredChannel || "");
      setAdminTargets(
        Array.isArray(data?.notifications?.adminTargets)
          ? data.notifications.adminTargets
          : [],
      );
      showToast("Update notification settings saved", "success");
    } catch (err) {
      showToast(
        err?.message || "Could not save notification settings",
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  // The frame renders in every state — controls disable while loading or
  // after a failed load; the data never hides the editor.
  const controlsDisabled = saving || loading || Boolean(loadError);

  return html`
    <div class="mt-4 pt-3 border-t border-border space-y-2">
      <div class="flex items-center justify-between gap-3">
        <div class="inline-flex items-center gap-2 text-xs text-fg-muted">
          <span>Update notifications</span>
          <${InfoTooltip}
            text="Where OpenClaw update outcomes (applied, failed, rolled back) are sent."
          />
        </div>
        ${testButton}
      </div>

      ${loading
        ? html`<p class="text-xs text-fg-muted">Loading...</p>`
        : null}
      ${loadError
        ? html`<${InlineErrorChip}
            error=${loadError}
            headline="Couldn't load notification settings."
            onRetry=${onRetryLoad}
          />`
        : null}

      <div class="flex flex-wrap items-center gap-2">
        <label class="text-xs text-fg-muted" for="notify-preferred-channel">Preferred channel</label>
        <select
          id="notify-preferred-channel"
          class=${kSelectClass}
          value=${preferredChannel}
          disabled=${controlsDisabled}
          onchange=${(event) => setPreferredChannel(event.target.value)}
        >
          <option value="">none (all configured channels)</option>
          ${notifyChannels.map(
            (channel) => html`<option value=${channel}>${channel}</option>`,
          )}
        </select>
      </div>

      <div class="space-y-2">
        ${adminTargets.length === 0
          ? loading || loadError
            ? null
            : html`<p class="text-xs text-fg-muted">${kDefaultRoutingNote}</p>`
          : adminTargets.map(
              (target, index) => html`
                <${AdminTargetRow}
                  key=${index}
                  target=${target}
                  index=${index}
                  disabled=${controlsDisabled}
                  channels=${notifyChannels}
                  onChange=${onChangeTarget}
                  onRemove=${onRemoveTarget}
                />
              `,
            )}
        <p class="text-xs text-fg-muted">${kChannelTargetHelp}</p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button
          class="text-xs px-2 py-1 rounded-lg ac-btn-ghost disabled:opacity-50"
          onclick=${onAddTarget}
          disabled=${controlsDisabled}
        >
          Add target
        </button>
        <button
          class="text-xs px-2 py-1 rounded-lg ac-btn-cyan disabled:opacity-50"
          onclick=${onSave}
          disabled=${controlsDisabled}
        >
          ${saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  `;
};

// Number input for the settings rows: kInputClass minus flex-1 (meaningless
// in a column) plus the autotune card's fixed width, mobile numeric keypad,
// and the project's disabled affordance (the toggles dim; so must this).
const kNumberInputClass =
  "bg-field border border-border rounded-lg px-2 py-1 text-xs text-body w-28 focus:outline-none focus:border-fg-muted disabled:opacity-50 disabled:cursor-not-allowed";

// Validation copy for a bounded whole-number field; bounds are formatted with
// thousands separators so a seven-digit ceiling reads as a number, not noise.
export const describeMemoryNumberBounds = ({ min, max, nullable }) =>
  `Enter a whole number between ${formatInteger(min)} and ${formatInteger(max)}${
    nullable ? ", or leave blank" : ""
  }.`;

// Number field for the memory fast-leak profile (issue #56): local draft,
// commits on blur/Enter only when the parsed value is valid AND differs from
// the server value. Feedback follows the house rule "never a silent snap-
// back": an invalid draft or a failed save renders an InlineErrorChip next to
// the control (the chip takes `headline`/`error`, not `text`). A failed
// commit also re-seeds the draft from server truth so the rejected text is
// not re-sent on the next blur.
export const MemoryNumberField = ({
  label,
  tooltip,
  ariaLabel,
  value,
  placeholder = "",
  nullable = false,
  min,
  max,
  step = 1,
  parse,
  describe,
  context,
  hydrated = false,
  saving = false,
  savingContext = null,
  saveError = null,
  disabled = false,
  onCommit = async () => ({ ok: true }),
  helper = null,
}) => {
  const serverText = value === null || value === undefined ? "" : String(value);
  const [draft, setDraft] = useState(serverText);
  const [invalid, setInvalid] = useState(false);
  // <input type="number"> reports value "" for an UNPARSEABLE draft ("1e",
  // "-", "12abc") — indistinguishable from an intentional clear without the
  // validity flag. A typo must never silently PUT {budgetMb: null}.
  const [badInput, setBadInput] = useState(false);
  useEffect(() => {
    setDraft(serverText);
    setInvalid(false);
    setBadInput(false);
  }, [serverText]);
  const busy = saving && savingContext === context;
  const bounds = { min, max };
  const commit = async () => {
    const parsed = badInput ? undefined : parse(draft, bounds);
    if (parsed === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const current = value === undefined ? null : value;
    if (parsed === current) return;
    const outcome = await onCommit(parsed);
    // Reverted to the SAME server value → serverText did not change, so the
    // effect above never re-seeds; do it here so the rejected draft is gone.
    if (outcome && outcome.ok === false) {
      setDraft(serverText);
      setBadInput(false);
    }
  };
  const ownSaveError =
    saveError && saveError.context === context ? saveError : null;
  return html`
    <div class="flex items-center justify-between gap-3">
      <div class="inline-flex items-center gap-2 text-xs text-fg-muted">
        <span>${label}</span>
        <${InfoTooltip} text=${tooltip} />
      </div>
      <div class="flex flex-col items-end gap-1">
        <input
          type="number"
          inputmode="numeric"
          class=${kNumberInputClass}
          aria-label=${ariaLabel}
          aria-invalid=${invalid ? "true" : "false"}
          placeholder=${placeholder}
          min=${min}
          max=${max}
          step=${step}
          value=${draft}
          disabled=${disabled || !hydrated || busy}
          oninput=${(event) => {
            setDraft(event.target.value);
            setBadInput(event.target.validity?.badInput === true);
            setInvalid(false);
          }}
          onblur=${() => void commit()}
          onkeydown=${(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commit();
            }
          }}
        />
        ${invalid
          ? html`<${InlineErrorChip}
              headline=${describeMemoryNumberBounds({ min, max, nullable })}
            />`
          : ownSaveError
            ? html`<${InlineErrorChip}
                error=${ownSaveError.error}
                headline=${describe(ownSaveError.attempted)}
              />`
            : helper
              ? html`<span class="text-xs text-fg-dim">${helper}</span>`
              : null}
      </div>
    </div>
  `;
};

// Memory-leak monitor toggles: a self-contained section on its own settings
// document (GET/PUT /api/watchdog/memory), UpdateNotificationsSection style.
// Detection is report-only and DEFAULT ON; auto-restart is the operator
// consent knob (default OFF) and renders disabled while detection is off —
// effective enforcement is always enabled && autoRestart.
export const MemoryMonitorSection = () => {
  const memory = useWatchdogMemorySettings();
  const detectionOn = memory.memorySettings.enabled === true;
  return html`
    <div class="mt-4 pt-3 border-t border-border space-y-3">
      <div class="flex items-center justify-between gap-3">
        <div class="inline-flex items-center gap-2 text-xs text-fg-muted">
          <span>Memory leak detection</span>
          <${InfoTooltip}
            text="Samples gateway memory (RSS) once a minute and warns when it rises steadily toward the limit. Report-only: events, notifications, and a Drift Doctor finding."
          />
        </div>
        <${SavedToggle}
          value=${memory.memorySettings.enabled === true}
          hydrated=${memory.memoryHydrated}
          saving=${memory.savingMemory}
          savingContext=${memory.savingMemoryContext}
          saveError=${memory.memorySaveError}
          loadError=${memory.memoryLoadError}
          onRetryLoad=${memory.onRetryLoadMemory}
          onChange=${memory.onToggleMemoryEnabled}
          describe=${describeMemoryEnabledSaveError}
          context=${kMemoryEnabledContext}
        />
      </div>
      <div class="flex items-center justify-between gap-3">
        <div class="inline-flex items-center gap-2 text-xs text-fg-muted">
          <span>Auto-restart before OOM</span>
          <${InfoTooltip}
            text="When a confirmed leak turns critical, the watchdog restarts the gateway before it runs out of memory — at most the per-day budget below (default twice), never during an update. A restart delays the leak; the Doctor finding is the fix path."
          />
        </div>
        <${SavedToggle}
          value=${memory.memorySettings.autoRestart === true}
          hydrated=${memory.memoryHydrated}
          saving=${memory.savingMemory}
          savingContext=${memory.savingMemoryContext}
          saveError=${memory.memorySaveError}
          loadError=${memory.memoryLoadError}
          onRetryLoad=${memory.onRetryLoadMemory}
          onChange=${memory.onToggleMemoryAutoRestart}
          describe=${describeMemoryAutoRestartSaveError}
          context=${kMemoryAutoRestartContext}
          disabled=${!detectionOn}
        />
      </div>
      <${MemoryNumberField}
        label="Memory budget (MB)"
        tooltip="Optional cap on the gateway's memory (whole process tree) for a diagnosed fast leak. Critical fires at 90% of the tightest of this budget, the heap cap, and the container limit. Must sit above the gateway's current usage. Leave blank to derive the cap automatically."
        ariaLabel="Gateway memory budget in MB"
        placeholder="auto"
        nullable=${true}
        value=${memory.memorySettings.budgetMb ?? null}
        min=${memory.memoryBounds.budgetMb.min}
        max=${memory.memoryBounds.budgetMb.max}
        step=${64}
        parse=${parseMemoryBudgetMbInput}
        describe=${describeMemoryBudgetSaveError}
        context=${kMemoryBudgetContext}
        hydrated=${memory.memoryHydrated}
        saving=${memory.savingMemory}
        savingContext=${memory.savingMemoryContext}
        saveError=${memory.memorySaveError}
        disabled=${!detectionOn}
        helper=${memory.memoryHydrated && !detectionOn
          ? "Enable memory leak detection to edit."
          : null}
        onCommit=${memory.onCommitMemoryBudgetMb}
      />
      <${MemoryNumberField}
        label="Auto-restarts per day"
        tooltip="How many pre-OOM restarts the watchdog may perform per rolling 24 hours (1–24). Restarts are spaced at least min(6h, 24h ÷ (2 × budget)) apart, so 2 keeps the original 6-hour spacing and 12 allows one per hour. Raise it only for a diagnosed leak while the fix is in progress."
        ariaLabel="Maximum pre-OOM auto-restarts per day"
        value=${memory.memorySettings.maxRestartsPerDay ??
        kMemoryDefaults.maxRestartsPerDay}
        min=${memory.memoryBounds.maxRestartsPerDay.min}
        max=${memory.memoryBounds.maxRestartsPerDay.max}
        parse=${parseMemoryMaxRestartsPerDayInput}
        describe=${describeMemoryMaxRestartsSaveError}
        context=${kMemoryMaxRestartsContext}
        hydrated=${memory.memoryHydrated}
        saving=${memory.savingMemory}
        savingContext=${memory.savingMemoryContext}
        saveError=${memory.memorySaveError}
        disabled=${!detectionOn || memory.memorySettings.autoRestart !== true}
        helper=${memory.memoryHydrated && detectionOn &&
        memory.memorySettings.autoRestart !== true
          ? "Arm auto-restart to edit."
          : null}
        onCommit=${memory.onCommitMemoryMaxRestartsPerDay}
      />
      ${memory.memoryHydrated && !detectionOn
        ? html`<p class="text-xs text-fg-dim">
            Auto-restart is inactive while detection is off — enable memory
            leak detection to arm it.
          </p>`
        : null}
    </div>
  `;
};

export const WatchdogSettingsCard = ({
  settings = {},
  settingsHydrated = false,
  savingSettings = false,
  savingSettingsContext = null,
  settingsSaveError = null,
  settingsLoadError = null,
  onRetryLoadSettings = () => {},
  onToggleAutoRepair = () => {},
  onToggleNotifications = () => {},
  onToggleNotificationsVerbose = () => {},
}) => {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  // Success stays a toast; a 502 (every channel failed) or a partial delivery
  // renders the per-channel failures INLINE — the operator must see which
  // channel/target refused and why (issue #54: Telegram parse errors were
  // invisible behind a bare "failed" toast).
  const handleTestNotification = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const data = await triggerWatchdogTestNotification();
      const outcome = buildTestNotificationOutcome({ data });
      showToast(outcome.message, outcome.hasFailures ? "warning" : "success");
      if (outcome.failures.length > 0) setTestResult(outcome);
    } catch (err) {
      setTestResult(buildTestNotificationOutcome({ error: err }));
    } finally {
      setTesting(false);
    }
  };

  const formatResult = (outcome) => {
    if (!outcome) return null;
    return html`
      <div class="space-y-1" role="status" aria-live="polite">
        <p
          class=${`text-xs ${
            outcome.ok ? "text-status-warning-muted" : "text-status-error-muted"
          }`}
        >
          ${outcome.message}
        </p>
        ${outcome.failures.length > 0
          ? html`<ul class="space-y-0.5">
              ${outcome.failures.map(
                (failure, index) => html`
                  <li
                    key=${`${failure.channel}-${failure.target || index}`}
                    class="text-xs text-fg-muted font-mono break-words"
                  >
                    ${formatTestNotificationFailure(failure)}
                  </li>
                `,
              )}
            </ul>`
          : null}
      </div>
    `;
  };

  // Lives next to the Update-notifications editor (that's what it exercises),
  // still gated on the notifications kill switch above.
  const testButton = html`
    <button
      class=${`text-xs px-2 py-1 rounded-lg ac-btn-ghost disabled:opacity-50 disabled:cursor-not-allowed ${
        settings.notificationsEnabled ? "" : "invisible pointer-events-none"
      }`}
      onClick=${handleTestNotification}
      disabled=${testing || savingSettings || !settings.notificationsEnabled}
      aria-hidden=${!settings.notificationsEnabled}
      tabIndex=${settings.notificationsEnabled ? 0 : -1}
    >
      ${testing ? "Sending..." : "Test"}
    </button>
  `;

  return html`
    <div class="bg-surface border border-border rounded-xl p-4">
      <div class="flex items-center justify-between gap-3">
        <div class="inline-flex items-center gap-2 text-xs text-fg-muted">
          <span>Auto-repair</span>
          <${InfoTooltip}
            text="Automatically runs OpenClaw doctor repair when watchdog detects gateway health failures or crash loops."
          />
        </div>
        <${SavedToggle}
          value=${settings.autoRepair === true}
          hydrated=${settingsHydrated}
          saving=${savingSettings}
          savingContext=${savingSettingsContext}
          saveError=${settingsSaveError}
          loadError=${settingsLoadError}
          onRetryLoad=${onRetryLoadSettings}
          onChange=${onToggleAutoRepair}
          describe=${describeAutoRepairSaveError}
          context=${kAutoRepairContext}
        />
      </div>
      <div class="flex items-center justify-between gap-3 mt-3">
        <div class="inline-flex items-center gap-2 text-xs text-fg-muted">
          <span>Notifications</span>
          <${InfoTooltip}
            text="Sends channel notices for watchdog alerts and auto-repair outcomes."
          />
        </div>
        <${SavedToggle}
          value=${settings.notificationsEnabled === true}
          hydrated=${settingsHydrated}
          saving=${savingSettings}
          savingContext=${savingSettingsContext}
          saveError=${settingsSaveError}
          loadError=${settingsLoadError}
          onRetryLoad=${onRetryLoadSettings}
          onChange=${onToggleNotifications}
          describe=${describeNotificationsSaveError}
          context=${kNotificationsContext}
        />
      </div>
      <div class="flex items-center justify-between gap-3 mt-3">
        <div class="inline-flex items-center gap-2 text-xs text-fg-muted">
          <span>Verbosity</span>
          <${InfoTooltip}
            text="On: every notice, including informational ones (gateway back online, health OK, update progress). Off: only problems, actions AlphaClaw took automatically, and anything needing your intervention. Requires Notifications to be on."
          />
        </div>
        <${SavedToggle}
          value=${settings.notificationsVerbose === true}
          hydrated=${settingsHydrated}
          saving=${savingSettings}
          savingContext=${savingSettingsContext}
          saveError=${settingsSaveError}
          loadError=${settingsLoadError}
          onRetryLoad=${onRetryLoadSettings}
          onChange=${onToggleNotificationsVerbose}
          describe=${describeVerboseSaveError}
          context=${kNotificationsVerboseContext}
          labels=${{ on: "Verbose", off: "Important only" }}
          disabled=${settings.notificationsEnabled !== true}
        />
      </div>
      ${settingsHydrated &&
      settings.notificationsEnabled === true &&
      settings.notificationsVerbose === false
        ? html`<p class="mt-2 text-xs text-fg-dim">
            Informational notices are suppressed from chat. Problems, automatic
            fixes, and anything needing you still arrive.
          </p>`
        : null}
      <${MemoryMonitorSection} />
      ${testResult
        ? html`<div class="mt-2">${formatResult(testResult)}</div>`
        : null}
      <${UpdateNotificationsSection} testButton=${testButton} />
    </div>
  `;
};
