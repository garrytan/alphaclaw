const {
  listWebhooks,
  getWebhookDetail,
  createWebhook,
  updateWebhookDestination,
  deleteWebhook,
  validateWebhookName,
  assertCreatableWebhookName,
} = require("../webhooks");
const { isTruthyFlag } = require("../utils/boolean");
const { wrapAsync } = require("../utils/wrap-async");

const isFiniteInteger = (value) =>
  Number.isFinite(value) && Number.isInteger(value);
const parseBooleanFlag = (value) => isTruthyFlag(value);

const buildHealth = ({ totalCount, errorCount }) => {
  if (!totalCount || totalCount <= 0) return "green";
  if (!errorCount || errorCount <= 0) return "green";
  if (errorCount >= totalCount) return "red";
  return "yellow";
};

const mapSummaryByHook = (summaries) => {
  const byHook = new Map();
  for (const summary of summaries || []) byHook.set(summary.hookName, summary);
  return byHook;
};

const mergeWebhookAndSummary = ({ webhook, summary }) => {
  const totalCount = Number(summary?.totalCount || 0);
  const errorCount = Number(summary?.errorCount || 0);
  const successCount = Number(summary?.successCount || 0);
  const recentTotalCount = Number(summary?.recentTotalCount || 0);
  const recentErrorCount = Number(summary?.recentErrorCount || 0);
  const recentSuccessCount = Number(summary?.recentSuccessCount || 0);
  const healthWindowSize = Number(summary?.healthWindowSize || 0);
  return {
    ...webhook,
    lastReceived: summary?.lastReceived || null,
    totalCount,
    successCount,
    errorCount,
    recentTotalCount,
    recentSuccessCount,
    recentErrorCount,
    healthWindowSize,
    health: buildHealth({
      totalCount: recentTotalCount || totalCount,
      errorCount: recentTotalCount > 0 ? recentErrorCount : errorCount,
    }),
  };
};

const normalizeStatusFilter = (rawStatus) => {
  const status = String(rawStatus || "all")
    .trim()
    .toLowerCase();
  if (["all", "success", "error"].includes(status)) return status;
  return "all";
};

const buildWebhookUrls = ({ baseUrl, name, oauthCallback = null }) => {
  const fullUrl = `${baseUrl}/hooks/${name}`;
  const token = String(process.env.WEBHOOK_TOKEN || "").trim();
  const queryStringUrl = token
    ? `${fullUrl}?token=${encodeURIComponent(token)}`
    : `${fullUrl}?token=<WEBHOOK_TOKEN>`;
  const authHeaderValue = token
    ? `Authorization: Bearer ${token}`
    : "Authorization: Bearer <WEBHOOK_TOKEN>";
  const callbackId = String(oauthCallback?.callbackId || "").trim();
  // Header form first; the query URL is the fallback for senders that cannot
  // set headers, and is labelled as less safe (ALPH-71 L-7).
  return {
    fullUrl,
    authHeaderValue,
    queryStringUrl,
    queryStringUrlNote:
      "Less safe: the token travels in the URL, where proxies, logs and link previews can record it. Use the Authorization header when the sender can set one. Deliveries must be POST.",
    hasRuntimeToken: !!token,
    oauthCallbackId: callbackId || "",
    oauthCallbackUrl: callbackId ? `${baseUrl}/oauth/${callbackId}` : "",
    oauthCallbackCreatedAt: oauthCallback?.createdAt || null,
    oauthCallbackRotatedAt: oauthCallback?.rotatedAt || null,
    oauthCallbackLastUsedAt: oauthCallback?.lastUsedAt || null,
  };
};

