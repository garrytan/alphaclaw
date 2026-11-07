import { describe, expect, it } from "vitest";
import {
  buildAgentRows,
  buildChannelRows,
  buildComingUp,
  buildHomeHeadline,
  buildRelayRow,
  buildStripCells,
  orderAttentionItems,
  summarizeRecentIncidents,
} from "../../lib/public/js/components/home/model.js";
import { deriveStatusChip } from "../../lib/public/js/components/status-chip.js";

// Home's pure view-models (ALPH-69 PR 3a): the headline templates, the four
// strip cells in each of their states, and the card rows.
const nowMs = Date.parse("2026-11-07T18:00:00Z");
const chipFor = (state) =>
  deriveStatusChip({ connectivityMode: "online", hasStatus: true, statusState: { state, label: state } });
const kRunning = chipFor("running");
const kDown = chipFor("down");
const kDegraded = chipFor("degraded");
const kRestarting = deriveStatusChip({ connectivityMode: "online", restartOperation: { phase: "running" } });
const kConnecting = deriveStatusChip({ connectivityMode: "online", hasStatus: false });
const kOffline = deriveStatusChip({ connectivityMode: "offline" });

describe("frontend/home headline", () => {
  it("running with nothing to do", () => {
    expect(buildHomeHeadline({ chip: kRunning, attentionCount: 0 })).toEqual({
      tone: "ok",
      text: "Your box is running. Nothing needs you.",
    });
  });

  it("running with one attention item", () => {
    expect(buildHomeHeadline({ chip: kRunning, attentionCount: 1 }).text).toBe(
      "Your box is running. One thing needs you.",
    );
  });

  it("running with several attention items", () => {
    expect(buildHomeHeadline({ chip: kRunning, attentionCount: 2 }).text).toBe(
      "Your box is running. 2 things need you.",
    );
  });

  it("restarting", () => {
    expect(buildHomeHeadline({ chip: kRestarting, attentionCount: 3 }).text).toBe(
      "The gateway is restarting. This page updates when it is back.",
    );
  });

  it("down and degraded point at Health", () => {
    expect(buildHomeHeadline({ chip: kDown })).toEqual({
      tone: "bad",
      text: "The gateway is down.",
      healthLink: "Health has what to do next.",
    });
    expect(buildHomeHeadline({ chip: kDegraded })).toMatchObject({
      tone: "warn",
      text: "The gateway is degraded.",
      healthLink: "Health has what to do next.",
    });
  });

  it("before the first status frame", () => {
    expect(buildHomeHeadline({ chip: kConnecting, attentionCount: 2 }).text).toBe("Loading…");
    expect(buildHomeHeadline({}).text).toBe("Loading…");
  });

  it("AlphaClaw unreachable", () => {
    expect(buildHomeHeadline({ chip: kOffline, attentionCount: 0 }).text).toBe(
      "AlphaClaw is not answering. Retrying…",
    );
  });
});

const kIncidents = [
  { id: 3, status: "closed", openedAt: "2026-11-07T10:00:00Z", summary: { outcome: "recovered", durationMs: 17_000 } },
  { id: 2, status: "closed", openedAt: "2026-11-05T10:00:00Z", summary: { outcome: "recovered", durationMs: 16_000 } },
  { id: 1, status: "closed", openedAt: "2026-10-20T10:00:00Z", summary: { outcome: "recovered", durationMs: 9_000 } },
];
const kUsage = {
  totals: { totalCost: 76.73, turnCount: 967 },
  daily: [
    { date: "2026-11-06", totalCost: 10 },
    { date: "2026-11-02", totalCost: 9.55 },
    { date: "2026-10-20", totalCost: 57.18 },
  ],
};
const kWatchdog = { lifecycle: "running", health: "healthy", autoRepair: true, uptimeMs: 14 * 60_000, servingPid: 4347 };
const loaded = () =>
  buildStripCells({
    chip: kRunning,
    watchdog: kWatchdog,
    incidents: { summary: summarizeRecentIncidents(kIncidents, nowMs) },
    usage: { data: kUsage },
    nowMs,
  });
const cell = (cells, key) => cells.find((entry) => entry.key === key);

