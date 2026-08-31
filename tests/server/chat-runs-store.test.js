const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  initChatRunsDb,
  closeChatRunsDb,
  recordSend,
  markRunning,
  markStopRequested,
  markTerminal,
  findRecentTerminal,
  listMarkers,
  pruneChatRuns,
} = require("../../lib/server/db/chat-runs");
const { buildHistoryMessages, toMarkers } = require("../../lib/server/chat/history");

describe("server/db/chat-runs", () => {
  let rootDir;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-chat-runs-"));
    initChatRunsDb({ rootDir, markInterruptedRuns: false });
  });

  afterEach(() => {
    closeChatRunsDb();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("round-trips a send through running to a terminal row", () => {
    recordSend({ sessionKey: "s1", clientMsgId: "cm1", messageId: "m1" });
    markRunning({ sessionKey: "s1", clientMsgId: "cm1", runId: "r1" });
    markStopRequested({ sessionKey: "s1", clientMsgId: "cm1" });
    markTerminal({
      sessionKey: "s1",
      clientMsgId: "cm1",
      status: "stopped",
      confidence: "confirmed",
      stopConfirmed: 1,
      lastSeq: 9,
    });
    const row = findRecentTerminal({
      sessionKey: "s1",
      clientMsgId: "cm1",
      windowMs: 60_000,
      now: Date.now(),
    });
    expect(row).toMatchObject({
      sessionKey: "s1",
      clientMsgId: "cm1",
      runId: "r1",
      messageId: "m1",
      status: "stopped",
      confidence: "confirmed",
      stopConfirmed: 1,
      lastSeq: 9,
    });
    expect(row.endedAtMs).toBeGreaterThan(0);
  });

  it("dedupe lookups bind the session: the same clientMsgId in two sessions is two rows", () => {
    recordSend({ sessionKey: "s-a", clientMsgId: "shared", messageId: "m-a" });
    recordSend({ sessionKey: "s-b", clientMsgId: "shared", messageId: "m-b" });
    markTerminal({ sessionKey: "s-a", clientMsgId: "shared", status: "done" });
    expect(
      findRecentTerminal({
        sessionKey: "s-a",
        clientMsgId: "shared",
        windowMs: 60_000,
        now: Date.now(),
      }),
    ).toMatchObject({ messageId: "m-a", status: "done" });
    // Session B's row is untouched — never replay another session's outcome.
    expect(
      findRecentTerminal({
        sessionKey: "s-b",
        clientMsgId: "shared",
        windowMs: 60_000,
        now: Date.now(),
      }),
    ).toBeNull();
  });

  it("findRecentTerminal respects the dedupe window", () => {
    recordSend({ sessionKey: "s1", clientMsgId: "cm1", messageId: "m1" });
    markTerminal({ sessionKey: "s1", clientMsgId: "cm1", status: "done" });
    const nowMs = Date.now();
    expect(
      findRecentTerminal({ sessionKey: "s1", clientMsgId: "cm1", windowMs: 60_000, now: nowMs }),
    ).not.toBeNull();
    // Pretend the lookup happens 10 minutes later than the row's end.
    expect(
      findRecentTerminal({
        sessionKey: "s1",
        clientMsgId: "cm1",
        windowMs: 60_000,
        now: nowMs + 10 * 60 * 1000,
      }),
    ).toBeNull();
  });

  it("a retry of an old terminal row upserts back to a fresh pending attempt", () => {
    recordSend({ sessionKey: "s1", clientMsgId: "cm1", messageId: "m1" });
    markRunning({ sessionKey: "s1", clientMsgId: "cm1", runId: "r1" });
    markTerminal({
      sessionKey: "s1",
      clientMsgId: "cm1",
      status: "error",
      errorCode: "gateway_unavailable",
      error: "nope",
    });
    // Fresh attempt of the same logical message: one row per (session, id).
    recordSend({ sessionKey: "s1", clientMsgId: "cm1", messageId: "m2" });
    expect(
      findRecentTerminal({ sessionKey: "s1", clientMsgId: "cm1", windowMs: 60_000, now: Date.now() }),
    ).toBeNull();
    expect(listMarkers("s1")).toEqual([]);
  });

  it("boot reconciliation resolves dangling rows honestly: pending → unknown, running → interrupted", () => {
    recordSend({ sessionKey: "s1", clientMsgId: "cm-pending", messageId: "m1" });
    recordSend({ sessionKey: "s1", clientMsgId: "cm-running", messageId: "m2" });
    markRunning({ sessionKey: "s1", clientMsgId: "cm-running", runId: "r2" });
    recordSend({ sessionKey: "s1", clientMsgId: "cm-done", messageId: "m3" });
    markTerminal({ sessionKey: "s1", clientMsgId: "cm-done", status: "done" });

    initChatRunsDb({ rootDir }); // markInterruptedRuns defaults on

    const markers = listMarkers("s1");
    expect(markers.map((m) => [m.clientMsgId, m.status, m.confidence])).toEqual([
      ["cm-pending", "unknown", "unconfirmed"],
      ["cm-running", "interrupted", "unconfirmed"],
    ]);
    // The pending row is ambiguous — its copy must say so.
    expect(markers[0].error).toMatch(/check the transcript/i);
  });

  it("lists only non-clean terminals as markers, oldest first", () => {
    for (const [id, status] of [
      ["a", "done"],
      ["b", "stopped"],
      ["c", "interrupted"],
      ["d", "error"],
      ["e", "unknown"],
    ]) {
      recordSend({ sessionKey: "s1", clientMsgId: id, messageId: `m-${id}` });
      markTerminal({ sessionKey: "s1", clientMsgId: id, status });
    }
    recordSend({ sessionKey: "s1", clientMsgId: "live", messageId: "m-live" });
    const markers = listMarkers("s1");
    expect(markers.map((m) => m.clientMsgId)).toEqual(["b", "c", "d", "e"]);
    expect(listMarkers("other")).toEqual([]);
  });

  it("maps store rows into wire markers", () => {
    recordSend({ sessionKey: "s1", clientMsgId: "cm1", messageId: "m1" });
    markRunning({ sessionKey: "s1", clientMsgId: "cm1", runId: "r1" });
    markTerminal({
      sessionKey: "s1",
      clientMsgId: "cm1",
      status: "stopped",
      confidence: "confirmed",
      stopConfirmed: 1,
      error: "You stopped this response",
    });
    const markers = toMarkers(listMarkers("s1"));
    expect(markers).toEqual([
      {
        kind: "stopped",
        runId: "r1",
        clientMsgId: "cm1",
        at: expect.any(Number),
        detail: "You stopped this response",
        confidence: "confirmed",
        stopConfirmed: true,
      },
    ]);
    expect(markers[0].at).toBeGreaterThan(0);
  });

  it("prunes per-session beyond the keep cap", () => {
    for (let index = 0; index < 210; index += 1) {
      recordSend({ sessionKey: "big", clientMsgId: `cm-${index}`, messageId: `m-${index}` });
      markTerminal({ sessionKey: "big", clientMsgId: `cm-${index}`, status: "stopped" });
    }
    recordSend({ sessionKey: "small", clientMsgId: "cm-s", messageId: "m-s" });
    markTerminal({ sessionKey: "small", clientMsgId: "cm-s", status: "stopped" });
    pruneChatRuns();
    // Oldest rows beyond 200 are gone; the newest survive; other sessions untouched.
    expect(
      findRecentTerminal({ sessionKey: "big", clientMsgId: "cm-0", windowMs: 86_400_000, now: Date.now() }),
    ).toBeNull();
    expect(
      findRecentTerminal({ sessionKey: "big", clientMsgId: "cm-209", windowMs: 86_400_000, now: Date.now() }),
    ).not.toBeNull();
    expect(listMarkers("small")).toHaveLength(1);
  });

  it("caps total rows globally — unique session keys can't grow the db forever", () => {
    // The per-session cap is useless against a client minting UNIQUE session
    // keys (1 row each): without the global ceiling an authenticated socket
    // grows chat-runs.db until disk exhaustion. Runtime pruning fires from
    // recordSend itself (every 500 inserts), so a long-lived server stays
    // bounded without waiting for a reboot.
    for (let index = 0; index < 5600; index += 1) {
      recordSend({
        sessionKey: `flood-${index}`,
        clientMsgId: "cm",
        messageId: `m-${index}`,
      });
    }
    pruneChatRuns();
    // markTerminal on a pruned row updates nothing — the oldest rows are
    // provably gone while the newest survive.
    markTerminal({ sessionKey: "flood-0", clientMsgId: "cm", status: "stopped" });
    markTerminal({ sessionKey: "flood-5599", clientMsgId: "cm", status: "stopped" });
    expect(listMarkers("flood-0")).toHaveLength(0);
    expect(listMarkers("flood-5599")).toHaveLength(1);
  });

  it("caps stored error text at 500 characters", () => {
    recordSend({ sessionKey: "s1", clientMsgId: "cm1", messageId: "m1" });
    markTerminal({
      sessionKey: "s1",
      clientMsgId: "cm1",
      status: "error",
      error: "e".repeat(2000),
    });
    const row = findRecentTerminal({
      sessionKey: "s1",
      clientMsgId: "cm1",
      windowMs: 60_000,
      now: Date.now(),
    });
    expect(row.error).toHaveLength(500);
  });
});

