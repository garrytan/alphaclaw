# TODOS

## P2 — Runtime guard for Express 4/5 dependency drift
- **What:** Assert `require("express/package.json").version` is major 4 at server boot; refuse to start (loud, actionable error) on drift.
- **Why:** AGENTS.md documents a real production incident: a mutated `/app/node_modules` hoisted `express@5` over the app root, causing silent request-handling regressions (body parsing on certain methods). Today's only guard is test-only (`tests/server/express-runtime-guard.test.js`) — production has no protection.
- **Context:** Add the assertion near the top of `lib/server.js` (before the app is constructed); mirror the expectation in the existing runtime-guard test. Recovery for a tripped guard is the AGENTS.md no-cache rebuild runbook.
- **Effort:** S. **Depends on:** nothing.

## P3 — Split admin plane from gateway supervisor (process isolation)
- **What:** Separate supervisor process so the admin UI survives supervisor failure and self-updates become zero-downtime (new process takes over the socket).
- **Why:** The availability ceiling of the 2026-08 downtime remediation (see docs/designs and the admin-ui-downtime plan): one process means updates/rollbacks still restart the UI, and a supervisor crash takes the dashboard with it. Cross-model review consensus that this is the correct 12-month architecture.
- **Context:** The remediation's Phase 3 (single shutdown orchestrator in `lib/server/init/server-lifecycle.js`) and Phase 4 (gateway lifecycle single-flight lock in `lib/server/utils/lifecycle-lock.js`) carve the exact seams a split would cut along; the lock is the embryo of the lifecycle state machine. Revisit after the remediation ships and upstream merge cadence is known.
- **Effort:** XL (→L with CC). **Depends on:** downtime remediation landing.

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

## P2 — Make env-save channel sync one atomic lifecycle-lock op
- **What:** `PUT /api/env` runs remove-channels → write env → add-channels as two separately queued lock ops (lib/server/routes/system.js + gateway.js `syncChannelConfig`). A gateway restart queued between them launches with channels removed-but-not-yet-re-added (final config state self-corrects when the add runs, but the running gateway may need another restart to pick it up). Wrap remove+write+add in a single uniquely-keyed lock op (expose a narrow `withGatewayLifecycleLock` from gateway.js or a dedicated `syncChannelConfigForEnvSave`).
- **Why:** Adversarial review M4 on the ship pass (2026-08-28). Rare (requires an operator restart racing an env save) and bounded, but the invariant "env save is atomic against lifecycle ops" held under execSync and silently weakened in the async conversion.
- **Effort:** M (test updates across routes-system + coalescing suites). **Depends on:** nothing.

## P3 — Keep the workspace manifest inside the fingerprint worker
- **What:** Each background snapshot refresh round-trips the full manifest (multi-MB at 15k+ files) through `postMessage`, costing ~7ms serialize + ~15ms deserialize on the main thread per refresh. The worker is persistent — cache the previous manifest worker-side (send it only on the first request) and return only fingerprint/limited/stats (and, with the delta moved worker-side, the computed delta).
- **Why:** Last recurring main-thread stall on the status path (bounded: once per 45s refresh window). Ship-review performance finding, 2026-08-28.
- **Context:** lib/server/doctor/fingerprint-client.js, fingerprint-worker.js, service.js `computeDeltaCached`.
- **Effort:** M. **Depends on:** nothing.

## P3 — Ship-review maintainability follow-ups (2026-08-28, grouped)
- **What:** (1) shared `applyOperationalPragmas(db)` helper for the WAL/NORMAL/busy_timeout block now copy-pasted in db/auth, db/doctor, db/watchdog, db/webhooks; (2) shared cron run-log tail-read helper (block repeated ×3 in cron-service.js); (3) shared `sleep` util (5 private copies); (4) one `kDoctorRepairTimeoutMs` constant for the 10-minute doctor-fix ceiling spelled in server.js and watchdog.js; (5) shared 1s sync-file-lock timeout constant (openclaw-config.js + topic-registry.js); (6) extract the proxy error handler and terminal error middleware from lib/server.js into a module so routes-proxy.test.js stops testing a verbatim copy; (7) `stream.end()` + bounded await-finish as a drain step in log-writer so stream-buffered bytes survive shutdown (in-memory queue already flushes); (8) make system-resources' loop-lag monitor injectable/stoppable for direct tests; (9) surface a `truncatedHistory` flag on cron run-history responses (256KB tail bound); (10) /v1-scoped error handler emitting the OpenAI error envelope for 413/400 parser errors; (11) SWR-cache `getGatewayPort` (sync read+parse per proxied request, sub-ms but unconditional); (12) stat-cache `analyzeBootstrapContext` file reads; (13) remaining test gaps: pairings single-flight/500 path, cron-store TTL-reopen/liveness cache, statusPayloadMemo invalidate-vs-in-flight race, doctor-service runStarting four-site reset → try/finally cleanup; (14) `Expect: 100-continue` proxied requests never get the post-header idle-timeout relaxation (http-proxy-3 skips the proxyReq event for them — consider stripping the header on the outgoing leg); (15) `installCrashGuards` removeAllListeners can drop dependency-registered process handlers — remove only known guards by reference; (16) browse preview TOCTOU: read at most limit+1 bytes from an fd instead of stat-then-readFileSync.
- **Why:** All flagged by the /ship specialist review; deferred as churn-vs-risk at ship time, none user-visible today.
- **Effort:** S each. **Depends on:** nothing.

## P2 — Node onboarding under team mode (trusted-proxy)
- **What:** `openclaw node run` authenticates with `OPENCLAW_GATEWAY_TOKEN`, which trusted-proxy mode rejects; `/api/nodes/connect-info` currently returns an empty token with a logged warning while team mode is on. Provide a working node path (gateway password credential, or a pairing flow) before recommending team mode to node users.
- **Context:** lib/server/gateway-credential.js, lib/server/routes/nodes.js; degradation documented in the team-auth milestone report.
- **Effort:** M. **Depends on:** verifying how `openclaw node run` accepts a password credential (docs/cli in the beta line).

## P3 — Extract shared overseer-core + retrofit the upgrade overseer card to live updates
- **What:** Pull the generic ~40% shared by `lib/server/upgrade-overseer.js` and `lib/server/watchdog-overseer.js` (env isolation, availability probe w/ SWR, `--help` flag discovery, envelope/verdict parsing, start/stop) into one module; then give the upgrade overseer card the watchdog card's freshness model (verdicts riding an existing poll instead of load-once).
- **Why:** Two deliberate copies exist today (copy-the-skeleton won the eng review over premature extraction for exactly two consumers); the trigger for extraction is a third consumer or this retrofit.
- **Context:** The watchdog copy already hardened several shared paths (fail-closed tool flags, output redaction) that the upgrade copy lacks — the extraction should level the upgrade overseer UP to those, not average them down. See the watchdog wave plan's cross-model notes.
- **Effort:** M (→S with CC). **Depends on:** watchdog wave shipped.

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
