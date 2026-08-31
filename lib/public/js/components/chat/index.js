import { h } from "preact";
import { useCallback, useMemo } from "preact/hooks";
import htm from "htm";
import { getSessionDisplayLabel } from "../../lib/session-keys.js";
import { useChatStore } from "./use-chat-store.js";
import { useChatComposer } from "./use-chat-composer.js";
import { MessageList } from "./message-list.js";
import { Composer } from "./composer.js";
import { ConnectionBanner } from "./connection-banner.js";
import { kDefaultMaxContentBytes } from "./chat-protocol.js";

const html = htm.bind(h);
const kChatDebugQueryFlag = "chatDebug";

// The Chat route. The old 1116-line chat-route.js monolith is decomposed into
// pure modules (run-state, send-outbox, transcript-store, connection — all
// node-env unit-tested), hooks (connection/store/composer), and presentational
// components. Reliability contract highlights:
//   - the composer never silently eats input: sends queue via a durable
//     localStorage outbox and survive disconnects/reloads (visible states);
//   - run state is strictly per-session (no cross-session Stop/typing bleed);
//   - history refetches MERGE by stable id — optimistic messages, live
//     streams, and <details> state survive; stops/interruptions render as
//     persisted inline markers.
export const ChatRoute = ({
  sessions = [],
  selectedSessionKey = "",
  onRunStarted = null,
}) => {
  const store = useChatStore({
    enabled: true,
    selectedSessionKey,
    onRunStarted,
  });
  const composer = useChatComposer({ selectedSessionKey });

  const selectedSession = useMemo(
    () =>
      sessions.find(
        (sessionRow) =>
          String(sessionRow?.key || "") === String(selectedSessionKey || ""),
      ) || null,
    [selectedSessionKey, sessions],
  );

  const chatDebugEnabled = useMemo(() => {
    try {
      const params = new URLSearchParams(window.location.search || "");
      return params.get(kChatDebugQueryFlag) === "1";
    } catch {
      return false;
    }
  }, []);

  const handleSend = useCallback(() => {
    const accepted = store.actions.send(composer.draft);
    // The draft clears ONLY after the outbox accepted the message — from that
    // moment the text is durable and visible as a bubble; nothing to lose.
    if (accepted) composer.clearDraft();
  }, [composer, store.actions]);

  const handleCancelQueued = useCallback(
    (clientMsgId) => {
      const content = store.actions.cancelQueued(clientMsgId);
      if (content) composer.appendToDraft(content);
    },
    [composer, store.actions],
  );

  const handleRetryHistory = useCallback(() => {
    store.actions.requestHistory(selectedSessionKey, { force: true });
  }, [selectedSessionKey, store.actions]);

  const queuedCount = useMemo(
    () => store.outboxItems.filter((item) => item.status === "queued").length,
    [store.outboxItems],
  );

  return html`
    <div class="chat-route-shell">
      <div class="chat-route-header">
        <div>
          <div class="chat-route-title">Chat</div>
          <div class="chat-route-subtitle">
            ${getSessionDisplayLabel(selectedSession) ||
            "Pick a session in the sidebar"}
          </div>
        </div>
        <${ConnectionBanner}
          status=${store.connection.status}
          persistWarning=${store.persistWarning}
          onRetryNow=${store.actions.retryConnection}
        />
      </div>
      <${MessageList}
        messages=${store.messages}
        runState=${store.runState}
        historyMeta=${store.historyMeta}
        selectedSessionKey=${selectedSessionKey}
        chatDebugEnabled=${chatDebugEnabled}
        rawHistory=${store.rawHistory}
        debugEvents=${store.debugEvents}
        onRetryItem=${store.actions.retryItem}
        onDiscardItem=${store.actions.discardItem}
        onCancelQueued=${handleCancelQueued}
        onRetryHistory=${handleRetryHistory}
      />
      <${Composer}
        selectedSessionKey=${selectedSessionKey}
        draft=${composer.draft}
        onDraftInput=${composer.updateDraft}
        onSend=${handleSend}
        onStop=${store.actions.stop}
        runState=${store.runState}
        connectionMode=${store.connection.status.mode}
        legacy=${store.connection.status.legacy}
        maxContentBytes=${Number(store.connection.hello?.maxContentBytes) ||
        kDefaultMaxContentBytes}
        stopError=${store.stopError}
        holdFlush=${store.runState.holdFlush === true}
        onConfirmFlush=${store.actions.confirmFlush}
        queuedCount=${queuedCount}
        onFlushDraftPersist=${composer.flushDraftPersist}
      />
    </div>
  `;
};
