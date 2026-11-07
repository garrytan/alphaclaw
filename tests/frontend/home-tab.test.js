import { beforeEach, describe, expect, it, vi } from "vitest";

// Home (ALPH-69 PR 3a) rendered with pass-through hooks (the
// api-feature-panel-states.test.js expandTree pattern): every function
// component in the tree runs, so the reads its cards make and the buttons it
// draws can be counted without a DOM.
const fetchedUrls = new Set();
const refreshed = [];
let visibleInterval = null;
const readFixtures = new Map();
const readErrors = new Map();
let shellFixture = {};

vi.mock("preact/hooks", () => ({
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v = null) => ({ current: v }),
}));
vi.mock("../../lib/public/js/lib/api/http.js", async (importOriginal) => ({
  ...(await importOriginal()),
  authFetch: async (url) => {
    fetchedUrls.add(String(url));
    return { ok: true, status: 200, text: async () => "{}", json: async () => ({}) };
  },
}));
vi.mock("../../lib/public/js/hooks/use-cached-fetch.js", () => ({
  useCachedFetch: (key, fetcher, { enabled = true } = {}) => {
    if (enabled) Promise.resolve().then(() => fetcher()).catch(() => {});
    return {
      data: readFixtures.get(key) ?? null,
      error: readErrors.get(key) ?? null,
      loading: false,
      refresh: async (options) => {
        refreshed.push([key, options]);
        return null;
      },
    };
  },
}));
vi.mock("../../lib/public/js/hooks/use-visible-interval.js", () => ({
  useVisibleInterval: (callback, intervalMs, options = {}) => {
    visibleInterval = { callback, intervalMs, options };
  },
}));
vi.mock("../../lib/public/js/hooks/usePolling.js", () => ({
  usePolling: (fetcher, _ms, { enabled = true } = {}) => {
    if (enabled) Promise.resolve().then(() => fetcher()).catch(() => {});
    return { data: null, error: null, isPolling: false, refresh: () => {} };
  },
}));
vi.mock("../../lib/public/js/components/restart-progress-card.js", async (importOriginal) => ({
  ...(await importOriginal()),
  useGatewayShell: () => shellFixture,
}));
vi.mock("../../lib/public/js/components/general/use-general-tab.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { useGeneralTab: vi.fn(actual.useGeneralTab) };
});

import { HomeTab, kHomeReadKeys } from "../../lib/public/js/components/home/index.js";
import { Gateway } from "../../lib/public/js/components/gateway.js";
import { BackupsCard } from "../../lib/public/js/components/general/backups-card.js";
import { WhatsNextCard } from "../../lib/public/js/components/general/whats-next-card.js";
import { SyncSettings } from "../../lib/public/js/components/general/sync-status.js";
import { DevicePairings } from "../../lib/public/js/components/device-pairings.js";
import { UpgradeAlert } from "../../lib/public/js/components/upgrade-alert/index.js";
import { useGeneralTab } from "../../lib/public/js/components/general/use-general-tab.js";

const expandTree = (node) => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expandTree);
  const out = { type: node.type, props: { ...(node.props || {}) } };
  if (typeof node.type === "function") {
    try {
      out.rendered = expandTree(node.type(node.props || {}));
    } catch (error) {
      out.rendered = null;
      out.error = error;
    }
  }
  if (out.props.children !== undefined) {
    out.props = { ...out.props, children: expandTree(out.props.children) };
  }
  return out;
};

const collectNodes = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out);
    return out;
  }
  out.push(node);
  // A component's children reappear inside what it rendered; walk them once.
  if (typeof node.type === "function") collectNodes(node.rendered, out);
  else if (node.props) collectNodes(node.props.children, out);
  return out;
};

const textOf = (node, out = []) => {
  if (typeof node === "string" || typeof node === "number") out.push(String(node));
  else if (Array.isArray(node)) node.forEach((child) => textOf(child, out));
  else if (node && typeof node === "object") {
    if (typeof node.type === "function") textOf(node.rendered, out);
    else if (node.props) textOf(node.props.children, out);
  }
  return out;
};

