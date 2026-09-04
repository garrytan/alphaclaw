// The live tiers' `openclaw backup` double must produce an archive the
// PRODUCT's usable check accepts — with real gzip and real GNU tar, the same
// binaries the check spawns in production. A plain-text stub once made every
// hard-gated live apply refuse honestly ("not in gzip format"), so this pins
// the double to upstream's archive layout instead of to "a file exists".
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createBackupStubRunner } = require("../live/live-helpers");
const { verifyArchiveManifest } = require("../../lib/server/openclaw-backup-offline-copy");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");

const kRequiredDbs = ["state/openclaw.sqlite", "agents/main/agent/openclaw-agent.sqlite"];

describe("live-helpers createBackupStubRunner (real tar/gzip)", () => {
  let rootDir;
  let stateDir;
  let backupsDir;
  const realRunner = createRunStream({});
  const runCommand = (spec) => realRunner.runStreamed(spec);

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-backup-stub-test-"));
    stateDir = path.join(rootDir, ".openclaw");
    backupsDir = path.join(rootDir, "backups", "openclaw");
    fs.mkdirSync(path.join(stateDir, "state"), { recursive: true });
    fs.mkdirSync(path.join(stateDir, "agents", "main", "agent"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}\n");
    for (const rel of kRequiredDbs) {
      fs.writeFileSync(path.join(stateDir, rel), Buffer.alloc(4096, 7));
    }
    // A runtime tree under the openclaw dir that a backup must not drag along.
    fs.mkdirSync(path.join(stateDir, ".alphaclaw", "overlays", "x"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, ".alphaclaw", "overlays", "x", "big"), Buffer.alloc(1 << 20));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const backupTo = (runner, out) =>
    runner.runStreamed({
      command: "openclaw",
      args: ["backup", "create", "--verify", "--output", out],
      env: {},
    });

  it("writes a real upstream-layout archive that the product's usable check accepts", async () => {
    const runner = createBackupStubRunner(realRunner, { stateDir });
    const out = path.join(backupsDir, "openclaw-backup-1-abcdef01.tar.gz");

    const result = await backupTo(runner, out);

    expect(result).toEqual(
      expect.objectContaining({ ok: true, code: 0, tail: expect.stringContaining("Archive verification: passed") }),
    );
    expect(fs.statSync(out).size).toBeGreaterThan(0);
    const verdict = await verifyArchiveManifest({
      file: out,
      runCommand,
      requiredArchivePaths: kRequiredDbs,
      stateDir,
    });
    expect(verdict).toEqual(
      expect.objectContaining({
        ok: true,
        producer: "openclaw",
        manifest: expect.objectContaining({
          schemaVersion: 1,
          paths: expect.objectContaining({ stateDir: path.resolve(stateDir) }),
          assets: [expect.objectContaining({ kind: "state", sourcePath: path.resolve(stateDir) })],
        }),
      }),
    );
    // The payload really carries the state files and skips the runtime tree.
    const listing = await runCommand({ command: "tar", args: ["-tzf", out], tailBytes: 1 << 20 });
    expect(listing.ok).toBe(true);
    for (const rel of kRequiredDbs) {
      expect(listing.tail).toContain(`/payload/posix${path.resolve(stateDir)}/${rel}`);
    }
    expect(listing.tail).not.toContain(".alphaclaw/overlays");
  });

  it("refuses to overwrite an existing archive (the real CLI's contract) and leaves it intact", async () => {
    const runner = createBackupStubRunner(realRunner, { stateDir });
    const out = path.join(backupsDir, "openclaw-backup-2-abcdef02.tar.gz");
    expect((await backupTo(runner, out)).ok).toBe(true);
    const before = fs.readFileSync(out);

    const second = await backupTo(runner, out);

    expect(second.ok).toBe(false);
    expect(second.tail).toMatch(/Refusing to overwrite existing backup archive/);
    expect(fs.readFileSync(out).equals(before)).toBe(true);
  });

  it("treats an existing directory target as a directory and writes a timestamped archive inside it", async () => {
    const runner = createBackupStubRunner(realRunner, { stateDir });
    fs.mkdirSync(backupsDir, { recursive: true });

    const result = await backupTo(runner, backupsDir);

    expect(result.ok).toBe(true);
    const written = fs.readdirSync(backupsDir).filter((name) => /-openclaw-backup\.tar\.gz$/.test(name));
    expect(written).toHaveLength(1);
    const verdict = await verifyArchiveManifest({
      file: path.join(backupsDir, written[0]),
      runCommand,
      requiredArchivePaths: kRequiredDbs,
      stateDir,
    });
    expect(verdict.ok).toBe(true);
  });

  it("resolves the state dir from the spawn env when no option is given, and fails loudly with neither", async () => {
    const out = path.join(backupsDir, "openclaw-backup-3-abcdef03.tar.gz");
    const fromEnv = await createBackupStubRunner(realRunner).runStreamed({
      command: "openclaw",
      args: ["backup", "create", "--output", out],
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    expect(fromEnv.ok).toBe(true);
    expect((await verifyArchiveManifest({ file: out, runCommand, requiredArchivePaths: kRequiredDbs, stateDir })).ok).toBe(true);

    const blind = path.join(backupsDir, "openclaw-backup-4-abcdef04.tar.gz");
    const result = await backupTo(createBackupStubRunner(realRunner), blind);
    expect(result.ok).toBe(false);
    expect(result.tail).toMatch(/backup stub needs the state dir/);
    // Never a fake artifact the hard gate could mistake for a backup.
    expect(fs.existsSync(blind)).toBe(false);
  });

  it("passes every non-backup command to the real runner untouched", async () => {
    const seen = [];
    const fake = { runStreamed: (opts) => { seen.push(opts); return Promise.resolve({ ok: true, code: 0, tail: "" }); } };
    const runner = createBackupStubRunner(fake, { stateDir });
    await runner.runStreamed({ command: "gzip", args: ["-t", "/x"] });
    await runner.runStreamed({ command: "openclaw", args: ["gateway", "stop"] });
    expect(seen.map((o) => o.command)).toEqual(["gzip", "openclaw"]);
  });
});
