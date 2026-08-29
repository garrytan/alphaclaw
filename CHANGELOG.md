# Changelog

All notable changes to AlphaClaw are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow this repository's `package.json` release counter.

## [Unreleased]

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
