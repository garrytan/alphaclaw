import { h } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import htm from "htm";
import {
  fetchTeamOperators,
  fetchTeamStatus,
  saveTeamOperators,
  setTeamEnabled,
} from "../../lib/api.js";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { ConfirmDialog } from "../confirm-dialog.js";
import { showToast } from "../toast.js";

const html = htm.bind(h);

const kCaveatText =
  "Multi-user identity is a usability feature, not a security boundary — all operators share one password.";

const kFieldClass =
  "w-full bg-field border border-border rounded-lg px-2 py-1.5 text-sm outline-none focus:border-fg-muted";

const newOperatorRow = () => ({ id: "", name: "", email: "", avatar: "" });

const useTeamTab = () => {
  const [status, setStatus] = useState(null);
  const [operators, setOperators] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [confirmToggle, setConfirmToggle] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [statusData, operatorsData] = await Promise.all([
        fetchTeamStatus(),
        fetchTeamOperators(),
      ]);
      setStatus(statusData);
      setOperators(
        Array.isArray(operatorsData?.operators) ? operatorsData.operators : [],
      );
    } catch (error) {
      showToast(error.message || "Could not load team settings", "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSaveOperators = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const cleaned = operators
        .map((operator) => ({
          id: String(operator.id || "").trim(),
          name: String(operator.name || "").trim(),
          email: String(operator.email || "").trim(),
          avatar: String(operator.avatar || "").trim(),
        }))
        .filter((operator) => operator.id);
      const result = await saveTeamOperators(cleaned);
      setOperators(result.operators || []);
      showToast("Operators saved", "success");
      await refresh();
    } catch (error) {
      showToast(error.message || "Could not save operators", "error");
    } finally {
      setSaving(false);
    }
  }, [operators, refresh, saving]);

  const handleConfirmToggle = useCallback(async () => {
    if (!confirmToggle || toggling) return;
    setToggling(true);
    try {
      const result = await setTeamEnabled(confirmToggle.enabled);
      if (result.ok) {
        showToast(
          result.enabled
            ? "Team mode enabled — gateway restarted with trusted-proxy auth"
            : "Team mode disabled — gateway restored to token auth",
          "success",
        );
      }
      setConfirmToggle(null);
      await refresh();
    } catch (error) {
      showToast(error.message || "Team mode change failed", "error");
      await refresh();
    } finally {
      setToggling(false);
    }
  }, [confirmToggle, refresh, toggling]);

  return {
    status,
    operators,
    setOperators,
    loading,
    saving,
    toggling,
    confirmToggle,
    setConfirmToggle,
    handleSaveOperators,
    handleConfirmToggle,
  };
};

const OperatorRow = ({ operator, onChange, onRemove }) => html`
  <div class="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2 items-center">
    <input
      class=${kFieldClass}
      placeholder="id (required)"
      value=${operator.id}
      onInput=${(event) => onChange({ ...operator, id: event.target.value })}
    />
    <input
      class=${kFieldClass}
      placeholder="Name"
      value=${operator.name}
      onInput=${(event) => onChange({ ...operator, name: event.target.value })}
    />
    <input
      class=${kFieldClass}
      placeholder="Email"
      value=${operator.email}
      onInput=${(event) => onChange({ ...operator, email: event.target.value })}
    />
    <input
      class=${kFieldClass}
      placeholder="Avatar URL"
      value=${operator.avatar}
      onInput=${(event) => onChange({ ...operator, avatar: event.target.value })}
    />
    <button
      type="button"
      class="text-xs text-fg-muted hover:text-status-error-muted px-1"
      title="Remove operator"
      onclick=${onRemove}
    >
      ✕
    </button>
  </div>
`;

