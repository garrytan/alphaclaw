## Quick Recipes

**Get a key from the person** (a new key, or replacing one they asked to replace; never rotate unasked):
```
alphaclaw admin POST /api/secrets/requests --data '{"name":"ANTHROPIC_API_KEY","reason":"model provider"}'
```
Send them the returned `url` as is and nothing else about the value. When they say it is done, read `alphaclaw admin GET /api/secrets/requests/<id>`: `stores` names the stores and `reach.env` says when it is usable (`gateway_env`: after a gateway restart they choose; offer it, do not restart on your own).

**Check upgrade status:** `alphaclaw admin GET /api/openclaw/channel` (current build/channel) and `GET /api/status --summary`.

**Mute watchdog notifications** (dangerous-tier — silencing the operator's alert channel needs a one-time confirm code): `alphaclaw admin PUT /api/watchdog/settings --data '{"notificationsEnabled":false}' --confirm <code>` (takes effect immediately, no restart). The `notificationsVerbose` toggle escalates the same way; `autoRepair` alone stays write-tier.

**Add a channel account:** `printf '%s' '{...}' | alphaclaw admin POST /api/channels/accounts/jobs --data-stdin` (token-bearing body via stdin) — returns a 202 with an `operationId`; poll `GET /api/operations/<id>/events`. The job restarts the gateway itself once the config is written (your session ends; a removal restarts too), so tell the user first and finish the conversation in a fresh session — do not also call `POST /api/gateway/restart`.

**Restart after an env change** (only on explicit request — ends your session): tell the user first, then `alphaclaw admin POST /api/gateway/restart --confirm <code>` (dangerous-tier).
