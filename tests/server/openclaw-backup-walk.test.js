const fs = require("fs");
const os = require("os");
const path = require("path");
const { walkStateTreeAsync } = require("../../lib/server/openclaw-backup-walk");
const { buildMigrationInventory } = require("../../lib/server/openclaw-backup-inventory");
const { resolveBackupPolicy } = require("../../lib/server/openclaw-backup-policy");

let root;
const write = (name, value = "data") => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
  return file;
};
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-walk-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("complete backup diagnosis", () => {
  it("counts a lazy 250k-entry tree completely while excluding 200k scratch files from the copy cap", async () => {
    const listings = new Map([
      [root, ["worktrees", "workspace", "keep"]],
      [path.join(root, "workspace"), [".openclaw"]],
      [path.join(root, "worktrees"), 100_000],
      [path.join(root, "workspace/.openclaw"), 100_000],
      [path.join(root, "keep"), 50_000],
    ]);
    let openHandles = 0;
    let filesRead = 0;
    const fsModule = { ...fs,
      opendirSync(directory) {
        const listing = listings.get(directory);
        if (listing === undefined) throw new Error("unexpected directory");
        openHandles++;
        let index = 0;
        return {
          readSync() {
            if (index >= (Array.isArray(listing) ? listing.length : listing)) return null;
            const name = Array.isArray(listing) ? listing[index++] : `file-${index++}`;
            const isDirectory = listings.has(path.join(directory, name));
            if (!isDirectory) filesRead++;
            return { name, isDirectory: () => isDirectory, isFile: () => !isDirectory, isSymbolicLink: () => false };
          },
          closeSync() { openHandles--; },
        };
      },
      statSync: () => ({ size: 4 }),
    };
    const { diagnostics } = await walkStateTreeAsync({ stateDir: root, diagnostic: true, fsModule });
    expect(diagnostics).toMatchObject({ complete: true, measurementComplete: true, entries: 250_004, bytes: 1_000_000,
      selectedEntries: 50_004, copyBudget: { exceeded: false },
      selection: { assetCount: 50_000, assetBytes: 200_000, excludedFiles: 200_000, excludedBytes: 800_000 },
    });
    expect(diagnostics.topLevel).toEqual([
      { path: "worktrees", entries: 100_001, bytes: 400_000, partial: false },
      { path: "workspace", entries: 100_002, bytes: 400_000, partial: false },
      { path: "keep", entries: 50_001, bytes: 200_000, partial: false },
    ]);
    expect(filesRead).toBe(250_000);
    expect(openHandles).toBe(0);
  }, 15_000);

  it("finishes counting selected and excluded files after both legacy caps", async () => {
    write("openclaw.json", "{}");
    for (let index = 0; index < 20; index++) {
      write(`worktrees/scratch/file-${index}`);
      write(`workspace/.openclaw/legacy/file-${index}`);
      write(`keep/file-${index}`);
    }
    for (let index = 0; index < 6; index++) write(`other-${index}/file`);
    const tree = await walkStateTreeAsync({ stateDir: root, mode: "diagnosis", maxEntries: 10, measurementMaxEntries: 1 });
    expect(tree.diagnostics).toMatchObject({ complete: true, measurementComplete: true, entries: 79, bytes: 266,
      copyBudget: { maxEntries: 10, exceeded: true },
      selection: { assetCount: 27, assetBytes: 106, excludedFiles: 40, excludedBytes: 160 },
    });
    expect(tree.diagnostics.topLevel).toHaveLength(10);
    expect(tree.diagnostics.topLevel).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "worktrees", entries: 22, bytes: 80, partial: false }),
      expect.objectContaining({ path: "workspace", entries: 23, bytes: 80, partial: false }),
      expect.objectContaining({ path: "keep", entries: 21, bytes: 80, partial: false }),
    ]));
    expect(tree.files.length).toBeLessThanOrEqual(10);
  });

  it("reports every absolute symlink, including excluded wiki and env links, without following directory links", async () => {
    write("actual/openclaw.json", "{}");
    write("actual/wiki/keep", "x");
    const actual = path.join(root, "actual");
    const alias = path.join(root, "alias");
    fs.symlinkSync(actual, alias);
    fs.symlinkSync("/outside/secret", path.join(actual, ".env"));
    fs.symlinkSync("/outside/wiki", path.join(actual, "wiki", "absolute"));
    fs.symlinkSync("../openclaw.json", path.join(actual, "wiki", "relative"));
    fs.symlinkSync(actual, path.join(actual, "cycle"));
    const tree = await walkStateTreeAsync({ stateDir: alias, mode: "diagnosis", measurementMaxEntries: 0 });
    expect(tree.diagnostics).toMatchObject({ complete: true, rootSymlink: true, stateDir: actual, entries: 7, absoluteSymlinkCount: 3 });
    expect(tree.diagnostics.absoluteSymlinks).toEqual(expect.arrayContaining([
      { path: ".env", target: "/outside/secret" },
      { path: "wiki/absolute", target: "/outside/wiki" },
      { path: "cycle", target: actual },
    ]));
    expect(tree.files.map((file) => file.archivePath)).toEqual(["openclaw.json"]);
  });

  it("fails closed with partial diagnostics when complete excluded measurement cannot finish", async () => {
    write("worktrees/scratch/file");
    let clock = 0;
    await expect(walkStateTreeAsync({ stateDir: root, mode: "diagnosis", diagnosisMs: 2, nowFn: () => clock++, checkpointEvery: 1 }))
      .rejects.toMatchObject({ code: "diagnosis_budget", stage: "enumerate", diagnostics: { complete: false } });
    const fsModule = { ...fs, opendirSync(directory) {
      if (directory.endsWith("/scratch")) throw new Error("unreadable");
      return fs.opendirSync(directory);
    } };
    await expect(walkStateTreeAsync({ stateDir: root, mode: "diagnosis", fsModule }))
      .rejects.toMatchObject({ stage: "enumerate", diagnostics: { complete: false, measurementComplete: false } });
  });

  it("reports ten thousand excluded absolute wiki links and both forms of env in under five seconds", async () => {
    write("openclaw.json", "{}");
    write(".env");
    write("wiki/real", "x");
    fs.symlinkSync("/outside/env", path.join(root, "wiki/.env"));
    for (let index = 0; index < 10_000; index++) fs.symlinkSync(`/outside/wiki-${index}`, path.join(root, `wiki/link-${index}`));
    const started = performance.now();
    const { diagnostics } = await walkStateTreeAsync({ stateDir: root, diagnostic: true });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(diagnostics).toMatchObject({ complete: true, entries: 10_005, absoluteSymlinkCount: 10_001, envFileCount: 2 });
    expect(diagnostics.absoluteSymlinks).toHaveLength(10_001);
    expect(diagnostics.envFiles.toSorted()).toEqual([".env", "wiki/.env"]);
  }, 15_000);
});

