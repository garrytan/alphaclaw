## How to call

```
alphaclaw admin <METHOD> </api/path> [--data '<json>' | --data-stdin] [--confirm CODE] [--context STR] [--summary] [--json]
alphaclaw admin manifest [--domain <name>] [--op <id>]
```

- **Response** (with `--json`, one JSON document on stdout): the server's raw JSON body. Success = exit code 0 (HTTP 2xx and the body does not carry `ok:false`/`error`). On a failure the body carries `{ ok:false, error, code?, hint? }` — `code` tells you what went wrong, `hint` tells you the next action. Client-side failures the CLI itself raises (bad `--data`, server unreachable) use `{ ok:false, code, message, hint? }` (`message` instead of `error`). Successful reads/writes return the route's own payload shape.
- **Secrets:** for any body containing a token/key/password, pipe it with `--data-stdin` (keeps it out of the process argument list), e.g. `printf '%s' "$JSON" | alphaclaw admin PUT /api/env --data-stdin`.
- **`--summary`** renders `GET /api/status` as a short human digest (gateway state, channels, restart pending, versions).
- **`--context "<session>"`** tags the audit trail so a post-restart outcome can be traced back to this conversation.
- **Errors and async jobs:** every error code with what to do, and how to poll a 202 `operationId` to completion, are in [references/errors.md](references/errors.md). Do not report an async job done from the 202 alone.
