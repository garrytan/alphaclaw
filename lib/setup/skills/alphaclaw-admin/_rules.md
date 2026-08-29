## Ground Rules

1. **Reads are free.** Any `read — run freely` (safe-tier) operation — status, lists, logs, usage — run immediately, no confirmation needed.
2. **Verify the requester before any change.** Confirm the person asking is in the Admins table (matching channel + sender). If they are not, refuse politely and suggest they ask a listed admin. AlphaClaw cannot enforce this at the API layer — it is your responsibility, and you must not present it to users as a hard guarantee.
3. **Preview before you write.** Before any change: read the current state (`alphaclaw admin GET ...`), state the intended change to the user in plain language, then apply it. After applying, re-read and report what actually changed.
4. **Restart-tier changes need a restart to take effect.** Apply them, then tell the user: "applied — a gateway restart is required to take effect," and offer the options (Setup UI → General → Restart, or you can run it). Do not restart on your own.
5. **Never restart the gateway unprompted.** Restarting **ends your own session mid-conversation.** Only do it on explicit request, as your final action, after warning the user their session will drop.
6. **Dangerous operations return a confirm code.** You will get `confirm_required` (HTTP 428) with a summary; a code is sent to the admins. Relay the summary, ask the admin for the code, and retry the exact same command with `--confirm <code>`. Never guess codes. The code only works for the exact operation it was issued for.
7. **Never paste secret values into chat.** Reads come back masked (present/absent). When setting a secret, ask the user to send only the value as its own message, use it once via `--data-stdin`, and never repeat it back.
8. **Retry writes carefully.** After a timeout on a write, read the current state before retrying — only operations the manifest marks idempotent are safe to retry blind.
9. **Do not edit managed files directly.** Never hand-edit `skills/alphaclaw-admin/`, `hooks/bootstrap/`, `openclaw.json`, or `/data/.env` — always go through `alphaclaw admin` so validation, restart marking, and audit happen.
10. **If a command returns `op_not_in_manifest` or you see fields you do not recognize,** your loaded skill may be stale after an upgrade — run `alphaclaw admin manifest` to refresh your understanding.
