# TODOS

## P3 — Multi-operator / multi-tab settings freshness
- **What:** Push-refresh (SSE settings events) or ETag/If-Match concurrency for persisted settings so a second operator/tab sees changes without a remount.
- **Why:** The toggle/status/error overhaul's generation guards fix single-client races only; concurrent editors remain last-write-wins with no live refresh of settings cards.
- **Context:** `useSavedSetting` (lib/public/js/hooks/use-saved-setting.js) is the single write path — a settings SSE channel could feed its `retryLoad()`/cache seam. Surfaced by the plan's CEO review + outside voice.
- **Effort:** M. **Depends on:** deciding a settings-events transport (piggyback /api/events/status vs a new stream).

## P3 — Cron run-history: cap-aware pagination merge + bounded optimistic converge
- **What:** (a) The runs poll skips replacing entries while paginated past page 1; with >200 entries loaded (server clamps limit to kMaxRunsLimit=200, lib/server/cron-service.js), every snapshot is truncated and live updates stay frozen until a job/filter switch — make the merge cap-aware (offset paging or merge-first-200). (b) The job-enable toggle's hold-until-confirm converge can pin the optimistic value if an external actor flips the job back between our commit and the confirming poll — add a timeout or generation-stamped converge.
- **Why:** Both are narrow edges of the accepted optimistic/merge design, flagged by the slice verifier; neither is user-visible in normal operation.
- **Context:** lib/public/js/components/cron-tab/use-cron-tab.js (truncated-snapshot guard ~line 213, converge effect ~line 244).
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
