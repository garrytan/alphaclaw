# Changelog

All notable changes to AlphaClaw are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow this repository's `package.json` release counter.

## [0.9.43] - 2026-08-29

### Added
- **Resource autotune (`autotune.enabled`, default ON).** AlphaClaw now reads
  the container's actual capacity (cgroup v1/v2 memory limit, CPU quota,
  disk, GPU presence — with host fallback and a container-of-unknown-size
  suppression guard) and sizes its resource-dependent settings to the box:
  the gateway's V8 heap (`--max-old-space-size`, strip-then-re-add so admin
  and gateway keep separate budgets), the gateway/CLI `UV_THREADPOOL_SIZE`,
  the agent-concurrency ceiling (replacing the fixed 64 — small boxes hold
  today's floor, big boxes scale to 128), JSON body limits, SQLite page
  caches (shared `applyOperationalPragmas`, negative-KiB semantics), and an
  advisory backup-retention budget. Every decision lands in a persisted
  ledger (detected → derived → applied, with per-row restart ownership:
  gateway vs AlphaClaw) surfaced at `GET /api/autotune`, on the Watchdog
  tab's new Autotune card, in `/api/status`'s `machine` block, the
  `alphaclaw admin --summary` digest, the agent's `SKILL.md`/`TOOLS.md`, and
  the medic/overseer prompts (numeric facts only). Live container resizes
  are detected on the watchdog tick (event + notification + retune); gateway
  heap-OOM and container-OOM exits are classified as distinct watchdog
  events with machine-derived remediation. Opt out per deployment
  (`PUT /api/autotune/settings {"enabled":false}` or the card toggle) or via
  the `ALPHACLAW_AUTOTUNE_DISABLED=1` env kill-switch (works mid-crash-loop
  from the platform dashboard); disabling restores pre-feature behavior,
  including deleting the concurrency default autotune itself wrote — and it
  never rewrites values you set by hand: only ledger-attributable writes are
  reverted, and a no-change pass never round-trips your `openclaw.json`.

### Changed
- The OpenAI-compatible `/v1` endpoints now reject requests without a bearer
  token before reading the request body, so unauthenticated traffic can no
  longer occupy request-body memory at all.

### Fixed
- The stale `package-lock.json` version left behind by the 0.9.42 release is
  synced.

## [0.9.42] - 2026-08-29

The Watchdog tab now explains itself: a live narrative of what the watchdog
is doing and why, a persisted incident history that groups raw events into
readable stories, and an optional AI overseer that reviews each settled
incident and tells you whether anything still needs your attention.

### Added
- **Live status narrative**: a card under the Gateway card that says in plain
  language what is happening right now — "Degraded for 6m — probe returned
  HTTP 503. Repair attempt 1 of 2 running. Auto-rollback in 3m 48s if not
  recovered." — with live countdowns for backoff, grace, and rollback
  deadlines, and an amber chip when auto-repair is paused by a stabilization
  window (the toggle keeps showing what you configured; the chip shows what
  is actually in effect).
- **Incident history**: gateway trouble is now recorded as incidents —
  opened on the first crash, failed probe, config error, release rollback,
  or safe-mode entry, and closed on recovery — instead of a flat event log. Incident cards carry
  a severity badge, a deterministic title ("Crash loop → rolled back ·
  resolved in 8m"), and an expandable event timeline; the active incident is
  pinned and pulsing. Older incidents page in with "Load more"; an "All
  events" tab keeps the raw feed with a routine-probe filter. Incidents
  survive restarts (an interrupted one is marked abandoned honestly) and
  the overseer's verdict notifications deep-link straight to the incident
  card.
- **Incident overseer** (optional, off by default): after an incident
  settles and the gateway is healthy again, a local Claude Code review is
  recorded on the incident — a verdict (resolved / monitoring / action
  needed), a plain-language summary, and a recommended action that surfaces
  as the matching button (repair, restart, resume channels) only while it is
  still applicable. Includes a "Review now" button, verdict chips on
  incident cards, and one deduplicated notification per incident with a
  "View incident" link. Advisory only: the deterministic watchdog remains
  the sole recovery authority. When enabled, redacted gateway logs, incident
  records, and doctor output are sent to the Anthropic API; the review runs
  with secrets redacted from both the prompt and the model's output, in an
  isolated environment with tools disabled (and is skipped entirely if that
  restriction can't be verified or the secret-redaction sources can't be
  read).
- **Status detail rows**: last probe time and failure reason, degraded
  duration, crash count against the crash-loop window, repair attempts,
  gateway PID, and last-exit details — all from data the server already had.
- **Resource telemetry**: event-loop lag percentiles (with a help tooltip)
  and unhandled-rejection counts now render alongside the memory/disk/CPU
  bars, with warning colors at sustained thresholds.

### Changed
- Watchdog cards reordered by usefulness: status → narrative → overseer →
  incidents → backup → console → resources → settings.
- The auto-repair toggle now tracks the live status stream, so a change made
  elsewhere (another tab, environment) converges without a reload — and a
  just-saved value never snaps back under a stale frame.
- Incident list responses slimmed for the 15s poll; full evidence snapshots
  stay on the incident detail read.
- Failed API errors surface the server's human-readable message instead of a
  bare code.

### Fixed
- Relative times and countdowns pause while the tab is hidden and stay
  correct under clock skew in either direction.
- Skipped health probes during grace/restart windows can no longer close an
  incident early; planned restarts never open one.
- Incident review requests return honest statuses (404 unknown incident,
  429 rate-limited, 503 reviewer infrastructure unavailable) with
  human-readable messages.
## [0.9.41] - 2026-08-29

### Added
- **Agent Administration (`features.agentAdmin`, default OFF).** The OpenClaw
  agent can now administer this AlphaClaw deployment on behalf of admin users —
  env vars, channels, agents, cron, webhooks, models, updates, watchdog, team —
  through an `alphaclaw admin <METHOD> /api/path` CLI backed by a manifest-
  described, tier-enforced view of the existing dashboard API. When enabled, a
  bearer token is minted (0600, state-dir, never git-synced), an
  `alphaclaw-admin` skill is generated into the workspace, and a pointer stanza
  is added to the agent's `TOOLS.md`. Operations are classified `safe` /
  `write` / `restart` / `dangerous` / `denied`; dangerous operations require a
  one-time confirm code delivered to a configured admin channel; every
  agent-driven mutation is audited to `watchdog.db` and admins are notified of
  restart-level and dangerous changes. **No observable change to existing
  functionality with the flag off** (no token, no skill, no `TOOLS.md` stanza;
  `/api/admin/*` returns 404). Enable it in Setup UI → General.
- **Config write hardening.** `alphaclaw.json` writes now go through a locked,
  atomic read-modify-write helper (`updateAlphaclawConfig`); `.env` writes are
  atomic (temp+rename) with a locked `updateEnvFile` helper available for
  callers; and `alphaclaw.json` is git-synced (README parity).

### Security
- The Agent Administration bearer path is opt-in per call site: it authorizes
  only Express `/api` requests, never WebSocket upgrades (watchdog terminal,
  chat) or the human-only cookie surfaces. It uses a separate rate-limit scope
  from the dashboard login, so agent-bearer failures can never lock an operator
  out. Documented honestly: this is not a security boundary against the agent
  (which already holds these credentials via the gateway env) — it exists for
  audit attribution, revocation, transcript hygiene, and tiered guardrails.

## [0.9.40] - 2026-08-29

Best-of-breed toggles, status, and errors across the entire Setup UI: a
22-agent audit confirmed 119 instances (~112 unique sites) of one defect
class — pessimistic toggles that visually snap back, silent or toast-only
failures, stale responses clobbering user actions, fetch-hostage cards, and
loading/error/empty states conflated — and every instance is fixed on shared
primitives.

### Added
- **`useSavedSetting`** (`lib/public/js/hooks/use-saved-setting.js`): the one
  persisted-setting loop — optimistic apply with loud inline revert,
  generation-guarded hydration (an in-flight GET can never clobber a user
  action, even landing after the save), synchronous save lock, entity `key`
  scoping with render-gated resets, load-failure state with Retry (a failed
  GET never presents the default as fact), reconcile-on-ambiguous-failure
  (a rejected fetch doesn't prove the PUT failed — the UI converges to server
  truth), canonical response adoption via `selectSaved`, cache seeding via
  `cacheKey` (instant remounts, no background revalidation of user-mutable
  state), functional commits, and a `{ ok, error, value }` outcome contract.
- **`SavedToggle`**, **`InlineErrorChip`**, **`AsyncSection`** shared
  components: house labels ("Saving...", "Loading...") with `aria-busy`,
  persistent inline error chips (`role=status aria-live=polite`) for anything
  that reverts, and standard loading / error(+Retry) / empty region states.
- AGENTS.md "Persisted settings and mutation feedback" conventions section.
- Browser smoke coverage for the founding bug: the Overseer toggle must flip
  instantly, never snap back, and persist across reload
  (`tests/browser/upgrade-ui-smoke.sh`).

### Fixed
- **Overseer toggle** (the founding bug): flips instantly with a "Saving..."
  state and reverts loudly inline on failure; stale settings responses can no
  longer overwrite the operator's choice; the card renders immediately instead
  of waiting for the availability probe, which is now warmed at server boot
  (`upgrade-overseer.start()`), and the dead `runs` fallback that refetched
  settings on every runs refresh is gone.
- **`api-cache.js` force/in-flight bug** (hit channels, gmail watch, envars,
  nodes): a forced post-mutation refresh could be satisfied by — or
  overwritten by — a request dispatched before the mutation. Reads and writes
  are now generation-guarded; a superseded request can neither be deduped
  onto nor overwrite newer cache state, and `invalidateCache` makes in-flight
  requests unusable for dedupe.
- **`useCachedFetch`**: inline-lambda fetchers no longer re-trigger the mount
  fetch every render (fetcher held in a ref), and hook-local state is
  latest-request-wins so an older refresh resolving late cannot overwrite
  newer data.
- **Upgrade page**: a failed apply no longer leaves the entire page dead —
  the failed progress card has a Dismiss affordance that re-enables all
  controls; channel/catalog loads are latest-request-wins (a just-cleared
  blocklist entry can no longer flash back); a failed "Check now" shows an
  inline warning instead of silently keeping stale data; mark-good/rollback/
  blocklist failures render persistent inline chips instead of transient
  toasts; the channel card renders immediately with the picker visible
  (cache-backed remounts) instead of a page-blanking loading shell; channel
  saves refresh the shared /api/status so the sidebar footer updates
  immediately.
- **All remaining audited sites** across watchdog, agents, cron, google,
  general, team, channels, telegram-workspace, providers, models, envars,
  nodes, webhooks, file-viewer, onboarding, usage, doctor, pairings, and the
  sidebar git panel: persisted toggles/selects are optimistic with inline
  reverts, per-row actions show per-row pending states, list panes distinguish
  loading from failed from empty, fetch errors never masquerade as confident
  defaults, background refreshes never overwrite unsaved drafts, and
  mutations invalidate the caches their consumers read. Disabled toggles and
  subtle/neutral/warning buttons now look disabled (`cursor: not-allowed`,
  reduced opacity). The unreferenced legacy `components/models.js` is deleted.
- **Models tab can no longer be blanked by a transient server error:** an
  HTTP error response is treated as an error instead of being adopted as
  empty configuration — your configured models, profiles, and provider order
  stay put (and the error is shown) until a refresh succeeds. The same guard
  keeps a failed Codex status check from fabricating "not connected" and a
  failed thinking-options fetch from leaving the previous model's levels
  selectable.
- **Watchdog settings saves are narrower:** each toggle now writes only its
  own setting, so flipping notifications can no longer overwrite an
  auto-repair change made meanwhile from another tab or the CLI.

### Security
- Error-envelope documentation links only render as clickable anchors for
  http(s) URLs — a hostile `docsUrl` in an upstream error can no longer
  inject `javascript:` links into the UI.
- The overseer's boot-time `claude --version` availability probe (and
  `--help` flag discovery) no longer receive `ANTHROPIC_API_KEY`; only real
  overseer runs get the credential. Concurrent cold probes are also
  single-flighted.

## [0.9.39] - 2026-08-29

The gateway no longer crash-loops when a beta-only config key meets a stable
build — and when a config error does stop it, AlphaClaw now troubleshoots and
repairs it automatically.

### Fixed
- **Beta stripe no longer poisons stable boots.** The Control-UI environment
  stripe (`gateway.controlUi.environment`) was written whenever the release
  channel said beta/dev, even when a fallback (missing overlay, failed
  activation, stale dev checkout, rollback) left the built-in stable OpenClaw
  running — which rejects the key with `EX_CONFIG` and crash-looped every
  boot with `gateway.controlUi: Unrecognized key: "environment"`. The stripe
  is now gated on the build that will actually run (2026.8.1+ for beta, an
  active dev shim with a 2026.8.1+ checkout for dev), and a stripe left
  behind by an older AlphaClaw is removed on the next boot automatically.

### Added
- **Gateway startup medic (default on).** When the gateway exits with a fatal
  configuration error, AlphaClaw now repairs it instead of only pausing
  restarts: it removes config keys the gateway itself rejected (managed keys
  immediately; others only with AI concurrence), or runs OpenClaw's
  `doctor --fix`, then restarts the gateway — with a best-effort
  `openclaw.json.medic-*.bak` backup before mutations (a missing config never
  blocks the remedy), at most two attempts per incident, and a
  notification describing exactly what was done. For failures without an
  obvious fix, the medic asks the smartest frontier model you have an API key
  for (Claude Fable 5 → Claude Opus 5 → GPT-5.6 → Gemini 3.1 Pro preview;
  evidence is secret-redacted first) to diagnose and pick from the
  whitelisted remedies —
  the model can never edit anything itself. Toggle on the Upgrade page or at
  `updates.openclaw.medic.enabled`; disabling restores the old
  pause-and-notify behavior.

## [0.9.38] - 2026-08-29

Team accounts with real credentials, two new channels, and a beta-ready
update pipeline — merged on top of 0.9.37's unified gateway-state,
streamed-restart, and never-freeze work.

### Added
- **Team access with member accounts.** Share one AlphaClaw with named
  teammates: each person signs in with their own email and password, and
  OpenClaw sees who's who — attributed messages, per-person profiles, and a
  who's-online roster. Admins invite members with expiring single-use links,
  set roles, and disable or remove accounts (sessions and gateway authority
  end together; the last admin can never be demoted). The enable wizard
  explains the security boundary up front, applies the gateway change,
  restarts, verifies the login handshake end to end, and restores the
  previous setup automatically if the check fails. Optional lockdown turns
  off shared-password login once your own account works (break-glass env
  var included).
- **Member permissions across the dashboard.** Members can chat and view
  status; updates, secrets, terminals, agents, webhooks, and team management
  stay admin-only — enforced on every API route, WebSocket, and OAuth
  callback, with a role-aware navigation that hides admin pages.
- **ClickClack channel.** Paste one setup code or URL on the beta for a
  fully guided setup (codes are single-use and never stored); manual
  token/base-URL fields work everywhere, including onboarding.
- **Buzz channel.** A resumable guided wizard installs the plugin, restarts
  the gateway, walks through relay + bot identity, waits for a room admin's
  approval (survives page reloads without rotating the identity), and
  finishes with room selection.
- **"What's new" per channel.** A curated card shows each OpenClaw line's
  highlights with security-default changes called out separately — and the
  same security changes appear again in the apply confirmation before you
  commit to a cross-channel switch.
- **Database compatibility check.** Before an update applies, the target
  version's own binary verifies it can read snapshots of your state
  databases; incompatible updates are blocked before anything changes.
  Rollbacks that cannot be verified say so honestly.
- **Settings migration at boot.** After a version change, OpenClaw's own
  doctor migrates your settings once (with a pre-migration backup kept per
  version); downgrades restore the exact settings saved for that version.
  The Upgrade page shows the last migration result.
- **Repair button.** Dev builds that fail mid-update get a one-click
  streamed `update repair`, recorded in the run timeline like any update.
- **Verified install scripts.** Staged updates run the package's install
  scripts in isolation and refuse to activate a tree whose install guard
  proves they didn't finish.
- **More surfaces:** feature-detecting capability probes for the installed
  OpenClaw; a secrets-store banner on Envars; a channel-colored environment
  stripe in the Control UI; markdown release notes (sanitized); a searchable
  onboarding model picker with live-catalog-gated defaults; onboarding
  without channels ("Continue with web chat"); a "What's next" checklist on
  General; Slack `/login` command and progress-indicator setting; degraded
  gateway states with plain-language recommended actions; gateway
  restart-handoff awareness and control-plane rate-limit backoff.

### Changed
- Trusted-proxy identity now carries the member's **email** (matching the
  gateway allowlist and per-identity permissions), injected — and spoofable
  headers stripped — in one shared layer covering HTTP proxying, WebSocket
  upgrades, and the webhook path.
