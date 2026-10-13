// Verbatim OpenClaw 2026.10.2 LocalStateOwnerError messages
// (dist/local-state-owner-*.mjs). OWNER_UNAVAILABLE was captured from the real
// CLI (`approvals get --json` against a state dir whose owner lock payload is
// unreadable); the other two follow the same template's fixed sentences.
const kGuidance =
  "Update the Gateway or fix authentication and retry. To run offline, stop the Gateway through its service owner, wait for ownership to release, then rerun this exact command.";
const kOwnerUnavailable = `Cannot admit exec.approvals.get for default exec approvals in state root /data/.openclaw: Gateway lock inspection is unavailable | Gateway lock payload could not be verified. No local mutation was attempted. Inspect openclaw gateway status. ${kGuidance}`;
const kOwnerRefused = `Gateway owning /data/.openclaw on local port 18789 could not complete exec.approvals.set for default exec approvals: gateway closed (1012): service restart. No local mutation was attempted. ${kGuidance}`;
const kOutcomeUnknown =
  "Gateway owning /data/.openclaw on local port 18789 could not complete exec.approvals.set for default exec approvals: gateway closed (1006). The outcome may be partial; inspect openclaw approvals get --json and the target before retrying. No local fallback was attempted.";
const kJsonEnvelope = (message) =>
  JSON.stringify({ ok: false, error: { type: "cli_error", message } }, null, 2);

module.exports = { kOwnerUnavailable, kOwnerRefused, kOutcomeUnknown, kJsonEnvelope };
