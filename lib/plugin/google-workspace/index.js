// AlphaClaw's Google Workspace plugin (GST-3848): the owner's Google
// Workspace (Gmail, Calendar, Drive, Docs, Sheets, Slides, Tasks) as agent
// tools, through GBrain's broker socket, which holds every Google token and
// makes every Google call (contract v4). This plugin holds no token and no
// Google client; it decides who may call, shapes the tools and maps the
// broker's answers.
//
// Who: only the owner's own turns (gate.js). A tool factory returns nothing
// for anyone else, and before_tool_call refuses every other call, wrapped by
// OpenClaw's dispatcher or not, before anything reaches the socket. A call
// runs only with the admission its own before_tool_call wrote (by tool call
// id), so a path that skipped the hook is refused too.
//
// Approvals: on the owner's turn a Google approval prompt is answered once
// with ALLOW_ONCE (the owner's standing "do it"). The broker's safety pauses
// (a second outside invite or share in one turn, more than 10 trashes) come
// back as gw_owner_confirm, which the owner confirms outside the gateway.
const os = require("os");
const path = require("path");

const catalog = require("./catalog");
const { createBrokerClient, resolveSocketPath } = require("./broker");
const { createCaller } = require("./call");
const { createAudit } = require("./audit");
const { errorResult } = require("./errors");
const defaultGate = require("./gate");

const kPluginId = "google-workspace";
const kMarker = "[google-workspace]";
const kSchemaTtlMs = 60 * 60 * 1000;
const kAdmissionTtlMs = 10 * 60 * 1000;
const kMaxAdmissions = 500;
const kDayMs = 24 * 60 * 60 * 1000;
const kDescriptionMax = 600;
const kRules = " Use the tool that matches what the owner asked for. If Google reports a declined approval, stop and do not retry.";
const kDispatchers = Object.freeze(["dispatch_action", "tool_call"]);
const kEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const accountsOf = (value) =>
  [...new Set((Array.isArray(value) ? value : []).map((entry) => String(entry || "").trim().toLowerCase()).filter((entry) => kEmailPattern.test(entry)))];

// The gw_ tool a dispatcher call reaches, from its params, or null. OpenClaw
// 2026.11.4's dispatch_action (2026.10.9's tool_call) takes the target by
// id, toolId or name, at the top or nested under args or input, as the bare
// tool name or a catalog id "openclaw:google-workspace:<name>"
// (tool-search: TOOL_SEARCH_SELECTOR_KEYS, toCatalogEntry). The tool it
// reaches runs through before_tool_call again under its own name.
const kSelectorKeys = Object.freeze(["id", "toolId", "name", "tool", "toolName", "tool_name"]);
const dispatchedToolOf = (params) => {
  const records = [params, params?.args, params?.input].filter((record) => record && typeof record === "object" && !Array.isArray(record));
  for (const record of records) {
    for (const key of kSelectorKeys) {
      const value = record[key];
      if (typeof value !== "string") continue;
      const name = value.trim().split(":").pop().toLowerCase();
      if (catalog.isGoogleWorkspaceTool(name)) return name;
    }
  }
  return null;
};

const permissive = Object.freeze({ type: "object", additionalProperties: true });

