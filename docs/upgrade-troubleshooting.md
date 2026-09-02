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

**What it means:** the new version installed, but its settings migration
failed and AlphaClaw failed **closed**: the gateway is deliberately held
(not started) so a half-migrated config can't run. The UI shows a "held"
banner on the Upgrade tab.

**Next steps:** the notification and the run ledger (`runs/<opId>.json`)
name the exact config keys the migration blamed. From the banner choose:

- **Retry migration** — after fixing the blamed keys yourself, or
- **Strip blamed keys and retry** — AlphaClaw removes the named keys
  (backing up the original config first) and re-runs the migration.

While the hold is set, a manual **restart is refused** (`409 gateway_held`
from `POST /api/gateway/restart`): restarting would launch the gateway on
the exact config the reconciler just rejected. Recover through the retry
actions above instead.

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

## Brief gateway pause during backup (quiesce)

**Expected behavior**, not a failure: cross-channel applies (e.g.
stable→beta), downgrades and dev switches quiesce the gateway briefly while
the pre-update backup captures a consistent state DB. Sessions reconnect
when the gateway resumes. The pause is one transaction: lifecycle lock
(leased for the quiesce **and** offline-copy budgets) → watchdog suppressed
→ gateway stopped and *confirmed* stopped → state-database quiet period →
backup attempts → quiet period released → gateway relaunched → lock
released. The Watchdog event log shows it as `backup_quiesce: engaged`.
If the pause exceeds the apply's own progress timeline, see the run ledger
for which step is stuck.

## Backup blocked by state-database contention

**What it means:** the pre-update backup (the upstream `openclaw backup
create --verify`, run with the gateway paused) died because *something else*
held or wrote the SQLite state database while it ran. Issue #54 is the
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

