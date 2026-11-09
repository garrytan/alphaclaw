const http = require("http");
const os = require("os");
const path = require("path");
const { readToken } = require("../../server/agent-admin/token-store");

// AlphaClaw's /secret command (GST-1956 PR 2): the owner types
// "/secret GITHUB_TOKEN" in a chat and gets the secret drop's one-time link
// back. OpenClaw runs a plugin command without the model, so the name never
// reaches a turn. requiredScopes ["operator.admin"] keeps it to the owner on
// chat surfaces (commands.ownerAllowFrom) and to admin gateway clients; any
// other paired chat gets OpenClaw's scope refusal before this handler runs.
// The link is minted by AlphaClaw's POST /api/secrets/requests with the agent
// admin bearer. A value typed after the name is never sent to AlphaClaw: the
// handler answers and tells the person to delete the message, on every path.
// OpenClaw still writes the whole command line to the session transcript
// (openclaw-agent.sqlite) and sends it to the model provider with the
// session's next ordinary message, so the reply says to send /new first. The
// plugin registers no hook to prevent that: any before_message_write hook
// makes OpenClaw skip restart-safe chat admission for every turn. A name needs
// an _, which no base32 seed (A-Z, 2-7) has, so a lone pasted seed is refused
// as a value. args and commandBody may hold a value, so nothing here logs
// them; logs carry a valid name only.
const kPluginId = "secret-drop";
const kLogPrefix = "[secret-drop]";
const kNamePattern = /^(?=[A-Z0-9_]*_)[A-Z][A-Z0-9_]{0,127}$/;
const kAdminScope = "operator.admin";
const kRequestTimeoutMs = 10_000;
const kMaxResponseBytes = 64 * 1024;

const kUsage = "Usage: /secret NAME (for example /secret GITHUB_TOKEN). You get a one-time link to paste the value into AlphaClaw; the value never goes in chat.";
const kInlineValueWarning =
  "It is still in this chat and in this session's history, so it will reach the model provider with your next message unless you send /new first to start a new session. Delete that message now (Telegram: long-press it, then Delete).";
const kValueNotSaved = (name) => "Values never go in chat: what you typed after " + name + " was not saved. " + kInlineValueWarning;
const kNotAName =
  "That is not a variable name: use uppercase letters, digits and at least one _, starting with a letter (for example /secret GITHUB_TOKEN). For a name without an _, use AlphaClaw's Envars page. Nothing was requested or saved. If you typed a secret value, it was not saved. " + kInlineValueWarning;
const kNotOwner = "Only the owner can ask for a secret link.";
const kOwnerChanged = "Your owner access changed while this ran, so nothing was requested.";
const kNoToken = "Agent Administration is off, so AlphaClaw cannot make the link: turn it on in AlphaClaw's Integrations page, then send /secret again.";
const kTooMany = "Too many secret links are open already. Use one or wait for one to expire (they last 15 minutes), then try again.";
const kUnreachable = "AlphaClaw is not answering right now, so no link was made. Try again in a minute.";
const kTimedOut = "AlphaClaw did not answer in time, so no link came back. If one was made, it expires unused in 15 minutes. Try again in a minute.";
const kFailed = "The secret link could not be made. Nothing was requested; try again in a minute.";

const splitArgs = (text) => String(text || "").trim().split(/\s+/).filter(Boolean);

const resolveSettings = (pluginConfig) => {
  const config = pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {};
  const rootDir = process.env.ALPHACLAW_ROOT_DIR || path.join(os.homedir(), ".alphaclaw");
  const port = Number.parseInt(String(config.port || process.env.PORT || "3000"), 10);
  return {
    openclawDir: String(config.openclawDir || path.join(rootDir, ".openclaw")),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 3000,
  };
};

const postJson = ({ port, urlPath, token, body, timeoutMs }) =>
  new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: urlPath,
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size <= kMaxResponseBytes) chunks.push(chunk);
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {}
          resolve({ status: res.statusCode, json });
        });
        res.on("error", () => resolve({ unreachable: true }));
      },
    );
    req.on("error", () => resolve({ unreachable: true }));
    req.setTimeout(timeoutMs, () => {
      resolve({ timedOut: true });
      req.destroy();
    });
    req.end(payload);
  });

