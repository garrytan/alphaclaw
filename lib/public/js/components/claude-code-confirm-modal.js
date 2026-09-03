import { h } from "preact";
import htm from "htm";
import { ModalShell } from "./modal-shell.js";
import { ActionButton } from "./action-button.js";

const html = htm.bind(h);

// Mode-specific consent line naming the permission mode the session will run
// under (codex 13: bypassPermissions must be re-consented by name).
const permissionModeLine = (permissionMode) => {
  if (permissionMode === "bypassPermissions") {
    return "Permission mode: bypassPermissions — the session runs commands and edits files WITHOUT any approval prompts.";
  }
  if (permissionMode === "acceptEdits") {
    return "Permission mode: acceptEdits — file edits are auto-approved; commands still require approval in the session.";
  }
  return `Permission mode: ${permissionMode || "default"}.`;
};

// One-time consent gate for the sidebar Claude Code launcher: firing the
// routine starts an autonomous run (shell access, no approval prompts) that
// bills the token owner's claude.ai subscription — and `title` tooltips don't
// exist on touch, so this modal is the warning surface that always renders.
// mode "local" covers the rescue session instead: it runs ON THIS SERVER and
// re-confirms whenever the configured permission mode changes (per-path
// consent). Escape / overlay-click are Cancel (ModalShell wires both to
// onClose).
export const ClaudeCodeConfirmModal = ({
  visible = false,
  mode = "routine",
  permissionMode = null,
  onStart = () => {},
  onCancel = () => {},
}) => html`
  <${ModalShell} visible=${visible} onClose=${onCancel}>
    ${mode === "local"
      ? html`
          <h2 class="text-base font-semibold text-body">
            Start a rescue Claude Code session on this server?
          </h2>
          <p class="text-sm text-fg-muted">
            This starts a Claude Code session on this server using your
            claude.ai subscription. It can read content on this box —
            including untrusted logs, which carry a prompt-injection risk —
            and transmits selected content to Anthropic as part of operating
            Claude Code.
          </p>
          <p class="text-sm text-fg-muted">
            ${permissionModeLine(permissionMode)}
          </p>
        `
      : html`
          <h2 class="text-base font-semibold text-body">Start a Claude Code session?</h2>
          <p class="text-sm text-fg-muted">
            This fires your routine — an autonomous run on your claude.ai account
            that uses subscription usage.
          </p>
        `}
    <div class="flex justify-end gap-2 pt-1">
      <${ActionButton}
        tone="neutral"
        size="md"
        idleLabel="Cancel"
        onClick=${onCancel}
      />
      <${ActionButton}
        tone="primary"
        size="md"
        idleLabel="Start session"
        onClick=${onStart}
      />
    </div>
  </${ModalShell}>
`;
