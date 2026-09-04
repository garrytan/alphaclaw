## How to call

```
alphaclaw admin <METHOD> </api/path> [--data '<json>' | --data-stdin] [--confirm CODE] [--context STR] [--summary] [--json]
alphaclaw admin manifest [--domain <name>] [--op <id>]
```

- **Response** (with `--json`, one JSON document on stdout): the server's raw JSON body. Success = exit code 0 (HTTP 2xx and the body does not carry `ok:false`/`error`). On a failure the body carries `{ ok:false, error, code?, hint? }` — `code` tells you what went wrong, `hint` tells you the next action. Client-side failures the CLI itself raises (bad `--data`, server unreachable) use `{ ok:false, code, message, hint? }` (`message` instead of `error`). Successful reads/writes return the route's own payload shape.
- **Secrets:** for any body containing a token/key/password, pipe it with `--data-stdin` (keeps it out of the process argument list), e.g. `printf '%s' "$JSON" | alphaclaw admin PUT /api/env --data-stdin`.
- **`--summary`** renders `GET /api/status` as a short human digest (gateway state, channels, restart pending, versions).
- **`--context "<session>"`** tags the audit trail so a post-restart outcome can be traced back to this conversation.

### Error codes you will see

| Code | Meaning | What to do |
| ---- | ------- | ---------- |
| `agent_admin_disabled` | The feature is off | Tell the operator to enable it (Setup UI → General). Do not fall back to other credentials. |
| `agent_admin_unavailable` | Flag on but token missing | Tell the operator to check server logs; a mint failure occurred. |
| `op_not_in_manifest` | Unknown/denied path | Your skill copy may be stale — run `alphaclaw admin manifest`. |
| `denied` | Operation is operator-only (or the path you named is a config/secret file) | Point the user to the dashboard. |
| `admin_required` (HTTP 403) | Admin-only route reached without passing the manifest gate | Never retry with other credentials; call the exact manifest method/path. Persisting → operator checks the server log. |
| `confirm_required` (HTTP 428) | Dangerous op needs approval | Relay the summary; ask an admin for the code (`delivery` says whether it was sent or an earlier code still stands); retry with `--confirm`. |
| `confirm_invalid` / `confirm_expired` / `confirm_attempts_exhausted` (HTTP 403) | Wrong code or mismatched retry / 10-min window passed / three wrong codes | Re-run the IDENTICAL command with the code as issued; for expired or exhausted, re-issue without `--confirm` to mint a fresh code. |
| `confirm_backlog_full` (HTTP 429) | Ten confirmations already pending | Wait for them to be redeemed or expire; do not spam new requests. |
| `dangerous_op_requires_confirmation` (HTTP 403) | Confirm flow unavailable on this install | Dashboard-only here; hand it to the operator. |
| `config_unreadable` (HTTP 503/409) | AlphaClaw refused to rewrite a config file it cannot parse (openclaw.json / alphaclaw.json — JSON5 or a torn write) | Do NOT retry in a loop; tell the operator which file, they fix or restore it, then retry. |
| `no_admin_targets` | No admin channel configured | Ask the operator to set one (Setup UI → Notifications) before dangerous ops. |
| `backup_in_progress` (HTTP 409 + `Retry-After`) | A pre-update backup is pausing the gateway and holding AlphaClaw's own state-database writes quiet | Nothing was changed. Wait the `Retry-After` seconds (120), then retry the same call. |
| `restart_required` in a response | Change applied, not yet live | Tell the user a gateway restart is needed. |
| `server_unreachable` / `timeout` | Server not responding | The gateway may be mid-restart; check the Watchdog tab and retry shortly. |

### Long-running operations

Some operations (e.g. `POST /api/openclaw/apply`, channel account jobs) return HTTP 202 with an `operationId`. Poll the operation's status op until it reaches a terminal state (the manifest entry lists the status op and its terminal states). Do not assume completion from the 202 alone.
