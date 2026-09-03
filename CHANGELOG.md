# Changelog

All notable changes to AlphaClaw are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow this repository's `package.json` release counter.

## [0.9.71] - 2026-09-02

Fixes issue #54 — a beta → stable downgrade refused `409 backup_failed`
after the quiesced pre-update backup lost OpenClaw's SQLite state lease
(`SQLite transaction lock wait failed` → `…lease … was lost`) and nobody was
told — and hardens every upgrade/downgrade and backup/restore flow around it.
Absorbs PR #4 (gateway prelaunch hook) with a real trust boundary. One PR,
per-subsystem commits: state-DB quiet period → notifications → gateway
honesty → backup ladder / offline copy / consented reuse → UI → integration →
live/container tiers + docs.

### Fixed
- **Backup ladder (#54).** Lease loss and raw SQLite busy signatures classify
  as `lock_contention` (one shared pattern with the restart-evidence
  diagnostic, `lib/server/openclaw-lock-contention.js`), a killed CLI as
  `killed`, a CLI that never started as `spawn_error` (terminal, names the
  cause); every classifier branch reads the last 20 output lines instead of
  the final one. The quiesced driver retries lock contention in-quiesce
  (budget-aware, ≤2, 15 s → 30 s, fixed deadline) and, when that is
  exhausted or the CLI was killed, takes an **AlphaClaw offline copy** of the
  still-paused state dir instead of giving up — see Added. Timeouts and
  live-file races relaunch the gateway, wait for it to answer and settle,
  then run the live ladder; the "retrying after a live-file race" label after
  a timeout is gone. Fresh-install waiver of the hard gate now fails closed
  (literally empty state tree only). Attempt wording is honest ("single
  attempt, with the gateway paused" / "after N attempts, M with the gateway
  paused"); `backup: running` is emitted once; a failed relaunch is its own
  `gateway-relaunch: warning` step; every hard-gate refusal names the newest
  surviving archive (age + producer). The contention pattern also matches the
  lease-TIMEOUT/acquire lines whose label is several words (`timed out
  waiting for legacy audit migration lease migration.legacy-audit/…`, the
  real 2026.8.2 / beta wording), not only the mid-run `was lost` form — the
  live #54 reproduction against the real beta caught the gap.
- **Notifications.** Telegram sends no longer die on `Bad Request: can't
  parse entities`: notices stay in the house format and the transport renders
  them to validated HTML (`lib/server/utils/telegram-html.js`), falling back
  to plain text locally and on a parse `400` (counted delivered). Delivery is
  honest: per-target error codes, `terminal` only when every target failed
  deterministically (403 blocked, chat not found for a pairing-store target, parse 400 surviving the
  fallback) → immediate `notification_abandoned` instead of 48 h of retries;
  zero resolvable targets stays transient; partial fan-out raises one
  `notification_partial` event per outbox id; `POST
  /api/watchdog/test-notification` reports real per-channel failures; Slack
  renders `[label](url)` as `<url|label>`. The apply outcome notification is
  always delivered (`apply-accepted-<operationId>`, no longer verbose). One
  shared house-link grammar (`renderHouseLinks`, URLs with balanced
  parentheses) drives both the Telegram and the Slack renderer; bold may
  wrap a code span (`<b>…<code>…</code>…</b>`); Slack labels are `& < >`
  escaped and URLs `| < >` percent-encoded; a Telegram `403` is deterministic
  only for blocked/kicked/deactivated/chat-not-found descriptions (every other
  403 is retried); and outbox-unavailable direct sends arriving during the
  state-DB quiet period are held in memory (max 50) and delivered when the
  barrier lifts (`{ ok: true, held: true, reason: "state_db_quiet" }`), with
  a shutdown mid-hold logging the undelivered count.
- **Gateway stop/restart honesty.** The recovery restart that recorded
  `succeeded` while the CLI refused `openclaw gateway stop` (non-interactive
  guard, 2026.8.2+) is gone: `--force` is passed only when the installed CLI
  advertises it (`gateway stop --help` capability probe — the 2026.7.1-2 pin
  has no such flag), the shutdown stop is unified onto the same helper, and
  a restart succeeds only when the old gateway is proven gone (port observed
  down, or a new pid with every pre-stop pid exited); otherwise the operation
  is recorded failed with `reason: "incumbent_gateway_still_running"`, event
  `restart_incumbent`, an important notification, the restart-required banner
  kept and no autotune stamp. `stopping: warning` when a stop was refused and
  the port never released.
- **Rollback fence** re-stats the referenced archive and says whether it
  still exists, was partial (workspace excluded) or a consented reuse (with
  its age) — the second-stage dialog renders the caveats.
- Consecutive identical failed `health_check` rows inside an expected-restart
  window are deduped (first logged + count).

### Added
- **State-DB quiet period** (`lib/server/state-db-quiet.js`): an awaited
  barrier with an owner token held from confirmed gateway stop to just before
  the relaunch. Status readers serve last-known data, the cron store falls
  back to `jobs.json`, notification flushes are held (never dropped), and
  AlphaClaw's own state-DB writers answer `409 { code: "backup_in_progress"
  }` + `Retry-After: 120`. Expiry aborts the backup rather than silently
  reopening. Kill switch `OPENCLAW_STATE_DB_QUIET=off` (deployment env only).
- **Pre-backup diagnosis** (`backup_diagnosis` event, `record.backup.diagnosis`):
  journal mode, filesystem type, state bytes, live openclaw processes, and a
  prediction from the prior run. A rollback-journal DB over 256 MB (network
  volumes) or a prediction over the remaining pause budget skips the upstream
  attempt and goes straight to the offline copy.
- **AlphaClaw offline copy** (`lib/server/openclaw-backup-offline-copy.js`,
  format in `docs/designs/backup-offline-copy.md`): after exclusivity is
  proven (stop confirmed, quiet barrier held, zero live openclaw processes,
  zero in-process handles, Linux `/proc/*/fd` scan clean) every `*.sqlite`
  is copied with SQLite's online backup API, integrity-checked, archived with
  `tar -I 'gzip -1'` as `openclaw-backup-<ts>-<opId8>.alphaclaw.tar.gz` with
  a manifest that shares upstream's core fields plus `producer:
  "alphaclaw-offline-copy"`, `alphaclawFormatVersion`, `exclusivityEvidence`
  and `diagnosis`. Workspaces ride along below 512 MiB (else `partial:
  true`). Measured: a 526 MB state tree in 19 s. Both producers share
  retention (keep-3), inventory and the fenced-run pin.
- **Usable-backup definition** (WI-6.1): every verified artifact passes
  `gzip -t` + a manifest check → `record.backup.usableCheck: "manifest_ok"`;
  a failing check is a `verify` failure (terminal, quarantined
  `.unverified`). The check judges **coverage**, not per-file listing: a
  state DB counts when an asset names it (the offline copy's per-file
  assets) or when an asset's `sourcePath` is the state dir or an ancestor of
  it, resolved against `manifest.paths.stateDir` — real upstream manifests
  (pin, 2026.8.2, beta) carry exactly ONE `kind: "state"` directory asset,
  and the first container-tier run caught the per-file rule refusing a
  genuine archive and failing the hard gate closed on a false verdict. The
  manifest is read at depth 1 only (`--wildcards --no-wildcards-match-slash
  '*/manifest.json' --occurrence=1`, so a workspace's own `manifest.json` is
  never the one parsed; 9–14 ms on real archives), through a 16 MB tail with
  a compact offline-copy manifest (the 64 KB default truncated it at ≳280
  files), and the parsed object must carry a numeric `schemaVersion` and an
  `assets[]` array.
- **Backup inventory** — `GET /api/openclaw/backups` (5 s cache, tier
  `safe`, never on the status path) and an Upgrade-tab Backups card with
  producer, age, size, provenance and eligibility.
- **Consented backup reuse** (WI-4.5): when the full fresh ladder fails with
  a retryable class on a hard gate, the 409 carries `reusableBackup: {
  file, at, ageMs, sha256, producer }` (newest verified non-partial ≤ 24 h
  archive with nothing applied since, re-verified on an open fd); resending
  with `allowBackupReuse: { sha256 }` (humans only — the agent actor is
  denied) re-runs the full ladder and only then proceeds with that archive,
  recorded as `backup.reused` with its age, announced, event
  `backup_reused`, pinned against pruning while the run is fenced. The
  confirm dialog shows the hard-gate/pause notes on every downgrade and an
  opt-in checkbox that is never pre-checked.
- **Gateway prelaunch hook** (absorbs PR #4): `ALPHACLAW_GATEWAY_PRELAUNCH_HOOK`
  (deployment env only) runs a root-owned, out-of-tree, non-writable
  executable by inode with a minimal env before every gateway launch; any
  refusal or failure aborts the launch fail-closed (`GatewayPrelaunchHookError`,
  event `prelaunch_hook`, important notification). README section.
- **Integration of the gateway seams** (lane I): the shared capabilities
  instance feeds the `--force` probe (`setGatewayCapabilities`), the
  prelaunch-hook outcome reaches the watchdog (`onPrelaunchHook` →
  `degradedReason: "prelaunch_hook_failed"`, `getStatus().prelaunchHook`, a
  `prelaunch_hook` event and a house-format notification), the incumbent
  verdict reaches the system routes' notifier, `applied.operationId` survives
  the store normalizer, the offline copy under `OPENCLAW_STATE_DB_QUIET=off`
  records `quiet: "disabled"` in its evidence (per stage), and state-file
  compatibility tests pin that old channel-state/run files load under the new
  normalizers and new fields load under the old code.
- New watchdog event kinds: `backup_diagnosis`, `backup_quiesce`,
  `backup_contention`, `backup_offline_copy`, `backup_reused`,
  `state_db_quiet`, `notification_partial`, `restart_incumbent`,
  `prelaunch_hook` (and `notification_abandoned` now fires immediately for
  terminal failures).
- **Live tier** (real npm installs of 2026.7.1-2 / 2026.8.2 / 2026.9.1-beta.1,
  cached per version): the #54 reproduction against the real beta with a
  held `BEGIN IMMEDIATE` (retry-succeeds and offline-copy paths), the same
  shape under the pin (no lease — finishes under the lock), the
  `gateway stop --help` `--force` contract across the three lines, the real
  beta → 2026.8.2 downgrade through the hard gate to activation and a healthy
  gateway (plus the reverse `incompatible` preflight block), the 12-cell
  restore drill (producer × journal mode × target: extract, place assets per
  manifest, target preflight, `integrity_check`, `gateway run` to `/healthz`)
  with a 500 MB offline-copy calibration, and the offline-copy manifest
  contract vs upstream. **Container tier:** a SQLite-contention holder
  during the quiesce window plus `tar`/`gzip` presence in the image — run
  for real on the sandbox's own dockerd (14/14 in 222 s on the final code paths: image build, rescue toolchain, stable
  boot, hard gate armed, browser-driven stable→beta apply through quiesce →
  backup → usable check → install, orchestrator restart, durability legs);
  only `tests/live/autotune-container.e2e.test.js` needs a host whose docker
  cgroup is not in threaded mode (memory-limited containers).
- **Live-tier disk hygiene** (from the 2026-09-02 incident: 46 GB of `/tmp`
  debris in one afternoon, `alphaclaw-live-downgrade-*` alone 21 GB over 15
  runs, `/` at 100 %, 12 files red with ENOSPC). Root cause: vitest 4's
  forks pool ends a worker with SIGTERM, which never emits `exit`, so the
  helpers' exit-time sweep had never run — every live run leaked its whole
  temp set, not only interrupted ones. `tests/live/live-helpers.js` now
  sweeps every tracked root in an `afterAll` it registers on each live file
  (plus best-effort SIGTERM/SIGINT/SIGHUP and `exit` sweeps), real installs
  go through `stageTempInstall` (the `openclaw-prepare-*` dir is tracked the
  moment npm starts) with `staged.cleanup()` in `finally` blocks, the
  per-version install cache moved out of the sweep namespace to
  `$TMPDIR/alphaclaw-openclaw-cache/<version>` (env override unchanged), and
  the heavy suites call `assertFreeDiskBytes()` (4 GiB; 8 GiB for the dev
  build) to fail fast with the sweep instruction (`rm -rf
  /tmp/alphaclaw-live-* /tmp/openclaw-prepare-*`, check `df -h /`) instead
  of dying mid-run.
- Docs: `docs/upgrade-troubleshooting.md` gains "Backup blocked by
  state-database contention", "Restoring a backup" (the runbook the UI links
  to), "Reusing a recent backup (consent)", "Restart did not take effect
  (incumbent gateway)" and "Gateway prelaunch hook"; AGENTS.md invariants
  for the ladder, the quiet period, stop/restart honesty and the hook
  boundary; the Telegram notice rule now says "author the house format, the
  transport renders HTML" (one link grammar for Telegram and Slack, bold over
  code spans); the `test:live` note carries the Node-22-first, sweep,
  cache-dir and cgroup facts.

### Fixed — final cross-model review round (gstack `/review`: 16 Claude finders + red team + per-finding refuters, and Codex adversarial passes over every scope)

