const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { runCliJson, scrubTestRunnerEnv } = require("./live-helpers");

// Independent observations of immutable releases, not production's schema
// oracle. Schema ordering is deliberately non-monotonic across these lines.
const kObservedSchemas = Object.freeze({
  // 2026.9.3 (the v0.9.80 pin): declared by its package.json
  // `openclaw.schemaVersions` and its dist constants (2026-09-08); the first
  // live run against a real 2026.9.3 database is what turns this row into an
  // observation — if it disagrees, the declaration drifted, not this fixture.
  "2026.9.3": Object.freeze({ state: 16, agent: 19 }),
  "2026.9.2": Object.freeze({ state: 15, agent: 19 }),
  "2026.8.2": Object.freeze({ state: 15, agent: 19 }),
  "2026.9.1-beta.1": Object.freeze({ state: 12, agent: 17 }),
});
const databasePaths = (stateDir) => ({
  state: path.join(stateDir, "state", "openclaw.sqlite"),
  agent: path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
});
const readDatabaseSchema = (file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      version: db.prepare("PRAGMA user_version").get().user_version,
      owner: db.prepare("SELECT role, schema_version, agent_id FROM schema_meta WHERE meta_key = 'primary'").get(),
      integrity: db.prepare("PRAGMA integrity_check").get().integrity_check,
    };
  } finally {
    db.close();
    // These are isolated, stopped fixtures. A read-only WAL open can create
    // a nonempty SHM index beside an empty WAL; neither is backup content.
    // Never delete a WAL containing frames just to satisfy preflight.
    const wal = `${file}-wal`;
    if (!fs.existsSync(wal) || fs.statSync(wal).size === 0) {
      fs.rmSync(wal, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    }
  }
};
const assertMaterializedSchemas = ({ stateDir, version, agentDb = true }) => {
  const expected = kObservedSchemas[version];
  if (!expected) throw new Error(`Record independent schema expectations for immutable OpenClaw ${version}`);
  const paths = databasePaths(stateDir);
  for (const kind of agentDb ? ["state", "agent"] : ["state"]) {
    const observed = readDatabaseSchema(paths[kind]);
    if (observed.version !== expected[kind] || observed.integrity !== "ok") {
      throw new Error(`${version} ${kind} database contract changed: ${JSON.stringify(observed)}; expected schema ${expected[kind]}`);
    }
    if (kind === "agent" && (observed.owner?.role !== "agent" || observed.owner?.agent_id !== "main" || observed.owner?.schema_version !== expected.agent)) {
      throw new Error(`${version} did not write valid main-agent ownership: ${JSON.stringify(observed.owner)}`);
    }
  }
  return paths;
};

// Exercise public CLIs: approvals materializes global state; Doctor migrates
// one real legacy session into the agent database with ownership metadata.
// No provider call or gateway is needed. Restore caller-owned config bytes
// afterwards so Doctor's unrelated setup suggestions do not alter the test.
const materializeDatabases = ({ openclawBin, cliEnv, stateDir, version, agentDb = true }) => {
  const paths = databasePaths(stateDir);
  for (const file of Object.values(paths)) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(`${file}${suffix}`, { force: true });
  }
  const configPath = path.join(stateDir, "openclaw.json");
  const config = fs.readFileSync(configPath);
  runCliJson(openclawBin, ["approvals", "get", "--json"], { env: cliEnv });
  if (agentDb) {
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "sessions.json"), JSON.stringify({
      "agent:main:main": { sessionId: "11111111-1111-4111-8111-111111111111", updatedAt: 1_780_000_000_000 },
    }));
    try {
      const result = spawnSync(process.execPath, [openclawBin, "doctor", "--fix", "--non-interactive"], {
        env: scrubTestRunnerEnv(cliEnv), encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      });
      if (result.error || result.status !== 0) {
        throw new Error(`Fixture Doctor failed (${result.status}): ${result.error?.message || ""}\n${result.stderr}\n${result.stdout}`);
      }
    } finally {
      fs.writeFileSync(configPath, config);
      fs.rmSync(path.join(stateDir, "tmp"), { recursive: true, force: true });
    }
  }
  return assertMaterializedSchemas({ stateDir, version, agentDb });
};

module.exports = { kObservedSchemas, databasePaths, readDatabaseSchema, assertMaterializedSchemas, materializeDatabases };