const byType = (tree, type) => collectNodes(tree).filter((vnode) => vnode.type === type);
const solidButtons = (tree) =>
  collectNodes(tree).filter((vnode) => vnode.type === "button" && String(vnode.props.class || "").includes("ac-btn-solid"));
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const kRunningShell = { connectivityMode: "online", hasStatus: true, statusState: { state: "running", label: "Running" } };
const kStatus = {
  gateway: "running",
  channels: { telegram: { status: "paired", paired: 1 } },
  repo: "acme/box",
  syncCron: { enabled: true, schedule: "7 * * * *", presets: [] },
  openclawVersion: "2026.10.9",
  alphaclaw: { team: { enabled: false } },
};

const quietState = (overrides = {}) => ({
  channels: kStatus.channels,
  devicePending: [],
  doctorStatus: null,
  gatewayStatus: "running",
  hasUnpaired: false,
  openclawPin: null,
  pending: [],
  repo: "acme/box",
  syncCron: kStatus.syncCron,
  syncCronChoice: "7 * * * *",
  watchdogStatus: { lifecycle: "running", autoRepair: true, uptimeMs: 60_000, servingPid: 42 },
  ...overrides,
});
const mockState = (state) =>
  useGeneralTab.mockReturnValue({ state, actions: new Proxy({}, { get: () => () => {} }) });

const render = (props = {}) =>
  expandTree(
    HomeTab({
      statusData: kStatus,
      watchdogData: null,
      doctorStatusData: null,
      agents: [{ id: "main", name: "main", default: true }],
      isActive: true,
      onSwitchTab: vi.fn(),
      ...props,
    }),
  );

// Today's General reads plus the incidents, usage and cron reads the 3a spec
// names for the strip and Coming up, and the relay status read its Channels
// card names (an endpoint the Relay page already serves).
const kAllowedHomeReads = new Set([
  "/api/openclaw/capabilities",
  "/api/openclaw/upgrade-status",
  "/api/openclaw/backup",
  "/api/pairings",
  "/api/devices",
  "/api/google/accounts",
  "/api/channels/accounts",
  "/api/watchdog/incidents?limit=50",
  "/api/usage/summary?days=30",
  "/api/cron/jobs?sortBy=nextRunAtMs&sortDir=asc",
  "/api/relay/status",
]);

beforeEach(async () => {
  fetchedUrls.clear();
  readFixtures.clear();
  readErrors.clear();
  refreshed.length = 0;
  visibleInterval = null;
  shellFixture = kRunningShell;
  const actual = await vi.importActual("../../lib/public/js/components/general/use-general-tab.js");
  useGeneralTab.mockImplementation(actual.useGeneralTab);
});

