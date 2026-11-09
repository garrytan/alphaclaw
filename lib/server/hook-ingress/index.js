// One edge decision for every /hooks delivery (GST-2134, PR 1). The gateway
// still checks hooks.token itself; AlphaClaw decides first, from the exact
// headers it will forward, so a wrong credential never reaches the gateway,
// failures are counted per real client (the gateway sees every caller as
// 127.0.0.1), and OpenClaw's built-in /hooks/agent and /hooks/wake are closed
// to the outside unless the owner turned them on.
const fs = require("fs");
const { loginLimiterKey, resolveLoginClientIp } = require("../login-client-ip");
const { resolveHookIngress, sanitizeHeaders } = require("../webhook-middleware");
const {
  builtinSharedWindow,
  credentialMatches,
  extractHookToken,
  hasCredentialHint,
  ownTokenMatches,
  resolveHookCredential,
} = require("./verify");
const {
  kBuiltinMigrationVersion,
  kBuiltinNames,
  mintBuiltinToken,
  readBuiltinsPolicy,
  readSecrets,
  updateBuiltinsPolicy,
} = require("./policy");

const kFailureWindowMs = 60_000;
const kFailureLimit = 20;
const kFailureKeysMax = 10_000;
const kRefusalRowIntervalMs = 10_000;
const kBuiltinSet = new Set(kBuiltinNames);

const isBuiltinHook = (hookName) => kBuiltinSet.has(hookName);

