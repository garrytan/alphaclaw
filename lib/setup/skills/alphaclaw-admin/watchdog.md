Read health, events and logs here; `GET /api/watchdog/resources` reports resource usage. Use autotune for machine tuning.

Repair/Restart open options, not mutation permission. Diagnose cannot clear holds, override Stop or grant migration consent. Follow the hold's next action; settings-migration retry is not universal. Busy requests never queue: inspect and ask before retrying.

**Verify and start** is human-only, even after hold clear while recovery is pending. Never send `verifyDatabaseRecovery`/`recoveryConfirmation`, even with dangerous-tier confirmation.

Repair interrupts work; use only for down/stuck gateways, never cold-restart a healthy one. Force cannot waive unknown/corrupt DBs or unapproved migration. On `ok:false`, Doctor or relaunch did not complete: inspect `message`/`verdict`/`result`. Skipped/409 alone cannot prove no config changes. On `ok:true,pending:true`, await cleared `replacementPending` and verified readiness before reporting recovery.

Settings touching `notificationsEnabled` or `notificationsVerbose` require dangerous-tier confirmation; `autoRepair` alone is a plain write. Overseer review without `incidentId` reviews live logs and requires confirmation; reviewing an existing incident is a plain write. Terminal endpoints are denied to agents.

Memory settings: arming `autoRestart`, and ANY `budgetMb` or `maxRestartsPerDay` write, require confirmation (428, retry with `--confirm <code>`). Budget is the measured gateway's memory (the worker; the group only while the worker is unproven) in whole MB above current RSS, or null for the derived cap (75% of the smaller of the container limit and host memory). A budget above that share is honored. Restart allowance is 1–24/day. On 400 `invalid_setting`, read `field`/`bounds`; on `budget_below_current_rss`, read `currentRssMb`; on 500 `setting_not_stored`, the write did not take: report `field` and the stored `settings`. Confirm a write from `effectiveCap` (`effectiveCapMb`, `capSource`, `reason`), which the GET also returns with the bounds.

RSS growth does not establish a V8 leak. Compare worker/child RSS and counts, advisory heap/external telemetry, PSS and separate container usage. Configured heap plus 192 MiB is only the worker's expected size, never the budget. Preserve freshness and frozen episode attribution; ownership/activity remain unknown. Do not raise heap limits or kill supposed orphans from an RSS sum.
