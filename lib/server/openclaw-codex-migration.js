const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./utils/safe-file");
const { OpenclawConfigReadError } = require("./openclaw-config");
const { isDeepStrictEqual } = require("node:util");
const { DatabaseSync } = require("node:sqlite");
const { resolveCodexMigrationBuild, loadOpenclawMigrationApi } = require("./openclaw-codex-migration-runtime");

// A second boot has an agents.entries shell even when no model was selected.
// Upstream Doctor treats that shell's implicit default as a Codex route and
// repairs a restrictive plugin allowlist by enabling the external plugin.
// That is a new plugin activation, not a legacy state migration: without an
// installed, consented plugin it turns a healthy recorded build into a loop.
// Compare structured config changes, never upstream's human-readable messages.
const withoutCodexPluginActivation = (cfg) => {
  const copy = structuredClone(cfg);
  const plugins = copy.plugins;
  if (!plugins || typeof plugins !== "object") return copy;
  if (plugins.entries && typeof plugins.entries === "object") {
    const codex = plugins.entries.codex;
    if (codex && typeof codex === "object" && !Array.isArray(codex)) {
      delete codex.enabled;
      if (Object.keys(codex).length === 0) delete plugins.entries.codex;
    }
    if (Object.keys(plugins.entries).length === 0) delete plugins.entries;
  }
  if (Array.isArray(plugins.allow)) {
    plugins.allow = plugins.allow.filter((id) => id !== "codex");
    if (plugins.allow.length === 0) delete plugins.allow;
  }
  if (Object.keys(plugins).length === 0) delete copy.plugins;
  return copy;
};

const writeConfig = (configPath, cfg) => {
  // Atomic (fix wave F051): this runs from bin/alphaclaw.js at boot; a torn
  // openclaw.json here is a gateway that cannot start.
  writeFileAtomic(configPath, `${JSON.stringify(cfg, null, 2)}\n`, { fsModule: fs });
};

// Raw parse on purpose (the migration hands the object to OpenClaw's own
// repair API and writes it back unchanged in shape), but fail CLOSED with the
// shared refusal message instead of a bare SyntaxError from the script.
const readConfigForMigration = (configPath) => {
  const raw = fs.readFileSync(configPath, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config root is not an object");
    }
    return parsed;
  } catch (error) {
    throw new OpenclawConfigReadError(
      `Refusing to migrate ${configPath}: existing file is not JSON alphaclaw can parse ` +
        `(openclaw allows JSON5/env includes). Fix or migrate the file manually. (${error.message})`,
      { configPath, cause: error },
    );
  }
};

const hasCanonicalCodexOauthProfile = (configPath) => {
  const databasePath = path.join(
    path.dirname(configPath),
    "agents",
    "main",
    "agent",
    "openclaw-agent.sqlite",
  );
  if (!fs.existsSync(databasePath)) return false;
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const row = database
      .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?")
      .get("primary");
    const store = row?.store_json ? JSON.parse(row.store_json) : {};
    return Object.values(store.profiles || {}).some(
      (profile) =>
        profile?.type === "oauth" &&
        profile?.provider === "openai" &&
        profile?.access &&
        profile?.refresh,
    );
  } catch {
    return false;
  } finally {
    database?.close();
  }
};

const restoreCanonicalCodexRuntimeModels = ({ configPath, cfg }) => {
  if (!hasCanonicalCodexOauthProfile(configPath)) return false;
  const configuredModels = cfg?.agents?.defaults?.models;
  if (!configuredModels || typeof configuredModels !== "object") return false;
  let changed = false;
  for (const [modelKey, modelConfig] of Object.entries(configuredModels)) {
    if (!modelKey.startsWith("openai/gpt-")) continue;
    if (modelConfig?.agentRuntime?.id === "codex") continue;
    configuredModels[modelKey] = {
      ...(modelConfig && typeof modelConfig === "object" ? modelConfig : {}),
      agentRuntime: { id: "codex" },
    };
    changed = true;
  }
  return changed;
};

