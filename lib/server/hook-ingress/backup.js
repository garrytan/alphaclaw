const fs = require("fs");
const path = require("path");
const { readAlphaclawConfigForWrite } = require("../alphaclaw-config");
const { hookIngressSecretsPath } = require("./policy");

// Hook ingress in "Back up now" (GST-2134 PR 2): beside each verified OpenClaw
// archive, a <stamp>-hook-ingress-backup directory (0700) holding the sender
// verification policy (alphaclaw.json hooksIngress) and the secrets file
// (0600) as one unit, with a manifest written last. Restoring one without the
// other refuses the signed hooks instead of reopening them to the shared
// token. copy-retention.js sweeps these with the archives' keep/days policy,
// and only directories carrying this manifest's marker.
const kHookIngressBackupSuffix = "-hook-ingress-backup";
const kHookIngressBackupMarker = "alphaclaw-hook-ingress-backup-v1";
const kHookIngressBackupNamePattern = /^\d{4}-\d{2}-\d{2}T[0-9.+\-Z]+-hook-ingress-backup$/;

const stampFromArchive = (archivePath, nowMs) => {
  const match = path.basename(String(archivePath || "")).match(/^(\d{4}-\d{2}-\d{2}T[0-9.+\-Z]+)-openclaw-backup\.tar\.gz$/);
  return match ? match[1] : new Date(nowMs).toISOString().replace(/:/g, "-");
};

const backupHookIngress = ({ rootDir, openclawDir, backupsDir, archivePath = null, now = Date.now, fsModule = fs }) => {
  let hooksIngress;
  try {
    hooksIngress = readAlphaclawConfigForWrite({ fsModule, openclawDir })?.hooksIngress || null;
  } catch (error) {
    return { ok: false, error: "alphaclaw.json is unreadable: " + String(error?.message || error) };
  }
  const secretsFile = hookIngressSecretsPath(rootDir);
  const hasSecrets = fsModule.existsSync(secretsFile);
  if (!hooksIngress && !hasSecrets) return { ok: true, skipped: "nothing_configured" };
  const dir = path.join(backupsDir, stampFromArchive(archivePath, now()) + kHookIngressBackupSuffix);
  const partial = dir + ".partial";
  try {
    for (const name of fsModule.existsSync(backupsDir) ? fsModule.readdirSync(backupsDir) : []) {
      if (name.endsWith(".partial") && kHookIngressBackupNamePattern.test(name.slice(0, -".partial".length))) {
        fsModule.rmSync(path.join(backupsDir, name), { recursive: true, force: true });
      }
    }
    fsModule.mkdirSync(partial, { recursive: true, mode: 0o700 });
    const files = {};
    fsModule.writeFileSync(path.join(partial, "policy.json"), JSON.stringify({ hooksIngress }, null, 2) + "\n", { mode: 0o600 });
    files["policy.json"] = fsModule.statSync(path.join(partial, "policy.json")).size;
    if (hasSecrets) {
      fsModule.copyFileSync(secretsFile, path.join(partial, "secrets.json"));
      fsModule.chmodSync(path.join(partial, "secrets.json"), 0o600);
      files["secrets.json"] = fsModule.statSync(path.join(partial, "secrets.json")).size;
    }
    fsModule.writeFileSync(
      path.join(partial, "manifest.json"),
      JSON.stringify({ marker: kHookIngressBackupMarker, createdAt: new Date(now()).toISOString(), archivePath, files }, null, 2) + "\n",
      { mode: 0o600 },
    );
    fsModule.renameSync(partial, dir);
    return { ok: true, path: dir, files };
  } catch (error) {
    fsModule.rmSync(partial, { recursive: true, force: true });
    return { ok: false, error: String(error?.message || error) };
  }
};

module.exports = { backupHookIngress, kHookIngressBackupMarker, kHookIngressBackupNamePattern, kHookIngressBackupSuffix };
