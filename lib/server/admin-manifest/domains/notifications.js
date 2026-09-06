// Notification routing preferences (routes/openclaw-channel.js — structured
// envelope). Admin targets are PII (chat ids/phone numbers) but not secrets:
// they may pass through responses unredacted.
module.exports = {
  domain: "notifications",
  title: "Notifications",
  ops: [
    {
      id: "notifications.read",
      title: "Read notification routing prefs + supported channels",
      method: "GET",
      path: "/api/openclaw/notifications",
      tier: "safe",
      envelope: "structured",
      notes: "supportedChannels in the response is the allowlist the PUT validates against.",
    },
    {
      id: "notifications.update",
      title: "Set notification routing prefs (preferred channel, admin targets)",
      method: "PUT",
      path: "/api/openclaw/notifications",
      tier: "write",
      // The admin targets are where the agent's OWN dangerous-tier confirm
      // codes are delivered. At plain write tier the agent could repoint (or
      // wipe) them and then self-confirm any dangerous op, or 409-lock every
      // confirm by pointing them nowhere — so any body that touches the
      // routing escalates to a dangerous-tier confirm delivered to the
      // CURRENT targets (fix wave F065). Confirm delivery is audit-class and
      // does not depend on the setting under attack.
      tierResolver: (req) => {
        const body = req?.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) return "write";
        if ("adminTargets" in body || "preferredChannel" in body) return "dangerous";
        return "write";
      },
      envelope: "structured",
      idempotent: true,
      readOp: "notifications.read",
      params: {
        fields: [
          {
            name: "preferredChannel",
            location: "body",
            type: "string|null",
            required: false,
            description:
              "One of the supportedChannels from notifications.read, or null to unset; anything else is a 400 (never silently normalized).",
          },
          {
            name: "adminTargets",
            location: "body",
            type: "array<{channel, target, accountId}>",
            required: false,
            description:
              "FULL replacement list. Each entry needs a supported channel and a non-empty target (chat id / phone number — PII); accountId is optional.",
          },
        ],
        example:
          '{"preferredChannel":"telegram","adminTargets":[{"channel":"telegram","target":"123456789"}]}',
      },
    },
  ],
};
