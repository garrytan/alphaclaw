import { h } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import {
  fetchWebhookIngress,
  generateWebhookIngressSecret,
  reopenWebhookIngressSharedToken,
  updateWebhookIngress,
} from "../../../lib/api.js";
import { setCached } from "../../../lib/api-cache.js";
import { usePolling } from "../../../hooks/usePolling.js";
import { copyTextToClipboard } from "../../../lib/clipboard.js";
import { formatLocaleDateTime } from "../../../lib/format.js";
import { ActionButton } from "../../action-button.js";
import { ConfirmDialog } from "../../confirm-dialog.js";
import { showToast } from "../../toast.js";

const html = htm.bind(h);

export const kSenderVerificationPresets = [
  { id: "token", label: "Shared webhook token (today)", secretSource: "none" },
  { id: "circleback", label: "Circleback", secretSource: "sender" },
  { id: "quo", label: "Quo", secretSource: "sender" },
  { id: "verkada", label: "Verkada", secretSource: "alphaclaw" },
  { id: "standard_webhooks", label: "Standard Webhooks", secretSource: "sender" },
  { id: "per_hook_token", label: "Own token for this hook", secretSource: "alphaclaw" },
];

export const kReadsRequestFieldsWarning =
  "This hook's transform reads query or header fields. Signed deliveries forward only the signed body and signed headers, so those fields will be empty.";
export const kCirclebackReplayNote =
  "Circleback signs no timestamp, so a captured delivery older than 30 days could be accepted again.";

const kStatusToneClass = {
  muted: "text-fg-muted",
  ok: "text-status-success",
  warn: "text-status-warning",
  error: "text-status-error",
};

export const getIngressCacheKey = (hookName = "") =>
  `/api/webhooks/${encodeURIComponent(String(hookName || ""))}/ingress`;

export const resolvePresetOptions = (ingress = null) =>
  Array.isArray(ingress?.presets) && ingress.presets.length > 0
    ? ingress.presets
    : kSenderVerificationPresets;

export const findPreset = (options = [], id = "") =>
  options.find((preset) => preset.id === id) ||
  kSenderVerificationPresets.find((preset) => preset.id === id) ||
  null;

export const getSenderVerificationStatus = (ingress = null, formatTime = formatLocaleDateTime) => {
  const ownToken = ingress?.preset === "per_hook_token";
  switch (ingress?.state) {
    case "token":
      return { tone: "muted", text: "Uses the shared webhook token" };
    case "waiting":
      return {
        tone: "warn",
        text: ownToken
          ? "Waiting for the first delivery with this hook's own token. The shared token still works until then."
          : "Waiting for the first signed delivery. The shared token still works until then.",
      };
    case "overlap":
      return {
        tone: "ok",
        text: `Verified. The shared token stops working on this hook at ${formatTime(ingress.closesAt)}.`,
      };
    case "closed":
      return {
        tone: "ok",
        text: ownToken
          ? "Closed: only deliveries with this hook's own token are accepted."
          : "Closed: only signed deliveries are accepted.",
      };
    case "misconfigured":
      return {
        tone: "error",
        text: String(ingress?.alert?.message || "").trim() || "Sender verification is misconfigured.",
      };
    default:
      return null;
  }
};

export const canSaveSenderPreset = ({ ingress = null, draftPreset = "", secretSource = "none", secretDraft = "" }) => {
  if (!ingress || !draftPreset) return false;
  if (secretSource === "sender") return String(secretDraft || "").trim().length > 0;
  if (secretSource === "none") return ingress.preset !== draftPreset;
  return false;
};

export const formatIngressCounts = (counts = null) => {
  if (!counts) return "";
  const count = (key) => Number(counts?.[key] || 0);
  return (
    `Last 500 requests: ${count("signed")} signed, ${count("shared_token")} shared token, ` +
    `${count("per_hook_token")} own token, ${count("rejected")} rejected.`
  );
};

// The generate-secret answer carries the secret, which is shown once and kept
// nowhere else: only the ingress status goes into the shared read cache.
export const toCachedIngress = (data = null) => ({ ok: true, ingress: data?.ingress || null });

