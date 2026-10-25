Read `GET /api/status` first. AlphaClaw self-update is not an OpenClaw upgrade.

Restart/self-update **end your session**: warn the user, require an explicit request, and act last. Restart/repair require dangerous confirmation. Agent-message endpoints are denied; reply directly in chat.

`schedule` on `GET /api/restart-status` is an operator-scheduled restart (`{ at, createdAt }` or null); read-only for you.

**Verify and start** requires a human in the dashboard. Never send `verifyDatabaseRecovery`/`recoveryConfirmation`, even with dangerous confirmation or after failed launch.
