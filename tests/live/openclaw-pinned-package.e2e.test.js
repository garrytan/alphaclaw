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

const bootGateway = async ({ rootDir, installDir, openclawDir }) => {
  const env = withOpenclawStartupEnv({
    ...scrubTestRunnerEnv(),
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
      expect(() => override.checkOpenclawPackageBeforeLaunch({ installDir, managedDir, env })).toThrow(expect.objectContaining({ reason: "tree_changed" }));

      const restored = override.applyOpenclawPackageAtBoot({ installDir, managedDir, openclawDir, env: { PATH: process.env.PATH, HOME: rootDir } });
      expect(restored).toMatchObject({ status: "stock", restored: true });
      expect(describeExecutingBuild({ installDir }).build).not.toBe("pinned_package");
    },
    kTestTimeoutMs,
  );
});
