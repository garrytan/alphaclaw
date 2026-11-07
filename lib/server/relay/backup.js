const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

// Relay data in "Back up now": beside each verified OpenClaw archive, a
// <stamp>-relay-backup directory (0700) holding online copies of the relay
// databases (engine, bridge, remote and the brain archive's state) (VACUUM INTO, so a running engine and bridge are never paused),
// secrets.json and the internal secret (0600), and a manifest written last.
// Each copy is integrity-checked before the manifest marks it complete.
// copy-retention.js sweeps these with the same keep/days policy as the
// archives, and only directories carrying this manifest's marker.
const kRelayBackupSuffix = "-relay-backup";
const kRelayBackupMarker = "alphaclaw-relay-backup-v1";
const kRelayBackupNamePattern = /^\d{4}-\d{2}-\d{2}T[0-9.+\-Z]+-relay-backup$/;

const stampFromArchive = (archivePath, nowMs) => {
  const match = path.basename(String(archivePath || "")).match(/^(\d{4}-\d{2}-\d{2}T[0-9.+\-Z]+)-openclaw-backup\.tar\.gz$/);
  return match ? match[1] : new Date(nowMs).toISOString().replace(/:/g, "-");
};

const copyDatabase = (source, target) => {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec("VACUUM INTO '" + target.replace(/'/g, "''") + "'");
  } finally {
    db.close();
  }
  fs.chmodSync(target, 0o600);
  const check = new DatabaseSync(target, { readOnly: true });
  try {
    const row = check.prepare("PRAGMA integrity_check").get();
    const verdict = row ? Object.values(row)[0] : null;
    if (verdict !== "ok") throw new Error("integrity_check of " + path.basename(target) + " returned " + verdict);
  } finally {
    check.close();
  }
  return fs.statSync(target).size;
};

const backupRelay = ({ paths, backupsDir, archivePath = null, now = Date.now }) => {
  if (!fs.existsSync(paths.secretsFile)) return { ok: true, skipped: "not_provisioned" };
  for (const name of fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : []) {
    if (name.endsWith(".partial") && kRelayBackupNamePattern.test(name.slice(0, -".partial".length))) {
      fs.rmSync(path.join(backupsDir, name), { recursive: true, force: true });
    }
  }
  const dir = path.join(backupsDir, stampFromArchive(archivePath, now()) + kRelayBackupSuffix);
  const partial = dir + ".partial";
  fs.mkdirSync(partial, { recursive: true, mode: 0o700 });
  try {
    const files = {};
    for (const [name, source] of [["relaycast.db", paths.engineDb], ["bridge.db", paths.bridgeDb], ["remote.db", paths.remoteDb], ["archive.db", paths.archiveDb]]) {
      if (fs.existsSync(source)) files[name] = copyDatabase(source, path.join(partial, name));
    }
    for (const [name, source] of [["secrets.json", paths.secretsFile], ["internal.secret", paths.internalSecretFile]]) {
      if (!fs.existsSync(source)) continue;
      fs.copyFileSync(source, path.join(partial, name));
      fs.chmodSync(path.join(partial, name), 0o600);
      files[name] = fs.statSync(path.join(partial, name)).size;
    }
    fs.writeFileSync(
      path.join(partial, "manifest.json"),
      JSON.stringify({ marker: kRelayBackupMarker, createdAt: new Date(now()).toISOString(), archivePath, files }, null, 2) + "\n",
      { mode: 0o600 },
    );
    fs.renameSync(partial, dir);
    return { ok: true, path: dir, files };
  } catch (error) {
    fs.rmSync(partial, { recursive: true, force: true });
    return { ok: false, error: String(error?.message || error) };
  }
};

module.exports = { backupRelay, kRelayBackupMarker, kRelayBackupNamePattern, kRelayBackupSuffix };
