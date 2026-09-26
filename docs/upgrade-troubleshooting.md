# Upgrade troubleshooting

Operator runbook for the failure states the OpenClaw upgrade pipeline can
surface (Upgrade tab, notifications, watchdog events). Background: issues
[#18](https://github.com/chrysb/alphaclaw/issues/18),
[#20](https://github.com/chrysb/alphaclaw/issues/20) and
[#54](https://github.com/chrysb/alphaclaw/issues/54).

## Managed deployment accepted or unknown

The AlphaClaw update card retains a provider attempt after reload or restart.
**Accepted** means the provider acknowledged the request; **Unknown** means the
request may have been accepted despite a lost, timed-out or invalid response.
Neither means the deployment finished. AlphaClaw does not resend automatically.
An unresolved attempt also blocks OpenClaw apply, backup and repair operations;
normal gateway restart and watchdog recovery remain available.

Open your deployment provider and verify the attempt has **finished or been
cancelled, with no deployment pending**. Then, as a human admin, use the update
card's **Provider finished the deployment** or **Provider cancelled or did not
deploy** action. The confirmation records `deployed` or `not_deployed` and
unlocks another submission. It does not trigger an update or certify
gateway health. If the local request is still active, wait for its bounded
completion before resolving it. Refresh if another operator resolved a different
attempt or outcome.

Do not delete `managed-update-attempt.json` to clear this state. It is the durable
record that prevents a duplicate deployment. If Doctor reports it unreadable,
preserve its bytes and any backup, check the provider first, then recover the
record with operator assistance. Reverting AlphaClaw does not cancel an already
submitted deployment; preserve the record through a version-advancing revert.

If a new submission returns `managed_update_audit_pending`, restore watchdog
database access and retry the status read. AlphaClaw retains unrecorded audit
transitions in a bounded backlog; it blocks new submissions when that backlog
fills, while allowing the current attempt to finish or be resolved. Do not
clear the attempt file to bypass this condition.

## Pending recovery or `cleanup_blocked`

The Watchdog card names the condition delaying crash recovery and shows its age
and next check. Maintenance and failed restarts do not erase the obligation.
After the competing operation finishes, recovery retries automatically. An
explicit stop of the watchdog during AlphaClaw shutdown cancels it; a launched
or adopted successor takes ownership while
warming up.

Cancelling a repair invalidates its write authority immediately, but queued
gateway operations wait until the process group has stopped and the Doctor
restore guard has finished. After fifteen seconds without confirmation, the
card shows **Repair cleanup needs attention** with the tracked process identities.
There is no automatic force-unlock. Use the rescue session to inspect the tracked
writers, confirm identity before stopping them, and confirm they have exited
before restarting AlphaClaw. Retain the repair log and watchdog events for diagnosis.

A dev repair that completes in place is shown as complete without waiting for
an AlphaClaw restart. If progress is interrupted, the Upgrade page looks up that
exact operation ID; use Retry when the status read fails. A previous update's
success is not evidence that the interrupted repair finished.

## Legacy dev update failed after changing state

The diagnostics below describe failures from older update paths. New dev
preparation explicitly clones upstream into a separate managed candidate,
checks out the selected commit, and runs `pnpm install --frozen-lockfile`,
`pnpm build`, `pnpm ui:build`, and Doctor with disposable state/configuration.
It never calls `openclaw update --channel dev`: that command can mutate an
active checkout or global package even with an isolated environment. The
running checkout stays unchanged during preparation; only boot selects the
verified candidate through the executable shim.

Explicit **in-place repair** is different: it still uses native
`openclaw update repair` against the actual active checkout/candidate, with
disposable state/configuration. It does not prepare or activate a new candidate.

A failed upstream dev update does not prove that its checkout or state was
rolled back. Check the operation's `updaterReason`, `updaterRecovery` and log.
`state-migrated-no-rollback` means upstream deliberately retained migrated
state; `serviceRestartSafe: false` means it did not verify that restarting the
gateway is safe. Preserve the log and state before attempting recovery.

For `runtime-verification-failed`, inspect `openclaw gateway status --deep`
and the service owner named there. A free port alone cannot establish that a
native service is stopped: its manager may restart it. Resolve the reported
ownership or service-state blocker before retrying. AlphaClaw reports verified
package restoration only when upstream provides explicit evidence; it does not
infer a rollback from a failed exit code.

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
`state_db_unreadable`, `state_db_unverified` or `activation_failed` — means the installed build
must not launch against the databases on disk; Retry migration refuses it
(`409 reconcile_still_held`), so use the "Version mismatch — running ≠
expected" section below instead (Re-activate recorded build, or apply a
version that can read the databases).

An unknown, corrupt, missing or thrown boot compatibility verdict also holds
the gateway. Startup skips settings reconciliation, Doctor and the config
mutation steps instead of attempting repair before compatibility is known;
the Setup UI remains available. `OPENCLAW_LAUNCH_COMPAT_GATE=off` does not
bypass this boundary. A migration that needs recovery approval must go through
the Upgrade choices; a runtime restart or re-activation cannot supply it.

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

## Config-first upgrade recovery

Ordinary OpenClaw updates prepare and verify the target first, then perform a
bounded, read-only inventory of database metadata before any checkpoint. They
do not make a hidden SQLite copy or run `VACUUM` automatically. The default
`config_only` checkpoint is a private directory containing the root
`openclaw.json`, exact optional legacy identity/auth files when present, and
its manifest. The optional paths are `identity/device.json`,
`identity/device-auth.json`, and `auth-profiles.json`, `auth-state.json`, or
`auth.json` directly inside each discovered agent directory. No other files
from those directories are implied. Capture is capped at 1 MiB per file, 16 MiB total, 256 files,
and 10 seconds. It does not recurse through the workspace, credentials,
`.alphaclaw`, or `.env`; it is not a backup of modern database-backed auth,
chat history, or other SQLite data.

If the prepared target requires a database migration and data protection is
available, the human chooses one of three outcomes before AlphaClaw stops the
gateway: take an explicit `database_set` snapshot of the complete discovered
SQLite set, accept the forward-only migration risk without a database
snapshot, or cancel. The complete set can be very large, including gigabytes.
An opted-in snapshot shares one quiet gateway pause; there is no second stop
and no automatic database restore. Unknown or incompatible target schemas,
corrupt/unreadable sources, ownership conflicts, and gateway holds are hard
refusals, not consent prompts. Config-only evidence never satisfies the
database recovery requirement. Pin/rollback decisions must continue to use
the actual database set and declared target schemas; retention protects
actual database snapshots rather than treating a config checkpoint as one.

Recovery orchestration requires the selected config to be `openclaw.json`
inside the same physical state directory AlphaClaw's config writers manage.
Custom filenames and conflicting state roots are refused before live mutation,
so AlphaClaw cannot capture one config and later restore or normalize another.
Symlink-equivalent roots remain supported without rewriting the gateway's
logical path selectors. Correct conflicting deployment settings while preserving
the original logical state path; do not move state files to bypass the refusal.

Forward-only approval binds the exact build and recovery facts. A normal
gateway shutdown can checkpoint its WAL and change those facts. In that case,
AlphaClaw revokes the old approval and leaves the gateway stopped in an explicit
recovery review. Choose protection again, or use **Cancel** to verify the prior
build and databases and resume it safely. Cancellation clears the review only
after the prior gateway is ready; a changed build, incompatible data, lost
ownership, or failed start keeps recovery unresolved and shows an actionable
error. Reloading or restarting AlphaClaw does not grant approval or discard the
review. A stale boot approval similarly requires **Review database recovery
choices**, not repeated migration retries.

`POST /api/openclaw/backup` defaults to the config checkpoint; `/backup-sqlite`
is the explicit database-set operation. Backup-policy mutation endpoints are
retired (`410`), as is the old archive-reuse option. These names describe the
shipped product contract; consult the live API manifest/UI for exact request
fields and response shapes.

New checkpoints retain the newest three configuration checkpoints and three
database sets, plus protected migration and active-operation artifacts. Existing
published legacy archives are preserved rather than automatically pruned; their
pin can expire without deleting the archive or erasing the rollback warning.

### Restoring a config checkpoint or database set

Neither checkpoint type is restored automatically. For a config checkpoint,
use the manifest to identify the exact captured files and restore only to the
matching compatible build. Do not infer that omitted config keys or database
state were captured. For an explicit database-set snapshot, stop AlphaClaw,
the gateway, and every other database writer through the host/provider
maintenance controls. Verify the checkpoint manifest and paths, save each
current destination database and its `-wal`, `-shm`, and `-journal` sidecars
to a separate private recovery location, and replace only database files
listed in the snapshot. Preserve omitted files and directories; do not replace
the state or agent directory wholesale. Validate integrity and target-schema
compatibility before restarting. Keep the saved destinations and sidecars
until the service is healthy. A config-only checkpoint cannot restore modern
database-backed auth or history, and legacy auth JSON must not be replayed
into modern SQLite authentication storage.

The checkpoint directory contains `manifest.json`, `ready.json`, and
`payload/<archivePath>`. Its manifest has separate `files[]` and `databases[]`
entries with exact `sourcePath` destinations and `archivePath` payload paths.
There is no restore API or automatic placement command. From a private host
maintenance shell, verify the artifact against its producing run before
copying anything (replace the three example paths with this installation's
actual package, run record, and checkpoint):

```sh
ALPHACLAW_PACKAGE=/path/to/installed/alphaclaw \
RUN_RECORD=/data/.openclaw/.alphaclaw/runs/OPERATION_ID.json \
CHECKPOINT=/data/backups/openclaw/recovery-UUID \
node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { inspectRecoveryCheckpoint, readRecoveryCheckpoint } = require(path.join(
  process.env.ALPHACLAW_PACKAGE, "lib/server/openclaw-recovery-checkpoint.js",
));
(async () => {
  const run = JSON.parse(fs.readFileSync(process.env.RUN_RECORD, "utf8"));
  const recorded = run.recovery?.checkpoint;
  if (!recorded?.verified || recorded.file !== process.env.CHECKPOINT) {
    throw new Error("Checkpoint does not match the producing run");
  }
  const inspection = inspectRecoveryCheckpoint(recorded.file, {
    record: run.recovery, backupsDir: path.dirname(recorded.file),
  });
  if (!inspection.ok) throw new Error("Checkpoint no longer matches its recorded manifest and payload identities");
  await readRecoveryCheckpoint(recorded.file, {
    operationId: run.operationId,
    sourceBuild: recorded.sourceBuild,
    targetBuild: recorded.targetBuild,
  });
  console.log("Checkpoint verified against its producing run; no files restored.");
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
NODE
```

Do not proceed on a verification or build-binding failure. Verify the build
you intend to run matches the captured **source** build/version (and full
commit for dev); the manifest's target is the update destination, not the
version that wrote the snapshot. A mismatched build requires a separate
compatibility assessment, not overriding the binding. After saving each
current destination and sidecar, copy only the verified
`payload/<archivePath>` to its checked `sourcePath`. For each restored SQLite
file, remove its old `-wal`, `-shm`, and `-journal` at the destination only
after preserving them; never reattach those sidecars to the snapshot. Check
integrity for every restored database and compatibility with the intended
build before restarting. Restore the complete captured database set together,
not an assumed independent subset. Preserve all omitted workspace, transcripts,
credentials and other files. Keep saved destinations through a full healthy
stabilization window.

## Brief gateway pause during backup (quiesce)

The update prepares its immutable target and checks bounded database metadata
while the current gateway serves. Recovery capture then takes one owned
lifecycle lease, suppresses watchdog relaunch, confirms the gateway is stopped,
and awaits the state-database quiet barrier. Config capture is bounded; only
an explicit `database_set` choice starts SQLite online snapshots. There is
no full-tree or upstream archive fallback and no intermediate relaunch of the
old gateway between capture and activation.

During the quiet period, state-database mutations may answer
`409 backup_in_progress` with `Retry-After`; retry after that interval. Lease
or quiet-barrier loss aborts capture rather than publishing unprotected data.
A manual backup or an aborted operation releases quiet before relaunching,
verifies the relaunch, then releases the lifecycle lease. A successful update
hands ownership through the restart/activation path. The 10-second config
capture ceiling is not an end-to-end update deadline; build preparation,
explicit database snapshots, migration and startup have separate budgets.

## Backup blocked by an oversized scratch tree

This is a historical archive failure, not a reason to edit exclusions for a
current update. Config-first recovery never enumerates a recursive workspace,
credentials or `.alphaclaw` tree, and `.env` is excluded. Known config and
database-owner discovery is bounded and refuses unsupported storage or an
incomplete inventory. A configured or registered database remains part of
the complete discovered set even when other content beside it is omitted.
The old exclusion editor and backup-policy mutations are retired (`410`).
Resolve a named required-source or ownership failure rather than trying to
exclude that database or re-enable an archive fallback.

The gateway and OpenClaw CLI keep `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`
and `XDG_CONFIG_HOME` exactly as configured. Only backup filesystem checks resolve
the state-root symlink: OpenClaw keys cron jobs and run history by the state-path
string, so replacing an alias with its real path selects a different partition
even when both paths reach the same SQLite file. `alphaclaw diagnose` warns when
the current and previous boot reports record different state paths. Older reports
without a recorded state path cannot establish a change.

Versions 0.9.87–0.9.91 resolved these runtime paths before spawning OpenClaw.
After upgrading to the fix, restart to serve the original cron partition again;
the fix does not rewrite or merge database rows. Before restarting an affected
box, consider setting `cron.skipMissedJobs: true` to avoid a burst of missed jobs.
Jobs created under the resolved path remain in that separate partition; do not
manually re-key SQLite rows as the recovery path.

## Backup blocked by state-database contention

Metadata observation and explicit database snapshots are bounded. A conflicting
owner, unconfirmed gateway stop, or lost quiet barrier refuses recovery; it does
not trigger a live archive attempt or a second stop. Inspect the operation's
code and evidence, stop the conflicting owner through its supervisor when
appropriate, then retry. Do not override source corruption or schema
incompatibility with forward-only consent.

Older run records may show `lock_contention`, a lost
`migration.legacy-audit/filesystem-sqlite-boundary` lease, `backup_rung`, or
`backup_offline_copy`. Those belong to the retired archive ladder. Its
historical journal-mode investigation, formats and dated live evidence remain
in [the archive design](designs/backup-offline-copy.md); they are not commands
to rerun automatically on a config-first update.

To exercise recovery before the next update, `POST /api/openclaw/backup`
creates a config checkpoint as a standalone ledger run; explicitly choose
`POST /api/openclaw/backup-sqlite` for the complete discovered database set.
Both use the same coordinated service, install nothing, and restore no files.
A successful config checkpoint does not prove that a multi-GB database
snapshot will fit the available disk or time budget.

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

### Legacy archive verification: GNU tar and gzip

Existing upstream and AlphaClaw tar archives retain their archive-specific
verification path: `gzip -t` plus extraction of the depth-1 manifest with
GNU tar (`--wildcards --no-wildcards-match-slash --occurrence=1`). Busybox tar
and BSD tar do not support that extraction contract. Keep GNU tar and gzip
available to inspect those archives; fix a missing tool rather than treating
an unverified archive as safe. This requirement does not describe the new
directory-checkpoint verifier. No current backup action creates a new tar
archive, and archive reuse is retired.

## Restoring a backup

This section is for **existing legacy tar archives**; use the directory-checkpoint
steps above for new recovery artifacts. Restore is a **supervised manual procedure** — upstream ships no tar-restore
CLI (`backup sqlite restore` and `backup git restore` only), and AlphaClaw
deliberately does not auto-restore (a multi-GB extract at boot would need 2×
disk and would silently discard state written since the backup). The same
steps apply to both producers; only the manifest's asset shape differs.
Verified live (2026-09-02) for pin 2026.7.1-2 / stable 2026.8.2 / beta
2026.9.1-beta.1 archives restored onto each of those three lines: every
cell preflighted, passed `integrity_check`, and booted to `/healthz`.

**Which archive:** when undoing a migration, use the verified pre-migration
archive named by that run's rollback fence; a newer archive may already contain
the migrated database. `GET /api/openclaw/backups` (or the Upgrade tab's Backups
card) lists `<root>/backups/openclaw/` archives with profile, coverage, producer,
age, size and provenance. The last three archives are retained, plus protected
migration archives and their originating records for seven days:

| Name | Producer | Manifest assets |
|---|---|---|
| `openclaw-backup-<ts>-<opId8>.tar.gz` | upstream `openclaw backup create` | ONE asset, `kind: "state"`, `sourcePath` = the state dir, `archivePath` = `<archiveRoot>/payload/posix<stateDir>` (the whole tree) |
| `openclaw-backup-<ts>-<opId8>.alphaclaw.tar.gz` | `alphaclaw-offline-copy` | per-file assets: `kind: sqlite | config | file | workspace`, `archivePath` relative to `<archiveRoot>/` |

A `.unverified` suffix is a quarantined failed artifact — never restore it.
Read `partialReasons` and `coverage` for omissions: `partial: true` can also mean
missing core assets. A `profile: "migration-minimal"` archive is explicitly a
**migration-only backup**: its discovered migration databases, configuration,
credentials, identity and agent authentication are covered; workspace and other
content are omitted. It can protect its originating update, but cannot be reused
as a later complete backup. Preserve omitted files during restore.

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

1. **Stop all writers from the host/provider maintenance console.** Stop
   AlphaClaw through its process manager or deployment controls, including the
   watchdog and background state-database users, then stop the gateway and any
   other OpenClaw CLI or external database writer. For upstream's stop command,
   use `openclaw gateway stop --force` on 2026.8.2 and later. Confirm no gateway
   listener, OpenClaw process or database file holder remains (`ss -ltnp`,
   `pgrep -af openclaw`, and `lsof` for the target databases where available).
   Stopping only the gateway from the Watchdog terminal is insufficient: the
   running watchdog can relaunch it during restoration. Keep all these services
   stopped through placement, integrity checking and preflight.
2. **Extract into an isolated directory**, never over the live state dir:
   ```sh
   gzip -t <archive>
   umask 077
   restore_dir=$(mktemp -d)
   tar -xzf <archive> -C "$restore_dir"
   cat "$restore_dir"/*/manifest.json
   ```
3. **Read `manifest.json`.** `paths.stateDir` is where the archive came
   from; for each `assets[]` entry, `archivePath` is the file or directory
   inside the extracted tree and `sourcePath` is where it belongs. Check
   `producer` (absent = upstream), `profile`, `createdAt`, optional
   `snapshotStartedAt`/`snapshotCompletedAt`, `coverage`, `partialReasons`,
   `options.includeWorkspace` and `skipped[]`. Check every archive path and
   destination against the intended state root before placing files.
4. **Save existing destination files and replace only captured assets.** Keep
   the state directory itself and everything the archive omitted. For each
   manifest asset, preserve the existing destination in a private recovery
   directory, then copy its captured replacement. For each database, preserve
   its old `-wal`, `-shm` and `-journal` sidecars too before removing them from the
   destination. For example, after saving these exact destinations and sidecars:
   ```sh
   cp -a "$restore_dir/<archiveRoot>/openclaw.json" /data/.openclaw/openclaw.json
   rm -f /data/.openclaw/state/openclaw.sqlite-wal \
         /data/.openclaw/state/openclaw.sqlite-shm \
         /data/.openclaw/state/openclaw.sqlite-journal
   cp -a "$restore_dir/<archiveRoot>/state/openclaw.sqlite" /data/.openclaw/state/openclaw.sqlite
   ```
   Repeat for **every** captured database and file, including custom locations.
   Merge upstream directory assets into their destination without removing
   omitted content. Never replace the whole state or agent directory from a
   migration-only archive. Do **not** copy any saved `-wal`/`-shm`/`-journal` sidecar
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
   opening it). This command checks state databases. Check each agent
   database's ownership metadata and `PRAGMA user_version` against the target
   package's declared `openclaw.schemaVersions.agent` too; an agent schema
   newer than the target is incompatible. Legacy 2026.7 builds have no
   `database` command; they are not the current pin.
6. **Integrity check** each restored database (read-only):
   `node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare("PRAGMA integrity_check").get())' /data/.openclaw/state/openclaw.sqlite`
   — expect `ok`. Remove the empty `-wal`/`-shm` files this open leaves.
7. **Start AlphaClaw** through the process manager or deployment controls and
   watch `/healthz` (restart ready budget: 5 min by default — `GATEWAY_RESTART_READY_TIMEOUT`, 30–480 s) plus the Watchdog tab; the boot
   reconciler runs the official migration when the preflight said one is
   required.
8. Keep saved destination files and sidecars until the box has been healthy through one full
   stabilization window (24 h).

**SQLite-only alternative (2026.8.1+):** when only a database — not config
or sessions — has to go back, `openclaw backup sqlite restore` against the
single copied database file (see the CLI's `--help`; the offline copy's
`state/openclaw.sqlite` is a standalone online-backup file that command
accepts).

## Reusing a recent backup (consent)

Archive reuse is retired. A stale client sending `allowBackupReuse` is refused;
refresh the page and choose the current recovery mode. Existing archive files,
provenance and retention still support supervised manual recovery, but an old
archive is not silently substituted for the current operation's checkpoint.

## Backup: continue without a backup (consent)

A migration that lacks database recovery protection presents three choices
before gateway stop: a complete discovered `database_set` snapshot,
human-only forward-only consent, or cancel. The target must already be
prepared and verified, including the exact commit for dev; the default config
checkpoint remains, but it cannot undo database changes. Forward-only consent
means a migration may leave no safe rollback to the old build.

The dashboard obtains an expiring, session-bound, single-use approval bound to
the operation, executing build, exact prepared target and database facts.
The human-only endpoint is
`POST /api/openclaw/runs/:operationId/backup-risk-consent`; an apply using that
approval carries both `confirmNoBackup: true` and its `confirmNoBackupToken`.
A bare boolean never authorizes data risk. Tokens do not appear in run logs,
event streams or agent responses, and agent requests cannot issue or use them.
Changed facts, an expired approval, or an AlphaClaw restart require a fresh
review rather than repeating an old archive ladder.

Consent waives missing database recovery protection only. Unknown or
incompatible schemas/builds, corrupt sources, another owner, insufficient
disk, blocklists and gateway holds remain blockers. The operation revalidates
its owned lease and bound facts before consuming approval and recording the
intent. Recovery is labeled `forward_only`, never a verified database backup;
no database restore happens automatically.

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

Rolling back after a database migration is fenced against the schemas on disk,
including pin rollbacks. A config-only checkpoint cannot satisfy the database
recovery fence, and human forward-only consent cannot make an old build read
a newer or unknown schema. AlphaClaw does not restore databases automatically.

When recovery needs earlier data, use the actual pre-migration database set
associated with that run, not the newest artifact by date. A newer checkpoint
may contain no databases or already-migrated data. Verify its provenance,
captured source build, database coverage and on-disk contents, then follow the
[directory-checkpoint procedure](#restoring-a-config-checkpoint-or-database-set)
or the [legacy archive procedure](#restoring-a-backup). Preserve current
destinations and sidecars first. Historical fields such as `backupPartial`,
`backupReused` and `reusedAgeMs` remain useful when reading old runs; they do
not re-enable archive reuse or weaken the current schema gate. Protected
database recovery artifacts and their originating records retain their
migration-retention protection; config checkpoints do not displace them.

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
  build that cannot, or whose compatibility is unknown, is HELD —
  `gatewayHold.reason: version_mismatch`, `state_db_unreadable` or
  `state_db_unverified`, with the operator prose in `gatewayHold.detail` —
  instead of launched. A missing/thrown verdict also skips config reconciliation
  and Doctor; the Setup UI stays up. The boot log line is `launch gate: …`; the event row
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
  health. The relaunch step refuses an incompatible binary, unknown/corrupt
  metadata, or a migration that lacks operator recovery approval. These
  refusals do not turn into a fallback launch or Doctor run, even with
  `OPENCLAW_LAUNCH_COMPAT_GATE=off`.
- `doctor --fix` (repair and the startup medic) requires a build that can read
  the current databases and the appropriate lifecycle/recovery admission.
  Config-first checkpoints do not invoke a backup CLI from any build.

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
   answers `no_bootable_version`); `db_preflight_failed` (unknown/unreadable
   compatibility); `recovery_choice_required` (the runtime target would migrate
   databases — use Upgrade and choose database-set protection or explicit
   forward-only consent before applying); `insufficient_disk` (needs 1.2 × the
   overlay's bytes); `activation_failed` / `verify_failed` (the swap failed
   after the old tree was removed — a hold is set and the notification and
   `boot-report.json` name it; re-run, or apply a version); `overlay_missing` (no complete local copy of the recorded build — apply the version again so the overlay is re-downloaded); `state_db_quiet` (a backup holds the quiet barrier — retry in about two minutes); `state_corrupted` (the channel-state file is unreadable — `alphaclaw diagnose` reports it); `lease_expired` (the lifecycle lease lapsed mid-reconcile — nothing was swapped; re-run).
3. Or apply a version whose schema can read the databases from the Upgrade
   page — the apply preflight probes the TARGET build, so it keeps working
   during a mismatch.
4. Deployment settings can disable runtime reconciliation
   (`OPENCLAW_RUNTIME_RECONCILE=off`) or the structural crash-repair ladder
   (`OPENCLAW_CRASH_CAUSE_LADDER=off`). They do not waive compatibility or
   migration protection. The legacy `OPENCLAW_LAUNCH_COMPAT_GATE=off` setting
   no longer disables database safety checks; do not use it to force a launch.

## Auto-repair paused

**What it means:** the watchdog stopped relaunching and repairing on its own
because doing so was provably useless: either (a) a crash was classified with
a version-family cause AND corroborated on disk, and every structural rung —
re-activate the recorded build → undo a stray config restore → pick a local
build that can read the databases / rename a legacy `exec-approvals.json` →
relaunch — was refused or failed (`reason: structural_repair_failed`), or
(b) the replacement child the ladder launched died inside its 60 s launch
window twice with the same crash fingerprint (`replacement_exited_twice`), or
(c) runtime launch checks found unknown/corrupt database state or a migration
requiring an operator recovery choice (`state_db_unverified`,
`state_db_unreadable`, `recovery_choice_required`).
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

- `state_db_unverified` / `state_db_unreadable` — establish compatible,
  readable state before retrying. Neither forced repair nor a kill switch
  waives an unknown or corrupt source.
- `recovery_choice_required` — use Upgrade to choose complete database-set
  protection or explicitly approve forward-only recovery. Runtime restart and
  re-activation cannot perform an unprotected migration.
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
For an ordinary structural pause, `POST /api/watchdog/repair
{ "force": true }` allows one attempt; the same fingerprint re-latches.
It does not clear a recovery-choice, unreadable-state or unverified-state
pause. A manual restart or a blocklist Clear does not clear those requirements.
`OPENCLAW_CRASH_CAUSE_LADDER=off` disables that structural ladder, not the
fail-closed database-recovery pauses; classification still records.

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