export const TeamTab = () => {
  const {
    status,
    operators,
    setOperators,
    loading,
    saving,
    toggling,
    confirmToggle,
    setConfirmToggle,
    handleSaveOperators,
    handleConfirmToggle,
  } = useTeamTab();

  if (loading) {
    return html`<p class="text-sm text-fg-muted">Loading team settings...</p>`;
  }

  const enabled = status?.enabled === true;
  const probe = status?.identityProbe || null;
  const probeFailing = enabled && probe && probe.ok !== true;

  return html`
    <div class="space-y-4">
      <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-2">
            <h2 class="card-label">Team web view</h2>
            <${Badge} tone=${enabled ? "success" : "neutral"}>
              ${enabled ? "Enabled" : "Disabled"}
            </${Badge}>
          </div>
          <${ActionButton}
            onClick=${() => setConfirmToggle({ enabled: !enabled })}
            tone=${enabled ? "warning" : "primary"}
            size="md"
            idleLabel=${enabled ? "Disable team mode" : "Enable team mode"}
            className="px-3 py-1.5 rounded-lg text-sm"
          />
        </div>
        <p class="text-xs text-fg-muted">
          Named operators pick who they are at login and their identity is
          forwarded to the OpenClaw gateway on every request.
        </p>
        <p class="text-xs text-status-warning-muted">${kCaveatText}</p>
        ${probeFailing
          ? html`
              <div
                class="border border-status-error-muted rounded-lg px-3 py-2 text-xs text-status-error-muted"
              >
                Identity handshake failing: ${probe.error || "unknown error"}
                ${probe.checkedAt ? ` (checked ${probe.checkedAt})` : ""}.
                Requests to the gateway may be rejected until this recovers.
              </div>
            `
          : null}
        ${enabled
          ? html`
              <p class="text-xs text-fg-muted">
                The built-in Chat tab uses one shared gateway bridge and is not
                attributed per operator yet.
              </p>
            `
          : null}
      </div>

      <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
        <div class="flex items-center justify-between gap-3">
          <h2 class="card-label">Operators</h2>
          <div class="flex items-center gap-2">
            <${ActionButton}
              onClick=${() => setOperators([...operators, newOperatorRow()])}
              tone="secondary"
              size="md"
              idleLabel="Add operator"
              className="px-3 py-1.5 rounded-lg text-sm"
            />
            <${ActionButton}
              onClick=${handleSaveOperators}
              loading=${saving}
              tone="primary"
              size="md"
              idleLabel="Save"
              loadingLabel="Saving..."
              className="px-3 py-1.5 rounded-lg text-sm"
            />
          </div>
        </div>
        ${operators.length === 0
          ? html`<p class="text-xs text-fg-muted">
              No operators yet. Add at least one before enabling team mode.
            </p>`
          : operators.map(
              (operator, index) => html`
                <${OperatorRow}
                  key=${index}
                  operator=${operator}
                  onChange=${(next) =>
                    setOperators(
                      operators.map((entry, entryIndex) =>
                        entryIndex === index ? next : entry,
                      ),
                    )}
                  onRemove=${() =>
                    setOperators(
                      operators.filter((_entry, entryIndex) => entryIndex !== index),
                    )}
                />
              `,
            )}
        <p class="text-2xs text-fg-muted">
          Removing an operator signs their identity out everywhere (sessions
          downgrade to anonymous; the shared password keeps working).
        </p>
      </div>

      <${ConfirmDialog}
        visible=${!!confirmToggle}
        title=${confirmToggle?.enabled ? "Enable team mode?" : "Disable team mode?"}
        message=${confirmToggle?.enabled
          ? "This restarts the OpenClaw gateway and switches it to trusted-proxy authentication: AlphaClaw forwards each operator's identity, gateway token auth is turned off, and internal callers move to the gateway password. If the identity handshake fails, the previous auth config is restored automatically."
          : "This restarts the OpenClaw gateway and restores its previous shared-token authentication. Operator identity will no longer be forwarded."}
        details=${html`<p class="text-xs text-status-warning-muted">${kCaveatText}</p>`}
        confirmLabel=${confirmToggle?.enabled ? "Enable and restart" : "Disable and restart"}
        confirmLoadingLabel="Applying..."
        confirmTone="warning"
        confirmLoading=${toggling}
        onConfirm=${handleConfirmToggle}
        onCancel=${() => (toggling ? null : setConfirmToggle(null))}
      />
    </div>
  `;
};
