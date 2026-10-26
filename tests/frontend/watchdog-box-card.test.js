import { describe, expect, it } from "vitest";
import { buildBoxSummary, WatchdogBoxCard } from "../../lib/public/js/components/watchdog-tab/box/index.js";

const collectText = (node, out = []) => {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    if (typeof node.type === "function") {
      try {
        collectText(node.type(node.props || {}), out);
      } catch {}
    }
    collectText(node.props?.children, out);
  }
  return out;
};

const kNow = Date.parse("2026-10-25T12:00:00Z");
const box = {
  processes: {
    ok: true,
    status: "fresh",
    total: 6,
    totals: { gateway: { count: 2, rssBytes: 800 * 1024 * 1024 }, tool: { count: 0, rssBytes: 0 }, alphaclaw: { count: 1, rssBytes: 120 * 1024 * 1024 }, other: { count: 3, rssBytes: 50 * 1024 * 1024 } },
    processes: [{ pid: 10, name: "openclaw-gateway", owner: "gateway", rssBytes: 790 * 1024 * 1024 }],
  },
  restart: {
    ok: true,
    gateway: { outcome: "ready", source: "api:restart", reason: "config change", requestedAt: "2026-10-25T11:50:00Z", downtimeMs: 12_000 },
    lastGatewayExit: { at: "2026-10-25T09:00:00Z", code: null, signal: "SIGKILL", cause: "oom" },
  },
  mcp: { ok: true, servers: [{ name: "docs", enabled: true, failing: false }, { name: "calc", enabled: true, failing: true, lastError: { message: "spawn uvx ENOENT" } }, { name: "off", enabled: false, failing: false }] },
  schedules: {
    ok: true,
    openclaw: { status: "ok", jobs: [{ id: "j1", name: "digest", enabled: true, nextRunAt: "2026-10-25T13:00:00Z", lastOutcome: "error" }] },
    alphaclaw: [{ id: "watchdog.health", title: "Gateway health and readiness check", nextRunAt: "2026-10-25T12:02:00Z" }],
    system: { total: 1, cronDaemon: { status: "not_running" }, entries: [{ command: "/usr/bin/sync", nextRunAt: "2026-10-25T12:17:00Z" }] },
  },
  disk: {
    ok: true,
    volumes: [{ id: "state", status: "fresh", freeBytes: 10 * 1024 ** 3, sizeBytes: 80 * 1024 ** 3 }],
    census: { status: "ok" },
    stateDir: { entries: [{ name: "agents", bytes: 3 * 1024 ** 3 }] },
    temp: [
      { id: "alphaclaw_backups", title: "Back up now archives", count: 5, bytes: 2 * 1024 ** 3, retention: { due: 2 } },
      { id: "openclaw_package_backups", title: "OpenClaw package and shim backups", count: 0, bytes: 0 },
    ],
  },
};

describe("Box card", () => {
  it("summarizes every view and raises the problems in the header", () => {
    const summary = buildBoxSummary(box, { nowMs: kNow });
    expect(summary.processes.owners.map((entry) => entry.label)).toEqual(["Gateway", "AlphaClaw", "Other"]);
    expect(summary.restart).toMatchObject({ outcome: "ready", tone: "success", when: "10m ago", downtime: expect.any(String), lastExit: { when: "3h ago", cause: "oom" } });
    expect(summary.mcp).toEqual({ total: 3, failing: [{ name: "calc", message: "spawn uvx ENOENT" }], disabled: 1 });
    expect(summary.schedules).toMatchObject({ openclawJobs: 1, failingJobs: ["digest"], alphaclawTimers: 1, systemEntries: 1, cronDaemon: "not_running", next: { label: "Gateway health and readiness check", in: "in 2m" } });
    expect(summary.disk.copies).toEqual([{ id: "alphaclaw_backups", title: "Back up now archives", count: 5, bytes: 2 * 1024 ** 3, due: 2 }]);
    expect(summary.alerts).toEqual(["1 MCP server failing", "1 cron job failing", "no cron daemon"]);
  });

  it("never names a next run that is already in the past", () => {
    const stale = { ...box.schedules, openclaw: { status: "ok", jobs: [{ id: "j1", name: "digest", enabled: true, nextRunAt: "2026-10-25T11:59:55Z" }] } };
    expect(buildBoxSummary({ schedules: stale }, { nowMs: kNow }).schedules.next).toEqual({ label: "Gateway health and readiness check", in: "in 2m" });
  });

  it("flags a failed restart and stays empty before anything loaded", () => {
    expect(buildBoxSummary({ restart: { ok: true, gateway: { outcome: "stop_refused", requestedAt: "2026-10-25T11:00:00Z" } } }, { nowMs: kNow })).toMatchObject({
      restart: { tone: "warning" },
      alerts: ["last restart stop_refused"],
      processes: null,
      disk: null,
    });
    expect(buildBoxSummary()).toEqual({ processes: null, restart: null, mcp: null, schedules: null, disk: null, alerts: [] });
  });

  it("renders the compact rows, and schedules and disk only when expanded", () => {
    const collapsed = collectText(WatchdogBoxCard({ box, errors: {}, expanded: false, nowMs: kNow })).join(" ").replace(/\s+/g, " ");
    expect(collapsed).toContain("Box");
    expect(collapsed).toContain("Gateway 2");
    expect(collapsed).toContain("spawn uvx ENOENT");
    expect(collapsed).not.toContain("System cron");
    const open = collectText(WatchdogBoxCard({ box, errors: {}, expanded: true, nowMs: kNow })).join(" ").replace(/\s+/g, " ");
    expect(open).toContain("System cron");
    expect(open).toContain("due for cleanup");
    expect(open).toContain("agents");
  });
});
