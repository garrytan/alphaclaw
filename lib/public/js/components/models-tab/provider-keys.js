import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { SecretInput } from "../secret-input.js";
import { patchEnvVar } from "../../lib/api/envars.js";
import { describeKeySource, getKeyRowActions } from "./model.js";

const html = htm.bind(h);

const kMask = "••••••••";
const fieldId = (key) => "provider-key-" + key + "-input";
const replaceId = (key) => "provider-key-" + key + "-replace";
const focusById = (id) => globalThis.document?.getElementById?.(id)?.focus?.();

// One .env key: where its value comes from, Show (env_file only, through
// SecretInput's own reveal) and Replace or Add key. A save sends exactly one
// PATCH /api/env for this key; a failed save keeps the typed value, and a
// save the server answers with a warning shows that warning under the row.
export const ProviderKeyRow = ({ entry = {}, onSaved = async () => {} }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(null);
  const actions = getKeyRowActions(entry);
  const key = String(entry.key || "");

  useEffect(() => {
    if (editing) focusById(fieldId(key));
  }, [editing, key]);

  const cancel = () => {
    setEditing(false);
    setDraft("");
    setError("");
    Promise.resolve().then(() => focusById(replaceId(key)));
  };

  const save = async (event) => {
    event?.preventDefault?.();
    if (saving || !draft) return;
    setSaving(true);
    setError("");
    try {
      const result = await patchEnvVar({ key, value: draft });
      setEditing(false);
      setDraft("");
      setSaved({ restartRequired: result?.restartRequired === true, warning: String(result?.warning || "") });
      await onSaved(result);
    } catch (err) {
      setError(err?.message || "Could not save the key");
    } finally {
      setSaving(false);
    }
  };

  return html`
    <li class="provider-key-row" data-env-key=${key}>
      <div class="provider-key-main">
        <span class="provider-key-name font-mono">${key}</span>
        <span class="provider-key-source text-fg-muted" data-source=${entry.source || "unset"}>${describeKeySource(entry.source)}</span>
        <span class="provider-key-value">
          ${actions.includes("show")
            ? html`<${SecretInput}
                value=${entry.value || ""}
                readOnly=${true}
                ariaLabel=${key + " value"}
                inputClass="provider-key-mask font-mono text-fg-dim bg-transparent border-0 p-0 w-full"
              />`
            : entry.source === "deployment"
              ? html`<span class="font-mono text-fg-dim">${kMask}</span>`
              : null}
        </span>
        <span class="provider-key-actions">
          ${editing
            ? null
            : html`<button
                type="button"
                id=${replaceId(key)}
                class="inline-flex items-center justify-center transition-colors whitespace-nowrap h-7 text-xs leading-none px-2.5 py-1 rounded-lg ac-btn-secondary"
                aria-label=${(actions.includes("add") ? "Add key " : "Replace ") + key}
                onclick=${() => {
                  setSaved(null);
                  setEditing(true);
                }}
              >
                ${actions.includes("add") ? "Add key" : "Replace"}
              </button>`}
        </span>
      </div>
      ${editing
        ? html`<form class="provider-key-form" onSubmit=${save}>
            <${SecretInput}
              id=${fieldId(key)}
              ariaLabel=${"New value for " + key}
              value=${draft}
              disabled=${saving}
              placeholder="Paste the new value"
              onInput=${(event) => setDraft(event.target.value)}
              onKeyDown=${(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancel();
                }
              }}
              inputClass="w-full bg-field border rounded-lg px-3 py-1.5 text-sm font-mono text-body"
            />
            <span class="provider-key-form-actions">
              <${ActionButton}
                type="submit"
                tone="secondary"
                size="sm"
                disabled=${saving || !draft}
                loading=${saving}
                loadingMode="inline"
                idleLabel="Save key"
                loadingLabel="Saving…"
              />
              <${ActionButton} tone="ghost" size="sm" disabled=${saving} onClick=${cancel} idleLabel="Cancel" />
            </span>
          </form>`
        : null}
      ${error ? html`<p class="text-xs text-status-error-muted" role="alert">${error}</p>` : null}
      ${saved
        ? html`<p class="text-xs text-fg-muted" role="status">
            Saved to .env.${saved.restartRequired ? " It applies after the gateway restarts." : ""}
          </p>`
        : null}
      ${saved?.warning
        ? html`<p class="text-xs text-status-warning-muted" role="alert">${saved.warning}</p>`
        : null}
    </li>
  `;
};

export const ProviderKeyGroupHeading = ({ group }) => html`
  <div class="provider-key-group-head">
    <h3 class="text-sm font-semibold text-body">${group.label}</h3>
    ${group.check ? html`<${Badge} tone=${group.check.tone}>${group.check.word}</${Badge}>` : null}
  </div>
`;
