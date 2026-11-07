const {
  parseTelegramSessionKey,
  isTelegramTopicSessionKey,
  parseSessionDeliveryRoute,
  getReplyTargetFromSessionKey,
  classifySessionKey,
  parseRelaySessionKey,
  isReadOnlySessionKind,
} = require("../../lib/server/utils/session-keys");

// Kind from the key alone (the fallback when no session-list row is known).
const kKindMatrix = [
  ["agent:main:main", "direct"],
  ["main", "direct"],
  ["agent:main:chat-1a2b3c4d", "direct"],
  ["agent:main:relay-capy-audit-c", "relay"],
  ["agent:ops:relay-Wintermute.v2", "relay"],
  ["agent:main:telegram:direct:7000210001", "telegram-dm"],
  ["agent:main:telegram:default:direct:1050", "telegram-dm"],
  ["agent:main:telegram:group:-1001234567890", "telegram-group"],
  ["agent:main:telegram:group:-1009876543210:topic:42", "telegram-topic"],
  ["agent:main:telegram:group:-1009876543210:topic:42:heartbeat", "telegram-topic"],
  ["agent:main:cron:nightly-sync", "cron"],
  ["agent:main:discord:channel:123", "other"],
  ["agent:main:subagent:abc", "other"],
  ["", "other"],
];

// Full matrix from the plan: direct, group root, group+topic, suffixed
// variants (openclaw emits `…:heartbeat` keys), account-scoped directs
// (`…:telegram:default:direct:1050`), malformed, non-telegram.
// Each entry is [sessionKey, expected].
const kMatrix = [
  [
    "agent:main:telegram:direct:123",
    {
      agentId: "main",
      channel: "telegram",
      scope: "direct",
      groupId: "",
      threadId: null,
      peerId: "123",
      accountId: null,
    },
  ],
  [
    "agent:main:telegram:direct",
    {
      agentId: "main",
      channel: "telegram",
      scope: "direct",
      groupId: "",
      threadId: null,
      peerId: null,
      accountId: null,
    },
  ],
  [
    "agent:main:telegram:direct:123:heartbeat",
    {
      agentId: "main",
      channel: "telegram",
      scope: "direct",
      groupId: "",
      threadId: null,
      peerId: "123",
      accountId: null,
    },
  ],
  // Account-scoped direct (per-account-channel-peer dmScope): segment 4 is
  // the accountId only when segment 5 is direct/dm.
  [
    "agent:main:telegram:default:direct:1050",
    {
      agentId: "main",
      channel: "telegram",
      scope: "direct",
      groupId: "",
      threadId: null,
      peerId: "1050",
      accountId: "default",
    },
  ],
  [
    "agent:main:telegram:work:direct:1050:heartbeat",
    {
      agentId: "main",
      channel: "telegram",
      scope: "direct",
      groupId: "",
      threadId: null,
      peerId: "1050",
      accountId: "work",
    },
  ],
  [
    "agent:main:telegram:group:-1001234567890",
    {
      agentId: "main",
      channel: "telegram",
      scope: "group",
      groupId: "-1001234567890",
      threadId: null,
      peerId: null,
      accountId: null,
    },
  ],
  [
    "agent:main:telegram:group:-1001234567890:topic:42",
    {
      agentId: "main",
      channel: "telegram",
      scope: "group",
      groupId: "-1001234567890",
      threadId: "42",
      peerId: null,
      accountId: null,
    },
  ],
  // Suffix-tolerant matching: `(?::|$)`, never `$`.
  [
    "agent:main:telegram:group:-1001234567890:topic:42:heartbeat",
    {
      agentId: "main",
      channel: "telegram",
      scope: "group",
      groupId: "-1001234567890",
      threadId: "42",
      peerId: null,
      accountId: null,
    },
  ],
  [
    "agent:scout:telegram:group:-123:heartbeat",
    {
      agentId: "scout",
      channel: "telegram",
      scope: "group",
      groupId: "-123",
      threadId: null,
      peerId: null,
      accountId: null,
    },
  ],
  // Malformed keys.
  ["agent:x:telegram:group", null],
  ["agent:x:telegram:group:topic:5", null],
  ["", null],
  ["   ", null],
  // Non-telegram keys.
  ["agent:main:discord:group:-123:topic:42", null],
  ["agent:main:slack:direct:U123", null],
  ["main", null],
  ["agent:main:cron:system-sync", null],
];