describe("frontend/home tab", () => {
  it("loads with no new endpoint: every read is General's or one the spec names", async () => {
    render();
    await settle();
    const urls = [...fetchedUrls].sort();
    expect(urls.filter((url) => !kAllowedHomeReads.has(url))).toEqual([]);
    for (const url of [
      "/api/watchdog/incidents?limit=50",
      "/api/usage/summary?days=30",
      "/api/cron/jobs?sortBy=nextRunAtMs&sortDir=asc",
    ]) {
      expect(urls).toContain(url);
    }
  });

  it("refreshes incidents, spend, schedules and relay about once a minute, forcing past a failed read", async () => {
    render();
    expect(visibleInterval.intervalMs).toBe(60_000);
    expect(visibleInterval.options).toMatchObject({ enabled: true });
    await visibleInterval.callback();
    expect(refreshed.map(([key]) => key).sort()).toEqual(
      [kHomeReadKeys.incidents, kHomeReadKeys.usage, kHomeReadKeys.cron, kHomeReadKeys.relay].sort(),
    );
    expect(refreshed.every(([, options]) => options?.force === true)).toBe(true);
  });

  it("does not keep retrying a read the server refused (401 or 403)", async () => {
    readErrors.set(kHomeReadKeys.usage, Object.assign(new Error("forbidden"), { status: 403 }));
    readErrors.set(kHomeReadKeys.relay, Object.assign(new Error("signed out"), { status: 401 }));
    readErrors.set(kHomeReadKeys.cron, Object.assign(new Error("boom"), { status: 500 }));
    render();
    await visibleInterval.callback();
    expect(refreshed.map(([key]) => key).sort()).toEqual([kHomeReadKeys.incidents, kHomeReadKeys.cron].sort());
  });

  it("renders no Gateway card", () => {
    const tree = render();
    expect(byType(tree, Gateway)).toHaveLength(0);
    expect(textOf(tree).join(" ")).not.toContain("Restart gateway");
  });

  it("shows the strip and the headline from the status stream", () => {
    mockState(quietState());
    const tree = render();
    const text = textOf(tree).join(" ");
    expect(text).toContain("Your box is running. Nothing needs you.");
    for (const label of ["Gateway", "Watchdog", "Incidents 7d", "Spend 30d"]) expect(text).toContain(label);
  });

  it("hides Attention and draws no solid button when nothing needs the owner", () => {
    mockState(quietState());
    const tree = render();
    expect(collectNodes(tree).some((vnode) => vnode.props?.["data-attention"])).toBe(false);
    expect(solidButtons(tree)).toHaveLength(0);
  });

  it("numbers Attention rows and draws exactly one solid button, on row 1", () => {
    mockState(
      quietState({
        openclawPin: { state: "diverged", installed: "2026.10.8", pinned: "2026.10.9" },
        doctorStatus: { stale: true, changeSummary: { hasMeaningfulChanges: true, changedFilesCount: 2 } },
        devicePending: [{ id: "d1", clientMode: "webchat" }],
        syncCron: { enabled: false },
      }),
    );
    const tree = render();
    const rows = collectNodes(tree).filter((vnode) => vnode.props?.["data-attention"]);
    expect(rows.map((row) => row.props["data-attention"])).toEqual(["doctor", "devices", "pin", "sync"]);
    const solid = solidButtons(tree);
    expect(solid).toHaveLength(1);
    expect(collectNodes(rows[0]).includes(solid[0])).toBe(true);
    expect(textOf(tree).join(" ")).toContain("Your box is running. 4 things need you.");
  });

  it("with several devices waiting only the first Approve is solid", () => {
    mockState(quietState({ devicePending: [{ id: "d1", clientMode: "cli" }, { id: "d2", clientMode: "webchat" }] }));
    const tree = render();
    expect(byType(tree, DevicePairings)[0].props.approveTone).toBe("solid");
    expect(solidButtons(tree)).toHaveLength(1);
  });

  it("the devices row's Approve is the solid button when it leads", () => {
    mockState(quietState({ devicePending: [{ id: "d1", clientMode: "cli" }] }));
    const tree = render();
    const devices = byType(tree, DevicePairings);
    expect(devices).toHaveLength(1);
    expect(devices[0].props.approveTone).toBe("solid");
    expect(solidButtons(tree)).toHaveLength(1);
  });
});

