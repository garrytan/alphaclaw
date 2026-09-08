# AlphaClaw Offline Copy — backup archive format and restore runbook

> **Status (2026-09-07):** shipped with the issue #54 hardening as the
> fallback behind the upstream CLI; since issue #79 (Stage 4c, decision D1a)
> the offline copy is the **first rung of every quiesced pre-update backup**
> — soft and hard gates alike — and the upstream `openclaw backup create`
> runs only after a failed copy (paused, when `chooseBackupRung` predicts it
> fits; otherwise live). The format is **AlphaClaw-owned**: it mirrors the
> core fields of upstream's schemaVersion-1 manifest so the same restore
> steps apply, and it does not claim compatibility with upstream restore
> tooling beyond those shared fields. Producer code:
> `lib/server/openclaw-backup-offline-copy.js`; ladder policy:
> `lib/server/openclaw-backup-ladder.js`.

## 1. Why a second producer exists — and why it now runs first

The pre-update backup used to run the upstream CLI with the gateway paused,
and only for the hard gates (downgrades, dev switches, prerelease targets).
Issue #54 showed the upstream backup can still die while paused: its
legacy-audit state lease was lost to AlphaClaw's own state-database traffic
(`SQLite transaction lock wait failed` → `lease
migration.legacy-audit/filesystem-sqlite-boundary was lost`). Two further
shapes have the same effect — a CLI killed from outside (OOM, platform
restart) and a rollback-journal state database large enough to self-block
the upstream snapshot on network volumes. The offline copy was born as the
fallback behind those failures.

Issue #79 (the 2026-09 incident: an 8 GB workspace `node_modules` tarred
inside the pause) inverted the order. The upstream CLI takes no excludes and
gives no progress; the copy sizes its set before the pause, excludes debris
(§2.1), reports progress and fits its own budget. So since Stage 4c
(decision D1a) **every apply that can pause the gateway does — soft gates
included — and the offline copy is the first rung of the pause,
unconditionally.** It runs strictly inside the quiesce transaction
(lifecycle lock held, gateway stopped and confirmed, state-DB quiet barrier
held) and only after proving exclusivity. `hardGate` decides only whether a
failure is fatal, never whether the copy runs.

```
 runBackupDiagnosis (before the pause, ≤ kOpenclawBackupDiagnosisBudgetMs):
   journal mode · fs type · ONE walk with the policy excludes → copy set /
   tar set / excluded bytes → predicted copy ms + upstream ms
   │
   ▼
 quiesce: lock → stop CONFIRMED → quiet barrier
   (busy lock / no barrier: hard gate → honest 409 · soft gate → warning + LIVE ladder)
   │
   ▼
 OFFLINE COPY FIRST (bounded by min(offlineCopyBudgetMs, quiesce remaining))
   assessExclusivity ─ any HARD miss ─▶ offline_copy_refused: no copy, hand over to
   │ stop confirmed · quiet held         the LIVE ladder (the live upstream runs
   │ 0 live openclaw processes           against a running gateway and needs no
   │ 0 in-process state-db handles       exclusivity); the refusal rides the record
   │ /proc/*/fd holders (Linux;          and is appended to the eventual failure
   │   else "partial")                   message — never a one-rung terminal
   ▼
 sqlite backup() per DB ──▶ integrity_check + user_version ──▶ verbatim assets
   ▼                        (workspaces minus the policy excludes, §2.1)
 manifest.json ──▶ tar -I 'gzip -1' ──▶ gzip -t + manifest extraction ──▶ publish
   │                                                                (after the unwind)
   └─ any other stage failure ─▶ describeUpstreamVeto / chooseBackupRung:
        upstream predicted to fit the remaining pause (and its tar set under
        kOpenclawBackupUpstreamMaxBytes) ─▶ in-quiesce `backup create`
        (kQuiescedOutcomePolicy: lock_contention retries ≤ 2, else hand over)
        anything else ─▶ relaunch gateway, settle, LIVE ladder (≤ 2 attempts)
   the copy never runs twice in one pause
```

