const crypto = require("crypto");
const os = require("os");
const path = require("path");
const { parseJsonObjectFromNoisyOutput } = require("../utils/json");
const { quoteShellArg } = require("../utils/shell");
const {
  readExecApprovalsConfig,
  writeExecApprovalsConfig,
} = require("../exec-defaults-config");

const kAllowedExecHosts = new Set(["gateway", "node"]);
const kAllowedExecSecurity = new Set(["deny", "allowlist", "full"]);
const kAllowedExecAsk = new Set(["off", "on-miss", "always"]);
const kSafeNodeIdPattern = /^[\w\-:.]+$/;
const kNodeBrowserInvokeTimeoutMs = 30000;
const kNodeBrowserCliTimeoutMs = 35000;
const kDefaultNodeRouteCliTimeoutMs = 12000;
const kDefaultNodesStatusCliTimeoutMs = 12000;
const kDefaultNodesPendingCliTimeoutMs = 12000;

const quoteCliArg = (value) => quoteShellArg(value, { strategy: "single" });

const resolveCliTimeoutMs = (envName, fallbackMs, env = process.env) => {
  const parsed = Number(env[envName]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return Math.round(parsed);
};

const resolveNodeCliTimeouts = (env = process.env) => ({
  route: resolveCliTimeoutMs(
    "ALPHACLAW_NODE_ROUTE_TIMEOUT_MS",
    kDefaultNodeRouteCliTimeoutMs,
    env,
  ),
  status: resolveCliTimeoutMs(
    "ALPHACLAW_NODES_STATUS_TIMEOUT_MS",
    kDefaultNodesStatusCliTimeoutMs,
    env,
  ),
  pending: resolveCliTimeoutMs(
    "ALPHACLAW_NODES_PENDING_TIMEOUT_MS",
    kDefaultNodesPendingCliTimeoutMs,
    env,
  ),
});

const isCliTimeoutResult = (result) =>
  Boolean(result?.timedOut || (result?.killed && result?.signal));

const formatCliFailure = ({ result, fallback, timeoutLabel, timeoutMs }) => {
  if (isCliTimeoutResult(result)) {
    return `${timeoutLabel} CLI timed out after ${timeoutMs}ms`;
  }
  return String(result?.stderr || "").trim() || fallback;
};

const normalizeExecAsk = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "on") return "on-miss";
  return normalized;
};

const buildDefaultExecConfig = () => ({
  host: "gateway",
  security: "allowlist",
  ask: "on-miss",
  node: "",
});

const parseNodesStatus = (stdout) => {
  const parsed = parseJsonObjectFromNoisyOutput(stdout) || {};
  const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  const pending = Array.isArray(parsed.pending)
    ? parsed.pending
    : nodes.filter((entry) => entry && entry.paired === false);
  return { nodes, pending };
};

const parseNodesPending = (stdout) => {
  const parsed = parseJsonObjectFromNoisyOutput(stdout) || {};
  const list = Array.isArray(parsed.pending)
    ? parsed.pending
    : Array.isArray(parsed.requests)
      ? parsed.requests
      : Array.isArray(parsed.nodes)
        ? parsed.nodes
        : [];
  return list
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const requestId = String(entry.requestId || entry.id || "").trim();
      const nodeId = String(entry.nodeId || requestId).trim();
      if (!nodeId) return null;
      return {
        ...entry,
        id: requestId || nodeId,
        nodeId,
        paired: false,
      };
    })
    .filter(Boolean);
};

const parseNodeBrowserStatus = (stdout) => {
  const parsed = parseJsonObjectFromNoisyOutput(stdout) || {};
  const payload =
    parsed.payload && typeof parsed.payload === "object" ? parsed.payload : {};
  const payloadResult = payload.result;
  let decodedResult = payloadResult;
  if (typeof decodedResult === "string") {
    const parsedResult = parseJsonObjectFromNoisyOutput(decodedResult);
    decodedResult = parsedResult || decodedResult;
  }
  if (decodedResult && typeof decodedResult === "object" && decodedResult.result) {
    const nestedResult = decodedResult.result;
    if (nestedResult && typeof nestedResult === "object") {
      decodedResult = nestedResult;
    }
  }
  return decodedResult && typeof decodedResult === "object" ? decodedResult : null;
};

