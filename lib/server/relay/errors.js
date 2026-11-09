// The one relay error table. MCP tools return these as isError results and
// routes as RFC 9457 problem bodies, so a caller always gets the same code,
// fix and retry guidance. Each anchor is a heading in
// lib/setup/skills/alphaclaw-admin/relay.md.
const kRelayErrors = Object.freeze({
  relay_disabled: {
    status: 503,
    title: "The relay is turned off",
    fix: "Set ALPHACLAW_RELAY=on in the deployment environment and restart AlphaClaw.",
    retry: "none",
  },
  platform_unsupported: {
    status: 503,
    title: "No relay engine build for this platform",
    fix: "Run AlphaClaw on Linux (x64 or arm64, glibc or musl) or macOS.",
    retry: "none",
  },
  engine_download_failed: {
    status: 503,
    title: "The relay engine could not be downloaded",
    fix: "Check that the box can reach github.com over HTTPS; AlphaClaw retries on its own.",
    retry: "automatic, backing off to 30 minutes",
  },
  engine_hash_mismatch: {
    status: 503,
    title: "The downloaded relay engine did not match its pinned hash",
    fix: "Nothing ran. AlphaClaw retries the download; if it keeps failing, report it (the release may have been replaced).",
    retry: "automatic, backing off to 30 minutes",
  },
  engine_unavailable: {
    status: 503,
    title: "The relay engine is not answering",
    fix: "AlphaClaw restarts it with backoff; its log is logs/sidecars/relay-engine.log in the AlphaClaw root.",
    retry: "automatic, backing off to 30 minutes",
  },
  provisioning_pending: {
    status: 503,
    title: "The relay is still starting",
    fix: "Wait for the Relay page to show ready.",
    retry: "after 5 seconds, at most 12 times",
  },
  provisioning_failed: {
    status: 503,
    title: "The relay could not create its workspace or agent",
    fix: "The detail names the engine's answer. AlphaClaw retries on its own; the Relay page shows the next attempt.",
    retry: "automatic, backing off to 30 minutes",
  },
  secrets_missing: {
    status: 503,
    title: "The relay database exists but its keys are missing",
    fix: "Restore relay/secrets.json from the same backup as relay/relaycast.db. AlphaClaw never creates a second workspace over existing history.",
    retry: "none",
  },
  recipient_unknown: {
    status: 404,
    title: "No relay agent has that name",
    fix: "Call relay_agents for the names on this relay.",
    retry: "none",
  },
  message_not_found: {
    status: 404,
    title: "No relay message has that id",
    fix: "Use an id from relay_inbox or relay_history.",
    retry: "none",
  },
  invalid_input: {
    status: 400,
    title: "The request is missing a field or has a bad value",
    fix: "Check the tool or route schema.",
    retry: "none",
  },
  rate_limited: {
    status: 429,
    title: "Too many relay requests from this sender this hour",
    fix: "Wait for the hour to roll over, or batch questions into one message.",
    retry: "after the window resets",
  },
  hop_limit: {
    status: 409,
    title: "The message has been relayed too many times",
    fix: "Agents are answering each other in a loop; start a new message instead of replying to a reply.",
    retry: "none",
  },
  run_failed: {
    status: 502,
    title: "The agent run failed",
    fix: "Send the request again; if it keeps failing, check the model on the Models tab.",
    retry: "once",
  },
  run_interrupted: {
    status: 502,
    title: "The agent run was cut off, for example by a gateway restart",
    fix: "Send the request again.",
    retry: "once",
  },
  outcome_unknown: {
    status: 502,
    title: "The gateway may or may not have started the run",
    fix: "Read the conversation with relay_history before sending again, so the agent does not do the work twice.",
    retry: "never automatically",
  },
  remote_disabled: {
    status: 404,
    title: "Remote access to the relay is turned off",
    fix: "Set ALPHACLAW_RELAY_REMOTE=on (or remove it) in the deployment environment and restart AlphaClaw.",
    retry: "none",
  },
  public_url_missing: {
    status: 503,
    title: "AlphaClaw does not know its public HTTPS address",
    fix: "Set ALPHACLAW_SETUP_URL to the box's public https:// URL in the deployment environment and restart AlphaClaw.",
    retry: "none",
  },
  not_bound: {
    status: 403,
    title: "This thread has no relay binding",
    fix: "Call relay_bind with your thread id and a webhook URL first, and pass the agent name and capability it returned.",
    retry: "none",
  },
  binding_capability_invalid: {
    status: 403,
    title: "The binding capability does not match",
    fix: "Pass the capability relay_bind returned for this agent. A lost capability cannot be recovered: ask the owner to remove the binding on the Relay page, then bind again.",
    retry: "none",
  },
  prefix_denied: {
    status: 403,
    title: "This connection may only act as its own capy- agents",
    fix: "Act as the agent relay_bind returned; other agents' names are refused.",
    retry: "none",
  },
  binding_limit: {
    status: 429,
    title: "Too many active bindings for this connection",
    fix: "Unbind unused threads (relay_unbind) or ask the owner to remove some; the limit is ALPHACLAW_RELAY_MAX_BINDINGS_PER_CLIENT (default 20).",
    retry: "after a binding is removed",
  },
  route_required: {
    status: 403,
    title: "This grant requires the tailnet route",
    fix: "Call over the box's tailnet address, not its public URL.",
    retry: "none",
  },
  generation_stale: {
    status: 409,
    title: "The binding was handed to another thread",
    fix: "A successor uses the capability relay_claim returned; the old holder asks for a new handoff.",
    retry: "none",
  },
  handoff_invalid: {
    status: 403,
    title: "That handoff code does not work",
    fix: "A code works once, for an hour, for the thread it named; ask the holder for a new one.",
    retry: "none",
  },
  handoff_conflict: {
    status: 409,
    title: "This thread already has a binding",
    fix: "Unbind this thread's own agent (relay_unbind), then claim.",
    retry: "after relay_unbind",
  },
  lane_limit: {
    status: 429,
    title: "This agent already uses all its lanes",
    fix: "Use a busy lane or wait for one to finish; the grant sets the count (default 3).",
    retry: "after a lane finishes",
  },
  result_not_found: {
    status: 404,
    title: "No long answer with that result_ref",
    fix: "Pass a result_ref from a reply to this agent; parts expire with the messages.",
    retry: "none",
  },
  relay_guard_missing: {
    status: 503,
    title: "The relay guard plugin is not loaded, so relay messages wait",
    fix: "Restart the gateway; if it stays missing, check plugins.entries.relay-guard and plugins.deny in openclaw.json and the gateway log.",
    retry: "automatic, every 30 s",
  },
  wake_url_refused: {
    status: 400,
    title: "The wake webhook URL is not allowed",
    fix: "Pass a Capy webhook URL (https://api.capy.ai/...) minted by this thread. Other hosts need ALPHACLAW_RELAY_WAKE_HOSTS in the deployment environment.",
    retry: "none",
  },
  masking_unavailable: {
    status: 503,
    title: "AlphaClaw could not mask this message, so it was not sent",
    fix: "The relay tools mask every outgoing message through AlphaClaw's own server first; send again once AlphaClaw is up.",
    retry: "safe to retry",
  },
  engine_error: {
    status: 502,
    title: "The relay engine rejected the request",
    fix: "The detail names the engine's error code.",
    retry: "none",
  },
});

