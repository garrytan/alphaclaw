import { describe, expect, it } from "vitest";
import { buildRelayHeadline, isWaitingConversation } from "../../lib/public/js/components/relay-tab/headline-model.js";

const ready = { enabled: true, phase: "ready", bridge: { failure: null } };
const answered = (id) => ({ id, lastStatus: "answered" });
const sessionOnly = (id) => ({ id, lastStatus: null, sessionOnly: true });

describe("Relay page headline", () => {
  it("says Loading until the status arrives, and names a status read that failed", () => {
    expect(buildRelayHeadline()).toBe("Loading…");
    expect(buildRelayHeadline({ statusError: new Error("403") })).toBe("Couldn't load the relay status.");
  });

  it("names a failed status read even when an earlier status is still loaded", () => {
    expect(buildRelayHeadline({ status: ready, statusError: new Error("boom"), conversations: [answered("a")] })).toBe(
      "Couldn't load the relay status.",
    );
  });

  it("says the relay is off, starting or not running from its phase", () => {
    expect(buildRelayHeadline({ status: { enabled: false } })).toBe("Relay is off.");
    expect(buildRelayHeadline({ status: { enabled: true, phase: "off" } })).toBe("Relay is off.");
    for (const phase of ["idle", "downloading", "engine_starting", "provisioning", undefined]) {
      expect(buildRelayHeadline({ status: { enabled: true, phase } })).toBe("Relay is starting.");
    }
    expect(buildRelayHeadline({ status: { enabled: true, phase: "failed" } })).toBe("Relay is not running.");
  });

  it("says a ready relay whose bridge is failing is not answering", () => {
    expect(buildRelayHeadline({ status: { ...ready, bridge: { failure: "session list failed" } }, conversations: [answered("a")] })).toBe(
      "Relay is not answering messages.",
    );
  });

  it("does not count conversations it could not load or is still loading", () => {
    expect(buildRelayHeadline({ status: ready, listError: new Error("500"), conversations: [] })).toBe(
      "Relay is ready, but its conversations didn't load.",
    );
    expect(buildRelayHeadline({ status: ready, listLoading: true })).toBe("Relay is ready.");
  });

  it("counts the rows still on the page after a refresh fails, and says they may be out of date", () => {
    const rows = [answered("a"), { id: "b", lastStatus: "dispatched" }];
    expect(buildRelayHeadline({ status: ready, listError: new Error("502"), conversations: rows })).toBe(
      "Relay is ready. Two conversations, one waiting. The last refresh failed, so this may be out of date.",
    );
    expect(buildRelayHeadline({ status: ready, listError: new Error("502"), conversations: rows, hasMore: true })).toBe(
      "Relay is ready. More than 2 conversations; one of the newest 2 waiting. The last refresh failed, so this may be out of date.",
    );
    expect(buildRelayHeadline({ status: ready, listError: new Error("502"), conversations: rows, filtered: true })).toBe(
      "Relay is ready. Showing the conversations that match your filters. The last refresh failed, so this may be out of date.",
    );
  });

  it("does not count a filtered list as every conversation", () => {
    expect(buildRelayHeadline({ status: ready, filtered: true, conversations: [answered("a")] })).toBe(
      "Relay is ready. Showing the conversations that match your filters.",
    );
  });

  it("counts conversations and how many are waiting, in words up to two", () => {
    expect(buildRelayHeadline({ status: ready, conversations: [] })).toBe("Relay is ready. No conversations yet.");
    expect(buildRelayHeadline({ status: ready, conversations: [answered("a")] })).toBe("Relay is ready. One conversation, answered.");
    expect(buildRelayHeadline({ status: ready, conversations: [{ id: "a", lastStatus: "dispatched" }] })).toBe(
      "Relay is ready. One conversation, one waiting.",
    );
    expect(buildRelayHeadline({ status: ready, conversations: [answered("a"), sessionOnly("b")] })).toBe(
      "Relay is ready. Two conversations, all answered.",
    );
    const four = [answered("a"), { id: "b", lastStatus: "interrupted" }, { id: "c", lastStatus: "queued" }, { id: "d", lastStatus: "failed" }];
    expect(buildRelayHeadline({ status: ready, conversations: four })).toBe("Relay is ready. 4 conversations, 3 waiting.");
    expect(buildRelayHeadline({ status: ready, conversations: four.slice(0, 3) })).toBe("Relay is ready. 3 conversations, two waiting.");
  });

  it("says more conversations exist than the page loaded", () => {
    const loaded = Array.from({ length: 50 }, (_, index) => answered("c" + index));
    expect(buildRelayHeadline({ status: ready, conversations: loaded, hasMore: true })).toBe(
      "Relay is ready. More than 50 conversations; the newest 50 are all answered.",
    );
    loaded[3] = { id: "c3", lastStatus: "rate_limited" };
    expect(buildRelayHeadline({ status: ready, conversations: loaded, hasMore: true })).toBe(
      "Relay is ready. More than 50 conversations; one of the newest 50 waiting.",
    );
  });

  it("counts a conversation as waiting only when the bridge has not answered its last message", () => {
    expect(isWaitingConversation({ lastStatus: "answered" })).toBe(false);
    expect(isWaitingConversation({ lastStatus: null })).toBe(false);
    expect(isWaitingConversation({ lastStatus: "replying" })).toBe(true);
    expect(isWaitingConversation({ lastStatus: "hop_limit" })).toBe(true);
  });
});
