const {
  createQueuedMessageNotice,
  parseTelegramChat,
  resolveTelegramTarget,
  kNoticeText,
  kTopicNoticeText,
} = require("../../lib/server/queued-message-notice");
const { ownerInboundKey } = require("../../lib/plugin/group-guard");

// The fallback line as OpenClaw 2026.11.4 prints it on the console
// (createSubsystemLogger("diagnostic").warn with its key=value tail), ANSI kept.
const queuedLine = ({ sessionId = "sess-topic", channel = "telegram", disposition = "followup-queued", reason = "unknown-source-with-terminal-history", runId = "inbound-run-1" } = {}) =>
  "\u001b[90m2026-11-18T00:49:48.120+00:00\u001b[39m \u001b[33m[diagnostic]\u001b[39m \u001b[33msteering rejected; applying follow-up policy reason=" +
  reason + " disposition=" + disposition + " channel=" + channel + " sessionId=" + sessionId + " runId=" + runId + "\u001b[39m\n";

const kGroup = "-1001234567890";
const kTopic = "99886";
const kTopicKey = "agent:main:telegram:group:" + kGroup + ":topic:" + kTopic;
const kDmKey = "agent:main:main";

// The group-guard plugin's mark for an owner's turn, as the gateway prints a
// plugin logger's info line.
const ownerLine = (sessionKey = kTopicKey) =>
  "\u001b[90m2026-11-18T00:49:48.010+00:00\u001b[39m \u001b[36m[plugins]\u001b[39m \u001b[36m[group-guard] owner inbound chat=" + ownerInboundKey(sessionKey) + "\u001b[39m\n";

const topicRow = (overrides = {}) => ({ key: kTopicKey,
  sessionId: "sess-topic",
  hasActiveRun: true,
  activeRunIds: ["announce:v1:agent:main:subagent:child:run-1"],
  startedAt: Date.parse("2026-11-18T00:47:41.000Z"),
  deliveryContext: { channel: "telegram", to: "telegram:" + kGroup, threadId: kTopic, accountId: "default" },
  ...overrides,
});