const createSecretDropPlugin = ({ readAgentToken = readToken, post = postJson, timeoutMs = kRequestTimeoutMs } = {}) => ({
  id: kPluginId,
  name: "AlphaClaw Secret Drop",
  description: "Adds /secret NAME: the owner gets a one-time AlphaClaw link to store a secret without putting it in chat",
  register: (api) => {
    const logger = api?.logger;
    const settings = resolveSettings(api?.pluginConfig);

    const mint = async (ctx, parts, assertOwnerCurrent) => {
      const adminClient = Array.isArray(ctx?.gatewayClientScopes) && ctx.gatewayClientScopes.includes(kAdminScope);
      if (parts.length === 0) return { text: kUsage };
      const name = parts[0];
      const valueTyped = parts.length > 1;
      if (!kNamePattern.test(name)) {
        logger?.warn?.(kLogPrefix + " /secret refused: the argument is not a variable name; nothing requested");
        return { text: kNotAName };
      }
      if (!assertOwnerCurrent && !adminClient) {
        logger?.warn?.(kLogPrefix + " /secret refused name=" + name + ": sender is not the owner");
        return { text: kNotOwner };
      }
      const token = readAgentToken({ openclawDir: settings.openclawDir });
      if (!token) {
        logger?.warn?.(kLogPrefix + " /secret name=" + name + ": no agent admin token (Agent Administration off)");
        return { text: kNoToken };
      }
      try {
        assertOwnerCurrent?.();
      } catch {
        logger?.warn?.(kLogPrefix + " /secret refused name=" + name + ": owner authority no longer current");
        return { text: kOwnerChanged };
      }
      const result = await post({
        port: settings.port,
        urlPath: "/api/secrets/requests",
        token,
        body: { name, reason: "requested with /secret" },
        timeoutMs,
      });
      if (result.timedOut) {
        logger?.warn?.(kLogPrefix + " /secret name=" + name + ": AlphaClaw did not answer within " + timeoutMs + "ms");
        return { text: kTimedOut };
      }
      if (result.unreachable) {
        logger?.warn?.(kLogPrefix + " /secret name=" + name + ": AlphaClaw unreachable on port " + settings.port);
        return { text: kUnreachable };
      }
      const url = typeof result.json?.url === "string" ? result.json.url : "";
      if (result.status === 201 && url) {
        logger?.info?.(kLogPrefix + " /secret link made name=" + name + " id=" + String(result.json?.request?.id || "?") + (valueTyped ? " (text after the name ignored)" : ""));
        return { text: url + "\nOpen it signed in to AlphaClaw. It works once, for 15 minutes." };
      }
      logger?.warn?.(kLogPrefix + " /secret name=" + name + ": AlphaClaw answered " + result.status + (result.json?.code ? " code=" + result.json.code : ""));
      if (result.status === 429) return { text: kTooMany };
      if (result.status === 400) {
        const reason = typeof result.json?.error === "string" && result.json.error.trim() ? result.json.error.trim() : "AlphaClaw refused that name.";
        return { text: "No link for " + name + ": " + reason };
      }
      if (result.status === 401 || result.status === 403) {
        return { text: "AlphaClaw refused the agent administration token (HTTP " + result.status + "). Check that Agent Administration is on in AlphaClaw's Integrations page." };
      }
      return { text: "AlphaClaw could not make the link (HTTP " + result.status + "). Nothing was requested; try again in a minute." };
    };

    api.registerCommand({
      name: "secret",
      description: "Get a one-time AlphaClaw link to store a secret (values never go in chat)",
      acceptsArgs: true,
      requiredScopes: [kAdminScope],
      handler: async (ctx) => {
        const assertOwnerCurrent = typeof ctx?.assertOwnerCurrent === "function" ? ctx.assertOwnerCurrent : null;
        const parts = splitArgs(ctx?.args);
        const valueAfterName = parts.length > 1 && kNamePattern.test(parts[0]);
        let reply;
        try {
          reply = await mint(ctx, parts, assertOwnerCurrent);
        } catch (error) {
          logger?.error?.(kLogPrefix + " /secret failed: " + String(error?.code || error?.name || "error"));
          reply = { text: kFailed };
        }
        return valueAfterName ? { text: reply.text + "\n" + kValueNotSaved(parts[0]) } : reply;
      },
    });
    logger?.info?.(kLogPrefix + " active: /secret NAME (owner only) asks AlphaClaw on port " + settings.port);
  },
});

const plugin = createSecretDropPlugin();
module.exports = plugin;
module.exports.default = plugin;
module.exports.createSecretDropPlugin = createSecretDropPlugin;
module.exports.kSecretDropPluginId = kPluginId;
