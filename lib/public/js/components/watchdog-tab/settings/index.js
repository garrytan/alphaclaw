import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { InfoTooltip } from "../../info-tooltip.js";
import { ToggleSwitch } from "../../toggle-switch.js";
import { showToast } from "../../toast.js";
import {
  fetchOpenclawNotifications,
  updateOpenclawNotifications,
} from "../../../lib/api.js";

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
  }, []);

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
        ? html`<p class="text-xs text-status-error-muted">${loadError}</p>`
        : null}

      ${!loading && !loadError
        ? html`
            <div class="flex flex-wrap items-center gap-2">
              <label class="text-xs text-fg-muted" for="notify-preferred-channel">Preferred channel</label>
              <select
                id="notify-preferred-channel"
                class=${kSelectClass}
                value=${preferredChannel}
                disabled=${saving}
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
                ? html`<p class="text-xs text-fg-muted">
                    ${kDefaultRoutingNote}
                  </p>`
                : adminTargets.map(
                    (target, index) => html`
                      <${AdminTargetRow}
                        key=${index}
                        target=${target}
                        index=${index}
                        disabled=${saving}
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
                disabled=${saving}
              >
                Add target
              </button>
              <button
                class="text-xs px-2 py-1 rounded-lg ac-btn-cyan disabled:opacity-50"
                onclick=${onSave}
                disabled=${saving}
              >
                ${saving ? "Saving..." : "Save"}
              </button>
            </div>
          `
        : null}
    </div>
  `;
};

export const WatchdogSettingsCard = ({
  settings = {},
  savingSettings = false,
  onToggleAutoRepair = () => {},
  onToggleNotifications = () => {},
}) => {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const handleTestNotification = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/watchdog/test-notification", { method: "POST" });
      const data = await res.json();
      if (!data?.ok) {
        setTestResult(data);
        return;
      }

      const channels = data.result?.channels || data.result || {};
      const parts = [];
      for (const channel of ["telegram", "discord", "slack"]) {
        const ch = channels[channel];
        if (!ch || ch.skipped) continue;
        if (ch.sent > 0) parts.push(`${channel}: ${ch.sent} sent`);
        if (ch.failed > 0) parts.push(`${channel}: ${ch.failed} failed`);
      }

      if (parts.length === 0) {
        showToast("No channels configured", "warning");
        return;
      }

      const hasFailures = parts.some((part) => part.includes("failed"));
      showToast(
        hasFailures ? parts.join(", ") : `Test notification sent: ${parts.join(", ")}`,
        hasFailures ? "warning" : "success",
      );
    } catch (err) {
      setTestResult({ ok: false, error: err.message });
    } finally {
      setTesting(false);
    }
  };

  const formatResult = (result) => {
    if (!result) return null;
    return html`<span class="text-status-error-muted text-xs">
      ${result.error || "Failed"}
    </span>`;
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
        <${ToggleSwitch}
          checked=${!!settings.autoRepair}
          disabled=${savingSettings}
          onChange=${onToggleAutoRepair}
          label=""
        />
      </div>
      <div class="flex items-center justify-between gap-3 mt-3">
        <div class="inline-flex items-center gap-2 text-xs text-fg-muted">
          <span>Notifications</span>
          <${InfoTooltip}
            text="Sends channel notices for watchdog alerts and auto-repair outcomes."
          />
        </div>
        <${ToggleSwitch}
          checked=${!!settings.notificationsEnabled}
          disabled=${savingSettings}
          onChange=${onToggleNotifications}
          label=""
        />
      </div>
      ${testResult
        ? html`<div class="mt-2">${formatResult(testResult)}</div>`
        : null}
      <${UpdateNotificationsSection} testButton=${testButton} />
    </div>
  `;
};
