# Changelog

All notable changes to AlphaClaw are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow this repository's `package.json` release counter.

## [0.10.9] - 2026-10-20

The Control UI at `/openclaw` now connects on every hostname an install is
reached by. Before, it rendered but every gateway connect was refused with
"Browser origin not allowed" unless the browser was on the one origin boot
wrote into `gateway.controlUi.allowedOrigins`. That broke Railway and Render
custom domains, a second hostname next to `ALPHACLAW_SETUP_URL`, a VPS reached
by name or IP, and ingresses that rewrite `Host`.

### Fixed

- **Same-origin Control UI connects from any hostname**
  (`resolveGatewayBrowserOrigin` in `lib/server/control-ui-mount.js`). The
  gateway's same-host origin rule can never match behind AlphaClaw, because the
  proxy rewrites `Host` to the gateway's loopback address. When a request's
  `Origin` host equals the host it was sent to (`Host`, or `X-Forwarded-Host`
  from an edge), AlphaClaw now presents the canonical origin boot pinned into
  the allowlist on the WebSocket upgrade and on proxied HTTP. A browser cannot
  forge either header, so this is the same-origin proof the allowlist exists
  for. A cross-origin `Origin` passes through untouched and the gateway's
  allowlist still decides it. The config and the gateway are unchanged.

### Tests

- `tests/live/control-ui-hostnames.e2e.test.js` (live tier, real Chromium and
  real gateway): with one pinned origin, a second hostname and a Host-rewriting
  ingress each reach `hello-ok` and complete a chat turn against a mock
  OpenAI-compatible model. It fails on 0.10.8 with
  `CONTROL_UI_ORIGIN_NOT_ALLOWED`.
- Unit and wiring coverage for the resolver, the WebSocket catch-all and the
  HTTP proxy.

## [0.10.8] - 2026-10-16

Honest boot status: while AlphaClaw boots, the dashboard says which stage the
boot is in, how long it has run, and — only once it has learned — how long a
comparable boot usually takes. Every fixed "usually under a minute" claim is
gone.

### Added

- **Boot timeline** (`lib/server/boot-progress/`): one per process, four
  stages — Preparing, Upgrading OpenClaw data (only when the version-change
  Doctor runs), Starting the gateway, Connecting channels. Every startup step
  maps to exactly one stage and stages never reopen. OpenClaw's
  `startup phase:` trace becomes plain-word detail text; `http.bound` moves the
  boot to Connecting channels. Boot kind: Upgrading OpenClaw (the
  version-change Doctor started) beats Updating AlphaClaw (first boot of this
  AlphaClaw version) beats AlphaClaw is restarting.
