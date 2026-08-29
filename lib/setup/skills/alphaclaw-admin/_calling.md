## How to call

```
alphaclaw admin <METHOD> </api/path> [--data '<json>' | --data-stdin] [--confirm CODE] [--context STR] [--summary] [--json]
alphaclaw admin manifest [--domain <name>] [--op <id>]
```

- **Response envelope** (with `--json`, one JSON document on stdout): `{ ok, status, code?, message?, hint?, data? }`. Success = exit code 0 and `ok !== false`. On failure the `code` tells you what went wrong and `hint` tells you the next action.
- **Secrets:** for any body containing a token/key/password, pipe it with `--data-stdin` (keeps it out of the process argument list), e.g. `printf '%s' "$JSON" | alphaclaw admin PUT /api/env --data-stdin`.
- **`--summary`** renders `GET /api/status` as a short human digest (gateway state, channels, restart pending, versions).
- **`--context "<session>"`** tags the audit trail so a post-restart outcome can be traced back to this conversation.

### Error codes you will see

| Code | Meaning | What to do |
| ---- | ------- | ---------- |
| `agent_admin_disabled` | The feature is off | Tell the operator to enable it (Setup UI → General). Do not fall back to other credentials. |
| `agent_admin_unavailable` | Flag on but token missing | Tell the operator to check server logs; a mint failure occurred. |
| `op_not_in_manifest` | Unknown/denied path | Your skill copy may be stale — run `alphaclaw admin manifest`. |
| `denied` | Operation is operator-only | Point the user to the dashboard. |
| `confirm_required` (HTTP 428) | Dangerous op needs approval | Relay the summary; ask an admin for the code sent to them; retry with `--confirm`. |
| `no_admin_targets` | No admin channel configured | Ask the operator to set one (Setup UI → Notifications) before dangerous ops. |
| `restart_required` in a response | Change applied, not yet live | Tell the user a gateway restart is needed. |
| `server_unreachable` / `timeout` | Server not responding | The gateway may be mid-restart; check the Watchdog tab and retry shortly. |

### Long-running operations

Some operations (e.g. `POST /api/openclaw/apply`, channel account jobs) return HTTP 202 with an `operationId`. Poll the operation's status op until it reaches a terminal state (the manifest entry lists the status op and its terminal states). Do not assume completion from the 202 alone.
