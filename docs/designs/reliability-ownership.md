# Reliability ownership

The latest intent owns the result. Interrupted work stays visible. Recovery
either progresses or explains the condition preventing progress. These are
extensions of the existing cache, lifecycle lock, run ledger and notification
outbox; they do not introduce another scheduler or change recovery thresholds.

## Shared reads

`api-cache.js` owns committed data, errors, request generations and subscriptions.
`useCachedFetch` and `usePolling` render that committed state. Routine reads join
the current request for the URL; explicit refresh and mutation invalidation
supersede it. The imperative `cachedFetch` still returns the fetcher's payload,
but an obsolete payload cannot publish into a mounted hook or invoke a stale
revalidation callback. Disabling or removing one consumer fences that consumer
without cancelling a read another consumer needs.

```text
read(URL, generation) → success → commit only if generation is current
          |              |
          |              └→ subscribers render the same committed entry
          └→ timeout/error → retain last success + stale/error + Retry

refresh/mutation → new generation → old result cannot commit
401 → clear protected data + sign-in; 403 → clear key + park automatic reads
```

Ordinary JSON reads include a 30-second transport/body deadline, with a
120-second catalog override. Ignoring AbortSignal cannot extend either bound.
Signal adapters are explicit so positional API arguments do not receive an
options object accidentally. Existing catalog session caching, visibility
pauses and the shell's SSE-first behavior remain in place.

## Crash recovery and repair cleanup

`watchdog-crash-recovery.js` retains one record, one retry timer and at most one
dispatch. Object identity and the captured `servingSeq` fence every continuation.
Maintenance's exit-probe token is not a serving identity. Failed admission or
dispatch without a successor leaves the record pending. Accepted launch/adoption
supersedes it, including during warmup; stopping the watchdog cancels it
synchronously. A failed restart reporting `stopped` is not that Stop intent. Structural
holds and rollback transfer responsibility to their existing recovery paths.
Managed-operation crashes retain the ten-second delay without crash accounting.
Only a real `LAUNCH_REQUESTED` consumes a conflict-relaunch attempt.

`repair-operation.js` owns deadline, cancellation, mutation authority and cleanup
promises. Register writers and restore guards before starting them. Each crash
discovery read is capped at thirty seconds and the remaining lifecycle lease.
Read-only discovery/model work can be abandoned on cancellation, but a writer must finish
cleanup before the lifecycle lease can admit a successor.

```text
working → cancellation/deadline → cleanup → writers and guard confirmed → release
                                    |
                                    └→ 15 seconds unconfirmed → cleanup_blocked
                                                                lock retained
```

The streamed runner owns the spawned process group. TERM→KILL escalation survives
leader exit, closed stdio and post-spawn errors until remaining writers are gone.
Repair and Doctor cancellation use a one-second TERM grace; ordinary update
runs retain their existing grace. Server shutdown joins both watchdog and
Upgrade repair cleanup.
The watchdog status exposes `recoveryPending` (creation time, next check, blocker)
and `lifecycleOperation` (cleanup phase and tracked processes). The dashboard
renders these before old healthy status. There is no cleanup force-unlock.

## Upgrade identity and deployment uncertainty

`openclaw-update-repair.js` saves a ledger run before dispatch, owns an
`update_repair` cleanup lease and uses the repair mutation intent. It checks
onboarding, active/self-update operations and recovery/config holds before
admission and again under ownership. A repair is an in-place operation:
`completed` is its success state; old repair records using `activated` remain
readable. It never mirrors into `lastUpdateRun`.

`use-operation-monitor.js` resumes the exact ledger ID through
`/api/openclaw/runs/:operationId`, including after lost SSE or reload. Another
run's success cannot settle it. Only a command that restarts AlphaClaw enters
restart waiting; a repair or provider acknowledgement does not.

`managed-update-attempts.js` atomically stores schema version 1 in
`<managedDir>/managed-update-attempt.json` before the provider POST. It contains
identity, state, timestamps and target versions/repository/ref, never the bridge
URL or bearer token. Each metadata read is bounded to ten seconds and the POST
to thirty.

```text
preflight → persist submitting → one provider POST → accepted / unknown
                  |                                    |
                  └→ process death → unknown             └→ human checks provider
                                                             |
                                                   resolved deployed/not_deployed

explicit rejection / recognized no-op → submission unlocked
```

Accepted and unknown survive restart and version changes. Neither proves
deployment completion. While unresolved, the attempt blocks another deployment
submission and competing OpenClaw apply, backup or repair mutations. Watchdog
recovery and manual gateway restart remain available. No automatic resend
follows ambiguity, including a
redirect, malformed acknowledgement or lost response. Exact-ID transitions
cannot overwrite a newer attempt or an operator resolution. Each transition
atomically records a pending correlated audit in the same file. Startup and
status reads retry it, with SQLite deduplication covering a crash between
insertion and acknowledgement while the audit remains in normal retention.
The backlog is capped at 32 records; admission reserves three slots before a
new attempt, so audit failure cannot prevent its completion or resolution.
Corrupt attempt storage fails closed and has a deterministic Doctor probe.

`POST /api/alphaclaw/update/:attemptId/resolve` requires a human admin,
`confirmProviderChecked: true`, and outcome `deployed` or `not_deployed`. A local
POST still running rejects resolution with `attempt_in_flight`; stale or
conflicting resolution returns 409. Identical resolution is idempotent. It
records the provider finding and unlocks submission; it neither deploys nor
asserts gateway health.

## Gmail intent and notification deadlines

`gmail-account-operations.js` serializes one active operation and one latest
pending intent per account. Equivalent callers join; replaced pending callers
receive `superseded`. Stop persists disabled intent immediately. Replacement
work waits for the preceding command and confirmed child cleanup. Renewal and
boot can only act on current enabled intent. Ports are reserved before awaiting;
duplicate persisted assignments are repaired deterministically by account ID.
Exact tracked-child identity fences exit callbacks, and a reservation remains
held until termination is confirmed.

```text
Start → active work ─────────────────────────────→ final current intent
           | Stop: persist disabled immediately            ↑
           └→ cancel/finish + confirmed child cleanup → latest pending intent

disconnect owns: Stop → remote revoke → account removal
                       failure → account retained, disabled, retryable error
```

Disconnect blocks Start/renewal with `account_disconnecting`; duplicate
disconnects join. Persisted remote-operation status distinguishes local disable,
pending remote stop and failed remote stop across reloads. An untracked live PID
from a prior process is not killed blindly or allowed to lose its port reservation.

`notification-expiry.js` normalizes the full envelope before policy or queueing.
An overseer notice has one deadline, sixty minutes after first handling, also
stored as `notifyExpiresAt` on its source record. Legacy queue entries use their
original creation time; invalid timing cannot create an immortal message.

```text
first handling + deadline → quiet hold / outbox / retry / fallback / restart
                                      |
                           fresh clock before each recipient
                                      |
                     expired → terminal suppression, partial counts retained
```

Queue pruning or dedupe revival cannot grant a new deadline. The event history
remains, and expiry emits an `expired` suppression audit, deduplicated across
outbox pruning while that audit remains in normal event retention. A transient
audit-write failure is retried without reviving delivery. Other notification
classes retain their existing 48-hour retry/age-out policy.

Operator procedures: [Upgrade troubleshooting](../upgrade-troubleshooting.md).