Every rung — the copy, each paused upstream attempt, each live attempt — is
one `run.backup.attemptsDetail[]` entry `{ rung, reason, quiesced,
startedAt, elapsedMs, bytes, kind, ok }` and one `backup_rung` event, and a
failed copy records what followed it as `offlineCopy.next { rung, reason }`.
A soft-gated apply that ends with no backup is still stopped at the
post-preflight checkpoint when the target migrates the databases (`409
backup_required_for_migration`). Eligible backup-availability failures on
either gate may offer a separate human confirmation bound to an already
prepared, verified target. The retry needs both `confirmNoBackup: true` and
a session-bound, single-use `confirmNoBackupToken`; ownership, compatibility
and gateway holds remain blockers. See the [consent runbook](../upgrade-troubleshooting.md#backup-continue-without-a-backup-consent).

## 2. Archive layout

```
<root>/backups/openclaw/openclaw-backup-<ts>-<opId8>.alphaclaw.tar.gz
└── openclaw-backup-<ts>-<opId8>/          (archiveRoot)
    ├── manifest.json
    ├── openclaw.json                       (kind: config)
    ├── state/openclaw.sqlite               (kind: sqlite — online backup())
    ├── agents/<id>/agent/openclaw-agent.sqlite
    ├── agents/<id>/agent/…                 (auth profiles etc., verbatim)
    ├── agents/<id>/sessions/…              (verbatim)
    ├── credentials/…, identity/…           (verbatim)
    └── workspace…/…                        (only when the POST-exclude total ≤ 512 MiB;
                                             minus the policy excludes, §2.1)
```

The `.alphaclaw.tar.gz` suffix is what distinguishes the producer on disk.
Retention (`keep-3`), the inventory API and failure cleanup classify both
producers with one pattern: `^openclaw-backup-[^/]*\.(alphaclaw\.)?tar\.gz$`.
The archive is written `0600` inside a `0700` backups directory; a refused
`chmod` (network filesystems) never fails the backup but is recorded on the
run (`backup.mode`, `backup.modeError`), warned and notified.

### What is copied and how

| Content | Method | Notes |
|---|---|---|
| `*.sqlite` (anywhere in the walk) | `node:sqlite` `backup(sourceDb, dest)` with the source opened `readOnly` and `PRAGMA busy_timeout = 30000` | Consistent single-file copy; `-wal`/`-shm`/`-journal` sidecars are **skipped** and listed under `skipped[]` with `coveredBy`. Each copy passes `PRAGMA integrity_check` and records `user_version`. |
| Regular files | `copyFile` verbatim | `openclaw.json` is `kind: config`, everything else `kind: file`. |
| Workspace dirs (`workspace`, `workspace-*`) | verbatim, **only** when their **post-exclude** total size ≤ `kOpenclawBackupWorkspaceInlineBytes` (512 MiB) | The size is judged after the policy excludes (§2.1) are taken out — the junk no longer decides. Otherwise the workspace is omitted → `options.includeWorkspace: false`, `coverage.workspace: "omitted"`, the run records `partial: true`, and the archive is never a reuse candidate (unchanged since #54). |
| Policy excludes inside workspaces (§2.1) | skipped, **measured** | Each excluded entry is one `skipped[]` row `{ kind: "policy_exclude", pattern, files, bytes }` (a directory is one row for the whole subtree); the manifest's `excludes[]` tallies per pattern and `coverage.workspace` reads `"policy_excluded"`. Never sets `partial`. |
| Symlinks | `openclaw.json` is followed when it resolves to a regular file (`viaSymlink`); every other symlink is skipped and listed in `skipped[]` (`kind: "symlink"`, directory symlinks are never followed) | A skipped symlink at a **core asset** path (`openclaw.json`, `credentials/**`, `identity/**`, `state/**`, `agents/<id>/agent/**`, any `*.sqlite`) is appended to `partialReasons` and makes the run `partial: true` (never a reuse candidate); a symlink elsewhere is just skipped. |
| Special files | skipped | Listed in `skipped[]`. |
| `.alphaclaw/`, `logs/`, `tmp/`, `node_modules/`, `backups/` | skipped | AlphaClaw bookkeeping and non-state trees — **outside** workspaces only. |

### 2.1 Policy excludes inside workspaces (issue #79)

The upstream backup includes workspace dirs wholesale, and until #79 so did
the offline copy: a workspace's `node_modules` (8 GB in the 2026-09 incident)
was copied inside the quiesce and blew the budget. Inside a workspace the
copy now applies a policy exclude list; outside a workspace nothing changes
(a `.tmp` under `agents/<id>/sessions/` is state and is copied).

- **Default set** (`kOfflineCopyPolicyExcludes`, unambiguous debris only):
  `node_modules`, `*.heapsnapshot`, `*.tmp`, `logs/**/*.gz`. `tmp`, `.cache`
  and `caches` are deliberately **not** default — an operator opts in.
- **Matching is gitignore-style, case-insensitive:** a pattern without `/`
  matches any entry's basename at any depth; one with `/` matches the
  workspace-relative path anchored at the workspace root (`**` spans
  segments, `*`/`?` never cross `/`); a trailing `/` matches directories
  only. A matched directory is excluded whole.
- **Override (module-level only, not yet an operator control):**
  `createOfflineCopy({ excludes })` **replaces** the default list (`[]`
  turns the policy off); at most 64 patterns, each ≤ 256 characters, no
  absolute paths, no `.`/`..` segments, no backslashes. **No `alphaclaw.json`
  key is read today** — the driver (`runOfflineCopy` in
  `openclaw-channel-sync.js`) passes no `excludes`, so production always
  runs the default set, and `runBackupDiagnosis`'s sizing walk uses the same
  defaults. The planned `updates.openclaw.backup.excludes` wiring (config
  normalizer, `dangerous` agent tier, one list threaded into BOTH
  `createOfflineCopy` and the diagnosis walk so the two walks cannot
  disagree) is deferred; until it lands the module-level option is exercised
  by `tests/server/openclaw-backup-offline-copy.test.js` only.
- **Core assets are never excludable, whatever the config says.** A pattern
  that could match a core asset — the config file, `credentials/**`,
  `identity/**`, `state/**`, `agents/<id>/agent/**` or any `*.sqlite` (so
  `*`, `**`, `*.json`, `*.sqlite`, `credentials`, `state/`, `agents/*`, …) —
  is **refused**: reported on the result (`refusedExcludes[{ pattern,
  reason }]`) and in the backup log, never applied, never fatal. Excludes
  apply only inside workspaces in the first place; the refusal is defence in
  depth so no config can widen them onto the data a restore cannot do
  without.
- **Measured, not silent.** Every excluded entry is listed in `skipped[]`
  with its size; excluded directories are walked in a tolerant measuring
  pass (an unreadable corner of a tree we are not copying never fails the
  backup) that yields to the budget like the rest of the walk but does not
  count against the 200k copy-set entry cap.
- **Never `partial`.** `partial` / `partialReasons` keep their meaning — a
  missing **core** asset (§2 symlink rule) or the over-limit workspace
  omission — so reuse eligibility (§6) is unchanged. The excludes are
  reported through `excludes[]` and `coverage` (§3).

## 3. `manifest.json`

Upstream core fields (schemaVersion 1) plus AlphaClaw's additions
(`alphaclawFormatVersion: 2` since issue #79; the reader accepts 1 and 2, §4):

```json
{
  "schemaVersion": 1,
  "createdAt": "2026-09-02T18:00:00.000Z",
  "archiveRoot": "openclaw-backup-1756836000000-2f8c1f2e",
  "runtimeVersion": "2026.9.1-beta.1",
  "platform": "linux",
  "nodeVersion": "v22.23.2",
  "options": { "includeWorkspace": true, "onlyConfig": false },
  "paths": {
    "stateDir": "/data/.openclaw",
    "configPath": "/data/.openclaw/openclaw.json",
    "oauthDir": "/data/.openclaw/credentials",
    "workspaceDirs": ["/data/.openclaw/workspace"],
    "agentRoots": [{ "agentId": "main", "sourcePath": "/data/.openclaw/agents/main" }]
  },
  "assets": [
    { "kind": "sqlite", "sourcePath": "/data/.openclaw/state/openclaw.sqlite", "archivePath": "state/openclaw.sqlite" },
    { "kind": "config", "sourcePath": "/data/.openclaw/openclaw.json", "archivePath": "openclaw.json" }
  ],
  "skipped": [
    { "kind": "sqlite-sidecar", "sourcePath": "/data/.openclaw/state/openclaw.sqlite-wal", "reason": "covered by the online sqlite copy", "coveredBy": "/data/.openclaw/state/openclaw.sqlite" },
    { "kind": "policy_exclude", "sourcePath": "/data/.openclaw/workspace/node_modules", "reason": "excluded by backup policy (node_modules)", "pattern": "node_modules", "files": 48213, "bytes": 812345678 }
  ],
  "partialReasons": [],
  "producer": "alphaclaw-offline-copy",
  "alphaclawFormatVersion": 2,
  "excludes": [
    { "pattern": "node_modules", "files": 48213, "bytes": 812345678 },
    { "pattern": "*.heapsnapshot", "files": 0, "bytes": 0 },
    { "pattern": "*.tmp", "files": 0, "bytes": 0 },
    { "pattern": "logs/**/*.gz", "files": 0, "bytes": 0 }
  ],
  "coverage": { "core": "complete", "workspace": "policy_excluded" },
  "exclusivityEvidence": {
    "stopConfirmed": true,
    "stopEvidence": { "...": "gateway stop record when the gateway module provides one" },
    "quiet": "held",
    "quietOwner": "quiesced-backup",
    "liveProcesses": 0,
    "handleCount": 0,
    "fdScan": "clean",
    "fdHolders": [],
    "completeness": "full",
    "platform": "linux"
  },
  "diagnosis": { "journalMode": "wal", "fsType": "ext4", "stateBytes": 734003200, "predictedUpstreamMs": 41000 }
}
```

`exclusivityEvidence.completeness` is `"full"` only when the Linux `/proc/*/fd`
scan ran and found no other holder; on other platforms it is `"partial"` and
the copy still proceeds because SQLite's online backup API is consistent under
concurrent access. Any **hard** miss (stop not confirmed, barrier not held,
live openclaw processes, open in-process handles, foreign fd holders) refuses
the copy before a byte is written.

`excludes[]` lists every policy pattern that was in force (one row per
pattern, zero-match rows included, so the reader sees the policy, not only
its hits) with the files and bytes it dropped. `coverage` is the honest
summary a restore or the inventory reads first:

| Field | Values | Meaning |
|---|---|---|
| `coverage.core` | `"complete"` / `"partial"` | Every core asset (config, `credentials/**`, `identity/**`, `state/**`, `agents/<id>/agent/**`, every `*.sqlite`) is in the archive / at least one was skipped (symlink rule) — the latter is exactly what `partial: true` + `partialReasons` name. |
| `coverage.workspace` | `"complete"` / `"policy_excluded"` / `"omitted"` | The workspaces are in whole / in minus the `excludes[]` / left out over the inline limit (`options.includeWorkspace: false`, also `partial: true`). A box with no workspace reads `"complete"`. |

`partial` stays reserved for a missing core asset and the over-limit
omission; a policy exclude never sets it (reuse eligibility, §6, is
unchanged). Refused operator patterns are **not** in the manifest — they
changed nothing about the archive — but are on the copy result
(`refusedExcludes`) and in the backup log.

`alphaclawFormatVersion` bumps whenever the layout or the field set changes in
a way a restore runbook must know about. History: **1** (2026-09-02, issue
#54) — the shape above without `excludes`/`coverage`; **2** (issue #79) —
adds `excludes[]`, `coverage{}` and the `policy_exclude` skipped kind. The
reader (`verifyArchiveManifest`) accepts every version in
`kOfflineCopyReadableFormatVersions` (`[1, 2]`); both share the restore
runbook in §5.

## 4. Verification ("usable" definition, WI-6.1)

An archive from either producer counts as verified only when:

1. `gzip -t <file>` passes,
2. the **depth-1** manifest extracts and parses:
   `tar -xzOf <file> --wildcards --no-wildcards-match-slash '*/manifest.json'
   --occurrence=1` — GNU `*` would otherwise span `/` and, with
   `--occurrence=1`, deterministically pick a *workspace's* own
   `manifest.json` when it sorts first; the extraction streams through a
   16 MB tail (the runStreamed default of 64 KB truncated a real-size
   offline-copy manifest at ≳280 files, which is why the producer writes
   compact JSON), and the parsed object must carry a numeric `schemaVersion`
   and an `assets[]` array (9–14 ms on real archives);
3. when the producer is `alphaclaw-offline-copy`, its `alphaclawFormatVersion`
   is one this build can read — `1` or `2` (`kOfflineCopyReadableFormatVersions`).
   An archive written by a **newer** AlphaClaw in a format this one does not
   know fails the check honestly at stage `format` rather than being judged
   "usable" on fields it does not understand. Upstream manifests carry no
   such version and are not gated. The verdict reports `formatVersion`
   (`null` for upstream);
4. that manifest **covers** this box's state databases
   (`state/openclaw.sqlite`, or the per-agent DB set when there is no global
   DB) — by `archivePath` / `sourcePath` suffix (per-file assets, the offline
   copy) OR by an asset whose `sourcePath` is the state dir or an ancestor of
   the database's absolute path, resolved against `manifest.paths.stateDir`
   (upstream's single `kind: "state"` asset; see §7). Coverage, not listing:
   a per-file-only rule rejected every real upstream archive and failed the
   hard gate closed on a false verdict in the first container-tier run.

The run record carries `backup.usableCheck: "manifest_ok"`; a failing check is
treated as a `verify` failure (terminal, quarantined as `.unverified`). Both
producers are judged by this one check — the offline copy's own `gzip -t` +
manifest step after publish is the same function. A policy exclude never
affects the verdict: the databases are never inside a workspace's exclude
scope, and `coverage.workspace: "policy_excluded"` is information for the
inventory and the restore, not a usability defect.

## 5. Restore runbook (manual — the same steps as an upstream archive)

There is no tar-restore CLI upstream; restore is a supervised manual procedure.

The operator-facing version of these steps (with the exact commands, the
preflight vocabulary and the "restart did not take effect" cross-check) is
`docs/upgrade-troubleshooting.md` "Restoring a backup"; the UI links there.

1. **Stop the gateway.** From the Watchdog terminal: `openclaw gateway stop`
   (on 2026.8.x/2026.9.x add `--force` when the shell is non-interactive).
   Confirm nothing listens on the gateway port and no `openclaw` process is
   live.
2. **Extract into an isolated directory**, never over the live state dir:
   `mkdir /tmp/restore && tar -xzf <archive> -C /tmp/restore`.
3. **Read `manifest.json`.** For each `assets[]` entry, `archivePath` is the
   file (offline copy) or directory (upstream's single `state` asset — the
   whole state dir under `payload/posix<stateDir>`) inside the extracted
   root, and `sourcePath` is where it belongs; place each at `sourcePath`
   relative to `paths.stateDir`. Check `producer`, `createdAt`,
   `options.includeWorkspace`, `coverage` and `skipped[]` so you know what is
   NOT in the archive (an omitted workspace, sidecars, and — format 2 — the
   `excludes[]` policy drops such as a workspace's `node_modules`, which a
   restore reinstalls rather than recovers).
4. **Move the current state dir aside** (`mv /data/.openclaw
   /data/.openclaw.pre-restore-<ts>`) and **place assets** per the manifest:
   `openclaw.json`, then every `sqlite` asset, then the remaining files. Do
   not copy any `-wal`/`-shm` sidecar from the aside tree next to a restored
   database — the online copy is self-contained.
5. **Preflight with the target CLI:** `openclaw database preflight
   <stateDir>/state/openclaw.sqlite --json` (and each agent DB). A
   `migration-required` verdict means the version you are about to run will
   migrate the restored state at its next start; an `incompatible` verdict
   means pick a version that can read it.
6. **Start the gateway** and watch `/healthz` (restart ready budget: 5 min by default, `GATEWAY_RESTART_READY_TIMEOUT`) plus the Watchdog
   tab; the boot reconciler runs the official migration if the preflight said
   one is required.
7. Keep the aside tree until the box has been healthy through one full
   stabilization window.

SQLite-only alternative (2026.8.1+): `openclaw backup sqlite restore` against a
single copied database, when only a database — not config or sessions — has to
go back.

## 6. Consented reuse of an earlier archive (WI-4.5)

When the fresh ladder (offline copy first → in-quiesce upstream attempts
when predicted to fit → live ladder; a refused copy hands over to the live
ladder rather than ending it) is exhausted by a retryable failure on a hard
gate (`kReuseEligibleKinds`: `lock_contention`, `killed`, `timeout`,
`vanished_file`, `window_exhausted`), the 409 `backup_failed` may
carry `reusableBackup: { file, at, ageMs, sha256, producer }` — the newest
verified, non-partial, ≤ 24 h archive with no apply/activation recorded since
it was taken, re-verified on an open fd (gzip -t, manifest, sha256). The
operator consents by resending the apply with `allowBackupReuse: { sha256 }`
(strict object; humans only — the agent actor is denied). The retry re-runs the
full fresh ladder first; only if it fails again is the consented archive used,
recorded as `backup.reused: true` with `reusedAgeMs` and the fresh failure,
announced as an important notification, and pinned against pruning while the
migrating run is fenced.

## 7. Verified against upstream (live tier, 2026-09-02)

Facts recorded by `tests/live/openclaw-live-backup-contention.e2e.test.js`,
`openclaw-live-restore-drill.e2e.test.js` and `openclaw-live-downgrade.e2e.test.js`
against the real 2026.7.1-2 (pin), 2026.8.2 (stable) and 2026.9.1-beta.1
(beta) packages. Re-verify here before changing the check or the format.

### Upstream manifest shape (all three lines)

Upstream's `backup create` writes exactly ONE asset:

```json
"assets": [{ "kind": "state", "sourcePath": "<stateDir>",
             "archivePath": "<archiveRoot>/payload/posix<stateDir>" }]
```

The state DB is never a per-file asset — it lives under that directory in
the archive (`…/payload/posix<stateDir>/state/openclaw.sqlite`). 2026.8.2 and
the beta add `paths.agentRoots[] { agentId, sourcePath }` (the pin has no such
key); every other core key (`schemaVersion`, `createdAt`, `archiveRoot`,
`runtimeVersion`, `platform`, `nodeVersion`, `options.{includeWorkspace,
onlyConfig}`, `paths.{stateDir,configPath,oauthDir,workspaceDirs}`, `assets[]`,
`skipped[] { kind, sourcePath, reason }`) is identical. The offline-copy
manifest carries the same core set plus `producer`, `alphaclawFormatVersion`, `partialReasons`,
`exclusivityEvidence`, `diagnosis` and (format 2) `excludes`, `coverage` — and
lists databases per file (`kind: "sqlite"`, `archivePath` relative to
`<archiveRoot>/`).

**Consequence for the usable check (§4, WI-6.1):** "the manifest lists this
box's state databases" must accept a required DB when an asset's
`sourcePath` is the state dir (or any ancestor of the DB's absolute path),
not only when an asset's `archivePath`/`sourcePath` ends with
`state/openclaw.sqlite`. A per-file-only rule rejects EVERY upstream archive
and turns every hard-gated apply into `409 backup_failed (verify)`.

### Lease behaviour under a held RESERVED lock (`BEGIN IMMEDIATE`)

| CLI | Lease | Under the lock | Output |
|---|---|---|---|
| 2026.7.1-2 | none | exit 0 in ~1.4 s, archive verified | `Config health-state write failed: database is locked` (warning) |
| 2026.8.2 | legacy-audit (when `logs/config-audit.jsonl` / `audit/system-agent.jsonl` / `audit/crestodian.jsonl` exists) | exit 1 after ~11 s, no archive | `[sqlite/transaction] SQLite transaction lock wait failed` ×N, `Warning: the backup outcome could not be recorded: database is locked`, `timed out waiting for legacy audit migration lease migration.legacy-audit/filesystem-sqlite-boundary` |
| 2026.9.1-beta.1 | same | same | same (the mid-run form is `… lease migration.legacy-audit/filesystem-sqlite-boundary was lost`, issue #54) |

The lease-timeout line's label has spaces ("legacy audit migration lease");
`kStateContentionPattern` must match it on its own, not only via the
companion lines. The beta refuses a fixture per-agent DB ("has no schema
ownership metadata … a direct file copy was refused") but backs up a
fixture GLOBAL state DB (it runs its own schema check on it).

### `database preflight` vocabulary (standalone snapshot, `--json`)

| found → target | status | exit |
|---|---|---|
| pin DB (user_version 1) → 2026.8.2 (15) / beta (12) | `migration-required` | 0 |
| 2026.8.2 DB (15) → 2026.8.2 | `exact` | 0 |
| beta DB (12) → 2026.8.2 (15) | `migration-required` | 0 (the #54 downgrade IS readable) |
| 2026.8.2 DB (15) → beta (12) | `incompatible` | 1 (hard-blocks the apply) |
| any DB with `-wal`/`-shm` beside it | `indeterminate` ("requires a consolidated snapshot with no sidecars") | 1 |

The pin has no `database` command (`Unknown command: openclaw database`).
`runDatabasePreflight` always probes a `VACUUM INTO` snapshot, so the
sidecar case never reaches it; the manual runbook must do the same.

### Restore drill results (12 cells + calibration)

Producer {upstream, alphaclaw-offline-copy} × fixture journal {WAL, DELETE}
× target {pin, stable, beta}: every cell restored by the runbook (extract →
place `assets[]` at `archivePath → sourcePath`), preflighted (`unsupported`
on the pin, `migration-required` / found 1 elsewhere), passed
`PRAGMA integrity_check`, and booted `gateway run` to `/healthz` in 6-8 s
(budget 120 s). Restored databases carry no sidecars from either producer.
Calibration: a 526 MB state tree (500 MB of incompressible rows in a second
DB) offline-copied in **19.2 s** (27 MB/s source throughput; sqlite
`backup()` + `tar -I 'gzip -1'`) → 525 MB archive, both copies
`integrity_check ok` — well inside the 8-minute budget, which therefore has
~25× headroom at this size and covers roughly 12 GB at the same rate.

## 8. Inventory

`GET /api/openclaw/backups` (5 s SWR cache, manifest tier `safe`, never on
the status path; `?force=1` bypasses the cache, and an apply settling
invalidates it) answers `{ backupsDir, readable, entries[], truncated,
newestArchive, reuseWindowStartMs, reuseMaxAgeMs }`. `readable: false` means
the directory exists but could not be scanned (a missing directory is an
empty inventory, not an error); `entries` is newest-first and capped at 50
(`truncated: true` when more exist). Each entry carries `{ file, producer,
sizeBytes, mtimeMs, at, verified, partial, partialReasons, reused, sha256,
exists, eligible, ineligibleReason, name, mode, operationId }` (`mode` is `"0600"`, `"default"` or null; `operationId` links the producing update run) with provenance from the run ledger /
channel state. Symlinks (`symlink`), files outside the directory
(`outside_dir`), files nothing recorded (`no_provenance`), unverified
(`unverified`) or partial (`partial`) archives, records dated in the future
(`future_dated`) and recorded-but-missing files (`missing`, `exists: false`)
are listed but never eligible. `reuseWindowStartMs` / `reuseMaxAgeMs` are the
bounds the consent gate in §6 enforces, computed by the same helper
(`computeReuseWindowStartMs`), so the Upgrade tab's reuse offer can only name
an archive the server would accept.
