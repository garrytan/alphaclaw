import { beforeEach, describe, expect, it, vi } from "vitest";

const loadApi = async () => import("../../lib/public/js/lib/api/telegram-groups.js");

const response = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

const lastCall = () => {
  const [url, options = {}] = global.fetch.mock.calls[global.fetch.mock.calls.length - 1] || [];
  return { url: String(url), options, headers: new Headers(options.headers) };
};

describe("frontend/api/telegram-groups", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    global.window = { location: { href: "http://localhost/" } };
  });

  it("leaves accountId off for the default account and encodes any other", async () => {
    const api = await loadApi();
    global.fetch.mockResolvedValue(response(200, { ok: true, groups: [] }));
    await expect(api.fetchTelegramGroups()).resolves.toEqual({ ok: true, groups: [] });
    expect(lastCall().url).toBe("/api/telegram/groups");
    await api.fetchTelegramGroups({ accountId: "ops team" });
    expect(lastCall().url).toBe("/api/telegram/groups?accountId=ops%20team");
  });

  it("sends a quoted If-Match only when the save carries a revision", async () => {
    const api = await loadApi();
    global.fetch.mockResolvedValue(response(200, { ok: true }));
    await api.setTelegramGroupPolicy("-1001", { mode: "approved" }, { revision: "r7" });
    const saved = lastCall();
    expect(saved.url).toBe("/api/telegram/groups/-1001/policy");
    expect(saved.options.method).toBe("PUT");
    expect(saved.headers.get("If-Match")).toBe('"r7"');
    expect(JSON.parse(saved.options.body)).toEqual({ mode: "approved" });
    await api.setTelegramGroupPolicy("-1001", { mode: "silent", dryRun: true });
    expect(lastCall().headers.has("If-Match")).toBe(false);
  });

  it("throws a problem holding only the documented fields", async () => {
    const api = await loadApi();
    global.fetch.mockResolvedValue(
      response(409, { title: "Topics override the group's rules", code: "topic_override", fix: "Send it again", retry: "with normalizeTopics set", topicOverrides: [{ threadId: "7" }], stack: "secret frames" }),
    );
    const error = await api.setTelegramGroupPolicy("-1001", { mode: "approved" }).catch((caught) => caught);
    expect(error.message).toBe("Topics override the group's rules");
    expect(error.status).toBe(409);
    expect(error.code).toBe("topic_override");
    expect(error.problem).toEqual({
      status: 409,
      title: "Topics override the group's rules",
      code: "topic_override",
      fix: "Send it again",
      retry: "with normalizeTopics set",
      topicOverrides: [{ threadId: "7" }],
    });
  });

  it("treats ok:false on a 200 as a failure and falls back to the action's title", async () => {
    const api = await loadApi();
    global.fetch.mockResolvedValue(response(200, { ok: false }));
    const error = await api.setTelegramBlockedSenders([{ id: "42" }]).catch((caught) => caught);
    expect(error.problem).toEqual({ status: 200, title: "Could not save the block list" });
    expect(JSON.parse(lastCall().options.body)).toEqual({ senders: [{ id: "42" }] });
  });

  it("wraps a body that is not JSON as the fallback problem", async () => {
    const api = await loadApi();
    global.fetch.mockResolvedValue(response(502, "<html>Bad Gateway</html>"));
    const error = await api.testTelegramGroup("-1001", { senderIds: ["42"] }).catch((caught) => caught);
    expect(error.message).toBe("Could not test the group");
    expect(error.problem).toEqual({ title: "Could not test the group", status: 502, detail: "<html>Bad Gateway</html>" });
  });
});
