# Upgrade troubleshooting

Operator runbook for the failure states the OpenClaw upgrade pipeline can
surface (Upgrade tab, notifications, watchdog events). Background: issues
[#18](https://github.com/chrysb/alphaclaw/issues/18),
[#20](https://github.com/chrysb/alphaclaw/issues/20) and
[#54](https://github.com/chrysb/alphaclaw/issues/54).

## `doctor_restored_stale_config`

**What it means:** during a repair pass, the doctor tried to restore a
last-known-good `openclaw.json` that was *staler* than your live config.
AlphaClaw detected the stale restore and reverted it — **your config is
unchanged**.

**Next steps:** nothing is broken; the event is recorded so you know the
doctor's snapshot had fallen behind. If it repeats, check that config edits
are going through AlphaClaw (which refreshes the last-known-good snapshot)
rather than hand-editing the file while a stale snapshot sticks around.

## Gateway held after activation

Two hold classes share `state.gatewayHold`. This section is the
**migration-class** hold (`reason` such as `config_migration_failed`): the
settings migration failed and **Retry migration** / **Strip blamed keys** are
the levers. A **structural** hold — `reason` `version_mismatch`,
`state_db_unreadable` or `activation_failed` — means the installed build
must not launch against the databases on disk; Retry migration refuses it
(`409 reconcile_still_held`), so use the "Version mismatch — running ≠
expected" section below instead (Re-activate recorded build, or apply a
version that can read the databases).

**What it means:** the new version installed, but its settings migration
failed and AlphaClaw failed **closed**: the gateway is deliberately held
(not started) so a half-migrated config can't run. The UI shows a "held"
banner on the Upgrade tab.

**Next steps:** the notification and the run ledger (`runs/<opId>.json`)
name the exact config keys the migration blamed. From the banner choose:

- **Retry migration** — after fixing the blamed keys yourself, or
- **Strip blamed keys and retry** — AlphaClaw removes the named keys
  (backing up the original config first) and re-runs the migration.

While the hold is set, every manual relaunch path fails closed (v0.9.73):

- The gateway card in the Setup UI still *offers* Restart, Retry and Repair
  but renders them disabled with "Gateway held after a failed settings
  migration — resolve it on the Upgrade page." Repair is blocked too:
  `doctor --fix` would rewrite the held config. If another lifecycle
  operation is running, its "Another operation is in progress" reason is
  shown instead of the hold reason.
- A manual **restart is refused** (`409 gateway_held` from
  `POST /api/gateway/restart`, with a `hint`): restarting would launch the
  gateway on the exact config the reconciler just rejected. The same check
  runs again once the restart holds the lifecycle lock, so a hold that
  appeared while the restart was queued behind another operation fails it
  with the same code — the operation's terminal event carries
  `code: gateway_held`, and the Watchdog event log books the row as
  `skipped`, never as a failed restart. This route's other refusal codes
  are `409 apply_in_progress` (a channel update is running), `409 booting`
  (AlphaClaw itself is still starting the gateway — refused up front, never
  queued) and `409 gateway_hold_unreadable` (below).
- A manual **repair is refused** the same way (`409 gateway_held` from
  `POST /api/watchdog/repair`); automatic repairs skip with one event-log
  row per distinct refusal.
- An **unreadable or corrupted** release-channel state file
  (`<root>/.openclaw/.alphaclaw/openclaw-channel-state.json`) is treated as
  held: restart and repair answer `409 gateway_hold_unreadable`, the card
  disables the same actions with "Gateway hold state could not be read…",
  and the exit-78 config-change auto-retry and the memory-pressure restart
  stop relaunching. Check the file and the server log.

Recover through the retry actions above instead.

The retry endpoint (`POST /api/openclaw/reconcile/retry`) answers `409`
with one of:

- `apply_in_progress` — a channel update is running; wait for it to settle.
- `reconcile_not_needed` — no hold is recorded and the gateway is already
  running; the doctor never touches a live gateway's databases.
- `gateway_running` — a hold is recorded but a gateway process is running
  anyway, which means it was started outside AlphaClaw (a manual
  `openclaw gateway` or an external supervisor — the hold is exactly
  AlphaClaw refusing to launch one). The migration never touches live
  databases; stop that process, then retry.
- `reconcile_still_held` — the migration failed again; the message carries
  the hold reason.
- `reconcile_skipped` — the reconciler declined to run (e.g. the openclaw
  binary could not be resolved); the hold and watchdog latch are untouched
  and the gateway is not relaunched.

## Version catalog and "Check now"

**What it means:** the Version catalog card lists what is installable. Since
v0.9.81 its rows are the **npm** abbreviated doc's versions (the install
source of truth) — minus versions npm marks `deprecated` — each enriched with
its **GitHub** release's notes and date when a release exists; a version that
is on npm but not yet released on GitHub is still a row, badged `latest` when
the dist-tag says so, with "release notes unavailable". Upstream publishes to
npm first and creates the GitHub release hours later (2026.9.3 sat on npm
~20 h before its release object existed), which is why a GitHub-first catalog
never showed the newest installable version for most of a day. Rows sort by
version; the dist-tag alone decides "latest".

**Staleness:** "Catalog as of" is the oldest of the two ROW sources. The
server serves a cached catalog for 10 minutes, then stale-while-revalidate;
an npm cache older than 60 minutes is awaited instead (bounded by the 20 s
fetch timeout, falling back to the stale copy flagged degraded). The stamp
and the last fetch failure survive AlphaClaw's restarts (a sidecar
`cache/openclaw-catalog/<file>.meta.json`), so "20 hours ago" after a
restart means the fetches really have been failing — the degraded line names
the source (`catalog.sources.{github,npm,dev}` on the payload). The page
re-reads the catalog every 10 minutes while visible and follows up once when
the server admits a stale answer.

**Check now** is never disabled by a running or failed update — only while
its own refresh is in flight. The toast says what happened: "Checked just
now" (a real fetch), or "Checked moments ago — try again in N s" (the 30 s
anti-hammer floor served the cached read; `refreshThrottledForMs` on the
payload). A `?refresh=1` that still shows an old "as of" means the sources
themselves failed — check the server's network access and `GITHUB_TOKEN`.

**"Update to latest" and declared intent:** the CTA appears only when a row
is strictly newer than the running version (never the next-older release —
the v0.9.78 bug), and its apply declares `intent: "update"` with
`expectLatest: true`. The server judges every stable/beta apply's `intent`
(`update | downgrade | switch`) against the running version:
`409 intent_mismatch` means the page's view of the running build or the
row's direction was stale (it reloads both); `409 catalog_stale` (carrying
`latest`) means a newer version appeared since the page loaded (it reloads
the catalog once and re-opens the confirm on that version). Agent-admin
callers of `updates.apply` must send `intent` too — a body without it is a
`400 invalid_body` naming the three values. The run record's `intentCheck`
says what was verified and what was skipped.

## Brief gateway pause during backup (quiesce)

