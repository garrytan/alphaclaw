// The boot's native maintenance (Codex migration, then Codex plugin
// reconciliation) runs once per OpenClaw build and per version of the
// scripts, not on every boot (ALPH-44). On a small box the two helpers cost
// tens of seconds of downtime per restart, and a same-version restart with an
// already-migrated state had nothing for them to do.
//
// The stamp (<managedDir>/codex-maintenance.json) records what the last
// successful run saw. The next boot skips only when every input still
// matches; anything it cannot read counts as changed, so a doubt runs the
// migration. The inputs:
//   - the executing OpenClaw build (dist/build-info.json buildId, else the
//     package version): a pin change runs it;
//   - a hash of the maintenance sources themselves: a new migration runs it;
//   - a hash of openclaw.json as the run left it: any later config write
//     (Connect Codex, a restore, a hand edit) runs it;
//   - the auth profile ids, providers and types of every agent store, never
//     their credentials: a new or renamed profile runs it;
//   - any legacy JSON auth store (auth-profiles.json, auth.json) under an
//     agent, by name, size and mtime: one that appears or changes runs it;
//   - the installed Codex plugin packages (name and version): a plugin
//     installed or replaced since runs the reconciliation.
// Session stores are not fingerprinted: their routes come from the config
// and the build, both covered above. The config hash is taken right after the
// helpers, so the boot steps that follow (exec defaults, Control UI proxy,
// hooks) can change it once on a fresh install; that boot's next restart runs
// the helpers one more time and records the converged file.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./utils/safe-file");
const { isNonArrayObject } = require("./utils/object");
const { isValidAgentId } = require("./agents/shared");

