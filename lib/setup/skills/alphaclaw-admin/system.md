Read `GET /api/status` first. AlphaClaw self-update is not an OpenClaw upgrade.

Restart/self-update **end your session**: warn the user, require an explicit request, and act last. Restart/repair require dangerous confirmation. Agent-message endpoints are denied; reply directly in chat.

`schedule` on `GET /api/restart-status` is an operator-scheduled restart (`{ at, createdAt }` or null); read-only for you.

**Verify and start** requires a human in the dashboard. Never send `verifyDatabaseRecovery`/`recoveryConfirmation`, even with dangerous confirmation or after failed launch.

**Tools that survive redeploys.** A redeploy replaces the container, so anything installed with `apt-get`, `npm -g` or straight into `/usr/local/bin` is gone afterwards; never install a tool you need after a redeploy that way. Put a statically linked build (`ldd <file>` says "not a dynamic executable") in `$OPENCLAW_STATE_DIR/bin`, or put the standalone `uv` in `~/.local/bin` and install Python tools with `uv tool install`, which keeps the tool and its Python under `~/.local` (the image has no Python, so `pipx` and `pip --user` tools stop working after a redeploy). On the Docker images AlphaClaw links both folders into `/usr/local/bin` at every boot, but never over a name the image already ships (the boot log names each skipped tool and why; only the owner can allow one in `alphaclaw.json` `tools.allowShadow`), so call your copy by its full path then. Cron runs jobs with `PATH=/usr/bin:/bin`: set `PATH=/usr/local/bin:/usr/bin:/bin` in the crontab or call tools by full path. When a tool belongs in the image, ask the owner to add it there.
