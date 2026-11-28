const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const tar = require("tar");

const { kLiveEnabled, mkTemp, scrubTestRunnerEnv, waitFor } = require("./live-helpers");
const override = require("../../lib/server/openclaw-package-override");
const { describeExecutingBuild } = require("../../lib/server/openclaw-build");
const { withOpenclawStartupEnv } = require("../../lib/server/openclaw-runtime-env");

// LIVE tier: the pinned OpenClaw booted from a sha-pinned stand-in package
// (ALPHACLAW_OPENCLAW_PACKAGES). The stand-in is the installed pin repacked
// the way a carried build is shaped: one extra bundled copy of a declared
// dependency, the .openclaw-lifecycle-pending marker its own postinstall
// clears, and an entry point that records which build ran. It is applied to
// a copy of the install (the repo's own node_modules/openclaw is never
// touched), the real gateway boots from it twice under one compile cache,
// and the per-launch check is held against what the gateway wrote. Run:
//   OPENCLAW_LIVE_E2E=1 npx vitest run tests/live/openclaw-pinned-package.e2e.test.js
const describeLive = kLiveEnabled ? describe : describe.skip;

const kTestTimeoutMs = 10 * 60 * 1000;
const kPort = 18998;
const kRepoInstall = path.resolve(__dirname, "../..");
const kRepoNodeModules = path.join(kRepoInstall, "node_modules");

const copyTree = (from, to) => fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });

// An install dir whose node_modules/openclaw is a real copy of the pin and
// every other package links back to the repo's node_modules.
const makeInstallCopy = (rootDir) => {
  const installDir = path.join(rootDir, "install");
  const nodeModules = path.join(installDir, "node_modules");
  fs.mkdirSync(nodeModules, { recursive: true });
  for (const name of fs.readdirSync(kRepoNodeModules)) {
    if (name === "openclaw" || name === ".bin" || name.startsWith(".")) continue;
    fs.symlinkSync(path.join(kRepoNodeModules, name), path.join(nodeModules, name));
  }
  copyTree(path.join(kRepoNodeModules, "openclaw"), path.join(nodeModules, "openclaw"));
  return installDir;
};