describe("frontend/home status strip", () => {
  it("orders the cells gateway, watchdog, incidents, spend and links each to its page", () => {
    expect(loaded().map(({ key, label, href }) => [key, label, href])).toEqual([
      ["gateway", "Gateway", "#/health"],
      ["watchdog", "Watchdog", "#/health"],
      ["incidents", "Incidents 7d", "#/health"],
      ["spend", "Spend 30d", "#/usage"],
    ]);
  });

  it("gateway cell: loaded, loading, gateway down", () => {
    expect(cell(loaded(), "gateway")).toMatchObject({ value: "Running", detail: "PID 4347 · up 14m", dot: "running" });
    expect(cell(buildStripCells({ chip: kConnecting }), "gateway")).toMatchObject({ value: "—", loading: true });
    expect(cell(buildStripCells({ chip: kDown, watchdog: kWatchdog }), "gateway")).toMatchObject({
      value: "Down",
      dot: "down",
      detail: "Open Health for the next step",
    });
  });

  it("gateway cell names an unreachable AlphaClaw", () => {
    expect(cell(buildStripCells({ chip: kOffline }), "gateway")).toMatchObject({
      value: "Offline",
      detail: "AlphaClaw is not answering",
    });
  });

  it("watchdog cell: loaded, loading, error, gateway down", () => {
    expect(cell(loaded(), "watchdog")).toMatchObject({ value: "On", detail: "2 recovered in 7 days" });
    expect(cell(buildStripCells({ chip: kRunning }), "watchdog")).toMatchObject({ value: "—", loading: true });
    expect(
      cell(buildStripCells({ chip: kRunning, watchdog: kWatchdog, incidents: { error: new Error("x") } }), "watchdog"),
    ).toMatchObject({ value: "On", detail: "" });
    expect(
      cell(buildStripCells({ chip: kDown, watchdog: { ...kWatchdog, operationInProgress: "repair" } }), "watchdog"),
    ).toMatchObject({ value: "Repairing" });
    expect(cell(buildStripCells({ chip: kRunning, watchdog: { ...kWatchdog, autoRepair: false } }), "watchdog").value).toBe(
      "Off",
    );
  });

  it("incidents cell: loaded, loading, error, gateway down", () => {
    expect(cell(loaded(), "incidents")).toMatchObject({ value: "2", detail: "17s · 16s" });
    expect(cell(buildStripCells({ chip: kRunning }), "incidents")).toMatchObject({ value: "—", loading: true });
    expect(
      cell(buildStripCells({ chip: kRunning, incidents: { error: new Error("Could not load watchdog incidents") } }), "incidents"),
    ).toMatchObject({ value: "—", error: true, tone: "warn", detail: "Could not load watchdog incidents" });
    const down = buildStripCells({
      chip: kDown,
      incidents: { summary: summarizeRecentIncidents([{ id: 9, status: "open", openedAt: "2026-11-07T17:50:00Z" }], nowMs) },
    });
    expect(cell(down, "incidents")).toMatchObject({ value: "1", tone: "warn", detail: "One is open" });
  });

  it("incidents cell says 50+ when the whole page falls inside 7 days", () => {
    const page = Array.from({ length: 50 }, (_, index) => ({
      id: index,
      status: "closed",
      openedAt: "2026-11-06T00:00:00Z",
      summary: { outcome: "recovered", durationMs: 1000 },
    }));
    expect(summarizeRecentIncidents(page, nowMs).countLabel).toBe("50+");
    expect(summarizeRecentIncidents(page.slice(0, 49), nowMs).countLabel).toBe("49");
  });

  it("spend's last 7 days is today and the 6 days before it", () => {
    const usage = {
      totals: { totalCost: 3, turnCount: 3 },
      daily: [
        { date: "2026-11-07", totalCost: 1 },
        { date: "2026-11-01", totalCost: 1 },
        { date: "2026-10-31", totalCost: 1 },
      ],
    };
    expect(cell(buildStripCells({ chip: kRunning, usage: { data: usage }, nowMs }), "spend").detail).toBe(
      "$2.00 last 7 days · 3 turns",
    );
  });

  it("spend cell: loaded, loading, error, gateway down", () => {
    expect(cell(loaded(), "spend")).toMatchObject({ value: "$76.73", detail: "$19.55 last 7 days · 967 turns" });
    expect(cell(buildStripCells({ chip: kRunning }), "spend")).toMatchObject({ value: "—", loading: true });
    expect(cell(buildStripCells({ chip: kRunning, usage: { error: new Error("nope") } }), "spend")).toMatchObject({
      value: "—",
      error: true,
      detail: "nope",
    });
    expect(cell(buildStripCells({ chip: kDown, usage: { data: kUsage }, nowMs }), "spend").value).toBe("$76.73");
  });
});