describe("frontend/home moved cards", () => {
  it("Finish setting up is the What's next checklist", () => {
    mockState(quietState({ channels: null }));
    const tree = render();
    expect(byType(tree, WhatsNextCard)).toHaveLength(1);
  });

  it("This box carries versions, backups and workspace sync", () => {
    mockState(quietState());
    const tree = render({ update: { version: "0.10.999", hasUpdate: true } });
    expect(byType(tree, BackupsCard)[0].props.compact).toBe(true);
    expect(byType(tree, SyncSettings)).toHaveLength(1);
    const text = textOf(tree).join(" ");
    expect(text).toContain("2026.10.9");
    expect(text).toContain("0.10.999");
    expect(text).toContain("Back up now");
    expect(text).toContain("acme/box");
  });

  it("the OpenClaw data upgrade alert sits in Attention", () => {
    mockState(quietState());
    readFixtures.set("/api/openclaw/upgrade-status", { alert: { tone: "error", headline: "Upgrade stopped" } });
    const tree = render();
    const alerts = byType(tree, UpgradeAlert);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].props).toMatchObject({ embedded: true, primaryTone: "solid" });
  });

  it("a hardening problem replaces the Doctor reminder and opens doctor?focus=context", () => {
    const onSwitchTab = vi.fn();
    mockState(
      quietState({
        doctorStatus: {
          stale: true,
          changeSummary: { hasMeaningfulChanges: true },
          bootstrapContext: {
            hardening: {
              state: "blocked",
              reason: "missing_file",
              files: [{ path: "hooks/bootstrap/AGENTS.md", exists: false, reason: "" }],
            },
          },
        },
      }),
    );
    const tree = render({ onSwitchTab });
    const rows = collectNodes(tree).filter((vnode) => vnode.props?.["data-attention"]);
    expect(rows.map((row) => row.props["data-attention"])).toEqual(["hardening"]);
    const button = collectNodes(rows[0]).find((vnode) => vnode.props?.idleLabel === "Open Drift Doctor");
    button.props.onClick();
    expect(onSwitchTab).toHaveBeenCalledWith("doctor?focus=context");
  });

  const kStaleDoctor = (hardeningState) => ({
    stale: true,
    changeSummary: { hasMeaningfulChanges: true, changedFilesCount: 2 },
    bootstrapContext: hardeningState ? { hardening: { state: hardeningState } } : undefined,
  });
  const doctorRow = (tree) => collectNodes(tree).find((vnode) => vnode.props?.["data-attention"] === "doctor");
  const buttonIn = (row, label) => collectNodes(row).find((vnode) => vnode.props?.idleLabel === label);

  it.each([[null], ["injected"]])(
    "with healthy hardening (%s) the Doctor reminder returns and opens plain #/doctor",
    (hardeningState) => {
      const onSwitchTab = vi.fn();
      mockState(quietState({ doctorStatus: kStaleDoctor(hardeningState) }));
      const tree = render({ onSwitchTab });
      const rows = collectNodes(tree).filter((vnode) => vnode.props?.["data-attention"]);
      expect(rows.map((row) => row.props["data-attention"])).toEqual(["doctor"]);
      buttonIn(rows[0], "Open Drift Doctor").props.onClick();
      expect(onSwitchTab).toHaveBeenCalledWith("doctor");
    },
  );

  it("the Doctor reminder's Dismiss calls onDismissDoctorWarning, and a dismissal hides it", () => {
    const onDismissDoctorWarning = vi.fn();
    mockState(quietState({ doctorStatus: kStaleDoctor("injected") }));
    buttonIn(doctorRow(render({ onDismissDoctorWarning })), "Dismiss for 1 week").props.onClick();
    expect(onDismissDoctorWarning).toHaveBeenCalledTimes(1);
    const dismissed = render({ doctorWarningDismissedUntilMs: Date.now() + 60_000 });
    expect(doctorRow(dismissed)).toBeUndefined();
  });

  it("shows the empty states for agents, channels and schedules", () => {
    mockState(quietState());
    readFixtures.set("/api/channels/accounts", { channels: [] });
    readFixtures.set("/api/cron/jobs?sortBy=nextRunAtMs&sortDir=asc", { jobs: [] });
    const text = textOf(render({ agents: [] })).join(" ");
    expect(text).toContain("No agents yet.");
    expect(text).toContain("No channels yet. Connect Telegram, Discord or another channel so people can reach your agents.");
    expect(text).toContain("Nothing scheduled. Agents add schedules when you ask them to run something on a timetable.");
  });
});
