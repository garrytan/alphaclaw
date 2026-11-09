import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { ConfirmDialog } from "../confirm-dialog.js";
import { formatRelativeTime } from "../../lib/format.js";
import { openRelayConsentWindow, removeRelayBinding, revokeRelayClient } from "../../lib/api.js";
import { showToast } from "../toast.js";
import { BriefingSection, FactRow, ToneWord, withLiterals } from "./parts.js";

const html = htm.bind(h);

// Remote connections: the OAuth clients the owner approved (Capy), the
// threads bound to capy-* agents through them, and how their wakes went.
// Revoking and removing are the owner's only; the confirm names the effect.
// A new app can be approved only within 10 minutes of Allow a new connection,
// with the one-time code that press returns (shown here once, never in the
// status the agent can read), so a sign-in link someone else sent cannot be
// approved just by clicking it.
const kRemoteUnavailableCopy = {
  relay_disabled: "The relay is off.",
  remote_disabled: "Remote access is off (ALPHACLAW_RELAY_REMOTE=off).",
  public_url_missing: "Set ALPHACLAW_SETUP_URL to this box's public https:// URL to let other agents connect.",
  provisioning_pending: "Available once the relay is ready.",
};

const kRemoteUnavailableWord = {
  public_url_missing: "Connections not set up",
  provisioning_pending: "Connections not ready yet",
};

const wakeTone = (binding) =>
  binding.deadAt ? "danger" : binding.expired ? "neutral" : binding.lastWakeStatus === "delivered" ? "success" : binding.lastWakeStatus ? "warning" : "neutral";

const wakeLabel = (binding) =>
  binding.deadAt ? "webhook gone" : binding.expired ? "expired" : binding.lastWakeStatus ? "wake " + binding.lastWakeStatus : "no wake yet";

