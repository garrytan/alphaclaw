# TODOS

## P1 — Narrow gatewayEnv secret spread
- **What:** `gatewayEnv()` (lib/server/gateway.js) spreads the full `process.env` into the OpenClaw gateway child, so the agent's shell inherits `SETUP_PASSWORD` and every provider key. Replace the spread with an explicit allowlist of what the gateway/agent actually needs.
- **Why:** This is the reason Agent Administration is "not a security boundary against the agent" — the agent can bypass every tier by curl-logging in with the inherited password. Narrowing this env is the single change that would turn the agent-admin tiers into a real boundary.
- **Context:** Documented in the agent-admin design doc's threat model (docs/designs/agent-admin.md). Large blast radius — every gateway child-process contract changes; needs its own review.
- **Effort:** M. **Depends on:** an inventory of which env keys the gateway/agent tools actually read.

## P2 — Agent-admin: manifest → MCP tool export (E1)
- **What:** Emit the agent-admin operation manifest as MCP tool definitions so other assistants can drive AlphaClaw with the same tiers/redaction.
- **Why:** The manifest is already the single source of truth; an MCP projection makes AlphaClaw administrable by any MCP client, not just the bundled skill.
- **Context:** lib/server/admin-manifest/ (serializeOp is the projection point). Deferred from the agent-admin CEO review.
- **Effort:** M.

## P2 — Agent-admin: server-side dry-run for admin ops (E3)
- **What:** A `?dryRun=1` (or `X-AlphaClaw-Dry-Run`) mode that validates + reports the effect of a write without applying it. The prompt-level preview rule (read-state-then-apply) ships now; this is the server-enforced version.
- **Context:** Needs per-handler cooperation; would slot into the enforcement middleware + each mutating route. Deferred from CEO review.
- **Effort:** M.

## P2 — Agent-admin: scoped undo (E6/U4.7)
- **What:** `POST /api/admin/undo-last` + `GET /api/admin/undo-candidate` with single-slot pre-write snapshots of `.env`/`alphaclaw.json`, replayed THROUGH the server write paths (never raw file copies) with a content-hash guard against undoing a later change.
- **Why:** "Undo that" is the highest-trust conversational admin flow. Deferred at implementation time: a correct replay requires extracting the inline `PUT /api/env` write logic (system.js:557-593, incl. reserved-key pre-strip and managed-key preservation) into a callable service — flagged by both the spec and eng reviews as the riskiest sub-feature.
- **Context:** The admin route handlers already exist, dormant behind `if (undoService)` in lib/server/routes/admin.js; the manifest ops were removed to avoid a manifest/route mismatch. Re-add the two ops + `undoable: true` on env.update when the service lands.
- **Effort:** M.

## P3 — Agent-admin: scheduled restarts (E5)
- **What:** "apply now, restart at 3am" for restart-tier changes. Deferred from CEO review — new scheduler semantics.
- **Effort:** M.

## P3 — Agent-admin: dedicated activity UI panel (E7)
- **What:** A richer operator view of the agent_admin audit trail than the shared Watchdog events tab (which covers it today). `GET /api/admin/audit?summary=1` already provides the error-rate metric.
- **Effort:** M.

## P3 — Agent-admin: per-domain CLI sugar verbs
- **What:** Task-shaped wrappers (e.g. `alphaclaw admin rotate-key`) over the generic `alphaclaw admin <METHOD> <path>` verb, IF observed agent error rates warrant. Gate the decision on `GET /api/admin/audit?summary=1` (A34).
- **Why:** Kept the generic verb over Approach-C-style per-domain duplication; sugar is only worth it if the data shows the agent fumbling the generic form.
- **Effort:** S.

## P3 — Backport confirm-token expiry to the Doctor fix flow
- **What:** The Doctor one-time fix token (lib/server/doctor/) has no expiry column; the agent-admin confirm store added 10-min expiry + attempt caps. Backport the same hardening to Doctor.
- **Effort:** S.

## P3 — Verify sendChatAction deleted-topic semantics; optional opt-in liveness probe
- **What:** On wintermute, call `sendChatAction` with a `message_thread_id` of a deleted forum topic and record whether Telegram returns a distinct thread-not-found error (reports exist of `ok: true` regardless). If it errors distinctly, consider an opt-in, low-frequency background probe for topics that never receive sends (default off — probes show "bot is typing…" to group members).
- **Why:** Lazy stale-marking (shipped) only fires on real send failures; never-posted-to topics stay unverified.
- **Context:** `isMissingTopicError` (lib/server/routes/telegram.js) is the error matcher; the per-topic "verify now" UI button covers on-demand checks regardless of this TODO.
- **Effort:** S. **Depends on:** telegram-topics-discovery shipping (docs/designs/telegram-topics-discovery.md).

## P3 — Migrate openclaw.json writes to openclaw's config.patch RPC
- **What:** Replace alphaclaw's direct read-modify-write of openclaw.json (syncConfigForTelegram et al — and now the team-mode `gateway.auth`/`gateway.trustedProxies` writes in lib/server/team-auth-transition.js) with openclaw's `config.patch` gateway RPC.
- **Why:** openclaw's writer natively handles JSON5, `${ENV}` refs, `$include`, snapshot-hash conflict detection, and rolling backups — alphaclaw's JSON.parse/writeFileSync cannot. Fail-closed reads (shipped with topics-discovery) prevent wipes but refuse to sync JSON5-flavored configs; config.patch would sync them correctly.
- **Context:** Surfaced by /plan-eng-review outside voice (E2) on the telegram-topics-discovery plan. openclaw's writer: dist io chunk `writeConfigFileLocal`; alphaclaw reader: lib/server/openclaw-config.js.
- **Effort:** M (→S with CC). **Depends on:** telegram-topics-discovery shipping; verify `gateway call config.patch` surface.

## P2 — Supervisor verified-restart handoff (OpenClaw 2026.8.1+)
- **What:** Implement the beta's verified restart handoff in `restartGateway`/`stopGatewayChildAndWait`/watchdog `restartAfterCrash` once a 2026.8.1 build is installed and its lifecycle contract is readable. Env plumbing (`OPENCLAW_SUPERVISOR_MODE=external`, gated on `supportsFeature("supervisorMode")`) already ships.
- **Why:** The pinned stable (2026.7.1-2) documents no external-supervision contract; implementing against an assumed shape risks a wrong handshake during the most fragile window (gateway restart).
- **Context:** TODO comment in lib/server/gateway.js; gate in lib/server/openclaw-feature-gates.js. Surfaced by the eng review's "handoff after the beta contract is read" sequencing decision.
- **Effort:** S. **Depends on:** applying 2026.8.1-beta.3+ on a staging deployment.

## P2 — Node onboarding under team mode (trusted-proxy)
- **What:** `openclaw node run` authenticates with `OPENCLAW_GATEWAY_TOKEN`, which trusted-proxy mode rejects; `/api/nodes/connect-info` currently returns an empty token with a logged warning while team mode is on. Provide a working node path (gateway password credential, or a pairing flow) before recommending team mode to node users.
- **Context:** lib/server/gateway-credential.js, lib/server/routes/nodes.js; degradation documented in the team-auth milestone report.
- **Effort:** M. **Depends on:** verifying how `openclaw node run` accepts a password credential (docs/cli in the beta line).
