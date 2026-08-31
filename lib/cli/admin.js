const fs = require("fs");
const http = require("http");
const path = require("path");
const {
  kConfirmHeader,
  kRequestContextHeader: kContextHeader,
  kMaxRequestContextLength,
} = require("../server/agent-admin/constants");
const tokenStore = require("../server/agent-admin/token-store");

// `alphaclaw admin` — a thin authenticated HTTP client for the running server's
// /api surface. The server owns all validation, side effects, restart marking,
// and tier enforcement; this verb just carries method + path + body + confirm.
// Runs entirely out of process (early-exit in bin, before the boot sync).

const kDefaultTimeoutMs = 30_000;

// Token path + reader are the server's own (token-store.js) so a filename or
// directory change can't silently break `alphaclaw admin` auth. rootDir/.openclaw
// is the openclawDir the store expects.
const readToken = (rootDir) =>
  tokenStore.readToken({ openclawDir: path.join(rootDir, ".openclaw") });

const flagValue = (argv, ...flags) => {
  for (const flag of flags) {
    const idx = argv.indexOf(flag);
    if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
  }
  return undefined;
};

const hasFlag = (argv, flag) => argv.includes(flag);

// One JSON document on stdout (A36); diagnostics on stderr. Exit 0 iff the
// operation succeeded.
const emit = ({ jsonMode, payload, human }) => {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else if (human) {
    process.stdout.write(`${human}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
};

const kManifestPointer =
  "Run `alphaclaw admin manifest` for the operation catalog.";

// A digest of GET /api/status for the agent's most-run command (A/E9).
const renderSummary = (status) => {
  if (!status || typeof status !== "object") return "No status available.";
  const lines = [];
  lines.push(`gateway: ${status.gateway ?? "unknown"}`);
  if (status.openclawVersion) lines.push(`openclaw: ${status.openclawVersion}`);
  if (status.openclawChannel?.channel) {
    lines.push(`channel: ${status.openclawChannel.channel}`);
  }
  if (Array.isArray(status.channels)) {
    const active = status.channels
      .filter((c) => c?.connected || c?.enabled)
      .map((c) => c.channel || c.name)
      .filter(Boolean);
    if (active.length) lines.push(`channels: ${active.join(", ")}`);
  }
  if (status.machine && typeof status.machine === "object") {
    const m = status.machine;
    const gpu = m.gpu?.present ? ", gpu" : "";
    const autotune = m.autotune?.enabled ? "on" : "off";
    lines.push(
      `machine: ${m.cores ?? "?"} vCPU / ${m.memoryGb ?? "?"} GB (${m.tier ?? "unknown"})${gpu} · autotune ${autotune}`,
    );
  }
  if (status.restartRequired) lines.push("restart: REQUIRED");
  if (status.agentAdmin?.state) lines.push(`agentAdmin: ${status.agentAdmin.state}`);
  return lines.join("\n");
};

const request = ({ method, urlPath, body, headers, port, timeoutMs }) =>
  new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: urlPath, headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode, raw });
        });
      },
    );
    req.on("error", (error) => resolve({ error }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ error: new Error("timeout"), timedOut: true });
    });
    if (body != null) req.write(body);
    req.end();
  });

// Returns a process exit code.
const runAdminCommand = async ({ argv, rootDir }) => {
  const jsonMode = hasFlag(argv, "--json");
  // Explicit --port wins over the inherited PORT env (B8): gatewayEnv
  // deliberately allowlists PORT into the agent's shell (gateway-env-policy.js)
  // precisely so this resolution works, so env-first would make --port dead.
  const port = String(flagValue(argv, "--port") || process.env.PORT || "3000").trim();

  const fail = (payload) => {
    emit({ jsonMode, payload });
    return 1;
  };

  const sub = argv[0];

  // `admin manifest` — served by the running server, falling back to the
  // bundled static manifest read-only when the server is down.
  if (sub === "manifest") {
    const token = readToken(rootDir);
    if (token) {
      const opFilter = flagValue(argv, "--op");
      const domainFilter = flagValue(argv, "--domain");
      const qs = [];
      if (opFilter) qs.push(`op=${encodeURIComponent(opFilter)}`);
      if (domainFilter) qs.push(`domain=${encodeURIComponent(domainFilter)}`);
      const urlPath = `/api/admin/manifest${qs.length ? `?${qs.join("&")}` : ""}`;
      const result = await request({
        method: "GET",
        urlPath,
        headers: { Authorization: `Bearer ${token}` },
        port,
        timeoutMs: kDefaultTimeoutMs,
      });
      if (!result.error) {
        try {
          const parsed = JSON.parse(result.raw);
          emit({ jsonMode, payload: { ...parsed, source: "live" } });
          return result.status >= 200 && result.status < 300 ? 0 : 1;
        } catch {
          /* fall through to static */
        }
      }
    }
    // Static fallback.
    try {
      const manifest = require("../server/admin-manifest").getManifest();
      emit({ jsonMode, payload: { ok: true, source: "fallback", ...manifest } });
      return 0;
    } catch (error) {
      return fail({
        ok: false,
        code: "server_unreachable",
        message: `Server not reachable on port ${port} and static manifest failed: ${error.message}`,
      });
    }
  }

  // `admin <METHOD> </api/path>` — the uniform verb.
  const method = String(sub || "").toUpperCase();
  if (!["GET", "POST", "PUT", "DELETE", "PATCH"].includes(method)) {
    return fail({
      ok: false,
      code: "usage",
      message:
        "Usage: alphaclaw admin <GET|POST|PUT|DELETE|PATCH> /api/<path> [--data '<json>' | --data-stdin] [--confirm CODE] [--context STR] [--summary] [--json]",
      hint: kManifestPointer,
    });
  }
  const urlPath = argv[1];
  if (!urlPath || !urlPath.startsWith("/api/")) {
    return fail({
      ok: false,
      code: "usage",
      message: "Path must start with /api/",
      hint: kManifestPointer,
    });
  }

  const token = readToken(rootDir);
  if (!token) {
    return fail({
      ok: false,
      code: "agent_admin_disabled",
      message: "No agent-admin token found.",
      hint: "Enable Agent Administration in the AlphaClaw dashboard (General tab).",
    });
  }

  // Body: --data '<json>' or --data-stdin (keeps secrets out of process args).
  let body = null;
  if (hasFlag(argv, "--data-stdin")) {
    try {
      body = fs.readFileSync(0, "utf8");
    } catch {
      body = "";
    }
  } else {
    const dataArg = flagValue(argv, "--data");
    if (dataArg !== undefined) body = dataArg;
  }
  if (body != null && body !== "") {
    try {
      JSON.parse(body);
    } catch (error) {
      emit({
        jsonMode,
        payload: {
          ok: false,
          code: "invalid_json",
          message: `--data is not valid JSON: ${error.message}`,
        },
      });
      return 2;
    }
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const confirm = flagValue(argv, "--confirm");
  if (confirm) headers[kConfirmHeader] = confirm;
  const context = flagValue(argv, "--context");
  if (context) headers[kContextHeader] = String(context).slice(0, kMaxRequestContextLength);

  const result = await request({
    method,
    urlPath,
    body,
    headers,
    port,
    timeoutMs: kDefaultTimeoutMs,
  });

  if (result.error) {
    return fail({
      ok: false,
      code: result.timedOut ? "timeout" : "server_unreachable",
      message: result.timedOut
        ? `Request timed out after ${kDefaultTimeoutMs}ms`
        : `AlphaClaw server is not responding on port ${port}. The gateway may be mid-restart; check the Watchdog tab.`,
      port: Number(port),
    });
  }

  // Parse the response. CLI success = HTTP 2xx AND parsed JSON lacking
  // error/ok:false. 2xx + non-JSON → print raw, exit 0 (A28).
  const ok2xx = result.status >= 200 && result.status < 300;
  let parsed = null;
  try {
    parsed = result.raw ? JSON.parse(result.raw) : null;
  } catch {
    // Non-JSON body.
    if (ok2xx) {
      emit({ jsonMode: false, payload: null, human: result.raw });
      return 0;
    }
    return fail({
      ok: false,
      code: "http_error",
      httpStatus: result.status,
      message: result.raw?.slice(0, 500) || `HTTP ${result.status}`,
    });
  }

  const succeeded = ok2xx && parsed?.ok !== false && parsed?.error === undefined;

  if (hasFlag(argv, "--summary") && succeeded) {
    emit({ jsonMode, payload: parsed, human: renderSummary(parsed) });
    return 0;
  }

  emit({ jsonMode, payload: parsed ?? { ok: succeeded, httpStatus: result.status } });
  return succeeded ? 0 : 1;
};

module.exports = { runAdminCommand };
