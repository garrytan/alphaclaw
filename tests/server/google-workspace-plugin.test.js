const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const { createGoogleWorkspacePlugin, dispatchedToolOf } = require("../../lib/plugin/google-workspace");
const catalog = require("../../lib/plugin/google-workspace/catalog");
const { resolveSocketPath } = require("../../lib/plugin/google-workspace/broker");
const { createAudit } = require("../../lib/plugin/google-workspace/audit");
const { kErrors, kBrokerCodes } = require("../../lib/plugin/google-workspace/errors");
const manifest = require("../../lib/plugin/google-workspace/openclaw.plugin.json");
const { applyGoogleWorkspaceEntry, resolveDesiredGoogleWorkspaceEntry, kGoogleWorkspacePluginPath, kGoogleWorkspaceEnvKeys } = require("../../lib/server/google-workspace-entry");
const { kDeploymentOnlyEnvKeys } = require("../../lib/server/deployment-only-env");
const { classifyAnchor } = require("../../lib/plugin/relay-guard/confirm");
const { decideRelayToolCall, kOwnerThreadGoogleWorkspaceTools } = require("../../lib/plugin/relay-guard/policy");

const kOwner = "owner@example.com";
const kSecond = "second@example.com";
const kMarker = "ARGS-MARKER-91c2";
const kOwnerTurn = { channel: "telegram", senderId: "100", senderIsOwner: true };
const kGuestTurn = { channel: "telegram", senderId: "200", senderIsOwner: false };
const kDmKey = "agent:main:telegram:direct:100";
const kGroupKey = "agent:main:telegram:group:-1001";

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// A fake GBrain broker on a temp unix socket. handler(request) returns the
// reply object, "close" (drop the connection unanswered) or a promise.
const startBroker = async (handler) => {
  const dir = tempDir("gw-broker-");
  const socketPath = path.join(dir, "google.sock");
  const requests = [];
  const conns = new Set();
  const server = net.createServer((conn) => {
    conns.add(conn);
    conn.on("close", () => conns.delete(conn));
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        requests.push(request);
        Promise.resolve(handler(request, requests)).then((reply) => {
          if (reply === "close") return conn.destroy();
          conn.write(JSON.stringify(reply) + "\n");
        });
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    requests,
    calls: () => requests.filter((request) => request.op !== "tools"),
    close: () =>
      new Promise((resolve) => {
        for (const conn of conns) conn.destroy();
        server.close(() => {
          fs.rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
};

const quota = (used, day = new Date().toISOString().slice(0, 10)) => ({ product: "calendar", used_today: used, cap: 1500, day });
const okReply = (result = { content: [{ type: "text", text: "done" }] }, used = 3) => ({ v: 4, ok: true, result, request_id: "req-ok", quota: quota(used) });
const defaultHandler = (request) => (request.op === "tools" ? { v: 4, ok: true, tools: [] } : okReply());

const register = ({ socketPath, rootDir, accounts = [kOwner], toolSurface, now, gate } = {}) => {
  const handlers = {};
  const lines = [];
  const registered = [];
  const plugin = createGoogleWorkspacePlugin({ ...(now ? { now } : {}), ...(gate ? { gate } : {}) });
  plugin.register({
    pluginConfig: { rootDir, accounts, socketPath, ...(toolSurface ? { toolSurface } : {}) },
    logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line), error: (line) => lines.push(line) },
    on: (name, handler) => {
      handlers[name] = handler;
    },
    registerTool: (factory, options) => registered.push({ factory, options }),
  });
  const factory = registered[0]?.factory;
  // OpenClaw's path for one call: before_tool_call with the requester, then
  // the tool's execute under the same tool call id. Tool definitions are
  // the owner's (2026.11.2+ keeps one tool set per session for every sender).
  let seq = 0;
  const invoke = async ({ toolName, params = {}, requester = kOwnerTurn, sessionKey = kDmKey, runId = "run-1", assertInvocationCurrent = () => {}, skipHook = false }) => {
    seq += 1;
    const toolCallId = "call-" + seq;
    if (!skipHook) {
      const hook = await handlers.before_tool_call({ toolName, params, toolCallId, runId }, { sessionKey, runId, requester });
      if (hook?.block) return { blocked: hook.blockReason };
    }
    const tools = factory.create({ sessionKey: kDmKey, senderIsOwner: true, assertInvocationCurrent });
    const tool = tools.find((entry) => entry.name === toolName);
    return tool.execute(toolCallId, params, undefined);
  };
  return { handlers, lines, registered, factory, invoke };
};

const textOf = (result) => result.content.map((part) => part.text || "").join("\n");

describe("google-workspace plugin (GST-3848)", () => {
  let broker;
  let rootDir;
  beforeEach(() => {
    rootDir = tempDir("gw-root-");
  });
  afterEach(async () => {
    await broker?.close();
    broker = null;
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  describe("catalog and manifest", () => {
    it("declares every tool it can register, and names them gw_<product>_<tool>", () => {
      expect(catalog.kTools).toHaveLength(62);
      expect(manifest.contracts.tools).toEqual([...catalog.kToolNames]);
      for (const entry of catalog.kTools) expect(entry.name).toBe("gw_" + entry.server + "_" + entry.tool);
      expect(catalog.kCoreTools.every((name) => catalog.entryOf(name))).toBe(true);
      expect(catalog.entryFor("Calendar", "UPDATE_EVENT").name).toBe("gw_calendar_update_event");
      expect(catalog.entryFor("chat", "send_message")).toBeNull();
    });

    it("finds the gw_ tool a dispatcher call reaches", () => {
      expect(dispatchedToolOf({ id: "gw_gmail_trash_thread", args: {} })).toBe("gw_gmail_trash_thread");
      expect(dispatchedToolOf({ name: "GW_CALL" })).toBe("gw_call");
      expect(dispatchedToolOf({ id: "openclaw:google-workspace:gw_calendar_update_event", args: {} })).toBe("gw_calendar_update_event");
      expect(dispatchedToolOf({ toolId: "gw_docs_update_doc" })).toBe("gw_docs_update_doc");
      expect(dispatchedToolOf({ args: { id: "openclaw:google-workspace:gw_gmail_trash_thread", threadId: "t1" } })).toBe("gw_gmail_trash_thread");
      expect(dispatchedToolOf({ input: { name: "gw_tasks_delete_task" } })).toBe("gw_tasks_delete_task");
      expect(dispatchedToolOf({ id: "exec" })).toBeNull();
      expect(dispatchedToolOf(null)).toBeNull();
    });

    it("uses GBrain's socket path unless the config names an absolute one", () => {
      expect(resolveSocketPath({ env: { GBRAIN_HOME: "/data" }, homedir: "/root" })).toBe("/data/.gbrain/run/google.sock");
      expect(resolveSocketPath({ env: {}, homedir: "/root" })).toBe("/root/.gbrain/run/google.sock");
      expect(resolveSocketPath({ socketPath: "/srv/g.sock", env: { GBRAIN_HOME: "/data" } })).toBe("/srv/g.sock");
      expect(resolveSocketPath({ socketPath: "rel.sock", env: {}, homedir: "/root" })).toBe("/root/.gbrain/run/google.sock");
    });

    it("maps every broker code to a fixed error", () => {
      for (const code of Object.values(kBrokerCodes)) expect(kErrors[code], code).toBeDefined();
    });
  });

  describe("who sees and calls the tools", () => {
    it("registers nothing without a configured account", () => {
      const { registered, handlers, lines } = register({ socketPath: "/nonexistent.sock", rootDir, accounts: ["not-an-email"] });
      expect(registered).toHaveLength(0);
      expect(handlers.before_tool_call).toBeUndefined();
      expect(lines.join("\n")).toContain("no Google account is configured");
    });

    it("gives the owner the core tools and everyone else none", async () => {
      broker = await startBroker(defaultHandler);
      const { factory, registered } = register({ socketPath: broker.socketPath, rootDir });
      expect(registered[0].options.names).toEqual([...catalog.kCoreTools, ...catalog.kHelperTools]);
      expect(factory.contextVersion).toBe(2);
      expect(factory.create({ sessionKey: kGroupKey, senderIsOwner: false })).toBeNull();
      expect(factory.create({ sessionKey: kGroupKey })).toBeNull();
      expect(factory.create({ sessionKey: "agent:main:relay-capy-0a1b2c3d4e5f", senderIsOwner: true })).toBeNull();
      expect(broker.requests).toHaveLength(0);
      const tools = factory.create({ sessionKey: kDmKey, senderIsOwner: true });
      expect(tools.map((tool) => tool.name)).toEqual(registered[0].options.names);
    });

    it("registers all 65 with toolSurface all", async () => {
      broker = await startBroker(defaultHandler);
      const { registered } = register({ socketPath: broker.socketPath, rootDir, toolSurface: "all" });
      expect(registered[0].options.names).toEqual([...catalog.kToolNames]);
    });

    it("refuses a non-owner before anything reaches the socket, directly, through the dispatcher and through gw_call", async () => {
      broker = await startBroker(defaultHandler);
      const { invoke, lines } = register({ socketPath: broker.socketPath, rootDir });
      const attempts = [
        { toolName: "gw_calendar_list_events", params: { calendarId: "primary" } },
        { toolName: "dispatch_action", params: { id: "gw_gmail_trash_thread", args: { threadId: "t1" } } },
        { toolName: "tool_call", params: { name: "gw_gmail_trash_thread", args: { threadId: "t1" } } },
        { toolName: "dispatch_action", params: { id: "openclaw:google-workspace:gw_calendar_update_event", args: { eventId: "e1" } } },
        { toolName: "dispatch_action", params: { args: { toolId: "gw_gmail_trash_thread", threadId: "t1" } } },
        { toolName: "gw_call", params: { server: "gmail", tool: "trash_thread", args: { threadId: "t1" } } },
        { toolName: "gw_check_outcome", params: { ref: "x" } },
      ];
      for (const requester of [kGuestTurn, {}, null]) {
        for (const attempt of attempts) {
          const result = await invoke({ ...attempt, requester, sessionKey: kGroupKey });
          expect(result.blocked, attempt.toolName).toContain("gw_not_owner");
        }
      }
      expect(broker.requests).toHaveLength(0);
      expect(lines.filter((line) => line.includes("refused tool=gw_gmail_trash_thread via=dispatch_action reason=not_owner"))).toHaveLength(6);
    });

    it("decides a relay session by the owner-thread verdict alone, not by senderIsOwner", async () => {
      broker = await startBroker(defaultHandler);
      const { invoke } = register({ socketPath: broker.socketPath, rootDir });
      const result = await invoke({ toolName: "gw_calendar_list_events", requester: kOwnerTurn, sessionKey: "agent:main:relay-capy-0a1b2c3d4e5f", runId: "relay-m1" });
      expect(result.blocked).toContain("gw_not_owner");
      expect(broker.requests).toHaveLength(0);
    });

    it("leaves other tools to the rest of OpenClaw", async () => {
      broker = await startBroker(defaultHandler);
      const { handlers } = register({ socketPath: broker.socketPath, rootDir });
      expect(handlers.before_tool_call({ toolName: "exec", params: {} }, { sessionKey: kGroupKey, requester: kGuestTurn })).toBeUndefined();
      expect(handlers.before_tool_call({ toolName: "dispatch_action", params: { id: "exec" } }, { sessionKey: kGroupKey, requester: kGuestTurn })).toBeUndefined();
    });

    it("refuses a call whose before_tool_call never admitted it", async () => {
      broker = await startBroker(defaultHandler);
      const { invoke } = register({ socketPath: broker.socketPath, rootDir });
      const result = await invoke({ toolName: "gw_calendar_list_events", skipHook: true });
      expect(result.isError).toBe(true);
      expect(result.details.code).toBe("gw_not_owner");
      expect(broker.calls()).toHaveLength(0);
    });

    it("checks the invocation is current right before the write, and writes nothing when it is not", async () => {
      broker = await startBroker(defaultHandler);
      const { invoke } = register({ socketPath: broker.socketPath, rootDir });
      const stale = () => {
        throw new Error("invocation is no longer current");
      };
      await expect(invoke({ toolName: "gw_calendar_list_events", assertInvocationCurrent: stale })).rejects.toThrow("no longer current");
      expect(broker.calls()).toHaveLength(0);
    });
  });

  describe("calls through the broker", () => {
    it("sends one v4 call with the run id as turn id and the arguments untouched", async () => {
      broker = await startBroker(defaultHandler);
      const { invoke } = register({ socketPath: broker.socketPath, rootDir });
      const args = { calendarId: "primary", eventId: "e1", notificationLevel: "ALL", summary: kMarker };
      const result = await invoke({ toolName: "gw_calendar_update_event", params: args, runId: "run-77" });
      expect(result.isError).toBeUndefined();
      expect(textOf(result)).toBe("done");
      const [call] = broker.calls();
      expect(call).toMatchObject({ v: 4, op: "call", account: kOwner, server: "calendar", tool: "update_event", args, turn_id: "run-77", caller: "alphaclaw-google-workspace" });
      expect(call.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
      expect(call.args).not.toHaveProperty("sendUpdates");
      expect(call).not.toHaveProperty("owner_verdict");
    });

    it("reaches any tool through gw_call and picks a configured account", async () => {
      broker = await startBroker(defaultHandler);
      const { invoke } = register({ socketPath: broker.socketPath, rootDir, accounts: [kOwner, kSecond] });
      await invoke({ toolName: "gw_call", params: { server: "tasks", tool: "create_task", args: { title: "x" }, account: kSecond } });
      await invoke({ toolName: "gw_calendar_list_events", params: { calendarId: "primary" } });
      expect(broker.calls().map((call) => [call.account, call.server, call.tool, call.args])).toEqual([
        [kSecond, "tasks", "create_task", { title: "x" }],
        [kOwner, "calendar", "list_events", { calendarId: "primary" }],
      ]);
      expect((await invoke({ toolName: "gw_call", params: { server: "chat", tool: "send_message" } })).details.code).toBe("gw_unknown_tool");
      expect((await invoke({ toolName: "gw_calendar_list_events", params: { account: "stranger@example.com" } })).details.code).toBe("gw_bad_account");
      expect(broker.calls()).toHaveLength(2);
    });

    it("answers Google's prompt once with ALLOW_ONCE on the owner's turn, under the same intent id", async () => {
      broker = await startBroker((request) => {
        if (request.op === "tools") return { v: 4, ok: true, tools: [] };
        if (!request.owner_verdict) return { v: 4, ok: false, code: "input_required", request_id: "req-1", message_md: "Allow?", choices: ["ALLOW_ONCE", "DENY_ONCE", "ALLOW_AUDIENCE_ALWAYS"], tool: request.tool, args_hash: "h", quota: quota(4) };
        return okReply();
      });
      const { invoke } = register({ socketPath: broker.socketPath, rootDir });
      const result = await invoke({ toolName: "gw_calendar_update_event", params: { eventId: "e1", summary: kMarker } });
      expect(textOf(result)).toBe("done");
      const [first, second] = broker.calls();
      expect(second.owner_verdict).toEqual({ choice: "ALLOW_ONCE", for_request: "req-1" });
      expect(second.idempotency_key).toBe(first.idempotency_key);
      expect(second.args).toEqual(first.args);
      const auditText = fs.readFileSync(path.join(rootDir, "google-workspace", fs.readdirSync(path.join(rootDir, "google-workspace"))[0]), "utf8");
      expect(JSON.parse(auditText.trim())).toMatchObject({ product: "calendar", tool: "update_event", outcome: "ok", offered: ["ALLOW_ONCE", "DENY_ONCE", "ALLOW_AUDIENCE_ALWAYS"], given: "ALLOW_ONCE", request: "req-ok" });
      expect(auditText).not.toContain(kMarker);
      expect(auditText).not.toContain(kOwner);
    });

    it("never picks another choice, and holds a prompt that offers no one-time approval", async () => {
      broker = await startBroker((request) =>
        request.op === "tools" ? { v: 4, ok: true, tools: [] } : { v: 4, ok: false, code: "input_required", request_id: "req-2", choices: ["ALLOW_TOOL_ALWAYS", "DENY_ONCE"], quota: quota(5) },
      );
      const { invoke } = register({ socketPath: broker.socketPath, rootDir });
      const result = await invoke({ toolName: "gw_gmail_trash_thread", params: { threadId: "t1" } });
      expect(result.details.code).toBe("gw_held_needs_owner");
      expect(broker.calls()).toHaveLength(1);
    });

    it("stops after one verdict: a refused or expired verdict is reported, never retried", async () => {
      for (const [code, expected] of [
        ["broker_args_refused", "gw_args_refused"],
        ["verdict_expired", "gw_verdict_expired"],
        ["input_required", "gw_held_needs_owner"],
      ]) {
        broker = await startBroker((request) => {
          if (request.op === "tools") return { v: 4, ok: true, tools: [] };
          if (!request.owner_verdict) return { v: 4, ok: false, code: "input_required", request_id: "req-3", choices: ["ALLOW_ONCE", "DENY_ONCE"], quota: quota(6) };
          return { v: 4, ok: false, code, request_id: "req-4", choices: ["ALLOW_ONCE"], quota: quota(7) };
        });
        const { invoke } = register({ socketPath: broker.socketPath, rootDir });
        const result = await invoke({ toolName: "gw_calendar_update_event", params: { eventId: "e1" } });
        expect(result.details.code, code).toBe(expected);
        expect(broker.calls(), code).toHaveLength(2);
        await broker.close();
        broker = null;
      }
    });

    it("holds a safety pause for the owner and replays the same intent when called again with the same arguments", async () => {
      let confirmed = false;
      broker = await startBroker((request) => {
        if (request.op === "tools") return { v: 4, ok: true, tools: [] };
        if (request.args.threadId === "t11" && !confirmed) return { v: 4, ok: false, code: "owner_confirm_required", request_id: "req-5", message_md: "eleventh trash", quota: quota(8) };
        return okReply();
      });
      const { invoke } = register({ socketPath: broker.socketPath, rootDir });
      const held = await invoke({ toolName: "gw_gmail_trash_thread", params: { threadId: "t11" } });
      expect(held.details.code).toBe("gw_owner_confirm");
      expect(textOf(held)).toContain("gbrain google approvals");
      expect(textOf(held)).not.toContain("eleventh trash");
      confirmed = true;
      await invoke({ toolName: "gw_gmail_trash_thread", params: { threadId: "t11" } });
      await invoke({ toolName: "gw_gmail_trash_thread", params: { threadId: "t12" } });
      const [first, replay, other] = broker.calls();
      expect(replay.idempotency_key).toBe(first.idempotency_key);
      expect(replay).not.toHaveProperty("owner_verdict");
      expect(other.idempotency_key).not.toBe(first.idempotency_key);
      expect(held.details.ref).toBe(first.idempotency_key);
    });

    it("never resends after an unknown outcome, and checks it only through the status op", async () => {
      let dropped = false;
      broker = await startBroker((request) => {
        if (request.op === "tools") return { v: 4, ok: true, tools: [] };
        if (request.op === "status") return { v: 4, ok: true, state: "done", request_id: "req-6" };
        if (!dropped) {
          dropped = true;
          return "close";
        }
        return { v: 4, ok: false, code: "outcome_unknown", request_id: "req-7", quota: quota(9) };
      });
      const { invoke } = register({ socketPath: broker.socketPath, rootDir });
      const lost = await invoke({ toolName: "gw_gmail_create_draft", params: { to: "a@example.com", body: kMarker } });
      expect(lost.details.code).toBe("gw_outcome_unknown");
      expect(broker.calls()).toHaveLength(1);
      const unknown = await invoke({ toolName: "gw_gmail_create_draft", params: { to: "a@example.com", body: kMarker } });
      expect(unknown.details.code).toBe("gw_outcome_unknown");
      expect(broker.calls()).toHaveLength(2);
      expect(broker.calls()[1].idempotency_key).toBe(broker.calls()[0].idempotency_key);
      const status = await invoke({ toolName: "gw_check_outcome", params: { ref: lost.details.ref } });
      expect(JSON.parse(textOf(status))).toMatchObject({ state: "done" });
      expect(broker.calls()[2]).toEqual({ v: 4, op: "status", idempotency_key: lost.details.ref });
      expect(textOf(lost)).not.toContain(kMarker);
    });

    it("says the broker is down when its socket is not there, and sends nothing", async () => {
      const { invoke } = register({ socketPath: path.join(rootDir, "missing.sock"), rootDir });
      const result = await invoke({ toolName: "gw_calendar_list_events", params: {} });
      expect(result.details.code).toBe("gw_broker_down");
      expect(textOf(result)).toContain("Nothing was sent to Google");
    });

    it("maps revoked, not connected and Google's own denials to fixed errors", async () => {
      const replies = [
        [{ code: "revoked" }, "gw_revoked"],
        [{ code: "not_connected" }, "gw_not_connected"],
        [{ code: "broker_precondition_unmet" }, "gw_not_switched_on"],
        [{ code: "some_new_code" }, "gw_broker_internal"],
        [{ code: "tool_error", reason: "user_denied", message_md: "UserDeniedAction: declined" }, "gw_user_denied"],
        [{ code: "tool_error", reason: "admin_policy", message_md: "AdminPolicyBlock" }, "gw_admin_policy"],
        [{ code: "tool_error", reason: "tool_failed", message_md: "Invalid range" }, "gw_tool_failed"],
      ];
      let next = 0;
      broker = await startBroker((request) => (request.op === "tools" ? { v: 4, ok: true, tools: [] } : { v: 4, ok: false, request_id: "r", quota: quota(10), ...replies[next++][0] }));
      const { invoke, lines } = register({ socketPath: broker.socketPath, rootDir });
      for (const [reply, code] of replies) {
        const result = await invoke({ toolName: "gw_sheets_get_values", params: { range: "A1" } });
        expect(result.isError, code).toBe(true);
        expect(result.details.code, code).toBe(code);
        if (reply.message_md) expect(textOf(result)).toContain("Google says: " + reply.message_md);
        else expect(textOf(result)).not.toContain("Google says");
      }
      expect(lines.join("\n")).toContain("Google access was revoked");
    });

    it("tells the owner once at 1,200 and stops at 1,500 without a second counter", async () => {
      let used = 1199;
      broker = await startBroker((request) => (request.op === "tools" ? { v: 4, ok: true, tools: [] } : okReply(undefined, ++used)));
      let clock = Date.parse("2026-11-25T12:00:00Z");
      const { invoke, lines } = register({ socketPath: broker.socketPath, rootDir, now: () => clock });
      const day = "2026-11-25";
      used = 1199;
      broker.requests.length = 0;
      const at1200 = await invoke({ toolName: "gw_calendar_list_events", params: {} });
      expect(textOf(at1200)).toContain("Tell the owner: Google calendar calls today are at 1200 of 1500");
      const at1201 = await invoke({ toolName: "gw_calendar_list_events", params: {} });
      expect(textOf(at1201)).not.toContain("Tell the owner");
      expect(lines.filter((line) => line.includes("quota notice product=calendar used=1200 stop=1500 day=" + day))).toHaveLength(1);
      used = 1499;
      await invoke({ toolName: "gw_calendar_list_events", params: {} });
      const before = broker.calls().length;
      const stopped = await invoke({ toolName: "gw_calendar_list_events", params: {} });
      expect(stopped.details.code).toBe("gw_quota_stopped");
      expect(broker.calls()).toHaveLength(before);
      expect((await invoke({ toolName: "gw_gmail_search_threads", params: {} })).isError).toBeUndefined();
      clock = Date.parse("2026-11-26T00:00:01Z");
      expect((await invoke({ toolName: "gw_calendar_list_events", params: {} })).isError).toBeUndefined();
    });

    it("stops a product for the day on day_cap", async () => {
      broker = await startBroker((request) => (request.op === "tools" ? { v: 4, ok: true, tools: [] } : { v: 4, ok: false, code: "day_cap", request_id: "r", quota: quota(1500) }));
      const { invoke } = register({ socketPath: broker.socketPath, rootDir });
      expect((await invoke({ toolName: "gw_calendar_list_events", params: {} })).details.code).toBe("gw_quota_stopped");
      expect((await invoke({ toolName: "gw_calendar_list_events", params: {} })).details.code).toBe("gw_quota_stopped");
      expect(broker.calls()).toHaveLength(1);
    });

    it("takes live schemas and descriptions from the broker's tools op, in memory only", async () => {
      const schema = { type: "object", properties: { calendarId: { type: "string" } }, required: ["calendarId"] };
      broker = await startBroker((request) =>
        request.op === "tools"
          ? { v: 4, ok: true, tools: request.server === "calendar" ? [{ name: "list_events", description: "Returns events.\n\nLong details.", inputSchema: schema }] : [] }
          : okReply(),
      );
      const { factory, invoke } = register({ socketPath: broker.socketPath, rootDir });
      const before = factory.create({ sessionKey: kDmKey, senderIsOwner: true }).find((tool) => tool.name === "gw_calendar_list_events");
      expect(before.parameters).toEqual({ type: "object", additionalProperties: true });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const after = factory.create({ sessionKey: kDmKey, senderIsOwner: true }).find((tool) => tool.name === "gw_calendar_list_events");
      expect(after.parameters).toEqual(schema);
      expect(after.description).toMatch(/^Returns events\. Use the tool that matches/);
      const described = JSON.parse(textOf(await invoke({ toolName: "gw_describe", params: { server: "calendar", tool: "list_events" } })));
      expect(described).toMatchObject({ server: "calendar", tool: "list_events", writes: false, inputSchema: schema });
      const listed = JSON.parse(textOf(await invoke({ toolName: "gw_describe", params: { server: "docs" } })));
      expect(listed.tools.map((tool) => tool.tool)).toEqual(["read_doc", "update_doc"]);
      expect(broker.requests.filter((request) => request.op === "tools").every((request) => request.v === 4 && request.account === kOwner)).toBe(true);
      expect(fs.existsSync(path.join(rootDir, "google-workspace")) ? fs.readdirSync(path.join(rootDir, "google-workspace")).every((name) => name.startsWith("audit-")) : true).toBe(true);
    });
  });

  describe("retention", () => {
    it("keeps 30 days of audit lines, owner-only", () => {
      let clock = Date.parse("2026-11-25T12:00:00Z");
      const audit = createAudit({ rootDir, now: () => clock });
      audit.write({ product: "gmail", tool: "trash_thread", outcome: "ok" });
      const dir = path.join(rootDir, "google-workspace");
      fs.writeFileSync(path.join(dir, "audit-2026-10-25.jsonl"), "{}\n");
      fs.writeFileSync(path.join(dir, "audit-2026-10-27.jsonl"), "{}\n");
      fs.writeFileSync(path.join(dir, "notes.txt"), "x");
      expect(audit.prune()).toBe(1);
      expect(fs.readdirSync(dir).sort()).toEqual(["audit-2026-10-27.jsonl", "audit-2026-11-25.jsonl", "notes.txt"]);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(dir, "audit-2026-11-25.jsonl")).mode & 0o777).toBe(0o600);
      clock = Date.parse("2026-12-30T00:00:00Z");
      expect(audit.prune()).toBe(2);
    });
  });

  describe("openclaw.json entry", () => {
    const env = (accounts, extra = {}) => ({ ALPHACLAW_GOOGLE_WORKSPACE_ACCOUNTS: accounts, ...extra });

    it("is off until the deployment names an account", () => {
      expect(resolveDesiredGoogleWorkspaceEntry({ env: {}, rootDir: "/data" })).toBeNull();
      expect(resolveDesiredGoogleWorkspaceEntry({ env: env("not-an-email, ,"), rootDir: "/data" })).toBeNull();
      expect(resolveDesiredGoogleWorkspaceEntry({ env: env("Owner@Example.com, " + kSecond + "," + kOwner), rootDir: "/data" })).toEqual({
        enabled: true,
        config: { _alphaclawManaged: "google-workspace", rootDir: "/data", accounts: [kOwner, kSecond], toolSurface: "core" },
      });
      expect(resolveDesiredGoogleWorkspaceEntry({ env: env(kOwner, { ALPHACLAW_GOOGLE_WORKSPACE_TOOLS: "ALL", ALPHACLAW_GOOGLE_WORKSPACE_SOCKET: "/data/.gbrain/run/google.sock" }), rootDir: "/data" }).config).toMatchObject({ toolSurface: "all", socketPath: "/data/.gbrain/run/google.sock" });
      expect(resolveDesiredGoogleWorkspaceEntry({ env: env(kOwner, { ALPHACLAW_GOOGLE_WORKSPACE_SOCKET: "relative.sock" }), rootDir: "/data" }).config).not.toHaveProperty("socketPath");
    });

    it("adds and removes only its own entry, load path and allow", () => {
      const cfg = { plugins: { allow: ["telegram"], load: { paths: ["/old/lib/plugin/google-workspace"] }, entries: {} } };
      const desired = resolveDesiredGoogleWorkspaceEntry({ env: env(kOwner), rootDir: "/data" });
      expect(applyGoogleWorkspaceEntry(cfg, desired, { log: () => {} })).toEqual({ changed: true, conflict: false });
      expect(cfg.plugins.entries["google-workspace"]).toEqual(desired);
      expect(cfg.plugins.load.paths).toEqual([kGoogleWorkspacePluginPath]);
      expect(cfg.plugins.allow).toEqual(["telegram", "google-workspace", "memory-core"]);
      expect(applyGoogleWorkspaceEntry(cfg, desired, { log: () => {} }).changed).toBe(false);
      expect(applyGoogleWorkspaceEntry(cfg, null, { log: () => {} })).toEqual({ changed: true, conflict: false });
      expect(cfg.plugins.entries).toEqual({});
      expect(cfg.plugins.load.paths).toEqual([]);
      expect(cfg.plugins.allow).toEqual(["telegram", "memory-core"]);
      expect(applyGoogleWorkspaceEntry({}, null, { log: () => {} })).toEqual({ changed: false, conflict: false });
    });

    it("leaves an entry AlphaClaw does not own", () => {
      const cfg = { plugins: { entries: { "google-workspace": { enabled: true, config: { accounts: [kOwner] } } } } };
      const desired = resolveDesiredGoogleWorkspaceEntry({ env: env(kOwner), rootDir: "/data" });
      expect(applyGoogleWorkspaceEntry(cfg, desired, { log: () => {} })).toEqual({ changed: false, conflict: true });
      expect(applyGoogleWorkspaceEntry(cfg, null, { log: () => {} })).toEqual({ changed: false, conflict: false });
      expect(cfg.plugins.entries["google-workspace"]).toEqual({ enabled: true, config: { accounts: [kOwner] } });
    });

    it("keeps its settings out of the agent's reach", () => {
      for (const key of kGoogleWorkspaceEnvKeys) expect(kDeploymentOnlyEnvKeys, key).toContain(key);
      const rootDir2 = "/srv/alphaclaw";
      for (const command of ["echo ALPHACLAW_GOOGLE_WORKSPACE_ACCOUNTS=a@example.com >> /srv/alphaclaw/.env", "export ALPHACLAW_GOOGLE_WORKSPACE_SOCKET=/tmp/x.sock"]) {
        expect(classifyAnchor({ toolName: "exec", params: { command }, rootDir: rootDir2, agentId: "main" }), command).not.toBeNull();
      }
    });
  });

  describe("relay guard", () => {
    it("opens the Google tools to the owner's own thread only, whatever the operator's list says", () => {
      expect(kOwnerThreadGoogleWorkspaceTools).toEqual(catalog.kToolNames);
      const delegate = { tier: "delegate" };
      for (const toolName of ["gw_gmail_trash_thread", "gw_call", "gw_describe"]) {
        expect(decideRelayToolCall({ toolName, params: {}, trust: delegate, ownerThread: true })).toEqual({ allow: true });
        for (const delegateTools of [[], [toolName], ["gw_*"]]) {
          expect(decideRelayToolCall({ toolName, params: {}, trust: delegate, delegateTools, ownerThread: false }).allow).toBe(false);
          expect(decideRelayToolCall({ toolName, params: {}, trust: { tier: "peer" }, delegateTools, ownerThread: true }).allow).toBe(false);
        }
      }
      expect(decideRelayToolCall({ toolName: "gw_gmail_send_message", params: {}, trust: delegate, ownerThread: true }).allow).toBe(false);
    });
  });
});

describe("google-workspace owner gate in relay sessions (GST-3848)", () => {
  const { setup } = require("./helpers/relay-attested-harness");
  const gate = require("../../lib/plugin/google-workspace/gate");
  const kPinned = "capy-25cf4e98b5b6";
  const kOther = "capy-0a1b2c3d4e5f";
  let ctx;
  afterEach(() => ctx?.cleanup());

  it("admits the owner's pinned thread and refuses another delegate, whatever senderIsOwner says", async () => {
    ctx = setup({ env: { ALPHACLAW_RELAY_TRUSTED_BINDINGS: kPinned } });
    const owner = await ctx.deliver(ctx.oauthDelegate(kPinned).agent);
    const other = await ctx.deliver(ctx.oauthDelegate(kOther, { threadId: "jam_B" }).agent);
    expect(gate.ownerOf({ rootDir: ctx.rootDir, ...owner.ctx, senderIsOwner: false })).toEqual({ owner: true, basis: "relay_owner_thread" });
    expect(gate.ownerOf({ rootDir: ctx.rootDir, sessionKey: owner.ctx.sessionKey })).toMatchObject({ owner: true });
    expect(gate.ownerOf({ rootDir: ctx.rootDir, ...other.ctx, senderIsOwner: true })).toEqual({ owner: false, reason: "relay_not_owner_thread" });
    expect(gate.ownerOf({ rootDir: ctx.rootDir, sessionKey: "agent:main:telegram:direct:100", runId: "run-1", senderIsOwner: true })).toEqual({ owner: true, basis: "sender" });
    expect(gate.ownerOf({ rootDir: ctx.rootDir, sessionKey: "agent:main:telegram:group:-1001", runId: "run-2", senderIsOwner: false }).owner).toBe(false);
  });
});

