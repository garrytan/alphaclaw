const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHash } = require("crypto");
const { execFileSync } = require("child_process");
const { matchSqliteArtifact, qualifySqliteArtifacts, kProducerContract } = require("../../lib/server/openclaw-sqlite-artifacts");
const { pinnedBuild, copyPinnedBuild, evidence } = require("../fixtures/sqlite-artifact-build");

describe("producer-qualified SQLite artifacts", () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-contract-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const uuid = "11111111-2222-3333-4444-555555555555";
  it.each(["generation-lock", "generation-writer", "reindex-lock", "memory-reindex", "backup", "tmp"])("recognizes %s and all sidecars without conferring authority", (family) => {
    const basename = family.includes("generation") || family === "reindex-lock" ? `main.sqlite.${family}.sqlite` : `main.sqlite.${family}-${uuid}`;
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      expect(matchSqliteArtifact(`/state/${basename}${suffix}`)).toMatchObject({ family });
      expect(matchSqliteArtifact(`${basename}${suffix}`.toUpperCase())).toMatchObject({ family });
    }
  });
  it.each(["lock.sqlite", "main.lock.sqlite", "generation-lock.sqlite", "main.generation-lock.sqlite", "main.sqlite.generation-lock.sqlite.bak", "main.sqlite.tmp-invalid", "main.sqlite.memory-reindex-11111111-2222-3333-4444-55555555555z", `main.sqlite.tmp-${uuid}.sqlite`, "main.sqlite", ".sqlite.reindex-lock.sqlite"])("retains nonmatching %s", (name) => expect(matchSqliteArtifact(name)).toBeNull());
  it("pins actual installed distribution bytes, not a mutable version claim", () => {
    expect(kProducerContract.files).toEqual(evidence.files);
    for (const [relative, hash] of Object.entries(evidence.files)) expect(createHash("sha256").update(fs.readFileSync(path.join(pinnedBuild.packageDir, relative))).digest("hex")).toBe(hash);
    expect(qualifySqliteArtifacts({ executingBuild: pinnedBuild })).toMatchObject({ qualified: true, families: ["generation-lock", "generation-writer", "reindex-lock", "memory-reindex"] });
    for (const source of ["installed", "overlay"]) expect(qualifySqliteArtifacts({ executingBuild: copyPinnedBuild(path.join(root, source), source) }).qualified).toBe(true);
  });
  it("never trusts missing, future, dev, changed, symlinked or oversized producer content", () => {
    for (const executingBuild of [null, { version: evidence.version }, { ...pinnedBuild, source: "dev" }, { ...pinnedBuild, version: "2026.9.6" }]) expect(qualifySqliteArtifacts({ executingBuild }).qualified).toBe(false);
    const build = copyPinnedBuild(path.join(root, "copy"));
    const relative = Object.keys(evidence.files)[0];
    const file = path.join(build.packageDir, relative);
    fs.appendFileSync(file, "\n");
    expect(qualifySqliteArtifacts({ executingBuild: build }).qualified).toBe(false);
    fs.unlinkSync(file);
    fs.symlinkSync(path.join(pinnedBuild.packageDir, relative), file);
    expect(qualifySqliteArtifacts({ executingBuild: build }).qualified).toBe(false);
    fs.unlinkSync(file);
    fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 1));
    expect(qualifySqliteArtifacts({ executingBuild: build }).qualified).toBe(false);
  });

  it.each(["package.json", ...Object.keys(evidence.files)])("refuses a real producer FIFO without waiting for a writer: %s", (relative) => {
    const build = copyPinnedBuild(path.join(root, "copy"));
    const file = path.join(build.packageDir, relative);
    fs.unlinkSync(file);
    execFileSync("mkfifo", [file]);
    const script = `const { qualifySqliteArtifacts } = require(process.argv[1]); process.stdout.write(JSON.stringify(qualifySqliteArtifacts({ executingBuild: JSON.parse(process.argv[2]) })));`;
    const output = execFileSync(process.execPath, ["-e", script, require.resolve("../../lib/server/openclaw-sqlite-artifacts"), JSON.stringify(build)], { encoding: "utf8", timeout: 2000 });
    expect(JSON.parse(output)).toMatchObject({ qualified: false, reason: "unsupported_transient_artifact_contract" });
    expect(fs.lstatSync(file).isFIFO()).toBe(true);
  });
});
