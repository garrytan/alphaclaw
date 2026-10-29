const { wrapAsync } = require("../utils/wrap-async");

const { describeActor } = require("../utils/input-audit");
const { OPENCLAW_DIR } = require("../constants");
const { readOpenclawConfig } = require("../openclaw-config");
const { noteModelPolicyGaps } = require("../model-policy");

const parseBooleanFlag = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  return !["0", "false", "no", "off"].includes(normalized);
};

// snapshot (default true). keepWorkspace is still accepted from older callers:
// "keep" keeps the files (now in the snapshot), "erase" now means no snapshot
// and OpenClaw moves the files to its Trash. snapshot wins; both present and
// different is a 400.
const resolveSnapshotFlag = (query = {}) => {
  const snapshot = parseBooleanFlag(query.snapshot);
  const keepWorkspace = parseBooleanFlag(query.keepWorkspace);
  if (snapshot !== null && keepWorkspace !== null && snapshot !== keepWorkspace) {
    return { error: "snapshot and keepWorkspace disagree; send snapshot only." };
  }
  return { snapshot: snapshot ?? keepWorkspace ?? true };
};

// The outcome of a delete OpenClaw was asked to do: "unknown" is 202 (it may
// still finish), "not_deleted" a 502 with OpenClaw's reason.
const kOutcomeStatus = { deleted: 200, cleanup_incomplete: 200, config_only: 200, unknown: 202, not_deleted: 502 };

const sendDeleterError = (res, error) => {
  const status = Number(error?.status) || 500;
  return res.status(status).json({ ok: false, code: error?.code || "error", error: error?.message || "Delete failed" });
};

