import { beforeEach, describe, expect, it, vi } from "vitest";

// Hook harness (same as sidebar-external-nav.test.js): state lives in
// per-call-index slots, effects are collected per render and run on demand.
vi.mock("preact/hooks", () => {
  const harness = { slots: [], cursor: 0, effects: [] };
  harness.beginRender = () => {
    harness.cursor = 0;
    harness.effects = [];
  };
  harness.reset = () => {
    harness.slots = [];
    harness.cursor = 0;
    harness.effects = [];
  };
  const useState = (initialValue) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] = typeof initialValue === "function" ? initialValue() : initialValue;
    }
    const setState = (next) => {
      harness.slots[index] = typeof next === "function" ? next(harness.slots[index]) : next;
    };
    return [harness.slots[index], setState];
  };
  const useRef = (initialValue = null) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = { current: initialValue };
    return harness.slots[index];
  };
  const useMemo = (factory) => factory();
  const useCallback = (fn) => fn;
  const useEffect = (effect) => {
    harness.effects.push(effect);
  };
  return { useState, useRef, useMemo, useCallback, useEffect, __harness: harness };
});

vi.mock("../../lib/public/js/components/file-tree.js", () => ({ FileTree: () => null }));
vi.mock("../../lib/public/js/components/sidebar-git-panel.js", () => ({ SidebarGitPanel: () => null }));
vi.mock("../../lib/public/js/components/update-modal.js", () => ({ UpdateModal: () => null }));
vi.mock("../../lib/public/js/components/theme-toggle.js", () => ({
  kThemeOptions: [],
  useThemePreference: () => ["dark", () => {}],
}));
vi.mock("../../lib/public/js/lib/ui-settings.js", () => ({
  readUiSettings: () => ({}),
  writeUiSettings: () => {},
  updateUiSettings: () => {},
}));

import * as preactHooks from "preact/hooks";
import { AppSidebar } from "../../lib/public/js/components/sidebar.js";
import { getChatSidebarSection, getSessionSourceChannel } from "../../lib/public/js/lib/session-keys.js";

const harness = preactHooks.__harness;

const collectNodes = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out);
    return out;
  }
  out.push(node);
  if (node.props) collectNodes(node.props.children, out);
  return out;
};

const collectText = (node) => {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  return collectText(node.props?.children);
};

const kNow = Date.now();
const row = (key, fields = {}) => ({
  key,
  agentId: key.split(":")[1],
  agentLabel: key.split(":")[1],
  updatedAt: kNow - 60_000,
  lastActivityAt: kNow - 60_000,
  ...fields,
});

// Rows as /api/agents/sessions returns them (kind, label, channel classified
// on the server), in the key shapes OpenClaw writes.
const kSessions = [
  row("agent:main:main", { kind: "direct", label: "Main", isMain: true }),
  row("agent:main:dashboard:0b8f1c2e-1111-4a2b-9c3d-123456789abc", { kind: "direct", label: "Web chat" }),
  row("agent:main:relay-capy-ops", { kind: "relay", label: "@capy-ops · relay", readOnly: true, running: true }),
  row("agent:main:relay-researcher", { kind: "relay", label: "@researcher · relay", readOnly: true, lastActivityAt: kNow - 3_600_000 }),
  row("agent:main:telegram:direct:7000210001", { kind: "telegram-dm", label: "Owner (@bb_owner)", readOnly: true, channel: "telegram" }),
  row("agent:main:telegram:group:-1001234567890:topic:42", { kind: "telegram-topic", label: "Ops · topic 42", readOnly: true, channel: "telegram" }),
  row("agent:main:discord:channel:123456789", { kind: "other", label: "#general", channel: "discord" }),
  row("agent:main:cron:nightly-sync", { kind: "cron", label: "nightly-sync" }),
  row("agent:main:subagent:7f3a", { kind: "other", label: "subagent" }),
  row("agent:ops:main", { kind: "telegram-dm", label: "Main · Telegram", isMain: true, readOnly: true, channel: "telegram" }),
];

const renderSidebar = (props = {}) => {
  harness.beginRender();
  return AppSidebar({ sidebarTab: "chat", chatSessions: kSessions, ...props });
};

const runEffects = (match) => {
  for (const effect of [...harness.effects]) {
    if (String(effect).includes(match)) effect();
  }
};

const sectionToggle = (tree, label) =>
  collectNodes(tree).find(
    (node) => node.type === "button" && node.props.class === "sidebar-chat-section-toggle" && collectText(node).includes(label),
  );

const sessionButtons = (tree) =>
  collectNodes(tree).filter((node) => node.type === "button" && node.props["data-session-key"]);