export const SenderVerification = ({
  selectedHookName = "",
  refreshNonce = 0,
  onIngressChanged = () => {},
}) => {
  const [draftPreset, setDraftPreset] = useState("");
  const [secretDraft, setSecretDraft] = useState("");
  const [generated, setGenerated] = useState(null);
  const [busy, setBusy] = useState("");
  const [showReopenConfirm, setShowReopenConfirm] = useState(false);

  const cacheKey = getIngressCacheKey(selectedHookName);
  const ingressPoll = usePolling(
    () => fetchWebhookIngress(selectedHookName),
    10000,
    { enabled: !!selectedHookName, cacheKey },
  );

  useEffect(() => {
    setDraftPreset("");
    setSecretDraft("");
    setGenerated(null);
    setShowReopenConfirm(false);
  }, [selectedHookName]);

  const lastRefreshNonceRef = useRef(refreshNonce);
  useEffect(() => {
    if (lastRefreshNonceRef.current === refreshNonce) return;
    lastRefreshNonceRef.current = refreshNonce;
    if (!selectedHookName) return;
    ingressPoll.refresh();
  }, [refreshNonce, ingressPoll.refresh, selectedHookName]);

  const run = useCallback(async (key, action) => {
    if (busy || !selectedHookName) return null;
    setBusy(key);
    try {
      const data = await action();
      setCached(cacheKey, toCachedIngress(data));
      onIngressChanged(data);
      return data;
    } catch (err) {
      showToast(err.message || "Could not change sender verification", "error");
      return null;
    } finally {
      setBusy("");
    }
  }, [busy, cacheKey, onIngressChanged, selectedHookName]);

  const ingress = ingressPoll.data?.ingress || null;
  if (!ingress) {
    return html`
      <div class="bg-surface border border-border rounded-xl p-4 space-y-2">
        <h2 class="font-semibold text-sm">Sender verification</h2>
        ${ingressPoll.error
          ? html`<p class="text-xs text-status-error">${ingressPoll.error.message || "Could not load sender verification"}</p>`
          : html`<p class="text-xs text-fg-muted">Loading…</p>`}
      </div>
    `;
  }

  const presetOptions = resolvePresetOptions(ingress);
  const currentPreset = findPreset(presetOptions, ingress.preset);
  const selectedId = draftPreset || ingress.preset;
  const selectedPreset = findPreset(presetOptions, selectedId);
  const secretSource = selectedPreset?.secretSource || "none";
  const status = getSenderVerificationStatus(ingress);
  const isCurrent = selectedId === ingress.preset;
  const canSave = canSaveSenderPreset({ ingress, draftPreset: selectedId, secretSource, secretDraft });
  const shownSecret = generated?.hookName === selectedHookName ? generated : null;

  const handleSave = async () => {
    const data = await run("save", () =>
      updateWebhookIngress(selectedHookName, { preset: selectedId, secret: secretDraft.trim() }),
    );
    if (!data) return;
    setSecretDraft("");
    setDraftPreset("");
    showToast("Sender verification saved", "success");
  };

  const handleGenerate = async () => {
    const data = await run("generate", () => generateWebhookIngressSecret(selectedHookName, selectedId));
    if (!data?.secret) return;
    setGenerated({ hookName: selectedHookName, secret: data.secret });
    setDraftPreset("");
  };

  const handleReopen = async () => {
    const data = await run("reopen", () => reopenWebhookIngressSharedToken(selectedHookName));
    setShowReopenConfirm(false);
    if (data) showToast("The shared token works on this hook for 24 hours", "success");
  };

  const copy = async (value, label) => {
    if (await copyTextToClipboard(value)) {
      showToast(`${label} copied`, "success");
      return;
    }
    showToast(`Could not copy the ${label.toLowerCase()}`, "error");
  };

  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div>
        <h2 class="font-semibold text-sm">Sender verification</h2>
        <p class="text-xs text-fg-muted mt-1">Now: ${currentPreset?.label || ingress.preset}</p>
      </div>

      ${ingress.alert && ingress.state !== "misconfigured"
        ? html`
            <div class="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3">
              <p class="text-xs text-status-warning">${ingress.alert.message}</p>
              ${ingress.alert.at
                ? html`<p class="text-xs text-fg-dim mt-1">${formatLocaleDateTime(ingress.alert.at)}</p>`
                : null}
            </div>
          `
        : null}

      ${status
        ? html`
            <div class="flex items-center justify-between gap-3 flex-wrap">
              <p class="text-xs ${kStatusToneClass[status.tone]}">${status.text}</p>
              ${ingress.state === "closed"
                ? html`<${ActionButton}
                    tone="secondary"
                    size="sm"
                    loading=${busy === "reopen"}
                    disabled=${!!busy}
                    idleLabel="Reopen shared token for 24 h"
                    loadingLabel="Reopening…"
                    onClick=${() => setShowReopenConfirm(true)}
                  />`
                : null}
            </div>
          `
        : null}

      ${ingress.preset !== "token" && ingress.counts
        ? html`<p class="text-xs text-fg-dim">${formatIngressCounts(ingress.counts)}</p>`
        : null}

      <div class="bg-field border border-border rounded-lg p-3 space-y-3">
        <div class="space-y-2">
          <p class="text-xs text-fg-muted">Method</p>
          <select
            value=${selectedId}
            onInput=${(event) => {
              const next = String(event.currentTarget?.value || "");
              setDraftPreset(next === ingress.preset ? "" : next);
              setSecretDraft("");
            }}
            disabled=${!!busy}
            class="h-8 w-full bg-field border rounded-lg px-3 text-xs text-body focus:border-fg-muted"
          >
            ${presetOptions.map((preset) => html`<option value=${preset.id}>${preset.label}</option>`)}
          </select>
          ${selectedPreset?.help
            ? html`<p class="text-xs text-fg-muted">${selectedPreset.help}</p>`
            : null}
        </div>

        ${secretSource === "sender"
          ? html`
              <div class="space-y-2">
                <p class="text-xs text-fg-muted">Signing secret</p>
                <div class="flex items-center gap-2">
                  <input
                    type="password"
                    autocomplete="new-password"
                    spellcheck=${false}
                    value=${secretDraft}
                    placeholder=${isCurrent && ingress.hasSecret
                      ? "Saved. Paste a new one to replace it."
                      : `Paste the signing secret from ${selectedPreset?.label || "the sender"}`}
                    onInput=${(event) => setSecretDraft(String(event.currentTarget?.value || ""))}
                    disabled=${!!busy}
                    class="h-8 flex-1 bg-field border rounded-lg px-3 text-xs text-body outline-none font-mono"
                  />
                  <${ActionButton}
                    tone="secondary"
                    size="sm"
                    loading=${busy === "save"}
                    disabled=${!!busy || !canSave}
                    idleLabel="Save"
                    loadingLabel="Saving…"
                    onClick=${handleSave}
                  />
                </div>
              </div>
            `
          : null}

        ${secretSource === "alphaclaw"
          ? html`
              <div class="flex items-center gap-2 flex-wrap">
                <${ActionButton}
                  tone="secondary"
                  size="sm"
                  loading=${busy === "generate"}
                  disabled=${!!busy}
                  idleLabel=${isCurrent && ingress.hasSecret ? "Replace secret" : "Generate secret"}
                  loadingLabel="Creating…"
                  onClick=${handleGenerate}
                />
                ${isCurrent && ingress.hasSecret
                  ? html`<p class="text-xs text-fg-muted">A new secret stops the old one working at once.</p>`
                  : null}
              </div>
            `
          : null}

        ${secretSource === "none" && !isCurrent
          ? html`
              <div class="flex items-center gap-2 flex-wrap">
                <${ActionButton}
                  tone="secondary"
                  size="sm"
                  loading=${busy === "save"}
                  disabled=${!!busy || !canSave}
                  idleLabel="Use the shared token"
                  loadingLabel="Saving…"
                  onClick=${handleSave}
                />
                <p class="text-xs text-fg-muted">This forgets the saved secret.</p>
              </div>
            `
          : null}

        ${shownSecret
          ? html`
              <div class="rounded-lg border border-border p-2 space-y-1">
                <p class="text-xs text-status-warning">
                  Copy this secret now and give it to the sender. You will not see it again.
                </p>
                <div class="flex items-center gap-2">
                  <code class="text-xs break-all flex-1 min-w-0">${shownSecret.secret}</code>
                  <${ActionButton}
                    tone="secondary"
                    size="sm"
                    idleLabel="Copy"
                    onClick=${() => copy(shownSecret.secret, "Secret")}
                  />
                  <${ActionButton} tone="ghost" size="sm" idleLabel="Done" onClick=${() => setGenerated(null)} />
                </div>
              </div>
            `
          : null}

        ${selectedId === "circleback"
          ? html`<p class="text-xs text-fg-muted">${kCirclebackReplayNote}</p>`
          : null}
        ${ingress.readsRequestFields && selectedId !== "token"
          ? html`<p class="text-xs text-status-warning">${kReadsRequestFieldsWarning}</p>`
          : null}
      </div>

      ${ingress.preset !== "token" && ingress.preset !== "per_hook_token" && ingress.signedUrl
        ? html`
            <div class="space-y-2">
              <p class="text-xs text-fg-muted">Signed URL: new URL, no token in it</p>
              <div class="flex items-center gap-2">
                <input
                  type="text"
                  readonly
                  value=${ingress.signedUrl}
                  class="h-8 flex-1 bg-field border rounded-lg px-3 text-xs text-body outline-none font-mono"
                />
                <button
                  class="h-8 text-xs px-2.5 rounded-lg ac-btn-secondary shrink-0"
                  onclick=${() => copy(ingress.signedUrl, "URL")}
                >
                  Copy
                </button>
              </div>
            </div>
          `
        : null}

      <${ConfirmDialog}
        visible=${showReopenConfirm}
        title="Reopen the shared token?"
        message="For the next 24 hours this hook also accepts the shared webhook token. Signed deliveries keep working."
        confirmLabel="Reopen for 24 h"
        confirmLoadingLabel="Reopening…"
        confirmLoading=${busy === "reopen"}
        confirmTone="warning"
        cancelLabel="Cancel"
        onCancel=${() => {
          if (busy === "reopen") return;
          setShowReopenConfirm(false);
        }}
        onConfirm=${handleReopen}
      />
    </div>
  `;
};
