const fs = require("fs");
const { OPENCLAW_DIR, kRootDir } = require("../constants");
const { readOpenclawConfigForWrite } = require("../openclaw-config");
const { normalizeAccountId } = require("../utils/channels");
const { isValidChannelAccountId } = require("../agents/shared");
const { logRejectedInput } = require("../utils/input-audit");
const { wrapAsync } = require("../utils/wrap-async");
const { createTelegramGroups, createOpenclawPatchValidator, isValidTelegramGroupId } = require("../telegram-groups");
const { runGroupTest } = require("../telegram-group-test");
const { TelegramGroupsError, sendTelegramGroupsProblem } = require("../telegram-groups-errors");

// Telegram group rules API (GST-1975 PR 1): read the groups, set one group's
// mode, test what a sender would get, and set the people blocked
// everywhere. Signed-in people only: every route is tier "denied" in the
// admin manifest, and the handlers refuse the agent actor again. Failures
// are RFC 9457 problem bodies (telegram-groups-errors.js).
const registerTelegramGroupRoutes = ({ app, telegramApi, execFileCmd, gatewayEnv, telegramGroups = null }) => {
  const groups =
    telegramGroups ||
    createTelegramGroups({
      openclawDir: OPENCLAW_DIR,
      rootDir: kRootDir,
      telegramApi,
      validatePatch: typeof execFileCmd === "function" ? createOpenclawPatchValidator({ execFileCmd, gatewayEnv }) : null,
    });

  const guard = (req, { groupId = null } = {}) => {
    if (req.alphaclawActor?.type === "agent") throw new TelegramGroupsError("humans_only");
    if (groupId !== null && !isValidTelegramGroupId(groupId)) {
      logRejectedInput({ req, field: "groupId", reason: "invalid_shape", value: groupId });
      throw new TelegramGroupsError("invalid_group_id");
    }
  };
  const accountOf = (req) => {
    const accountId = normalizeAccountId(req.query?.accountId || req.body?.accountId || "");
    if (isValidChannelAccountId(accountId)) return accountId;
    logRejectedInput({ req, field: "accountId", reason: "invalid_shape", value: accountId });
    throw new TelegramGroupsError("invalid_input", "accountId must be a channel account id (lowercase letters, digits and dashes)");
  };
  // Every handler answers its own failures as a problem body.
  const answer = async (res, fn) => {
    try {
      await fn();
    } catch (error) {
      sendTelegramGroupsProblem(res, error);
    }
  };

  app.get(
    "/api/telegram/groups",
    wrapAsync(async (req, res) => answer(res, async () => {
      guard(req);
      res.json({ ok: true, ...groups.list({ accountId: accountOf(req) }) });
    })),
  );

  app.put(
    "/api/telegram/groups/:groupId/policy",
    wrapAsync(async (req, res) => answer(res, async () => {
      const groupId = String(req.params.groupId || "");
      guard(req, { groupId });
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const result = await groups.setPolicy({
        accountId: accountOf(req),
        groupId,
        body,
        ifMatch: req.get("if-match") || "",
        dryRun: body.dryRun === true,
      });
      if (result.revision) res.set("ETag", '"' + result.revision + '"');
      res.json({ ok: true, ...result });
    })),
  );

  app.post(
    "/api/telegram/groups/:groupId/test",
    wrapAsync(async (req, res) => answer(res, async () => {
      const groupId = String(req.params.groupId || "");
      guard(req, { groupId });
      const cfg = readOpenclawConfigForWrite({ fsModule: fs, openclawDir: OPENCLAW_DIR });
      const result = await runGroupTest({
        cfg,
        state: groups.readState(),
        accountId: accountOf(req),
        groupId,
        senderIds: Array.isArray(req.body?.senderIds) ? req.body.senderIds.map(String) : [],
      });
      res.json({ ok: true, ...result });
    })),
  );

  app.put(
    "/api/telegram/blocked-senders",
    wrapAsync(async (req, res) => answer(res, async () => {
      guard(req);
      const result = groups.setBlockedSenders({ senders: req.body?.senders, ifMatch: req.get("if-match") || "" });
      res.set("ETag", '"' + result.revision + '"');
      res.json({ ok: true, ...result });
    })),
  );

  return groups;
};

module.exports = { registerTelegramGroupRoutes };
