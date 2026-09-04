// Guard (c): every async Express route handler goes through wrapAsync.
// Express 4 does not catch async rejections — an unwrapped rejection hangs
// the request forever AND feeds the unhandledRejection storm brake
// (utils/wrap-async.js header; audit F203/F207 found ~95 unwrapped sites).
const { auditTree, formatHits } = require("./guard-utils");
const { scanUnwrappedAsyncRoutes } = require("./scanners");

// PR 2a (the wrapAsync sweep) drives this list to zero. Until then every
// entry is a known unwrapped async handler: a throw before res.json hangs the
// request and lands as an unhandledRejection.
const kKnownOffenders = {
  "lib/server/routes/agents.js::POST /api/channels/accounts": "PR 2a",
  "lib/server/routes/agents.js::POST /api/channels/accounts/login": "PR 2a",
  "lib/server/routes/agents.js::DELETE /api/channels/accounts": "PR 2a",
  "lib/server/routes/agents.js::PUT /api/agents/:id": "PR 2a",
  "lib/server/routes/auth.js::POST /api/auth/accept-invite": "PR 2a",
  "lib/server/routes/autotune.js::PUT /api/autotune/settings": "PR 2a",
  "lib/server/routes/autotune.js::POST /api/autotune/reapply": "PR 2a",
  "lib/server/routes/browse/index.js::GET /api/browse/git-summary": "PR 2a",
  "lib/server/routes/browse/index.js::GET /api/browse/git-diff": "PR 2a",
  "lib/server/routes/browse/index.js::POST /api/browse/git-sync": "PR 2a",
  "lib/server/routes/browse/index.js::PUT /api/browse/write": "PR 2a",
  "lib/server/routes/browse/index.js::POST /api/browse/restore": "PR 2a",
  "lib/server/routes/buzz.js::POST /api/channels/buzz/setup/install": "PR 2a",
  "lib/server/routes/buzz.js::POST /api/channels/buzz/setup/probe": "PR 2a",
  "lib/server/routes/codex.js::GET /auth/codex/callback": "PR 2a",
  "lib/server/routes/codex.js::POST /api/codex/exchange": "PR 2a",
  "lib/server/routes/cron.js::POST /api/cron/jobs/:id/run": "PR 2a",
  "lib/server/routes/cron.js::POST /api/cron/jobs/:id/enable": "PR 2a",
  "lib/server/routes/cron.js::POST /api/cron/jobs/:id/disable": "PR 2a",
  "lib/server/routes/cron.js::PUT /api/cron/jobs/:id/prompt": "PR 2a",
  "lib/server/routes/cron.js::PUT /api/cron/jobs/:id/routing": "PR 2a",
  "lib/server/routes/doctor.js::POST /api/doctor/run": "PR 2a",
  "lib/server/routes/doctor.js::POST /api/doctor/import": "PR 2a",
  "lib/server/routes/doctor.js::POST /api/doctor/findings/:id/fix": "PR 2a",
  "lib/server/routes/gmail.js::POST /api/gmail/watch/start": "PR 2a",
  "lib/server/routes/gmail.js::POST /api/gmail/watch/stop": "PR 2a",
  "lib/server/routes/gmail.js::POST /api/gmail/watch/renew": "PR 2a",
  "lib/server/routes/google.js::GET /api/google/accounts": "PR 2a",
  "lib/server/routes/google.js::GET /api/google/status": "PR 2a",
  "lib/server/routes/google.js::POST /api/google/credentials": "PR 2a",
  "lib/server/routes/google.js::GET /api/google/check": "PR 2a",
  "lib/server/routes/google.js::POST /api/google/disconnect": "PR 2a",
  "lib/server/routes/google.js::GET /auth/google/callback": "PR 2a",
  "lib/server/routes/models.js::GET /api/models": "PR 2a",
  "lib/server/routes/models.js::GET /api/models/thinking-options": "PR 2a",
  "lib/server/routes/models.js::GET /api/models/status": "PR 2a",
  "lib/server/routes/models.js::POST /api/models/set": "PR 2a",
  "lib/server/routes/models.js::PUT /api/models/config": "PR 2a",
  "lib/server/routes/nodes.js::GET /api/nodes": "PR 2a",
  "lib/server/routes/nodes.js::POST /api/nodes/:id/approve": "PR 2a",
  "lib/server/routes/nodes.js::POST /api/nodes/:id/route": "PR 2a",
  "lib/server/routes/nodes.js::DELETE /api/nodes/:id": "PR 2a",
  "lib/server/routes/nodes.js::GET /api/nodes/connect-info": "PR 2a",
  "lib/server/routes/nodes.js::GET /api/nodes/:id/browser-status": "PR 2a",
  "lib/server/routes/nodes.js::GET /api/nodes/exec-config": "PR 2a",
  "lib/server/routes/nodes.js::POST /api/nodes/exec-config": "PR 2a",
  "lib/server/routes/nodes.js::GET /api/nodes/exec-approvals": "PR 2a",
  "lib/server/routes/nodes.js::POST /api/nodes/exec-approvals/allowlist": "PR 2a",
  "lib/server/routes/nodes.js::DELETE /api/nodes/exec-approvals/allowlist/:id": "PR 2a",
  "lib/server/routes/onboarding.js::POST /api/onboard": "PR 2a",
  "lib/server/routes/onboarding.js::POST /api/onboard/github/verify": "PR 2a",
  "lib/server/routes/onboarding.js::POST /api/onboard/import/scan": "PR 2a",
  "lib/server/routes/onboarding.js::POST /api/onboard/import/apply": "PR 2a",
  "lib/server/routes/openclaw-channel.js::PUT /api/alphaclaw/config/updates/openclaw-release-channel": "PR 2a",
  "lib/server/routes/openclaw-channel.js::GET /api/openclaw/overseer": "PR 2a",
  "lib/server/routes/openclaw-channel.js::POST /api/openclaw/backup-sqlite": "PR 2a",
  "lib/server/routes/openclaw-channel.js::GET /api/openclaw/catalog": "PR 2a",
  "lib/server/routes/openclaw-channel.js::POST /api/openclaw/apply": "PR 2a",
  "lib/server/routes/openclaw-channel.js::POST /api/openclaw/repair": "PR 2a",
  "lib/server/routes/openclaw-channel.js::POST /api/openclaw/reconcile/retry": "PR 2a",
  "lib/server/routes/pairings.js::GET /api/pairings": "PR 2a",
  "lib/server/routes/pairings.js::POST /api/pairings/:id/approve": "PR 2a",
  "lib/server/routes/pairings.js::GET /api/devices": "PR 2a",
  "lib/server/routes/pairings.js::POST /api/devices/:id/approve": "PR 2a",
  "lib/server/routes/pairings.js::POST /api/devices/:id/reject": "PR 2a",
  "lib/server/routes/system.js::GET /api/events/status": "PR 2a",
  "lib/server/routes/system.js::PUT /api/alphaclaw/config/features/openai-compat-api": "PR 2a",
  "lib/server/routes/system.js::GET /api/alphaclaw/version": "PR 2a",
  "lib/server/routes/system.js::GET /api/alphaclaw/release-notes": "PR 2a",
  "lib/server/routes/system.js::POST /api/alphaclaw/update": "PR 2a",
  "lib/server/routes/system.js::GET /api/agent/sessions": "PR 2a",
  "lib/server/routes/system.js::POST /api/agent/message": "PR 2a",
  "lib/server/routes/system.js::GET /api/restart-status": "PR 2a",
  "lib/server/routes/system.js::POST /api/restart-status/dismiss": "PR 2a",
  "lib/server/routes/team.js::GET /api/team": "PR 2a",
  "lib/server/routes/team.js::POST /api/team/enable": "PR 2a",
  "lib/server/routes/team.js::POST /api/team/disable": "PR 2a",
  "lib/server/routes/team.js::PATCH /api/team/members/:id": "PR 2a",
  "lib/server/routes/team.js::DELETE /api/team/members/:id": "PR 2a",
  "lib/server/routes/telegram.js::GET /api/telegram/bot": "PR 2a",
  "lib/server/routes/telegram.js::POST /api/telegram/groups/verify": "PR 2a",
  "lib/server/routes/telegram.js::POST /api/telegram/discovery/sweep": "PR 2a",
  "lib/server/routes/telegram.js::POST /api/telegram/groups/:groupId/topics": "PR 2a",
  "lib/server/routes/telegram.js::POST /api/telegram/groups/:groupId/topics/bulk": "PR 2a",
  "lib/server/routes/telegram.js::DELETE /api/telegram/groups/:groupId/topics/:topicId": "PR 2a",
  "lib/server/routes/telegram.js::POST /api/telegram/groups/:groupId/topics/:topicId/verify": "PR 2a",
  "lib/server/routes/telegram.js::PUT /api/telegram/groups/:groupId/topics/:topicId": "PR 2a",
  "lib/server/routes/telegram.js::POST /api/telegram/groups/:groupId/configure": "PR 2a",
  "lib/server/routes/telegram.js::GET /api/telegram/workspace": "PR 2a",
  "lib/server/routes/telegram.js::POST /api/telegram/workspace/reset": "PR 2a",
  "lib/server/routes/watchdog.js::GET /api/watchdog/overseer": "PR 2a",
  "lib/server/routes/watchdog.js::POST /api/watchdog/overseer/review": "PR 2a",
  "lib/server/routes/watchdog.js::POST /api/watchdog/repair": "PR 2a",
  "lib/server/routes/watchdog.js::POST /api/watchdog/resume-channels": "PR 2a",
  "lib/server/routes/watchdog.js::POST /api/watchdog/test-notification": "PR 2a",
  "lib/server/routes/webhooks.js::POST /api/webhooks": "PR 2a",
  "lib/server/routes/webhooks.js::PUT /api/webhooks/:name/destination": "PR 2a",
  "lib/server/routes/webhooks.js::DELETE /api/webhooks/:name": "PR 2a",
};

