const {
  parseTelegramSessionKey,
  isTelegramTopicSessionKey,
} = require("../../lib/server/utils/session-keys");

// Full matrix from the plan: direct, group root, group+topic, suffixed
// variants (openclaw emits `…:heartbeat` keys), malformed, non-telegram.
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

  describe("client mirror parity (lib/public/js/lib/session-keys.js)", () => {
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
  });
});
