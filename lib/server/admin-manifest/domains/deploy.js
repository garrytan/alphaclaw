// Deploy announcements: the agent (or an operator script through the admin
// CLI) may announce a restart and read the measured downtimes. Announcing
// only sends a notice and runs the operators' sidecar announce commands; it
// restarts nothing and is rate-limited (one per 30 s).
module.exports = {
  domain: "deploy",
  title: "Deploy announcements",
  summary: "Deploy announcements and downtime history; announce a restart",
  ops: [
    {
      id: "deploy.status",
      title: "Deploy announcement + downtime history",
      method: "GET",
      path: "/api/deploy/status",
      tier: "safe",
    },
    {
      id: "deploy.announce",
      title: "Announce a restart (notice only)",
      method: "POST",
      path: "/api/deploy/announce",
      tier: "write",
      readOp: "deploy.status",
      params: {
        fields: [
          { name: "inSeconds", location: "body", type: "number", required: true, description: "Seconds until the restart, 0-3600." },
          { name: "etaSeconds", location: "body", type: "number", required: false, description: "Expected downtime, 1-7200 s; default: measured median." },
          { name: "reason", location: "body", type: "string", required: false, description: "One line, max 200 chars." },
        ],
      },
    },
  ],
};
