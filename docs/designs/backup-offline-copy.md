# AlphaClaw Offline Copy — backup archive format and restore runbook

> **Status (2026-09-02):** ships with the issue #54 hardening. The offline copy
> is the fallback the quiesced pre-update backup takes when the upstream
> `openclaw backup create` cannot finish while the gateway is paused. The
> format is **AlphaClaw-owned**: it mirrors the core fields of upstream's
> schemaVersion-1 manifest so the same restore steps apply, and it does not
> claim compatibility with upstream restore tooling beyond those shared
> fields. Producer code: `lib/server/openclaw-backup-offline-copy.js`.

## 1. Why a second producer exists

The mandatory pre-update backup for downgrades, dev switches and prerelease
targets runs the upstream CLI with the gateway paused. Issue #54 showed the
upstream backup can still die while paused: its legacy-audit state lease was
lost to AlphaClaw's own state-database traffic (`SQLite transaction lock wait
failed` → `lease migration.legacy-audit/filesystem-sqlite-boundary was lost`).
Two further shapes have the same effect — a CLI killed from outside (OOM,
platform restart) and a rollback-journal state database large enough to
self-block the upstream snapshot on network volumes.

Rather than give up on the hard gate, AlphaClaw takes its own consistent copy
of the still-paused state directory. It runs strictly inside the same quiesce
transaction (lifecycle lock held, gateway stopped and confirmed, state-DB quiet
barrier held) and only after proving exclusivity.

```
 upstream attempt(s) fail (lock_contention / killed / short-circuit)
   │
   ▼
 assessExclusivity ─ any HARD miss ─▶ no copy, honest 409 (names the newest surviving archive)
   │ stop confirmed · quiet barrier held · 0 live openclaw processes
   │ 0 in-process state-db handles · /proc/*/fd holders (Linux; else "partial")
   ▼
 sqlite backup() per DB ──▶ integrity_check + user_version ──▶ verbatim assets
   ▼
 manifest.json ──▶ tar -I 'gzip -1' ──▶ gzip -t + manifest extraction ──▶ publish
   │
   └─ any other stage failure ─▶ relaunch gateway, live ladder takes over
```

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
    └── workspace…/…                        (only when total < 512 MiB)
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
| Workspace dirs (`workspace`, `workspace-*`) | verbatim, **only** when their total size ≤ `kOpenclawBackupWorkspaceInlineBytes` (512 MiB) | Otherwise excluded → `options.includeWorkspace: false`, the run records `partial: true`, and the archive is never a reuse candidate. |
| Symlinks | `openclaw.json` is followed when it resolves to a regular file (`viaSymlink`); every other symlink is skipped and listed in `skipped[]` (`kind: "symlink"`, directory symlinks are never followed) | A skipped symlink at a **core asset** path (`openclaw.json`, `credentials/**`, `identity/**`, `state/**`, `agents/<id>/agent/**`, any `*.sqlite`) is appended to `partialReasons` and makes the run `partial: true` (never a reuse candidate); a symlink elsewhere is just skipped. |
| Special files | skipped | Listed in `skipped[]`. |
| `.alphaclaw/`, `logs/`, `tmp/`, `node_modules/`, `backups/` | skipped | AlphaClaw bookkeeping and non-state trees. |

## 3. `manifest.json`

Upstream core fields (schemaVersion 1) plus AlphaClaw's additions:

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
    { "kind": "sqlite-sidecar", "sourcePath": "/data/.openclaw/state/openclaw.sqlite-wal", "reason": "covered by the online sqlite copy", "coveredBy": "/data/.openclaw/state/openclaw.sqlite" }
  ],
  "partialReasons": [],
  "producer": "alphaclaw-offline-copy",
  "alphaclawFormatVersion": 1,
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

`alphaclawFormatVersion` bumps whenever the layout or the field set changes in
a way a restore runbook must know about.

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
3. that manifest **covers** this box's state databases
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
manifest step after publish is the same function.

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
   `options.includeWorkspace` and `skipped[]` so you know what is NOT in the
   archive (excluded workspaces, sidecars).
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
6. **Start the gateway** and watch `/healthz` (120 s budget) plus the Watchdog
   tab; the boot reconciler runs the official migration if the preflight said
   one is required.
7. Keep the aside tree until the box has been healthy through one full
   stabilization window.

SQLite-only alternative (2026.8.1+): `openclaw backup sqlite restore` against a
single copied database, when only a database — not config or sessions — has to
go back.

## 6. Consented reuse of an earlier archive (WI-4.5)

When the fresh ladder (quiesced retries → offline copy → live ladder) is
exhausted by a retryable failure on a hard gate, the 409 `backup_failed` may
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
`exclusivityEvidence`, `diagnosis` — and lists databases per file (`kind:
"sqlite"`, `archivePath` relative to `<archiveRoot>/`).

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
