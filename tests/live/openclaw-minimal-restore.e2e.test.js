// Issue #99: selective migration coverage must restore over an existing root,
// and a >200k-entry scratch tree cannot consume the final copy's inventory.
// Real immutable OpenClaw databases/CLIs, SQLite WAL frames, and 2 GiB of
// incompressible payload; fixtures are removed in-test and by the live sweep.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const live = require("./live-helpers");
process.env.ALPHACLAW_ROOT_DIR = live.mkTemp("alphaclaw-live-minimal-root-");
delete process.env.OPENCLAW_GIT_DIR;
const { buildCliEnv } = require("./live-backup-harness");
const { databasePaths, readDatabaseSchema } = require("./database-fixture");
const { kCopyBudgetMs, writeFile, createSource, sourceJournal, leaveCommittedWal,
  produceCopy, restoreCapturedAssets, bootAndStop } = require("./minimal-restore-helpers");

const describeLive = live.kLiveEnabled ? describe : describe.skip;
const cleanupSource = (source) => {
  if (!source) return;
  for (const directory of [...(source.archiveDirs || []), source.homeDir]) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};
const readFixtureValue = (file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare("SELECT value FROM alphaclaw_backup_fixture WHERE id = 1").get().value; }
  finally { db.close(); }
};
const preservedFiles = Object.freeze({
  "workspace/omitted.txt": "newer workspace must survive",
  "security-planning/retained.txt": "newer scratch must survive",
  "agents/main/sessions/retained.jsonl": "newer transcript must survive",
});
const assertPreserved = (destination) => {
  for (const [relative, contents] of Object.entries(preservedFiles)) {
    expect(fs.readFileSync(path.join(destination.stateDir, relative), "utf8")).toBe(contents);
  }
};

