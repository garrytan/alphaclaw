const { wrapAsync } = require("../utils/wrap-async");
const { timingSafeStringEqual } = require("../utils/timing-safe");
const { kDeploymentOnlyEnvKeys, getDeploymentEnvBaseline: readDeploymentEnvBaseline } = require("../deployment-only-env");
const { getBoxLock, sendIfBoxLocked, requestBoxLockWaitMs } = require("../box-lock");
const {
  kReservedUserEnvVarKeys,
  isManagedChannelTokenKey,
  isReservedUserEnvVar,
  isVisibleInEnvars,
} = require("../utils/env-keys");

const kEnvSavedWithoutRestartNote =
  "Saved. The gateway does not receive the changed variables, so the change takes effect without a restart.";

const kEnvKeyPattern = /^[A-Za-z0-9_]+$/;

// The write path String()-coerces, strips line breaks and trims keys, so a
// non-string key or one with interior whitespace/control characters could
// canonicalize into a different (protected) key the agent tier resolver never
// saw. Grammar is [A-Za-z0-9_], the UI's own key normalizer's output.
const isMalformedEnvKey = (key) => {
  if (key === undefined || key === null || key === "") return false;
  if (typeof key !== "string") return true;
  const trimmed = key.trim();
  return trimmed !== "" && !kEnvKeyPattern.test(trimmed);
};

const describeMalformedKey = (key) =>
  `Invalid environment variable name: ${JSON.stringify(String(key).slice(0, 64))}`;

const describeReservedKey = (key) =>
  kDeploymentOnlyEnvKeys.includes(key)
    ? `${key} is deployment-only and was not saved. Set it in the deployment environment, not Envars or .env.`
    : `${key} is reserved and was not saved.`;

const toValueMap = (vars) => new Map((vars || []).map(({ key, value }) => [key, String(value ?? "")]));

const listChangedKeys = (before, after) => {
  const changed = [];
  for (const [key, value] of after) {
    if (!before.has(key) || before.get(key) !== value) changed.push(key);
  }
  for (const key of before.keys()) {
    if (!after.has(key)) changed.push(key);
  }
  return changed.sort();
};

