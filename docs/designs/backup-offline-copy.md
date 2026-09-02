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

### What is copied and how

| Content | Method | Notes |
|---|---|---|
| `*.sqlite` (anywhere in the walk) | `node:sqlite` `backup(sourceDb, dest)` with the source opened `readOnly` and `PRAGMA busy_timeout = 30000` | Consistent single-file copy; `-wal`/`-shm`/`-journal` sidecars are **skipped** and listed under `skipped[]` with `coveredBy`. Each copy passes `PRAGMA integrity_check` and records `user_version`. |
| Regular files | `copyFile` verbatim | `openclaw.json` is `kind: config`, everything else `kind: file`. |
| Workspace dirs (`workspace`, `workspace-*`) | verbatim, **only** when their total size ≤ `kOpenclawBackupWorkspaceInlineBytes` (512 MiB) | Otherwise excluded → `options.includeWorkspace: false`, the run records `partial: true`, and the archive is never a reuse candidate. |
| Symlinks, special files | skipped | Listed in `skipped[]`. |
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
2. `tar -xzOf <file> --wildcards '*/manifest.json'` extracts a JSON object with
   an `assets[]` array,
3. that manifest lists this box's state databases (`state/openclaw.sqlite`, or
   the per-agent DB set when there is no global DB) by `archivePath` or
   `sourcePath` suffix.

The run record carries `backup.usableCheck: "manifest_ok"`; a failing check is
treated as a `verify` failure (terminal, quarantined as `.unverified`).

## 5. Restore runbook (manual — the same steps as an upstream archive)

There is no tar-restore CLI upstream; restore is a supervised manual procedure.

1. **Stop the gateway.** From the Watchdog terminal: `openclaw gateway stop`
   (on 2026.8.x/2026.9.x add `--force` when the shell is non-interactive).
   Confirm nothing listens on the gateway port and no `openclaw` process is
   live.
2. **Extract into an isolated directory**, never over the live state dir:
   `mkdir /tmp/restore && tar -xzf <archive> -C /tmp/restore`.
3. **Read `manifest.json`.** For each `assets[]` entry, `archivePath` is the
   file inside the extracted root and `sourcePath` is where it belongs. Check
   `producer`, `createdAt`, `options.includeWorkspace` and `skipped[]` so you
   know what is NOT in the archive (excluded workspaces, sidecars).
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

## 7. Inventory

`GET /api/openclaw/backups` (5 s cache, manifest tier `safe`) lists every
archive-class file in the backups directory with provenance from the run
ledger / channel state: `{ file, producer, sizeBytes, mtimeMs, at, verified,
partial, reused, exists, eligible, ineligibleReason }`. Symlinks, files outside
the directory, files nothing recorded (`no_provenance`), unverified or partial
archives and recorded-but-missing files are listed but never eligible.