const createGoogleWorkspacePlugin = ({ gate = defaultGate, createBroker = createBrokerClient, now = Date.now, env = process.env, homedir = os.homedir } = {}) => ({
  id: kPluginId,
  name: "AlphaClaw Google Workspace",
  description: "The owner's Google Workspace as agent tools on the owner's own turns, through GBrain's broker",
  register: (api) => {
    const logger = api?.logger;
    const pluginConfig = api?.pluginConfig && typeof api.pluginConfig === "object" ? api.pluginConfig : {};
    const rootDir = String(pluginConfig.rootDir || env.ALPHACLAW_ROOT_DIR || path.join(homedir(), ".alphaclaw"));
    const accounts = accountsOf(pluginConfig.accounts);
    const surface = pluginConfig.toolSurface === "all" ? "all" : "core";
    const socketPath = resolveSocketPath({ socketPath: pluginConfig.socketPath, env, homedir: homedir() });
    const audit = createAudit({ rootDir, now, logger });
    audit.prune();
    const pruneTimer = setInterval(() => audit.prune(), kDayMs);
    pruneTimer.unref?.();

    // Calls and the tools lookups use separate connections, so a slow
    // schema fetch never queues ahead of a call.
    const callBroker = createBroker({ socketPath });
    const toolsBroker = createBroker({ socketPath, timeoutMs: 15_000 });
    const schemas = new Map();
    const fetching = new Map();
    const fetchSchemas = (server) => {
      if (fetching.has(server)) return fetching.get(server);
      const run = toolsBroker
        .request({ op: "tools", account: accounts[0], server })
        .then((answer) => {
          const list = answer.reply?.ok === true && Array.isArray(answer.reply.tools) ? answer.reply.tools : null;
          if (!list) return null;
          const byName = new Map();
          for (const tool of list) {
            if (!tool || typeof tool.name !== "string") continue;
            byName.set(tool.name, {
              description: typeof tool.description === "string" ? tool.description : "",
              inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema) ? tool.inputSchema : permissive,
            });
          }
          schemas.set(server, { at: now(), byName });
          return byName;
        })
        .catch(() => null)
        .finally(() => fetching.delete(server));
      fetching.set(server, run);
      return run;
    };
    const freshSchemas = (server) => {
      const entry = schemas.get(server);
      return entry && now() - entry.at < kSchemaTtlMs ? entry.byName : null;
    };
    const warm = (servers) => {
      for (const server of servers) if (!freshSchemas(server)) fetchSchemas(server);
    };

    const caller = createCaller({
      broker: callBroker,
      audit,
      logger,
      noticeAt: Number(pluginConfig.dailyNoticeAt) > 0 ? Number(pluginConfig.dailyNoticeAt) : 1200,
      stopAt: Number(pluginConfig.dailyStopAt) > 0 ? Number(pluginConfig.dailyStopAt) : 1500,
      now,
      onRevoked: () => logger?.warn?.(kMarker + " Google access was revoked for a configured account; calls stop until the owner reconnects it"),
    });

    // Admissions: tool call id -> { runId, at }, written by before_tool_call
    // for an owner's call and taken once by that call's execute.
    const admissions = new Map();
    const admit = (toolCallId, runId) => {
      if (admissions.size >= kMaxAdmissions) admissions.delete(admissions.keys().next().value);
      admissions.set(toolCallId, { runId, at: now() });
    };
    const takeAdmission = (toolCallId) => {
      const entry = admissions.get(toolCallId);
      admissions.delete(toolCallId);
      return entry && now() - entry.at < kAdmissionTtlMs ? entry : null;
    };

    if (!accounts.length) {
      logger?.warn?.(kMarker + " no Google account is configured (ALPHACLAW_GOOGLE_WORKSPACE_ACCOUNTS); no tools registered");
      return;
    }

    const names = surface === "all" ? catalog.kToolNames : [...catalog.kCoreTools, ...catalog.kHelperTools];
    const servers = surface === "all" ? catalog.kServers : [...new Set(catalog.kCoreTools.map((name) => catalog.entryOf(name).server))];

    const accountParam = accounts.length > 1 ? { account: { type: "string", enum: accounts, description: "The Google account; leave out for " + accounts[0] + "." } } : null;
    const withAccount = (schema) => {
      if (!accountParam) return schema;
      const base = schema && typeof schema === "object" ? schema : permissive;
      return { ...base, type: "object", properties: { ...(base.properties || {}), ...accountParam } };
    };
    const resolveAccount = (params) => {
      if (accounts.length === 1) return { account: accounts[0], args: params };
      const { account, ...args } = params || {};
      if (account === undefined || account === null || account === "") return { account: accounts[0], args };
      const wanted = String(account).trim().toLowerCase();
      return accounts.includes(wanted) ? { account: wanted, args } : { error: errorResult("gw_bad_account") };
    };

    const runCall = async ({ entry, params, admission, ctx, signal }) => {
      const resolved = resolveAccount(params && typeof params === "object" ? params : {});
      if (resolved.error) return resolved.error;
      return caller.callTool({
        account: resolved.account,
        server: entry.server,
        tool: entry.tool,
        args: resolved.args,
        turnId: admission.runId || "session:" + String(ctx?.sessionId || ctx?.sessionKey || "unknown"),
        assertCurrent: () => ctx?.assertInvocationCurrent?.(),
        signal,
      });
    };

    const describeTool = async ({ server, tool }) => {
      const product = String(server || "").trim().toLowerCase();
      if (!catalog.kServers.includes(product)) return errorResult("gw_unknown_tool");
      if (!tool) {
        const listed = catalog.kTools.filter((entry) => entry.server === product).map((entry) => ({ tool: entry.tool, writes: entry.write, summary: entry.summary }));
        return { content: [{ type: "text", text: JSON.stringify({ server: product, tools: listed }) }], details: { status: "ok" } };
      }
      const entry = catalog.entryFor(product, tool);
      if (!entry) return errorResult("gw_unknown_tool");
      const live = freshSchemas(product) || (await fetchSchemas(product));
      const schema = live?.get(entry.tool);
      const text = JSON.stringify({ server: product, tool: entry.tool, writes: entry.write, description: schema?.description?.slice(0, 4000) || entry.summary, inputSchema: schema?.inputSchema || null });
      return { content: [{ type: "text", text }], details: { status: "ok" } };
    };

    const buildTool = (name, ctx) => {
      const execute = async (toolCallId, params, signal) => {
        const admission = takeAdmission(toolCallId);
        if (!admission) return errorResult("gw_not_owner");
        if (name === "gw_describe") return describeTool(params || {});
        if (name === "gw_check_outcome") {
          const ref = typeof params?.ref === "string" ? params.ref.trim() : "";
          if (!ref) return errorResult("gw_unknown_tool");
          return caller.checkOutcome({ ref, assertCurrent: () => ctx?.assertInvocationCurrent?.(), signal });
        }
        if (name === "gw_call") {
          const entry = catalog.entryFor(params?.server, params?.tool);
          if (!entry) return errorResult("gw_unknown_tool");
          const args = params?.args && typeof params.args === "object" && !Array.isArray(params.args) ? params.args : {};
          return runCall({ entry, params: params?.account !== undefined ? { ...args, account: params.account } : args, admission, ctx, signal });
        }
        return runCall({ entry: catalog.entryOf(name), params, admission, ctx, signal });
      };
      if (name === "gw_describe") {
        return {
          name,
          label: "Google Workspace: describe",
          description: "List a Google Workspace product's tools, or show one tool's inputs. Products: " + catalog.kServers.join(", ") + ".",
          parameters: { type: "object", properties: { server: { type: "string", enum: [...catalog.kServers] }, tool: { type: "string" } }, required: ["server"], additionalProperties: false },
          execute,
        };
      }
      if (name === "gw_call") {
        return {
          name,
          label: "Google Workspace: call",
          description: "Call any Google Workspace tool by product and tool name; use gw_describe first for its inputs." + kRules,
          parameters: {
            type: "object",
            properties: {
              server: { type: "string", enum: [...catalog.kServers] },
              tool: { type: "string" },
              args: { type: "object", additionalProperties: true },
              ...(accountParam || {}),
            },
            required: ["server", "tool"],
            additionalProperties: false,
          },
          execute,
        };
      }
      if (name === "gw_check_outcome") {
        return {
          name,
          label: "Google Workspace: check outcome",
          description: "After gw_outcome_unknown, ask GBrain whether that call happened, by the Ref it gave. Never repeats the call.",
          parameters: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"], additionalProperties: false },
          execute,
        };
      }
      const entry = catalog.entryOf(name);
      const live = freshSchemas(entry.server)?.get(entry.tool);
      const description = (live?.description ? live.description.trim().split(/\n\s*\n/)[0].slice(0, kDescriptionMax) : entry.summary) + kRules;
      return { name, label: "Google " + entry.server + ": " + entry.tool.replace(/_/g, " "), description, parameters: withAccount(live?.inputSchema || permissive), execute };
    };

    api.registerTool(
      {
        contextVersion: 2,
        create(ctx) {
          if (!gate.ownerOf({ rootDir, sessionKey: ctx?.sessionKey, senderIsOwner: ctx?.senderIsOwner }).owner) return null;
          warm(servers);
          return names.map((name) => buildTool(name, ctx));
        },
      },
      { names: [...names] },
    );

    api.on(
      "before_tool_call",
      (event, ctx) => {
        const toolName = String(event?.toolName || ctx?.toolName || "").trim().toLowerCase();
        const direct = catalog.isGoogleWorkspaceTool(toolName);
        const wrapped = !direct && kDispatchers.includes(toolName) ? dispatchedToolOf(event?.params) : null;
        if (!direct && !wrapped) return undefined;
        const sessionKey = ctx?.sessionKey;
        const runId = ctx?.runId || event?.runId;
        let verdict;
        try {
          verdict = gate.ownerOf({ rootDir, sessionKey, runId, senderIsOwner: ctx?.requester?.senderIsOwner });
        } catch {
          verdict = { owner: false, reason: "owner_check_failed" };
        }
        if (!verdict.owner) {
          logger?.warn?.(kMarker + " refused tool=" + (wrapped || toolName) + (wrapped ? " via=" + toolName : "") + " reason=" + verdict.reason);
          return { block: true, blockReason: errorResult("gw_not_owner").content[0].text };
        }
        const toolCallId = event?.toolCallId;
        if (direct && toolCallId) admit(toolCallId, typeof runId === "string" ? runId : "");
        return undefined;
      },
      { priority: 100 },
    );

    logger?.info?.(kMarker + " active: " + names.length + " tools (" + surface + ") for " + accounts.length + " account(s), owner turns only");
  },
});

const plugin = createGoogleWorkspacePlugin();
module.exports = plugin;
module.exports.default = plugin;
module.exports.createGoogleWorkspacePlugin = createGoogleWorkspacePlugin;
module.exports.kGoogleWorkspacePluginId = kPluginId;
module.exports.dispatchedToolOf = dispatchedToolOf;
