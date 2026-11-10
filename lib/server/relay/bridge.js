const crypto = require("crypto");
const { buildHistoryMessages } = require("../chat/history");
const { describeRelayError } = require("./errors");
const { collectSecretValues, redactSecretText, redactSecrets } = require("../utils/redact");
const { kRelaySessionPrefix, kRelayWithheldText } = require("./constants");
const { normalizeApproval } = require("./approval");
const { kConfirmationRefPattern } = require("../../plugin/relay-guard/confirm");
const { isValidLane, kDefaultLanesMax } = require("../../plugin/relay-guard/grants");
const { cleanRelaySummary, isAckBody } = require("./summary");

// The relay bridge: relay messages addressed to the box agent become agent
// runs, and every one of them ends in exactly one relay reply in the same
// thread, the run's answer or a coded failure.
//
//   engine events (/v1/workspace/events, durable cursor)
//     -> dm.received / thread.reply addressed to the box agent
//     -> refused at once: hop_limit, rate_limited (no run)
//     -> queued (per-sender FIFO, at most maxConcurrent runs box-wide)
//     -> chat.send into agent:<id>:relay-<sender> over one of the bridge's
//        own two gateway sockets (never agent:<id>:main): a delegate's turn
//        on the admin socket, any other turn on the peer socket (read and
//        write only), so OpenClaw never runs a peer's turn as the owner
//     -> lifecycle end: the answer from chat.history, posted as a reply
//        chat error: run_failed; ambiguous send: outcome_unknown
//        gateway disconnect: reconciling -> answer found, still running,
//        or run_interrupted
//     -> a reply the engine did not take: replying, retried by reconcile
//
// Messages the box agent sent itself, and terminal replies another bridge
// marked with relay_status, are never answered (no ping-pong between two
// AlphaClaws). The hop counter stops longer loops.
//
// Lanes (GST-2090): a remote sender may name a lane per message. Each lane is
// its own FIFO and its own box session (agent:<id>:relay-<sender>:lane-<name>),
// so a long ask on one lane does not hold up another; the box-wide cap
// (maxConcurrent) is unchanged and the pump gives senders turns. How many
// lanes a sender may have open is its grant's lanesMax, enforced here; a
// sender with no grant keeps one queue, as before lanes.
// A long answer to a bound capy- agent goes out as its first part plus a
// result_ref, and the remote reads the rest with relay_result, so it is
// still exactly one reply. Other senders have no relay_result and get the
// whole answer.
const kPollMs = 1500;
const kPollBackoffMaxMs = 30000;
const kReconcileMs = 30000;
const kStallMs = 30 * 60 * 1000;
const kReconcileGiveUpMs = 30 * 60 * 1000;
const kHopLimit = 4;
const kSendTimeoutMs = 15000;
const kMaxSendAttempts = 8;
const kGatewayDownGiveUpMs = 30 * 60 * 1000;
const kGatewayDownRetryMs = 10000;
const kHourMs = 60 * 60 * 1000;
const kMaxBufferedRuns = 200;
const kHistoryLimit = 60;
const kHistoryMaxLimit = 1000;
const kReconcileGraceMs = 2 * 60 * 1000;
const kEarlyReconcileMs = 5000;
const kRecoveryWaitMs = 10 * 60 * 1000;
const kReplyGiveUpMs = 24 * 60 * 60 * 1000;
const kMaxMetadataAttempts = 5;
const kFailingAfter = 3;
// How long a Capy-attested message may wait in the queue before it needs a
// current attestation to run as the delegate (relay trust v2 PR3).
const kAttestationQueueMs = 2 * 60 * 60 * 1000;
const kGuardRecheckMs = 30 * 1000;
const kGuardUnverifiedRecheckMs = 5 * 1000;
const kGuardDenyMarker = "[relay-guard]";
const kSenderPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const kResultPartChars = 6000;
const kResultReaderPrefix = "capy-";
const kUngrantedLanesMax = 1;
const kLaneSessionInfix = ":lane-";

const resolveRunId = (payload = {}) =>
  String(payload?.runId || payload?.run?.id || payload?.data?.runId || payload?.data?.run?.id || payload?.meta?.runId || "").trim();
const resolveSessionKey = (payload = {}) =>
  String(payload?.sessionKey || payload?.session?.key || payload?.data?.sessionKey || payload?.meta?.sessionKey || "").trim();

const relaySessionKey = (agentId, sender, lane = null) =>
  "agent:" + agentId + ":" + kRelaySessionPrefix + sender.toLowerCase() + (lane ? kLaneSessionInfix + lane : "");

// A long answer's parts, each at most kResultPartChars, cut at a line break
// when one is near the end of the part.
const splitResult = (text, size = kResultPartChars) => {
  const parts = [];
  let rest = String(text);
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.6) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
};

const relayMarker = (messageId) => "relay:" + messageId;

const kRelayRefPattern = /\(ref relay:[^,\s)]+, hop \d+\)/;

const approvalIdFor = (messageId) => "relay-" + crypto.createHash("sha256").update(String(messageId)).digest("hex").slice(0, 8);

