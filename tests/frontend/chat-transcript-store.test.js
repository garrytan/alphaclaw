import { describe, expect, it, vi } from "vitest";
import {
  applyChunk,
  applyTool,
  composeVisibleMessages,
  markerCopy,
  mergeHistory,
} from "../../lib/public/js/components/chat/transcript-store.js";

// Deterministic uuid for applyTool (its default is crypto.randomUUID).
const makeUuid = () => {
  let n = 0;
  return () => {
    n += 1;
    return `uuid-${n}`;
  };
};

const historyRow = (id, role, content, timestamp) => ({ id, role, content, timestamp });

describe("frontend/chat transcript-store mergeHistory", () => {
  it("merge reuses object identity for unchanged rows", () => {
    const rows = [
      historyRow("h1", "user", "hi", 100),
      historyRow("h2", "assistant", "hello!", 200),
    ];
    const first = mergeHistory({ current: [], rows });
    const second = mergeHistory({ current: first, rows });
    // Identical rows keep their exact object references (no list remount).
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);

    // A row whose content changed gets a fresh object; the untouched one
    // keeps its identity.
    const third = mergeHistory({
      current: second,
      rows: [rows[0], historyRow("h2", "assistant", "hello! (edited)", 200)],
    });
    expect(third[0]).toBe(first[0]);
    expect(third[1]).not.toBe(first[1]);
    expect(third[1].content).toBe("hello! (edited)");
  });

  it("merge never drops the active run's live rows", () => {
    const uuid = makeUuid();
    let current = applyChunk({
      messages: [],
      messageId: "m1",
      content: "streaming…",
      runId: "r1",
      now: 1_000,
    });
    current = applyTool({
      messages: current,
      payload: {
        phase: "call",
        toolCall: { id: "t1", name: "exec" },
        timestamp: 1_001,
      },
      runId: "r1",
      uuid,
    });

    // History refetch mid-run returns nothing yet: both live rows survive.
    const merged = mergeHistory({ current, rows: [], activeMessageId: "m1" });
    expect(merged).toHaveLength(2);
    expect(merged).toContain(current[0]);
    expect(merged).toContain(current[1]);
    expect(merged.find((m) => m.role === "assistant").content).toBe("streaming…");
    expect(merged.find((m) => m.role === "tool").live).toBe(true);
  });

  it("a finished run's live text survives until history covers it", () => {
    const live = applyChunk({
      messages: [],
      messageId: "m2",
      content: "final answer",
      runId: "r2",
      now: 2_000,
    });

    // Run finished (activeMessageId "") but history does not carry the text
    // yet: the live row is retained — never blank shown text.
    const uncovered = mergeHistory({
      current: live,
      rows: [historyRow("h8", "assistant", "an older reply", 50)],
      activeMessageId: "",
    });
    expect(uncovered).toHaveLength(2);
    expect(uncovered).toContain(live[0]);

    // Once history contains the same content, the live row yields to it.
    const covered = mergeHistory({
      current: uncovered,
      rows: [
        historyRow("h8", "assistant", "an older reply", 50),
        historyRow("h9", "assistant", "final answer", 2_100),
      ],
      activeMessageId: "",
    });
    expect(covered).toHaveLength(2);
    expect(covered.map((m) => m.id)).toEqual(["h8", "h9"]);
    expect(covered.some((m) => m.live)).toBe(false);
  });

  it("confirmation is bounded and one-shot", () => {
    const onConfirmed = vi.fn();
    const itemA = {
      clientMsgId: "A",
      content: "same text",
      createdAt: 1_000_000,
      ackedAt: 1_000_500,
    };
    const itemB = {
      clientMsgId: "B",
      content: "same text",
      createdAt: 1_000_200,
      ackedAt: 1_000_700,
    };
    // ONE history user row inside both windows: only the OLDEST item (A)
    // consumes it — identical texts can't cross-confirm.
    mergeHistory({
      current: [],
      rows: [historyRow("u1", "user", "same text", 1_000_400)],
      outboxItems: [itemA, itemB],
      onConfirmed,
    });
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(onConfirmed).toHaveBeenCalledWith("A");

    // A row outside the window (2 minutes BEFORE createdAt) confirms nothing.
    const onConfirmedLate = vi.fn();
    mergeHistory({
      current: [],
      rows: [historyRow("u2", "user", "drifted", 1_000_000 - 120_000)],
      outboxItems: [
        { clientMsgId: "C", content: "drifted", createdAt: 1_000_000, ackedAt: 1_000_000 },
      ],
      onConfirmed: onConfirmedLate,
    });
    expect(onConfirmedLate).not.toHaveBeenCalled();
  });

  it("markers interleave by timestamp with stable ids", () => {
    const rows = [
      historyRow("h1", "user", "one", 100),
      historyRow("h2", "assistant", "two", 200),
      historyRow("h3", "assistant", "three", 300),
    ];
    const markers = [
      { at: 150, kind: "stopped", clientMsgId: "cmA" },
      { at: 999, kind: "interrupted", runId: "r9" },
    ];
    const merged = mergeHistory({ current: [], rows, markers });
    expect(merged.map((m) => m.id)).toEqual([
      "h1",
      "marker:cmA:stopped",
      "h2",
      "h3",
      "marker:r9:interrupted",
    ]);
    expect(merged[1].role).toBe("system");
    expect(merged[1].content).toBe("You stopped this response");

    // Re-merge: markers keep the SAME object identity via previousById.
    const remerged = mergeHistory({ current: merged, rows, markers });
    expect(remerged[1]).toBe(merged[1]);
    expect(remerged[4]).toBe(merged[4]);
  });

  it("composeVisibleMessages appends unconfirmed outbox items in creation order", () => {
    const messages = [historyRow("h1", "assistant", "welcome", 50)];
    const outboxItems = [
      // Deliberately out of order: compose must sort by createdAt.
      { clientMsgId: "b", content: "second", createdAt: 200, status: "queued" },
      { clientMsgId: "a", content: "first", createdAt: 100, status: "failed" },
    ];
    const visible = composeVisibleMessages({ messages, outboxItems });
    expect(visible.map((m) => m.id)).toEqual(["h1", "c:a", "c:b"]);
    expect(visible[1]).toMatchObject({
      role: "user",
      content: "first",
      pendingState: "failed",
      clientMsgId: "a",
    });
    expect(visible[2].pendingState).toBe("queued");

    // No outbox items: the exact same array comes back (no remount).
    expect(composeVisibleMessages({ messages, outboxItems: [] })).toBe(messages);
  });
});

