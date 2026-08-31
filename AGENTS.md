## Project Overview

### AlphaClaw Project Context

AlphaClaw is the ops and setup layer around OpenClaw. It provides a browser-based setup UI, gateway lifecycle management, watchdog recovery flows, and integrations (for example Telegram, Discord, Google Workspace, and webhooks) so users can operate OpenClaw without manual server intervention.

### Understanding OpenClaw

If you need to understand the internals of OpenClaw, you can inspect the code at `~/Projects/openclaw/src`

### Architecture At A Glance

- `bin/alphaclaw.js`: CLI entrypoint and lifecycle command surface.
- `lib/server`: Express server, authenticated setup APIs, watchdog APIs, channel integrations, and proxying to the OpenClaw gateway.
- `lib/public`: Setup UI frontend (component-driven tabs and flows for providers, envars, watchdog, webhooks, and onboarding).
- `lib/setup`: Prompt hardening templates and setup-related assets injected into agent/system behavior.
- `lib/server/claude-code-local`: the local **Claude Code rescue session** behind the sidebar's Open Claude Code launcher — `claude remote-control` hosted in a detached tmux session (`tmux.js`), its Remote Control URL parsed from the TUI against pinned fixtures (`tui.js`), driven by the `index.js` state machine (routes in `lib/server/routes/claude-code.js` under `/api/claude-code/local/*`; the cloud routine in `lib/server/claude-code-service.js` is the fallback). Invariants (do not regress): async staleness is bound to the tracked object (`session.generation !== gen`), never a global counter; every mutation is humans-only and agent-actor status is redacted (`admin-manifest/domains/claude-code.js` strips sessionUrl/sessionId/oauthUrl/error-tail/warnings). Operator runbook + `CLAUDE_CODE_LOCAL_*` keys live in README ("Open Claude Code Launcher → Local rescue session"); deployed-agent guidance in `lib/setup/skills/alphaclaw-admin/claude-code.md`.
- Chat: `lib/server/chat/` (browser⇄gateway bridge, protocol v2, run lifecycle) + `lib/server/db/chat-runs/` (durable run outcomes/markers) + `lib/public/js/components/chat/` (feature folder; pure modules for run state, send outbox, transcript merge, reconnect). Contract + invariants (H8/H13/H16/MW5/C2, ambiguity policy): `docs/designs/chat-reliability.md`. `lib/server/chat-ws.js` is a re-export shim.

Runtime model:

1. At boot, `bin/alphaclaw.js` first spawns a boot-placeholder child process (`lib/boot-placeholder.js` + `lib/boot-placeholder-child.js`) that holds the port — serving an auto-refreshing "updating" page to browsers and `200 {status:"updating"}` health checks to platforms (flipping `/health` to 503 if boot hangs past 15 minutes) — until the real server is ready to take over.
2. AlphaClaw server starts and manages OpenClaw as a child process.
3. Setup UI calls AlphaClaw APIs for configuration and operations.
4. AlphaClaw proxies gateway traffic and handles watchdog monitoring/repair.

### Key Technologies

- Node.js 22.22.3+ runtime (or a supported Node 24.15+/25.9+ release).
- Express-based HTTP API server.
- `http-proxy-3` (pinned in `package.json`) for gateway proxy behavior, with `lil-http-terminator` for graceful HTTP drain on shutdown.
- OpenClaw CLI/gateway process orchestration.
- Preact + `htm` frontend patterns for Setup UI components.
- Vitest + Supertest for server and route testing.

## Coding Conventions

### Change Patterns

- Keep edits targeted and production-safe; favor small, reviewable changes.
- Preserve existing behavior unless the task explicitly requires behavior changes.
- Follow existing UI conventions and shared components for consistency.
- Reuse existing server route and state patterns before introducing new abstractions.
- Update tests when behavior changes in routes, watchdog flows, or setup state.
- Before running tests in a fresh checkout, run `npm install` so `vitest` (devDependency) is available for `npm test`.
- `npm test` is hermetic by design — `tests/live/**` (real npm/GitHub/OpenClaw-updater e2e) is excluded unless `OPENCLAW_LIVE_E2E=1`. Use `npm run test:live` (network, ~5 min) or `npm run test:live:dev` (the real dev source build ONLY — 20-35 min measured, 35-min build timeout; it does not re-run the catalog/apply tiers). When a live tier fails but the hermetic suite is green, suspect upstream OpenClaw drift first and update the encoded assumption, not the guard.

### Code Structure

- Avoid monolithic implementation files for new features. For new UI areas and new API areas, start with a decomposed structure (focused components/hooks/utilities for UI; focused route modules/services/helpers for server) rather than building one large file first and splitting later.
- When adding a new feature area, follow the existing project patterns from day one (for example feature folders with `index.js` plus `use-*` hooks in UI, and route + service separation on server) so code stays maintainable as the feature grows.
- When continuing to build on a file that is growing large or accumulating unrelated concerns, stop and decompose it before adding more code rather than letting it drift into a monolith.

### Networking and Fetching

- Prefer the shared cache primitives in `lib/public/js/lib/api-cache.js` for backend reads:
  - `cachedFetch(...)` for imperative fetch paths.
  - `getCached(...)` / `setCached(...)` / `invalidateCache(...)` for cache lifecycle.
- For component-level read requests, prefer `useCachedFetch` from `lib/public/js/hooks/use-cached-fetch.js` over ad-hoc `useEffect(() => fetchX())` mount loads.
- Treat the API URL (including query params) as the canonical cache key for GET-style payloads.
- Keep cache in-memory for fast tab switches; do not add persistent storage caching unless explicitly required by product behavior.
- Do not keep route panes mounted via `display:none` just to preserve data. Prefer conditional rendering + cache-backed remounts.
- Use `usePolling` for recurring refreshes and always pass a stable `cacheKey` when poll results should hydrate remounts.
- Keep `pauseWhenHidden` behavior enabled for polling unless a specific flow requires background polling while the browser tab is hidden.
- Tune polling intervals conservatively; avoid 1-2s polling unless there is a clear real-time requirement.
- For app-shell status streams, prefer SSE (`/api/events/status`) where available and keep polling as fallback behavior.
- After write/mutation APIs (POST/PUT/DELETE), refresh or invalidate relevant cached keys so the UI does not show stale data.

### OpenClaw Config Access

