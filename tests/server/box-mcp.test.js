const express = require("express");
const request = require("supertest");
const { createMcpWatch } = require("../../lib/server/mcp-watch");
const { createMcpReader, kProbeCommand } = require("../../lib/server/box-status/mcp");
const { registerBoxRoutes } = require("../../lib/server/routes/box");

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("MCP watch", () => {
  let now;
  let notify;
  let insertEvent;
  let watch;
  beforeEach(() => {
    now = Date.parse("2026-10-25T12:00:00Z");
    notify = vi.fn(async () => ({ ok: true }));
    insertEvent = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    watch = createMcpWatch({ notify, insertEvent, getSecrets: () => ["sk-live-secret-value"], now: () => now });
    watch.onGatewayLaunch({ generation: 1 });
  });
  afterEach(() => vi.restoreAllMocks());

  it("records a start failure, tells the owner once per launch and redacts the message", async () => {
    watch.observeGatewayOutput('2026-10-25T12:00:00Z [warn] bundle-mcp: failed to start server "docs" (stdio uvx docs-mcp --key sk-live-secret-value): spawn uvx ENOENT\n');
    watch.observeGatewayOutput('[warn] bundle-mcp: failed to start server "docs" (stdio uvx docs-mcp): spawn uvx ENOENT\n');
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('MCP server "docs" failed to start');
    expect(notify.mock.calls[0][0]).toContain("spawn uvx ENOENT");
    expect(notify.mock.calls[0][1]).toEqual({ eventType: "mcp_server_failed", id: "mcp-docs-1" });
    expect(insertEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "mcp_server_failed", status: "start_failed", details: { server: "docs", message: "spawn uvx ENOENT" } }));
    const [server] = watch.getState().servers;
    expect(server).toMatchObject({ name: "docs", counts: { start_failed: 2 }, lastError: { kind: "start_failed", thisLaunch: true, message: "spawn uvx ENOENT" } });
    expect(JSON.stringify(watch.getState())).not.toContain("sk-live-secret-value");

    watch.onGatewayLaunch({ generation: 1 });
    watch.observeGatewayOutput('bundle-mcp: failed to start server "docs" (x): again\n');
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);

    watch.onGatewayLaunch({ generation: 2 });
    expect(watch.getState().servers[0].lastError.thisLaunch).toBe(false);
    watch.observeGatewayOutput('bundle-mcp: failed to start server "docs" (x): token sk-live-secret-value rejected\n');
    await flush();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).not.toContain("sk-live-secret-value");
  });

  it("alerts on a skipped server, records closes and recycles without alerting, and joins split chunks", async () => {
    watch.observeGatewayOutput('bundle-mcp: skipped server "ws" because transport "websocket" is not supp');
    watch.observeGatewayOutput('orted.\nbundle-mcp: server "calc" closed; next request reconnects\nbundle-mcp: recycling server "calc" after repeated timeouts\nunrelated line\n');
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('MCP server "ws" was skipped');
    const byName = Object.fromEntries(watch.getState().servers.map((entry) => [entry.name, entry]));
    expect(byName.ws.lastError).toMatchObject({ kind: "skipped", message: 'transport "websocket" is not supported.' });
    expect(byName.calc).toMatchObject({ counts: { closed: 1, recycled: 1 }, lastError: null, lastEvent: { kind: "recycled" } });
  });

  it("reads the line as the gateway log renders it ([bundle-mcp] prefix)", async () => {
    watch.observeGatewayOutput('2026-10-25T21:31:17.462Z [gateway] 2026-10-25T21:31:17.462+00:00 [bundle-mcp] failed to start server "bbbroken" (/nonexistent/bb-mcp-server): spawn /nonexistent/bb-mcp-server ENOENT; server unavailable; retry after 2026-10-25T21:31:22.460Z. Check server reachability or reload MCP after fixing it.\n');
    await flush();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(watch.getState().servers[0]).toMatchObject({
      name: "bbbroken",
      lastError: { kind: "start_failed", thisLaunch: true, message: expect.stringMatching(/^spawn \/nonexistent\/bb-mcp-server ENOENT; server unavailable/) },
    });
  });

  it("never throws when the notifier or the ledger does", async () => {
    const failing = createMcpWatch({ notify: async () => { throw new Error("down"); }, insertEvent: () => { throw new Error("db"); } });
    expect(() => failing.observeGatewayOutput('bundle-mcp: failed to start server "x" (y): z\n')).not.toThrow();
    await flush();
  });
});

