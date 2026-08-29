import { h } from "preact";
import htm from "htm";
import { ModalShell } from "./modal-shell.js";
import { ActionButton } from "./action-button.js";

const html = htm.bind(h);

// One-time consent gate for the sidebar Claude Code launcher: firing the
// routine starts an autonomous run (shell access, no approval prompts) that
// bills the token owner's claude.ai subscription — and `title` tooltips don't
// exist on touch, so this modal is the warning surface that always renders.
// Escape / overlay-click are Cancel (ModalShell wires both to onClose).
export const ClaudeCodeConfirmModal = ({
  visible = false,
  onStart = () => {},
  onCancel = () => {},
}) => html`
  <${ModalShell} visible=${visible} onClose=${onCancel}>
    <h2 class="text-base font-semibold text-body">Start a Claude Code session?</h2>
    <p class="text-sm text-fg-muted">
      This fires your routine — an autonomous run on your claude.ai account
      that uses subscription usage.
    </p>
    <div class="flex justify-end gap-2 pt-1">
      <${ActionButton}
        tone="neutral"
        size="sm"
        idleLabel="Cancel"
        onClick=${onCancel}
      />
      <${ActionButton}
        tone="primary"
        size="sm"
        idleLabel="Start session"
        onClick=${onStart}
      />
    </div>
  </${ModalShell}>
`;