const makeStandIn = ({ rootDir, probeFile }) => {
  const src = path.join(rootDir, "standin-src");
  const pkgRoot = path.join(src, "package");
  const stock = path.join(kRepoNodeModules, "openclaw");
  const stockPkg = JSON.parse(fs.readFileSync(path.join(stock, "package.json"), "utf8"));
  copyTree(stock, pkgRoot);
  for (const name of fs.readdirSync(path.join(pkgRoot, "node_modules"))) {
    if (!(stockPkg.bundleDependencies || []).includes(name)) fs.rmSync(path.join(pkgRoot, "node_modules", name), { recursive: true, force: true });
  }
  fs.rmSync(path.join(pkgRoot, "dist", "extensions", "node_modules"), { recursive: true, force: true });
  const extra = Object.keys(stockPkg.dependencies || {})
    .sort()
    .find((name) => !name.startsWith("@") && !(stockPkg.bundleDependencies || []).includes(name) && fs.existsSync(path.join(kRepoNodeModules, name, "package.json")) && !fs.existsSync(path.join(kRepoNodeModules, name, "node_modules")));
  copyTree(path.join(kRepoNodeModules, extra), path.join(pkgRoot, "node_modules", extra));
  const pkg = { ...stockPkg, bundleDependencies: [...(stockPkg.bundleDependencies || []), extra] };
  fs.writeFileSync(path.join(pkgRoot, "package.json"), JSON.stringify(pkg, null, 2));
  fs.writeFileSync(path.join(pkgRoot, ".openclaw-lifecycle-pending"), "pending\n");
  const entry = path.join(pkgRoot, "openclaw.mjs");
  const text = fs.readFileSync(entry, "utf8");
  const shebang = text.startsWith("#!") ? text.slice(0, text.indexOf("\n") + 1) : "";
  const probe = `try { (await import("node:fs")).appendFileSync(${JSON.stringify(probeFile)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2, 4) }) + "\\n"); } catch {}\n`;
  fs.writeFileSync(entry, shebang + probe + text.slice(shebang.length));
  const file = path.join(rootDir, "openclaw-packages", `openclaw-${stockPkg.version}-standin.tgz`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  tar.c({ gzip: true, file, cwd: src, sync: true, portable: true }, ["package"]);
  fs.chmodSync(file, 0o600);
  fs.rmSync(src, { recursive: true, force: true });
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  return { file, sha256, version: stockPkg.version, extra };
};

// A stand-in @openclaw/codex shaped like the published package: a TypeScript
// entry with its built JavaScript named in openclaw.runtimeExtensions. With
// built: false it is the same package packed from source without a build.
const makeCodexStandIn = ({ rootDir, version, built = true }) => {
  const src = path.join(rootDir, `codex-src-${built ? "built" : "source"}`);
  const pkgRoot = path.join(src, "package");
  fs.mkdirSync(path.join(pkgRoot, "dist"), { recursive: true });
  const openclaw = { extensions: ["./index.ts"], ...(built ? { runtimeExtensions: ["./dist/index.js"] } : {}) };
  fs.writeFileSync(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "@openclaw/codex", version, type: "module", openclaw }, null, 2));
  fs.writeFileSync(path.join(pkgRoot, "openclaw.plugin.json"), JSON.stringify({ id: "codex", name: "Codex stand-in", configSchema: { type: "object", additionalProperties: false, properties: {} } }));
  fs.writeFileSync(path.join(pkgRoot, "index.ts"), "export {};\n");
  if (built) fs.writeFileSync(path.join(pkgRoot, "dist", "index.js"), 'export default { id: "codex", name: "Codex stand-in", register() {} };\n');
  const file = path.join(rootDir, "openclaw-packages", `openclaw-codex-${version}-${built ? "built" : "source"}.tgz`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  tar.c({ gzip: true, file, cwd: src, sync: true, portable: true }, ["package"]);
  fs.chmodSync(file, 0o600);
  fs.rmSync(src, { recursive: true, force: true });
  return { file, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
};

const bootGateway = async ({ rootDir, installDir, openclawDir, extraEnv = {} }) => {
  const env = withOpenclawStartupEnv({
    ...scrubTestRunnerEnv(),
    ...extraEnv,
    HOME: rootDir,
    OPENCLAW_HOME: rootDir,
    OPENCLAW_CONFIG_PATH: path.join(openclawDir, "openclaw.json"),
    OPENCLAW_STATE_DIR: openclawDir,
    XDG_CONFIG_HOME: openclawDir,
    OPENCLAW_NO_AUTO_UPDATE: "1",
    OPENCLAW_GATEWAY_PORT: String(kPort),
    NODE_COMPILE_CACHE: path.join(rootDir, "compile-cache"),
  });
  const build = describeExecutingBuild({ installDir });
  const logFile = path.join(rootDir, "gateway.log");
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [build.bin, "gateway", "run", "--port", String(kPort)], { env, cwd: rootDir, stdio: ["ignore", logFd, logFd], detached: true });
  fs.closeSync(logFd);
  const stop = async () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    await waitFor(async () => {
      try {
        await fetch(`http://127.0.0.1:${kPort}/healthz`);
        return false;
      } catch {
        return true;
      }
    }, 30000, "gateway port closed");
  };
  try {
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${kPort}/healthz`)).ok;
      } catch {
        return false;
      }
    }, 150000, "gateway /healthz");
  } catch (error) {
    await stop();
    error.message += `\n--- gateway output (tail) ---\n${fs.readFileSync(logFile, "utf8").slice(-3000)}`;
    throw error;
  }
  return { build, stop };
};

describeLive("live: the gateway boots from a sha-pinned OpenClaw package", () => {
  it(
    "applies the stand-in, boots the real gateway from it twice, keeps the launch check green and refuses a changed file",
    async () => {
      const rootDir = mkTemp("alphaclaw-live-pinned-package-");
      const openclawDir = path.join(rootDir, ".openclaw");
      const managedDir = path.join(openclawDir, ".alphaclaw");
      fs.mkdirSync(managedDir, { recursive: true });
      fs.writeFileSync(
        path.join(openclawDir, "openclaw.json"),
        JSON.stringify({ gateway: { mode: "local", bind: "loopback", port: kPort, auth: { token: "live-e2e-token-000000000000000000000000" } } }),
      );
      const probeFile = path.join(rootDir, "standin-ran.jsonl");
      const installDir = makeInstallCopy(rootDir);

      const stockBoot = await bootGateway({ rootDir, installDir, openclawDir });
      expect(stockBoot.build.build).not.toBe("pinned_package");
      await stockBoot.stop();
      expect(fs.existsSync(probeFile)).toBe(false);

      const standIn = makeStandIn({ rootDir, probeFile });
      const env = { ALPHACLAW_OPENCLAW_PACKAGES: `${standIn.version}:${standIn.file}:${standIn.sha256}` };
      const startedAt = Date.now();
      const verdict = override.applyOpenclawPackageAtBoot({ installDir, managedDir, openclawDir, env: { ...env, PATH: process.env.PATH, HOME: rootDir } });
      const applyMs = Date.now() - startedAt;
      expect(verdict).toMatchObject({ status: "applied", version: standIn.version, sha256: standIn.sha256, bundledExtras: [standIn.extra] });
      console.log(`[pinned-package] applied in ${applyMs} ms, ${verdict.files} files, extra bundled ${standIn.extra}`);
      expect(fs.existsSync(path.join(installDir, "node_modules", "openclaw", ".openclaw-lifecycle-pending"))).toBe(false);
      expect(override.checkOpenclawPackageBeforeLaunch({ installDir, managedDir, env })).toMatchObject({ status: "applied" });

      for (const round of [1, 2]) {
        const boot = await bootGateway({ rootDir, installDir, openclawDir });
        try {
          expect(boot.build).toMatchObject({ version: standIn.version, build: "pinned_package", packageSha256: standIn.sha256 });
          const runs = fs.readFileSync(probeFile, "utf8").split("\n").filter(Boolean);
          expect(runs.length).toBeGreaterThanOrEqual(round);
        } finally {
          await boot.stop();
        }
        expect(override.checkOpenclawPackageBeforeLaunch({ installDir, managedDir, env })).toMatchObject({ status: "applied" });
      }

      const shipped = path.join(installDir, "node_modules", "openclaw", "openclaw.mjs");
      const stat = fs.statSync(shipped);
      fs.appendFileSync(shipped, "\n");
      fs.utimesSync(shipped, stat.atime, new Date(stat.mtimeMs + 5000));
      let refusal = null;
      try {
        override.checkOpenclawPackageBeforeLaunch({ installDir, managedDir, env });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toMatchObject({ reason: "tree_changed", files: ["openclaw.mjs (modified)"] });

      // GST-3061: the launch applies the package again (in its own process)
      // and the real gateway boots from the verified build.
      const reapplied = await override.reapplyOpenclawPackageForLaunch({ installDir, managedDir, openclawDir, refusal, env: { ...env, PATH: process.env.PATH, HOME: rootDir } });
      expect(reapplied).toMatchObject({ verdict: { status: "applied", sha256: standIn.sha256, editedFiles: ["openclaw.mjs (modified)"] }, files: ["openclaw.mjs (modified)"] });
      expect(fs.readFileSync(shipped, "utf8").endsWith("\n\n")).toBe(false);
      const runsBefore = fs.readFileSync(probeFile, "utf8").split("\n").filter(Boolean).length;
      const reboot = await bootGateway({ rootDir, installDir, openclawDir });
      try {
        expect(reboot.build).toMatchObject({ build: "pinned_package", packageSha256: standIn.sha256 });
        expect(fs.readFileSync(probeFile, "utf8").split("\n").filter(Boolean).length).toBeGreaterThan(runsBefore);
      } finally {
        await reboot.stop();
      }

      const restored = override.applyOpenclawPackageAtBoot({ installDir, managedDir, openclawDir, env: { PATH: process.env.PATH, HOME: rootDir } });
      expect(restored).toMatchObject({ status: "stock", restored: true });
      expect(describeExecutingBuild({ installDir }).build).not.toBe("pinned_package");
    },
    kTestTimeoutMs,
  );

  it(
    "installs a pinned @openclaw/codex under a config with ${VAR} references the install's env lacks, and refuses a source-only one up front",
    async () => {
      const rootDir = mkTemp("alphaclaw-live-pinned-codex-");
      const openclawDir = path.join(rootDir, ".openclaw");
      const managedDir = path.join(openclawDir, ".alphaclaw");
      fs.mkdirSync(managedDir, { recursive: true });
      const configPath = path.join(openclawDir, "openclaw.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          gateway: { mode: "local", bind: "loopback", port: kPort, auth: { mode: "token", token: "${ALPHACLAW_LIVE_GATEWAY_TOKEN}" } },
          channels: { telegram: { enabled: false, botToken: "${ALPHACLAW_LIVE_TELEGRAM_TOKEN}" } },
          plugins: { entries: { browser: { enabled: true }, github: { enabled: false } } },
        }),
      );
      const installDir = makeInstallCopy(rootDir);
      const core = makeStandIn({ rootDir, probeFile: path.join(rootDir, "standin-ran.jsonl") });
      const coreEntry = `${core.version}:${core.file}:${core.sha256}`;
      const settingWith = (codex) => ({ ALPHACLAW_OPENCLAW_PACKAGES: `${coreEntry}\n@openclaw/codex@${core.version}:${codex.file}:${codex.sha256}` });
      const bootEnv = (setting) => ({ ...setting, PATH: process.env.PATH, HOME: rootDir });

      const sourceOnly = makeCodexStandIn({ rootDir, version: core.version, built: false });
      expect(override.checkOpenclawPackageSetting({ installDir, openclawDir, env: settingWith(sourceOnly) })).toMatchObject({ ok: false, reason: "plugin_not_built", detail: "./index.ts: expected ./dist/index.js, ./dist/index.mjs, ./dist/index.cjs" });
      expect(override.applyOpenclawPackageAtBoot({ installDir, managedDir, openclawDir, env: bootEnv(settingWith(sourceOnly)) })).toMatchObject({ status: "refused", reason: "plugin_not_built" });
      // The rule the check mirrors: the pinned OpenClaw itself refuses that package.
      const refusedByOpenclaw = require("child_process").spawnSync(
        process.execPath,
        [path.join(installDir, "node_modules", "openclaw", "openclaw.mjs"), "plugins", "install", sourceOnly.file, "--force", "--accept-capabilities"],
        { env: scrubTestRunnerEnv({ PATH: process.env.PATH, HOME: rootDir, OPENCLAW_STATE_DIR: openclawDir, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_NO_AUTO_UPDATE: "1" }), encoding: "utf8", timeout: 300000 },
      );
      expect(refusedByOpenclaw.status).toBe(1);
      expect(refusedByOpenclaw.stderr).toContain("requires compiled runtime output for TypeScript entry ./index.ts");

      const built = makeCodexStandIn({ rootDir, version: core.version });
      expect(override.checkOpenclawPackageSetting({ installDir, openclawDir, env: settingWith(built) })).toMatchObject({ ok: true, plugin: { name: "@openclaw/codex" } });
      // Fresh state with no Doctor run for this version yet: OpenClaw accepts
      // the install, so the start installs it instead of waiting for Doctor.
      const verdict = override.applyOpenclawPackageAtBoot({ installDir, managedDir, openclawDir, env: bootEnv(settingWith(built)) });
      expect(verdict).toMatchObject({ status: "applied", version: core.version, codex: { name: "@openclaw/codex", installed: true } });
      expect(verdict.codex.pending).toBeUndefined();
      expect(fs.existsSync(path.join(openclawDir, "extensions", "codex", "dist", "index.js"))).toBe(true);
      const config = fs.readFileSync(configPath, "utf8");
      expect(config).toContain("${ALPHACLAW_LIVE_GATEWAY_TOKEN}");
      expect(config).toContain("${ALPHACLAW_LIVE_TELEGRAM_TOKEN}");
      expect(override.checkOpenclawPackageBeforeLaunch({ installDir, managedDir, env: settingWith(built) })).toMatchObject({ status: "applied" });

      const boot = await bootGateway({ rootDir, installDir, openclawDir, extraEnv: { ALPHACLAW_LIVE_GATEWAY_TOKEN: "live-e2e-token-000000000000000000000000" } });
      try {
        expect(boot.build).toMatchObject({ build: "pinned_package", packageSha256: core.sha256 });
      } finally {
        await boot.stop();
      }
      expect(override.applyOpenclawPackageAtBoot({ installDir, managedDir, openclawDir, env: bootEnv(settingWith(built)) })).toMatchObject({ status: "applied", codex: { installed: false } });
    },
    kTestTimeoutMs,
  );
});
