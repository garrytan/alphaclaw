import { h } from "preact";
import htm from "htm";
import { sendDoctorCardFix } from "../../lib/api.js";
import { showToast } from "../toast.js";
import { AgentSendModal } from "../agent-send-modal.js";
import {
  getReplyTargetFromSessionKey,
  getSessionKind,
  getSessionRowKey,
  kDestinationSessionFilter,
} from "../../lib/session-keys.js";

const html = htm.bind(h);

// Main sessions are a legitimate "run in the main thread" target (dmScope=main
// installs have no per-peer keys at all); cron/hook/doctor/subagent noise is
// not — a fix dispatched there is invisible to the operator. Classification
// goes through the canonical parser module — never a hand-rolled key regex.
export const kDoctorFixSessionFilter = (sessionRow) =>
  kDestinationSessionFilter(sessionRow) ||
  getSessionKind(getSessionRowKey(sessionRow)) === "main";

// d2: the destination is visible BEFORE send — the silent-delivery bug hid
// exactly here, at the moment of choice. Rows without the server-sent
// `deliverable` flag (older payloads) fall back to key-derived deliverability.
const renderDeliveryHint = (selectedSession) => {
  if (!selectedSession) return null;
  const key = getSessionRowKey(selectedSession);
  const derived = getReplyTargetFromSessionKey(key);
  const deliverable =
    selectedSession.deliverable === true ||
    (selectedSession.deliverable === undefined && !!derived.replyTo);
  const hintText = deliverable
    ? `Delivers the outcome to this chat (${selectedSession.replyChannel || derived.replyChannel})`
    : getSessionKind(key) === "main"
      ? "Runs in the main session — watch the Chat tab for the outcome"
      : "Runs in this session — watch the Chat tab for the outcome";
  return html`<p class="text-xs text-fg-muted">${hintText}</p>`;
};

export const DoctorFixCardModal = ({
  visible = false,
  card = null,
  onClose = () => {},
  onComplete = () => {},
}) => {
  const handleSend = async ({ selectedSession, selectedSessionKey, message }) => {
    if (!card?.id) return false;
    try {
      const result = await sendDoctorCardFix({
        cardId: card.id,
        sessionKey: selectedSessionKey,
        // Advisory back-compat fields: the server derives the authoritative
        // reply target from the sessionKey.
        replyChannel: selectedSession?.replyChannel || "",
        replyTo: selectedSession?.replyTo || "",
        prompt: message,
      });
      // "requested", never "delivered": 202 proves dispatch acceptance, not
      // that the message reached the chat.
      showToast(
        result?.delivery?.attached
          ? "Fix queued — delivery to the selected chat requested. The agent will mark it fixed after applying and verifying the change."
          : "Fix queued to the main session — watch the Chat tab. The agent will mark it fixed after applying and verifying the change.",
        "success",
      );
      await onComplete();
      return true;
    } catch (error) {
      showToast(error.message || "Could not send Doctor fix request", "error");
      return false;
    }
  };

  return html`
    <${AgentSendModal}
      visible=${visible}
      title="Ask agent to fix"
      messageLabel="Instructions"
      initialMessage=${String(card?.fixPrompt || "")}
      resetKey=${String(card?.id || "")}
      submitLabel="Send fix request"
      loadingLabel="Queuing..."
      onClose=${onClose}
      onSubmit=${handleSend}
      sessionFilter=${kDoctorFixSessionFilter}
      renderSessionHint=${renderDeliveryHint}
    />
  `;
};