const buildOauthTransformSource = (name) => {
  return [
    "export default async function transform(payload, context) {",
    "  const data = payload.payload || payload || {};",
    "  const code = String(data.code || \"\").trim();",
    "  const state = String(data.state || \"\").trim();",
    "  const error = String(data.error || \"\").trim();",
    "  const message = error",
    "    ? `OAuth callback error: ${error}`",
    "    : code",
    "      ? \"OAuth callback received (authorization code present)\"",
    "      : state",
    "        ? \"OAuth callback received (state present)\"",
    "        : \"OAuth callback received\";",
    "  return {",
    "    message,",
    `    name: \"${name}\",`,
    "    wakeMode: \"now\",",
    "    oauth: {",
    "      code,",
    "      state,",
    "      error,",
    "    },",
    "  };",
    "}",
    "",
  ].join("\n");
};


const registerWebhookRoutes = ({
  app,
  fs,
  constants,
  getBaseUrl,
  webhooksDb,
  gitSync,
  restartRequiredState,
  hookIngress = null,
}) => {
  const {
    getRequests = () => [],
    getRequestById = () => null,
    getHookSummaries = () => [],
    deleteRequestsByHook = () => 0,
    createOauthCallback: createOauthCallbackEntry = () => null,
    getOauthCallbackByHook: getOauthCallbackByHookEntry = () => null,
    rotateOauthCallback: rotateOauthCallbackEntry = () => null,
    deleteOauthCallback: deleteOauthCallbackEntry = () => 0,
  } = webhooksDb || {};
  const fallbackRestartState = {
    markRequired: () => {},
    getSnapshot: async () => ({ restartRequired: false }),
  };
  const resolvedRestartState = restartRequiredState || fallbackRestartState;
  const { markRequired: markRestartRequired, getSnapshot: getRestartSnapshot } =
    resolvedRestartState;
  const runWebhookGitSync = async (action, name) => {
    if (typeof gitSync !== "function") return null;
    return gitSync({ message: `webhooks: ${action} ${String(name || "").trim()}` });
  };

  app.get("/api/webhooks", (req, res) => {
    try {
      const hooks = listWebhooks({ fs, constants });
      const summaries = getHookSummaries();
      const summaryByHook = mapSummaryByHook(summaries);
      const webhooks = hooks.map((webhook) => {
        const oauthCallback = getOauthCallbackByHookEntry(webhook.name);
        return {
          ...mergeWebhookAndSummary({
            webhook,
            summary: summaryByHook.get(webhook.name),
          }),
          oauthCallbackEnabled: !!String(oauthCallback?.callbackId || "").trim(),
        };
      });
      res.json({ ok: true, webhooks });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/webhooks/:name", (req, res) => {
    try {
      const name = validateWebhookName(req.params.name);
      const detail = getWebhookDetail({ fs, constants, name });
      if (!detail)
        return res.status(404).json({ ok: false, error: "Webhook not found" });
      const summary = getHookSummaries().find((item) => item.hookName === name);
      const oauthCallback = getOauthCallbackByHookEntry(name);
      const merged = mergeWebhookAndSummary({ webhook: detail, summary });
      const baseUrl = getBaseUrl(req);
      const urls = buildWebhookUrls({ baseUrl, name, oauthCallback });
      let ingressPreset = "token";
      try {
        ingressPreset = hookIngress?.ingressStatus(name)?.preset || "token";
      } catch {}
      return res.json({
        ok: true,
        webhook: {
          ...merged,
          fullUrl: urls.fullUrl,
          authHeaderValue: urls.authHeaderValue,
          queryStringUrl: urls.queryStringUrl,
          queryStringUrlNote: urls.queryStringUrlNote,
          hasRuntimeToken: urls.hasRuntimeToken,
          oauthCallbackId: urls.oauthCallbackId,
          oauthCallbackUrl: urls.oauthCallbackUrl,
          oauthCallbackCreatedAt: urls.oauthCallbackCreatedAt,
          oauthCallbackRotatedAt: urls.oauthCallbackRotatedAt,
          oauthCallbackLastUsedAt: urls.oauthCallbackLastUsedAt,
          ingress: { preset: ingressPreset },
          authNote:
            ingressPreset === "token"
              ? "This hook takes the shared WEBHOOK_TOKEN. Use Authorization: Bearer <token> or x-openclaw-token header."
              : "This hook verifies its sender (" + ingressPreset + "); see Sender verification.",
        },
      });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/webhooks", wrapAsync(async (req, res) => {
    try {
      const {
        name: rawName,
        destination = null,
        oauthCallback = false,
      } = req.body || {};
      const name = validateWebhookName(rawName);
      const transformSource = oauthCallback ? buildOauthTransformSource(name) : "";
      const webhook = createWebhook({
        fs,
        constants,
        name,
        destination,
        transformSource,
      });
      const oauthCallbackRecord = oauthCallback
        ? createOauthCallbackEntry({ hookName: name })
        : null;
      hookIngress?.resetHookIngress(name, { created: true });
      const baseUrl = getBaseUrl(req);
      const urls = buildWebhookUrls({
        baseUrl,
        name,
        oauthCallback: oauthCallbackRecord,
      });
      const syncWarning = await runWebhookGitSync("create", name);
      markRestartRequired("webhooks");
      const snapshot = await getRestartSnapshot();
      return res.status(201).json({
        ok: true,
        webhook: {
          ...webhook,
          fullUrl: urls.fullUrl,
          authHeaderValue: urls.authHeaderValue,
          queryStringUrl: urls.queryStringUrl,
          queryStringUrlNote: urls.queryStringUrlNote,
          hasRuntimeToken: urls.hasRuntimeToken,
          oauthCallbackId: urls.oauthCallbackId,
          oauthCallbackUrl: urls.oauthCallbackUrl,
          oauthCallbackCreatedAt: urls.oauthCallbackCreatedAt,
          oauthCallbackRotatedAt: urls.oauthCallbackRotatedAt,
          oauthCallbackLastUsedAt: urls.oauthCallbackLastUsedAt,
        },
        restartRequired: snapshot.restartRequired,
        syncWarning,
      });
    } catch (err) {
      const status = String(err.message || "").includes("already exists")
        ? 409
        : 400;
      return res.status(status).json({ ok: false, error: err.message });
    }
  }));

  app.put("/api/webhooks/:name/destination", wrapAsync(async (req, res) => {
    try {
      const name = validateWebhookName(req.params.name);
      const detail = updateWebhookDestination({
        fs,
        constants,
        name,
        destination: req?.body?.destination ?? null,
      });
      const summary = getHookSummaries().find((item) => item.hookName === name);
      const oauthCallback = getOauthCallbackByHookEntry(name);
      const merged = mergeWebhookAndSummary({ webhook: detail, summary });
      const baseUrl = getBaseUrl(req);
      const urls = buildWebhookUrls({ baseUrl, name, oauthCallback });
      const syncWarning = await runWebhookGitSync("update destination", name);
      markRestartRequired("webhooks");
      const snapshot = await getRestartSnapshot();
      return res.json({
        ok: true,
        webhook: {
          ...merged,
          fullUrl: urls.fullUrl,
          authHeaderValue: urls.authHeaderValue,
          queryStringUrl: urls.queryStringUrl,
          queryStringUrlNote: urls.queryStringUrlNote,
          hasRuntimeToken: urls.hasRuntimeToken,
          oauthCallbackId: urls.oauthCallbackId,
          oauthCallbackUrl: urls.oauthCallbackUrl,
          oauthCallbackCreatedAt: urls.oauthCallbackCreatedAt,
          oauthCallbackRotatedAt: urls.oauthCallbackRotatedAt,
          oauthCallbackLastUsedAt: urls.oauthCallbackLastUsedAt,
          authNote:
            "All hooks use WEBHOOK_TOKEN. Use Authorization: Bearer <token> or x-openclaw-token header.",
        },
        restartRequired: snapshot.restartRequired,
        syncWarning,
      });
    } catch (err) {
      const status = String(err.message || "").includes("not found") ? 404 : 400;
      return res.status(status).json({ ok: false, error: err.message });
    }
  }));

  app.post("/api/webhooks/:name/oauth-callback", (req, res) => {
    try {
      const name = assertCreatableWebhookName(validateWebhookName(req.params.name));
      // An alias skips sender verification, so on a hook that has moved off
      // the shared token only a person may add one.
      if (req.alphaclawActor?.type === "agent" && hookIngress && hookIngress.ingressStatus(name).preset !== "token") {
        return res.status(403).json({ ok: false, error: "humans_only" });
      }
      const detail = getWebhookDetail({ fs, constants, name });
      if (!detail)
        return res.status(404).json({ ok: false, error: "Webhook not found" });
      const existing = getOauthCallbackByHookEntry(name);
      if (existing?.callbackId) {
        return res.status(409).json({
          ok: false,
          error: "OAuth callback alias already exists",
        });
      }
      const oauthCallback = createOauthCallbackEntry({ hookName: name });
      const baseUrl = getBaseUrl(req);
      const urls = buildWebhookUrls({ baseUrl, name, oauthCallback });
      return res.status(201).json({
        ok: true,
        oauthCallbackId: urls.oauthCallbackId,
        oauthCallbackUrl: urls.oauthCallbackUrl,
        oauthCallbackCreatedAt: urls.oauthCallbackCreatedAt,
        oauthCallbackRotatedAt: urls.oauthCallbackRotatedAt,
        oauthCallbackLastUsedAt: urls.oauthCallbackLastUsedAt,
      });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/webhooks/:name/oauth-callback/rotate", (req, res) => {
    try {
      const name = validateWebhookName(req.params.name);
      const detail = getWebhookDetail({ fs, constants, name });
      if (!detail)
        return res.status(404).json({ ok: false, error: "Webhook not found" });
      const oauthCallback = rotateOauthCallbackEntry(name);
      const baseUrl = getBaseUrl(req);
      const urls = buildWebhookUrls({ baseUrl, name, oauthCallback });
      return res.json({
        ok: true,
        oauthCallbackId: urls.oauthCallbackId,
        oauthCallbackUrl: urls.oauthCallbackUrl,
        oauthCallbackCreatedAt: urls.oauthCallbackCreatedAt,
        oauthCallbackRotatedAt: urls.oauthCallbackRotatedAt,
        oauthCallbackLastUsedAt: urls.oauthCallbackLastUsedAt,
      });
    } catch (err) {
      const status = String(err?.message || "").includes("not found") ? 404 : 400;
      return res.status(status).json({ ok: false, error: err.message });
    }
  });

  app.delete("/api/webhooks/:name/oauth-callback", (req, res) => {
    try {
      const name = validateWebhookName(req.params.name);
      const deletedCount = deleteOauthCallbackEntry(name);
      return res.json({ ok: true, deleted: deletedCount > 0 });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.delete("/api/webhooks/:name", wrapAsync(async (req, res) => {
    try {
      const name = validateWebhookName(req.params.name);
      const deleteTransformDir = parseBooleanFlag(
        req?.body?.deleteTransformDir,
      );
      const deletion = deleteWebhook({
        fs,
        constants,
        name,
        deleteTransformDir,
      });
      if (deletion?.managed) {
        return res.status(409).json({
          ok: false,
          error: `Webhook "${name}" is managed by system setup and cannot be deleted`,
        });
      }
      if (!deletion?.removed)
        return res.status(404).json({ ok: false, error: "Webhook not found" });
      deleteOauthCallbackEntry(name);
      hookIngress?.resetHookIngress(name);
      const deletedRequestCount = deleteRequestsByHook(name);
      const syncWarning = await runWebhookGitSync("delete", name);
      markRestartRequired("webhooks");
      const snapshot = await getRestartSnapshot();
      return res.json({
        ok: true,
        restartRequired: snapshot.restartRequired,
        syncWarning,
        deletedRequestCount,
        deletedTransformDir: !!deletion.deletedTransformDir,
      });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  }));

  app.get("/api/webhooks/:name/requests", (req, res) => {
    try {
      const name = validateWebhookName(req.params.name);
      const limit = Number.parseInt(String(req.query.limit || 50), 10);
      const offset = Number.parseInt(String(req.query.offset || 0), 10);
      const status = normalizeStatusFilter(req.query.status);
      const hasBadPaging =
        !isFiniteInteger(limit) ||
        limit <= 0 ||
        !isFiniteInteger(offset) ||
        offset < 0;
      if (hasBadPaging) {
        return res
          .status(400)
          .json({ ok: false, error: "Invalid limit/offset" });
      }
      const requests = getRequests(name, { limit, offset, status });
      return res.json({ ok: true, requests });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/webhooks/:name/requests/:id", (req, res) => {
    try {
      const name = validateWebhookName(req.params.name);
      const requestId = Number.parseInt(String(req.params.id || 0), 10);
      if (!isFiniteInteger(requestId) || requestId <= 0) {
        return res.status(400).json({ ok: false, error: "Invalid request id" });
      }
      const request = getRequestById(name, requestId);
      if (!request)
        return res.status(404).json({ ok: false, error: "Request not found" });
      return res.json({ ok: true, request });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  // OpenClaw's built-in /hooks/agent and /hooks/wake (GST-2134). Not agent
  // operations: only a person turns them on, mints their token or reopens the
  // shared token on them.
  if (!hookIngress) return;
  const builtinMutation = (handler) => (req, res) => {
    if (req.alphaclawActor?.type === "agent") {
      return res.status(403).json({ ok: false, error: "humans_only" });
    }
    try {
      return handler(req, res);
    } catch (err) {
      return res.status(err.status || 500).json({ ok: false, error: err.message });
    }
  };
  app.get("/api/hook-ingress/builtins", (req, res) => {
    try {
      res.json({ ok: true, ...hookIngress.builtinStatus() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  app.put("/api/hook-ingress/builtins/:name", builtinMutation((req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ ok: false, error: "enabled must be true or false" });
    }
    return res.json({ ok: true, ...hookIngress.setBuiltinEnabled(String(req.params.name || ""), enabled) });
  }));
  app.post("/api/hook-ingress/builtins/:name/token", builtinMutation((req, res) => {
    const token = hookIngress.mintToken(String(req.params.name || ""));
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, token, ...hookIngress.builtinStatus() });
  }));
  app.post("/api/hook-ingress/builtins/:name/reopen", builtinMutation((req, res) =>
    res.json({ ok: true, ...hookIngress.reopenBuiltinSharedToken(String(req.params.name || "")) })));

  // Sender verification per hook (GST-2134 PR 2). Humans only: who may
  // deliver to a hook, and its signing secret, are the owner's to set. The
  // agent actor sees only the preset, in the webhook detail.
  const ingressRoute = (handler) => builtinMutation((req, res) => {
    const name = validateWebhookName(req.params.name);
    res.setHeader("Cache-Control", "no-store");
    return handler(name, req, res);
  });
  app.get("/api/webhooks/:name/ingress", ingressRoute((name, req, res) =>
    res.json({ ok: true, ingress: hookIngress.ingressStatus(name) })));
  app.put("/api/webhooks/:name/ingress", ingressRoute((name, req, res) =>
    res.json({ ok: true, ingress: hookIngress.setIngress(name, { preset: req.body?.preset, secret: req.body?.secret }) })));
  app.post("/api/webhooks/:name/ingress/generate-secret", ingressRoute((name, req, res) => {
    const { secret, ingress } = hookIngress.generateIngressSecret(name, { preset: req.body?.preset });
    return res.json({ ok: true, secret, ingress });
  }));
  app.post("/api/webhooks/:name/ingress/reopen", ingressRoute((name, req, res) =>
    res.json({ ok: true, ingress: hookIngress.reopenIngress(name) })));
};

module.exports = { registerWebhookRoutes };