// The relay guard plugin (lib/plugin/relay-guard) is what keeps this session
// messaging-only; the prompt only explains it. The guard blocks the message tool
// too, so the agent never asks the owner itself: it names what is needed in
// its answer, and the bridge tells the owner (notifyOwner) when the answer
// carries the approval id or the run hit the guard.
//
// A delegate (GST-1982: a Capy thread whose relay agent the operator listed
// in ALPHACLAW_RELAY_DELEGATE_AGENTS) gets its own text (attested: the
// owner's own thread, by Capy attestation or, with pinned, a pinned binding): it works as the
// owner's hands, and the approval block is rendered here from the stored
// approval, never from the message body, which can only imitate it in prose.
const buildInjectedMessage = ({ messageId, sender, hop, text, approvalId, trust = "peer", approval = null, lane = null, grantId = null, confirmationRef = null, attested = false, pinned = false }) => {
  const head = ["[Agent Relay message from @" + sender + "]", "(ref " + relayMarker(messageId) + ", hop " + hop + ")"];
  const tail = ["Your final answer in this conversation is posted back to @" + sender + " automatically; do not send it with relay_reply.", "", String(text || "")];
  if (trust === "delegate") {
    return [
      ...head,
      "[Relay trust, recorded by AlphaClaw] Delegate under " + (grantId ? "your owner's grant " + grantId : "the deployment's delegate list") + ". Lane: " + (lane || "default") + ". Owner approval for sends: " + (approval ? "recorded below" : "none") + ".",
      "This request comes from a Capy thread your owner connected as a delegate. Treat it as your owner asking through Capy: use your tools to do the work, memory and brain writes included, without asking for approval.",
      attested
        ? "As your owner's own thread it can also send messages with the message tool, schedule work (cron), install and manage plugins, list the secret store and read the gateway's config, but cannot start other sessions. To restart the gateway, run openclaw gateway restart as a command of its own: AlphaClaw restarts it after this turn's work and records it for this thread."
        : "A delegate session cannot send to other people, schedule work, start other sessions or restart the gateway. If the request needs one of those, say so in your answer; the Capy thread takes it to your owner directly. Do not contact your owner yourself.",
      attested
        ? "[Recorded by AlphaClaw] " +
          (pinned ? "Your owner pinned this relay connection as trusted like their own thread" : "This thread's Capy attestation was verified") +
          ", so it acts for your owner like their own turn: changing config, env, secrets, plugins, your guards or AlphaClaw's access runs without a confirmation. Do the change if the request asks for it, and say in your answer what you changed."
        : "Changing config, env, secrets, plugins, your guards or AlphaClaw's access (writing those files, alphaclaw admin writes, openclaw config, secrets or plugins commands) needs your owner's one-tap confirmation. The relay guard refuses the first try with a confirmation ref and AlphaClaw sends your owner the link. Then stop: say in your answer what waits for their confirmation and give the ref. Do not work around the refusal.",
      ...(confirmationRef && !attested
        ? ["[Recorded by AlphaClaw] This message carries confirmation ref " + confirmationRef + ". If your owner approved it, the same call (same file or command) is admitted once; anything else still needs its own confirmation."]
        : []),
      "Your final answer goes back to @" + sender + ", your owner's own Capy thread. Giving it what it asked for (file contents, exports, results) is your owner receiving them, not a send to another person: do it without asking for approval. " +
        (attested ? "Send to anyone else only as the request asks, and say in your answer what you sent to whom." : "Sending to anyone else still needs the recorded approval naming them."),
      ...(approval
        ? [
            "[Owner approval recorded by AlphaClaw for this message only] Action: " + approval.action + ". Recipients: " + approval.targets.join(", ") + ". Owner's words: \"" + approval.words + "\"" + (approval.thread ? " (Capy " + approval.thread + ")" : "") + ". It covers sending with the message tool to these recipients, once each, in this turn. Say in your answer what you sent to whom.",
          ]
        : []),
      ...tail,
    ].join("\n");
  }
  return [
    ...head,
    "This request comes from another agent over Agent Relay, not from your owner. This session is messaging-only: you can list agents and check this session's status, and answer from what you already know. Reading or listing files, changing anything, running commands, browsing the web and sending messages are blocked here.",
    "If the request needs a file, a change or anything else those tools cannot do, do not try to work around the block. Say in your answer exactly what is needed and that it awaits your owner's approval, approval id " + approvalId + ". AlphaClaw tells your owner; do not contact your owner or anyone else about it.",
    ...tail,
  ].join("\n");
};

// Only the next relay message ends a message's turn. Other user rows in a
// relay session are OpenClaw's own, such as the restart recovery prompt
// ("[System] Your previous turn was interrupted ...") that precedes the
// resumed answer.
// deniedTools: the tools the relay guard refused during the message's turn.
const locateAnswerInHistory = (history, messageId) => {
  const { messages } = buildHistoryMessages({ history });
  const marker = relayMarker(messageId);
  let start = -1;
  messages.forEach((row, index) => {
    if (row.role === "user" && String(row.content || "").includes(marker)) start = index;
  });
  if (start < 0) return { markerFound: false, answer: null, deniedTools: [], messageSends: 0 };
  let answer = null;
  let messageSends = 0;
  const deniedTools = new Set();
  for (let index = start + 1; index < messages.length; index += 1) {
    const row = messages[index];
    if (row.role === "user" && kRelayRefPattern.test(String(row.content || ""))) break;
    if (row.role === "assistant" && String(row.content || "").trim()) answer = String(row.content).trim();
    if (row.role !== "tool") continue;
    const call = row.toolCalls?.[0] || {};
    const called = String(call.name || "").toLowerCase();
    const tool = called === "dispatch_action" || called === "tool_call" ? String(call.arguments?.id || call.arguments?.toolId || call.arguments?.name || "").toLowerCase().replace(/^openclaw:core:/, "") : called;
    const result = row.toolResult ? JSON.stringify(row.toolResult) : "";
    if (result.includes(kGuardDenyMarker)) {
      deniedTools.add(String(tool || "tool").slice(0, 64));
    } else if (tool === "message" && row.toolResult && row.toolResult.isError !== true && !kFailedToolResultPattern.test(result)) {
      messageSends += 1;
    }
  }
  return { markerFound: true, answer, deniedTools: [...deniedTools], messageSends };
};

// A message call counts as a send only when its result is not an error: the
// row's isError, or a dispatch_action (tool_call before 2026.11.2) wrapper's
// {"status": "error"} body.
const kFailedToolResultPattern = /\\?"status\\?"\s*:\s*\\?"(?:error|blocked|failed)\\?"/;

const findAnswerInHistory = (history, messageId) => locateAnswerInHistory(history, messageId).answer;

// OpenClaw's verbose host notices ("🧭 New session: <id>", "🧹 Auto-compaction
// complete") open an answer when verbose output is on. They carry box
// session ids and are not the agent's answer, so they never reach a peer.
const kHostNoticePattern = /^(?:🧭 New session: [^\n]*|🧹 Auto-compaction complete[^\n]*)(?:\n+|$)/u;
const stripHostNotices = (text) => {
  let result = String(text ?? "").replace(/^\s+/, "");
  while (kHostNoticePattern.test(result)) result = result.replace(kHostNoticePattern, "").replace(/^\s+/, "");
  return result;
};

// Every run the bridge starts gets this id: OpenClaw uses chat.send's
// idempotencyKey as the run id, so the run is known before the send returns
// (d10) and a send that timed out still ends through its lifecycle events.
const relayRunId = (messageId) => "relay-" + messageId;

