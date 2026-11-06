import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { Badge } from "../badge.js";
import { ConfirmDialog } from "../confirm-dialog.js";
import { formatRelativeTime } from "../../lib/format.js";
import { openRelayConsentWindow, removeRelayBinding, revokeRelayClient } from "../../lib/api.js";
import { showToast } from "../toast.js";

const html = htm.bind(h);

// Remote connections: the OAuth clients the owner approved (Capy), the
// threads bound to capy-* agents through them, and how their wakes went.
// Revoking and removing are the owner's only; the confirm names the effect.
// A new app can be approved only within 10 minutes of Allow a new connection,
// so a consent link someone else started cannot be approved on its own.
const kRemoteUnavailableCopy = {
  relay_disabled: "The relay is off.",
  remote_disabled: "Remote access is off (ALPHACLAW_RELAY_REMOTE=off).",
  public_url_missing: "Set ALPHACLAW_SETUP_URL to this box's public https:// URL to let other agents connect.",
  provisioning_pending: "Available once the relay is ready.",
};

const wakeTone = (binding) =>
  binding.deadAt ? "danger" : binding.expired ? "neutral" : binding.lastWakeStatus === "delivered" ? "success" : binding.lastWakeStatus ? "warning" : "neutral";

const wakeLabel = (binding) =>
  binding.deadAt ? "webhook gone" : binding.expired ? "expired" : binding.lastWakeStatus ? "wake " + binding.lastWakeStatus : "no wake yet";

export const RelayConnections = ({ remote, error, onChanged }) => {
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const clients = (remote?.clients || []).filter((client) => client.consentedAt);
  const bindings = remote?.bindings || [];

  const allowConnection = async () => {
    setBusy(true);
    try {
      await openRelayConsentWindow();
      showToast("New connection allowed for 10 minutes", "success");
      onChanged?.();
    } catch (err) {
      showToast(String(err?.message || err), "error");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === "client") await revokeRelayClient(pending.id);
      else await removeRelayBinding(pending.id);
      showToast(pending.kind === "client" ? "Connection revoked" : "Binding removed", "success");
      setPending(null);
      onChanged?.();
    } catch (err) {
      showToast(String(err?.message || err), "error");
    } finally {
      setBusy(false);
    }
  };

  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-2">
      <h3 class="font-semibold text-sm">Connections</h3>
      ${error
        ? html`<p class="text-sm text-status-error-muted">${String(error?.message || error)}</p>`
        : remote?.unavailable
          ? html`<p class="text-sm text-fg-muted">${kRemoteUnavailableCopy[remote.unavailable] || remote.unavailable}</p>`
          : html`
              <p class="text-xs text-fg-muted">
                Other agents connect at <code class="select-all">${remote?.mcpUrl || "…"}</code> and you approve each app once.
                Each thread that binds gets its own @capy-… agent and is woken at its own webhook.
              </p>
              <div class="flex flex-wrap items-center gap-2 text-xs">
                ${remote?.consentWindowUntil
                  ? html`<${Badge} tone="info">new connection allowed</${Badge}>
                      <span class="text-fg-muted">Approve it within ${formatRelativeTime(remote.consentWindowUntil, { style: "unit" })}.</span>`
                  : html`<button type="button" class="underline text-fg-muted hover:text-fg" disabled=${busy} onclick=${allowConnection}>Allow a new connection</button>
                      <span class="text-fg-muted">Press this before you connect an app; its sign-in page refuses approval otherwise.</span>`}
              </div>
              ${clients.length
                ? html`<ul>
                    ${clients.map(
                      (client) => html`
                        <li class="flex flex-wrap items-center gap-2 text-sm py-1 border-t border-border first:border-t-0">
                          <span class="font-medium">${client.name || "MCP client"}</span>
                          <span class="text-xs text-fg-muted">${(client.redirectHosts || []).join(", ")}</span>
                          ${client.revokedAt
                            ? html`<${Badge} tone="neutral">revoked</${Badge}>`
                            : client.consentedAt
                              ? html`<${Badge} tone="success">connected</${Badge}>`
                              : html`<${Badge} tone="neutral">not approved</${Badge}>`}
                          <span class="text-xs text-fg-muted ml-auto">${client.consentedAt ? "approved " + formatRelativeTime(client.consentedAt, { style: "compact" }) : "registered " + formatRelativeTime(client.createdAt, { style: "compact" })}</span>
                          ${client.revokedAt
                            ? null
                            : html`<button type="button" class="text-xs text-fg-muted hover:text-status-error underline" onclick=${() => setPending({ kind: "client", id: client.clientId, name: client.name || "this app" })}>Revoke</button>`}
                        </li>
                      `,
                    )}
                  </ul>`
                : html`<p class="text-sm text-fg-muted">No app is connected yet.</p>`}
              ${bindings.length
                ? html`<div class="pt-2">
                    <h4 class="text-xs font-semibold text-fg-muted">Bound threads</h4>
                    <ul>
                      ${bindings.map(
                        (binding) => html`
                          <li class="flex flex-wrap items-center gap-2 text-sm py-1">
                            <span class="font-medium">@${binding.agent}</span>
                            <span class="text-xs text-fg-muted truncate">${binding.threadId}</span>
                            <${Badge} tone=${wakeTone(binding)}>${wakeLabel(binding)}</${Badge}>
                            <span class="text-xs text-fg-muted ml-auto">${binding.expired ? "ended" : "until"} ${formatRelativeTime(binding.until, { style: "compact", allowFuture: true })}</span>
                            <button type="button" class="text-xs text-fg-muted hover:text-status-error underline" onclick=${() => setPending({ kind: "binding", id: binding.agent, name: "@" + binding.agent })}>Remove</button>
                          </li>
                        `,
                      )}
                    </ul>
                  </div>`
                : null}
            `}
      <${ConfirmDialog}
        visible=${!!pending}
        title=${pending?.kind === "client" ? "Revoke this connection?" : "Remove this binding?"}
        message=${pending?.kind === "client"
          ? pending.name + " loses access at once: its tokens stop working and every thread it bound stops being woken. It can connect again only after you approve it again."
          : pending?.name + " stops being woken, and its thread can no longer act as it. Its messages stay in the log; the thread can bind again as a new binding."}
        confirmLabel=${pending?.kind === "client" ? "Revoke" : "Remove"}
        confirmLoadingLabel="Working..."
        confirmTone="danger"
        confirmLoading=${busy}
        onConfirm=${confirm}
        onCancel=${() => !busy && setPending(null)}
      />
    </div>
  `;
};
