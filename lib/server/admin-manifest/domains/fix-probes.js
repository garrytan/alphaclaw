// Fix probes (GST-3436): read-only checks that a box fix is still in. The
// agent may read their status and start a run; the probe list itself lives
// in alphaclaw.json fixProbes and is edited only there.
module.exports = {
  domain: "fix-probes",
  title: "Fix probes",
  summary: "Read-only checks that each box fix is still in: status and an on-demand run",
  ops: [
    {
      id: "fix-probes.status",
      title: "Each fix probe's issue, state, code and counts, plus invalid probes with their fix line",
      method: "GET",
      path: "/api/fix-probes",
      tier: "safe",
      notes: "Never returns a probe's substrings, markers or file paths. Probes are configured in alphaclaw.json fixProbes.",
    },
    {
      id: "fix-probes.run",
      title: "Run every fix probe now and return the results",
      method: "POST",
      path: "/api/fix-probes/run",
      tier: "write",
      notes: "Read-only. Side effect: an owner alert only when a probe changes state. 409 fix_probe_run_in_progress while a run is going; 429 fix_probe_rate_limited (Retry-After) more than once a minute.",
    },
  ],
};