describeLive("migration-minimal existing-state restore", () => {
  // Both suites pin the 2026.9.3 schema pair (state 16 / agent 19) and the
  // second one migrates to 2026.9.4, so the SOURCE release is staged
  // explicitly rather than borrowed from the repo bin (the pin moves; it is
  // 2026.9.5 since v0.9.88).
  const kSourceRelease = "2026.9.3";
  it.each(["wal", "delete"])("restores %s snapshots over newer databases and stale sidecars while preserving omitted files", async (journal) => {
    live.assertFreeDiskBytes();
    const bin = (await live.stageOpenclawVersion(kSourceRelease)).bin;
    let source;
    let destination;
    try {
      source = createSource(bin);
      for (const file of Object.values(source.paths)) sourceJournal(file, journal);
      const copy = await produceCopy(source);
      expect(copy).toMatchObject({ ok: true, profile: "migration-minimal", partial: true,
        coverage: { migration: "complete", core: "partial", workspace: "omitted" } });
      expect(copy.manifest.alphaclawFormatVersion).toBe(3);
      expect(copy.snapshotCompletedAt).toBeGreaterThanOrEqual(copy.snapshotStartedAt);
      expect(copy.manifest.assets.some((asset) => asset.sourcePath.includes("/workspace/"))).toBe(false);

      const homeDir = live.mkTemp("alphaclaw-live-minimal-existing-");
      destination = { homeDir, stateDir: path.join(homeDir, ".openclaw") };
      destination.paths = databasePaths(destination.stateDir);
      fs.cpSync(source.stateDir, destination.stateDir, { recursive: true });
      for (const [relative, contents] of Object.entries(preservedFiles)) writeFile(path.join(destination.stateDir, relative), contents);
      writeFile(path.join(destination.stateDir, "credentials", "restore-fixture.json"), '{"fixture":"newer"}');
      for (const file of Object.values(destination.paths)) {
        leaveCommittedWal(file, "newer-destination");
        expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);
        expect(fs.existsSync(`${file}-shm`)).toBe(true);
      }

      const restored = restoreCapturedAssets(copy.file, destination);
      expect(restored.profile).toBe("migration-minimal");
      for (const [kind, file] of Object.entries(destination.paths)) {
        // Check before opening SQLite: stale sidecars must have been saved
        // and removed, rather than replayed onto the captured standalone DB.
        for (const suffix of ["-wal", "-shm", "-journal"]) expect(fs.existsSync(`${file}${suffix}`)).toBe(false);
        const saved = path.join(homeDir, "saved-before-restore", path.relative(destination.stateDir, file));
        expect(fs.statSync(`${saved}-wal`).size).toBeGreaterThan(0);
        expect(readFixtureValue(file)).toBe("captured");
        expect(readDatabaseSchema(file)).toMatchObject({ version: kind === "state" ? 16 : 19, integrity: "ok" });
      }
      expect(fs.readFileSync(path.join(destination.stateDir, "credentials", "restore-fixture.json"), "utf8")).toBe('{"fixture":"captured"}');
      assertPreserved(destination);
      const preflight = live.runCliJson(bin, ["database", "preflight", destination.paths.state, "--json"], { env: buildCliEnv(destination) });
      expect(preflight).toMatchObject({ status: "exact", foundVersion: 16, targetVersion: 16 });
      await bootAndStop(bin, destination);
      for (const file of Object.values(destination.paths)) {
        expect(readFixtureValue(file)).toBe("captured");
        expect(readDatabaseSchema(file).integrity).toBe("ok");
      }
      assertPreserved(destination);
    } finally {
      cleanupSource(destination);
      cleanupSource(source);
    }
  }, 5 * 60_000);

  it("backs up a 2 GiB database after the full walk hits 200k scratch entries, then migrates 2026.9.3 to 2026.9.4", async () => {
    // Source + SQLite snapshot + incompressible archive/verification plus
    // the immutable target install. The cache is deliberately not swept.
    live.assertFreeDiskBytes(14 * 1024 ** 3, { label: "migration-minimal production-scale fixture" });
    const target = await live.stageOpenclawVersion("2026.9.4");
    console.log(`[minimal-scale] target 2026.9.4 staged (cache=${target.fromCache})`);
    const pkg = JSON.parse(fs.readFileSync(path.join(target.packageDir, "package.json"), "utf8"));
    const declaredSchemas = pkg.openclaw.schemaVersions;
    let source;
    const payloadBytes = 2 * 1024 ** 3;
    const chunkBytes = 1024 ** 2;
    const scratchEntries = 200_050;
    try {
      source = createSource((await live.stageOpenclawVersion(kSourceRelease)).bin);
      const db = new DatabaseSync(source.paths.agent);
      try {
        db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE alphaclaw_scale_payload (id INTEGER PRIMARY KEY, body BLOB NOT NULL)");
        const insert = db.prepare("INSERT INTO alphaclaw_scale_payload VALUES (?, ?)");
        for (let first = 0; first < payloadBytes / chunkBytes; first += 64) {
          db.exec("BEGIN");
          for (let index = first; index < first + 64; index += 1) insert.run(index, crypto.randomBytes(chunkBytes));
          db.exec("COMMIT");
        }
      } finally { db.close(); }
      expect(fs.statSync(source.paths.agent).size).toBeGreaterThanOrEqual(payloadBytes);
      const scratchRoot = path.join(source.stateDir, "security-planning", "stronghold-import");
      for (let index = 0; index < scratchEntries; index += 1) {
        const directory = path.join(scratchRoot, String(Math.floor(index / 1_000)));
        if (index % 1_000 === 0) fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, `scratch-${index}`), "x");
      }
      console.log(`[minimal-scale] generated ${scratchEntries} scratch files and ${payloadBytes} SQLite payload bytes`);
      let fullError;
      try { await produceCopy(source, { profile: "full" }); } catch (error) { fullError = error; }
      expect(fullError).toMatchObject({ stage: "enumerate" });
      expect(fullError.message).toContain("200000 entries");
      expect(fullError.diagnostics.topEntries.some((entry) => entry.path === "security-planning")).toBe(true);
      console.log("[minimal-scale] full walk refused at its entry cap; beginning minimal copy");
      const copy = await produceCopy(source);
      expect(copy).toMatchObject({ ok: true, profile: "migration-minimal", coverage: { migration: "complete", workspace: "omitted" } });
      expect(copy.durationMs).toBeLessThan(kCopyBudgetMs);
      expect(fs.statSync(copy.file).size).toBeGreaterThan(payloadBytes * 0.95);
      expect(copy.manifest.assets.some((asset) => asset.sourcePath.startsWith(scratchRoot))).toBe(false);
      console.log(`[minimal-scale] minimal archive verified in ${copy.durationMs} ms; beginning target preflight`);

      // The inventory's read-only source open may create an empty WAL/SHM.
      // This stopped-fixture helper removes those only if no WAL frames
      // exist; never discard committed frames to make preflight pass.
      expect(readDatabaseSchema(source.paths.state)).toMatchObject({ version: 16, integrity: "ok" });
      const preflight = live.runCliJson(target.bin, ["database", "preflight", source.paths.state, "--json"], { env: buildCliEnv(source) });
      expect(preflight).toMatchObject({ status: "migration-required", foundVersion: 16, targetVersion: declaredSchemas.state });
      const migrated = spawnSync(process.execPath, [target.bin, "doctor", "--fix", "--non-interactive"], {
        env: live.scrubTestRunnerEnv(buildCliEnv(source)), encoding: "utf8", timeout: 6 * 60_000, maxBuffer: 16 * 1024 * 1024,
      });
      expect(migrated.error, `${migrated.stderr}\n${migrated.stdout}`).toBeUndefined();
      expect(migrated.status, `${migrated.stderr}\n${migrated.stdout}`).toBe(0);
      await bootAndStop(target.bin, source);
      for (const [kind, file] of Object.entries(source.paths)) {
        expect(readDatabaseSchema(file)).toMatchObject({ version: declaredSchemas[kind], integrity: "ok" });
      }
      const restoredPayload = new DatabaseSync(source.paths.agent, { readOnly: true });
      try {
        expect(restoredPayload.prepare("SELECT count(*) AS rows, sum(length(body)) AS bytes FROM alphaclaw_scale_payload").get())
          .toMatchObject({ rows: payloadBytes / chunkBytes, bytes: payloadBytes });
      } finally { restoredPayload.close(); }
      console.log(`[minimal-scale] scratch=${scratchEntries} agentBytes=${fs.statSync(source.paths.agent).size} ` +
        `archiveBytes=${fs.statSync(copy.file).size} copyMs=${copy.durationMs} schemas=16/19→${declaredSchemas.state}/${declaredSchemas.agent}`);
    } finally {
      cleanupSource(source);
    }
  }, 30 * 60_000);
});
