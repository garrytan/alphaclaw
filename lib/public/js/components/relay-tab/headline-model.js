// The Relay page's headline: one sentence from the status and conversations
// reads the page already makes. A conversation is waiting when the last
// message the bridge took in is not answered yet (running, failed or cut
// off); one with no bridge state (between two other agents, or a session
// past retention) counts toward the total only.

const kCountWords = ["no", "one", "two"];

const countWord = (count) => kCountWords[count] || String(count);

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

export const isWaitingConversation = (item) => Boolean(item?.lastStatus) && item.lastStatus !== "answered";

const conversationsSentence = ({ conversations, hasMore }) => {
  const total = conversations.length;
  const waiting = conversations.filter(isWaitingConversation).length;
  if (total === 0) return "No conversations yet.";
  if (hasMore) {
    return waiting === 0
      ? "More than " + total + " conversations; the newest " + total + " are all answered."
      : "More than " + total + " conversations; " + countWord(waiting) + " of the newest " + total + " waiting.";
  }
  const noun = total === 1 ? " conversation, " : " conversations, ";
  const state = waiting === 0 ? (total === 1 ? "answered" : "all answered") : countWord(waiting) + " waiting";
  return capitalize(countWord(total)) + noun + state + ".";
};

// status and statusError come from the status poll, the rest from the
// conversations hook. A fresh error wins over data loaded before it.
export const buildRelayHeadline = ({
  status = null,
  statusError = null,
  conversations = [],
  listError = null,
  listLoading = false,
  hasMore = false,
  filtered = false,
} = {}) => {
  if (statusError) return "Couldn't load the relay status.";
  if (!status) return "Loading…";
  if (status.enabled === false || status.phase === "off") return "Relay is off.";
  if (status.phase === "failed") return "Relay is not running.";
  if (status.phase !== "ready") return "Relay is starting.";
  if (status.bridge?.failure) return "Relay is not answering messages.";
  if (listError) return "Relay is ready, but its conversations didn't load.";
  if (listLoading) return "Relay is ready.";
  if (filtered) return "Relay is ready. Showing the conversations that match your filters.";
  return "Relay is ready. " + conversationsSentence({ conversations: Array.isArray(conversations) ? conversations : [], hasMore });
};
