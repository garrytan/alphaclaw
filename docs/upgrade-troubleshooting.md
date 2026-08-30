# Upgrade troubleshooting

Operator runbook for the failure states the OpenClaw upgrade pipeline can
surface (Upgrade tab, notifications, watchdog events). Background: issues
[#18](https://github.com/chrysb/alphaclaw/issues/18) and
[#20](https://github.com/chrysb/alphaclaw/issues/20).

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
stable→beta) quiesce the gateway briefly while the pre-update backup
captures a consistent state DB. Sessions reconnect when the gateway resumes.
If the pause exceeds the apply's own progress timeline, see the run ledger
for which step is stuck.

## Rollback fencing after a DB migration

Rolling back to an older version after the newer one migrated the state DB
is fenced: the older binary cannot verify state written by the newer one.
The first rollback attempt answers `409 rollback_requires_confirmation`,
and its `backupFile` field names the verified pre-update backup to
**restore first**. The UI then shows a second-stage confirm dialog naming
that backup; confirming (`confirmDataRisk: true`) proceeds with the
rollback anyway — data written by the newer version may be unreadable.

## Where the evidence lives

- **Run ledger:** `GET /api/openclaw/runs/:id` (also on disk as
  `runs/<opId>.json` under the OpenClaw managed dir) — step timeline,
  blamed keys, verdicts.
- **Watchdog events:** Watchdog tab event log (restart causes, held states,
  doctor actions).
- **Update logs:** the update log files linked from the Upgrade tab's
  "Technical details" toggle on the progress card.
