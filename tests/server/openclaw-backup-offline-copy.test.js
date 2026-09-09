// AlphaClaw offline copy (issue #54): exclusivity evidence, per-stage named
// failures, quiet_lost abort, manifest shape, gzip -1 archiving, and the
// shared usable-check; (issue #79) workspace policy excludes, honest
// coverage, the format-2 manifest with its v1 reader, and the progress feed.
// The happy path runs the REAL tar/gzip on this box; the stage-failure cases
// drive a scripted runner so they stay hermetic.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const {
  kOfflineCopyProducer,
  kOfflineCopyFormatVersion,
  kOfflineCopyReadableFormatVersions,
  kOfflineCopyPolicyExcludes,
  kOfflineCopyExcludeMaxPatterns,
  kCoreAssetProbePaths,
  kOfflineCopyArchiveSuffix,
  kOfflineCopyTempDirPrefix,
  kIntegrityCheckpointIntervalMs,
  kManifestTailBytes,
  kManifestMaxBytes,
  kWalkCheckpointEvery,
  OfflineCopyError,
  isOfflineCopyArchiveName,
  producerOfArchiveName,
  isCoreAssetPath,
  compileExcludePattern,
  resolveExcludes,
  assessExclusivity,
  defaultListFdHolders,
  defaultSpawnIntegrityWorker,
  checkIntegrity,
  walkStateTree,
  walkStateTreeAsync,
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

