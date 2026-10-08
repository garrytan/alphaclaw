import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

// The failed restart's redacted stderr tail, served by reference and fetched
// only when the operator opens the disclosure — never in status frames.
export const WatchdogRestartEvidence = ({ operation = null, onLoadEvidence = null }) => {
  const [evidence, setEvidence] = useState({ operationId: null, status: "idle", text: "" });
  if (!operation || operation.phase !== "failed" || !operation.operationId) return null;
  const operationId = operation.operationId;
  const current = evidence.operationId === operationId ? evidence : { status: "idle", text: "" };

  const handleToggle = (event) => {
    if (!event?.currentTarget?.open || current.status !== "idle") return;
    if (typeof onLoadEvidence !== "function") {
      setEvidence({ operationId, status: "expired", text: "" });
      return;
    }
    setEvidence({ operationId, status: "loading", text: "" });
    Promise.resolve(onLoadEvidence(operationId))
      .then((text) =>
        setEvidence(
          text
            ? { operationId, status: "loaded", text: String(text) }
            : { operationId, status: "expired", text: "" },
        ),
      )
      .catch((error) =>
        setEvidence({ operationId, status: "error", text: String(error?.message || "") }),
      );
  };

  return html`
    <details class="bg-surface border border-border rounded-xl p-4" ontoggle=${handleToggle}>
      <summary class="card-label cursor-pointer">Restart evidence</summary>
      ${current.status === "loading"
        ? html`<p class="mt-2 text-xs text-fg-muted">Loading evidence…</p>`
        : current.status === "expired"
          ? html`<p class="mt-2 text-xs text-fg-muted">Evidence expired</p>`
          : current.status === "error"
            ? html`<p class="mt-2 text-xs text-fg-muted">
                ${current.text ? `Couldn't load evidence — ${current.text}` : "Couldn't load evidence"}
              </p>`
            : current.status === "loaded"
              ? html`<pre class="mt-2 bg-field rounded p-2 text-xs whitespace-pre-wrap break-words max-h-64 overflow-auto">${current.text}</pre>`
              : null}
    </details>
  `;
};
