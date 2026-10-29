# Changelog

All notable changes to AlphaClaw are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow this repository's `package.json` release counter.

## [0.10.152] - 2026-10-29

The nightly live tier runs again instead of failing on the runner. Since v0.10.137 (#277), `gateway-stale-heartbeat-relaunch` failed every night on GitHub's Ubuntu 24.04 runner, because AppArmor there blocks unprivileged user namespaces (`unshare: write failed /proc/self/uid_map`) and the test fails rather than skips under `CI`. The tier had also grown to about 44 minutes and timed out at its 45-minute limit on Oct 27 (ALPH-52).

### Changed
- `live-e2e.yml`: the job runs on a pinned `ubuntu-24.04` image. A new step lifts `kernel.apparmor_restrict_unprivileged_userns`, then runs the heartbeat test's own `unshare` probe and fails with a message naming the runner image if namespaces are still unavailable.
- The job limit is 75 minutes instead of 45, until the tier runs as parallel legs.
- The tier writes a JSON report (every test with its status) to `tests/live/artifacts/report.json`, which is uploaded with the other artifacts on every outcome.

### Tests
- `tests/ci/workflow-contract.test.js` pins the image, the sysctl, the probe (it reads the flags from the test file, so the two can't drift apart) and the report.

## [0.10.151] - 2026-10-29

The container gate runs its four test files on three runners at once instead of one after another, so a PR's required checks wait for the slowest leg (boot durability, about 6–7 minutes with its image build) instead of all four files (median 12.5 minutes over the last 25 PR runs) (ALPH-52).

### Changed
- `container-e2e.yml`: the heavy job is a matrix over the legs in `tests/container/shards.json` (`durability`, `self-upgrade`, `boot-progress` with the snapshot preflight). Each leg calls vitest with its own files only, writes a JSON report, checks that the report holds exactly its files, and uploads its artifacts on every outcome (`container-e2e-artifacts-<leg>`). The required `gate` check is unchanged and fails when any leg fails or is cancelled.
- The path filter also runs the heavy job for edits to `container-e2e.yml`, `vitest.config.js` and the `test:container` script, which can change what the tier runs.
- `npm run test:container` still runs the whole tier serially for local runs.

### Tests
- `tests/ci/workflow-contract.test.js` checks that the matrix legs equal the shard map's legs and that every `tests/container/*.test.js` file sits in exactly one non-empty leg. It also pins the leg-only vitest call, the per-leg artifacts and the new filter entries.

## [0.10.150] - 2026-10-28

Delete Agent now deletes through OpenClaw's own `agents.delete` on the serving gateway, and can keep a snapshot of the agent first. Until now AlphaClaw removed the agent from `openclaw.json` and deleted its files itself: OpenClaw kept a registry row for a database it could no longer find (Doctor warned "not a configured target" on every run afterwards), and the files went away under a gateway that might still have them open (ALPH-51).

### Changed
- **One delete path.** `DELETE /api/agents/:id` runs `openclaw gateway call agents.delete --params {"agentId":…,"deleteFiles":true}` (`lib/server/agents/delete-agent/`). OpenClaw removes the entry, bindings, cron jobs, exec approvals, session rows and registry row, moves the files to its Trash and journals the delete; the gateway does not restart. `gateway call` never falls back to removing files from the CLI. AlphaClaw removes nothing under the state directory, and the delete is refused (409) while the gateway isn't serving. AlphaClaw's own refusals (default agent, owners of `agents.defaults`) still come first.
- **The outcome comes from OpenClaw's facts, not the CLI's exit code.** After every answer, including a timeout or an error that OpenClaw may have raised after committing, AlphaClaw reads the config and the deletion journal (read-only) for up to 10 s: `deleted`, `cleanup_incomplete` (Finish deleting resends the delete), `not_deleted` (502), `unknown` (202, terminal "Couldn't confirm… Check again"), `config_only`. `GET /api/agent-deletions` serves the last outcome per agent plus OpenClaw's unfinished deletions, so the receipt and Finish deleting survive a reload.
- **Serialized, crash-safe.** One delete at a time; the gateway lifecycle lock is taken with a bounded 60 s wait; from the lock to the read-back every AlphaClaw write to `openclaw.json` answers 409 "An agent is being deleted. Try again in a moment." (checked inside the config writer, under its file lock). Each delete writes its intent to `archives/agents/.operations/` before the call; a restart in the middle is settled from OpenClaw's journal once the gateway serves, and the owner gets one notice.
- **Creating an agent under a deleted agent's id answers 409.** OpenClaw keeps the id reserved by its deletion record until its own agent creation claims it, and an entry AlphaClaw writes under that id has no usable database.
- The agent-database boot line joins the deletion journal: this version's unfinished deletes read "Deletion not finished… Use Finish deleting", and the rest are described as left by agent deletes from before Delete Agent went through OpenClaw.

### Added
- **Keep a snapshot (on by default).** Before the delete: `openclaw backup sqlite create --agent <id>` + `backup sqlite verify`, and a copy of the workspace (not when another agent uses it; sockets and FIFOs are listed and skipped), into `<ALPHACLAW_ROOT_DIR>/archives/agents/<UTC date>-<id>-<6 hex>/` (mode 0700) with a `manifest.json`. A disk budget (2× database and cold transcripts + workspace + 256 MB) is checked first; if the snapshot fails or doesn't fit, nothing is deleted. Nothing prunes snapshots; the boot log counts them. Restoring is manual (README, "Deleted agents' data": `backup sqlite restore` + `gateway call agents.create`).
- **Delete dialog:** a preview (bindings, cron jobs, history and workspace sizes, snapshot verdict), the reason Delete is disabled as visible text, one busy label, a receipt with the snapshot name, and Finish deleting / Check again notices. New routes `GET /api/agents/:id/delete-preview`, `POST /api/agents/:id/finish-delete`; Agent Administration ops `agents.delete-preview`, `agents.finish-delete` (dangerous) and `agents.deletions`. `?keepWorkspace=` is kept as an alias of `?snapshot=` (400 when they disagree).

### Tests
- `agent-deleter.test.js`, `routes-agents-delete.test.js`, `agents-tab-delete-agent-copy.test.js`, plus the Doctor report snapshot count.
- Live tier `agent-delete.e2e.test.js` on the pinned OpenClaw: an agent with chat history is deleted with no registry row, a complete journal, no gateway restart, a verified snapshot and no AlphaClaw fs mutation under the state dir; a CLI killed after OpenClaw journaled the delete still resolves to `deleted`; a restored pre-delete `openclaw.json` brings the entry back without a usable database and Delete Agent removes it again; the snapshot restores with its session through `backup sqlite restore` + `agents.create`; `doctor --fix` exits 0 naming no deleted agent.

## [0.10.149] - 2026-10-28

The boot line that names agent databases belonging to no configured agent now reads each file's real size. OpenClaw 2026.10.8 registers those paths relative to its state directory, and v0.10.148 looked them up relative to AlphaClaw's working directory, so it never found a file and printed the registry's `size_bytes` instead: no WAL, and a stale size for a file that is gone (ALPH-50).

### Fixed
- `agent-database-registry.js` resolves each registered path against the state directory. A file that exists reports its size plus its `-wal`; a registered file that is gone is reported as `file missing` (Doctor's recovery copy lists it as missing and copies nothing), never with the registry's size. Sizes under 10 MB print in MB, so a small leftover no longer reads `0.00 GB`. The boot report's `unconfiguredAgentDatabases` entries gain `missing`.

### Tests
- `doctor-report.test.js`: relative registry paths read from another working directory (size with WAL, missing file, non-file, absolute path, MB and GB formatting).
- Live tier `doctor-report-contract.e2e.test.js`: the pinned OpenClaw registers a relative path, and the reader's size equals the file plus its WAL.

## [0.10.148] - 2026-10-27

Every `openclaw doctor --fix` run now says where its time went and what it changed, and a boot names the agent databases behind OpenClaw's "database is not a configured target" lines. On a production pin bump (OpenClaw 2026.10.7 → 2026.10.8, a 5.2 GB agent database) Doctor ran 632 s. About 240 s was believed to be OpenClaw's recovery copy, and nothing said where the other ~390 s went, or which four databases the gateway skipped at start (ALPH-50).

### Added
- **One summary line per Doctor run.** `doctor-report.js` builds the report from OpenClaw's startup trace (v0.10.146 turned it on for the Doctor child): the top-level phases (`maintenance.begin`, `database-preflight`, `config-flow`, `contributions`, `maintenance-ready`, `maintenance.finish`, `maintenance.release`), with the recovery copy (`preserve-original-state`) and `legacy-state-migrations` listed under their parent and never added up; the time the phases do not cover (`unattributed`, from AlphaClaw's own clock); the five slowest contribution checks; the "Doctor changes" notes (the first 20, and a count); and whether `openclaw.json` was rewritten (its raw bytes before and after the run, read in memory; `unknown` when either side is unreadable; this says nothing about effective settings). A fact without evidence is `unknown`, never "unchanged". Example: `[alphaclaw] doctor --fix summary source=boot total=632s maintenance.begin=…(recovery-copy=…) … unattributed=… slowestChecks=… recoveryCopy=unknown configFile=rewritten migrations=0 changes=3`.
- **Where the report lives.** `lastOutcome.report` on `.alphaclaw/openclaw-boot-migration.json`; `lastRun` in `GET /api/openclaw/upgrade-status` for admin sessions only (the change notes and the recovery copy's path come from OpenClaw's output; members and the agent never see it); the boot's line as `migration.doctorSummary` in the boot report.
- **After the gateway first serves** (`doctor-after-serving.js`, off the path to serving): this boot's recovery copy is measured (only a direct `doctor-*` child of `<realpath(state)>.update-captures`, a bounded walk that never follows a symlink), added to the report as `captureBytes` and logged; and the state database's `agent_databases` registry is read read-only for rows whose agent is not configured (`agent-database-registry.js`), logged once with ids and sizes (the file and its WAL on disk, else the registry's `size_bytes`, else "size unknown"). Both go into the boot report. Nothing is deleted or notified. OpenClaw matches a registry row by path, AlphaClaw by agent id, so a configured agent's row under an unusual path is not listed.

### Changed
- `createDoctorPhaseTracker` frames stdout and stderr separately (the trace is on stderr) and drains a last line without a newline; a "Doctor changes" box only collects lines of the stream that opened it.

### Tests
- `doctor-report.test.js`: a real 2026.10.8 run's stdout and stderr (`tests/fixtures/doctor-trace-2026.10.8`, paths rewritten) fed interleaved in 37-byte chunks gives every phase, nesting, unattributed time, the five slowest checks and the capped change notes; a last line without a newline; an untraced run; the summary line; config same bytes / rewritten / unknown; the recovery copy measured only inside the capture root and never through a symlink; unconfigured databases from a real SQLite registry (on-disk size with WAL, registered size, unknown size, implicit main agent, no database, no table, unreadable); the after-serving step patches only this boot's run and never throws.
- `openclaw-upgrade-status.test.js`: `lastRun` for admins only and only for the installed pin.
- `boot-report-steps.test.js`, `openclaw-boot-migration.test.js`, `doctor-fix-runner.test.js`: the new `doctorSummary` and `report` fields.
- Live tier `doctor-report-contract.e2e.test.js`: the pinned OpenClaw's `doctor --fix` with the trace on prints every phase the report names, keeps the recovery copy its manifest line names, and its state database has the `agent_databases` columns read here.

## [0.10.147] - 2026-10-27

An external rewrite of the .env file no longer drops platform-set keys from AlphaClaw's environment. On a production box a key set in the platform's environment, with an empty line for it in .env, was deleted from AlphaClaw's env on every external rewrite and logged as "removed". Every API, channel or team restart reloads the env first, and the gateway env is built from AlphaClaw's, so platform-set provider keys and bot tokens with empty template lines also vanished from the gateway (ALPH-50).

### Fixed
- **A reload produces what a fresh boot would.** `bin/alphaclaw.js` records the deployment environment once, before anything changes `process.env` (`recordDeploymentEnvBaseline` in `deployment-only-env.js`). Boot and `reloadEnv` share one rule for what the .env file contributes (`resolveEnvFileOverlay`): entries in file order, and an empty value contributes nothing (so `KEY=a` then `KEY=` leaves `a` in both). Deployment-only keys never apply. On reload, a key whose .env line is empty or gone falls back to its deployment value (logged as `restored from deployment env KEY`, key names only). It is removed only when the deployment never set it. The keys boot derives after the .env load (`ALPHACLAW_ROOT_DIR`, `PORT`, `PATH`, `HOME`, `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, `XDG_CONFIG_HOME`, `GOG_KEYRING_PASSWORD`) are never touched by a reload.
- **Envars and every .env writer read a duplicate key the way boot does.** `normalizeEnvVars` keeps one entry per key with the last non-empty value, so with `KEY=a` then `KEY=`, Envars shows `a` (the live value) and the next unrelated save writes `KEY=a` instead of dropping it.
- **The .env watcher notices an edit to any line.** Its change signature keeps every line in file order, duplicates included. It used to collapse duplicates to the last line, so with `KEY=a` then `KEY=`, an edit of the first line (the effective value) was skipped as unchanged.
- **Envars shows a platform-provided key as set.** `GET /api/env` reports `source: "deployment"` (never the value) for a known key whose .env line is empty while the deployment sets it, and the field reads "set by the deployment platform" instead of "not set". Clearing it in Envars no longer looks like revoking it.
- **A self-update respawn starts from the deployment environment.** The replacement process is spawned with the recorded baseline as its env, not with `process.env`. That env holds this boot's .env values and lacks keys a reload removed, and the child would have recorded it as its own deployment baseline.

### Behavior changes
- Clearing a platform-provided key no longer unsets it at runtime; the platform value stays, as it already did after a reboot. This covers every path that clears a .env key: editing .env, the Envars page, removing a provider API key on the Models page, and deleting a channel. A channel deleted in AlphaClaw while the platform still sets its bot token (`TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN` …) keeps that token in AlphaClaw's and the gateway's env, and watchdog notices keep using it; to revoke it, remove it from the platform's environment. Envars shows such keys as "set by the deployment platform". A process that did not boot through `bin/alphaclaw.js` (no recorded baseline) keeps the old rule: an empty or missing key is removed.

### Tests
- `env.test.js`: platform-set SETUP_PASSWORD, provider key and bot token with empty lines survive a rewrite and are not logged as removed; a .env override, then cleared, restores the platform value; a file-only key is removed; a known key missing from the file keeps its platform value; duplicate keys ending empty (also shown in Envars and kept through the next save); boot-managed keys untouched; the watcher reloads when only an earlier non-empty duplicate changes; reloading an unchanged file after boot changes nothing (four cases); bin records the baseline before the first `process.env` write and loads .env through the shared rule.
- `alphaclaw-version.test.js`: the respawned process gets the recorded baseline as its env.
- `routes-env.test.js`: a deployment-set key with an empty .env line reads `deployment` with no value in the response; file and unset cases.

## [0.10.146] - 2026-10-27

A pin-bump boot that takes longer than 10 minutes no longer tells the owner the box is back while OpenClaw is still upgrading its data. On a production deploy (OpenClaw 2026.10.7 → 2026.10.8, a 5.2 GB agent database), `doctor --fix` ran for 632 s, so the sidecars' 10-minute fallback fired first and called the deploy announcer: the owner got "back: down 10 min 51 s" and deploy status recorded 651 s, while the gateway was down 733 s (ALPH-50).

### Fixed
- **"Back" means serving.** The sidecar service keeps two latches on its `/readyz` poll: the sidecar start (a native ready, or the 10-minute fallback, as before) and the gateway serving (the downtime note's `isServingObservation`: ready, or unready only because a channel component fails). The deploy announcer's `onGatewayReady` fires once, on the first serving answer, never at the fallback. After the fallback the poll continues every 5 s (so the measured downtime is at most 5 s late) until the gateway serves, `stopAll`, or shutdown, and a probe that resolves after shutdown began is ignored. A ready answer still measures the downtime before the post-boot hook runs.
- **A box that was not onboarded at boot measures no outage.** The announcer is told whether this boot starts a gateway at all (`gatewayExpectedAtBoot`, onboarded at boot). When the gateway first serves after onboarding, nothing is measured and no "back" notice is sent, and such a process never carries an earlier shutdown record forward (it would have reported "back: down N h" to a newly connected channel).
- **A never-ready boot that is redeployed keeps the outage start.** `onShutdown` keeps the earlier shutdown record when this process never saw its gateway serve, so the next boot measures the whole outage instead of only the last container's share. `onGatewayReady` returns early once this process is shutting down.

### Added
- **One "upgrading OpenClaw data" notice.** When the boot starts `doctor --fix` for a pin change, the owner gets "⏳ AlphaClaw is upgrading OpenClaw's data after the update to <version>; replies resume when it finishes. The last data upgrade took about N min." (N from the last pin upgrade's Doctor, recorded as `lastPinUpgrade` on the migration record only when a boot's Doctor completes a real version change; a legacy-state import, watchdog repair, Retry or medic run never sets or clears it; omitted when unknown). Only a pin change sends it: a legacy-state Doctor (same version) or a boot with no earlier version recorded does not. When the gateway first serves, the announcer retires every "upgrading" notice still undelivered, this boot's and any earlier boot's (`retire` on `upgrade-notifier` and `notify-outbox`): a queued copy is closed as expired, and a send in flight stops before its next target. A notice whose channel only opens after the gateway is up (WhatsApp) is therefore dropped rather than sent after "back". It also expires 5 minutes after the expected end (10 minutes when there is no estimate).
- **Every Doctor run prints OpenClaw's startup trace.** `doctor-fix-runner` sets `OPENCLAW_GATEWAY_STARTUP_TRACE=1` (documented in OpenClaw's `docs/gateway/doctor/running.md`) on the Doctor child only, never on the gateway, so `doctor-last-run.log` and the gateway log time each Doctor phase and contribution check on the next pin bump.

### Behavior changes
- The sidecars status `gatewayReadyAt` is the first serving time (null until then); the new `sidecarsStartedAt` is when the gateway sidecars started.
- The post-boot hook gets `ALPHACLAW_SIDECARS_STARTED_AT`. After a fallback start, its `ALPHACLAW_GATEWAY_READY_AT` and `ALPHACLAW_LAST_DOWNTIME_SECONDS` are empty.
- With the trace on, the boot and Retry cards show Doctor's "Checking sessions and transcripts" phase, and an agent schema migration line moves the card back to "Migrating agent databases" (OpenClaw 2026.10.8 migrates agent databases after its checks). A failed Doctor's detail line skips trace timings; the heartbeat's `last=` still shows the newest line. The heartbeat's line tracker frames stdout and stderr separately, so a trace chunk on stderr can no longer splice into a stdout line.

### Tests
- `sidecars-service.test.js`: the fallback starts sidecars but the announcer waits for serving; components-only unready counts as back while sidecars wait for the fallback; a never-serving gateway gets no call and `stopAll` ends the polling; shutdown during an in-flight probe; ready measures before the hook; a fallback hook gets no ready time and a slow hook does not delay the serving notice.
- `notify-outbox.test.js`: a queued upgrading notice held by a failing channel is never sent once retired; a later process draining the file retires its predecessor's notice before sending; a send in flight stops before its next target while other notices go out.
- `deploy-announce.test.js`: serving retires every boot's upgrading notice (not back or shutdown notices) and a late Doctor start sends none; a 733 s boot with one upgrading notice records 733 s; the notice without an estimate and never while shutting down; a ready answer after SIGTERM; a redeployed never-ready boot keeps the outage start.
- `openclaw-boot-migration.test.js`: `lastPinUpgrade` is recorded for 2026.10.7 → 2026.10.8 only, and a later repair outcome leaves it alone.
- `deploy-announce.test.js`: a box not onboarded at boot measures nothing and sends no "back" after onboarding.
- `doctor-fix-runner.test.js`, `doctor-progress.test.js`: interleaved stdout/stderr chunks stay separate lines; the trace env on the Doctor child only; a trace line never becomes the failure detail; migrations after the checks marker are counted.

## [0.10.145] - 2026-10-27

Pin OpenClaw 2026.10.8 (npm `latest` since 2026-10-27 11:24Z). It is a patch release of 162 PRs on top of 2026.10.7: update and Doctor recovery, restart-recovery fences that no longer wedge sessions, retries for transient agent-database lock contention at startup, channel default accounts that keep their secrets, and Codex and Claude CLI turn fixes. It moves neither `openclaw.schemaVersions` (state 20, agent 25) nor `engines.node` (`>=24.22.1 <25 || >=26.12.1`). On real state, 2026.10.7 boots again after 2026.10.8's Doctor has run, so the pin can be rolled back without restoring a backup.

### Changed
- **OpenClaw pin 2026.10.7 → 2026.10.8.** No `lib/` change was needed. Every OpenClaw contract AlphaClaw reads is unchanged in the 2026.10.8 dist: the `gateway-drain` chunk is byte-identical (drain lines, `backgroundExecSessions`), `STOP_DRAIN_TIMEOUT_MS` is still 20 s, `closeOwnedStdioProcess` keeps its stdin EOF / 2 s / SIGTERM / 2 s / SIGKILL close, the owner heartbeat is still 90 s with the same `wait N s and retry` refusal, the restart-recovery note to the model is unchanged, the `model fallback decision … reason=model_not_found` line is unchanged, `openclaw.control.token.v1` is still the Control UI token key, and every export the Codex migration helpers load by name resolves.

### Tests
- `tests/live/database-fixture.js`: `kObservedSchemas` gains the 2026.10.8 row (state 20, agent 25), observed on real 2026.10.7 state after 2026.10.8's `doctor --fix --non-interactive`.
- `tests/live/workspace-alias-move.e2e.test.js`: the doctor-module census strips chunk hashes that contain `-`. 2026.10.8 ships `doctor-repair-mode-CZY1Y--S.mjs`, and the old `[A-Za-z0-9_]{8}` pattern left that hash on the name, so the census failed even though the set of modules was unchanged.

## [0.10.144] - 2026-10-26

A deploy's SIGTERM no longer runs out the ask's window on a gateway that runs a slow-exiting stdio MCP server. OpenClaw 2026.10.7 closes the children it owns as process trees (stdio MCP servers, each under a `service-child-group-anchor.js`) only after the restart drain: stdin EOF, 2 s, SIGTERM, 2 s, SIGKILL. With a server that takes 3 s to exit after its stdin closes, the post-drain close took 7.1 s instead of about 3.5 s on the live tier (3.65 s of it was the child) and 8.9 s in the Render deploy replay. The gateway outlived the ask's window, and v0.10.140's 25 s budget ended it with a signal: `stopped how=sigkill ms=19368` on the live tier, `how=sigterm ms=19095` in the replay (ALPH-46, ALPH-48).

### Fixed
- **The shutdown ask reserves the owned-child close.** When the gateway's process inventory holds a `service-child-group-anchor.js`, `stopGatewayForShutdown` adds `kGatewayShutdownOwnedChildCloseMs` (6 s) to the ask's overhead, so the overhead is 14 s instead of 8 s. The 6 s covers OpenClaw's two 2 s graces plus the slower close measured beside them on a container (12.4 s from the ask to the exit beyond the drain). The drain shrinks by as much, to about 4 s instead of 10 s with the default budget. The ladder waits as much longer for the close, so the ask's window still ends a second before the SIGKILL step. A gateway with no owned child is unchanged. The ladder now passes its `askGraceMs` resolver `{ inventory }` and takes an `askOverheadMs` the resolver returns; the asking line logs `overheadMs=`.

### Tests
- `gateway-restart-ladder.test.js`: a gateway with an anchor in its tree is asked with the 6 s shorter `--wait` and `overheadMs=14000`, and a gateway that needs its drain plus 13 s to exit stops gracefully with no signal.
- `tests/live/shutdown-drain.e2e.test.js` (live tier): a third case adds a stdio MCP server that ignores SIGTERM and exits 3 s after its stdin closes. With an exec turn running, SIGTERM drains, OpenClaw closes the child itself (stdin EOF, then exit), the gateway stops `how=graceful` inside 25 s, and AlphaClaw exits 0. Against main's `gateway.js`, the same case is SIGKILLed at about 19.4 s.
## [0.10.143] - 2026-10-26

OpenClaw's own file log now goes to the data volume instead of the container's /tmp. With no `logging.file` in `openclaw.json`, OpenClaw 2026.10.7 writes a daily log to `/tmp/openclaw/openclaw-YYYY-MM-DD.log`. That directory is hard-coded and does not follow TMPDIR. The log rotates by size at 100 MB and keeps five older files, so one day can reach about 600 MB. On hosts like Render, /tmp is a small volume with its own limit, and the instance is replaced when it fills.

### Changed
- **Boot sets `logging.file` when the operator has not.** `normalizeBootConfig` runs on every boot and after onboarding, before the gateway launches. If `logging.file` is missing, null, empty or whitespace, it sets it to `<root>/logs/openclaw/openclaw-YYYY-MM-DD.log` (`kOpenclawLogDir`, `lib/server/openclaw-log-file.js`). The write goes through the same single `updateOpenclawConfig` call as the rest of the boot normalization, and AlphaClaw logs `[alphaclaw] OpenClaw file log set to <path> (logging.file was unset)` once. The literal `openclaw-YYYY-MM-DD.log` name keeps OpenClaw's daily rolling and its 24-hour pruning. The log gets a directory of its own because that pruning deletes every `openclaw-*.log` in the log file's directory. The other `logging` keys are kept. An operator path is never replaced, including one under /tmp, and a `logging` value that is not an object is left alone. `<root>/logs` was already included in the disk-space census.
- AlphaClaw's own log readers are unchanged. The Watchdog Logs view, `alphaclaw diagnose`, the incident overseer and incident bundles read `<root>/logs/process.log`. `openclaw logs` and the Control UI Logs page read whichever file `logging.file` names, so they follow the new path. README has a new "Log files" section.

### Tests
- `boot-config-normalization.test.js`: sets the path when it is unset, adds a missing `logging` block, treats `""` and whitespace as unset, never replaces an operator path (`/tmp/openclaw/…`, `~/…`, `/data/…`), keeps `level`, `maxFileBytes` and `redactSensitive`, leaves a non-object `logging` alone, writes nothing on the second run, and creates no config or log directory when there is no config. `openclaw-log-file.test.js` covers the pure helper and the path constant.
- `tests/live/openclaw-file-log.e2e.test.js` (live tier) runs the real normalization on a scratch root, then boots the pinned 2026.10.7 gateway. Today's `openclaw-<local date>.log` appears in `<root>/logs/openclaw` with gateway lines, and the gateway's `log file:` startup line names it. `openclaw logs --json` reads it over the `logs.tail` RPC (`sourceKind: "file"`, no local fallback). The gateway writes nothing to `/tmp/openclaw`.

## [0.10.142] - 2026-10-26

A model a chat can pick with `/model` but the provider will not serve now explains itself. On OpenClaw 2026.10.7, `/model` accepts any ref the allowlist permits. When the provider then rejects the model, the reply is "⚠️ This model was not found. Choose another model in the Control UI or run `openclaw configure`". That reply names neither the model, the provider, nor what the provider said. A `/model` choice also turns off the configured fallbacks, so that chat stays broken until someone sends `/model default` (ALPH-47).

### Added
- **Model check** (`lib/server/model-check/`, `GET`/`POST /api/models/check`, admin ops `models.check.read` and `models.check.run`, a Model check card on the Models tab). It reads every ref `openclaw.json` offers: primaries, fallbacks, the `agents.defaults.models` and `modelPolicy.allow` allowlists and their aliases, for the defaults and each agent. For each ref it asks OpenClaw's own listing (`openclaw models list --json`) whether the ref resolves. For custom providers (a `models.providers` entry with a `baseUrl` on `openai-completions`, `openai-responses` or `anthropic-messages`), it sends one request of at most 16 output tokens on the configured API, with the credential OpenClaw would use (`${VAR}`, a bare env name, an env SecretRef, `request.auth`, or the provider's auth profile). When the provider rejects the id, the check also tries the other OpenAI API shape and reads the provider's `/models` list. Each result has a status, the provider's own redacted answer, and one fix:
  - `wrong_api`: the provider serves the model on the other API. Set `models.providers.<p>.api`.
  - `model_rejected` with an empty list: the key works but has access to no models. Enable model access in the provider's dashboard; no config change is needed.
  - `model_rejected` with a list that lacks the id: enable that model for the key, or use one of the listed ids.
  - `unresolved` (no plugin or `models.providers` entry provides the provider), `no_credential` (naming the unset env var), `auth_rejected`, `endpoint_not_found`, `unreachable`, `inconclusive`.

  Plugin-managed providers are reported from OpenClaw's listing without a request. The check never writes config, never returns or logs a credential, and probes only when asked.
- **model_not_found watch** (`lib/server/model-failure-watch.js`). It reads OpenClaw's `model fallback decision: decision=candidate_failed … reason=model_not_found` lines and the `configured fallbacks disabled by user model override` note from the gateway output. It then runs the model check for that one ref and tells the owner, at most once per model per six hours:
  - which model failed and what OpenClaw reported;
  - that the `/model` choice turned off the fallbacks, and to send `/model default` in that chat;
  - the check's reason and fix.

  It also writes a `model_not_found` watchdog event, and `GET /api/models/check` lists recent failures. When a fallback answered instead, the notice says so.
- `alphaclaw-admin` skill (`models.md`): what the agent does when a model will not run. It runs `models.check.run` for the ref, relays the reason and fix, tells the user about `/model default`, and never edits `models.providers` or the allowlist without the owner.

### Tests
- `model-check.test.js`: target collection across scopes and aliases, secret resolution, connection building, answer classification, and a local provider for every status. Covered: the wrong-API case, the empty-entitlement case, a list without the id, an unset env var, a refused key, an unresolved provider, at most 16 tokens per probe, nothing sent with `probe: false`, and no credential in any result even when the provider echoes it.
- `model-failure-watch.test.js`: the notice text with and without a session override, a fallback that answered, the six-hour throttle, split output chunks, secret redaction, and a failed check. `routes-models.test.js`: the check routes and their input validation.
- `tests/live/model-not-found.e2e.test.js` (live tier, pinned 2026.10.7): a provider serves `wonder-1` only on the Responses API, but the config says `openai-completions`.
  - `/model wonder` is accepted, and the next message fails with "This model was not found" and fallbacks off.
  - The watch's notice names the model, the provider's 404 answer, the override and the `api` fix, and the check agrees.
  - A second provider whose `/models` list is empty gets the provider-dashboard fix.
  - After the fix is applied, the next reply and the check succeed.

## [0.10.141] - 2026-10-26

AlphaClaw's own cron job now gets the box's temp directory. cron starts every job with a minimal environment, so the hourly git sync and anything it spawns wrote temp files to the container's own /tmp even where the deployment routes temp onto the persistent disk (the Render template exports `TMPDIR=/data/tmp`). A full /tmp is what made Render replace an instance on Oct 25 (ALPH-24); the deploy-replay e2e (ALPH-46) found that AlphaClaw's cron.d file still left TMPDIR out.

### Fixed
- **`/etc/cron.d/openclaw-hourly-sync` carries `TMPDIR`, `TMP` and `TEMP`** when AlphaClaw's process has them, using the same safe-path rule as the file's other paths. A value cron.d cannot carry is left out with a warning and the file is still written. All three writers (onboarding, the boot reconcile, `PUT /api/sync-cron`) share the builder, so the next boot rewrites an existing file with the new lines.

### Tests
- `system-cron.test.js`: the temp vars are written in order between the state lines and the box-lock lines, an unrelated variable is not, and an unsafe value is dropped with a warning while the file is still written. The exact-content test now passes an empty environment, because the test runner sets its own TMPDIR.

## [0.10.140] - 2026-10-26

A platform SIGTERM (a deploy, a container stop) now uses the time the platform gives. Before, the gateway got a fixed 6 s slice of a 10 s process deadline, SIGTERM first and then SIGKILL. OpenClaw drains a plain stop for up to 20 s, so any deploy that landed while the agent was working SIGKILLed the gateway mid-turn (`stopped how=sigkill ms≈4100` on 2026.10.7 with an exec turn running), and the next boot then waited for OpenClaw's ownership heartbeat to lapse (ALPH-45).

### Added
- **`ALPHACLAW_SHUTDOWN_GRACE_SECONDS`** (default `25`, clamped `10`–`300`, read at process start, deployment env only): how long AlphaClaw may take from a SIGTERM to exit. It is the process's hard shutdown deadline (`kShutdownGraceMs`, `server-lifecycle.js`), and the gateway stop gets everything up to it minus a 3 s tail reserve for the steps after it. The default fits Render's default 30 s shutdown delay with a margin. Set it a few seconds below the platform's grace: `docker stop` waits 10 s unless given `-t`, and Railway's `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` defaults to 0. The log line reads `Shutting down: SIGTERM (budget 25 s)`.

### Changed
- **Shutdown asks OpenClaw for a drain sized to the time left.** `stopGatewayForShutdown({ deadlineAt })` runs the stop ladder with the ask: `openclaw gateway restart --wait <time left − 3 s kill grace − 8 s for the CLI and OpenClaw's close − 1 s slack>` (`graceReason=shutdown_budget`, about 7–10 s with the default budget). Work that ends inside the drain ends normally. A turn still running at its end is cut short and marked for OpenClaw's restart recovery, OpenClaw exits 0 on its own, and the next gateway on the same state resumes the turn. If OpenClaw is still draining at the deadline minus the kill grace, AlphaClaw SIGKILLs it, because OpenClaw ignores SIGTERM while it drains. The ask was chosen over a longer SIGTERM wait from the pinned dist and a live run: a plain stop drains for a fixed 20 s (`STOP_DRAIN_TIMEOUT_MS`) and needed about 27.5 s to exit with a turn running, while an ask with a 10 s drain exited gracefully in 15.5 s. Both paths, and the old SIGKILL, left the turn resumable on 2026.10.7. When no drain fits (a budget of about 15 s or less, or `ALPHACLAW_GATEWAY_STOP_ASK=0`), SIGTERM gets all the time but the SIGKILL step. A caller with no deadline (the self-update drain) keeps the 6 s slice.
- **Stop ladder budget rules.** The ask is `no_budget` only when the time left is less than its grace plus its overhead plus the SIGKILL step. The SIGTERM step is not counted: it adds nothing after an accepted ask, and after a refused ask it gets what is left. The ask's wait and the SIGTERM wait always leave the SIGKILL step its grace before the deadline. A new `askOverheadMs` option replaces the fixed ack-plus-reserve allowance; restart callers keep the old 25 s value, and with their deadlines nothing changes for them.
- A second SIGTERM or SIGINT still exits at once and reaps the gateway synchronously. The shutdown record and the deploy notice still start with the first signal.

### Tests
- `gateway-restart-ladder.test.js`: a deadline that fits asks with the derived `--wait` and stops gracefully without a signal; a drain that outlasts the deadline is SIGKILLed at the deadline minus the kill grace, and the stop ends inside the budget without `stop_failed`; with the ask turned off, SIGTERM runs to the SIGKILL step; the fixed 2 s slice is `no_budget`.
- `server-lifecycle.test.js`: the hard deadline defaults to the budget, the gateway stop gets the budget minus the tail reserve, the self-update drain passes no deadline, and the record, the notice and a second signal behave as before during a long drain. `shutdown-grace.test.js`: the default, the clamp, the junk fallback and the deployment-only registration.