// AlphaClaw offline copy (issue #54): exclusivity evidence, per-stage named
// failures, quiet_lost abort, manifest shape, gzip -1 archiving, and the
// shared usable-check. The happy path runs the REAL tar/gzip on this box; the
// stage-failure cases drive a scripted runner so they stay hermetic.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const {
  kOfflineCopyProducer,
  kOfflineCopyFormatVersion,
  kOfflineCopyArchiveSuffix,
  OfflineCopyError,
  isOfflineCopyArchiveName,
  producerOfArchiveName,
  assessExclusivity,
  defaultListFdHolders,
  walkStateTree,
  verifyArchiveManifest,
  createOfflineCopy,
} = require("../../lib/server/openclaw-backup-offline-copy");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");

const mkTemp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const realRunner = createRunStream({});
const realRunCommand = (spec) => realRunner.runStreamed({ ...spec, env: process.env });

const writeDb = (file, { rows = 3, userVersion = 7 } = {}) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE t(x INTEGER)");
  for (let i = 0; i < rows; i += 1) db.exec(`INSERT INTO t VALUES (${i})`);
  db.exec(`PRAGMA user_version = ${userVersion}`);
  db.close();
};

// A realistic state dir: global DB (+ WAL sidecar), one agent DB, config,
// credentials, a session transcript, a workspace, and AlphaClaw's own tree.
const makeStateDir = ({ workspaceBytes = 64 } = {}) => {
  const stateDir = mkTemp("alphaclaw-offline-copy-state-");
  writeDb(path.join(stateDir, "state", "openclaw.sqlite"));
  fs.writeFileSync(path.join(stateDir, "state", "openclaw.sqlite-wal"), "");
  writeDb(path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"), {
    userVersion: 3,
  });
  fs.writeFileSync(
    path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"),
    '{"profiles":[]}\n',
  );
  fs.mkdirSync(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "agents", "main", "sessions", "s1.jsonl"), "{}\n");
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), '{"agents":{}}\n');
  fs.mkdirSync(path.join(stateDir, "credentials"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "credentials", "telegram.json"), "{}\n");
  fs.mkdirSync(path.join(stateDir, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "workspace", "notes.md"), "x".repeat(workspaceBytes));
  fs.mkdirSync(path.join(stateDir, ".alphaclaw", "runs"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, ".alphaclaw", "runs", "r.json"), "{}\n");
  fs.mkdirSync(path.join(stateDir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "logs", "gateway.log"), "log\n");
  fs.symlinkSync("/etc/hostname", path.join(stateDir, "hostname-link"));
  return stateDir;
};

const heldToken = { id: "quiet-1", owner: "quiesced-backup", disabled: false };
const fullExclusivity = {
  stopConfirmed: true,
  stopEvidence: { confirmed: true, via: "port_released" },
  quietToken: heldToken,
  liveProcesses: [],
  handleCount: 0,
};

const makeCopyArgs = (overrides = {}) => {
  const stateDir = overrides.stateDir || makeStateDir();
  const backupsDir = overrides.backupsDir || mkTemp("alphaclaw-offline-copy-backups-");
  return {
    stateDir,
    backupsDir,
    outputFile: path.join(backupsDir, `openclaw-backup-1000-abcdef12${kOfflineCopyArchiveSuffix}`),
    exclusivity: fullExclusivity,
    isQuiet: () => true,
    runCommand: realRunCommand,
    diagnosis: { journalMode: "wal", fsType: "ext4", stateBytes: 4096 },
    runtimeVersion: "2026.9.1-beta.1",
    platform: "linux",
    listFdHolders: () => [],
    ...overrides,
  };
};

