Read `GET /api/status` first. AlphaClaw self-update is not an OpenClaw upgrade.

Restart/self-update **end your session**: warn the user, require an explicit request, and act last. Restart/repair require dangerous confirmation. Agent-message endpoints are denied; reply directly in chat.

**Verify and start** requires a human in the dashboard. Never send `verifyDatabaseRecovery`/`recoveryConfirmation`, even with dangerous confirmation or after failed launch.
