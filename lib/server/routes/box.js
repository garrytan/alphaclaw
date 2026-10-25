// Read-only operator status of the box AlphaClaw runs on (ALPH-40), so an
// operator or the agent can diagnose it without a shell: GET /api/box/:view.
// One route and one agent-admin op for every view keeps the admin skill
// small; each view only reads, answers within its own budget and returns
// bounded output. The collectors live in lib/server/box-status/.
const { wrapAsync } = require("../utils/wrap-async");
const { parseEnvKeys, kMaxLimit } = require("../box-status/processes");

const parseLimit = (raw, max) => {
  if (raw == null || raw === "") return { value: undefined };
  if (typeof raw !== "string" || !/^\d{1,4}$/.test(raw)) return { error: true };
  const value = Number(raw);
  return value >= 1 && value <= max ? { value } : { error: true };
};

const badRequest = (res, error, message) => res.status(400).json({ ok: false, error, message });

const registerBoxRoutes = ({ app, requireAuth, processTable, readRestartStatus, scheduleReader }) => {
  const views = {
    processes: async (req, res) => {
      const envKeys = parseEnvKeys(req.query.envKeys);
      if (envKeys.error) return badRequest(res, "invalid_env_keys", envKeys.error);
      const limit = parseLimit(req.query.limit, kMaxLimit);
      if (limit.error) return badRequest(res, "invalid_limit", "limit is a whole number from 1 to " + kMaxLimit);
      res.json(await processTable.read({ envKeys: envKeys.keys, limit: limit.value }));
    },
    restart: async (req, res) => {
      res.json(readRestartStatus());
    },
    schedules: async (req, res) => {
      res.json(await scheduleReader.read());
    },
  };

  app.get("/api/box/:view", requireAuth, wrapAsync(async (req, res) => {
    const view = Object.hasOwn(views, req.params.view) ? views[req.params.view] : null;
    if (!view) {
      res.status(404).json({ ok: false, error: "unknown_view", views: Object.keys(views) });
      return;
    }
    await view(req, res);
  }));
};

module.exports = { registerBoxRoutes };
