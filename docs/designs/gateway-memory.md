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
and `gatewayMemoryTrend.rssMb` remain whole-group RSS aliases. A truncated census
is partial evidence and cannot confirm a restart. Static process roles do not
identify MCP sessions, activity, or orphaned children.

RSS counts shared pages in every process. It is not an additive decomposition of
cgroup usage. The container bar therefore shows only measured usage/limit;
process RSS is displayed separately. Linux `smaps_rollup` provides a paired RSS,
PSS, and private-page sample on the first opportunity and then every five minutes.
At most 128 processes and 16 KiB per file are read, with one chain in flight and a
one-second scheduling deadline. Late results are rejected; an in-kernel read is
allowed to finish before another chain starts. Coverage, timing, failures and
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

Set `ALPHACLAW_GATEWAY_MEMORY_TELEMETRY=off` to disable instrumentation. Existing
gateways become instrumented on their next normal launch. No restart is requested
just to install telemetry. Until then the UI states that heap telemetry is
unavailable. RSS and container monitoring continue if instrumentation is disabled,
unsupported, unreadable, or unable to write.

**Trust:** the gateway and AlphaClaw share a UID. Private permissions and identity
checks do not authenticate the telemetry writer. Heap, GC, external memory, and
attribution are diagnostic only: none can set budgets, clear pressure, or authorize
a restart. Public/agent projections contain selected finite numbers and closed
enums, never raw histories, argv, boot IDs, filenames, or error text.

## Detection and retained explanations

The group policy budget is the tighter valid value of configured active heap plus
192 MiB and `watchdog.memory.budgetMb`. Its source is `derived_group_budget`,
`budget`, or `none`. It is not the actual V8 heap limit. The previous co-resident
formula `cgroupUsed - groupRSS` is removed. The old `projectedExhaustionAt` field
aliases projected group-budget crossing; new code uses `projectedBudgetCrossingAt`.

Group growth retains its existing grace, confirmation, recovery and restart
interlocks. Fresh container pressure can satisfy the pressure side of its growth
predicate. Container pressure also has its own two-read 90% latch and three-read
recovery, independent of gateway presence. Container-only pressure never permits
a gateway restart. Duplicate, stale, partial or out-of-order process evidence
cannot confirm mitigation; missing evidence cannot clear a critical verdict.

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
OpenClaw launch chain. After `npm run build:ui`, run
`node tests/browser/watchdog-memory-smoke.mjs` for Chromium keyboard, responsive,
collapsed-warning and measurement-scope checks.
