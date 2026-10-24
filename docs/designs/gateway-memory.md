# Gateway memory measurements and pressure policy

Issue #85 separates the memory being measured from the explanation for its growth.

```text
serving root + worker identity
  /proc group RSS + actual cgroup usage → pure pressure detector → watchdog gates
  gateway-reported heap + natural GC    → advisory attribution   → Resources / Doctor
  bounded Linux PSS                    → shared-page explanation → frozen episode
```

## Measurement scopes

The serving root is selected once for Resources and incident snapshots. The
watchdog uses the same tracked root; PID and `/proc` start ticks identify each
process lifetime. Within that group the worker, worker descendants, and remaining
launcher/sibling branches form disjoint RSS totals. `processes.gateway.rssBytes`
remains a whole-group RSS alias. A truncated census is partial evidence and
cannot confirm a restart.

**Enforcement basis (ALPH-17).** `gatewayMemoryTrend.rssMb` is the series the
pressure detector judges, and `gatewayMemoryTrend.rssBasis` names it. `worker`:
the gateway worker's own RSS, used when the worker is proven from `/proc` as the
process holding the gateway port (gateway.js's launch identity carries
`workerVerified`; the first-child fallback does not count). The root and worker
records are read first, so a census that goes partial later still yields a worker
sample. `group`: the whole group, used only when the worker is unproven; the
watchdog logs `mitigation_skipped reason=worker_unverified` once per episode and
never restarts on it. A basis change resets the series and freezes any episode as
`basis_changed`, because the step between the two would read as growth. Children
are reported beside the worker (`groupRssMb`, the evidence split, the largest
child by pid) and never enter the enforced series: a gateway restart cannot free
a tool child's memory. On the worker basis, container pressure counts toward the
verdict only while the worker holds at least half of a completely censused group
and is itself growing at 64 MB/h or more. When the container goes critical
because of tool processes, the owner is told once per container episode which
command the largest child runs (its executable's basename, else `/proc/<pid>/comm`,
withheld unless it is a plain token; never argv, a path or the pid, and only in the
notification) and how much it uses against the container limit, and that the kernel
will kill it if it keeps growing. The watchdog neither kills the child nor restarts
the gateway: the kernel picks the child anyway (OpenClaw sets its tool children's
`oom_score_adj` to 1000), and a restart would end it too. `tests/server/gateway-memory-incident-replay.test.js`
replays the Oct 22 incident (worker flat at 3837 MB, one child growing to 2754 MB
at 2021 MB/h, group 7239 MB against an 8384 MB budget). Static process roles do not
identify MCP sessions, activity, or orphaned children.

