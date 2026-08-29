# Changelog

All notable changes to AlphaClaw are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow this repository's `package.json` release counter.

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
- **Config write hardening.** `alphaclaw.json` and `.env` writes are now atomic
  (temp+rename) with locked read-modify-write helpers (`updateAlphaclawConfig`,
  `updateEnvFile`), and `alphaclaw.json` is git-synced (README parity).

### Security
- The Agent Administration bearer path is opt-in per call site: it authorizes
  only Express `/api` requests, never WebSocket upgrades (watchdog terminal,
  chat) or the human-only cookie surfaces. It uses a separate rate-limit scope
  from the dashboard login, so agent-bearer failures can never lock an operator
  out. Documented honestly: this is not a security boundary against the agent
  (which already holds these credentials via the gateway env) — it exists for
  audit attribution, revocation, transcript hygiene, and tiered guardrails.

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
