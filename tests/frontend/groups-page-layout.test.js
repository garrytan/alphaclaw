import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("preact/hooks", () => ({
  useState: (value) => [typeof value === "function" ? value() : value, () => {}],
  useRef: (value = null) => ({ current: value }),
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useLayoutEffect: () => {},
}));

const kPoll = { data: null, error: null };
vi.mock("../../lib/public/js/hooks/usePolling.js", () => ({
  usePolling: vi.fn(() => ({ data: kPoll.data, error: kPoll.error, refresh: vi.fn() })),
}));

import { usePolling } from "../../lib/public/js/hooks/usePolling.js";
import { GroupsTab } from "../../lib/public/js/components/groups-tab/index.js";

// GST-1975 PR 2: the Groups page renders every state from the API, including
// fields a newer server adds or an older one leaves out. Every id is fake.
const expandTree = (node) => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expandTree);
  if (typeof node.type === "function") return expandTree(node.type(node.props || {}));
  const children = node.props?.children;
  if (children === undefined) return node;
  return { ...node, props: { ...node.props, children: expandTree(children) } };
};
const collectNodes = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out);
    return out;
  }
  out.push(node);
  collectNodes(node.props?.children, out);
  return out;
};
const collectText = (node) => {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  return collectText(node.props?.children);
};
const hasClass = (node, name) => String(node.props?.class || "").split(/\s+/).includes(name);
const render = () => expandTree(GroupsTab({ accountId: "default" }));
const sectionTitles = (tree) => collectNodes(tree).filter((node) => hasClass(node, "briefing-section-title")).map(collectText);
const rows = (tree) => collectNodes(tree).filter((node) => hasClass(node, "groups-row"));

const kData = {
  ok: true,
  configured: true,
  accountId: "default",
  owners: ["100000001"],
  accountPolicy: "allowlist",
  visibleReplies: "automatic",
  blockedSenders: [{ id: "100000007", label: "Spam bot", blockedAt: "2026-11-08T00:00:00.000Z" }],
  groupGuard: { enforced: true, reason: null },
  groups: [
    { groupId: "-1001111111111", title: "Family chat", mode: "approved", trusted: [{ id: "100000002", scope: "actions", label: "Alex" }], topicOverrides: [], revision: "a", warnings: [] },
    { groupId: "-1001111111113", title: "Core team", mode: "trusted", trusted: [], topicOverrides: [], revision: "b", warnings: [{ code: "anonymous_admins", title: "Anonymous admins are not heard here", detail: "They reach your agent as GroupAnonymousBot." }] },
    { groupId: "-1001111111116", title: "Old marketplace", mode: "blocked", trusted: [], topicOverrides: [], revision: "c", leaveError: "Bad Gateway", lastLeftAt: null },
    { groupId: "-1001111111117", title: null, mode: "custom", readOnly: true, rules: { groupPolicy: "open" }, trusted: [], topicOverrides: [{ threadId: "7", keys: ["allowFrom"], allowFrom: ["100000005"] }], revision: "d" },
    { groupId: "-1001111111119", title: "Weekend plans", mode: "waiting", trusted: [], topicOverrides: [], revision: "e", seen: { lastJoinAt: "2026-11-09T00:00:00.000Z" } },
  ],
};

describe("Groups page layout", () => {
  beforeEach(() => {
    kPoll.data = structuredClone(kData);
    kPoll.error = null;
  });

  it("polls the account's groups and lists sections in order, then the block list", () => {
    const tree = render();
    expect(usePolling.mock.calls.at(-1)[2]).toEqual({ cacheKey: "/api/telegram/groups?accountId=default" });
    expect(sectionTitles(tree)).toEqual(["Waiting for you (1)", "Custom (1)", "Approved (1)", "Trusted people (1)", "Blocked (1)", "Guest notes", "Blocked people"]);
    const text = collectText(tree);
    expect(text).toContain("1 group waits for you to pick a rule.");
    expect(text).toContain("Anonymous admins are not heard");
    expect(text).toContain("Your agent could not leave: Bad Gateway");
    expect(text).toContain("Current rules in openclaw.json");
    expect(text).toContain("Topic overrides");
    expect(text).toContain("Spam bot");
    expect(text).not.toContain("Blocks are not enforced");
    expect(rows(tree)).toHaveLength(5);
  });

  it("shows a banner when the group guard is not enforced", () => {
    kPoll.data.groupGuard = { enforced: false, reason: "foreign" };
    const banner = collectNodes(render()).find((node) => hasClass(node, "groups-banner"));
    expect(collectText(banner)).toMatch(/Blocks are not enforced[\s\S]*is not AlphaClaw's/);
  });

  it("renders a server without groupGuard or warnings, and unknown extra fields", () => {
    delete kPoll.data.groupGuard;
    kPoll.data.someFutureField = { x: 1 };
    for (const entry of kPoll.data.groups) {
      delete entry.warnings;
      entry.futureField = true;
    }
    const tree = render();
    expect(rows(tree)).toHaveLength(5);
    expect(collectText(tree)).not.toContain("Blocks are not enforced");
  });

  it("hides every control behind the rules_unreadable card", () => {
    kPoll.error = Object.assign(new Error("x"), {
      problem: { code: "rules_unreadable", status: 503, title: "AlphaClaw cannot read its Telegram group rules file", detail: "Cannot read /root/.alphaclaw/telegram/group-rules.json: Unexpected token", sideEffects: "none" },
    });
    const tree = render();
    const text = collectText(tree);
    expect(text).toContain("Fix AlphaClaw's group rules file to use this page");
    expect(text).toContain("Cannot read /root/.alphaclaw/telegram/group-rules.json");
    expect(text).toContain("move it aside");
    expect(rows(tree)).toHaveLength(0);
    expect(sectionTitles(tree)).toEqual([]);
  });

  it("renders another load failure as its problem body and keeps the last groups", () => {
    kPoll.error = Object.assign(new Error("x"), { problem: { code: "config_unreadable", status: 503, title: "AlphaClaw cannot read openclaw.json", fix: "Fix the file.", retry: "after the file is fixed", sideEffects: "none" } });
    const tree = render();
    const text = collectText(tree);
    expect(text).toContain("AlphaClaw cannot read openclaw.json");
    expect(text).toContain("Try again after the file is fixed.");
    expect(rows(tree)).toHaveLength(5);
  });

  it("points an unconfigured box at Channels and warns when saves would be refused", () => {
    kPoll.data = { ...kPoll.data, configured: false, groups: [] };
    expect(collectText(render())).toContain("Telegram is not set up");
    kPoll.data = { ...structuredClone(kData), owners: [], accountPolicy: "open" };
    const text = collectText(render());
    expect(text).toContain("No owner Telegram id is known");
    expect(text).toContain("Groups are not on an allowlist");
  });
});