RSS counts shared pages in every process. It is not an additive decomposition of
cgroup usage. Container pressure therefore uses only the cgroup's own working
set over its limit: usage minus `inactive_file` from the same cgroup's
`memory.stat` (`total_inactive_file` on v1), as `docker stats` reports it
(#125). Raw usage stands in when `memory.stat` is unreadable, and when inactive
file pages are not below usage. Process RSS is displayed separately. Linux `smaps_rollup` provides a paired RSS,
PSS, and private-page sample on the first opportunity and then every five minutes.
At most 128 processes and 16 KiB per file are read, including every short read.
A file that fills the buffer is rejected without reading an extra byte to check
for end of file. There is one chain in flight and a one-second scheduling
deadline. Late results are rejected; an in-kernel read is allowed to finish
before another chain starts. Coverage, timing, failures and
staleness are explicit. Six minutes or a membership change invalidates current
PSS. Partial totals are not presented as complete group totals.

## Optional gateway telemetry

The child startup environment adds a caught dynamic import through a `data:`
bootstrap. Missing or broken sampler files cannot prevent gateway startup.
Eligibility checks run before package imports. The option survives the compile
cache launcher, then is removed from the serving process environment so later
tools do not inherit it. Operator `NODE_OPTIONS` remain intact. The main-thread
sampler activates when the pinned gateway identifies itself as `openclaw-gateway`.
Other entrypoint/title variants degrade to unavailable telemetry.

The sampler publishes immediately and every 30 seconds: process RSS, heap
used/total, actual V8 heap limit, external memory, and ArrayBuffers. ArrayBuffers
are included in external memory. A natural major-GC observer records the lowest
heap measurement observed in each publication interval, with its original event
time; callbacks delayed more than one second and forced collections are excluded.
These are observations after GC delivery, not an exact synchronous V8 GC hook.

Each private atomic file retains 128 publication records (at most 64 KiB), so a
minute reader cannot miss an intervening low-water observation. Files are scoped
to PID/start ticks and checked against the Linux boot ID. Reads use a nonblocking,
no-follow descriptor, require a regular file, and cap reads on that same handle.
Publication age over 90 seconds is stale. Confirmed-dead owned files are swept at
startup/hourly, with 128 inspected entries and 32 deletions per sweep.

Telemetry lives in `<stateDir>/tmp/alphaclaw/gateway-memory/`, using the shared
directory resolver for publishers, readers and cleanup. Upstream `backup create`
excludes this temporary tree, so atomic publication and process-exit removal
cannot race its source walk. Legacy `.alphaclaw/gateway-memory/` files are left
untouched; a running older producer becomes unavailable to the new reader until
the next normal gateway launch.

Set `ALPHACLAW_GATEWAY_MEMORY_TELEMETRY=off` to disable instrumentation. Existing
gateways become instrumented on their next normal launch. No restart is requested
just to install telemetry. Until then the UI states that heap telemetry is
unavailable. RSS and container monitoring continue if instrumentation is disabled,
unsupported, unreadable, or unable to write.

**Trust:** the gateway and AlphaClaw share a UID. Private permissions and identity
checks do not authenticate the telemetry writer. External memory and attribution
are diagnostic only. Since ALPH-22 the heap reading (heap used against the V8 heap
limit, and confirmed rising post-GC floors) is one of the three critical gates: it
can keep a worker that is growing under load out of critical, and it can name the
heap as the floor, but it never sets the memory budget, and every critical still
needs the independently sampled worker slope. Missing or stale telemetry leaves
the gate open, so a writer that stops publishing cannot hide a leak. Public/agent
projections contain selected finite numbers and closed enums, never raw
histories, argv, boot IDs, filenames, or error text.

## Detection and retained explanations

**The memory budget (ALPH-22)** is `watchdog.memory.budgetMb` when the operator
set one (`capSource: "budget"`). Otherwise it is 75% (`memoryShareFraction`) of
min(container memory limit, host MemTotal): `container_share` or `host_share`,
with `capPhysicalMb` and `capFraction` on the trend, the events and the Resources
card. The other quarter is left for tool children, AlphaClaw and the kernel. The
heap signal has its own cap, the actual V8 heap limit from telemetry. Configured
heap plus 192 MiB is now only the worker's expected size (`expectedSizeMb`,
`aboveExpectedSize`), an informational line that decides nothing; before
ALPH-22 it was the budget (`derived_group_budget`, 8,384 MB on a 100 GB host
with an 8 GB heap, which the overseer still accepts in historical records). The
previous co-resident formula `cgroupUsed - groupRSS` is removed. The old `projectedExhaustionAt` field
aliases projected group-budget crossing; new code uses `projectedBudgetCrossingAt`.

The budget is never clamped: an operator budget above the derived share is the
cap. `GET` and `PUT /api/watchdog/memory` return the stored settings beside
`effectiveCap`, the cap the next evaluation uses with the stored budget
(`effectiveCapMb`, `capSource`, `capPhysicalMb`, `capFraction`), the cap the last
evaluation used (`lastEvaluated`), and a `reason` when the stored budget is not
enforced (`detection_disabled`, `config_unreadable`, `memory_limit_unknown`). A
PUT whose stored value differs from the request answers `500 setting_not_stored`
with the field: before v0.10.85 the server dropped `budgetMb` and
`maxRestartsPerDay` on the way to `alphaclaw.json` and answered `ok: true`.

**Critical (ALPH-22)** needs all three gates on the verified worker, held for
three consecutive fresh evaluations (the fast path also needs RSS rising on each):

1. **Slope:** the fitted worker RSS slope over the window is positive.
2. **Floor:** the worker's memory is at 90% of the budget or more, or the V8 heap
   is at 70% of its limit or more. Worker memory is its private memory (USS, from
   its own `smaps_rollup`) while that read is fresh, otherwise its RSS. The
   worker's own reading stays fresh when tool children come and go; only the
   group PSS total goes stale with `membership_changed`.
3. **Heap:** when heap telemetry is fresh, heap used is at 70% of the limit, or
   post-GC floors are rising (`possible_heap_retention`), or the worker itself
   has the container at 90% (it dominates the group and the container, and is
   growing).

A group series (the worker is not verified) can latch `leak_suspected`, labelled
as the group with its tool children, but never goes critical and never counts
container pressure. The heap projection (worker slope toward the heap limit)
can latch a warning as well as the budget projection.

