import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { useCachedFetch } from "../../hooks/use-cached-fetch.js";
import { fetchGoogleAccounts } from "../../lib/api.js";
import { kWhatsNextHiddenForSessionKey } from "../../lib/storage-keys.js";

const html = htm.bind(h);

// Post-onboarding discovery checklist (E4/D14). Rows auto-hide as they complete;
// "Hide for now" stashes the card for this browser session only (never
// dismiss-forever — guidance must be recoverable). The whole card disappears once
// every row is done.
const readHidden = () => {
  try {
    return sessionStorage.getItem(kWhatsNextHiddenForSessionKey) === "1";
  } catch {
    return false;
  }
};

export const WhatsNextCard = ({
  channels = null,
  onSwitchTab = () => {},
  // D14: show the Team row only when its security prerequisite is satisfiable
  // (the installed OpenClaw supports trusted-proxy team access) and hide it
  // once team access is on.
  teamSupported = false,
  teamEnabled = false,
}) => {
  const [hidden, setHidden] = useState(readHidden);

  const hasChannel =
    channels && typeof channels === "object" && Object.keys(channels).length > 0;
  // D14 done-state: the Google row hides once any account is authenticated.
  const { data: googleAccountsPayload } = useCachedFetch(
    "/api/google/accounts",
    fetchGoogleAccounts,
    { maxAgeMs: 60_000 },
  );
  const googleConnected = (
    Array.isArray(googleAccountsPayload?.accounts)
      ? googleAccountsPayload.accounts
      : Array.isArray(googleAccountsPayload)
        ? googleAccountsPayload
        : []
  ).some((account) => account?.authenticated);

  const rows = [
    !hasChannel && {
      key: "channel",
      title: "Add a chat channel",
      body: "You're set up with the web chat. Add Telegram, Discord, Slack, WhatsApp, or ClickClack to talk to your agent anywhere.",
      action: { label: "Open Channels", onClick: () => onSwitchTab("channels") },
    },
    teamSupported &&
      !teamEnabled && {
        key: "team",
        title: "Share this AlphaClaw with your team",
        body: "Give teammates their own logins — attributed messages, profiles, and who's online inside OpenClaw.",
        action: { label: "Open Team", onClick: () => onSwitchTab("team") },
      },
    !googleConnected && {
      key: "google",
      title: "Connect Google Workspace",
      body: "Give your agent Gmail, Calendar, Drive, and more by connecting a Google account.",
      action: { label: "Open Integrations", onClick: () => onSwitchTab("integrations") },
    },
  ].filter(Boolean);

  if (hidden || rows.length === 0) return null;

  return html`
    <div class="home-card">
      <div class="home-card-head">
        <h2 class="home-card-title">What's next</h2>
        <button
          type="button"
          class="text-xs text-fg-muted hover:text-body"
          onclick=${() => {
            try {
              sessionStorage.setItem(kWhatsNextHiddenForSessionKey, "1");
            } catch {}
            setHidden(true);
          }}
        >
          Hide for now
        </button>
      </div>
      <ul class="space-y-2">
        ${rows.map(
          (row) => html`
            <li class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="text-sm text-body">${row.title}</p>
                <p class="text-xs text-fg-muted">${row.body}</p>
              </div>
              ${row.action
                ? html`<button
                    type="button"
                    class="text-xs px-2 py-1 rounded-lg ac-btn-ghost shrink-0"
                    onclick=${row.action.onClick}
                  >
                    ${row.action.label}
                  </button>`
                : null}
            </li>
          `,
        )}
      </ul>
    </div>
  `;
};
