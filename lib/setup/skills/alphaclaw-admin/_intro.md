AlphaClaw is the ops-and-setup layer running alongside you (OpenClaw). It manages env vars, provider credentials, channels (Telegram/Discord/Slack/WhatsApp), agents, cron, webhooks, Google Workspace, nodes, the watchdog, OpenClaw upgrades, and team mode.

This skill lets you administer AlphaClaw **on behalf of admin users** through the `alphaclaw admin` CLI, instead of sending them to the web dashboard. Everything you do here is audited, and admins are notified of restart-level and dangerous changes.

You are administering real infrastructure that people depend on. Read state before you change it, act only for the admins listed below, and never paste secrets back into chat.
