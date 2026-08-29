const { kMask } = require("../../agent-admin/constants");
// The Pub/Sub push token gates the UNAUTHENTICATED /gmail-pubsub ingress, so
// it must never enter the agent transcript. It appears both as a bare field
// (pushToken) and embedded as a token= query param inside pushEndpoint URLs
// and the generated gcloud commands — mask all of them (deep walk).
const kTokenQueryParam = /([?&]token=)[^"'&\s]+/g;
const redactGmailPushSecrets = (value) => {
  if (Array.isArray(value)) return value.map(redactGmailPushSecrets);
  if (value && typeof value === "object") {
    const redacted = {};
    for (const [key, entry] of Object.entries(value)) {
      redacted[key] =
        key === "pushToken" && typeof entry === "string" && entry
          ? kMask
          : redactGmailPushSecrets(entry);
    }
    return redacted;
  }
  return typeof value === "string"
    ? value.replace(kTokenQueryParam, "$1•••")
    : value;
};

module.exports = {
  domain: "gmail",
  title: "Gmail Watch",
  ops: [
    {
      id: "gmail.config.read",
      title: "Read Gmail push config (topics, endpoints, per-account watch state)",
      method: "GET",
      path: "/api/gmail/config",
      tier: "safe",
      redactResponse: redactGmailPushSecrets,
      notes:
        "pushToken and token= params in endpoints/gcloud commands are masked — a human copies the real commands from the Setup UI.",
    },
    {
      id: "gmail.config.update",
      title: "Save Gmail push config for a client (topic path / push token)",
      method: "POST",
      path: "/api/gmail/config",
      tier: "write",
      idempotent: false,
      readOp: "gmail.config.read",
      redactResponse: redactGmailPushSecrets,
      params: {
        fields: [
          {
            name: "client",
            location: "body",
            type: "string",
            required: false,
            description: 'Credential slot to configure; defaults to "default".',
          },
          {
            name: "topicPath",
            location: "body",
            type: "string",
            required: false,
            description:
              'Full Pub/Sub topic path ("projects/<id>/topics/<name>"); omitted derives one from the client credentials/projectId.',
          },
          {
            name: "projectId",
            location: "body",
            type: "string",
            required: false,
            description:
              "Google Cloud project used to derive the topic path when topicPath is omitted.",
          },
          {
            name: "regeneratePushToken",
            location: "body",
            type: "boolean",
            required: false,
            description:
              "Rotates the shared push token — existing Pub/Sub subscription push endpoints stop validating until recreated.",
          },
        ],
        example:
          '{"client":"default","topicPath":"projects/my-proj/topics/gog-gmail-default"}',
      },
    },
    {
      id: "gmail.watch.start",
      title: "Start Gmail watch for an account",
      method: "POST",
      path: "/api/gmail/watch/start",
      tier: "write",
      idempotent: false,
      readOp: "gmail.watch.status",
      params: {
        fields: [
          {
            name: "accountId",
            location: "body",
            type: "string",
            required: true,
            description:
              "Account to watch; missing is a 400 and an account without the gmail:read scope is rejected.",
          },
          {
            name: "destination",
            location: "body",
            type: "object{channel, to, agentId?}",
            required: false,
            description:
              "Routes incoming mail notifications; channel and to are required together (a partial pair is rejected).",
          },
        ],
        example:
          '{"accountId":"ga-1a2b3c","destination":{"channel":"telegram","to":"12345"}}',
      },
      notes:
        "First start wires the openclaw webhook mapping; the response includes restartRequired when that marks a restart.",
    },
    {
      id: "gmail.watch.stop",
      title: "Stop Gmail watch for an account",
      method: "POST",
      path: "/api/gmail/watch/stop",
      tier: "write",
      idempotent: true,
      readOp: "gmail.watch.status",
      params: {
        fields: [
          {
            name: "accountId",
            location: "body",
            type: "string",
            required: true,
            description:
              "Account to stop; missing is a 400. Unknown accounts return ok with skipped:true.",
          },
        ],
        example: '{"accountId":"ga-1a2b3c"}',
      },
    },
    {
      id: "gmail.watch.renew",
      title: "Renew Gmail watch registration(s)",
      method: "POST",
      path: "/api/gmail/watch/renew",
      tier: "write",
      idempotent: false,
      readOp: "gmail.watch.status",
      params: {
        fields: [
          {
            name: "accountId",
            location: "body",
            type: "string",
            required: false,
            description:
              "Account to renew; omitted renews EVERY watch-enabled account.",
          },
          {
            name: "force",
            location: "body",
            type: "boolean",
            required: false,
            description:
              "Defaults to true here; false only renews watches near expiration (others report skipped/not_due).",
          },
        ],
        example: '{"accountId":"ga-1a2b3c","force":true}',
      },
    },
    {
      id: "gmail.watch.status",
      title: "Gmail watch status (one account or all)",
      method: "GET",
      path: "/api/gmail/watch/status",
      tier: "safe",
      params: {
        fields: [
          {
            name: "accountId",
            location: "query",
            type: "string",
            required: false,
            description:
              "Account to inspect (404 if unknown); omitted returns all accounts.",
          },
        ],
        example: "GET /api/gmail/watch/status?accountId=ga-1a2b3c",
      },
    },
  ],
};