class RelayError extends Error {
  constructor(code, detail = "") {
    const entry = kRelayErrors[code] || kRelayErrors.engine_error;
    super(detail ? String(detail) : entry.title);
    this.name = "RelayError";
    this.code = kRelayErrors[code] ? code : "engine_error";
    this.status = entry.status;
  }
}

const describeRelayError = (code, detail = "") => {
  const key = kRelayErrors[code] ? code : "engine_error";
  const entry = kRelayErrors[key];
  return {
    code: key,
    title: entry.title,
    detail: String(detail || entry.title),
    fix: entry.fix,
    retry: entry.retry,
    doc: "relay.md#" + key,
  };
};

const toRelayError = (error) =>
  error instanceof RelayError ? error : new RelayError("engine_error", error?.message || String(error));

const sendRelayProblem = (res, error) => {
  const relayError = toRelayError(error);
  const described = describeRelayError(relayError.code, relayError.message);
  res
    .status(relayError.status)
    .type("application/problem+json")
    .json({
      type: "https://github.com/garrytan/alphaclaw/blob/main/lib/setup/skills/alphaclaw-admin/" + described.doc,
      title: described.title,
      status: relayError.status,
      detail: described.detail,
      code: described.code,
      fix: described.fix,
      retry: described.retry,
    });
};

const toMcpError = (error) => {
  const relayError = toRelayError(error);
  const described = describeRelayError(relayError.code, relayError.message);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: described.code, detail: described.detail, fix: described.fix, retry: described.retry }),
      },
    ],
  };
};

module.exports = { kRelayErrors, RelayError, describeRelayError, toRelayError, sendRelayProblem, toMcpError };