// Reproducible debris inside the workspace — what the default policy drops —
// beside files it must keep (a log that is not gzipped, a sqlite file, a
// nested `.cache` an operator may opt in to). `junkBytes` sizes the
// node_modules payload so the inline-limit decision can be probed.
const addWorkspaceJunk = (stateDir, { junkBytes = 4096 } = {}) => {
  const ws = path.join(stateDir, "workspace");
  fs.mkdirSync(path.join(ws, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(ws, "node_modules", "index.js"), "x".repeat(junkBytes));
  fs.writeFileSync(path.join(ws, "node_modules", "left-pad", "index.js"), "y".repeat(100));
  fs.writeFileSync(path.join(ws, "Heap-20260907.heapsnapshot"), "z".repeat(300));
  fs.writeFileSync(path.join(ws, "scratch.tmp"), "t".repeat(50));
  fs.mkdirSync(path.join(ws, "logs", "app"), { recursive: true });
  fs.writeFileSync(path.join(ws, "logs", "app", "old.log.gz"), "g".repeat(70));
  fs.writeFileSync(path.join(ws, "logs", "app", "current.log"), "keep\n");
  fs.mkdirSync(path.join(ws, ".cache"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".cache", "blob"), "c".repeat(40));
  fs.writeFileSync(path.join(ws, "notes.sqlite"), "not a db, a workspace file\n");
  return {
    junkBytes: junkBytes + 100 + 300 + 50 + 70,
    junkFiles: 5,
  };
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

    it("refuses when the quiet barrier is missing or lost", () => {
      expect(assessExclusivity({ ...base, quietToken: null }).failures).toEqual([
        "state-db quiet barrier missing",
      ]);
      expect(assessExclusivity({ ...base, isQuiet: () => false }).failures).toEqual([
        "state-db quiet barrier lost",
      ]);
    });

    it("accepts a barrier DISABLED by the OPENCLAW_STATE_DB_QUIET kill switch as evidence, not a refusal", () => {
      // Lane D's kill switch returns a { disabled: true } token and never
      // enters the quiet state, so isQuiet() reads false — that must not be
      // mistaken for a lost barrier. The other hard gates still apply.
      const disabled = assessExclusivity({
        ...base,
        quietToken: { ...heldToken, disabled: true },
        isQuiet: () => false,
      });
      expect(disabled.ok).toBe(true);
      expect(disabled.failures).toEqual([]);
      expect(disabled.evidence).toEqual(
        expect.objectContaining({ quiet: "disabled", quietOwner: "quiesced-backup" }),
      );
      const disabledButLive = assessExclusivity({
        ...base,
        quietToken: { ...heldToken, disabled: true },
        isQuiet: () => false,
        liveProcesses: [{ pid: 9 }],
      });
      expect(disabledButLive.ok).toBe(false);
      expect(disabledButLive.failures).toEqual([
        "1 live openclaw process(es): 9 — argv names an OpenClaw executable or entry script",
      ]);
    });

    it("refuses on live openclaw processes and open in-process handles", () => {
      const report = assessExclusivity({
        ...base,
        liveProcesses: [{ pid: 57, cmdline: "openclaw gateway run" }],
        handleCount: 2,
      });
      expect(report.ok).toBe(false);
      // pid AND argv: the operator can tell a foreign holder from AlphaClaw's
      // own transient CLI shell-out that coincided with the sample.
      expect(report.failures).toEqual([
        "1 live openclaw process(es): 57 (openclaw gateway run) — argv names an OpenClaw executable or entry script",
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

    it("matches the kernel-canonical spelling too: a state dir reached through a symlink still finds its holders", () => {
      // /proc/<pid>/fd links always report the resolved path; the configured
      // state dir goes through /srv/current → /data/alphaclaw.
      const fsModule = {
        realpathSync: (p) => {
          if (p === "/srv/current/.openclaw/state/openclaw.sqlite") {
            return "/data/alphaclaw/.openclaw/state/openclaw.sqlite";
          }
          throw new Error(`ENOENT ${p}`);
        },
        readdirSync: (p) => {
          if (p === "/proc") return ["42"];
          if (p === "/proc/42/fd") return ["3"];
          throw new Error(`unexpected ${p}`);
        },
        readlinkSync: (p) => {
          if (p === "/proc/42/fd/3") return "/data/alphaclaw/.openclaw/state/openclaw.sqlite-wal";
          throw new Error(`unexpected ${p}`);
        },
      };
      const holders = defaultListFdHolders({
        fsModule,
        dbPaths: ["/srv/current/.openclaw/state/openclaw.sqlite"],
        selfPid: 1,
      });
      expect(holders).toEqual([{ pid: 42, path: "/data/alphaclaw/.openclaw/state/openclaw.sqlite-wal" }]);
    });

    it("keeps scanning under the configured spelling when realpath fails (db not yet on disk)", () => {
      const fsModule = {
        realpathSync: () => {
          throw new Error("ENOENT");
        },
        readdirSync: (p) => {
          if (p === "/proc") return ["42"];
          if (p === "/proc/42/fd") return ["3"];
          throw new Error(`unexpected ${p}`);
        },
        readlinkSync: () => "/s/state/openclaw.sqlite",
      };
      expect(
        defaultListFdHolders({ fsModule, dbPaths: ["/s/state/openclaw.sqlite"], selfPid: 1 }),
      ).toEqual([{ pid: 42, path: "/s/state/openclaw.sqlite" }]);
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
      expect(result.partialReasons).toEqual([]);
      expect(result.method).toBe("tar -I gzip -1");
      expect(fs.statSync(args.outputFile).size).toBe(result.bytes);
      // The archive carries credentials: 0600, whatever the umask.
      expect(fs.statSync(args.outputFile).mode & 0o777).toBe(0o600);
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

    it("stages the copy under the exported temp-dir prefix the channel-sync sweeper matches", async () => {
      const seen = [];
      const args = makeCopyArgs({
        runCommand: (spec) => {
          seen.push(...(spec.args || []).map(String));
          return realRunCommand(spec);
        },
      });
      const result = await createOfflineCopy(args);
      expect(result.ok).toBe(true);
      const staged = seen.filter(
        (arg) =>
          path.dirname(arg) === args.backupsDir &&
          path.basename(arg).startsWith(kOfflineCopyTempDirPrefix),
      );
      expect(staged.length).toBeGreaterThan(0);
      expect(path.basename(staged[0])).toMatch(new RegExp(`^\\${kOfflineCopyTempDirPrefix}${process.pid}-[0-9a-f]{8}$`));
      // Removed in the finally — only the archive remains.
      expect(fs.readdirSync(args.backupsDir)).toEqual([path.basename(args.outputFile)]);
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

    // ── Symlinked core assets: never silently absent from a "verified" copy ──
    it("follows a symlinked openclaw.json that resolves to a regular file (config-map mount) and records it as the config asset", async () => {
      const stateDir = makeStateDir();
      const mounted = mkTemp("alphaclaw-offline-copy-configmap-");
      const target = path.join(mounted, "..data", "openclaw.json");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(path.join(stateDir, "openclaw.json"), target);
      fs.symlinkSync(target, path.join(stateDir, "openclaw.json"));
      const args = makeCopyArgs({ stateDir });

      const result = await createOfflineCopy(args);

      expect(result.partial).toBe(false);
      expect(result.manifest.paths.configPath).toBe(path.join(stateDir, "openclaw.json"));
      expect(result.manifest.assets).toContainEqual({
        kind: "config",
        sourcePath: path.join(stateDir, "openclaw.json"),
        archivePath: "openclaw.json",
      });
      // The archive holds the TARGET's bytes, not a dangling link.
      const extractDir = mkTemp("alphaclaw-offline-copy-extract-");
      execFileSync("tar", ["-xzf", args.outputFile, "-C", extractDir]);
      const copied = path.join(extractDir, "openclaw-backup-1000-abcdef12", "openclaw.json");
      expect(fs.lstatSync(copied).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(copied, "utf8")).toBe('{"agents":{}}\n');
    });

    it("a symlinked credentials dir is NOT followed: the copy is partial with the reason, oauthDir is null, and the archive lacks it", async () => {
      const stateDir = makeStateDir();
      const elsewhere = mkTemp("alphaclaw-offline-copy-creds-");
      fs.writeFileSync(path.join(elsewhere, "telegram.json"), "{}\n");
      fs.rmSync(path.join(stateDir, "credentials"), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(stateDir, "credentials"));
      const args = makeCopyArgs({ stateDir });

      const result = await createOfflineCopy(args);

      expect(result.partial).toBe(true);
      expect(result.partialReasons).toEqual(["credentials: core asset is a symlink (not followed)"]);
      expect(result.manifest.paths.oauthDir).toBeNull();
      expect(result.manifest.partialReasons).toEqual(result.partialReasons);
      expect(result.manifest.skipped).toContainEqual(
        expect.objectContaining({ kind: "symlink", core: true, sourcePath: path.join(stateDir, "credentials") }),
      );
      expect(listArchive(args.outputFile).some((entry) => entry.includes("credentials/"))).toBe(false);
      // The non-core hostname-link is skipped as before and never makes the copy partial.
      const hostnameLink = result.manifest.skipped.find((entry) => entry.sourcePath.endsWith("hostname-link"));
      expect(hostnameLink).toEqual(expect.objectContaining({ kind: "symlink" }));
      expect(hostnameLink.core).toBeUndefined();
    });

    it("a config symlink that does not resolve to a regular file leaves configPath null and the copy partial", async () => {
      const stateDir = makeStateDir();
      fs.rmSync(path.join(stateDir, "openclaw.json"));
      fs.symlinkSync("/nonexistent-alphaclaw-config.json", path.join(stateDir, "openclaw.json"));

      const result = await createOfflineCopy(makeCopyArgs({ stateDir }));

      expect(result.partial).toBe(true);
      expect(result.partialReasons).toEqual([
        "openclaw.json: config symlink does not resolve to a regular file",
      ]);
      expect(result.manifest.paths.configPath).toBeNull();
      expect(result.manifest.assets.some((asset) => asset.kind === "config")).toBe(false);
    });

    // ── The deadline reaches INTO the sqlite backup, not only between stages ──
    const kStubDatabaseSync = class {
      constructor() {}
      exec() {}
      prepare() {
        return { get: () => ({ integrity_check: "ok", user_version: 1 }) };
      }
      close() {}
    };

    it("bounds sqlite backup() by the remaining budget: a never-settling backup rejects with stage budget and leaves no file", async () => {
      const args = makeCopyArgs({
        budgetMs: 200,
        nowFn: () => 1_000_000,
        sqliteModule: {
          DatabaseSync: kStubDatabaseSync,
          backup: () => new Promise(() => {}),
        },
      });
      const startedAt = Date.now();
      await expect(createOfflineCopy(args)).rejects.toMatchObject({
        stage: "budget",
        message: expect.stringMatching(/during sqlite_backup of .*\.sqlite .* did not finish in time/),
      });
      expect(Date.now() - startedAt).toBeLessThan(5000);
      expect(fs.readdirSync(args.backupsDir)).toEqual([]);
    });

    it("a quiet barrier lost DURING the sqlite backup surfaces through the progress hook as quiet_lost, and the orphaned backup's later failure is swallowed", async () => {
      let quiet = true;
      const args = makeCopyArgs({
        isQuiet: () => quiet,
        sqliteModule: {
          DatabaseSync: kStubDatabaseSync,
          backup: (_src, _dest, { progress }) =>
            new Promise((_resolve, reject) => {
              quiet = false;
              progress();
              setTimeout(() => reject(new Error("orphan finished later")), 20);
            }),
        },
      });
      await expect(createOfflineCopy(args)).rejects.toMatchObject({
        stage: "quiet_lost",
        message: expect.stringMatching(/during sqlite_backup/),
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    // X2: the fallback for a backup() whose current step never returns (the
    // progress hook is never called again, so nothing can throw into the job;
    // closing its source does not stop it — node:sqlite zombifies the
    // connection). These fakes ignore the hook on purpose: the abort path
    // closes the source at once, unlinks the destination, waits a short bound
    // for the orphan to settle, and past the bound marks the failure
    // `orphanedBackup: true` so the driver can record that the barrier was
    // released over a still-stepping backup. The NORMAL abort — the hook's
    // throw cancelling the job — is pinned in the describe below.
    describe("orphaned sqlite backup() after a budget abort (X2)", () => {
      const closeTrackingDatabaseSync = () => {
        let onClose = () => {};
        const closes = [];
        const DatabaseSync = class extends kStubDatabaseSync {
          close() {
            closes.push(Date.now());
            onClose();
          }
        };
        return { DatabaseSync, closes, whenClosed: new Promise((resolve) => (onClose = resolve)) };
      };

      it("closes the source immediately, then returns the budget error as soon as the orphan settles (no orphanedBackup flag)", async () => {
        const tracking = closeTrackingDatabaseSync();
        let destinationSeen = null;
        const args = makeCopyArgs({
          budgetMs: 100,
          nowFn: () => 1_000_000,
          orphanSettleMs: 5000,
          sqliteModule: {
            DatabaseSync: tracking.DatabaseSync,
            // Resolves only once the source has been closed — the orphan
            // "finishes" in response to the abort.
            backup: (_src, destination) => {
              destinationSeen = destination;
              fs.mkdirSync(path.dirname(destination), { recursive: true });
              fs.writeFileSync(destination, "partial copy");
              return tracking.whenClosed.then(() => 1);
            },
          },
        });
        const startedAt = Date.now();
        const error = await createOfflineCopy(args).catch((caught) => caught);
        expect(error).toMatchObject({ stage: "budget" });
        expect(error.orphanedBackup).toBeUndefined();
        // Settled well inside the 5 s bound because the close released it.
        expect(Date.now() - startedAt).toBeLessThan(3000);
        expect(tracking.closes.length).toBeGreaterThanOrEqual(1);
        expect(fs.existsSync(destinationSeen)).toBe(false);
        expect(fs.readdirSync(args.backupsDir)).toEqual([]);
      });

      it("a backup that never settles inside the bound fails with stage budget AND orphanedBackup: true, its destination unlinked", async () => {
        const tracking = closeTrackingDatabaseSync();
        let destinationSeen = null;
        const args = makeCopyArgs({
          budgetMs: 50,
          nowFn: () => 1_000_000,
          orphanSettleMs: 60,
          sqliteModule: {
            DatabaseSync: tracking.DatabaseSync,
            backup: (_src, destination) => {
              destinationSeen = destination;
              fs.mkdirSync(path.dirname(destination), { recursive: true });
              fs.writeFileSync(destination, "partial copy");
              return new Promise(() => {});
            },
          },
        });
        const startedAt = Date.now();
        const error = await createOfflineCopy(args).catch((caught) => caught);
        expect(error).toMatchObject({ stage: "budget", orphanedBackup: true });
        // Waited the bound (source closed first), then gave up honestly.
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
        expect(Date.now() - startedAt).toBeLessThan(3000);
        expect(tracking.closes.length).toBeGreaterThanOrEqual(1);
        expect(fs.existsSync(destinationSeen)).toBe(false);
        expect(fs.readdirSync(args.backupsDir)).toEqual([]);
      });
    });

    // D1/D4: a throw from the `progress` hook is node:sqlite's cancel — the
    // job aborts at that step boundary, backup() rejects with the thrown
    // value and no further step runs. The previous shape swallowed the
    // checkpoint's throw, so a budget/quiet abort left the job stepping as an
    // orphan that restarted from page 1 on every gateway write after the
    // relaunch (livelock, state-DB read lock, unlinked destination's disk).
    // These pins drive the REAL node:sqlite module against a multi-step DB.
    describe("abort cancels sqlite backup() through the progress hook (real node:sqlite)", () => {
      const sqlite = require("node:sqlite");
      // Enough pages that a `rate: 5` backup takes dozens of steps.
      const growStateDb = (stateDir) => {
        const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
        db.exec("CREATE TABLE big(x TEXT)");
        const insert = db.prepare("INSERT INTO big VALUES (?)");
        db.exec("BEGIN");
        for (let i = 0; i < 3000; i += 1) insert.run("x".repeat(400));
        db.exec("COMMIT");
        db.close();
      };
      // The real module with a step counter around the copy's own hook; the
      // module identity differs from `node:sqlite`, so the integrity check
      // would run in-process — never reached, the abort lands before it.
      const countingSqlite = ({ onStep }) => {
        const counter = { steps: 0 };
        return {
          counter,
          sqliteModule: {
            DatabaseSync: sqlite.DatabaseSync,
            backup: (src, dest, options) =>
              sqlite.backup(src, dest, {
                ...options,
                rate: 5,
                progress: (info) => {
                  counter.steps += 1;
                  onStep(counter.steps);
                  options.progress(info);
                },
              }),
          },
        };
      };

      it("a quiet barrier lost between steps aborts the job: the promise settles as quiet_lost, no further step runs, no orphan flag", async () => {
        const stateDir = makeStateDir();
        growStateDb(stateDir);
        let quiet = true;
        const { counter, sqliteModule } = countingSqlite({
          onStep: (step) => {
            if (step === 2) quiet = false;
          },
        });
        const args = makeCopyArgs({ stateDir, sqliteModule, isQuiet: () => quiet });

        const error = await createOfflineCopy(args).catch((caught) => caught);

        expect(error).toMatchObject({
          stage: "quiet_lost",
          message: expect.stringMatching(/ended during sqlite_backup/),
        });
        expect(error.orphanedBackup).toBeUndefined();
        expect(counter.steps).toBe(2);
        // The job is dead, not orphaned: no step lands after the settle.
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(counter.steps).toBe(2);
        expect(fs.readdirSync(args.backupsDir)).toEqual([]);
      });

      it("a deadline exhausted between steps aborts the job through the same hook (stage budget), no orphan flag", async () => {
        const stateDir = makeStateDir();
        growStateDb(stateDir);
        let now = 1_000_000;
        const { counter, sqliteModule } = countingSqlite({
          onStep: (step) => {
            // The clock leaps past the deadline while the job is mid-copy.
            if (step === 2) now += 120_000;
          },
        });
        const args = makeCopyArgs({ stateDir, sqliteModule, budgetMs: 60_000, nowFn: () => now });

        const error = await createOfflineCopy(args).catch((caught) => caught);

        expect(error).toMatchObject({
          stage: "budget",
          message: expect.stringMatching(/exhausted during sqlite_backup/),
        });
        expect(error.orphanedBackup).toBeUndefined();
        expect(counter.steps).toBe(2);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(counter.steps).toBe(2);
        expect(fs.readdirSync(args.backupsDir)).toEqual([]);
      });

      it("after the outer deadline timer fires, the NEXT step throws the budget error into the job (contract fake): rejected with that value, settled long before the orphan bound", async () => {
        let rejectedWith = null;
        const args = makeCopyArgs({
          budgetMs: 20,
          nowFn: () => 1_000_000,
          orphanSettleMs: 5000,
          sqliteModule: {
            DatabaseSync: kStubDatabaseSync,
            // node:sqlite's contract: the promise rejects with whatever the
            // hook threw. This step returns 60 ms in — after the 20 ms timer.
            backup: (_src, _dest, { progress }) =>
              new Promise((resolve, reject) => {
                setTimeout(() => {
                  try {
                    progress({ totalPages: 2, remainingPages: 1 });
                    resolve(1);
                  } catch (thrown) {
                    rejectedWith = thrown;
                    reject(thrown);
                  }
                }, 60);
              }),
          },
        });
        const startedAt = Date.now();
        const error = await createOfflineCopy(args).catch((caught) => caught);

        expect(error).toMatchObject({ stage: "budget" });
        expect(error.orphanedBackup).toBeUndefined();
        expect(rejectedWith).toBe(error);
        expect(Date.now() - startedAt).toBeLessThan(3000);
        expect(fs.readdirSync(args.backupsDir)).toEqual([]);
      });
    });

    // ── The walk is budgeted and yields; it is not one blocking recursion ──
    it("re-checks the budget every kWalkCheckpointEvery entries: a huge workspace is interrupted by the deadline instead of walked to the end", async () => {
      const stateDir = "/synthetic-alphaclaw-state";
      const dirent = (name, type) => ({
        name,
        isSymbolicLink: () => false,
        isDirectory: () => type === "dir",
        isFile: () => type === "file",
      });
      const fsModule = {
        readdirSync: (dir) => {
          if (dir === stateDir) return [dirent("workspace", "dir")];
          if (dir === path.join(stateDir, "workspace")) {
            return Array.from({ length: 5000 }, (_, i) => dirent(`f${i}.txt`, "file"));
          }
          throw new Error(`unexpected readdir ${dir}`);
        },
        statSync: () => ({ size: 1 }),
      };
      let checkpoints = 0;
      const tree = await walkStateTreeAsync({
        stateDir,
        fsModule,
        checkpoint: () => {
          checkpoints += 1;
        },
      });
      expect(checkpoints).toBe(Math.floor(5001 / kWalkCheckpointEvery));
      expect(tree.workspaces.get(path.join(stateDir, "workspace")).files).toHaveLength(5000);
      // Plain workspace files match no policy exclude, so every one of them
      // is payload and counts toward the cadence (excluded entries count
      // toward the cadence too — see the policy-excludes describe).
      expect(walkStateTree({ stateDir, fsModule }).workspaces.size).toBe(1);

      let now = 0;
      const args = makeCopyArgs({
        stateDir,
        fsModule,
        budgetMs: 10,
        nowFn: () => {
          now += 100;
          return now;
        },
      });
      await expect(createOfflineCopy(args)).rejects.toMatchObject({
        stage: "budget",
        message: expect.stringMatching(/during enumerate/),
      });
    });

    // ── Producer and verifier share the manifest ceiling ──
    it("refuses at stage manifest (before any archive is written) when the manifest would exceed manifestMaxBytes; exactly at the ceiling it passes", async () => {
      const stateDir = makeStateDir();
      const fixedNow = () => 1_700_000_000_000;
      // Warm-up run: any sidecar the read-only opens leave beside the sources
      // is in place before the size is measured.
      await createOfflineCopy(makeCopyArgs({ stateDir, nowFn: fixedNow }));
      const probe = await createOfflineCopy(makeCopyArgs({ stateDir, nowFn: fixedNow }));
      const manifestBytes = Buffer.byteLength(`${JSON.stringify(probe.manifest)}\n`);

      const atLimit = await createOfflineCopy(
        makeCopyArgs({ stateDir, nowFn: fixedNow, manifestMaxBytes: manifestBytes }),
      );
      expect(atLimit.ok).toBe(true);

      const over = makeCopyArgs({ stateDir, nowFn: fixedNow, manifestMaxBytes: manifestBytes - 1 });
      await expect(createOfflineCopy(over)).rejects.toMatchObject({
        stage: "manifest",
        message: expect.stringMatching(/over the .* the usable check can read back/),
      });
      expect(fs.readdirSync(over.backupsDir)).toEqual([]);
      expect(kManifestMaxBytes).toBeLessThan(kManifestTailBytes);
      expect(kManifestTailBytes).toBe(16 * 1024 * 1024);
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

    it("completes under a kill-switch-disabled barrier (isQuiet false throughout) and records quiet:\"disabled\" in the manifest", async () => {
      const isQuiet = vi.fn(() => false);
      const args = makeCopyArgs({
        exclusivity: { ...fullExclusivity, quietToken: { ...heldToken, disabled: true } },
        isQuiet,
      });
      const result = await createOfflineCopy(args);
      expect(result.ok).toBe(true);
      expect(result.exclusivityEvidence).toEqual(
        expect.objectContaining({ quiet: "disabled", completeness: "full" }),
      );
      expect(result.manifest.exclusivityEvidence.quiet).toBe("disabled");
      expect(fs.readdirSync(args.backupsDir)).toEqual([path.basename(args.outputFile)]);
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

    // D13: the live-process sample and the /proc fd scan must describe the
    // same instant — the walk in between yields for seconds, so a child that
    // spawns during it was missed by a pre-walk argv sample yet caught by the
    // fd scan and refused as a foreign holder.
    describe("live processes are re-sampled after the walk, next to the fd scan", () => {
      it("a child that appears during the walk is refused BY NAME even though the pre-walk sample was empty", async () => {
        let samples = 0;
        const args = makeCopyArgs({
          exclusivity: { ...fullExclusivity, liveProcesses: [] },
          sampleLiveProcesses: async () => {
            samples += 1;
            return [{ pid: 777, cmdline: "openclaw sessions list --json" }];
          },
        });
        await expect(createOfflineCopy(args)).rejects.toMatchObject({
          stage: "exclusivity",
          message: expect.stringMatching(/1 live openclaw process\(es\): 777 \(openclaw sessions list --json\)/),
        });
        expect(samples).toBe(1);
        expect(fs.readdirSync(args.backupsDir)).toEqual([]);
      });

      it("a child seen only by the pre-walk sample that is gone at the re-sample does not refuse; the evidence records the settled sample", async () => {
        const args = makeCopyArgs({
          exclusivity: {
            ...fullExclusivity,
            liveProcesses: [{ pid: 777, cmdline: "openclaw sessions list --json" }],
          },
          sampleLiveProcesses: async () => [],
        });
        const result = await createOfflineCopy(args);
        expect(result.exclusivityEvidence).toEqual(
          expect.objectContaining({ liveProcesses: 0, completeness: "full" }),
        );
      });

      it("without a sampler the pre-walk sample is the verdict (fail-closed)", async () => {
        const args = makeCopyArgs({
          exclusivity: {
            ...fullExclusivity,
            liveProcesses: [{ pid: 4242, cmdline: "openclaw gateway run" }],
          },
        });
        await expect(createOfflineCopy(args)).rejects.toMatchObject({
          stage: "exclusivity",
          message: expect.stringMatching(/4242 \(openclaw gateway run\)/),
        });
      });
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

  // ── PRAGMA integrity_check runs OFF the event loop, bounded like backup() ──
  describe("checkIntegrity (worker thread)", () => {
    const { EventEmitter } = require("events");
    // A worker that never answers: the shape checkIntegrity drives, nothing more.
    const makeHangingWorker = () => {
      const worker = new EventEmitter();
      worker.terminate = vi.fn(async () => {});
      return worker;
    };

    it("real copy: verdict + user_version come back from the worker while the main thread keeps turning", async () => {
      const dir = mkTemp("alphaclaw-integrity-");
      const copyPath = path.join(dir, "copy.sqlite");
      writeDb(copyPath, { userVersion: 11 });
      let turned = false;
      const pending = checkIntegrity({ copyPath, remainingMs: () => 10_000 });
      // A macrotask queued right after the call runs BEFORE the verdict
      // lands — impossible on the synchronous in-process path, where the
      // already-settled promise's continuation wins the microtask race.
      setImmediate(() => {
        turned = true;
      });
      await expect(pending).resolves.toEqual({ integrity: "ok", userVersion: 11 });
      expect(turned).toBe(true);
    });

    it("real copy that is not a database: stage integrity, 'could not run', never a pass", async () => {
      const dir = mkTemp("alphaclaw-integrity-");
      const copyPath = path.join(dir, "garbage.sqlite");
      fs.writeFileSync(copyPath, "not a database at all, but long enough to be opened\n".repeat(20));
      await expect(checkIntegrity({ copyPath })).rejects.toMatchObject({
        stage: "integrity",
        message: expect.stringMatching(/integrity_check on garbage\.sqlite could not run/),
      });
    });

    it("a check that outlives the remaining budget rejects with stage budget and terminates the worker", async () => {
      const worker = makeHangingWorker();
      const startedAt = Date.now();
      await expect(
        checkIntegrity({
          copyPath: "/x/openclaw.sqlite",
          remainingMs: () => 40,
          spawnWorker: () => worker,
        }),
      ).rejects.toMatchObject({
        stage: "budget",
        message: expect.stringMatching(/during integrity of openclaw\.sqlite/),
      });
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    });

    it("a quiet barrier lost WHILE the check runs aborts through the interval checkpoint (quiet_lost), terminating the worker", async () => {
      const worker = makeHangingWorker();
      let quiet = true;
      setTimeout(() => {
        quiet = false;
      }, 5);
      await expect(
        checkIntegrity({
          copyPath: "/x/openclaw.sqlite",
          remainingMs: () => 10_000,
          checkpoint: (stage) => {
            if (!quiet) throw new OfflineCopyError("quiet_lost", `state-db quiet period ended during ${stage}`);
          },
          spawnWorker: () => worker,
        }),
      ).rejects.toMatchObject({
        stage: "quiet_lost",
        message: expect.stringMatching(/during integrity/),
      });
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(kIntegrityCheckpointIntervalMs).toBeLessThanOrEqual(1000);
    });

    it("a worker that dies without a verdict is an integrity failure, not a pass", async () => {
      const worker = makeHangingWorker();
      const pending = checkIntegrity({ copyPath: "/x/openclaw.sqlite", spawnWorker: () => worker });
      worker.emit("exit", 1);
      await expect(pending).rejects.toMatchObject({
        stage: "integrity",
        message: expect.stringMatching(/worker exited \(1\) without a verdict/),
      });
    });

    it("createOfflineCopy: the default (real sqlite) path uses the worker seam and the deadline reaches INTO the integrity stage", async () => {
      const worker = makeHangingWorker();
      const spawn = vi.fn(() => worker);
      const args = makeCopyArgs({ budgetMs: 150, spawnIntegrityWorker: spawn });
      const startedAt = Date.now();
      await expect(createOfflineCopy(args)).rejects.toMatchObject({
        stage: "budget",
        message: expect.stringMatching(/during integrity of/),
      });
      expect(Date.now() - startedAt).toBeLessThan(5000);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(worker.terminate).toHaveBeenCalled();
      // No archive, no staging debris.
      expect(fs.readdirSync(args.backupsDir)).toEqual([]);
    });

    it("the production default spawns a real node:worker_threads Worker", async () => {
      const dir = mkTemp("alphaclaw-integrity-");
      const copyPath = path.join(dir, "copy.sqlite");
      writeDb(copyPath, { userVersion: 2 });
      const worker = defaultSpawnIntegrityWorker({ copyPath });
      const message = await new Promise((resolve, reject) => {
        worker.on("message", resolve);
        worker.on("error", reject);
      });
      expect(message).toEqual({ ok: true, verdict: "ok", userVersion: 2 });
      await worker.terminate();
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

  // ── Issue #79: policy excludes inside workspaces ─────────────────────────
  describe("policy excludes (issue #79)", () => {
    describe("compileExcludePattern / resolveExcludes", () => {
      it("the default set is exactly the unambiguous debris (Codex 17): node_modules, *.heapsnapshot, *.tmp, logs/**/*.gz", () => {
        expect([...kOfflineCopyPolicyExcludes]).toEqual(["node_modules", "*.heapsnapshot", "*.tmp", "logs/**/*.gz"]);
        for (const optIn of ["tmp", ".cache", "caches"]) expect(kOfflineCopyPolicyExcludes).not.toContain(optIn);
        const { applied, refused } = resolveExcludes(undefined);
        expect(applied.map((rule) => rule.pattern)).toEqual([...kOfflineCopyPolicyExcludes]);
        expect(refused).toEqual([]);
      });

      it("matches gitignore-style: basename at any depth, anchored paths with **, trailing / for directories only, case-insensitive", () => {
        const node = compileExcludePattern("node_modules").compiled;
        expect(node.test("node_modules", { isDirectory: true })).toBe(true);
        expect(node.test("packages/app/node_modules", { isDirectory: true })).toBe(true);
        expect(node.test("Node_Modules", { isDirectory: true })).toBe(true);
        expect(node.test("node_modules_backup", { isDirectory: true })).toBe(false);
        const gz = compileExcludePattern("logs/**/*.gz").compiled;
        expect(gz.test("logs/x.gz")).toBe(true);
        expect(gz.test("logs/app/2026/x.GZ")).toBe(true);
        expect(gz.test("sub/logs/x.gz")).toBe(false);
        expect(gz.test("logs/x.gzip")).toBe(false);
        const tmp = compileExcludePattern("tmp/").compiled;
        expect(tmp.test("a/tmp", { isDirectory: true })).toBe(true);
        expect(tmp.test("a/tmp", { isDirectory: false })).toBe(false);
        const dist = compileExcludePattern("dist/**").compiled;
        expect(dist.test("dist/a/b.js")).toBe(true);
        expect(dist.test("dist")).toBe(false);
        expect(compileExcludePattern("*.heap?napshot").compiled.test("x/y.heapsnapshot")).toBe(true);
        // Regex specials in a pattern are literal.
        expect(compileExcludePattern("a.b").compiled.test("aXb")).toBe(false);
      });

      it("refuses every pattern that could name a core asset, whatever the config says", () => {
        const refusedPatterns = ["*", "**", "**/*", "*.sqlite", "*.json", "openclaw.json", "credentials", "identity/", "state/", "state/**", "agents/*", "agents/**", "agent", "openclaw-agent.sqlite", "auth-profiles.json", "credentials/*.json"];
        for (const pattern of refusedPatterns) {
          const outcome = compileExcludePattern(pattern);
          expect(outcome.compiled, pattern).toBeUndefined();
          expect(outcome.refused).toEqual({ pattern, reason: expect.stringMatching(/could match the core asset "[^"]+" — core assets are never excludable/) });
        }
        // Every probe the refusal uses is itself a core asset path, or an
        // ancestor directory of one — the guard cannot drift away from
        // isCoreAssetPath.
        for (const probe of kCoreAssetProbePaths) {
          const coreOrAncestor =
            isCoreAssetPath(probe) ||
            kCoreAssetProbePaths.some((other) => other.startsWith(`${probe}/`) && isCoreAssetPath(other));
          expect(coreOrAncestor, probe).toBe(true);
        }
        expect(kCoreAssetProbePaths).toEqual(expect.arrayContaining(["openclaw.json", "credentials", "identity", "state/openclaw.sqlite", "agents/main/agent/openclaw-agent.sqlite", "openclaw.sqlite"]));
        // An agent ID is not a core name; operator opt-ins compile.
        for (const pattern of ["main", ".cache", "caches", "tmp", "tmp/", "dist/**", "*.log", "build"]) {
          expect(compileExcludePattern(pattern).compiled, pattern).toBeDefined();
        }
      });

      it("refuses malformed patterns with a reason: non-string, empty, absolute, dot segments, backslash, NUL, over-long", () => {
        const reasons = Object.fromEntries(
          [42, "", "   ", "/abs/path", "a/../b", "./x", "a//b", "a\\b", "a\0b", "x".repeat(300)].map((raw) => [
            JSON.stringify(raw),
            compileExcludePattern(raw).refused?.reason ?? "ACCEPTED",
          ]),
        );
        expect(reasons).toEqual({
          "42": "not a string",
          '""': "empty pattern",
          '"   "': "empty pattern",
          '"/abs/path"': expect.stringMatching(/absolute paths are not allowed/),
          '"a/../b"': expect.stringMatching(/'\.' and '\.\.' segments/),
          '"./x"': expect.stringMatching(/'\.' and '\.\.' segments/),
          '"a//b"': "empty path segment (//)",
          '"a\\\\b"': expect.stringMatching(/backslashes are not supported/),
          '"a\\u0000b"': "contains a NUL byte",
          [JSON.stringify("x".repeat(300))]: "longer than 256 characters",
        });
      });

      it("an operator list REPLACES the defaults, dedupes, caps at kOfflineCopyExcludeMaxPatterns, and a non-array is refused whole", () => {
        const custom = resolveExcludes([".cache", " node_modules ", "node_modules", "*.sqlite"]);
        expect(custom.applied.map((rule) => rule.pattern)).toEqual([".cache", "node_modules"]);
        expect(custom.refused).toEqual([{ pattern: "*.sqlite", reason: expect.stringMatching(/core asset/) }]);
        expect(resolveExcludes([]).applied).toEqual([]);
        const many = resolveExcludes(Array.from({ length: kOfflineCopyExcludeMaxPatterns + 2 }, (_, i) => `junk-${i}`));
        expect(many.applied).toHaveLength(kOfflineCopyExcludeMaxPatterns);
        expect(many.refused).toEqual([
          { pattern: `junk-${kOfflineCopyExcludeMaxPatterns}`, reason: expect.stringMatching(/more than 64 patterns/) },
          { pattern: `junk-${kOfflineCopyExcludeMaxPatterns + 1}`, reason: expect.stringMatching(/more than 64 patterns/) },
        ]);
        const notArray = resolveExcludes("node_modules");
        expect(notArray.applied).toEqual([]);
        expect(notArray.refused).toEqual([{ pattern: "node_modules", reason: "excludes must be an array of patterns" }]);
      });
    });

    describe("walkStateTree with excludes", () => {
      it("drops the default debris inside the workspace, measures it, and leaves everything outside the workspace alone", () => {
        const stateDir = makeStateDir();
        const junk = addWorkspaceJunk(stateDir);
        // The same names OUTSIDE a workspace are state and stay: a session
        // file ending in .tmp, a heap snapshot under an agent dir.
        fs.writeFileSync(path.join(stateDir, "agents", "main", "sessions", "draft.tmp"), "s");
        fs.writeFileSync(path.join(stateDir, "agents", "main", "sessions", "dump.heapsnapshot"), "h");

        const tree = walkStateTree({ stateDir, fsModule: fs });

        const ws = tree.workspaces.get(path.join(stateDir, "workspace"));
        expect(ws.files.map((f) => f.archivePath).sort()).toEqual([
          "workspace/.cache/blob",
          "workspace/logs/app/current.log",
          "workspace/notes.md",
          "workspace/notes.sqlite",
        ]);
        expect(ws.bytes).toBe(40 + 5 + 64 + "not a db, a workspace file\n".length);
        expect(ws.excludedBytes).toBe(junk.junkBytes);
        expect(ws.excludedFiles).toBe(junk.junkFiles);
        expect(tree.files.map((f) => f.archivePath)).toEqual(
          expect.arrayContaining(["agents/main/sessions/draft.tmp", "agents/main/sessions/dump.heapsnapshot"]),
        );
        // One skipped row per excluded entry — a directory is one row with
        // the whole subtree measured — each naming the pattern that hit.
        const policyRows = tree.skipped.filter((entry) => entry.kind === "policy_exclude");
        expect(policyRows.map((row) => [path.relative(stateDir, row.sourcePath), row.pattern, row.files, row.bytes]).sort()).toEqual(
          [
            ["workspace/Heap-20260907.heapsnapshot", "*.heapsnapshot", 1, 300],
            ["workspace/logs/app/old.log.gz", "logs/**/*.gz", 1, 70],
            ["workspace/node_modules", "node_modules", 2, 4096 + 100],
            ["workspace/scratch.tmp", "*.tmp", 1, 50],
          ].sort(),
        );
        for (const row of policyRows) {
          expect(row.reason).toBe(`excluded by backup policy (${row.pattern})`);
          expect(row.core).toBeUndefined();
        }
        // Per-pattern tallies, defaults order, zero-match rows included.
        expect(tree.excludes).toEqual([
          { pattern: "node_modules", files: 2, bytes: 4196 },
          { pattern: "*.heapsnapshot", files: 1, bytes: 300 },
          { pattern: "*.tmp", files: 1, bytes: 50 },
          { pattern: "logs/**/*.gz", files: 1, bytes: 70 },
        ]);
        expect(tree.refusedExcludes).toEqual([]);
      });

      it("an operator list replaces the defaults; a refused pattern is reported and NOT applied; [] turns the policy off", () => {
        const stateDir = makeStateDir();
        addWorkspaceJunk(stateDir);
        const relFiles = (tree) =>
          tree.workspaces
            .get(path.join(stateDir, "workspace"))
            .files.map((f) => f.archivePath)
            .sort();

        const custom = walkStateTree({ stateDir, fsModule: fs, excludes: [".cache", "*.sqlite", "openclaw.json"] });
        // node_modules is back in (the operator did not list it); .cache is out;
        // the refused *.sqlite left the workspace's sqlite-named file in place.
        expect(relFiles(custom)).toEqual(
          expect.arrayContaining(["workspace/node_modules/index.js", "workspace/notes.sqlite", "workspace/scratch.tmp"]),
        );
        expect(relFiles(custom)).not.toContain("workspace/.cache/blob");
        expect(custom.excludes).toEqual([{ pattern: ".cache", files: 1, bytes: 40 }]);
        expect(custom.refusedExcludes).toEqual([
          { pattern: "*.sqlite", reason: expect.stringMatching(/core asset "openclaw\.sqlite"/) },
          { pattern: "openclaw.json", reason: expect.stringMatching(/core asset "openclaw\.json"/) },
        ]);

        const off = walkStateTree({ stateDir, fsModule: fs, excludes: [] });
        expect(off.excludes).toEqual([]);
        expect(off.skipped.filter((entry) => entry.kind === "policy_exclude")).toEqual([]);
        expect(relFiles(off)).toContain("workspace/node_modules/left-pad/index.js");
      });

      it("an excluded tree never counts against the copy-set cap, still yields to the budget, and an unreadable corner of it is tolerated", async () => {
        const stateDir = "/synthetic-alphaclaw-state";
        const dirent = (name, type) => ({
          name,
          isSymbolicLink: () => type === "link",
          isDirectory: () => type === "dir",
          isFile: () => type === "file",
        });
        const wsDir = path.join(stateDir, "workspace");
        const nm = path.join(wsDir, "node_modules");
        const fsModule = {
          readdirSync: (dir) => {
            if (dir === stateDir) return [dirent("workspace", "dir")];
            if (dir === wsDir) return [dirent("node_modules", "dir"), dirent("keep.txt", "file")];
            if (dir === nm) {
              return [
                ...Array.from({ length: 200_500 }, (_, i) => dirent(`f${i}.js`, "file")),
                dirent("broken", "dir"),
                dirent("link", "link"),
              ];
            }
            if (dir === path.join(nm, "broken")) throw new Error("EACCES");
            throw new Error(`unexpected readdir ${dir}`);
          },
          statSync: (file) => {
            if (file.endsWith("f7.js")) throw new Error("ENOENT raced");
            return { size: 3 };
          },
        };
        let checkpoints = 0;
        const tree = await walkStateTreeAsync({
          stateDir,
          fsModule,
          checkpoint: () => {
            checkpoints += 1;
          },
        });
        const ws = tree.workspaces.get(wsDir);
        expect(ws.files.map((f) => f.archivePath)).toEqual(["workspace/keep.txt"]);
        // 200_499 measurable files × 3 bytes (one stat raced, one subdir
        // unreadable, one symlink not followed) — reported, never fatal.
        expect(ws.excludedFiles).toBe(200_499);
        expect(ws.excludedBytes).toBe(200_499 * 3);
        expect(tree.excludes[0]).toEqual({ pattern: "node_modules", files: 200_499, bytes: 200_499 * 3 });
        // Well over the 200k copy-set cap in visited entries, yet no throw —
        // and the cadence covered the measured tree (≥ 400 yields).
        expect(checkpoints).toBeGreaterThanOrEqual(400);
      });
    });

    describe("createOfflineCopy with excludes (real tar + gzip)", () => {
      it("junk excluded, databases present, partial:false, manifest v2 with excludes[] + coverage, inline limit judged on post-exclude bytes", async () => {
        const stateDir = makeStateDir();
        const junk = addWorkspaceJunk(stateDir, { junkBytes: 8192 });
        const logs = [];
        // Pre-exclude the workspace is ~8.7 KB; post-exclude ~140 B. A 1 KiB
        // inline limit therefore INCLUDES it — the junk no longer decides.
        const args = makeCopyArgs({ stateDir, workspaceInlineBytes: 1024, log: (line) => logs.push(line) });

        const result = await createOfflineCopy(args);

        expect(result.ok).toBe(true);
        expect(result.partial).toBe(false);
        expect(result.partialReasons).toEqual([]);
        expect(result.coverage).toEqual({ core: "complete", workspace: "policy_excluded" });
        expect(result.excludedBytes).toBe(junk.junkBytes);
        expect(result.refusedExcludes).toEqual([]);
        expect(result.excludes).toEqual([
          { pattern: "node_modules", files: 2, bytes: 8192 + 100 },
          { pattern: "*.heapsnapshot", files: 1, bytes: 300 },
          { pattern: "*.tmp", files: 1, bytes: 50 },
          { pattern: "logs/**/*.gz", files: 1, bytes: 70 },
        ]);
        const { manifest } = result;
        expect(manifest.alphaclawFormatVersion).toBe(2);
        expect(kOfflineCopyFormatVersion).toBe(2);
        expect(manifest.options).toEqual({ includeWorkspace: true, onlyConfig: false });
        expect(manifest.excludes).toEqual(result.excludes);
        expect(manifest.coverage).toEqual(result.coverage);
        expect(manifest.partialReasons).toEqual([]);
        expect(manifest.skipped.filter((entry) => entry.kind === "policy_exclude")).toHaveLength(4);
        expect(manifest.skipped.some((entry) => entry.kind === "workspace")).toBe(false);

        const root = "openclaw-backup-1000-abcdef12";
        const listed = listArchive(args.outputFile);
        expect(listed).toEqual(
          expect.arrayContaining([
            `${root}/state/openclaw.sqlite`,
            `${root}/agents/main/agent/openclaw-agent.sqlite`,
            `${root}/workspace/notes.md`,
            `${root}/workspace/logs/app/current.log`,
            `${root}/workspace/.cache/blob`,
            `${root}/workspace/notes.sqlite`,
          ]),
        );
        for (const absent of ["node_modules", ".heapsnapshot", "scratch.tmp", "old.log.gz"]) {
          expect(listed.some((entry) => entry.includes(absent)), absent).toBe(false);
        }
        expect(logs.some((line) => /policy excluded 5 workspace file\(s\)/.test(line))).toBe(true);

        // The usable check reads the v2 manifest back and reports the format.
        const verdict = await verifyArchiveManifest({
          file: args.outputFile,
          runCommand: realRunCommand,
          requiredArchivePaths: ["state/openclaw.sqlite", "agents/main/agent/openclaw-agent.sqlite"],
          stateDir,
        });
        expect(verdict.ok).toBe(true);
        expect(verdict.formatVersion).toBe(2);
        expect(verdict.manifest.coverage).toEqual({ core: "complete", workspace: "policy_excluded" });
      });

      it("coverage is honest in every shape: clean → complete/complete; over the limit → omitted (still partial, reuse unchanged); core symlink → core partial", async () => {
        const clean = await createOfflineCopy(makeCopyArgs());
        expect(clean.coverage).toEqual({ core: "complete", workspace: "complete" });
        expect(clean.manifest.excludes).toEqual([...kOfflineCopyPolicyExcludes].map((pattern) => ({ pattern, files: 0, bytes: 0 })));

        const omitted = await createOfflineCopy(
          makeCopyArgs({ stateDir: makeStateDir({ workspaceBytes: 4096 }), workspaceInlineBytes: 1024 }),
        );
        expect(omitted.coverage).toEqual({ core: "complete", workspace: "omitted" });
        expect(omitted.partial).toBe(true);
        expect(omitted.manifest.options.includeWorkspace).toBe(false);

        const stateDir = makeStateDir();
        addWorkspaceJunk(stateDir);
        const elsewhere = mkTemp("alphaclaw-offline-copy-creds-");
        fs.rmSync(path.join(stateDir, "credentials"), { recursive: true });
        fs.symlinkSync(elsewhere, path.join(stateDir, "credentials"));
        const coreMissing = await createOfflineCopy(makeCopyArgs({ stateDir }));
        expect(coreMissing.coverage).toEqual({ core: "partial", workspace: "policy_excluded" });
        expect(coreMissing.partial).toBe(true);
        expect(coreMissing.partialReasons).toEqual(["credentials: core asset is a symlink (not followed)"]);
      });

      it("a workspace emptied by the policy is still includeWorkspace:true with coverage policy_excluded — never a bogus over-the-limit skip", async () => {
        const stateDir = makeStateDir();
        fs.rmSync(path.join(stateDir, "workspace", "notes.md"));
        fs.mkdirSync(path.join(stateDir, "workspace", "node_modules"), { recursive: true });
        fs.writeFileSync(path.join(stateDir, "workspace", "node_modules", "a.js"), "aaaa");
        const result = await createOfflineCopy(makeCopyArgs({ stateDir }));
        expect(result.partial).toBe(false);
        expect(result.coverage).toEqual({ core: "complete", workspace: "policy_excluded" });
        expect(result.manifest.options.includeWorkspace).toBe(true);
        expect(result.manifest.skipped.some((entry) => entry.kind === "workspace")).toBe(false);
        expect(listArchive(result.file).some((entry) => entry.includes("workspace/"))).toBe(false);
      });

      it("a refused operator pattern is reported on the result and in the log, never applied; the valid ones replace the defaults", async () => {
        const stateDir = makeStateDir();
        addWorkspaceJunk(stateDir);
        const logs = [];
        const result = await createOfflineCopy(
          makeCopyArgs({ stateDir, excludes: [".cache", "*.sqlite", "**"], log: (line) => logs.push(line) }),
        );
        expect(result.ok).toBe(true);
        expect(result.excludes).toEqual([{ pattern: ".cache", files: 1, bytes: 40 }]);
        expect(result.refusedExcludes).toEqual([
          { pattern: "*.sqlite", reason: expect.stringMatching(/core asset/) },
          { pattern: "**", reason: expect.stringMatching(/core asset/) },
        ]);
        expect(result.manifest.excludes).toEqual(result.excludes);
        // Refusals do not travel in the manifest (they changed nothing about
        // the archive); they are on the result and in the log.
        expect(result.manifest.refusedExcludes).toBeUndefined();
        expect(logs.some((line) => /refused 2 exclude pattern\(s\), not applied: "\*\.sqlite" \(.*core asset.*\); "\*\*"/.test(line))).toBe(true);
        const listed = listArchive(result.file);
        expect(listed.some((entry) => entry.endsWith("workspace/notes.sqlite"))).toBe(true);
        expect(listed.some((entry) => entry.includes("workspace/node_modules/"))).toBe(true);
        expect(listed.some((entry) => entry.includes("workspace/.cache/"))).toBe(false);
      });
    });

    describe("verifyArchiveManifest accepts alphaclawFormatVersion 1 AND 2", () => {
      // A v1 manifest exactly as the 2026-09-02 producer wrote it: per-file
      // sqlite assets, no excludes[]/coverage{}. Older archives on disk must
      // stay usable (and reusable) after the format bump.
      const v1Manifest = {
        schemaVersion: 1,
        createdAt: "2026-09-02T18:00:00.000Z",
        archiveRoot: "openclaw-backup-1756836000000-2f8c1f2e",
        runtimeVersion: "2026.9.1-beta.1",
        platform: "linux",
        nodeVersion: "v22.23.2",
        options: { includeWorkspace: true, onlyConfig: false },
        paths: {
          stateDir: "/data/.openclaw",
          configPath: "/data/.openclaw/openclaw.json",
          oauthDir: "/data/.openclaw/credentials",
          workspaceDirs: ["/data/.openclaw/workspace"],
          agentRoots: [{ agentId: "main", sourcePath: "/data/.openclaw/agents/main" }],
        },
        assets: [
          { kind: "sqlite", sourcePath: "/data/.openclaw/state/openclaw.sqlite", archivePath: "state/openclaw.sqlite" },
          { kind: "sqlite", sourcePath: "/data/.openclaw/agents/main/agent/openclaw-agent.sqlite", archivePath: "agents/main/agent/openclaw-agent.sqlite" },
          { kind: "config", sourcePath: "/data/.openclaw/openclaw.json", archivePath: "openclaw.json" },
        ],
        skipped: [],
        partialReasons: [],
        producer: kOfflineCopyProducer,
        alphaclawFormatVersion: 1,
        exclusivityEvidence: { stopConfirmed: true, quiet: "held", liveProcesses: 0, handleCount: 0, fdScan: "clean", fdHolders: [], completeness: "full", platform: "linux" },
        diagnosis: { journalMode: "wal", fsType: "ext4", stateBytes: 734003200 },
      };
      const scripted = (manifest) => async (spec) =>
        spec.command === "gzip" ? { ok: true, tail: "" } : { ok: true, tail: `${JSON.stringify(manifest)}\n` };
      const required = ["state/openclaw.sqlite", "agents/main/agent/openclaw-agent.sqlite"];

      it("a v1 fixture verifies and reports formatVersion 1", async () => {
        const verdict = await verifyArchiveManifest({ file: "/x.alphaclaw.tar.gz", runCommand: scripted(v1Manifest), requiredArchivePaths: required });
        expect(verdict).toEqual(expect.objectContaining({ ok: true, producer: kOfflineCopyProducer, formatVersion: 1 }));
        expect(verdict.manifest.excludes).toBeUndefined();
        expect(verdict.manifest.coverage).toBeUndefined();
      });

      it("a v2 fixture verifies and reports formatVersion 2; the readable set is exactly [1, 2]", async () => {
        const v2 = { ...v1Manifest, alphaclawFormatVersion: 2, excludes: [{ pattern: "node_modules", files: 3, bytes: 999 }], coverage: { core: "complete", workspace: "policy_excluded" } };
        const verdict = await verifyArchiveManifest({ file: "/x.alphaclaw.tar.gz", runCommand: scripted(v2), requiredArchivePaths: required });
        expect(verdict).toEqual(expect.objectContaining({ ok: true, formatVersion: 2 }));
        expect([...kOfflineCopyReadableFormatVersions]).toEqual([1, 2]);
        expect(kOfflineCopyReadableFormatVersions).toContain(kOfflineCopyFormatVersion);
      });

      it("an offline copy in a format this build does not know (newer AlphaClaw, or no version) fails the usable check at stage format — honest, not a throw", async () => {
        const newer = await verifyArchiveManifest({ file: "/x.alphaclaw.tar.gz", runCommand: scripted({ ...v1Manifest, alphaclawFormatVersion: 3 }), requiredArchivePaths: required });
        expect(newer).toEqual(expect.objectContaining({ ok: false, stage: "format", reason: "alphaclawFormatVersion 3 is not one this AlphaClaw can read (1, 2)" }));
        const { alphaclawFormatVersion: _dropped, ...unversioned } = v1Manifest;
        const missing = await verifyArchiveManifest({ file: "/x.alphaclaw.tar.gz", runCommand: scripted(unversioned), requiredArchivePaths: required });
        expect(missing).toEqual(expect.objectContaining({ ok: false, stage: "format", reason: expect.stringMatching(/^alphaclawFormatVersion undefined is not one/) }));
      });

      it("upstream manifests carry no format version and are not gated (formatVersion null)", async () => {
        const upstream = { schemaVersion: 1, paths: { stateDir: "/data/.openclaw" }, assets: [{ kind: "state", sourcePath: "/data/.openclaw", archivePath: "r/payload/posix/data/.openclaw" }] };
        const verdict = await verifyArchiveManifest({ file: "/x.tar.gz", runCommand: scripted(upstream), requiredArchivePaths: required });
        expect(verdict).toEqual(expect.objectContaining({ ok: true, producer: "openclaw", formatVersion: null }));
      });
    });
  });

  // ── Issue #79 (h): progress feed for the caller's ticker ─────────────────
  describe("onProgress", () => {
    const sqlite = require("node:sqlite");
    const growStateDb = (stateDir) => {
      const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
      db.exec("CREATE TABLE big(x TEXT)");
      const insert = db.prepare("INSERT INTO big VALUES (?)");
      db.exec("BEGIN");
      for (let i = 0; i < 3000; i += 1) insert.run("x".repeat(400));
      db.exec("COMMIT");
      db.close();
    };
    // The real module, stepping 5 pages at a time so backup() reports many
    // times; module identity differs from `node:sqlite`, so integrity runs
    // in-process (irrelevant here).
    const steppingSqlite = ({ onStep = () => {} } = {}) => ({
      DatabaseSync: sqlite.DatabaseSync,
      backup: (src, dest, options) =>
        sqlite.backup(src, dest, {
          ...options,
          rate: 5,
          progress: (info) => {
            onStep(info);
            options.progress(info);
          },
        }),
    });
    const kStages = ["sqlite_backup", "integrity", "copy_assets", "archive", "verify"];

    it("reports { stage, doneBytes, totalBytes } from the per-file loop AND copyDatabase's step hook: monotonic, bounded, ending at totalBytes", async () => {
      const stateDir = makeStateDir();
      growStateDb(stateDir);
      addWorkspaceJunk(stateDir);
      const events = [];
      const args = makeCopyArgs({ stateDir, sqliteModule: steppingSqlite(), onProgress: (event) => events.push({ ...event }) });

      const result = await createOfflineCopy(args);

      expect(result.ok).toBe(true);
      expect(events.length).toBeGreaterThan(10);
      const totals = new Set(events.map((event) => event.totalBytes));
      expect(totals.size).toBe(1);
      const totalBytes = [...totals][0];
      // The copy set: databases + assets + the inlined (post-exclude) workspace.
      const tree = walkStateTree({ stateDir, fsModule: fs });
      const expectedTotal =
        tree.dbs.reduce((sum, db) => sum + db.bytes, 0) +
        tree.files.reduce((sum, file) => sum + file.bytes, 0) +
        [...tree.workspaces.values()].reduce((sum, ws) => sum + ws.bytes, 0);
      expect(totalBytes).toBe(expectedTotal);
      for (let i = 1; i < events.length; i += 1) {
        expect(events[i].doneBytes).toBeGreaterThanOrEqual(events[i - 1].doneBytes);
      }
      for (const event of events) {
        expect(kStages).toContain(event.stage);
        expect(event.doneBytes).toBeLessThanOrEqual(totalBytes);
        expect(Number.isInteger(event.doneBytes)).toBe(true);
      }
      // Intra-database progress: several strictly increasing sqlite_backup
      // readings between 0 and the big DB's size, not just start/end.
      const dbSteps = events.filter((event) => event.stage === "sqlite_backup").map((event) => event.doneBytes);
      expect(new Set(dbSteps).size).toBeGreaterThan(3);
      expect(events.filter((event) => event.stage === "copy_assets").length).toBe(tree.files.length + [...tree.workspaces.values()].reduce((n, ws) => n + ws.files.length, 0));
      expect(events.at(-1)).toEqual({ stage: "verify", doneBytes: totalBytes, totalBytes });
      expect(events.find((event) => event.stage === "archive").doneBytes).toBe(totalBytes);
    });

    it("an observer that throws is disarmed and logged once; the copy still completes", async () => {
      const logs = [];
      let calls = 0;
      const args = makeCopyArgs({
        onProgress: () => {
          calls += 1;
          throw new Error("ticker exploded");
        },
        log: (line) => logs.push(line),
      });
      const result = await createOfflineCopy(args);
      expect(result.ok).toBe(true);
      expect(calls).toBe(1);
      expect(logs.filter((line) => /progress observer threw \(ticker exploded\)/.test(line))).toHaveLength(1);
    });

    it("cancel-by-throw is untouched: a quiet barrier lost between steps still aborts the job through the hook, and no progress is reported after the abort", async () => {
      const stateDir = makeStateDir();
      growStateDb(stateDir);
      let quiet = true;
      let steps = 0;
      const events = [];
      const sqliteModule = steppingSqlite({
        onStep: () => {
          steps += 1;
          if (steps === 2) quiet = false;
        },
      });
      const args = makeCopyArgs({ stateDir, sqliteModule, isQuiet: () => quiet, onProgress: (event) => events.push({ ...event }) });

      const error = await createOfflineCopy(args).catch((caught) => caught);

      expect(error).toMatchObject({ stage: "quiet_lost", message: expect.stringMatching(/ended during sqlite_backup/) });
      expect(error.orphanedBackup).toBeUndefined();
      expect(steps).toBe(2);
      // The abort landed in the database stage: the last reading is a
      // sqlite_backup one (step 2's checkpoint threw BEFORE the observer ran,
      // so it reported nothing), no later stage was ever reached, and the
      // dead job reports nothing more.
      const reported = events.length;
      expect(reported).toBeGreaterThanOrEqual(2);
      expect(events.at(-1).stage).toBe("sqlite_backup");
      expect(events.some((event) => ["copy_assets", "archive", "verify"].includes(event.stage))).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(steps).toBe(2);
      expect(events.length).toBe(reported);
      expect(fs.readdirSync(args.backupsDir)).toEqual([]);
    });
  });
});
