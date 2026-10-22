const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveCodexMigrationBuild, loadOpenclawMigrationApi } = require("../../lib/server/openclaw-codex-migration-runtime");
const { resolveSelfDependency } = require("../../lib/server/self-dependency");

describe("Codex migration executing build", () => {
  let rootDir;
  let packageDir;
  let build;
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-codex-runtime-"));
    packageDir = path.join(rootDir, "node_modules", "openclaw");
    fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
    build = { packageDir, bin: path.join(packageDir, "openclaw.mjs"), version: "2026.9.2", buildId: `2026.9.2-${path.basename(rootDir)}`, source: "installed" };
  });
  afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const writeApi = (value, extension = "js") => fs.writeFileSync(path.join(packageDir, "dist", `codex-route-warnings-fixture.${extension}`), `export function readFixture() { return ${JSON.stringify(value)}; }\n`);
  const loadApi = (target) => loadOpenclawMigrationApi({ build: target, prefix: "codex-route-warnings", functionNames: ["readFixture"] });

  it("resolves the pinned package installed beside AlphaClaw", () => {
    const resolved = resolveCodexMigrationBuild();
    const installDir = resolveSelfDependency().installDir;
    expect(resolved).toMatchObject({ source: "installed", packageDir: path.join(installDir, "node_modules", "openclaw") });
    expect(fs.existsSync(resolved.bin)).toBe(true);
  });

  it.each(["js", "mjs"])("imports the installed package's .%s chunks without a package main export", async (extension) => {
    writeApi("installed", extension);
    expect((await loadApi(build)).readFixture()).toBe("installed");
  });

  it("refuses an unknown build", async () => {
    await expect(loadApi(null)).rejects.toThrow("Executing OpenClaw build is unknown");
  });

  it.each(["js", "mjs"])("refuses absent required .%s migration APIs", async (extension) => {
    await expect(loadApi(build)).rejects.toThrow(`OpenClaw ${build.buildId} migration module not found`);
    writeApi("fixture", extension);
    await expect(loadOpenclawMigrationApi({ build, prefix: "codex-route-warnings", functionNames: ["maybeRepairCodexRoutes"] })).rejects.toThrow("migration exports not found");
  });

  it("matches the successor chunk by function NAME, not export key", async () => {
    // 2026.9.5+ publishes `export { repairAuthProfileMigration as t }`.
    fs.writeFileSync(path.join(packageDir, "dist", "auth-profile-repair-fixture.mjs"), "async function repairAuthProfileMigration() { return \"composed\"; }\nexport { repairAuthProfileMigration as t };\n");
    const api = await loadOpenclawMigrationApi({ build, prefix: "auth-profile-repair", functionNames: ["repairAuthProfileMigration"] });
    expect(await api.repairAuthProfileMigration()).toBe("composed");
  });

  it("imports only the prefix chunks whose source names a wanted function", async () => {
    const dist = path.join(packageDir, "dist");
    fs.writeFileSync(path.join(dist, "sqlite-a.mjs"), "throw new Error(\"unrelated chunk imported\");\n");
    fs.writeFileSync(path.join(dist, "sqlite-b.mjs"), "function runAuthProfileWriteTransaction() { return \"named\"; }\nexport { runAuthProfileWriteTransaction as r };\n");
    fs.writeFileSync(path.join(dist, "sqlite-c.js"), "throw new Error(\"unrelated chunk imported\");\n");
    const api = await loadOpenclawMigrationApi({ build, prefix: "sqlite", functionNames: ["runAuthProfileWriteTransaction"] });
    expect(api.runAuthProfileWriteTransaction()).toBe("named");
  });

  it("falls back to every prefix chunk when no source names a wanted function", async () => {
    const dist = path.join(packageDir, "dist");
    fs.writeFileSync(path.join(dist, "sqlite-a.mjs"), "export function unrelated() {}\n");
    fs.writeFileSync(path.join(dist, "sqlite-b.mjs"), "const f = () => \"renamed\";\nObject.defineProperty(f, \"name\", { value: [\"runAuthProfile\", \"WriteTransaction\"].join(\"\") });\nexport { f as r };\n");
    const api = await loadOpenclawMigrationApi({ build, prefix: "sqlite", functionNames: ["runAuthProfileWriteTransaction"] });
    expect(api.runAuthProfileWriteTransaction()).toBe("renamed");
  });
});