const registerAgentRoutes = ({
  app,
  agentsService,
  agentDeleter = null,
  restartRequiredState = null,
  operationEvents = null,
  readConfig = () => readOpenclawConfig({ openclawDir: OPENCLAW_DIR }),
}) => {
  const modelPolicyAfterSave = () => noteModelPolicyGaps({ readConfig, restartRequiredState });

  app.get("/api/channels/accounts", (_req, res) => {
    try {
      res.json({
        ok: true,
        channels: agentsService.listConfiguredChannelAccounts(),
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/channels/accounts/token", (req, res) => {
    try {
      const provider = String(req.query?.provider || "").trim();
      const accountId = String(req.query?.accountId || "").trim() || "default";
      const result = agentsService.getChannelAccountToken({
        provider,
        accountId,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      const status = error?.code === "OPENCLAW_CONFIG_WRITE_BLOCKED" ? 409 : String(error.message || "").includes("not found")
        ? 404
        : 400;
      return res.status(status).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/channels/accounts", wrapAsync(async (req, res) => {
    try {
      const body = req.body || {};
      const result = await agentsService.createChannelAccount(body);
      return res.status(201).json({ ok: true, ...result });
    } catch (error) {
      const message = String(error.message || "");
      const status = error?.code === "OPENCLAW_CONFIG_WRITE_BLOCKED" ? 409 : message.includes("already exists")
        ? 409
        : message.includes("already assigned")
          ? 409
          : message.includes("not found")
            ? 404
            : 400;
      return res.status(status).json({ ok: false, error: error.message });
    }
  }));

  app.post("/api/channels/accounts/jobs", (req, res) => {
    if (!operationEvents?.createOperation) {
      return res
        .status(503)
        .json({ ok: false, error: "Operation events unavailable" });
    }
    const body = req.body || {};
    const { operationId } = operationEvents.createOperation({
      type: "channel-account-create",
    });
    (async () => {
      try {
        const result = await agentsService.createChannelAccount(body, {
          onProgress: ({ phase = "", label = "" } = {}) => {
            operationEvents.publish(operationId, {
              event: "phase",
              data: {
                phase: String(phase || "").trim(),
                label: String(label || "").trim(),
              },
            });
          },
        });
        operationEvents.complete(operationId, { ok: true, ...result });
      } catch (error) {
        operationEvents.fail(operationId, error);
      }
    })();
    return res.status(202).json({
      ok: true,
      operationId,
      streamUrl: `/api/operations/${encodeURIComponent(operationId)}/events`,
    });
  });

  app.get("/api/operations/:operationId/events", (req, res) => {
    if (!operationEvents?.subscribe) {
      return res
        .status(503)
        .json({ ok: false, error: "Operation events unavailable" });
    }
    const subscribed = operationEvents.subscribe({
      operationId: req.params.operationId,
      req,
      res,
    });
    if (!subscribed) {
      return res.status(404).json({ ok: false, error: "Operation not found" });
    }
  });

  app.put("/api/channels/accounts", (req, res) => {
    try {
      const result = agentsService.updateChannelAccount(req.body || {});
      const restartRequired = !!result?.tokenUpdated;
      if (restartRequired) {
        restartRequiredState?.markRequired?.("channel_token_updated");
      }
      return res.json({ ok: true, restartRequired, ...result });
    } catch (error) {
      const status = error?.code === "OPENCLAW_CONFIG_WRITE_BLOCKED" ? 409 : String(error.message || "").includes("not found")
        ? 404
        : 400;
      return res.status(status).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/channels/accounts/login", wrapAsync(async (req, res) => {
    try {
      const body = req.body || {};
      const result = await agentsService.runChannelAccountLogin({
        provider: body.provider,
        accountId: body.accountId,
      });
      return res.json({
        ok: true,
        completed: !!result?.ok,
        stdout: String(result?.stdout || ""),
        stderr: String(result?.stderr || ""),
        code: result?.code ?? null,
      });
    } catch (error) {
      const status = error?.code === "OPENCLAW_CONFIG_WRITE_BLOCKED" ? 409 : String(error.message || "").includes("only supported")
        ? 400
        : 500;
      return res.status(status).json({ ok: false, error: error.message });
    }
  }));

  app.get("/api/channels/accounts/login-status", (req, res) => {
    try {
      const provider = String(req.query?.provider || "").trim();
      const accountId = String(req.query?.accountId || "").trim() || "default";
      const result = agentsService.getChannelAccountLoginStatus({
        provider,
        accountId,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      const status = error?.code === "OPENCLAW_CONFIG_WRITE_BLOCKED" ? 409 : String(error.message || "").includes("only supported")
        ? 400
        : 500;
      return res.status(status).json({ ok: false, error: error.message });
    }
  });

  app.delete("/api/channels/accounts", wrapAsync(async (req, res) => {
    try {
      const body = req.body || {};
      // The service's additive outcome flags (`gatewayRestartFailed`,
      // `pairingRowsCleanupFailed`) must reach the client — dropping the
      // result here silently reported a clean delete when the restart or the
      // pairing-row cleanup failed.
      // `ok: true` stays authoritative: the delete itself succeeded.
      const result = await agentsService.deleteChannelAccount(body);
      return res.json({
        ...(result && typeof result === "object" ? result : {}),
        ok: true,
      });
    } catch (error) {
      const status = error?.code === "OPENCLAW_CONFIG_WRITE_BLOCKED" ? 409 : String(error.message || "").includes("not found")
        ? 404
        : 400;
      return res.status(status).json({ ok: false, error: error.message });
    }
  }));

  app.get("/api/agents", (_req, res) => {
    try {
      res.json({
        ok: true,
        agents: agentsService.listAgents(),
        defaults: agentsService.getAgentDefaults?.() || {},
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/agents/:id", (req, res) => {
    try {
      const agent = agentsService.getAgent(req.params.id);
      if (!agent)
        return res.status(404).json({ ok: false, error: "Agent not found" });
      return res.json({ ok: true, agent });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/agents/:id/workspace-size", (req, res) => {
    try {
      const workspace = agentsService.getAgentWorkspaceSize(req.params.id);
      return res.json({ ok: true, ...workspace });
    } catch (error) {
      const status = error?.code === "OPENCLAW_CONFIG_WRITE_BLOCKED" ? 409 : String(error.message || "").includes("not found")
        ? 404
        : 500;
      return res.status(status).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/agents/:id/bindings", (req, res) => {
    try {
      const agent = agentsService.getAgent(req.params.id);
      if (!agent)
        return res.status(404).json({ ok: false, error: "Agent not found" });
      return res.json({
        ok: true,
        bindings: agentsService.getBindingsForAgent(req.params.id),
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/agents", (req, res) => {
    try {
      const body = req.body || {};
      if (!String(body.id || "").trim()) {
        return res.status(400).json({ ok: false, error: "id is required" });
      }
      if (agentDeleter?.findDeletionRecord?.(body.id)) {
        return res.status(409).json({
          ok: false,
          code: "agent_id_reserved",
          error: `"${String(body.id).trim()}" belonged to a deleted agent, and OpenClaw keeps that id reserved. Choose another id, or restore the deleted agent (README: Deleted agents' data).`,
        });
      }
      const agent = agentsService.createAgent(body);
      return res.status(201).json({ ok: true, agent, ...modelPolicyAfterSave() });
    } catch (error) {
      const status = error?.code === "OPENCLAW_CONFIG_WRITE_BLOCKED" ? 409 : String(error.message || "").includes("already exists")
        ? 409
        : 400;
      return res.status(status).json({ ok: false, error: error.message });
    }
  });

  app.put("/api/agents/:id", wrapAsync(async (req, res) => {
    try {
      const agent = await agentsService.updateAgent(
        req.params.id,
        req.body || {},
      );
      return res.json({ ok: true, agent, ...modelPolicyAfterSave() });
    } catch (error) {
      const status = error?.code === "OPENCLAW_CONFIG_WRITE_BLOCKED" ? 409 : String(error.message || "").includes("not found")
        ? 404
        : 400;
      return res.status(status).json({ ok: false, error: error.message });
    }
  }));

  app.post("/api/agents/:id/bindings", (req, res) => {
    try {
      const binding = agentsService.addBinding(req.params.id, req.body || {});
      return res.status(201).json({ ok: true, binding });
    } catch (error) {
      const message = String(error.message || "");
      const status = error?.code === "OPENCLAW_CONFIG_WRITE_BLOCKED" ? 409 : message.includes("not found")
        ? 404
        : message.includes("already assigned")
          ? 409
          : 400;
      return res.status(status).json({ ok: false, error: error.message });
    }
  });

  app.delete("/api/agents/:id/bindings", (req, res) => {
    try {
      agentsService.removeBinding(req.params.id, req.body || {});
      return res.json({ ok: true });
    } catch (error) {
      const status = error?.code === "OPENCLAW_CONFIG_WRITE_BLOCKED" ? 409 : String(error.message || "").includes("not found")
        ? 404
        : 400;
      return res.status(status).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/agent-deletions", (_req, res) => {
    try {
      return res.json({ ok: true, ...agentDeleter.listDeletions() });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/agents/:id/delete-preview", wrapAsync(async (req, res) => {
    try {
      return res.json({ ok: true, preview: await agentDeleter.preview(req.params.id) });
    } catch (error) {
      return sendDeleterError(res, error);
    }
  }));

  app.delete("/api/agents/:id", wrapAsync(async (req, res) => {
    const flag = resolveSnapshotFlag(req.query);
    if (flag.error) return res.status(400).json({ ok: false, code: "bad_request", error: flag.error });
    try {
      const result = await agentDeleter.deleteAgent(req.params.id, { snapshot: flag.snapshot, actor: describeActor(req) });
      const status = kOutcomeStatus[result.outcome] || 500;
      return res.status(status).json({ ok: status === 200, ...result });
    } catch (error) {
      return sendDeleterError(res, error);
    }
  }));

  app.post("/api/agents/:id/finish-delete", wrapAsync(async (req, res) => {
    try {
      const result = await agentDeleter.finishDelete(req.params.id, { actor: describeActor(req) });
      const status = kOutcomeStatus[result.outcome] || 500;
      return res.status(status).json({ ok: status === 200, ...result });
    } catch (error) {
      return sendDeleterError(res, error);
    }
  }));

  app.post("/api/agents/:id/default", (req, res) => {
    try {
      const agent = agentsService.setDefaultAgent(req.params.id);
      return res.json({ ok: true, agent });
    } catch (error) {
      const status = error?.code === "OPENCLAW_CONFIG_WRITE_BLOCKED" ? 409 : String(error.message || "").includes("not found")
        ? 404
        : 400;
      return res.status(status).json({ ok: false, error: error.message });
    }
  });
};

module.exports = { registerAgentRoutes };
