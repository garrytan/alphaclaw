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

## P3 — Multi-operator / multi-tab settings freshness
- **What:** Push-refresh (SSE settings events) or ETag/If-Match concurrency for persisted settings so a second operator/tab sees changes without a remount.
- **Why:** The toggle/status/error overhaul's generation guards fix single-client races only; concurrent editors remain last-write-wins with no live refresh of settings cards.
- **Context:** `useSavedSetting` (lib/public/js/hooks/use-saved-setting.js) is the standard write path (a few deliberate bespoke loops remain: cron's job-enable converge, General's SSE-proof API toggle) — a settings SSE channel could feed its `retryLoad()`/cache seam. Surfaced by the plan's CEO review + outside voice.
- **Effort:** M. **Depends on:** deciding a settings-events transport (piggyback /api/events/status vs a new stream).

## P3 — Cron run-history: cap-aware pagination merge + bounded optimistic converge
- **What:** (a) The runs poll skips replacing entries while paginated past page 1; with >200 entries loaded (server clamps limit to kMaxRunsLimit=200, lib/server/cron-service.js), every snapshot is truncated and live updates stay frozen until a job/filter switch — make the merge cap-aware (offset paging or merge-first-200). (b) The job-enable toggle's hold-until-confirm converge can pin the optimistic value if an external actor flips the job back between our commit and the confirming poll — add a timeout or generation-stamped converge.
- **Why:** Both are narrow edges of the accepted optimistic/merge design, flagged by the slice verifier; neither is user-visible in normal operation.
- **Context:** lib/public/js/components/cron-tab/use-cron-tab.js (truncated-snapshot guard ~line 213, converge effect ~line 244).
- **Effort:** S.

## P3 — Plumb an AbortSignal through the startup medic
- **What:** Pass a real cancellation signal from the watchdog's run-budget race into `configMedic.run` → `llmClient.complete` (fetch already takes one) and `runDoctorFix` (kill the spawned doctor), so a budget expiry cancels the in-flight work instead of orphaning it.
- **Why:** Today the race latches correctly and every mutating step re-checks its budget (LLM deadline-capped, doctor timeout-capped, remove_keys re-checks remaining), so the practical zombie window is small — but a cancelled medic that still finishes a doctor run can rewrite openclaw.json after the lifecycle lock has moved on.
- **Context:** `lib/server/watchdog.js` runConfigMedic (Promise.race), `lib/server/gateway-medic.js` run(), `lib/server.js` runStreamedDoctorFix. The lease-expired relaunch guard exists and is the backstop; this closes the residual. Add a fake-clock test for the lease-expiry branch while here (currently the one untested watchdog medic branch).
- **Effort:** M → CC: S.

## P3 — Surface medic incidents in the Upgrade page card
- **What:** Show the last medic incident on the Startup-medic card: when it ran, tier used, keys removed/doctor result, backup filename with a restore CTA, and the model consulted. Data already exists in the `medic` watchdog events (`GET /api/watchdog/events`) and the `openclaw.json.medic-*.bak` files.
- **Why:** Today the audit trail lives in chat notifications and the watchdog event log; the card only shows the toggle + AI availability. An operator debugging a config incident should see what the medic did without scrolling Telegram.
- **Context:** `lib/public/js/components/upgrade-tab/medic-card.js`; mirror the overseer card's report pattern. Pairs with the TODOS item "Notification remediation-action parity".
- **Effort:** M → CC: S.

## P3 — Allowlist-project the config body sent to the medic's AI tier
- **What:** Replace the deny-list scrub of the serialized openclaw.json with an allowlist projection: send only schema-relevant structure (key paths + value types + the blamed subtrees), never raw string values, to the provider API.
- **Why:** Value/shape-based redaction (secret-named keys, token shapes, cookies, signed URLs, DSN userinfo) covers the known classes but is structurally a blocklist; a projection is fail-closed for secret classes nobody listed yet.
- **Context:** `lib/server/gateway-medic.js` renderConfigForPrompt/runAiTier. The model rarely needs raw values to pick between remove_keys/doctor_fix/none — key paths and the validator errors carry the signal.
- **Effort:** S → CC: S.