- External supervision (`OPENCLAW_SUPERVISOR_MODE=external`) is now the
  default on every gateway launch — a no-op on stable, load-bearing on
  2026.8+ — with an `off|none` escape hatch that fully reverts it.
- The availability line reports honest release distance ("2 beta releases
  behind" / "not running this channel yet"), and the rollback confirmation
  states what a downgrade can and cannot verify.
- Update repair runs are recorded in the durable run ledger with redacted
  logs, like applies.

### Fixed
- A fresh install's first cross-channel switch is no longer blocked by the
  backup guard when there is nothing to back up yet (live-verified against
  the real beta).
- Recurring boot notifications (settings migration, restores, preflight
  warnings) are deduplicated per version instead of repeating every boot.
- Config read caches can no longer serve stale contents when the underlying
  reader changes.
- The What's-new card and its security-change list now appear immediately
  when you switch channels in the same session, instead of only after a
  reload.
- A guided ClickClack setup that fails after the code is accepted now cleans
  up so you are not blocked from retrying, and ClickClack no longer strands
  onboarding at a dead pairing step. A paused Buzz setup resumes where you
  left off instead of restarting from the beginning.

### Security
- Team members can no longer read stored provider API keys or OAuth tokens
  (the model-credentials endpoints are admin-only).
- Turning team access off now fully ends member access: member sessions and
  logins stop working, and existing shared-password sessions end the moment
  shared-password login is disabled.
- Member email addresses are strictly validated, member-account changes made
  while team access is off no longer disturb the gateway login mode, a
  half-completed enable can no longer strand the login configuration, and the
  file that stores the previous gateway credential is owner-only.
- Invite acceptance is transactional — a failed signup no longer burns a
  single-use invite — and reveals nothing about which emails already exist.
- Client-supplied forwarding headers are stripped before every gateway
  request, and the Buzz plugin installs with an isolated home directory so
  package scripts cannot read credentials from disk.

## [0.9.37] - 2026-08-28

### Added
- **One honest gateway status.** The Gateway card now shows a single unified
  state instead of separate (and sometimes contradictory) gateway/watchdog
  rows. The vocabulary, in the order the card resolves it:
  - **Not set up yet** — AlphaClaw hasn't been onboarded.
  - **AlphaClaw starting / Startup failed** — the boot sequence itself.
  - **Status unavailable** — no fresh observation; shows when it was last
    confirmed running instead of guessing.
  - **Configuration error** — OpenClaw rejected its config (exit 78);
    automatic restarts pause until it's fixed.
  - **Down** — not running, nothing in progress; Retry/Repair offered.
  - **Starting** — launching, with elapsed time against the ready budget.
  - **Unstable** — crashed and came back repeatedly; crash count and window
    shown (estimated when the gateway runs outside AlphaClaw's supervision).
  - **Running with issues** — up, but health probes are failing.
  - **Channels paused** — the gateway's crash-loop breaker suppressed channel
    autostart; one-click Resume.
  - **Running** — up, healthy, with real uptime.
  Every state carries a plain-language reason, the recommended action, and a
  glossary explainer. Alerts (Telegram/Discord/Slack/WhatsApp) use the same
  vocabulary, so what pings you matches what the page says.
- **Restarts you can watch.** Restarting the gateway streams live steps
  (checking plugins → stopping → starting → waiting for health check) with
  honest outcomes: success reports measured downtime; failure shows the
  actual error evidence (secrets redacted) with what to try next — no more
  "Gateway restarted ✅" over a dead gateway. Restarts survive page reloads
  and even an AlphaClaw crash mid-restart ("interrupted restart" on reboot).
- **Faster dead-gateway detection.** An always-on 10-second port watcher plus
  immediate re-checks after every restart/repair replace the old
  up-to-2-minutes wait; stale verdicts like a lingering "crash loop" clear
  the moment reality changes.
- **Last-delivered timestamp for watchdog alerts** (next to the existing
  Send test notification button), so you can verify alerting is actually
  reaching you before you need it.

### Changed
- **Nearly everything is faster.** The server no longer freezes itself:
  status checks, restarts, and boots run off the event loop; the
  logs/watchdog page queries are indexed; the Upgrade page catalog serves
  instantly from cache while refreshing in the background; responses are
  compressed; charts load on demand. Status responses that took seconds
  under load now answer in milliseconds.
- **Expected restart during upgrades:** a gateway restart is part of channel
  switches and upgrades; the watchdog now knows the restart window is
  expected and won't report it as a crash or trigger rollback hooks during
  it.
- **API compatibility window:** `/api/status` keeps the legacy
  `gateway`/`watchdogStatus` fields for one minor release as projections of
  the new `state` object (they can no longer disagree). `POST
  /api/gateway/restart` keeps blocking semantics by default; new clients
  opt into `?async=1` + the streamed operation. Both defaults flip next
  minor.
- **Rollback implications:** automatic version rollback still arms after
  gateway restarts; interrupted or failed restarts leave the rollback
  window and its incident reporting exactly as before — with clearer
  attribution in the incident feed ("automatic repair" vs manual restart).

### Fixed
- **Operations can no longer collide.** Channel updates, gateway restarts,
  channel saves, and the watchdog's own recovery all serialize through one
  lifecycle lock in both directions — an update can't kill a live restart,
  a save can't interleave with a boot, and team-mode transitions hold the
  same lock. A failed restart can no longer leave the card stuck on
  "Starting" with no way out, and a gateway that crash-loops relaunches
  with exponential backoff instead of hot-looping.
- **Failure evidence stays readable and safe.** Restart evidence no longer
  masks harmless values like file paths into `***` (only secret-named
  values are redacted, longest-first so partial matches can't leak), and
  failure messages get the same masking as stderr.
- **Light theme and accessibility:** status dots now meet contrast minimums
  in light mode, the reduced-motion setting actually stops every pulsing
  animation, and small controls meet the 44px touch-target minimum on both
  axes.
- Charts recover after a failed load instead of staying blank for the whole
  session; a stuck status-stream client is disconnected instead of
  buffering frames without bound; port or channel changes written to
  openclaw.json by any writer are picked up immediately.

### Removed
- `GET /api/gateway-status` (unused; it spawned a blocking 15s CLI status
  call if ever hit). Use `GET /api/status` — the unified `state` object
  carries everything it reported and more.

## [0.9.36] - 2026-08-28

Fix the chronic admin-UI downtime: the dashboard stays responsive while the
gateway restarts, updates install, or the workspace grows. Verified on a
15,000-file workspace: `/health` p99 dropped from 150–430ms to under 2ms,
and proxied API writes no longer hang.

### Fixed
- **Proxied JSON writes no longer hang.** The admin server consumed request
  bodies before proxying, so every JSON POST/PUT to gateway APIs stalled
  until timeout. Proxied paths now stream bodies through untouched, with a
  50 MB cap — oversized or chunked-encoding uploads get a fast 413 instead
  of becoming an out-of-memory risk.
- **Status polling no longer freezes the dashboard.** Workspace drift
  fingerprinting (a full re-hash of every workspace file, previously re-run
  every few seconds) moved to a background worker thread with incremental,
  demand-driven refresh and bounded manifests (50k files / 10 MB per file);
  channel, cron, and doctor status are served from short-lived caches; the
  doctor run history no longer re-parses multi-megabyte manifests per
  status request, and status responses stop embedding full manifests.
- **Crashes no longer kill the dashboard silently.** Unhandled rejections
  are logged and survived (a storm brake restarts cleanly if a subsystem
  fails continuously), uncaught exceptions exit through a bounded graceful
  shutdown, and a port conflict at startup retries loudly instead of dying.
- **Gateway controls no longer freeze everything.** "Restart gateway",
  channel saves, and watchdog recovery ran blocking CLI commands (up to
  120s) on the request path. They are now async and serialized through a
  single-flight lifecycle lock: double-clicking Restart coalesces, a save
  during a restart queues, and shutdown cancels an in-flight restart
  (including its 120s ready-wait) instead of waiting it out.
- **Channel tokens can no longer leak into logs** when a channel add fails:
  CLI failures are scrubbed of secret-bearing argument values before
  logging, and unexpected 5xx responses return a generic message instead of
  internal error details.
- **The watchdog repair no longer parks itself.** `doctor --fix` runs
  through a streaming runner with a 10-minute ceiling (previously killed at
  15s), crash restarts back off exponentially, and a repair skipped during
  an in-flight relaunch retries on a bounded cadence instead of dropping.
- Log writing is buffered with size-capped rotation (no more per-line
  synchronous writes on the hot path); the watchdog log endpoint clamps
  unbounded tail reads to 4 MB.
- SQLite contention: WAL mode with correct pragma ordering (no boot crash
  when a draining predecessor holds a lock), bounded busy timeouts, and a
  stale-result fallback for usage stats during gateway write bursts.
- **OpenClaw update backups no longer fail forever at the backup step**
  (#7, #9). AlphaClaw passed the fixed path `<root>/backups/openclaw` to
  `openclaw backup create --output` without creating the directory, so the
  CLI wrote the archive as a file at that exact path: the first
  cross-channel/hard-gated run produced a verified multi-GB archive that
  the artifact check couldn't see and falsely reported as "produced no
  backup file" (#9, orphaning the archive), and every later run hit the
  CLI's refuse-to-overwrite error (#7). Backups now go to unique per-run
  archives (`openclaw-backup-<timestamp>-<opid>.tar.gz`) inside that
  directory — a legacy archive file blocking the path is migrated into the
  directory automatically — keep-3 retention actually prunes old archives,
  and verify-failed archives are quarantined as `*.unverified`. Backup
  errors now state the real cause and the offending path (overwrite
  refusal, timeout, out of disk space, verify failure) instead of a
  misleading "failed to verify" / "not trustworthy" message, the
  "openclaw update repair" advice appears only when repair actually
  applies, and the failed-update card's elapsed timer freezes at failure
  instead of counting up forever. Revert-safe: after this fix the path is
  a directory of archives, which older AlphaClaw versions and the CLI's
  directory contract both handle correctly.

### Added
- **"AlphaClaw is updating" page during restarts and updates.** The port
  answers immediately at boot — browsers get a human auto-refreshing page,
  platforms get 200 `{status:"updating"}` health checks so they don't
  restart-loop a container mid-update, and a boot stuck past 15 minutes
  flips to 503 so the platform recovers it. The placeholder runs as its own
  small process (so it keeps answering even while the boot installs block),
  and retries its bind while a previous instance finishes draining.
- **Three-state `/health`** (healthy / degraded with `gatewayDownSince` /
  updating — always 200) and an opt-in strict `/health/ready` (503 while
  the gateway is down; configure it only after onboarding).
- **Event-loop and rejection telemetry** in `/api/watchdog/resources` (loop
  lag percentiles, RSS, unhandled-rejection counts) with a sustained-lag
  warning in the logs, plus a responsiveness harness under `scripts/dev/`.
- README deployment sizing guidance (≥2 GB / 1 CPU recommended; per-process
  heap budgets — the gateway no longer inherits the admin server's memory
  flags).

### Changed
- Proxy engine swapped from the unmaintained `http-proxy` to `http-proxy-3`
  (pinned 1.20.10), with a 30s fail-fast timeout for hung gateways that
  disarms once a response starts streaming.
- `/v1` JSON request bodies are capped at 20 MB (was 50 MB) to remove an
  out-of-memory vector on small instances.
- SSE status stream: doctor status recomputes on a 30s cadence shared
  across tabs instead of per-tab, and clients that stop reading are
  disconnected instead of buffering without bound.
- Graceful shutdown drains in order (watchdog → HTTP → gateway → gmail →
  terminal → service disposal → log flush) within a 10s deadline; SIGTERM,
  self-update restarts, and crash exits all route through the same path.


## [0.9.35] - 2026-08-27

Adopt the OpenClaw 2026.8.1 beta line and rebuild the upgrade experience:
a narrated, durable, admin-notified update lifecycle, an optional AI
overseer, and a default-off team web view.

### Added
- **Upgrade page overhaul.** Clicking a release channel now persists
  immediately (spinner while saving, a persistent inline error chip on
  failure — never a silent snap-back). A standing mismatch banner shows
  "channel set to beta — still running stable X" with an Apply / release
  notes / back-to-stable choice, and all breaking-change framing (verified
  backup, 120s acceptance hold, 24h auto-rollback, blocklist, what-happens-
  next) moved into the Apply confirm. Degraded catalog sources are handled
  per source (GitHub down annotates notes; npm down gates Apply). A run
  timeline card and a post-restart "View full log" round it out.
- **Durable update run ledger.** Every OpenClaw update gets a per-operation
  run record and a redacted, size-capped log (10 MB/run, 200 MB total) that
  survive the activation restart — new `GET /api/openclaw/runs`,
  `/runs/:id`, and `/runs/:id/log` (bounded tail) endpoints power a
  post-restart "what happened" view. The npm install now streams through the
  spawn runner so a hang or OOM still leaves log evidence.
- **Notification outbox with admin routing.** Upgrade and watchdog
  notifications are persisted before delivery (deduped by id, retried on
  failure with an attempt cap that logs loudly instead of dropping,
  re-drained after restarts) and can be routed to explicit admin targets
  with a preferred channel and error-only "(fallback)" delivery
  (`GET/PUT /api/openclaw/notifications`). Failed applies — previously
  silent — now notify, with a deep link to the Upgrade page. AlphaClaw's own
  version updates are announced once per version.
- **Team web view (named operators, default off).** Behind `team.enabled`:
  named operators pick an identity at login, forwarded to OpenClaw as
  trusted-proxy identity so the beta's multi-user Control UI lights up.
  Cookies carry a revocable operator claim; the gateway auth transition
  snapshots → applies → probes → auto-restores on failure; identity and
  forwarded-evidence headers plus the alphaclaw session cookie are stripped
  at every gateway boundary. Explicitly not a security boundary (operators
  share one password); flagged as such in the UI.
- **Upgrade overseer (recommend-only, default off).** An optional Claude
  Code review of each settled update run: it reads the run record, the
  redacted log tail, and `openclaw doctor` output in an isolated,
  secret-free environment (prompt over stdin, tools disabled) and posts an
  advisory verdict (healthy / suspect / broken) with a suggestion to Mark as
  good or Roll back — only when the reviewed run is the live build. The
  deterministic watchdog remains the only enforcement layer. Requires the
  `claude` CLI and `ANTHROPIC_API_KEY`; availability is shown, never
  silently degraded. When enabled, redacted upgrade logs and doctor output
  are sent to the Anthropic API. Toggle:
  `updates.openclaw.overseer.enabled` / the Upgrade page's Overseer card.
- **Version-gated OpenClaw beta features** (fail-closed on stable and dev
  shas, via `GET /api/openclaw/features`): external supervisor mode
  (`OPENCLAW_SUPERVISOR_MODE=external` in the gateway env on
  2026.8.1-beta.1+), a "Create verified SQLite backup" button on the
  Watchdog tab (`POST /api/openclaw/backup-sqlite`, 503 when unsupported),
  a gated session Dashboards sidebar link with a focus-mode deep-link
  helper, and a secret-egress-binding note on the Envars page.
- **Models:** added `openai/gpt-5.6-ultra` to the always-available model
  catalog next to the other GPT-5.6 entries.

### Changed
- Cross-channel, prerelease, and downgrade applies now HARD-require a
  verified backup (an artifact must actually appear, not just exit 0); the
  run records the exact backup. Same-channel upgrades stay soft-gated but
  flag `noBackup` when they proceed without one.
- Selecting a release channel no longer marks the app restart-required
  (it installs nothing until Apply).
- Nothing observable changes with the flags off and stable OpenClaw
  installed: the overseer is default-off, team mode is default-off, and
  every beta feature hides behind a fail-closed version gate.

### Security
- The unauthenticated webhook/oauth proxy paths now strip client-supplied
  identity and forwarded-evidence headers before forwarding to the gateway,
  matching the authenticated proxy boundaries (spoofing guard for
  trusted-proxy mode).
- Object-form gateway SecretRefs resolve correctly instead of collapsing to
  the guessable literal `[object Object]` during team-mode migration.
- Overseer inputs (doctor output, log tail) are secret-redacted before the
  Anthropic call and delivered over stdin (not argv), and its tool deny-list
  covers file reads.

### Fixed
- Hot request paths (proxy identity resolution, subprocess spawns, the
  OpenAI-compat bridge) cache config/state reads by mtime instead of
  re-parsing per request.
- The self-restart respawn no longer dies on EPIPE when the parent stdout is
  a pipe (it would silently kill the in-flight update).
- Test reliability: HTTP keep-alive disabled in tests (socket cross-talk was
  the long-standing rotating supertest flake), fork workers capped; the
  codex-migration test skips loudly on unsupported Node runtimes.

## [0.9.34] - 2026-08-26

### Added
- **OpenClaw release channels (stable / beta / dev).** Pick a channel and a
  version from a new **Upgrade** page and switch with one click — including
  building OpenClaw's `main` branch from source the same way its dev channel
  does. Restarts deterministically re-apply your selection offline; nothing
  updates unless you ask.
- **Upgrade page** with the running version and what's in it, the last 5
  stable and beta releases plus recent dev commits, release notes, live
  streamed build progress with automatic reconnect after the restart, and a
  guided channel-switch flow.
- **Automatic rollback.** A new version that crash-loops, exits with a config
  error, or stays degraded in its first 24 hours is blocklisted and rolled
  back to your last known good version (or the built-in pin) — with an
  incident card explaining what happened and a "Mark as good now" escape
  hatch that disarms the window.
- **Safety rails around switching:** verified backup before every switch
  (downgrades and dev builds are blocked if the backup fails), disk/toolchain/
  Node-compatibility preflights, verification of every downloaded or built
  artifact before it can activate, and a locally persisted pin snapshot so
  rollback always has an offline target.
- **Live end-to-end test tiers** (`npm run test:live`, `test:live:dev`) that
  exercise the real npm registry, the real GitHub API, and a real from-source
  OpenClaw build — scheduled in CI to catch upstream drift.

### Changed
- The gateway now runs with `OPENCLAW_NO_AUTO_UPDATE=1`; version changes go
  through the Upgrade page only, and out-of-band changes are detected and
  reverted at the next restart.
- Version activation happens only at boot from a local overlay store, so a
  half-finished download or build can never replace the running install.
- Candidate downloads, build scripts, and verification probes run with an
  isolated HOME and a secret-free environment.

### Fixed
- Version comparisons now rank hotfix suffixes (`2026.7.1-2`) above their
  base release and prereleases (`-beta.N`) below it, consistently across the
  server and the UI.
- An update interrupted by a restart is closed out at the next boot instead
  of leaving the Upgrade page permanently locked on a phantom operation.
- A routine AlphaClaw self-update no longer triggers the "OpenClaw was
  changed outside this dashboard" warning while npm catches up to the new
  pinned version.

### Removed
- Stale `pnpm-lock.yaml` (pinned an old OpenClaw; CI and installs are
  npm-only).

## [0.9.33] - 2026-07-21

### Fixed
- Cron message delivery no longer logs a spurious warning.

## [0.9.32] - 2026-07-21

### Added
- Cron jobs are restored from OpenClaw's SQLite store after a restart.

### Changed
- Test coverage raised from 71% to 99.6% of lines (2,077 tests).

## [0.9.31] - 2026-07-16

### Changed
- OpenClaw pinned to 2026.7.1-2 (hotfix) and the watchdog hardened for the
  OpenClaw 2026.7.1 gateway lifecycle contract.

### Fixed
- Webhook mappings created before OpenClaw 7.1 get IDs backfilled so they
  keep working after the upgrade.

## [0.9.30] - 2026-07-16

### Added
- OpenClaw 2026.7.1 support and GPT-5.6 model support.

### Fixed
- Onboarding writes `ALPHACLAW_ROOT_DIR` into the generated system cron file.
