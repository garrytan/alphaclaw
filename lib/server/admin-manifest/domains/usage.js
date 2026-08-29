module.exports = {
  domain: "usage",
  title: "Usage & Cost",
  ops: [
    {
      id: "usage.summary",
      title: "Token/cost usage summary",
      method: "GET",
      path: "/api/usage/summary",
      tier: "safe",
    },
    {
      id: "usage.sessions",
      title: "List sessions with usage",
      method: "GET",
      path: "/api/usage/sessions",
      tier: "safe",
    },
    {
      id: "usage.session-detail",
      title: "Usage detail for one session",
      method: "GET",
      path: "/api/usage/sessions/:id",
      tier: "safe",
    },
    {
      id: "usage.session-timeseries",
      title: "Usage time series for one session",
      method: "GET",
      path: "/api/usage/sessions/:id/timeseries",
      tier: "safe",
    },
  ],
};
