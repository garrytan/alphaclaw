const { kMaxWalkEntries } = require("./openclaw-backup-walk");
const { kManifestMaxBytes } = require("./openclaw-backup-offline-copy");
const { isCoreAssetPath } = require("./openclaw-backup-policy");

const assessBackupPreflight = (diagnosis, budget) => {
  const directories = diagnosis?.directories;
  if (diagnosis?.walk !== "complete" || directories?.measurementComplete === false) {
    return { blocked: true, reason: `Backup preflight could not finish: ${diagnosis?.walkError || "the state tree could not be fully measured"}. The gateway has not been paused.` };
  }
  if (directories?.selectedEntries > kMaxWalkEntries) {
    return { blocked: true, reason: `Backup preflight found ${directories.selectedEntries} selected entries (${directories.entries} total), above the ${kMaxWalkEntries}-entry copy budget. Add scratch exclusions or move the largest directories before retrying. The gateway has not been paused.` };
  }
  const byteBudget = Math.floor(budget.defaultCopyBytesPerSec * budget.offlineCopyBudgetMs / 1000);
  if (diagnosis.copySetBytes > byteBudget) {
    return { blocked: true, reason: `Backup preflight found ${diagnosis.copySetBytes} bytes to copy, above the ${byteBudget}-byte budget for this pause. Review the largest directories and backup exclusions. The gateway has not been paused.` };
  }
  if (diagnosis.minimumManifestBytes > kManifestMaxBytes) {
    return { blocked: true, reason: `Backup preflight found at least ${diagnosis.minimumManifestBytes} bytes of file inventory, above the ${kManifestMaxBytes}-byte manifest budget. Exclude scratch files or reduce the selected file count. The gateway has not been paused.` };
  }
  return { blocked: false, reason: null };
};

// Where an absolute-target symlink matters to the UPSTREAM rung. Upstream's
// `backup create` archives its asset roots by path and FOLLOWS a symlink that
// sits at one of them (probed 2026-09-22 against 2026.9.5: `credentials` and
// `identity` replaced by links to an outside directory → the archive carried
// the links AND the outside files), so a link there can smuggle foreign
// content — or a whole /etc — into a backup and must veto. Everywhere else
// upstream neither follows nor archives links: OpenClaw itself plants
// `plugin-skills/<skill>` → its own `dist/extensions/…` in EVERY state dir
// (2026.9.3 and 2026.9.5), and a 2026.9.5 archive of such a tree carries no
// plugin-skills entry. v0.9.87 vetoed on ANY absolute link, which ruled the
// upstream rung out on every real install (the live tier caught it the day it
// shipped): the no-quiesce ladder had no rung left and the paused ladder lost
// its fallback. Roots: the config file and every core asset
// (isCoreAssetPath), the whole agent root (upstream archives
// `agents/<id>` — sessions too) and the workspace.
const kUpstreamArchivedRootPattern = /^(agents(\/.*)?|workspace(\/.*)?)$/;
const isUpstreamArchivedPath = (relPath) =>
  typeof relPath === "string" &&
  (isCoreAssetPath(relPath) || kUpstreamArchivedRootPattern.test(relPath));

const upstreamBackupVeto = (diagnosis, offlineCopy, budget) => {
  if (["enumerate", "budget"].includes(offlineCopy?.stage)) return "offline_copy_budget";
  if (diagnosis?.walk !== "complete" || diagnosis?.directories?.measurementComplete === false) return "preflight_incomplete";
  if (diagnosis?.directories?.envFiles?.length) return "env_files_excluded";
  if (diagnosis?.directories?.absoluteSymlinks?.some((link) => isUpstreamArchivedPath(link?.path))) {
    return "absolute_symlinks";
  }
  if (diagnosis?.directories?.entries > kMaxWalkEntries) return "upstream_entry_budget";
  if (diagnosis?.tarSetBytes > budget.upstreamMaxBytes) return "upstream_byte_budget";
  return null;
};

module.exports = { assessBackupPreflight, upstreamBackupVeto, isUpstreamArchivedPath };