describe("safe default backup selection", () => {
  it("omits scratch, derived state and every env file even with policy disabled", async () => {
    write("openclaw.json", "{}");
    for (const name of ["worktrees/a/checkout", "workspace/.openclaw/old/checkout", "wiki/generated", "logs/current.log", "state/main.sqlite.corrupt-1", "state/main.sqlite.migrated-old"])
      write(name);
    write(".env");
    write("workspace/.env");
    write("credentials/.env");
    const inventory = await buildMigrationInventory({ stateDir: root, spawnEnv: {} });
    const tree = await walkStateTreeAsync({ stateDir: root, inventory });
    expect(tree.files.map((file) => file.archivePath)).toEqual(["openclaw.json"]);
    expect([...tree.workspaces.values()].flatMap((ws) => ws.files)).toEqual([]);
    const disabled = await walkStateTreeAsync({ stateDir: root, inventory, excludes: [], rootExcludes: [] });
    expect([...disabled.files, ...[...disabled.workspaces.values()].flatMap((ws) => ws.files)]
      .some((file) => file.archivePath.split("/").includes(".env"))).toBe(false);
  });

  it("refuses default scratch rules covering configured migration owners", async () => {
    const owner = path.join(root, "worktrees", "required");
    write("openclaw.json", JSON.stringify({ agents: { list: [{ id: "main", agentDir: owner }] } }));
    write("worktrees/required/auth.json");
    const inventory = await buildMigrationInventory({ stateDir: root, spawnEnv: {} });
    const policy = resolveBackupPolicy({}, { inventory });
    expect(policy.rootExcludes).not.toContain("worktrees/**");
    expect(policy.refused).toEqual(expect.arrayContaining([expect.objectContaining({ pattern: "worktrees/**", scope: "root" })]));
    const tree = await walkStateTreeAsync({ stateDir: root, inventory, policy });
    expect(tree.files.map((file) => file.archivePath)).toContain("worktrees/required/auth.json");
  });
});
