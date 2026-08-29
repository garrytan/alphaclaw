// Nodes, channel pairings, and device pairings live in one module: they are
// all access-granting surfaces, so their approve actions share the dangerous
// tier while rejects/removals stay plain writes.

// connect-info exists to hand a HUMAN the gateway token for node onboarding.
// The agent gets everything except the token value (hygiene: no plaintext
// tokens in the transcript).
const redactConnectInfo = (body) => {
  if (!body || typeof body !== "object") return body;
  return {
    ...body,
    gatewayToken: body.gatewayToken ? "••• (set)" : "",
  };
};

module.exports = {
  domain: "nodes",
  title: "Nodes & Pairing",
  ops: [
    {
      id: "nodes.list",
      title: "List paired nodes and pending node pairing requests",
      method: "GET",
      path: "/api/nodes",
      tier: "safe",
    },
    {
      id: "nodes.approve",
      title: "Approve a pending node pairing request",
      method: "POST",
      path: "/api/nodes/:id/approve",
      tier: "dangerous",
      idempotent: false,
      readOp: "nodes.list",
      params: {
        fields: [
          {
            name: "id",
            location: "path",
            type: "string",
            required: true,
            description:
              "Node id from the `pending` list of nodes.list. Ids outside [\\w\\-:.] are rejected (400).",
          },
        ],
        example: "POST /api/nodes/host-abc123/approve",
      },
      hint: "Approval pairs the node and grants it gateway access — verify the request is one you initiated.",
    },
    {
      id: "nodes.route",
      title: "Route agent exec to a node (sets tools.exec.* config)",
      method: "POST",
      path: "/api/nodes/:id/route",
      tier: "restart",
      restart: "marks",
      idempotent: true,
      readOp: "nodes.exec-config.read",
      params: {
        fields: [
          {
            name: "id",
            location: "path",
            type: "string",
            required: true,
            description:
              "Paired node id to route exec to. Sets host=node, security=allowlist, ask=on-miss, node=<id>.",
          },
        ],
        example: "POST /api/nodes/host-abc123/route",
      },
      notes: "Fixed preset; use exec-config.update for other host/security/ask combinations.",
    },
    {
      id: "nodes.remove",
      title: "Remove a paired node",
      method: "DELETE",
      path: "/api/nodes/:id",
      tier: "write",
      readOp: "nodes.list",
      params: {
        fields: [
          {
            name: "id",
            location: "path",
            type: "string",
            required: true,
            description: "Paired node id from nodes.list. Removal revokes the node's pairing.",
          },
        ],
        example: "DELETE /api/nodes/host-abc123",
      },
    },
    {
      id: "nodes.connect-info",
      title: "Node onboarding connection info (gateway token masked)",
      method: "GET",
      path: "/api/nodes/connect-info",
      tier: "safe",
      secretFields: ["gatewayToken"],
      redactResponse: redactConnectInfo,
      notes:
        "gatewayToken is masked for the agent actor; direct humans to the Setup UI to read it.",
    },
    {
      id: "nodes.browser-status",
      title: "Probe a node's browser status",
      method: "GET",
      path: "/api/nodes/:id/browser-status",
      tier: "safe",
      params: {
        fields: [
          {
            name: "id",
            location: "path",
            type: "string",
            required: true,
            description: "Paired node id to probe (invokes browser.proxy on the node).",
          },
          {
            name: "profile",
            location: "query",
            type: "string",
            required: false,
            description: "Browser profile to probe; defaults to \"user\".",
          },
        ],
        example: "GET /api/nodes/host-abc123/browser-status?profile=user",
      },
    },
    {
      id: "nodes.exec-config.read",
      title: "Read exec routing config (host/security/ask/node)",
      method: "GET",
      path: "/api/nodes/exec-config",
      tier: "safe",
    },
    {
      id: "nodes.exec-config.update",
      title: "Set exec routing config",
      method: "POST",
      path: "/api/nodes/exec-config",
      tier: "restart",
      restart: "marks",
      idempotent: true,
      readOp: "nodes.exec-config.read",
      params: {
        fields: [
          {
            name: "host",
            location: "body",
            type: "string",
            required: true,
            description: "gateway|node. \"node\" requires the node field; anything else is 400.",
          },
          {
            name: "security",
            location: "body",
            type: "string",
            required: true,
            description: "deny|allowlist|full. \"full\" runs any command unprompted — prefer allowlist.",
          },
          {
            name: "ask",
            location: "body",
            type: "string",
            required: true,
            description: "off|on-miss|always (\"on\" is accepted as on-miss).",
          },
          {
            name: "node",
            location: "body",
            type: "string",
            required: false,
            description:
              "Target node id; required when host is node (400 otherwise), cleared when host is gateway.",
          },
        ],
        example: '{"host":"node","security":"allowlist","ask":"on-miss","node":"host-abc123"}',
      },
    },
    {
      id: "nodes.exec-approvals.read",
      title: "Read exec approvals file and wildcard allowlist",
      method: "GET",
      path: "/api/nodes/exec-approvals",
      tier: "safe",
    },
    {
      id: "nodes.exec-approvals.allowlist-add",
      title: "Add an exec allowlist pattern (runs without approval)",
      method: "POST",
      path: "/api/nodes/exec-approvals/allowlist",
      tier: "dangerous",
      idempotent: false,
      readOp: "nodes.exec-approvals.read",
      params: {
        fields: [
          {
            name: "pattern",
            location: "body",
            type: "string",
            required: true,
            description:
              "Command pattern to allowlist for all agents (wildcard entry). Empty pattern is rejected (400).",
          },
        ],
        example: '{"pattern":"git status"}',
      },
      hint: "Allowlisted commands execute on the exec host with no further approval prompt.",
      notes: "Re-adding an existing pattern is a no-op (`unchanged: true`).",
    },
    {
      id: "nodes.exec-approvals.allowlist-remove",
      title: "Remove an exec allowlist entry",
      method: "DELETE",
      path: "/api/nodes/exec-approvals/allowlist/:id",
      tier: "write",
      readOp: "nodes.exec-approvals.read",
      params: {
        fields: [
          {
            name: "id",
            location: "path",
            type: "string",
            required: true,
            description: "Allowlist entry id (uuid) from exec-approvals.read. Unknown id is 404.",
          },
        ],
        example: "DELETE /api/nodes/exec-approvals/allowlist/1f2e3d4c-...",
      },
    },
    {
      id: "pairings.list",
      title: "List pending channel pairing requests",
      method: "GET",
      path: "/api/pairings",
      tier: "safe",
      notes: "Cached up to 10s; requests expire after 1h.",
    },
    {
      id: "pairings.approve",
      title: "Approve a channel pairing request",
      method: "POST",
      path: "/api/pairings/:id/approve",
      tier: "dangerous",
      idempotent: false,
      readOp: "pairings.list",
      params: {
        fields: [
          {
            name: "id",
            location: "path",
            type: "string",
            required: true,
            description: "Pairing code from pairings.list.",
          },
          {
            name: "channel",
            location: "body",
            type: "string",
            required: false,
            description:
              "telegram|discord|slack|whatsapp; defaults to telegram. Anything else is 400.",
          },
          {
            name: "accountId",
            location: "body",
            type: "string",
            required: false,
            description: "Channel account id for multi-account providers.",
          },
        ],
        example: '{"channel":"telegram","accountId":"default"}',
      },
      hint: "Approval grants the requester chat access to the agent on that channel — verify who is asking.",
    },
    {
      id: "pairings.reject",
      title: "Reject (remove) a channel pairing request",
      method: "POST",
      path: "/api/pairings/:id/reject",
      tier: "write",
      idempotent: false,
      readOp: "pairings.list",
      params: {
        fields: [
          {
            name: "id",
            location: "path",
            type: "string",
            required: true,
            description: "Pairing code from pairings.list. Unknown code is 404.",
          },
          {
            name: "channel",
            location: "body",
            type: "string",
            required: false,
            description: "Channel the request belongs to; defaults to telegram.",
          },
          {
            name: "accountId",
            location: "body",
            type: "string",
            required: false,
            description: "Channel account id for multi-account providers.",
          },
        ],
        example: '{"channel":"telegram"}',
      },
    },
    {
      id: "devices.list",
      title: "List pending device pairing requests",
      method: "GET",
      path: "/api/devices",
      tier: "safe",
      notes: "First pending CLI device is auto-approved once server-side (bootstrap marker).",
    },
    {
      id: "devices.approve",
      title: "Approve a device pairing request",
      method: "POST",
      path: "/api/devices/:id/approve",
      tier: "dangerous",
      idempotent: false,
      readOp: "devices.list",
      params: {
        fields: [
          {
            name: "id",
            location: "path",
            type: "string",
            required: true,
            description:
              "Device request id from devices.list. Unknown id is 404; scope refusals are 403.",
          },
        ],
        example: "POST /api/devices/req-abc123/approve",
      },
      hint: "Approval grants the device operator-scoped gateway access — verify the request before approving.",
    },
    {
      id: "devices.reject",
      title: "Reject a device pairing request",
      method: "POST",
      path: "/api/devices/:id/reject",
      tier: "write",
      idempotent: false,
      readOp: "devices.list",
      params: {
        fields: [
          {
            name: "id",
            location: "path",
            type: "string",
            required: true,
            description: "Device request id from devices.list.",
          },
        ],
        example: "POST /api/devices/req-abc123/reject",
      },
    },
  ],
};