describe("frontend/chat transcript-store streaming + tools", () => {
  it("chunk → tool → chunk yields ONE assistant bubble plus one tool card", () => {
    const uuid = makeUuid();
    let messages = applyChunk({
      messages: [],
      messageId: "m1",
      content: "Hello ",
      runId: "r1",
      now: 1,
    });
    messages = applyTool({
      messages,
      payload: { phase: "call", toolCall: { id: "t1", name: "exec" }, timestamp: 2 },
      runId: "r1",
      uuid,
    });
    messages = applyChunk({
      messages,
      messageId: "m1",
      content: "world",
      runId: "r1",
      now: 3,
    });

    // One bubble, appended in place — the tool card must not split it.
    expect(messages).toHaveLength(2);
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toBe("Hello world");
    expect(messages[1].role).toBe("tool");

    // A chunk for a NEW messageId starts a new bubble.
    const withNext = applyChunk({
      messages,
      messageId: "m2",
      content: "Next turn",
      runId: "r1",
      now: 4,
    });
    expect(withNext).toHaveLength(3);
    expect(withNext[2].id).toBe("live:m2");
    expect(withNext[2].content).toBe("Next turn");
  });

  it("id-less tool calls are never name-deduped (twin: same toolCallId IS deduped)", () => {
    const uuid = makeUuid();
    const idlessCall = { phase: "call", toolCall: { name: "exec" }, timestamp: 10 };
    let idless = applyTool({ messages: [], payload: idlessCall, runId: "r1", uuid });
    idless = applyTool({ messages: idless, payload: idlessCall, runId: "r1", uuid });
    // Two real calls, two cards.
    expect(idless).toHaveLength(2);
    expect(idless[0].id).not.toBe(idless[1].id);

    const idCall = { phase: "call", toolCall: { id: "t1", name: "exec" }, timestamp: 10 };
    let withId = applyTool({ messages: [], payload: idCall, runId: "r1", uuid });
    withId = applyTool({ messages: withId, payload: idCall, runId: "r1", uuid });
    // Same toolCallId: replayed event, one card.
    expect(withId).toHaveLength(1);
  });

  it("id-less results attach to the newest unresolved same-name call", () => {
    const uuid = makeUuid();
    const idlessCall = { phase: "call", toolCall: { name: "exec" }, timestamp: 10 };
    let messages = applyTool({ messages: [], payload: idlessCall, runId: "r1", uuid });
    messages = applyTool({ messages, payload: idlessCall, runId: "r1", uuid });

    const idlessResult = {
      phase: "result",
      toolResult: {
        toolName: "exec",
        rawMessage: { toolName: "exec", content: [{ type: "text", text: "ran" }] },
      },
      timestamp: 11,
    };
    const afterFirst = applyTool({ messages, payload: idlessResult, runId: "r1", uuid });
    expect(afterFirst).toHaveLength(2);
    // Attached to the SECOND (newest) card only.
    expect(afterFirst[1].debugPayload.toolResult).toBeTruthy();
    expect(afterFirst[0].debugPayload.toolResult).toBeNull();
    expect(afterFirst[0]).toBe(messages[0]);

    // The newest card is now resolved: the next result falls to the older one.
    const afterSecond = applyTool({
      messages: afterFirst,
      payload: idlessResult,
      runId: "r1",
      uuid,
    });
    expect(afterSecond).toHaveLength(2);
    expect(afterSecond[0].debugPayload.toolResult).toBeTruthy();

    // An orphan result (no matching call anywhere) gets a synthetic card.
    const orphan = applyTool({
      messages: afterSecond,
      payload: {
        phase: "result",
        toolResult: {
          toolCallId: "missing",
          toolName: "lookup",
          rawMessage: { toolCallId: "missing", toolName: "lookup", content: [] },
        },
        timestamp: 12,
      },
      runId: "r1",
      uuid,
    });
    expect(orphan).toHaveLength(3);
    expect(orphan[2].role).toBe("tool");
    expect(orphan[2].content).toBe("Tool call: lookup");
    expect(orphan[2].debugPayload.toolResult).toBeTruthy();
    expect(orphan[2].debugPayload.toolCalls[0].id).toBe("missing");
  });
});

describe("frontend/chat transcript-store markerCopy", () => {
  it("markerCopy wording", () => {
    expect(markerCopy({ kind: "stopped" })).toBe("You stopped this response");
    expect(markerCopy({ kind: "interrupted" })).toContain("may have kept working");
    expect(markerCopy({ kind: "unknown" })).toContain("check the transcript");
    // A provided detail wins over the default copy.
    expect(markerCopy({ kind: "interrupted", detail: "custom detail" })).toBe(
      "custom detail",
    );
    // Unrecognized kinds fall back to the generic failure line.
    expect(markerCopy({ kind: "someday-new" })).toBe("This message failed");
  });
});