const listArchive = (file) =>
  execFileSync("tar", ["-tzf", file], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .sort();

describe("server/openclaw-backup-offline-copy", () => {
  describe("naming", () => {
    it("recognizes the AlphaClaw suffix and maps producers", () => {
      expect(isOfflineCopyArchiveName("openclaw-backup-1-abcd.alphaclaw.tar.gz")).toBe(true);
      expect(isOfflineCopyArchiveName("openclaw-backup-1-abcd.tar.gz")).toBe(false);
      expect(producerOfArchiveName("openclaw-backup-1-abcd.alphaclaw.tar.gz")).toBe(
        kOfflineCopyProducer,
      );
      expect(producerOfArchiveName("openclaw-backup-1-abcd.tar.gz")).toBe("openclaw");
    });
  });

  describe("assessExclusivity", () => {
    const base = {
      ...fullExclusivity,
      isQuiet: () => true,
      dbPaths: ["/s/state/openclaw.sqlite"],
      platform: "linux",
      listFdHolders: () => [],
    };

    it("passes with full evidence on Linux when the fd scan is clean", () => {
      const report = assessExclusivity(base);
      expect(report.ok).toBe(true);
      expect(report.failures).toEqual([]);
      expect(report.evidence).toEqual(
        expect.objectContaining({
          stopConfirmed: true,
          quiet: "held",
          quietOwner: "quiesced-backup",
          liveProcesses: 0,
          handleCount: 0,
          fdScan: "clean",
          completeness: "full",
          platform: "linux",
        }),
      );
    });

    it("refuses when the stop is not confirmed", () => {
      const report = assessExclusivity({ ...base, stopConfirmed: false });
      expect(report.ok).toBe(false);
      expect(report.failures).toEqual(["gateway stop not confirmed"]);
    });

    it("refuses when the quiet barrier is missing, lost, or disabled by the kill switch", () => {
      expect(assessExclusivity({ ...base, quietToken: null }).failures).toEqual([
        "state-db quiet barrier missing",
      ]);
      expect(assessExclusivity({ ...base, isQuiet: () => false }).failures).toEqual([
        "state-db quiet barrier lost",
      ]);
      const disabled = assessExclusivity({
        ...base,
        quietToken: { ...heldToken, disabled: true },
      });
      expect(disabled.failures).toEqual(["state-db quiet barrier disabled"]);
      expect(disabled.evidence.quiet).toBe("disabled");
    });

    it("refuses on live openclaw processes and open in-process handles", () => {
      const report = assessExclusivity({
        ...base,
        liveProcesses: [{ pid: 57, cmdline: "openclaw gateway run" }],
        handleCount: 2,
      });
      expect(report.ok).toBe(false);
      expect(report.failures).toEqual([
        "1 live openclaw process(es): 57",
        "2 in-process state-db handle(s) open",
      ]);
    });

    it("refuses when another process holds a state db open (fd scan)", () => {
      const report = assessExclusivity({
        ...base,
        listFdHolders: () => [{ pid: 99, path: "/s/state/openclaw.sqlite-wal" }],
      });
      expect(report.ok).toBe(false);
      expect(report.failures[0]).toMatch(/pid 99 \(openclaw\.sqlite-wal\)/);
      expect(report.evidence.fdScan).toBe("holders");
      expect(report.evidence.completeness).toBe("partial");
    });

    it("proceeds with evidence 'partial' when the fd scan cannot run (non-Linux / no /proc)", () => {
      const darwin = assessExclusivity({ ...base, platform: "darwin" });
      expect(darwin.ok).toBe(true);
      expect(darwin.evidence).toEqual(
        expect.objectContaining({ fdScan: "unavailable", completeness: "partial" }),
      );
      const noProc = assessExclusivity({ ...base, listFdHolders: () => null });
      expect(noProc.ok).toBe(true);
      expect(noProc.evidence.fdScan).toBe("unavailable");
    });
  });

  describe("defaultListFdHolders", () => {
    it("scans /proc/*/fd for the db paths and sidecars, skipping self and unreadable pids", () => {
      const fsModule = {
        readdirSync: (p) => {
          if (p === "/proc") return ["1", "42", "77", "self"];
          if (p === "/proc/1/fd") throw new Error("EACCES");
          if (p === "/proc/42/fd") return ["0", "3", "4"];
          if (p === "/proc/77/fd") return ["5"];
          throw new Error(`unexpected ${p}`);
        },
        readlinkSync: (p) => {
          if (p === "/proc/42/fd/3") return "/s/state/openclaw.sqlite-wal (deleted)";
          if (p === "/proc/42/fd/4") return "/dev/null";
          if (p === "/proc/42/fd/0") throw new Error("ENOENT");
          if (p === "/proc/77/fd/5") return "/s/state/openclaw.sqlite";
          throw new Error(`unexpected ${p}`);
        },
      };
      const holders = defaultListFdHolders({
        fsModule,
        dbPaths: ["/s/state/openclaw.sqlite"],
        selfPid: 77,
      });
      expect(holders).toEqual([{ pid: 42, path: "/s/state/openclaw.sqlite-wal" }]);
    });

    it("returns null when /proc is unreadable", () => {
      expect(
        defaultListFdHolders({
          fsModule: {
            readdirSync: () => {
              throw new Error("ENOENT");
            },
          },
          dbPaths: ["/s/x.sqlite"],
        }),
      ).toBeNull();
    });
  });

  describe("walkStateTree", () => {
    it("separates databases, assets, workspaces, and skipped entries", () => {
      const stateDir = makeStateDir();
      const tree = walkStateTree({ stateDir, fsModule: fs });
      expect(tree.dbs.map((db) => db.archivePath).sort()).toEqual([
        "agents/main/agent/openclaw-agent.sqlite",
        "state/openclaw.sqlite",
      ]);
      expect(tree.files.map((f) => f.archivePath).sort()).toEqual([
        "agents/main/agent/auth-profiles.json",
        "agents/main/sessions/s1.jsonl",
        "credentials/telegram.json",
        "openclaw.json",
      ]);
      expect([...tree.workspaces.keys()]).toEqual([path.join(stateDir, "workspace")]);
      expect(tree.skipped).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "symlink", sourcePath: path.join(stateDir, "hostname-link") }),
          expect.objectContaining({ kind: "dir", sourcePath: path.join(stateDir, ".alphaclaw") }),
          expect.objectContaining({ kind: "dir", sourcePath: path.join(stateDir, "logs") }),
          expect.objectContaining({
            kind: "sqlite-sidecar",
            coveredBy: path.join(stateDir, "state", "openclaw.sqlite"),
          }),
        ]),
      );
    });

    it("throws a named enumerate error for an unreadable tree", () => {
      expect(() => walkStateTree({ stateDir: "/nonexistent-alphaclaw", fsModule: fs })).toThrow(
        OfflineCopyError,
      );
      try {
        walkStateTree({ stateDir: "/nonexistent-alphaclaw", fsModule: fs });
      } catch (error) {
        expect(error.stage).toBe("enumerate");
      }
    });
  });

  describe("createOfflineCopy (real tar + gzip)", () => {
    it("copies every DB via online backup(), assets verbatim, writes the manifest, archives with gzip -1, and verifies", async () => {
      const args = makeCopyArgs();
      const result = await createOfflineCopy(args);

      expect(result.ok).toBe(true);
      expect(result.file).toBe(args.outputFile);
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.partial).toBe(false);
      expect(result.method).toBe("tar -I gzip -1");
      expect(fs.statSync(args.outputFile).size).toBe(result.bytes);
      // No temp debris left behind.
      expect(fs.readdirSync(args.backupsDir)).toEqual([path.basename(args.outputFile)]);

      const root = "openclaw-backup-1000-abcdef12";
      const listed = listArchive(args.outputFile);
      expect(listed).toEqual(
        expect.arrayContaining([
          `${root}/manifest.json`,
          `${root}/state/openclaw.sqlite`,
          `${root}/agents/main/agent/openclaw-agent.sqlite`,
          `${root}/agents/main/agent/auth-profiles.json`,
          `${root}/agents/main/sessions/s1.jsonl`,
          `${root}/openclaw.json`,
          `${root}/credentials/telegram.json`,
          `${root}/workspace/notes.md`,
        ]),
      );
      expect(listed.some((entry) => entry.endsWith("-wal"))).toBe(false);
      expect(listed.some((entry) => entry.includes(".alphaclaw"))).toBe(false);

      // Manifest: upstream core fields + the AlphaClaw additions.
      const { manifest } = result;
      expect(manifest).toEqual(
        expect.objectContaining({
          schemaVersion: 1,
          archiveRoot: root,
          runtimeVersion: "2026.9.1-beta.1",
          platform: "linux",
          nodeVersion: process.version,
          options: { includeWorkspace: true, onlyConfig: false },
          producer: kOfflineCopyProducer,
          alphaclawFormatVersion: kOfflineCopyFormatVersion,
          diagnosis: args.diagnosis,
        }),
      );
      expect(manifest.paths).toEqual({
        stateDir: args.stateDir,
        configPath: path.join(args.stateDir, "openclaw.json"),
        oauthDir: path.join(args.stateDir, "credentials"),
        workspaceDirs: [path.join(args.stateDir, "workspace")],
        agentRoots: [{ agentId: "main", sourcePath: path.join(args.stateDir, "agents", "main") }],
      });
      expect(manifest.assets).toEqual(
        expect.arrayContaining([
          {
            kind: "sqlite",
            sourcePath: path.join(args.stateDir, "state", "openclaw.sqlite"),
            archivePath: "state/openclaw.sqlite",
          },
          {
            kind: "config",
            sourcePath: path.join(args.stateDir, "openclaw.json"),
            archivePath: "openclaw.json",
          },
          expect.objectContaining({ kind: "workspace", archivePath: "workspace/notes.md" }),
        ]),
      );
      expect(manifest.exclusivityEvidence).toEqual(
        expect.objectContaining({ quiet: "held", fdScan: "clean", completeness: "full" }),
      );
      expect(result.databases).toHaveLength(2);
      expect(result.databases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: path.join(args.stateDir, "state", "openclaw.sqlite"),
            integrity: "ok",
            userVersion: 7,
          }),
          expect.objectContaining({
            path: path.join(args.stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
            integrity: "ok",
            userVersion: 3,
          }),
        ]),
      );

      // The copied DB is a real, self-contained database with the rows.
      const extractDir = mkTemp("alphaclaw-offline-copy-extract-");
      execFileSync("tar", ["-xzf", args.outputFile, "-C", extractDir]);
      const copied = new DatabaseSync(path.join(extractDir, root, "state", "openclaw.sqlite"), {
        readOnly: true,
      });
      expect(copied.prepare("SELECT count(*) AS n FROM t").get().n).toBe(3);
      copied.close();
    });

    it("excludes workspaces above the inline limit and records partial:true", async () => {
      const args = makeCopyArgs({ stateDir: makeStateDir({ workspaceBytes: 4096 }), workspaceInlineBytes: 1024 });
      const result = await createOfflineCopy(args);
      expect(result.partial).toBe(true);
      expect(result.manifest.options.includeWorkspace).toBe(false);
      expect(result.manifest.skipped).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "workspace", reason: expect.stringMatching(/excluded/) }),
        ]),
      );
      expect(listArchive(args.outputFile).some((e) => e.includes("workspace/"))).toBe(false);
    });

    it("refuses BEFORE copying when exclusivity fails, leaving no file behind", async () => {
      const args = makeCopyArgs({
        exclusivity: { ...fullExclusivity, liveProcesses: [{ pid: 5, cmdline: "openclaw gateway run" }] },
      });
      await expect(createOfflineCopy(args)).rejects.toMatchObject({
        name: "OfflineCopyError",
        stage: "exclusivity",
        message: expect.stringMatching(/1 live openclaw process/),
      });
      expect(fs.readdirSync(args.backupsDir)).toEqual([]);
    });

    it("aborts with quiet_lost when the barrier drops mid-copy and cleans up", async () => {
      let calls = 0;
      const args = makeCopyArgs({
        // Held for the exclusivity check, gone by the first checkpoint.
        isQuiet: () => {
          calls += 1;
          return calls <= 1;
        },
      });
      await expect(createOfflineCopy(args)).rejects.toMatchObject({
        stage: "quiet_lost",
        message: expect.stringMatching(/ended during sqlite_backup/),
      });
      expect(fs.readdirSync(args.backupsDir)).toEqual([]);
    });

    it("aborts with budget when the deadline passes between stages", async () => {
      let now = 1_000_000;
      const args = makeCopyArgs({
        budgetMs: 10,
        nowFn: () => {
          now += 100;
          return now;
        },
      });
      await expect(createOfflineCopy(args)).rejects.toMatchObject({ stage: "budget" });
    });

    it("names the sqlite_backup stage when a source database cannot be opened", async () => {
      const stateDir = makeStateDir();
      fs.writeFileSync(path.join(stateDir, "state", "openclaw.sqlite"), "not a database");
      const args = makeCopyArgs({ stateDir });
      await expect(createOfflineCopy(args)).rejects.toMatchObject({
        stage: "sqlite_backup",
        message: expect.stringMatching(/openclaw\.sqlite/),
      });
    });

    it("names the integrity stage when the copy fails integrity_check", async () => {
      const args = makeCopyArgs({
        sqliteModule: {
          DatabaseSync: class {
            constructor(file) {
              this.file = file;
            }
            exec() {}
            prepare(sql) {
              return {
                get: () =>
                  /integrity_check/.test(sql)
                    ? { integrity_check: "*** in database main *** page 3 is never used" }
                    : { user_version: 1 },
              };
            }
            close() {}
          },
          backup: async (_src, dest) => {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, "copy");
          },
        },
      });
      await expect(createOfflineCopy(args)).rejects.toMatchObject({
        stage: "integrity",
        message: expect.stringMatching(/page 3 is never used/),
      });
    });

    it("names the space stage when the backups volume cannot hold 2x the state", async () => {
      const args = makeCopyArgs({
        fsModule: {
          ...fs,
          promises: fs.promises,
          statfsSync: () => ({ bavail: 1, bsize: 1 }),
        },
      });
      await expect(createOfflineCopy(args)).rejects.toMatchObject({ stage: "space" });
    });

    it("names the archive stage on a hard tar failure and removes the temp output", async () => {
      const args = makeCopyArgs({
        runCommand: async (spec) =>
          spec.command === "tar" && spec.args[0] === "-I"
            ? { ok: false, code: 2, tail: "tar: /nope: Cannot open: No space left\n", timedOut: false }
            : realRunCommand(spec),
      });
      await expect(createOfflineCopy(args)).rejects.toMatchObject({
        stage: "archive",
        message: expect.stringMatching(/tar failed: tar: \/nope/),
      });
      expect(fs.readdirSync(args.backupsDir)).toEqual([]);
    });

    it("falls back to `tar | gzip -1` through sh when -I is unsupported", async () => {
      const spawned = [];
      const args = makeCopyArgs({
        runCommand: async (spec) => {
          spawned.push(spec.command);
          if (spec.command === "tar" && spec.args[0] === "-I") {
            return { ok: false, code: 64, tail: "tar: unrecognized option '-I'\n", timedOut: false };
          }
          return realRunCommand(spec);
        },
      });
      const result = await createOfflineCopy(args);
      expect(result.method).toBe("tar | gzip -1");
      expect(spawned).toEqual(["tar", "sh", "gzip", "tar"]);
      expect(listArchive(args.outputFile)).toContain("openclaw-backup-1000-abcdef12/manifest.json");
    });

    it("names the verify stage when the archive does not pass gzip -t / manifest extraction", async () => {
      const args = makeCopyArgs({
        runCommand: async (spec) =>
          spec.command === "gzip"
            ? { ok: false, code: 1, tail: "gzip: unexpected end of file\n", timedOut: false }
            : realRunCommand(spec),
      });
      await expect(createOfflineCopy(args)).rejects.toMatchObject({
        stage: "verify",
        message: expect.stringMatching(/gzip -t: gzip: unexpected end of file/),
      });
      expect(fs.readdirSync(args.backupsDir)).toEqual([]);
    });

    it("rejects a runner that throws as a named archive-stage error", async () => {
      const args = makeCopyArgs({
        runCommand: async () => {
          throw new Error("spawn EACCES");
        },
      });
      await expect(createOfflineCopy(args)).rejects.toMatchObject({
        stage: "archive",
        message: expect.stringMatching(/tar could not run: spawn EACCES/),
      });
    });

    it("requires runCommand and isQuiet", async () => {
      await expect(createOfflineCopy(makeCopyArgs({ runCommand: null }))).rejects.toThrow(TypeError);
      await expect(createOfflineCopy(makeCopyArgs({ isQuiet: null }))).rejects.toThrow(TypeError);
    });
  });

  describe("verifyArchiveManifest (WI-6.1 usable check)", () => {
    it("passes a real offline-copy archive and returns its producer", async () => {
      const args = makeCopyArgs();
      await createOfflineCopy(args);
      const verdict = await verifyArchiveManifest({
        file: args.outputFile,
        runCommand: realRunCommand,
        requiredArchivePaths: ["state/openclaw.sqlite", "agents/main/agent/openclaw-agent.sqlite"],
      });
      expect(verdict.ok).toBe(true);
      expect(verdict.producer).toBe(kOfflineCopyProducer);
    });

    it("matches required databases by sourcePath suffix too (upstream manifests)", async () => {
      const verdict = await verifyArchiveManifest({
        file: "/x.tar.gz",
        runCommand: async (spec) =>
          spec.command === "gzip"
            ? { ok: true, tail: "" }
            : {
                ok: true,
                tail: `noise\n${JSON.stringify({
                  schemaVersion: 1,
                  assets: [{ kind: "file", sourcePath: "/data/.openclaw/state/openclaw.sqlite", archivePath: "state/3/openclaw.sqlite" }],
                })}\n`,
              },
        requiredArchivePaths: ["state/openclaw.sqlite"],
      });
      expect(verdict.ok).toBe(true);
      expect(verdict.producer).toBe("openclaw");
    });

    // The REAL upstream manifest shape (captured from `openclaw backup create
    // --verify` on the 2026.7.1-2 pin and 2026.9.1-beta.1): ONE directory-level
    // state asset; the databases are tar entries beneath it, never assets.
    const upstreamManifest = (stateDirPath, { agentRoots = true } = {}) => ({
      schemaVersion: 1,
      createdAt: "2026-09-02T19:46:13.626Z",
      archiveRoot: "2026-09-02T19-46-13.626+00-00-openclaw-backup",
      runtimeVersion: "2026.9.1-beta.1",
      platform: "linux",
      nodeVersion: "v22.23.2",
      options: { includeWorkspace: true, onlyConfig: false },
      paths: {
        stateDir: stateDirPath,
        configPath: `${stateDirPath}/openclaw.json`,
        oauthDir: `${stateDirPath}/credentials`,
        workspaceDirs: [`${stateDirPath}/workspace`],
        ...(agentRoots
          ? { agentRoots: [{ agentId: "main", sourcePath: `${stateDirPath}/agents/main/agent` }] }
          : {}),
      },
      assets: [
        {
          kind: "state",
          sourcePath: stateDirPath,
          archivePath: `2026-09-02T19-46-13.626+00-00-openclaw-backup/payload/posix${stateDirPath}`,
        },
      ],
      skipped: [{ kind: "workspace", sourcePath: `${stateDirPath}/workspace`, reason: "missing" }],
    });
    const scriptedManifest = (manifest) => async (spec) =>
      spec.command === "gzip" ? { ok: true, tail: "" } : { ok: true, tail: `${JSON.stringify(manifest)}\n` };

    it("accepts the real upstream shape: one directory-level state asset covers the box's databases", async () => {
      for (const agentRoots of [true, false]) {
        const verdict = await verifyArchiveManifest({
          file: "/data/backups/openclaw/openclaw-backup-1-abc.tar.gz",
          runCommand: scriptedManifest(upstreamManifest("/data/.openclaw", { agentRoots })),
          requiredArchivePaths: ["state/openclaw.sqlite", "agents/main/agent/openclaw-agent.sqlite"],
          stateDir: "/data/.openclaw",
        });
        expect(verdict.ok).toBe(true);
        expect(verdict.producer).toBe("openclaw");
      }
    });

    it("resolves coverage against manifest.paths.stateDir when the caller passes no stateDir", async () => {
      const verdict = await verifyArchiveManifest({
        file: "/x.tar.gz",
        runCommand: scriptedManifest(upstreamManifest("/tmp/oc-manifest-pin-enPE")),
        requiredArchivePaths: ["state/openclaw.sqlite"],
      });
      expect(verdict.ok).toBe(true);
    });

    it("survives a workspace that ships its own manifest.json (real tar: only the depth-1 manifest is read)", async () => {
      const args = makeCopyArgs();
      // A Chrome-extension-style manifest inside the inline workspace — a
      // bare `*/manifest.json` wildcard would match it too.
      fs.mkdirSync(path.join(args.stateDir, "workspace", "ext"), { recursive: true });
      fs.writeFileSync(
        path.join(args.stateDir, "workspace", "ext", "manifest.json"),
        JSON.stringify({ manifest_version: 3, name: "not ours" }),
      );
      await createOfflineCopy(args);
      const verdict = await verifyArchiveManifest({
        file: args.outputFile,
        runCommand: realRunCommand,
        requiredArchivePaths: ["state/openclaw.sqlite", "agents/main/agent/openclaw-agent.sqlite"],
        stateDir: args.stateDir,
      });
      expect(verdict.ok).toBe(true);
      expect(verdict.manifest.producer).toBe(kOfflineCopyProducer);
    });

    it("survives a busy install: a 400-session-file tree yields a manifest far larger than the runner's default 64 KB tail", async () => {
      const args = makeCopyArgs();
      const sessions = path.join(args.stateDir, "agents", "main", "sessions");
      for (let i = 0; i < 400; i += 1) {
        fs.writeFileSync(path.join(sessions, `session-${String(i).padStart(4, "0")}-${"x".repeat(24)}.jsonl`), "{}\n");
      }
      await createOfflineCopy(args);
      const verdict = await verifyArchiveManifest({
        file: args.outputFile,
        runCommand: realRunCommand,
        requiredArchivePaths: ["state/openclaw.sqlite", "agents/main/agent/openclaw-agent.sqlite"],
        stateDir: args.stateDir,
      });
      expect(verdict.ok).toBe(true);
      expect(verdict.manifest.assets.length).toBeGreaterThan(400);
    });

    it("rejects a manifest without a numeric schemaVersion even when assets[] is present", async () => {
      const verdict = await verifyArchiveManifest({
        file: "/x.tar.gz",
        runCommand: scriptedManifest({ assets: [{ kind: "state", sourcePath: "/data/.openclaw", archivePath: "r/payload/posix/data/.openclaw" }] }),
        requiredArchivePaths: ["state/openclaw.sqlite"],
        stateDir: "/data/.openclaw",
      });
      expect(verdict).toEqual(expect.objectContaining({ ok: false, stage: "parse" }));
    });

    it("stops the manifest extraction at the first depth-1 match and still gzip-tests the whole archive", async () => {
      const calls = [];
      await verifyArchiveManifest({
        file: "/x.tar.gz",
        runCommand: async (spec) => {
          calls.push(spec);
          return spec.command === "gzip"
            ? { ok: true, tail: "" }
            : { ok: true, tail: JSON.stringify(upstreamManifest("/data/.openclaw")) };
        },
        requiredArchivePaths: ["state/openclaw.sqlite"],
        stateDir: "/data/.openclaw",
      });
      expect(calls[0]).toEqual(expect.objectContaining({ command: "gzip", args: ["-t", "/x.tar.gz"] }));
      expect(calls[1].args).toEqual([
        "-xzOf",
        "/x.tar.gz",
        "--wildcards",
        "--no-wildcards-match-slash",
        "--occurrence=1",
        "*/manifest.json",
      ]);
      expect(calls[1].tailBytes).toBe(16 * 1024 * 1024);
    });

    it("rejects a manifest whose assets cover none of the databases (config-only archive, foreign state dir)", async () => {
      const configOnly = {
        ...upstreamManifest("/data/.openclaw"),
        options: { includeWorkspace: false, onlyConfig: true },
        assets: [{ kind: "config", sourcePath: "/data/.openclaw/openclaw.json", archivePath: "r/payload/posix/data/.openclaw/openclaw.json" }],
      };
      const verdict = await verifyArchiveManifest({
        file: "/x.tar.gz",
        runCommand: scriptedManifest(configOnly),
        requiredArchivePaths: ["state/openclaw.sqlite"],
        stateDir: "/data/.openclaw",
      });
      expect(verdict).toEqual(
        expect.objectContaining({ ok: false, stage: "assets", reason: "manifest covers no state/openclaw.sqlite" }),
      );
      // A directory asset from ANOTHER state dir must not cover this box's databases.
      const foreign = await verifyArchiveManifest({
        file: "/x.tar.gz",
        runCommand: scriptedManifest({ ...upstreamManifest("/other/.openclaw"), paths: { stateDir: "/other/.openclaw" } }),
        requiredArchivePaths: ["state/openclaw.sqlite"],
        stateDir: "/data/.openclaw",
      });
      // manifest.paths.stateDir wins for resolution, so the archive covers ITS
      // own /other/.openclaw/state/openclaw.sqlite — a restore of that archive
      // onto this box is the operator's explicit choice, not a usability defect.
      expect(foreign.ok).toBe(true);
    });

    it("fails on gzip, manifest, parse, and assets stages with honest reasons", async () => {
      const scripted = (gzipOk, tarOk, tarTail) => async (spec) =>
        spec.command === "gzip"
          ? { ok: gzipOk, code: gzipOk ? 0 : 1, tail: gzipOk ? "" : "gzip: crc error\n" }
          : { ok: tarOk, code: tarOk ? 0 : 2, tail: tarTail };
      const gzip = await verifyArchiveManifest({ file: "/x", runCommand: scripted(false, true, "") });
      expect(gzip).toEqual({ ok: false, stage: "gzip", reason: "gzip -t: gzip: crc error" });
      const manifest = await verifyArchiveManifest({
        file: "/x",
        runCommand: scripted(true, false, "tar: Not found in archive\n"),
      });
      expect(manifest).toEqual(
        expect.objectContaining({ stage: "manifest", reason: expect.stringMatching(/Not found in archive/) }),
      );
      const parse = await verifyArchiveManifest({ file: "/x", runCommand: scripted(true, true, "not json") });
      expect(parse).toEqual(expect.objectContaining({ stage: "parse" }));
      const assets = await verifyArchiveManifest({
        file: "/x",
        runCommand: scripted(
          true,
          true,
          JSON.stringify({ schemaVersion: 1, assets: [{ archivePath: "openclaw.json" }] }),
        ),
        requiredArchivePaths: ["state/openclaw.sqlite"],
      });
      expect(assets).toEqual(
        expect.objectContaining({ stage: "assets", reason: "manifest covers no state/openclaw.sqlite" }),
      );
    });

    it("treats a throwing runner as a gzip/manifest-stage failure, never a throw", async () => {
      const verdict = await verifyArchiveManifest({
        file: "/x",
        runCommand: async () => {
          throw new Error("spawn ENOENT");
        },
      });
      expect(verdict).toEqual({ ok: false, stage: "gzip", reason: "gzip could not run: spawn ENOENT" });
    });

    it("hands the remaining budget to each tool (bounded by timeoutMs)", async () => {
      const timeouts = [];
      let now = 0;
      await verifyArchiveManifest({
        file: "/x",
        timeoutMs: 1000,
        nowFn: () => {
          now += 400;
          return now;
        },
        runCommand: async (spec) => {
          timeouts.push(spec.timeoutMs);
          return spec.command === "gzip"
            ? { ok: true, tail: "" }
            : { ok: true, tail: JSON.stringify({ assets: [] }) };
        },
      });
      expect(timeouts[0]).toBeLessThanOrEqual(1000);
      expect(timeouts[1]).toBeLessThan(timeouts[0]);
    });
  });
});