- **Dev channel: the updater's report is read by shape.** A real from-source dev build ended `build:warning` "updater output was not parseable" on every run: the runner's combined tail carries the doctor's stderr ahead of the updater's `--json` report, and the doctor's hint `openclaw config set commands.ownerAllowFrom '["telegram:123456789"]'` is a valid JSON array, so a first-JSON-value parse returned it and `status` read as unknown. The parse now scans for the object that carries a string `status` (live-verified: two red runs, then `build:completed` on the real build). The regression fixture carries the pinned CLI's verbatim stderr lines.
- **Prelaunch hook boundary tightened.** The hook's `PATH` is a fixed system path (sudo `secure_path` style — a writable directory on the inherited `PATH` would let a planted interpreter run under `#!/usr/bin/env …` on every launch); the in-tree exclusion canonicalizes the AlphaClaw root and state dir too (a symlinked deployment root could hide an in-tree hook); the hook runs in its own process group with a hard deadline (`timeout` + 5 s grace → the whole group is SIGKILLed, so a signal-trapping hook or a descendant holding stdio can no longer hang every launch); its stdout/stderr are redacted before logging.
- **Hook alerts cannot be silenced by their own id.** The `prelaunch-hook-<code>-<site>` outbox id gains an hour bucket: a delivered outbox entry never revives on the same id, so a time-free id would have muted every later independent failure at that site; a boot loop within the hour still collapses to one notice.
- **Shutdown stop fits its budget.** With a cold capability cache the `--force` probe gets a 1.5 s slice and the CLI stop keeps the remainder of the 5 s shutdown budget (probe + stop must fit the 10 s process shutdown deadline, or the old gateway keeps the port for the successor).
- **Restart verdict honours pid-proven replacement.** An external supervisor that swaps the gateway process between two 500 ms port polls never shows a "port down" sample; when every pre-stop pid is gone and a new pid answers, the old gateway is provably gone and the restart is a success, not an incumbent failure.
- **`gatewayStopForce` probe.** A FAILED probe is read as help output only when it really is the `gateway stop` usage text; a crash whose diagnostic merely mentions options/`--help` stays `unknown` (retried) instead of caching `unsupported` for the installed version.
- **Contention regex is lease-only.** The `<scope>/<key>` token must follow the word `lease`, so `timed out waiting for https://…` or `failed to acquire … /tmp/file` never classify as `lock_contention` (which would retry inside the quiesce and make the failure reuse-eligible).
- **Live tiers.** The `openclaw backup` double writes a REAL upstream-layout archive (the product's usable check honestly refused the old plain-text stub with `not in gzip format`); every live spawn env goes through `scrubTestRunnerEnv()` (the pinned CLI prints nothing — not even its `--json` report — when it inherits `VITEST`), pinned by a hermetic convention test.

#### Backup ladder hardening (Codex review B1–B9)
- **Reuse verification binds to the opened inode.** The consented-reuse gate now hands `gzip -t` and the manifest extraction `/proc/<pid>/fd/<fd>` (Linux) so the usable check, the sha256 and the consent digest all describe the same archive; off Linux the path is re-stat'ed against the opened inode and a swap is refused (`changed_during_verify`).
- **Fresh-install waiver is an allowlist.** A state tree waives the hard gate only when it holds nothing but AlphaClaw bookkeeping (`.alphaclaw`, `logs`, `backups`, `tmp`, the `.env` link), an absent/empty/`{}` `openclaw.json`, and empty directories. Credentials, identity, legacy `auth-profiles.json`, cron/pairing files, symlinks or any unknown file now defeat the waiver — at the backup gate and at the db-preflight blind spot.
- **Offline copy: symlinked core assets are never silently absent.** A symlinked `openclaw.json` is followed when it resolves to a regular file (config-map mounts); a symlinked `credentials/`, `identity/`, `state/`, `agents/*/agent` or `*.sqlite` makes the copy `partial: true` with the reason (`partialReasons`), and `manifest.paths.configPath`/`oauthDir` reflect what is actually in the archive.
- **Offline copy honours its deadline inside SQLite.** `backup()` is raced against the remaining budget (stage `budget`) and the quiet barrier is re-checked between backup steps (stage `quiet_lost`); the walk yields to the event loop and re-checks the budget every 500 entries (stage `budget` during `enumerate`).
- **Manifest ceiling shared by producer and verifier.** The copy refuses (stage `manifest`) rather than write a manifest larger than the 16 MiB the usable check can read back (15 MiB producer limit).
- **Archive permissions.** The backups directory is repaired to `0700`, the offline copy's archive is `0600` before it is published, and the upstream CLI's archive is tightened to `0600` after it verifies.
- **Handle counter fails closed.** A state-DB handle whose native `close()` keeps throwing while the connection stays open remains counted (retry once, then `isOpen`), so the offline copy refuses honestly instead of seeing a false "exclusive"; a closed-underneath connection releases.
- **Reuse window bounded on both sides.** Future-dated backup records (beyond a 5-minute clock-skew tolerance) are never offered for reuse and show as `future_dated` in the backup inventory.

#### State-DB quiet barrier: never mutate-then-refuse (Codex review R1–R6, R8)
- **Channel delete vs backup barrier.** `deleteChannelAccount` answers a held barrier (409 `backup_in_progress`) before anything mutates, and clears the account's state-db pairing rows LAST — after the `channels remove` CLI, `.env` and `openclaw.json` writes — so a CLI timeout, config-write failure or ENOSPC can no longer leave the account and token intact while permanently deleting its authorized users. A barrier that begins mid-delete is never re-thrown against an already-mutated config: the clear is deferred to the barrier's release (bounded retries, `SECURITY:` log) and the service returns `{ ok: true, pairingRowsCleanupDeferred: true }`.
- **Model config vs backup barrier.** `PUT /api/models/config` refuses at entry and orders every quiet-gated store write before the `openclaw.json` model write — it can no longer rewrite the config and then answer 409.
- **Rollback fence re-verification.** The "restore the verified pre-update backup first" fence now `lstat`s the recorded archive (a symlink swapped onto the path is never the verified backup), requires containment in the backups directory and the inventory's own vouching (provenance digest / size cross-check, never a hash on the request path), reports why via `backupFileCaveat`, and only ever names a surviving fallback that is on disk, eligible, verified and not partial.
- **Backup inventory freshness.** `GET /api/openclaw/backups?force=1` bypasses the 5 s SWR cache; an apply settling invalidates it, so the Upgrade tab's post-apply refresh (and any reuse consent) binds to the current archive.
- **Restart lock vs notification.** The incumbent-restart notification no longer runs under the gateway lifecycle lock / `restartInFlight`; an outbox-unavailable direct send can't hold a restart hostage.
- **Codex OAuth vs backup barrier.** The callback and manual exchange refuse a held barrier BEFORE consuming the one-use OAuth state (the same URL/paste succeeds after the backup); a barrier that begins after the token exchange retains the redeemed credential and writes it when the barrier lifts — callback `postMessage({ codex: 'success', deferred: true })`, exchange `202 { ok: true, deferred: true, reason: 'backup_in_progress' }` — instead of discarding live tokens behind a 409 the retry could never satisfy.
- **Unavailable ≠ removed.** During a backup `GET /api/models/config`, `GET /api/models/auth` and `GET /api/codex/status` carry an additive `unavailable: true, reason: "backup_in_progress"` marker (existing fields unchanged) so configured credentials render as unavailable, not deleted.
- `state-db-quiet.js`: new `whenStateDbQuietReleased(fn)` one-shot release waiter (fires on release, expiry or a begin rollback, after listeners' `end()`), the primitive the deferred writes above need.

#### Upgrade tab (Codex review R5, R7)
- The "proceed with the most recent verified backup" consent now mirrors the server's reuse gate — only an archive at most 24 h old that postdates the last successful apply/settings migration/update run can be offered; otherwise the toggle is disabled with the honest reason ("No verified backup from the last 24 hours that postdates the last update — if a fresh backup fails, nothing is installed.") instead of promising a fallback the server refuses.
- The backup inventory re-read after an apply settles asks the server to rescan (`GET /api/openclaw/backups?force=1`; servers without the knob ignore it) instead of caching its 5 s SWR copy as fresh for 60 s, and an open hard-gated confirm re-binds its reuse candidate when that re-read lands, so consent always names the archive that is newest now.

#### Follow-ups from the review lanes
- **Channel delete outcome flags reach the client.** `DELETE /api/channels/accounts` now forwards the service result (`gatewayRestartFailed`, `pairingRowsCleanupDeferred`) alongside the authoritative `ok: true`; previously the route dropped it and reported a clean delete even when the gateway restart failed or the pairing-row cleanup was deferred past a backup barrier.
- **Backup reuse window published on the inventory.** `GET /api/openclaw/backups` now carries `reuseWindowStartMs` and `reuseMaxAgeMs`, computed by the same helper the reuse gate uses (`computeReuseWindowStartMs`), so the Upgrade tab's consent model binds to the bounds the server enforces — including run-ledger activations the channel payload never showed. The UI folds the server value in (max with its channel-payload mirror) and falls back to the mirror on older servers.
- **Quiet-period honesty in the models/Codex UI.** While a backup holds the state-DB barrier, the Models tab, Providers tab and onboarding step keep the last-known credentials/Codex status and say "Credential store unavailable during a backup — showing the last known … / nothing to show until it finishes" instead of an empty profile list or "Not connected"; a Codex OAuth completion deferred past the barrier toasts and badges "Connected — saved after the backup finishes" until the store confirms.
- **Partial backup reasons on the Backups card.** Rows render a partial archive's recorded `partialReasons` (workspace exclusion, skipped core symlinks such as credentials) instead of the fixed "workspace files excluded" label; reason-less legacy records keep the old label.

#### Review round 2 — the `/review` workflow's confirmed findings (40 confirmed of 68 deduplicated; 23 refuted by the per-finding refuters)

- **Quiesce leaves only the verdict inside the pause.** A quiesced success now runs only its usable check (gzip -t + manifest) and the 0600 chmod with the gateway stopped; the prune, the advisory sha256 and the run record are published after the state DB resumes, the gateway relaunches and the lifecycle lock releases. A usable check that times out (or fails) in-quiesce is finalized on that same deferred path, so the consented-reuse gate's per-candidate re-verification never again runs against a paused box. Recorder pins fix the order.
- **`PRAGMA integrity_check` off the event loop.** The offline copy's per-DB integrity pass runs in a `node:worker_threads` worker (real `node:sqlite`, read-only on the copy), raced against the remaining offline-copy budget (`budget`) with the quiet checkpoint re-run every 250 ms (`quiet_lost`); a worker that dies without a verdict is an `integrity` failure. `/health`, the 2 s SSE tick, the barrier expiry and the lease keep firing during multi-GB checks on slow volumes.
- **Offline-copy exclusivity: settle before refusing, and name the argv.** The driver re-samples the live `openclaw` process list for up to 5 s (250 ms polls, ≤ a quarter of the copy budget) so AlphaClaw's own transient CLI shell-out no longer turns the last-resort copy into a terminal `offline_copy_refused`; a holder that stays is refused with `pid (cmdline)`. The `/proc/*/fd` holder scan matches state DBs under both the configured and the realpath'd path.
- **Incumbent-restart notification reaches the operator.** The `restart_incumbent` notification called the request-shaped `getBaseUrl()` without a request — a TypeError in production that dropped the notification; the "View logs" link is now resolved from the request and threaded through. The structured `incumbent evidence:` line rides at the very end of the merged evidence tail.
- **Terminal outbox tombstones revive on a fresh same-id enqueue.** A deterministic delivery failure abandons after one attempt; that tombstone no longer silences every later re-enqueue of a stable id forever — a fresh enqueue gets a new attempt (`abandonedTerminal` persisted; one `notification_abandoned` per abandonment). 48 h age-out tombstones and delivered entries stay deduped; old outbox files load unchanged.
- **Quiet-barrier honesty on more edges.** While the pre-update backup holds the state-DB quiet period: pairing approve and device approve/reject refuse with `409 backup_in_progress` + `Retry-After: 120` BEFORE spawning the CLI; every cron mutator (run/enable/disable/prompt/routing) answers the same 409 instead of the CLI's connection error or a false "unknown cron job id" from the `jobs.json` fallback; `POST /api/watchdog/test-notification` answers 409 instead of a false "nothing is configured or paired".
- **Gateway pid evidence is uncapped.** The restart-incumbent verdict's pid snapshot filtered for gateway processes AFTER a 12-entry cap over every openclaw-ish process, so a busy host could hide the swapped-in gateway or a surviving one; the gateway snapshot now filters inside the scan with no cap (`listLiveOpenclawProcesses({ match, limit })`); the human evidence lines keep the cap.
- **Upgrade tab honesty.** The 409 reuse offer keeps the archive's absolute timestamp and derives its "taken … ago" / loss-window strings at render time; "Run repair" clears a leftover reuse offer; a hard-gated confirm opened while the backup list is loading, failed, or `readable:false` says so (with "Retry reading backups") instead of "No eligible backup to reuse"; the Backups card renders `readable:false` as the ERROR state, prints the server's returned page size, and no longer implies only cross-channel updates create a backup. The unreachable "No channels configured" 200-path in the test-notification settings is gone (the server answers 502).
- **Hermetic gateway tests** mock `execFile` by default so no hermetic test boots the real pinned CLI via the managed launch's `gateway stop --help` warm-up; `createSwrCache` moved to `lib/server/utils/swr-cache.js`; one exported `formatAge`; the `.offline-copy-` staging prefix is the producer's export; `parseMountInfoFsType` gains unit pins; a short-circuited refused copy no longer reads "(after 0 attempts)".
- **Telegram `400 chat not found` is final only for a proven chat.** Target provenance (pairing store · `allowFrom` fallback · explicit admin target) now rides through the Telegram send; `400 chat not found` abandons after one attempt only for a pairing-store target (the bot has talked to that chat before), while an `allowFrom` id the bot has never exchanged a message with — Telegram answers the same 400 until the user messages the bot — keeps the 48 h retry ladder, the same human-fixable state the 403 "can't initiate conversation" shape already keeps retryable.
- **Watchdog tab names a hook-aborted launch.** When the prelaunch hook refused or failed the launch, the Watchdog tab shows "Gateway launch aborted by the prelaunch hook" with the code, site and message and the fix (repair or unset the hook, then restart) instead of "Watchdog stopped / monitoring is not running"; the incidents list labels the `prelaunch_hook` event kind.
- **Rollback fence vouches honestly.** Its digest cross-check compared the run record against the inventory's copy of the same record, so a same-size file swapped onto the recorded archive path passed as "verified"; the fence now checks the on-disk size and mtime against what the publish recorded (`content_changed`, `unverifiable_content` when the record has nothing to compare — no hashing on the request path) and its hint says only that the archive is present and unchanged since it was verified, with the restore runbook re-verifying it before use; a partial archive's caveat names the recorded reasons.
- **Offline copy cancels its sqlite `backup()`; a stuck step is named.** A throw from node:sqlite's `progress` hook aborts the job at the next step boundary (closing the source alone does not); on a budget/quiet abort the copy throws into the job, closes the source, unlinks the destination, and only when a step never returns inside 2 s records `orphanedBackup: true` on the failure instead of releasing the barrier over a still-stepping backup silently. The artifact record now persists `partialReasons`, so the inventory and the Backups card name what a partial copy omitted.
- **Fresh-install waiver checks shape, not name.** `.alphaclaw`/`logs`/`backups`/`tmp` must be real directories; `.env` must be the onboarding symlink to `<rootDir>/.env` or a regular file ≤ 4 KB with no `OPENCLAW_*`/TOKEN/SECRET/API_KEY/CREDENTIAL keys.
- **Channel delete reports a failed pairing-row clear** (`pairingRowsCleanupFailed` + `pairingRowsCleanupError`, SECURITY log) instead of a clean delete over still-authorized allow entries. **Archive mode is recorded, never silent:** a refused `chmod` is recorded on the backup (`mode`, `modeError`), warned as a step and notified; the inventory projects `mode`.
- **Codex deferred write has a visible outcome.** `GET /api/codex/status` carries `deferredWrite: { state: pending | saved | failed, reason, at }`; a failure after the barrier lifts notifies the operator, and the UI's "saved after the backup finishes" badge ends honestly (saved clears it, failed shows "Codex connection was not saved — reconnect"; without the field two readable `connected:false` reads end the claim).
- **Backup-reuse consent binds to the digest the operator saw.** When the live backups re-read replaces or removes the archive a CHECKED consent was bound to, the consent is revoked and the dialog says so; an unchanged digest keeps it.
- **Incumbent-restart notification link hardened.** The "View logs" link prefers the configured public URL and otherwise embeds the request-derived base only when it is a plain `http(s)://host[:port]` origin — a spoofed `X-Forwarded-Host` drops the link, never the message.
- **A symlinked prelaunch-hook path is refused before it is resolved.** The configured path is `lstat`ed first and must be canonical (a symlink, or a symlinked path component, is refused with code `symlink`); previously `realpath` resolved the link before the `O_NOFOLLOW` open, so a link the deployed agent could repoint at any root-owned executable passed every later check.
- **A missing backups directory is the empty state, not an error.** The inventory scan folded ENOENT into `readable:false`, and with the Backups card now rendering that as an error every fresh box read "Couldn't read backups" until its first update; a directory that does not exist yet is an empty, readable inventory (EACCES/ENOTDIR stay unreadable). Caught by the browser QA steps added to `tests/browser/upgrade-ui-smoke.sh` (Backups card empty state; the cross-channel confirm's consent toggle present, unchecked and disabled with its reason, cancel starts no apply; Watchdog test-notification honesty).
- **Docs.** Prelaunch hook runbook says `/proc/<pid>/fd/<fd>` (parent pid) with the fixed system `PATH`; the `409 backup_in_progress` contract names every covered write and the mid-flight deferrals; `OPENCLAW_STATE_DB_QUIET` in the README env table; GNU tar documented as a hard requirement (with a TODOS entry for a bsdtar-compatible extraction); version floors corrected to v0.9.71 (the version this PR claims; PR #57 holds v0.9.70).

### Notes
- **Review adjudication:** an adversarial review of the merged server lanes
  (22 agents on the integrated tree) returned 26 findings — 15 confirmed and
  fixed in this entry (manifest depth-1 extraction and tail size, incumbent
  verdict contract, reuse gate outside the quiesce, `deleteChannelAccount`
  ordering under the barrier, usable-check budget floor, upstream-only
  prediction source, `applied.operationId` normalization, shared link
  grammar, bold over code spans, stale `.offline-copy-*` sweep, bounded
  reuse verification, shutdown-probe abortability, tracked auth-store
  readers with `busy_timeout`, hook-outcome-aware `latchConfigError`), 3
  refuted with a cited mechanism, 8 low-confidence items evaluated (the cheap
  ones — Telegram 403 scope, Slack escaping, quiet-held direct sends — fixed;
  the rest recorded in TODOS.md).
- **Compatibility:** run records gain `backup.{quiescedAttempts,
  contentionRetries, offlineCopy, diagnosis, producer, usableCheck,
  exclusivityEvidence, reused}` and `applied.operationId`; old files load
  under the new normalizers. State-DB writes during a backup pause return
  `409 backup_in_progress` — retry after the pause. `--force` on `gateway
  stop` is probed, never assumed. The offline-copy archive is
  AlphaClaw-owned; restore is the same manual runbook as an upstream archive.
- Upstream follow-ups filed from this wave are tracked in TODOS.md ("File
  upstream", item 3: lease `busy_timeout 0` + lease held across the snapshot
  read; rollback-journal self-block) with the AlphaClaw belts to retire once
  fixed.

#### Delta review — final fix round (14 confirmed of 30 deduped, 38 agents; 13 refuted, 3 low-confidence)

- **Offline copy cancels its sqlite `backup()` instead of orphaning it.** node:sqlite has one cancel path — a throw from the `progress` hook aborts the job at that step boundary (verified on Node 22.23) — and the copy swallowed it: a budget/quiet abort left the native job stepping as an orphan that restarted from page 1 on every gateway write after the relaunch, livelocking on the libuv threadpool while holding a state-DB read lock and the unlinked destination's disk. The hook now rethrows the checkpoint's `quiet_lost`/`budget` error into node:sqlite, and once the deadline timer fires every later step throws the same error, so `backup()` rejects and no further step runs; the close/unlink/2 s orphan-settle path and `orphanedBackup: true` remain only for a single step that never returns. Pinned against the real node:sqlite module. (Replaces the earlier "Offline copy names its orphan" premise that the job could not be cancelled.)
- **Consented reuse is never `unverifiable_content`.** The reuse path recorded no `bytes`/`mtimeMs` on its artifact, so the rollback fence classified every reused backup as unverifiable ("do not restore it") and then named the same archive as the survivor. `verifyReuseCandidate` now returns the verified inode's size + mtime and `tryReuseRecentBackup` records them, matching the fresh publish; the fence reports the reused archive present and unchanged, with its loss-window caveat.
- **Our own sessions poll can no longer refuse the offline copy.** `GET /api/agent/sessions` serves the last-known list (or 409 `backup_in_progress` + Retry-After) under the quiet barrier instead of spawning the `sessions` CLI, and the offline copy re-samples the live `openclaw` process list AFTER the state walk, right before the `/proc/*/fd` scan, so a transient child that spawns during the walk is settled rather than refused as a foreign holder.
- **Re-adding a channel account clears its stale pairing rows, and the SECURITY log names a remedy that works.** "Re-run the delete" 404'd (the account was already gone); the log now says re-add-then-delete or the by-hand row delete. `createChannelAccount` clears that provider/account's allow entries and pending requests first — quiet-gated (409 before any mutation) and fail-closed (a table it cannot clear refuses the add) — so a re-added id never inherits a deleted account's authorized users.
- Test pin: prelaunch-hook stdout/stderr is shape-redacted (`***`) before it reaches the platform log.
- **Channel delete is never toasted as clean when it wasn't.** Both delete surfaces (Channels tab, agent bindings section) now read the `DELETE /api/channels/accounts` result through one shared helper (`lib/public/js/lib/channel-delete-outcome.js`): a failed pairing-row clear is an **error** toast that says the deleted account's paired users are STILL authorized, names the reason and the real remedy (re-add the account and delete it again, or clear the rows by hand — a repeat delete would 404); a clear deferred past a backup barrier is a **warning** ("stay authorized until the running backup finishes"); a failed gateway restart is appended to the toast and raises the restart-required banner.
- **Rollback fence dialog names why a present archive must not be restored.** `runRollback` now passes the fence's `backupFileCaveat` into the data-risk model, so a symlinked / content-changed / unverifiable archive renders "is on disk but failed verification — <why> — do not restore it" instead of the "pruned" wording (which is kept for a genuinely missing file).
- **Backups card copy.** The `future_dated` ineligibility reads "not reusable — dated in the future — check the box's clock" instead of the raw enum; the unreadable-backups error no longer suggests the directory "may not exist yet" (a missing directory is an empty inventory server-side) and points at permissions or a stray file at the path.
- **Store-unavailable badges clear on their own.** While `GET /api/models/config` / `GET /api/codex/status` answer `unavailable: true` (state-DB backup barrier), the Models tab, Providers tab and onboarding Codex step arm ONE bounded re-read (`kStoreUnavailableRecheckMs`, 30 s; re-armed only while still unavailable, dropped once readable, cleared on unmount) so "Unavailable during backup" no longer outlives the barrier until the operator acts.
- **The hermetic suite no longer litters `/tmp`.** Hundreds of tests `mkdtemp` under `os.tmpdir()` and many never clean up (a throw before the cleanup, an `afterAll` a SIGTERMed fork never reaches); measured after ~45 full runs on one dev box: 139 770 entries and 7 GB. A Vitest `globalSetup` (`tests/setup-tmpdir.js`) now gives every run a private `TMPDIR` (`alphaclaw-vitest-run-*`) that the forked workers inherit and removes it at teardown, with a fail-closed path guard on the recursive delete; `ALPHACLAW_KEEP_TEST_TMPDIR=1` keeps it for inspection. Verified: the two leakiest files add zero entries to the shared `/tmp`.

## [0.9.69] - 2026-09-02

The incident overseer answers "what is happening?" in any watchdog state. The
card's review button no longer refuses while the gateway is degraded or an
incident is live — it produces a situation report from the current status, the
live incident, the last 30 minutes of log (with the real coverage disclosed),
doctor output, and recent incident history. Advisory only; the deterministic
watchdog stays the only enforcement layer.

### Changed
- **Behavior change:** the Incident overseer card's "Review now" is now
  "Review current situation" and ALWAYS produces a situation report — it no
  longer re-reviews the newest settled incident. Re-review a specific settled
  incident from its row in Incident history ("Review this incident"); the API
  keeps its shape (`POST /api/watchdog/overseer/review` with `incidentId`).
  The manual `not_steady_state` refusal is gone; an open incident requested by
  id refuses with `incident_open` and points at the situation report.
- A situation report never consumes the automatic review floor, so it cannot
  postpone a settled incident's automatic review. The manual 2-minute rate
  limit is stamped when evidence is actually sent — never on a refusal.
- Settled-incident re-reviews can now run while the gateway is degraded or a
  different incident is open; their prompt labels live sections "at review
  time" instead of "post-incident" in that case.
- The rate-limit refusal names the remaining wait ("try again in about 1m").
- Incident-history rollups are enum-validated before riding the overseer's
  trusted prompt tier; `abandonOpenIncidents` ignores overseer audit events
  when back-dating an abandoned incident's terminal timestamp.

### Added
- `GET /api/watchdog/overseer/situation` — the card's 15s poll: `current`
  (latest attempt), `lastVerdict` (most recent completed report, kept even
  when later attempts fail), `nextManualAt`, `inFlight`. Allowlisted
  projection; raw model transcripts never cross the API. Admin-manifest op
  `watchdog.overseer.situation.read` (safe tier).
- `watchdog_meta` table (additive, created at boot) holding the situation
  slot; `lib/server/overseer-situation-slot.js` (stale `pending` self-heals
  unconditionally at boot and after 10 minutes on read).
- `overseer_review` watchdog events: every manual review attempt that reached
  the reviewer (refusals included, one row per reason per 2-minute window)
  leaves an append-only audit row (verdict or refusal reason, mode, duration),
  stamped on the live incident a situation report looked at or the incident
  re-reviewed — never on an unrelated active incident. The Events tab labels
  them "Overseer review" with the verdict as the detail.
- `POST /api/watchdog/overseer/review` returns `mode`, `record`, `persisted`;
  a report that ran but could not be saved is still returned (200 with a
  `warning: { code: "persist_failed", message }` envelope). Rate-limit refusals
  (429) carry a `Retry-After` header.
- `readLogTailInfo` in the log writer reports whether the byte tail was cut at
  the front; situation reports disclose real log coverage ("covers
  08:04–08:21, 412 lines (tail did not reach the window start)").
- Card: scope line under the button, evidence provenance line, a "situation
  changed since this report" delta line (verdict badge turns neutral, CTAs
  hide), inline status line instead of error toasts, elapsed time while a
  report runs, a rate-limit countdown, kind label, and a one-click swap between
  the situation report and the latest post-incident review.
- `inFlight` on the situation endpoint is a typed object
  (`{ kind: "situation" | "incident" | "automatic", incidentId, startedAt }`,
  `null` when idle). The card shows "Reviewing…" only for a situation report;
  any other holder of the review mutex disables the button with the reason
  ("Automatic review of incident #7 in progress"). The incident-row action
  honors the same mutex and the shared 2-minute rate limit (countdown title).
- Review failures cross the API with their own codes: `spawn_failed` (502) and
  `timed_out` (504) instead of a generic `review_failed` (500).
- Situation-report evidence carries `windowMs` and `logCapped`; the card's
  evidence line discloses the 64k evidence cap ("newest 64k chars").

### Fixed
- Clicking the overseer's review button while the gateway was degraded (the
  moment an operator most wants a read) surfaced "Reviews only run once the
  gateway is healthy with no open incident" instead of a report.
- A model-driven CTA (`action_needed`) is hidden while the watchdog's own
  repair ladder is mid-operation, and a routine `phase` flip no longer marks a
  fresh report as "changed since" (it flips on every retry tick).
- The situation prompt's live-incident block is trimmed whole events at a time
  to fit its cap, so "latest N of M events" is the N the model received; a log
  window cut by the evidence cap says "front cut to the evidence cap" instead
  of "log begins".
- Refusal audit rows dedupe per target (mode + incident), so a refused
  situation report no longer swallows the audit trail of a refused re-review;
  a situation report that crashes still leaves a `failed` audit row.
- The card reports "Connection lost" only for real fetch network errors, not
  for any `TypeError` thrown by client code.
- The situation slot never rebuilds its record over a read that THREW (lock
  contention, I/O): the write is refused, the report stays ephemeral with the
  `persist_failed` warning, and the stored verdict and history survive. A
  corrupt blob is still replaced by the next write. The spawn error string in
  a failed review's summary now passes through the secret scrubber.

## [0.9.68] - 2026-09-01

Reasonable health-check cadence while the gateway is degraded: the retry loop
backs off instead of probing every 5 seconds forever, the watchdog card shows
when the next check lands, and the cadence knobs are documented, clamped, and
deployment-env only.

### Changed
- Degraded health-check retries now back off 5s → 10s → 20s → 30s (cap) instead
  of a flat 5s forever. Sustained degraded episodes cost ~6× fewer `/health`
  probes and `watchdog_events` rows (~100–120/hour instead of ~720). Short blips
  still recover on the same schedule (the first retry is unchanged at 5s), and
  hard down/up detection is unchanged — TCP port transitions still trigger an
  immediate debounced probe (≤2s with a browser open, ≤10s unattended). The
  retry counter resets on real recovery, on expected restarts and relaunches,
  and when a stale timer fires into a non-degraded state; it deliberately
  survives a green-`/health`-but-failing-`/readyz` tick so the most persistent
  wedged state ramps like every other. Bootstrap's bounded 5s loop stays.
- The connected-browser `fast_cadence` 30s probe is suppressed while the
  degraded retry loop is armed or in flight — that loop owns the cadence then.
  Degraded states without the loop (`restarting`, `crash_loop`) keep
  `fast_cadence` as their sub-120s probe.
- `WATCHDOG_CHECK_INTERVAL` and `WATCHDOG_DEGRADED_CHECK_INTERVAL` (previously
  undocumented and unbounded) are now documented, clamped (`30`–`3600` and
  `2`–`120` seconds), and deployment-env only — never honored from the
  agent-writable `.env`. Out-of-range or malformed values warn once at boot and
  clamp or fall back to the default.

### Added
- `WATCHDOG_DEGRADED_CHECK_MAX_INTERVAL` (seconds, default `30`, clamped
  `5`–`120`, never below `WATCHDOG_DEGRADED_CHECK_INTERVAL`): the cap for the
  degraded retry delay. Deployment env only.
- The watchdog card shows a live "Next retry" countdown while degraded (reading
  "probing…" while a retry's probe is in flight), watchdog status
  exposes `degradedRetry: { attempt, nextDelayMs, dueAt, inFlight }`, and failed
  `health_check` / `degraded_retry` incident rows carry the time to the next retry
  ("next retry in 30s") — only when a retry is actually armed, so a gateway that
  is restarting or crash-looping never advertises a retry that will not come.

### Notes
- **Compatibility** for anyone who set the cadence knobs: values below the new
  floors clamp (`WATCHDOG_CHECK_INTERVAL` < 30 becomes 30); a
  `WATCHDOG_DEGRADED_CHECK_INTERVAL` below 30 now ramps toward the cap instead
  of staying flat (≥ 30 behaves as before); and values set only in `.env` stop
  applying — move the var to your platform's environment.

## [0.9.67] - 2026-09-01

Post-incident hardening (2026-09-01 outage): a slow-but-healthy gateway boot no
longer escalates to a rescue session, a failed restart now names its real
blocking cause with persisted evidence (including WHICH live OpenClaw process
holds the state-lifecycle lock), and a broken `openclaw doctor` CLI is a
first-class surfaced state instead of an invisible red herring.

### Added
- `GATEWAY_RESTART_READY_TIMEOUT` (seconds, default 300, clamped 30–480): the
  gateway restart readiness budget, raised from a fixed 120s that a loaded box
  cold-starting 72 plugins legitimately exceeded. The wait still returns the
  instant the gateway answers. One shared operation budget derived from it now
  governs every restart-class lifecycle-lock hold, the restart operation
  record's lifetime (kept alive while queued and between steps), and the
  watchdog's expected-restart suppression windows — so a configured wait can
  never outlive the machinery that protects it.
- Failed restarts persist their evidence: the redacted last lines of the
  gateway's stderr AND stdout are stored on the restart operation record
  (written 0600) and served by `GET /api/restart-status` even after AlphaClaw
  itself restarts, and `errorSummary` now appends the last error-shaped line
  ("… — last gateway error: ERROR another OpenClaw process owns
  state-lifecycle …") instead of only the timeout symptom. Evidence redaction
  gained shape-based token masking (Bearer/JWT/provider keys/DSNs) and
  control-character normalization applied before matching.
- Lock-contention diagnostics (read-only). Verified against the openclaw
  2026.9.1-beta.1 tarball: the state-lifecycle "lock" is an exclusive SQLite
  transaction held by a LIVE process (`BEGIN EXCLUSIVE` on
  `$TMPDIR/openclaw-state-locks-<uid>/<family>.<hash>.lock.sqlite`, released by
  the kernel the instant the holder dies) — so a leftover lock file never
  blocks anyone, and "another OpenClaw process owns state-lifecycle" always
  names a live holder (in the incident: the pre-restart process still shutting
  down). When a restart fails with that refusal, AlphaClaw now appends the
  live openclaw processes (pid + cmdline via /proc, mirroring upstream's own
  owner-status logic) to the persisted evidence, and the boot sequence logs
  any openclaw process already alive before it spawns anything. Nothing is
  ever deleted: removing a held lock file would let a second acquirer take
  the exclusive lock on a fresh inode — two owners of the state database.
- Doctor-CLI availability is now a first-class state: all six doctor call
  sites classify outcomes through one classifier (a CLI that cannot start is
  distinct from "zero findings" and from a timed-out capture), transitions
  emit a single `doctor_probe` watchdog event plus a greppable process.log
  line, and doctor status exposes `openclawDoctorCli`. Medic, watchdog
  overseer, upgrade overseer, and the watchdog's advisory probe now share one
  single-flight collector that returns usable doctor output or null — never
  raw stderr laundered into LLM evidence prompts.
- Channel status APIs expose `pinDiverged` + `appliedVersion`, and the boot
  log prints `running <version> (<channel> channel) over declared pin <pin> —
  expected…` — so `npm ls` reporting the `openclaw` dependency "invalid"
  while a channel apply is active reads as the designed overlay behavior, not
  version drift (foreign tampering detection is unchanged).

### Fixed
- A restart operation's `durationMs`/`downtimeMs` now survive an AlphaClaw
  restart (the reload path silently dropped them; the UI reads both).
- A dead restart supervisor fails the operation within one poll tick — with a
  final readiness probe so a daemonizing supervisor or healthy incumbent
  never false-fails — instead of burning the whole readiness budget.
- The `doctorJsonShape` capability probe was removed (it had zero consumers,
  and its legitimate stable-channel answer was defined as its falsy value, so
  every healthy install re-spawned `openclaw doctor --json` every ~60s —
  ~530 spawns/day observed during the incident). When any capability probe
  sees the CLI-startup-crash signature (or a full pass times out end to end),
  the capabilities layer serves cached answers instead of re-spawning a
  broken CLI.
- Deployment-only env keys are now skipped by BOTH `.env` load paths (the
  boot loader in `bin/alphaclaw.js` previously hardcoded only the two
  gateway-env hatches), and the new restart-budget knob is deployment-only —
  an agent-written `.env` cannot shrink the ready budget.
- `writeFileAtomic` gained an opt-in `mode` (exclusive-create temp file, so
  0600 lands on a fresh inode even over a pre-existing looser file); the
  system-cron writer now uses it instead of a hand-rolled duplicate.

## [0.9.66] - 2026-09-01

The rescue-session link is now revocable: stop kills it everywhere, restart mints a new one.

### Added
- **Rescue-link capability wrapper.** The local rescue session's card, QR
  code, launcher, and 🛟 notification lines now hand out an AlphaClaw-owned
  link — `<your-alphaclaw>/rescue/<256-bit token>` — that 302-redirects to the
  live claude.ai Remote Control URL and uniformly 404s otherwise. Stopping the
  session invalidates every distributed copy; each start mints a fresh token;
  an AlphaClaw restart adopting a still-live session keeps the same link.
  Previously the surfaces repeated the raw claude.ai URL, whose
  environment-form is stable per box — old links in channel history stayed
  usable after stop and came back identical on restart.
- **Rescue-link audit trail.** Each redemption records a watchdog operation
  event (`rescue_link_redeemed`, with client IP + truncated user agent);
  failed lookups record `rescue_link_probe_failed`. Event writes are capped
  (per-IP and globally) so probing can never flood watchdog.db; the caps never
  change the response. Events are incident-neutral by construction.
- Watchdog notifications now suppress link previews on all three chat
  transports — Telegram (`disable_web_page_preview`), Slack
  (`unfurl_links`/`unfurl_media` off), and Discord (`SUPPRESS_EMBEDS`) — so
  platform crawlers no longer follow (and thereby redeem) rescue links.
- When `ALPHACLAW_SETUP_URL` (or an equivalent base-URL variable) is set, the
  rescue link shown on the card and QR code is built from that validated
  public origin rather than from request headers, so a misconfigured reverse
  proxy can never point the link at a foreign host. Without a configured base
  the request origin is still used, as before.
- New shared util `lib/server/utils/timing-safe.js` (hash-both-sides
  `timingSafeEqual` — the canonical semantic from `routes/auth.js`), used by
  the rescue resolver. Migrating the pre-existing comparison sites onto it is
  tracked in TODOS.md.

### Notes
- **Cutover:** links distributed before this upgrade are raw claude.ai URLs —
  stop + start the rescue session once after upgrading to switch to revocable
  links. With no public base URL configured (`ALPHACLAW_SETUP_URL`),
  notification lines keep carrying the raw claude.ai URL (a localhost wrapper
  link would be dead on a phone) plus a config hint.
- One-time link rotation: a session adopted from pre-upgrade state gets a
  fresh token at adoption (the persisted state had none).

## [0.9.65] - 2026-09-01

Drift Doctor now audits your models: outdated bindings, invalid model
codings, wrong context limits, and skills that still steer the agent toward
old models all surface as actionable cards.

### Added
- **Model-drift checks in Drift Doctor.** Every scan now validates the
  workspace's model setup against a curated Anthropic model ontology
  (tiers, lifecycle status, documented context windows and output caps):
  - Agent bindings on deprecated models (e.g. Claude Opus 4.6) get a P1 card
    with a one-click fix prompt naming the newest successor available **on
    the binding's own provider** — never a model your gateway can't run, a
    different provider's credentials, or a catalog row marked unavailable.
    Superseded-but-served models get a gentler P2 nudge once their successor
    is actually installed.
  - Invalid model codings are caught: malformed keys, made-up Anthropic
    versions, models a custom provider no longer declares (checked against
    your own `models.providers` list, even when a stale catalog still carries
    the key). Copy hedges honestly when judging against a cached or bundled
    catalog snapshot.
  - The model catalog's taxonomy is validated (every first-party Anthropic
    model classified exactly once, unambiguous labels, consistent provider
    fields) — a model newer than the ontology surfaces as a finding instead
    of passing silently.
  - Max context sizes are verified: first-party catalog rows are compared
    against the models' documented context windows and output caps, and
    custom `models.providers` entries without a plausible `contextWindow`
    (or provider-level default) are flagged, including explicit implausible
    overrides.
  - Workspace skills whose SKILL.md references old models get per-skill cards
    with replacement guidance, under strict safety bounds (streamed directory
    walk, 8MB read budget, symlink containment, lookalike-token guards) and
    honest truncation/overflow notes.
- Doctor scheduled scans now react to model changes: the environment
  signature includes the agents' model bindings, custom provider definitions,
  and a catalog digest, so editing openclaw.json or refreshing the catalog
  triggers a re-evaluation without waiting for a workspace edit.
- The shared model-catalog cache gained an exec-free `peekCatalog()` view
  (models + source) that the doctor consumes by late DI — scans never spawn
  the CLI and fall back to the bundled catalog when the cache is cold.
- New "model drift" doctor card category with its own UI tone.

### Fixed
- Dismissal semantics for the new cards follow the repo doctrine end to end:
  severity, finding class, and (for skills) the flagged model set live in the
  sourceKey, so dismissing a mild card can never suppress a later severe one.

### Removed
- The CI soak gate (`soak.yml`, added in v0.9.62): PRs no longer stay RED for
  2 hours before merge. Removed by owner decision — merges are gated by tests
  and the container-e2e aggregator alone.

## [0.9.64] - 2026-08-31

Disconnecting a Google account (and Gmail-watch teardown generally) is now
race-safe and can no longer leave a live token or a stray process behind.

### Fixed
- Disconnecting a Google account now stops its Gmail watch first — the local
  push-serve process is shut down and Google is told to stop delivering,
  instead of the account row being deleted out from under a running watcher
  (which used to leave a process holding its port and Google delivering for up
  to 7 days).
- A Gmail-watch teardown or a concurrently completing sign-in can no longer
  clobber each other's state: every Google-account write that spans a
  multi-second operation (disconnect, connect, credential save, watch
  start/stop, serve restart) now happens under a lock against freshly read
  state, closing a window where a just-connected account (and its live token)
  could be silently erased.
- A disconnect whose token export TIMES OUT now keeps the account and reports a
  retryable error, instead of assuming there was no token to revoke and
  removing the account — which could have orphaned a still-live token at Google.

## [0.9.63] - 2026-08-31

The deployed OpenClaw agent no longer inherits AlphaClaw's own secrets.

### Fixed
- `gatewayEnv()` previously spread the entire server environment into every
  OpenClaw child process, so the agent's shell held `SETUP_PASSWORD`, the
  keyring password, platform deploy tokens, and every internal credential —
  which meant Agent Administration's tiers were not a real boundary against a
  compromised agent. The gateway/agent now receives an explicit allowlist:
  the OpenClaw and provider keys it genuinely needs pass through, everything
  else (led by `SETUP_PASSWORD`) is withheld, and an absolute deny list can
  never be overridden. This closes environment inheritance; a same-UID
  read of the on-disk `.env` remains a separate, documented concern.
- If a deployment needs an extra variable to reach the gateway, add it to
  `ALPHACLAW_GATEWAY_ENV_PASSTHROUGH` (deployment environment only). A
  break-glass `ALPHACLAW_GATEWAY_ENV_UNRESTRICTED=1` restores the legacy
  behavior minus the always-denied secrets. Neither can be set from the
  dashboard-written `.env`, so the agent cannot grant itself broader access.
## [0.9.62] - 2026-08-31

### Added
- **Merge gate on `main`** (the CI half; the branch-protection ruleset is
  configured separately): a **version guard** fails any PR whose
  `package.json` version does not strictly advance `main` (kills the
  concurrent-version-claim races that forced unreviewed renumbering), a
  **soak** check that keeps a PR red until its current commit has been open
  ≥2h — measured from a non-forgeable GitHub timestamp, overridable with an
  `expedite` label and auto-re-checked by a 30-min `ripen` job — and a
  **tag-release** workflow that tags `v<version>` on every merge and trips
  loudly on a duplicate-version collision. The container-E2E path filter was
  widened to cover the watchdog/doctor/routes/server-core surfaces the boot
  journey exercises. Contributor release flow updated: versions bump inside
  PRs, so `npm version` is no longer part of publishing.
## [0.9.61] - 2026-08-31

### Changed
- Added a **Merge unification safety** policy to the contributor guide
  (`CLAUDE.md`): check for overlapping in-flight branches before starting,
  never run two branches against one subsystem, merge `main` and reconcile
  file-by-file before landing, claim version numbers at merge time, and
  justify any rewrite of code merged in the last 7 days. Codifies the
  reconciliation discipline that keeps fast-moving parallel work from
  clobbering freshly-merged fixes. Docs/process only — no runtime change.

## [0.9.59] - 2026-08-31

Closes an agent-privilege-escalation hole in the environment editor.

### Fixed
- The Agent Administration tier gate can no longer be bypassed to repoint the
  Claude Code launcher without an operator confirmation. A deployed agent
  could previously smuggle a protected launcher key (e.g.
  `CLAUDE_CODE_ROUTINE_URL`) past the "dangerous" tier by padding it with
  whitespace/newlines or wrapping it as a JSON array — the tier check saw a
  different key than the one actually written to disk. Key classification and
  persistence now use one shared normalizer, and `PUT /api/env` rejects
  malformed or non-string key names outright.

## [0.9.58] - 2026-08-31

The hourly sync schedule can no longer be used to smuggle anything into the
root cron file — and a bad schedule can no longer silently kill the sync job.

### Fixed
- Cron schedule validation is now semantic and shared by all three writers
  of `/etc/cron.d/openclaw-hourly-sync`: exactly five space-separated numeric
  fields within real cron ranges. Previously, separators matched ANY
  whitespace, so a schedule containing newlines could inject environment or
  command lines into the root cron file.
- Charset-legal but invalid schedules (like `99 * * * *`) are rejected too —
  cron rejects the entire file on one bad line, which silently stopped the
  hourly sync while the dashboard reported it installed.
- An invalid schedule stored on disk now falls back to the hourly default
  LOUDLY: a warning is logged and `GET /api/sync-cron` reports
  `scheduleFallback` with the rejected value.
- A cron write the builder refuses now returns an error instead of `ok:true`
  while `/etc/cron.d` silently keeps the old line; at boot, a refused
  configuration removes the managed cron file instead of leaving a stale one.
- The cron file is installed atomically (temp file + rename), so a crash
  mid-write can never leave a truncated root cron file.

### Changed
- Schedules with named days/months (`MON`, `JAN`) or `@aliases` are no longer
  accepted; the built-in UI only ever offered numeric presets. If a stored
  schedule used names, it falls back to hourly and the API says so.

## [0.9.57] - 2026-08-31

Disconnecting a Google account works again — and can no longer strand you
half-disconnected. A v0.9.49 refactor broke every disconnect after the token
was already revoked at Google, leaving the account stuck in the UI.

### Fixed
- Google account disconnect completes again: the account is removed locally
  and `gog auth remove` runs (a variable-scoping regression had made every
  attempt fail after upstream revocation).
- Disconnect is now safely retryable: if Google's revocation endpoint times
  out or errors, the account is kept and the response says
  `retryable: true` with the resolved `accountId`, so a retry targets the
  same account instead of silently falling back to the first one. Only a
  confirmed-dead token (or nothing to revoke) proceeds to removal.
- The refresh token now travels in the revocation request body (never the
  URL), with a 10-second timeout so a stalled Google endpoint can't hang the
  request.
- Disconnect no longer erases accounts connected concurrently while it was
  waiting on Google, and a failed keyring cleanup is surfaced as a warning
  instead of swallowed.
- With multiple Google accounts configured, a disconnect request without an
  `accountId` is now refused instead of guessing the first account (the Setup
  UI always sends one; agents get the exact rule in the admin manifest).

## [0.9.56] - 2026-08-31

One-click OpenClaw dashboards: every path into the Control UI now lands you
signed in automatically — no terminal, no token pasting, no "Auth required"
screen. Verified end-to-end on a real instance (real gateway, real browser
click-through) and encoded as a live e2e suite.

### Added
- **Dashboards opens signed in.** The sidebar Dashboards link (and the
  General tab's "OpenClaw Gateway Dashboard" Open button, the Team tab's
  "Open Control UI", and the Envars "Open Secrets" deep link) now route
  through an authenticated
  server-side launcher (`GET /gateway/launch`) that primes the gateway token
  into the Control UI's URL fragment via an empty-body redirect. The token
  never enters the page's JavaScript, any response body, any log line, or
  any cacheable surface; members and trusted-proxy (team) installs get
  tokenless links and sign in via proxy identity. First visit and every
  visit after lands connected.
- **Doctor warns when dashboard links can't be token-primed.** A new
  deterministic check (`det:dashboard-token-unresolvable`) surfaces the one
  failure the launcher can't fix — no resolvable gateway token in config —
  as a visible warning card instead of a silent fallback to the manual
  connect screen. It never runs the CLI or external secret providers, and
  stays silent in trusted-proxy and password modes where tokenless is
  correct.
- **Live e2e proof of the credential chain.**
  `tests/live/dashboard-launch.e2e.test.js` boots the real server
  supervising a real gateway and proves: authenticated launch → tokened
  302 → the launcher-issued token authenticates a real WebSocket connect
  through the proxy; a wrong token is rejected; an unauthenticated launch
  never sees a token. (Live tier, `OPENCLAW_LIVE_E2E=1`.)

### Changed
- **The Dashboards sidebar item grew up.** Distinct icon (it previously
  shared Usage's), a tooltip ("Opens OpenClaw session dashboards in a new
  tab (signed in automatically)"), a visible-label-first accessible name,
  and the mobile
  drawer now closes when the new tab opens.
- **Token resolution is single-flight, bounded, and mode-aware.** One shared
  resolver serves the launcher, `/api/gateway/dashboard`, and the doctor
  check: concurrent launches share one resolution (at most one CLI spawn),
  a hung external secret provider degrades the launch tokenless within 20s
  instead of hanging the tab (and the next launch retries fresh), and
  trusted-proxy/password modes short-circuit tokenless without ever
  spawning the CLI or resurrecting a stale token into a link.

### Fixed
- **The Envars "Open Secrets" link no longer corrupts the token.** It used
  to splice the settings path inside the URL fragment, landing on a broken
  URL; it now routes through the launcher and lands connected on
  Settings → Secrets.
- **No more false "token missing" warning in team mode.** The General tab's
  toast fired in trusted-proxy installs where tokenless sign-in is the
  success path; entry points now just open connected.

### Security
- Failed `openclaw` CLI runs now scrub token-bearing values by shape, and
  launcher resolution errors by shape and by known-secret value (process
  env, env file, and config literals — with the env file read fail-closed)
  before anything reaches a log line; `GET /api/gateway/dashboard` responses
  are marked `Cache-Control: no-store` so the tokened URL can't sit in a
  browser HTTP cache.

## [0.9.55] - 2026-08-31

The watchdog now sees a memory leak coming instead of explaining the crash
afterward: gateway memory is sampled every minute, a rising trend is called
out hours before the limit, Drift Doctor turns it into a guided fix, and — if
you opt in — the gateway is restarted gracefully before it runs out of memory.

### Added
- **Memory-leak detection (default ON, report-only).** The watchdog samples
  the gateway's memory (RSS) once a minute and confirms a leak with a
  noise-resistant trend test (rising per-window floors + projected time to
  the limit against a co-residency-aware cap). You get one calm notification
  per episode ("memory rising steadily — projected to reach its limit in
  ~3h"), a distinct 🔴 alert if it turns critical, persisted watchdog events
  (`leak_suspected` / `leak_critical` / `leak_cleared` with an episode
  summary), and an honest live trend row on the Watchdog tab's Resources
  card. Disable anytime: Watchdog → Settings → Memory leak detection.
- **Drift Doctor knows about leaks.** A suspected or critical leak surfaces
  as a deterministic finding card (episode-scoped, so dismissing one false
  positive never silences a future real leak) with an "Ask agent to fix"
  runbook: confirm the trend, inspect recently added plugins/config, check
  the logs, and apply machine-specific memory-limit advice that refuses to
  suggest a raise when the container is already at its limit. A recent
  episode stays visible as evidence even after a restart replaced the
  process, and leak onset counts as an environment change for scheduled
  scans.
- **Pre-OOM auto-restart (strictly opt-in, default OFF).** When a confirmed
  leak turns critical, the watchdog can restart the gateway gracefully before
  the crash — through the same lifecycle lock and interlocks as a manual
  restart (never mid-channel-apply, never over a reconciler hold), never
  during an update's stabilization window, only on a tick with a fresh
  memory reading, capped at 2 restarts per 24 hours at least 6 hours apart
  (the brake survives AlphaClaw restarts; a failed restart attempt refunds
  that budget instead of burning it), and never counted as a crash. The
  deployed agent cannot arm this switch for itself: any agent-admin write
  that would turn effective auto-restart on requires an operator confirm.
- **Leak context reaches the AI diagnosis surfaces.** Incident post-mortems
  carry the close-time memory trend (episode evidence only when it actually
  correlates with the incident), and the numeric machine summary the gateway
  medic and upgrade overseer read now includes the RSS trend — numbers and
  closed enums only.

### Fixed
- **The Resources card's "Gateway" memory segment now counts the whole
  gateway process tree.** On OpenClaw 2026.9.1-beta.1, `gateway run` can fork
  a worker child that holds the real heap while the launcher stays ~50MB — a
  launcher-only read showed a tiny, flat number while the real gateway (and
  any leak in it) lived in the worker. Both the card and the leak monitor now
  read the subtree (`getProcessTreeUsage`, one bounded `/proc` pass).
- `getProcessUsage` (per-pid RSS) is now exported from
  `lib/server/system-resources.js` — the memory monitor's default sampler
  depends on it (caught by the new real-process leak e2e).
- **Toggling memory settings can never destroy a corrupt config.** If
  alphaclaw.json exists but cannot be parsed, `PUT /api/watchdog/memory`
  now refuses with 409 `config_unreadable` instead of silently rebuilding
  the entire file from defaults (which would have erased every unrelated
  setting). The deployed agent also cannot arm auto-restart through
  concurrent split writes — the `autoRestart: true` field itself now always
  requires an operator confirm.
- **Memory-limit advice is honest about what it can fix.** The critical
  alert and the Drift Doctor runbook embed the "raise the gateway heap"
  command only when the pressure is actually against the heap cap; pressure
  against the container limit gets "raising the heap will not help" guidance
  instead.

## [0.9.54] - 2026-08-31

Notifications grow a volume dial and lose their blind spots: a new Verbose
toggle keeps chat quiet without hiding real problems, the gateway finally
says when it goes DOWN (not just when it comes back), and every automatic
fix AlphaClaw performs — config migrations, autotune rewrites, stray-file
repairs, auth restores — now announces itself. The master Notifications
toggle becomes truthful: off now means off for everything, with the agent
audit trail as the one deliberate exception.

### Added

- **Verbose notification toggle (default on).** A third switch on the
  Watchdog settings card — "Verbose" vs "Important only". Important-only
  mode suppresses informational notices (gateway back online, channels
  resumed, activation verified, update progress, scheduled doctor scans,
  topic-discovery digests, healthy overseer verdicts, config-change retry
  progress, the AlphaClaw update-available notice) while problems,
  failures, and action-taken repairs still arrive. Persisted as
  `WATCHDOG_NOTIFICATIONS_QUIET`; exposed via `GET/PUT
/api/watchdog/settings` (`notificationsVerbose`) and the agent-admin
  manifest; a helper line states the quiet-mode contract.
- **"Gateway went down" alerts.** A single unexpected gateway exit now
  notifies once per incident with exit/signal-aware copy — previously only
  the third crash (crash loop) said anything, so you heard "back online"
  without ever hearing "went offline".
- **Every server-phase auto-fix now notifies:** successful automatic
  settings/database migrations (previously only failures spoke), the
  reconciler's machinery-error gateway hold, autotune's openclaw.json
  concurrency writes and disable-reverts (one composed message per apply;
  container downsizes get an urgent OOM-pressure warning), pin
  re-activation after an interrupted activation, quarantined-config
  recovery, stray legacy exec-approvals repair, team-mode auth
  auto-restore, and config-change gateway retries. Boot-loopable fixes
  carry stable outbox dedupe ids, so a boot loop collapses into one alert
  instead of a storm (user-initiated one-shots such as team-mode enable
  failures are deliberately timestamp-keyed: each attempt is a new event).

### Changed

- **Notifications off now means off.** The master toggle previously gated
  only a handful of alert paths — upgrade failures, migration holds,
  rollbacks and ~30 other sources ignored it. A central delivery policy now
  enforces both toggles at the outbox (enqueue AND delivery time — queued
  alerts are re-checked before they land: master-toggle-off holds them for
  redelivery when you re-enable, within the outbox's 48h window, while
  Important-only drops informational notices for good), with documented
  exceptions: the Test button, agent-admin audit notices, and the boot
  webhook for unbootable boxes.
- **The agent can't silence you quietly.** An agent-admin request touching
  either notification toggle now escalates to a dangerous-tier operator
  confirm, and agent-admin audit notices are exempt from both toggles — a
  semi-trusted agent can never mute the announcement of its own change.
- **Crash-loop alerts name their remediation** ("use Retry (or Repair) from
  the Watchdog tab") using the gateway card's own action vocabulary, and
  exit copy is signal-aware everywhere (`signal SIGKILL` instead of
  `unknown`).

### Fixed

- Suppressed notifications log a `skipped` event row instead of a spurious
  `failed`; suppression log lines carry the event id only, never message
  content.
- Concurrent per-field settings saves can no longer lose each other's
  change (the env write now holds a file lock across the read-modify-write).
- Mixed settings payloads with a mistyped field are rejected instead of
  silently dropping the bad field.
- Autotune's resize notices keep their dedupe ids end-to-end (capacity
  flapping no longer duplicates alerts), and boot/settings retune notices
  ride the durable outbox so they survive restarts.
- A brief notifications-off window can no longer destroy pending alerts:
  flush-time master-toggle suppression holds queued events for redelivery
  instead of dropping them, and a terminally suppressed outbox entry
  revives on a fresh enqueue of the same id — one quiet window used to
  permanently swallow every future re-notify of a stable id. Terminal
  suppressions persist their reason across restarts.
- The team-mode operator-lockout path (auth enable failed AND the auto-
  restore failed) now alerts loudly — it was the one silent branch — and
  exception snippets in alert copy are sanitized (newlines, backticks, and
  links stripped; length capped).
- Config-retry notices key to the latch episode, so an editor autosave
  burst produces one notice instead of one per save, and machinery-hold
  alerts normalize volatile reason fragments (paths, digits) so a boot
  loop can't mint a fresh alert each iteration.

## [0.9.53] - 2026-08-31

The sidebar's Open Claude Code button can now land you in a Claude Code
session running on the box itself. AlphaClaw hosts `claude remote-control`
in a detached tmux session, extracts its Remote Control URL, and prefers
that local rescue path — the cloud routine stays as the fallback — so you
can debug AlphaClaw/OpenClaw from claude.ai/code (or your phone) with hands
on the actual machine. The whole flow was driven live against a real
claude.ai login before landing.

### Added

- **Local rescue session launcher (local-first, routine fallback).** One
  click starts (or rejoins) a Claude Code instance on this box in detached
  tmux and navigates straight to its claude.ai/code session; the session
  survives AlphaClaw restarts. Boxes without a completed local login keep
  firing the cloud routine exactly as before.
- **Guided one-time OAuth login in the web UI.** The Watchdog page walks
  through `claude auth login` — clickable OAuth link, paste-the-code input,
  success verified against `claude auth status` — with credentials kept in
  a dedicated 0700 HOME that backups deliberately exclude (re-run the login
  after restoring a backup).
- **Watchdog rescue-session card.** State badge with Start/Stop/Login/Logout,
  the session URL as a QR code (plain selectable link always beside it), a
  copyable tmux attach hint for shell access, and a sanitized terminal-tail
  viewer for diagnosing failed spawns.
- **Incident auto-spawn.** When the watchdog opens an incident (and the
  login is done), the rescue session warms automatically and the incident
  notification includes its URL when the session is already running.
  Unattended spawns always clamp to `acceptEdits` and skip below a ~500MB
  free-memory floor.
- **Five new env keys** on the Envars page — `CLAUDE_CODE_LOCAL_ENABLED`,
  `CLAUDE_CODE_LOCAL_AUTOSTART`, `CLAUDE_CODE_LOCAL_PERMISSION_MODE`,
  `CLAUDE_CODE_LOCAL_CWD`, `CLAUDE_CODE_LOCAL_SPAWN_ON_INCIDENT` — all
  hot-reloaded, no restart required.
- **Docker image: tmux + pinned Claude Code CLI.** The image now ships tmux
  (so rescue sessions outlive the AlphaClaw process) and an exact-pinned
  `@anthropic-ai/claude-code` install (pinned on purpose: the TUI-parsing
  fixtures are captured against that version and the pin is bumped together
  with a fixture refresh). Without either, the launcher degrades honestly —
  script(1) hosting or the routine fallback.

### Fixed

- **The rescue session now actually reaches "running" on a logged-in box.**
  Live QA with a real claude.ai login caught three gaps the same day:
  `claude remote-control` exits (rather than prompting) on an untrusted
  workspace, so trust is pre-seeded in the rescue HOME before every spawn;
  its "Enable Remote Control? (y/n)" confirmation is answered automatically;
  and the URL it publishes is the environment form
  (`claude.ai/code?environment=…`), which the launcher now parses alongside
  the per-session form. Each screen is pinned as a captured fixture.

### Changed

- **Ship-review hardening across the rescue feature.** The five
  `CLAUDE_CODE_LOCAL_*` keys are agent-protected (an agent env write now
  requires a dangerous-tier operator confirm, matching the routine keys);
  agent-readable status also withholds the session id, not just the URL;
  starting a session verifies the permission mode you confirmed against the
  live config, so a mid-flight mode switch always re-asks; a launch that
  discovers the login is missing mid-wait now falls back to the cloud
  routine instead of timing out; and background probing got cheaper (pauses
  while disabled, under memory pressure, and in hidden browser tabs).

## [0.9.52] - 2026-08-31

Chat no longer eats messages. The Chat tab's session management was rebuilt
end to end for ChatGPT-level reliability: every keystroke survives, Stop means
stop (and says so honestly when it can't), and every stop, interruption, and
ambiguous outcome is recorded visibly in the conversation — across reloads.

### Added

- **Durable send queue.** Typing while the agent is streaming — or while
  disconnected — queues the message visibly ("Queued") and auto-sends when the
  session is free; it never silently vanishes. Queued/failed messages survive
  page reloads (restored as "Not sent — Retry", never auto-sent), failed sends
  get Retry/Discard on the bubble, and a queued message can be cancelled back
  into the draft. Retries are safe by construction: the client message id is
  the idempotency key and the bridge deduplicates, so a retry can never post a
  duplicate turn.
- **Honest stop lifecycle.** Stop shows "Stopping…" until the gateway confirms
  (or an unconfirmed timeout is recorded as such); a failed abort says
  "Couldn't stop — try again" instead of pretending. "You stopped this
  response" appears inline in the transcript and persists across reloads.
- **Interruptions are terminal, visible, and persisted.** A gateway restart or
  crash mid-run ends the stream with an "Interrupted — the agent may have kept
  working" marker (no more streaming-forever UI); a run silent for 5+ minutes
  is closed out honestly and recorded as a watchdog event. Ambiguous outcomes
  (server restarted mid-send) surface as "may have been sent — check the
  transcript" with manual Retry/Discard, and queued messages wait for explicit
  confirmation after an interruption instead of firing into a possibly-live
  run. Backed by a new `chat-runs` store with boot reconciliation.
- **Resilient connection.** Unlimited jittered reconnects with a visible
  "Retry now" after a minute (the old client gave up silently after 8
  attempts and left the composer dead); keepalives on both the browser and
  gateway sockets; a Limited mode against older servers; HTTP fallback keeps
  history readable. New sessions now appear in the sidebar without a reload
  (visibility-paused 30s polling; the sessions endpoint gained a micro-cache
  so N tabs share one OpenClaw CLI spawn).
- **Transcript polish.** History refreshes merge by stable message identity —
  no more full-list blanking/remount after every turn (open tool cards and
  scroll position survive); an assistant reply no longer splits into duplicate
  bubbles around tool calls; id-less tool calls are never lost to name-dedupe;
  "Older messages aren't shown" appears only when older history actually
  exists; Escape stops, a "Jump to latest" pill appears when scrolled up,
  messages have a copy button, and the chat pane finally works on narrow
  viewports with screen-reader-announced streaming.

### Fixed

- A hard-to-hit race could skip "Limited mode" detection against an older
  server when the connection was slow to open — retries there could have
  duplicated a message; detection now arms from the moment the socket opens
  and sends never fire before the protocol level is known.
- A history refresh that failed over the live connection left "Refreshing
  history…" up forever with no way to retry; it now settles with an inline
  Retry.
- Long streams stay smooth: the transcript no longer re-renders every message
  bubble (with a full markdown re-parse) for every streamed token, and
  status colors now use the theme's semantic tokens so warning/error text is
  legible in light mode too (the jump-to-latest pill was unreadable there).
- Stop stays available against older servers; a "Still working…" hint appears
  when a run goes quiet for a couple of minutes; keyboard focus returns to
  the composer after Retry/Discard.
- Adversarial-review hardening (two independent fresh-context passes, Claude +
  Codex, both gated the merge until fixed): a failed send's stored terminal no
  longer blocks its own retry for 10 minutes (retry is now a fresh attempt);
  a stale or timed-out gateway connection attempt can no longer tear down the
  healthy replacement socket (falsely interrupting every live run) or feed
  duplicate events into transcripts; `chat-runs.db` is bounded by a global row
  cap with runtime pruning (unique session keys could previously grow it until
  disk exhaustion); a delayed Stop naming an already-finished run settles
  cleanly instead of killing the session's newer run; a second tab waiting on
  `session_busy` now attaches to the live run and sees its stream and
  terminal; a run that finished while a tab was disconnected no longer wedges
  that session's queue on reconnect; acknowledged-but-unsettled sends requeue
  on socket loss (dedupe-safe) instead of stranding; a foreign run's lifecycle
  end on the same session can no longer fail a still-pending send; per-run
  stream cursors can no longer silently lose frames after reconnect (a stale
  cursor now forces a history reconcile); a finished run's live row with a
  stream hole self-heals instead of duplicating the bubble forever; history
  ids from native gateway rows are disambiguated per rendered row; ids
  containing control characters are rejected (registry-key collision + log
  injection); chat session keys are validated before reaching gateway RPCs on
  every path including HTTP history, whose errors are now classified instead
  of leaking raw gateway text; logout clears queued chat content and drafts;
  a transient socket blip can no longer latch the sticky HTTP-fallback mode;
  oversized drafts are measured post-JSON-escaping so pathological content
  hits the visible size chip instead of killing the socket; concurrent Stops
  collapse into one abort; buffered foreign-run events are byte-capped; and a
  tab's send allowance counts only its own sends, not org-wide runs it
  auto-attached to. Remaining accepted residuals are logged in TODOS.md.

### Changed

- The chat bridge (`lib/server/chat-ws.js`) was decomposed into
  `lib/server/chat/` and the 1116-line chat route into
  `lib/public/js/components/chat/` (pure, unit-tested modules for run state,
  send outbox, transcript merging, and reconnect policy). Protocol v2 adds
  acks, per-run sequence numbers, and exactly-one-terminal-per-run semantics
  while remaining compatible with old bundles in both directions. Design doc:
  `docs/designs/chat-reliability.md`.

## [0.9.51] - 2026-08-31

Every "something is wrong" surface now tells you what, why, and how to fix
it: the vague "Hardening: blocked" badge is replaced by a card naming the
file, the true cause, and the fix — and the ~20 other places that swallowed
an error or rendered a bare "Error" pill got the same treatment.

### Fixed

- **The Doctor no longer gives advice that can't work when prompt hardening
  is blocked by a rejected read.** An escaping symlink or a >2 MiB hardening
  file used to be misdiagnosed as "missing file" ("restart — the resync
  rewrites it", which fixes neither). The true cause now flows end to end
  with deterministic precedence, cause-specific card copy for symlink escapes
  and the read cap (never budget advice — the 2 MiB cap isn't configurable),
  per-file evidence for rejected files (previously misreported), an honest headline
  when causes are mixed, and a safe generic fallback for reason codes a
  future server may add. A file that is never injected at all (hook disabled,
  rejected basename) no longer surfaces budget advice just because it is
  also over a cap.
- **A failed Codex status check can no longer fabricate "Not connected".**
  All four status-check surfaces (Providers, Models, onboarding, welcome)
  keep the last checked status, show why the check failed (Providers and
  Models add a Retry button), and
  say "Status unknown" when there is no prior data to claim — including when
  the server answers with an error envelope instead of a rejection.
- **Caught errors stop disappearing into static copy.** The agent-admin token
  panel renders the server's own hint (the "(mint failure)" guess is gone);
  upgrade-status refresh failures name the cause like the catalog card
  already did; team presence failures show the real message on its own line
  (a 500 no longer reads "could not reach the server"); the Google
  credentials modal, watchdog terminal, and onboarding model catalog all
  surface the underlying message; a restart-evidence fetch failure is no
  longer misreported as "Evidence expired"; and the sidebar git panel's
  hover-only native tooltip becomes the shared keyboard-reachable one.

### Added

- **A "Prompt hardening" card on the General tab for problem states** (the
  healthy state keeps the compact badge): an impact anchor ("Safety rules are
  not reaching the agent."), per-file rows with the specific cause and a
  one-clause fix (severity derived from impact — a fully-dropped file is
  danger DROPPED, truncation is warning PARTIAL, blocked is always danger),
  an "updated {time}" stamp, a restart disambiguation footnote, and an
  Open Drift Doctor button. The stale-doctor warning yields while the card is
  showing so two alert cards never stack.
- **The card's CTA deep-links `#/doctor?focus=context`:** the context meter
  scrolls into view, the fresh hardening finding is highlighted persistently,
  and rejected-read or unconfigured files the meter cannot list get an
  explanatory hint line — the arrival is never a dead end.
- **Doctor context-meter chips explain themselves:** hover or focus any
  Blocked/Dropped/Truncated chip for the cause and fix (the "Starved" label
  is now "Dropped"), backed by one client copy map whose coverage against the
  server's canonical reason list is CI-enforced.
- **The server logs "hardening state change observed"** with per-file causes
  whenever the state or reason set changes between status refreshes — "when
  did it break?" is answerable from logs even when no scan ran (paths
  sanitized against log forging).

### Changed

- **Bare warning/danger badges across the flagged cohort now name their
  condition and carry their remedy** via the new shared TooltipBadge
  (visible label stays the
  accessible name; tooltips are supplementary since they never open on
  touch): "Error" → "Watch not running" (with a visible renew hint),
  "Needs auth" → "Authentication required", "Awaiting pairing" → "Pairing
  incomplete", node "Disconnected"/"Pending approval" carry reconnect and
  approval guidance, Telegram "stale"/"no account attributed" explain
  consequence and fix, and Resources "Host values" explains what it means.
  The rule is codified in AGENTS.md so the class can't regress.

## [0.9.50] - 2026-08-31

Drift Doctor's "Ask Agent to Fix" now actually delivers to the chat you pick
— any channel, any session-key shape — and the workspace scan caps are
raised, configurable, and honestly reported.

### Fixed

- **"Ask Agent to Fix" silently never delivered to most DMs.** The reply
  target derived from hand-rolled Telegram-only regexes: account-scoped keys
  (`…telegram:default:direct:…`), suffixed keys (`…:heartbeat`), bare groups,
  and every Discord/Slack DM lost delivery while the UI showed a success
  toast. Delivery targets now derive through the canonical suffix/account-
  tolerant parser, server-side, validated against the live session list —
  Discord/Slack DMs get proper `user:<id>` targets and account-scoped keys
  deliver through their account (`replyAccountId`/`--reply-account`). The
  same fix repairs `POST /api/agent/message` and the webhook/cron destination
  pickers for non-Telegram DMs.
- **One unreadable directory no longer kills the workspace scan**, deep or
  ultra-wide trees no longer crash the walk (iterative traversal, no spread
  overflow), files vanishing mid-scan stay a non-event, a file being actively
  appended can no longer hang the scan (hashing is bounded at the observed
  size), and persistently unreadable files now honestly mark the scan
  partial instead of silently vanishing from drift detection.
- **Messages to another agent's session now run under that agent.**
  "Send to agent" previously always executed as the main agent; with
  delivery now working for every channel, a non-main agent's DM would have
  received the main agent's answer — the turn now runs under the session's
  own agent.

### Added

- **Configurable scan caps** (Doctor settings → Scan limits): defaults raised
  to 200k files / 50MB per file (was 50k/10MB), bounds 1k–500k / 1–100MB,
  blank = default; changes re-scan immediately, no restart. The partial-scan
  banner now states real numbers (files found vs cap, oversize/hash-budget/
  unreadable-dir skips) and links to the settings card.
- **Honest fix-dispatch lifecycle:** the modal filters to deliverable + main
  sessions, shows a "delivers to chat / runs in main thread" hint before
  send, Telegram DM rows are peer-qualified ("Direct message · 1050"), the
  toast says delivery was _requested_ (never "delivered"), and working cards
  carry a persisted dispatch record ("delivery requested → telegram · 1050" /
  "dispatch failed").
- **Scan coverage forensics:** every doctor run persists the caps + stats its
  snapshot was built under (`scan_stats_json`).
- **Pre-merge review hardening** (specialist + red-team + cross-model passes,
  all findings fixed): oversized fix prompts are a clean 400 before any state
  change (char pre-filter + byte budget on the final payload); a failing
  sessions CLI maps to 502, never a client-blaming 400; failed dispatches
  leave a visible "last fix dispatch failed" marker on the reopened card and
  the record survives no-change scan cloning; scan-limit inputs revert their
  drafts on rejected saves and lock during any in-flight settings save; the
  scanner reuses one hash buffer and only skips the manifest round-trip when
  nothing was re-hashed (touched-but-identical files no longer re-hash every
  refresh).

### Changed

- **One-time full re-analysis after upgrade:** workspace fingerprints changed
  (tool-owned directories like `dist`, `.venv`, `__pycache__`, `.cache`,
  `coverage` are now ignored; capped scans fold exclusion counters into the
  fingerprint so changes beyond the cap bust the reuse guard). The first scan
  after this release re-analyzes from scratch by design.
- **Bounded doctor.db growth:** run manifests are retained only on the newest
  two manifest-bearing runs plus the latest completed run.

## [0.9.49] - 2026-08-31

An upstream-alignment fix wave: the watchdog terminal finally gets a real
window size, agent guidance stops naming Docker-only paths on npx and VPS
installs, a Signal channel configured out-of-band becomes visible to status
and onboarding (and survives it), the Google OAuth flow payload moves fully
server-side, and model pricing/catalog gaps close — plus two security
hardenings found while verifying prior waves.

### Added

- **MiniMax (China) support.** `minimax-cn` model selections reuse your
  existing MiniMax API key, six MiniMax models (M2.7, M2.7-highspeed, M3 —
  both regions) ship in the cold-start catalog via a new curated overlay
  that catalog regeneration can no longer erase, and the picker shows a
  labeled "MiniMax (China)" section.
- **Signal shows up.** A Signal channel configured in openclaw.json (linked
  via signal-cli) now appears in `/api/status`, renders as a
  "Signal — Configured" row in the onboarding Channels step, and flips the
  finish button from "Continue with web chat" to "Next". The plugin
  runtime-deps preflight now also runs on Signal-only boxes.

### Changed

- **Prompt guidance is install-aware.** Durable-storage rules render the
  real managed state directory — env-var-first
  (`$OPENCLAW_STATE_DIR (this install: …)`) — instead of the Docker-only
  `/data/.openclaw`, across the bootstrap templates, the gog skill, and the
  admin-skill rules. Existing installs self-heal on the next restart; the
  `alphaclaw git-sync` CLI messages are root-agnostic too. Fixes the Drift
  Doctor P1 ("guidance names a nonexistent root") on `npx alphaclaw start`.
- **Model pricing fallback resolves the most specific match** at component
  boundaries (`gpt-5` can no longer shadow `gpt-5.5`; `gpt-5x` no longer
  false-positives onto `gpt-5`). Note: `gpt-5.4-nano`-style ids now price
  via `gpt-5.4` instead of `gpt-5`.

### Fixed

- **`openclaw doctor --fix` is readable in the Watchdog terminal.** The PTY
  was spawned with a 0×0 window (Node TUIs saw `isTTY=true, columns=0` and
  rendered one glyph per line); the browser's fitted size now applies at
  spawn, the latest size is recorded per connection and used by every
  respawn (Restart session picks it up), sizes are integer-clamped on both
  untrusted paths, and each spawn logs its size for future diagnosis.
- **Google OAuth state can no longer be re-encoded.** The account-linking
  payload lives server-side behind an opaque single-use state (TTL'd,
  size-capped, softly bound to the starting browser session), the token
  exchange is pinned to the start-time redirect URI, a denied consent
  consumes the flow, and an unknown accountId can no longer be planted for
  the callback to adopt. The session-less OAuth callback exemption now
  actually matches (it compared the wrong path under the /auth mount) and
  uses an exact pathname, so `/auth/google/callback-evil` never rides it.
- **Channel account deletion rejects traversal ids** before any config read,
  with containment inside both destructive cleanup helpers — a hostile
  account key planted in openclaw.json can no longer steer `rm -rf`-class
  deletes outside the credentials directory.
- **The boot git-askpass helper moved off the predictable `/tmp` path** into
  the shared private-mkdtemp writer (a pre-planted symlink could redirect
  the copy and get executed by git); an explicit
  `ALPHACLAW_GIT_ASKPASS_PATH` override is written exclusively (`wx`).
- **A boot or env-save sync can never auto-remove a channel that has no
  managed env token** — the removal branch used to `channels remove
--delete` any enabled channel without a saved token. WhatsApp's lifecycle
  is unchanged and now pinned by a regression test.
- **Externally-configured channels survive fresh onboarding**: non-managed
  `channels.*` entries are snapshotted before `openclaw onboard` rewrites
  the config and re-added add-only through the sanitized write (hardened
  against prototype-pollution key names).
- **Eight missing model prices** (gpt-5.5, gpt-5.4-mini, kimi-k2.6:cloud,
  deepseek-v4-flash:cloud, glm-5.1:cloud, grok-4.3, qwen3-coder-next,
  minimax-m3:cloud) — gpt-5.5/gpt-5.4-mini were mispricing as gpt-5, the
  rest billed at zero.
- **Test temp-dir leaks** in the models/browse route suites (~108 leaked
  directories per run); the repo-wide sweep is tracked in TODOS.

## [0.9.48] - 2026-08-30

Drift Doctor now understands how the installed OpenClaw actually injects
workspace context — verified against the real 2026.7 stable and 2026.8.1 beta
packages — and can watch your workspace on a schedule instead of waiting for
you to click Run.

### Added

- **Scheduled Drift Doctor scans (opt-in).** A Doctor-tab toggle runs a scan
  automatically when the workspace goes stale with meaningful changes, when
  your environment changes (budgets, hooks, git-sync, OpenClaw version), or
  when prompt hardening degrades — throttled to at most one scan per 6 hours,
  skipped while the gateway is down, and never on by default.
- **New-P0 notifications.** When a scan surfaces a new critical finding, you
  get one Watchdog notification naming up to three findings — deduplicated
  across restarts, never repeated for findings you already saw or dismissed.
- **Context-budget meter (Doctor tab).** See the estimated injection size of
  every bootstrap file against OpenClaw's real 60,000-character budget, with
  per-file bars and truncation/starvation chips.
- **Prompt-hardening badge (General tab).** At a glance: are AlphaClaw's
  safety rules actually reaching the agent? States cover injected, partially
  truncated, blocked, and unknown (including unreadable JSON5 configs and
  unverified dev builds).
- **Environment checks that don't need an LLM.** Every scan now also runs
  deterministic checks: retired TOOLS.md/HEARTBEAT.md guidance on the beta,
  invalid or starved bootstrap extras, MEMORY.md over budget, leftover
  BOOTSTRAP.md, skills-prompt bloat, and git sync disabled.
- **OpenClaw's own doctor, bridged in.** Scans run `openclaw doctor --lint
--json` alongside the LLM analysis and surface its findings as cards
  (capped, deduplicated, and suppressed where Drift Doctor already covers
  the same ground).
- **Verified restart handoff.** When a supervised gateway exits because
  OpenClaw itself requested a restart (config write, /restart, plugin
  change), AlphaClaw now consumes the handoff record and relaunches promptly
  instead of counting it as a crash.

### Changed

- **Doctor analysis upgraded to the doctor-v2 contract.** Corrected budgets
  (60k total, not 150k), real truncation behavior (75/25 with visible
  markers), MEMORY.md recognized as injected, per-version file ordering, and
  the beta's 4k USER.md cap and session-scope filtering — all cited to the
  shipped packages, with per-version profiles selected by installed version
  (failing closed to stable). The first scan after upgrading re-analyzes
  from scratch by design.
- **Prompt hardening now ships as one merged `hooks/bootstrap/AGENTS.md`**
  on every version — the beta no longer silently drops AlphaClaw's rules
  with the retired TOOLS.md name, and existing installs migrate on next
  boot with user-added extras preserved.
- **Run button stays honest.** It disables with a visible reason only while
  the gateway can't take a run (including degraded health); with zero file
  changes it stays enabled — a no-change scan is cheap (no LLM call) and
  re-checks your environment, config, and OpenClaw's own doctor findings.

### Fixed

- **Exit-78 no longer always means "config error".** A healthy-incumbent
  step-aside (two gateways racing at boot) is now verified with a health
  probe and treated as benign instead of latching restarts and triggering
  rollback.
- **SQLite backups cover every database and follow the real beta CLI.**
  Create with the required `--repository`, then verify the exact snapshot
  the create reported — for the shared state database AND each configured
  agent's database (sessions, auth profiles). A backup that can't be
  verified, or that skips a database, is reported as a failure with the
  exact step that failed — never as a success.
- **Dashboard focus links use the beta's URL grammar** (path form), so
  focus deep links actually open.
- **Notification and card hygiene hardened.** Finding titles can't forge
  extra notification lines; evidence snippets can't read outside the
  workspace (symlinks included) and are secret-redacted; secrets rotated
  via the env editor are redacted without a restart; agent-dispatched fix
  prompts only ever contain template text and validated identifiers.
- **The context model matches the shipped packages byte-for-byte.**
  Per-agent budget overrides, the `patterns`/`files` extras aliases, keyed
  agent rosters, USER.md's basename-applied cap, missing-file markers
  charged to the budget, and the 2 MiB read-rejection cap are all modeled
  as the real gateway behaves — each cited to the package source.
- **The upgrade overseer reads doctor output correctly on stable**
  (`doctor --lint --json`, honoring the exit-code contract).

## [0.9.47] - 2026-08-30

Every time shown in the UI now renders in your browser's timezone and your
locale's expected format — "Mar 10, 2026, 7:45 PM" in the US, "10.03.2026,
19:45" in Germany — from one shared formatter family instead of six competing
hand-rolled dialects. Raw UTC ISO strings no longer leak into tooltips or the
watchdog console, and two genuine timezone bugs are fixed: cron trend charts
bucketed days at the _server's_ midnight, and the Doctor tab served a frozen
"(12 minutes ago)" phrase forever.

### Added

- **One time-format dialect**: `lib/public/js/lib/format.js` now carries the
  full family — locale datetime (medium date + short time), date-only,
  time-only (optional seconds), datetime + numeric UTC offset, datetime
  ranges with elided dates ("Aug 29, 2026, 3:11 – 4:12 PM"), and a single
  parametrized relative-time helper (compact "5m ago", long "5 minutes ago",
  unit "5m"/"2mo", opt-in future "in 5m") that replaces six duplicate
  implementations with divergent thresholds. Formatters are built through one
  `createFormatters(timeZone?)` factory, so timezone-conversion tests
  exercise the exact construction path production uses.
- **Watchdog console in local time**: log-line timestamps render as
  `YYYY-MM-DD HH:mm:ss ±HH:MM` in your zone (the offset survives copy/paste
  and disambiguates DST folds), with a "Line timestamps shown in
  ‹your zone›" caption on the Logs tab; the copy action is now labeled
  **"Copy diagnostics (UTC)"** because the export deliberately stays UTC ISO
  for escalation.
- **Dual-register incident tooltips**: hovering an incident or event shows
  "Mar 10, 2026, 7:45:02 PM GMT-7 · 2026-03-10T02:45:02.114Z" — local time
  with the offset plus the exact UTC instant, instead of a raw ISO string.
- **Browser-timezone cron trend buckets**: `/api/cron/jobs/:id/trends` now
  buckets 7d/30d ranges at _your_ midnight (via the `x-client-timezone`
  header every request already carries), with a DST-safe day-start algorithm
  (skipped and repeated midnights handled), canonicalized and size-capped
  timezone caches, and the effective timezone echoed in the response.
  Requests without the header keep the previous server-local behavior.
- **Conventions guard test** that fails the build if new `toLocale*` or
  `Intl.DateTimeFormat` calls appear outside `format.js`, so the
  normalization can't silently erode.
- **Browser-level E2E** (`npm run test:ui:time`,
  `tests/browser/time-format-smoke.sh`): boots a real isolated server and
  asserts in headless Chromium — against expectations the browser itself
  computes with the same Intl presets, so the test is locale/timezone
  agnostic — that the gateway card matches the API instant, console lines
  carry local `±HH:MM` prefixes with the zone caption and the
  "Copy diagnostics (UTC)" label, and incident timelines show seconds with
  dual-register tooltips.

### Changed

- All ~75 timestamp render sites (gateway, watchdog, upgrade, cron, usage,
  webhooks, team, telegram, doctor, chat, buzz, update modal, git panel) use
  the shared formatters; ambient timestamps drop seconds by default while
  sub-minute event surfaces (incident timeline, webhook request history,
  cron run history) explicitly keep them.
- Cron schedule descriptions render their wall-times through the locale
  formatter ("Daily at 9:30 AM" in the US, "Daily at 09:30" in Germany) —
  still never timezone-converted — so the schedule and next-run cells no
  longer show two different time styles side by side.
- Chat message times read "3:04 PM" instead of "03:04 PM"; relative-time
  wording is now consistent everywhere (one threshold table, floor rounding).

### Fixed

- Doctor no longer serves a frozen "(12 minutes ago)" phrase written at scan
  time: new summaries omit it and legacy rows are scrubbed on read.
- Future timestamps no longer collapse to "just now" where a direction
  matters (cron next-run shows "in 5m"), while past-only feeds keep the
  clamp so server clock skew never shows "in 3s" on a past event.
- The timezone request header is memoized at page load alongside the display
  formatters, so server-side bucketing and on-screen times can never diverge
  mid-session.
- The `timeZone` echoed by `/api/usage/summary` is now the canonical IANA id
  (e.g. `america/new_york` → `America/New_York`) rather than the raw client
  string — a side effect of shared zone canonicalization; browsers already
  send canonical ids, so only hand-rolled callers comparing the echo to their
  input will notice.
- Console lines whose leading timestamp carries a numeric offset (child
  process output like `…T12:00:00+02:00`) now localize using that real
  offset, and zone-less timestamps pass through unchanged instead of being
  guessed as browser-local; the timezone caption falls back to "local time"
  when the browser can't name its zone.
- When the server can't recognize the browser's timezone, the cron trends
  chart says so ("Day buckets use the server's timezone…") instead of
  silently labeling server-local buckets with browser-local dates; the
  trends endpoint also accepts a `?timeZone=` override and marks its
  response `Vary: x-client-timezone` for HTTP caches.

## [0.9.46] - 2026-08-29

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

## [0.9.45] - 2026-08-29

The two remaining upgrade incidents are fixed end-to-end (issues #18 and
#20), and the whole stable→beta upgrade path is now proven on every PR by a
real container upgrade driven through the real browser UI. This release also
unifies 0.9.43's apply-time migration gate with a new fail-closed boot
reconciler, so there is one migration engine with one recovery story.

### Fixed

- **Pre-update backup no longer races the live gateway (#18)**: downgrades,
  dev switches, and cross-channel updates now pause the gateway briefly for
  a consistent backup (the confirm dialog says so), with a retry ladder for
  vanished-file races when pausing isn't possible. Failures name the exact
  file and honest attempt count instead of a truncated path; a backup blocked
  by a broken config retries once without workspace files and is recorded and
  announced as partial.
- **Settings migration is fail-closed (#20)**: the freshly activated build's
  settings are validated and migrated BEFORE its gateway can ever start —
  with a budget sized to your state databases (10 min + 5 min/GB, up to 30
  min; `OPENCLAW_DOCTOR_MIGRATION_TIMEOUT` overrides the base and can raise
  the cap) instead of the old fixed timeout. On failure, the 0.9.43 hard
  gate reverts to a preflight-proven older build when that is safe;
  otherwise the gateway is HELD with the exact blamed settings keys and
  one-click "Retry migration" / "Strip blamed keys and retry" actions on
  the Upgrade page. Unknown settings keys are never deleted without your
  consent, manual gateway restarts are refused while the hold protects your
  data, and a crash-looping box can no longer destroy weeks of settings.
- **`doctor --fix` can no longer silently restore stale settings**: the
  last-known-good file is quarantined during every doctor run, tripwires
  catch backwards timestamps, shrinking MCP/provider inventories, and
  secrets flattened from env references, and a blocked restore is reverted
  and reported with key paths only — never values.
- **Rolling back after a database migration now asks first**: both rollback
  buttons (Upgrade page and Gateway card) show a second confirmation naming
  the verified pre-update backup to restore, instead of silently handing the
  old build databases it may not be able to read; API callers get a 409
  with a `confirmDataRisk` escape hatch.
- **The update wait page shows live progress**: during updates and restarts
  the placeholder page now renders real step names with elapsed times, the
  target version, and a backup-verified line tied to the actual run — legible
  on phones — and its patience scales with step progress (60-minute cap) so
  platforms no longer kill long migrations mid-flight.
- **Watchdog and recovery hardening**: the exit-78 medic now queues briefly
  behind a busy lifecycle lock instead of skipping (and stands down when a
  competing repair already relaunched the gateway); a reconciler hold
  survives watchdog startup and outranks 0.9.43's config-edit auto-relaunch;
  the lifecycle-lock lease scales to the migration budget so a queued
  restart can never interrupt a long migration; listener-exposure settings
  (`gateway.mode/bind/port/tls`) can never be auto-stripped; persisted
  validator output is secret-redacted.

### Changed

- The 0.9.43 migration hard gate now runs inside the fail-closed reconciler:
  every gate decline — kill switch, missing snapshot, no compatible revert
  target — holds the gateway instead of continuing on the rejected build,
  and the migration timeout ceiling rises from 12 to 30 minutes now that the
  wait page tracks step progress.

### Added

- **Container upgrade test tier**: a real Docker container running the
  pinned stable OpenClaw is upgraded to the newest beta through the real
  browser UI while session files churn, then must survive both a container
  replacement and a `docker restart` on the same volume — run nightly and as
  an always-on PR gate for upgrade-path changes, so a broken upgrade can no
  longer merge blind.
- A live-tier test that runs the real backup CLI under file churn, pinning
  the vanished-file contract that caused #18.
- `docs/upgrade-troubleshooting.md`: a runbook for held gateways, blocked
  stale restores, quiesced backups, and their exact recovery commands.

## [0.9.44] - 2026-08-29

The sidebar gains an "Open Claude Code" launcher: one click starts a fresh
Claude Code cloud session on claude.ai and opens it in a new tab — or, until
you configure it, simply takes you to claude.ai/code.

### Added

- **Open Claude Code launcher** (Monitoring section of the sidebar): when a
  Claude Code routine fire URL and per-routine token are configured in Envars
  (`CLAUDE_CODE_ROUTINE_URL`, `CLAUDE_CODE_ROUTINE_TOKEN`), clicking the item
  fires your routine through Anthropic's experimental routine-fire API and
  opens the returned `claude.ai/code/session_…` in a new tab, with a live
  interstitial while the session starts. Unconfigured, the item is a plain
  link to claude.ai/code — always useful, never a dead click. Because a fire
  starts an autonomous run that consumes your claude.ai subscription usage,
  the first fire asks for a one-time confirmation (remembered per browser),
  the server enforces that consent plus a single-flight guard and a short
  cooldown, and cmd/ctrl-click always opens plain claude.ai/code without
  firing. The launcher never sends the token to the browser (its status
  endpoint is presence-only; like every Envars secret, admins can still view
  it in the Envars editor), the token is excluded from the OpenClaw gateway's
  child environment, and the fire endpoint is denied to the agent-admin
  actor; config changes apply live without a restart.

## [0.9.43] - 2026-08-29

A beta upgrade can no longer brick a box (issues #21, #22, #23). The root
incident: a config-migration timeout let the new build boot anyway, one-way
migrate the config and state DB, then roll back to a pin that could read
neither — with every notification about it dropped. Every link in that chain
is now fixed, plus the exec-approvals regression that took down all channels
on sqlite-era OpenClaw.

### Fixed

- **Migration hard gate (#21 bug 2, the critical one)**: a failed boot-time
  `doctor --fix` on a freshly applied build now aborts BEFORE that build ever
  runs — the previous version is re-activated, its pre-migration settings are
  restored, and the new build is blocklisted (`config_migration_failed`) with
  a Clear-to-retry path. The gate preflights its own revert target and stays
  forward when a part-migrated state DB makes reverting the more dangerous
  move. Kill switch: `OPENCLAW_MIGRATION_GATE=off`.
- **Migration timeout (#21 bug 1)**: the hard 120s `doctor --fix` timeout is
  now tunable (`OPENCLAW_DOCTOR_MIGRATION_TIMEOUT`, default 10 min), scales
  with state-DB size, and is capped at 12 min — under the boot placeholder's
  15-minute health ceiling so the platform can never kill a migration
  mid-flight. Doctor output is captured (secret-redacted) into the warning,
  the notification, and `configMigration.lastAttempt.error`; timeouts kill
  with SIGKILL so a lingering doctor can't hold locks.
- **Rollback compatibility (#21 bug 3)**: boot rollback markers now preflight
  EVERY candidate target — package targets AND the pin — against a snapshot
  of the state DBs (copy-per-probe), plus an `agents.entries` config-shape
  guard. A blocked target reroutes to the next compatible candidate; when
  nothing can read the migrated state the rollback is REFUSED (the
  blocked-but-compatible build keeps running under the watchdog latch) with
  the newest backup archive named as the manual recovery path.
- **Crash-rollback config restore (#21 bug 4)**: rolling back to a version
  now restores its `openclaw.json.pre-fix-<version>.bak` even when the
  migration bookkeeping already points at that version — the exact blind
  spot that kept the #21 box unbootable. Pre-fix backup write failures are
  surfaced instead of swallowed, and the backup is never named after the
  version being migrated to.
- **Pin last-known-good (#21 bug 5)**: a pin-only box now promotes the
  healthy pin to `lastKnownGood.package` after the 120s health hold (with a
  disk-checked overlay snapshot), so later rollbacks have a real target.
- **Backup escape hatch (#21 bug 6)**: when `backup create` fails because a
  broken config prevents workspace discovery, the backup retries once with
  `--no-include-workspace` into a fresh archive, recorded and announced as
  `partial` — config and state databases are still included.
- **Deliverable notifications (#21 bug 7)**: the Telegram bot token now also
  resolves from `openclaw.json` (fresh onboardings store it there, not in
  `.env`), and fan-out falls back to numeric `channels.telegram.allowFrom`
  chat IDs when no pairing files exist — the two gaps behind
  `no_channels_delivered`. The outbox retries with exponential backoff for
  48 hours instead of giving up after 5 attempts, and an abandoned event is
  persisted as a `notification_abandoned` watchdog event. New out-of-band
  webhook channel (`ALPHACLAW_NOTIFY_WEBHOOK_URL`) posts critical events
  directly — including straight from the boot process for gate reverts,
  refused rollbacks, and forward recovery, when no server is up to drain the
  outbox.
- **Intentional restarts (#21 bug 8 / #22)**: container restarts now exit
  with the dedicated code 75 (EX_TEMPFAIL) so supervising wrappers can
  relaunch immediately instead of falling to a failure page, and the
  lifecycle latches its exiting state before the restart drain (a SIGTERM in
  that window no longer races a second drain). Companion template-repo
  change supervises `alphaclaw start` instead of `exec`-ing the failure
  server.
- **EX_CONFIG latch (#21 bug 9)**: while latched, the watchdog now watches
  `openclaw.json` and re-arms exactly one relaunch per distinct config edit
  (operator fix, medic repair, boot restore) instead of staying inert until
  a container restart; the gateway card in `config_error` now surfaces the
  Repair action that force-clears the latch.
- **No bootable version (#21 bug 10)**: when the pin itself cannot boot and
  a newer blocklisted build with a local overlay owns the migrated state,
  the watchdog performs a one-shot FORWARD recovery to that build (audited,
  never ping-pongs; kill switch `OPENCLAW_FORWARD_RECOVERY=off`). If that
  also fails, a persisted `noBootableVersion` flag drives an unmissable
  banner and notification instead of a silent dead box.
- **Legacy exec-approvals (#23)**: AlphaClaw no longer recreates
  `exec-approvals.json` on OpenClaw ≥ 2026.9.1-beta.1 (where its mere
  existence fails all channels, cron, and heartbeat closed) — the managed
  seeding is skipped when the SQLite `exec_approvals_config` backend is
  detected, a stray legacy file is renamed aside at boot, and the
  exec-approvals dashboard routes go through `openclaw approvals get/set`
  on CLI-capable builds.

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
