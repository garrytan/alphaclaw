# Changelog

All notable changes to AlphaClaw are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow this repository's `package.json` release counter.

## [Unreleased]

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