const registerEnvRoutes = ({
  app,
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  kKnownVars,
  kKnownKeys,
  syncChannelConfig,
  isOnboarded,
  restartRequiredState,
  gatewayLifecycleLock = null,
  gatewayLaunchEnv = null,
  doSyncPromptFiles = null,
  syncApiKeyAuthProfiles = () => {},
  // Writes the models.providers blocks of AlphaClaw's provider presets whose
  // env var is now set (providers/ensure.js); never throws.
  ensureOwnedProviders = () => ({ ok: true }),
  invalidateStatusCaches = () => {},
  // ({ keys, envFileValues, gatewayEnv }) → findStaleEnvProcesses result.
  // Absent (tests, non-Linux wiring): saves carry no staleProcesses field and
  // the read route answers available:false.
  scanStaleEnvProcesses = null,
  // The deployment environment recorded at boot (key presence only is read
  // here; values never leave the process).
  getDeploymentEnvBaseline = readDeploymentEnvBaseline,
}) => {
  const hiddenKnownVarKeys = new Set(
    kKnownVars
      .filter((def) => !isReservedUserEnvVar(def.key) && !isVisibleInEnvars(def))
      .map((def) => def.key),
  );
  // Sorted key=value pairs of the gateway's launch env, compared within one
  // save and never logged or returned. null when unavailable: the save then
  // counts as a gateway change.
  const readGatewayEnvSignature = () => {
    if (typeof gatewayLaunchEnv !== "function") return null;
    try {
      return JSON.stringify(Object.entries(gatewayLaunchEnv() || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    } catch {
      return null;
    }
  };
  const isEnvRestartPending = () =>
    isOnboarded() && restartRequiredState?.hasReason?.("env_vars_changed") === true;

  const scanStale = (keys, envVars) => {
    if (typeof scanStaleEnvProcesses !== "function" || !keys.length) return null;
    try {
      let gatewayEnv = null;
      try {
        gatewayEnv = typeof gatewayLaunchEnv === "function" ? gatewayLaunchEnv() : null;
      } catch {}
      return scanStaleEnvProcesses({ keys, envFileValues: toValueMap(envVars), gatewayEnv });
    } catch (error) {
      console.warn(`[alphaclaw] stale env process scan failed: ${error.message}`);
      return { available: false, reason: "scan_failed" };
    }
  };

  // One write path for PUT and PATCH. The save is a multi-step
  // read-modify-write of openclaw.json (channels remove -> env file write ->
  // channels add), serialized against concurrent saves, boot and restarts by
  // the lifecycle lock; the caller holds it.
  const applyEnvWrite = async (req, nextEnvVars, box) => {
    // The operator box lock (box-lock.js), taken after the lifecycle lock
    // like every restart: the save waits up to the configured time for
    // another operator, or answers 409 box_locked (?boxLockWait=0: at once).
    const boxLock = getBoxLock();
    if (boxLock.enabled) {
      box.hold = await boxLock.acquire({ step: "envars-write", by: "api:env", waitMs: requestBoxLockWaitMs(req) });
    }
    const envBefore = toValueMap(readEnvFile());
    await syncChannelConfig(nextEnvVars, "remove");
    const gatewayEnvBefore = readGatewayEnvSignature();
    writeEnvFile(nextEnvVars);
    const changed = reloadEnv();
    // A key AlphaClaw keeps to itself (ALPHACLAW_GIT_SYNC, any key the
    // gateway env filter strips) changes nothing a restart would apply.
    // The signature holds secret values, so it is compared in constant time;
    // an unreadable side (null) never matches.
    const gatewayEnvChanged =
      changed && !timingSafeStringEqual(readGatewayEnvSignature(), gatewayEnvBefore);
    // The auth-profile sync can fail closed (shared state db busy). The env
    // file IS already written at this point; aborting would 500 with
    // half-applied state. Degrade to a response warning instead.
    let authSyncWarning = null;
    try {
      syncApiKeyAuthProfiles(nextEnvVars);
    } catch (err) {
      authSyncWarning = `Env saved, but syncing API-key auth profiles failed (${err.message}) — retry the save shortly`;
      console.warn(`[alphaclaw] ${authSyncWarning}`);
    }
    const providerWarning = ensureOwnedProviders()?.warning || null;
    if (gatewayEnvChanged && isOnboarded()) {
      restartRequiredState.markRequired?.("env_vars_changed");
    }
    const restartRequired = isEnvRestartPending();
    console.log(
      `[alphaclaw] Env vars saved (${nextEnvVars.length} vars, changed=${changed})`,
    );
    await syncChannelConfig(nextEnvVars, "add");
    // After the channel re-add: the prompt reads channel config from
    // openclaw.json. Prompt settings such as ALPHACLAW_GIT_WRITER_COMMAND
    // reach the agent's next session without an AlphaClaw restart.
    if (changed && isOnboarded()) {
      try {
        doSyncPromptFiles?.();
      } catch (err) {
        console.warn(`[alphaclaw] Env saved, but rewriting the bootstrap prompt failed: ${err.message}`);
      }
    }
    // Channel state just changed — the next status poll must see it, not a
    // <=5s-stale SWR value.
    invalidateStatusCaches();
    const envAfter = readEnvFile();
    const staleProcesses = changed ? scanStale(listChangedKeys(envBefore, toValueMap(envAfter)), envAfter) : null;
    return {
      ok: true,
      changed,
      ...(changed ? { gatewayEnvChanged } : {}),
      restartRequired,
      ...(changed && !gatewayEnvChanged ? { note: kEnvSavedWithoutRestartNote } : {}),
      ...(authSyncWarning || providerWarning ? { warning: [authSyncWarning, providerWarning].filter(Boolean).join(" ") } : {}),
      ...(staleProcesses ? { staleProcesses } : {}),
    };
  };

  const withEnvLock = async (res, work) => {
    let release = null;
    const box = { hold: null };
    try {
      if (gatewayLifecycleLock) release = await gatewayLifecycleLock.acquire("env_sync");
      return await work(box);
    } catch (err) {
      if (sendIfBoxLocked(res, err)) return undefined;
      // Express 4 does not forward async rejections; an fs failure in
      // writeEnvFile (ENOSPC/EACCES) must become a 500, not a process crash.
      res.status(500).json({ ok: false, error: err.message });
      return undefined;
    } finally {
      box.hold?.release(res.statusCode < 400 ? 0 : 1);
      release?.();
    }
  };

  app.get("/api/env", (req, res) => {
    const fileVars = readEnvFile();
    const merged = [];

    for (const def of kKnownVars) {
      if (isReservedUserEnvVar(def.key)) continue;
      if (!isVisibleInEnvars(def)) continue;
      const fileEntry = fileVars.find((v) => v.key === def.key);
      const value = fileEntry?.value || "";
      // A key the deployment platform sets stays live when its .env line is
      // cleared (a reload falls back to it, as a boot does), so it must not
      // read as unset. Its value is never sent.
      const fromDeployment = !value && !!getDeploymentEnvBaseline()?.[def.key];
      merged.push({
        key: def.key,
        value,
        label: def.label,
        group: def.group,
        hint: def.hint,
        features: def.features,
        source: value ? "env_file" : fromDeployment ? "deployment" : "unset",
        editable: true,
      });
    }

    for (const v of fileVars) {
      if (
        kKnownKeys.has(v.key) ||
        isReservedUserEnvVar(v.key) ||
        isManagedChannelTokenKey(v.key)
      ) {
        continue;
      }
      merged.push({
        key: v.key,
        value: v.value,
        label: v.key,
        group: "custom",
        hint: "",
        source: "env_file",
        editable: true,
      });
    }

    res.json({
      vars: merged,
      reservedKeys: kReservedUserEnvVarKeys,
      restartRequired: isEnvRestartPending(),
    });
  });

  // Full replacement of the editable set. Reserved keys in the body are
  // skipped with a per-key warning; the rest of the write goes through. A
  // body whose every key is reserved writes nothing (it would otherwise read
  // as "delete every editable key").
  app.put("/api/env", wrapAsync(async (req, res) => {
    const { vars } = req.body || {};
    if (!Array.isArray(vars)) {
      return res.status(400).json({ ok: false, error: "Missing vars array" });
    }
    const malformed = vars.find((v) => v && isMalformedEnvKey(v.key));
    if (malformed) {
      return res.status(400).json({ ok: false, error: describeMalformedKey(malformed.key) });
    }
    return withEnvLock(res, async (box) => {
      const submittedKeys = vars.map((v) => String(v?.key || "").trim()).filter(Boolean);
      const skippedKeys = Array.from(new Set(submittedKeys.filter((key) => isReservedUserEnvVar(key))));
      const skipped = skippedKeys.map((key) => ({ key, warning: describeReservedKey(key) }));
      if (skipped.length) {
        console.warn(`[alphaclaw] Env save skipped reserved keys: ${skippedKeys.join(", ")}`);
      }
      if (submittedKeys.length && submittedKeys.every((key) => isReservedUserEnvVar(key))) {
        return res.json({ ok: true, changed: false, restartRequired: isEnvRestartPending(), skipped });
      }
      const currentVars = readEnvFile();
      const nextEnvVars = [
        ...vars.filter((v) => !isReservedUserEnvVar(v.key) && !isManagedChannelTokenKey(v.key)),
        ...currentVars.filter((v) => hiddenKnownVarKeys.has(v.key)),
        ...currentVars.filter((v) => isManagedChannelTokenKey(v.key)),
        ...currentVars.filter((v) => isReservedUserEnvVar(v.key)),
      ];
      const body = await applyEnvWrite(req, nextEnvVars, box);
      return res.json({ ...body, ...(skipped.length ? { skipped } : {}) });
    });
  }));

  // One key: {"key":"K","value":"v"} sets it, {"key":"K","delete":true}
  // removes it. Every other key in .env is left as it is.
  app.patch("/api/env", wrapAsync(async (req, res) => {
    const { key: rawKey, value, delete: deleteKey } = req.body || {};
    if (typeof rawKey !== "string" || !rawKey.trim()) {
      return res.status(400).json({ ok: false, error: "Missing key" });
    }
    if (isMalformedEnvKey(rawKey)) {
      return res.status(400).json({ ok: false, error: describeMalformedKey(rawKey) });
    }
    const isDelete = deleteKey === true;
    if (isDelete === (value !== undefined)) {
      return res.status(400).json({
        ok: false,
        error: 'Send either "value" (a string) to set the key or "delete": true to remove it',
      });
    }
    if (!isDelete && typeof value !== "string") {
      return res.status(400).json({ ok: false, error: '"value" must be a string' });
    }
    const key = rawKey.trim();
    if (isReservedUserEnvVar(key)) {
      return res.status(400).json({ ok: false, error: describeReservedKey(key) });
    }
    if (isManagedChannelTokenKey(key)) {
      return res.status(400).json({ ok: false, error: `${key} is managed from Channels and was not saved.` });
    }
    if (hiddenKnownVarKeys.has(key)) {
      return res.status(400).json({ ok: false, error: `${key} is managed by AlphaClaw and was not saved.` });
    }
    return withEnvLock(res, async (box) => {
      const currentVars = readEnvFile();
      if (isDelete && !currentVars.some((entry) => entry.key === key)) {
        return res.json({ ok: true, changed: false, restartRequired: isEnvRestartPending() });
      }
      const nextEnvVars = currentVars.filter((entry) => entry.key !== key);
      if (!isDelete) nextEnvVars.push({ key, value });
      return res.json(await applyEnvWrite(req, nextEnvVars, box));
    });
  }));

  // Which running processes (this server's uid) hold a value for an .env key
  // that differs from the file: key names, pids and command names only.
  app.get("/api/env/stale-processes", (req, res) => {
    const requested = String(req.query?.keys || "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean);
    const invalid = requested.find((key) => !kEnvKeyPattern.test(key));
    if (invalid) {
      return res.status(400).json({ ok: false, error: describeMalformedKey(invalid) });
    }
    const envVars = readEnvFile();
    const keys = requested.length ? Array.from(new Set(requested)) : envVars.map((entry) => entry.key);
    const result = scanStale(keys, envVars) || { available: false, reason: "unsupported" };
    return res.json({ ok: true, ...result });
  });

  return { isEnvRestartPending };
};

module.exports = {
  registerEnvRoutes,
  kEnvSavedWithoutRestartNote,
};
