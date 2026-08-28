# TODOS

## P3 — Finish ensureGatewayProxyConfig migration onto updateOpenclawConfig
- **What:** ensureGatewayProxyConfig (lib/server/gateway.js) now holds the shared file lock (`withFileLockSync`) around its read-modify-write, so it can no longer race the team-mode/channel-sync writers. Remaining nicety: replace its raw `JSON.parse`/`writeFileSync` body with `updateOpenclawConfig` itself (fail-closed read + agents-shape preservation + atomic temp+rename), writing the `${REMOTE_MCP_API_TOKEN}` placeholder directly instead of post-serialize string substitution.
- **Why:** Consistency and beta agents-shape preservation on this one writer; the correctness-critical race is already closed by the lock.
- **Context:** The full rewrite needs the 66 gateway tests moved off raw `fs.writeFileSync(configPath, content)` assertions.
- **Effort:** M.

## P3 — Wire restart-handoff consume into the watchdog exit classifier
- **What:** In gateway.js's child exit handler, when the target supports the restart-handoff contract (capabilities probe) and the exit is unexpected, consume the handoff (`lib/server/openclaw-restart-handoff.js`) before classifying, and add a watchdog `onGatewayExit` branch that relaunches without crash accounting. Serialize exit classification per child pid.
- **Why:** Correctly classify an OpenClaw-initiated fresh-process restart as intentional, not a crash.
- **Context:** Deferred from Phase 1.7 — low value in practice because AlphaClaw sets `OPENCLAW_NO_RESPAWN=1`, so routine restarts stay in-process (no child exit to misclassify); a fresh-process handoff restart is rare. The module + tests exist; only the exit-handler wiring remains. Cooldown tolerance (window 15s->50s) already shipped.
- **Effort:** M.

## P3 — OpenClaw-beta follow-ups (deferred from the beta-support plan)
- **What:** Invite QR codes on the Team page; a "move this key to the shared secret store" CTA on the Models page; per-agent access mapping built on the members roster; an auto-canary channel (apply beta to a shadow gateway, promote on health). The Watchdog degraded-state badge (eventLoopDegraded/readyzFailing are already exposed in getStatus) is folded into the Phase 2/3 UI work.
- **Why:** Recorded scope decisions from the CEO review; each is a platform follow-up after core beta support ships.
- **Context:** See the CEO plan and the implementation plan's "Explicitly out of scope" + expansion decisions.
- **Effort:** S–L (per item).

## P3 — Post-audit polish deferrals (beta-support plan, audited 2026-08-28)
- **What:** (a) Team enable wizard's apply step could run restart + health re-check + first-invite inline instead of deferring to the restart banner and the Team page; (b) a shared admin-copy-constants module (D1 strings are currently inline per component); (c) `getAdvertisedScopes` is not wired in production — scope-name intersection is a no-op (mitigated: the operator.* names are live-verified against the beta's OperatorScopeSchema by the e2e suite); (d) the server-side channel maps (constants.kChannelDefs, agents/shared.js) are CJS and cannot import the ESM channel registry — they stay cross-referenced counterparts, extended together (the registry header documents this).
- **Why:** Each is polish or a structural nicety; the shipped behavior is correct and tested.
- **Context:** Findings from the 7-agent plan-completion audit; everything else the audit flagged was fixed in the audit-batch commits.
- **Effort:** S–M (per item).

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
