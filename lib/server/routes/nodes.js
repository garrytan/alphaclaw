const crypto = require("crypto");
const { sendIfConfigUnreadable } = require("../utils/config-unreadable");
const os = require("os");
const path = require("path");
const { parseJsonObjectFromNoisyOutput } = require("../utils/json");
const { quoteShellArg } = require("../utils/shell");
const {
  readExecApprovalsConfig,
  readExecApprovalsConfigForWrite,
  writeExecApprovalsConfig,
} = require("../exec-defaults-config");
const { wrapAsync } = require("../utils/wrap-async");

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

// (security, ask) → tools.exec.mode, mirroring openclaw's own legacy-config
// migration EXACTLY — including its two deliberate bail-outs (`ask: always`
// and `full + on-miss` have no mode equivalent and stay as legacy keys, which
// both eras accept unflagged). Returns null for the bail-out combos.
const deriveExecMode = (security, ask) => {
  if (ask === "always") return null;
  if (security === "full" && ask === "on-miss") return null;
  if (security === "deny") return "deny";
  if (security === "allowlist" && ask === "off") return "allowlist";
  if (security === "full") return "full"; // ask === "off" here
  return "ask"; // allowlist + on-miss
};

// tools.exec.mode → the legacy (security, ask) pair the dashboard API has
// always exposed. EXACT inverse of upstream's resolveExecPolicyForMode
// (identical in both shipped versions): ask/auto both resolve to
// allowlist + on-miss (auto additionally sets autoReview, which the legacy
// pair cannot express — the raw `mode` field in the response carries it).
// Getting this wrong is a security inversion: mapping "ask" to full-security
// made a GET→save cycle silently drop allowlist enforcement.
const kModeToLegacy = {
  full: { security: "full", ask: "off" },
  allowlist: { security: "allowlist", ask: "off" },
  deny: { security: "deny", ask: "off" },
  ask: { security: "allowlist", ask: "on-miss" },
  auto: { security: "allowlist", ask: "on-miss" },
};

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
  // Era resolver from openclaw-state-era (issue #23): legacy exec-approvals
  // file WRITES require a determinate file-era answer from it.
  resolveExecApprovalsBackend = null,
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

  app.get("/api/nodes", wrapAsync(async (_req, res) => {
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
  }));

  app.post("/api/nodes/:id/approve", wrapAsync(async (req, res) => {
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
  }));

  app.post("/api/nodes/:id/route", wrapAsync(async (req, res) => {
    const nodeId = String(req.params.id || "").trim();
    if (!nodeId || !kSafeNodeIdPattern.test(nodeId)) {
      return res.status(400).json({ ok: false, error: "Invalid node id" });
    }
    // allowlist + on-miss IS converted by openclaw's own mode migration (to
    // mode "ask" — upstream bails only on ask "always" and full+on-miss), so
    // writing the legacy pair here left a doctor-flagged legacy config on the
    // beta. Same read-merge-write as POST /api/nodes/exec-config: one
    // validated whole-object set, preserving unmanaged exec keys.
    const current = await clawCmd("config get tools.exec --json", {
      quiet: true,
      timeoutMs: cliTimeouts.route,
    });
    const existing = current.ok
      ? parseJsonObjectFromNoisyOutput(current.stdout) || {}
      : {};
    const next = { ...existing };
    delete next.security;
    delete next.ask;
    next.host = "node";
    next.node = nodeId;
    next.mode = "ask"; // upstream's conversion of allowlist + on-miss
    const result = await clawCmd(
      `config set tools.exec ${quoteCliArg(JSON.stringify(next))} --strict-json`,
      {
        quiet: true,
        timeoutMs: cliTimeouts.route,
      },
    );
    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: formatCliFailure({
          result,
          fallback: "Could not apply node routing",
          timeoutLabel: "node routing",
          timeoutMs: cliTimeouts.route,
        }),
      });
    }
    return res.json({ ok: true, restartRequired: true, nodeId });
  }));

  app.delete("/api/nodes/:id", wrapAsync(async (req, res) => {
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
  }));

  app.get("/api/nodes/connect-info", wrapAsync(async (req, res) => {
    // Serves the raw gateway token — never cacheable (F080).
    res.set("Cache-Control", "no-store");
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
  }));

  app.get("/api/nodes/:id/browser-status", wrapAsync(async (req, res) => {
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
  }));

  app.get("/api/nodes/exec-config", wrapAsync(async (_req, res) => {
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
    const mode = String(parsed.mode || "").trim().toLowerCase();
    if (kAllowedExecHosts.has(host)) config.host = host;
    // A config written since the mode migration carries tools.exec.mode;
    // derive the legacy pair the API contract exposes, then let explicit
    // legacy keys (still valid on both eras) override.
    if (kModeToLegacy[mode]) {
      config.security = kModeToLegacy[mode].security;
      config.ask = kModeToLegacy[mode].ask;
      config.mode = mode;
    }
    if (kAllowedExecSecurity.has(security)) config.security = security;
    if (kAllowedExecAsk.has(ask)) config.ask = ask;
    if (node) config.node = node;
    return res.json({ ok: true, config });
  }));

  app.post("/api/nodes/exec-config", wrapAsync(async (req, res) => {
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

    // Read-merge-write of the whole tools.exec object in ONE validated
    // `config set … --strict-json` (supported by both the pinned 2026.7.1-2
    // and the 2026.9.x beta). Writing the retired `security`/`ask` keys
    // per-path made the beta flag the config legacy (every CLI command then
    // refuses until `doctor --fix`), and a key-by-key set/unset sequence is
    // not crash-safe. Merging preserves exec keys AlphaClaw does not manage
    // (timeoutSeconds, strictInlineEval, …).
    const current = await clawCmd("config get tools.exec --json", { quiet: true });
    const existing = current.ok
      ? parseJsonObjectFromNoisyOutput(current.stdout) || {}
      : {};
    const next = { ...existing };
    delete next.security;
    delete next.ask;
    delete next.mode;
    next.host = host;
    next.node = host === "node" ? node : "";
    const mode = deriveExecMode(security, ask);
    if (mode) {
      next.mode = mode;
    } else {
      // Combos openclaw's own migration deliberately does NOT convert
      // (ask === "always", full + on-miss): the legacy pair stays valid and
      // unflagged on both eras, so writing it preserves semantics exactly.
      next.security = security;
      next.ask = ask;
    }
    const result = await clawCmd(
      `config set tools.exec ${quoteCliArg(JSON.stringify(next))} --strict-json`,
    );
    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: result.stderr || "Could not apply exec config",
      });
    }

    return res.json({ ok: true, restartRequired: true });
  }));

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

  // Writers fail closed on legacy-file creation (issue #23 rule): when the
  // approvals CLI is unavailable, the file fallback may WRITE only on a
  // determinate file era — a capability-probe failure on a beta box must not
  // let a dashboard edit create the file whose existence breaks the gateway.
  // A missing resolver (older harnesses) preserves the legacy behavior.
  const legacyApprovalsWriteAllowed = async () => {
    if (typeof resolveExecApprovalsBackend !== "function") return true;
    try {
      const backend = await resolveExecApprovalsBackend();
      return backend?.backend === "file";
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
    // `approvals get --json` wraps the document on BOTH eras (verified live
    // against 2026.7.1-2 and 2026.9.1-beta.1): { path, exists, hash,
    // file: <the doc>, effectivePolicy }. Operating on the wrapper corrupted
    // the round-trip — a later `set` would upload path/hash/effectivePolicy
    // as the approvals document. Unwrap, tolerating a bare doc if the shape
    // ever changes back. NOTE: `file.socket.token` is redacted in the get
    // output; `approvals set` re-merges the stored token server-side, so the
    // read-mutate-set cycle below never loses it (verified live).
    const doc =
      parsed.file && typeof parsed.file === "object" && !Array.isArray(parsed.file)
        ? parsed.file
        : parsed;
    return { ok: true, approvals: ensureWildcardAgent(doc) };
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

  app.get("/api/nodes/exec-approvals", wrapAsync(async (_req, res) => {
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
  }));

  app.post("/api/nodes/exec-approvals/allowlist", wrapAsync(async (req, res) => {
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
      if (!(await legacyApprovalsWriteAllowed())) {
        return res.status(503).json({
          ok: false,
          error:
            "Exec approvals store unavailable (era undetermined and the approvals CLI is not answering) — retry shortly",
        });
      }
      // Mutator read (fix wave F215): an existing exec-approvals.json this
      // code cannot parse is a 409 refusal, never a rebuild from { version: 1 }.
      try {
        approvals = ensureWildcardAgent(
          readExecApprovalsConfigForWrite({ fsModule, openclawDir }),
        );
      } catch (err) {
        if (sendIfConfigUnreadable(res, err, { status: 409 })) return;
        throw err;
      }
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
  }));

  app.delete("/api/nodes/exec-approvals/allowlist/:id", wrapAsync(async (req, res) => {
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
      if (!(await legacyApprovalsWriteAllowed())) {
        return res.status(503).json({
          ok: false,
          error:
            "Exec approvals store unavailable (era undetermined and the approvals CLI is not answering) — retry shortly",
        });
      }
      // Mutator read (fix wave F215): an existing exec-approvals.json this
      // code cannot parse is a 409 refusal, never a rebuild from { version: 1 }.
      try {
        approvals = ensureWildcardAgent(
          readExecApprovalsConfigForWrite({ fsModule, openclawDir }),
        );
      } catch (err) {
        if (sendIfConfigUnreadable(res, err, { status: 409 })) return;
        throw err;
      }
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
  }));
};

module.exports = {
  registerNodeRoutes,
};