describe("server/queued-message-notice", () => {
  let clock;
  let rows;
  let sendTelegram;
  let insertEvent;
  let timers;
  let logger;
  let listSessions;
  let notice;

  beforeEach(() => {
    clock = Date.parse("2026-11-18T00:49:48.500Z");
    rows = [topicRow()];
    sendTelegram = vi.fn(async () => ({ ok: true }));
    insertEvent = vi.fn();
    timers = [];
    logger = { log: vi.fn(), warn: vi.fn() };
    listSessions = vi.fn(async () => ({ sessions: rows }));
    notice = createQueuedMessageNotice({
      listSessions,
      sendTelegram,
      insertEvent,
      now: () => clock,
      setTimer: (fn, ms) => timers.push({ fn, ms }),
      logger,
    });
  });

  const ownerQueued = (opts = {}, key = kTopicKey) => notice.observeGatewayOutput(ownerLine(key) + queuedLine(opts));

  it("posts one line in the topic when an owner's message is queued behind a run that started minutes earlier", async () => {
    ownerQueued();
    await notice.settled();
    expect(listSessions).toHaveBeenCalledWith({ activeOnly: true, limit: 200, rowMode: "compact" });
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram).toHaveBeenCalledWith({ accountId: "default", chatId: kGroup, threadId: kTopic, text: kTopicNoticeText });
    expect(insertEvent).toHaveBeenCalledWith({
      eventType: "queued_message_notice",
      source: "queued_notice",
      status: "sent",
      details: { channel: "telegram", chat: "topic", runAgeS: 128, reason: "unknown-source-with-terminal-history" },
    });
    const logged = logger.log.mock.calls.map((call) => call[0]).join("\n");
    expect(logged).toContain("[alphaclaw] queued-notice: sent chat=topic runAgeS=128");
    expect(logged).not.toContain(kGroup);
    expect(logged).not.toContain(kTopic);
  });

  it("stays silent when the queued message is not an owner's, even right after an owner's message in the same topic", async () => {
    notice.observeGatewayOutput(queuedLine());
    await notice.settled();
    expect(sendTelegram).not.toHaveBeenCalled();
    rows = [topicRow({ activeRunIds: ["run-b"] })];
    ownerQueued();
    notice.observeGatewayOutput(queuedLine({ runId: "stranger" }));
    await notice.settled();
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    rows = [topicRow({ activeRunIds: ["run-c"] })];
    notice.observeGatewayOutput(queuedLine({ runId: "stranger-2" }));
    await notice.settled();
    expect(sendTelegram).toHaveBeenCalledTimes(1);
  });

  it("does not read sessions for a queued message when no owner mark is waiting", async () => {
    notice.observeGatewayOutput(queuedLine() + queuedLine({ runId: "stranger-2" }));
    await notice.settled();
    expect(listSessions).not.toHaveBeenCalled();
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("ignores an owner mark for another chat and one older than 30 seconds", async () => {
    notice.observeGatewayOutput(ownerLine("agent:main:telegram:group:-100999:topic:5") + queuedLine());
    await notice.settled();
    notice.observeGatewayOutput(ownerLine());
    clock += 3 * 60_000;
    notice.observeGatewayOutput(queuedLine());
    await notice.settled();
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("does not let a stranger spend an owner mark left by a message OpenClaw steered 30 s earlier", async () => {
    notice.observeGatewayOutput(ownerLine());
    clock += 31_000;
    notice.observeGatewayOutput(queuedLine({ runId: "stranger" }));
    await notice.settled();
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("only counts an owner mark logged before the queued line, and only the group guard's own", async () => {
    notice.observeGatewayOutput(queuedLine({ runId: "stranger" }));
    clock += 1_000;
    notice.observeGatewayOutput(ownerLine());
    await notice.settled();
    clock += 31_000;
    notice.observeGatewayOutput(ownerLine().replace("[group-guard] ", "[someone-else] ") + queuedLine({ runId: "stranger-2" }));
    await notice.settled();
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("never tells the owner their message is next once it is already running", async () => {
    rows = [topicRow({ activeRunIds: ["inbound-run-1"], startedAt: clock + 2_000 })];
    ownerQueued();
    await notice.settled();
    rows = [topicRow({ activeRunIds: ["inbound-run-2"], startedAt: clock - 5 * 60_000 })];
    ownerQueued({ runId: "inbound-run-2" });
    await notice.settled();
    expect(sendTelegram).not.toHaveBeenCalled();
    expect(timers).toHaveLength(0);
  });

  it("sends at most one notice per run per chat, however many owner messages queue behind it", async () => {
    for (let i = 0; i < 5; i += 1) {
      clock += 40_000;
      ownerQueued({ runId: "inbound-run-" + i });
    }
    await notice.settled();
    expect(sendTelegram).toHaveBeenCalledTimes(1);
  });

  it("sends again when a later run holds the same chat", async () => {
    ownerQueued();
    await notice.settled();
    rows = [topicRow({ activeRunIds: ["announce:v1:agent:main:subagent:child:run-2"], startedAt: clock - 5 * 60_000 })];
    ownerQueued();
    await notice.settled();
    expect(sendTelegram).toHaveBeenCalledTimes(2);
  });

  it("waits until the run ahead is a minute old, and posts only if that same run still holds the chat", async () => {
    rows = [topicRow({ startedAt: clock - 20_000 })];
    ownerQueued();
    ownerQueued({ runId: "inbound-run-2" });
    await notice.settled();
    expect(sendTelegram).not.toHaveBeenCalled();
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(40_000);
    clock += 40_000;
    timers[0].fn();
    await notice.settled();
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(insertEvent.mock.calls[0][0].details.runAgeS).toBe(60);
  });

  it("posts nothing when the young run ends or another run replaced it before the minute is up", async () => {
    rows = [topicRow({ startedAt: clock - 20_000 })];
    ownerQueued();
    await notice.settled();
    rows = [topicRow({ activeRunIds: ["inbound-run-1"], startedAt: clock + 30_000 })];
    clock += 40_000;
    timers[0].fn();
    await notice.settled();
    rows = [];
    ownerQueued();
    await notice.settled();
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("times a run with no startedAt from the moment the message was queued", async () => {
    rows = [topicRow({ startedAt: undefined })];
    ownerQueued();
    await notice.settled();
    expect(timers[0].ms).toBe(60_000);
    clock += 60_000;
    timers[0].fn();
    await notice.settled();
    expect(sendTelegram).toHaveBeenCalledTimes(1);
  });

  it("answers an owner's DM without a thread id, and uses the chat wording", async () => {
    rows = [
      {
        key: kDmKey,
        sessionId: "sess-dm",
        hasActiveRun: true,
        activeRunIds: ["cron-run-1"],
        startedAt: clock - 120_000,
        deliveryContext: { channel: "telegram", to: "telegram:111222333", accountId: "default" },
      },
    ];
    ownerQueued({ sessionId: "sess-dm" }, kDmKey);
    await notice.settled();
    expect(sendTelegram).toHaveBeenCalledWith({ accountId: "default", chatId: "111222333", threadId: "", text: kNoticeText });
  });

  it("posts to a forum's General topic without a thread id, which Telegram refuses for id 1", async () => {
    rows = [topicRow({ deliveryContext: { channel: "telegram", to: kGroup, threadId: 1 } })];
    ownerQueued();
    await notice.settled();
    expect(sendTelegram).toHaveBeenCalledWith(expect.objectContaining({ chatId: kGroup, threadId: "" }));
  });

  it("reads the json console style, the shape the box's log file shows", async () => {
    const json =
      '{"0":"{\\"subsystem\\":\\"diagnostic\\"}","1":{"reason":"unknown-source-with-terminal-history","disposition":"followup-queued","channel":"telegram","sessionId":"sess-topic","runId":"R1"},"2":"steering rejected; applying follow-up policy","_meta":{"logLevelName":"WARN"}}\n';
    notice.observeGatewayOutput(ownerLine() + json);
    await notice.settled();
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(insertEvent.mock.calls[0][0].details.reason).toBe("unknown-source-with-terminal-history");
  });

  it("ignores other channels, other dispositions and lines with no session", async () => {
    notice.observeGatewayOutput(ownerLine());
    notice.observeGatewayOutput(queuedLine({ channel: "discord" }));
    notice.observeGatewayOutput(queuedLine({ disposition: "followup-not-enqueued" }));
    notice.observeGatewayOutput(queuedLine({ disposition: "skipped-queue-cap" }));
    notice.observeGatewayOutput("[diagnostic] steering rejected; applying follow-up policy reason=x disposition=followup-queued channel=telegram\n");
    await notice.settled();
    expect(listSessions).not.toHaveBeenCalled();
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("also acts on the steer-adoption fallback (disposition=followup-policy) and on lines split across chunks", async () => {
    const text = ownerLine() + queuedLine({ disposition: "followup-policy", reason: "reply-owner-ended" });
    notice.observeGatewayOutput(text.slice(0, 50));
    notice.observeGatewayOutput(text.slice(50, 200));
    notice.observeGatewayOutput(text.slice(200));
    await notice.settled();
    expect(sendTelegram).toHaveBeenCalledTimes(1);
  });

  it("keeps working when a send fails or the gateway read fails", async () => {
    sendTelegram.mockRejectedValueOnce(new Error("Bad Request: message thread not found"));
    ownerQueued();
    await notice.settled();
    expect(insertEvent).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    listSessions.mockRejectedValueOnce(new Error("gateway call timed out"));
    ownerQueued({ sessionId: "other" });
    await notice.settled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("check failed: gateway call timed out"));
  });

  it("reads the chat and topic from deliveryContext, the last route, or the session key", () => {
    expect(parseTelegramChat("telegram:-100555:topic:42")).toEqual({ chatId: "-100555", threadId: "42" });
    expect(parseTelegramChat("telegram:group:-100555", 7)).toEqual({ chatId: "-100555", threadId: "7" });
    expect(parseTelegramChat("@somebody")).toBeNull();
    expect(resolveTelegramTarget({ lastChannel: "telegram", lastTo: "-100555", lastThreadId: "9", lastAccountId: "ops" })).toEqual({ chatId: "-100555", threadId: "9", accountId: "ops" });
    expect(resolveTelegramTarget({ key: "agent:main:telegram:group:-100555:topic:12" })).toEqual({ chatId: "-100555", threadId: "12", accountId: "" });
    expect(resolveTelegramTarget({ key: "agent:main:discord:channel:1" })).toBeNull();
  });
});
