// MCP servers as the box status shows them (ALPH-40): what openclaw.json
// configures, what the gateway reported about each since AlphaClaw started
// (lib/server/mcp-watch.js: last event, last error, this launch or not), and,
// when asked with probe=1, OpenClaw's own live probe (`openclaw mcp probe
// --json`: connects to each server once and lists its tools), so the tool
// counts are real. The probe starts each stdio server briefly, exactly like
// the CLI; it runs at most once per 10 minutes, single-flight, within 45 s.
const { redactLine, collectSecretValues } = require("../utils/redact");

const kMaxServers = 64;
const kProbeCommand = "mcp probe --json";
const kProbeTimeoutMs = 45_000;
const kProbeCacheMs = 10 * 60_000;
const kMaxDiagnostics = 20;

const describeTarget = (entry, secrets) => {
  if (typeof entry.url === "string") {
    try {
      const url = new URL(entry.url);
      return redactLine(url.origin + url.pathname, { secrets, maxLength: 200 });
    } catch {
      return "invalid url";
    }
  }
  if (typeof entry.command === "string") {
    const base = entry.command.split("/").pop();
    const args = Array.isArray(entry.args) ? entry.args.length : 0;
    return redactLine(base, { secrets, maxLength: 80 }) + (args ? " (+" + args + " args)" : "");
  }
  return null;
};

const describeTransport = (entry) => {
  if (typeof entry.transport === "string") return entry.transport.slice(0, 40);
  if (typeof entry.url === "string") return "http";
  if (typeof entry.command === "string") return "stdio";
  return "unknown";
};

const createMcpReader = ({
  readConfig,
  watch = null,
  clawCmd = null,
  readEnvFile = () => [],
  env = process.env,
  nowFn = Date.now,
} = {}) => {
  let probeCache = null;

  const secretsNow = () => {
    let envFileVars = [];
    try { envFileVars = readEnvFile() || []; } catch {}
    return collectSecretValues({ env, envFileVars });
  };

  const runProbe = async (secrets) => {
    if (typeof clawCmd !== "function") return { status: "unavailable", reason: "no_cli", servers: {}, diagnostics: [] };
    const result = await clawCmd(kProbeCommand, { quiet: true, timeoutMs: kProbeTimeoutMs });
    let body = null;
    try { body = JSON.parse(String(result?.stdout || "")); } catch {}
    if (!body || typeof body.servers !== "object" || body.servers === null) {
      return { status: "unavailable", reason: result?.ok ? "unreadable_answer" : "probe_failed", detail: redactLine(String(result?.stderr || ""), { secrets, maxLength: 200 }) || null, servers: {}, diagnostics: [] };
    }
    const servers = {};
    for (const [name, server] of Object.entries(body.servers).slice(0, kMaxServers)) {
      servers[name] = {
        tools: Number.isSafeInteger(server?.tools) ? server.tools : null,
        resources: server?.resources === true,
        prompts: server?.prompts === true,
      };
    }
    const diagnostics = (Array.isArray(body.diagnostics) ? body.diagnostics : []).slice(0, kMaxDiagnostics)
      .map((entry) => redactLine(typeof entry === "string" ? entry : entry?.message ?? JSON.stringify(entry), { secrets, maxLength: 300 }));
    return { status: result?.ok ? "ok" : "partial", reason: null, servers, diagnostics };
  };

  const readProbe = (secrets) => {
    const now = nowFn();
    if (probeCache && now >= probeCache.atMs && now - probeCache.atMs < kProbeCacheMs) return probeCache.promise;
    const atMs = now;
    const promise = runProbe(secrets).then((value) => ({ ...value, at: new Date(atMs).toISOString() }));
    probeCache = { atMs, promise };
    promise.catch(() => { if (probeCache?.promise === promise) probeCache = null; });
    return promise;
  };

  const read = async ({ probe = false } = {}) => {
    const secrets = secretsNow();
    let config = null;
    try { config = readConfig(); } catch {}
    const configured = config?.mcp?.servers && typeof config.mcp.servers === "object" ? config.mcp.servers : {};
    const runtime = watch?.getState?.() ?? { launchAt: null, servers: [] };
    const runtimeByName = new Map(runtime.servers.map((entry) => [entry.name, entry]));
    const probed = probe ? await readProbe(secrets) : (probeCache ? await probeCache.promise.catch(() => null) : null);
    const names = [...new Set([...Object.keys(configured), ...runtimeByName.keys(), ...Object.keys(probed?.servers || {})])].slice(0, kMaxServers);
    const servers = names.map((name) => {
      const entry = configured[name] && typeof configured[name] === "object" ? configured[name] : null;
      const seen = runtimeByName.get(name) || null;
      const tools = probed?.servers?.[name] ?? null;
      return {
        name: redactLine(name, { secrets, maxLength: 120 }),
        configured: entry !== null,
        enabled: entry ? entry.enabled !== false : null,
        transport: entry ? describeTransport(entry) : null,
        target: entry ? describeTarget(entry, secrets) : null,
        toolCount: tools?.tools ?? null,
        lastEvent: seen?.lastEvent ?? null,
        lastError: seen?.lastError ?? null,
        failing: Boolean(seen?.lastError?.thisLaunch && seen.lastEvent?.kind === seen.lastError.kind),
      };
    });
    return {
      ok: true,
      gatewayLaunchAt: runtime.launchAt,
      total: servers.length,
      failing: servers.filter((server) => server.failing).length,
      servers,
      probe: probed ? { status: probed.status, reason: probed.reason ?? null, at: probed.at, detail: probed.detail ?? null, diagnostics: probed.diagnostics } : null,
    };
  };

  return { read };
};

module.exports = { createMcpReader, kProbeCommand };
