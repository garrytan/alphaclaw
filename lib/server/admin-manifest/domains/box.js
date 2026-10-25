// Read-only operator status of the box (ALPH-40). One op covers every view
// and it is listed under the watchdog domain (the Box card lives on the
// Watchdog tab), so the agent-admin skill stays inside its size budget; the
// views and their parameters are documented here and in
// \`alphaclaw admin manifest --op box.read\`.
module.exports = {
  domain: "watchdog",
  title: "Watchdog",
  ops: [
    {
      id: "box.read",
      title: "Box status (read-only)",
      method: "GET",
      path: "/api/box/:view",
      tier: "safe",
      params: {
        fields: [
          {
            name: "view",
            location: "path",
            type: "string",
            required: true,
            description: "processes: every process in the container with its redacted command, owner (gateway: launcher and worker; tool: anything below the gateway worker; alphaclaw: the server and its children; other: co-resident services, role ancestor = above AlphaClaw), uid, uptime, RSS, PSS for the largest, version. restart: the last gateway restart (source, reason, restartClass, outcome ready | running | interrupted | stop_refused | stop_failed | launch_failed | ready_timeout | aborted, durationMs, downtimeMs = stop to ready), AlphaClaw's last two boots (kind, outcome, totalMs to ready) and the gateway's last unexpected exit (code, signal, cause). schedules: OpenClaw cron jobs from cron.list (schedule, lastRunAt, lastOutcome, nextRunAt), AlphaClaw's timers and git sync (lastRunAt, lastOutcome, nextRunAt), crontab and /etc/cron.d lines (redacted command, nextRunAt) and whether a cron daemon runs. disk: volumes (free/size), the state dir's top-level folders by size, and each feature's temporary copies (OpenClaw snapshot copies, update captures, package backups, openclaw.json backups, Back up now archives) with count, bytes and age. 404 unknown_view lists the views.",
          },
          {
            name: "limit",
            location: "query",
            type: "number",
            required: false,
            description: "processes: rows to return, largest RSS first, 1-500 (default 100). totals cover every process read.",
          },
          {
            name: "envKeys",
            location: "query",
            type: "string",
            required: false,
            description: "processes: up to 8 comma-separated env var names. Per process, an HMAC of the value it holds (never the value) and envFile = match | mismatch | unset | not_in_env_file | unknown against the deployment's .env. Hashes compare only within one AlphaClaw process lifetime.",
          },
          {
            name: "openUnder",
            location: "query",
            type: "string",
            required: false,
            description: "disk: an absolute path. Adds openFiles: the processes holding files open under it, deleted files and the bytes they still hold included.",
          },
        ],
        example: "GET /api/box/processes?envKeys=DATABASE_URL&limit=50",
      },
      notes:
        "Every view is bounded and cached briefly. processes: status partial means the 750 ms scan budget or the 4096-pid cap ran out; fresh for 5 s. schedules: openclaw.status unavailable means the gateway did not answer cron.list; fresh for 15 s (OpenClaw part 60 s). disk: the size census stops at 200k entries or 3 s (census.status partial) and is fresh for 5 min. Never kill or restart a process from this view; report it to the operator.",
    },
  ],
};