**Restart policy (ALPH-22).** A critical verdict alone never restarts the gateway.
The opt-in mitigation also needs a restart authority on the snapshot:
`heap_near_limit` (fresh heap telemetry at 85% of the V8 limit or more: the
worker would abort anyway), `worker_container_oom` (the dominant, growing worker
has the container at 90%), or `operator_budget` (the operator's own
`watchdog.memory.budgetMb` is the cap and the worker is at 90% of it, the issue
#56 fast-leak profile). Without one, the watchdog logs one `mitigation_skipped`
`not_near_limit` per episode. A restart always goes through the graceful ladder
with the derived drain; the drain's exhaustion estimate now includes the heap's
own crossing (heap used toward its limit at the worker slope) and takes the
short ladder at 97% of the heap limit. SIGKILL stays the ladder's last step,
and the rate brake is unchanged.

Worker growth retains its existing grace, confirmation, recovery and restart
interlocks. Fresh container pressure counts only for a dominant, growing worker:
the worker holds at least half of its process group's RSS and at least half of
the container's working set, and its slope is at least 64 MB/h. Before v0.10.86
only the group share was checked, so a container filled by a process outside the
gateway tree counted against a 3 GB worker whose RSS re-faulted in a burst under
the pressure, and the fast path went critical with `worker_container_oom`. Container pressure also has its own two-read 90% latch and three-read
recovery, independent of gateway presence. Container-only pressure never permits
a gateway restart. Duplicate, stale, partial or out-of-order process evidence
cannot confirm mitigation; missing evidence cannot clear a critical verdict.
Mitigation rechecks the authoritative RSS timestamp and, when container pressure
is the trigger, the cgroup timestamp both at admission and after awaited
notification delivery. Evidence older than 90 seconds vetoes the restart,
refunds the brake and notification dedupe, and releases the lifecycle lock so a
fresh sample can retry. Settings, restart interlocks and rate brakes are also
rechecked after notification delivery.

### Notifications (ALPH-22)

Each episode sends at most one message per tier. The opening alert waits five
minutes (`memoryNoticeHoldMs` in `watchdog.js`), so load that settles inside
that hold never pages. A warning episode that outlasts the hold sends one 🟡
"rising steadily" message; a critical one sends one 🔴 message that says
whether the watchdog will restart and, if not, why (auto-restart off, the worker
not identified, or no restart authority). A restart or rate-brake notice takes
the critical slot. A critical that clears inside the hold gets one combined
"spiked and recovered" message instead of a red alert. When an episode that
notified clears in place, one ✅ follow-up names its duration, its peak and any
restarts. An episode that ends with the process (a restart or crash) closes
without a follow-up, because the restart path reports its own outcome.

The brake notice ("automatic restart is paused") states how many memory
restarts the window holds, the limit and spacing, and the UTC time the brake
lifts. No memory notice advises a manual restart: repeated restarts are the
harm the brake exists to stop, so every notice points to Doctor and the
watchdog's memory events.

Attribution uses a one-hour covered window and two fresh confirmations. Child
growth is distinct from accumulation (count and RSS growth). Possible heap
retention additionally needs three observed major-GC bucket minima spanning 48
minutes, rising floors and at least max(48 MiB, 5% of actual heap limit) growth.
Sparse GC stays unknown. Unexplained process growth requires co-sampled coverage;
subtraction does not establish native allocator growth. Mixed and recovered
transient observations remain distinct.

Episodes retain compact attribution, contributor aggregates, identities,
availability, scoped budget and trigger data. Telemetry loss does not replace a
known explanation with an empty one; restart history and Doctor retain it.
Historical event/source IDs and dismissal keys remain compatible. The status SSE
contains only latched state; live numerical evidence stays on the five-second
Resources endpoint.

## Verification

Focused tests cover collection bounds, telemetry loading and file safety,
sampling cadence/GC timing, pure attribution, pressure enforcement, immutable
episode evidence, API projections and historical Doctor behavior. The integration
fixture follows flat worker heap/RSS with accumulating children through the real
collector, watchdog, Resources projection and post-restart Doctor card.
`tests/live/openclaw-memory-telemetry.e2e.test.js` exercises the actual pinned
OpenClaw launch chain. `tests/live/openclaw-live-backup.e2e.test.js` also runs the
pinned backup CLI while real sampler processes publish rapidly and exit,
verifying that the archive succeeds and contains no telemetry files.
After `npm run build:ui`, run
`node tests/browser/watchdog-memory-smoke.mjs` for Chromium keyboard, responsive,
collapsed-warning and measurement-scope checks.
