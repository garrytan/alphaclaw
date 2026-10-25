// Operator sidecars: the agent may read the registry and status (env values
// are never returned, only names) but never start, stop or restart a sidecar,
// and the registry itself lives only in the deployment environment.
module.exports = {
  domain: "sidecars",
  title: "Operator sidecars",
  ops: [
    {
      id: "sidecars.status",
      title: "Operator sidecars + status",
      method: "GET",
      path: "/api/sidecars",
      tier: "safe",
      notes: "The registry comes from the deployment environment (ALPHACLAW_SIDECARS) and cannot be edited through the API.",
    },
    {
      id: "sidecars.action",
      title: "Start/stop/restart a sidecar",
      method: "POST",
      path: "/api/sidecars/:name/:action",
      tier: "denied",
    },
  ],
};
