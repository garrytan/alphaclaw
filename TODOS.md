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
- **What:** (a) a shared admin-copy-constants module (D1 strings are currently inline per component); (b) `getAdvertisedScopes` is not wired in production — scope-name intersection is a no-op (mitigated: the operator.* names are live-verified against the beta's OperatorScopeSchema by the e2e suite); (c) the server-side channel maps (constants.kChannelDefs, agents/shared.js) are CJS and cannot import the ESM channel registry — they stay cross-referenced counterparts, extended together (the registry header documents this). (The wizard's inline apply + restart + health re-check shipped with the 0.9.36 team-auth transition.)
- **Why:** Each is polish or a structural nicety; the shipped behavior is correct and tested.
- **Context:** Findings from the 7-agent plan-completion audit; everything else the audit flagged was fixed in the audit-batch commits.
- **Effort:** S–M (per item).

## P2 — Team-mode security follow-ups (deferred from the 0.9.36 ship review)
- **What:** (a) Per-member chat/session isolation — team mode v1 keeps global agent sessions (channels, hooks, crons) with no owner column, so a member can enumerate (`GET /api/usage/sessions`) and read/send to (`GET /api/chat/history`, chat WS) ANY session; documented in `chat-ws.js` ("chat traffic is NOT attributed per-operator in team mode v1"). A real fix adds an owner/attribution column to usage_events + a visibility filter keyed on `req.alphaclawIdentity`. (b) Role demotion only takes gateway effect on the next restart (`restartRequired:true`) — the running gateway keeps the old operator scope until then (OpenClaw captures auth at startup). (c) Verified restart-handoff for `OPENCLAW_SUPERVISOR_MODE=external` (2026.8.1+): env plumbing ships default-on, but `openclaw-restart-handoff.js` has no production caller, so a gateway-initiated fresh-process restart could feed watchdog crash accounting (mitigated: `OPENCLAW_NO_RESPAWN=1` keeps routine restarts in-process, 50s expected-exit window). (d) `getAdvertisedScopes` is not wired in production, so the scope-name intersection guard is a no-op (mitigated: names are hardcoded to live-verified OperatorScopeSchema values).
- **Why:** All are acceptable under the plan's "team roles are a CONVENIENCE boundary, host isolation is the precondition" posture; none is a credential leak or auth bypass after the 0.9.36 fixes.
- **Effort:** M–L (per item).

## P3 — Config-writer + cache hygiene follow-ups
- **What:** (a) `runBootConfigMigration` (openclaw-channel-sync.js) resolves the doctor binary + installed version from `installDir/node_modules/openclaw` (the pin), so on the DEV channel it runs the pin's doctor / keys migration on the pin version instead of the active checkout — a dev build needing a newer schema can boot unmigrated (backstopped by exit-78 → auto-rollback; dev is advanced/opt-in). Resolve the dev checkout's version + binary (as the db-preflight path does) for the migration. (b) `derivePasswordCredential` writes a resolved literal into openclaw.json when the pre-team `gateway.auth.password` was a non-canonical `${OTHER_VAR}`/SecretRef (only OPENCLAW_GATEWAY_PASSWORD/TOKEN round-trip as env-refs). (c) gateway-credential's read cache returns the same object reference on a hit while alphaclaw-config returns a fresh parse — align the aliasing.
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

## P3 — Unify feature gates and capability probes
- **What:** `/api/openclaw/features` (version-gated, lib/server/openclaw-feature-gates.js) and `/api/openclaw/capabilities` (feature-detecting probes, lib/server/openclaw-capabilities.js) coexist after the 0.9.36 reconciliation. Back the version-gated keys with probes where a probe exists (sessionDashboards, secretEgressBinding), keep gates only where probing is impossible, and collapse to one endpoint. Also delete the now-unused operator-roster half of lib/server/operators-store.js (only the notification-prefs half has consumers).
- **Why:** One source of truth for "what does the installed OpenClaw support"; probes survive dev builds and forks where version comparison fails closed.
- **Context:** Documented split from the main-branch merge; the restart-handoff/env plumbing (OPENCLAW_SUPERVISOR_MODE default-external with the off|none hatch) is no longer gated.
- **Effort:** M.

## P2 — Node onboarding under team mode (trusted-proxy)
- **What:** `openclaw node run` authenticates with `OPENCLAW_GATEWAY_TOKEN`, which trusted-proxy mode rejects; `/api/nodes/connect-info` currently returns an empty token with a logged warning while team mode is on. Provide a working node path (gateway password credential, or a pairing flow) before recommending team mode to node users.
- **Context:** lib/server/gateway-credential.js, lib/server/routes/nodes.js; degradation documented in the team-auth milestone report.
- **Effort:** M. **Depends on:** verifying how `openclaw node run` accepts a password credential (docs/cli in the beta line).
