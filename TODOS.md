# TODOS

## P2 — File the two upstream openclaw reports from the 2026-09-01 incident (gateway-hardening wave)
- **What:** (1) `openclaw doctor`'s `registerBundledHealthChecks` resolves plugin public surfaces through the bundled-only loader, so a registry/npm-installed plugin (codex) crashes the CLI at startup ("Could not start the CLI … Unable to resolve bundled plugin public surface codex/api.js", 2026.9.1-beta.1) — it should resolve via the plugin registry. (2) The state-lifecycle coordinator refusal ("another OpenClaw process owns state-lifecycle") names no holder: the coordinator is an exclusive SQLite transaction (`dist/state-database-coordinator-*.js` + `dist/node-sqlite-*.js`, `BEGIN EXCLUSIVE` on `<family>.<hash>.lock.sqlite`) so the refusal is correct, but an operator cannot tell WHICH live process holds it. Ask upstream to record holder identity (pid/argv/startedAt — the same owner-status data its gateway pid-lock already tracks in `dist/gateway-lock-*.js`) alongside the coordinator and include it in the contention error.
- **Why:** AlphaClaw now carries two belts coupled to these internals (the doctor-CLI classifier's crash signatures, and the read-only lock-contention diagnostic in `lib/server/openclaw-lock-contention.js` that lists live openclaw processes via /proc as a proxy for the holder); both are stamped "verified against 2026.9.1-beta.1" and should be DELETED once upstream owns the fixes. Upstream lock ownership/fencing is under design (openclaw/openclaw#121069) — reference it and re-verify against whatever lands. NOTE for the record: this wave's plan originally specified a destructive "stale lock sweep"; the tarball proved a leftover lock file can never block (kernel releases the advisory lock on holder exit) and that deleting a HELD lock file would allow double ownership of the state DB — so the sweep was replaced by the diagnostic before merge.
- **Context:** incident 2026-09-01 (host srv-d776lrvpm1nc73e08c9g, ~6 min down); lib/server/doctor/classify-doctor-cli.js, lib/server/openclaw-lock-contention.js (header comments carry the verified-against stamps and the coordinator semantics).
- **Effort:** S. **Depends on:** upstream issue tracker access.

## P3 — Doctor-availability UI chip (gateway-hardening wave follow-up)
- **What:** A small chip/badge on the Doctor tab rendering `openclawDoctorCli` from doctor status ("upstream doctor broken since <at>: <reason>") — the tracker (`lib/server/doctor/availability.js`) and status field already exist; this is render-only.
- **Why:** Today the state is visible in doctor status JSON, watchdog `doctor_probe` events, and a process.log line; a glanceable chip closes the loop for operators who live in the UI.
- **Context:** lib/server/doctor/service.js buildStatus (`openclawDoctorCli`), lib/public/js/components/doctor/. Run `npm run build:ui` after the change.
- **Effort:** S. **Depends on:** —.

## P3 — Upgrade-page note rendering pinDiverged/appliedVersion (gateway-hardening wave follow-up)
- **What:** A one-line note on the Upgrade page when `pinDiverged` is true: "running <appliedVersion> (<channel>) over the declared pin <pinVersion> — expected; `npm ls` will report the dep invalid". Both channel APIs already expose the fields.
- **Why:** The 2026-09-01 responder diagnosed the expected overlay divergence as a version-drift bug; the boot log line now names it, but the Upgrade page is where operators actually look.
- **Context:** routes/system.js buildOpenclawChannelSummary, routes/openclaw-channel.js catalog `channel`, lib/public/js/components/upgrade-tab/. Run `npm run build:ui`.
- **Effort:** S. **Depends on:** —.

## P3 — Adaptive readiness budget from watchdog history (rejected for the hardening wave, revisitable)
- **What:** Scale `GATEWAY_RESTART_READY_TIMEOUT`'s effective value from recorded cold-start durations (`watchdog_events` gateway_restart `durationMs`, 30-day retention) — e.g. `max(configured, 2 x p95 cold start)` with the existing 480s ceiling.
- **Why:** Deliberately rejected in the plan review (D3a): couples gateway.js to the watchdog DB and under-scales on first boot/DB loss, while a generous static budget costs nothing (the wait returns the instant the port answers). Revisit only if heterogeneous fleets make one static default wrong in both directions.
- **Context:** lib/server/constants.js (kGatewayRestartReadyTimeoutMs + kGatewayRestartOperationBudgetMs derivation), lib/server/db/watchdog (durationMs in gateway_restart events).
- **Effort:** M. **Depends on:** the hardening wave's budget threading (landed).

## P3 — Single-flight doctor collector freshness barrier (documented v1 nuance)
- **What:** A joiner of the shared doctor spawn may receive results from a run started BEFORE its trigger (e.g. a post-repair medic collect coalescing onto a pre-repair spawn). Option: joiners whose trigger timestamp postdates the in-flight run's start optionally wait for the NEXT run.
- **Why:** Bounded staleness (one 60s spawn) accepted in review; matters most in the post-repair evidence window. The collector's header documents the nuance.
- **Context:** lib/server/doctor/collect-doctor-json.js.
- **Effort:** S. **Depends on:** —.

## P3 — Model-drift review deferrals (2026-09-01, grouped)
- **What:** (1) Consolidate the two skills-tree walks — `deterministic-checks.js` `scanWorkspaceSkills` (8KB frontmatter reads, prompt-budget check) and `model-drift.js` `scanSkillFilesForStaleModels` (256KB body reads, 8MB total budget, stale-model check) walk `skills/` independently on every doctor scan; one shared bounded walk should feed both consumers. (2) Verify the openclaw custom-provider schema (`models.providers.*` — provider-level `contextWindow` defaults, per-model shapes, and whether `agents.*.model.fallbacks` exists at all) against the pinned upstream tarball/docs, then tighten `collectConfiguredModels` and the custom-provider checks in `model-drift.js` — today they duck-type defensively and treat unparseable shapes as "cannot judge".
- **Why:** Both flagged in the 2026-09-01 CEO/eng retro-review of the model-drift feature (with a Codex outside-voice pass) and accepted as follow-ups: (1) is a DRY/IO cleanup with no behavior change, (2) trades defensive silence for verified strictness — both beyond the review wave's blast radius.
- **Context:** lib/server/doctor/model-drift.js (scanSkillFilesForStaleModels, customProviderModelIds, collectConfiguredModels), lib/server/doctor/deterministic-checks.js (scanWorkspaceSkills). House rule for (2): verify against the tarball, never memory (see docs/designs/openclaw-context-contract.md doctrine).
- **Effort:** S each. **Depends on:** (2) needs the pinned upstream source handy.

## P3 — Google disconnect: verify no gog no-token stderr contract remains (2026-08-31, from the v0.9.64 fix wave)
- **What:** The v0.9.64 fix wave closed the red-team findings on disconnect: (1) a locked read-modify-write helper `updateGoogleState` now serializes the disconnect removal AND the OAuth-callback upsert (both read fresh under one lock — the lost-update / disconnect-vs-reauth race is closed); (2) `gogCmd` now returns `timedOut`/`code`, and a TIMED-OUT token export is treated as retryable (keeps the account) instead of orphaning a live token; (3) disconnect now stops the account's Gmail watch (local serve process + `gmail watch stop`) before revocation via the injected `stopGmailWatch`. (4) grant-wide revocation: sibling rows are self-correcting — `/api/google/accounts` re-probes `gog auth list --check` on every fetch, so a sibling invalidated by a grant-wide revoke shows unauthenticated on the next status load; no persistent staleness, left as-is.
- **Remaining (P3, needs a live box):** a CLEAN nonzero (non-timeout) export failure still falls through to best-effort removal because AlphaClaw does not know gog's exact "no such account / no token" stderr string — verify that string against the pinned gog build and, if a clean nonzero can mean "transient but not killed" (e.g. locked keyring exiting nonzero without timeout), route it to retryable too. Contract-test it; do NOT guess the string.
- **Context:** lib/server/routes/google.js (disconnect + callback now use `updateState`), lib/server/google-state.js (`updateGoogleState`), lib/server/commands.js (`gogCmd` timedOut/code), lib/server/init/register-server-routes.js (stopGmailWatch wiring).
- **Effort:** S. **Depends on:** a box with a configured Gmail account + the pinned gog build.

## P2 — Chat-reliability ship-review deferrals (2026-08-31, grouped)
- **What:** (1) Wire `send-outbox.clearAll()` (and the chat draft keys) to auth-IDENTITY change, not just the explicit-logout `localStorage.clear()` — a session that expires before a different member logs in on the same browser resurrects the previous member's queued message content via `restoreOnLoad()` (security specialist, conf 6). (2) Debug-payload wire negotiation: history responses always carry `rawHistory` + per-row `rawMessage`, and tool stream frames carry `rawEvent` — 2x+ payload inflation for data only the `?chatDebug=1` drawer reads; add a `debug:true` request field / `?includeRaw=1` and strip otherwise (perf specialist; the replay-buffer copy already strips rawEvent). (3) Chat hook test harness batch — use-chat-store/-connection/-composer glue is untested (frame router reqId guard, 2s refetch dedupe coalescing, legacy single-shot markAcked, handleClosed fan-out, draft-debounce blur/unload flush, cancel-append); the mocked-preact-hooks harness pattern (tests/frontend/watchdog-tab.test.js) applies. Also: browser-keepalive terminate side (needs a non-ponging fake in wss.clients), a `gatewayPingIntervalMs` timing override + wedged-gateway test, and an express-level `/api/chat/history` passthrough test. (4) Consolidate `gateway-client.js`'s `resolveTokenValue`/`getGatewayToken` with `gateway-credential`'s `resolveConfigSecret` (subtly different regex + no SecretRef guard; behavior-pinned by the auth-token tests, so consolidate with care).
- **Why:** Each flagged by the /ship review army (security/performance/testing/maintainability specialists) and verified real; deferred as beyond this wave's blast radius — none is user-visible on the happy path and the risky lifecycle logic beneath them is covered (83% diff coverage, ~160 chat tests).
- **Context:** lib/public/js/components/chat/send-outbox.js (clearAll), lib/server/chat/{index,send-service}.js (raw* fields), lib/server/chat/gateway-client.js (credential resolver, ping override), tests/frontend + tests/server/helpers/chat-gateway-harness.js.
- **Effort:** S each, except the hook-harness batch (M). **Depends on:** (1) an identity signal in the UI (pairs with the per-operator attribution item below).

## P2 — Chat-reliability adversarial-review deferrals (2026-08-31, grouped)
- **What:** (1) Cross-tab outbox deletion sync — removal tombstones are tab-local, so when two tabs restored the same item, tab A's confirm/discard can be resurrected by tab B's next merge-on-fresh-read persist; fix is persisted shared tombstones or a `storage`-event listener that drops removed ids live. (2) Clock-skew-proof outbox confirmation — `mergeHistory` confirms sent items against gateway history timestamps within [−60s, ack+30s] using the browser clock; >60s skew (VPS without NTP, wrong browser clock) means user messages never confirm and render twice; needs a server-supplied clock offset (e.g. `hello.serverNow`) or an id-based confirmation signal. (3) Resume amplification at team scale — every socket gets ALL registry runs in `hello.activeRuns` and resumes each one: ≥60 org-wide active runs would trip the 60-frames/10s inbound flood cap on reconnect (reconnect storm) and every tab receives every member's token streams (bandwidth, and the acknowledged any-member-reads-any-session posture); needs per-tab relevance filtering (e.g. resume only sessions the tab has state for) once per-operator attribution exists. (4) Stall-sweeper vs long-running tools — a >5-min-silent tool call (common for builds) gets finalized `interrupted` + `holdFlush`, and the run's REAL lifecycle:end then arrives for an unknown runId and is buffered forever instead of drained; consider a gateway-side liveness probe or draining buffered terminals against the store's terminal rows.
- **Why:** Flagged by the /ship adversarial passes (Claude + Codex, fresh-context attacker prompts) and verified real, but each needs a design decision (identity signal, clock contract, attribution model) beyond this wave's blast radius. The wave's fixes for the same passes' criticals (terminal-replay retry block, stale gateway sockets, unbounded chat-runs.db growth, late-stop cross-run kill, interruptedLocal wedge) all landed in v0.9.52.
- **Context:** lib/public/js/components/chat/send-outbox.js (tombstones), transcript-store.js (confirmation window), lib/server/chat/index.js (activeRuns fan-out), send-service.js (sweeper + buffered terminals).
- **Effort:** S–M each. **Depends on:** (1)/(3) pair with the identity/attribution items above; (2) needs a small protocol addition.
## P2 — Hardening dismissal-key granularity + freshness stamp (2026-08-31, from ship adversarial review)
- **What:** (1) `det:hardening:blocked` is one sourceKey across distinct causes (missing_file / escapes_workspace / file_too_large): a user who dismisses a benign missing-file P0 permanently suppresses doctor cards AND scheduled-scan triggers for a later escaping-symlink block (`service.js` readDismissedSourceKeys + the scan-trigger candidateKeys gate). Split the key per reason (`det:hardening:blocked:<reason>`) or reset the dismissal when the reason set changes — either changes dedupe semantics, so it needs its own review. Mitigation shipped: the General hardening card is non-dismissible and always renders. (2) The card's "updated {time}" stamps the payload's FIRST RENDER (module WeakMap), not SSE delivery — opening the tab after being away overstates freshness by up to the SSE re-emit gap; stamping at the app-shell receive site would fix it.
- **Why:** Both flagged by the ship adversarial review as real but judgment-bearing; neither is a regression (the shared key predates this wave).
- **Context:** lib/server/doctor/deterministic-checks.js (sourceKey), lib/server/doctor/service.js (dismissal filter + scan trigger), lib/public/js/components/general/hardening-card.js (getStatusReceivedAt), lib/public/js/hooks/use-app-shell-controller.js (receive site).
- **Effort:** S-M each. **Depends on:** a decision on dismissal semantics.

## P3 — Actionable-error wave deferrals (2026-08-31, grouped)
- **What:** (1) "Run Doctor scan" action on the General hardening card — closes the badge-vs-card timing gap from the General side (needs run-state management on a new surface); (2) Doctor context meter rows for `exists:false` rejected/missing files (the meter filters them today; the General card + P0 card + the meter hint line cover the state); (3) for the record: a direct blocked-flip notification pathway was considered and SKIPPED — scheduled scans + new-P0 dedupe already notify when enabled, and a parallel path risks storming the notification-dedup seam (`openIncident()`/`sentIncidentNotifications`); (4) migrate the watchdog incidents anchor parser (`incidents/helpers.js` parseIncidentAnchor) to the shared `lib/public/js/lib/hash-query.js` helper — works today, second parser exists only until migrated; (5) a "Restart AlphaClaw" CTA on the hardening card reusing the existing restart flow — the most common remediation is restart, but wiring lifecycle actions into a new card deserves its own change; (6) tap-to-toggle open for the shared Tooltip — `tooltip.js` suppresses focus-open on tap (suppressFocusOpenRef), so ALL tooltips are unreachable on touch today; fixing the primitive fixes every surface at once; (7) tokenize the incident/focus highlight color (`border-cyan-500/60` → a `--color-focus-highlight` theme token; migrate watchdog incidents alongside); (8) design exploration: an AlphaClaw system-status motif — a compact "AlphaClaw rules → OpenClaw bootstrap → Agent" context-path visual with the broken step marked, shared by hardening/gateway/doctor status.
- **Why:** All surfaced during the actionable-error plan reviews (CEO/design/eng + three codex passes) and individually decided as defer/skip; each is either a second door to a covered state, a systemic primitive fix that deserves its own change, or polish.
- **Context:** lib/public/js/components/general/hardening-card.js (new card), lib/public/js/components/doctor/context-budget-meter.js (hint line), lib/public/js/components/tooltip.js (tap suppression at onPointerDown), lib/public/js/lib/hash-query.js (shared parser), lib/public/css/theme.css (token layer). The plan that produced these lives in the quito-v2 review history.
- **Effort:** S each except (6) M and (8) design-only. **Depends on:** nothing.

## P2 — v0.9.49 fix-wave deferrals (2026-08-31, grouped)
- **What:** (1) repo-wide mkdtempSync leak sweep — ~47 test files mint temp dirs with no cleanup (e.g. `tests/server/gateway-medic.test.js`, `team-service.test.js`, `routes-pairings.test.js`, `safe-path.test.js`, and `tests/setup-agent.js`'s per-worker `real-git-*` shim dir); copy the `kTempDirs` + module-scope `afterEach` pattern now used in `routes-models`/`routes-browse` (canonical original: `tests/server/import-applier.test.js:11-22`). (2) node-pty adoption for TRUE live terminal resize (ioctl/TIOCSWINSZ + SIGWINCH) — stdin-injected `stty` was rejected in review because it corrupts a running TUI's stdin; today a new size applies only at (re)spawn. Cost: native module in the `node:22-slim` image (needs prebuilds or a build stage). (3) shared oauth pending-flow-store extracted from the near-identical maps in `routes/codex.js` and `routes/google.js` (duplication was deliberate in the wave to keep blast radius small). (4) askpass mkdtemp dir cleanup lifecycle — all three `writeGitAskpassScript` call sites leak one 0700 dir per run/boot into tmp (accepted tmp-reaper exposure; a boot-time sweep of stale `alphaclaw-askpass-*` dirs would close it), and `lib/scripts/git-askpass` is now an unused copy source (content identical to `kGitAskpassScript`) — retire it once nothing external references it. (5) decide whatsapp `sync: false` semantics — the flag is declared in kChannelDefs but deliberately NOT honored (honoring it would end env-clear auto-removal for whatsapp; behavior is pinned by a gateway test); either enforce it with a migration note or delete it. (6) #121 deterministic doctor check for stale storage guidance (rendered AGENTS.md naming a root outside managedRoot) — needs false-positive design: the merged file legitimately contains other absolute paths (machine profile, setup URL). (7) full Signal parity: `kChannelEnvKeys`/`kChannelLabels` in `agents/shared.js` need an explicit token-less branch first (`deriveChannelEnvKey` at shared.js:226-231 would return undefined and pollute `getConfiguredChannelEnvKeys`), then `routes/pairings.js:10,:293` allowlists and `welcome-pairing-step.js`'s duplicate meta map. (8) google.js consent-denied path still redirects to `/setup?google=error` instead of the popup postMessage HTML the UI listens for — a denied consent strands the popup on /setup with no toast.
- **Why:** Each flagged by the wave's CEO/eng/outside-voice reviews as real but deliberately out of the bug-fix wave's blast radius.
- **Context:** upstream cross-links: chrysb/alphaclaw #76 (resize), #113 (parity), #121 (doctor check), PR #123 (sweep). The wave itself: see CHANGELOG 0.9.49.
- **Effort:** S each, except node-pty (M) and Signal parity (M).


## P3 — Chat: session deep-links (2026-08-31)
- **What:** Put the selected session in the URL (`/chat/<sessionKey>`, per-segment encoded like OpenClaw's session-path grammar) so chat sessions are deep-linkable and back/forward-navigable.
- **Why:** Navigation parity with the rest of the app; today `/chat` carries no session and reloads land on the last-selected key from localStorage.
- **Pros:** Shareable links, browser history works. **Cons:** Touches app-shell routing conventions beyond the chat folder.
- **Context:** Deferred by the 2026-08-31 chat-reliability CEO review (see docs/designs/chat-reliability.md). Selection state lives in lib/public/js/app.js + hooks/useAgentSessions.js (`kAgentLastSessionKey`).
- **Effort:** S-M. **Depends on:** nothing.

## P3 — Chat: history pagination beyond the 200-row window (2026-08-31)
- **What:** A "load older" affordance for chat history. The bridge now reports an honest `truncated` flag (fetch 201, trim), but protocol-4 `chat.history` has no cursor.
- **Why:** Long-running sessions cap at the newest 200 rows.
- **Pros:** Full-history reading. **Cons:** Blocked on upstream cursor support; needs a capability probe (house rule: probe behavior, never version-gate — lib/server/openclaw-capabilities.js).
- **Context:** Deferred by the 2026-08-31 chat-reliability reviews; `kHistoryLimit` in lib/server/chat/index.js, merge path in lib/public/js/components/chat/transcript-store.js is already merge-by-id so prepending older pages is straightforward client-side.
- **Effort:** M. **Depends on:** upstream OpenClaw history cursor.

## P3 — Chat: session-list push over SSE instead of polling (2026-08-31)
- **What:** Push session-list changes over the existing status SSE (`/api/events/status` pattern) instead of the 30s visibility-paused poll + 15s server micro-cache that shipped with the chat rework.
- **Why:** Removes polling entirely; today's mitigation already coalesces N tabs into one `openclaw sessions --json --all-agents` spawn per 15s window.
- **Pros:** Real-time sidebar, zero per-tab churn. **Cons:** OpenClaw exposes no session-change event, so the server would still poll the CLI once centrally — modest win over the micro-cache.
- **Context:** Eng-review D6 (2026-08-31); micro-cache in lib/server/routes/system.js (`agentSessionsCacheTtlMs`), poll in lib/public/js/hooks/useAgentSessions.js.
- **Effort:** M. **Depends on:** ideally an upstream session-change signal.
## P3 — Rescue login modal: label the OAuth link instead of rendering the raw URL
- **What:** The guided-login modal renders the full OAuth authorize URL as a 9-line wrapped link; show a short label ("Open claude.ai login") with the raw URL in a copyable line beneath.
- **Why:** Cosmetic (found by /qa on vientiane, 2026-08-31, ISSUE-001); functional as-is.
- **Context:** lib/public/js/components/claude-code-local-setup-modal.js, awaiting_code state. Evidence: .gstack/qa-reports/screenshots/login-modal-awaiting-code.png.
- **Effort:** S. **Depends on:** nothing.

## P3 — Resource-autotune ship-review follow-ups (2026-08-29, grouped)
- **What:** (1) container-hook tests for `WatchdogAutotuneCard` (restartSignal/detectedAt refetch triggers, per-context save isolation, heap-input validation toast, reapply/dismiss flows — only the presentational view + builders are covered); (2) `launchGatewayProcess` spawn-stamp glue test (heap regex from childEnv, UV match) at the call site; (3) extract the copy-pasted cgroup fs-spy/containerFsModule test fixtures (×6 files) into a shared tests helper; (4) unify the three machine-summary assemblies (agent-admin/skill.js `gatherLiveState`, routes/system.js `buildMachineSummary`, onboarding/workspace.js `renderMachineProfileMarkdown`) on one summarizer with per-surface sanitization at call sites; (5) hoist the 3500ms post-restart settle-refetch literal (autotune-card, incidents hook, general tab) into a shared constant; (6) design pass items for /design-review: collapse the N-identical "Restart gateway now" per-row buttons into a single affordance, and move underlined text-button actions (Restart/Copy) onto ActionButton; (7) ~~downsize-specific urgent-toned resize notification~~ (DONE v0.9.54 — any shrinking dimension gets the ⚠️ OOM-pressure copy, tested); (8) apply the shared cache pragma at cron-store's TTL reopen (+ decide agent-admin/usage sites); (9) a `pruneBackups` advisory-budget warning test; (10) an explicit boot-order test (autotune apply completes before `doSyncPromptFiles`, machine line present in first-boot artifacts with a GPU fixture).
- **Why:** All flagged by the /ship specialist review or plan-completion audit; each deferred as churn-vs-risk at ship time — none is user-visible today, and the risky logic beneath them is covered (82% diff coverage, regressions pinned).
- **Context:** lib/public/js/components/watchdog-tab/autotune-card.js, lib/server/gateway.js (spawn stamp), lib/server/machine-summary.js (new shared prompt summarizer to extend), lib/server/cron-store.js, lib/server/openclaw-channel-sync.js (advisory block), lib/server/startup.js.
- **Effort:** S each. **Depends on:** nothing.

## P3 — Resource-autotune adversarial-review deferrals (2026-08-29, grouped)
- **What:** (1) CPU detection should take the MOST restrictive of quota and cpuset (`min(quota, cpuset)`) instead of first-match, and the cgroup-v2 `cpu.max` guard should reject zero/negative quotas like the v1 path does (pre-existing main behavior, inherited unchanged — `lib/server/system-resources.js` getAllocatedCpuInfo); (2) `detectEnvironment`'s bare `"0::/"` cgroup heuristic classifies non-systemd bare metal (Alpine/OpenRC) as a container, silently suppressing autotune there (fail-safe direction; add an `lxc` token while at it); (3) `markPendingGatewayRestart` re-marks restart-required for pre-existing pending rows not caused by the current PUT (mild over-nag); (4) the mtime+size probe/config caches can serve a stale parse verdict for a same-size same-millisecond rewrite (negligible under writeFileAtomic); (5) telegram-sync writes >64 made under a raised machine cap are not ledger-attributable, so the disable revert leaves them for the NEXT telegram sync to clamp back to the legacy 64 (self-heals at boot/channel sync; consider stamping sync writes with provenance if a non-syncing deployment surfaces).
- **Why:** Flagged by the cross-model adversarial pass (Codex F13 + Claude minors), verified as real-but-not-merge-blocking: each is either pre-existing main behavior, fail-safe in direction, or self-healing.
- **Context:** lib/server/system-resources.js, lib/server/machine-profile.js (detectEnvironment), lib/server/routes/autotune.js (markPendingGatewayRestart), lib/server/alphaclaw-config.js (kAutotuneProbeCache), lib/server/autotune.js + telegram-workspace.js (sync-write provenance).
- **Effort:** S each. **Depends on:** nothing.

## P3 — Verify gateway daemon does not need GOG_KEYRING_PASSWORD in-process (from A4 gateway-env allowlist)
- **What:** v0.9.60's gateway-env allowlist (lib/server/gateway-env-policy.js) denies GOG_KEYRING_PASSWORD to the OpenClaw child. AlphaClaw's own `gog` spawns re-inject it (commands.js, gmail-watch), but if the openclaw gateway daemon (or a gog subprocess it spawns for OAuth-backed Gmail channels) relies on INHERITING it to unlock the keyring, stored Google credentials would silently fail to decrypt.
- **Why:** Denying a keyring password from the deployed agent is the security-correct default, but it must not silently break Gmail-via-agent. Confidence was moderate (the daemon may never read it in-process).
- **Context:** Runtime-verify on a box with a configured Gmail channel that the agent can still send/receive after the allowlist; if it needs the password, re-inject it on the daemon launch env AFTER the filter (as the gog spawns do) rather than relaxing the deny. Recover in the meantime with ALPHACLAW_GATEWAY_ENV_PASSTHROUGH=GOG_KEYRING_PASSWORD.
- **Effort:** S. **Depends on:** a live Gmail-channel test box.

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

## ~~P3 — Serialize alphaclaw.json writers under a file lock~~ (DONE, resource-autotune branch)
- Most writers already routed through the locked `updateAlphaclawConfig`; the last unlocked read-modify-write (`updateTeamSettings`) was migrated with the autotune config work. Nothing remains.

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
- **What:** (a) Per-member chat/session isolation — team mode v1 keeps global agent sessions (channels, hooks, crons) with no owner column, so a member can enumerate (`GET /api/usage/sessions`) and read/send to (`GET /api/chat/history`, chat WS) ANY session; documented in `lib/server/chat/gateway-client.js` ("chat traffic is NOT attributed per-operator in team mode v1"). A real fix adds an owner/attribution column to usage_events + a visibility filter keyed on `req.alphaclawIdentity`. (b) Role demotion only takes gateway effect on the next restart (`restartRequired:true`) — the running gateway keeps the old operator scope until then (OpenClaw captures auth at startup). (c) Verified restart-handoff for `OPENCLAW_SUPERVISOR_MODE=external` (2026.8.1+): env plumbing ships default-on, but `openclaw-restart-handoff.js` has no production caller, so a gateway-initiated fresh-process restart could feed watchdog crash accounting (mitigated: `OPENCLAW_NO_RESPAWN=1` keeps routine restarts in-process, 50s expected-exit window). (d) `getAdvertisedScopes` is not wired in production, so the scope-name intersection guard is a no-op (mitigated: names are hardcoded to live-verified OperatorScopeSchema values).
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

## P3 — Watchdog status gatewayPid stays null
- **What:** `GET /api/watchdog/status` reports `gatewayPid: null` after boot and after a managed restart while lifecycle is `running`. Both gateway.js launch emit sites pass `pid: child.pid`, so some path drops it before/after the watchdog's `state.gatewayPid = pid` (launch-handler destructure, an exit-time reset racing the relaunch, or the restart-cmd path). Trace and fix; add a status assertion to the launch tests.
- **Why:** Display/diagnostic gap only — the restart-handoff consume reads the EXIT payload's own pid (verified present live), so behavior is unaffected; but a null pid in status misleads operators and weakens the `?? state.gatewayPid` fallback.
- **Context:** Found by /qa on brussels (2026-08-29), ISSUE-003 in .gstack/qa-reports/qa-report-localhost-3000-2026-08-29.md. lib/server/watchdog.js (state.gatewayPid), lib/server/gateway.js launch handlers.
- **Effort:** S.

## P3 — Watchdog health-timeline sparkline
- **What:** Small timeline strip on the watchdog page showing health-check outcomes/gateway state over the last 24h (data already persisted in watchdog_events).
- **Why:** "Was it flapping overnight?" currently requires reading incident rows one by one.
- **Effort:** S-M.

## P3 — Notification remediation-action parity (PARTIALLY DONE, v0.9.54)
- **What:** Alerts name the primary remediation with the same action vocabulary as the card's `actions[]`; today they share state labels and deep links but not the action wording.
- **Done:** the crash-loop-paused notice names Retry/Repair (the `down` state's catalog actions) with a parity test against `actionsForState` (tests/server/auto-fix-notifications.test.js); auto-resolving notices deliberately stay action-free. Remaining: sweep the OTHER pre-existing alerts (config-error latch, rollback notices) for the same treatment.
- **Context:** Copy source: lib/server/gateway-state.js catalog + actionsForState (now exported).
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

## P3 — Retire the unwired upstream restart-handoff stub
- **What:** lib/server/openclaw-restart-handoff.js (landed with the v0.9.37-39 merge) has zero requirers and encodes a guessed consume-response schema (`doc.consumed || doc.accepted || doc.restart`). The wired implementation is lib/server/gateway-restart-handoff.js, whose parsing follows the tarball-verified protocol (`protocol` marker + `status:"accepted"` + nested `handoff`). Delete the stub, or fold any capabilities-gating advice from it into the wired module first. Related: gate the consume spawn on the `restartHandoff` capability probe (openclaw-capabilities.js) so stable installs skip the bounded 5s CLI attempt — gateway.js's injectable param is ready for that wiring.
- **Why:** Two modules claiming the same contract invite the wrong one being extended; the stub's schema is unverified.
- **Context:** Merge-resolution finding (2026-08-29); verified contract in docs/designs/openclaw-context-contract.md §lifecycle appendix.
- **Effort:** S. **Depends on:** nothing.

## P3 — Live-tier openclaw backup CLI contract regression test
- **What:** One tests/live assertion that a real `openclaw backup create --output <file>` writes exactly at the given path (refusing when it already exists) and `--output <dir>/` writes a timestamped archive inside the directory.
- **Why:** Issues #7/#9 existed because every test stub encoded an unvalidated assumption about the CLI's `--output` contract; the contract is now verified from openclaw@2026.7.1-2 dist source, and a live guard catches future CLI changes.
- **Context:** `createBackupStubRunner` (tests/live/live-helpers.js) stubs backup in the live tier; contract notes in the #7/#9 fix PR.
- **Effort:** S. **Depends on:** live tier (`OPENCLAW_LIVE_E2E=1`) with a real openclaw build.

## P3 — Enforced backup pruning to the autotune byte budget
- **What:** The resource-autotune branch shipped the ADVISORY half of size-aware retention: a disk-derived budget (`backupMaxTotalGb`, 20% of the backups volume clamped 2–60GB) that warns via `pruneBackups` and renders in the autotune ledger when the kept archives exceed it. Remaining: an opt-in ENFORCED mode that actually prunes below keep-3 toward the budget (always keeping ≥1 archive), plus surfacing backup disk usage in the UI.
- **Why:** Auto-deleting verified backups is destructive and non-revertible, so enforcement needs its own explicit opt-in design (per the plan's outside-voice review) — the advisory warning covers the ENOSPC-awareness gap meanwhile.
- **Context:** `kOpenclawBackupKeepCount` (lib/server/constants.js), `pruneBackups` + the advisory block (lib/server/openclaw-channel-sync.js), `getBackupMaxTotalBytes` (lib/server/autotune.js).
- **Effort:** S-M.

## P2 — Latch shutdown state before the self-update restart drain
- **What:** `restartProcess` (lib/server/alphaclaw-version.js) calls `serverLifecycle.drain()` without setting the lifecycle's `exiting` latch, so a SIGTERM or uncaughtException landing inside the ≤10s drain window starts a second concurrent drain and exits before the successor process is spawned — on an unsupervised VPS that means a self-update ends with nothing running. Route the restart through a lifecycle method (e.g. `prepareForRestart()`) that latches `exiting` and disarms signal re-entry, or move the respawn inside the guarded exit path.
- **Why:** Red-team finding on the downtime-remediation ship review (2026-08-28); bounded window but the failure mode is "permanently down after update".
- **Effort:** S. **Depends on:** nothing.

## P2 — Keep the workspace manifest inside the fingerprint worker
- **What:** Each background snapshot refresh round-trips the full manifest (multi-MB at 15k+ files) through `postMessage`, costing ~7ms serialize + ~15ms deserialize on the main thread per refresh. The worker is persistent — cache the previous manifest worker-side (send it only on the first request) and return only fingerprint/limited/stats (and, with the delta moved worker-side, the computed delta). Also cover the sibling main-thread cost: run-create JSON.stringifys the full manifest for the SQLite write (db/doctor createDoctorRun) — serialize it in the worker (ship the JSON string) or move the blob write off the run-insert critical path.
- **Why:** Last recurring main-thread stall on the status path (bounded: once per ≤60s refresh window). Ship-review performance finding, 2026-08-28. **Bumped P3→P2 on the deliverable-fix-dispatch wave (2026-08-31): the default cap raise to 200k files quadruples the clone cost for over-cap workspaces.** Partially mitigated on that wave: the worker now omits the manifest from the result message when the fingerprint is unchanged (steady-state refreshes are clone-free), so the remaining cost is changed-workspace refreshes only.
- **Context:** lib/server/doctor/workspace-fingerprint.js (worker round-trip), lib/server/doctor/fingerprint-worker.js, lib/server/doctor/service.js (`calculateWorkspaceDelta` call site).
- **Effort:** M. **Depends on:** nothing.

## P3 — Ship-review maintainability follow-ups (2026-08-28, grouped)
- **What:** (1) ~~shared `applyOperationalPragmas(db)` helper~~ DONE on the resource-autotune branch (lib/server/db/pragmas.js, with an autotune-scaled negative-KiB `cache_size`); (2) shared cron run-log tail-read helper (block repeated ×3 in cron-service.js); (3) shared `sleep` util (5 private copies); (4) one `kDoctorRepairTimeoutMs` constant for the 10-minute doctor-fix ceiling spelled in server.js and watchdog.js; (5) shared 1s sync-file-lock timeout constant (openclaw-config.js + topic-registry.js); (6) extract the proxy error handler and terminal error middleware from lib/server.js into a module so routes-proxy.test.js stops testing a verbatim copy; (7) `stream.end()` + bounded await-finish as a drain step in log-writer so stream-buffered bytes survive shutdown (in-memory queue already flushes); (8) ~~make system-resources' loop-lag monitor injectable/stoppable~~ DONE on the resource-autotune branch (`startLoopLagMonitor({monitorFn, sampleWindowMs})` + `stopLoopLagMonitor`); (9) surface a `truncatedHistory` flag on cron run-history responses (256KB tail bound); (10) /v1-scoped error handler emitting the OpenAI error envelope for 413/400 parser errors; (11) SWR-cache `getGatewayPort` (sync read+parse per proxied request, sub-ms but unconditional); (12) ~~stat-cache `analyzeBootstrapContext` file reads~~ DONE on the Drift Doctor wave (createBootstrapContextAnalyzer mtime+size cache); (13) remaining test gaps: pairings single-flight/500 path, cron-store TTL-reopen/liveness cache, statusPayloadMemo invalidate-vs-in-flight race; (14) `Expect: 100-continue` proxied requests never get the post-header idle-timeout relaxation (http-proxy-3 skips the proxyReq event for them — consider stripping the header on the outgoing leg); (15) `installCrashGuards` removeAllListeners can drop dependency-registered process handlers — remove only known guards by reference; (16) browse preview TOCTOU: read at most limit+1 bytes from an fd instead of stat-then-readFileSync.
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

## P3 — Doctor per-run token cost display
- **What:** Show each doctor run's LLM token cost on the Doctor tab by joining usage.db on the run's session key (`agent:main:doctor:<n>`).
- **Why:** Scheduled scans (doctor autoRun) make doctor LLM spend recurring; operators should see what each scan cost before tuning frequency. Deferred from the 8.1 wave's CEO review.
- **Context:** doctor runs use deterministic session keys `agent:main:doctor:<n>`; usage.db already powers the usage views. Wave background in docs/designs/openclaw-context-contract.md.
- **Effort:** S. **Depends on:** Drift Doctor 8.1 wave landing.

## P3 — Session-kind context breakdown card
- **What:** A Doctor-tab card visualizing the per-session-kind injection matrix (main/subagent/cron/group-channel) from the active context profile — which bootstrap files each session kind actually receives.
- **Why:** Session-scope filtering is invisible today (on beta, subagents see only AGENTS.md; group chats lose MEMORY.md); operators assume every session sees the full workspace context. Deferred from the 8.1 wave's CEO review.
- **Context:** the matrix is data in lib/server/doctor/context-profiles.js; verified facts and citations in docs/designs/openclaw-context-contract.md §2 (session-scope matrix).
- **Effort:** S. **Depends on:** Drift Doctor 8.1 wave landing.

## P3 — Copy-fix-prompt button on doctor findings
- **What:** A copy-to-clipboard button on each doctor finding card exposing the card's fixPrompt, so operators can paste it into a session of their choosing.
- **Why:** Fixes stay explicit-dispatch by doctrine; a copy affordance gives a manual path without wiring any auto-dispatch. Deferred from the 8.1 wave's CEO review.
- **Context:** cards already carry fixPrompt (doctor service); UI-only change in the Doctor tab.
- **Effort:** S. **Depends on:** Drift Doctor 8.1 wave landing.

## P3 — Stable notify keys for LLM doctor cards
- **What:** maybeNotifyNewP0s dedupes LLM P0s by exact title (no sourceKey); a persistent P0 the model rewords re-notifies each scan. Derive a stable key (hash of category + sorted targetPaths) or feed prior open-card titles into the doctor prompt with reuse instructions.
- **Why:** Notification fatigue once scheduled scans are on.
- **Context:** lib/server/doctor/service.js maybeNotifyNewP0s cardKey; prompt.js.
- **Effort:** S.

## P3 — SQLite snapshot retention (keep-N)
- **What:** Keep-N retention for the SQLite snapshot repository at `<root>/backups/openclaw-sqlite/` (each `backup sqlite create` adds a new snapshot directory; nothing prunes them).
- **Why:** The verified 8.1 contract makes `--repository` required on create, so snapshots accumulate unboundedly in our managed directory; companion to the size-aware archive retention entry above.
- **Context:** create/verify contract in docs/designs/openclaw-context-contract.md §5 (`backup sqlite` CLI); `kOpenclawSqliteBackupDir` (lib/server/constants.js, added by the wave's backup-runner fix); pattern precedent in `pruneBackups` (lib/server/openclaw-channel-sync.js).
- **Effort:** S. **Depends on:** the wave's backup sqlite runner fix landing.

## P3 — doctor.db retention (raw_result_json + dismissed-keys residual)
- **What:** ~~workspace_manifest_json growth~~ DONE on the deliverable-fix-dispatch wave (2026-08-31): `pruneRunManifests` keeps manifests only on the newest 2 manifest-bearing runs plus the latest completed run. Residual: reuse runs still clone raw_result_json with no pruning, and the dismissed-keys DISTINCT scan grows with total rows. Add keep-N retention for raw_result_json blobs while preserving dismissed source_keys (they feed suppression).
- **Why:** Remaining unbounded disk growth on VPS installs (the partial index added earlier mitigates the query, not the growth).
- **Context:** lib/server/db/doctor/ (`pruneRunManifests` is the pattern to extend); precedent in `pruneBackups` (lib/server/openclaw-channel-sync.js).
- **Effort:** S.

## P3 — Stale `working`-card reaper for Doctor fixes
- **What:** The fix dispatch is fire-and-forget (`gateway call agent` without `--expect-final`): a card whose agent crashed, refused, or never ran the completion callback stays `working` forever unless the operator clicks Reopen. Add a TTL reaper (e.g. revert to `open` after 24h with a note on the card) driven off `fix_started_at`, and consider `--expect-final`-style delivered-confirmation as the fuller fix.
- **Why:** Zero-silent-failures residual from the deliverable-fix-dispatch wave (2026-08-31): the dispatch record (`fix_delivery_json`) shows dispatch state, but post-acceptance failures still need manual cleanup.
- **Context:** lib/server/doctor/service.js (dispatch at requestCardFix), lib/server/db/doctor (fix_started_at column exists), manual Reopen in lib/public/js/components/doctor/findings-list.js.
- **Effort:** S-M. **Depends on:** nothing.

## P3 — Verify delivery-route grammar for WhatsApp JIDs and Discord/Slack thread keys
- **What:** The typed reply-target mapping treats peer ids as single colon-delimited segments, so a device-suffixed WhatsApp JID (`1234:12@s.whatsapp.net`) would truncate at the first colon, and discord/slack `group:<id>:topic:<thread>` keys drop the thread id (replies go to the channel, not the thread). Verify against the pinned openclaw whether such key shapes are ever emitted; add typed support + parity-matrix rows if so.
- **Why:** Adversarial-review finding on the deliverable-fix-dispatch wave (2026-08-31); risk today is low (such keys were entirely non-deliverable before the wave, and a truncated JID fails rather than misdelivers) but the grammar should be contract-verified. Related pre-existing hardening: clawCmd uses exec with the default 1MB maxBuffer — a huge `sessions --json --all-agents` output errors the lookup (now honestly a 502).
- **Context:** lib/server/utils/session-keys.js (getReplyTargetFromSessionKey), tests/server/session-keys.test.js (kDeliveryMatrix), tests/live/doctor-fix-dispatch-contract.e2e.test.js.
- **Effort:** S. **Depends on:** nothing.

## P3 — gitignore-aware workspace scanning (git fast path)
- **What:** When the workspace is a git repo, use `git status --porcelain`/`git ls-files` as the change oracle instead of walking+hashing everything — free .gitignore semantics, native speed, and the static `kIgnoredDirectoryNames` list becomes a fallback for non-git workspaces only.
- **Why:** The principled fix for huge-workspace scans (the 2026-08-31 wave raised caps and trimmed ignores, which covers today's cases but keeps hashing build junk in repos with unusual layouts). Changes fingerprint semantics → one full re-analysis on rollout.
- **Context:** lib/server/doctor/workspace-fingerprint.js (walkFiles / kIgnoredDirectoryNames); scan caps config in lib/server/alphaclaw-config.js (doctor.scan).
- **Effort:** M. **Depends on:** nothing.

## P3 — Container-tier chaos leg
- **What:** Kill the container mid-download during a stable→beta apply and assert the fresh boot recovers cleanly onto the stable pin (no half-installed tree, gateway healthy). Extends tests/container/openclaw-container-upgrade.e2e.test.js with a second, shorter journey.
- **Why:** The container tier proves the happy-path restart; the crash-mid-apply recovery path is only covered by hermetic boot tests today — a real-image chaos leg would prove it against the real installer.
- **Context:** tests/container/container-helpers.js (docker wrappers already support rm -f + fresh run on the same volume); hermetic coverage in the boot self-heal suites.
- **Effort:** S. **Depends on:** container tier landing.

## P3 — Placeholder authenticated detail view
- **What:** Serve rich progress/error strings behind login during the restart window — the current boot placeholder (lib/boot-placeholder.js) deliberately renders no error content to unauthenticated callers, so an operator watching a restart sees only the generic updating page until the real server binds.
- **Why:** During a failed activation the placeholder window is exactly when an operator most wants the step/error detail; today they must wait for the full UI (or read container logs).
- **Context:** lib/boot-placeholder.js, lib/boot-placeholder-child.js; the container E2E's best-effort placeholder observation (tests/container/openclaw-container-upgrade.e2e.test.js) documents the current unauthenticated behavior.
- **Effort:** M.

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

## P3 — Migrate WATCHDOG_AUTO_REPAIR / WATCHDOG_NOTIFICATIONS_DISABLED / WATCHDOG_NOTIFICATIONS_QUIET from env to alphaclaw.json
- **What:** Move the three legacy watchdog toggles into alphaclaw.json with env fallback + one-release deprecation note (the verbose toggle added a third env key, `WATCHDOG_NOTIFICATIONS_QUIET`, deliberately on the same backend so this migration moves all of them together).
- **Why:** New settings already live in alphaclaw.json (`watchdog.overseer.enabled`); the split store means `PUT /api/watchdog/settings` writes env while the overseer toggle writes config — two backends for one card.
- **Context:** `updateSettings` in lib/server/watchdog.js (updateEnvFile locked-RMW path) + `lib/server/notification-policy.js` env readers; never write env and config simultaneously.
- **Effort:** M. **Depends on:** nothing.

## P3 — Bin-phase boot-notices bridge (pre-server auto-fix notifications)
- **What:** Durable boot-notices JSONL in the state dir written by `bin/alphaclaw.js` auto-fixes (pending-update self npm-install, openclaw.json restore from the git remote, pre-server config migrations), drained through `upgradeNotifier.notify` at server boot — mirroring channel-sync's `lastBoot.notifications` envelope pattern.
- **Why:** These are genuine automatic fixes that today only reach the console; the verbose/important notification work (v0.9.54) covers the server phase only.
- **Context:** No notifier exists in the bin process; `flushBootNotifications` (lib/server/openclaw-channel-sync.js) is the drain precedent. Classify all as important (action taken).
- **Effort:** M → CC: S. **Depends on:** nothing.

## P3 — Suppressed-notice digest/history
- **What:** Daily digest (or Watchdog-tab history pane) of notices suppressed by Important-only mode.
- **Why:** Quiet-mode operators may want a low-frequency rollup of what they didn't see.
- **Context:** The outbox has a terminal `suppressedAt` state (flush-time suppressions), but the MAJORITY of suppressed notices are discarded pre-outbox by the enqueue gate in lib/server/upgrade-notifier.js — the digest needs enqueue-time persistence of suppressed events (deliberately rejected for v1 to keep the outbox lean).
- **Effort:** M. **Depends on:** nothing.

## P3 — Gmail-watch respawn notification with a repeated-failure threshold
- **What:** Notify when the `gog serve` child keeps dying (lib/server/gmail-watch.js respawns every 5s, console-only today).
- **Why:** The one remaining server-phase auto-fix loop with zero notification coverage; the raw 5s cadence needs a breaker (N consecutive failures) before notifying or it spams.
- **Effort:** S. **Depends on:** nothing.

## P3 — Gateway went-down notice debounce
- **What:** Optional N-second debounce suppressing the down+up notification pair for transient blips.
- **Why:** Only if the accepted volume delta (a single crash+recovery now notifies both ways with Verbose ON; previously silent) proves chatty in practice — deliberately NOT built in v1 to keep timers out of the crash path.
- **Context:** `notifyOncePerIncident("gateway_went_down", ...)` in lib/server/watchdog.js handleCrashExit.
- **Effort:** S. **Depends on:** field feedback.

## P3 — StatusHero card absorbing the shared Gateway card on the Watchdog tab
- **What:** Merge the Gateway card + status details + narrative card into one hero for the Watchdog tab (the shared Gateway card stays for other tabs).
- **Why:** Three stacked cards carry one mental model; a hero reads faster. Deferred from the wave because forking a shared component was extra surface for equal information.
- **Effort:** M. **Depends on:** watchdog wave shipped.

## P3 — Resource telemetry follow-ups: configurable thresholds, sparklines/history
- **What:** Optional alphaclaw.json keys for the (currently hardcoded 80/90%) resource warn/crit display thresholds; small ring buffer + sparklines for memory/CPU/event-loop lag.
- **Why:** Deferred as expert knobs / width-hungry UI; revisit on demand. Display-only either way.
- **Update (memory-leak wave):** the gateway RSS ring buffer now EXISTS (in-memory, ~120 samples, inside `lib/server/gateway-memory-monitor.js`) — a memory sparkline only needs a read path from the detector's sample window to the resources payload.
- **Effort:** M. **Depends on:** nothing.

## P3 — Resource-based alerting/enforcement (design needed — invariant territory)
- **What:** Any watchdog *action* on resource signals (e.g., restart on sustained event-loop starvation or OOM pressure).
- **Why:** Today resources are report-only by design ("the deterministic watchdog is the ONLY enforcement layer" covers gateway health, not host resources). Changing that is a policy design, not a feature toggle.
- **Update (memory-leak wave):** DESIGNED AND SHIPPED for the gateway-memory case — the reviewed policy (opt-in default OFF `watchdog.memory.autoRestart`, watchdog-owned lifecycle lock, stabilization-window suppression, persisted 2-per-24h brake, expected-restart semantics; see the AGENTS.md memory-monitor bullet). CPU / event-loop / disk enforcement remains undesigned; any new signal must go through the same explicit-design bar, reusing the memory policy as the template.
- **Effort:** L. **Depends on:** explicit design review.

## P3 — AlphaClaw self-process memory-leak detection
- **What:** Run `createGatewayMemoryMonitor` against the admin server's own `process.memoryUsage().rss` (we are also a long-lived Node process with in-memory maps).
- **Why:** The detector is pure and signal-agnostic; the missing piece is mitigation semantics — the server cannot pre-OOM restart ITSELF safely (drain, pidfile, boot-placeholder interplay), so v1 would be detect+notify only.
- **Context:** Detector module `lib/server/gateway-memory-monitor.js`; the watchdog tick pattern in `checkMemoryTrend` is the wiring template. Deferred from the memory-leak wave CEO review (D7.3).
- **Effort:** M → CC: S. **Depends on:** nothing.

## P3 — Doctor LLM prompt: machine/memory context line
- **What:** Feed `getMachineSummaryForPrompt()` (now including `gatewayRssTrendMbPerHour`/`gatewayMemoryTrendState`) into the Drift Doctor LLM prompt.
- **Why:** The deterministic leak card already carries the finding; prompt context would only help the LLM tier reason about memory-adjacent workspace findings. Speculative until a real case shows the gap. Deferred from the memory-leak wave (D7.5).
- **Context:** `buildDoctorPrompt` (lib/server/doctor/prompt.js); machine summary consumers today are the medic + upgrade overseer.
- **Effort:** S. **Depends on:** nothing.

## P3 — V8-heap-precision gateway sampling (security review required)
- **What:** Upgrade the RSS proxy to real V8 heap numbers for the CHILD gateway — candidates: Node diagnostic report on signal (`--report-on-signal` + parse), an opt-in `/readyz` memory block if upstream ships one, or inspector-protocol `HeapProfiler` (least favored).
- **Why:** RSS conflates heap with allocator fragmentation/native memory; heap-precision would sharpen the leak-vs-fragmentation call and the heap-raise advice. Every candidate widens the gateway's attack/perf surface, so this needs its own security review — deliberately excluded from the memory-leak wave.
- **Context:** Detection seams: `readMemorySample()` dep in lib/server/watchdog.js; cap math in lib/server/gateway-memory-monitor.js (`computeEffectiveCap`).
- **Effort:** M. **Depends on:** security review.

## P3 — Calibrate tree-RSS vs single-process heap-cap pressure math
- **What:** `computeEffectiveCap` models ONE V8 process (`activeHeapMb + 192MB overhead`) but the pressure numerator is the whole process TREE from `getProcessTreeUsage` (launcher + worker + descendants, with per-process VmRSS double-counting shared pages). Options: compare max single-process RSS in the tree against the heap cap (tree RSS stays for the container cap), or size `gatewayNativeOverheadMb` to explicitly budget the launcher.
- **Why:** Tree-over-heap-cap structurally overestimates pressure — a busy-but-healthy gateway subtree could brush the 90% fast-path band; the inverse error underestimates co-residents in the container cap. Mitigated today by the fast path's rising-slope requirement and the critical 2-eval confirm, so a flat-at-92% gateway never restarts; this sharpens the margin rather than fixing a live false-positive. Red-team finding from the memory-leak wave ship review.
- **Context:** lib/server/gateway-memory-monitor.js (`computeEffectiveCap`, fast path); sampler in lib/server/watchdog.js (`readMemorySampleSafe`) already has per-pid granularity available in `getProcessTreeUsage`'s walk.
- **Effort:** S. **Depends on:** a live remeasure of launcher/worker RSS split (the wave's live e2e harness, tests/live/openclaw-live-memory.e2e.test.js, can produce it).
- **Also (same seam):** the subtree walk is synchronous on the main event loop (worst case ~8192 /proc status reads per uncached call; 5s TTL memo bounds frequency, typical containers are <300 pids ≈ ms). If a real deployment shows loop-lag spikes attributable to it, move the walk off-thread (fingerprint-worker precedent) or lower kMaxProcScan with an explicit truncation marker instead of silent cutoff.

## P3 — Corrupt-config write refusal for the remaining alphaclaw.json updaters
- **What:** `updateWatchdogMemorySettings` now refuses to write while alphaclaw.json exists-but-cannot-parse (error code `config_unreadable`, PUT /api/watchdog/memory → 409) — but the other updaters (`updateWatchdogSettings`, `updateAutotuneSettings`, `updateDoctorAutoRunEnabled`, `updateOpenAiCompatApiFeature`, etc., all built on `updateAlphaclawConfig`) still merge onto `kDefaultAlphaclawConfig` when the read falls back, silently rebuilding the whole file from defaults and destroying unrelated operator settings.
- **Why:** A "toggle write" during transient corruption (torn write, disk pressure) must not be the thing that makes the corruption permanent. Red-team finding from the memory-leak wave; fixed narrowly there to bound blast radius.
- **Context:** The guard belongs in `updateAlphaclawConfig` itself (lib/server/alphaclaw-config.js) — one existsSync+JSON.parse probe under the file lock, plus a route-level 409 mapping per caller. Template: the memory updater + routes/watchdog.js PUT handler.
- **Effort:** S. **Depends on:** nothing.

## P3 — Consume OpenClaw's own memory-pressure diagnostics as a corroborating signal
- **What:** Parse the gateway log line `[diagnostics/memory] memory pressure: level=critical reason=rss_threshold rss=... heap=...` (2026.9.1-beta.1+) into the watchdog memory monitor as a second, upstream-sourced signal beside the RSS trend — and surface its heap-vs-RSS split (a flat heap with runaway RSS indicates an off-main-isolate leak, e.g. a plugin, where heap raises cannot help).
- **Why:** Upstream now self-reports pressure with per-isolate heap numbers AlphaClaw cannot observe from outside; corroboration would cut false positives and sharpen the doctor card's plugin-vs-main-leak diagnosis.
- **Context:** Discovered during the memory-leak wave's live tier; log format is beta and unversioned — treat as an encoded assumption with a guard test, per the drift doctrine. Consumption point: the gateway stderr/stdout tail already flows through lib/server/gateway.js.
- **Effort:** M → CC: S. **Depends on:** log-format stability check against the next beta.

## P3 — Shared rolling-window rate-brake helper
- **What:** One `rollingWindowBrake` util for the three copies: medic runs (`medicRunTimestamps`), handoff relaunches (`handoffRelaunchTimestamps`), memory mitigations (`memoryMitigationTimestamps` — the persisted one).
- **Why:** Third copy shipped with the memory-leak wave; the persistence wrinkle (only the memory brake persists) is why it was not extracted inline.
- **Context:** All three live in lib/server/watchdog.js.
- **Effort:** S. **Depends on:** nothing.

## P3 — Capture the incident log window at close time
- **What:** Persist the timestamp-filtered gateway log excerpt when an incident closes (per-incident file or capped blob) instead of re-reading the tail at review time.
- **Why:** A late overseer review (stale-pending retry) on a busy log can lose the incident window; the wave ships a widened 256KB read + an explicit "may be partial" prompt label as the honest fallback. Capture-at-close removes the limitation at the cost of per-incident storage.
- **Context:** `filterLogWindow` + the `isLate` branch in lib/server/watchdog-overseer.js; the cross-model disagreement is recorded in the wave plan (U5 known limitation).
- **Effort:** M. **Depends on:** nothing.

## P3 — Watchdog wave minor polish (deferred by scope decision)
- **What:** Per-event-type filter pills on the All-events tab; a spot-check "explain current status" overseer mode with no incident; any new SSE event streams for the watchdog surfaces.
- **Why:** Each was reviewed and deferred: three tabs cover the filtering need, the deterministic narrator explains live status for free, and the 2s status SSE + 15s polls already carry everything ("new event streams are the expensive path").
- **Effort:** S each. **Depends on:** demand.

## P3 — Absolute-time hover tooltips on every relative-time display (E4)
- **What:** Extend the incidents-tab pattern (relative text + absolute `title` tooltip, ideally `<time datetime>`) to the remaining relative-only displays: team presence, telegram last-seen/last-sweep, upgrade catalog staleness, restart freeze stamps.
- **Why:** "5m ago" answers "how recent"; the tooltip answers "when exactly" without a format change. Also the keyboard-accessibility story for `title`-only tooltips lives here.
- **Context:** Deferred from the UI local-time normalization plan (CEO review E4). `buildIncidentTimeTooltip` (watchdog-tab/incidents/helpers.js) is the shape to generalize; `formatLocaleDateTimeWithZone` in lib/public/js/lib/format.js does the formatting.
- **Effort:** M → CC: S. **Depends on:** the normalization PR landing.

## P3 — Un-pin number/currency formatters from en-US (E5)
- **What:** Switch `formatInteger`/`formatCompactNumber`/`formatUsd` (lib/public/js/lib/format.js) and the two `Number#toLocaleString` char counts in doctor/helpers.js (allowlisted in the conventions guard) from `"en-US"` to browser-default locale.
- **Why:** Same "show data the way the local user expects" logic as the time normalization — but it changes USD symbol rendering abroad ("$1,234.50" → "1.234,50 $" in de-DE), so it's a separate product decision, not a mechanical follow-on.
- **Context:** Deferred from the UI local-time normalization plan (CEO review E5). Tests pin the en-US outputs (tests/frontend/format.test.js).
- **Effort:** S. **Depends on:** product decision on currency rendering.

## P3 — Gateway-state reason prose client-side (E7)
- **What:** Expose `tcp.observedAt` (and crash-window inputs) in the status payload and build the "Last confirmed running 42s ago — reconnecting." / "3 restarts in the last 5 min" prose client-side.
- **Why:** The only remaining server-composed relative-time prose. It is tz-safe (relative, recomputed every ~2s snapshot) so this is architectural hygiene, not a correctness bug.
- **Context:** lib/server/gateway-state.js:195-235 `reasonForState`; consumed verbatim by lib/public/js/components/gateway.js. Deferred from the UI local-time normalization plan (CEO review E7).
- **Effort:** M. **Depends on:** nothing.

## P3 — Usage-tracker ingest-time tz-aware day keys (E8)
- **What:** The usage-tracker plugin writes UTC day keys at ingest (lib/plugin/usage-tracker/index.js:198-200); rows near local midnight land in the "wrong" day for non-UTC users until the read path re-buckets.
- **Why:** The read path already re-buckets by the client timezone (lib/server/db/usage), so this only matters for consumers reading the raw `date` column. Fixing it at ingest needs a backfill/migration of existing rows.
- **Context:** Deferred from the UI local-time normalization plan (CEO review E8).
- **Effort:** M. **Depends on:** data migration plan.

## P3 — Run /design-consultation to create DESIGN.md
- **What:** The repo has no DESIGN.md; design reviews calibrate against universal principles instead of a stated system (fonts, spacing scale, color tokens, interaction patterns).
- **Why:** Every future design review (and AI-generated UI work) gets sharper with a written design system; the setup UI already has consistent implicit conventions worth codifying.
- **Context:** Flagged by the plan-design-review of the UI local-time normalization plan (Pass 5).
- **Effort:** S (one /design-consultation session). **Depends on:** nothing.

## P3 — upgrade-ui-smoke.sh: password selector matches two elements
- **What:** `tests/browser/upgrade-ui-smoke.sh` stops at `browse wait 'input[type="password"]'` — login.html renders both `#password` and a hidden `#password-confirm`, and the browse CLI now refuses multi-match selectors. Fix: wait/fill `#password` by id (claude-code-launcher-smoke.sh already does; better yet, share time-format-smoke.sh's in-page `POST /api/auth/login` approach, which sidesteps the form entirely).
- **Why:** The upgrade smoke silently no-ops in environments with a current browse CLI, so the channel-segment regression it guards is unwatched.
- **Context:** Pre-existing (login.html last touched v0.9.38, smoke v0.9.40); surfaced by /qa on 2026-08-29 while running it as a regression check for the time-normalization branch. Not modified per QA rule "never modify existing tests".
- **Effort:** S. **Depends on:** nothing.
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

## P2 — Watchdog incident → Claude Code routine escalation (fallback path)
- **What:** Reuse `claude-code-service` to fire the cloud routine on incident escalation — now scoped as the FALLBACK variant, for boxes with a configured routine but no completed local rescue login: once the local login is done, incident auto-spawn (`CLAUDE_CODE_LOCAL_SPAWN_ON_INCIDENT`, shipped with the local rescue session) already warms an on-box session at incident open.
- **Why:** Platform potential: incidents debug themselves in a session with context attached, instead of an operator copy-pasting log excerpts — and routine-only boxes shouldn't be left out.
- **Context:** Deferred from the launcher's CEO review. The narrative-payload half (which incidents qualify, redaction of the untrusted narrative text) moved into the "Seed the local rescue session with incident context" entry below — design both launch paths against that one shared redaction/qualification policy. `lib/server/claude-code-service.js` is the extension point (currently posts no body by design); the incident-open hook seam is `onIncidentActivity` in lib/server/watchdog-incidents.js.
- **Effort:** M. **Depends on:** fire-with-custom-text (payload path); the incident-context seeding entry's shared redaction design.

## P2 — Seed the local rescue session with incident context
- **What:** When a rescue session spawns for (or is joined by) a watchdog incident, seed it with the incident's narrative — what opened it, key events, redacted log excerpts — instead of arriving blank, via send-keys into the live session or a context file in the session cwd.
- **Why:** Incident auto-spawn (shipped) delivers a warm but empty session; the dream state is a session already loaded with why it exists.
- **Context:** Deliberately deferred at implementation time as a prompt-injection surface: incident narratives embed untrusted gateway log content, so seeding needs shared redaction plus an explicit untrusted-content wrapper (the routine path's `<routine-fire-payload>` opt-in pattern), designed together with the P2 fire-with-text payload so both launch paths share one policy. Extension points: `ensureForIncident(context)` in lib/server/claude-code-local/index.js (the incident id already flows through as `spawnedBy`) and the notification-composition seam in lib/server/watchdog.js.
- **Effort:** M. **Depends on:** fire-with-custom-text (shared payload/redaction design).

## P3 — Doctor check for Claude Code launcher config drift (routine + local)
- **What:** Surface both launch paths' misconfiguration as Doctor findings: the routine service's `invalid_config` reason (bad host, wrong token prefix, half-configured pair) AND the local rescue path's drift states — enabled-but-`needs_login` (including the credentials-lost-after-backup-restore case: `<rootDir>/claude-code-local/home/` is deliberately excluded from backups, so a restore silently drops the login until the operator re-runs it from the Watchdog card), invalid `CLAUDE_CODE_LOCAL_PERMISSION_MODE`/`CLAUDE_CODE_LOCAL_CWD` values, and the untested-claude-version warning.
- **Why:** Misconfiguration is currently visible only in the sidebar tooltip, the Watchdog card, and fire-time toasts; Doctor is where operators look for config drift — and re-login-after-restore has no proactive surface at all today.
- **Context:** `createClaudeCodeService().getAvailability()` and `createClaudeCodeLocalService().getStatusSnapshot()` already return the exact reason/warning strings — the check is a thin adapter in lib/server/doctor/.
- **Effort:** S. **Depends on:** nothing.

## P3 — Unify PTY spawn under pty-process.js
- **What:** Refactor lib/server/watchdog-terminal.js onto the shared `spawnInPty` helper (lib/server/pty-process.js) that the rescue session's script(1) fallback hosting and the guided-login PTY already use.
- **Why:** One PTY primitive instead of two copies of the script(1) harness; deferred mid-feature to keep blast radius off the stable watchdog-terminal surface.
- **Context:** lib/server/pty-process.js was extracted during the local rescue session work (plan amendment D13); watchdog-terminal.js keeps its own child pattern until this lands.
- **Effort:** S. **Depends on:** the local rescue session feature landing.

## P3 — Adopt `claude remote-control --headless` when anthropics/claude-code#30447 ships
- **What:** Swap the rescue spawn from TUI-in-tmux parsing to the upstream headless flag once it exists; the swap is isolated in `buildSpawnCommand()` (lib/server/claude-code-local/index.js). Drop the tmux dependency for the daemon path; keep tmux for the operator attach hint.
- **Why:** TUI parsing (capture-pane → stripAnsi → URL regex) is the feature's highest-drift surface; a supported headless mode deletes it.
- **Context:** Track anthropics/claude-code#30447. The version-pinned TUI fixtures (tests/server/fixtures/claude-code-tui/) and the Dockerfile's exact-version claude pin are the artifacts this retires.
- **Effort:** S. **Depends on:** upstream shipping the flag.

## P3 — Claude Code launcher: durable cross-process fire lease
- **What:** The launcher's single-flight (`inFlight`) and cooldown (`cooldownUntil`) live in memory on one `claudeCodeService` instance (lib/server/claude-code-service.js). A crash between Anthropic accepting a fire and AlphaClaw replying, or multiple server processes, or multiple team admins, each bypass the duplicate-billing guard; `busy`/`cooldown` are also shared across all admins (one admin's fire blocks another's).
- **Why:** The fire endpoint has no upstream idempotency key, so every gap in the in-memory guard is a real (if narrow) double-billing window. Adversarial review (Claude + Codex) flagged it; accepted as out-of-scope for the initial launcher because the practical exposure is small (single-process deploy, one operator, rare crash-timing).
- **Context:** Would need an atomic durable lease (file lock or the existing SQLite state dir) keyed per routine, plus persisting uncertain outcomes across boot. (The gatewayEnv allowlist that this referenced shipped in v0.9.60 — lib/server/gateway-env-policy.js.)
- **Effort:** M. **Depends on:** nothing.

## P3 — Sidebar nav a11y debt
- **What:** Internal sidebar nav items are `<a>` elements without `href` (not keyboard-focusable), and rows are under the 44px touch-target minimum on mobile.
- **Why:** Keyboard users cannot tab to most nav items; touch targets fall below platform guidelines. The Claude Code launcher item carries a real href (and aria-busy while launching) — the rest of the nav should catch up.
- **Context:** `renderNavItem` in lib/public/js/components/sidebar.js and the `.sidebar-nav a` metrics in lib/public/css/shell.css:215-246. Repo-wide pass; keep visual density on desktop while adding focus/touch affordances.
- **Effort:** M. **Depends on:** nothing.

## P3 — Locale QA matrix for the time-normalization surfaces (manual)
- **What:** Visual pass with browser locale en-GB (24h), de-DE, ar-EG (RTL), ja-JP at 375px and 200% zoom over the tight cells (webhook request rows, team invite chips, cron settings card, run-history collapsed groups); wrap affected timestamp spans in `<bdi>` only if the ar-EG pass shows bidi reordering.
- **Why:** Unit + E2E assertions are locale-agnostic by construction (browser-computed Intl expectations), so they prove correctness in any locale but can't judge *layout* in locales the CI browser doesn't run.
- **Context:** Plan verification item V4 of the UI local-time normalization (v0.9.45); everything automatable was executed (en-US live QA 13/13, TZ-shifted suites, E2E 9/9). Needs a real user machine with switchable browser locale.
- **Effort:** S (manual, ~20 min). **Depends on:** nothing.

## P3 — Midnight-rollover re-render sweep for today-style timestamps
- **What:** Confirm each `formatLocaleDateTimeWithTodayTime` surface (webhook lists, cron run history, usage sessions) refreshes its "today → time-only" labels across a local midnight via its existing poll/`useNowMs` cycle; add a ticker to any surface found static.
- **Why:** A tab left open across midnight would otherwise show yesterday's times in the time-only style until the next poll. Pre-existing behavior (poll cycles cover the known surfaces) — this records the plan's V5 verification item instead of leaving it silently unchecked.
- **Context:** Plan verification item V5 of the UI local-time normalization (v0.9.45).
- **Effort:** S. **Depends on:** nothing.

## P3 — Two pre-existing trend/calendar edges adjacent to the tz work
- **What:** (a) Hourly (24h) cron trends drop a run stamped exactly at `windowEndMs` — the entry is admitted but its floor-bucket key lands past the last bucket and is skipped (`cron-service.js` bucket loop). (b) `cron-calendar-helpers.js` builds day slots via `rangeStartMs + offset * kDayMs` then `startOfDayMs`, so two offsets can collapse to one `dayKey` across a 25h DST fall-back day, colliding calendar cell keys.
- **Why:** Both predate the v0.9.45 timezone work (flagged by its adversarial review because they sit on touched lines); each is a one-line-ish fix but changes pre-existing behavior, so they get their own change.
- **Effort:** S. **Depends on:** nothing.

## P2 — Dashboard launcher: bootstrapToken owner-grade handoff for the CLI fallback
- **What:** Upgrade the launcher's CLI fallback from scraping the shared token to forwarding the one-time `#bootstrapToken=…&bootstrapProfile=owner` fragment that `openclaw dashboard --no-open --json` mints (`browserUrl` field, verified on 2026.9.1-beta.1). Single-use + 600s TTL (`DEVICE_BOOTSTRAP_TOKEN_TTL_MS`, atomic consume) means mint per click — the launcher's single-flight CLI memo must NOT share one bootstrap URL across concurrent launches. Feature-gate via the existing gate pattern (lib/server/openclaw-feature-gates.js) and re-verify the JSON contract per version against the npm tarball per the context-contract re-verification checklist.
- **Why:** Covers installs running an ephemeral unrecoverable runtime token (where config-first resolution returns nothing) and removes the shared token from browser URLs entirely — the bootstrap grant is owner-grade, expiring, and single-use.
- **Context:** docs/designs/openclaw-context-contract.md §6 (owner-handoff facts + citations); lib/server/gateway-dashboard-url.js `resolveDashboardToken` (the CLI fallback to upgrade); lib/server/routes/dashboard-launch.js. Deferred from the launcher plan's follow-ups.
- **Effort:** M. **Depends on:** the launcher shipping; per-version verification of the `dashboard --json` contract. Related: upstream's own handoff never URL-embeds a SecretRef-backed token (`includeTokenInUrl = Boolean(token) && !hasSecretRef`); AlphaClaw's resolver embeds the materialized value (pre-existing behavior) — the bootstrap handoff removes that divergence for SecretRef installs too.

## P3 — Post-login return path for launcher clicks
- **What:** login.html hardcodes the post-login redirect to "/" (`window.location.href = "/"`, ~line 216), so an expired-session click on the Dashboards launcher authenticates and then loses the `/gateway/launch?to=dashboards` target. Add an open-redirect-safe `?next=` parameter: the login redirect carries the original path, and login.html honors it only after validation (single-origin relative path — reject schemes, hosts, and protocol-relative `//`).
- **Why:** The launcher's expired-session UX currently dead-ends one click short of the target; a validated `next` closes the loop without opening a redirect hole.
- **Context:** lib/public/login.html; lib/server/routes/auth.js (the login-page redirect for unauthenticated non-`/api` requests). Deferred from the launcher plan's follow-ups.
- **Effort:** S. **Depends on:** nothing.

## P2 — Auth-gate the catch-all WS upgrade to the gateway
- **What:** The upgrade handler in lib/server/watchdog-terminal-ws.js auth-checks `/openclaw*`, the terminal path, and `/api/ws/chat`, but its final catch-all `proxy.ws(...)` forwards every other upgrade path — including the Control UI's actual root-path WS — to the gateway with no AlphaClaw auth in front (the gateway's connect-frame auth still applies downstream). CAVEAT for any fix: node onboarding connects through that same proxied WS with only the gateway token and NO AlphaClaw cookie — a naive `isAuthorizedRequest` gate breaks node pairing. The gate must leave a path for token-bearing node connects (or scope the check to the paths the browser Control UI uses).
- **Why:** With the launcher making dashboard access one-click, the WS side should match the HTTP side's auth boundary instead of relying solely on gateway connect-frame auth.
- **Context:** lib/server/watchdog-terminal-ws.js (`server.on("upgrade")`, catch-all at the end); identity strip/inject already handled by resolveProxyIdentity/applyProxyIdentity. Deferred from the launcher plan's follow-ups.
- **Effort:** M. **Depends on:** verifying the node-onboarding WS handshake on both supported lines.

## P3 — Launcher focus deep-links into product surfaces
- **What:** Deep-link Watchdog incidents / Cron runs / Usage rows into the matching OpenClaw dashboard session: a launcher query param `?focus=<sessionKey>`, validated server-side and TRANSLATED to the path-form `/focus/dashboard/...` URL via `buildDashboardFocusUrl` — OpenClaw parses no query-form focus (path grammar only).
- **Why:** "Open this session's dashboard" from an incident/run/usage row is the natural next step once launcher clicks land authenticated; today those surfaces have no jump.
- **Context:** lib/public/js/lib/app-navigation.js `buildDashboardFocusUrl` (client helper exists); lib/server/routes/dashboard-launch.js (extend the allowlist mapping — raw input never interpolated into Location); focus path grammar cited in docs/designs/openclaw-context-contract.md §5 (Dashboards focus deep links).
- **Effort:** S-M. **Depends on:** the launcher shipping.

## P3 — Consolidate the two gateway-token resolvers
- **What:** lib/server/gateway-dashboard-url.js (config-first, browser-URL-safe, SecretRef/env-file/CLI fallback) and lib/server/gateway-credential.js (env-first; returns the gateway PASSWORD in password/trusted-proxy modes) both resolve gateway credentials. Fold them into one mode-aware resolver with per-consumer projections. Hard constraints: preserve the routes-system.test.js precedence pins (dashboard resolution is config-first, test-pinned) and the invariant that a password NEVER feeds a browser URL. Also flagged during the launcher review (collaborative repo, not fixed there): `kLocalOnlyApiPrefixes` (lib/server/routes/proxy.js) lists `/api/gateway-status` but no route serves it.
- **Why:** Two resolvers with different precedence invite the wrong one being extended; today a cross-reference comment is the only guard.
- **Context:** Cross-reference comment in gateway-dashboard-url.js; tests/server/routes-system.test.js precedence pins. Deferred from the launcher plan's follow-ups. Also fold in: GET /api/gateway/dashboard answers `needsAuth:true` in trusted-proxy mode where tokenless IS the success path — a false 'auth missing' signal to the agent-actor consumer; distinguish tokenless-success (e.g. a `mode` field) when the shapes are next unpinned.
- **Effort:** M. **Depends on:** the launcher shipping.

## Completed

## Mobile drawer doesn't close on external nav items
- **What:** The generic `item.href` branch in `renderNavItem` (lib/public/js/components/sidebar.js) — used by the gated Dashboards link — never closes the mobile drawer, leaving the drawer and overlay covering the app while the new tab opens.
- **Why:** The Claude Code launcher fixed this for itself via its `onBeforeOpen` callback (design-review finding); the same fix should backport to the generic external-item branch.
- **Completed:** v0.9.56 (2026-08-31) — the external-item anchor branch now notifies the shell via a new `onExternalNavClick` prop (wired to `closeMobileSidebar` in app.js) without preventDefault, so native new-tab navigation is untouched; pinned by tests/frontend/sidebar-external-nav.test.js.


## Serialize alphaclaw.json writers under a file lock
- **What:** Route every writeAlphaclawConfig read-modify-write through the shared file lock.
- **Completed:** v0.9.45 merge (2026-08-29) — upstream v0.9.42 wave added updateAlphaclawConfig (withFileLockSync around every update* helper); our doctor scheduled-scans updater was re-layered onto the same locked path during the merge.

## Gateway close-event stale-generation guard
- **What:** Exit classification listens on child "close" (chosen so post-exit stderr flushes are captured); if a grandchild inherits the stdio fds and outlives the gateway, "close" fires late — or never. Per-child stderr tails cover the fires-late half; the remaining scope was the bounded exit-vs-close race for the never-fires case: race "exit" with a short bounded drain so a close that never arrives cannot leave the exit unclassified.
- **Why:** A close that never fires meant the watchdog never saw the exit — no restart-handoff consume, no relaunch — until the descendant died; the health/TCP path was the slower backstop.
- **Completed:** v0.9.45 (2026-08-29) — both halves shipped in lib/server/gateway.js. Per-child stderr tails: each launch closure owns its tail, so a late close is always classified against its OWN child's stderr, never a successor's. Bounded exit-vs-close drain: "exit" arms a 400ms unref'd drain timer (`kGatewayCloseDrainMs`) that runs the same finalize with the tail-so-far if close hasn't fired; first of {close, drain timeout} wins via a per-child settled flag and a late close after the timeout is a no-op (exactly-once classification). The restart-supervisor path (`runGatewayRestartCmd`) already records its exit on "exit" directly and needed no guard.

## Gate runHealthCheck during pending exit classification
- **What:** While the watchdog's async exit resolver runs (handoff consume ≤5s + step-aside probes), lifecycle/health still read running/healthy and armed health timers can independently mark degraded or start rollback/auto-repair paths racing the resolver (serialized only by the lifecycle lock). Early-return from runHealthCheck while state.pendingExitClassification is true, mirroring the configurationErrorActive guard.
- **Why:** Duplicate restart attempts / notification noise for one exit.
- **Completed:** v0.9.45 (2026-08-29) — runHealthCheck early-returns while `state.pendingExitClassification` is truthy (lib/server/watchdog.js), right after the configurationErrorActive guard; the resolver owns the next transition, and the flag clears on settle or any newer lifecycle event.

## Wire restart-handoff consume into the watchdog exit classifier
- **What:** In gateway.js's child exit handler, when the target supports the restart-handoff contract and the exit is unexpected, consume the handoff before classifying, and add a watchdog `onGatewayExit` branch that relaunches without crash accounting. Serialize exit classification per child pid.
- **Why:** Correctly classify an OpenClaw-initiated fresh-process restart as intentional, not a crash.
- **Completed:** v0.9.45 (2026-08-29) — implemented against the tarball-verified protocol in `lib/server/gateway-restart-handoff.js` (per-PID exactly-once consume, 60s TTL cache) with the watchdog's `resolveSupervisedCleanExit` handling accepted/none/rejected on every clean unmanaged exit; gated on the supervisor-mode env rather than a capabilities probe (that gating refinement is tracked in "Retire the unwired upstream restart-handoff stub").

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

## P3 — Operator "rotate rescue link" action without restarting the session
- **What:** A button on the Watchdog rescue card (plus service method) that mints a new `linkToken`, persists it, and re-notifies — invalidating every distributed link without killing the live session.
- **Why:** Stop + start already rotates the link, but costs the session (and its context). A leaked link with a healthy session shouldn't force a restart.
- **Context:** `lib/server/claude-code-local/index.js` — rotate = replace `session.linkToken` + `persistSession()` under `runExclusive`; the resolver picks up the new token immediately. Re-notify via the existing notification-line hook. Deferred from the rescue-link CEO review (2026-09-01, D3.5).
- **Effort:** M (service + route + card button + tests). **Depends on:** the rescue-link capability wrapper (v0.9.66).

## P3 — Migrate the timing-safe comparison sites onto lib/server/utils/timing-safe.js
- **What:** Move the four existing timing-safe comparisons (`routes/auth.js:93`, `routes/auth.js:429`, `routes/proxy.js:52`, `db/auth/members.js:62` — two distinct semantics today) and the non-timing-safe `!==` in `gmail-push.js:140` onto the shared hash-both-sides util shipped in v0.9.66.
- **Why:** One canonical, length-leak-free comparator instead of five variants; gmail-push's plain `!==` is the outlier that should not exist on a token check.
- **Context:** `lib/server/utils/timing-safe.js` carries the canonical semantic (from `routes/auth.js:424-429`). Deliberately NOT done in the rescue-link PR (blast-radius discipline per CLAUDE.md merge rules — security-sensitive comparison code across auth/proxy/members belongs in its own reviewed diff).
- **Effort:** S. **Depends on:** nothing (util already shipped).

## Completed

## Make env-save channel sync one atomic lifecycle-lock op
- **What:** `PUT /api/env` runs remove-channels → write env → add-channels as two separately queued lock ops (lib/server/routes/system.js + gateway.js `syncChannelConfig`). A gateway restart queued between them launches with channels removed-but-not-yet-re-added (final config state self-corrects when the add runs, but the running gateway may need another restart to pick it up). Wrap remove+write+add in a single uniquely-keyed lock op (expose a narrow `withGatewayLifecycleLock` from gateway.js or a dedicated `syncChannelConfigForEnvSave`).
- **Why:** Adversarial review M4 on the ship pass (2026-08-28). Rare (requires an operator restart racing an env save) and bounded, but the invariant "env save is atomic against lifecycle ops" held under execSync and silently weakened in the async conversion.
- **Effort:** M (test updates across routes-system + coalescing suites). **Depends on:** nothing.
- **Completed:** v0.9.37 (2026-08-28) — `PUT /api/env` acquires the shared gateway lifecycle lock once around the full remove → write → add sequence (lib/server/routes/system.js `env_sync` op); `syncChannelConfig` itself stays lock-free, so the whole save is one atomic lifecycle operation.
