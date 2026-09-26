const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { DatabaseSync, backup } = require("node:sqlite");

process.umask(0o077);
process.once("message", async ({ source, destination, verifyOnly }) => {
  let db;
  try {
    if (!verifyOnly) {
      db = new DatabaseSync(source, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 1000");
      process.send?.({ progress: { totalPages: 0, remainingPages: 0 } });
      await backup(db, destination, {
        rate: 128,
        progress: ({ totalPages, remainingPages }) => {
          process.send?.({ progress: { totalPages, remainingPages } });
        },
      });
      db.close();
      db = null;
      db = new DatabaseSync(destination);
      db.exec("PRAGMA journal_mode = DELETE");
      db.close();
      db = null;
    }
    db = new DatabaseSync(destination, { readOnly: true });
    const verdicts = db.prepare("PRAGMA integrity_check").all();
    if (verdicts.length !== 1 || verdicts[0].integrity_check !== "ok") {
      throw new Error("snapshot integrity check failed");
    }
    const userVersion = db.prepare("PRAGMA user_version").get().user_version;
    db.close();
    db = null;
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(destination)) hash.update(chunk);
    process.send?.({ result: { sha256: hash.digest("hex"), userVersion, integrity: "ok", bytes: fs.statSync(destination).size } });
  } catch {
    process.send?.({ error: "SQLite snapshot or integrity verification failed" });
    process.exitCode = 1;
  } finally {
    try { db?.close(); } catch {}
    process.disconnect();
  }
});
