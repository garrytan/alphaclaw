import { h } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import htm from "htm";
import {
  fetchBuiltinHooks,
  mintBuiltinHookToken,
  reopenBuiltinHookSharedToken,
  setBuiltinHookEnabled,
} from "../../../lib/api.js";
import { copyTextToClipboard } from "../../../lib/clipboard.js";
import { formatLocaleDateTime } from "../../../lib/format.js";
import { ActionButton } from "../../action-button.js";
import { Badge } from "../../badge.js";
import { showToast } from "../../toast.js";

const html = htm.bind(h);

const kBuiltinHooks = [
  { name: "agent", purpose: "starts an agent run with the text the caller sends" },
  { name: "wake", purpose: "wakes the agent with the text the caller sends" },
];

// OpenClaw's own /hooks/agent and /hooks/wake (GST-2134). Off unless the box
// used them; when on they take their own token, and the shared webhook token
// works on them only until its window closes.
export const BuiltinHooksPanel = () => {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState("");
  const [minted, setMinted] = useState(null);

  const load = useCallback(async () => {
    try {
      setStatus(await fetchBuiltinHooks());
    } catch (err) {
      showToast(err.message || "Could not load the built-in hooks", "error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const run = useCallback(async (key, action) => {
    if (busy) return;
    setBusy(key);
    try {
      const data = await action();
      setStatus(data);
      return data;
    } catch (err) {
      showToast(err.message || "Could not change the built-in hook", "error");
      return null;
    } finally {
      setBusy("");
    }
  }, [busy]);

  if (!status) return null;

  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div>
        <h2 class="text-sm font-medium">OpenClaw built-in hooks</h2>
        <p class="text-xs text-fg-muted mt-1">
          These two hooks reach the agent directly, so they are closed to callers outside this box unless you turn them
          on. When on, each takes its own token.
        </p>
      </div>
      ${status.policyUnreadable
        ? html`<p class="text-xs text-status-error">alphaclaw.json cannot be read, so both hooks stay closed until it is fixed.</p>`
        : null}
      ${kBuiltinHooks.map(({ name, purpose }) => {
        const hook = status.hooks?.[name] || {};
        return html`
          <div class="border-t border-border pt-3 space-y-2" key=${name}>
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <code class="text-sm">/hooks/${name}</code>
                <span class="text-xs text-fg-muted ml-2">${purpose}</span>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <${Badge} tone=${hook.enabled ? "ok" : "neutral"}>${hook.enabled ? "On" : "Off"}</${Badge}>
                <${ActionButton}
                  tone="secondary"
                  size="sm"
                  loading=${busy === name + ":toggle"}
                  disabled=${!!busy || status.policyUnreadable}
                  idleLabel=${hook.enabled ? "Turn off" : "Turn on"}
                  onClick=${() => run(name + ":toggle", () => setBuiltinHookEnabled(name, !hook.enabled))}
                />
              </div>
            </div>
            ${hook.enabled
              ? html`
                  <div class="text-xs text-fg-muted space-y-1">
                    <p>
                      ${hook.hasOwnToken
                        ? `Own token created ${formatLocaleDateTime(hook.ownTokenCreatedAt)}.`
                        : "No own token yet. Create one and give it to the caller."}
                    </p>
                    <p>
                      ${hook.sharedTokenOpen
                        ? `The shared webhook token still works here until ${formatLocaleDateTime(hook.sharedTokenClosesAt)}.`
                        : "The shared webhook token no longer works here."}
                    </p>
                  </div>
                  <div class="flex items-center gap-2">
                    <${ActionButton}
                      tone="secondary"
                      size="sm"
                      loading=${busy === name + ":mint"}
                      disabled=${!!busy}
                      idleLabel=${hook.hasOwnToken ? "Replace token" : "Create token"}
                      onClick=${async () => {
                        const data = await run(name + ":mint", () => mintBuiltinHookToken(name));
                        if (data?.token) setMinted({ name, token: data.token });
                      }}
                    />
                    ${hook.sharedTokenOpen
                      ? null
                      : html`<${ActionButton}
                          tone="ghost"
                          size="sm"
                          loading=${busy === name + ":reopen"}
                          disabled=${!!busy}
                          idleLabel="Reopen shared token for 7 days"
                          onClick=${() => run(name + ":reopen", () => reopenBuiltinHookSharedToken(name))}
                        />`}
                  </div>
                  ${minted?.name === name
                    ? html`
                        <div class="rounded-lg border border-border p-2 space-y-1">
                          <p class="text-xs">Copy this token now. It is shown once and AlphaClaw keeps only a fingerprint of it.</p>
                          <div class="flex items-center gap-2">
                            <code class="text-xs break-all">${minted.token}</code>
                            <${ActionButton}
                              tone="secondary"
                              size="sm"
                              idleLabel="Copy"
                              onClick=${async () => {
                                await copyTextToClipboard(minted.token);
                                showToast("Token copied", "success");
                              }}
                            />
                            <${ActionButton} tone="ghost" size="sm" idleLabel="Done" onClick=${() => setMinted(null)} />
                          </div>
                        </div>
                      `
                    : null}
                `
              : null}
          </div>
        `;
      })}
    </div>
  `;
};
