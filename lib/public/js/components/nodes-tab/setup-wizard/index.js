import { h } from "preact";
import htm from "htm";
import { WizardShell } from "../../wizard-shell.js";
import { ActionButton } from "../../action-button.js";
import { FileCopyLineIcon } from "../../icons.js";
import { DevicePairings } from "../../device-pairings.js";
import { copyTextToClipboard } from "../../../lib/clipboard.js";
import { showToast } from "../../toast.js";
import { useSetupWizard } from "./use-setup-wizard.js";

const html = htm.bind(h);

const kWizardSteps = ["Install OpenClaw CLI", "Connect Node"];

const renderCommandBlock = ({ command = "", onCopy = () => {} }) => html`
  <div class="rounded-lg border border-border bg-field p-3">
    <pre
      class="pt-1 pl-2 text-[11px] leading-5 whitespace-pre-wrap break-all font-mono text-body"
    >
${command}</pre
    >
    <div class="pt-3">
      <button
        type="button"
        onclick=${onCopy}
        class="text-xs px-2 py-1 rounded-lg ac-btn-ghost inline-flex items-center gap-1.5"
      >
        <${FileCopyLineIcon} className="w-3.5 h-3.5" />
        Copy
      </button>
    </div>
  </div>
`;

const copyAndToast = async (value, label = "text") => {
  const copied = await copyTextToClipboard(value);
  if (copied) {
    showToast("Copied to clipboard", "success");
    return;
  }
  showToast(`Could not copy ${label}`, "error");
};

export const NodesSetupWizard = ({
  visible = false,
  nodes = [],
  refreshNodes = async () => {},
  onRestartRequired = () => {},
  onClose = () => {},
}) => {
  const state = useSetupWizard({
    visible,
    nodes,
    refreshNodes,
    onRestartRequired,
    onClose,
  });
  const isFinalStep = state.step === kWizardSteps.length - 1;

  return html`
    <${WizardShell}
      visible=${visible}
      onClose=${onClose}
      label="Node Setup Wizard"
      steps=${kWizardSteps}
      step=${state.step}
    >

      ${
        state.step === 0
          ? html`
              <div class="text-xs text-fg-muted">
                Install OpenClaw on the machine you want to connect as a node.
              </div>
              ${renderCommandBlock({
                command: "npm install -g openclaw",
                onCopy: () =>
                  copyAndToast("npm install -g openclaw", "command"),
              })}
              <div class="text-xs text-fg-muted">
                Requires Node.js ${">=22.22.3 <23, >=24.15.0 <25, or >=25.9.0."}
              </div>
            `
          : null
      }

      ${
        state.step === 1
          ? html`
              <div class="space-y-2">
                <label class="space-y-1 block">
                  <div class="text-xs text-fg-muted">Display name</div>
                  <input
                    type="text"
                    value=${state.displayName}
                    oninput=${(event) =>
                      state.setDisplayName(event.target.value)}
                    class="w-full bg-field border border-border rounded-lg px-2.5 py-2 text-xs font-mono focus:border-fg-muted focus:outline-none"
                  />
                </label>

                <div>
                  <div class="text-xs text-fg-muted mb-1">
                    Run this on the device you want to connect:
                  </div>
                  ${state.loadingConnectInfo
                    ? html`<div class="text-xs text-fg-muted">
                        Loading command...
                      </div>`
                    : renderCommandBlock({
                        command:
                          state.connectCommand ||
                          "Could not build connect command.",
                        onCopy: () =>
                          copyAndToast(state.connectCommand || "", "command"),
                      })}
                </div>
                ${state.devicePending.length
                  ? html`
                      <${DevicePairings}
                        pending=${state.devicePending}
                        onApprove=${state.handleDeviceApprove}
                        onReject=${state.handleDeviceReject}
                      />
                    `
                  : state.selectedPairedNode &&
                      !state.selectedPairedNode.connected
                    ? html`
                        <div
                          class="rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs text-status-warning"
                        >
                          Node is paired but currently disconnected. Run the
                          node command again on your device, then Finish will
                          enable.
                        </div>
                      `
                    : html`
                        <div
                          class="rounded-lg border border-border bg-field px-3 py-2 text-xs text-fg-muted"
                        >
                          Pairing request will show up here. Checks every 3s.
                        </div>
                      `}
              </div>
            `
          : null
      }

      <div class="grid grid-cols-2 gap-2 pt-2">
        ${
          state.step === 0
            ? html`<div></div>`
            : html`
                <${ActionButton}
                  onClick=${() => state.setStep(Math.max(0, state.step - 1))}
                  idleLabel="Back"
                  tone="secondary"
                  size="md"
                  className="w-full justify-center"
                />
              `
        }
        ${
          isFinalStep
            ? html`
                <${ActionButton}
                  onClick=${async () => {
                    const ok = await state.applyGatewayNodeRouting();
                    if (!ok) return;
                    state.completeWizard();
                  Promise.resolve(refreshNodes()).catch(() => {});
                  }}
                  loading=${state.configuring}
                  idleLabel=${state.canFinish ? "Finish" : "Awaiting pairing"}
                  loadingLabel="Finishing..."
                  tone="primary"
                  size="md"
                  className="w-full justify-center"
                  disabled=${!state.canFinish}
                />
              `
            : html`
                <${ActionButton}
                  onClick=${() =>
                    state.setStep(
                      Math.min(kWizardSteps.length - 1, state.step + 1),
                    )}
                  idleLabel="Next"
                  tone="primary"
                  size="md"
                  className="w-full justify-center"
                />
              `
        }
      </div>
    </${WizardShell}>
  `;
};