// Delivery-route matrix: [sessionKey, expectedRoute, expectedReplyTarget].
// Locks the generic grammar AND the per-channel replyTo formats (discord/
// slack DMs REQUIRE `user:<id>` — bare ids resolve as channel ids upstream).
const kDeliveryMatrix = [
  [
    "agent:main:telegram:direct:1050",
    { agentId: "main", channel: "telegram", scope: "direct", accountId: null, peerId: "1050", groupId: "", threadId: null },
    { replyChannel: "telegram", replyTo: "1050", replyAccountId: "" },
  ],
  [
    "agent:main:telegram:direct:1050:heartbeat",
    { agentId: "main", channel: "telegram", scope: "direct", accountId: null, peerId: "1050", groupId: "", threadId: null },
    { replyChannel: "telegram", replyTo: "1050", replyAccountId: "" },
  ],
  [
    "agent:main:telegram:default:direct:1050",
    { agentId: "main", channel: "telegram", scope: "direct", accountId: "default", peerId: "1050", groupId: "", threadId: null },
    { replyChannel: "telegram", replyTo: "1050", replyAccountId: "default" },
  ],
  [
    "agent:main:telegram:dm:1050",
    { agentId: "main", channel: "telegram", scope: "direct", accountId: null, peerId: "1050", groupId: "", threadId: null },
    { replyChannel: "telegram", replyTo: "1050", replyAccountId: "" },
  ],
  // Bare group (no topic): replyTo is the bare group id.
  [
    "agent:main:telegram:group:-100555",
    { agentId: "main", channel: "telegram", scope: "group", accountId: null, peerId: null, groupId: "-100555", threadId: null },
    { replyChannel: "telegram", replyTo: "-100555", replyAccountId: "" },
  ],
  [
    "agent:main:telegram:group:-100555:topic:7:heartbeat",
    { agentId: "main", channel: "telegram", scope: "group", accountId: null, peerId: null, groupId: "-100555", threadId: "7" },
    { replyChannel: "telegram", replyTo: "-100555:7", replyAccountId: "" },
  ],
  // Discord/Slack DMs must be `user:<id>` targets.
  [
    "agent:main:discord:direct:99",
    { agentId: "main", channel: "discord", scope: "direct", accountId: null, peerId: "99", groupId: "", threadId: null },
    { replyChannel: "discord", replyTo: "user:99", replyAccountId: "" },
  ],
  [
    "agent:main:slack:direct:U02R12345",
    { agentId: "main", channel: "slack", scope: "direct", accountId: null, peerId: "U02R12345", groupId: "", threadId: null },
    { replyChannel: "slack", replyTo: "user:U02R12345", replyAccountId: "" },
  ],
  [
    "agent:main:discord:channel:123456",
    { agentId: "main", channel: "discord", scope: "channel", accountId: null, peerId: "123456", groupId: "", threadId: null },
    { replyChannel: "discord", replyTo: "channel:123456", replyAccountId: "" },
  ],
  [
    "agent:main:slack:group:C0999",
    { agentId: "main", channel: "slack", scope: "group", accountId: null, peerId: null, groupId: "C0999", threadId: null },
    { replyChannel: "slack", replyTo: "channel:C0999", replyAccountId: "" },
  ],
  [
    "agent:main:whatsapp:direct:123@g.us",
    { agentId: "main", channel: "whatsapp", scope: "direct", accountId: null, peerId: "123@g.us", groupId: "", threadId: null },
    { replyChannel: "whatsapp", replyTo: "123@g.us", replyAccountId: "" },
  ],
  // Unknown/plugin channels parse (labels, icons) but never claim a
  // deliverable target — only verified formats do.
  [
    "agent:main:clickclack:direct:77",
    { agentId: "main", channel: "clickclack", scope: "direct", accountId: null, peerId: "77", groupId: "", threadId: null },
    { replyChannel: "", replyTo: "", replyAccountId: "" },
  ],
  // Reserved kinds and channel-less keys carry no delivery route.
  ["agent:main:main", null, { replyChannel: "", replyTo: "", replyAccountId: "" }],
  ["agent:main:doctor:42", null, { replyChannel: "", replyTo: "", replyAccountId: "" }],
  ["agent:main:cron:system-sync", null, { replyChannel: "", replyTo: "", replyAccountId: "" }],
  ["agent:main:hook:x", null, { replyChannel: "", replyTo: "", replyAccountId: "" }],
  ["agent:main:subagent:abc", null, { replyChannel: "", replyTo: "", replyAccountId: "" }],
  ["agent:main:direct:77", null, { replyChannel: "", replyTo: "", replyAccountId: "" }],
  ["agent:main:telegram:direct", null, { replyChannel: "", replyTo: "", replyAccountId: "" }],
  // No account-scoped groups (mirrors openclaw's grammar).
  ["agent:main:telegram:default:group:-1", null, { replyChannel: "", replyTo: "", replyAccountId: "" }],
  ["main", null, { replyChannel: "", replyTo: "", replyAccountId: "" }],
  ["", null, { replyChannel: "", replyTo: "", replyAccountId: "" }],
];

