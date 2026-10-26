# Changelog

All notable changes to AlphaClaw are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow this repository's `package.json` release counter.

## [0.10.144] - 2026-10-26

A deploy's SIGTERM no longer runs out the ask's window on a gateway that runs a slow-exiting stdio MCP server. OpenClaw 2026.10.7 closes the children it owns as process trees (stdio MCP servers, each under a `service-child-group-anchor.js`) only after the restart drain: stdin EOF, 2 s, SIGTERM, 2 s, SIGKILL. With a server that takes 3 s to exit after its stdin closes, the post-drain close took 7.1 s instead of about 3.5 s on the live tier (3.65 s of it was the child) and 8.9 s in the Render deploy replay. The gateway outlived the ask's window, and v0.10.140's 25 s budget ended it with a signal: `stopped how=sigkill ms=19368` on the live tier, `how=sigterm ms=19095` in the replay (ALPH-46, ALPH-48).

### Fixed
- **The shutdown ask reserves the owned-child close.** When the gateway's process inventory holds a `service-child-group-anchor.js`, `stopGatewayForShutdown` adds `kGatewayShutdownOwnedChildCloseMs` (6 s) to the ask's overhead, so the overhead is 14 s instead of 8 s. The 6 s covers OpenClaw's two 2 s graces plus the slower close measured beside them on a container (12.4 s from the ask to the exit beyond the drain). The drain shrinks by as much, to about 4 s instead of 10 s with the default budget. The ladder waits as much longer for the close, so the ask's window still ends a second before the SIGKILL step. A gateway with no owned child is unchanged. The ladder now passes its `askGraceMs` resolver `{ inventory }` and takes an `askOverheadMs` the resolver returns; the asking line logs `overheadMs=`.

### Tests
- `gateway-restart-ladder.test.js`: a gateway with an anchor in its tree is asked with the 6 s shorter `--wait` and `overheadMs=14000`, and a gateway that needs its drain plus 13 s to exit stops gracefully with no signal.
- `tests/live/shutdown-drain.e2e.test.js` (live tier): a third case adds a stdio MCP server that ignores SIGTERM and exits 3 s after its stdin closes. With an exec turn running, SIGTERM drains, OpenClaw closes the child itself (stdin EOF, then exit), the gateway stops `how=graceful` inside 25 s, and AlphaClaw exits 0. Against main's `gateway.js`, the same case is SIGKILLed at about 19.4 s.

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
- `tests/live/shutdown-drain.e2e.test.js` (live tier): a real `alphaclaw start` on the pinned 2026.10.7 with an agent turn inside an exec call gets SIGTERM. With the 10 s floor the gateway is SIGKILLed. With the default it drains, exits 0 inside 25 s, writes the shutdown record and the deploy history, and the next AlphaClaw on the same root resumes the turn.

## [0.10.139] - 2026-10-26

Boot native maintenance (the Codex migration, then the Codex plugin reconciliation) runs once per OpenClaw build and per version of its scripts instead of on every boot. A same-version restart with an already-migrated state skips both helpers, which cost about 3 s per boot on 8 CPUs and about 17 s on half a CPU, before the gateway could launch (ALPH-44).

