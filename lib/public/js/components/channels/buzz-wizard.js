import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { WizardShell } from "../wizard-shell.js";
import { ActionButton } from "../action-button.js";
import { showToast } from "../toast.js";
import { copyTextToClipboard } from "../../lib/clipboard.js";
import { fetchBuzzSetup, runBuzzSetupAction } from "../../lib/api.js";
import { formatLocaleDateTime, formatLocaleTime } from "../../lib/format.js";

const html = htm.bind(h);

const kSteps = [
  "Before you start",
  "Install the plugin",
  "Relay address",
  "Bot identity & approval",
  "Pick rooms",
];

const kInputClass =
  "w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body outline-none focus:border-fg-muted";

// Server status → the wizard step to resume at (the state machine lives on
// the server so a page reload lands exactly where the flow paused).
const stepForStatus = (status) => {
  if (status === "installed") return 2;
  if (status === "awaiting-approval") return 3;
  if (status === "done") return 4;
  return 0;
};

const ErrorInset = ({ error }) =>
  error
    ? html`
        <div class="ac-surface-inset border border-red-500/40 rounded-lg p-3 space-y-1">
          <p class="text-sm text-status-error">${error.message}</p>
          ${error.hint
            ? html`<p class="text-xs text-fg-muted">${error.hint}</p>`
            : null}
        </div>
      `
    : null;