**What AlphaClaw does (v0.9.70+, the #54 backup ladder):** the failure is classified
`lock_contention` (a *retryable* kind, alongside `killed`; `spawn_error` is
terminal) from the last 20 lines of CLI output, and the ladder runs — still
with the gateway paused and the state-database quiet period held:

1. **In-quiesce retries** — up to 2, backing off 15 s then 30 s, only while
   the fixed quiesce deadline (7 min) still fits the retry
   (`backup_contention: retrying | exhausted` events name the reason:
   `retries_exhausted`, `attempt_too_long`, `insufficient_budget`).
2. **AlphaClaw offline copy** — when retries are exhausted, when the CLI was
   killed, or straight away when the pre-backup **diagnosis**
   (`backup_diagnosis` event: journal mode, filesystem type, state bytes,
   other live openclaw processes, predicted upstream duration) says the
   upstream snapshot cannot work (rollback-journal DB over 256 MB, or a
   prior run too slow for the remaining budget). It proves exclusivity
   first (stop confirmed, quiet barrier held, zero live openclaw processes,
   zero in-process handles, Linux `/proc/*/fd` scan clean), copies every
   `*.sqlite` with SQLite's online backup API, verifies each copy with
   `PRAGMA integrity_check`, archives with `tar -I 'gzip -1'` into
   `openclaw-backup-<ts>-<opId8>.alphaclaw.tar.gz`, and runs the same
   gzip + manifest check every artifact gets. Format:
   [docs/designs/backup-offline-copy.md](designs/backup-offline-copy.md).
   Events: `backup_offline_copy: started | completed | failed`.
3. **Relaunch + live ladder** — for timeouts, live-file races and any
   offline-copy stage failure other than a refused exclusivity check.
4. **Consented reuse** of a recent verified archive — see
   [Reusing a recent backup](#reusing-a-recent-backup-consent).

A hard-gate refusal (`409 backup_failed`) always names the newest surviving
archive (age and producer) in its hint, and the run record carries
`backup.attempts`, `quiescedAttempts`, `contentionRetries`, `offlineCopy`,
`diagnosis` and `exclusivityEvidence` so the ladder is reconstructible.

**`409 backup_in_progress` on writes:** while the quiet period is held,
AlphaClaw's own state-database writers answer `409 { code:
"backup_in_progress" }` with `Retry-After: 120` **before** anything is
mutated. The contract covers every pairing write (`POST
/api/pairings/:id/approve` and `/reject`, `POST /api/devices/:id/approve`
and `/reject` — a pairing write during the pause would put a live
`openclaw` process on the state DB, exactly the traffic the barrier
suppresses), auth-profile saves and channel-account deletes. Status readers
serve last-known data, the cron store falls back to `jobs.json`, and
notification flushes are held (never dropped) until the barrier releases.
Two writers finish instead of refusing when the barrier begins *mid-flight*
(config already changed): a channel delete clears the account's pairing
rows after release and reports `pairingRowsCleanupDeferred: true`; the
Codex OAuth exchange keeps the redeemed tokens and answers `202 { deferred:
true }`. `GET /api/models/config`, `/api/models/auth` and
`/api/codex/status` carry `unavailable: true, reason: "backup_in_progress"`
so configured credentials render as unavailable, not deleted. Retry after
the pause. Kill switch: `OPENCLAW_STATE_DB_QUIET=off` (deployment env only)
— the barrier then no-ops and the offline copy records `quiet: "disabled"`
in its evidence.

**Still failing?** `offline_copy_refused` means another process holds a
state database open (the 409 names the pid); stop it and retry. A
`spawn_error` means the backup CLI never ran (PATH/permissions). Repeated
`lock_contention` with nothing else on the box points at the hypothesis
below.

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
why the quiesced driver skips the upstream attempt and takes the offline
copy first; the copy itself is unaffected (SQLite's online backup API is
consistent in either journal mode).

### Platform requirement: GNU tar and gzip

The "usable" check every archive must pass (`backup.usableCheck:
"manifest_ok"`) extracts the depth-1 manifest with
`tar -xzOf … --wildcards --no-wildcards-match-slash --occurrence=1
'*/manifest.json'`. Those are **GNU tar** long options; busybox tar and
BSD `bsdtar` (Alpine, macOS) reject them, and the check has no fallback.
The production image (`node:22-slim`, Debian) ships GNU tar and gzip, and
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
   watch `/healthz` (120 s budget) plus the Watchdog tab; the boot
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

**What it means:** the fresh backup ladder (quiesced retries → offline copy
→ live ladder) failed with a *retryable-class* cause (`lock_contention`,
`killed`, `timeout`, `vanished_file`, `offline_copy_refused`,
`window_exhausted`) on a hard gate, but a verified, non-partial archive from
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

## Gateway prelaunch hook

**What it means:** `ALPHACLAW_GATEWAY_PRELAUNCH_HOOK=<absolute path>`
(deployment env only) runs an operator-installed executable before **every**
gateway launch and aborts the launch when the hook is refused or fails
(`GatewayPrelaunchHookError`, codes such as `not_root_owned`, `in_tree`,
`symlink`, `writable`, `nonzero_exit`, `timeout`). The watchdog records a
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

## Where the evidence lives

- **Run ledger:** `GET /api/openclaw/runs/:id` (also on disk as
  `runs/<opId>.json` under the OpenClaw managed dir) — step timeline,
  blamed keys, verdicts, and the full `backup` record (attempts, pause,
  contention retries, offline copy, diagnosis, exclusivity evidence,
  producer, usable check, reuse).
- **Backup inventory:** `GET /api/openclaw/backups` — every archive-class
  file in the backups directory with provenance and eligibility.
- **Watchdog events:** Watchdog tab event log (restart causes, held states,
  doctor actions, and the backup/quiet/notification kinds:
  `backup_diagnosis`, `backup_quiesce`, `backup_contention`,
  `backup_offline_copy`, `backup_reused`, `state_db_quiet`,
  `notification_partial`, `notification_abandoned`, `restart_incumbent`,
  `prelaunch_hook`).
- **Update logs:** the update log files linked from the Upgrade tab's
  "Technical details" toggle on the progress card — the CLI's own output
  (the contention lines above appear verbatim there).