## P3 — Migrate the upgrade overseer onto the shared frontier LLM client
- **What:** Swap `lib/server/upgrade-overseer.js` from spawning the `claude` CLI to `lib/server/llm-client.js` (raw fetch, Anthropic → OpenAI → Google fallback), keeping its recommend-only contract, redaction, and run-ledger persistence.
- **Why:** The overseer currently requires a `claude` binary on PATH and only works with an Anthropic key; the medic's client works in any container with any of the three provider keys and already handles refusals, timeouts, and body-stall aborts. One LLM path to maintain instead of two.
- **Context:** `createFrontierLlmClient` is dependency-free and tested. Preserve the overseer's isolated-env posture by keeping evidence redaction (it already scrubs) — the CLI sandboxing rationale disappears once no subprocess is spawned.
- **Effort:** M → CC: S.

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
## P2 — Gateway child re-ownership spike
- **What:** Investigate re-owning the gateway process after a manual restart so exit codes and crash attribution stay reliable (today the first `openclaw gateway --force` restart detaches the child; crash detection falls back to TCP-probe inference labeled "estimated").
- **Why:** Exit-based detection is instant and attributable; probe-based is ~10s and inferred.
- **Context:** Trigger condition (from the gateway-state design): schedule this spike only if production unified-state staleness p95 (real gateway death → state change; recorded on watchdog events) exceeds 15s now that event-driven probes shipped. Supervision honesty labels are in lib/server/gateway-state.js.
- **Effort:** M (spike) — outcome decides the real work.

## P2 — Remove legacy status fields (next minor)
- **What:** Drop `gateway` and `watchdogStatus`-derived legacy projections from `/api/status` and flip `POST /api/gateway/restart` to async-by-default (blocking behavior behind an opt-out for one more release).
- **Why:** They exist only as a one-minor-release compat window for old clients; the reducer-backed `status.state` is the contract now. A projection-equality test pins them equal until removal.
- **Context:** lib/server/routes/system.js (projection + restart route), client version-skew adapter in components/gateway.js can drop its legacy path at the same time.
- **Effort:** S.

## P3 — Manual repair should queue on the lifecycle lock, not skip
- **What:** POST /api/watchdog/repair (source "manual") uses tryAcquire and returns `{ok:false, skipped:true, reason:"operation_in_progress"}` as HTTP 200 while any lifecycle operation holds the lock. The lock module's contract says user paths QUEUE; today only route restarts do. Either queue manual repairs or return 409 with a user-actionable message.
- **Why:** Direct API users and badge-hidden windows (boot holds the lock but shows no badge) get a silent no-op today. Deliberately deferred at ship time (2026-08-28 red-team finding, conf 5): repair-behind-a-restart queueing is debatable UX and the card's disabled-action guard covers the visible cases.
- **Context:** lib/server/watchdog.js runRepair (tryAcquire), lib/server/routes/watchdog.js repair handler, lib/server/gateway-lifecycle-lock.js contract comment.
- **Effort:** S.

## P3 — Watchdog health-timeline sparkline
- **What:** Small timeline strip on the watchdog page showing health-check outcomes/gateway state over the last 24h (data already persisted in watchdog_events).
- **Why:** "Was it flapping overnight?" currently requires reading incident rows one by one.
- **Effort:** S-M.

## P3 — Notification remediation-action parity
- **What:** Alerts name the primary remediation ("Repair from the Watchdog tab") with the same action vocabulary as the card's `actions[]`; today they share state labels and deep links but not the action wording.
- **Context:** Copy source: lib/server/gateway-state.js catalog + actionsForState.
- **Effort:** S.

## P3 — Downloadable redacted diagnostic bundle
- **What:** One-click export: recent watchdog events, redacted log tail, doctor summary, config (env-values masked), version/channel info.
- **Why:** "Send me diagnostics" is the support loop for self-hosters; redaction plumbing (lib/server/utils/redact.js) already exists.
- **Effort:** M.

## P3 — Browser-first recovery flows for dev-repair/backup-restore
- **What:** Guided UI flows for the recovery paths that still assume shell access (restoring a version backup, dev-channel repair after a failed build).
- **Effort:** M.

## P4 — SSE log streaming
- **What:** Push log deltas over SSE instead of the 3s delta poll.
- **Why (deferred):** Delta polling + gzip already cut the transfer to near-nothing; revisit only if log latency becomes a complaint.
- **Effort:** S.

## P4 — Operator runbook + DESIGN.md + a11y audit
- **What:** Full operator runbook doc (state glossary → remediation per state); DESIGN.md via /design-consultation capturing the status-surface design system; app-wide accessibility audit extending the Gateway-card live-region/reduced-motion work to the rest of the UI.
- **Effort:** M each.

