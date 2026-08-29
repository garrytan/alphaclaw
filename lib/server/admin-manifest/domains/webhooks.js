const { kMask } = require("../../agent-admin/constants");
// Detail/create/destination responses embed the shared WEBHOOK_TOKEN inside
// queryStringUrl and authHeaderValue (copy-paste convenience for humans).
// Mask the token for the agent actor; hasRuntimeToken still signals presence.
// Stored request logs are already sanitized at capture time (webhook
// middleware redacts auth headers + token query params), so the requests
// reads pass through unredacted.
const maskWebhookUrls = (webhook) => {
  if (!webhook || typeof webhook !== "object" || !webhook.hasRuntimeToken) {
    return webhook;
  }
  const masked = { ...webhook };
  if (typeof masked.queryStringUrl === "string") {
    masked.queryStringUrl = masked.queryStringUrl.replace(
      /token=[^&]*/,
      "token=<WEBHOOK_TOKEN>",
    );
  }
  if (typeof masked.authHeaderValue === "string") {
    masked.authHeaderValue = "Authorization: Bearer ••• (set)";
  }
  return masked;
};

const redactWebhookEnvelope = (body) =>
  body && typeof body === "object" && body.webhook
    ? { ...body, webhook: maskWebhookUrls(body.webhook) }
    : body;

