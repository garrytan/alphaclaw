const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const { buildMigrationInventory } = require("../../lib/server/openclaw-backup-inventory");
const { resolveBackupPolicy } = require("../../lib/server/openclaw-backup-policy");
const { walkStateTreeAsync } = require("../../lib/server/openclaw-backup-walk");
const { createOfflineCopy, verifyArchiveManifest } = require("../../lib/server/openclaw-backup-offline-copy");
const { verifyFormat3Payload } = require("../../lib/server/openclaw-backup-verification");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");
const { updateOpenclawConfig } = require("../../lib/server/openclaw-config");
const roots = [];
const temporary = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-minimal-")); roots.push(root); return root; };
const write = (root, name, bytes = "{}") => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
const database = (root, name, mode = "WAL") => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=${mode}; CREATE TABLE t(value TEXT); INSERT INTO t VALUES ('saved'); PRAGMA user_version=17;`);
  db.close();
  return file;
};
const register = (root, entries) => {
  const db = new DatabaseSync(path.join(root, "state/openclaw.sqlite"));
  try {
    db.exec("CREATE TABLE agent_databases(agent_id,path,schema_version)");
    const insert = db.prepare("INSERT INTO agent_databases VALUES (?,?,?)");
    for (const [id, file] of entries) insert.run(id, file, 17);
  } finally { db.close(); }
};
const fixture = () => {
  const root = temporary();
  write(root, "openclaw.json", '{"agents":{"list":[{"id":"main"}]}}');
  database(root, "state/openclaw.sqlite");
  database(root, "agents/main/agent/openclaw-agent.sqlite", "DELETE");
  write(root, "credentials/provider.json", '{"secret":"credential"}');
  write(root, "identity/device.json", '{"id":"device"}');
  write(root, "agents/main/agent/auth-profiles.json", '{"profiles":{}}');
  write(root, "workspace/keep.md", "omitted workspace");
  return root;
};
const runner = createRunStream({});
const command = (spec) => runner.runStreamed({ ...spec, env: process.env });
const copyArgs = (stateDir) => {
  const backupsDir = temporary();
  return { stateDir, spawnEnv: {}, backupsDir,
    outputFile: path.join(backupsDir, "minimal.alphaclaw.tar.gz"), profile: "migration-minimal", runCommand: command,
    isQuiet: () => true, listFdHolders: () => [],
    exclusivity: { stopConfirmed: true, quietToken: { id: "minimal", disabled: false }, liveProcesses: [], handleCount: 0 },
  };
};
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("migration-minimal inventory", () => {
  it("unions direct, configured, and every registry schema without entering scratch", async () => {
    const root = fixture();
    const custom = path.join(root, "state", "owners", "custom");
    write(root, "openclaw.json", JSON.stringify({ agents: { entries: { custom: { agentDir: custom } } } }));
    database(root, "state/owners/custom/openclaw-agent.sqlite");
    database(root, "tmp/registered/arbitrary.db");
    database(root, "state/extra.sqlite");
    const global = new DatabaseSync(path.join(root, "state/openclaw.sqlite"));
    global.exec("CREATE TABLE agent_databases(agent_id TEXT,path TEXT,schema_version INTEGER)");
    global.prepare("INSERT INTO agent_databases VALUES (?,?,?)").run("older", "tmp/registered/arbitrary.db", 999);
    global.prepare("INSERT INTO agent_databases VALUES (?,?,?)").run("stale", "agents/gone/agent/openclaw-agent.sqlite", 17);
    global.close();
    write(root, "state/security-planning/import/skip", "scratch");
    const opened = [];
    const fsModule = { ...fs, opendirSync(directory) { opened.push(directory); return fs.opendirSync(directory); } };
    const inventory = await buildMigrationInventory({ stateDir: root, spawnEnv: {}, fsModule });
    expect(inventory.dbs.map((entry) => entry.archivePath).sort()).toEqual([
      "agents/main/agent/openclaw-agent.sqlite", "state/extra.sqlite", "state/openclaw.sqlite",
      "state/owners/custom/openclaw-agent.sqlite", "tmp/registered/arbitrary.db",
    ]);
    expect(inventory.skipped.some((entry) => entry.kind === "missing-registry-database")).toBe(true);
    expect(opened.some((directory) => directory.includes("security-planning") || directory.includes("workspace"))).toBe(false);
  });

  it.each(["{oops", '{"$include":"other.json"}', '{"agents":{"list":[{"id":"main","agentDir":"${MISSING}/agent"}]}}'])
    ("refuses unresolved configuration %s", async (config) => {
      const root = fixture();
      write(root, "openclaw.json", config);
      await expect(buildMigrationInventory({ stateDir: root, spawnEnv: {} })).rejects.toMatchObject({ stage: "inventory" });
    });

  it("reads the selected config and credential paths, including optional missing stores", async () => {
    const root = fixture();
    write(root, "alternate.json", '{"agents":{}}');
    write(root, "state/auth/token.json", "token");
    fs.rmSync(path.join(root, "identity"), { recursive: true });
    const inventory = await buildMigrationInventory({ stateDir: root, spawnEnv: {
      OPENCLAW_CONFIG_PATH: path.join(root, "alternate.json"), OPENCLAW_OAUTH_DIR: path.join(root, "state/auth"),
    } });
    expect(inventory.files.map((entry) => entry.archivePath)).toEqual(expect.arrayContaining(["alternate.json", "state/auth/token.json"]));
  });

  it("captures config and OAuth paths under OPENCLAW_HOME when HOME points elsewhere", async () => {
    const root = fixture();
    write(root, "alternate.json", '{"agents":{"list":[{"id":"main"}]}}');
    const spawnEnv = { OPENCLAW_HOME: root, HOME: temporary(), OPENCLAW_CONFIG_PATH: "~/alternate.json", OPENCLAW_OAUTH_DIR: "~/credentials" };
    const inventory = await buildMigrationInventory({ stateDir: root, spawnEnv });
    expect(inventory.configPath).toBe(path.join(root, "alternate.json"));
    expect(inventory.oauthDir).toBe(path.join(root, "credentials"));
    const result = await createOfflineCopy({ ...copyArgs(root), spawnEnv });
    expect(result.manifest.assets.map((asset) => asset.archivePath)).toEqual(expect.arrayContaining(["alternate.json", "credentials/provider.json"]));
    expect(result.coverage.migration).toBe("complete");
  });

  it("expands a bare tilde OAuth store to the effective home", async () => {
    const root = fixture();
    const inventory = await buildMigrationInventory({ stateDir: root, spawnEnv: { OPENCLAW_HOME: path.join(root, "credentials"), HOME: temporary(), OPENCLAW_OAUTH_DIR: "~" } });
    expect(inventory.oauthDir).toBe(path.join(root, "credentials"));
    expect(inventory.files.map((entry) => entry.archivePath)).toContain("credentials/provider.json");
  });

  it.each([null, 0, {}, []])("refuses a present non-string configured agentDir %s", async (agentDir) => {
    const root = fixture();
    write(root, "openclaw.json", JSON.stringify({ agents: { list: [{ id: "main", agentDir }] } }));
    await expect(buildMigrationInventory({ stateDir: root, spawnEnv: {} })).rejects.toMatchObject({ stage: "inventory", message: expect.stringContaining("storage path must be a string") });
  });

  it.each(["-wal", "-shm", "-journal"])("refuses an orphaned %s sidecar", async (suffix) => {
    const root = fixture();
    fs.unlinkSync(path.join(root, "state/openclaw.sqlite"));
    write(root, `state/openclaw.sqlite${suffix}`, "orphan");
    await expect(buildMigrationInventory({ stateDir: root, spawnEnv: {} })).rejects.toMatchObject({ stage: "inventory" });
  });

  it("refuses inaccessible inputs and directory symlinks", async () => {
    const root = fixture();
    const fsModule = { ...fs, opendirSync(directory) {
      if (directory.endsWith("/credentials")) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return fs.opendirSync(directory);
    } };
    await expect(buildMigrationInventory({ stateDir: root, spawnEnv: {}, fsModule })).rejects.toMatchObject({ stage: "inventory" });
    fs.renameSync(path.join(root, "agents/main"), path.join(root, "real-agent"));
    fs.symlinkSync(path.join(root, "real-agent"), path.join(root, "agents/main"));
    await expect(buildMigrationInventory({ stateDir: root, spawnEnv: {} })).rejects.toMatchObject({ stage: "inventory" });
  });

  it("refuses existing external required stores without changing their bytes", async () => {
    const root = fixture();
    const external = temporary();
    write(external, "token.json", "outside");
    await expect(buildMigrationInventory({ stateDir: root, spawnEnv: { OPENCLAW_OAUTH_DIR: external } })).rejects.toMatchObject({ stage: "inventory" });
    expect(fs.readFileSync(path.join(external, "token.json"), "utf8")).toBe("outside");
    await expect(createOfflineCopy({ ...copyArgs(root), profile: "full", spawnEnv: { OPENCLAW_OAUTH_DIR: external } }))
      .rejects.toMatchObject({ code: "BACKUP_EXTERNAL_SOURCE" });
  });

  it("distinguishes proven source corruption from unreadable registry metadata", async () => {
    const root = fixture();
    const global = new DatabaseSync(path.join(root, "state/openclaw.sqlite"));
    global.exec("CREATE TABLE agent_databases(unrelated TEXT)");
    global.close();
    const unavailable = await buildMigrationInventory({ stateDir: root, spawnEnv: {} }).catch((error) => error);
    expect(unavailable.stage).toBe("inventory");
    expect(unavailable.sourceCorrupt).toBeUndefined();
    fs.writeFileSync(path.join(root, "state/openclaw.sqlite"), "not a database");
    await expect(buildMigrationInventory({ stateDir: root, spawnEnv: {} }))
      .rejects.toMatchObject({ stage: "inventory", sourceCorrupt: true, code: "SQLITE_CORRUPT" });
  });

  it("excludes only registry import artifacts across lexical, canonical, and dangling aliases", async () => {
    const root = fixture();
    database(root, "imports/offline/openclaw-agent.sqlite");
    database(root, "state/owners/imports/live.db");
    fs.symlinkSync(path.join(root, "imports/offline"), path.join(root, "import-alias"));
    fs.symlinkSync(path.join(root, "imports/missing"), path.join(root, "dangling-import"));
    register(root, [
      ["offline", "imports/offline/openclaw-agent.sqlite"],
      ["alias", "import-alias/openclaw-agent.sqlite"],
      ["gone", "dangling-import/openclaw-agent.sqlite"],
      ["live", "state/owners/imports/live.db"],
    ]);
    const visited = [];
    const fsModule = { ...fs, opendirSync(directory) { visited.push(directory); return fs.opendirSync(directory); } };
    const inventory = await buildMigrationInventory({ stateDir: root, spawnEnv: {}, fsModule });
    expect(inventory.dbs.map((entry) => entry.archivePath)).toContain("state/owners/imports/live.db");
    expect(inventory.dbs.some((entry) => /^(imports|import-alias|dangling-import)\//.test(entry.archivePath))).toBe(false);
    expect(inventory.skipped.filter((entry) => entry.kind === "registry-import-artifact")).toHaveLength(3);
    expect(visited.some((directory) => /\/(imports|import-alias|dangling-import)(\/|$)/.test(directory) && !directory.includes("state/owners"))).toBe(false);
  });

  it("filters registry aliases into an external imports target without admitting external migration inputs", async () => {
    const root = fixture();
    const external = temporary();
    database(external, "offline.db");
    fs.symlinkSync(external, path.join(root, "imports"));
    register(root, [["lexical", "imports/offline.db"], ["canonical", path.join(external, "offline.db")]]);
    const inventory = await buildMigrationInventory({ stateDir: root, spawnEnv: {} });
    expect(inventory.skipped.filter((entry) => entry.kind === "registry-import-artifact")).toHaveLength(2);
    expect(inventory.dbs).toHaveLength(2);
  });

  it("retains an explicitly configured agent input even when its registry row is an import artifact", async () => {
    const root = fixture();
    const configured = path.join(root, "imports/active");
    write(root, "openclaw.json", JSON.stringify({ agents: { list: [{ id: "active", agentDir: configured }] } }));
    database(root, "imports/active/openclaw-agent.sqlite");
    register(root, [["active", "imports/active/openclaw-agent.sqlite"]]);
    const inventory = await buildMigrationInventory({ stateDir: root, spawnEnv: {} });
    expect(inventory.dbs.map((entry) => entry.archivePath)).toContain("imports/active/openclaw-agent.sqlite");
    expect(inventory.protectedPaths).toContain(configured);
  });

  it.each([null, 3, "", "bad/id", "a".repeat(65)])("refuses malformed registry identity %s", async (id) => {
    const root = fixture();
    register(root, [[id, "agents/main/agent/openclaw-agent.sqlite"]]);
    await expect(buildMigrationInventory({ stateDir: root, spawnEnv: {} })).rejects.toMatchObject({ stage: "inventory", message: expect.stringContaining("registry agent identity") });
  });

  it("refuses registry paths whose parent traversal could change symlink resolution", async () => {
    const root = fixture();
    register(root, [["main", "agents/main/../main/agent/openclaw-agent.sqlite"]]);
    await expect(buildMigrationInventory({ stateDir: root, spawnEnv: {} })).rejects.toMatchObject({ stage: "inventory", message: expect.stringContaining("registry database path") });
  });

  it("refuses SQLite inode aliases while retaining ordinary-file restore destinations", async () => {
    const root = fixture();
    fs.linkSync(path.join(root, "credentials/provider.json"), path.join(root, "identity/provider-copy.json"));
    const inventory = await buildMigrationInventory({ stateDir: root, spawnEnv: {} });
    expect(inventory.files.map((entry) => entry.archivePath)).toEqual(expect.arrayContaining(["credentials/provider.json", "identity/provider-copy.json"]));
    expect(inventory.protectedPaths).toEqual(expect.arrayContaining([path.join(root, "credentials/provider.json"), path.join(root, "identity/provider-copy.json")]));
    fs.linkSync(path.join(root, "agents/main/agent/openclaw-agent.sqlite"), path.join(root, "state/alias.sqlite"));
    await expect(buildMigrationInventory({ stateDir: root, spawnEnv: {} })).rejects.toMatchObject({ code: "BACKUP_SQLITE_ALIAS" });
    await expect(createOfflineCopy({ ...copyArgs(root), profile: "full" })).rejects.toMatchObject({ code: "BACKUP_SQLITE_ALIAS" });
  });

  it("applies the SQLite alias refusal to extra full-profile workspace databases", async () => {
    const root = fixture();
    fs.linkSync(path.join(root, "agents/main/agent/openclaw-agent.sqlite"), path.join(root, "workspace/alias.sqlite"));
    await expect(createOfflineCopy({ ...copyArgs(root), profile: "full" })).rejects.toMatchObject({ code: "BACKUP_SQLITE_ALIAS" });
  });
});

describe("bounded walk and protection", () => {
  it("rejects dangerous roots and validates dynamic root/workspace owners", async () => {
    const root = fixture();
    write(root, "openclaw.json", JSON.stringify({ agents: { list: [{ id: "main", agentDir: path.join(root, "workspace", "private") }] } }));
    database(root, "workspace/private/openclaw-agent.sqlite");
    const inventory = await buildMigrationInventory({ stateDir: root, spawnEnv: {} });
    for (const rootExcludes of [["state/*"], ["agents/main"], ["../state"], ["/state/owners"], ["workspace/private"]]) {
      expect(resolveBackupPolicy({ rootExcludes }, { inventory }).refused).not.toHaveLength(0);
    }
    expect(resolveBackupPolicy({ excludes: ["private"] }, { inventory }).refused).toHaveLength(1);
    expect(resolveBackupPolicy({ rootExcludes: ["state/security-planning/stronghold-*", "workspace/.openclaw"] }, { inventory }).refused).toEqual([]);
    expect(resolveBackupPolicy(null).refused).toHaveLength(1);
  });

  it("closes every directory on budget expiry and retains unfinished offender statistics", async () => {
    const root = fixture();
    for (let i = 0; i < 25; i++) write(root, `state/security-planning/import/${i}`, "scratch");
    let handles = 0;
    const fsModule = { ...fs, opendirSync(directory) {
      const dir = fs.opendirSync(directory); handles++;
      return { readSync: () => dir.readSync(), closeSync() { handles--; dir.closeSync(); } };
    } };
    const error = await walkStateTreeAsync({ stateDir: root, fsModule, checkpointEvery: 1,
      checkpoint() { if (handles >= 4) throw new Error("deadline"); } }).catch((error) => error);
    expect(error.message).toBe("deadline");
    expect(handles).toBe(0);
    expect(error.diagnostics.complete).toBe(false);
    expect(error.diagnostics.topEntries.some((entry) => entry.path.includes("security-planning"))).toBe(true);
  });

  it("shares the excluded measurement cap across roots and never treats its bytes as complete", async () => {
    const root = fixture();
    for (const directory of ["first", "second"]) for (let i = 0; i < 10; i++) write(root, `workspace/${directory}/${i}`, "scratch".repeat(3000));
    const tree = await walkStateTreeAsync({ stateDir: root, excludes: ["first", "second"], measurementMaxEntries: 7, measurementMs: Infinity });
    expect(tree.diagnostics.measuredEntries).toBe(7);
    expect(tree.diagnostics.measurementComplete).toBe(false);
    expect(tree.diagnostics.topBytes.some((entry) => entry.path === "workspace/first")).toBe(true);
    expect(tree.excludes.some((entry) => entry.partial)).toBe(true);
    expect(tree.workspaces.get(path.join(root, "workspace")).files.map((file) => file.archivePath)).toEqual(["workspace/keep.md"]);
  });

  it("counts individually excluded entries against the walk cap", async () => {
    const root = fixture();
    for (let i = 0; i < 20; i++) write(root, `workspace/${i}.tmp`, "excluded");
    await expect(walkStateTreeAsync({ stateDir: root, maxEntries: 12 })).rejects.toMatchObject({ stage: "enumerate" });
  });

  it("stops a lazy million-entry scratch directory at the default cap with bounded diagnostics and closed handles", async () => {
    const root = temporary();
    const scratch = "state/security-planning/stronghold-src/import";
    const directoryListings = new Map([
      ["", ["state"]],
      ["state", [...Array.from({ length: 6 }, (_, index) => `finished-${index}`), "security-planning"]],
      ["state/security-planning", ["stronghold-src"]],
      ["state/security-planning/stronghold-src", ["import"]],
      [scratch, null],
      ...Array.from({ length: 6 }, (_, index) => [`state/finished-${index}`, ["sample.bin"]]),
    ]);
    const offeredScratchEntries = 1_000_000;
    let generatedScratchEntries = 0;
    let readEntries = 0;
    let statCalls = 0;
    let openHandles = 0;
    let openedHandles = 0;
    let closedHandles = 0;
    let peakHandles = 0;
    let progressSamples = 0;
    let largestLeaderList = 0;
    const fsModule = { ...fs,
      readdirSync() { throw new Error("the bounded walk must not eagerly materialize a directory"); },
      opendirSync(directory) {
        const relative = path.relative(root, directory);
        if (!directoryListings.has(relative)) throw new Error(`unexpected directory ${relative}`);
        const listing = directoryListings.get(relative);
        let cursor = 0;
        let closed = false;
        openedHandles++;
        peakHandles = Math.max(peakHandles, ++openHandles);
        return {
          readSync() {
            if (closed) throw new Error("read after close");
            const length = relative === scratch ? offeredScratchEntries : listing.length;
            if (cursor >= length) return null;
            const name = relative === scratch ? `entry-${cursor++}.bin` : listing[cursor++];
            if (relative === scratch) generatedScratchEntries++;
            readEntries++;
            const isDirectory = directoryListings.has(relative ? `${relative}/${name}` : name);
            return { name, isDirectory: () => isDirectory, isFile: () => !isDirectory, isSymbolicLink: () => false };
          },
          closeSync() {
            if (closed) throw new Error("directory closed twice");
            closed = true;
            openHandles--;
            closedHandles++;
          },
        };
      },
      statSync(file) {
        const relative = path.relative(root, file);
        if (!relative.startsWith(`${scratch}/entry-`) && !/^state\/finished-\d\/sample\.bin$/.test(relative)) throw new Error(`unexpected stat ${relative}`);
        statCalls++;
        return { size: 64, isFile: () => true };
      },
    };
    const error = await walkStateTreeAsync({ stateDir: root, fsModule, onProgress({ diagnostics }) {
      progressSamples++;
      largestLeaderList = Math.max(largestLeaderList, diagnostics.topEntries.length, diagnostics.topBytes.length);
    } }).catch((error) => error);
    expect(error).toMatchObject({ stage: "enumerate", message: expect.stringContaining("200000 entries") });
    expect(error.diagnostics).toMatchObject({ complete: false, entries: 200_001, measuredEntries: 0 });
    expect(readEntries).toBe(200_001);
    expect(generatedScratchEntries).toBe(199_985);
    expect(statCalls).toBe(199_990);
    expect(generatedScratchEntries).toBeLessThan(offeredScratchEntries);
    expect(progressSamples).toBe(400);
    expect(largestLeaderList).toBe(5);
    for (const field of ["topEntries", "topBytes"]) {
      expect(error.diagnostics[field]).toHaveLength(5);
      expect(error.diagnostics[field].every((entry) => entry.partial)).toBe(true);
      expect(error.diagnostics[field]).toEqual(expect.arrayContaining([expect.objectContaining({ path: scratch, entries: 199_984, bytes: 199_984 * 64 })]));
    }
    expect(openHandles).toBe(0);
    expect(closedHandles).toBe(openedHandles);
    expect(openedHandles).toBe(directoryListings.size);
    expect(peakHandles).toBe(5);
  });

  it("retains rejected rules when revalidating a frozen policy against refreshed inventory", async () => {
    const root = fixture();
    const frozen = resolveBackupPolicy({ excludes: ["*.tmp"], rootExcludes: ["state/*", "state/custom"] });
    write(root, "openclaw.json", JSON.stringify({ agents: { list: [{ id: "main", agentDir: path.join(root, "state/custom") }] } }));
    database(root, "state/custom/openclaw-agent.sqlite");
    const inventory = await buildMigrationInventory({ stateDir: root, spawnEnv: {} });
    const refreshed = resolveBackupPolicy(frozen, { inventory });
    expect(refreshed.rootExcludes).toEqual([]);
    expect(refreshed.refused.map((entry) => entry.pattern)).toEqual(["state/*", "state/custom"]);
    expect(resolveBackupPolicy(refreshed, { inventory }).refused).toEqual(refreshed.refused);
    expect(resolveBackupPolicy({ excludes: [], rootExcludes: [], refused: frozen.refused }).refused).toEqual([]);
  });
});

describe("migration-minimal archive", () => {
  it("succeeds after full-tree entry-cap failure and restores WAL/DELETE rows and authentication without workspace", async () => {
    const root = fixture();
    for (let i = 0; i < 30; i++) write(root, `state/security-planning/import/${i}`, "scratch");
    await expect(walkStateTreeAsync({ stateDir: root, maxEntries: 12 })).rejects.toMatchObject({ stage: "enumerate" });
    const args = copyArgs(root);
    const result = await createOfflineCopy(args);
    expect(result).toMatchObject({ profile: "migration-minimal", partial: true,
      coverage: { migration: "complete", core: "partial", workspace: "omitted" } });
    expect(result.manifest.alphaclawFormatVersion).toBe(3);
    expect(result.snapshotStartedAt).toBeLessThanOrEqual(result.snapshotCompletedAt);
    expect(result.manifest.snapshotStartedAt).toBe(result.snapshotStartedAt);
    const published = fs.statSync(result.file);
    expect(result.verifiedFileIdentity).toEqual({ dev: published.dev, ino: published.ino, size: published.size, mtimeMs: published.mtimeMs });
    const extracted = temporary();
    execFileSync("tar", ["-xzf", result.file, "-C", extracted]);
    const payload = path.join(extracted, result.manifest.archiveRoot);
    expect(fs.existsSync(path.join(payload, "workspace"))).toBe(false);
    for (const db of result.manifest.assets.filter((asset) => asset.kind === "sqlite")) {
      const connection = new DatabaseSync(path.join(payload, db.archivePath), { readOnly: true });
      expect(connection.prepare("SELECT value FROM t").get().value).toBe("saved");
      expect(connection.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
      connection.close();
    }
    expect(fs.readFileSync(path.join(payload, "identity/device.json"), "utf8")).toContain("device");
    expect(fs.readFileSync(path.join(root, "workspace/keep.md"), "utf8")).toBe("omitted workspace");
  });

  it("consolidates an uncheckpointed WAL into the required database payload", async () => {
    const root = fixture();
    const connection = new DatabaseSync(path.join(root, "state/openclaw.sqlite"));
    try {
      connection.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO t VALUES ('wal-only')");
      expect(fs.statSync(path.join(root, "state/openclaw.sqlite-wal")).size).toBeGreaterThan(0);
      const result = await createOfflineCopy(copyArgs(root));
      const extracted = temporary();
      execFileSync("tar", ["-xzf", result.file, "-C", extracted]);
      const copiedPath = path.join(extracted, result.manifest.archiveRoot, "state/openclaw.sqlite");
      expect(fs.existsSync(`${copiedPath}-wal`)).toBe(false);
      const copied = new DatabaseSync(copiedPath, { readOnly: true });
      expect(copied.prepare("SELECT value FROM t ORDER BY rowid").all().map((row) => row.value)).toEqual(["saved", "wal-only"]);
      copied.close();
    } finally { connection.close(); }
  });

  it("round-trips multiple agents and configured, workspace, skipped-directory, and registered databases with distinct rows", async () => {
    const root = fixture();
    const owners = [
      ["main", "agents/main/agent"],
      ["second", "agents/second/agent"],
      ["custom", "state/owners/custom"],
      ["workspace-owner", "workspace/private"],
      ["scratch-owner", "tmp/configured/agent"],
      ["registered", "tmp/registered"],
    ];
    const expectedRows = new Map([["state/openclaw.sqlite", ["global:first", "global:second"]]]);
    for (const [index, [id, directory]] of owners.entries()) {
      const dbPath = `${directory}/${id === "registered" ? "arbitrary.db" : "openclaw-agent.sqlite"}`;
      if (id !== "main") database(root, dbPath, index % 2 === 0 ? "WAL" : "DELETE");
      expectedRows.set(dbPath, [`${id}:first`, `${id}:second`]);
      write(root, `${directory}/auth-profiles.json`, JSON.stringify({ owner: id }));
    }
    write(root, "openclaw.json", JSON.stringify({ agents: { list: owners.filter(([id]) => id !== "registered").map(([id, directory]) => ({
      id, ...(!["main", "second"].includes(id) ? { agentDir: path.join(root, directory) } : {}),
    })) } }));
    for (const [dbPath, rows] of expectedRows) {
      const source = new DatabaseSync(path.join(root, dbPath));
      try {
        source.exec("DELETE FROM t");
        const insert = source.prepare("INSERT INTO t VALUES (?)");
        for (const row of rows) insert.run(row);
      } finally { source.close(); }
    }
    database(root, "imports/offline/openclaw-agent.sqlite");
    register(root, [["registered", "tmp/registered/arbitrary.db"], ["offline", "imports/offline/openclaw-agent.sqlite"], ["gone", "agents/gone/agent/openclaw-agent.sqlite"]]);
    write(root, "tmp/unrelated-scratch.bin", "omit unrelated scratch");
    write(root, "state/security-planning/stronghold-src/import/unrelated.bin", "omit unrelated imports");
    const result = await createOfflineCopy({ ...copyArgs(root), policy: resolveBackupPolicy({
      excludes: ["private"], rootExcludes: ["state/owners/custom", "workspace/private"],
    }) });
    expect(result.coverage).toEqual({ migration: "complete", core: "partial", workspace: "omitted" });
    expect(result.manifest.assets.filter((asset) => asset.kind === "sqlite").map((asset) => asset.archivePath).sort()).toEqual([...expectedRows.keys()].sort());
    const extracted = temporary();
    execFileSync("tar", ["-xzf", result.file, "-C", extracted]);
    const payload = path.join(extracted, result.manifest.archiveRoot);
    for (const [dbPath, rows] of expectedRows) {
      // A read-only SQLite open can itself create empty WAL sidecars. Check
      // the extracted payload before the validation connection touches it.
      for (const suffix of ["-wal", "-shm", "-journal"]) expect(fs.existsSync(path.join(payload, `${dbPath}${suffix}`))).toBe(false);
      const restored = new DatabaseSync(path.join(payload, dbPath), { readOnly: true });
      try {
        expect(restored.prepare("SELECT value FROM t ORDER BY rowid").all().map((row) => row.value)).toEqual(rows);
        expect(restored.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
        expect(restored.prepare("PRAGMA user_version").get().user_version).toBe(17);
      } finally { restored.close(); }
    }
    for (const [id, directory] of owners) expect(JSON.parse(fs.readFileSync(path.join(payload, directory, "auth-profiles.json"), "utf8"))).toEqual({ owner: id });
    for (const file of ["openclaw.json", "credentials/provider.json", "identity/device.json"]) {
      expect(fs.readFileSync(path.join(payload, file))).toEqual(fs.readFileSync(path.join(root, file)));
    }
    for (const omitted of ["workspace/keep.md", "tmp/unrelated-scratch.bin", "imports/offline/openclaw-agent.sqlite", "state/security-planning"]) {
      expect(fs.existsSync(path.join(payload, omitted))).toBe(false);
    }
  });

  it("rejects a required source disappearing after discovery", async () => {
    const root = fixture();
    const args = copyArgs(root);
    args.sampleLiveProcesses = () => { fs.unlinkSync(path.join(root, "identity/device.json")); return []; };
    await expect(createOfflineCopy(args)).rejects.toMatchObject({ stage: "inventory" });
    expect(fs.readdirSync(args.backupsDir)).toEqual([]);
  });

  it("refuses an atomic config update during copying instead of archiving a config whose selected database is missing", async () => {
    const root = fixture();
    const args = copyArgs(root);
    const configPath = path.join(root, "openclaw.json");
    const nextDb = database(root, "tmp/next-agent/openclaw-agent.sqlite");
    let changed = false;
    args.fsModule = { ...fs, promises: { ...fs.promises, copyFile: async (source, destination) => {
      if (source === configPath && !changed) {
        changed = true;
        updateOpenclawConfig({ openclawDir: root, mutate: (config) => {
          config.agents.list = [{ id: "main", agentDir: path.dirname(nextDb) }];
        } });
      }
      return fs.promises.copyFile(source, destination);
    } } };
    await expect(createOfflineCopy(args)).rejects.toMatchObject({
      stage: "inventory", message: expect.stringContaining("required source changed after discovery: openclaw.json"),
    });
    expect(changed).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).agents.list[0].agentDir).toBe(path.dirname(nextDb));
    expect(fs.readdirSync(args.backupsDir)).toEqual([]);
  });

  it.each(["during-copy", "after-config-read"])("binds config payload to the exact parsed bytes when a same-inode edit preserves metadata (%s)", async (when) => {
    const root = fixture();
    const args = copyArgs(root);
    const configPath = path.join(root, "openclaw.json");
    const priorDb = database(root, "tmp/prior-agent/openclaw-agent.sqlite");
    const nextDb = database(root, "tmp/newer-agent/openclaw-agent.sqlite");
    const config = (db) => JSON.stringify({ agents: { list: [{ id: "main", agentDir: path.dirname(db) }] } });
    const prior = config(priorDb);
    const replacement = config(nextDb);
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(prior));
    fs.writeFileSync(configPath, prior);
    fs.utimesSync(configPath, 1_760_000_000, 1_760_000_000);
    const original = fs.statSync(configPath);
    let changed = false;
    const change = () => {
      if (changed) return;
      changed = true;
      fs.writeFileSync(configPath, replacement);
      fs.utimesSync(configPath, original.atime, original.mtime);
      const actual = fs.statSync(configPath);
      expect([actual.dev, actual.ino, actual.size, actual.mtimeMs]).toEqual([
        original.dev, original.ino, original.size, original.mtimeMs,
      ]);
    };
    args.fsModule = { ...fs,
      readFileSync: (file, ...options) => {
        const bytes = fs.readFileSync(file, ...options);
        if (when === "after-config-read" && file === configPath) change();
        return bytes;
      },
      promises: { ...fs.promises, copyFile: async (source, destination) => {
        if (when === "during-copy" && source === configPath) change();
        return fs.promises.copyFile(source, destination);
      } },
    };
    await expect(createOfflineCopy(args)).rejects.toMatchObject({
      stage: "inventory", message: expect.stringContaining("required source content changed after discovery: openclaw.json"),
    });
    expect(changed).toBe(true);
    expect(fs.readFileSync(configPath, "utf8")).toBe(replacement);
    expect(fs.readdirSync(args.backupsDir)).toEqual([]);
  });

  it("refuses a required credential file replaced during its asynchronous copy", async () => {
    const root = fixture();
    const args = copyArgs(root);
    const credentialsPath = path.join(root, "credentials/provider.json");
    args.fsModule = { ...fs, promises: { ...fs.promises, copyFile: async (source, destination) => {
      if (source === credentialsPath) {
        const replacement = path.join(root, "credentials/provider.next");
        fs.writeFileSync(replacement, '{"secret":"new credential"}');
        fs.renameSync(replacement, credentialsPath);
      }
      return fs.promises.copyFile(source, destination);
    } } };
    await expect(createOfflineCopy(args)).rejects.toMatchObject({
      stage: "inventory", message: expect.stringContaining("required source changed after discovery: credentials/provider.json"),
    });
    expect(fs.readFileSync(credentialsPath, "utf8")).toContain("new credential");
    expect(fs.readdirSync(args.backupsDir)).toEqual([]);
  });

  it("refuses publication after the lifecycle lease is revoked during verification", async () => {
    const root = fixture();
    const args = copyArgs(root);
    let valid = true;
    args.isLeaseValid = () => valid;
    args.runCommand = async (spec) => { const result = await command(spec); if (spec.args[0] === "-tvzf") valid = false; return result; };
    await expect(createOfflineCopy(args)).rejects.toMatchObject({ stage: "lease_lost" });
    expect(fs.readdirSync(args.backupsDir)).toEqual([]);
  });

  it("refuses an archive replaced between successful verification commands", async () => {
    const root = fixture();
    const args = copyArgs(root);
    args.runCommand = async (spec) => {
      const result = await command(spec);
      if (spec.command === "gzip" && spec.args[0] === "-t") {
        const replacement = path.join(temporary(), "replacement.tar.gz");
        fs.copyFileSync(spec.args[1], replacement);
        fs.renameSync(replacement, spec.args[1]);
      }
      return result;
    };
    await expect(createOfflineCopy(args)).rejects.toMatchObject({ stage: "verify", message: expect.stringContaining("changed during verification") });
    expect(fs.readdirSync(args.backupsDir)).toEqual([]);
  });

  it("checks required payload members rather than trusting the manifest", async () => {
    const root = fixture();
    const result = await createOfflineCopy(copyArgs(root));
    const extracted = temporary();
    execFileSync("tar", ["-xzf", result.file, "-C", extracted]);
    fs.unlinkSync(path.join(extracted, result.manifest.archiveRoot, "identity/device.json"));
    const altered = path.join(temporary(), "altered.tar.gz");
    execFileSync("tar", ["-czf", altered, "-C", extracted, result.manifest.archiveRoot]);
    await expect(verifyArchiveManifest({ file: altered, runCommand: command, requiredAssets: result.manifest.requiredAssets })).resolves.toMatchObject({ ok: false, stage: "assets", reason: expect.stringContaining("identity/device.json") });
  });

  it("disables both policy scopes when required source inventory is unavailable", async () => {
    const root = fixture();
    write(root, "openclaw.json", '{"$include":"other.json"}');
    write(root, "workspace/custom/keep.tmp", "required source may be configured here");
    write(root, "state/custom/keep.txt", "required source may be configured here");
    const policy = resolveBackupPolicy({ excludes: ["custom"], rootExcludes: ["state/custom", "state/*"] });
    const result = await createOfflineCopy({ ...copyArgs(root), profile: "full", policy });
    expect(result.coverage.migration).toBe("unknown");
    expect(result.manifest.assets.map((entry) => entry.archivePath)).toEqual(expect.arrayContaining(["workspace/custom/keep.tmp", "state/custom/keep.txt"]));
    expect(result.refusedExcludes).toEqual(expect.arrayContaining([
      expect.objectContaining({ pattern: "custom", reason: "protected source inventory is unavailable" }),
      expect.objectContaining({ scope: "root", pattern: "state/custom", reason: "protected source inventory is unavailable" }),
      expect.objectContaining({ scope: "root", pattern: "state/*" }),
    ]));
  });

  it("bounds existing and inventory-unavailable refusals across both scopes", async () => {
    const root = fixture();
    write(root, "openclaw.json", '{"$include":"other.json"}');
    const policy = resolveBackupPolicy({
      excludes: [...Array.from({ length: 32 }, (_, index) => `/invalid-${index}`), ...Array.from({ length: 32 }, (_, index) => `junk-${index}`)],
      rootExcludes: Array.from({ length: 64 }, (_, index) => `state/cache-${index}`),
    });
    const result = await createOfflineCopy({ ...copyArgs(root), profile: "full", policy });
    expect(result.refusedExcludes).toHaveLength(65);
    expect(result.refusedExcludes.at(-1).omittedCount).toBe(64);
    expect(result.refusedExcludes.every((entry) => entry.pattern.length <= 256 && entry.reason.length <= 512)).toBe(true);
  });

  it("refuses a state-root manifest instead of overwriting a declared payload", async () => {
    const root = fixture();
    write(root, "manifest.json", '{"must":"survive"}');
    const args = { ...copyArgs(root), profile: "full" };
    await expect(createOfflineCopy(args)).rejects.toMatchObject({ stage: "inventory", message: expect.stringContaining("conflicts") });
    expect(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).toBe('{"must":"survive"}');
    expect(fs.readdirSync(args.backupsDir)).toEqual([]);
  });

  it("rejects a truncated extraction even if its retained tail parses as a valid manifest", async () => {
    const root = fixture();
    const result = await createOfflineCopy(copyArgs(root));
    await expect(verifyArchiveManifest({ file: result.file, requiredAssets: result.manifest.requiredAssets,
      runCommand: async (spec) => ({ ...await command(spec), ...(spec.args[0] === "-xzOf" ? { truncated: true } : {}) }),
    })).resolves.toMatchObject({ ok: false, stage: "manifest", reason: expect.stringContaining("truncated") });
  });

  it.each(["directory", "foreign", "duplicate", "traversal", "missing-inventory", "coverage", "interval"])
    ("rejects a forged format-3 %s declaration", async (kind) => {
      const root = fixture();
      const result = await createOfflineCopy(copyArgs(root));
      const manifest = structuredClone(result.manifest);
      if (kind === "directory") manifest.assets[0].kind = "state";
      if (kind === "foreign") manifest.assets[0].sourcePath = "/another/state/openclaw.sqlite";
      if (kind === "duplicate") manifest.assets.push(manifest.assets[0]);
      if (kind === "traversal") manifest.assets[0].archivePath = "../openclaw.sqlite";
      if (kind === "missing-inventory") manifest.requiredAssets = [null];
      if (kind === "coverage") manifest.coverage.workspace = "complete";
      if (kind === "interval") manifest.snapshotCompletedAt = manifest.snapshotStartedAt - 1;
      await expect(verifyFormat3Payload({ manifest, requiredAssets: result.manifest.requiredAssets, file: result.file,
        runCommand: command, timeoutMs: 10000 })).resolves.toMatchObject({ ok: false, stage: "assets" });
    });
});

describe("complete format-3 payload verification", () => {
  const fixtureManifest = () => {
    const assets = [
      { kind: "config", sourcePath: "/state/openclaw.json", archivePath: "openclaw.json" },
      { kind: "workspace", sourcePath: "/state/workspace/note.md", archivePath: "workspace/note.md" },
    ];
    return { schemaVersion: 1, profile: "full", archiveRoot: "backup", snapshotStartedAt: 1, snapshotCompletedAt: 2,
      paths: { stateDir: "/state" }, assets, requiredAssets: structuredClone(assets) };
  };
  const member = (name, type = "-") => `${type}rw-r--r-- 0/0 4 2026-09-16 12:00:00 backup/${name}\n`;
  const completeListing = () => member("manifest.json") + member("openclaw.json") + member("workspace/note.md");
  const verify = (manifest, tail, extra = {}) => verifyFormat3Payload({ manifest, file: "/unused.tar.gz", timeoutMs: 1000,
    runCommand: async () => ({ ok: true, tail, ...extra }) });

  it("refuses a truncated listing whose retained tail contains all expected files", async () => {
    await expect(verify(fixtureManifest(), completeListing(), { truncated: true }))
      .resolves.toMatchObject({ ok: false, reason: expect.stringContaining("truncated") });
  });

  it("checks workspace payloads independently of core migration inventory", async () => {
    await expect(verify(fixtureManifest(), member("manifest.json") + member("openclaw.json")))
      .resolves.toMatchObject({ ok: false, reason: expect.stringContaining("workspace/note.md") });
    const manifest = fixtureManifest();
    manifest.requiredAssets.pop();
    await expect(verify(manifest, completeListing()))
      .resolves.toMatchObject({ ok: false, reason: expect.stringContaining("complete required inventory") });
  });

  it.each([
    ["duplicate", () => member("openclaw.json")],
    ["undeclared file", () => member("other")],
    ["undeclared directory", () => member("other/", "d")],
    ["symlink", () => member("link -> openclaw.json", "l")],
    ["hardlink", () => member("link link to backup/openclaw.json", "h")],
    ["outside root", () => member("../outside")],
    ["regular file with a directory suffix", () => member("openclaw.json/")],
  ])("refuses a %s archive member", async (_kind, extra) => {
    await expect(verify(fixtureManifest(), completeListing() + extra())).resolves.toMatchObject({ ok: false, stage: "assets" });
  });

  it("requires an actual manifest file and reserves it from source assets", async () => {
    await expect(verify(fixtureManifest(), member("openclaw.json") + member("workspace/note.md")))
      .resolves.toMatchObject({ ok: false, reason: expect.stringContaining("manifest") });
    const manifest = fixtureManifest();
    manifest.assets.push({ kind: "file", sourcePath: "/state/manifest.json", archivePath: "manifest.json" });
    manifest.requiredAssets = structuredClone(manifest.assets);
    await expect(verify(manifest, completeListing())).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("invalid") });
  });

  it("cannot establish minimal coverage from an archive's own requiredAssets declaration", async () => {
    const manifest = fixtureManifest();
    Object.assign(manifest, { profile: "migration-minimal", partial: true, options: { includeWorkspace: false },
      coverage: { migration: "complete", core: "partial", workspace: "omitted" } });
    await expect(verify(manifest, completeListing())).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("independent") });
  });

  it("rejects duplicate expected identities that would conceal a missing required file", async () => {
    const manifest = fixtureManifest();
    await expect(verifyFormat3Payload({ manifest, requiredAssets: [manifest.assets[0], manifest.assets[0]], file: "/unused.tar.gz",
      runCommand: async () => ({ ok: true, tail: completeListing() }), timeoutMs: 1000,
    })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("duplicate independent") });
  });

  it("preserves leading spaces in archive root names", async () => {
    const manifest = fixtureManifest();
    manifest.archiveRoot = " backup";
    await expect(verify(manifest, completeListing().replaceAll("backup/", " backup/"))).resolves.toEqual({ ok: true });
  });
});