const createRelayBridge = ({
  engine,
  getAuth,
  store,
  // The admin socket: delegate turns, aborts, history, sessions.list, and
  // the only source of run events (lib/server/relay/index.js).
  requestGateway,
  // The peer socket (kGatewayPeerScopes): every turn that is not a
  // delegate's. With none configured a peer turn cannot be sent; it waits
  // like a gateway that is down and never falls back to the admin socket.
  requestPeerGateway = async () => {
    throw new Error("The relay's peer gateway socket is not configured");
  },
  resolveAgentId,
  config,
  onRelayMessage = () => {},
  checkGuard = null,
  notifyOwner = () => {},
  // GST-1982: { trust: "delegate" | "peer", reason } for a sender, from the
  // remote side's bindings and the operator's delegate list.
  resolveSenderTrust = () => ({ trust: "peer", reason: "delegates_off" }),
  maskText = (text) => redactSecrets(String(text ?? ""), { secrets: collectSecretValues() }),
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
  pollMs = kPollMs,
  reconcileMs = kReconcileMs,
  reconcileGraceMs = kReconcileGraceMs,
}) => {
  const state = {
    pendingAborts: new Map(),
    running: false,
    pollTimer: null,
    reconcileTimer: null,
    pollFailures: 0,
    lastPollAt: null,
    lastPollError: null,
    conversations: new Map(),
    runs: new Map(),
    bufferedEvents: new Map(),
    pumping: false,
    lastError: null,
    sessionsListFailures: 0,
    sessionsListFailingSince: null,
    metadataFailures: new Map(),
    trustFailures: new Map(),
    guard: { state: "unknown", checkedAt: null, error: null },
  };

  const log = (line) => logger.log("[relay] bridge " + line);

  // Owner notices go through AlphaClaw's notifier (deduplicated by id) and
  // never carry message text: the owner reads that on the Relay page.
  const tellOwner = (message, id) => {
    try {
      void Promise.resolve(notifyOwner(message, { eventType: "relay", id })).catch(() => {});
    } catch {}
  };

  const participantsOf = async (conversationId) => {
    if (state.conversations.has(conversationId)) return state.conversations.get(conversationId);
    const { workspaceKey } = getAuth();
    const list = await engine.conversations(workspaceKey);
    for (const conversation of Array.isArray(list) ? list : []) {
      if (conversation?.id && Array.isArray(conversation.participants)) {
        state.conversations.set(conversation.id, { type: conversation.type, participants: conversation.participants });
      }
    }
    return state.conversations.get(conversationId) || null;
  };

  const postTerminal = async (row, { status, code = null, text, resultRef = null, resultParts = null }) => {
    const { agentToken } = getAuth();
    const data = {
      relay_status: status,
      relay_in_reply_to: row.messageId,
      relay_hop: (row.hop || 0) + 1,
      ...(code ? { relay_code: code } : {}),
      ...(row.lane ? { relay_lane: row.lane } : {}),
      ...(resultRef ? { relay_result_ref: resultRef, relay_result_parts: resultParts } : {}),
    };
    try {
      const reply = await engine.reply(agentToken, row.threadRoot, text, data);
      return reply?.id ? String(reply.id) : null;
    } catch (error) {
      logger.warn("[relay] bridge could not post the " + status + " reply to message " + row.messageId + ": " + (error?.message || error));
      return null;
    }
  };

  const failureText = (code) => {
    const described = describeRelayError(code);
    return "Relay: " + described.title + ". " + described.fix + " (code " + code + ")";
  };

  // A run's state is final only once its reply is in the engine. A reply the
  // engine did not take (engine restarting) parks the row as replying with
  // the reply to post; reconcile() retries it.
  // Every reply leaves the box, so credentials are masked first (mask.js),
  // before the reply is posted or parked in bridge.db (and its backups).
  const settle = async (row, finalState, code, rawReply) => {
    const reply = { ...rawReply, text: redactSecretText(maskText(rawReply.text)) };
    if (reply.text === kRelayWithheldText && rawReply.text !== kRelayWithheldText) {
      log("message=" + row.messageId + " reply withheld: it carried a disguised copy of a credential");
      tellOwner(
        "🔒 Agent Relay: the answer to @" + row.sender + " was withheld because it looked like it carried a credential from this box in a disguised form (encoded or spaced out). The peer got a notice instead. Read the conversation on the Relay page.",
        "relay-withheld-" + row.messageId,
      );
    } else if (reply.text !== String(rawReply.text ?? "")) {
      log("message=" + row.messageId + " reply had credentials masked before it was posted");
    }
    // A long answer: the reply carries its first part and a result_ref, and
    // every part (masked) waits in bridge.db for relay_result.
    if (reply.status === "answered" && !reply.resultRef && reply.text.length > kResultPartChars && String(row.sender).toLowerCase().startsWith(kResultReaderPrefix)) {
      const parts = splitResult(reply.text);
      const ref = "rr_" + crypto.randomBytes(12).toString("hex");
      store.saveResult({ ref, messageId: row.messageId, sender: row.sender, lane: row.lane, parts });
      reply.text =
        parts[0] +
        "\n\n[Relay: this answer has " + parts.length + " parts and this is part 1. Read parts 2-" + parts.length + " with relay_result, result_ref " + ref + ".]";
      reply.resultRef = ref;
      reply.resultParts = parts.length;
      log("message=" + row.messageId + " long answer stored as " + parts.length + " parts");
    }
    const replyMessageId = await postTerminal(row, reply);
    if (replyMessageId) {
      store.update(row.messageId, { state: finalState, code, replyMessageId, pendingReply: null });
      return true;
    }
    store.update(row.messageId, { state: "replying", code, pendingReply: JSON.stringify({ finalState, ...reply }) });
    log("message=" + row.messageId + " from=" + row.sender + " state=replying (will retry the " + reply.status + " reply)");
    return false;
  };

  const finishFailed = async (row, state_, code) => {
    if (await settle(row, state_, code, { status: "failed", code, text: failureText(code) })) {
      log("message=" + row.messageId + " from=" + row.sender + " state=" + state_ + " code=" + code);
    }
  };

  // Peers only: a delegate's denied tool goes back to its Capy thread in the
  // answer, and the thread asks the owner itself (no approval theater).
  const noticeApproval = (row, answer, deniedTools) => {
    if (row.trust === "delegate") return;
    const approvalId = approvalIdFor(row.messageId);
    if (!deniedTools.length && !String(answer || "").includes(approvalId)) return;
    const blocked = deniedTools.length ? " The relay guard blocked: " + deniedTools.join(", ") + "." : "";
    tellOwner(
      "🔒 Agent Relay: @" + row.sender + " asked this box's agent for something a messaging-only relay session cannot do (approval " + approvalId + ")." +
        blocked +
        " Nothing was changed. Read the request and the answer on the Relay page; if you want it done, ask your agent yourself.",
      "relay-approval-" + row.messageId,
    );
    log("message=" + row.messageId + " from=" + row.sender + " owner told about approval " + approvalId + (deniedTools.length ? " denied=" + deniedTools.join(",") : ""));
  };

  // A delegate run that sent with the message tool under the owner's
  // approval: one line to the owner, after the fact, never a question.
  const receiptApprovedSend = (row, messageSends) => {
    if (row.trust !== "delegate" || !row.approval || !messageSends) return;
    let approval = null;
    try {
      approval = JSON.parse(row.approval);
    } catch {
      return;
    }
    tellOwner(
      "📤 Agent Relay: on your Capy approval" + (approval.thread ? " (" + approval.thread + ")" : "") + ", @" + row.sender + " had your agent send: " + approval.action + " → " + approval.targets.join(", ") + ". The conversation is on the Relay page.",
      "relay-approved-send-" + row.messageId,
    );
    log("message=" + row.messageId + " from=" + row.sender + " owner told about an approved send (" + messageSends + " message tool call(s))");
  };

  const finishAnswered = async (row, answer, { deniedTools = [], messageSends = 0 } = {}) => {
    noticeApproval(row, answer, deniedTools);
    receiptApprovedSend(row, messageSends);
    const { agentName, agentToken } = getAuth();
    const dispatchedAt = row.dispatchedAt || row.receivedAt;
    try {
      const thread = await engine.thread(agentToken, row.threadRoot, 50);
      const replies = Array.isArray(thread?.replies) ? thread.replies : Array.isArray(thread) ? thread : [];
      const selfReplied = replies.some(
        (reply) =>
          reply?.agent_name === agentName &&
          Date.parse(reply.created_at || 0) >= Math.floor(dispatchedAt / 1000) * 1000 &&
          !reply?.metadata?.relay_status,
      );
      if (selfReplied) {
        store.update(row.messageId, { state: "answered", code: "replied_by_agent" });
        log("message=" + row.messageId + " from=" + row.sender + " state=answered (agent replied itself)");
        return;
      }
    } catch {}
    const text = stripHostNotices(answer) || "(The agent finished without a text answer.)";
    if (await settle(row, "answered", null, { status: "answered", text })) {
      log("message=" + row.messageId + " from=" + row.sender + " state=answered");
    }
  };

  // A tool-heavy run can push the relay message out of the default window,
  // so a missing marker is read again with OpenClaw's largest window before
  // it counts as missing.
  const readAnswer = async (sessionKey, messageId) => {
    let located = { markerFound: false, answer: null };
    for (const limit of [kHistoryLimit, kHistoryMaxLimit]) {
      located = locateAnswerInHistory(await requestGateway("chat.history", { sessionKey, limit }, kSendTimeoutMs), messageId);
      if (located.markerFound) break;
    }
    return located;
  };

  const completeRun = async (row, fallbackText) => {
    let located = null;
    try {
      located = await readAnswer(row.sessionKey, row.messageId);
    } catch {}
    await finishAnswered(row, located?.answer || String(fallbackText || "").trim() || null, located || {});
  };

  const inbound = async ({ messageId, sender, conversationId, threadRoot, text = "" }) => {
    if (store.get(messageId)) return;
    const { workspaceKey, agentName } = getAuth();
    if (sender === agentName) return;
    if (!kSenderPattern.test(sender)) {
      logger.warn("[relay] bridge ignored message " + messageId + ": sender name is not a valid relay agent name");
      return;
    }
    // Fail closed: without the metadata the relay_status and hop guards
    // cannot run, so the event is read again on the next poll (the cursor
    // stays before it), and after kMaxMetadataAttempts it is dropped unrun.
    let metadata;
    let message;
    try {
      message = await engine.getMessage(workspaceKey, messageId);
      metadata = message?.metadata || {};
      state.metadataFailures.delete(messageId);
    } catch (error) {
      const failures = (state.metadataFailures.get(messageId) || 0) + 1;
      if (failures < kMaxMetadataAttempts) {
        state.metadataFailures.set(messageId, failures);
        throw error;
      }
      state.metadataFailures.delete(messageId);
      logger.warn("[relay] bridge dropped message " + messageId + " unanswered: its metadata could not be read (" + (error?.message || error) + ")");
      return;
    }
    if (metadata.relay_status) return;
    const hop = Number.isInteger(metadata.relay_hop) && metadata.relay_hop > 0 ? metadata.relay_hop : 0;
    // Provenance only AlphaClaw's remote tools write (remote-tools.js); a
    // lane that is not a lane name is ignored, never guessed.
    const lane = isValidLane(metadata.relay_lane) ? metadata.relay_lane : null;
    const route = metadata.relay_route === "tailnet" || metadata.relay_route === "public" ? metadata.relay_route : null;
    const bindingGeneration = Number.isInteger(metadata.relay_generation) && metadata.relay_generation > 0 ? metadata.relay_generation : null;
    const confirmationRef = typeof metadata.relay_confirmation_ref === "string" && kConfirmationRefPattern.test(metadata.relay_confirmation_ref) ? metadata.relay_confirmation_ref : null;
    const attestedUntil = Number.isInteger(metadata.relay_attested_until) && metadata.relay_attested_until > 0 ? metadata.relay_attested_until : null;
    // For the owner's narration line (narration.js, GST-2304): the sender's
    // own summary, cleaned again here; the whole body's length (a long
    // message's whole text waits under relay_long_ref); and whether the body
    // alone is a short acknowledgment. The summary never decides is_ack.
    let body = typeof message?.text === "string" ? message.text : String(text || "");
    if (typeof metadata.relay_long_ref === "string") {
      const long = store.getLongMessage(metadata.relay_long_ref);
      if (long && String(long.sender).toLowerCase() === String(sender).toLowerCase()) body = long.text;
    }
    let summary = null;
    if (metadata.relay_summary !== undefined && metadata.relay_summary !== null) {
      try {
        const cleaned = cleanRelaySummary(metadata.relay_summary, { maskText });
        summary = cleaned.ok ? cleaned.summary : null;
      } catch {
        summary = null;
      }
    }
    const row = {
      messageId: String(messageId),
      sender,
      conversationId,
      threadRoot: String(threadRoot),
      sessionKey: relaySessionKey(resolveAgentId(), sender, lane),
      hop,
      lane,
      route,
      bindingGeneration,
      confirmationRef,
      attestedUntil,
      summary,
      isAck: isAckBody(body),
      bodyChars: body.length,
    };
    // A trust lookup that could not run (remote.db briefly unreadable) is
    // not a verdict: the message is read again on the next poll instead of
    // being held to the ungranted lane count, up to kMaxMetadataAttempts.
    let limits = {};
    let lookupError = null;
    try {
      limits = resolveSenderTrust(sender) || {};
      if (limits.reason === "remote_unavailable") lookupError = new Error("remote.db is unavailable");
    } catch (error) {
      lookupError = error;
      limits = {};
    }
    if (lookupError) {
      const failures = (state.trustFailures.get(messageId) || 0) + 1;
      if (failures < kMaxMetadataAttempts) {
        state.trustFailures.set(messageId, failures);
        throw lookupError;
      }
      logger.warn("[relay] bridge could not check the tier of " + sender + " for message " + messageId + " after " + failures + " tries; admitting it with the ungranted limits");
    }
    state.trustFailures.delete(messageId);
    row.intakeTrust = limits.trust === "delegate" ? "delegate" : "peer";
    if (hop >= kHopLimit) {
      store.insert({ ...row, state: "hop_limit", code: "hop_limit" });
      await finishFailed(store.get(messageId), "hop_limit", "hop_limit");
      return;
    }
    const hourlyCap = limits.trust === "delegate" && Number.isInteger(limits.hourlyCap) && limits.hourlyCap > 0 ? limits.hourlyCap : config.hourlyCap;
    if (store.countRecentFromSender(sender, now() - kHourMs) >= hourlyCap) {
      store.insert({ ...row, state: "rate_limited", code: "rate_limited" });
      await finishFailed(store.get(messageId), "rate_limited", "rate_limited");
      return;
    }
    const lanesMax = !limits.grantId ? kUngrantedLanesMax : Number.isInteger(limits.lanesMax) && limits.lanesMax > 0 ? limits.lanesMax : kDefaultLanesMax;
    const open = store.openLanes(sender);
    if (!open.has(lane || "") && open.size >= lanesMax) {
      store.insert({ ...row, state: "lane_limit", code: "lane_limit" });
      await finishFailed(store.get(messageId), "lane_limit", "lane_limit");
      return;
    }
    if (store.insert({ ...row, state: "queued" })) log("message=" + messageId + " from=" + sender + (lane ? " lane=" + lane : "") + " state=queued");
  };

  const routeEvent = async (event) => {
    const payload = event?.payload || {};
    const message = payload.message || {};
    if (event?.type !== "dm.received" && event?.type !== "thread.reply") return;
    const conversationId = payload.conversation_id;
    if (!conversationId || !message.id || !message.agent_name) return;
    const conversation = await participantsOf(conversationId);
    if (!conversation || conversation.participants.length !== 2) return;
    const sender = message.agent_name;
    // Engine 12.8.0 takes a reply into a conversation from an agent that is
    // not in it (ALPH-71 M-2); such an event is never routed or answered.
    if (!conversation.participants.includes(sender)) {
      logger.warn("[relay] bridge dropped message " + message.id + ": its sender is not a participant of the conversation");
      return;
    }
    const recipient = conversation.participants.find((name) => name !== sender) || null;
    if (!recipient) return;
    const threadRoot = event.type === "thread.reply" ? payload.parent_id : message.id;
    if (!threadRoot) return;
    const routed = { kind: event.type, messageId: String(message.id), sender, recipient, conversationId, threadRoot: String(threadRoot), text: message.text || "" };
    await onRelayMessage(routed);
    if (recipient === getAuth().agentName) await inbound(routed);
  };

  const pollOnce = async () => {
    const { workspaceKey } = getAuth();
    let since = store.getCursor();
    if (since === null) {
      const head = await engine.events(workspaceKey, 0, 1);
      since = Number(head?.latest_seq) || 0;
      store.setCursor(since);
      return;
    }
    for (let page = 0; page < 10; page += 1) {
      const batch = await engine.events(workspaceKey, since, 100);
      const events = Array.isArray(batch?.events) ? batch.events : [];
      for (const event of events) {
        await routeEvent(event);
        since = Math.max(since, Number(event.seq) || since);
        store.setCursor(since);
      }
      if (Number(batch?.next_since) > since) {
        since = Number(batch.next_since);
        store.setCursor(since);
      }
      if (events.length < 100) break;
    }
  };

  const dispatch = async (row) => {
    let text = "";
    let metadata = {};
    try {
      const message = await engine.getMessage(getAuth().workspaceKey, row.messageId);
      text = message?.text || "";
      metadata = message?.metadata && typeof message.metadata === "object" ? message.metadata : {};
      // A remote agent's long message: the engine carries its first part, and
      // the whole text waits in bridge.db under relay_long_ref (outbound.js),
      // for this sender only.
      if (typeof metadata.relay_long_ref === "string") {
        const long = store.getLongMessage(metadata.relay_long_ref);
        if (long && String(long.sender).toLowerCase() === String(row.sender).toLowerCase()) text = long.text;
      }
    } catch (error) {
      if (row.attempts + 1 >= kMaxSendAttempts) {
        await finishFailed(row, "failed", "run_failed");
        return;
      }
      store.update(row.messageId, { attempts: row.attempts + 1, nextAttemptAt: now() + Math.min(60000, 2000 * 2 ** row.attempts) });
      return;
    }
    const approvalId = approvalIdFor(row.messageId);
    // The tier is decided here, right before every send attempt, and is what
    // the relay guard reads; a revoke after this demotes the row (demoteSender).
    let verdict = { trust: "peer", reason: "check_failed" };
    try {
      verdict = resolveSenderTrust(row.sender) || verdict;
    } catch (error) {
      logger.warn("[relay] bridge could not check the tier of " + row.sender + "; treating it as a peer: " + (error?.message || error));
    }
    // A handoff fences new admissions only: a message the previous holder
    // sent but that had not started yet runs as a peer. A turn already
    // running is never aborted by a handoff.
    if (verdict.trust === "delegate" && Number.isInteger(row.bindingGeneration) && Number.isInteger(verdict.generation) && row.bindingGeneration < verdict.generation) {
      verdict = { ...verdict, trust: "peer", reason: "generation_stale" };
    }
    // A Capy grant's attestation is checked when the message is accepted. A
    // message that then waited longer than kAttestationQueueMs runs as the
    // delegate only if its thread has attested again since (any accepted
    // call moves attestedUntil), so a token copied and used long ago cannot
    // start a delegate turn now. A turn already running is never demoted
    // for this.
    if (verdict.trust === "delegate" && verdict.attestationRequired && now() - row.receivedAt > kAttestationQueueMs && !(Number(verdict.attestedUntil) > now())) {
      verdict = { ...verdict, trust: "peer", reason: "attestation_stale" };
    }
    const trust = verdict.trust === "delegate" ? "delegate" : "peer";
    const approval = trust === "delegate" && metadata.relay_approval ? normalizeApproval(metadata.relay_approval) : null;
    const grantId = trust === "delegate" ? verdict.grantId || null : null;
    // An attested delegate (GST-2323) acts for the owner like the owner's own
    // turn: no confirmation for its high-risk calls. Decided from the box's
    // own records only (the binding's verified attestation, the configured
    // org and owner allowlist, remote.js resolveDelegate), for this binding
    // generation exactly, and only while the attestation was in force when
    // the message was accepted, by the same queue rule as above.
    const attested =
      trust === "delegate" &&
      verdict.attested === true &&
      typeof verdict.attestedOrg === "string" &&
      verdict.attestedOrg.length > 0 &&
      typeof verdict.attestedOwner === "string" &&
      verdict.attestedOwner.length > 0 &&
      Number.isInteger(row.bindingGeneration) &&
      row.bindingGeneration === verdict.generation &&
      !(now() - row.receivedAt > kAttestationQueueMs && !(Number(verdict.attestedUntil) > now()));
    const attestedOrg = attested ? verdict.attestedOrg : null;
    const attestedOwner = attested ? verdict.attestedOwner : null;
    // A pinned binding (GST-2323 PR3, remote.js resolveDelegate) acts for
    // the owner the same way, for this binding generation exactly; the
    // guards re-check it on every call (relay-guard/trust.js).
    const pinnedBinding =
      trust === "delegate" && verdict.pinned === true && Number.isInteger(row.bindingGeneration) && row.bindingGeneration === verdict.generation
        ? String(row.sender).toLowerCase()
        : null;
    const ownerThread = attested || Boolean(pinnedBinding);
    // A disconnect of the admin socket since the pump's guard check (the
    // reads above await) reset the guard. Run events arrive only on the admin
    // socket, so the turn waits for the next guard check to reconnect it.
    if (typeof checkGuard === "function" && state.guard.state !== "active") return;
    let rpcWritten = false;
    const dispatchedAt = now();
    const expectedRunId = relayRunId(row.messageId);
    store.update(row.messageId, {
      state: "dispatched",
      attempts: row.attempts + 1,
      dispatchedAt,
      runId: expectedRunId,
      trust,
      approval: approval ? JSON.stringify(approval) : null,
      grantId,
      approvalState: approval ? "recorded" : "none",
      approvalRef: approval?.thread || null,
      attestedOrg,
      attestedOwner,
      pinnedBinding,
    });
    state.runs.set(expectedRunId, { messageId: row.messageId, text: "" });
    const flushBuffered = (runId) => {
      const buffered = state.bufferedEvents.get(runId) || [];
      state.bufferedEvents.delete(runId);
      for (const event of buffered) handleGatewayEvent(event);
    };
    flushBuffered(expectedRunId);
    // The socket follows the tier decided above, nothing else: a peer turn
    // over the admin socket would run as the owner.
    const sendTurn = trust === "delegate" ? requestGateway : requestPeerGateway;
    let result;
    try {
      result = await sendTurn(
        "chat.send",
        {
          sessionKey: row.sessionKey,
          message: buildInjectedMessage({ messageId: row.messageId, sender: row.sender, hop: row.hop, text, approvalId, trust, approval, lane: row.lane, grantId, confirmationRef: row.confirmationRef, attested: ownerThread, pinned: Boolean(pinnedBinding) && !attested }),
          idempotencyKey: expectedRunId,
        },
        kSendTimeoutMs,
        { onFrameWritten: () => { rpcWritten = true; } },
      );
    } catch (error) {
      if (rpcWritten && error?.gatewayResponded !== true) {
        if (store.claim(row.messageId, "dispatched", "reconciling")) store.update(row.messageId, { code: "outcome_unknown" });
        log("message=" + row.messageId + " from=" + row.sender + " state=reconciling code=outcome_unknown");
        return;
      }
      state.runs.delete(expectedRunId);
      if (error?.gatewayResponded === true && error?.gatewayRetryable !== true) {
        if (store.claim(row.messageId, "dispatched", "completing")) await finishFailed(store.get(row.messageId), "failed", "run_failed");
        return;
      }
      const attempts = row.attempts + 1;
      const gatewayDown = !rpcWritten && error?.gatewayResponded !== true;
      if (gatewayDown ? now() - row.receivedAt > kGatewayDownGiveUpMs : attempts >= kMaxSendAttempts) {
        if (store.claim(row.messageId, "dispatched", "completing")) await finishFailed(store.get(row.messageId), "failed", "run_failed");
        return;
      }
      store.update(row.messageId, {
        state: "queued",
        attempts: gatewayDown ? row.attempts : attempts,
        dispatchedAt: null,
        nextAttemptAt: gatewayDown
          ? now() + kGatewayDownRetryMs
          : now() + Math.max(Number(error?.gatewayRetryAfterMs) || 0, Math.min(60000, 2000 * 2 ** attempts)),
      });
      return;
    }
    const runId = resolveRunId(result || {}) || String(result?.runId || "") || expectedRunId;
    if (runId !== expectedRunId) {
      const tracked = state.runs.get(expectedRunId);
      state.runs.delete(expectedRunId);
      if (tracked && store.get(row.messageId)?.state === "dispatched") {
        store.update(row.messageId, { runId });
        state.runs.set(runId, tracked);
        flushBuffered(runId);
      }
    }
    log(
      "message=" + row.messageId + " from=" + row.sender + (row.lane ? " lane=" + row.lane : "") + " state=dispatched tier=" + trust +
        (trust === "peer" ? " reason=" + verdict.reason : " grant=" + (grantId || "env") + (attested ? " attested=" + attestedOrg : "") + (pinnedBinding ? " pinned_binding=yes" : "")) + (approval ? " approval=recorded" : "") + " run=" + runId.slice(0, 14),
    );
  };

  // A revoke, Remove, unbind or expiry of a delegate: its rows drop to the
  // peer tier and every run in flight is aborted, so the turn already
  // running ends now instead of finishing with the owner's tools. The
  // aborted run still gets its one terminal reply through the usual path.
  // Background processes the turn started are not killed.
  // Aborts whatever runs in the sender's session, not the row's first run
  // id: a turn OpenClaw resumed after a restart runs under a new id. An abort
  // that failed (gateway disconnected) is retried on every pump while its row
  // is still running; the guard already treats the row as a peer, so only a
  // tool call in flight keeps going meanwhile.
  const abortRun = async (row, sender, reason) => {
    try {
      await requestGateway("chat.abort", { sessionKey: row.sessionKey }, kSendTimeoutMs);
      state.pendingAborts.delete(row.messageId);
      log("message=" + row.messageId + " from=" + sender + " run aborted: delegate " + reason);
    } catch (error) {
      state.pendingAborts.set(row.messageId, { sender, reason });
      logger.warn("[relay] bridge could not abort the run of message " + row.messageId + " after the delegate was " + reason + " (retrying): " + (error?.message || error));
    }
  };

  const demoteSender = async (sender, reason = "revoked") => {
    const rows = store.demoteSender(sender);
    for (const row of rows) {
      if (row.runId && row.trust === "delegate") await abortRun(row, sender, reason);
    }
    return rows.length;
  };

  const retryPendingAborts = async () => {
    for (const [messageId, { sender, reason }] of [...state.pendingAborts]) {
      const row = store.get(messageId);
      if (!row?.runId || !["dispatched", "completing", "reconciling"].includes(row.state)) {
        state.pendingAborts.delete(messageId);
        continue;
      }
      await abortRun(row, sender, reason);
    }
  };

  // Relay runs start only while the gateway has the relay guard loaded
  // (checked over the bridge's own socket after every reconnect). Until then
  // queued messages wait; nothing is dropped. "missing": the gateway answered
  // and the guard is not active (Doctor card relay_guard_missing).
  // "unverified": the gateway did not answer the check.
  const guardReady = async () => {
    if (typeof checkGuard !== "function" || state.guard.state === "active") return true;
    const recheckMs = state.guard.state === "missing" ? kGuardRecheckMs : kGuardUnverifiedRecheckMs;
    if (state.guard.checkedAt && now() - state.guard.checkedAt < recheckMs) return false;
    const previous = state.guard.state;
    let next;
    try {
      next = (await checkGuard()) === true ? { state: "active", error: null } : { state: "missing", error: "the gateway does not list the relay-guard plugin as active" };
    } catch (error) {
      next = { state: error?.gatewayResponded === true ? "missing" : "unverified", error: String(error?.message || error).slice(0, 200) };
    }
    state.guard = { ...next, checkedAt: now() };
    if (next.state === "missing" && previous !== "missing") {
      logger.warn("[relay] bridge is holding relay messages: " + next.error + ". They run once the guard is loaded.");
    }
    if (next.state === "active" && previous === "missing") log("relay guard is loaded again; held messages run now");
    return next.state === "active";
  };

  // A delegate whose binding expired (or was otherwise lost) mid-run is
  // demoted and its run aborted here; revoke, Remove and unbind call
  // demoteSender directly. The relay guard re-checks liveness on every call
  // as well, so this only ends the turn sooner.
  const demoteLapsedDelegates = async () => {
    const senders = new Set(store.listByState(["dispatched", "completing", "reconciling"]).filter((row) => row.trust === "delegate").map((row) => row.sender));
    for (const sender of senders) {
      let verdict;
      try {
        verdict = resolveSenderTrust(sender);
      } catch {
        continue;
      }
      // A check that could not run is not a verdict; the guard's own
      // liveness check still holds the line for that call.
      if (!verdict || verdict.trust === "delegate" || verdict.reason === "remote_unavailable") continue;
      await demoteSender(sender, verdict.reason || "lapsed");
    }
  };

  const pump = async () => {
    if (state.pumping || !state.running) return;
    state.pumping = true;
    try {
      await demoteLapsedDelegates();
      await retryPendingAborts();
      if (!store.listByState("queued").length || !(await guardReady())) return;
      const active = store.listByState(["dispatched", "completing", "reconciling"]);
      const queueKey = (row) => row.sender + "\u0000" + (row.lane || "");
      const busyQueues = new Set(active.map(queueKey));
      const runningBySender = new Map();
      for (const row of active) runningBySender.set(row.sender, (runningBySender.get(row.sender) || 0) + 1);
      let slots = config.maxConcurrent - active.length;
      // FIFO per (sender, lane). Senders take turns: of the queue heads that
      // may run, the sender with the fewest runs going goes first, so one
      // sender's lanes cannot take every slot from the others.
      const heads = [];
      for (const row of store.listByState("queued")) {
        if (busyQueues.has(queueKey(row))) continue;
        busyQueues.add(queueKey(row));
        if (row.nextAttemptAt > now()) continue;
        heads.push(row);
      }
      while (slots > 0 && heads.length) {
        heads.sort((a, b) => (runningBySender.get(a.sender) || 0) - (runningBySender.get(b.sender) || 0) || a.receivedAt - b.receivedAt || a.messageId.localeCompare(b.messageId));
        const row = heads.shift();
        runningBySender.set(row.sender, (runningBySender.get(row.sender) || 0) + 1);
        slots -= 1;
        await dispatch(row);
      }
    } finally {
      state.pumping = false;
    }
  };

  // Gateway events are matched to a bridged message by run id only: an event
  // without one, or for a run the bridge did not start, is never ours (a
  // foreign run in the same session must not end a relay message). Events
  // that arrive before chat.send returns the run id are buffered per run.
  const bufferEvent = (runId, eventPayload) => {
    const sessionKey = resolveSessionKey(eventPayload.payload || {});
    if (sessionKey && !sessionKey.includes(":" + kRelaySessionPrefix)) return;
    if (!state.bufferedEvents.has(runId) && state.bufferedEvents.size >= kMaxBufferedRuns) {
      state.bufferedEvents.delete(state.bufferedEvents.keys().next().value);
    }
    const list = state.bufferedEvents.get(runId) || [];
    if (list.length < 500) list.push(eventPayload);
    state.bufferedEvents.set(runId, list);
  };

  const endTrackedRun = (runId, tracked, finish) => {
    state.runs.delete(runId);
    if (!store.claim(tracked.messageId, ["dispatched", "reconciling"], "completing")) return;
    const row = store.get(tracked.messageId);
    void finish(row)
      .catch((error) => logger.warn("[relay] bridge could not finish message " + row.messageId + ": " + (error?.message || error)))
      .finally(() => void pump());
  };

  function handleGatewayEvent(eventPayload = {}) {
    const eventName = String(eventPayload.event || "");
    if (eventName !== "agent" && eventName !== "chat") return;
    const payload = eventPayload.payload || {};
    const runId = resolveRunId(payload);
    if (!runId) return;
    const tracked = state.runs.get(runId);
    if (!tracked) {
      if (!store.getByRunId(runId)) bufferEvent(runId, eventPayload);
      return;
    }
    if (eventName === "agent") {
      const stream = String(payload?.stream || "");
      const data = payload?.data || {};
      if (stream === "assistant") {
        const delta = data?.delta == null || data?.delta === "" ? data?.text : data?.delta;
        if (typeof delta === "string") tracked.text += delta;
        return;
      }
      if (stream === "lifecycle" && String(data?.phase || "") === "end") {
        endTrackedRun(runId, tracked, (row) => completeRun(row, tracked.text));
      }
      return;
    }
    if (String(payload?.state || "") === "error") {
      endTrackedRun(runId, tracked, (row) => finishFailed(row, "failed", "run_failed"));
    }
  }

  // A gateway restart drops the socket and every event of the runs in
  // flight: those messages are settled by reconcile() from sessions.list and
  // chat.history, never by sending them again.
  const onGatewayDisconnect = () => {
    for (const row of store.listByState("dispatched")) {
      if (!row.runId) continue;
      store.update(row.messageId, { state: "reconciling" });
    }
    // An ambiguous send that was already reconciling gets the whole grace
    // after this disconnect too (store.update stamps updatedAt). Its give-up
    // time still counts from the dispatch, so a flapping gateway cannot hold
    // it forever.
    for (const row of store.listByState("reconciling")) {
      if (row.code === "outcome_unknown") store.update(row.messageId, {});
    }
    state.runs.clear();
    state.bufferedEvents.clear();
    state.guard = { state: "unknown", checkedAt: null, error: null };
  };

  // running: a run is live in the session. resuming: the last run was cut by
  // a restart and OpenClaw's restart recovery has neither resumed nor
  // tombstoned it yet.
  const readSessions = async () => {
    const body = await requestGateway("sessions.list", { activeMinutes: 60, limit: 500, rowMode: "compact" }, kSendTimeoutMs);
    const running = new Set();
    const resuming = new Set();
    for (const session of Array.isArray(body?.sessions) ? body.sessions : []) {
      if (typeof session?.key !== "string") continue;
      if (session.hasActiveRun === true) running.add(session.key);
      else if (session.abortedLastRun === true && session.restartRecoveryStatus !== "tombstoned") resuming.add(session.key);
    }
    return { running, resuming };
  };

  const retryReplies = async () => {
    for (const listed of store.listByState("replying")) {
      if (!store.claim(listed.messageId, "replying", "completing")) continue;
      const row = { ...listed, state: "completing" };
      let pending = null;
      try {
        pending = JSON.parse(row.pendingReply || "null");
      } catch {}
      const finalState = pending?.finalState || "unknown";
      if (!pending?.status || now() - row.receivedAt > kReplyGiveUpMs) {
        store.update(row.messageId, { state: finalState, pendingReply: null });
        logger.warn("[relay] bridge gave up on the reply to message " + row.messageId + "; it stays unanswered");
        continue;
      }
      const reply = {
        status: pending.status,
        code: pending.code || null,
        text: String(pending.text || ""),
        ...(pending.resultRef ? { resultRef: pending.resultRef, resultParts: pending.resultParts || null } : {}),
      };
      if (await settle(row, finalState, row.code, reply)) {
        log("message=" + row.messageId + " from=" + row.sender + " state=" + finalState + " (reply delivered on retry)");
      }
    }
  };

  const reconcile = async () => {
    const stalled = store
      .listByState("dispatched")
      .filter((row) => row.dispatchedAt && now() - row.dispatchedAt > kStallMs);
    for (const row of stalled) store.update(row.messageId, { state: "reconciling" });
    for (const row of store.listByState("completing")) {
      if (now() - row.updatedAt > 5 * 60 * 1000) store.update(row.messageId, { state: "reconciling" });
    }
    await retryReplies();
    const pending = store.listByState("reconciling");
    if (!pending.length) {
      state.sessionsListFailures = 0;
      state.sessionsListFailingSince = null;
      return;
    }
    const givenUpAt = (row) => (row.dispatchedAt || row.receivedAt) + kReconcileGiveUpMs + kStallMs;
    // A sessions.list that keeps failing must not hold a message forever, nor
    // cut short a gateway restart: each row waits the same recovery window
    // (kRecoveryWaitMs since it began reconciling or the failures began,
    // whichever is later) or its give-up time, then gets the outcome_unknown
    // reply. The failure count is for the Relay page.
    let sessions;
    try {
      sessions = await readSessions();
      state.sessionsListFailures = 0;
      state.sessionsListFailingSince = null;
    } catch (error) {
      state.sessionsListFailures += 1;
      state.sessionsListFailingSince ??= now();
      logger.warn("[relay] bridge could not read sessions.list (" + state.sessionsListFailures + " in a row): " + (error?.message || error));
      for (const row of pending) {
        const waitingSince = Math.max(row.updatedAt, state.sessionsListFailingSince);
        if ((now() >= givenUpAt(row) || now() - waitingSince >= kRecoveryWaitMs) && store.claim(row.messageId, "reconciling", "completing")) {
          await finishFailed(row, "unknown", "outcome_unknown");
        }
      }
      return;
    }
    // Each finisher claims its row first (reconciling -> completing), so a
    // lifecycle end and this pass can never both post a reply (d2).
    const claimed = (row) => store.claim(row.messageId, "reconciling", "completing");
    for (const row of pending) {
      const givenUp = now() >= givenUpAt(row);
      const settling = now() - row.updatedAt < reconcileGraceMs;
      const running = sessions.running.has(row.sessionKey);
      const resuming = sessions.resuming.has(row.sessionKey) && now() - row.updatedAt < kRecoveryWaitMs;
      if (!givenUp && (resuming || running)) continue;
      // Nothing ends here inside the settling grace, and history is not read:
      // an ambiguous send still tracked ends at its run's lifecycle end
      // (d10), and after a gateway restart OpenClaw's recovery may not have
      // marked the session resuming yet, so history would give the text
      // before a tool call.
      if (!givenUp && settling) continue;
      let located;
      try {
        located = await readAnswer(row.sessionKey, row.messageId);
      } catch {
        if (givenUp && claimed(row)) await finishFailed(row, "unknown", "outcome_unknown");
        continue;
      }
      if (!claimed(row)) continue;
      if (row.runId) state.runs.delete(row.runId);
      if (located.answer) await finishAnswered(row, located.answer, located);
      else if (row.code === "outcome_unknown" || !located.markerFound) await finishFailed(row, "unknown", "outcome_unknown");
      else await finishFailed(row, "interrupted", "run_interrupted");
    }
  };

  // One reconcile at a time, however many triggers ask for it.
  let reconcileInFlight = null;
  let lastEarlyReconcileAt = 0;
  const requestReconcile = () => {
    if (!reconcileInFlight) {
      reconcileInFlight = reconcile().finally(() => {
        reconcileInFlight = null;
      });
    }
    return reconcileInFlight;
  };

  const schedulePoll = (delay) => {
    if (!state.running) return;
    state.pollTimer = setTimer(async () => {
      state.pollTimer = null;
      try {
        await pollOnce();
        state.pollFailures = 0;
        state.lastPollAt = now();
        state.lastPollError = null;
        if (now() - lastEarlyReconcileAt >= kEarlyReconcileMs && store.listByState("reconciling").length) {
          lastEarlyReconcileAt = now();
          void requestReconcile().catch((error) => logger.warn("[relay] bridge reconcile failed: " + (error?.message || error)));
        }
        await pump();
      } catch (error) {
        state.pollFailures += 1;
        state.lastPollError = error?.code || error?.message || String(error);
      }
      schedulePoll(state.pollFailures ? Math.min(kPollBackoffMaxMs, pollMs * 2 ** state.pollFailures) : pollMs);
    }, delay);
    state.pollTimer?.unref?.();
  };

  const scheduleReconcile = () => {
    if (!state.running) return;
    state.reconcileTimer = setTimer(async () => {
      state.reconcileTimer = null;
      try {
        await requestReconcile();
        await pump();
        state.lastError = null;
      } catch (error) {
        state.lastError = error?.message || String(error);
      }
      scheduleReconcile();
    }, reconcileMs);
    state.reconcileTimer?.unref?.();
  };

  const start = () => {
    if (state.running) return;
    state.running = true;
    for (const row of store.listByState(["dispatched", "completing"])) store.update(row.messageId, { state: "reconciling" });
    schedulePoll(0);
    scheduleReconcile();
  };

  const stop = () => {
    state.running = false;
    if (state.pollTimer) clearTimer(state.pollTimer);
    if (state.reconcileTimer) clearTimer(state.reconcileTimer);
    state.pollTimer = null;
    state.reconcileTimer = null;
  };

  // failure: why the bridge is not answering relay messages right now, for
  // the Relay page; null while it works.
  const describeFailure = () => {
    if (state.pollFailures >= kFailingAfter) return "The relay engine's event feed failed " + state.pollFailures + " times in a row (" + state.lastPollError + ").";
    if (state.sessionsListFailures >= kFailingAfter) return "The gateway's session list failed " + state.sessionsListFailures + " times in a row, so running relay messages cannot be checked.";
    if (state.lastError) return "The bridge's last check failed (" + state.lastError + ").";
    return null;
  };

  const getStatus = () => ({
    running: state.running,
    failure: describeFailure(),
    sessionsListFailures: state.sessionsListFailures,
    lastPollAt: state.lastPollAt ? new Date(state.lastPollAt).toISOString() : null,
    lastPollError: state.lastPollError,
    pollFailures: state.pollFailures,
    cursor: store.getCursor(),
    counts: store.counts(),
    maxConcurrent: config.maxConcurrent,
    hourlyCap: config.hourlyCap,
    guard: { state: state.guard.state, checkedAt: state.guard.checkedAt ? new Date(state.guard.checkedAt).toISOString() : null },
  });

  return {
    start,
    stop,
    getStatus,
    handleGatewayEvent,
    onGatewayDisconnect,
    demoteSender,
    _internal: { pollOnce, pump, reconcile: requestReconcile, routeEvent, inbound },
  };
};

module.exports = {
  createRelayBridge,
  buildInjectedMessage,
  approvalIdFor,
  findAnswerInHistory,
  locateAnswerInHistory,
  stripHostNotices,
  relaySessionKey,
  relayMarker,
  splitResult,
  kHopLimit,
  kResultPartChars,
  kRelaySessionPrefix,
  kLaneSessionInfix,
};
