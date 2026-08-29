import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { showToast } from "./toast.js";
import { InfoTooltip } from "./info-tooltip.js";
import { ToggleSwitch } from "./toggle-switch.js";
import { ActionButton } from "./action-button.js";
import { usePolling } from "../hooks/usePolling.js";
import {
  updateAgentAdminFeature,
  rotateAgentAdminToken,
  fetchAgentAdminConfirms,
} from "../lib/api.js";

const html = htm.bind(h);

const kConfirmsPollMs = 10000;
const kConfirmsShown = 5;

// "Agent Administration" panel (General tab). Lets the OpenClaw agent
// administer this deployment via the `alphaclaw admin` CLI. Honest framing:
// this is NOT a security boundary against the agent — it exists for audit,
// revocation, and keeping secrets out of transcripts.
export const AgentAdminPanel = ({
  agentAdmin = null,
  onToggle = () => {},
  onRotated = () => {},
  isActive = false,
}) => {
  const state = agentAdmin?.state || "disabled";
  const enabled = state !== "disabled";
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);

  // Poll pending confirm codes while the tab is active and the feature is on.
  // usePolling pauses when the browser tab is hidden (repo convention).
  const { data: confirmsData } = usePolling(
    fetchAgentAdminConfirms,
    kConfirmsPollMs,
    { enabled: enabled && isActive, cacheKey: "/api/admin/confirms", dedupeInFlight: true },
  );
  const pendingConfirms = confirmsData?.confirms || [];

  const handleToggle = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await updateAgentAdminFeature(!enabled);
      onToggle(!enabled);
      showToast(
        !enabled
          ? "Agent Administration enabled — active on the agent's next session"
          : "Agent Administration disabled",
        "success",
      );
    } catch (e) {
      showToast(e.message || "Could not update the setting", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleRotate = async () => {
    if (rotating) return;
    setRotating(true);
    try {
      await rotateAgentAdminToken();
      onRotated();
      showToast("Agent-admin token rotated", "success");
    } catch (e) {
      showToast(e.message || "Could not rotate token", "error");
    } finally {
      setRotating(false);
    }
  };

  return html`
    <div class="bg-surface border border-border rounded-xl p-4">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-1.5 min-w-0">
          <h2 class="card-label">Agent Administration</h2>
          <${InfoTooltip}
            text="Lets the OpenClaw agent administer this deployment (env, channels, agents, cron, webhooks, models, updates, watchdog) on behalf of admin users. Not a security boundary — the agent already holds these credentials; this adds an audit trail, revocation, and tiered guardrails."
            widthClass="w-80"
          />
        </div>
        <${ToggleSwitch}
          checked=${enabled}
          disabled=${saving}
          label=${saving ? "Saving..." : enabled ? "Enabled" : "Disabled"}
          onChange=${handleToggle}
        />
      </div>

      ${enabled
        ? html`
            <div class="mt-3 text-xs text-fg-muted">
              ${state === "unavailable"
                ? html`<span class="text-status-error">⚠ Token unavailable (mint failure) — check server logs.</span>`
                : html`Active on the agent's <strong>next session</strong>. Ask your agent: <code class="font-mono">check alphaclaw status</code>.`}
            </div>
            ${pendingConfirms.length
              ? html`
                  <div class="mt-3 border-t border-border pt-3">
                    <div class="text-xs text-fg-muted mb-1">
                      Pending confirmations (${pendingConfirms.length})
                    </div>
                    ${pendingConfirms.slice(0, kConfirmsShown).map(
                      (c) => html`
                        <div class="flex items-center justify-between gap-2 text-xs py-1">
                          <span class="min-w-0 truncate text-body">${c.summary || c.op}</span>
                          <code class="font-mono bg-field border border-border rounded px-2 py-0.5 shrink-0">${c.code}</code>
                        </div>
                      `,
                    )}
                    ${pendingConfirms.length > kConfirmsShown
                      ? html`<div class="text-xs text-fg-dim">
                          +${pendingConfirms.length - kConfirmsShown} more
                        </div>`
                      : null}
                    <div class="text-xs text-fg-dim mt-1">
                      Give a code to an admin to approve a pending dangerous operation.
                    </div>
                  </div>
                `
              : null}
            <div class="mt-3 flex items-center gap-2">
              <${ActionButton}
                tone="secondary"
                size="sm"
                idleLabel="Rotate token"
                loadingLabel="Rotating..."
                loading=${rotating}
                onClick=${handleRotate}
              />
              <a
                class="ac-tip-link text-xs"
                href="https://github.com/chrysb/alphaclaw#agent-administration"
                target="_blank"
                rel="noreferrer"
                >Learn more</a
              >
            </div>
          `
        : null}
    </div>
  `;
};
