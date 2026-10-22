export const kSlackBotScopes = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "commands",
  "emoji:read",
  "files:read",
  "files:write",
  "groups:read",
  "groups:history",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "pins:read",
  "pins:write",
  "reactions:read",
  "reactions:write",
  "users:read",
];
const kSlackBotEvents = [
  "app_mention",
  "message.channels",
  "message.groups",
  "message.im",
  "message.mpim",
  "reaction_added",
  "reaction_removed",
];
export const kSlackInstructionsLink = "https://docs.openclaw.ai/channels/slack";

export const buildSlackManifest = (appName = "AlphaClaw") =>
  JSON.stringify(
    {
      _metadata: {
        major_version: 1,
      },
      display_information: {
        name: String(appName || "").trim() || "AlphaClaw",
        description: "Slack connector for AlphaClaw",
      },
      features: {
        bot_user: {
          display_name: String(appName || "").trim() || "AlphaClaw",
          always_online: false,
        },
        app_home: {
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
        // OpenClaw 2026.8 registers /login natively but Slack manifests are
        // administrator-managed and not synced at runtime, so it must ship in the
        // manifest. Slack caps an app at 25 slash commands; we define one.
        slash_commands: [
          {
            command: "/login",
            description: "Link your Slack account to OpenClaw",
            should_escape: false,
          },
        ],
      },
      oauth_config: {
        scopes: {
          bot: kSlackBotScopes,
        },
      },
      settings: {
        event_subscriptions: {
          bot_events: kSlackBotEvents,
        },
        org_deploy_enabled: false,
        socket_mode_enabled: true,
        is_hosted: false,
        token_rotation_enabled: false,
      },
    },
    null,
    2,
  );
