const { redactSecretText } = require("../../utils/redact");

// The one AlphaClaw path that deletes an agent: OpenClaw's own agents.delete
// gateway method, so the serving gateway removes the config entry, cron jobs,
// exec approvals, session rows and files under its own locks. `gateway call`
// only talks to the gateway; unlike `agents delete`, it never falls back to
// removing files from the CLI process. deleteFiles is always true:
// deleteFiles:false keeps the database registered, and Doctor then warns
// about it on every run.
const parseSingleJson = (text) => {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

const tail = (text, bytes = 400) => redactSecretText(String(text || "").trim().slice(-bytes));

// → { kind: "ok", body } | { kind: "error", code, message } | { kind: "none", detail }
const callAgentsDelete = async ({ execFileCmd, env, agentId, timeoutMs }) => {
  const args = [
    "gateway",
    "call",
    "agents.delete",
    "--params",
    JSON.stringify({ agentId, deleteFiles: true }),
    "--json",
    "--timeout",
    String(timeoutMs),
  ];
  try {
    const stdout = await execFileCmd("openclaw", args, {
      env,
      processGroup: true,
      timeoutMs: timeoutMs + 30_000,
    });
    const body = parseSingleJson(stdout);
    if (!body) return { kind: "none", detail: "OpenClaw's answer was not readable" };
    if (body.ok === false) {
      return { kind: "error", code: String(body.error?.code || ""), message: tail(body.error?.message || "", 600) };
    }
    return { kind: "ok", body };
  } catch (error) {
    if (error?.timedOut || error?.cancelled || error?.killed) {
      return { kind: "none", detail: "the call timed out" };
    }
    const body = parseSingleJson(error?.stdout);
    if (body?.ok === false) {
      return { kind: "error", code: String(body.error?.code || ""), message: tail(body.error?.message || "", 600) };
    }
    return { kind: "none", detail: tail(error?.stderr || error?.message || "the call failed") };
  }
};

// The fields of a successful answer worth keeping (manifest, op record).
const summarizeAnswer = (answer) => {
  if (answer.kind === "ok") {
    const removed = Array.isArray(answer.body.removed) ? answer.body.removed : [];
    const failed = Array.isArray(answer.body.failed) ? answer.body.failed : [];
    return {
      kind: "ok",
      removedBindings: Number(answer.body.removedBindings) || 0,
      removed: removed.map((entry) => ({ path: String(entry?.path || ""), method: String(entry?.method || "") })),
      failed: failed.map((entry) => ({ path: String(entry?.path || ""), error: tail(entry?.error || entry?.message || "", 200) })),
      purgeFailed: answer.body.purgeFailed === true,
    };
  }
  if (answer.kind === "error") return { kind: "error", code: answer.code, message: answer.message };
  return { kind: "none", detail: answer.detail };
};

module.exports = { callAgentsDelete, summarizeAnswer, parseSingleJson };