const ensureWildcardAgent = (file) => {
  const agents = file.agents && typeof file.agents === "object" ? file.agents : {};
  const wildcard =
    agents["*"] && typeof agents["*"] === "object" ? agents["*"] : {};
  const allowlist = Array.isArray(wildcard.allowlist) ? wildcard.allowlist : [];
  agents["*"] = { ...wildcard, allowlist };
  return { ...file, version: 1, agents };
};

const resolveSetupUiBaseUrl = (req) => {
  const explicit = String(
    process.env.ALPHACLAW_SETUP_URL ||
      process.env.ALPHACLAW_BASE_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      process.env.URL ||
      "",
  )
    .trim()
    .replace(/\/+$/, "");
  if (explicit) return explicit;

  const railwayPublicDomain = String(process.env.RAILWAY_PUBLIC_DOMAIN || "").trim();
  if (railwayPublicDomain) {
    return `https://${railwayPublicDomain}`;
  }

  const railwayStaticUrl = String(process.env.RAILWAY_STATIC_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (railwayStaticUrl) return railwayStaticUrl;

  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").trim();
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  const reqProtocol = req.protocol || "http";
  const reqHost = req.get("host");
  if (reqHost) {
    return `${reqProtocol}://${reqHost}`;
  }

  return "http://localhost:3000";
};

const parseBaseUrlParts = (baseUrl) => {
  try {
    const parsed = new URL(baseUrl);
    const tls = parsed.protocol === "https:";
    const port =
      Number(parsed.port) || (tls ? 443 : 80);
    return {
      baseUrl: parsed.origin,
      host: parsed.hostname,
      port,
      tls,
    };
  } catch {
    return {
      baseUrl: "http://localhost:3000",
      host: "localhost",
      port: 3000,
      tls: false,
    };
  }
};

const registerNodeRoutes = ({
  app,
  clawCmd,
  // Rate-limit-aware variant for CLI writes; falls back to clawCmd when the
  // caller does not wire it (older harnesses).
  clawCmdWithRetry = null,
  // Capability service (openclaw-capabilities.js). When the installed
  // openclaw has the `approvals` CLI (SQLite-era exec approvals, issue #23),
  // the exec-approvals routes go through it and NEVER touch the legacy
  // exec-approvals.json — creating that file breaks the gateway on that era.
  openclawCapabilities = null,
  openclawDir,
  gatewayToken = "",
  // Lazy resolution so an auth-mode change (team mode) after boot is
  // reflected without a server restart. Falls back to the static token.
  getGatewayToken = null,
  // Returns the gateway's auth mechanism ("token" | "password"); non-token
  // means token onboarding cannot work (team/trusted-proxy mode).
  getGatewayAuthMode = null,
  fsModule,
}) => {
  const cliTimeouts = resolveNodeCliTimeouts();
  // A resolver throw yields "" (no token) rather than the static fallback: a
  // possibly-stale static token that the gateway would reject is worse than
  // an honest empty. The static token only applies when no resolver is wired.
  const resolveGatewayToken = () => {
    if (typeof getGatewayToken === "function") {
      try {
        return String(getGatewayToken() || "");
      } catch {
        return "";
      }
    }
    return String(gatewayToken || "");
  };
  const resolveGatewayAuthMode = () => {
    try {
      return typeof getGatewayAuthMode === "function"
        ? String(getGatewayAuthMode() || "token")
        : "token";
    } catch {
      return "token";
    }
  };

  app.get("/api/nodes", async (_req, res) => {
    const statusResult = await clawCmd("nodes status --json", {
      quiet: true,
      timeoutMs: cliTimeouts.status,
    });
    if (!statusResult.ok) {
      return res.status(500).json({
        ok: false,
        error: formatCliFailure({
          result: statusResult,
          fallback: "Could not load nodes status",
          timeoutLabel: "nodes status",
          timeoutMs: cliTimeouts.status,
        }),
      });
    }
    const status = parseNodesStatus(statusResult.stdout);
    const pendingResult = await clawCmd("nodes pending --json", {
      quiet: true,
      timeoutMs: cliTimeouts.pending,
    });
    const pending = pendingResult.ok
      ? parseNodesPending(pendingResult.stdout)
      : status.pending;
    const pendingById = new Map();
    for (const entry of pending) {
      const nodeId = String(entry?.nodeId || entry?.id || "").trim();
      if (!nodeId || pendingById.has(nodeId)) continue;
      pendingById.set(nodeId, entry);
    }
    return res.json({
      ok: true,
      nodes: status.nodes,
      pending: Array.from(pendingById.values()),
    });
  });

  app.post("/api/nodes/:id/approve", async (req, res) => {
    const nodeId = String(req.params.id || "").trim();
    if (!nodeId || !kSafeNodeIdPattern.test(nodeId)) {
      return res.status(400).json({ ok: false, error: "Invalid node id" });
    }
    const result = await clawCmd(`nodes approve ${quoteCliArg(nodeId)}`);
    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: result.stderr || "Could not approve node",
      });
    }
    return res.json({ ok: true });
  });

  app.post("/api/nodes/:id/route", async (req, res) => {
    const nodeId = String(req.params.id || "").trim();
    if (!nodeId || !kSafeNodeIdPattern.test(nodeId)) {
      return res.status(400).json({ ok: false, error: "Invalid node id" });
    }
    const commands = [
      "config set tools.exec.host 'node'",
      "config set tools.exec.security 'allowlist'",
      "config set tools.exec.ask 'on-miss'",
      `config set tools.exec.node ${quoteCliArg(nodeId)}`,
    ];
    for (const command of commands) {
      const result = await clawCmd(command, {
        quiet: true,
        timeoutMs: cliTimeouts.route,
      });
      if (!result.ok) {
        return res.status(500).json({
          ok: false,
          error: formatCliFailure({
            result,
            fallback: `Could not apply node routing (${command})`,
            timeoutLabel: "node routing",
            timeoutMs: cliTimeouts.route,
          }),
        });
      }
    }
    return res.json({ ok: true, restartRequired: true, nodeId });
  });

  app.delete("/api/nodes/:id", async (req, res) => {
    const nodeId = String(req.params.id || "").trim();
    if (!nodeId || !kSafeNodeIdPattern.test(nodeId)) {
      return res.status(400).json({ ok: false, error: "Invalid node id" });
    }
    const result = await clawCmd(`devices remove ${quoteCliArg(nodeId)}`, {
      quiet: true,
    });
    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: result.stderr || "Could not remove node",
      });
    }
    return res.json({ ok: true, nodeId });
  });

  app.get("/api/nodes/connect-info", async (req, res) => {
    const baseUrl = resolveSetupUiBaseUrl(req);
    const parsed = parseBaseUrlParts(baseUrl);
    const token = resolveGatewayToken();
    const authMode = resolveGatewayAuthMode();
    return res.json({
      ok: true,
      baseUrl: parsed.baseUrl,
      gatewayHost: parsed.host,
      gatewayPort: parsed.port,
      gatewayToken: token,
      // Machine-readable reason ONLY when the gateway's auth mode actually
      // refuses tokens (team/trusted-proxy) — a plain unconfigured token on a
      // token-mode gateway must not claim to be in team mode.
      ...(!token && authMode !== "token"
        ? {
            authMode,
            tokenUnavailableReason:
              "Gateway is in team (trusted-proxy) mode — token-based node onboarding is unavailable until team mode is disabled.",
          }
        : {}),
      tls: parsed.tls,
    });
  });

  app.get("/api/nodes/:id/browser-status", async (req, res) => {
    const nodeId = String(req.params.id || "").trim();
    if (!nodeId || !kSafeNodeIdPattern.test(nodeId)) {
      return res.status(400).json({ ok: false, error: "Invalid node id" });
    }
    const profile = String(req.query?.profile || "user").trim() || "user";
    const params = JSON.stringify({
      method: "GET",
      path: "/",
      query: { profile },
    });
    const result = await clawCmd(
      `nodes invoke --node ${quoteCliArg(nodeId)} --command browser.proxy --params ${quoteCliArg(params)} --invoke-timeout ${kNodeBrowserInvokeTimeoutMs} --json`,
      { quiet: true, timeoutMs: kNodeBrowserCliTimeoutMs },
    );
    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: result.stderr || "Could not probe node browser status",
      });
    }
    const status = parseNodeBrowserStatus(result.stdout);
    if (!status) {
      return res.status(500).json({
        ok: false,
        error: "Could not parse node browser status",
      });
    }
    return res.json({ ok: true, status, profile });
  });

  app.get("/api/nodes/exec-config", async (_req, res) => {
    const result = await clawCmd("config get tools.exec --json", { quiet: true });
    if (!result.ok) {
      return res.json({ ok: true, config: buildDefaultExecConfig() });
    }
    const parsed = parseJsonObjectFromNoisyOutput(result.stdout) || {};
    const config = buildDefaultExecConfig();
    const host = String(parsed.host || "").trim().toLowerCase();
    const security = String(parsed.security || "").trim().toLowerCase();
    const ask = normalizeExecAsk(parsed.ask);
    const node = String(parsed.node || "").trim();
    if (kAllowedExecHosts.has(host)) config.host = host;
    if (kAllowedExecSecurity.has(security)) config.security = security;
    if (kAllowedExecAsk.has(ask)) config.ask = ask;
    if (node) config.node = node;
    return res.json({ ok: true, config });
  });

  app.post("/api/nodes/exec-config", async (req, res) => {
    const body = req.body || {};
    const host = String(body.host || "").trim().toLowerCase();
    const security = String(body.security || "").trim().toLowerCase();
    const ask = normalizeExecAsk(body.ask);
    const node = String(body.node || "").trim();
    if (!kAllowedExecHosts.has(host)) {
      return res.status(400).json({ ok: false, error: "Invalid exec host" });
    }
    if (!kAllowedExecSecurity.has(security)) {
      return res.status(400).json({ ok: false, error: "Invalid exec security" });
    }
    if (!kAllowedExecAsk.has(ask)) {
      return res.status(400).json({ ok: false, error: "Invalid exec ask mode" });
    }
    if (host === "node" && !node) {
      return res
        .status(400)
        .json({ ok: false, error: "Node target is required when host is node" });
    }

    const commands = [
      `config set tools.exec.host ${quoteCliArg(host)}`,
      `config set tools.exec.security ${quoteCliArg(security)}`,
      `config set tools.exec.ask ${quoteCliArg(ask)}`,
      host === "node"
        ? `config set tools.exec.node ${quoteCliArg(node)}`
        : "config set tools.exec.node ''",
    ];

    for (const command of commands) {
      const result = await clawCmd(command);
      if (!result.ok) {
        return res.status(500).json({
          ok: false,
          error: result.stderr || `Could not apply exec config (${command})`,
        });
      }
    }

    return res.json({ ok: true, restartRequired: true });
  });

  // True when the installed openclaw stores exec approvals in SQLite and
  // exposes the `approvals` CLI (issue #23). A missing service or a probe
  // failure degrades to the legacy file path, unchanged.
  const hasExecApprovalsCli = async () => {
    try {
      return (await openclawCapabilities?.get?.("execApprovalsCli")) === true;
    } catch {
      return false;
    }
  };

  const readApprovalsViaCli = async () => {
    const result = await clawCmd("approvals get --json", { quiet: true });
    if (!result.ok) {
      return {
        ok: false,
        error:
          String(result?.stderr || "").trim() || "Could not read exec approvals",
      };
    }
    // Parse-failure parity with the file path: an unreadable store degrades
    // to the empty { version: 1 } document rather than erroring.
    const parsed = parseJsonObjectFromNoisyOutput(result.stdout) || { version: 1 };
    return { ok: true, approvals: ensureWildcardAgent(parsed) };
  };

  const writeApprovalsViaCli = async (approvals) => {
    // The snapshot can carry socket.token — write the tmpfile 0600 and remove
    // it as soon as the CLI has consumed it.
    const tmpFile = path.join(
      os.tmpdir(),
      `alphaclaw-exec-approvals-${crypto.randomUUID()}.json`,
    );
    try {
      fsModule.writeFileSync(tmpFile, JSON.stringify(approvals, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      const runCmd = clawCmdWithRetry || clawCmd;
      const result = await runCmd(
        `approvals set --file ${quoteCliArg(tmpFile)}`,
        { quiet: true },
      );
      if (!result.ok) {
        return {
          ok: false,
          error:
            String(result?.stderr || "").trim() || "Could not write exec approvals",
        };
      }
      return { ok: true };
    } finally {
      try {
        fsModule.unlinkSync?.(tmpFile);
      } catch {}
    }
  };

  app.get("/api/nodes/exec-approvals", async (_req, res) => {
    if (await hasExecApprovalsCli()) {
      const read = await readApprovalsViaCli();
      if (!read.ok) return res.status(500).json({ ok: false, error: read.error });
      return res.json({
        ok: true,
        file: read.approvals,
        allowlist: read.approvals?.agents?.["*"]?.allowlist || [],
      });
    }
    const approvals = ensureWildcardAgent(
      readExecApprovalsConfig({ fsModule, openclawDir }),
    );
    const allowlist = approvals?.agents?.["*"]?.allowlist || [];
    return res.json({
      ok: true,
      file: approvals,
      allowlist,
    });
  });

  app.post("/api/nodes/exec-approvals/allowlist", async (req, res) => {
    const pattern = String(req.body?.pattern || "").trim();
    if (!pattern) {
      return res.status(400).json({ ok: false, error: "pattern is required" });
    }
    const cliBacked = await hasExecApprovalsCli();
    let approvals;
    if (cliBacked) {
      // NOTE: get → mutate → set is an unlocked read-modify-write; concurrent
      // dashboard edits can interleave exactly as they can on the legacy
      // read-file → mutate → write-file path below. Parity accepted rather
      // than adding locking (concurrent dashboard edits are rare).
      const read = await readApprovalsViaCli();
      if (!read.ok) return res.status(500).json({ ok: false, error: read.error });
      approvals = read.approvals;
    } else {
      approvals = ensureWildcardAgent(
        readExecApprovalsConfig({ fsModule, openclawDir }),
      );
    }
    const allowlist = approvals.agents["*"].allowlist;
    const existing = allowlist.find(
      (entry) => String(entry?.pattern || "").trim() === pattern,
    );
    if (existing) {
      return res.json({ ok: true, entry: existing, unchanged: true });
    }
    const entry = {
      pattern,
      id: crypto.randomUUID(),
      lastUsedAt: Date.now(),
    };
    approvals.agents["*"].allowlist = [...allowlist, entry];
    if (cliBacked) {
      const write = await writeApprovalsViaCli(approvals);
      if (!write.ok) return res.status(500).json({ ok: false, error: write.error });
    } else {
      writeExecApprovalsConfig({ fsModule, openclawDir, file: approvals });
    }
    return res.json({ ok: true, entry });
  });

  app.delete("/api/nodes/exec-approvals/allowlist/:id", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) {
      return res.status(400).json({ ok: false, error: "id is required" });
    }
    const cliBacked = await hasExecApprovalsCli();
    let approvals;
    if (cliBacked) {
      // Same unlocked read-modify-write parity note as the POST handler.
      const read = await readApprovalsViaCli();
      if (!read.ok) return res.status(500).json({ ok: false, error: read.error });
      approvals = read.approvals;
    } else {
      approvals = ensureWildcardAgent(
        readExecApprovalsConfig({ fsModule, openclawDir }),
      );
    }
    const allowlist = approvals.agents["*"].allowlist;
    const nextAllowlist = allowlist.filter((entry) => String(entry?.id || "") !== id);
    if (nextAllowlist.length === allowlist.length) {
      return res.status(404).json({ ok: false, error: "Allowlist entry not found" });
    }
    approvals.agents["*"].allowlist = nextAllowlist;
    if (cliBacked) {
      const write = await writeApprovalsViaCli(approvals);
      if (!write.ok) return res.status(500).json({ ok: false, error: write.error });
    } else {
      writeExecApprovalsConfig({ fsModule, openclawDir, file: approvals });
    }
    return res.json({ ok: true });
  });
};

module.exports = {
  registerNodeRoutes,
};