## P2 — Runtime guard for Express 4/5 dependency drift
- **What:** Assert `require("express/package.json").version` is major 4 at server boot; refuse to start (loud, actionable error) on drift.
- **Why:** AGENTS.md documents a real production incident: a mutated `/app/node_modules` hoisted `express@5` over the app root, causing silent request-handling regressions (body parsing on certain methods). Today's only guard is test-only (`tests/server/express-runtime-guard.test.js`) — production has no protection.
- **Context:** Add the assertion near the top of `lib/server.js` (before the app is constructed); mirror the expectation in the existing runtime-guard test. Recovery for a tripped guard is the AGENTS.md no-cache rebuild runbook.
- **Effort:** S. **Depends on:** nothing.

## P3 — Split admin plane from gateway supervisor (process isolation)
- **What:** Separate supervisor process so the admin UI survives supervisor failure and self-updates become zero-downtime (new process takes over the socket).
- **Why:** The availability ceiling of the 2026-08 downtime remediation (see docs/designs and the admin-ui-downtime plan): one process means updates/rollbacks still restart the UI, and a supervisor crash takes the dashboard with it. Cross-model review consensus that this is the correct 12-month architecture.
- **Context:** The remediation's Phase 3 (single shutdown orchestrator in `lib/server/init/server-lifecycle.js`) and Phase 4 (gateway lifecycle single-flight lock in `lib/server/gateway-lifecycle-lock.js`) carve the exact seams a split would cut along; the lock is the embryo of the lifecycle state machine. Revisit after the remediation ships and upstream merge cadence is known.
- **Effort:** XL (→L with CC). **Depends on:** downtime remediation landing.

## P3 — Verify sendChatAction deleted-topic semantics; optional opt-in liveness probe
- **What:** On wintermute, call `sendChatAction` with a `message_thread_id` of a deleted forum topic and record whether Telegram returns a distinct thread-not-found error (reports exist of `ok: true` regardless). If it errors distinctly, consider an opt-in, low-frequency background probe for topics that never receive sends (default off — probes show "bot is typing…" to group members).
- **Why:** Lazy stale-marking (shipped) only fires on real send failures; never-posted-to topics stay unverified.
- **Context:** `isMissingTopicError` (lib/server/routes/telegram.js) is the error matcher; the per-topic "verify now" UI button covers on-demand checks regardless of this TODO.
- **Effort:** S. **Depends on:** telegram-topics-discovery shipping (docs/designs/telegram-topics-discovery.md).

