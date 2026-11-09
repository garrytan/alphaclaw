// The secret drop (routes/secret-drop.js): the agent asks for a named secret
// and gets a one-time link for the person; it never sends, sees or receives
// a value. Saving happens only on the page, signed in to AlphaClaw as an
// admin, which is outside /api and outside this manifest.
const kAgentRequestFields = ["id", "name", "status", "createdAt", "expiresAt", "stores", "reach"];

const pickRequest = (request) =>
  request && typeof request === "object"
    ? Object.fromEntries(kAgentRequestFields.filter((field) => request[field] !== undefined).map((field) => [field, request[field]]))
    : request;

const redactRequestBody = (body) => {
  if (!body || typeof body !== "object") return body;
  const { ok, code, error, url, hint, request } = body;
  return {
    ok,
    ...(code !== undefined ? { code } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(hint !== undefined ? { hint } : {}),
    ...(request !== undefined ? { request: pickRequest(request) } : {}),
  };
};

module.exports = {
  domain: "secrets",
  title: "Secrets (secret drop)",
  summary: "Ask the person for a secret through a one-time link; values never go in chat",
  ops: [
    {
      id: "secrets.request",
      title: "Ask for a secret: get a one-time link for the person",
      method: "POST",
      path: "/api/secrets/requests",
      tier: "write",
      restart: "none",
      readOp: "secrets.status",
      redactResponse: redactRequestBody,
      params: {
        fields: [
          { name: "name", location: "body", type: "string", required: true, description: "The variable name: uppercase A-Z, 0-9 and _, starting with a letter. Reserved, deployment-only, locked and Channels-managed names are refused." },
          { name: "reason", location: "body", type: "string", required: false, description: "What it is for, shown on the page (200 characters)." },
        ],
        example: '{"name":"GITHUB_TOKEN","reason":"open pull requests"}',
      },
      notes:
        "Returns `url` (send it to the person as is) and `request.id`. The link works once, for 15 minutes, and only for someone signed in to AlphaClaw as an admin; it stores the value in AlphaClaw's .env and OpenClaw's secret store. Never ask for, accept or repeat the value in chat.",
    },
    {
      id: "secrets.status",
      title: "Status of a secret request (names only)",
      method: "GET",
      path: "/api/secrets/requests/:id",
      tier: "safe",
      redactResponse: redactRequestBody,
      notes:
        "`status` is pending, stored, partial (one store failed; the link stays open for a retry), expired or partial_expired. `stores` says which stores hold it and `reach.env` where the .env copy is usable: gateway_env (after the next gateway restart), next_gateway_start, or never (scripts that read .env only).",
    },
  ],
};