describe("server/utils/session-keys", () => {
  it.each(kMatrix)("parses %j", (sessionKey, expected) => {
    expect(parseTelegramSessionKey(sessionKey)).toEqual(expected);
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(
      parseTelegramSessionKey("  agent:main:telegram:group:-1:topic:2  "),
    ).toEqual({
      agentId: "main",
      channel: "telegram",
      scope: "group",
      groupId: "-1",
      threadId: "2",
      peerId: null,
      accountId: null,
    });
  });

  it("tolerates non-string input", () => {
    expect(parseTelegramSessionKey(null)).toBeNull();
    expect(parseTelegramSessionKey(undefined)).toBeNull();
    expect(parseTelegramSessionKey(42)).toBeNull();
  });

  it("identifies topic session keys, including suffixed ones", () => {
    expect(
      isTelegramTopicSessionKey("agent:main:telegram:group:-1:topic:2"),
    ).toBe(true);
    expect(
      isTelegramTopicSessionKey("agent:main:telegram:group:-1:topic:2:heartbeat"),
    ).toBe(true);
    expect(isTelegramTopicSessionKey("agent:main:telegram:group:-1")).toBe(false);
    expect(isTelegramTopicSessionKey("agent:main:telegram:direct:9")).toBe(false);
    expect(isTelegramTopicSessionKey("agent:main:cron:sync")).toBe(false);
  });

  it.each(kDeliveryMatrix)("derives delivery route for %j", (sessionKey, expectedRoute) => {
    expect(parseSessionDeliveryRoute(sessionKey)).toEqual(
      expectedRoute ? expect.objectContaining(expectedRoute) : null,
    );
  });

  it.each(kDeliveryMatrix)(
    "derives reply target for %j",
    (sessionKey, _route, expectedTarget) => {
      expect(getReplyTargetFromSessionKey(sessionKey)).toEqual(expectedTarget);
    },
  );

  it("classifies session kinds from the key", () => {
    for (const [sessionKey, kind] of kKindMatrix) {
      expect([sessionKey, classifySessionKey(sessionKey)]).toEqual([sessionKey, kind]);
    }
    expect(parseRelaySessionKey("agent:main:relay-capy-x")).toEqual({ agentId: "main", peer: "capy-x" });
    expect(parseRelaySessionKey("agent:main:relay-")).toBeNull();
    expect(isReadOnlySessionKind("relay")).toBe(true);
    expect(isReadOnlySessionKind("telegram-topic")).toBe(true);
    expect(isReadOnlySessionKind("direct")).toBe(false);
  });

  describe("client mirror parity (lib/public/js/lib/session-keys.js)", () => {
    it("classifies kinds identically", async () => {
      const clientModule = await import("../../lib/public/js/lib/session-keys.js");
      for (const [sessionKey] of kKindMatrix) {
        expect(clientModule.classifySessionKey(sessionKey)).toEqual(classifySessionKey(sessionKey));
        expect(clientModule.parseRelaySessionKey(sessionKey)).toEqual(parseRelaySessionKey(sessionKey));
      }
    });

    it("produces identical output for the whole matrix", async () => {
      const clientModule = await import(
        "../../lib/public/js/lib/session-keys.js"
      );
      for (const [sessionKey, expected] of kMatrix) {
        const serverResult = parseTelegramSessionKey(sessionKey);
        const clientResult = clientModule.parseTelegramSessionKey(sessionKey);
        expect(clientResult).toEqual(serverResult);
        expect(clientResult).toEqual(expected);
      }
    });

    it("produces identical delivery routes and reply targets for the whole matrix", async () => {
      const clientModule = await import(
        "../../lib/public/js/lib/session-keys.js"
      );
      for (const [sessionKey, expectedRoute, expectedTarget] of kDeliveryMatrix) {
        expect(clientModule.parseSessionDeliveryRoute(sessionKey)).toEqual(
          parseSessionDeliveryRoute(sessionKey),
        );
        expect(clientModule.parseSessionDeliveryRoute(sessionKey)).toEqual(
          expectedRoute ? expect.objectContaining(expectedRoute) : null,
        );
        const serverTarget = getReplyTargetFromSessionKey(sessionKey);
        expect(clientModule.getReplyTargetFromSessionKey(sessionKey)).toEqual(serverTarget);
        expect(serverTarget).toEqual(expectedTarget);
      }
    });
  });
});