const migrateLegacyCodexState = async ({
  configPath = process.env.OPENCLAW_CONFIG_PATH,
  env = process.env,
} = {}) => {
  if (!configPath || !fs.existsSync(configPath)) {
    return { changed: false, changes: [], warnings: [] };
  }

  const cfg = readConfigForMigration(configPath);
  const build = resolveCodexMigrationBuild({ configPath, env });
  const routeApi = await loadOpenclawMigrationApi({
    build,
    prefix: "codex-route-warnings",
    functionNames: [
      "maybeRepairCodexRoutes",
      "maybeRepairCodexSessionRoutes",
    ],
  });
  const authApi = await loadOpenclawMigrationApi({
    build,
    prefix: "doctor-auth-flat-profiles",
    functionNames: [
      "collectOpenAICodexAuthProfileStoreIdMap",
      "maybeRepairOpenAICodexAuthConfig",
      "maybeMigrateAuthProfileJsonStoresToSqlite",
    ],
    // Retired upstream in 2026.9 (absent from doctor-auth-flat-profiles-*.js):
    // it rewrote a legacy flat auth-profiles.json store's provider to "openai"
    // in place. The JSON store no longer survives the run at all — the SQLite
    // migration below moves and renames those profiles — so on a pin that
    // still ships it the step is a no-op preface, and on 2026.9+ its absence
    // reaches the same end state.
    optionalFunctionNames: ["maybeRepairOpenAICodexAuthProfileStores"],
  });

  const changes = [];
  const warnings = [];
  const routeRepair = routeApi.maybeRepairCodexRoutes({
    cfg,
    env,
    shouldRepair: true,
  });
  const pluginActivationOnly = routeRepair.changes.length > 0 && isDeepStrictEqual(
    withoutCodexPluginActivation(cfg),
    withoutCodexPluginActivation(routeRepair.cfg),
  );
  let nextCfg = pluginActivationOnly ? cfg : routeRepair.cfg;
  if (!pluginActivationOnly) changes.push(...routeRepair.changes);
  warnings.push(...routeRepair.warnings);

  const profileIdMap = authApi.collectOpenAICodexAuthProfileStoreIdMap({
    cfg: nextCfg,
    env,
  });
  const configAuthRepair = authApi.maybeRepairOpenAICodexAuthConfig(nextCfg, {
    profileIdMap,
  });
  nextCfg = configAuthRepair.config;
  changes.push(...configAuthRepair.changes);
  warnings.push(...configAuthRepair.warnings);

  if (changes.length > 0) writeConfig(configPath, nextCfg);

  if (typeof authApi.maybeRepairOpenAICodexAuthProfileStores === "function") {
    const storeRepair = await authApi.maybeRepairOpenAICodexAuthProfileStores({
      cfg: nextCfg,
      env,
    });
    changes.push(...storeRepair.changes);
    warnings.push(...storeRepair.warnings);
  }

  const sqliteMigration = await authApi.maybeMigrateAuthProfileJsonStoresToSqlite({
    cfg: nextCfg,
    env,
    prompter: { confirmAutoFix: async () => true },
  });
  changes.push(...sqliteMigration.changes);
  warnings.push(...sqliteMigration.warnings);
  if (sqliteMigration.configChanged) writeConfig(configPath, nextCfg);

  if (restoreCanonicalCodexRuntimeModels({ configPath, cfg: nextCfg })) {
    changes.push("Restored Codex runtime metadata for canonical OpenAI models.");
    writeConfig(configPath, nextCfg);
  }

  const sessionRepair = await routeApi.maybeRepairCodexSessionRoutes({
    cfg: nextCfg,
    env,
    shouldRepair: true,
  });
  changes.push(...sessionRepair.changes);
  warnings.push(...sessionRepair.warnings);

  return {
    changed: changes.length > 0,
    changes,
    warnings,
  };
};

module.exports = { migrateLegacyCodexState };