describe("frontend/home cards", () => {
  it("Coming up lists the next five enabled jobs with their agent", () => {
    const jobs = Array.from({ length: 7 }, (_, index) => ({
      id: "job-" + index,
      name: "Job " + index,
      agentId: index === 0 ? "scout" : "",
      enabled: index !== 1,
      state: { nextRunAtMs: nowMs + (7 - index) * 60_000 },
    }));
    const rows = buildComingUp({ jobs, agents: [{ id: "scout", name: "Scout" }] });
    expect(rows.map((row) => row.id)).toEqual(["job-6", "job-5", "job-4", "job-3", "job-2"]);
    expect(buildComingUp({ jobs: [jobs[0]], agents: [{ id: "scout", name: "Scout" }] })[0].agentName).toBe("Scout");
    expect(buildComingUp({ jobs: [] })).toEqual([]);
  });

  it("Agents shows the name, the Default badge and the model ref", () => {
    expect(
      buildAgentRows([
        { id: "main", name: "main", default: true, model: { primary: "openai/gpt-5" } },
        { id: "scout", name: "Scout", model: "anthropic/claude" },
        { id: "ledger" },
      ]),
    ).toEqual([
      { id: "main", name: "main", isDefault: true, model: "openai/gpt-5" },
      { id: "scout", name: "Scout", isDefault: false, model: "anthropic/claude" },
      { id: "ledger", name: "ledger", isDefault: false, model: "" },
    ]);
  });

  it("Channels summarizes bots, bindings and paired senders per channel", () => {
    const rows = buildChannelRows({
      accounts: [
        { channel: "telegram", accounts: [{ id: "default" }] },
        { channel: "discord", accounts: [{ id: "ops", boundAgentId: "scout", status: "configured" }] },
      ],
      channels: { telegram: { status: "paired", paired: 2 } },
      agents: [{ id: "main", name: "main", default: true }, { id: "scout", name: "Scout" }],
    });
    expect(rows).toEqual([
      { key: "telegram", label: "Telegram", detail: "1 bot bound to main · 2 paired senders", href: "#/telegram/default", tone: "ok" },
      { key: "discord", label: "Discord", detail: "1 bot bound to Scout · 1 waiting to pair", href: "#/channels", tone: "warn" },
    ]);
  });

  it("Telegram links its one account by id, and Channels when there are several", () => {
    const telegram = (accounts) =>
      buildChannelRows({
        accounts: [{ channel: "telegram", accounts }],
        channels: { telegram: { status: "paired", paired: 1 } },
      })[0];
    expect(telegram([{ id: "ops bot" }]).href).toBe("#/telegram/ops%20bot");
    expect(telegram([{ id: "default" }, { id: "ops" }]).href).toBe("#/channels");
  });

  it("Relay reads its phase and peers", () => {
    expect(buildRelayRow({ phase: "ready", agents: [{}, {}, {}, {}] })).toMatchObject({
      detail: "Ready · 4 peer agents",
      href: "#/relay",
      tone: "ok",
    });
    expect(buildRelayRow({ enabled: false })).toMatchObject({ detail: "Off", tone: "neutral" });
    expect(buildRelayRow(null)).toBeNull();
  });

  it("Attention puts rows with an action first, so row 1 owns the solid button", () => {
    const ordered = orderAttentionItems([
      { key: "pin" },
      false,
      { key: "doctor", actionable: true },
      { key: "sync" },
      { key: "devices", actionable: true },
    ]);
    expect(ordered.map((item) => item.key)).toEqual(["doctor", "devices", "pin", "sync"]);
  });
});
