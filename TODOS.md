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

## P2 — Latch shutdown state before the self-update restart drain
- **What:** `restartProcess` (lib/server/alphaclaw-version.js) calls `serverLifecycle.drain()` without setting the lifecycle's `exiting` latch, so a SIGTERM or uncaughtException landing inside the ≤10s drain window starts a second concurrent drain and exits before the successor process is spawned — on an unsupervised VPS that means a self-update ends with nothing running. Route the restart through a lifecycle method (e.g. `prepareForRestart()`) that latches `exiting` and disarms signal re-entry, or move the respawn inside the guarded exit path.
- **Why:** Red-team finding on the downtime-remediation ship review (2026-08-28); bounded window but the failure mode is "permanently down after update".
- **Effort:** S. **Depends on:** nothing.

## P3 — Keep the workspace manifest inside the fingerprint worker
- **What:** Each background snapshot refresh round-trips the full manifest (multi-MB at 15k+ files) through `postMessage`, costing ~7ms serialize + ~15ms deserialize on the main thread per refresh. The worker is persistent — cache the previous manifest worker-side (send it only on the first request) and return only fingerprint/limited/stats (and, with the delta moved worker-side, the computed delta).
- **Why:** Last recurring main-thread stall on the status path (bounded: once per 45s refresh window). Ship-review performance finding, 2026-08-28.
- **Context:** lib/server/doctor/workspace-fingerprint.js (worker round-trip), lib/server/doctor/fingerprint-worker.js, lib/server/doctor/service.js (`calculateWorkspaceDelta` call site).
- **Effort:** M. **Depends on:** nothing.

## P3 — Ship-review maintainability follow-ups (2026-08-28, grouped)
- **What:** (1) shared `applyOperationalPragmas(db)` helper for the WAL/NORMAL/busy_timeout block now copy-pasted in db/auth, db/doctor, db/watchdog, db/webhooks; (2) shared cron run-log tail-read helper (block repeated ×3 in cron-service.js); (3) shared `sleep` util (5 private copies); (4) one `kDoctorRepairTimeoutMs` constant for the 10-minute doctor-fix ceiling spelled in server.js and watchdog.js; (5) shared 1s sync-file-lock timeout constant (openclaw-config.js + topic-registry.js); (6) extract the proxy error handler and terminal error middleware from lib/server.js into a module so routes-proxy.test.js stops testing a verbatim copy; (7) `stream.end()` + bounded await-finish as a drain step in log-writer so stream-buffered bytes survive shutdown (in-memory queue already flushes); (8) make system-resources' loop-lag monitor injectable/stoppable for direct tests; (9) surface a `truncatedHistory` flag on cron run-history responses (256KB tail bound); (10) /v1-scoped error handler emitting the OpenAI error envelope for 413/400 parser errors; (11) SWR-cache `getGatewayPort` (sync read+parse per proxied request, sub-ms but unconditional); (12) stat-cache `analyzeBootstrapContext` file reads; (13) remaining test gaps: pairings single-flight/500 path, cron-store TTL-reopen/liveness cache, statusPayloadMemo invalidate-vs-in-flight race, doctor-service runStarting four-site reset → try/finally cleanup; (14) `Expect: 100-continue` proxied requests never get the post-header idle-timeout relaxation (http-proxy-3 skips the proxyReq event for them — consider stripping the header on the outgoing leg); (15) `installCrashGuards` removeAllListeners can drop dependency-registered process handlers — remove only known guards by reference; (16) browse preview TOCTOU: read at most limit+1 bytes from an fd instead of stat-then-readFileSync.
- **Why:** All flagged by the /ship specialist review; deferred as churn-vs-risk at ship time, none user-visible today.
- **Effort:** S each. **Depends on:** nothing.

## P2 — Node onboarding under team mode (trusted-proxy)
- **What:** `openclaw node run` authenticates with `OPENCLAW_GATEWAY_TOKEN`, which trusted-proxy mode rejects; `/api/nodes/connect-info` currently returns an empty token with a logged warning while team mode is on. Provide a working node path (gateway password credential, or a pairing flow) before recommending team mode to node users.
- **Context:** lib/server/gateway-credential.js, lib/server/routes/nodes.js; degradation documented in the team-auth milestone report.
- **Effort:** M. **Depends on:** verifying how `openclaw node run` accepts a password credential (docs/cli in the beta line).

## Completed

## Make env-save channel sync one atomic lifecycle-lock op
- **What:** `PUT /api/env` runs remove-channels → write env → add-channels as two separately queued lock ops (lib/server/routes/system.js + gateway.js `syncChannelConfig`). A gateway restart queued between them launches with channels removed-but-not-yet-re-added (final config state self-corrects when the add runs, but the running gateway may need another restart to pick it up). Wrap remove+write+add in a single uniquely-keyed lock op (expose a narrow `withGatewayLifecycleLock` from gateway.js or a dedicated `syncChannelConfigForEnvSave`).
- **Why:** Adversarial review M4 on the ship pass (2026-08-28). Rare (requires an operator restart racing an env save) and bounded, but the invariant "env save is atomic against lifecycle ops" held under execSync and silently weakened in the async conversion.
- **Effort:** M (test updates across routes-system + coalescing suites). **Depends on:** nothing.
- **Completed:** v0.9.37 (2026-08-28) — `PUT /api/env` acquires the shared gateway lifecycle lock once around the full remove → write → add sequence (lib/server/routes/system.js `env_sync` op); `syncChannelConfig` itself stays lock-free, so the whole save is one atomic lifecycle operation.