**Expected behavior**, not a failure: since issue #79 (Stage 4c, decision
D1a) **every** apply that can pause the gateway does — a same-channel
stable upgrade as much as a cross-channel apply, downgrade or dev switch —
while the pre-update backup captures a consistent state DB. The pause is no
longer gate-scoped: `runBackup` (`openclaw-channel-sync.js`) sets
`willQuiesce = Boolean(gatewayQuiesce)` with no hard-gate term, and
`hardGate` (downgrade, dev switch, prerelease target, channel-boundary
crossing) now decides only whether a backup failure is fatal — a hard gate
answers `409 backup_failed`, a soft gate records `noBackup` with a
`backup: warning` and continues to the migration checkpoint ("Backup:
continue without a backup (consent)" below). Sessions reconnect when the
gateway resumes. The pause is one transaction: `runBackupDiagnosis` (before
the pause) → lifecycle lock (leased for the quiesce **and** offline-copy
budgets) → watchdog suppressed → gateway stopped and *confirmed* stopped →
state-database quiet period → AlphaClaw offline copy, then any in-quiesce
upstream attempt (the ladder in the next section) → quiet period released →
gateway relaunched → lock released. The Watchdog event log shows it as
`backup_quiesce: engaged`; the step row reads "pausing the gateway for a
consistent backup (AlphaClaw offline copy first)". A soft gate whose
lifecycle lock is busy or whose quiet barrier cannot be held does not pause
at all: only the backup rung degrades to the live ladder (`backup:
warning`); the apply's own serialization is unchanged. If the pause exceeds
the apply's own progress timeline, see the run ledger for which step is
stuck.

## Backup blocked by state-database contention

**What it means:** the upstream `openclaw backup create --verify` rung of
the pre-update backup (since #79 it runs only after the AlphaClaw offline
copy failed — paused, or live against the relaunched gateway) died because
*something else* held or wrote the SQLite state database while it ran. Issue #54 is the
canonical case: on 2026.8.2 and 2026.9.1-beta.1 the backup takes a
"legacy-audit migration lease" on `state/openclaw.sqlite` whenever a legacy
audit log exists (`logs/config-audit.jsonl`, `audit/system-agent.jsonl` or
`audit/crestodian.jsonl`); its lease writes use `busy_timeout 0`, so a
concurrent writer's RESERVED lock makes them fail at once:

```
[sqlite/transaction] SQLite transaction lock wait failed
Warning: the backup outcome could not be recorded: database is locked
timed out waiting for legacy audit migration lease migration.legacy-audit/filesystem-sqlite-boundary
```
or, mid-run, `… lease migration.legacy-audit/filesystem-sqlite-boundary was lost`.

The pinned 2026.7.1-2 has no lease: it finishes under the same lock and only
logs `Config health-state write failed: database is locked`.

**What AlphaClaw does (the #54 ladder, v0.9.71+; copy-first since v0.9.77,
#79 (c)):** an upstream failure is classified `lock_contention` (a
*retryable* kind, alongside `killed`; `spawn_error` is terminal) from the
last 20 lines of CLI output. The rungs, in the order they run — each one is
a `run.backup.attemptsDetail[] { rung, reason, quiesced, startedAt,
elapsedMs, bytes, kind, ok }` entry and a `backup_rung` event:

1. **AlphaClaw offline copy — first, unconditionally** — inside the pause
   (gateway stopped and confirmed, quiet period held), soft and hard gates
   alike (`runQuiescedAttemptLoop` → `runOfflineCopy`). It proves
   exclusivity first (stop confirmed, quiet barrier held, zero live openclaw
   processes, zero in-process handles, Linux `/proc/*/fd` scan clean),
   copies every `*.sqlite` with SQLite's online backup API, verifies each
   copy with `PRAGMA integrity_check`, skips the policy excludes inside
   workspaces (`node_modules`, `*.heapsnapshot`, `*.tmp`, `logs/**/*.gz` —
   measured and listed in the manifest's `excludes[]`), archives with
   `tar -I 'gzip -1'` into `openclaw-backup-<ts>-<opId8>.alphaclaw.tar.gz`,
   and runs the same gzip + manifest check every artifact gets. Bounded by
   `min(offlineCopyBudgetMs, quiesceRemaining())`; the copy never runs twice
   in one pause. Format:
   [docs/designs/backup-offline-copy.md](designs/backup-offline-copy.md).
   Events: `backup_offline_copy: started | completed | failed`.
2. **In-quiesce upstream `backup create`** — only after a copy that failed
   at a stage other than exclusivity, and only when the pre-pause
   **diagnosis** (`backup_diagnosis` event: journal mode, filesystem type,
   state bytes, copy / tar / excluded bytes, other live openclaw processes,
   predicted copy and upstream durations) says it fits what is left of the
   pause: `describeUpstreamVeto` rules it out for a rollback-journal state
   DB over 256 MB (`backup.upstreamVeto: rollback_journal_self_deadlock`),
   then `chooseBackupRung` (`openclaw-backup-ladder.js`, fail-closed)
   requires the predicted upstream time × 1.5 to fit the remaining pause
   and the tar set to be under 2 GiB (`predicted_fits`; otherwise
   `predicted_too_slow`, `copy_set_too_large`, `copy_set_unknown` or
   `prediction_unknown` — any unknown hands over to rung 3). Here
   `lock_contention` retries up to 2 times, backing off 15 s then 30 s, only
   while the quiesce deadline (sized `quiesceTimeoutMs +
   offlineCopyBudgetMs` = 15 min up front, bounded by the remaining phase
   envelope and shared with the copy) still fits
   the retry (`backup_contention: retrying | exhausted` events name the
   reason: `retries_exhausted`, `attempt_too_long`, `insufficient_budget`);
   a `killed` or `timeout` attempt hands over at once — the copy that used
   to be "next" already ran this pause.
3. **Relaunch + live ladder** — at most `kOpenclawBackupLiveAttempts` = 2
   upstream attempts against the running gateway. Reached by a **refused**
   copy (`offline_copy_refused`: another holder on a state DB — the paused
   rungs need exclusivity the live upstream does not, so the pause ends,
   the record carries `offlineCopy.next: { rung: "live", reason:
   "offline_copy_refused" }` and a `backup_rung: handed_over` event is
   booked), by a copy failure the prediction ruled the paused upstream out
   of, by exhausted in-quiesce retries, by timeouts and by live-file races
   (`vanished_file`). A soft gate that also fails here ends as `noBackup` +
   one warning; a hard gate as `409 backup_failed` naming both failures.
4. **Consented reuse** of a recent verified archive — see
   [Reusing a recent backup](#reusing-a-recent-backup-consent).

A hard-gate refusal (`409 backup_failed`) always names the newest surviving
archive (age and producer) in its hint, and the run record carries
`backup.attempts`, `attemptsDetail`, `quiescedAttempts`,
`contentionRetries`, `offlineCopy` (with `next`), `upstreamVeto`,
`diagnosis` and `exclusivityEvidence` so the ladder is reconstructible.

**`409 backup_in_progress` on writes:** while the quiet period is held,
AlphaClaw's own state-database writers answer `409 { code:
"backup_in_progress" }` with `Retry-After: 120` **before** anything is
mutated. The contract covers every pairing write (`POST
/api/pairings/:id/approve` and `/reject`, `POST /api/devices/:id/approve`
and `/reject` — a pairing write during the pause would put a live
`openclaw` process on the state DB, exactly the traffic the barrier
suppresses), channel-account adds (`POST /api/channels/accounts` clears the
id's stale pairing rows first, so the 409 lands before any env or config
change) and deletes, model-config and auth-profile saves (`PUT
/api/models/config`, `PUT`/`DELETE /api/models/auth/:profileId`), cron job
writes (run now, enable/disable, prompt and routing edits), the Codex
disconnect, and the watchdog test notification (`POST
/api/watchdog/test-notification` — a raw send during the pause would read
an empty pairing fallback and falsely report that nothing is paired).
Readers that would shell out to the CLI hold back too: `GET
/api/agent/sessions` serves the last-known list (even past its TTL) or
answers the same 409 instead of spawning `openclaw sessions`, whose open
state-DB handle would make the offline copy refuse the paused box. The
agent-admin CLI (`alphaclaw admin …`) sees the same 409 + `Retry-After`.
Status readers serve last-known data, the cron store falls back to
`jobs.json`, and notification flushes are held (never dropped) until the
barrier releases. Two writers finish instead of refusing when the barrier
begins *mid-flight* (config already changed): a channel delete clears the
account's pairing rows after release and reports
`pairingRowsCleanupDeferred: true`; the Codex OAuth exchange keeps the
redeemed tokens and answers `202 { deferred: true }` (the browser callback
checks the barrier before consuming its one-use state, so it renders a
"backup in progress" page and the login attempt stays valid to reopen).
`GET /api/models/config`, `/api/models/auth` and
`/api/codex/status` carry `unavailable: true, reason: "backup_in_progress"`
so configured credentials render as unavailable, not deleted. Retry after
the pause. Kill switch: `OPENCLAW_STATE_DB_QUIET=off` (deployment env only)
— the barrier then no-ops and the offline copy records `quiet: "disabled"`
in its evidence.

**Still failing?** `offline_copy_refused` on the run record
(`backup.offlineCopy.stage: "exclusivity"`, `attemptsDetail[0].kind`) means
another process held a state database open while the gateway was paused —
the record and the failure message name its `pid (argv)`, followed since
v0.9.81 by "argv names an OpenClaw executable or entry script". Before
v0.9.81 the matcher also fired on any path ARGUMENT under an `/openclaw/`
directory, so a log follower (`tail -c +1 -F
/tmp/openclaw/openclaw-2026-09-08.log`) or a pager on a file there refused
every copy in production; the matcher now judges the program position only
(the CLI/gateway binary, a JS runtime's OpenClaw entry script, a shell
wrapper named `openclaw`). If a refusal still names a process, it is a real
OpenClaw process — stop it and retry. Since the copy-first ladder (#79) a
refusal is never terminal on its own: the ladder fell through to the live
upstream attempt, so the 409 you see names THAT failure first and the refusal
after it. A `stalled` kind (v0.9.81) means the upstream `backup create`
printed nothing and wrote nothing for 3 minutes and was stopped — the
message quotes its last output lines and the run record keeps them
(`backup.lastOutput`); a `timeout` is the same after the full 10-minute
ceiling with bytes still moving. "Written so far" on the progress row is
read from wherever the pinned CLI stages: `<output>.<uuid>.tmp`
(2026.7.x/8.x), the `.openclaw-backup-publish-*` dot-dir and
`<tmpdir>/openclaw-backup-*` assembly dir (2026.9.x); once the archive is at
its final path the CLI is verifying it (silent by design) and the stall
policy stands down. A `spawn_error` means the backup CLI never
ran (PATH/permissions). Repeated `lock_contention` with nothing else on the
box points at the hypothesis below.

**Prove the backup works before the next update:** the Backups card's
**Back up now** runs the same ladder on its own (`POST /api/openclaw/backup`;
agent-admin `updates.backup`). It pauses the gateway like an update's backup
step, writes the archive, relaunches, and records a `kind: "backup"` run the
card summarizes as "Last manual backup: … — verified" (or the failure). A
failed update's card offers **Retry backup** for exactly this; when the
backup completes it offers **Retry update to X** with the original target.

### Rollback-journal / network-volume hypothesis

OpenClaw forces SQLite into rollback-journal mode (`journal_mode=delete`)
on `cifs`, `smb*`, `virtiofs`, `9p` and `nfs` mounts. In that mode a
reader's SHARED lock blocks the writer's COMMIT, and with the lease's
`busy_timeout 0` the upstream backup can block **itself** once the snapshot
read overlaps a lease renewal — deterministically for large databases. In
WAL mode it cannot. How to check on your box:

```sh
# 1. filesystem type under the state dir
findmnt -T /data/.openclaw -o TARGET,FSTYPE          # or: grep ' /data ' /proc/self/mountinfo
# 2. journal mode of the state DBs (read-only; harmless while the gateway runs)
node -e 'const {DatabaseSync}=require("node:sqlite");for(const p of process.argv.slice(1)){const d=new DatabaseSync(p,{readOnly:true});console.log(p,d.prepare("PRAGMA journal_mode").get());d.close()}' \
  /data/.openclaw/state/openclaw.sqlite /data/.openclaw/agents/*/agent/openclaw-agent.sqlite
```

The run record's `backup.diagnosis.{fsType,journalMode,stateBytes}` shows
what AlphaClaw saw. `journalMode: "delete"` with a state DB over 256 MB is
why, after a failed copy, the paused upstream attempt is vetoed
(`backup.upstreamVeto: rollback_journal_self_deadlock`) and the ladder hands
over to the live rung; the copy — which runs first regardless — is
unaffected (SQLite's online backup API is consistent in either journal
mode).

### Update refused: "needs Node …" (engines gate)

**What it means:** the target OpenClaw declares an `engines.node` range this
AlphaClaw's runtime does not satisfy — since 2026.9.3 that range is
`>=24.16.0 <25 || >=26.1.0` (Node 22 and 25 dropped; older runtimes truncate
SQLite text). The catalog row shows "Needs Node.js … — this AlphaClaw runs
Node …" with a disabled Apply, the "Update to latest" button skips that row,
and a direct `POST /api/openclaw/apply` answers `409 engines_unsupported`
naming the requirement and the running Node — all from ONE evaluator
(`lib/engines-range.js`), so the three never disagree. **Fix:** move AlphaClaw
to a runtime the range allows — rebuild the container image on `node:24-slim`
(Node 24.16+, the base since v0.9.80) and redeploy, or upgrade the host's Node
for an `npx alphaclaw` install; the row unlocks on the next catalog load. An
`engines.node` outside the supported grammar (`^`, `~`, wildcards) is never
enforced — npm's warn-only posture — so an exotic upstream spec cannot block
an install.

### Platform requirement: GNU tar and gzip

The "usable" check every archive must pass (`backup.usableCheck:
"manifest_ok"`) extracts the depth-1 manifest with
`tar -xzOf … --wildcards --no-wildcards-match-slash --occurrence=1
'*/manifest.json'`. Those are **GNU tar** long options; busybox tar and
BSD `bsdtar` (Alpine, macOS) reject them, and the check has no fallback.
The production image (`node:24-slim`, Debian) ships GNU tar and gzip, and
the container tier asserts it (`tar --version` must report `GNU tar`) so
the image is checked rather than assumed. Only the offline copy's *write*
step has a portable `tar | gzip -1` pipe — that path is dead-ended on a
non-GNU host because the verify that follows it fails anyway.

**Symptom on a self-built image without GNU tar:** every hard-gated update
(downgrade, dev switch, cross-channel apply) fails terminally at the
`verify` stage — the run record's `backup.attempts[].kind` is `verify` with
a `manifest.json not extractable: … unrecognized option` reason — and the
archive the upstream CLI had already verified is quarantined as
`<name>.unverified` (renamed, never deleted; keep-3 pruning spares the
newest). Consented reuse refuses every candidate for the same reason. Fix
the image (`apt-get install tar gzip` on Debian, `apk add tar gzip` on
Alpine — the `tar` package, not busybox's applet) rather than working
around the gate; a quarantined `.unverified` archive can be inspected by
hand with `tar -xzf`. A bsdtar-compatible extraction is a tracked
follow-up (TODOS "bsdtar-compatible manifest extraction").

## Restoring a backup

Restore is a **supervised manual procedure** — upstream ships no tar-restore
CLI (`backup sqlite restore` and `backup git restore` only), and AlphaClaw
deliberately does not auto-restore (a multi-GB extract at boot would need 2×
disk and would silently discard state written since the backup). The same
steps apply to both producers; only the manifest's asset shape differs.
Verified live (2026-09-02) for pin 2026.7.1-2 / stable 2026.8.2 / beta
2026.9.1-beta.1 archives restored onto each of those three lines: every
cell preflighted, passed `integrity_check`, and booted to `/healthz`.

**Which archive:** the newest verified one in `<root>/backups/openclaw/`
(last 3 kept). `GET /api/openclaw/backups` (or the Upgrade tab's Backups
card) lists them with producer, age, size and provenance:

| Name | Producer | Manifest assets |
|---|---|---|
| `openclaw-backup-<ts>-<opId8>.tar.gz` | upstream `openclaw backup create` | ONE asset, `kind: "state"`, `sourcePath` = the state dir, `archivePath` = `<archiveRoot>/payload/posix<stateDir>` (the whole tree) |
| `openclaw-backup-<ts>-<opId8>.alphaclaw.tar.gz` | `alphaclaw-offline-copy` | per-file assets: `kind: sqlite | config | file | workspace`, `archivePath` relative to `<archiveRoot>/` |

A `.unverified` suffix is a quarantined failed artifact — never restore it.
A `partial: true` run record (or `options.includeWorkspace: false` in the
manifest) means workspace files are **not** in the archive.

**How an archive earned `verified`** (`backup.usableCheck: "manifest_ok"` in
the run record): `gzip -t` passed, and the manifest **covers** this box's
state databases — either an asset names the database (the offline copy's
per-file assets) or an asset's `sourcePath` is the state dir / an ancestor
of the database, resolved against `manifest.paths.stateDir` (upstream's
single `kind: "state"` asset). The check reads exactly the archive's
top-level `<archiveRoot>/manifest.json` (depth 1 — a workspace's own
`manifest.json` deeper in the tree is never the one judged) and requires a
numeric `schemaVersion` plus an `assets[]` array. If you restore by hand,
apply the same reading: the manifest at the archive root is the authority,
and for an upstream archive the DB files are tar entries *under* the state
asset, not assets of their own.

**Steps:**

1. **Stop the gateway** and confirm it is gone. From the Watchdog terminal:
   `openclaw gateway stop` — on 2026.8.2 and later add `--force` (the CLI
   refuses non-interactive stops without it; the pin has no such flag).
   Confirm nothing listens on the gateway port and no `openclaw` process is
   live (`ss -ltnp | grep 18789`, `pgrep -af openclaw`). AlphaClaw's own
   restart is recorded *failed* (`incumbent_gateway_still_running`) when a
   stop did not take — do not proceed against a live gateway.
2. **Extract into an isolated directory**, never over the live state dir:
   ```sh
   mkdir -p /tmp/restore && tar -xzf <archive> -C /tmp/restore
   cat /tmp/restore/*/manifest.json
   ```
3. **Read `manifest.json`.** `paths.stateDir` is where the archive came
   from; for each `assets[]` entry, `archivePath` is the file or directory
   inside the extracted tree and `sourcePath` is where it belongs. Check
   `producer` (absent = upstream), `createdAt`, `options.includeWorkspace`
   and `skipped[]` so you know what is NOT in the archive.
4. **Move the current state dir aside** and place assets per the manifest
   (`<relative>` = `sourcePath` relative to `paths.stateDir`):
   ```sh
   mv /data/.openclaw /data/.openclaw.pre-restore-$(date +%s)
   mkdir -p /data/.openclaw
   # upstream: the single state asset is the whole tree
   cp -a "/tmp/restore/<archiveRoot>/payload/posix/<original stateDir>/." /data/.openclaw/
   # offline copy: every asset, e.g.
   cp -a /tmp/restore/<archiveRoot>/openclaw.json            /data/.openclaw/openclaw.json
   cp -a /tmp/restore/<archiveRoot>/state/openclaw.sqlite    /data/.openclaw/state/openclaw.sqlite
   cp -a /tmp/restore/<archiveRoot>/agents                   /data/.openclaw/
   ```
   Do **not** copy any `-wal`/`-shm`/`-journal` sidecar from the aside tree
   next to a restored database: both producers write self-contained
   databases (upstream consolidates its snapshot; the offline copy uses the
   online backup API and lists the sidecars under `skipped[]`).
5. **Preflight with the version that will run** (2026.8.x and later):
   ```sh
   openclaw database preflight /data/.openclaw/state/openclaw.sqlite --json
   ```
   `status: "exact"` or `"migration-required"` (exit 0) = that version reads
   the restored state (a migration runs at its next start);
   `"incompatible"` (exit 1) = pick a version that can read it (a newer
   line's database restored onto an older one — the #54 direction);
   `"indeterminate"` = the file has sidecars; consolidate first
   (`VACUUM INTO` a copy, or remove the empty sidecars you created by
   opening it). The pin 2026.7.1-2 has no `database` command — on the pin
   go straight to step 6 and watch for exit 78.
6. **Integrity check** each restored database (read-only):
   `node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare("PRAGMA integrity_check").get())' /data/.openclaw/state/openclaw.sqlite`
   — expect `ok`. Remove the empty `-wal`/`-shm` files this open leaves.
7. **Start the gateway** (Watchdog tab → Restart, or restart AlphaClaw) and
   watch `/healthz` (restart ready budget: 5 min by default — `GATEWAY_RESTART_READY_TIMEOUT`, 30–480 s) plus the Watchdog tab; the boot
   reconciler runs the official migration when the preflight said one is
   required.
8. Keep the aside tree until the box has been healthy through one full
   stabilization window (24 h).

**SQLite-only alternative (2026.8.1+):** when only a database — not config
or sessions — has to go back, `openclaw backup sqlite restore` against the
single copied database file (see the CLI's `--help`; the offline copy's
`state/openclaw.sqlite` is a standalone online-backup file that command
accepts).

## Reusing a recent backup (consent)

**What it means:** the fresh backup ladder (offline copy first → in-quiesce
upstream attempts when predicted to fit → live ladder) failed with a
*retryable-class* cause (`lock_contention`, `killed`, `timeout`, `stalled`,
`vanished_file`, `window_exhausted`; a refused copy hands over to the live
ladder rather than ending it, so `offline_copy_refused` is never the cause
an offer follows) on a hard gate, but a verified, non-partial archive from
the last 24 h exists and nothing has been applied, activated or migrated
since it was taken. The `409 backup_failed` then carries
`reusableBackup: { file, at, ageMs, sha256, producer }` and the Upgrade tab
offers "Retry using that backup".

**What consent does:** resending the apply with
`allowBackupReuse: { sha256 }` (the offered digest — a bare `true` or a
string is `400`) authorizes AlphaClaw to proceed with THAT archive if — and
only if — the full fresh ladder fails again. The archive is re-verified on
an open descriptor (`gzip -t`, manifest lists the state DBs, sha256 over
the fd, size/inode unchanged) within 5 min; a mismatch makes it ineligible.
The run then records `backup.reused: true` with `reusedAgeMs`,
`freshAttemptFailure` and the original `at`; the step reads "fresh backup
failed (<kind>) — proceeding with the verified backup from <age> ago; state
written since is not in it"; an important notification says the same; the
event log gets `backup_reused`; the archive is pinned against keep-3
pruning while the migrating run is fenced. Humans only: the agent actor's
`updates.apply` is `denied` for any body carrying `allowBackupReuse` and
the route 403s it. Never offered for `no_command`, `refuse_overwrite`,
`enospc`, `verify`, `no_artifact` or `spawn_error` — those are box problems
an old archive would paper over.

## Backup: continue without a backup (consent)

A failed apply can offer **Continue without a backup** when its target is
already prepared and verified, and only backup availability failed. This
includes eligible cross-channel changes, downgrades and migrating stable
updates. A new or moving dev build still needs a verified backup before
preparation; a waiver can reuse only an already built checkout at an exact
verified commit.

Fixing the backup remains an option. To accept its absence, open the failed
run's confirmation, review the target and check **I understand: no verified
backup exists; changes may leave no safe rollback path**. The dashboard obtains
a ten-minute, single-use confirmation bound to that failed run, your current
sign-in session, the executing build, the prepared target and the database
facts. It reuses that verified preparation instead of repeating the exhausted
backup ladder. A changed build or database, an expired confirmation, or an
AlphaClaw restart requires a fresh review; the UI never treats that refusal
as a successful update.

The human-only endpoint is
`POST /api/openclaw/runs/:operationId/backup-risk-consent`. The next apply must
carry both `confirmNoBackup: true` and the returned `confirmNoBackupToken`.
A bare boolean does not authorize a waiver. Tokens never appear in run logs,
event streams or agent responses, and agent requests cannot issue or use them.

Consent waives missing recovery protection only. Another database owner,
insufficient disk, incompatible or unverified schemas/builds, corrupt state,
blocklists and gateway holds remain blockers. Lifecycle ownership and all
bound facts are checked again before consuming the confirmation and recording
the update. The run stores `backup.noBackupConfirmed: true` and its originating
failed operation; the existing warning, notification and audit event record
that the update proceeded without a verified backup. A migration may then
leave no compatible build to roll back to.

## Restart did not take effect (incumbent gateway)

**What it means:** a gateway restart (manual, API, agent-admin, env save,
repair) reported **failed** with `reason: "incumbent_gateway_still_running"`
(`code: restart_incumbent`, event `restart_incumbent`, notification
`restart-incumbent-<opId>`). AlphaClaw only calls a restart successful when
the OLD gateway is proven gone — the port was observed down, or a new
gateway pid appeared with every pre-stop pid exited. Otherwise the gateway
that answered `/health` is the incumbent, still running the OLD config and
env; the restart-required banner stays up and no autotune stamp is taken
from the child that never launched.

**Why it happens:** since 2026.8.2 the OpenClaw CLI refuses
`openclaw gateway stop` from a non-interactive shell unless `--force` is
passed ("re-run with --force"). AlphaClaw passes `--force` only when the
installed CLI *advertises* it (probed once per installed version via
`gateway stop --help`; the 2026.7.1-2 pin has no such flag; an unknown probe
result retries on a short TTL). An externally supervised gateway (systemd,
a manual `openclaw gateway run`) is the other common incumbent.

**Next steps:** the operation record's evidence names the pids and whether
the CLI refused. Stop the incumbent yourself (`openclaw gateway stop
--force` on 2026.8.2+, or the external supervisor), then restart from the
Watchdog tab. The backup quiesce records the same evidence
(`stopEvidence: { method, childExited, portReleased, cliRefused }`) and the
offline copy refuses to run when the stop was not confirmed.

## Gateway is up but not ready

**What it means:** the watchdog reports `readiness: "not_ready"` with a
`readinessReason` naming the failing components (or `ready:false`; event
`readiness_degraded`, `degradedReason: readiness_failing`, ledger rows
`health_check/ok {readinessPending: true}` collapsed into one row plus a
count, notification "🟡 Gateway is up but not ready — <components>" once per
incident). The port answers and `/health` is green, but OpenClaw's own
`/readyz` verdict says the gateway is not ready — one or more components
(secrets, a channel, a plugin) have not come up, or the body says
`ready: false` outright. Since v0.9.75 AlphaClaw treats this as degraded, not
recovered: no "Gateway running again" notice, the incident stays open (a
`gateway_readiness` incident opens when none is), the release-channel
acceptance hook is NOT credited (a green-`/health`, failing-`/readyz` build
cannot be promoted to last-known-good), and a pending replacement is not
verified. Readiness alone never triggers `doctor --fix` or a restart — the
degraded-repair counter counts liveness failures only.

Since #87 the verdict is OpenClaw's, not AlphaClaw's. The `eventLoop`
diagnostic in the `/readyz` body ("event loop under pressure" in the
timeline, `event_loop_pressure` rows, `eventLoopDegraded` on status) is
telemetry and never opens a readiness incident on its own — upstream
documents that it "does not change the readiness result by itself"; the
Watchdog tab's gateway-health card shows pressure under a neutral LOAD label,
never the DEGRADED badge, unless `/readyz` components are also failing. Only
the newest COMPLETED probe writes a verdict, so a slow older probe (or a Doctor
run started for an earlier degradation) can no longer reopen an incident the
gateway already recovered from; a superseded probe leaves one
`[watchdog] probe #N (<source>) superseded …` console line and nothing else.

**Read the two status fields first.** `GET /api/watchdog/status` carries
`readinessProbe` (how the last `/readyz` read went: `ok | unconfigured |
unsupported | unavailable | timeout | malformed`) and `readinessStatus` (what
the body said: `started | starting | draining`). With `readiness` they
separate five situations that used to all read as "not ready" or "unknown":

| `readiness` | `readinessProbe` | `readinessStatus` | Meaning | Timeline / card |
|---|---|---|---|---|
| `unknown` | `unconfigured`, `unsupported` (404/405/501) or `null` | — | `/readyz` was not consulted, or this gateway does not serve it. Recovery is decided from `/health` alone; nothing is logged. | plain "up" |
| `not_ready` | `ok` | `starting` or `draining` | **Transitional** — the gateway itself says it is still coming up (or shutting down). NOT an incident, NOT degraded: no notice, no `degradedReason`, no acceptance credit; the watchdog re-probes every 5 s (the bootstrap loop, or a single-shot `readiness_recheck` probe outside it) and a pending replacement is not certified yet. Bounded by the ready budget (`GATEWAY_RESTART_READY_TIMEOUT`, default 300 s): past it the same body becomes a real not-ready with `readinessReason: "starting did not complete within 300s"`. A liveness flap in the middle of the phase neither restarts that budget nor lets the next `/readyz` probe error announce recovery (the hold below keeps this row's flavour: health stays healthy, the 5 s cadence continues). An explicit `ready: true` beside such a status is not transitional — it is ready, and the status is telemetry only. | "up, still starting" / "up, draining"; card reason "Up — channels still starting." / "Up — draining." |
| `not_ready` | `ok` | `started` or `null` | **Real not-ready** — `/readyz` names failing components or says `ready: false`. This is the incident described above; `readinessReason` names the components. The detached Doctor may add ONE `readiness_advisory` row ("doctor: <checkId> (<severity>)") when OpenClaw's Doctor reports a runtime secret failure (e.g. `gateway.probe_auth_secretref_unavailable`) — evidence, never a trigger; it runs at most once per failing-component key per 10 min and at most once per 2 min per gateway generation regardless of key, so neither a flapping `/readyz` nor rotating component names can spawn a Doctor on every transition. | "up, not ready"; Running with issues |
| `not_ready` (or `unknown` right after a liveness flap) | `unavailable`, `timeout` or `malformed` | last value | **Probe error while not ready — recovery held.** The last `/readyz` CONSUMED in this gateway generation said not ready — the open degradation episode, which survives a liveness flap (a failed `/health` in between resets `readiness` to `unknown` but not the episode) and ends only with a ready body, a fail-open or a gateway generation change (a relaunch starts a new episode); or a `starting` / `draining` body still inside its budget, whose clock survives a flap the same way (that hold keeps health healthy and the 5 s cadence instead of degrading) — and this one could not be read (connection refused, 5 s timeout, unparseable body). The watchdog does NOT assume recovery: the incident stays open, health stays degraded and the 5→30 s retry ladder keeps probing; one `readiness_probe_error {kind}` row per kind transition (5-min floor per kind; the floor survives a liveness flap and resets with the gateway generation). Bounded by the same ready budget, after which it fails open with `readiness_probe_error {kind, recoveryAssumed: true, heldMs}`, readiness becomes `unknown` and the degradation episode is closed (`readiness_degraded ok {recovered, assumed, kind}`) — the same components afterwards open a new incident. The recovery notice then reads "🟢 Gateway running again — readiness unverified" (a ready body would have given the plain notice). | "up, readiness probe <kind>" |
| `unknown` | `unavailable`, `timeout` or `malformed` | — | Probe error with NO open degradation episode in this gateway generation (a fresh or relaunched gateway, or one whose last consumed `/readyz` was ready): fails open as before — one `readiness_probe_error` row, recovery is not blocked. | plain "up" |

**Why it happens:** a channel token that fails auth, a plugin whose
provider is unreachable, a secrets backend that is slow to answer (a beta
gateway STARTS degraded instead of refusing when a SecretRef cannot be
resolved — the `readiness_advisory` row names the finding). Upstream keeps
serving the rest of the gateway meanwhile, which is why the port and
`/health` look fine. A `starting` body that persists after a relaunch
usually means a slow plugin or channel init; a `draining` body means
OpenClaw is shutting the gateway down (a restart it requested, or an
operator stop) and a relaunch will follow.

**Next steps:** read `readinessReason`, `readinessProbe` and
`readinessStatus` on `GET /api/watchdog/status` (or the gateway card's reason
line) and check the named component in the gateway log; a `readiness_advisory`
row in the incident timeline points at the Doctor finding (`checkId`,
severity, a sanitized message). The incident closes on its own on the first
probe where `/readyz` is green again — that tick emits the normal recovery
row and notice. While the timeline says "up, readiness probe unavailable" or
"… timeout", check that the gateway's `/readyz` URL is reachable from
AlphaClaw (auth, port, TLS) — the hold releases the moment one `/readyz` is
read, whatever it says. Event-loop pressure rows alone ("event loop under
pressure: event loop delay") are a load signal, not a readiness failure:
check recent gateway restarts and workspace size (README "Health checks" ops
note).

## Control UI shows "Styles failed to load"

**What it means:** the OpenClaw Control UI (the dashboard AlphaClaw opens at
`/openclaw`) shows the banner *"Styles failed to load, so the page may look
broken"* with a Reload button, and text renders in system fonts. Upstream
shows it when a `<link rel="stylesheet">` fired an `error` event before the
page finished loading, or when the entry stylesheet's sentinel
(`--openclaw-css-ok`) is missing at `load`. It tries one automatic reload per
build first, which is the flash-reload users see before the banner.

**Why it happens:** before v0.9.83 AlphaClaw mounted the gateway's
ROOT-served UI under `/openclaw` by stripping the prefix off every proxied
request. The gateway therefore stamped an empty base path into the page
(`<html data-openclaw-control-ui-base-path="">`) and the UI — which resolves
every resource URL from that attribute, not from the page URL — fetched its
fonts, themes, `sw.js`, bootstrap config and avatars from AlphaClaw's root,
where they 404'd. The font stylesheet's `error` event is what trips the
banner. Since v0.9.83 `ensureGatewayProxyConfig` writes
`gateway.controlUi.basePath: "/openclaw"` into `openclaw.json` at boot, the
proxy forwards `/openclaw*` verbatim, and the gateway restarts itself when
the key lands (OpenClaw's default `gateway.reload.mode: "hybrid"`).

**How to check:**

- `curl -I -b 'setup_token=…' https://<alphaclaw>/openclaw/fonts/instrument-sans.css`
  answers `200` with `content-type: text/css`. A `404` means the gateway is
  still serving the UI from its root; a `302 /login.html` means the cookie
  is missing.
- `GET /openclaw/` (with the cookie) returns HTML whose `<html>` tag carries
  `data-openclaw-control-ui-base-path="/openclaw"`. The gateway stamps this,
  not AlphaClaw — an empty value means the gateway has not picked up the key.
- The boot log has `[alphaclaw] control_ui_mount=basepath basePath=/openclaw`
  (or `control_ui_mount=legacy basePath=(removed)` under the kill switch).
- `openclaw.json` has `gateway.controlUi.basePath: "/openclaw"`.

**Next steps:** if the key is in `openclaw.json` but the page is still
stamped with an empty base path, the gateway has not restarted since the key
was written — an externally supervised gateway (systemd, a manual `openclaw
gateway run`) with hot reload off is the usual case. Restart it once; the
managed child is restarted by AlphaClaw.

An expired AlphaClaw session behaves differently for resources and documents
on purpose: a Control UI resource (font, chunk, theme, `sw.js`, bootstrap
config, avatar, `/assets/*`) gets `401 {"error":"Unauthorized"}`, while a
document navigation (and the UI's `HEAD` recovery probe) still gets the
`302 /login.html` redirect. The pinned Control UI service worker caches any
`ok` response under the requested URL — a redirected 200 login page for a
font would be served for that font forever, even after logging in — and a
browser refuses HTML as a stylesheet, which is the same banner by another
route. So a font `401` on an expired session is expected; reload the page
and log in.

After a whole-file config restore (rollback, round-trip, migration gate) the
key is re-applied and verified by re-reading `openclaw.json`. A miss is not
fatal: the boot report / notification carries the warning *"control UI mount
repair failed after the … config restore"* and the log has the fixed code
`control_ui_mount_repair_failed source=<source>`; the next AlphaClaw boot
re-applies it.

**Kill switch:** `ALPHACLAW_CONTROL_UI_MOUNT=legacy` in the deployment
environment (never `.env`; read at process start) restores the pre-0.9.83
prefix-strip mount: boot removes the managed `gateway.controlUi.basePath`,
the gateway restarts in root mode and the proxy strips the prefix again (the
banner returns — that is the known legacy state). A plain code revert is NOT
enough: old AlphaClaw strips `/openclaw/x` to `/x`, which a gateway still in
base-path mode does not recognise as a Control UI path and answers `404` —
the whole dashboard disappears. Set the switch, or also delete the key from
`openclaw.json` and restart the gateway.

## Another process owns the state directory

**What it means:** a gateway AlphaClaw launched exited with code 1 and its
stderr carried OpenClaw's ownership wording. Since v0.9.75 the watchdog
classifies that exit (`classifyOwnershipConflict`, pattern verified against
2026.7.1-2 and 2026.9.1-beta.1) instead of booking a crash, and corroborates
it with an incumbent probe. Two cases:

- **Gateway conflict** (`gateway_conflict`: "another gateway instance is
  already listening", "gateway already running (pid N)", "failed to acquire
  gateway lock at", "owns state-lifecycle", "existing gateway did not become
  healthy"). If the incumbent on the port answers `/health`, the contender's
  exit is benign (`incumbentConflict: true` row, no crash count, no "went
  down" notice) and the incumbent's identity is adopted (`servingPid`,
  `supervisionMode: "adopted"`). If nothing healthy answers, the watchdog goes
  `degraded` with `degradedReason: gateway_conflict_unhealthy`, opens an
  incident and sends one notice ("🔴 Another gateway (pid N) holds the state
  directory but is not healthy — not relaunching into the conflict"). The
  holder then gets a cold-boot grace (`GATEWAY_RESTART_READY_TIMEOUT`, the
  same budget a relaunch gets to become ready; `incumbentGraceUntil` in the
  status, one `repair/<source>/skipped {incumbent_startup_grace}` row) —
  OpenClaw takes the lock before `/health` is green, and a cold boot can run
  minutes. If it is still not healthy after that, repair treats it as the
  problem: after the sustained-failure gate it runs `doctor --fix`,
  re-probes the port (a holder that answers healthy by then is adopted, not
  stopped) and replaces a still-unhealthy holder through the verified
  cold-restart path (`intent: "replace"`, the same `gateway stop` →
  `--force` → ready-wait that manual restarts use, with the
  incumbent-still-running verdict above). A refused stop counts as a repair
  attempt and the automatic ladder waits for a recovery before trying again —
  if you stop the wedged gateway yourself (the notice names its pid), the
  watchdog sees there is nothing left to replace and relaunches on its next
  probe (`repair/<source>/ok {latchLifted: true}`); the grace ends early the
  same way when the holder is gone.
- **State-writer conflict** (`state_writer_conflict`: "state directory is
  locked by <role> (pid N)", "another embedded OpenClaw state writer is
  active", "failed to acquire gateway state ownership"). The holder is not a
  gateway — an embedded agent, a backup, a migration — so neither Doctor nor
  a cold restart can free it. The watchdog goes `degraded` with
  `degradedReason: state_writer_conflict`, notifies once ("🟡 Another
  OpenClaw process (<role>, pid N) holds the state directory — the gateway
  will be relaunched once it releases") and relaunches on the crash-restart
  backoff ladder only; it never runs `doctor --fix` or `gateway stop` for
  this case.

**Why it happens:** OpenClaw acquires the state-ownership lock BEFORE the
port bind, so a losing contender emits lock wording, never `EADDRINUSE` —
the port-only duplicate-launch detector could not see it. Typical triggers:
an externally supervised gateway (systemd, a manual `openclaw gateway run`),
a backup or migration running under a different uid, or two AlphaClaw
containers sharing one volume.

**Next steps:** the ledger row carries the classification, pid and role
(stderr stays in the row, out of the notification). Find the holder
(`ps -o pid,ppid,cmd -p <pid>`; the evidence also lists live openclaw
processes), stop it if it should not be there, and the next degraded retry or
backoff relaunch recovers. Upstream does not name the coordinator holder
itself (TODOS "File the two upstream openclaw reports").

## Repair skipped: lease expired

**What it means:** a ledger row `repair/<source>/skipped` or
`restart/<source>/skipped` with `reason: "lease_expired"` (launch detail
`lease_expired` when the abort happened immediately before the spawn). The
lifecycle-lock hold that the repair, crash relaunch, medic or config-change
retry was running under expired — or was force-released — while `doctor
--fix` or a ready-wait was still in flight, and by the time the holder
reached its launch step another operation (a user restart, a channel apply,
boot) had taken the lock. Since v0.9.75 the holder asks the lock whether it
still owns it (`release.isValid()`) after every await and immediately before
every spawn, and when it does not it books this row and stops: nothing is
launched, lifecycle, repair attempts and crash timestamps are untouched, and
the successor's operation proceeds alone. Before this change the expired
holder would have launched a second gateway into the successor's restart.

**Why it happens:** the repair hold is leased at the Doctor ceiling plus the
restart budget (about 20 minutes by default: the 10-minute `doctor --fix`
ceiling plus the ~10.5-minute restart operation budget derived from
`GATEWAY_RESTART_READY_TIMEOUT`), so expiry during a repair should be
rare; the common cause is a very slow `doctor --fix` (plugin preflight
against an unreachable registry) coinciding with a manual restart or
apply. The work already underway is not cancelled — a Doctor that
outlives its lease still finishes writing `openclaw.json` (cancellation
signals into the Doctor runner are a TODOS item).

**Next steps:** nothing to repair — the row is informational. Check the
operation that took the lock (the Watchdog tab's operation badge or
`GET /api/watchdog/status`), and if the gateway is still down after it
finishes, the next degraded probe re-arms repair normally. If the rows
recur, raise `GATEWAY_RESTART_READY_TIMEOUT` (the restart budget half of the
lease) or look at why Doctor is slow.

## Gateway prelaunch hook

**What it means:** `ALPHACLAW_GATEWAY_PRELAUNCH_HOOK=<absolute path>`
(deployment env only) runs an operator-installed executable before **every**
gateway launch and aborts the launch when the hook is refused or fails
(`GatewayPrelaunchHookError`, codes such as `not_root_owned`, `in_tree`,
`symlink`, `writable_by_others`, `nonzero_exit`, `timeout`). The watchdog records a
`prelaunch_hook` event, an important notification is sent, and the gateway
stays down with `degradedReason: prelaunch_hook_failed` until the next
successful launch.

**Requirements the check enforces:** absolute path; realpath outside the
AlphaClaw root and the OpenClaw state dir; regular file owned by `uid 0`
(the deployed agent shares AlphaClaw's uid, so owner=self proves nothing);
execute bit set; not group- or world-writable; no symlink (`O_NOFOLLOW`);
executed by inode (`/proc/<pid>/fd/<fd>` on Linux — the AlphaClaw parent's
pid, not `/proc/self`, which fails with ENOENT for `#!` scripts; elsewhere
the realpath is re-checked against the inspected inode) with a minimal env
(a fixed system `PATH` of `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
— never AlphaClaw's own — plus `HOME`, `OPENCLAW_STATE_DIR`,
`OPENCLAW_CONFIG_PATH`, `ALPHACLAW_ROOT_DIR`; never gateway secrets);
120 s budget.

**Next steps:** read the hook's stdout/stderr in the AlphaClaw process log,
fix the file (`chown 0:0`, `chmod 0755`, move it out of the tree) or the
script, then restart the gateway from the Watchdog tab. Unset the variable
to turn the hook off — there is no in-tree fallback path. Full reference:
README "Gateway prelaunch hook".

## Rollback fencing after a DB migration

Rolling back to an older version after the newer one migrated the state DB
is fenced: the older binary cannot verify state written by the newer one.
The first rollback attempt answers `409 rollback_requires_confirmation`,
and its `backupFile` field names the verified pre-update backup to
**restore first** (see [Restoring a backup](#restoring-a-backup)). The
response also says whether that file still exists (`backupFileExists`),
whether it was a partial archive (`backupPartial`, workspace files
excluded) and whether it was a consented reuse (`backupReused` with
`reusedAgeMs` — state written since is not in it). The UI then shows a
second-stage confirm dialog naming that backup with those caveats;
confirming (`confirmDataRisk: true`) proceeds with the rollback anyway —
data written by the newer version may be unreadable.

## `alphaclaw diagnose`

The first move on a sick box. `alphaclaw diagnose` (run in the container,
server up or down) prints one markdown bundle of every piece of boot
evidence on the volume: the AlphaClaw version stamp, the last three boot
reports plus the pinned incident report and their verdicts, the channel-state
summary, a fresh pidfile decision, every state DB's `user_version` against
the installed build's supported schema, the last three incidents with their
classified `cause`, recent update runs, the restart-operation record,
`gateway-state.json`, the backups directory (including `.tmp` /
`.unverified` debris) and the boot-spine lines of `process.log`. Each
section is stamped `live` (computed in this process), `disk` (read from
the volume) or `unavailable` with the reason, so a corrupt file never hides
the rest, and the bundle is secret-redacted before it is printed. `--json`
prints the same bundle as one JSON line. It creates nothing on the volume.

The running server serves the same bundle at `GET /api/diagnose` (JSON
envelope `{ ok, bundle }`; `?format=text` for the markdown) with the live
watchdog status, channel info and incident rows the CLI cannot see; the
agent-admin op is `watchdog.diagnose` (tier `safe`). Paste the markdown
into the incident. A `current boot verdict` other than `consistent` names
the inconsistency (`installed_not_expected`, `pidfile_contradiction`,
`state_db_unreadable`, …) and the boot report that carries it is described
below.

### First five minutes after a deploy

1. `alphaclaw diagnose` prints a `current boot verdict` of `consistent`.
2. `<root>/.openclaw/.alphaclaw/alphaclaw-server.pid` has `format: 2` (the
   legacy claim converged, or the new process wrote its own record).
3. `<root>/.openclaw/.alphaclaw/alphaclaw-version.json` names the AlphaClaw
   version you just deployed.
4. No `*.tmp` under `<root>/backups/openclaw` (the boot sweep ran).
5. The watchdog phase is healthy and the incidents timeline shows this
   boot's `boot` event with its verdict.

## Version mismatch — running ≠ expected

**What it means:** the OpenClaw tree under `node_modules/openclaw` (running /
installed) is not the build the channel state recorded (`applied.version`,
else the `package.json` pin) — `getChannelInfo().installedDiverged`. Since
issue #76 this is a first-class signal instead of an unexplained crash loop:
`GET /api/watchdog/status` shows `versionMismatch: { expected, running,
source, detectedAt }` and `degradedReason: "version_mismatch"`, a
`version_mismatch` incident opens (or an open one escalates), every
notification is prefixed `⚠️ Version mismatch: running <r>, expected <e>`,
and the boot report's `verdict[]` carries `installed_not_expected`. Typical
causes: an AlphaClaw redeploy whose `npm install` rewrote
`node_modules/openclaw` to the pin while the channel state says a beta or
stable overlay was applied (the 2026-09-06 incident), or an activation that
was interrupted mid-copy. A pin bump npm has not reconciled yet is NOT a
mismatch (`state.pinLag`, bounded to 3 boots / 24 h).

**What AlphaClaw does on its own:**

- At boot, `reconcileInstalledAtBoot` re-activates the recorded build before
  anything can run from the wrong binary (no `doctor --fix`, no launch), then
  the launch-compatibility gate checks that the installed build can open every
  state database (`PRAGMA user_version` vs the build's declared schema). A
  build that cannot is HELD — `gatewayHold.reason: version_mismatch` or
  `state_db_unreadable`, with the operator prose in `gatewayHold.detail` —
  instead of launched. The boot log line is `launch gate: …`; the event row
  is `launch_compat_gate/held`; the notification and `alphaclaw diagnose`
  name the hold. The gateway card and restart/repair refusals use reason-aware
  advice: migration holds point to **Retry migration**; structural holds point
  to **Re-activate recorded build** and the diagnose bundle. Retrying a
  migration cannot clear a structural hold. The Upgrade banner also shows the
  hold's `detail`; follow the next steps below.
- At runtime, a crash whose stderr names a version-family cause (`… uses newer
  schema version N; this build supports M`, `Legacy exec approvals exist at
  …`, `plugin requires plugin API …`) and is corroborated on disk (the DB's
  actual `user_version`, the diverged tree, the file) never relaunches the
  same binary: the structural repair re-activates the recorded build (or the
  newest local build that can read the databases), relaunches and proves
  health. The relaunch step itself refuses a binary that cannot open the DB
  (`restart/<source>/skipped {reason: version_mismatch}`).
- `doctor --fix` (repair and the startup medic) and the pre-update backup run
  from a build that can read the CURRENT databases, or are skipped
  `version_mismatch` — never from the `openclaw` on PATH.

**Next steps:**

1. `alphaclaw diagnose` — the channel-state section prints installed vs
   expected, the boot verdict, and each DB's `user_version` against what the
   installed build supports.
2. Upgrade page → **Re-activate recorded build** (`POST
   /api/openclaw/reconcile-installed`, humans only, agent-admin tier
   `dangerous`; the action renders only while the tree is diverged).
   Refusals: `409 booting` / `apply_in_progress` (the restart blockers) and
   `gateway_held` (a migration-class hold — Retry migration first);
   `disabled` (`OPENCLAW_RUNTIME_RECONCILE=off`); `dev_channel` (a dev apply
   has no recorded package build); `no_expected_version`; `incumbent_running`
   (a gateway is serving and could not be stopped confirmed — the tree is
   never removed from under a live gateway); `target_incompatible` (the
   recorded build itself cannot read the databases — the chooser then picks a
   local build that can, recorded as `applied.reason: "schema_recovery"`, or
   answers `no_bootable_version`); `insufficient_disk` (needs 1.2 × the
   overlay's bytes); `activation_failed` / `verify_failed` (the swap failed
   after the old tree was removed — a hold is set and the notification and
   `boot-report.json` name it; re-run, or apply a version); `overlay_missing` (no complete local copy of the recorded build — apply the version again so the overlay is re-downloaded); `state_db_quiet` (a backup holds the quiet barrier — retry in about two minutes); `state_corrupted` (the channel-state file is unreadable — `alphaclaw diagnose` reports it); `lease_expired` (the lifecycle lease lapsed mid-reconcile — nothing was swapped; re-run).
3. Or apply a version whose schema can read the databases from the Upgrade
   page — the apply preflight probes the TARGET build, so it keeps working
   during a mismatch.
4. Kill switches (deployment env only, README env table):
   `OPENCLAW_RUNTIME_RECONCILE=off`, `OPENCLAW_LAUNCH_COMPAT_GATE=off`,
   `OPENCLAW_CRASH_CAUSE_LADDER=off`. Each keeps recording and stops acting;
   the boot-time re-activation of a diverged tree is not switchable.

## Auto-repair paused

**What it means:** the watchdog stopped relaunching and repairing on its own
because doing so was provably useless: either (a) a crash was classified with
a version-family cause AND corroborated on disk, and every structural rung —
re-activate the recorded build → undo a stray config restore → pick a local
build that can read the databases / rename a legacy `exec-approvals.json` →
relaunch — was refused or failed (`reason: structural_repair_failed`), or
(b) the replacement child the ladder launched died inside its 60 s launch
window twice with the same crash fingerprint (`replacement_exited_twice`).
It is NOT the crash-loop pause (3 exits in 5 min — `restartAfterCrash`'s
backoff relaunches continue) and NOT the repair budget
(`repair/<source>/skipped {repair_attempts_exhausted}` — Doctor stops,
relaunches continue). The notice (`🔴 Auto-repair paused`) names `Cause:` —
or `Suspected cause:` when nothing on disk corroborated the stderr —
`Running … · Expected …`, `DB schema: state N (running build supports M) ·
agent …`, `Last plan: <rung> → <outcome>` and the remediation. The pause
survives restarts (`auto-repair-pause.json` under the managed dir, keyed by
installed version + fingerprint) so a platform reboot does not replay the
ladder; the incident is `critical`, and the gateway card's `down` reason
reads the same cause.

**Remediation by cause:**

- `state_schema_too_new` / `agent_schema_too_new` — the running build is
  older than the schema on disk. Re-activate the recorded (newer) build
  (Upgrade → Re-activate recorded build) or apply the version that wrote the
  schema; if no local build can read it, restore the newest verified archive
  ("Restoring a backup") or apply a newer version.
- `state_schema_migration_failed` — the build refused to migrate the state
  DB. Restore the backup taken before the apply, or roll forward to a build
  whose migration succeeds.
- `legacy_exec_approvals` — `<openclawDir>/exec-approvals.json` exists on a
  sqlite-era build (2026.8+, issue #23). The rename rung should have handled
  it; if it could not (permissions), move the file aside yourself
  (`exec-approvals.json.stray-<ts>`) and resume.
- `plugin_api_too_old` / `cli_startup_crash` — the installed tree is not the
  recorded build; re-activate it (above).
- Anything under `Suspected cause:` — the classifier matched stderr but no
  independent fact agreed. Treat the stderr as a hint: read the incident's
  crash rows (`cause`, `fingerprint`, `corroborated`) and `alphaclaw
  diagnose`.

**Resuming:** the pause clears by itself when the installed version changes
(a reconcile or an apply) or when a gateway passes the 120 s acceptance hold
(consecutive healthy, identity-clear probes — one green probe is not enough).
To retry once with nothing changed: `POST /api/watchdog/repair
{ "force": true }` — one attempt; the same fingerprint re-latches. A manual
restart or a blocklist Clear does not clear it. Kill switch:
`OPENCLAW_CRASH_CAUSE_LADDER=off` (classification still records; the ladder
and the pause never act).

## Where the evidence lives

- **Boot reports:** `boot-report.json` under the OpenClaw managed dir
  (`<root>/.openclaw/.alphaclaw/`), rotated to `boot-report.1.json` /
  `boot-report.2.json` by each boot's bin phase — what the bin phase saw
  (declared pin, applied channel build, installed tree, overlay, pidfile
  decision, sync action) and what the server phase recorded (state DB schema,
  config hash, reconcile outcome, `verdict[]`). `boot-report-incident.json`
  pins the first report with a non-empty verdict so a restart loop cannot
  rotate it away. `boot-report-refused.json` holds the last start that exited
  because a live server provably owned the directory — written outside the
  ring so a refused second instance never evicts the live server's report.
  The report is the diagnostic superset; the channel state's `lastBoot` stays
  the authority for the action the boot took.
- **AlphaClaw version stamp:** `alphaclaw-version.json` (same dir) — the
  AlphaClaw version and commit that booted, first/last boot time, boot count
  and the previous version; the boot banner (`[alphaclaw] AlphaClaw <version>
  …`) is the first line of every boot log.
- **Schema table:** `openclaw-schema-versions.json` (same dir) — supported
  `{ state, agent }` schemas plus observed `user_version` evidence for compatibility gates and diagnostics.
  Valid public `package.json` `openclaw.schemaVersions` metadata is authoritative; only its absence
  permits legacy constants or historical fallback. Invalid metadata stays unknown.
  Package entries use `byVersion`; dev entries use `byBuild`, keyed by the full commit.
- **Config-gate evidence:** `config-gate/<ms>.json` (same dir; newest 10
  kept) — key-path-only diffs of every restore over `openclaw.json` (paths
  and counts, never values), beside the byte-exact
  `openclaw.json.pre-restore-<ms>.bak` copies (newest 3) next to the config;
  `configMigration.lastRestore` in the channel state names both and the boot
  that did it.
- **Rescue bundle:** `INCIDENT-<id>.md` in the AlphaClaw-owned Claude Code
  rescue workspace — the inert incident attachment (classified cause,
  versions, fenced stderr lines) a spawned rescue session reads first.
- **Auto-repair pause:** `auto-repair-pause.json` (same managed dir) —
  `{ at, cause, fingerprint, installedVersion, attempts, lastPlan: { rung,
  outcome }, reason }`; present exactly while the pause is latched, re-armed
  at boot for the same installed version, mirrored as
  `GET /api/watchdog/status` `autoRepairPaused`.
- **Run ledger:** `GET /api/openclaw/runs/:id` (also on disk as
  `runs/<opId>.json` under the OpenClaw managed dir) — step timeline,
  blamed keys, verdicts, and the full `backup` record (attempts, pause,
  contention retries, offline copy, diagnosis, exclusivity evidence,
  producer, usable check, reuse; since #79 also `attemptsDetail[] { rung,
  reason, quiesced, startedAt, elapsedMs, bytes, kind, ok }` — one row per
  backup rung, copy first — `offlineCopy.next` when a rung handed over, and
  `noBackupConfirmed`; since v0.9.81 also `backupFailureKind` and
  `lastOutput` — the upstream CLI's last three lines, secret-redacted — on a
  failed ladder, and `intentCheck { direction, latest, … }` on every apply:
  what the declared-intent belt verified or skipped). A `reconcile` run
  (`target.kind: "reconcile"`) is the installed-tree re-activation with steps
  `stop → activate → verify → relaunch`; a `backup` run (`target.kind:
  "backup"`, v0.9.81 "Back up now") is the standalone ladder, terminal state
  `completed` or `failed`, with `result.archive` on success.
- **Backup inventory:** `GET /api/openclaw/backups` — every archive-class
  file in the backups directory with provenance and eligibility.
- **Watchdog events:** Watchdog tab event log (restart causes, held states,
  doctor actions, and the backup/quiet/notification kinds:
  `backup_diagnosis`, `backup_quiesce`, `backup_contention`,
  `backup_offline_copy`, `backup_reused`, `state_db_quiet`,
  `notification_partial`, `notification_abandoned`, `restart_incumbent`,
  `prelaunch_hook`, `readiness_degraded`; since v0.9.75 also
  `readiness_probe_error`, `serving_identity_lost`, the
  `restart/<source>/requested` → `ok {verified: true}` pair a verified
  relaunch leaves behind, and the `repair/<source>/skipped` reasons
  `awaiting_sustained_failure`, `incumbent_startup_grace`, `lease_expired`
  and `state_writer_conflict`; since v0.9.77 (#76/#79) also `boot` (one row
  per boot report: verdict, pidfile decision, installed vs expected),
  `crash_cause` (the classifier's corroboration follow-up), `version_mismatch`,
  `auto_repair_paused`, `launch_compat_gate` (`held | unknown`),
  `reconcile_installed`, `config_migration_gate` (`drift_detected`,
  `*_restore`, `reverted`, `version_mismatch`), `backup_rung` (one per rung,
  `handed_over` when a rung fell through), the `repair/structural/*` rows
  with their `plan[]`, and the `repair/<source>/skipped` reasons
  `repair_attempts_exhausted`, `auto_repair_paused` and `version_mismatch`
  plus `restart/<source>/skipped {version_mismatch}`; since #87 also
  `readiness_advisory` (the detached Doctor's structured finding on an open
  readiness incident, `warn`) and `event_loop_pressure` (`warn | ok`
  telemetry — never an incident); `crash` rows carry
  `cause` + `fingerprint`).
- **Watchdog status:** `GET /api/watchdog/status` — `readiness` /
  `readinessReason` (since #87 also `readinessProbe` / `readinessStatus` —
  see "Gateway is up but not ready"), `servingPid` / `servingRootPid` / `supervisionMode`,
  `replacementPending`, `lastRepairVerdict`, `degradedRepairThreshold`,
  `incumbentConflict` (kind, holder pid/role) and `incumbentGraceUntil`;
  since v0.9.77 `versionMismatch` (`{ expected, running, source,
  detectedAt }` or `null`), `autoRepairPaused` and `lastExit.cause`. The
  repair response (`POST /api/watchdog/repair`) carries `ok`, `verdict`,
  `pending`, `replacementPending` and, on `ok: false`, `error` plus an
  operator `message`.
- **Update logs:** the update log files linked from the Upgrade tab's
  "Technical details" toggle on the progress card — the CLI's own output
  (the contention lines above appear verbatim there).
