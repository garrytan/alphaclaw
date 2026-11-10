import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("preact/hooks", () => ({
  useState: (value) => [typeof value === "function" ? value() : value, () => {}],
  useRef: (value = null) => ({ current: value }),
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useLayoutEffect: () => {},
}));

const kPolled = new Map();
const kErrors = new Map();
vi.mock("../../lib/public/js/hooks/usePolling.js", () => ({
  usePolling: vi.fn((_fetcher, _interval, { cacheKey, enabled } = {}) => {
    const key = String(cacheKey).split("?")[0];
    return {
      data: enabled === false ? null : kPolled.get(key) ?? null,
      error: enabled === false ? null : kErrors.get(key) ?? null,
      refresh: vi.fn(),
    };
  }),
}));

vi.mock("../../lib/public/js/lib/api.js", async (importOriginal) => ({
  ...(await importOriginal()),
  openRelayConsentWindow: vi.fn(async () => ({ code: "K7QX-M4PZ", until: "2026-11-08T12:10:00.000Z" })),
  revokeRelayClient: vi.fn(async () => ({ ok: true })),
  removeRelayBinding: vi.fn(async () => ({ ok: true })),
}));

import { openRelayConsentWindow } from "../../lib/public/js/lib/api.js";
import { RelayTab } from "../../lib/public/js/components/relay-tab/index.js";
import { RelayConnections } from "../../lib/public/js/components/relay-tab/connections.js";
import { ConfirmDialog } from "../../lib/public/js/components/confirm-dialog.js";
import { getRoute } from "../../lib/public/js/lib/routes.js";

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

const classOf = (node) => String(node.props?.class || node.props?.className || "");
const hasClass = (node, name) => classOf(node).split(/\s+/).includes(name);

const kStatus = {
  enabled: true,
  phase: "ready",
  agentName: "wintermute",
  engine: { version: "12.8.0", target: "linux-x64", port: 18787, process: { status: "running" }, exposure: { exposedOn: ["172.17.0.2"] } },
  settings: { retentionDays: 90, maxConcurrent: 2, hourlyCap: 30 },
  bridge: { failure: null, lastPollError: null },
  agents: [
    { name: "wintermute", online: true, lastSeen: "2026-11-08T11:59:00.000Z" },
    { name: "capy-ops", online: false, lastSeen: "2026-11-08T11:00:00.000Z" },
  ],
  dbBytes: { engine: 1_000_000, bridge: 20_000 },
  archive: { enabled: false },
};

const relaySessionKey = (peer) => `agent:main:relay-${peer}`;

const kConversations = [
  {
    id: "conv-1",
    participants: ["wintermute", "capy-ops"],
    peer: "capy-ops",
    messageCount: 4,
    lastMessageAt: "2026-11-08T11:58:00.000Z",
    lastFrom: "wintermute",
    lastText: "pong: disk is at 41%",
    lastStatus: "answered",
    lastCode: null,
    sessionKey: relaySessionKey("capy-ops"),
    sessionOnly: false,
  },
  {
    id: "conv-2",
    participants: ["wintermute", "hermes"],
    peer: "hermes",
    messageCount: 2,
    lastMessageAt: "2026-11-08T11:59:00.000Z",
    lastFrom: "hermes",
    lastText: "ping",
    lastStatus: "dispatched",
    lastCode: null,
    sessionKey: relaySessionKey("hermes"),
    sessionOnly: false,
  },
];

const kRemote = {
  enabled: true,
  mcpUrl: "https://box.example.com/relay/mcp",
  unavailable: null,
  consentWindowUntil: null,
  clients: [{ clientId: "c1", name: "Capy", redirectHosts: ["capy.ai"], createdAt: 1, consentedAt: 2, revokedAt: null }],
  bindings: [{ agent: "capy-62a929e44271", threadId: "jam_01ABC", until: Date.now() + 86_400_000, expired: false, deadAt: null, lastWakeStatus: "delivered" }],
};

const render = () => expandTree(RelayTab());
const headlineOf = (tree) => collectText(collectNodes(tree).find((node) => hasClass(node, "briefing-headline")));
const headings = (tree) => collectNodes(tree).filter((node) => node.type === "h2").map((node) => collectText(node));

