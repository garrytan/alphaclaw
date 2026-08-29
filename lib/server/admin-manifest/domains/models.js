const { kMask } = require("../../agent-admin/constants");
// Auth-profile credentials (key/token/access/refresh) are stored in full in
// auth-profiles.json and both GETs return them verbatim — mask before the
// agent transcript. Redaction is hygiene, not secrecy (threat model).
const kCredentialSecretFields = ["key", "token", "access", "refresh"];

const maskProfile = (profile) => {
  if (!profile || typeof profile !== "object") return profile;
  const masked = { ...profile };
  for (const field of kCredentialSecretFields) {
    if (masked[field]) masked[field] = kMask;
  }
  return masked;
};

const maskProfileList = (profiles) =>
  Array.isArray(profiles) ? profiles.map(maskProfile) : profiles;

module.exports = {
  domain: "models",
  title: "Models & Auth Profiles",
  ops: [
    {
      id: "models.catalog",
      title: "Model catalog (available models and defaults)",
      method: "GET",
      path: "/api/models",
      tier: "safe",
    },
    {
      id: "models.status",
      title: "Current default model, fallbacks, and image model",
      method: "GET",
      path: "/api/models/status",
      tier: "safe",
    },
    {
      id: "models.thinking-options",
      title: "Thinking levels available for a model",
      method: "GET",
      path: "/api/models/thinking-options",
      tier: "safe",
      params: {
        fields: [
          {
            name: "modelKey",
            location: "query",
            type: "string",
            required: true,
            description:
              "provider/model key (must contain a slash); anything else is a 400.",
          },
        ],
        example:
          "GET /api/models/thinking-options?modelKey=anthropic/claude-fable-5",
      },
    },
    {
      id: "models.set",
      title: "Set the default model",
      method: "POST",
      path: "/api/models/set",
      tier: "restart",
      restart: "marks",
      idempotent: true,
      readOp: "models.status",
      params: {
        fields: [
          {
            name: "modelKey",
            location: "body",
            type: "string",
            required: true,
            description:
              "provider/model key from the catalog (must contain a slash); anything else is a 400.",
          },
        ],
        example: '{"modelKey":"anthropic/claude-fable-5"}',
      },
      notes: "Marks restart-required; the new default applies after relaunch.",
    },
    {
      id: "models.config.read",
      title: "Read model config + auth profiles (credentials masked)",
      method: "GET",
      path: "/api/models/config",
      tier: "safe",
      redactResponse: (body) => ({
        ...body,
        authProfiles: maskProfileList(body?.authProfiles),
      }),
      params: {
        fields: [
          {
            name: "agentId",
            location: "query",
            type: "string",
            required: false,
            description: "Scope to one agent's auth store; omit for the default agent.",
          },
        ],
        example: "GET /api/models/config",
      },
      notes: "authProfiles include env-var-backed fallbacks; credential values are masked.",
    },
    {
      id: "models.config.update",
      title: "Save model config (primary, configured models, profiles, auth order)",
      method: "PUT",
      path: "/api/models/config",
      tier: "restart",
      restart: "marks",
      idempotent: true,
      readOp: "models.config.read",
      secretFields: [
        "profiles[].key",
        "profiles[].token",
        "profiles[].access",
        "profiles[].refresh",
      ],
      params: {
        fields: [
          {
            name: "primary",
            location: "body",
            type: "string",
            required: false,
            description:
              "New primary provider/model key (must contain a slash); omit to keep current.",
          },
          {
            name: "configuredModels",
            location: "body",
            type: "object",
            required: false,
            description:
              "Per-model settings map keyed by provider/model; non-object is a 400.",
          },
          {
            name: "profiles",
            location: "body",
            type: "array<{id, type, provider, ...credential}>",
            required: false,
            description:
              "Auth profiles to upsert (entries missing id/type/provider are skipped). Credentials are secrets — send the body via --data-stdin.",
          },
          {
            name: "authOrder",
            location: "body",
            type: "object",
            required: false,
            description: "Per-provider ordered profile-id arrays for auth fallback.",
          },
          {
            name: "agentId",
            location: "query",
            type: "string",
            required: false,
            description: "Scope profile/order writes to one agent; omit for the default agent.",
          },
        ],
        example:
          '{"primary":"anthropic/claude-fable-5","authOrder":{"anthropic":["anthropic:default"]}}',
      },
      hint: "Pipe secret-bearing bodies via --data-stdin so values stay out of process args.",
      notes: "Marks restart-required; api_key profiles also sync to env vars server-side.",
    },
    {
      id: "models.auth.read",
      title: "List auth profiles (credentials masked)",
      method: "GET",
      path: "/api/models/auth",
      tier: "safe",
      redactResponse: (body) => ({
        ...body,
        profiles: maskProfileList(body?.profiles),
      }),
      params: {
        fields: [
          {
            name: "agentId",
            location: "query",
            type: "string",
            required: false,
            description: "Scope to one agent's auth store; omit for the default agent.",
          },
        ],
        example: "GET /api/models/auth",
      },
    },
    {
      id: "models.auth.upsert",
      title: "Create/update an auth profile",
      method: "PUT",
      path: "/api/models/auth/:profileId",
      tier: "write",
      idempotent: true,
      readOp: "models.auth.read",
      secretFields: kCredentialSecretFields,
      params: {
        fields: [
          {
            name: "profileId",
            location: "path",
            type: "string",
            required: true,
            description: 'Profile id, conventionally "provider:label".',
          },
          {
            name: "type",
            location: "body",
            type: "string",
            required: true,
            description: "One of api_key | token | oauth; anything else is a 400.",
          },
          {
            name: "provider",
            location: "body",
            type: "string",
            required: true,
            description: "Provider id (e.g. anthropic, openai).",
          },
          {
            name: "key",
            location: "body",
            type: "string",
            required: false,
            description:
              "API key for type=api_key (token/access/refresh for the other types). Secrets — send the body via --data-stdin.",
          },
          {
            name: "agentId",
            location: "query",
            type: "string",
            required: false,
            description: "Scope to one agent's auth store; omit for the default agent.",
          },
        ],
        example: '{"type":"api_key","provider":"anthropic","key":"sk-ant-..."}',
      },
      hint: "Pipe secret-bearing bodies via --data-stdin so values stay out of process args.",
      notes: "api_key profiles also sync their provider env var server-side.",
    },
    {
      id: "models.auth.remove",
      title: "Delete an auth profile",
      method: "DELETE",
      path: "/api/models/auth/:profileId",
      tier: "write",
      idempotent: true,
      readOp: "models.auth.read",
      params: {
        fields: [
          {
            name: "profileId",
            location: "path",
            type: "string",
            required: true,
            description:
              "Profile id to remove; unknown ids return ok with removed:false.",
          },
          {
            name: "agentId",
            location: "query",
            type: "string",
            required: false,
            description: "Scope to one agent's auth store; omit for the default agent.",
          },
        ],
        example: "DELETE /api/models/auth/anthropic:default",
      },
    },
  ],
};
