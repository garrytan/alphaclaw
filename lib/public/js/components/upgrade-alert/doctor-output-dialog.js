import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { ModalShell } from "../modal-shell.js";
import { ActionButton } from "../action-button.js";
import { fetchDoctorOutput } from "../../lib/api.js";
import { formatLocaleDateTime } from "../../lib/format.js";

const html = htm.bind(h);

// The newest doctor --fix run's own output (redacted, last 256 KB).
export const DoctorOutputDialog = ({ visible = false, onClose }) => {
  const [state, setState] = useState({ loading: false, text: null, updatedAt: null, error: null });
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setState({ loading: true, text: null, updatedAt: null, error: null });
    fetchDoctorOutput()
      .then((data) => {
        if (!cancelled) setState({ loading: false, text: data?.text || null, updatedAt: data?.updatedAt || null, error: null });
      })
      .catch((err) => {
        if (!cancelled) setState({ loading: false, text: null, updatedAt: null, error: err?.message || "Couldn't load the output." });
      });
    return () => {
      cancelled = true;
    };
  }, [visible]);
  const when = formatLocaleDateTime(state.updatedAt, { fallback: null });
  return html`<${ModalShell}
    visible=${visible}
    onClose=${onClose}
    panelClassName="bg-modal border border-border rounded-xl p-5 max-w-3xl w-full space-y-3"
  >
    <div role="dialog" aria-modal="true" aria-label="Doctor output" class="space-y-3">
      <h2 class="text-base font-semibold">Doctor output</h2>
      <p class="text-xs text-fg-muted">
        The last openclaw doctor --fix run${when ? `, updated ${when}` : ""}. Secrets are masked.
      </p>
      ${state.loading ? html`<p class="text-sm text-fg-muted">Loading…</p>` : null}
      ${state.error ? html`<p class="text-sm text-status-error" role="alert">${state.error}</p>` : null}
      ${!state.loading && !state.error
        ? state.text
          ? html`<pre class="ac-surface-inset border border-border rounded-lg p-3 text-xs font-mono whitespace-pre-wrap break-all max-h-[60vh] overflow-auto">${state.text}</pre>`
          : html`<p class="text-sm text-body">No Doctor run has been recorded since this AlphaClaw version was installed.</p>`
        : null}
      <div class="flex justify-end">
        <${ActionButton} onClick=${onClose} tone="secondary" size="md" idleLabel="Close" />
      </div>
    </div>
  <//>`;
};
