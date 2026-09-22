const { kMaxWalkEntries } = require("./openclaw-backup-walk");
const { kManifestMaxBytes } = require("./openclaw-backup-offline-copy");

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

const upstreamBackupVeto = (diagnosis, offlineCopy, budget) => {
  if (["enumerate", "budget"].includes(offlineCopy?.stage)) return "offline_copy_budget";
  if (diagnosis?.walk !== "complete" || diagnosis?.directories?.measurementComplete === false) return "preflight_incomplete";
  if (diagnosis?.directories?.envFiles?.length) return "env_files_excluded";
  // Absolute-target symlinks are REPORTED (Upgrade → Check backup sources) but
  // never veto the upstream rung: OpenClaw itself plants them in every state
  // dir (`plugin-skills/<skill>` → the package's `dist/extensions/…/skills`,
  // observed on 2026.9.3 and 2026.9.5), and its `backup create` neither
  // follows nor archives them (a 2026.9.5 archive of such a tree carries no
  // plugin-skills entry and nothing under dist/extensions — verified
  // 2026-09-22). A veto here ruled the upstream rung out on every real
  // install, which the live tier caught the day it shipped (v0.9.87): the
  // no-quiesce ladder has no other rung, and the paused ladder lost its
  // fallback. Secrets reachable through links are the `.env` rule's job.
  if (diagnosis?.directories?.entries > kMaxWalkEntries) return "upstream_entry_budget";
  if (diagnosis?.tarSetBytes > budget.upstreamMaxBytes) return "upstream_byte_budget";
  return null;
};

module.exports = { assessBackupPreflight, upstreamBackupVeto };
