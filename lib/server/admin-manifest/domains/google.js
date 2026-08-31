const { kMask } = require("../../agent-admin/constants");
// Agent-actor read redaction: the OAuth client secret never enters the
// transcript. Mask any secret-looking field to present/absent (env.js style).
const kSecretishKey = /secret|token|password/i;
const redactGoogleCredentials = (body) => {
  if (!body || typeof body !== "object") return body;
  const redacted = { ...body };
  for (const [key, value] of Object.entries(redacted)) {
    if (kSecretishKey.test(key) && typeof value === "string" && value) {
      redacted[key] = kMask;
    }
  }
  return redacted;
};

module.exports = {
  domain: "google",
  title: "Google Accounts",
  ops: [
    {
      id: "google.accounts.list",
      title: "List connected Google accounts",
      method: "GET",
      path: "/api/google/accounts",
      tier: "safe",
    },
    {
      id: "google.status",
      title: "Google auth status for one account",
      method: "GET",
      path: "/api/google/status",
      tier: "safe",
      params: {
        fields: [
          {
            name: "accountId",
            location: "query",
            type: "string",
            required: false,
            description:
              "Account to inspect; omitted falls back to the first configured account.",
          },
        ],
        example: "GET /api/google/status?accountId=ga-1a2b3c",
      },
      notes:
        "Returns an empty/unauthenticated shape while the gateway is not running.",
    },
    {
      id: "google.credentials.read",
      title: "Read OAuth client credentials (clientSecret masked)",
      method: "GET",
      path: "/api/google/credentials",
      tier: "safe",
      redactResponse: redactGoogleCredentials,
      params: {
        fields: [
          {
            name: "accountId",
            location: "query",
            type: "string",
            required: false,
            description:
              "Resolve the client slot from an existing account; wins over `client`.",
          },
          {
            name: "client",
            location: "query",
            type: "string",
            required: false,
            description:
              'Credential slot to read ("default", "personal", ...); defaults to the default client.',
          },
        ],
        example: "GET /api/google/credentials?client=personal",
      },
      notes:
        "clientSecret is masked for the agent actor — use hasCredentials to check setup state.",
    },
    {
      id: "google.credentials.update",
      title: "Save OAuth client credentials for a Google account",
      method: "POST",
      path: "/api/google/credentials",
      tier: "write",
      idempotent: false,
      readOp: "google.credentials.read",
      params: {
        fields: [
          {
            name: "clientId",
            location: "body",
            type: "string",
            required: true,
            description:
              "OAuth web client ID from Google Cloud Console; blank is rejected (ok:false).",
          },
          {
            name: "clientSecret",
            location: "body",
            type: "string",
            required: true,
            description: "OAuth client secret; blank is rejected (ok:false).",
          },
          {
            name: "email",
            location: "body",
            type: "string",
            required: true,
            description:
              "Google account email these credentials serve; blank is rejected (ok:false).",
          },
          {
            name: "client",
            location: "body",
            type: "string",
            required: false,
            description:
              'Credential slot name; defaults to "personal" when personal=true, else the default client.',
          },
          {
            name: "personal",
            location: "body",
            type: "boolean",
            required: false,
            description:
              "Mark the account personal (only one personal account is allowed; a second is rejected).",
          },
          {
            name: "accountId",
            location: "body",
            type: "string",
            required: false,
            description:
              "Existing account to update; omitting it creates a NEW account entry (max-accounts cap applies).",
          },
          {
            name: "services",
            location: "body",
            type: "array<string>",
            required: false,
            description:
              'Scope labels to request (e.g. "gmail:read"); defaults to the account\'s current or default scopes.',
          },
        ],
        example:
          '{"clientId":"1234.apps.googleusercontent.com","clientSecret":"GOCSPX-...","email":"ops@example.com","personal":false}',
      },
      hint: "Pipe the body via --data-stdin so clientSecret stays out of process args.",
      notes:
        "Re-saving clears stored OAuth tokens for that email — the account must re-consent via the Setup UI.",
    },
    {
      id: "google.accounts.add",
      title: "Add/update a Google account record (starts connect flow)",
      method: "POST",
      path: "/api/google/accounts",
      tier: "write",
      idempotent: false,
      readOp: "google.accounts.list",
      params: {
        fields: [
          {
            name: "email",
            location: "body",
            type: "string",
            required: true,
            description:
              "Google account email; blank is rejected (ok:false).",
          },
          {
            name: "client",
            location: "body",
            type: "string",
            required: false,
            description:
              "Credential slot to attach; rejected (ok:false) if no credentials are saved for it yet — save credentials first.",
          },
          {
            name: "personal",
            location: "body",
            type: "boolean",
            required: false,
            description:
              "Mark the account personal (only one personal account is allowed; a second is rejected).",
          },
          {
            name: "accountId",
            location: "body",
            type: "string",
            required: false,
            description:
              "Existing account to update; omitting it creates a NEW account entry (max-accounts cap applies).",
          },
          {
            name: "services",
            location: "body",
            type: "array<string>",
            required: false,
            description:
              'Scope labels to request (e.g. "gmail:read", "calendar").',
          },
        ],
        example: '{"email":"ops@example.com","services":["gmail:read"]}',
      },
      notes:
        "Starts the flow only — a human must finish Google OAuth consent in the Setup UI browser.",
    },
    {
      id: "google.check",
      title: "Probe enabled Google APIs for an account",
      method: "GET",
      path: "/api/google/check",
      tier: "safe",
      params: {
        fields: [
          {
            name: "accountId",
            location: "query",
            type: "string",
            required: false,
            description:
              "Account to probe; omitted falls back to the first configured account.",
          },
        ],
        example: "GET /api/google/check?accountId=ga-1a2b3c",
      },
      notes:
        "Per-service results include an enableUrl when the API is not enabled in the Google Cloud project.",
    },
    {
      id: "google.disconnect",
      title: "Disconnect a Google account (revoke + remove)",
      method: "POST",
      path: "/api/google/disconnect",
      tier: "write",
      idempotent: false,
      readOp: "google.accounts.list",
      params: {
        fields: [
          {
            name: "accountId",
            location: "body",
            type: "string",
            required: false,
            description:
              "Account to revoke and remove. OMITTING this disconnects the FIRST configured account — always pass it.",
          },
        ],
        example: '{"accountId":"ga-1a2b3c"}',
      },
      notes:
        "Revokes the Google refresh token and deletes local auth — reconnecting needs a human OAuth consent in the Setup UI. A response of ok:false with retryable:true means upstream revocation could not be confirmed (timeout/5xx) and the account was KEPT; it echoes the resolved accountId — retry by passing THAT accountId explicitly (never rely on the first-account fallback across retries). Only a confirmed-dead token (or nothing to revoke) proceeds to removal.",
    },
  ],
};