### Changed
- **A stamp decides, and any doubt runs the helpers.** After both helpers exit 0, `<managedDir>/codex-maintenance.json` records the executing OpenClaw build (`dist/build-info.json` `buildId`, else the package version), a hash of the maintenance sources, a hash of `openclaw.json` as the run left it, a hash of every agent's auth profile ids, providers and types (never their credentials, so a token refresh does not count), a hash of any legacy JSON auth store's name, size and mtime, and a hash of the installed Codex plugin packages. The next boot skips only when all of them still match, and logs `Codex migration and plugin reconciliation skipped: already done for OpenClaw <build> with this config (<time>)`. Otherwise it logs why it runs (`OpenClaw build changed`, `openclaw.json changed`, `auth profiles changed`, `legacy auth store changed`, `Codex plugin install changed`, `maintenance scripts changed`, `no record of a completed run`, `inputs unreadable`) and runs both helpers as before. The record is removed before a run and written only after a run in which every helper exited 0, so an interrupted, failed or timed-out run is retried on the next boot. A box with something left to migrate (Connect Codex's deprecated `openai:codex-cli` profile id, for example) still runs it, because that write changes the config or the auth profiles.
- **Diagnostics are summarized, not withheld.** A helper that writes stderr now logs `<label> completed with diagnostics, N lines: <first> | <second> | <third> (+K more)` (or the same summary on its failure line) instead of "emitted diagnostics; child output withheld". Each line is redacted (the child env's and config's secret values, secret-named assignments, token shapes) and clamped to 160 characters.
- **The plugin reconciliation exits 1 when it could not finish**: an unknown active OpenClaw version, a `plugins list` that failed (it used to read as "not installed") or a failed install. Boot continues as before; the exit only keeps the run from being recorded, so the next boot retries.

### Tests
- `boot-native-maintenance.test.js`: the first boot runs and records, a same-build boot skips, a token refresh alone skips, and each input change (build, config, auth profile, legacy auth store, Codex plugin install, sources) runs it again. The helpers' own config write does not trigger a rerun, a failed or timed-out run is never recorded, unreadable inputs always run and record nothing, and the diagnostics summary is redacted.
- `reconcile-codex-plugin.test.js`: a failed plugin list is `plugins-unknown`, and the script exits 1 for it, for an unknown version and for a failed install, and 0 when the plugin is current.
- `tests/live/boot-native-maintenance-once.e2e.test.js` (live tier): real AlphaClaw boots on the pinned OpenClaw. The first boot without a record runs (about 3.3 s of maintenance), the same-build reboot skips it and is ready about 3 s sooner, a planted `openai:codex-cli` profile runs it and is migrated to the canonical id, and a record from another OpenClaw build runs it.

## [0.10.138] - 2026-10-26

The Box card keeps a restart history (the last 20 boots or 14 days) and says why each boot happened. A boot that follows no AlphaClaw shutdown record and no AlphaClaw restart is classified as an unclean exit ("platform or crash"), with how long the box was down, and the agent's downtime note now says so instead of giving no cause.

### Added
- **Shutdown record.** A graceful exit (SIGTERM, SIGINT, or the crash guards' own drain after an uncaught exception or a rejection storm) writes `<managedDir>/last-shutdown.json` (`{ kind: "shutdown", reason, code, atMs }`, atomic) as the drain begins, and a self-update restart (`restartProcess`) writes `{ kind: "restart", reason: "update" }` before its drain. The next process reads and deletes it once at startup (`lib/server/box-status/boot-cause.js`), so it explains one boot only.
- **Boot cause.** Each boot is classified at startup and recorded on its `boot-history.json` row as `cause: { kind, label, reason, shutdownAt, gapMs }`. `kind` is `shutdown` ("Clean shutdown (SIGTERM)", or "AlphaClaw exited on an error (…)" for a non-zero code), `restart` ("AlphaClaw restart (update)"), `unclean_exit` ("Platform or crash": no record, so the platform replaced or killed the container, or AlphaClaw died past its crash guards; the two cannot be told apart from inside) or `first_boot` (no last-serving stamp and no boot history). `gapMs` is the time from the persisted last-serving stamp (`gateway-last-serving.json`) to this boot's start. A record the gateway outlived by more than a minute is stale and ignored. The server logs one `[alphaclaw] boot cause: <kind> gap_ms=<n>` line.
- **`GET /api/box/restart` returns `boots`**: the retained history, newest first, each with `bootId` (the public boot id) and `cause`. `lastBoot` and `previousBoot` stay (they are its first two rows) and carry the same two new fields. The `box.read` manifest description names the new field.
- **Box card.** A "Last boot" row shows the cause badge (warning tone for platform or crash), when, how long the box was down and how long it took to be ready. Expanded, a "Boots" row lists the whole history; boots recorded before this version read "Cause not recorded". The expand button reads "Boots, schedules and disk".

### Changed
- **Boot history retention.** `boot-history.json` keeps the last 20 boots or 14 days, whichever bound is hit first (it kept 20). The row being written is always kept. Boot duration estimates still use the last three comparable successful boots among the retained rows.
- **Downtime note cause.** When the episode a process boots into carries no cause and the boot is classified `unclean_exit`, the note says "after an unclean exit (platform replacement or crash)" (new cause `unclean_exit`). A cause the previous process recorded (a crash, a restart, a repair) still wins, and a clean shutdown still carries no cause.

### Tests
- `box-boot-cause.test.js` (new): a graceful shutdown record reads as `shutdown` with the gap, a crash guard's drain as an AlphaClaw error, a self-update restart as `restart`, no record as `unclean_exit` with `gapMs`, no stamp and no history as `first_boot`; a record is consumed once; stale, unreadable and foreign records are ignored; a failed write never throws.
- `boot-progress-history.test.js`: the 20-boot and 14-day bounds, the new row always kept, undated rows kept within the count; the timeline records the cause on its row.
- `box-last-restart.test.js`: the route's `boots` array newest first with causes, `lastBoot`/`previousBoot` compatibility, and `boots: []` when nothing is known.
- `gateway-downtime-note.test.js`: an `unclean_exit` boot names the cause in the note, a recorded crash cause wins, a clean shutdown stays causeless.
- `watchdog-box-card.test.js`: the boot section, the older-server `lastBoot` fallback, the collapsed "Last boot" row and the expanded history.
- `alphaclaw-version.test.js`: `restartProcess` writes the restart record after the exit latch and before the drain.

## [0.10.137] - 2026-10-25

A gateway killed in another container (a killed deploy, an OOM kill, a SIGKILL from the stop ladder under tini) no longer keeps the next container's gateway down for the gateway-owner lease's full five minutes. The watchdog now relaunches when OpenClaw's own ownership heartbeat lapses, about 90 s after the dead gateway's last beat, and the boot card says what it is waiting for (ALPH-43).

### Fixed
- **Relaunch at the heartbeat's lapse, not the lease's expiry.** On OpenClaw 2026.10.7 a gateway started in a new PID namespace while the previous gateway's state-owner heartbeat is under 90 s old is refused at once: the CLI bootstrap's shared-state read raises `GatewayLockNamespaceError` ("Cannot read shared state for discovery: … cannot verify Gateway ownership from this process (different PID namespace) … wait N s and retry") and `gateway run` exits 1, with no retry of its own. The watchdog already classified this as `owner_lease_held`, but it held the relaunch until the `state_leases` row's recorded expiry (up to 300 s) and only reclaimed that row for a holder on another host. Same-host PID namespaces never qualified. On a GitHub runner the gateway stayed down for more than 3 minutes. The classifier now reads upstream's own countdown from the refusal (`retryAfterMs`, only from the namespace-refusal line, at most 95 s), the conflict carries `heartbeatLapseAtMs` (the exit time plus the countdown plus a 2 s margin), and the watchdog relaunches at that instant on a dedicated timer instead of on the next degraded tick (up to 30 s later). The wait skips the lease re-read and the reclaim. AlphaClaw never deletes or edits OpenClaw's lock files and never relaunches before upstream says it will accept the takeover; OpenClaw decides again on every relaunch. A holder that keeps beating (a second live container on the volume) is refused with a fresh countdown each time, and the existing conflict relaunch budget (3 in 5 minutes, with exponential backoff) latches it into the "keeps being renewed" notice. Refusals without a countdown (the 2026.9.x lease wording) keep the expiry-based wait.
- **The boot waits instead of failing.** The boot timeline used to end `failed (readiness_failed)` as soon as the watchdog went degraded on the conflict. While the watchdog holds a transient ownership conflict (`owner_lease_held` or `state_writer_conflict`), the boot now shows a `lock_wait` step ("Waiting for OpenClaw's state ownership") and follows the relaunch to ready. A relaunch cap still fails it (`gateway_exited`), and so does the ready backstop. The boot card adds a line: "The previous gateway's OpenClaw state ownership has not lapsed yet (OpenClaw allows a takeover 90 s after its last heartbeat) — retrying in about 41s", or, for a state writer, "Another OpenClaw process holds the state database — retrying once it releases". The authenticated status frame carries `bootProgress.lockWait` (`{ kind, untilMs }`); the public frame does not.
- The watchdog notice and the Watchdog tab's degraded reason name the heartbeat wait and the time left, instead of "leases lapse five minutes after their last heartbeat".

### Tests
- `openclaw-lock-contention.test.js`: the countdown is read from the 2026.10.2 refusal, its wrapped forms and the 2026.10.7 discovery-read wording; it is not read from another line in the tail, from a missing countdown, or from one over 95 s.
- `watchdog.test.js`: a 2026.10.7 refusal at boot holds the relaunch through degraded ticks without touching the lease, relaunches within 50 ms of the countdown (not at the lease's 289 s expiry), and a second refusal re-arms the wait with the conflict backoff. No crash row, no reclaim, no Doctor.
- `boot-progress-timeline.test.js`, `boot-progress-card.test.js`: the lock wait is non-terminal and visible (human projection only), the relaunch returns to `gateway_launch` and reaches ready, a relaunch cap still fails the boot, and the card shows the countdown copy.
- `tests/live/gateway-stale-heartbeat-relaunch.e2e.test.js` (live tier): a real AlphaClaw and 2026.10.7 gateway run in their own PID namespace (`unshare -U --map-current-user -pf --mount-proc`), the whole namespace is SIGKILLed, and a fresh AlphaClaw boots right away on the same root. The test requires the namespace refusal, the `lock_wait` step with the right lapse time, one relaunch no earlier than the heartbeat's lapse and within 8 s of it, `/readyz` ready within 90 s plus a 60 s cold-boot margin of the kill, and the boot timeline ending ready.

## [0.10.136] - 2026-10-25

The `alphaclaw-admin` skill is an index plus one reference file per domain, so a new admin op no longer has to trim another domain's text to fit one 63k file, and the skill is readable again on models with less than about 160k tokens of context (ALPH-42).

### Changed
- **`SKILL.md` is a short index.** It keeps the intro, how to call, the Ground Rules, the Admins table, Current State and the Quick Recipes, then one row per domain: title, `references/<domain>.md` link, op count and a one-line summary. Each domain's prose and generated op table move to `skills/alphaclaw-admin/references/<domain>.md`, which the agent reads with its read tool when a question touches that domain (paths relative to `SKILL.md`, the convention OpenClaw's bundled skills use; `alphaclaw admin manifest --domain <name>` stays the fallback). The error-code table and long-running-operation guidance move to `references/errors.md`. Every op, recipe and fragment still renders; nothing about op behavior changes. On the maximal fixture the index is about 11k characters (was 62.6k for the whole skill) and the largest domain file (watchdog) about 6.7k.
- **OpenClaw could not serve the old file.** OpenClaw 2026.10.7 serves a skill file through the read tool only whole, up to max(32 KiB, 10% of the model's context at 4 chars per token), and otherwise answers "Skill instructions cannot be partially served". The single 62.7 KB `SKILL.md` was refused that way for a 128k-context model; every file now stays under 32 KiB.
- **Each admin-manifest domain module carries a `summary`** (one line, at most 160 characters, no `|`), which the index renders. The manifest refuses a domain without one. `getDomains()` returns `{ domain, title, summary }` per domain. Domain titles now render in the skill (the old builder fell back to the domain id).
- The installer writes the reference files before `SKILL.md`, deletes reference files the manifest no longer produces, and removes the `references/` directory with the skill when the feature is turned off.

### Tests
- `agent-admin-skill.test.js`: the index stays under 16k characters and every reference file under 12k on the maximal fixture (replacing the single 63k cap), and every file under 32 KiB; each op's command is in its own domain's file; the index links exactly the files produced; every fragment renders; every domain row shows its title and summary; the installer writes the files, drops a stale one, and removes them when disabled.
- `admin-manifest.test.js`: one summary per domain, shared by the box views under watchdog.
- `tests/live/admin-skill-references.e2e.test.js` (live tier): on the real pinned gateway with a scripted model, `alphaclaw-admin` is in the agent's skill catalog, the read tool serves the index whole, the agent opens `references/webhooks.md` relative to it and answers from that file.

## [0.10.135] - 2026-10-25

Env changes the operator and the agent can reason about: a one-key PATCH, a PUT confirm that says what it would delete, reserved keys skipped instead of failing the write, and a list of the processes still running with the old value (ALPH-39).

### Added
- **`PATCH /api/env` sets or deletes one key.** `{"key":"K","value":"v"}` sets it, `{"key":"K","delete":true}` removes it, and every other key in `.env` stays as it is. It runs the same save path as PUT (channel sync, auth-profile sync, the restart reason only when the gateway's launch env changes, the bootstrap prompt rewrite) and returns the same body. Reserved, managed-channel and AlphaClaw-managed keys are refused with a 400 that names the key. Like PUT, it takes the operator box lock (step `envars-write`, by `api:env`): it waits for another holder up to the configured time, or at once with `?boxLockWait=0`, then answers 409 `box_locked`. In the admin manifest it is `env.patch` (restart tier); deleting or blanking an existing secret-class key, or changing a Claude Code launcher key, escalates to a dangerous-tier confirm, as with PUT. The `alphaclaw-admin` skill's env page and the key-rotation recipe now use it.
- **Processes still running with the old value.** After a save that changed keys, the response carries `staleProcesses`: for each changed key, the processes under AlphaClaw's user whose `/proc/<pid>/environ` holds a different value (`differs`), still holds a deleted key (`still_set`), or, inside the gateway's process tree, lacks a key the gateway is launched with (`missing`). Gateway processes are judged against the gateway's launch env, every other process against `.env`. Each value is SHA-256 hashed as it is read and compared in constant time; only key names, pids and command names leave the scan, and nothing is logged or stored. AlphaClaw's own process is skipped (its env is updated in place). `GET /api/env/stale-processes?keys=A,B` (default: every key in `.env`) answers the same question at any time; it is a safe-tier op for the agent (`env.stale-processes`).
- **The Envars tab shows that list** under the save, with a Dismiss button, so an operator sees which sidecars to restart besides the gateway.

### Changed
- **Reserved keys in a PUT are skipped, not fatal.** A reserved or deployment-only key in the body used to fail the whole write with a 400. It is now left out, and the response lists it in `skipped` with a warning per key (`PORT is reserved and was not saved.`; a deployment-only key says to set it in the deployment environment). The Envars tab shows each warning as a toast. A body whose every key is reserved writes nothing, since a full replacement without them would delete every editable key.
- **The PUT confirm says what the write would delete.** When an agent's PUT escalates to a confirm, the summary the operator sees (dashboard and admin channel) names how many currently-set keys the body omits or blanks, for example `Replace environment variables: would delete 2 keys (ANTHROPIC_API_KEY, BRAVE_API_KEY)`. Manifest ops can now describe the exact request with `confirmSummary(req)`; a missing, empty or throwing description falls back to the op title.
- The env routes moved out of `routes/system.js` into `routes/env.js` (same behavior and registration point). PUT keeps v0.10.122's box lock unchanged, now in the write path PUT and PATCH share.

### Tests
- `env-stale-processes.test.js`: against real `/proc`, a child started with the old value is listed by pid and command and one with the new value is not; a deleted key is `still_set`; a gateway-tree process missing a launched key is `missing`, and not when the launch env strips the key; this process is skipped; neither value appears in the result.
- `routes-env.test.js`: PATCH refused with 409 `box_locked` while another holder has the box lock (nothing written; `?boxLockWait=0` refuses at once), then holding the lock once it is free; PATCH set, delete, no-op delete and every refusal; the scan gets exactly the changed keys and the post-save values; no scan without a change; a throwing scan never fails the save; the read route's defaults, key list and validation.
- `admin-manifest.test.js`, `agent-admin-confirm.test.js`: the delete-count summary (and its 10-name cap), the PATCH tier rules, the stale read's tier, and the summary fallback.
- `routes-system.test.js`, `deployment-env-agent.test.js`: reserved and deployment-only keys are skipped with warnings and never written; PATCH refuses them.
- `envars-component.test.js`: the skipped-key toasts, the stale list after a save, and Dismiss.

## [0.10.134] - 2026-10-25

A compact Box card on the Watchdog tab: processes, the last restart and MCP servers at a glance, schedules and disk one click away (ALPH-40, 7 of 7).

### Added
- **Watchdog → Box card**, below Resources. Always shown: processes per owner (count and RSS), the last gateway restart (outcome, when, who asked, downtime, reason) and the gateway's last unexpected exit, and the MCP servers with each failing server's last error. **Schedules and disk** expands OpenClaw, AlphaClaw and system cron counts with the next run and failing cron jobs, free space, the state dir's largest folders and each feature's copies with how many are due for cleanup. Problems (a failing MCP server, a restart that did not reach ready, failing cron jobs, cron lines without a cron daemon) show as badges in the header without expanding. Read-only: the card has no actions.
- The card reads the box views every minute while the tab is visible (schedules and disk only while expanded; disk every 5 minutes), all cached server-side.

### Tests
- `watchdog-box-card.test.js`: the view model for every view, the header badges, a failed restart, nothing loaded yet, and the collapsed and expanded rendering.

## [0.10.133] - 2026-10-25

Which MCP servers the gateway has, how many tools each brings and why one did not start, plus one owner notice when a server fails to start (ALPH-40, 6 of 7).

### Added
- **`GET /api/box/mcp`** (`box.read` view `mcp`): every MCP server from `openclaw.json` `mcp.servers` and every server the gateway reported on, with `configured`, `enabled`, `transport`, a redacted `target` (URL origin and path, or the command's name and argument count), `lastEvent` and `lastError` (kind, time, whether it happened since the gateway's last launch, redacted message) and `failing` when the server's last event this launch was an error. `probe=1` runs OpenClaw's own `openclaw mcp probe --json` (it connects to each server once, starting stdio servers briefly, 45 s budget, at most once per 10 minutes) and fills `toolCount`; the result is reused by later reads until it expires.
- **MCP start failures reach the owner.** OpenClaw starts an MCP server the first time a session needs it and reports a failure only as a `bundle-mcp:` warning in the gateway output, so the agent quietly ran without the server's tools. AlphaClaw now reads those lines (`lib/server/mcp-watch.js`): failed to start, skipped (unsupported transport or launch), and a failed connection resolver send one notice and one `mcp_server_failed` watchdog event per server per gateway launch; refresh failures, tool-list failures, closes and recycles are recorded for the view without a notice. Messages are redacted. Nothing is restarted or reconfigured.

### Tests
- `box-mcp.test.js`: a start failure recorded, redacted and notified once per launch (the second launch notice of the same generation does not re-arm it, a new generation does), a skipped server across split output chunks, closes and recycles without a notice, a failing notifier or ledger never throwing; the view joining config, the gateway's reports and a probe without showing a secret, the probe cache, a failed probe and an unreadable config, and the route's `probe` validation.

## [0.10.132] - 2026-10-25

Back up now archives and OpenClaw's Doctor and update captures no longer pile up forever: the periodic sweep keeps the newest 3 and anything younger than 7 days, and removes only what those features made (ALPH-40, 5 of 7).

### Added
- **Copy retention** (`lib/server/copy-retention.js`), run by the watchdog's existing 30-minute sweep right after the snapshot-copy sweep. Per family it keeps the newest `ALPHACLAW_BACKUP_RETENTION_KEEP` (default 3) and anything younger than `ALPHACLAW_BACKUP_RETENTION_DAYS` (default 7), and removes the rest one item at a time. Both are deployment env only: from `.env` an agent could shrink them and have the sweep delete backups.
- **Only the feature's own copies are candidates.** A Back up now archive must be a regular file named like OpenClaw's archives (`<timestamp>-openclaw-backup.tar.gz`) and owned by AlphaClaw's user. An update capture must be a directory owned by AlphaClaw's user that carries OpenClaw's private capture marker with its exact content and is sealed (`manifest.json` present, no `manifest.json.partial`); its age is the manifest's mtime. An operator's own file or folder in either place is never touched, whatever its age. Nothing a process holds open is removed (read from `/proc` right before the delete; without `/proc` nothing is removed). Each sweep that finds something due logs one `[alphaclaw] retention sweep` line. Like the snapshot sweep it runs under the operator box lock (step `sweep-delete`) when one is configured, without waiting: while another operator holds it the sweep is skipped and the next one retries.
- **`GET /api/box/disk` shows it.** The `alphaclaw_backups` and `openclaw_update_captures` groups carry `retention` (`keep`, `days`, how many are `due`, and the last sweep's removed count, freed bytes, held and failed), and each item its verdict: `kept_newest`, `kept_recent`, `due` or `not_managed:<reason>`. The box schedule list names the retention removals in the sweep's last detail.

### Tests
- `copy-retention.test.js`: the env policy and its fallbacks, newest-3/7-days verdicts, an operator's archive and a directory with an archive name never planned, captures without the marker, with a forged marker, unsealed or unpublished never planned, another owner's items never planned, removal of what is due with a held-open item kept, nothing removed without `/proc`, a quiet sweep, and the verdicts in the disk view.

## [0.10.131] - 2026-10-25

Disk use of the box by folder: the volumes, the state directory's top-level folders, the temporary copies each feature leaves behind, and who still holds files open under a path (ALPH-40, 4 of 7).

### Added
- **`GET /api/box/disk`** (`box.read` view `disk`):
  - `volumes`: free and total bytes of the state volume and any diagnostic-dir volume, as the disk-space monitor reads them.
  - `stateDir`: the gateway state directory's top-level folders by allocated size, largest first (100 shown), and the bytes in its top-level files.
  - `temp`: each feature's copies with count, bytes, newest and oldest modification and the 50 newest items: OpenClaw's SQLite read-only snapshot copies, OpenClaw's Doctor and update captures (`<state>.update-captures`), OpenClaw package and shim backups beside the state dir, `openclaw.json` backups (Doctor, medic, rotation, quarantine), and Back up now archives. A hand-named copy such as `openclaw.json.backup-by-hand` is not counted as a feature's copy.
  - `openUnder=<absolute path>` adds `openFiles`: the processes holding files open under that path from `/proc/<pid>/fd`, with deleted files and the bytes they still hold listed first, since that space only comes back when the holder closes them.