describe("Chat sidebar sections (ALPH-69)", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
  });

  it("classifies real session-key shapes into direct, relays, channels, scheduled and other", () => {
    const sections = Object.fromEntries(kSessions.map((session) => [session.key, getChatSidebarSection(session)]));
    expect(sections).toEqual({
      "agent:main:main": "chats",
      "agent:main:dashboard:0b8f1c2e-1111-4a2b-9c3d-123456789abc": "chats",
      "agent:main:relay-capy-ops": "relays",
      "agent:main:relay-researcher": "relays",
      "agent:main:telegram:direct:7000210001": "channels",
      "agent:main:telegram:group:-1001234567890:topic:42": "channels",
      "agent:main:discord:channel:123456789": "channels",
      "agent:main:cron:nightly-sync": "cron",
      "agent:main:subagent:7f3a": "other",
      "agent:ops:main": "chats",
    });
    // Bare rows (a deep link before the list loads) classify from the key.
    expect(getChatSidebarSection({ key: "agent:main:relay-capy-x" })).toBe("relays");
    expect(getChatSidebarSection({ key: "agent:main:telegram:default:direct:1050" })).toBe("channels");
    expect(getChatSidebarSection({ key: "agent:main:telegram:group:-1001" })).toBe("channels");
    expect(getChatSidebarSection({ key: "agent:main:slack:direct:U0123" })).toBe("channels");
    expect(getChatSidebarSection({ key: "agent:main:whatsapp:direct:+15550001" })).toBe("channels");
    expect(getChatSidebarSection({ key: "agent:main:dashboard:abc" })).toBe("chats");
    expect(getChatSidebarSection({ key: "agent:main:doctor:12" })).toBe("other");
    // A scheduled run stays Scheduled when it delivers to a channel: the
    // server classifies such a row by its Telegram delivery context.
    expect(getChatSidebarSection({ key: "agent:main:cron:nightly-sync", kind: "telegram-dm", channel: "telegram" })).toBe("cron");
    expect(getChatSidebarSection({ key: "agent:main:cron:nightly-sync:run:0b8f1c2e" })).toBe("cron");
    expect(getSessionSourceChannel({ key: "agent:main:slack:direct:U0123" })).toBe("slack");
    expect(getSessionSourceChannel({ key: "agent:main:x", kind: "telegram-dm" })).toBe("telegram");
  });

  it("groups each agent's sessions under Relays and Channels, keeping the operator's chats on top", () => {
    const tree = renderSidebar();
    expect(collectText(sectionToggle(tree, "Relays"))).toContain("Relays (2)");
    expect(collectText(sectionToggle(tree, "Channels"))).toContain("Channels (3)");
    expect(collectText(sectionToggle(tree, "Scheduled"))).toContain("Scheduled (1)");
    expect(collectText(sectionToggle(tree, "Other"))).toContain("Other (1)");
    expect(sectionToggle(tree, "Relays").props["aria-expanded"]).toBe(false);
    // Collapsed by default, so only the operator's chats show as rows.
    expect(sessionButtons(tree).map((node) => node.props["data-session-key"])).toEqual([
      "agent:main:main",
      "agent:main:dashboard:0b8f1c2e-1111-4a2b-9c3d-123456789abc",
      "agent:ops:main",
    ]);
  });

  it("labels relay rows with the peer, a status dot and the last activity, and channel rows by source", () => {
    let tree = renderSidebar();
    sectionToggle(tree, "Relays").props.onclick();
    sectionToggle(tree, "Channels").props.onclick();
    tree = renderSidebar();
    const byKey = Object.fromEntries(sessionButtons(tree).map((node) => [node.props["data-session-key"], node]));
    const ops = byKey["agent:main:relay-capy-ops"];
    expect(collectText(ops)).toBe("@capy-ops1m");
    const opsDot = collectNodes(ops).find((node) => String(node.props?.class || "").startsWith("sidebar-chat-status-dot"));
    expect(opsDot.props).toMatchObject({ role: "img", "aria-label": "Running" });
    expect(opsDot.props.class).toContain("is-running");
    const researcherDot = collectNodes(byKey["agent:main:relay-researcher"]).find((node) =>
      String(node.props?.class || "").startsWith("sidebar-chat-status-dot"),
    );
    expect(researcherDot.props["aria-label"]).toBe("Idle");
    expect(collectText(byKey["agent:main:relay-researcher"])).toContain("1h");
    expect(collectText(byKey["agent:main:telegram:direct:7000210001"])).toContain("Telegram");
    expect(collectText(byKey["agent:main:telegram:group:-1001234567890:topic:42"])).toContain("Ops · topic 42");
    expect(collectText(byKey["agent:main:discord:channel:123456789"])).toContain("Discord");
  });

  it("expands Relays, selects and scrolls to a deep-linked relay conversation", () => {
    const key = "agent:main:relay-researcher";
    let tree = renderSidebar({ selectedChatSessionKey: key });
    expect(sectionToggle(tree, "Relays").props["aria-expanded"]).toBe(false);
    runEffects("revealedChatSessionKeyRef");
    tree = renderSidebar({ selectedChatSessionKey: key });
    expect(sectionToggle(tree, "Relays").props["aria-expanded"]).toBe(true);
    expect(sectionToggle(tree, "Channels").props["aria-expanded"]).toBe(false);
    const selected = sessionButtons(tree).find((node) => node.props["data-session-key"] === key);
    expect(selected.props.class).toContain("active");
    expect(selected.props["aria-current"]).toBe("true");

    const list = collectNodes(tree).find((node) => node.props?.class === "sidebar-chat-sessions-list");
    const target = {
      getAttribute: () => key,
      getBoundingClientRect: () => ({ top: 900, bottom: 930, height: 30 }),
    };
    list.ref.current = {
      scrollTop: 0,
      querySelectorAll: () => [target],
      getBoundingClientRect: () => ({ top: 100, bottom: 500, height: 400 }),
    };
    runEffects("querySelectorAll");
    expect(list.ref.current.scrollTop).toBe(900 - 100 - (400 - 30) / 2);

    // Revealed once: the operator can collapse Relays again.
    sectionToggle(tree, "Relays").props.onclick();
    tree = renderSidebar({ selectedChatSessionKey: key });
    runEffects("revealedChatSessionKeyRef");
    tree = renderSidebar({ selectedChatSessionKey: key });
    expect(sectionToggle(tree, "Relays").props["aria-expanded"]).toBe(false);
  });

  it("opens the agent group when the deep-linked conversation sits in a collapsed agent", () => {
    const key = "agent:main:relay-capy-ops";
    let tree = renderSidebar({ selectedChatSessionKey: key });
    const agentToggle = collectNodes(tree).find(
      (node) => node.type === "button" && node.props.class === "sidebar-chat-agent-toggle" && collectText(node).includes("main"),
    );
    agentToggle.props.onclick();
    tree = renderSidebar({ selectedChatSessionKey: key });
    expect(sessionButtons(tree).some((node) => node.props["data-session-key"] === key)).toBe(false);
    runEffects("revealedChatSessionKeyRef");
    tree = renderSidebar({ selectedChatSessionKey: key });
    expect(sessionButtons(tree).some((node) => node.props["data-session-key"] === key)).toBe(true);
  });

  it("finishes a cold deep link once the real list puts the row past the first 30", () => {
    const key = "agent:main:relay-peer-40";
    const placeholder = { key, agentId: "main", kind: "relay", readOnly: true };
    let tree = renderSidebar({ chatSessions: [placeholder], selectedChatSessionKey: key });
    runEffects("revealedChatSessionKeyRef");
    tree = renderSidebar({ chatSessions: [placeholder], selectedChatSessionKey: key });
    expect(sectionToggle(tree, "Relays").props["aria-expanded"]).toBe(true);
    const realList = Array.from({ length: 45 }, (_, index) =>
      row("agent:main:relay-peer-" + index, { kind: "relay", label: "@peer-" + index, lastActivityAt: kNow - index * 60_000 }),
    );
    tree = renderSidebar({ chatSessions: realList, selectedChatSessionKey: key });
    expect(sessionButtons(tree).some((node) => node.props["data-session-key"] === key)).toBe(false);
    runEffects("revealedChatSessionKeyRef");
    tree = renderSidebar({ chatSessions: realList, selectedChatSessionKey: key });
    const selected = sessionButtons(tree).find((node) => node.props["data-session-key"] === key);
    expect(selected).toBeTruthy();
    expect(selected.props["aria-current"]).toBe("true");
  });

  it("clears the scroll target when the row is missing or the list has no height, so a later toggle never jumps", () => {
    for (const fakeList of [
      { scrollTop: 0, querySelectorAll: () => [], getBoundingClientRect: () => ({ top: 100, bottom: 500, height: 400 }) },
      { scrollTop: 0, querySelectorAll: (/** keyed below */) => [{ getAttribute: () => "agent:main:relay-researcher", getBoundingClientRect: () => ({ top: 900, bottom: 930, height: 30 }) }], getBoundingClientRect: () => ({ top: 0, bottom: 0, height: 0 }) },
    ]) {
      harness.reset();
      const key = "agent:main:relay-researcher";
      let tree = renderSidebar({ selectedChatSessionKey: key });
      runEffects("revealedChatSessionKeyRef");
      tree = renderSidebar({ selectedChatSessionKey: key });
      const listNode = () => collectNodes(tree).find((node) => node.props?.class === "sidebar-chat-sessions-list");
      listNode().ref.current = fakeList;
      runEffects("querySelectorAll");
      // A later render (a section toggle) with a list where the row is now
      // findable must not scroll: the target was spent.
      sectionToggle(tree, "Channels").props.onclick();
      tree = renderSidebar({ selectedChatSessionKey: key });
      const later = {
        scrollTop: 0,
        querySelectorAll: () => [{ getAttribute: () => key, getBoundingClientRect: () => ({ top: 900, bottom: 930, height: 30 }) }],
        getBoundingClientRect: () => ({ top: 100, bottom: 500, height: 400 }),
      };
      listNode().ref.current = later;
      runEffects("querySelectorAll");
      expect(later.scrollTop).toBe(0);
    }
  });
});
