## Quick Recipes

**Rotate a provider key** (secret via stdin, restart after):
```
printf '%s' '{"key":"ANTHROPIC_API_KEY","value":"<new-key>"}' \
  | alphaclaw admin PATCH /api/env --data-stdin
```
Then tell the user a restart is required, naming any `staleProcesses`.

**Check upgrade status:** `alphaclaw admin GET /api/openclaw/channel` (current build/channel) and `GET /api/status --summary`.

**Mute watchdog notifications** (dangerous-tier — silencing the operator's alert channel needs a one-time confirm code): `alphaclaw admin PUT /api/watchdog/settings --data '{"notificationsEnabled":false}' --confirm <code>` (takes effect immediately, no restart). The `notificationsVerbose` toggle escalates the same way; `autoRepair` alone stays write-tier.

**Add a channel account:** `printf '%s' '{...}' | alphaclaw admin POST /api/channels/accounts/jobs --data-stdin` (token-bearing body via stdin) — returns a 202 with an `operationId`; poll `GET /api/operations/<id>/events`. The job restarts the gateway itself once the config is written (your session ends; a removal restarts too), so tell the user first and finish the conversation in a fresh session — do not also call `POST /api/gateway/restart`.

**Restart after an env change** (only on explicit request — ends your session): tell the user first, then `alphaclaw admin POST /api/gateway/restart --confirm <code>` (dangerous-tier).