const kCodexMaintenanceStampFileName = "codex-maintenance.json";
const kCodexMaintenanceStampSchema = "alphaclaw.codex-maintenance.v1";
const kLegacyAuthFileNames = ["auth-profiles.json", "auth.json"];
const kMaintenanceSources = [
  path.join(__dirname, "..", "scripts", "migrate-openclaw-codex.js"),
  path.join(__dirname, "..", "scripts", "reconcile-codex-plugin.js"),
  path.join(__dirname, "openclaw-codex-migration.js"),
  path.join(__dirname, "openclaw-codex-migration-runtime.js"),
  __filename,
];

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const readDirNames = (dir, fsModule) => {
  try {
    return fsModule.readdirSync(dir).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
};

const readOpenclawBuildId = ({ packageDir, fsModule = fs }) => {
  if (!packageDir) return null;
  for (const [file, key] of [[path.join(packageDir, "dist", "build-info.json"), "buildId"], [path.join(packageDir, "package.json"), "version"]]) {
    try {
      const value = JSON.parse(fsModule.readFileSync(file, "utf8"))?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    } catch {}
  }
  return null;
};

// Profile ids, providers and types only: the fingerprint must change when a
// profile is added or renamed, and must not change when a token refreshes.
const describeAuthProfiles = (store) =>
  Object.entries(isNonArrayObject(store?.profiles) ? store.profiles : {})
    .map(([id, profile]) => `${id}|${profile?.provider || ""}|${profile?.type || profile?.mode || ""}`)
    .sort();

const readAgentIds = ({ stateDir, fsModule }) =>
  readDirNames(path.join(stateDir, "agents"), fsModule).filter(isValidAgentId);

const describeLegacyAuthFiles = ({ stateDir, agentIds, fsModule }) =>
  agentIds.flatMap((agentId) => kLegacyAuthFileNames.flatMap((name) => {
    try {
      const stat = fsModule.statSync(path.join(stateDir, "agents", agentId, "agent", name));
      return [`${agentId}/${name}|${stat.size}|${Math.round(stat.mtimeMs)}`];
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }));

// OpenClaw installs a global plugin as an npm project under the state dir
// (2026.10: npm/projects/openclaw-codex-<hash>); older builds used
// extensions/<id>. Either layout, a Codex package's version is the input.
const describeCodexPluginInstalls = ({ stateDir, fsModule }) => {
  const installs = [];
  const npmProjects = path.join(stateDir, "npm", "projects");
  for (const name of readDirNames(npmProjects, fsModule).filter((entry) => entry.includes("codex"))) {
    installs.push(`npm/${name}@${readPackageVersion(path.join(npmProjects, name, "node_modules", "@openclaw", "codex"), fsModule)}`);
  }
  const extensions = path.join(stateDir, "extensions");
  for (const name of readDirNames(extensions, fsModule).filter((entry) => entry.includes("codex"))) {
    installs.push(`extensions/${name}@${readPackageVersion(path.join(extensions, name), fsModule)}`);
  }
  return installs;
};

const readPackageVersion = (dir, fsModule) => {
  try {
    return String(JSON.parse(fsModule.readFileSync(path.join(dir, "package.json"), "utf8")).version || "unknown");
  } catch {
    return "missing";
  }
};

// → the inputs, or null when something could not be read (the caller then
// runs the maintenance).
const collectCodexMaintenanceInputs = ({
  configPath,
  stateDir,
  packageDir,
  loadAuthStore,
  fsModule = fs,
}) => {
  try {
    const buildId = readOpenclawBuildId({ packageDir, fsModule });
    if (!buildId || !loadAuthStore) return null;
    const agentIds = readAgentIds({ stateDir, fsModule });
    const authProfiles = [];
    for (const agentId of agentIds) {
      const store = loadAuthStore(agentId);
      if (store?.unavailable) return null;
      authProfiles.push(...describeAuthProfiles(store).map((entry) => `${agentId}:${entry}`));
    }
    return {
      openclawBuild: buildId,
      scripts: sha256(kMaintenanceSources.map((file) => fsModule.readFileSync(file)).join("\0")),
      config: sha256(fsModule.readFileSync(configPath)),
      authProfiles: sha256(authProfiles.join("\n")),
      legacyAuthFiles: sha256(describeLegacyAuthFiles({ stateDir, agentIds, fsModule }).join("\n")),
      codexPlugin: sha256(describeCodexPluginInstalls({ stateDir, fsModule }).join("\n")),
    };
  } catch {
    return null;
  }
};

const stampPath = (managedDir) => path.join(managedDir, kCodexMaintenanceStampFileName);

const readCodexMaintenanceStamp = ({ managedDir, fsModule = fs }) => {
  try {
    const parsed = JSON.parse(fsModule.readFileSync(stampPath(managedDir), "utf8"));
    if (parsed?.schema !== kCodexMaintenanceStampSchema || !isNonArrayObject(parsed.inputs)) return null;
    return parsed;
  } catch {
    return null;
  }
};

const kInputReasons = {
  openclawBuild: "OpenClaw build changed",
  scripts: "maintenance scripts changed",
  config: "openclaw.json changed",
  authProfiles: "auth profiles changed",
  legacyAuthFiles: "legacy auth store changed",
  codexPlugin: "Codex plugin install changed",
};

// → null when the stamp covers the current inputs, else why it must run.
const decideCodexMaintenance = ({ stamp, inputs }) => {
  if (!inputs) return "inputs unreadable";
  if (!stamp) return "no record of a completed run";
  for (const [key, reason] of Object.entries(kInputReasons)) {
    if (stamp.inputs[key] !== inputs[key]) return reason;
  }
  return null;
};

const writeCodexMaintenanceStamp = ({ managedDir, inputs, completedAt = Date.now(), fsModule = fs, logger = console }) => {
  try {
    writeFileAtomic(
      stampPath(managedDir),
      `${JSON.stringify({ schema: kCodexMaintenanceStampSchema, completedAt: new Date(completedAt).toISOString(), inputs }, null, 2)}\n`,
      { fsModule },
    );
    return true;
  } catch (error) {
    logger.warn?.(`[alphaclaw] could not record the Codex maintenance run (${error?.code || "write failed"})`);
    return false;
  }
};

const clearCodexMaintenanceStamp = ({ managedDir, fsModule = fs }) => {
  try {
    fsModule.rmSync(stampPath(managedDir), { force: true });
  } catch {}
};

module.exports = {
  kCodexMaintenanceStampFileName,
  kCodexMaintenanceStampSchema,
  collectCodexMaintenanceInputs,
  readCodexMaintenanceStamp,
  decideCodexMaintenance,
  writeCodexMaintenanceStamp,
  clearCodexMaintenanceStamp,
};