- **Terminal outcomes.** Success is verified native readiness (healthy,
  `/readyz` ready, the new gateway's identity confirmed) — never `bootPhase=ready`.
  Failures: boot_failed, config_error, gateway exit / crash loop, failing
  readiness, and the ready budget running out. A user Restart, Retry upgrade or
  repair supersedes the boot; fail-open readiness ends "unverified"; a box
  that is not onboarded gets no timeline.
- **Boot history** (`boot-history.json`, last 20 boots): outcome, completeness, kind
  and OpenClaw version. "Usually about X" needs three successful boots of the
  same kind that reached verified readiness (an OpenClaw upgrade falls back to
  upgrades of any version, still three); failed, aborted, superseded and
  unverified boots never train it. Otherwise the card shows elapsed time only.
- **Boot card** in the Gateway card: the stage list (done / in progress /
  not started), elapsed time against the server clock, "Taking longer than
  usual" past the estimate, a "No output for …" line after two quiet minutes,
  "Ready in X" for ten seconds, and "Last boot stopped at <stage>: …" when the
  Gateway card does not already name the failure. Details (steps, versions,
  Doctor) sit in the supervision details. Stage changes are announced;
  the clock is not.
- **`GET /boot-progress.json`** beside `/health`, ahead of auth (not an `/api` route,
  so not in the agent-admin manifest): a whitelisted public frame — opaque
  bootId, kind label, stage ids/statuses/timestamps, an activity sequence that
  advances only on genuine progress, stalled/stuck verdicts, the estimate. No
  versions, paths, Doctor or trace text, or errors. The boot placeholder
  answers the same path with `{ kind: "preparing", bootId, stuck }`. The agent
  actor's `/api/status` and status stream get the same public shape.
  `/health` adds `boot: { stage, since }` while the boot sequence runs.
- **Reconnect while AlphaClaw restarts**: the dashboard probes
  `/boot-progress.json` while the status feed is down and shows Preparing,
  the stage, "stalled" (no genuine progress within the budget), "stuck" (the
  responder says so), or unreachable. A placeholder → server handoff is one
  boot; more than three fresh boots in ten minutes is "AlphaClaw keeps
  restarting" with logs/diagnose guidance. Host-recovery advice appears only
  for unreachable, stuck or the restart loop.

### Changed

- The boot placeholder shows "AlphaClaw is restarting" (or "AlphaClaw is
  updating" while a self-update installs) with Preparing only, follows the
  light theme (`prefers-color-scheme` and the saved theme), keeps the meta
  refresh for no-JS clients only, and reloads into the app when the real
  server answers `/boot-progress.json`.
- While the boot timeline is live the Gateway card's headline is the boot
  kind in booting/starting, and its reason is the stage; in running the
  headline stays Running and the reason reads "Connecting channels." in place
  of "Up — channels still starting.". Degraded, config_error, down, flapping,
  boot_failed and any user operation keep their own headline and actions.

### Removed

- Fixed duration claims: "Normally under a minute", "usually under 30
  seconds", "(usually under 2 min)" on the overseer card, and "It usually
  takes a few minutes" in the upgrade alert.

## [0.10.7] - 2026-10-16

OpenClaw's data upgrade gets a home on the dashboard: an alert that says
whether the installed pin's `doctor --fix` finished, a way to let it keep a
safety snapshot, and a way to retry it without restarting AlphaClaw.

### Added

- **Upgrade alert** under the Gateway card (with a pointer line in the card,
  a passive banner line and a member view). It shows only while the installed
  pin's upgrade is unfinished (`completedForVersion` differs from the pin), so
  a repair or medic Doctor that fails after a completed upgrade never raises
  it. Rows: didn't finish (Retry upgrade), July-2026 window refusal (the
  bridge-release steps, no Retry), interrupted (Retry upgrade now), and an
  admin-only, dismissible "ran without a safety snapshot" notice keyed on
  (OpenClaw version, failing path, rule). Each failure is one plain sentence;
  OpenClaw's raw text is behind "What OpenClaw said". Members read "An
  administrator needs to finish this upgrade." `GET /api/openclaw/upgrade-status`.
- **Retry upgrade** (`POST /api/openclaw/boot-migration/retry`, admin,
  dangerous tier): the restart pipeline with Doctor between the stop and the
  relaunch. After Doctor it runs the same post-Doctor steps as a boot (native
  maintenance, autotune, exec approvals, usage tracker, webhooks, prompt files,
  env, channel sync, Control UI proxy config), then prepares the launch again.
  The lifecycle lease and the operation record are sized for the boot
  migration's 45 min. The Doctor heartbeat keeps the record alive and says
  when Doctor has been quiet for 2 minutes. A Doctor failure still relaunches
  and is booked as unfinished. The outcome remembers which step failed, so Try
  again opens the Retry upgrade confirm after a stop or Doctor failure, and
  restarts after a launch failure. It refuses with 409 when the gateway is busy
  (no queueing), when the upgrade already completed, for a window refusal,
  and asks for an explicit "Retry anyway" when nothing changed since the
  remembered failure. The progress card, the banner and notifications name the
  upgrade ("Upgrading OpenClaw data · 2m 10s", "OpenClaw data upgraded in
  5m 30s").
- **Snapshot preflight**: a read-only port of OpenClaw 2026.10.4's staging and
  space checks answers "would the next Doctor keep a pre-repair snapshot?"
  (`captureAvailable`, `failingPath`, `failingRule`, `fixable`, free and
  needed bytes). It never changes anything and never blocks Doctor. Shown in
  Backups ("Upgrade safety snapshots") and in Diagnose. A container leg checks
  it against the real Doctor on the #144 layout.
- **Enable snapshots** (`/api/openclaw/snapshots/proposal` and `/enable`,
  admin, dangerous tier): `chmod +t` on exactly the directories the check
  refuses. The confirm names each path, its old and new mode, the size of each
  snapshot and the 30-day retention. The proposal is bound to each directory's
  path, device/inode, owner and mode, and applying it re-checks all of them on
  directories opened with `O_NOFOLLOW`. It applies only when the simulated
  check passes and two snapshots fit, and rolls back through the same handles
  on a failure. Success talks about future Doctor runs only.
- **View Doctor output**: every Doctor run keeps a redacted transcript of its
  last 256 KB in `doctor-last-run.log` (0600), served admin-only from
  `/api/openclaw/doctor-output`.
- Backups now remember the archive OpenClaw verified (path, size, mtime). The
  alert calls a backup "verified" only while that archive is unchanged, says
  whether it predates the upgrade, and labels every other file "verification
  unknown".

## [0.10.6] - 2026-10-16

Fixes #144 (Doctor failing on a symlinked state directory) and pins OpenClaw
**2026.10.4** (npm `latest` since 2026-10-15). Engines and state schemas are
unchanged (`>=24.16.0 <25 || >=26.1.0`; `{ state: 20, agent: 24 }`). The pin
ships with the #144 fix because every pin bump reruns `doctor --fix` on boot,
and on 2026.10.x that Doctor fails on every symlinked install.

### Fixed

- **Doctor and `openclaw config set` on a symlinked state directory (#144).**
  OpenClaw 2026.10's atomic file writer (`@openclaw/fs-safe` 0.24.2, still in
  2026.10.4) refuses a parent directory that is a symlink, so with
  `/data/.openclaw` linked elsewhere every Doctor and CLI config write failed
  with "Atomic replace parent must be a real directory". AlphaClaw now resolves
  only `OPENCLAW_CONFIG_PATH` to the symlink's target (gateway, Doctor, CLI,
  system cron, auth store, operator shells). `OPENCLAW_STATE_DIR` and
  `XDG_CONFIG_HOME` stay lexical so cron partitions do not move; this
  supersedes the `OPENCLAW_CONFIG_PATH` part of #118. A guard test fails CI
  on a new `OPENCLAW_CONFIG_PATH` assignment outside the resolver.
- **A slow gateway boot is no longer an incident.** While the launch's
  replacement is still inside its ready budget and the launched child is
  alive, a failing `/health` is booked as `health_check/ok { startupInProgress }`
  instead of opening `gateway_degraded` (a 41 s database admission opened an
  incident and a rescue session in #144). The ready deadline and child exits
  behave as before.

### Changed

- **Pin: `openclaw` 2026.10.2 → 2026.10.4.** It brings Doctor
  data-preservation fixes (no OAuth-profile deletion on an unreadable legacy
  auth store, no replacement characters in rewritten memory files, plugins
  keep their enabled flag), gateway ownership that survives sleep and clock
  jumps, bounded shutdown waits, manual `/compact` that settles the run instead
  of aborting it, and Tlon group-DM owner checks. The seed table and the live
  database fixture gain rows for 2026.10.3 and 2026.10.4. The CLI, readiness,
  lifecycle and Doctor wording AlphaClaw parses is unchanged between the
  2026.10.2 and 2026.10.4 dists.
- **Every Doctor run is recorded.** The shared streamed runner reads Doctor's
  output as it streams (both streams, split lines, before the 64 KiB tail
  evicts it) and writes `lastOutcome` into `openclaw-boot-migration.json`: status,
  `deterministic`/`transient` class, reason, the redacted failing line, whether
  OpenClaw's pre-repair snapshot was taken and why not, the OpenClaw version,
  the caller (`boot`/`repair`/`medic`) and the duration. The boot report's
  `serverPhase.migration` and diagnose carry the same detail. A Doctor that
  completes for the pin from any caller marks the pin migrated.
- **Deterministic boot Doctor failures are remembered, briefly.** The next
  boot on the same versions, Doctor-relevant config and directory layout
  starts the gateway without rerunning a failure it already saw; any change,
  or 24 hours, retries it. Transient failures are never remembered.
- **Honest notices.** A Doctor that succeeds without OpenClaw's safety
  snapshot says so once, with OpenClaw's reason. The July-2026
  upgrade-window notice no longer suggests running an older OpenClaw against
  the live state; it says to run the bridge release on a restored copy in a
  separate directory and says plainly when that needs a backup that may not
  exist.

## [0.10.5] - 2026-10-12

Pins OpenClaw **2026.10.2** (npm `latest` since 2026-10-12; 2026.9.9 and
2026.10.1 shipped in between). Engines are unchanged
(`>=24.16.0 <25 || >=26.1.0`), so the Node 24.16 floor, the `node:24-slim`
image and the CI matrix stand. The bump comes with an audit of every OpenClaw
contract AlphaClaw encodes (CLI flags and output, config keys, gateway
lifecycle wording, readiness, state schemas, chat protocol, Control UI) against
the 2026.9.8 and 2026.10.2 dists, and the fixes that audit turned up.

### Changed

- **Pin: `openclaw` 2026.9.8 → 2026.10.2.** 2026.10.1 moves the state
  database to schema 20 (`openclaw.schemaVersions { state: 20, agent: 24 }`;
  it adds `cron_run_receipts.delivery_attempt_state`). The seed table and the
  live database fixture gain rows for 2026.9.9, 2026.10.1 and 2026.10.2. Going
  back to 2026.9.x means restoring a verified backup, never reinstall-and-boot.
- **Agent roster written in 2026.10's canonical shape.** 2026.10.1 makes
  `agents.list` and every boolean `agents.entries.*.default` marker blocking
  config errors (`default: false` included). A multi-agent roster must carry
  `agents.ownership: "explicit"`. AlphaClaw stamped `default: true` on every
  agent or channel save, so on 2026.10 each save left a config the gateway
  refuses: exit 78 on the next start, every CLI command refusing, and the
  watchdog looping on Doctor. The write boundary (`canonicalizeAgentsForWrite`)
  now always writes keyed `agents.entries` without markers. `default` is an
  in-memory marker only, derived from `agents.defaults.systemAgent.agentId`
  (then the sole agent, then `main`). A roster that grows past one agent gets
  what OpenClaw's own `agents add` and Doctor's legacy-owner materialization
  write: explicit ownership, the prior agent as system agent, heartbeat and
  Talk owner, and a channel-wide binding for every enabled channel that had
  none. Inherited-auth and session-store owners are pinned where needed, so
  existing channels keep their routing. "Set as default" moves the system
  agent. Deleting an agent clears system-agent, heartbeat and Talk references
  to it, and an agent that owns `authInheritance` or `sessionStore` cannot be
  deleted. A file that still holds a legacy roster keeps it, so the boot
  migration's `doctor --fix` can materialize owners from the marker.
  Supersedes the explicit-fleet-only fix in #127.
- **The gateway launches with `OPENCLAW_DEBUG=1`.** 2026.10 prints only "The
  CLI command failed." when `gateway run` fails; the `Reason:` line that
  2026.9.8 always printed now appears only under `OPENCLAW_DEBUG` or
  `--verbose`. Without it the crash classifier was blind: a fresh owner lease
  left by a replaced container (`GatewayLockNamespaceError`, "cannot verify
  Gateway ownership from this process") read as three unclassified crashes, so
  the watchdog latched `crash_loop` instead of holding the bounded
  `owner_lease_held` wait until the 90 s heartbeat window passed. Only the
  long-running daemon gets the variable; short-lived CLI children keep the
  terse output their parsers expect.
- **Readiness reads the phases 2026.x actually reports.** `/readyz` never
  sends `status`. Startup and drain arrive as `{ready:false,
  failing:["startup-sidecars"]}` and `{ready:false,
  failing:["gateway-draining"]}`, and these now map to the starting and
  draining phases instead of a component-failure degradation on every boot
  and drain. 2026.10.2 reports ready while agent databases are still being
  inspected, so that count is recorded as telemetry.
- **Owner-lease timing follows 2026.10.2:** heartbeat 15 s (was 30 s) and
  stale after 90 s, pinned explicitly.
- **Model prices come from OpenClaw's plugin manifests.** The dist pricing
  scraper matched only `.js` chunks and found nothing on 2026.9.x or 2026.10.x
  (dist is `.mjs`, and prices moved to
  `dist/extensions/*/openclaw.plugin.json` `modelCatalog`). Usage costs now
  read those manifests: 86 priced models on 2026.10.2, including Claude
  Haiku 5.5, Opus/Sonnet 5 and 5.5, and GPT-6. A bare model id that
  aggregators price differently falls back to the static table.
- **Operator shells inherit the supervisor contract.** The `openclaw` wrapper
  exports `OPENCLAW_SUPERVISOR_MODE`, `OPENCLAW_SERVICE_REPAIR_POLICY` and
  `OPENCLAW_NO_AUTO_UPDATE=1` like the gateway child. As a result,
  `openclaw update` from `docker exec` refuses to replace the pinned package.

### Fixed

- **Shared auth store on state schema 20.** The main agent's auth store only
  accepted state schemas 13–19, so on 2026.10.x every credential read reported
  `AUTH_STORE_UNREADABLE` and Codex sign-in returned 500. The live tier caught
  this. The `config_machine_state` layout and the `authProfiles.*` keys are
  unchanged at 20.
- **Cross-container ownership refusal.** 2026.10.2 refuses to verify an owner
  in another PID namespace with a new message: "cannot verify Gateway
  ownership from this process (different PID namespace) …". The bare form went
  to the generic crash ladder, and the "failed to acquire gateway state
  ownership | …" form was misread as a state-writer conflict. Both now
  classify `owner_lease_held`, which waits out or reclaims the lease and
  latches the "second container on the same volume?" notice. That holder pid
  belongs to another namespace, so it is never treated as local. The
  heartbeat-wait line streams as the `lock_wait` restart step, and "OpenClaw
  state database is busy at" counts as state contention.
- **Pairing and approvals through the gateway state owner.** On 2026.10,
  `pairing list|approve` and `approvals get|set` run through the live gateway.
  While it starts or restarts they fail with OpenClaw's "stop the Gateway
  through its service owner" guidance, which is wrong inside AlphaClaw. Those
  refusals are now a retryable 503 ("The gateway is starting or restarting;
  try again in a few seconds."). An unconfirmed mutation is a 409 telling you
  to re-read first, and it is never auto-retried, including by
  `clawCmdWithRetry`. The background pairing sweep no longer runs the CLI
  while the gateway is down, where 2026.10 would take offline ownership and
  race a launch.
- **Chat during gateway warm-up.** A gateway refusal marked `retryable: true`
  (2026.10's `UNAVAILABLE` + `retryAfterMs` while agent databases are being
  inspected) classifies as `gateway_busy` (retryable) instead of an unknown
  failure. `chat.history` retries once after the delay, and `chat.send`
  surfaces `notSubmitted` so the outbox resends with the same idempotency key.
- **ClickClack setup URLs.** AlphaClaw passed `--url`, which no OpenClaw
  release accepts. `--code` takes a code or a URL on 2026.9.8 and 2026.10.2.
- **WhatsApp setup.** `channels add --channel whatsapp` was given `--token`,
  which OpenClaw rejects. The owner number already persists through
  `WHATSAPP_OWNER_NUMBER` and `allowFrom`.
- **Doctor's context-window card** stopped recommending a provider-level
  `contextWindow`. 2026.10.2 rejects that key ("Unrecognized key"), so only
  per-model values count, and a provider-level value gets its own P1 evidence
  line telling you to move it onto each model or run `openclaw doctor --fix`.
- **Boot-migration failure notice** quotes OpenClaw's first failing check.
  When 2026.10.2 refuses state that predates its July 2026 upgrade window, the
  notice says to boot an AlphaClaw release pinned to OpenClaw 2026.9.5 first.
- **Schema dist scan** accepts `.mjs` chunks.

### Tests

- New live test `openclaw-live-agents-roster.e2e.test.js` runs AlphaClaw's
  agent create, set-default, update and delete, plus a save after the pinned
  `doctor --fix`, through `openclaw config validate --json`. It fails on
  v0.10.4.
- The live memory-leak fixture leaks every 100 ms instead of every 250 ms.
  2026.10.2 grows RSS at the nominal ~5.6 MB/s, which cannot reach the
  gateway's unchanged 3 GiB critical threshold inside the stage budget.
  Assertions are unchanged.

## [0.10.4] - 2026-10-12

Issue #140, part 2 of 2: the dashboard surfaces move onto the 0.10.3 git-sync
engine, and the scheduled sync stops landing on the minute every other cron
job uses.

### Changed

- **Offset sync schedule** (`lib/cli/system-cron.js`): new installs and
  every schedule default use a per-install minute derived from a sha256 of
  the repo and the managed path (1–59, never a quarter hour), so two installs
  on one box spread out and none of them collides with `:00` jobs. The minute
  is computed on every read, so nothing is stored. The General tab offers
  `Every 30 min`, `Hourly` and `Daily` presets labelled with the real minute
  (for example `Hourly · :49`). A stored schedule is never rewritten: a legacy
  `:00` preset or a custom expression stays selected, labelled
  `Hourly · :00` or `Custom · <expr>`.
- **Last-run status on the General tab**: the sync-cron status (part of the
  status snapshot) adds `scheduleLabel`, `offsetMinute`, `presets` and
  `lastRun`, a redacted summary of `.alphaclaw/git-sync-status.json` (code,
  headline, times, failure count, how many files are behind GitHub; never the
  detail text or owner pids, because the agent can read the snapshot). The
  repo card shows "Last synced 5 minutes ago · abc1234", a warning when a
  pushed run left local files behind GitHub, or a red line such as "Git sync
  blocked by an unfinished rebase or merge since 3 hours ago (3 runs).
  Workspace changes are not being backed up."
- **Sync button runs the engine**: `POST /api/browse/git-sync` no longer runs
  its own `add -A` / commit / push in the live tree. It runs `alphaclaw
  git-sync --json --trigger manual` (`lib/server/git-sync-runner.js`: argv
  form, this package's bin under the server's Node, 30 s SIGKILL backstop
  over the CLI's 25 s deadline), so it shares the writer lock, scoped
  commits, merge-tree integration and status file. It answers 200 for
  `ok`/`warning`, 400 when sync is not configured, 409 with the engine's next
  step for a refusal and 500 for other failures. A busy writer lock shows
  "Another git writer is busy. Try again in a minute."
- **Settings routes back up through the same runner**: models, Telegram and
  webhook saves call it with `--trigger caller` (models still scoped to
  `openclaw.json`) instead of `shellCmd`/`execFileCmd` strings against
  `alphaclaw` on `PATH`. `syncWarning` is now the engine's sentence ("Backup
  push deferred: another git writer was busy…" for a busy lock or a spent
  deadline) instead of raw `Command failed: …` stderr, and the toasts read
  "Saved. <sentence>".
- **`alphaclaw git-sync --json`** prints exactly one
  `{"gitSync":{outcome,code,message,action,shortHash,committed,pushed,integration,paths}}`
  line on stdout and moves every log line to stderr. Usage errors report code
  `usage` (exit 2).
- Agent docs: the `browse.git-sync` manifest title and the admin skill's
  browse fragment describe the engine-backed sync.

## [0.10.3] - 2026-10-12

Issue #140: `alphaclaw git-sync` cooperates with the other writers on the box
(agents, cron scripts, hooks, a second clone) instead of rebasing their work
in the live tree and refusing in silence.

### Changed

- **Shared writer lock** (`lib/cli/git-writer-lock.js`): every sync holds an
  exclusive flock on the fixed `<git common dir>/alphaclaw-writer.lock` from
  preflight to the final fast-forward, on a close-on-exec fd Node owns (git
  children and hooks never inherit it). Wait budget 120 s scheduled / 15 s
  otherwise (`--lock-wait`, `ALPHACLAW_GIT_LOCK_TIMEOUT_SECONDS`); a timeout
  exits 75 and names the holder from the `.holder` sidecar. Nesting is
  `ALPHACLAW_GIT_LOCK_FD`, trusted only when the fd's dev+inode is the lock
  file; git children get `ALPHACLAW_GIT_LOCK_HELD` so hooks can skip
  re-locking. The fd key is deployment-only (ignored from `.env`). No usable
  `flock`: the sync runs unlocked, says so, and Doctor shows a card.
- **No pull, rebase, stash or `add -A`** (`lib/cli/git-sync.js`). The sync
  commits only paths with working-tree changes (`add -N` for new files, one
  `commit --only --pathspec-from-file`, literal pathspecs), so another
  writer's staged-only entries stay staged. It then fetches with an explicit
  refspec and pins `L=HEAD`, `R=origin/<branch>` once: push `L` when it
  contains `R`; when diverged, `merge-tree --write-tree` + `commit-tree -p L
  -p R` and push that (`sync: merge origin/<branch> (AlphaClaw)`); retry up
  to 3 times when the remote moves; then `merge --ff-only` the live tree. A
  conflict refuses with nothing pushed and no in-tree state; a dirty file
  that blocks the fast-forward is a `live_tree_behind` warning after a
  successful push. Lock-file contention (`index.lock` & co.) retries with
  backoff for 60 s. A detached HEAD refuses instead of syncing to `main`; an
  `ls-remote` auth/network failure is no longer treated as "branch absent";
  origin and the identity are rewritten only when they differ; every git
  child is bounded by the run deadline (600 s scheduled, 25 s otherwise,
  `--deadline-seconds`) and network commands abort stalled transfers.
  Unborn-HEAD adoption still runs before the first commit.
- **Loud refusals**: every run writes `.alphaclaw/git-sync-status.json`
  (0600; codes in `lib/cli/git-sync-codes.js`). The server's
  `git-sync-health.js` turns a failure episode into one notification and a
  `git_sync_refused` watchdog event (immediately for blocked states,
  after 3 runs for lock/push/network failures, after 2 refusals while a
  rebase's own git process is still alive), plus one recovery line. Doctor
  gets episode-scoped `det:git-sync-blocked:<code>:<since>`,
  `det:git-sync-live-tree-behind:<since>` and `det:git-sync-lock-unavailable`
  cards, and the scan env signature includes the sync health. The refusal
  text no longer advises `git rebase --abort` while the rebase's process
  is alive.
- **Hourly script** (`lib/setup/hourly-git-sync.sh`) runs `git-sync --trigger
  scheduled` and no git command of its own: its compare-then-`git restore`
  of `cron/jobs.json` raced the gateway's writes (and cron jobs live in the
  state database since OpenClaw 2026.4.20). It no longer exports the lock
  handoff keys from `.env`.
- **Deployed agent guidance** (`core-prompts/AGENTS.md`): commit only the
  paths you changed, integrate with `pull --ff-only` or a merge, never leave
  a rebase or merge in progress (was "always pull first").

## [0.10.2] - 2026-10-11

The linkage half of bug #137 (0.10.1 was the hotfix). After a failed restart
the box now says what happened next — in the incident, on the record and on
the card — instead of leaving "none recorded", a stale failure sentence and a
banner that had silently cleared itself.

### Changed

- **Banner truth** (`restart-required-state.js`): the down→up heuristic no
  longer clears restart-required reasons while the last operation is a fresh
  (≤ 15 min) unrecovered failed restart. Recovery is the watchdog's verdict:
  at the first identity-clear green probe after a failed restart it calls
  `onRestartFailureRecovered({ operationId, code, by, launchedAt })` and the
  record's new `markRecovered` stamps `recovered { by, at, launchedAt,
  changesLive }`. `by = watchdog_repair` (the watchdog relaunched from the
  current config) or `restart_child` (a `ready_timeout`'s own child came up)
  clears only the snapshotted reasons added at or before that launch — a
  same-code edit made after the spawn still asks for a restart; `unknown`
  clears nothing.
- **Recovered card line**: a failed restart whose gateway came back reads
  "Automatic repair brought the gateway back at HH:MM — your changes are
  live." / "The gateway finished starting at HH:MM — your changes are live."
  or, when the recovery cannot be attributed, "The gateway came back at
  HH:MM, but AlphaClaw cannot tell whether your changes are live — press
  Restart to be sure." (with a Restart button). It replaces the failure
  sentence on reload and when the one-minute retire timer fires; a new
  restart or dismissal retires it.
- **Incident cause** (`watchdog.js`): while a failed restart's note stands,
  every `health_check … failed` / `readiness_degraded … failed` row — the rows
  that open a `gateway_down` / `gateway_readiness` incident — carries `cause:
  restart_<code>` (`restart_stop_failed | restart_launch_failed |
  restart_ready_timeout | restart_aborted`), `by: restart:<operationId>`,
  `corroborated: false`; filing the note also books one
  `restart / restart_failed / failed` row so an already-open incident gets the
  same cause. A corroborated crash cause is never overwritten. The Watchdog
  tab's incident timeline renders "suspected: restart stop failed — not
  corroborated" with the failed phase; `alphaclaw diagnose` shows
  `cause: restart_stop_failed, corroborated false` instead of "none recorded".
- **Doctor heartbeat** (`doctor-fix-runner.js`): while `doctor --fix` runs,
  one line every 30 s — `[alphaclaw] doctor heartbeat elapsed=<s>s
  sinceOutput=<s>s last="<redacted last line>"` — so a hung Doctor is
  distinguishable from a slow one; a failed or timed-out run's result carries
  `lastOutputAgeMs` / `lastOutputLine`.
- **Record timeline**: every streamed step lands on the operation record as
  `timeline[] { at, step, status, detail? }` (≤ 32 entries + `timelineOmitted`,
  details limited to phase/how/reason/signal/graceSeconds/status). Admin
  sessions only (stripped for members and the agent actor). `alphaclaw
  diagnose` renders it with offsets ("+0.5s stopping running (phase=asking
  status=skipped reason=no_lsof)") and falls back to the 0.10.1 `phaseAt`
  view ("timeline: not recorded" on older records); the Watchdog tab's
  Restart evidence disclosure lists it.

## [0.10.1] - 2026-10-11

Restart told the truth about the wrong thing (bug #137). A manual Restart
ended in `stop_failed` — "Couldn't stop the old gateway" — while the gateway
was already down, and nothing brought it back for eight minutes. Verified on
the box and against the pinned OpenClaw: the graceful ask (`gateway restart
--wait`) fails in milliseconds inside the image because OpenClaw's restart
CLI locates the gateway with `lsof`, which the `node:24-slim` image does not
ship; the SIGKILL of the process group then left a **zombie** gateway pid
whose parent had not reaped it, `process.kill(pid, 0)` kept answering
"alive", and the ladder reported survivors that had in fact exited; the
route closed the record and handed the watchdog nothing, so the only path
to Doctor was three 120 s health misses.

### Fixed

- **Zombie-aware liveness** (`gateway-identity.js` `resolveProcessVerdict`,
  `openclaw-lock-contention.js`): a pid is `gone` when `/proc/<pid>/stat` says
  `Z`/`X` with no live thread, `alive` when it runs, `unknown` when `/proc`
  cannot be read — never a bare `kill(pid, 0)`. `unknown` is never counted as
  gone and is never signalled per pid; a stop that ends with only `unknown`
  verdicts is reported as unverified, not as survivors.
- **Honest ask** (`gateway.js`): the graceful `openclaw gateway restart
  --wait 30000ms` runs only when it can work; otherwise it is skipped with one
  logged reason (`no_lsof | no_respawn_pinned | no_worker | no_budget |
  caller_disabled`) and its fix, and the ladder goes straight to SIGTERM.
  `ALPHACLAW_GATEWAY_STOP_ASK=0` disables the ask (deployment env).
- **lsof for the ask** (`lib/server/lsof-shim/`, Dockerfile): the image now
  installs `lsof`; where it is missing, a `/proc`-backed shim that answers
  exactly the `-nP -iTCP:<port> -sTCP:LISTEN -Fpc` query OpenClaw's restart
  CLI makes is appended to the ask's PATH (never the gateway's).
  `ALPHACLAW_LSOF_SHIM=0` disables it. A pin-contract test fails CI when the
  pinned OpenClaw changes the query.
- **Kill-set evidence**: the ladder inventories the process group before it
  signals it (`gateway | helper | other`), signals the whole group as before,
  and records what died and what was left (`stopEvidence`: identity, observed
  exits, still-running non-OpenClaw processes, survivors with verdicts). The
  user sentence names a COUNT ("2 gateway processes did not exit after
  SIGKILL…"); pids, states and commands live in the evidence, served to admin
  sessions only (stripped for members and the agent actor) behind the Watchdog
  tab's **Restart evidence** disclosure, now in plain language.
- **Failure → watchdog handoff** (`routes/system.js`, `watchdog.js`): a
  failed restart files one `noteRestartFailure` after the lifecycle lock is
  released; while the note stands and the port is proven down, the watchdog
  rechecks at 0/5/15/30/60 s with repair allowed and bypasses the
  three-miss sustained-failure gate. The card's failure line ends with what
  recovery WILL do ("Automatic recovery is checking now." / "…is paused —
  press Resume repair once…" / "…is off — press Repair…"), streamed as a
  `recovery` event before the terminal error. A new user restart supersedes
  the note; the watchdog's own planned restarts carry it so the recovery can
  be attributed.
- **Copy matrix**: no failure sentence tells the operator to restart the
  container. `stop_refused` → "Couldn't safely identify the running gateway,
  so nothing was stopped…"; `stop_failed` → "Couldn't confirm the old gateway
  stopped, so your changes are not live yet." (or the count sentence);
  success qualifies a forced stop ("forced; 2 other processes exited").
- **One log grammar**: every ladder event is `[alphaclaw] restart op=<8>
  <event> key=value …` (`identity`, `asking`, `stopping`, `forcing`,
  `stopped`, `stop_refused`, `stop_failed`, `launch`, `launch_failed`,
  `ready_timeout`, `ready`), strings redacted.
- **`alphaclaw diagnose`**: the Restart operation section renders the phase
  timeline and the bounded stop evidence; a new **Gateway identity** section
  shows what the last restart recorded, who holds the port in `/proc` right
  now, and which `lsof` the ask would use.

## [0.10.0] - 2026-10-07

Gateway restart, rebuilt. Every restart while the agent had work in flight
failed the same way on OpenClaw 2026.9.8 — and then the card buried the
operator in evidence about it. Root cause (verified against the pinned
binary with AlphaClaw's real child env): OpenClaw drains a SIGTERMed gateway
for up to ~315 s while the port stays open; AlphaClaw waited 15 s; both CLI
verbs the pipeline leaned on are refused on an AlphaClaw box (`gateway stop
--force` under `OPENCLAW_SUPERVISOR_MODE=external`, `gateway --force` with
exit 78 while the old gateway still owns the state directory); and the
managed child AlphaClaw signalled was OpenClaw's compile-cache launcher, not
the gateway — a SIGKILL of it orphaned the worker on the port.

### Changed

- **One stop ladder, one launch, one proof** (`lib/server/gateway.js`,
  `gateway-identity.js`, `gateway-readiness.js`). A restart prepares first
  (prelaunch hook + plugin preflight while the old gateway serves), resolves
  the gateway's identity from `/proc` (managed tree → serving tree → port
  listener; a foreign or ambiguous listener is `stop_refused` and nothing is
  signalled), then escalates: ask OpenClaw to restart itself (`gateway
  restart --wait 30000ms` — admission closes, the agent's turn compacts,
  work drains ≤ 30 s, the gateway exits 0), SIGTERM the gateway's process
  group (10 s), SIGKILL it (5 s). Only once every pid is gone does it spawn
  `openclaw gateway run` (detached, managed) and wait on `/readyz` inside
  the ready budget; success requires the listener to be inside the new
  child's tree. Autotune is stamped only at verified ready. Failures are one
  of `stop_refused | stop_failed | launch_failed | ready_timeout | aborted`.
- **`OPENCLAW_NO_RESPAWN` is no longer pinned to `1`** under the external
  supervisor: the gateway's own restart (config write, `gateway restart`,
  SIGUSR2) now exits 0 with a restart-handoff row that the watchdog consumes
  and relaunches with a fresh environment, instead of restarting in-process
  and keeping the old env. The supervisor escape hatch still pins `1`.
- **The managed child's serving pid is the worker**, resolved from `/proc`
  once the gateway listens (`servingPid`/`workerPid`): the memory monitor,
  the restart-handoff consume and exit classification all key on the right
  process. Shutdown runs the same ladder (no ask) inside a 6 s slice of the
  process deadline; `killManagedGatewayChildNow` SIGKILLs the whole group.
- **The gateway card is one button and one line.** Restart (or Start when
  the gateway is down) is one click with no confirmation — the server's
  admission gate is the safety and a refusal renders as "Can't restart right
  now: …". During a restart the button row becomes a single server-timed
  line (checking plugins → asking OpenClaw to finish its current work →
  forcing it, active work may be interrupted → starting OpenClaw → checking
  readiness → Running: restarted in Ns (down for Ms)). On failure: one
  sentence naming which half failed, Try again, View logs. Repair keeps its
  confirmation ("Resume repair once" when automatic repair is paused). The
  failure evidence moved to the Watchdog tab's operation record.
- **Persisted operation record** carries `code`, `hint`, `how`, `budgetMs`
  and `phaseAt{step: epochMs}`; SSE steps carry `at` and structured
  `detail`; the sync endpoint answers `{ code, error, hint, detail }`.
- **Notifications:** one `restart_failed` message per failed restart
  (`restart-failed-<opId>`) with the same sentence the card shows.

### Removed

- `openclaw gateway --force` cold starts, the cold-restart supervisor
  adoption, the pid-diff incumbent verdict (`GatewayIncumbentRestartError`,
  `incumbent_gateway_still_running`, event `restart_incumbent`), the CLI
  `gateway stop` (restart and shutdown) and its `gatewayStopForce`
  capability probe, `runGatewayCmd`, the TCP-only ready wait.