const createHookIngress = ({
  fsModule = fs,
  openclawDir,
  rootDir,
  readOpenclawConfig = () => null,
  getLaunchEnv = () => null,
  insertRequest = () => {},
  isKnownHook = () => true,
  hasAcceptedRequest = () => false,
  notify = null,
  getSetupUrl = () => "",
  nowMs = () => Date.now(),
  logger = console,
} = {}) => {
  const failures = new Map();
  const refusalRows = new Map();
  let lastCredentialWarning = "";

  const webhooksUrl = () => {
    const base = String(getSetupUrl() || "").replace(/\/+$/, "");
    return base ? base + "/#/webhooks" : "the Webhooks page";
  };
  const isoAt = (ms) => new Date(ms).toISOString();

  const sendNotice = (message, id) => {
    if (typeof notify !== "function") return;
    Promise.resolve()
      .then(() => notify(message, { eventType: "hook_ingress", id }))
      .catch(() => {});
  };

  const resolveCredential = () => {
    let hooks = null;
    try {
      hooks = readOpenclawConfig()?.hooks || null;
    } catch {}
    const resolved = resolveHookCredential({ hooks, launchEnv: getLaunchEnv() });
    if (!resolved.ok && resolved.reason !== lastCredentialWarning) {
      lastCredentialWarning = resolved.reason;
      logger.warn?.(
        "[hooks] edge check skipped: the gateway's hook credential cannot be resolved here (" +
          resolved.reason + "); the gateway decides on its own",
      );
    }
    if (resolved.ok) lastCredentialWarning = "";
    return resolved;
  };

  const failureKey = (req) => loginLimiterKey(resolveLoginClientIp(req));

  // Consulted only after a credential failed, so a matching credential is
  // never refused here.
  const takeFailure = (req) => {
    const key = failureKey(req);
    const now = nowMs();
    let entry = failures.get(key);
    if (!entry || now - entry.startedAt >= kFailureWindowMs) {
      failures.delete(key);
      entry = { startedAt: now, count: 0 };
      failures.set(key, entry);
      while (failures.size > kFailureKeysMax) failures.delete(failures.keys().next().value);
    }
    if (entry.count >= kFailureLimit) {
      return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((entry.startedAt + kFailureWindowMs - now) / 1000)) };
    }
    entry.count += 1;
    return { limited: false };
  };

  // At most one refused row per hook per 10 s, carrying the count it
  // suppressed, so a flood cannot push real deliveries out of the per-hook cap.
  const recordRefusal = ({ hookName, method, headers, sourceIp, status, reason, detail }) => {
    if (!isBuiltinHook(hookName) && !isKnownHook(hookName)) return;
    const now = nowMs();
    const entry = refusalRows.get(hookName) || { lastAt: -Infinity, suppressed: 0 };
    if (now - entry.lastAt < kRefusalRowIntervalMs) {
      entry.suppressed += 1;
      refusalRows.set(hookName, entry);
      return;
    }
    const suppressed = entry.suppressed;
    refusalRows.set(hookName, { lastAt: now, suppressed: 0 });
    const gatewayBody =
      "AlphaClaw refused this delivery: " + detail +
      (suppressed > 0 ? " (" + suppressed + " more refused in the 10 s before this row)" : "");
    try {
      insertRequest({
        hookName,
        method: method || "POST",
        headers: headers || {},
        payload: "",
        payloadTruncated: false,
        payloadSize: 0,
        sourceIp,
        gatewayStatus: status,
        gatewayBody,
        auth: "rejected:" + reason,
      });
    } catch (err) {
      logger.error?.("[webhook] failed to write request log:", err.message);
    }
    logger.warn?.("[hooks] refused hook=" + hookName + " reason=" + reason + " status=" + status + " ip=" + (sourceIp || "unknown"));
  };

  const refuse = (status, reason, error, detail, extra = {}) => ({ ok: false, status, reason, error, detail, ...extra });

  const builtinEntry = (hookName) => {
    const policy = readBuiltinsPolicy({ fsModule, openclawDir });
    if (policy.unreadable) return { unreadable: true, entry: null };
    return { unreadable: false, entry: policy.builtins?.[hookName] || null };
  };

  const builtinOffVerdict = (hookName, { unreadable, entry } = builtinEntry(hookName)) => {
    if (unreadable) return refuse(404, "builtin_policy_unreadable", "Not found", "alphaclaw.json is unreadable, so the built-in hooks stay closed");
    if (entry?.enabled === true) return null;
    sendNotice(
      "🔒 AlphaClaw refused a call to OpenClaw's built-in /hooks/" + hookName +
        " because the built-in hooks are off on this box. If you use it, turn it on in " + webhooksUrl() +
        "; it then takes its own token.",
      "hook-ingress-builtin-off-" + hookName + "-" + String(entry?.changedAt || "initial"),
    );
    return refuse(404, "builtin_off", "Not found", "/hooks/" + hookName + " is off on this box");
  };

  const authenticateBuiltin = ({ hookName, presented, credential }) => {
    const current = builtinEntry(hookName);
    const off = builtinOffVerdict(hookName, current);
    if (off) return off;
    const { entry } = current;
    if (!credential.ok) {
      return refuse(503, "credential_unresolved", "Service Unavailable", "AlphaClaw cannot read the gateway's hook credential, so it cannot forward a built-in hook");
    }
    const secrets = readSecrets({ fsModule, rootDir });
    const stored = secrets.unreadable ? null : secrets.secrets.builtins?.[hookName]?.tokenSha256;
    if (presented && ownTokenMatches(presented, stored)) {
      return {
        ok: true,
        auth: "per_hook_token",
        authorization: "Bearer " + credential.value,
        onAdmitted: entry?.firstOwnTokenAt ? null : () => recordFirstOwnToken(hookName),
      };
    }
    if (presented && credentialMatches(presented, credential.value)) {
      const window = builtinSharedWindow(entry, nowMs());
      if (window.open) {
        sendNotice(
          "/hooks/" + hookName + " was called with the shared webhook token. Give the caller this hook's own token from " +
            webhooksUrl() + "; the shared token stops working on it at " + isoAt(window.closesAtMs) + ".",
          "hook-ingress-builtin-shared-" + hookName + "-" + String(entry?.turnedOnAt || ""),
        );
        return { ok: true, auth: "shared_token" };
      }
      sendNotice(
        "AlphaClaw refused a call to /hooks/" + hookName + " with the shared webhook token: its move to its own token has ended. " +
          "Give the caller the hook's own token from " + webhooksUrl() + ", or reopen the shared token there.",
        "hook-ingress-builtin-retired-" + hookName + "-" + String(entry?.turnedOnAt || ""),
      );
      return refuse(401, "shared_token_retired", "Unauthorized", "the shared token no longer works on /hooks/" + hookName);
    }
    return null;
  };

  const authenticateHookDelivery = (req, { hookName, gatewayHeaders, internal = null } = {}) => {
    const credential = resolveCredential();
    if (internal === "oauth_alias") {
      return credential.ok
        ? { ok: true, auth: "oauth_alias", authorization: "Bearer " + credential.value }
        : { ok: true, auth: "oauth_alias" };
    }
    const presented = extractHookToken(gatewayHeaders);
    if (isBuiltinHook(hookName)) {
      const verdict = authenticateBuiltin({ hookName, presented, credential });
      if (verdict) return verdict;
    } else if (!credential.ok) {
      return { ok: true, auth: "unchecked" };
    } else if (presented && credentialMatches(presented, credential.value)) {
      return { ok: true, auth: "shared_token" };
    }
    const failure = takeFailure(req);
    if (failure.limited) {
      return refuse(429, "throttled", "Too Many Requests", "too many failed credentials from this client", {
        retryAfterSeconds: failure.retryAfterSeconds,
      });
    }
    return refuse(401, presented ? "bad_credential" : "no_credential", "Unauthorized",
      presented ? "the credential does not match" : "no credential was sent");
  };

  const recordFirstOwnToken = (hookName) => {
    try {
      updateBuiltinsPolicy({
        fsModule,
        openclawDir,
        mutate: (builtins) => {
          const entry = builtins[hookName];
          if (entry && entry.enabled === true && !entry.firstOwnTokenAt) {
            builtins[hookName] = { ...entry, firstOwnTokenAt: isoAt(nowMs()) };
          }
          return builtins;
        },
      });
    } catch (err) {
      logger.warn?.("[hooks] could not record the first own-token delivery for /hooks/" + hookName + ": " + err.message);
    }
  };

  const sendRefusal = (res, verdict) => {
    if (verdict.retryAfterSeconds) res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
    return res.status(verdict.status).json({ error: verdict.error });
  };

  // Runs before express.raw: a POST with no token, no x-openclaw-token, no
  // ?token= and no signature header is refused before its body is buffered,
  // and a closed built-in answers 404 the same way.
  const preParseGate = (req, res, next) => {
    if (String(req.method || "").toUpperCase() !== "POST") return next();
    const ingress = resolveHookIngress(req.originalUrl || req.url);
    if (!ingress.ok) return next();
    const sourceIp = resolveLoginClientIp(req);
    let verdict = null;
    if (isBuiltinHook(ingress.hookName)) verdict = builtinOffVerdict(ingress.hookName);
    if (!verdict && !hasCredentialHint({ headers: req.headers, url: req.originalUrl || req.url })) {
      verdict = refuse(401, "no_credential", "Unauthorized", "no credential or signature header was sent");
    }
    if (!verdict) return next();
    recordRefusal({
      hookName: ingress.hookName,
      method: req.method,
      headers: sanitizeHeaders(req.headers),
      sourceIp,
      status: verdict.status,
      reason: verdict.reason,
      detail: verdict.detail,
    });
    res.setHeader("Connection", "close");
    return sendRefusal(res, verdict);
  };

  const builtinStatus = () => {
    const policy = readBuiltinsPolicy({ fsModule, openclawDir });
    const secrets = readSecrets({ fsModule, rootDir });
    const now = nowMs();
    const hooks = {};
    for (const name of kBuiltinNames) {
      const entry = policy.builtins?.[name] || null;
      const window = builtinSharedWindow(entry, now);
      hooks[name] = {
        enabled: entry?.enabled === true,
        changedAt: entry?.changedAt || null,
        turnedOnAt: entry?.turnedOnAt || null,
        firstOwnTokenAt: entry?.firstOwnTokenAt || null,
        hasOwnToken: !secrets.unreadable && !!secrets.secrets.builtins?.[name]?.tokenSha256,
        ownTokenCreatedAt: secrets.unreadable ? null : secrets.secrets.builtins?.[name]?.createdAt || null,
        sharedTokenOpen: window.open,
        sharedTokenClosesAt: Number.isFinite(window.closesAtMs) ? isoAt(window.closesAtMs) : null,
      };
    }
    return {
      policyUnreadable: policy.unreadable,
      secretsUnreadable: secrets.unreadable,
      migration: policy.builtins?.migration || null,
      hooks,
    };
  };

  const assertBuiltinName = (name) => {
    if (!isBuiltinHook(name)) throw Object.assign(new Error("Unknown built-in hook"), { status: 404 });
  };

  const setBuiltinEnabled = (name, enabled) => {
    assertBuiltinName(name);
    const at = isoAt(nowMs());
    updateBuiltinsPolicy({
      fsModule,
      openclawDir,
      mutate: (builtins) => {
        const entry = builtins[name] || {};
        if ((entry.enabled === true) === (enabled === true)) return builtins;
        builtins[name] = enabled === true
          ? { enabled: true, changedAt: at, turnedOnAt: at, firstOwnTokenAt: null }
          : { enabled: false, changedAt: at, turnedOnAt: null, firstOwnTokenAt: null };
        return builtins;
      },
    });
    return builtinStatus();
  };

  // A human reopens the shared-token window: a fresh 7-day window from now.
  const reopenBuiltinSharedToken = (name) => {
    assertBuiltinName(name);
    const at = isoAt(nowMs());
    updateBuiltinsPolicy({
      fsModule,
      openclawDir,
      mutate: (builtins) => {
        const entry = builtins[name];
        if (entry?.enabled !== true) {
          throw Object.assign(new Error("Turn the hook on first"), { status: 409 });
        }
        builtins[name] = { ...entry, turnedOnAt: at, firstOwnTokenAt: null };
        return builtins;
      },
    });
    return builtinStatus();
  };

  const mintToken = (name) => {
    assertBuiltinName(name);
    return mintBuiltinToken({ fsModule, rootDir, name, nowIso: isoAt(nowMs()) });
  };

  // Once per box (recorded with a version): a built-in the request log shows
  // the gateway accepting stays on, with the shared-token window; anything
  // else, an empty or pruned log included, is "unknown" and goes off, with
  // every refused call logged and the first one sent to the owner.
  const runBuiltinMigration = () => {
    const policy = readBuiltinsPolicy({ fsModule, openclawDir });
    if (policy.unreadable) {
      logger.warn?.("[hooks] built-in hook migration skipped: alphaclaw.json is unreadable; /hooks/agent and /hooks/wake stay closed");
      return { ran: false, reason: "policy_unreadable" };
    }
    if (Number(policy.builtins?.migration?.version || 0) >= kBuiltinMigrationVersion) {
      return { ran: false, reason: "already_ran" };
    }
    const at = isoAt(nowMs());
    const verdicts = {};
    for (const name of kBuiltinNames) {
      let inUse = false;
      try {
        inUse = hasAcceptedRequest(name) === true;
      } catch {}
      verdicts[name] = inUse ? "in_use" : "unknown";
    }
    try {
      updateBuiltinsPolicy({
        fsModule,
        openclawDir,
        mutate: (builtins) => {
          if (Number(builtins.migration?.version || 0) >= kBuiltinMigrationVersion) return builtins;
          for (const name of kBuiltinNames) {
            if (builtins[name]) continue;
            builtins[name] = verdicts[name] === "in_use"
              ? { enabled: true, changedAt: at, turnedOnAt: at, firstOwnTokenAt: null }
              : { enabled: false, changedAt: at, turnedOnAt: null, firstOwnTokenAt: null };
          }
          builtins.migration = { version: kBuiltinMigrationVersion, at, verdicts };
          return builtins;
        },
      });
    } catch (err) {
      logger.warn?.("[hooks] built-in hook migration failed: " + err.message + "; /hooks/agent and /hooks/wake stay closed");
      return { ran: false, reason: "write_failed" };
    }
    const status = builtinStatus();
    for (const name of kBuiltinNames) {
      if (verdicts[name] !== "in_use" || !status.hooks[name].enabled) continue;
      sendNotice(
        "/hooks/" + name + " has been used on this box, so AlphaClaw kept it on. Create its own token in " + webhooksUrl() +
          " and give it to the caller; the shared webhook token stops working on it at " + status.hooks[name].sharedTokenClosesAt + ".",
        "hook-ingress-builtin-migrated-" + name,
      );
    }
    logger.log?.("[hooks] built-in hooks migrated: agent=" + verdicts.agent + " wake=" + verdicts.wake);
    return { ran: true, verdicts };
  };

  return {
    authenticateHookDelivery,
    builtinStatus,
    mintToken,
    preParseGate,
    recordRefusal,
    reopenBuiltinSharedToken,
    runBuiltinMigration,
    sendRefusal,
    setBuiltinEnabled,
  };
};

module.exports = { createHookIngress, isBuiltinHook };
