# Upgrade troubleshooting

Operator runbook for the gateway failure states an AlphaClaw deploy or an
OpenClaw pin bump can surface (Watchdog tab, notifications, watchdog events).
AlphaClaw runs exactly the `openclaw` version pinned in its `package.json`;
the only way to change OpenClaw is to deploy an AlphaClaw release with a
different pin. There is no in-app version switch, rollback or AlphaClaw-side
backup ladder. Background: issues
[#18](https://github.com/chrysb/alphaclaw/issues/18),
[#20](https://github.com/chrysb/alphaclaw/issues/20),
[#54](https://github.com/chrysb/alphaclaw/issues/54) and
[#76](https://github.com/chrysb/alphaclaw/issues/76).

On the first boot of a new pin, AlphaClaw runs `openclaw doctor --fix` once
before the gateway starts (upstream defers legacy repairs and database
migrations to it) and records the version it completed for in
`<root>/.openclaw/.alphaclaw/openclaw-boot-migration.json`. A Doctor run that
fails or times out sends a notification naming the reason and the gateway
starts anyway; the watchdog's crash classifier and startup medic own whatever
the build then rejects. To retry by hand, run `openclaw doctor --fix` from the
Watchdog terminal, read its output, then restart the gateway.

## Configuration rejected

A genuine configuration rejection names what OpenClaw rejected. On an
`EX_CONFIG` exit the startup medic removes the rejected keys and announces it;
**Repair** runs the Doctor configuration repair and a verified relaunch.
**Restart** does not run Doctor. A refused or skipped request is not a
successful repair, and a pending replacement is not recovered until current
readiness is verified. When the medic latches, fix the blamed keys by hand.

## Managed deployment accepted or unknown

The AlphaClaw update card retains a provider attempt after reload or restart.
**Accepted** means the provider acknowledged the request; **Unknown** means the
request may have been accepted despite a lost, timed-out or invalid response.
Neither means the deployment finished. AlphaClaw does not resend automatically.
An unresolved attempt blocks only another AlphaClaw update submission; gateway
restart, repair, **Back up now** and watchdog recovery remain available.

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

## `doctor_restored_stale_config`

**What it means:** during a repair pass, the doctor tried to restore a
last-known-good `openclaw.json` that was *staler* than your live config.
AlphaClaw detected the stale restore and reverted it — **your config is
unchanged**.

**Next steps:** nothing is broken; the event is recorded so you know the
doctor's snapshot had fallen behind. If it repeats, check that config edits
are going through AlphaClaw (which refreshes the last-known-good snapshot)
rather than hand-editing the file while a stale snapshot sticks around.

## Box was on the removed beta/dev channel

Releases up to v0.9.98 had an Upgrade tab that could run a beta, stable or dev
build on top of the pin. On the first boot of a newer AlphaClaw the bin phase
retires that switch once: it removes the old PATH shim
(`<root>/.openclaw/.alphaclaw/bin`), moves `openclaw-channel-state.json` aside
to `openclaw-channel-state.json.retired-<ts>`, and records what the box was
running in `openclaw-channel-retired.json` (same directory). The box then runs
the pinned OpenClaw. After the notifier is up, the server sends **one** notice
naming the build the box ran and removes the BETA/DEV Control UI stripe the old
switch wrote into `openclaw.json`. Only a box that ran ahead of the pin (a
beta or dev build, or a stable newer than the pin) gets the notice; a box on
the pin or an older stable just moves forward.

The risk is data written by a newer build. If the old overlay migrated the
databases past what the pin can open, the gateway crashes with
`state_schema_too_new` or `agent_schema_too_new` and auto-repair pauses (see
[Auto-repair paused](#auto-repair-paused)). There are two recoveries:

1. Deploy an AlphaClaw release that pins that OpenClaw version or newer.
2. Restore a backup taken before the switch, using OpenClaw's own restore
   procedure (see [Back up now](#back-up-now)).

AlphaClaw does not attempt either on its own. The old overlay store
(`<root>/openclaw-overlay/`, named in the notice when present) is no longer
used and can be deleted once the gateway runs. `alphaclaw diagnose` shows the
retirement record under **OpenClaw** (`retiredChannel`) and the boot report's
`retiredChannel` field.

## Back up now

The General tab's **Backups** card runs OpenClaw's own backup:

```bash
openclaw backup create --output <root>/backups/openclaw --verify --json
```

`POST /api/openclaw/backup` starts it in the background (one at a time;
`409 backup_in_progress` while one runs) and `GET /api/openclaw/backup`
reports `running` plus the last result: the archive path and size, or the
error (the CLI's last stderr lines, or "did not report a verified archive").
The result lives in memory only, so it resets when AlphaClaw restarts; the
archive itself stays in `<root>/backups/openclaw`. AlphaClaw adds no quiesce,
retention, inventory or restore of its own. Delete old archives yourself when
the volume fills.

Restoring is OpenClaw's own procedure. `openclaw backup verify <archive>`
checks an archive, and `openclaw backup restore <archive> --target <dir>`
extracts it into a fresh staging directory (see `openclaw backup --help` and
<https://docs.openclaw.ai/cli/backup>). Stop the gateway before moving restored
files into place, and keep the current state directory until the restored
gateway is verified healthy.

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
`gateway stop --help`, so a broken or stale install that predates the flag is
still handled; an unknown probe result retries on a short TTL). An externally supervised gateway (systemd,
a manual `openclaw gateway run`) is the other common incumbent.

**Next steps:** the operation record's evidence names the pids and whether
the CLI refused. Stop the incumbent yourself (`openclaw gateway stop
--force` on 2026.8.2+, or the external supervisor), then restart from the
Watchdog tab.

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
`gateway_readiness` incident opens when none is), and a pending replacement is
not verified. Readiness alone never triggers `doctor --fix` or a restart — the
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
| `not_ready` | `ok` | `starting` or `draining` | **Transitional** — the gateway itself says it is still coming up (or shutting down). NOT an incident, NOT degraded: no notice, no `degradedReason`; the watchdog re-probes every 5 s (the bootstrap loop, or a single-shot `readiness_recheck` probe outside it) and a pending replacement is not certified yet. Bounded by the ready budget (`GATEWAY_RESTART_READY_TIMEOUT`, default 300 s): past it the same body becomes a real not-ready with `readinessReason: "starting did not complete within 300s"`. A liveness flap in the middle of the phase neither restarts that budget nor lets the next `/readyz` probe error announce recovery (the hold below keeps this row's flavour: health stays healthy, the 5 s cadence continues). An explicit `ready: true` beside such a status is not transitional — it is ready, and the status is telemetry only. | "up, still starting" / "up, draining"; card reason "Up — channels still starting." / "Up — draining." |
| `not_ready` | `ok` | `started` or `null` | **Real not-ready** — `/readyz` names failing components or says `ready: false`. This is the incident described above; `readinessReason` names the components. The detached Doctor may add ONE `readiness_advisory` row ("doctor: <checkId> (<severity>)") when OpenClaw's Doctor reports a runtime secret failure (e.g. `gateway.probe_auth_secretref_unavailable`) — evidence, never a trigger; it runs at most once per failing-component key per 10 min and at most once per 2 min per gateway generation regardless of key, so neither a flapping `/readyz` nor rotating component names can spawn a Doctor on every transition. | "up, not ready"; Running with issues |
| `not_ready` (or `unknown` right after a liveness flap) | `unavailable`, `timeout` or `malformed` | last value | **Probe error while not ready — recovery held.** The last `/readyz` CONSUMED in this gateway generation said not ready — the open degradation episode, which survives a liveness flap (a failed `/health` in between resets `readiness` to `unknown` but not the episode) and ends only with a ready body, a fail-open or a gateway generation change (a relaunch starts a new episode); or a `starting` / `draining` body still inside its budget, whose clock survives a flap the same way (that hold keeps health healthy and the 5 s cadence instead of degrading) — and this one could not be read (connection refused, 5 s timeout, unparseable body). The watchdog does NOT assume recovery: the incident stays open, health stays degraded and the 5→30 s retry ladder keeps probing; one `readiness_probe_error {kind}` row per kind transition (5-min floor per kind; the floor survives a liveness flap and resets with the gateway generation). Bounded by the same ready budget, after which it fails open with `readiness_probe_error {kind, recoveryAssumed: true, heldMs}`, readiness becomes `unknown` and the degradation episode is closed (`readiness_degraded ok {recovered, assumed, kind}`) — the same components afterwards open a new incident. The recovery notice then reads "🟢 Gateway running again — readiness unverified" (a ready body would have given the plain notice). | "up, readiness probe <kind>" |
| `unknown` | `unavailable`, `timeout` or `malformed` | — | Probe error with NO open degradation episode in this gateway generation (a fresh or relaunched gateway, or one whose last consumed `/readyz` was ready): fails open as before — one `readiness_probe_error` row, recovery is not blocked. | plain "up" |

**Why it happens:** a channel token that fails auth, a plugin whose
provider is unreachable, a secrets backend that is slow to answer (a
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
reached its launch step another operation (a user restart, boot) had taken
the lock. Since v0.9.75 the holder asks the lock whether it
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
against an unreachable registry) coinciding with a manual restart. The work already underway is not cancelled — a Doctor that
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

## `alphaclaw diagnose`

The first move on a sick box. `alphaclaw diagnose` (run in the container,
server up or down) prints one markdown bundle of every piece of boot
evidence on the volume: the AlphaClaw version stamp, the last three boot
reports plus the pinned incident report and the last refused start, with
their verdicts; the **OpenClaw** section; a fresh pidfile decision; every
state DB's `user_version` against the installed build's supported schema;
the last three incidents with their classified `cause`; the restart-operation
record; `gateway-state.json`; the backups directory; and the boot-spine lines
of `process.log`. Each section is stamped `live` (computed in this process),
`disk` (read from the volume) or `unavailable` with the reason, so a corrupt
file never hides the rest, and the bundle is secret-redacted before it is
printed. `--json` prints the same bundle as one JSON line. It creates nothing
on the volume.

The **OpenClaw** section and the boot report's bin phase carry the version
facts:

- `pinnedVersion` / `declaredPin` — the `openclaw` version in AlphaClaw's
  `package.json`, the only version AlphaClaw runs.
- `installedVersion` / `installedAtBoot` — the build actually in
  `node_modules/openclaw`.
- `installedDiverged` — `true` when the two differ. That means the image did
  not install the pin (a broken or stale install), never a version choice. It
  also latches `versionMismatch` on `GET /api/watchdog/status`, opens a
  `version_mismatch` incident, prefixes notifications with
  `⚠️ Version mismatch: running <r>, expected <e>` and puts
  `installed_not_expected` in the boot verdict. Redeploy the AlphaClaw image
  (or rerun its `npm install`) so the pinned build is installed.
- `bootMigration` — the boot migration record (`completedForVersion`, `at`):
  the version the once-per-pin `doctor --fix` last completed for. A record
  older than `installedVersion` means the boot migration failed or has not run
  yet.
- `retiredChannel` — the retired in-app version switch this box had
  (`previous: { channel, version, sha }`, `retiredAt`, `notifiedAt`), or
  `null`. See [Box was on the removed beta/dev channel](#box-was-on-the-removed-betadev-channel).

The running server serves the same bundle at `GET /api/diagnose` (JSON
envelope `{ ok, bundle }`; `?format=text` for the markdown) with the live
watchdog status and incident rows the CLI cannot see; the agent-admin op is
`watchdog.diagnose` (tier `safe`). Paste the markdown into the incident. A
`current boot verdict` other than `consistent` names the inconsistency
(`installed_not_expected`, `state_schema_too_new`, `agent_schema_too_new`,
`state_db_unreadable`, `legacy_exec_approvals_present`,
`pidfile_contradiction`). Exit 0 and API `ok: true` mean the bundle was
collected, not that the gateway recovered.

### First five minutes after a deploy

1. `alphaclaw diagnose` prints a `current boot verdict` of `consistent`.
2. `<root>/.openclaw/.alphaclaw/alphaclaw-server.pid` has `format: 2` (the
   legacy claim converged, or the new process wrote its own record).
3. `<root>/.openclaw/.alphaclaw/alphaclaw-version.json` names the AlphaClaw
   version you just deployed.
4. The **OpenClaw** section shows `installedDiverged: false` and a
   `bootMigration.completedForVersion` equal to the pin.
5. The watchdog phase is healthy and the incidents timeline shows this
   boot's `boot` event with its verdict.

## Auto-repair paused

**What it means:** the watchdog stopped relaunching and repairing on its own
because doing so was provably useless: either (a) a crash was classified with
a version-family cause AND corroborated on disk, and the structural repair
could not fix it (`reason: structural_repair_failed`), or (b) the replacement
child the ladder launched died inside its 60 s launch window twice with the
same crash fingerprint (`replacement_exited_twice`). The structural repair
has one fixable cause: a legacy `exec-approvals.json` is renamed aside
(`rename_exec_approvals`) and the gateway relaunched (`relaunch`). Every other
version-family cause pauses at once with plan step `ladder → no_remedy`,
because the OpenClaw version comes only from the pin and there is no other
build to move to.
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

- `state_schema_too_new` / `agent_schema_too_new` — the pinned build is older
  than the schema on disk (a removed beta/dev overlay, or a deploy that moved
  the pin backwards, migrated it). Deploy an AlphaClaw release that pins the
  OpenClaw version that wrote the schema or newer, or restore a backup taken
  before the migration ([Back up now](#back-up-now)).
- `state_schema_migration_failed` — the pinned build refused to migrate the
  state DB. Restore a backup taken before the version change, or deploy a
  newer pin whose migration succeeds.
- `legacy_exec_approvals` — `<openclawDir>/exec-approvals.json` exists on a
  sqlite-era build (2026.8+, issue #23). The rename rung should have handled
  it; if it could not (permissions), move the file aside yourself
  (`exec-approvals.json.stray-<ts>`) and resume.
- `plugin_api_too_old` / `cli_startup_crash` — the installed tree is not the
  pin (`installedDiverged`). Redeploy so the pinned build is installed; if
  the pin itself is the problem, deploy a newer pin or restore a backup.
- Anything under `Suspected cause:` — the classifier matched stderr but no
  independent fact agreed. Treat the stderr as a hint: read the incident's
  crash rows (`cause`, `fingerprint`, `corroborated`) and `alphaclaw
  diagnose`.

**Resuming:** the pause clears by itself when the installed version changes
(a deploy with a new pin) or when a gateway passes the 120 s health hold
(consecutive healthy, identity-clear probes — one green probe is not enough).
`POST /api/watchdog/repair { "force": true }` allows one attempt; the same
fingerprint re-latches. A manual restart does not clear it.
`OPENCLAW_CRASH_CAUSE_LADDER=off` disables the structural ladder and the
pause it creates; classification still records.

## Where the evidence lives

- **Boot reports:** `boot-report.json` under the OpenClaw managed dir
  (`<root>/.openclaw/.alphaclaw/`), rotated to `boot-report.1.json` /
  `boot-report.2.json` by each boot's bin phase — what the bin phase saw
  (`declaredPin`, `installedAtBoot`, `installedDiverged`, `retiredChannel`,
  pidfile decision) and what the server phase recorded (state DB schema,
  config hash, boot migration outcome, `verdict[]`).
  `boot-report-incident.json` pins the first report with a non-empty verdict
  so a restart loop cannot rotate it away. `boot-report-refused.json` holds
  the last start that exited because a live server provably owned the
  directory — written outside the ring so a refused second instance never
  evicts the live server's report.
- **Boot migration record:** `openclaw-boot-migration.json` (same dir) —
  `{ completedForVersion, at }`, the version the once-per-pin
  `doctor --fix` last completed for.
- **Retired channel record:** `openclaw-channel-retired.json` (same dir) —
  present only on boxes that used the removed version switch, beside the
  moved-aside `openclaw-channel-state.json.retired-<ts>`.
- **AlphaClaw version stamp:** `alphaclaw-version.json` (same dir) — the
  AlphaClaw version and commit that booted, first/last boot time, boot count
  and the previous version; the boot banner (`[alphaclaw] AlphaClaw <version>
  …`) is the first line of every boot log.
- **Rescue bundle:** `INCIDENT-<id>.md` in the AlphaClaw-owned Claude Code
  rescue workspace — the inert incident attachment (classified cause,
  versions, fenced stderr lines) a spawned rescue session reads first.
- **Auto-repair pause:** `auto-repair-pause.json` (same managed dir) —
  `{ at, cause, fingerprint, installedVersion, attempts, lastPlan: { rung,
  outcome }, reason }`; present exactly while the pause is latched, re-armed
  at boot for the same installed version, mirrored as
  `GET /api/watchdog/status` `autoRepairPaused`.
- **Backups:** `<root>/backups/openclaw` — the archives **Back up now** wrote
  (also listed in the diagnose bundle's **Backups** section).
- **Watchdog events:** Watchdog tab event log (restart causes, doctor
  actions, `notification_partial`, `notification_abandoned`,
  `restart_incumbent`, `prelaunch_hook`, `readiness_degraded`,
  `readiness_probe_error`, `serving_identity_lost`, the
  `restart/<source>/requested` → `ok {verified: true}` pair a verified
  relaunch leaves behind, and the `repair/<source>/skipped` reasons
  `awaiting_sustained_failure`, `incumbent_startup_grace`, `lease_expired`,
  `state_writer_conflict`, `repair_attempts_exhausted` and
  `auto_repair_paused`; `boot` (one row per boot report: verdict, pidfile
  decision, installed vs expected), `crash_cause` (the classifier's
  corroboration follow-up), `version_mismatch`, `auto_repair_paused`, the
  `repair/structural/*` rows with their `plan[]`, `readiness_advisory` (the
  detached Doctor's structured finding on an open readiness incident, `warn`)
  and `event_loop_pressure` (`warn | ok` telemetry — never an incident);
  `crash` rows carry `cause` + `fingerprint`). Older event records may still
  carry retired kinds (`backup_*`, `state_db_quiet`, `launch_compat_gate`,
  `reconcile_installed`, `config_migration_gate`, `channel_rollback`); they
  stay readable.
- **Watchdog status:** `GET /api/watchdog/status` — `readiness` /
  `readinessReason` / `readinessProbe` / `readinessStatus` (see "Gateway is
  up but not ready"), `servingPid` / `servingRootPid` / `supervisionMode`,
  `replacementPending`, `lastRepairVerdict`, `degradedRepairThreshold`,
  `incumbentConflict` (kind, holder pid/role), `incumbentGraceUntil`,
  `versionMismatch` (`{ expected, running, source, detectedAt }` or `null`),
  `autoRepairPaused` and `lastExit.cause`. The repair response
  (`POST /api/watchdog/repair`) carries `ok`, `verdict`, `pending`,
  `replacementPending` and, on `ok: false`, `error` plus an operator
  `message`.
