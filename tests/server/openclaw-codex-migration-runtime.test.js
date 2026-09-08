const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveCodexMigrationBuild, loadOpenclawMigrationApi } = require("../../lib/server/openclaw-codex-migration-runtime");
const { createOpenclawReleaseChannelStore } = require("../../lib/server/openclaw-release-channel");

const kShaA = "a".repeat(40);
const kShaB = "b".repeat(40);

describe("Codex migration executing build", () => {
  let rootDir;
  let openclawDir;
  let checkoutDir;
  let env;
  let store;
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-codex-runtime-"));
    openclawDir = path.join(rootDir, ".openclaw");
    checkoutDir = path.join(rootDir, "openclaw");
    fs.mkdirSync(path.join(checkoutDir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(checkoutDir, "dist"));
    fs.writeFileSync(path.join(checkoutDir, "package.json"), JSON.stringify({ version: "2026.9.2", type: "module", bin: { openclaw: "openclaw.mjs" } }));
    fs.writeFileSync(path.join(checkoutDir, "openclaw.mjs"), "// verified fixture entrypoint\n");
    fs.writeFileSync(path.join(checkoutDir, ".git", "HEAD"), kShaA);
    env = { ALPHACLAW_ROOT_DIR: rootDir, OPENCLAW_STATE_DIR: openclawDir };
    store = createOpenclawReleaseChannelStore({ rootDir, openclawDir });
    store.writeBinShim({ targetBin: path.join(checkoutDir, "openclaw.mjs") });
  });
  afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const describeBuild = () => resolveCodexMigrationBuild({ configPath: path.join(openclawDir, "openclaw.json"), env });
  const writeApi = (value, extension = "js") => fs.writeFileSync(path.join(checkoutDir, "dist", `codex-route-warnings-fixture.${extension}`), `export function readFixture() { return ${JSON.stringify(value)}; }\n`);
  const loadApi = (build) => loadOpenclawMigrationApi({ build, prefix: "codex-route-warnings", functionNames: ["readFixture"] });

  it.each(["js", "mjs"])("imports the selected dev package's .%s chunks without a package main export instead of the dormant pin", async (extension) => {
    writeApi("selected dev", extension);
    const build = describeBuild();
    expect(build).toMatchObject({ packageDir: checkoutDir, buildId: kShaA, version: "2026.9.2", source: "dev" });
    expect((await loadApi(build)).readFixture()).toBe("selected dev");
  });

  it.each(["js", "mjs"])("does not reuse .%s migration exports when two dev commits share their package version", async (extension) => {
    writeApi("first commit", extension);
    expect((await loadApi(describeBuild())).readFixture()).toBe("first commit");
    fs.writeFileSync(path.join(checkoutDir, ".git", "HEAD"), kShaB);
    writeApi("second commit", extension);
    expect((await loadApi(describeBuild())).readFixture()).toBe("second commit");
  });

  it.each(["js", "mjs"])("refuses absent required .%s migration APIs without borrowing the dormant pin's implementation", async (extension) => {
    const build = describeBuild();
    await expect(loadApi(build)).rejects.toThrow(`OpenClaw ${kShaA} migration module not found`);
    writeApi("fixture", extension);
    await expect(loadOpenclawMigrationApi({ build, prefix: "codex-route-warnings", functionNames: ["maybeRepairCodexRoutes"] })).rejects.toThrow("migration exports not found");
  });

  it("uses the installed fallback when the selected checkout cannot execute", () => {
    fs.rmSync(path.join(checkoutDir, "openclaw.mjs"));
    const build = describeBuild();
    expect(build.source).toBe("installed");
    expect(build.packageDir).not.toBe(checkoutDir);
    expect(fs.existsSync(build.bin)).toBe(true);
  });
});
