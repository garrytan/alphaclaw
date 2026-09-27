const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");
const { captureDatabaseBaseline, checkDatabaseBaseline, normalizeDatabaseBaseline, normalizeDatabasePending } = require("../../lib/server/openclaw-db-verification");

describe("database verification positive coverage", () => {
  let root;
  let verdict;
  let baseline;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "database-verification-"));
    const packageDir = path.join(root, "package");
    fs.mkdirSync(packageDir);
    fs.writeFileSync(path.join(packageDir, "package.json"), '{}');
    fs.writeFileSync(path.join(packageDir, "entry.js"), 'entry');
    fs.writeFileSync(path.join(root, "openclaw.json"), '{}');
    verdict = { compatible: true, migrationRequired: false, complete: true,
      executingBuild: { packageDir, bin: path.join(packageDir, "entry.js"), version: "1", buildId: "1", source: "installed" },
      inventory: { stateDir: root, requestedStateDir: root, configPath: path.join(root, "openclaw.json"),
        configDigest: crypto.createHash("sha256").update('{}').digest("hex"), databaseSetComplete: true,
        dbs: [{ archivePath: "state/openclaw.sqlite", dbKind: "state" }, { archivePath: "agents/main/agent/openclaw-agent.sqlite", dbKind: "agent", agentId: "main" }] } };
    verdict.inventory.expectedDatabases = verdict.inventory.dbs.map((db) => ({ ...db, sourcePath: path.join(root, db.archivePath), ownership: "canonical", present: true }));
    verdict.perDb = verdict.inventory.expectedDatabases.map((db) => ({ ...db, compatible: true, migrationRequired: false }));
    baseline = captureDatabaseBaseline({ verdict });
    expect(baseline).not.toBeNull();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("requires each original logical database and owner, not its old inode", () => {
    verdict.inventory.dbs[0].sourceIdentity = { dev: 1, ino: 99 };
    expect(checkDatabaseBaseline({ baseline, verdict }).ok).toBe(true);
    verdict.inventory.dbs.pop();
    expect(checkDatabaseBaseline({ baseline, verdict })).toMatchObject({ ok: false, code: "required_database_missing" });
    verdict.inventory.dbs = [];
    expect(checkDatabaseBaseline({ baseline, verdict })).toMatchObject({ ok: false, code: "required_database_missing" });
  });

  it("refuses a changed owner and a missing registry target", () => {
    verdict.inventory.dbs[1].agentId = "other";
    expect(checkDatabaseBaseline({ baseline, verdict }).code).toBe("required_database_missing");
    verdict.inventory.dbs[1].agentId = "main";
    verdict.inventory.skipped = [{ kind: "missing-registry-database", sourcePath: "missing.sqlite" }];
    expect(checkDatabaseBaseline({ baseline, verdict }).code).toBe("required_database_missing");
  });

  it.each([
    ["unknown", { compatible: null }, "database_verification_failed"],
    ["incompatible", { compatible: false }, "database_verification_failed"],
    ["migration", { migrationRequired: true }, "recovery_choice_required"],
    ["partial", { complete: false }, "recovery_inventory_incomplete"],
  ])("retains the hold for %s evidence", (_name, patch, code) => {
    expect(checkDatabaseBaseline({ baseline, verdict: { ...verdict, ...patch } })).toMatchObject({ ok: false, code });
  });

  it("requires manual verification for a legacy baseline", () => {
    expect(checkDatabaseBaseline({ verdict }).code).toBe("recovery_baseline_unavailable");
    expect(checkDatabaseBaseline({ verdict, manual: true }).ok).toBe(true);
    verdict.inventory.dbs = [];
    expect(checkDatabaseBaseline({ verdict, manual: true }).code).toBe("required_database_missing");
  });

  it("requires positive canonical and registry coverage for manually verified legacy holds", () => {
    verdict.inventory.expectedDatabases[1].present = false;
    expect(checkDatabaseBaseline({ verdict, manual: true }).code).toBe("required_database_missing");
    verdict.inventory.expectedDatabases[1].present = true;
    verdict.inventory.expectedDatabases[1].ownership = "registry";
    verdict.perDb[1].agentId = "other";
    expect(checkDatabaseBaseline({ verdict, manual: true }).code).toBe("required_database_missing");
    verdict.perDb[1].agentId = "main";
    expect(checkDatabaseBaseline({ verdict, manual: true }).ok).toBe(true);
    delete verdict.inventory.expectedDatabases;
    expect(checkDatabaseBaseline({ verdict, manual: true }).code).toBe("recovery_baseline_unavailable");
  });

  it("does not accept config, build, or root identity replacement", () => {
    verdict.executingBuild.buildId = "2";
    expect(checkDatabaseBaseline({ baseline, verdict }).code).toBe("recovery_source_changed");
    verdict.executingBuild.buildId = "1";
    fs.writeFileSync(verdict.executingBuild.bin, "new entry");
    expect(checkDatabaseBaseline({ baseline, verdict }).code).toBe("recovery_source_changed");
    fs.writeFileSync(verdict.inventory.configPath, '{"changed":true}');
    expect(checkDatabaseBaseline({ baseline, verdict }).ok).toBe(false);
  });

  it("refuses a disappeared storage root and a replacement root at the same selector", () => {
    const moved = `${root}-old`;
    fs.renameSync(root, moved);
    try {
      expect(checkDatabaseBaseline({ baseline, verdict }).ok).toBe(false);
      fs.mkdirSync(root);
      fs.cpSync(moved, root, { recursive: true });
      expect(checkDatabaseBaseline({ baseline, verdict }).code).toBe("recovery_source_changed");
    } finally { fs.rmSync(moved, { recursive: true, force: true }); }
  });

  it("bounds persisted paths and rows and refuses malformed pending evidence", () => {
    expect(normalizeDatabaseBaseline({ ...baseline, databases: Array(513).fill(baseline.databases[0]) })).toBeNull();
    expect(normalizeDatabaseBaseline({ ...baseline, databases: [{ path: "../escape", dbKind: "state" }] })).toBeNull();
    expect(normalizeDatabasePending({ recoveryId: "r", baseline, at: 1 })).toEqual({ recoveryId: "r", baseline, at: 1 });
    expect(normalizeDatabasePending({ recoveryId: "r", baseline: {} })).toBeNull();
  });

  it("refuses a real FIFO configuration without blocking the caller", () => {
    fs.rmSync(verdict.inventory.configPath);
    execFileSync("mkfifo", [verdict.inventory.configPath]);
    const modulePath = require.resolve("../../lib/server/openclaw-db-verification");
    const child = spawnSync(process.execPath, ["-e",
      `const { verificationIdentity } = require(${JSON.stringify(modulePath)}); const result = verificationIdentity(JSON.parse(process.argv[1])); if (result !== null) process.exit(1); process.stdout.write("refused");`,
      JSON.stringify({ inventory: verdict.inventory, build: verdict.executingBuild })], { encoding: "utf8", timeout: 2000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("refused");
  });
});