describe("chat/history stable ids + truncation", () => {
  const row = (overrides = {}) => ({
    role: "assistant",
    content: "same text",
    timestamp: 1700000000000,
    ...overrides,
  });

  it("mints identical ids across two normalizations of the same history", () => {
    const history = {
      messages: [
        row({ role: "user", content: "hi", timestamp: 1 }),
        row({ timestamp: 2 }),
        row({ timestamp: 2 }), // identical duplicate — occurrence counter splits them
      ],
    };
    const first = buildHistoryMessages({ history, sessionKey: "s", limit: 200 });
    const second = buildHistoryMessages({ history, sessionKey: "s", limit: 200 });
    expect(first.messages.map((m) => m.id)).toEqual(second.messages.map((m) => m.id));
    const ids = new Set(first.messages.map((m) => m.id));
    expect(ids.size).toBe(first.messages.length);
    expect(first.truncated).toBe(false);
  });

  it("keeps ids stable when the window slides (no absolute row index)", () => {
    const rows = Array.from({ length: 6 }, (_, index) =>
      row({ content: `msg-${index}`, timestamp: 1000 + index }),
    );
    const full = buildHistoryMessages({
      history: { messages: rows },
      sessionKey: "s",
      limit: 10,
    });
    const slid = buildHistoryMessages({
      history: { messages: rows.slice(2) },
      sessionKey: "s",
      limit: 10,
    });
    // The four surviving rows keep the exact ids they had before the slide.
    expect(slid.messages.map((m) => m.id)).toEqual(
      full.messages.slice(2).map((m) => m.id),
    );
  });

  it("prefers a native row id when the gateway provides one, disambiguated per rendered row", () => {
    const built = buildHistoryMessages({
      history: { messages: [row({ id: "native-7" })] },
      sessionKey: "s",
      limit: 10,
    });
    // Role (and toolCallId/occurrence when present) suffix the native id: one
    // gateway message splits into a text row plus one row per tool call, and
    // the bare native id would mint DUPLICATE keys across those rows.
    expect(built.messages[0].id).toBe("h:native-7:assistant");
  });

  it("a native-id message split across text and tool rows never duplicates ids", () => {
    const built = buildHistoryMessages({
      history: {
        messages: [
          {
            id: "native-9",
            role: "assistant",
            timestamp: 1000,
            content: [
              { type: "text", text: "running a tool" },
              { type: "toolCall", id: "tc-1", name: "exec", arguments: {} },
              { type: "toolCall", id: "tc-2", name: "exec", arguments: {} },
            ],
          },
        ],
      },
      sessionKey: "s",
      limit: 10,
    });
    const ids = built.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reports truncation only when a row beyond the limit proves older history", () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      row({ content: `m${index}`, timestamp: 1000 + index }),
    );
    const exact = buildHistoryMessages({
      history: { messages: rows },
      sessionKey: "s",
      limit: 5,
    });
    expect(exact.truncated).toBe(false);
    expect(exact.messages).toHaveLength(5);
    const over = buildHistoryMessages({
      history: { messages: rows },
      sessionKey: "s",
      limit: 4,
    });
    expect(over.truncated).toBe(true);
    // The OLDEST overflow row is trimmed; the newest `limit` rows survive.
    expect(over.messages.map((m) => m.content)).toEqual(["m1", "m2", "m3", "m4"]);
  });
});
