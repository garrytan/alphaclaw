Read gateway health, events and logs through this domain; `GET /api/watchdog/resources` reports memory, CPU, disk, process and event-loop measurements. Machine capacity and tuning live in autotune.

`POST /api/watchdog/repair` can interrupt work and channels: use it only for a down/stuck gateway. A healthy gateway is never cold-restarted. `ok:false` without `result.skipped` means relaunch failed (`verdict` explains why); `ok:true,pending:true` requires polling status until `replacementPending` clears.

Settings touching `notificationsEnabled` or `notificationsVerbose` require dangerous-tier confirmation; `autoRepair` alone is a plain write. Overseer review without `incidentId` reviews live logs and requires confirmation; reviewing an existing incident is a plain write. Terminal endpoints are denied to agents.

Memory settings: arming `autoRestart`, and ANY `budgetMb` or `maxRestartsPerDay` write, require confirmation (428, retry with `--confirm <code>`). Budget is whole-group RSS in whole MB above current usage, or null for the derived budget. Restart allowance is 1–24/day. On 400 `invalid_setting`, read `field`/`bounds`; on `budget_below_current_rss`, read `currentRssMb`. Bounds also appear in the memory-settings GET.

RSS growth does not establish a V8 leak. Compare worker/child RSS and counts, advisory heap/external telemetry, PSS and separate container usage. The derived GROUP budget is configured heap plus 192 MiB. Preserve freshness and frozen episode attribution; ownership/activity remain unknown. Do not raise heap limits or kill supposed orphans from an RSS sum.