## P3 — Redact inline secrets from JSON5/broken openclaw.json in restart evidence
- **What:** `collectSecretValues({configObjects})` gets the parsed openclaw.json; when the config is JSON5-flavored (or unparseable), `readOpenclawConfig` falls back to `{}` and inline tokens echoed to gateway stderr are not masked in restart-failure evidence. Env/env-file secrets still redact.
- **Why:** Same evidence-honesty goal as the shipped inline-JSON redaction; JSON5 configs are the remaining gap (needs a JSON5 parser or openclaw's own reader).
- **Context:** lib/server/routes/system.js redactEvidenceTail, lib/server/utils/redact.js. Surfaced (unverified severity) by the branch adversarial review, 2026-08-28.
- **Effort:** S once config.patch/openclaw reader migration (below) lands — likely subsumed by it.

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
## P3 — Live-tier openclaw backup CLI contract regression test
- **What:** One tests/live assertion that a real `openclaw backup create --output <file>` writes exactly at the given path (refusing when it already exists) and `--output <dir>/` writes a timestamped archive inside the directory.
- **Why:** Issues #7/#9 existed because every test stub encoded an unvalidated assumption about the CLI's `--output` contract; the contract is now verified from openclaw@2026.7.1-2 dist source, and a live guard catches future CLI changes.
- **Context:** `createBackupStubRunner` (tests/live/live-helpers.js) stubs backup in the live tier; contract notes in the #7/#9 fix PR.
- **Effort:** S. **Depends on:** live tier (`OPENCLAW_LIVE_E2E=1`) with a real openclaw build.

## P3 — Size-aware backup retention
- **What:** Add a configurable max-total-bytes retention policy (always keeping >= 1 archive) on top of keep-3, and consider surfacing backup disk usage in the UI.
- **Why:** Keep-3 of ~7 GiB archives is ~21 GiB with no byte budget; small-volume installs can hit ENOSPC (now at least reported honestly, with a pre-backup space warning).
- **Context:** `kOpenclawBackupKeepCount` (lib/server/constants.js:272), `pruneBackups` (lib/server/openclaw-channel-sync.js).
- **Effort:** S-M. **Depends on:** the #7/#9 backup fix landing.

## P2 — Supervisor verified-restart handoff (OpenClaw 2026.8.1+)
- **What:** Implement the beta's verified restart handoff in `restartGateway`/`stopGatewayChildAndWait`/watchdog `restartAfterCrash` once a 2026.8.1 build is installed and its lifecycle contract is readable. Env plumbing (`OPENCLAW_SUPERVISOR_MODE=external`, gated on `supportsFeature("supervisorMode")`) already ships.
- **Why:** The pinned stable (2026.7.1-2) documents no external-supervision contract; implementing against an assumed shape risks a wrong handshake during the most fragile window (gateway restart).
- **Context:** TODO comment in lib/server/gateway.js; gate in lib/server/openclaw-feature-gates.js. Surfaced by the eng review's "handoff after the beta contract is read" sequencing decision.
- **Effort:** S. **Depends on:** applying 2026.8.1-beta.3+ on a staging deployment.

## P3 — Keep the workspace manifest inside the fingerprint worker
- **What:** Each background snapshot refresh round-trips the full manifest (multi-MB at 15k+ files) through `postMessage`, costing ~7ms serialize + ~15ms deserialize on the main thread per refresh. The worker is persistent — cache the previous manifest worker-side (send it only on the first request) and return only fingerprint/limited/stats (and, with the delta moved worker-side, the computed delta).
- **Why:** Last recurring main-thread stall on the status path (bounded: once per 45s refresh window). Ship-review performance finding, 2026-08-28.
- **Context:** lib/server/doctor/workspace-fingerprint.js (worker round-trip), lib/server/doctor/fingerprint-worker.js, lib/server/doctor/service.js (`calculateWorkspaceDelta` call site).
- **Effort:** M. **Depends on:** nothing.

## P3 — Ship-review maintainability follow-ups (2026-08-28, grouped)
- **What:** (1) shared `applyOperationalPragmas(db)` helper for the WAL/NORMAL/busy_timeout block now copy-pasted in db/auth, db/doctor, db/watchdog, db/webhooks; (2) shared cron run-log tail-read helper (block repeated ×3 in cron-service.js); (3) shared `sleep` util (5 private copies); (4) one `kDoctorRepairTimeoutMs` constant for the 10-minute doctor-fix ceiling spelled in server.js and watchdog.js; (5) shared 1s sync-file-lock timeout constant (openclaw-config.js + topic-registry.js); (6) extract the proxy error handler and terminal error middleware from lib/server.js into a module so routes-proxy.test.js stops testing a verbatim copy; (7) `stream.end()` + bounded await-finish as a drain step in log-writer so stream-buffered bytes survive shutdown (in-memory queue already flushes); (8) make system-resources' loop-lag monitor injectable/stoppable for direct tests; (9) surface a `truncatedHistory` flag on cron run-history responses (256KB tail bound); (10) /v1-scoped error handler emitting the OpenAI error envelope for 413/400 parser errors; (11) SWR-cache `getGatewayPort` (sync read+parse per proxied request, sub-ms but unconditional); (12) stat-cache `analyzeBootstrapContext` file reads; (13) remaining test gaps: pairings single-flight/500 path, cron-store TTL-reopen/liveness cache, statusPayloadMemo invalidate-vs-in-flight race, doctor-service runStarting four-site reset → try/finally cleanup; (14) `Expect: 100-continue` proxied requests never get the post-header idle-timeout relaxation (http-proxy-3 skips the proxyReq event for them — consider stripping the header on the outgoing leg); (15) `installCrashGuards` removeAllListeners can drop dependency-registered process handlers — remove only known guards by reference; (16) browse preview TOCTOU: read at most limit+1 bytes from an fd instead of stat-then-readFileSync.
- **Why:** All flagged by the /ship specialist review; deferred as churn-vs-risk at ship time, none user-visible today.
- **Effort:** S each. **Depends on:** nothing.

## P3 — Adversarial-review UI cache follow-ups (2026-08-29, grouped)
- **What:** (1) `cachedFetch` SWR dedupe: when a reusable in-flight request exists, the second consumer's `onRevalidate` is never attached, so two components sharing a key (`/api/env` in Envars + Features, `/api/channels/accounts`) can render different vintages until their next refresh/poll/remount — attach a generation-gated `.then(onRevalidate)` (+`.catch(() => {})`) to the reused in-flight promise; (2) `useCachedFetch`: if `setCached()` supersedes an in-flight forced refresh, the cache correctly refuses the stale write but the awaiting hook still `setData(next)` with the pre-mutation result — re-check the key generation after the await before applying locally; (3) `models-tab/use-models.js` refresh and `providers.js` compute merges inside side-effecting `setState` updaters and synchronously read the result for cache writes — correct under Preact's eager updaters but fragile; compute merges from refs instead.
- **Why:** Claude adversarial ship-review findings (2026-08-29); all are small self-healing windows or latent fragility, none user-visible as a deterministic bug today.
- **Effort:** S each. **Depends on:** nothing.

## P2 — Node onboarding under team mode (trusted-proxy)
- **What:** `openclaw node run` authenticates with `OPENCLAW_GATEWAY_TOKEN`, which trusted-proxy mode rejects; `/api/nodes/connect-info` currently returns an empty token with a logged warning while team mode is on. Provide a working node path (gateway password credential, or a pairing flow) before recommending team mode to node users.
- **Context:** lib/server/gateway-credential.js, lib/server/routes/nodes.js; degradation documented in the team-auth milestone report.
- **Effort:** M. **Depends on:** verifying how `openclaw node run` accepts a password credential (docs/cli in the beta line).

## P3 — Extract shared overseer-core + retrofit the upgrade overseer card to live updates
- **What:** Pull the generic ~40% shared by `lib/server/upgrade-overseer.js` and `lib/server/watchdog-overseer.js` (env isolation, availability probe w/ SWR, `--help` flag discovery, envelope/verdict parsing, start/stop) into one module; then give the upgrade overseer card the watchdog card's freshness model (verdicts riding an existing poll instead of load-once).
- **Why:** Two deliberate copies exist today (copy-the-skeleton won the eng review over premature extraction for exactly two consumers); the trigger for extraction is a third consumer or this retrofit.
- **Context:** The watchdog copy already hardened several shared paths (fail-closed tool flags, output + tail-truncation redaction, credential-scoped spawns, fail-closed redaction sources, temp-HOME cleanup/sweep) that the upgrade copy lacks — the extraction should level the upgrade overseer UP to those, not average them down. Known upgrade-copy gaps to close then: its `alphaclaw-overseer-home-*` temp dir is never removed/swept (its probes already strip the API key as of v0.9.40). See the watchdog wave plan's cross-model notes.
- **Effort:** M (→S with CC). **Depends on:** watchdog wave shipped.

## P3 — Async manual overseer review (fire-and-return + pending polling)
- **What:** `POST /api/watchdog/overseer/review` currently awaits the whole review in the handler (availability probe + help + doctor + up to the 5-min claude deadline). Flip to fire-and-return: respond `{ok:true, started:true}` immediately and let the existing pending-state UI (15s incidents poll renders "review in progress") carry progress; keep the mutex/rate-limit semantics.
- **Why:** A proxy/browser timeout during a long review surfaces as a spurious failure toast while the review continues server-side; the operator's retry then hits `busy`. Flagged by the ship adversarial review; sync was the deliberate v1 choice (operator watching the card), so this is UX hardening, not a bug fix.
- **Context:** lib/server/routes/watchdog.js review handler; lib/server/watchdog-overseer.js requestReview (rate limit now stamps only when a review actually spawns, which async must preserve).
- **Effort:** S.

## P3 — Provisional overseer reviews of stuck-open incidents
- **What:** Behind the same `watchdog.overseer.enabled` flag: one interim review when an incident stays open past ~10 min or hits a material event (crash_loop, config_error), superseded later by the final review; ≤2 reviews/incident total.
- **Why:** The deterministic narrator covers "right now"; an LLM read of a stuck incident ("this looks like the 2026.7.1 plugins.allow bug — fix openclaw.json") is the one live moment it could add value. Deferred from the wave: final-only first, validate incident boundaries before spending on open ones.
- **Context:** `runReviewFor` in lib/server/watchdog-overseer.js already takes an incident id; the healthy-steady-state gate is the line to carve an exception through — carefully (mid-storm reviews were deliberately killed).
- **Effort:** M. **Depends on:** the wave's e2e boundary gate holding in production.

## P3 — Overseer model pin + cost telemetry (both overseers together)
- **What:** Pin the claude model (config key), count reviews/tokens/duration per overseer, surface in the UI cards.
- **Why:** Neither overseer pins a model today (whatever the installed CLI defaults to) and cost is invisible; do both at once to avoid asymmetry.
- **Effort:** S–M. **Depends on:** nothing.

## P3 — Migrate WATCHDOG_AUTO_REPAIR / WATCHDOG_NOTIFICATIONS_DISABLED from env to alphaclaw.json
- **What:** Move the two legacy watchdog toggles into alphaclaw.json with env fallback + one-release deprecation note.
- **Why:** New settings already live in alphaclaw.json (`watchdog.overseer.enabled`); the split store means `PUT /api/watchdog/settings` writes env while the overseer toggle writes config — two backends for one card.
- **Context:** `updateSettings` in lib/server/watchdog.js (writeEnvFile/reloadEnv path); never write env and config simultaneously.
- **Effort:** M. **Depends on:** nothing.

## P3 — StatusHero card absorbing the shared Gateway card on the Watchdog tab
- **What:** Merge the Gateway card + status details + narrative card into one hero for the Watchdog tab (the shared Gateway card stays for other tabs).
- **Why:** Three stacked cards carry one mental model; a hero reads faster. Deferred from the wave because forking a shared component was extra surface for equal information.
- **Effort:** M. **Depends on:** watchdog wave shipped.

## P3 — Resource telemetry follow-ups: configurable thresholds, sparklines/history
- **What:** Optional alphaclaw.json keys for the (currently hardcoded 80/90%) resource warn/crit display thresholds; small ring buffer + sparklines for memory/CPU/event-loop lag.
- **Why:** Deferred as expert knobs / width-hungry UI; revisit on demand. Display-only either way.
- **Effort:** M. **Depends on:** nothing.

## P3 — Resource-based alerting/enforcement (design needed — invariant territory)
- **What:** Any watchdog *action* on resource signals (e.g., restart on sustained event-loop starvation or OOM pressure).
- **Why:** Today resources are report-only by design ("the deterministic watchdog is the ONLY enforcement layer" covers gateway health, not host resources). Changing that is a policy design, not a feature toggle.
- **Effort:** L. **Depends on:** explicit design review.

## P3 — Capture the incident log window at close time
- **What:** Persist the timestamp-filtered gateway log excerpt when an incident closes (per-incident file or capped blob) instead of re-reading the tail at review time.
- **Why:** A late overseer review (stale-pending retry) on a busy log can lose the incident window; the wave ships a widened 256KB read + an explicit "may be partial" prompt label as the honest fallback. Capture-at-close removes the limitation at the cost of per-incident storage.
- **Context:** `filterLogWindow` + the `isLate` branch in lib/server/watchdog-overseer.js; the cross-model disagreement is recorded in the wave plan (U5 known limitation).
- **Effort:** M. **Depends on:** nothing.

## P3 — Watchdog wave minor polish (deferred by scope decision)
- **What:** Per-event-type filter pills on the All-events tab; a spot-check "explain current status" overseer mode with no incident; any new SSE event streams for the watchdog surfaces.
- **Why:** Each was reviewed and deferred: three tabs cover the filtering need, the deterministic narrator explains live status for free, and the 2s status SSE + 15s polls already carry everything ("new event streams are the expensive path").
- **Effort:** S each. **Depends on:** demand.
## P2 — Cron run-history UI: read run logs from the state db
- **What:** The cron run/trend UI reads `cron/runs/<jobId>.jsonl` (lib/server/cron-service.js), but even the PINNED openclaw 2026.7.1-2 writes run logs to SQLite (`cron_run_logs`), and 2026.9.1-beta.1's `doctor --fix` additionally renames leftover `.jsonl` to `.jsonl.migrated` — after the first beta doctor run, run history and trends silently go empty. Port the bounded-tail reads to `cron_run_logs` (cached-handle pattern from lib/server/cron-store.js), keeping the `.jsonl` fallback for genuinely old dirs.
- **Why:** Stale-data class of the issue-#23 family: a file the runtime no longer writes, read as if authoritative.
- **Context:** Surfaced by the 2026.9.1-beta.1 compatibility review (plan §11). Self-contained: cron-service.js read paths + tests.
- **Effort:** M → CC: S.

## P3 — Retire the file-era code paths when the openclaw pin reaches ≥ 2026.9.x
- **What:** Once package.json pins an openclaw whose state is SQLite-backed, delete the legacy branches: exec-approvals file seeding (lib/server/exec-defaults-config.js file half), pairing-file readers/writers (routes/pairings.js, watchdog-notify.js, agents/), the agent-db 'primary' auth path for the main agent (lib/server/auth-profiles.js), and the era hint machinery that exists only to tell the two eras apart (lib/server/openclaw-state-era.js documents every seam).
- **Why:** Dual-era code is deliberate, bounded debt from the 2026.9.1-beta.1 compatibility work; the seams are explicit so retirement is mechanical.
- **Effort:** M. **Depends on:** the npm pin moving to ≥ 2026.9.x and the beta line stabilizing.

## P3 — Unified OpenClaw state-backend adapter + CI cross-version contract matrix
- **What:** Fold exec-approvals/auth/pairing/cron state access behind one adapter module and run the live contract suite (tests/live/openclaw-live-cli-contract.e2e.test.js) against BOTH the pinned and the beta openclaw in CI (hermetic `npm pack openclaw@<v>` fixtures).
- **Why:** Approach C from the compatibility review's CEO pass: the 2026.9 migration wave showed every direct state access is a latent break; an adapter plus a version matrix turns the next wave into a test failure instead of an outage.
- **Includes:** the migration-lifecycle E2E from the review (pin → beta apply → forced failure → gate revert, asserting approvals/auth/pairing/notification targets stay functional on the surviving version) — the per-surface behaviors are unit-covered and were verified live against real installs of both versions; the automated end-to-end chain belongs with this matrix.
- **Context:** lib/server/openclaw-state-era.js and openclaw-state-db.js are the seeds; the era decision table lives in the plan for the #23 follow-up work.
- **Effort:** L → CC: M. **Depends on:** the state-era module (landed).

## P3 — Watchdog auth backend for main agent: route saves through `openclaw models auth` where expressible
- **What:** Credential saves for the main agent currently write the shared state db directly in state-db mode (schema-guarded BEGIN IMMEDIATE, lib/server/auth-profiles.js). `openclaw models auth paste-api-key`/`paste-token` exist on both supported versions and would route API-key saves through openclaw's own validation and store selection; oauth profiles, ordering, and usage state have no CLI surface, so the direct writer stays for those either way.
- **Why:** Prefer CLI surfaces over private-schema writes wherever one exists (compat review [C6]); a partial move only pays off if the api-key path is the churny one — check first.
- **Effort:** S-M. **Depends on:** verifying paste-api-key flag shapes on both versions.

## P2 — Claude Code launcher: fire with custom instruction text
- **What:** An input UI on the launcher that passes `{"text": ...}` in the routine-fire body so a click can carry task instructions.
- **Why:** Turns "open a session" into "open a session already working on X" — the highest-leverage extension of the launcher.
- **Context:** The fire payload arrives wrapped in an untrusted `<routine-fire-payload>` block, so the routine's saved prompt must explicitly opt in to reading it (e.g. "act on the routine-fire-payload block"); needs UX design (input modal) and README prompt guidance. `lib/server/claude-code-service.js` is the extension point (currently posts no body by design).
- **Effort:** M. **Depends on:** the launcher shipping.

## P2 — Watchdog incident → Claude Code routine escalation
- **What:** Reuse `claude-code-service` to fire the routine with a settled incident's narrative as the `text` payload ("escalate this incident to Claude Code").
- **Why:** Platform potential: incidents debug themselves in a cloud session with context attached, instead of an operator copy-pasting log excerpts.
- **Context:** Deferred from the launcher's CEO review; needs overseer-integration design (which incidents qualify, redaction of the narrative, notification links) and its own review. Blocked on the fire-with-text TODO above for the payload path.
- **Effort:** M. **Depends on:** fire-with-custom-text.

## P3 — Doctor check for Claude Code routine config shape
- **What:** Surface the launcher service's `invalid_config` reason (bad host, wrong token prefix, half-configured pair) as a Doctor finding.
- **Why:** Misconfiguration is currently visible only in the sidebar tooltip and the fire-time error toast; Doctor is where operators look for config drift.
- **Context:** `createClaudeCodeService().getAvailability()` already returns the exact reason/message — the check is a thin adapter in lib/server/doctor/.
- **Effort:** S. **Depends on:** nothing.

## P3 — Mobile drawer doesn't close on external nav items
- **What:** The generic `item.href` branch in `renderNavItem` (lib/public/js/components/sidebar.js) — used by the gated Dashboards link — never closes the mobile drawer, leaving the drawer and overlay covering the app while the new tab opens.
- **Why:** The Claude Code launcher fixed this for itself via its `onBeforeOpen` callback (design-review finding); the same fix should backport to the generic external-item branch.
- **Context:** `use-browse-navigation.js` `handleSelectNavItem` closes the drawer for internal items only; external anchors bypass it.
- **Effort:** S. **Depends on:** nothing.

## P3 — Claude Code launcher: durable cross-process fire lease
- **What:** The launcher's single-flight (`inFlight`) and cooldown (`cooldownUntil`) live in memory on one `claudeCodeService` instance (lib/server/claude-code-service.js). A crash between Anthropic accepting a fire and AlphaClaw replying, or multiple server processes, or multiple team admins, each bypass the duplicate-billing guard; `busy`/`cooldown` are also shared across all admins (one admin's fire blocks another's).
- **Why:** The fire endpoint has no upstream idempotency key, so every gap in the in-memory guard is a real (if narrow) double-billing window. Adversarial review (Claude + Codex) flagged it; accepted as out-of-scope for the initial launcher because the practical exposure is small (single-process deploy, one operator, rare crash-timing).
- **Context:** Would need an atomic durable lease (file lock or the existing SQLite state dir) keyed per routine, plus persisting uncertain outcomes across boot. Design it alongside the P1 gatewayEnv allowlist work.
- **Effort:** M. **Depends on:** nothing.

## P3 — Sidebar nav a11y debt
- **What:** Internal sidebar nav items are `<a>` elements without `href` (not keyboard-focusable), and rows are under the 44px touch-target minimum on mobile.
- **Why:** Keyboard users cannot tab to most nav items; touch targets fall below platform guidelines. The Claude Code launcher item carries a real href (and aria-busy while launching) — the rest of the nav should catch up.
- **Context:** `renderNavItem` in lib/public/js/components/sidebar.js and the `.sidebar-nav a` metrics in lib/public/css/shell.css:215-246. Repo-wide pass; keep visual density on desktop while adding focus/touch affordances.
- **Effort:** M. **Depends on:** nothing.

## Completed

## Make env-save channel sync one atomic lifecycle-lock op
- **What:** `PUT /api/env` runs remove-channels → write env → add-channels as two separately queued lock ops (lib/server/routes/system.js + gateway.js `syncChannelConfig`). A gateway restart queued between them launches with channels removed-but-not-yet-re-added (final config state self-corrects when the add runs, but the running gateway may need another restart to pick it up). Wrap remove+write+add in a single uniquely-keyed lock op (expose a narrow `withGatewayLifecycleLock` from gateway.js or a dedicated `syncChannelConfigForEnvSave`).
- **Why:** Adversarial review M4 on the ship pass (2026-08-28). Rare (requires an operator restart racing an env save) and bounded, but the invariant "env save is atomic against lifecycle ops" held under execSync and silently weakened in the async conversion.
- **Effort:** M (test updates across routes-system + coalescing suites). **Depends on:** nothing.
- **Completed:** v0.9.37 (2026-08-28) — `PUT /api/env` acquires the shared gateway lifecycle lock once around the full remove → write → add sequence (lib/server/routes/system.js `env_sync` op); `syncChannelConfig` itself stays lock-free, so the whole save is one atomic lifecycle operation.

## P3 — Guided state-DB restore when a rollback is refused
- **What:** When boot refuses a rollback ("no OpenClaw version on this box can read the migrated state", `rollbackRefused` latch, issue #21), the notification names the newest `openclaw-backup-*.tar.gz` and points at the runbook — but restoring it is still a manual CLI dance. Build a guided flow (Upgrade page CTA → staged extract → `openclaw backup` restore steps → restart) that walks the operator through it.
- **Why:** Auto-restore was deliberately rejected in the #21 fix plan (multi-GB extraction at boot, 2× disk requirement, silently discards state written since the backup). A guided flow keeps the human decision while removing the error-prone shell steps.
- **Context:** Refusal path in lib/server/openclaw-channel-sync.js (`chooseBootRollbackTarget` → `rollback_refused` branch); recovery archive named via `newestArchiveName()`; runbook step 6 in AGENTS.md.
- **Effort:** M. **Depends on:** nothing.

## P3 — Slack allowFrom fallback for watchdog notifier targets
- **What:** The Bug-7 fix (issue #21) falls back to `channels.telegram.allowFrom` numeric IDs when no pairing files exist. Slack was deliberately excluded: its allowFrom entries need per-account token derivation (`slack-<account>-allowFrom.json` naming), and Slack user IDs require a `conversations.open` call before posting. Add the Slack equivalent if a real box hits `no_channels_delivered` with only Slack configured.
- **Context:** lib/server/watchdog-notify.js (`readChannelAllowFrom`, fan-out fallback block with the exclusion comment).
- **Effort:** S. **Depends on:** nothing.