describe("MCP box view", () => {
  const config = {
    mcp: {
      servers: {
        docs: { url: "https://mcp.example.com/mcp?token=abc123secretvalue", transport: "streamable-http" },
        local: { command: "/usr/local/bin/uvx", args: ["calc-mcp", "--api-key", "sk-live-secret-value"] },
        off: { command: "npx", enabled: false },
      },
    },
  };
  const watchState = {
    launchAt: "2026-10-25T11:00:00.000Z",
    servers: [
      { name: "local", counts: { start_failed: 1 }, lastEvent: { kind: "start_failed", at: "2026-10-25T11:05:00.000Z", thisLaunch: true }, lastError: { kind: "start_failed", at: "2026-10-25T11:05:00.000Z", thisLaunch: true, message: "spawn uvx ENOENT" } },
      { name: "plugin-srv", counts: { closed: 1 }, lastEvent: { kind: "closed", at: "2026-10-25T11:06:00.000Z", thisLaunch: true }, lastError: null },
    ],
  };

  it("joins config, the gateway's reports and a probe, and never shows a secret", async () => {
    let now = 1_000_000;
    const clawCmd = vi.fn(async () => ({ ok: false, stdout: JSON.stringify({ servers: { docs: { tools: 2, resources: true } }, tools: ["docs__a", "docs__b"], diagnostics: ["local: spawn uvx ENOENT key=sk-live-secret-value"] }) }));
    const reader = createMcpReader({ readConfig: () => config, watch: { getState: () => watchState }, clawCmd, env: { MCP_KEY: "sk-live-secret-value" }, nowFn: () => now });

    const plain = await reader.read();
    expect(clawCmd).not.toHaveBeenCalled();
    expect(plain.probe).toBeNull();
    expect(plain).toMatchObject({ ok: true, gatewayLaunchAt: "2026-10-25T11:00:00.000Z", total: 4, failing: 1 });
    const byName = Object.fromEntries(plain.servers.map((server) => [server.name, server]));
    expect(byName.docs).toMatchObject({ configured: true, enabled: true, transport: "streamable-http", target: "https://mcp.example.com/mcp", toolCount: null, failing: false });
    expect(byName.local).toMatchObject({ transport: "stdio", target: "uvx (+3 args)", failing: true, lastError: { message: "spawn uvx ENOENT" } });
    expect(byName.off).toMatchObject({ enabled: false });
    expect(byName["plugin-srv"]).toMatchObject({ configured: false, enabled: null, lastEvent: { kind: "closed" } });

    const probed = await reader.read({ probe: true });
    expect(clawCmd).toHaveBeenCalledWith(kProbeCommand, expect.objectContaining({ quiet: true, timeoutMs: 45_000 }));
    expect(probed.probe).toMatchObject({ status: "partial", reason: null, at: new Date(1_000_000).toISOString() });
    expect(probed.servers.find((server) => server.name === "docs").toolCount).toBe(2);
    expect(JSON.stringify(probed)).not.toContain("sk-live-secret-value");
    expect(JSON.stringify(probed)).not.toContain("abc123secretvalue");

    now += 5 * 60_000;
    expect((await reader.read({ probe: true })).servers.find((server) => server.name === "docs").toolCount).toBe(2);
    expect((await reader.read()).probe.status).toBe("partial");
    expect(clawCmd).toHaveBeenCalledTimes(1);
    now += 6 * 60_000;
    await reader.read({ probe: true });
    expect(clawCmd).toHaveBeenCalledTimes(2);
  });

  it("says why a probe has no answer and survives an unreadable config", async () => {
    const reader = createMcpReader({ readConfig: () => { throw new Error("EACCES"); }, clawCmd: async () => ({ ok: false, stdout: "", stderr: "gateway closed" }) });
    const body = await reader.read({ probe: true });
    expect(body).toMatchObject({ ok: true, total: 0, servers: [], probe: { status: "unavailable", reason: "probe_failed", detail: "gateway closed" } });
    expect((await createMcpReader({ readConfig: () => ({}) }).read({ probe: true })).probe.reason).toBe("no_cli");
  });

  it("serves GET /api/box/mcp and validates probe", async () => {
    const app = express();
    const mcpReader = { read: vi.fn(async () => ({ ok: true, servers: [] })) };
    registerBoxRoutes({ app, requireAuth: (req, res, next) => next(), processTable: null, readRestartStatus: () => null, scheduleReader: null, diskReader: null, mcpReader });
    expect((await request(app).get("/api/box/mcp")).status).toBe(200);
    expect(mcpReader.read).toHaveBeenLastCalledWith({ probe: false });
    await request(app).get("/api/box/mcp?probe=1");
    expect(mcpReader.read).toHaveBeenLastCalledWith({ probe: true });
    const bad = await request(app).get("/api/box/mcp?probe=yes");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_probe");
  });
});