// Buzz setup wizard (5.2, D15). Prerequisites BEFORE the install button;
// Retry/Back never touch the bot identity; cancel states what stays.
export const BuzzWizard = ({
  visible = false,
  onClose = () => {},
  onFinished = () => {},
}) => {
  const [step, setStep] = useState(0);
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [relayUrl, setRelayUrl] = useState("");
  const [roomsText, setRoomsText] = useState("");
  const [defaultRoom, setDefaultRoom] = useState("");
  const [probeResult, setProbeResult] = useState(null);

  useEffect(() => {
    if (!visible) return;
    setError(null);
    setProbeResult(null);
    fetchBuzzSetup()
      .then((data) => {
        const nextState = data?.state || null;
        setState(nextState);
        setRelayUrl(nextState?.relayUrl || "");
        setStep(stepForStatus(nextState?.status));
      })
      .catch(() => setStep(0));
  }, [visible]);

  const run = async (action, payload, { onOk = () => {} } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const result = await runBuzzSetupAction(action, payload);
      if (result?.state) setState(result.state);
      onOk(result);
      return result;
    } catch (err) {
      setError({
        message: err?.message || "Buzz setup step failed",
        hint: err?.hint || null,
      });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    // `run` returns null (and sets the inline error) when the cancel POST
    // failed — do not toast "paused" over a failure (fix wave F169).
    const result = await run("cancel", {});
    if (!result) return;
    showToast(
      "Buzz setup paused — the plugin and bot identity stay installed; resume any time from Add channel",
      "info",
    );
    onClose();
  };

  const stepBody = () => {
    if (step === 0) {
      return html`
        <div class="space-y-3">
          <p class="text-sm text-body">Buzz needs a few things up front:</p>
          <ul class="text-sm text-fg-muted space-y-1 list-disc pl-5">
            <li>It's an external plugin (<code class="text-xs bg-field px-1 rounded">@openclaw/buzz</code>) — installing it runs third-party code.</li>
            <li>The gateway restarts once after the install.</li>
            <li>A Buzz room owner must approve your bot before it can join.</li>
            <li>Known limits: no DMs, no media; rooms are addressed by UUID.</li>
          </ul>
        </div>
      `;
    }
    if (step === 1) {
      return html`
        <div class="space-y-3">
          <p class="text-sm text-body">
            Install the Buzz plugin. AlphaClaw runs the install without any of
            your credentials in its environment.
          </p>
          <${ErrorInset} error=${error} />
        </div>
      `;
    }
    if (step === 2) {
      return html`
        <div class="space-y-3">
          <label class="block space-y-1">
            <span class="text-xs text-fg-muted">Relay URL</span>
            <input
              type="text"
              class=${kInputClass}
              value=${relayUrl}
              onInput=${(e) => setRelayUrl(e.target.value)}
              placeholder="wss://relay.your-buzz.example"
            />
            <p class="text-xs text-fg-muted">
              Your Buzz workspace admin can share the relay address (it starts
              with wss://).
            </p>
          </label>
          <${ErrorInset} error=${error} />
        </div>
      `;
    }
    if (step === 3) {
      const publicKey = state?.publicKey || probeResult?.publicKey || "";
      return html`
        <div class="space-y-3">
          <p class="text-sm text-body">
            Hand your bot's public key to a Buzz room owner or admin — they
            approve it with the Bot role. This can take a while; you can close
            this wizard and resume later, the setup keeps waiting.
          </p>
          ${publicKey
            ? html`
                <div class="flex items-center gap-2">
                  <code class="text-xs bg-field rounded px-2 py-1 break-all flex-1"
                    >${publicKey}</code
                  >
                  <${ActionButton}
                    onClick=${async () => {
                      const copied = await copyTextToClipboard(publicKey);
                      showToast(
                        copied ? "Public key copied" : "Could not copy",
                        copied ? "success" : "error",
                      );
                    }}
                    tone="subtle"
                    idleLabel="Copy"
                  />
                </div>
              `
            : html`
                <p class="text-sm text-status-warning-muted">
                  No bot identity reported yet. Restart the gateway (banner
                  above) if you haven't since installing, then press "Check
                  again". Checking never resets the identity.
                </p>
              `}
          <div class="flex items-center gap-2">
            <${ActionButton}
              onClick=${() => run("probe", {}, { onOk: setProbeResult })}
              tone="subtle"
              idleLabel="Check again"
              loadingLabel="Checking..."
              loading=${busy}
            />
            ${state?.lastProbeAt
              ? html`<span class="text-xs text-fg-muted">
                  last checked
                  ${formatLocaleTime(state.lastProbeAt, {
                    valueIsEpochMs: true,
                  })}
                </span>`
              : null}
          </div>
          ${probeResult?.detail || state?.lastProbeDetail
            ? html`<p class="text-xs text-fg-muted">
                ${probeResult?.detail || state?.lastProbeDetail}
              </p>`
            : null}
          <${ErrorInset} error=${error} />
        </div>
      `;
    }
    return html`
      <div class="space-y-3">
        <label class="block space-y-1">
          <span class="text-xs text-fg-muted">Room UUIDs (one per line)</span>
          <textarea
            class=${`${kInputClass} font-mono min-h-24`}
            value=${roomsText}
            onInput=${(e) => setRoomsText(e.target.value)}
            placeholder="11111111-2222-3333-4444-555555555555"
          ></textarea>
          <p class="text-xs text-fg-muted">
            Copy each room's UUID from its settings in Buzz. Rooms are the
            canonical targets — no DMs.
          </p>
        </label>
        <label class="block space-y-1">
          <span class="text-xs text-fg-muted">
            Default outbound room (optional — first room when empty)
          </span>
          <input
            type="text"
            class=${`${kInputClass} font-mono`}
            value=${defaultRoom}
            onInput=${(e) => setDefaultRoom(e.target.value)}
            placeholder="11111111-2222-3333-4444-555555555555"
          />
        </label>
        <${ErrorInset} error=${error} />
      </div>
    `;
  };

  const primaryAction = () => {
    if (step === 0) {
      return html`<${ActionButton}
        onClick=${() => setStep(1)}
        tone="primary"
        idleLabel="Continue"
      />`;
    }
    if (step === 1) {
      return html`<${ActionButton}
        onClick=${() =>
          run("install", {}, { onOk: () => setStep(2) })}
        tone="primary"
        idleLabel="Install Buzz plugin and restart"
        loadingLabel="Installing..."
        loading=${busy}
      />`;
    }
    if (step === 2) {
      return html`<${ActionButton}
        onClick=${() =>
          run("configure", { relayUrl }, { onOk: () => setStep(3) })}
        tone="primary"
        idleLabel="Save relay and continue"
        loadingLabel="Saving..."
        loading=${busy}
        disabled=${!relayUrl.trim()}
      />`;
    }
    if (step === 3) {
      return html`<${ActionButton}
        onClick=${() => setStep(4)}
        tone="primary"
        idleLabel="The bot is approved — pick rooms"
      />`;
    }
    return html`<${ActionButton}
      onClick=${() =>
        run(
          "rooms",
          {
            groups: roomsText
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
            defaultTo: defaultRoom.trim(),
          },
          {
            onOk: () => {
              showToast(
                "Buzz is configured — restart the gateway to bring it online",
                "success",
              );
              onFinished();
              onClose();
            },
          },
        )}
      tone="primary"
      idleLabel="Finish setup"
      loadingLabel="Saving..."
      loading=${busy}
    />`;
  };

  const footer = html`
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <${ActionButton}
          onClick=${step === 0 ? onClose : () => setStep(step - 1)}
          tone="subtle"
          idleLabel=${step === 0 ? "Close" : "Back"}
          disabled=${busy}
        />
        ${step > 0 && step < 4
          ? html`<${ActionButton}
              onClick=${cancel}
              tone="subtle"
              idleLabel="Pause setup"
              disabled=${busy}
            />`
          : null}
      </div>
      ${primaryAction()}
    </div>
  `;

  return html`
    <${WizardShell}
      visible=${visible}
      onClose=${onClose}
      label="Buzz channel setup"
      steps=${kSteps}
      step=${step}
      footer=${footer}
    >
      ${stepBody()}
    </${WizardShell}>
  `;
};

// Persistent resumable task card (D15): shown on the Channels card while a
// Buzz setup is paused awaiting external approval.
export const BuzzPendingCard = ({ state = null, onResume = () => {}, onCancel = () => {} }) => {
  if (!state || state.status !== "awaiting-approval") return null;
  return html`
    <div class="bg-surface border border-yellow-500/35 rounded-xl p-4 space-y-2">
      <h2 class="card-label">Waiting for Buzz approval</h2>
      <p class="text-sm text-fg-muted">
        A Buzz room owner needs to approve your bot. The plugin and bot
        identity stay installed while you wait.
      </p>
      ${state.publicKey
        ? html`<code class="text-xs bg-field rounded px-2 py-1 break-all block"
            >${state.publicKey}</code
          >`
        : null}
      ${state.lastProbeAt
        ? html`<p class="text-xs text-fg-muted">
            last checked${" "}
            ${formatLocaleDateTime(state.lastProbeAt, { valueIsEpochMs: true })}
          </p>`
        : null}
      <div class="flex items-center gap-2">
        <${ActionButton} onClick=${onResume} tone="primary" idleLabel="Resume setup" />
        <${ActionButton} onClick=${onCancel} tone="subtle" idleLabel="Pause" />
      </div>
    </div>
  `;
};
