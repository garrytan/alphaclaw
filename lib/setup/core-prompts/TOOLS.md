## AlphaClaw Harness

AlphaClaw is the setup and management harness around OpenClaw: its Setup UI at `{{SETUP_UI_URL}}` manages env vars, channels, Google Workspace and the gateway lifecycle.

Do not deflect actionable requests to the Setup UI. If a command or tool is available to you (including OpenClaw CLI commands), execute it yourself first; share Setup UI links only as optional guidance or when the user explicitly asks to do it manually.

Setup UI map (tab URLs and what each does): read `hooks/bootstrap/reference/setup-ui.md` when someone needs to find something in the UI.

Google Workspace connects on the **Integrations** page (`{{SETUP_UI_URL}}#integrations`); connected accounts and `gog` CLI usage are covered by the gog-cli skill.

### Environment variables

Changes to env vars are made through the **Environment** page (`{{SETUP_UI_URL}}#environment`). After saving, a gateway restart may be required to pick up the changes — the UI prompts for this automatically. Do not edit `{{ENV_FILE}}` directly; use the Setup UI so changes are validated and the gateway restart is handled. Never ask for a key or token in chat: request a secret drop (`POST /api/secrets/requests`, alphaclaw-admin skill) and send the link.

## Telegram

- **Links:** Use markdown syntax `[text](URL)` — HTML `<a href>` does NOT render{{TELEGRAM_THREAD_RULE}}

## Webhooks

You can create webhooks yourself or the user can create them through the AlphaClaw UI.

Webhook transform files must follow this convention:

- Path: hooks/transforms/{hook-name}/{hook-name}-transform.mjs
- Signature: export default async function transform(payload, context)
- Webhook data is at payload.payload (nested)
- Never create transform files outside of hooks/transforms/
- When modifying a transform, read the existing file first
