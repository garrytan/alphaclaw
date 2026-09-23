const { workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const signal = new Int32Array(workerData.signal);
const db = new DatabaseSync(workerData.databasePath);
db.exec("PRAGMA busy_timeout = 3000");
Atomics.store(signal, 0, 1);
Atomics.notify(signal, 0);
db.exec("BEGIN IMMEDIATE");
Atomics.store(signal, 1, 1);
Atomics.notify(signal, 1);
if (workerData.hold) {
  Atomics.wait(signal, 2, 0, 3000);
  Atomics.wait(signal, 3, 0, 150);
}
const row = db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.store'").get();
const store = JSON.parse(row.value_json);
store.profiles["other:oauth"].access = "synthetic-refreshed";
db.prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = 'authProfiles.store'").run(JSON.stringify(store));
db.exec("COMMIT");
db.close();