// The connection controls' state, shared by the page header (Allow a new
// connection), the one-time code under the headline and the Connections
// section (Revoke, Remove and their confirm).
export const useRelayConnections = ({ remote, error, onChanged }) => {
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [allowed, setAllowed] = useState(null);

  const allowConnection = async () => {
    setBusy(true);
    try {
      const result = await openRelayConsentWindow();
      setAllowed({ code: result.code, until: result.until });
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

  const codeShown = Boolean(remote?.consentWindowUntil && allowed?.until === remote.consentWindowUntil);
  return {
    pending,
    setPending,
    busy,
    allowed,
    allowConnection,
    confirm,
    codeShown,
    canAllow: !error && !remote?.unavailable && !codeShown,
  };
};

// The page's one solid button.
export const RelayAllowConnectionButton = ({ connections }) =>
  connections.canAllow
    ? html`<${ActionButton}
        onClick=${connections.allowConnection}
        disabled=${connections.busy}
        tone="solid"
        size="md"
        idleLabel="Allow a new connection"
        className="relay-allow"
      />`
    : null;

// Facts under the headline: the one-time code after Allow, or why other
// agents cannot connect. A relay that is off already says so above.
export const RelayConnectionFacts = ({ remote, error, connections }) => {
  if (connections.codeShown) {
    return html`<${FactRow} tone="info" word="New connection allowed">
      Press Connect in your app, then enter this code on the consent page within ${formatRelativeTime(remote.consentWindowUntil, { style: "unit" })}:${" "}
      <code class="font-mono select-all font-semibold tracking-wider text-bright">${connections.allowed.code}</code>
    </${FactRow}>`;
  }
  if (error || !remote?.unavailable || remote.unavailable === "relay_disabled") return null;
  return html`<${FactRow} tone="neutral" word=${kRemoteUnavailableWord[remote.unavailable] || "Connections off"}>
    ${withLiterals(kRemoteUnavailableCopy[remote.unavailable] || remote.unavailable)}
  </${FactRow}>`;
};

// While remote access is unavailable the section is hidden, but the confirm
// keeps its place after it, so a Revoke or Remove confirm that is already
// open stays open and mounted, as it did when the section was always shown.
export const RelayConnections = ({ remote, error, connections }) => {
  const { pending, setPending, busy, confirm } = connections;
  const dialog = html`
    <${ConfirmDialog}
      visible=${!!pending}
      title=${pending?.kind === "client" ? "Revoke this connection?" : "Remove this binding?"}
      message=${pending?.kind === "client"
        ? pending.name + " loses access at once: its tokens stop working and every thread it bound stops being woken. It can connect again only after you approve it again."
        : pending?.name + " stops being woken, and its thread can no longer act as it. Its messages stay in the log; the thread can bind again as a new binding."}
      confirmLabel=${pending?.kind === "client" ? "Revoke" : "Remove"}
      confirmLoadingLabel="Working…"
      confirmTone="danger"
      confirmLoading=${busy}
      onConfirm=${confirm}
      onCancel=${() => !busy && setPending(null)}
    />
  `;
  const clients = (remote?.clients || []).filter((client) => client.consentedAt);
  const bindings = remote?.bindings || [];
  const section = html`
    <${BriefingSection}
      id="relay-connections-title"
      title="Connections"
      caption=${error
        ? null
        : html`Other agents connect at <code class="font-mono select-all">${remote?.mcpUrl || "…"}</code> and you approve each app once.
            Each thread that binds gets its own @capy-… agent and is woken at its own webhook.
            Threads marked "delegate" (their relay agent is listed in ALPHACLAW_RELAY_DELEGATE_AGENTS) work as you on this box: they use your agent's tools, and only sending to other people needs your approval; every other thread stays chat-only.
            To add one, press Allow a new connection, then press Connect in your app and enter the code shown here; a sign-in started before it is refused.`}
    >
      ${error
        ? html`<p class="text-sm text-status-error-muted">${String(error?.message || error)}</p>`
        : html`
            ${clients.length
              ? html`<ul class="relay-rows">
                  ${clients.map(
                    (client) => html`
                      <li key=${client.clientId} class="relay-row">
                        <span class="font-medium text-bright">${client.name || "MCP client"}</span>
                        <span class="font-mono text-xs text-fg-muted">${(client.redirectHosts || []).join(", ")}</span>
                        <span class="relay-row-meta">
                          ${client.revokedAt
                            ? html`<${ToneWord} tone="neutral">revoked</${ToneWord}>`
                            : client.consentedAt
                              ? html`<${ToneWord} tone="success">connected</${ToneWord}>`
                              : html`<${ToneWord} tone="neutral">not approved</${ToneWord}>`}
                          <span>${client.consentedAt ? "approved " + formatRelativeTime(client.consentedAt, { style: "compact" }) : "registered " + formatRelativeTime(client.createdAt, { style: "compact" })}</span>
                          ${client.revokedAt
                            ? null
                            : html`<button type="button" class="relay-row-action" onclick=${() => setPending({ kind: "client", id: client.clientId, name: client.name || "this app" })}>Revoke</button>`}
                        </span>
                      </li>
                    `,
                  )}
                </ul>`
              : html`<p class="text-sm text-fg-muted">No app is connected yet.</p>`}
            ${bindings.length
              ? html`<div>
                  <h3 class="relay-subtitle">Bound threads</h3>
                  <ul class="relay-rows">
                    ${bindings.map(
                      (binding) => html`
                        <li key=${binding.agent} class="relay-row">
                          <span class="relay-handle">@${binding.agent}</span>
                          <span class="font-mono text-xs text-fg-muted truncate min-w-0">${binding.threadId}</span>
                          <span class="relay-row-meta">
                            <${ToneWord} tone=${wakeTone(binding)}>${wakeLabel(binding)}</${ToneWord}>
                            ${binding.tier === "delegate" ? html`<${ToneWord} tone="warning">delegate</${ToneWord}>` : null}
                            <span>${binding.expired ? "ended" : "until"} ${formatRelativeTime(binding.until, { style: "compact", allowFuture: true })}</span>
                            <button type="button" class="relay-row-action" onclick=${() => setPending({ kind: "binding", id: binding.agent, name: "@" + binding.agent })}>Remove</button>
                          </span>
                        </li>
                      `,
                    )}
                  </ul>
                </div>`
              : null}
          `}
    </${BriefingSection}>
  `;
  return html`${!error && remote?.unavailable ? null : section}${dialog}`;
};
