// One `openclaw gateway call <method>` helper for AlphaClaw's read paths into
// the gateway's RPC (sessions.list, sessions.recover, sessions.usage). The
// method and params are shell-quoted here, once, and stdout is parsed as one
// JSON document; a failed or unparsable call answers { ok: false } or a null
// body instead of throwing. clawCmd reads a maxBuffer overflow as a timeout,
// so callers that can receive large payloads keep their params narrow.
const { shellEscapeArg } = require("./agents/shared");

const kGatewayCallDefaultTimeoutMs = 20_000;

const parseJson = (text) => {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return null;
  }
};

const callGateway = async (clawCmd, method, params, { timeoutMs = kGatewayCallDefaultTimeoutMs } = {}) => {
  const result = await clawCmd(
    `gateway call ${shellEscapeArg(method)} --params ${shellEscapeArg(JSON.stringify(params))} --json`,
    { quiet: true, timeoutMs },
  );
  return { ok: !!result?.ok, body: parseJson(result?.stdout), stderr: String(result?.stderr || "") };
};

module.exports = { callGateway, kGatewayCallDefaultTimeoutMs };
