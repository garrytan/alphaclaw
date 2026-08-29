import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { showToast } from "./toast.js";
import { InfoTooltip } from "./info-tooltip.js";
import { ToggleSwitch } from "./toggle-switch.js";
import { ActionButton } from "./action-button.js";
import {
  updateAgentAdminFeature,
  rotateAgentAdminToken,
  fetchAgentAdminConfirms,
} from "../lib/api.js";

const html = htm.bind(h);

// "Agent Administration" panel (General tab). Lets the OpenClaw agent
// administer this deployment via the `alphaclaw admin` CLI. Honest framing:
// this is NOT a security boundary against the agent — it exists for audit,
// revocation, and keeping secrets out of transcripts.
export const AgentAdminPanel = ({
  agentAdmin = null,
  saving = false,
  onToggle = () => {},
  onRotated = () => {},
  isActive = false,
}) => {
  const state = agentAdmin?.state || "disabled";
  const enabled = state !== "disabled";
  const [pendingConfirms, setPendingConfirms] = useState([]);

  // Poll pending confirm codes while the tab is active and the feature is on.
  useEffect(() => {
    if (!enabled || !isActive) {
      setPendingConfirms([]);
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const data = await fetchAgentAdminConfirms();
        if (!cancelled) setPendingConfirms(data?.confirms || []);
      } catch {
        /* transient — leave prior list */
      }
    };
    load();
    const timer = setInterval(load, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, isActive]);

  const handleToggle = async () => {
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
    }
  };

  const handleRotate = async () => {
    try {
      await rotateAgentAdminToken();
      onRotated();
      showToast("Agent-admin token rotated", "success");
    } catch (e) {
      showToast(e.message || "Could not rotate token", "error");
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
                    ${pendingConfirms.slice(0, 5).map(
                      (c) => html`
                        <div class="flex items-center justify-between gap-2 text-xs py-1">
                          <span class="min-w-0 truncate text-body">${c.summary || c.op}</span>
                          <code class="font-mono bg-field border border-border rounded px-2 py-0.5 shrink-0">${c.code}</code>
                        </div>
                      `,
                    )}
                    <div class="text-xs text-fg-dim mt-1">
                      Give a code to an admin to approve a pending dangerous operation.
                    </div>
                  </div>
                `
              : null}
            <div class="mt-3 flex items-center gap-2">
              <${ActionButton}
                class="ac-btn-secondary text-xs px-3 py-1.5 rounded-lg"
                onClick=${handleRotate}
                label="Rotate token"
                loadingLabel="Rotating..."
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
