## AlphaClaw Harness

AlphaClaw is the setup and management harness that runs alongside OpenClaw. It provides a web-based Setup UI and manages environment variables, channel connections, Google Workspace integration, and the gateway lifecycle.

AlphaClaw UI: `{{SETUP_UI_URL}}`

Do not deflect actionable requests to the Setup UI. If a command or tool is available to you (including OpenClaw CLI commands), execute it yourself first; share Setup UI links only as optional guidance or when the user explicitly asks to do it manually.

### Tabs

| Tab      | URL                         | What it helps with |
| -------- | --------------------------- | ------------------ |
| General  | `{{SETUP_UI_URL}}#general`  | Gateway status & restart, channel health (Telegram/Discord/Slack/WhatsApp/Signal), pending chat pairings & device approvals, feature health, Google Workspace connection, OpenAI-compatible API and Agent Administration toggles, repo auto-sync schedule, OpenClaw dashboard launch |
| Cron     | `{{SETUP_UI_URL}}#cron`     | Scheduled jobs — scheduler status, enable/disable, run now, prompt and delivery-routing edits, rolling calendar, run history, trends and per-run usage |
| Usage    | `{{SETUP_UI_URL}}#usage`    | Token and cost reporting — daily summary plus per-session and per-agent breakdowns and time series |
| Doctor   | `{{SETUP_UI_URL}}#doctor`   | Drift Doctor workspace health scans — finding cards, deterministic environment and model-drift checks, context-injection budget meter, scheduled scans, fixes dispatched to the agent |
| Watchdog | `{{SETUP_UI_URL}}#watchdog` | Gateway supervision — live status narrative, incidents and optional AI overseer, auto-repair, notification channel and admin targets, memory-leak detection and resource-autotune settings, event log, log tail, terminal, Claude Code rescue session |
| Models   | `{{SETUP_UI_URL}}#models`   | Available Models list with primary-model selection, and Provider Authentication — API keys / auth profiles per provider (Anthropic, OpenAI, Gemini, Mistral, Voyage, Groq, Deepgram and others), Codex OAuth, auth-profile ordering |
| Envars   | `{{SETUP_UI_URL}}#envars`   | View/edit/add environment variables (saved to `{{ENV_FILE}}`), gateway restart prompt to apply changes |
| Webhooks | `{{SETUP_UI_URL}}#webhooks` | Webhook endpoints — create flow, transform modules, request history and payload inspection, OAuth callback aliases, Gmail watch delivery |
| Nodes    | `{{SETUP_UI_URL}}#nodes`    | Worker nodes — Node Setup Wizard and pairing approval, connected-node list, browser attach, exec policy (host, security, ask) and the command allowlist |
| Team     | `{{SETUP_UI_URL}}#team`     | Team access (needs OpenClaw 2026.8+, beta channel) — member accounts, invites, roles, who's online; the enable wizard switches gateway auth to trusted-proxy |
| Upgrade  | `{{SETUP_UI_URL}}#upgrade`  | OpenClaw versions & release channels (stable/beta/dev) — catalog, release notes, apply with backup + auto-rollback, backups inventory, medic and overseer settings |
| Browse   | `{{SETUP_UI_URL}}#browse`   | File browser and editor rooted at `.openclaw` (opened from the sidebar file tree), markdown preview/edit, diff review and git-aware save/sync |

### Environment variables

Changes to env vars are made through the **Envars** tab (`{{SETUP_UI_URL}}#envars`). After saving, a gateway restart may be required to pick up the changes — the UI prompts for this automatically. Do not edit `{{ENV_FILE}}` directly; use the Setup UI so changes are validated and the gateway restart is handled.

### Persistent storage

`/tmp` and other temp locations are not durable and can vanish on restart or redeploy.

Anything persistent must live under `$OPENCLAW_STATE_DIR` (this install: `{{STATE_DIR}}`).

For plugins and local tooling:

- Prefer normal `openclaw plugins install <spec>` flows for durable installs.
- If you need to stage a local plugin or helper files first, put them under `$OPENCLAW_STATE_DIR/...`, not `/tmp/...`.
- Do not leave durable `plugins.load.paths` entries pointing at temp directories.

### Google Workspace

Google Workspace is connected via the **General** tab (`{{SETUP_UI_URL}}#general`). The user provides OAuth client credentials from Google Cloud Console, then authorizes access to the services they need (Gmail, Calendar, Drive, Sheets, Docs, Tasks, Contacts, Meet). Connected accounts and `gog` CLI usage are covered by the gog-cli skill.

## Telegram Formatting

- **Links:** Use markdown syntax `[text](URL)` — HTML `<a href>` does NOT render

## Webhooks

You can create webhooks yourself or the user can create them through the AlphaClaw UI.

Webhook transform files must follow this convention:

- Path: hooks/transforms/{hook-name}/{hook-name}-transform.mjs
- Signature: export default async function transform(payload, context)
- Webhook data is at payload.payload (nested)
- Never create transform files outside of hooks/transforms/
- When modifying a transform, read the existing file first
