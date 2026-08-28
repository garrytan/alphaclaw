# TODOS

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

## P2 — Node onboarding under team mode (trusted-proxy)
- **What:** `openclaw node run` authenticates with `OPENCLAW_GATEWAY_TOKEN`, which trusted-proxy mode rejects; `/api/nodes/connect-info` currently returns an empty token with a logged warning while team mode is on. Provide a working node path (gateway password credential, or a pairing flow) before recommending team mode to node users.
- **Context:** lib/server/gateway-credential.js, lib/server/routes/nodes.js; degradation documented in the team-auth milestone report.
- **Effort:** M. **Depends on:** verifying how `openclaw node run` accepts a password credential (docs/cli in the beta line).
