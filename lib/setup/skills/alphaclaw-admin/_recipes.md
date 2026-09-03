## Quick Recipes

**Rotate a provider key** (secret via stdin, restart after):
```
printf '%s' '{"vars":[{"key":"ANTHROPIC_API_KEY","value":"<new-key>"}, ...keep the rest...]}' \
  | alphaclaw admin PUT /api/env --data-stdin
```
Read `GET /api/env` first to see which keys exist (values are masked); include every key you want to keep — omitting one deletes it. Then tell the user a restart is required.

**Check upgrade status:** `alphaclaw admin GET /api/openclaw/channel` (current build/channel) and `GET /api/status --summary`.

**Mute watchdog notifications** (dangerous-tier — silencing the operator's alert channel needs a one-time confirm code): `alphaclaw admin PUT /api/watchdog/settings --data '{"notificationsEnabled":false}' --confirm <code>` (takes effect immediately, no restart). The `notificationsVerbose` toggle escalates the same way; `autoRepair` alone stays write-tier.

**Add a channel account:** `alphaclaw admin POST /api/channels/accounts --data '{...}'` — returns a 202 with an `operationId`; poll `GET /api/operations/<id>/events`. Restart required after.

**Restart after an env change** (only on explicit request — ends your session): tell the user first, then `alphaclaw admin POST /api/gateway/restart --confirm <code>` (dangerous-tier).