describe("Relay page briefing layout", () => {
  beforeEach(() => {
    kPolled.clear();
    kErrors.clear();
    vi.clearAllMocks();
    kPolled.set("/api/relay/status", kStatus);
    kPolled.set("/api/relay/conversations", { agentName: "wintermute", conversations: kConversations, nextBefore: null });
    kPolled.set("/api/relay/remote", kRemote);
  });

  it("opens with a headline that matches the conversation rows below it", () => {
    const tree = render();
    expect(headlineOf(tree)).toBe("Relay is ready. Two conversations, one waiting.");
    const rows = collectNodes(tree).filter((node) => node.type === "a" && hasClass(node, "relay-conv-link"));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => collectText(row)).join(" ")).toMatch(/Answered[\s\S]*Running/);
  });

  it("lists the facts as dot-plus-word rows, with the exposure warning as a warn row", () => {
    const facts = collectNodes(render()).filter((node) => hasClass(node, "relay-fact"));
    const ready = facts.find((node) => collectText(node).includes("Ready"));
    expect(collectNodes(ready).some((node) => hasClass(node, "status-chip-dot--running"))).toBe(true);
    const exposure = facts.find((node) => collectText(node).includes("172.17.0.2"));
    expect(collectNodes(exposure).some((node) => hasClass(node, "status-chip-dot--degraded"))).toBe(true);
    expect(collectNodes(exposure).some((node) => node.type === "code" && collectText(node) === "172.17.0.2")).toBe(true);
  });

  it("has one solid button, Allow a new connection, which keeps its handler", async () => {
    const tree = render();
    const solid = collectNodes(tree).filter((node) => node.type === "button" && hasClass(node, "ac-btn-solid"));
    expect(solid).toHaveLength(1);
    expect(collectText(solid[0])).toContain("Allow a new connection");
    await (solid[0].props.onClick || solid[0].props.onclick)();
    expect(openRelayConsentWindow).toHaveBeenCalledTimes(1);
  });

  it("opens each conversation with this box in its own Chat session", () => {
    const links = collectNodes(render()).filter((node) => node.type === "a" && collectText(node).includes("Open in Chat"));
    expect(links.map((node) => [collectText(node).match(/@[a-z-]+/)[0], node.props.href])).toEqual([
      ["@capy-ops", "#/chat/" + encodeURIComponent(relaySessionKey("capy-ops"))],
      ["@hermes", "#/chat/" + encodeURIComponent(relaySessionKey("hermes"))],
    ]);
  });

  it("draws relay handles in mono and section titles, state words and labels in sans", () => {
    const tree = render();
    const mono = collectNodes(tree).filter((node) => hasClass(node, "relay-handle") || hasClass(node, "font-mono"));
    const monoText = mono.map((node) => collectText(node));
    expect(monoText).toEqual(expect.arrayContaining(["@capy-ops", "@hermes", "@wintermute", "@capy-62a929e44271"]));
    for (const text of monoText) {
      expect(text).toMatch(/^(@[a-z0-9-]+|[0-9.]+ \([a-z0-9-]+\)|https:\/\/\S+|capy\.ai|jam_\w+|[0-9.]+|ALPHACLAW_\S+)$/);
    }
    for (const node of collectNodes(tree).filter((child) => child.type === "h2" || hasClass(child, "relay-word") || child.type === "dt")) {
      expect(classOf(node)).not.toContain("font-mono");
    }
  });

  it("orders the sections Conversations, Agents, Connections, Engine, Brain archive", () => {
    expect(headings(render())).toEqual(["Conversations", "Agents", "Connections", "Engine", "Brain archive"]);
  });

  it("shows when each agent was seen and the engine as a key and value list", () => {
    const tree = render();
    const text = collectText(tree);
    expect(text).toContain("(this box)");
    expect(text).toMatch(/offline[\s\S]*seen/);
    const keys = collectNodes(tree).filter((node) => node.type === "dt").map((node) => collectText(node));
    expect(keys).toEqual(expect.arrayContaining(["Engine", "This box's agent", "Bridged runs", "Retention", "Storage"]));
  });

  it("says Relay is off and drops the engine and the Allow button when the relay is off", () => {
    kPolled.set("/api/relay/status", { enabled: false, phase: "off", agents: [], settings: {}, engine: { exposure: { exposedOn: [] } } });
    kPolled.set("/api/relay/remote", { enabled: false, unavailable: "relay_disabled" });
    const tree = render();
    expect(headlineOf(tree)).toBe("Relay is off.");
    expect(headings(tree)).not.toContain("Engine");
    expect(collectNodes(tree).some((node) => node.type === "button" && hasClass(node, "ac-btn-solid"))).toBe(false);
    expect(collectText(tree)).not.toContain("Connections off");
  });

  it("says why other agents cannot connect while the relay itself is on", () => {
    kPolled.set("/api/relay/remote", { enabled: false, unavailable: "public_url_missing" });
    const tree = render();
    const fact = collectNodes(tree).find((node) => hasClass(node, "relay-fact") && collectText(node).includes("Connections not set up"));
    expect(collectNodes(fact).some((node) => node.type === "code" && collectText(node) === "ALPHACLAW_SETUP_URL")).toBe(true);
    expect(headings(tree)).not.toContain("Connections");
    expect(collectNodes(tree).some((node) => node.type === "button" && hasClass(node, "ac-btn-solid"))).toBe(false);
  });

  it("shows no status-based rows over a status read that just failed", () => {
    kErrors.set("/api/relay/status", new Error("Request failed (403)"));
    const tree = render();
    expect(headlineOf(tree)).toBe("Couldn't load the relay status.");
    expect(headings(tree)).not.toContain("Engine");
    expect(headings(tree)).not.toContain("Agents");
    expect(collectText(tree)).toContain("Request failed (403)");
  });

  it("keeps the loaded conversations and Load more under the error when a refresh fails", () => {
    kPolled.set("/api/relay/conversations", { agentName: "wintermute", conversations: kConversations, nextBefore: "cursor-1" });
    kErrors.set("/api/relay/conversations", new Error("Request failed (502)"));
    const tree = render();
    const nodes = collectNodes(tree);
    const error = nodes.find((node) => node.type === "p" && collectText(node) === "Request failed (502)");
    const rows = nodes.filter((node) => node.type === "a" && hasClass(node, "relay-conv-link"));
    expect(error).toBeTruthy();
    expect(rows).toHaveLength(2);
    expect(nodes.indexOf(error)).toBeLessThan(nodes.indexOf(rows[0]));
    expect(nodes.some((node) => node.type === "button" && collectText(node).includes("Load more conversations"))).toBe(true);
    expect(headlineOf(tree)).toBe(
      "Relay is ready. More than 2 conversations; one of the newest 2 waiting. The last refresh failed, so this may be out of date.",
    );
  });

  it("shows only the error when a conversations read fails before any rows loaded", () => {
    kPolled.delete("/api/relay/conversations");
    kErrors.set("/api/relay/conversations", new Error("Request failed (502)"));
    const tree = render();
    const text = collectText(tree);
    expect(text).toContain("Request failed (502)");
    expect(text).not.toContain("No relay conversations yet.");
    expect(text).not.toContain("Load more conversations");
    expect(headlineOf(tree)).toBe("Relay is ready, but its conversations didn't load.");
  });

  it("keeps an open Revoke confirm open, in the same place, when remote access becomes unavailable", () => {
    const connections = { pending: { kind: "client", id: "c1", name: "Capy" }, setPending: vi.fn(), busy: false, confirm: vi.fn() };
    const dialogIndex = (remote) => {
      const children = [RelayConnections({ remote, error: null, connections })].flat();
      return children.findIndex((child) => child?.type === ConfirmDialog && child.props.visible === true);
    };
    const shown = dialogIndex(kRemote);
    const hidden = dialogIndex({ enabled: false, unavailable: "provisioning_pending" });
    expect(shown).toBeGreaterThanOrEqual(0);
    expect(hidden).toBe(shown);
    const closed = expandTree(RelayConnections({ remote: { enabled: false, unavailable: "provisioning_pending" }, error: null, connections: { ...connections, pending: null } }));
    expect(headings(closed)).toEqual([]);
  });

  it("lists trusted Capy projects with a form to add one, and hides their own clients from the app list", () => {
    const connections = { pending: null, setPending: vi.fn(), busy: false, confirm: vi.fn() };
    const remote = {
      ...kRemote,
      capyAttestation: true,
      clients: [...kRemote.clients, { clientId: "capy_0123456789abcdef", name: "Capy machines (proj_1)", redirectHosts: [], createdAt: 1, consentedAt: 2, revokedAt: null }],
      grants: [
        { id: "rg_0123456789abcdef", kind: "capy", project: "proj_1", tier: "delegate", createdAt: 1, revokedAt: null },
        { id: "rg_fedcba9876543210", kind: "capy", project: "proj_old", tier: "delegate", createdAt: 1, revokedAt: 3 },
      ],
    };
    const tree = expandTree(RelayConnections({ remote, error: null, connections }));
    const text = collectText(tree);
    expect(text).toContain("Trusted Capy projects");
    expect(text).toContain("proj_1");
    expect(text).not.toContain("proj_old");
    expect(text).not.toContain("Capy machines (proj_1)");
    expect(collectNodes(tree).filter((node) => node.type === "input").map((node) => node.props["aria-label"])).toEqual(["Capy project id", "Thread owner's Capy user id"]);
    const off = collectText(expandTree(RelayConnections({ remote: { ...remote, capyAttestation: false }, error: null, connections })));
    expect(off).not.toContain("Trusted Capy projects");
  });

  it("reads at the content width like the other briefing pages", () => {
    expect(getRoute("relay")).toMatchObject({ layout: "briefing", wide: true, purpose: "Other agents can message this box's agent over the relay" });
  });
});
