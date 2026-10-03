const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveCodexMigrationBuild, loadOpenclawMigrationApi, kMigrationModuleNotFound } = require("../../lib/server/openclaw-codex-migration-runtime");
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

  it("names an ABSENT chunk with a stable code and an export-less chunk with none (2026.9.4+ successor fallback)", async () => {
    // 2026.9.4 dropped `doctor-auth-flat-profiles-*` for `auth-profile-repair-*`.
    // The migration falls back on the code alone: a chunk that exists but
    // lost an export is a contract break, not a reason to try another chunk.
    const absent = await loadOpenclawMigrationApi({ build, prefix: "doctor-auth-flat-profiles", functionNames: ["maybeRepairOpenAICodexAuthConfig"] }).catch((error) => error);
    expect(absent).toBeInstanceOf(Error);
    expect(absent.code).toBe(kMigrationModuleNotFound);
    expect(absent.message).toContain("migration module not found: doctor-auth-flat-profiles");

    fs.writeFileSync(path.join(packageDir, "dist", "doctor-auth-flat-profiles-fixture.mjs"), "export function unrelated() {}\n");
    const exportless = await loadOpenclawMigrationApi({ build, prefix: "doctor-auth-flat-profiles", functionNames: ["maybeRepairOpenAICodexAuthConfig"] }).catch((error) => error);
    expect(exportless).toBeInstanceOf(Error);
    expect(exportless.code).toBeUndefined();
    expect(exportless.message).toContain("migration exports not found");

    // The successor chunk is matched by function NAME, not export key: 2026.9.5
    // publishes `export { repairAuthProfileMigration as t }`.
    fs.writeFileSync(path.join(packageDir, "dist", "auth-profile-repair-fixture.mjs"), "async function repairAuthProfileMigration() { return \"composed\"; }\nexport { repairAuthProfileMigration as t };\n");
    const api = await loadOpenclawMigrationApi({ build, prefix: "auth-profile-repair", functionNames: ["repairAuthProfileMigration"] });
    expect(await api.repairAuthProfileMigration()).toBe("composed");
  });

  it("loads optional exports when present and tolerates their absence", async () => {
    fs.writeFileSync(path.join(packageDir, "dist", "codex-route-warnings-fixture.mjs"), "export function readFixture() { return 1; }\nexport function retiredRepair() { return 2; }\n");
    const api = await loadOpenclawMigrationApi({ build, prefix: "codex-route-warnings", functionNames: ["readFixture"], optionalFunctionNames: ["retiredRepair", "neverShipped"] });
    expect(api.retiredRepair()).toBe(2);
    expect(api.neverShipped).toBeUndefined();
  });
});