module.exports = {
  domain: "webhooks",
  title: "Webhooks",
  ops: [
    {
      id: "webhooks.list",
      title: "List webhooks with delivery health summaries",
      method: "GET",
      path: "/api/webhooks",
      tier: "safe",
    },
    {
      id: "webhooks.detail",
      title: "Webhook detail (URLs, destination, oauth callback, health)",
      method: "GET",
      path: "/api/webhooks/:name",
      tier: "safe",
      secretFields: ["webhook.queryStringUrl", "webhook.authHeaderValue"],
      redactResponse: redactWebhookEnvelope,
      params: {
        fields: [
          {
            name: "name",
            location: "path",
            type: "string",
            required: true,
            description: "Hook name from webhooks.list; invalid names are rejected (400).",
          },
        ],
        example: "GET /api/webhooks/deploy-alerts",
      },
      notes: "WEBHOOK_TOKEN is masked in the response; hasRuntimeToken says whether one is set.",
    },
    {
      id: "webhooks.create",
      title: "Create a webhook",
      method: "POST",
      path: "/api/webhooks",
      tier: "write",
      restart: "marks",
      idempotent: false,
      readOp: "webhooks.list",
      secretFields: ["webhook.queryStringUrl", "webhook.authHeaderValue"],
      redactResponse: redactWebhookEnvelope,
      params: {
        fields: [
          {
            name: "name",
            location: "body",
            type: "string",
            required: true,
            description:
              "Hook name (slug); duplicates are rejected (409). Becomes the /hooks/<name> ingest URL.",
          },
          {
            name: "destination",
            location: "body",
            type: "object|null",
            required: false,
            description: "Delivery destination; null/omitted = default routing.",
          },
          {
            name: "oauthCallback",
            location: "body",
            type: "boolean",
            required: false,
            description:
              "Also mint an /oauth/<id> callback alias with a starter OAuth transform.",
          },
        ],
        example: '{"name":"deploy-alerts","oauthCallback":false}',
      },
      notes: "Runs alphaclaw git-sync and marks restart-required; syncWarning in the response reports sync failures.",
    },
    {
      id: "webhooks.destination-update",
      title: "Set a webhook's delivery destination",
      method: "PUT",
      path: "/api/webhooks/:name/destination",
      tier: "write",
      restart: "marks",
      idempotent: true,
      readOp: "webhooks.detail",
      secretFields: ["webhook.queryStringUrl", "webhook.authHeaderValue"],
      redactResponse: redactWebhookEnvelope,
      params: {
        fields: [
          {
            name: "name",
            location: "path",
            type: "string",
            required: true,
            description: "Hook name; unknown hooks are rejected (404).",
          },
          {
            name: "destination",
            location: "body",
            type: "object|null",
            required: false,
            description: "New destination; null clears back to default routing.",
          },
        ],
        example: '{"destination":{"channel":"telegram","to":"-100123456"}}',
      },
      notes: "Runs alphaclaw git-sync and marks restart-required.",
    },
    {
      id: "webhooks.oauth-callback-create",
      title: "Create an OAuth callback alias for a webhook",
      method: "POST",
      path: "/api/webhooks/:name/oauth-callback",
      tier: "write",
      idempotent: false,
      readOp: "webhooks.detail",
      params: {
        fields: [
          {
            name: "name",
            location: "path",
            type: "string",
            required: true,
            description:
              "Hook name. Rejected (409) if an alias already exists — rotate instead.",
          },
        ],
        example: "POST /api/webhooks/deploy-alerts/oauth-callback",
      },
    },
    {
      id: "webhooks.oauth-callback-rotate",
      title: "Rotate a webhook's OAuth callback id",
      method: "POST",
      path: "/api/webhooks/:name/oauth-callback/rotate",
      tier: "write",
      idempotent: false,
      readOp: "webhooks.detail",
      params: {
        fields: [
          {
            name: "name",
            location: "path",
            type: "string",
            required: true,
            description:
              "Hook name. Issues a new /oauth/<id> URL; the old URL stops working immediately — update the OAuth app's redirect URI.",
          },
        ],
        example: "POST /api/webhooks/deploy-alerts/oauth-callback/rotate",
      },
    },
    {
      id: "webhooks.oauth-callback-delete",
      title: "Delete a webhook's OAuth callback alias",
      method: "DELETE",
      path: "/api/webhooks/:name/oauth-callback",
      tier: "write",
      idempotent: true,
      readOp: "webhooks.detail",
      params: {
        fields: [
          {
            name: "name",
            location: "path",
            type: "string",
            required: true,
            description:
              "Hook name. Removes the /oauth/<id> alias; the /hooks/<name> URL keeps working.",
          },
        ],
        example: "DELETE /api/webhooks/deploy-alerts/oauth-callback",
      },
    },
    {
      id: "webhooks.delete",
      title: "Delete a webhook (and its request log)",
      method: "DELETE",
      path: "/api/webhooks/:name",
      tier: "write",
      restart: "marks",
      idempotent: true,
      readOp: "webhooks.list",
      params: {
        fields: [
          {
            name: "name",
            location: "path",
            type: "string",
            required: true,
            description:
              "Hook name. Also removes its oauth alias and logged requests.",
          },
          {
            name: "deleteTransformDir",
            location: "body",
            type: "boolean",
            required: false,
            description: "Also delete the hook's transform directory on disk.",
          },
        ],
        example: "DELETE /api/webhooks/deploy-alerts",
      },
      notes: "Managed hooks (e.g. the setup-created 'gmail' hook) are server-side undeletable (409). Runs git-sync and marks restart-required.",
    },
    {
      id: "webhooks.requests",
      title: "Logged inbound requests for a webhook",
      method: "GET",
      path: "/api/webhooks/:name/requests",
      tier: "safe",
      params: {
        fields: [
          {
            name: "name",
            location: "path",
            type: "string",
            required: true,
            description: "Hook name.",
          },
          {
            name: "limit",
            location: "query",
            type: "number",
            required: false,
            description: "Page size; default 50, must be > 0.",
          },
          {
            name: "offset",
            location: "query",
            type: "number",
            required: false,
            description: "Page offset; default 0, must be >= 0.",
          },
          {
            name: "status",
            location: "query",
            type: "string",
            required: false,
            description: "all|success|error; anything else falls back to all.",
          },
        ],
        example: "GET /api/webhooks/deploy-alerts/requests?limit=50&status=error",
      },
    },
    {
      id: "webhooks.request-detail",
      title: "One logged webhook request (headers, payload, gateway result)",
      method: "GET",
      path: "/api/webhooks/:name/requests/:id",
      tier: "safe",
      params: {
        fields: [
          {
            name: "name",
            location: "path",
            type: "string",
            required: true,
            description: "Hook name.",
          },
          {
            name: "id",
            location: "path",
            type: "number",
            required: true,
            description: "Numeric request id from webhooks.requests; non-numeric ids are rejected (400).",
          },
        ],
        example: "GET /api/webhooks/deploy-alerts/requests/42",
      },
    },
  ],
};