describe("guard: async route handlers are wrapped with wrapAsync", () => {
  it("detects an unwrapped async handler, with and without middleware, and accepts wrapped ones (self-test)", () => {
    const fixture = [
      'app.get("/api/a", async (req, res) => { res.json({}); });',
      'app.post("/api/b", requireAdmin, async ({ body }, res) => { res.json(body); });',
      'app.put("/api/c", wrapAsync(async (req, res) => { res.json({}); }));',
      'app.delete("/api/d", (req, res) => { const run = async () => {}; run(); });',
    ].join("\n");
    const hits = scanUnwrappedAsyncRoutes(fixture, "lib/server/routes/planted.js");
    expect(hits.map((h) => h.key.split("::")[1])).toEqual(["GET /api/a", "POST /api/b"]);
  });

  it("has no unwrapped async route handlers outside the allowlist, and no stale entries", () => {
    const { unexpected, stale } = auditTree({
      roots: ["lib/server"],
      scan: scanUnwrappedAsyncRoutes,
      allowlist: kKnownOffenders,
    });
    expect(
      unexpected,
      `Unwrapped async route handler(s) — wrap with wrapAsync(...) from lib/server/utils/wrap-async.js:\n${formatHits(unexpected)}`,
    ).toEqual([]);
    expect(stale, `Stale allowlist entries:\n  ${stale.join("\n  ")}`).toEqual([]);
  });
});
