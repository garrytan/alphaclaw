# Persisted-format fixtures (issue #76 C5)

Literal on-disk state files of the boot spine, one directory per file and one
`<era>.json` per format generation. `tests/server/state-file-compat.test.js`
plants each fixture VERBATIM on a temp dir and feeds it through the CURRENT
reader/normalizer: a pre-change era must load with defaults and never throw, a
current-era file must round-trip intact, and a torn write (`corrupt.json`)
must be lenient — one warning, a rewrite, never an exception into the boot.
When a writer changes its format, regenerate the affected era from the real
writer and fix the test in the same commit (the fixture and the reader move
together).

Every fixture is keyed to one deterministic incident clock so the eras
cross-reference: `at` 1788681600000 = 2026-09-06T08:00:00.000Z, host
`srv-d3f9a1c2`, container pid 1 start ticks 3431, the 0.9.76 boot
`7:1788681590000`, the 0.9.77 boot `7:1788681600000`, the recorded build
2026.9.2 with 2026.7.1-2 installed (the #76 mismatch), the operator apply
`9b1f6c2e-3d4a-4f5b-8c6d-7e8f9a0b1c2d`.

Provenance. Pre-change eras were produced by the v0.9.76 writers
(`git archive 01d3b66 lib` loaded from a scratch dir), current eras by the
working tree's writers at the Stage 2 commit (23b380a); the two hand-authored
records are marked below. Non-deterministic seams were pinned (`nowFn`,
`getBootId`, `hostnameFn`, `crypto.randomUUID`, a planted `/proc`). Each
`corrupt.json` is the head of the matching `v0.9.77.json` cut mid-object — the
bytes a crash between `write` and `rename` would leave if the writer were not
atomic (every current writer IS, which is why the readers only have to be
lenient about files older code or a hand edit left behind).

- alphaclaw-server.pid/
  - legacy.json — `{ pid, at }`, hand-transcribed from `describeSelf()` at
    0fdcf8b (v0.9.34, #5) through v0.9.72. No identity at all: the RC1/RC2
    claim whose pid can name a thread or a process from a previous container.
  - v0.9.73.json — `{ pid, at, host, startTicks }`, hand-transcribed from
    `describeSelf()` at d9bda11 (v0.9.73, #64) through 01d3b66 (v0.9.76). An
    identity claim: matching start ticks corroborate, different ticks are a
    recycled pid.
  - v0.9.77.json — `format: 2`, `legacyClaim: true`, `observedTicks`,
    `containerStartTicks`, never `startTicks`: the CONVERGENCE of legacy.json
    by the current `convergeLegacyServerPidClaim` over a planted `/proc` (pid
    47 alive as its own leader, argv `node /app/bin/alphaclaw.js start
    --root-dir /data`, start ticks 15532, `upgradedAt` = at + 45 s). The test
    re-derives it byte-for-byte from legacy.json.
- openclaw-channel-state.json/
  - v0.9.76.json — the v0.9.76 store's `writeState()` (the full normalized
    key set of that release: applied with operationId/reason, pin window,
    previous pin, configMigration WITHOUT lastRestore, a blocklisted beta, a
    lane-A backup record). No `lastTransition`, no `pinLag`.
  - v0.9.77.json — the current store's `writeState()` over the same body plus
    `lastTransition` (operator_apply upgrade, ok, unconsumed), `pinLag`
    (bootId + bootsSeen) and `configMigration.lastRestore` (round_trip).
- runs/ (`<managedDir>/runs/<operationId>.json`)
  - v0.9.76.json — the v0.9.76 ledger: `createRun` + a stepRecorder-style
    `updateRun` mid-apply (`install` running, backup + dbPreflight recorded).
    The process died here; boot must close it.
  - v0.9.77.json — the current ledger: the Stage 3 reconcile run shape (target
    `{ kind: "reconcile", version }`, `appendStep` stop → activate) left
    `running` mid-copy. Written through the ledger's generic API ahead of the
    B1.2 writer; regenerate from `reconcileInstalled` once it lands.
- alphaclaw-restart-operation.json/
  - v0.9.76.json — the v0.9.76 store: `beginRestart` (uuid pinned) +
    `updateRestartOperation(lastStep)` for the 0.9.76 boot, still `running`.
  - v0.9.77.json — the current store: a restart completed `ok: false` with the
    A2 `stateDb` evidence (`readStateDbVersions` seam), the A3 `cause`
    (`readLastExitCause` seam) and a redacted `evidenceTail`.
- gateway-state.json/
  - v0.9.76.json — the v0.9.76 tracker's `track()`: `{ state, since, bootId }`.
  - v0.9.77.json — the current tracker: `track()` + `setCause` +
    `setVersionMismatch` (the A3/A4 annotations).
- boot-report.json/
  - v0.9.77.json — the current writer: `writeBinPhase` then the two
    `mergeServerPhase` patches `boot-report-steps.js` sends (record, finalize).
    The #76 incident shape: 2026.7.1-2 resolved for launch under an expected
    2026.9.2, state schema 15 over a supported 1, a `version_mismatch` hold,
    verdict `installed_not_expected` + `state_schema_too_new`.
  - corrupt.json — the first 311 bytes.
- alphaclaw-version.json/
  - v0.9.77.json — `stampSelfVersionAtBoot`: three boots of 0.9.76 then two of
    0.9.77 (`previous` carries the 0.9.76 stamp; `bootCount` 2).
  - corrupt.json — the first 61 bytes.
- openclaw-schema-versions.json/
  - v0.9.77.json — `createSchemaVersionTable`: `recordDeclared("2026.9.2")` +
    `recordObserved("2026.9.2")` + `recordDeclared("2026.9.3")`. 2026.9.3 is
    synthetic — a stand-in for "a version the seeds do not know".
  - corrupt.json — the first 97 bytes.
- auto-repair-pause.json/
  - v0.9.77.json — the current writer (`serializeAutoRepairPause`,
    lib/server/watchdog-structural-repair.js) over the incident record:
    `at` = incident clock + 5 min, cause `state_schema_too_new`, the
    fingerprint of the 2026.7.1-2 refusal line ("uses newer schema version 15;
    this OpenClaw build supports 1"), installed 2026.7.1-2, three latches, last
    plan `reconcile_installed → overlay_missing`. Keyed by installedVersion +
    fingerprint; the compat test re-derives it byte-for-byte and re-arms it
    through `createWatchdog` (same version → paused, other version → dropped).
