import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { WizardShell } from "../wizard-shell.js";
import { ActionButton } from "../action-button.js";
import { SecretInput } from "../secret-input.js";

const html = htm.bind(h);

const kSteps = [
  "What team access does",
  "Your account",
  "Security decision",
  "Review & apply",
];

const kInputClass =
  "w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body outline-none focus:border-fg-muted";

const Field = ({ label, children }) => html`
  <div class="space-y-1">
    <label class="text-xs font-medium text-fg-muted">${label}</label>
    ${children}
  </div>
`;

// Team enable wizard (4.5, D8/D9/D11). Four steps: plain-language intro,
// owner account, the one-way security decision (blocked until the admin
// confirms the host-isolation prerequisite), and a review with the exact
// config under an Advanced disclosure.
export const TeamEnableWizard = ({
  visible = false,
  onClose = () => {},
  onEnable = async () => null,
  enabling = false,
  enableError = null,
  enableResult = null,
}) => {
  const [step, setStep] = useState(0);
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerDisplayName, setOwnerDisplayName] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [ownerPasswordConfirm, setOwnerPasswordConfirm] = useState("");
  const [disableLegacyLogin, setDisableLegacyLogin] = useState(true);
  const [confirmHostIsolation, setConfirmHostIsolation] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const emailValid = ownerEmail.trim().includes("@");
  const passwordValid =
    ownerPassword.length >= 8 && ownerPassword === ownerPasswordConfirm;
  const canNext =
    step === 0 ||
    (step === 1 && emailValid && passwordValid) ||
    (step === 2 && confirmHostIsolation) ||
    step === 3;

  const reset = () => {
    setStep(0);
    setOwnerPassword("");
    setOwnerPasswordConfirm("");
    setConfirmHostIsolation(false);
  };

  const close = () => {
    reset();
    onClose();
  };

  const apply = async () => {
    await onEnable({
      ownerEmail: ownerEmail.trim(),
      ownerDisplayName: ownerDisplayName.trim(),
      ownerPassword,
      disableLegacyLogin,
      confirmHostIsolation,
    });
  };

  const stepBody = () => {
    if (enableResult) {
      return html`
        <div class="space-y-3">
          <p class="text-sm text-body">
            Team access is on. Restart the gateway (banner above) to activate
            it, then send your first invite from the Team page.
          </p>
          <div class="ac-surface-inset border border-yellow-500/35 rounded-lg p-3 space-y-1">
            <p class="text-sm text-body">Two follow-ups worth doing now:</p>
            <p class="text-xs text-fg-muted">
              1. If you disabled shared-password login, emergency access is
              restored by setting
              <code class="bg-field px-1 rounded">ALPHACLAW_ALLOW_LEGACY_LOGIN=1</code>
              on the server.
            </p>
            <p class="text-xs text-fg-muted">
              2. Rotate <code class="bg-field px-1 rounded">SETUP_PASSWORD</code>
              in your deployment — anyone who knew it could sign in before now.
            </p>
          </div>
          <p class="text-xs text-fg-muted">
            Teammates set their display name and avatar in the OpenClaw
            dashboard (Settings → Profile) — AlphaClaw supplies the identity,
            OpenClaw owns the profile.
          </p>
        </div>
      `;
    }
    if (step === 0) {
      return html`
        <div class="space-y-3">
          <p class="text-sm text-body">
            Team access gives each person their own AlphaClaw login and carries
            that identity into OpenClaw — messages are attributed, everyone
            gets their own profile, and you can see who's online.
          </p>
          <ul class="text-sm text-fg-muted space-y-1 list-disc pl-5">
            <li>Members can chat and view status.</li>
            <li>
              They cannot manage updates, secrets, terminals, agents, or team
              access — that stays admin-only.
            </li>
            <li>
              Needs OpenClaw 2026.8+. Applying restarts the gateway once and
              verifies the change — it rolls back automatically if the check
              fails.
            </li>
          </ul>
        </div>
      `;
    }
    if (step === 1) {
      return html`
        <div class="space-y-3">
          <p class="text-sm text-body">
            Create your own named account first — you'll sign in with it
            instead of the shared password.
          </p>
          <${Field} label="Email">
            <input
              type="email"
              class=${kInputClass}
              value=${ownerEmail}
              onInput=${(e) => setOwnerEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </${Field}>
          <${Field} label="Display name (optional)">
            <input
              type="text"
              class=${kInputClass}
              value=${ownerDisplayName}
              onInput=${(e) => setOwnerDisplayName(e.target.value)}
              placeholder="Your name"
            />
          </${Field}>
          <${Field} label="Password (8+ characters)">
            <${SecretInput}
              value=${ownerPassword}
              onInput=${(e) => setOwnerPassword(e.target.value)}
              placeholder="Choose a password"
              isSecret=${true}
              inputClass=${`flex-1 ${kInputClass}`}
            />
          </${Field}>
          <${Field} label="Confirm password">
            <${SecretInput}
              value=${ownerPasswordConfirm}
              onInput=${(e) => setOwnerPasswordConfirm(e.target.value)}
              placeholder="Same password again"
              isSecret=${true}
              inputClass=${`flex-1 ${kInputClass}`}
            />
          </${Field}>
          ${ownerPasswordConfirm && !passwordValid
            ? html`<p class="text-xs text-status-error-muted">
                Passwords must match and be at least 8 characters.
              </p>`
            : null}
        </div>
      `;
    }
    if (step === 2) {
      return html`
        <div class="space-y-3">
          <div class="ac-surface-inset border border-yellow-500/35 rounded-lg p-3 space-y-2">
            <p class="text-sm text-body">
              Shared access is a convenience boundary, not a hard security
              boundary.
            </p>
            <p class="text-xs text-fg-muted">
              Any process running on this host can impersonate a team member
              unless the host is isolated (loopback firewalled from other
              users, or fronted by Tailscale). Only enable team access on a
              host you control end to end.
            </p>
          </div>
          <label class="flex items-start gap-2 text-sm text-body">
            <input
              type="checkbox"
              class="mt-0.5"
              checked=${confirmHostIsolation}
              onChange=${(e) => setConfirmHostIsolation(e.target.checked)}
            />
            <span>
              I confirm this host doesn't run untrusted processes and is
              isolated as described above.
            </span>
          </label>
          <label class="flex items-start gap-2 text-sm text-body">
            <input
              type="checkbox"
              class="mt-0.5"
              checked=${disableLegacyLogin}
              onChange=${(e) => setDisableLegacyLogin(e.target.checked)}
            />
            <span>
              Disable shared-password login (recommended) — everyone signs in
              with their own account. Emergency access:
              <code class="bg-field px-1 rounded text-xs"
                >ALPHACLAW_ALLOW_LEGACY_LOGIN=1</code
              >.
            </span>
          </label>
        </div>
      `;
    }
    return html`
      <div class="space-y-3">
        <p class="text-sm text-body">Here's what applying will change:</p>
        <ul class="text-sm text-fg-muted space-y-1 list-disc pl-5">
          <li>OpenClaw will trust your AlphaClaw login identity (identity forwarding on).</li>
          <li>Your browsers/devices are approved automatically with member permissions.</li>
          <li>
            Admin account: <span class="text-body">${ownerEmail.trim() || "—"}</span>
          </li>
          <li>
            Shared-password login:${" "}
            <span class="text-body">${disableLegacyLogin ? "disabled" : "stays enabled"}</span>
          </li>
          <li>
            The gateway restarts once during apply; AlphaClaw verifies the
            login handshake and restores the previous setup if it fails.
          </li>
        </ul>
        <button
          type="button"
          class="text-xs text-fg-muted hover:text-body"
          onclick=${() => setAdvancedOpen((open) => !open)}
          aria-expanded=${advancedOpen ? "true" : "false"}
        >
          ${advancedOpen ? "▾ Advanced configuration" : "▸ Advanced configuration"}
        </button>
        ${advancedOpen
          ? html`<pre class="bg-field rounded p-2 text-xs whitespace-pre-wrap break-words">
gateway.trustedProxies += ["127.0.0.1"]
gateway.auth.mode = "trusted-proxy"
gateway.auth.identityScopes = per-member operator.* scopes from the roster
gateway.auth.trustedProxy.userHeader = "x-alphaclaw-user"
gateway.auth.trustedProxy.allowLoopback = true
gateway.auth.trustedProxy.allowUsers = active member emails
gateway.auth.trustedProxy.deviceAutoApprove = { enabled: true, scopes: [operator.read, operator.write, operator.approvals] }</pre
            >`
          : null}
        ${enableError
          ? html`<div class="ac-surface-inset border border-red-500/40 rounded-lg p-3 space-y-1">
              <p class="text-sm text-status-error">${enableError.message}</p>
              ${enableError.hint
                ? html`<p class="text-xs text-fg-muted">${enableError.hint}</p>`
                : null}
            </div>`
          : null}
      </div>
    `;
  };

  const footer = enableResult
    ? html`
        <div class="flex justify-end">
          <${ActionButton} onClick=${close} tone="primary" idleLabel="Done" />
        </div>
      `
    : html`
        <div class="flex items-center justify-between">
          <${ActionButton}
            onClick=${() => (step === 0 ? close() : setStep(step - 1))}
            tone="subtle"
            idleLabel=${step === 0 ? "Cancel" : "Back"}
            disabled=${enabling}
          />
          ${step < kSteps.length - 1
            ? html`<${ActionButton}
                onClick=${() => setStep(step + 1)}
                tone="primary"
                idleLabel="Next"
                disabled=${!canNext}
              />`
            : html`<${ActionButton}
                onClick=${apply}
                tone="primary"
                idleLabel="Enable team access"
                loadingLabel="Applying..."
                loading=${enabling}
              />`}
        </div>
      `;

  return html`
    <${WizardShell}
      visible=${visible}
      onClose=${close}
      label="Team access"
      steps=${kSteps}
      step=${enableResult ? kSteps.length - 1 : step}
      footer=${footer}
    >
      ${stepBody()}
    </${WizardShell}>
  `;
};