- When reading `openclaw.json` in server code, use the shared helper in `lib/server/openclaw-config.js` (`readOpenclawConfig`) instead of ad-hoc `JSON.parse(fs.readFileSync(...))` blocks.

### Where To Put Agent Guidance

- **This file (`AGENTS.md`):** Project-level guidance for coding agents working on the AlphaClaw codebase — architecture, conventions, release flow, UI patterns, etc.
- **`lib/setup/core-prompts/AGENTS.md` and `lib/setup/core-prompts/TOOLS.md`:** Runtime prompt templates injected into the OpenClaw agent's system prompt. At workspace sync they are merged into ONE `hooks/bootstrap/AGENTS.md` in the agent workspace (`lib/server/onboarding/workspace.js`) — `AGENTS.md` is a valid bootstrap-extras basename on every supported OpenClaw line, while a `TOOLS.md` extra is silently rejected on 2026.8.1+; the legacy AlphaClaw-owned `hooks/bootstrap/TOOLS.md` is cleaned up on sync. Only write in these templates when the guidance is meant for the deployed agent's behavior, not for coding on this project.
- **`lib/setup/skills/alphaclaw-admin/*.md`:** Fragments for the generated Agent Administration skill (the deployed agent's reference for the `alphaclaw admin` CLI). Prose only — the operation tables are generated from the manifest. Write here only when the guidance is for the agent administering AlphaClaw at runtime.

### Agent Administration (features.agentAdmin)

The Agent Administration feature (default OFF) lets the deployed OpenClaw agent drive the dashboard `/api` surface via `alphaclaw admin`, governed by an operation manifest.

- **Adding or changing an `/api` route:** every route the agent may reach needs a descriptor in `lib/server/admin-manifest/domains/<domain>.js` (tier, and where relevant `params`/`readOp`/`secretFields`/`redactResponse`/`tierResolver`). The route-coverage test (`tests/server/admin-manifest.test.js`) fails CI for any unclassified `/api` route — either classify it or add it to `kUnmanifestedRoutes` in `lib/server/admin-manifest/index.js` **with a why-comment**.
- **Never let the agent actor reach the gateway proxy:** enforcement denies any agent-actor `/api` request outside the manifest (all methods), so an unclassified route is denied, not proxied.
- **Bearer auth is opt-in per call site** (`isAuthorizedRequest(req, { allowBearer })`): only the Express `/api` `requireAuth` path passes `true`. WS upgrades and manual checks must keep the default `false`.
- **Reuse the shared `sanitizeLabel`/`toTableCell`** in `lib/server/utils/sanitize-label.js` for any live string rendered into the skill or a prompt.

## Operations

### Release Flow (Beta -> Production)

Use this release flow when promoting tested beta builds to production:

1. Ensure `main` is clean and synced, and tests pass.
2. Publish beta iterations as needed:
   - `npm version prerelease --preid=beta`
   - `git push && git push --tags`
   - `npm publish --tag beta`
3. Immediately after each beta publish, update `~/Projects/openclaw-railway-template` on the `beta` branch to pin the exact beta version in `package.json` (for example `0.3.2-beta.4`), then commit and push that template change. Do not leave the beta template on `latest`, or Docker layer cache can reuse an older install.
4. When ready for production, publish a stable release version (for example `0.3.2`):
   - `npm version 0.3.2`
   - `git push && git push --tags`
   - `npm publish` (publishes to `latest`)
   - Pin all deployment templates on `main` to that release: set `@chrysb/alphaclaw` in `~/Projects/openclaw-railway-template`, `~/Projects/openclaw-render-template`, and `~/Projects/openclaw-apex-template` to the released version. The Render checkout must track `render-examples/openclaw-render-template`; verify `gh api repos/render-examples/openclaw-render-template --jq '.permissions.push'` returns `true` before publishing, and stop if write access is missing. Templates rely on AlphaClaw’s declared `openclaw` dependency — do not add `package.json` `overrides` for `openclaw` unless you have a one-off debug reason. Run `npm install` in each repo, confirm `npm ls openclaw` matches AlphaClaw’s `package.json` pin, commit `package.json` and `package-lock.json`, and push. Skipping a template leaves it stale relative to the others.
5. Return templates to production channel:
   - `@chrysb/alphaclaw: "latest"`
6. Optionally keep beta branch/tag flows active for next release cycle.

### OpenClaw Release Channels (runtime version pinning)

The `openclaw` pin in `package.json` remains authoritative for the **stable** channel and for every fallback path — do not weaken the pin policy above. On top of it, the release-channel system (`lib/server/openclaw-channel-sync.js`, `openclaw-release-channel.js`, `openclaw-releases.js`, `openclaw-run-stream.js`, routes in `routes/openclaw-channel.js`, Upgrade tab UI) lets an operator explicitly run a different published version (beta/stable catalog via npm+GitHub) or a source build of upstream `main` (dev channel, via OpenClaw's own `openclaw update --channel dev`).

Design invariants (do not regress):
- **Activation happens ONLY at boot** (`bin/alphaclaw.js` section 7b → `runOpenclawChannelBootSync`), from local state: the overlay store at `<root>/openclaw-overlay/` (self-contained `--install-strategy=nested` trees incl. a snapshot of the pin) or the dev checkout at `$OPENCLAW_HOME/openclaw` behind the PATH bin shim at `<root>/.openclaw/.alphaclaw/bin/openclaw`. Boot never fetches. An apply prepares + verifies + records, then restarts the AlphaClaw process.
- The activation sentinel (`node_modules/.openclaw-activation.json`), not a version compare, decides re-activation (mid-copy crashes leave a plausible package.json).
- Boot sync is fail-open: any error falls back to the pin and never blocks the Setup UI.
- The channel state file (`<root>/.openclaw/.alphaclaw/openclaw-channel-state.json`) is the single authority for applied build state (active build, blocklist, last-known-good); the operator's channel *selection* lives in `alphaclaw.json` under `updates.openclaw.releaseChannel` (git-synced); `openclaw.json`'s `update.channel` is a mirror rewritten every boot, and `OPENCLAW_NO_AUTO_UPDATE=1` is set in the gateway env so neither OpenClaw nor the agent can self-update out from under it.
- Rollback triggers (crash loop, exit 78, degraded >10 min) fire only on non-pin builds inside their 24h stabilization window — a build that never passes the 120s acceptance hold isn't rolled back directly, it just stays unaccepted until one of those triggers fires. Dev rollback targets the pin snapshot (falling back to a usable last-known-good stable overlay when the pin isn't locally recoverable) — never an in-crash rebuild. Unattended `doctor --fix` is suppressed inside that window (the 2026.7.1 plugins.allow bug is why). One exception (issue #21 bug 10): a PIN that itself exits 78 / crash-loops while a NEWER blocklisted build with a local overlay owns the migrated state (blocklist reason `config_error`/`config_migration_failed`) triggers **forward recovery** — a one-shot marker-driven move to that build (persisted `forwardRecovery.attemptedId`; a second pin failure sets `noBootableVersion` and latches). A pin-only box also self-promotes to `lastKnownGood.package` after the 120s health hold (with an on-demand pin overlay snapshot), so later rollbacks have a real target. Exit 78 is disambiguated before it latches: 2026.8.1 overloads EX_CONFIG with a benign healthy-incumbent step-aside (a boot-race loser deliberately exits 78 after probing the incumbent), so the watchdog verifies the stderr signature with its own health probe of the incumbent — and only classifies a step-aside when the exit also lands within 60s of that child's launch (`kStepAsideStartupWindowMs`) — treating a confirmed step-aside as benign: no restart latch, no rollback trigger; outside the window or on a failed probe the config-error path keeps latching (`lib/server/watchdog.js`).
- The config/DB migration for a freshly activated version runs in the SERVER boot sequence (`reconcileBootConfig` — validate, sized doctor-guarded `doctor --fix`, boot lock held, strictly before the gateway starts; issue #20) and is fail-CLOSED with a HARD GATE on its failure path (issue #21 bug 2): with a restorable `pre-fix-<from>.bak` and a local revert target that preflights clean, the reconciler blocklists the new build (`config_migration_failed`), restores the pre-fix config, and re-activates the previous version BEFORE the new build's gateway ever runs; when reverting is the more dangerous move (part-migrated DBs, no compatible target, `OPENCLAW_MIGRATION_GATE=off`) it HOLDS the gateway (`state.gatewayHold` + watchdog latch) with operator retry/strip-consent actions instead of failing open. Boot rollback markers preflight EVERY candidate target (package AND pin; DB probe + agents.entries config-shape guard) and REFUSE the rollback (persisted `rollbackRefused`, keep the blocked-but-compatible build running) when nothing can read the migrated state. Kill switches: `OPENCLAW_MIGRATION_GATE=off`, `OPENCLAW_FORWARD_RECOVERY=off`; migration budget: sized to state-DB bytes (10 min + 5 min/GB, cap 30 min; the live-progress boot placeholder tracks step progress so long migrations aren't platform-killed), base overridable via `OPENCLAW_DOCTOR_MIGRATION_TIMEOUT` (seconds — an explicit value also raises the cap); rollback preflights share the 12-min boot-ops budget. Backups that fail on workspace discovery (config-broken box) retry once with `--no-include-workspace` and record `partial: true`.
- The apply latch stays held once a restart is imminent (restarting success or deferred rollback) — releasing it early would let a second apply start only to be killed mid-overlay-write. A live-server pidfile (`<root>/.openclaw/.alphaclaw/alphaclaw-server.pid`, claimed at boot-sync time, never clobbering a live owner) makes a second `alphaclaw start`'s destructive boot sync a no-op.
- Candidate code never sees secrets: package installs and verify probes run with an isolated HOME and a pinned registry/config; dev builds get an OPENCLAW_*/XDG_* allowlist with secret-shaped keys (TOKEN/SECRET/KEY/PASSWORD) filtered out.
- Accepted supply-chain risk: the dev channel executes upstream build scripts (pnpm postinstalls). Mitigations: pre-switch verified backups (per-run timestamped `openclaw-backup-*.tar.gz` archives under the directory `<root>/backups/openclaw/`, last 3 kept; hard gate on downgrades AND dev switches), acceptance gating, blocklist, pin floor, secret-free build env.

Runbook — "a dev/beta build broke":
1. If it crash-looped inside the window, auto-rollback already ran: check the Upgrade page incident card + the chat notification; the bad build is blocklisted.
2. Gateway up but misbehaving: Upgrade page → Roll back (targets last known-good, else the pin), or "Mark as good now" if the degradation is expected/self-inflicted.
3. Dev checkout stuck (interrupted build / dirty worktree): run `openclaw update repair` from the Watchdog terminal; it finishes a half-completed update and does not touch user state.
4. Downgrade landed on migrated state (gateway exits 78 after a downgrade): the restore candidate is the newest `openclaw-backup-*.tar.gz` archive in `<root>/backups/openclaw/` (last 3 kept); stage and activate it via the `openclaw backup` CLI steps (see its docs; sqlite-only: `openclaw doctor --session-sqlite restore`).
5. Blocklist entries are permanent per version until cleared in the UI ("Clear" → "Try again") — with the single forward-recovery exception above (the one-shot clear is audited in `forwardRecovery.clearedEntry`). Clearing an entry also resets a matching `rollbackRefused` latch.
6. Rollback refused ("no OpenClaw version on this box can read the migrated state"): the box keeps running the blocked build under the watchdog latch. Recovery: restore the newest `openclaw-backup-*.tar.gz` (step 4), or apply a NEWER version that understands the migrated state, or Clear the blocklist entry to retry. The refusal latch clears on mark-good, a successful apply, or blocklist Clear.
7. "No bootable version" (forward recovery exhausted, `noBootableVersion` set): both the pin and the forward build failed. Manual recovery only — restore the newest backup archive, or fix the config/state by hand (see issue #21's recovery appendix), then Clear + retry from the Upgrade page.
8. Exec approvals (openclaw ≥ 2026.9.1-beta.1, issue #23): approvals live in SQLite (`exec_approvals_config`); the legacy `<openclawDir>/exec-approvals.json` must NOT exist (its presence fails all channels/cron/heartbeat closed). AlphaClaw never writes it on sqlite-era boxes and renames a stray one to `.stray-<ts>` at boot; the dashboard routes go through `openclaw approvals get/set`.

Runbook — update observability & the overseer:
- **Durable run logs.** Every apply gets a UUID operation id; the record lives at `<root>/.openclaw/.alphaclaw/runs/<operationId>.json` and its log at `.../logs/openclaw-update-<operationId>.log` (`GET /api/openclaw/runs`, `/runs/:id`, `/runs/:id/log`). Logs are line-buffer redacted against secret-shaped env values, hard-capped at 10MB per run and 200MB total (oldest pruned first), and survive the activation restart — the run record, not `lastUpdateRun`, is the correlation key.
- **Notification outbox + admin routing.** Upgrade/watchdog notifications are enqueued durably first (deduped by id), then delivered: to explicit admin targets when configured (preferred channel first, fallback targets only on delivery error, prefixed "(fallback)"), else the fan-out to every paired ID. A notifier `{ok:false}` is retried, never silently acknowledged: undelivered events are re-drained after the activation restart and on the 60s heartbeat with exponential backoff (60s doubling per attempt, 1h ceiling) until the event is 48h old, at which point it is abandoned exactly once — one GIVING-UP log plus a persisted `notification_abandoned` watchdog event so the loss shows in the incidents UI even when no channel works. Deliverability fallbacks for the broken-box case (the reason these alerts exist): the Telegram bot token resolves env-first then the literal `channels.telegram.botToken` in openclaw.json (shared resolver behind both the API client and the notifier; broken/unparseable config always degrades to env+pairing, never blocks delivery); fan-out Telegram targets fall back to the numeric chat IDs in `channels.telegram.allowFrom` when no pairing files exist (usernames/`"*"` are authorization identities, not chat_ids — skipped; Telegram only, by design); and `ALPHACLAW_NOTIFY_WEBHOOK_URL` (when set) receives a plain `POST {"text": ...}` JSON as an extra fan-out channel, with `lib/server/notify-webhook.js` (`postNotifyWebhookDirect`) as the swallow-all-errors direct path for the pre-server boot process. Prefs API: `GET/PUT /api/openclaw/notifications` (PII — state dir store, never git-synced alphaclaw.json).
- **Gateway startup medic (DEFAULT ON, opt-out).** `lib/server/gateway-medic.js` + `lib/server/llm-client.js`; toggle at `updates.openclaw.medic.enabled` / `GET+PUT /api/openclaw/medic`; wired into the watchdog's exit-78 branch (`configMedic`), which stays the enforcement layer. On an `EX_CONFIG` gateway exit (after channel rollback declines) the medic runs at most twice per incident (plus a cross-incident brake: at most 5 runs per rolling hour, then it latches): (1) deterministically removes config keys the gateway's own stderr blamed as unrecognized IF they are AlphaClaw-managed (`gateway.controlUi.environment`); (2) otherwise asks the highest-ranked frontier model with a configured key (`ANTHROPIC_API_KEY` → `OPENAI_API_KEY` → `GEMINI_API_KEY`, direct fetch — no SDK dependency, no `claude` binary needed) to pick ONE whitelisted remedy: `remove_keys` (restricted to stderr-blamed paths), `doctor_fix` (suppressed whenever a stabilization window may be live — openclaw#107226), or `none` (diagnosis-only, appended to the latch notification). When the AI tier is unreachable or answers unusably (no key, unparseable, non-whitelisted keys), the medic falls back to a plain `doctor --fix` under the same suppression rule — deterministic repairs run even with zero API keys. Every mutation attempts an `openclaw.json.medic-<ts>.bak` backup first (best-effort — newest 3 kept; a missing/unreadable config never blocks the remedy) and is announced via the notifier + a `medic` watchdog event. Data disclosure: when the AI tier runs, secret-redacted stderr, doctor output, and openclaw.json are sent to the configured provider APIs — tried most-capable-first, and on failure the same evidence falls through to the next provider in the ranking. Related root-cause guard: the environment stripe in `openclaw-channel-sync.js` is capability-gated on the build that will actually run (core version ≥ 2026.8.1 for beta, an active dev shim on a ≥ 2026.8.1 checkout for dev) — never on the channel selection alone.
- **Upgrade overseer (recommend-only, DEFAULT OFF).** `lib/server/upgrade-overseer.js`; toggle at `updates.openclaw.overseer.enabled` / `GET+PUT /api/openclaw/overseer`. Requires a `claude` binary on PATH and `ANTHROPIC_API_KEY`; unavailability is recorded on the run and shown in the UI, never silently degraded. It runs only after a run settles (acceptance hold resolved, or terminal failure), with a 5-minute wall-clock deadline, an isolated temp HOME + Anthropic-credential-only env (never gatewayEnv), and tools disabled (CLI flags when verifiable from `--help`, else a recorded prompt-only restriction). Verdicts (`healthy|suspect|broken`, or an honest `unparseable`) are persisted on the run's `overseer` field, marked `stale` (and unnotified) if the running build changed mid-review. Data disclosure: when enabled, redacted upgrade logs and doctor output are sent to the Anthropic API. Precedence: the deterministic watchdog is the ONLY enforcement layer — the overseer never calls mark-good/rollback.
- **Watchdog incidents (persisted).** `lib/server/watchdog-incidents.js` is a transition observer wrapped around the watchdog's injected event sink in `lib/server.js` — it derives `watchdog_incidents` rows (open/resolved/abandoned, one open max, `incident_id` stamped on watchdog-sourced events) from event transitions and NEVER touches `openIncident()`/`sentIncidentNotifications` (that in-memory pair is the notification-dedup seam; re-arming it storms). Skipped-probe `ok` events (grace/expected-restart windows) never close an incident; expected exits never open one. Close-time rollups capture a status + resource snapshot (the overseer's incident-scoped evidence); boot marks dangling rows `abandoned` with `resolved_at` = last stamped event. APIs: `GET /api/watchdog/incidents[?limit&before]` (slim rows for the 15s poll — close-time evidence snapshots and overseer history stay on the detail read — plus an honest `hasMore` probe so clients never infer paging from page size), `GET /api/watchdog/incidents/:id` (first 200 events + honest truncation marker); the flat `GET /api/watchdog/events` is byte-compatible and untouched.
- **Watchdog narration.** `getStatus()` carries additive "why" fields (`degradedReason`, `lastExit`, grace/backoff/rollback timestamps, `doctorFixSuppressed` — derived from the same `channelRollbackEligible()` predicate the ladder consults, so UI truth can't drift) plus a canonical `phase` from the pure `lib/server/watchdog-phase.js` (closed 15-value enum, precedence = declaration order). All in-memory reads — the 2s SSE tick must never gain DB/fs/network work. The Watchdog tab's narrative card maps phase→copy client-side; a sync test pins the two lists.
- **Watchdog incident overseer (advisory-only, DEFAULT OFF).** `lib/server/watchdog-overseer.js`; toggle at `watchdog.overseer.enabled` / `GET+PUT /api/watchdog/overseer`; manual `POST /api/watchdog/overseer/review` (rate-limited, never notifies; refusals map to honest statuses — 404 missing incident, 429 rate-limited, 503 missing infrastructure). Reviews the oldest unreviewed settled incident, only from a healthy steady state (no open incident), one per 10-min floor. Stricter than the upgrade overseer: the ENTIRE prompt and the model OUTPUT pass the secret redactor, redaction FAILS CLOSED when a redaction source (.env, openclaw.json) can't be read (`redaction_sources_unreadable` — the review is refused rather than sent under-scrubbed), the trusted prompt tier is an explicit ALLOWLIST projection (enums/numbers/timestamps only; gateway-echoed strings ride the semi-trusted tier), `ANTHROPIC_API_KEY` reaches only the one `claude -p` review spawn (`--version`/`--help` probes run without it), verdict text is notification-sanitized (no newlines/backticks/links), and tool restriction FAILS CLOSED when `--disallowedTools` can't be verified from `claude --help`. Verdicts (`resolved|monitoring|action_needed` + an action enum that drives CTAs, or an honest `unparseable`) persist on the incident's `overseer_json` as `{v, current, history[<=3]}`. Data disclosure: when enabled, redacted gateway logs, incident records, and doctor output are sent to the Anthropic API. Precedence: the deterministic watchdog is the ONLY enforcement layer — this factory's DI receives no repair/rollback/resume functions at all.
- **Resource autotune (DEFAULT ON, opt-out).** `lib/server/machine-profile.js` (cgroup v1/v2-aware capacity detection — memory/CPU/disk/GPU, tiers, container detection with an unknown-limits suppression guard) + `lib/server/autotune.js` (derivation + the persisted `autotune-ledger.json` in the managed state dir; the in-memory ledger keeps serving if the disk write fails). Config: `autotune.enabled` / `autotune.overrides` in alphaclaw.json (unknown keys and out-of-bounds override values are dropped at normalize time); env kill-switch `ALPHACLAW_AUTOTUNE_DISABLED=1`. Detection always runs — only application is gated. Consumers: gateway V8 heap (`--max-old-space-size` strip-then-re-add in gateway.js) + `UV_THREADPOOL_SIZE`, the agent-concurrency cap (telegram sync), JSON body limits (lib/server.js), SQLite page caches (shared `applyOperationalPragmas` in `lib/server/db/pragmas.js`, negative-KiB semantics), and the advisory backup budget (`getBackupMaxTotalBytes` → `pruneBackups` warning). Boot order matters: `applyResourceAutotuneOnBoot` is the FIRST lock-held step in `runOnboardedBootSequence` (lib/server/startup.js), before `doSyncPromptFiles()`, so SKILL.md/TOOLS.md render a real machine line. The watchdog tick detects live container resizes (event + notification + retune) and classifies `heap_oom` vs `container_oom` gateway exits as distinct events. APIs: `GET /api/autotune`, `PUT /api/autotune/settings`, `POST /api/autotune/reapply`, `PUT /api/autotune/resize-ack`; UI: the Watchdog tab's Autotune card; the machine summary also reaches `/api/status`, `alphaclaw admin --summary`, and the medic/overseer prompts via `lib/server/machine-summary.js`. Invariants (do not regress): disabling restores pre-feature defaults and reverts ONLY ledger-attributable writes (never values an operator set by hand), and a no-change pass never rewrites `openclaw.json`.
- **Beta feature gates.** `lib/server/openclaw-feature-gates.js` (fail-closed per feature; dev shas fail closed): supervisorMode (listed in the gate map but effectively ungated — `OPENCLAW_SUPERVISOR_MODE` defaults to `external` in gatewayEnv on every version, with an `off|none` operator escape hatch that neutralizes it without a rebuild, `lib/server/openclaw-runtime-env.js`; OpenClaw-requested restarts are consumed via the tarball-verified handoff protocol in `lib/server/gateway-restart-handoff.js` — per-PID exactly-once consume, 60s TTL cache — and relaunched by the watchdog without crash accounting, capped at 5 handoff relaunches per rolling hour before the normal crash flow takes over; the unwired legacy stub `openclaw-restart-handoff.js` is slated for deletion, see TODOS), bootstrapContractV2 (the 2026.8.1 Project Context contract — TOOLS.md/HEARTBEAT.md retired, MEMORY.md-era bootstrap set, USER.md 4k cap; drives the doctor's context-profile selection), sqliteBackup (`POST /api/openclaw/backup-sqlite`, 503 when gated; creates with the required `--repository` into `<root>/backups/openclaw-sqlite/`, then verifies the exact snapshot the create reported — for the shared state DB AND each configured agent's DB; any unverified or skipped database fails the run loudly), sessionDashboards (gated sidebar link), secretEgressBinding (info callout). `GET /api/openclaw/features`.
- **Drift Doctor (doctor-v2).** Server core in `lib/server/doctor/`: `service.js` (scan orchestration, reuse of no-change runs, new-P0 notification dedupe, and opt-in scheduled scans — config key `doctor.autoRun.enabled` in alphaclaw.json via `GET/PUT /api/doctor/settings`, 15-min tick, ≥6h between scans, 24h backoff after a failed run, skipped while the gateway is down), `context-profiles.js` (version-aware injection model selected by installed OpenClaw version, failing closed to stable), `bootstrap-context.js` (the 60k-char budget model + hardening state consumed by the General-tab badge and card), `deterministic-checks.js` (no-LLM environment checks run on every scan), `openclaw-doctor.js` (bridges `openclaw doctor --lint --json` findings as capped/deduped cards), `sanitize.js`, and `workspace-fingerprint.js` + `fingerprint-worker.js` (off-thread manifest hashing). Store: `lib/server/db/doctor/`; routes: `lib/server/routes/doctor.js`; UI: `lib/public/js/components/doctor/` (incl. the context-budget meter — its Blocked/Dropped/Truncated chip copy lives in `lib/public/js/lib/hardening-reasons.js`, coverage-pinned by CI against `kHardeningReasonValues` in `lib/server/doctor/constants.js` — and the scheduled-scans toggle) plus `lib/public/js/components/general/hardening-badge.js` (healthy/unknown/dev-unverified states) and `lib/public/js/components/general/hardening-card.js` (problem states — the badge yields entirely; the card's CTA deep-links `#/doctor?focus=context` via the shared `lib/public/js/lib/hash-query.js` parser). The upstream injection contract is encoded from tarball-verified facts — cite `docs/designs/openclaw-context-contract.md`, never memory, when changing budgets/ordering/session-scope behavior (both the stable and beta models were wrong before verification).
  - **Scan caps are configurable** (`doctor.scan.{maxFiles,maxFileMb}` in alphaclaw.json, defaults 200k files / 50MB, bounds 1k-500k / 1-100MB, `null` = default; same settings route/UI card as scheduled scans). Cap changes invalidate the snapshot cache and re-scan without a restart; the worker-unavailable sync fallback always clamps to the legacy 50k/10MB so degraded mode can never block the event loop at raised caps; the partial-scan banner renders real numbers from `doctorStatus.workspaceScan`, never hardcoded prose.
  - **Delivery targets derive ONLY through the canonical session-key parser** (`lib/server/utils/session-keys.js` `parseSessionDeliveryRoute`/`getReplyTargetFromSessionKey`, UI mirror in `lib/public/js/lib/session-keys.js`, parity-locked by `tests/server/session-keys.test.js`). Never hand-roll session-key regexes in routes/services — the pre-0.9.50 `$`-anchored copy in routes/system.js silently dropped DM delivery for account-scoped/suffixed/non-telegram keys. Discord/Slack DMs need `user:<id>` reply targets; unknown/plugin channels parse but are never `deliverable`. The Doctor fix dispatch validates the sessionKey against the live session list (`lib/server/utils/agent-session-lookup.js`), derives the reply target server-side (client fields are advisory back-compat), and persists the dispatch record on the card (`fix_delivery_json`).
- **Team mode.** Multi-operator/team behaviors ride the same gates (`multiUser`, `trustedProxyPairing`, both `2026.8.1-beta.1`). Shipped surface: credentialed member accounts with token-v2 auth and an invite/role authz matrix (`lib/server/db/auth/members.js`, `lib/server/routes/auth.js`, `lib/server/team-service.js`, `lib/server/routes/team.js` → `/api/team/{enable,disable,invites,members,presence}`, all mutations admin-only); trusted-proxy identity injection carrying the member's **email** with spoofable forwarding headers stripped in one shared layer over HTTP/WS/webhook paths (`lib/server/proxy-identity.js`); the team gateway-config writer that flips gateway auth from token to trusted-proxy (`lib/server/team/gateway-config.js`, `lib/server/team/{state,presence}.js`); the enable wizard's apply→restart→verify-login→auto-restore flow and shared-password lockdown/transition (`lib/server/team-auth-transition.js`); and the Team tab UI (`lib/public/js/components/team-tab/`, nav in `lib/public/js/lib/app-navigation.js`). The operator/notification store is still `lib/server/operators-store.js`. The Team tab always renders, but the enable path shows "switch to the beta channel" until the gateway reports the `trustedProxyTeam` capability. A boot divergence detector (`register-server-routes.js`) notifies when `team.enabled` and the gateway auth mode disagree.
- **Channels.** The provider registry has a single frontend source (`lib/public/js/lib/channel-registry.js`) and server counterparts (`kChannelDefs` in `lib/server/constants.js` + the maps in `lib/server/agents/shared.js`) — extend all three when adding a provider. Beyond telegram/discord/slack/whatsapp, two guided channels ship: **ClickClack** (`guidedSetup`, paste one setup code or URL — codes need the beta's `--code`, URLs work on stable's `--url`; manual token/base-URL still works, incl. onboarding; never preselected as an onboarding pairing target since fresh onboarding only stashes its token) and **Buzz** (`wizard`, beta-only external plugin set up through the resumable server-state-machine wizard in `lib/server/buzz-setup.js` + `lib/server/routes/buzz.js` + `lib/public/js/components/channels/buzz-wizard.js`, shown disabled with the unmet requirement when the `buzzChannel` capability is absent).

### Runtime Dependency Guardrails (Express 4 vs 5)

AlphaClaw currently expects Express 4 semantics in its setup API layer. A broken container dependency tree can accidentally resolve `express@5` at `/app/node_modules/express`, which causes subtle request handling regressions (for example body parsing behavior on certain methods).

Known root cause pattern:

- Mutating `/app/node_modules` in-place (for example copy-over installs used for emergency package swaps) can leave the runtime tree inconsistent with `/app/package.json`.
- This can hoist `express@5` to the app root, so `require("express")` inside AlphaClaw resolves the wrong major version.

Preferred fix/recovery:

1. Ensure template `package.json` pins the intended `@chrysb/alphaclaw` version.
2. Rebuild the `openclaw` container from scratch (no cache) and recreate it:
   - `docker compose down`
   - `docker compose build --no-cache openclaw`
   - `docker compose up -d openclaw`
3. Verify runtime resolution inside the container:
   - `node -p "require('express/package.json').version"` should be `4.x`
   - `npm ls express` should show `@chrysb/alphaclaw` on `express@4.x` (OpenClaw can still carry its own `express@5` subtree).

### Telegram Notice Format (AlphaClaw)

Use this format for any Telegram notices sent from AlphaClaw services (watchdog, system alerts, repair notices):

1. Header line (Markdown): `🐺 *AlphaClaw Watchdog*`
2. Headline line (simple, no `Status:` prefix):
   - `🔴 Crash loop detected`
   - `🔴 Crash loop detected, auto-repairing...`
   - `🟡 Auto-repair started, awaiting health check`
   - `🟢 Auto-repair complete, gateway healthy`
   - `🟢 Gateway healthy again`
   - `🔴 Auto-repair failed`
3. Append a markdown link to the headline when URL is available:
   - `... - [View logs](<full-url>/#/watchdog)`
4. Optional context lines like `Trigger: ...`, `Attempt count: ...`
5. For values with underscores or special characters (for example `crash_loop`), wrap the value in backticks:
   - `Trigger: \`crash_loop\``
6. Do not use HTML tags (`<b>`, `<a href>`) for Telegram watchdog notices.

## UI Conventions

Use these conventions for all UI work under `lib/public/js` and `lib/public/css`.

### Setup UI bundle (esbuild)

- The browser loads the compiled bundle under `lib/public/dist/` (for example `app.bundle.js` and chunk files), produced by `scripts/build-ui.mjs` (esbuild).
- **After any UI source change** that should ship in production (`lib/public/js`, `lib/public/css`, or other inputs to the build), run **`npm run build:ui`** so `lib/public/dist/` stays in sync. Verify the app in the browser against the rebuilt bundle when the change is non-trivial.
- **`npm publish`** runs **`prepack`** → **`npm run build:ui`**, so published packages always include a fresh bundle. Local installs, Docker builds from a git checkout, or commits that include `dist/` still require **`npm run build:ui`** when you change UI sources and expect the built assets to match.

### Component structure

- Use arrow-function components and helpers.
- Prefer shared components over one-off markup when a pattern already exists.
- Keep constants in `kName` format (e.g. `kUiTabs`, `kGroupOrder`, `kNamePattern`).
- Keep component-level helpers near the top of the file, before the main export.
- Treat `index.js` as a presentational shell whenever possible: keep business logic in hooks and pass derived state/actions down as props.
- Add reusable SVG icons to `lib/public/js/components/icons.js` and import them from there; avoid introducing one-off inline SVGs in feature files when a shared icon component can be used.

### Rendering and composition

- Use the `htm` + `preact` pattern:
  - `const html = htm.bind(h);`
  - return `html\`...\``
- In `htm` templates, be explicit with inline spacing around styled inline tags (`<span>`, `<code>`, `<a>`): use ` ${" "}` where needed, and verify rendered copy so words never collapse (`eventsand`) or gain double spaces.
- Prefer early return for hidden states (e.g. `if (!visible) return null;`).
- Use `<PageHeader />` for tab/page headers that need a title and right-side actions.
- Use card shells consistently: `bg-surface border border-border rounded-xl`.
- For nested "surface on surface" blocks (content inside a `bg-surface` card), use `ac-surface-inset` for the inner container treatment so inset sections match shared history/sessions styling.
- For internal section dividers, use `border-t border-border` (avoid opacity variants) with comfortable vertical spacing around the divider.

### Color and theme tokens

- Prefer semantic Tailwind color utilities backed by theme tokens (`text-body`, `text-fg-muted`, `text-fg-dim`, `bg-field`, `bg-status-error-bg`, `border-status-warning-border`) instead of raw palette classes like `text-gray-300` or `bg-red-900/30`.
- When a new reusable UI color role is needed, add the CSS variable in `lib/public/css/theme.css` and expose it through `tailwind.config.cjs` rather than introducing one-off hardcoded color classes in components.
- Keep component refactors token-based so future theme changes stay centralized in the token layer instead of requiring per-component color rewrites.

### Buttons

- Primary actions: `ac-btn-cyan`
- Secondary actions: `ac-btn-secondary`
- Positive/success actions: `ac-btn-green`
- Ghost/text actions: `ac-btn-ghost` (use for low-emphasis actions like "Disconnect" or "Add provider")
- Destructive inline actions: `ac-btn-danger`
- Use consistent disabled treatment: `opacity-50 cursor-not-allowed`.
- Keep action sizing consistent (`text-xs px-3 py-1.5 rounded-lg` for compact controls unless there is a clear reason otherwise).
- For `<PageHeader />` actions, use `ac-btn-cyan` (primary) or `ac-btn-secondary` (secondary) by default; avoid ghost/text-only styling for main header actions.
- Prefer shared action components when available (`ActionButton`, `UpdateActionButton`, `ConfirmDialog`) before custom button logic.
- In setup/onboarding auth flows (e.g. Codex OAuth), prefer `<ActionButton />` over raw `<button>` for consistency in tone, sizing, and loading behavior.
- In setup wizard/multi-step modal footers, use `<ActionButton />` for Back/Next/Finish/Done actions (not raw `<button>`), so loading and tone behavior stays consistent.
- In multi-step auth flows, keep the active "finish" action visually primary and demote the "start/restart" action to secondary once the flow has started.

### Dialogs and modals

- Use `<ConfirmDialog />` for destructive/confirmation flows.
- Use `<ModalShell />` for non-confirm custom modals that need shared overlay and Escape handling.
- Modal overlay convention:
  - `fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50`
- Modal panel convention:
  - `bg-modal border border-border rounded-xl p-5 ...`
- Support close-on-overlay click and Escape key for dialogs.

### Inputs and forms

- Reuse `<SecretInput />` for sensitive values and token/key inputs.
- Reuse `<ToggleSwitch />` for boolean on/off controls instead of ad-hoc checkbox/switch markup.
- Base input look should remain consistent:
  - `bg-field border border-border rounded-lg ... focus:border-fg-muted`
- Preserve monospace for technical values (`font-mono`) and codes/paths.
- Prefer inline helper text under fields (`text-xs text-fg-muted` / `text-fg-dim`) for setup guidance.
- For tip/help links in helper text, use the shared `ac-tip-link` class (token-backed via `--accent-link`) instead of per-file ad-hoc cyan classes.

### Persisted settings and mutation feedback

- Persisted booleans/selects go through `useSavedSetting` (`lib/public/js/hooks/use-saved-setting.js`) — optimistic apply, generation-guarded hydration, savingRef lock, loud revert. Booleans render via `<SavedToggle />`; selects/segmented controls render the hook's `value` directly plus an `<InlineErrorChip />` on failure. Document-level hooks: `save` receives `(nextDoc, { context })` — when the endpoint patches per-field, narrow the request body to the field the context changed (watchdog settings is the model) so a stale local copy of a sibling field is never written back.
- One hook instance per settings DOCUMENT: when several controls share one GET/PUT (e.g. watchdog settings), use a single `useSavedSetting` (`select` = identity) and have each control call `commit({ ...value, field: next }, { context: "field" })`. Never instantiate per-field hooks against the same endpoint.
- Mutations that revert a control show a persistent `<InlineErrorChip />` adjacent to it (cleared on the next attempt). Toasts are for successes and fire-and-forget notices only — never the sole surface for a revert.
- A failed initial GET must never present a default value as fact: render the control disabled with a "Couldn't load — Retry" chip (`SavedToggle` does this via `loadError`/`onRetryLoad`).
- Every fetch that writes user-mutable or list state carries a latest-request-wins guard (generation ref / `usePolling` / `useCachedFetch`); background refreshes never overwrite unsaved drafts (dirty-check merges).
- Never gate a whole card on a fetch: render the frame immediately and scope "Loading..." to the data region or control label (`api-feature-panel.js` pattern). Lists/status panes distinguish loading / error(+Retry) / genuinely-empty — use `<AsyncSection />`.
- After write/mutation APIs, `setCached`/`invalidateCache`/`refresh({ force: true })` the affected keys (see `lib/public/js/lib/api-cache.js` — force refreshes are generation-safe: a superseded request can neither be deduped onto nor write the cache; residual edge: the superseded promise itself can still hand pre-mutation data to its awaiting caller, tracked in TODOS.md).
- Per-row actions get per-row pending state ("Approving...", "Binding...") on the clicked control, not a page-level spinner.

### Feedback and state

- Use `showToast(...)` for user-visible operation outcomes.
- Prefer semantic toast levels (`success`, `error`, `warning`, `info`) at callsites. Legacy color aliases are only for backwards compatibility.
- Keep toast positioning relative to the active page container (not the viewport) when layout banners can shift content.
- For hover help and icon labels, use the shared portal-backed tooltip components (`Tooltip`, `InfoTooltip`) instead of inline absolutely positioned popovers, so tooltips are not clipped by cards, rows, or scroll containers.
- Keep loading/saving flags explicit in state (`saving`, `creating`, `restartingGateway`, etc.).
- Reuse `<LoadingSpinner />` for loading indicators instead of inline spinner SVG markup.
- Use `<Badge />` for compact status chips (e.g. connected/not connected) instead of one-off status span styling.
- Every `warning`/`danger` badge carries a SELF-STANDING label naming the condition (never a bare "Error"/"Blocked"); cause detail rides adjacent text or the shared `<TooltipBadge />` — but tooltips are supplementary only (they do not open on touch — `tooltip.js` suppresses focus-open on tap), so a danger badge's required action must live in visible text, a drill-down, or the label itself. Never swallow a caught error into static copy: surface it through the envelope helpers (`buildErrorEnvelopeModel` / `<InlineErrorChip />`) where a chip fits, else bind the message into the copy. A failed status CHECK keeps last-known status rather than fabricating a state — and never claims "last known" data that doesn't exist (no prior data reads "unknown", not "not connected").
- Read `#/route?key=value` hash-query params through the shared `lib/public/js/lib/hash-query.js` helper (`readHashQueryParam`) — never hand-roll a second hash parser (the watchdog incidents anchor parser predates it and migrates later; see TODOS.md).
- Use polling via `usePolling` for frequently refreshed backend-backed data.
- For restart-required flows, render the standardized yellow restart banner style used in `providers`, `envars`, and `webhooks`.

### Shared formatting utilities

- Prefer shared formatter helpers in `lib/public/js/lib/format.js` for reusable value formatting (`formatX` style helpers such as date/time, currency, integers, and common duration formats).
- Before adding a new formatter in a component, check `lib/public/js/lib/format.js` and reuse an existing helper when possible.
- Add new formatter helpers to `lib/public/js/lib/format.js` when the behavior is cross-feature and likely to be reused; keep feature-specific transforms local to the feature folder.
- Avoid wrapper pass-through helpers that only rename a global formatter without adding feature-specific behavior.
- **Date/time rendering is normalized (v0.9.45):** every UI timestamp renders through the shared date/time family in `lib/public/js/lib/format.js` (`formatLocaleDateTime`/`formatLocaleDate`/`formatLocaleTime`, `formatLocaleDateTimeWithTodayTime`, `formatLocaleDateTimeWithZone`, `formatLocaleDateTimeRange`, `formatRelativeTime`), built via the `createFormatters(timeZone?)` factory; `getBrowserTimeZone()` supplies the zone id (and the `x-client-timezone` request header). Never call `toLocale*` or `new Intl.DateTimeFormat(...)` in components: the conventions guard test (`tests/frontend/format-conventions.test.js`) fails the build on any use outside `format.js`, with one allowlisted exception (the `Number#toLocaleString` char counts in `components/doctor/helpers.js` — number-locale un-pinning is deferred, TODOS.md E5). One deliberate non-Intl outlier the guard cannot see: the watchdog console's fixed-width local log stamps (`formatLocalLogStamp`/`localizeLogTimestamps` in `components/watchdog-tab/helpers.js`) assemble `YYYY-MM-DD HH:mm:ss ±HH:MM` manually for copy/paste-stable offsets — don't copy that pattern to new surfaces.
- **Deliberate UTC exceptions:** machine-readable exports for escalation (e.g. the watchdog console's "Copy diagnostics (UTC)" payload) intentionally keep raw UTC ISO strings — label the surface "(UTC)" instead of localizing it.
- Server-side timezone logic (canonicalizing the `x-client-timezone` header — or its `?timeZone=` query fallback — and DST-safe local-midnight day bucketing) lives in `lib/server/utils/time-zone.js` (`resolveTimeZone`, `normalizeTimeZone`, `readClientTimeZone`, `getTimeZoneDayStartMs`) — reuse it instead of hand-rolling zone math in routes.

### Session key utilities

- Keep shared session-key parsing/filtering helpers in `lib/public/js/lib/session-keys.js` (for example extracting `agentId`, destination-session matching checks, and destination payload derivation).
- Before adding session-key logic in a hook/component, check `lib/public/js/lib/session-keys.js` first and reuse existing helpers.
- When session-key behavior is reused across features, add/extend helpers in `lib/public/js/lib/session-keys.js` instead of duplicating regex/string parsing in feature files.

### localStorage keys

- All standalone `localStorage` keys are defined in `lib/public/js/lib/storage-keys.js`. Import keys from this file — never define raw localStorage key strings inline in components.
- Use the naming convention `alphaclaw.<area>.<purpose>` for new keys (e.g. `alphaclaw.doctor.lastSessionKey`).
- Keys that live inside the `alphaclaw.ui.settings` JSON blob (e.g. `browseLastPath`, `doctorWarningDismissedUntilMs`) are sub-keys, not standalone localStorage entries — those stay in their consuming file.
