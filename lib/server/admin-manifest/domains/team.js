// Team (named member accounts) management. Main's 4.x team mode replaced the
// old PUT /api/team + /api/team/operators surface with an invite/member model
// and a snapshot->restart->identity-probe auth-mode transition. The
// unauthenticated GET /api/team/login-info endpoint and the session-minting
// POST /api/auth/accept-invite are deliberately unmanifested (see
// kUnmanifestedRoutes in index.js).
module.exports = {
  domain: "team",
  title: "Team",
  ops: [
    {
      id: "team.status",
      title: "Team mode status (roster, invites, presence, identity probe)",
      method: "GET",
      path: "/api/team",
      tier: "safe",
    },
    {
      id: "team.presence",
      title: "Who is currently online (member presence + TTL)",
      method: "GET",
      path: "/api/team/presence",
      tier: "safe",
    },
    {
      id: "team.enable",
      title: "Enable team mode (create/verify owner, gateway auth-mode transition)",
      method: "POST",
      path: "/api/team/enable",
      tier: "dangerous",
      restart: "restarts",
      idempotent: false,
      readOp: "team.status",
      params: {
        fields: [
          {
            name: "ownerEmail",
            location: "body",
            type: "string",
            required: true,
            description:
              "Owner account email. If it already exists it must be an admin and ownerPassword must match; otherwise a new admin account is created.",
          },
          {
            name: "ownerPassword",
            location: "body",
            type: "string",
            required: true,
            description:
              "Owner password (verified against the stored hash before anything is enabled). Never echoed back — send once, do not paste into chat.",
          },
          {
            name: "ownerDisplayName",
            location: "body",
            type: "string",
            required: false,
            description: "Display name for a newly created owner account.",
          },
          {
            name: "disableLegacyLogin",
            location: "body",
            type: "boolean",
            required: false,
            description:
              "true arms the shared-password lockdown (only after the owner credential AND the identity handshake verified). Default false.",
          },
          {
            name: "confirmHostIsolation",
            location: "body",
            type: "boolean",
            required: true,
            description:
              "Must be true: an explicit acknowledgement that this host runs no untrusted processes (loopback firewalled or Tailscale-fronted). 400 host_isolation_unconfirmed otherwise.",
          },
        ],
        example:
          '{"ownerEmail":"owner@example.com","ownerPassword":"•••","confirmHostIsolation":true}',
      },
      hint: "A failed post-restart probe auto-restores the previous auth config.",
    },
    {
      id: "team.disable",
      title: "Disable team mode (restore token auth, rotate member sessions)",
      method: "POST",
      path: "/api/team/disable",
      tier: "dangerous",
      restart: "restarts",
      idempotent: false,
      readOp: "team.status",
      hint: "Restores the previous gateway auth; every member session is invalidated. 409 not_enabled if team mode is already off.",
    },
    {
      id: "team.invites.create",
      title: "Create a member invite (returns a one-time invite URL + token)",
      method: "POST",
      path: "/api/team/invites",
      tier: "write",
      idempotent: false,
      readOp: "team.status",
      params: {
        fields: [
          {
            name: "email",
            location: "body",
            type: "string",
            required: false,
            description:
              "Optional pin: the invite is only redeemable by this email. Omit for an open invite. A malformed pinned email is a 400.",
          },
          {
            name: "role",
            location: "body",
            type: "string",
            required: false,
            enum: ["admin", "member"],
            description: "Invited role. Default member.",
          },
        ],
        example: '{"email":"new@example.com","role":"member"}',
      },
      notes:
        "The response carries the invite token + login URL — a credential. Relay the URL to the intended person over an out-of-band channel; do not post it into a shared transcript.",
    },
    {
      id: "team.invites.revoke",
      title: "Revoke a pending invite",
      method: "DELETE",
      path: "/api/team/invites/:id",
      tier: "write",
      idempotent: true,
      readOp: "team.status",
      params: {
        fields: [
          {
            name: "id",
            location: "path",
            type: "string",
            required: true,
            description: "Invite id from team.status invites[]. 404 if unknown.",
          },
        ],
      },
    },
    {
      id: "team.members.update",
      title: "Change a member's role / display name / disabled state",
      method: "PATCH",
      path: "/api/team/members/:id",
      tier: "write",
      restart: "marks",
      idempotent: true,
      readOp: "team.status",
      params: {
        fields: [
          {
            name: "id",
            location: "path",
            type: "string",
            required: true,
            description: "Member id from team.status members[]. 404 if unknown.",
          },
          {
            name: "role",
            location: "body",
            type: "string",
            required: false,
            enum: ["admin", "member"],
            description:
              "Promote/demote. 409 last_admin if it would leave no admins. An authority change rotates the member's session and rebuilds gateway config.",
          },
          {
            name: "displayName",
            location: "body",
            type: "string",
            required: false,
            description: "New display name.",
          },
          {
            name: "disabled",
            location: "body",
            type: "boolean",
            required: false,
            description:
              "true suspends the account (drops presence + rotates session). 409 last_admin if it would disable the only admin.",
          },
        ],
        example: '{"role":"admin"}',
      },
    },
    {
      id: "team.members.remove",
      title: "Remove a member account",
      method: "DELETE",
      path: "/api/team/members/:id",
      tier: "write",
      restart: "marks",
      idempotent: true,
      readOp: "team.status",
      params: {
        fields: [
          {
            name: "id",
            location: "path",
            type: "string",
            required: true,
            description:
              "Member id from team.status members[]. 404 if unknown; 409 last_admin if it would remove the only admin.",
          },
        ],
      },
    },
  ],
};
