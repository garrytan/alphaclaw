// OpenClaw from a sha-pinned package (lib/server/openclaw-package-override.js):
// real temp trees and real tarballs (node-tar), the package's own postinstall
// run for real, and the launch, watchdog and notification paths it feeds.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const tar = require("tar");
const override = require("../../lib/server/openclaw-package-override");
const { createWatchdog, createGatewayPrelaunchHookHandler } = require("../../lib/server/watchdog");

const kVersion = "2026.11.4";
const kSchemas = { state: 22, agent: 27 };
const kDeps = { express: "^5.0.0", tar: "7.5.22", "@scope/lib": "1.2.3" };
const kOptional = { sharp: "0.34.0" };
const kPostinstall = [
  'import { rmSync, writeFileSync } from "node:fs";',
  'import { join, dirname } from "node:path";',
  'import { fileURLToPath } from "node:url";',
  'const root = join(dirname(fileURLToPath(import.meta.url)), "..");',
  'if (process.env.POSTINSTALL_MODE === "fail") { console.error("boom"); process.exit(3); }',
  'if (process.env.POSTINSTALL_MODE !== "keep") rmSync(join(root, ".openclaw-lifecycle-pending"), { force: true });',
  'writeFileSync(join(root, "dist", "postinstall-ran.txt"), "yes\\n");',
].join("\n");

const roots = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const packageJson = (overrides = {}) => ({
  name: "openclaw",
  version: kVersion,
  bin: { openclaw: "openclaw.mjs" },
  dependencies: kDeps,
  optionalDependencies: kOptional,
  bundleDependencies: ["chrome-devtools-mcp"],
  engines: { node: ">=24.16.0 <25 || >=26.1.0" },
  openclaw: { schemaVersions: kSchemas },
  scripts: { postinstall: "node scripts/postinstall-bundled-plugins.mjs" },
  ...overrides,
});

// An install dir with the image's stock openclaw: package.json, a bin, the
// bundled dependency and two npm-nested dependencies (one scoped).
const makeInstall = () => {
  const installDir = tmp("pkg-install-");
  const stock = path.join(installDir, "node_modules", "openclaw");
  writeJson(path.join(stock, "package.json"), packageJson());
  write(path.join(stock, "openclaw.mjs"), "#!/usr/bin/env node\nconsole.log('stock');\n");
  write(path.join(stock, "dist", "index.js"), "export const build = 'stock';\n");
  writeJson(path.join(stock, "node_modules", "chrome-devtools-mcp", "package.json"), { name: "chrome-devtools-mcp", version: "1.0.0" });
  writeJson(path.join(stock, "node_modules", "nested-dep", "package.json"), { name: "nested-dep", version: "2.0.0" });
  writeJson(path.join(stock, "node_modules", "@scope", "nested", "package.json"), { name: "@scope/nested", version: "3.0.0" });
  const rootDir = tmp("pkg-root-");
  const openclawDir = path.join(rootDir, ".openclaw");
  const managedDir = path.join(openclawDir, ".alphaclaw");
  fs.mkdirSync(managedDir, { recursive: true });
  return { installDir, stock, rootDir, openclawDir, managedDir };
};

// A tarball the way npm packs one: everything under package/.
const makePackage = ({ dir, pkg = packageJson(), files = {}, extraBundled = {}, lifecycleMarker = true, symlink = false, mode = 0o644 } = {}) => {
  const src = tmp("pkg-src-");
  const root = path.join(src, "package");
  writeJson(path.join(root, "package.json"), pkg);
  write(path.join(root, "openclaw.mjs"), "#!/usr/bin/env node\nconsole.log('patched');\n");
  write(path.join(root, "dist", "index.js"), "export const build = 'patched';\n");
  write(path.join(root, "scripts", "postinstall-bundled-plugins.mjs"), kPostinstall);
  writeJson(path.join(root, "node_modules", "chrome-devtools-mcp", "package.json"), { name: "chrome-devtools-mcp", version: "1.0.0" });
  for (const [name, version] of Object.entries(extraBundled)) {
    writeJson(path.join(root, "node_modules", ...name.split("/"), "package.json"), { name, version });
  }
  if (lifecycleMarker) write(path.join(root, ".openclaw-lifecycle-pending"), "pending\n");
  for (const [rel, text] of Object.entries(files)) write(path.join(root, rel), text);
  if (symlink) fs.symlinkSync("/etc/passwd", path.join(root, "dist", "escape"));
  const outDir = dir || tmp("pkg-out-");
  const file = path.join(outDir, "openclaw-patched.tgz");
  tar.c({ gzip: true, file, cwd: src, sync: true, portable: true }, ["package"]);
  fs.chmodSync(file, mode);
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  return { file, sha256 };
};

const settingOf = (...entries) => entries.map(({ version = kVersion, file, sha256 }) => `${version}:${file}:${sha256}`).join(",");

const apply = (install, env, extra = {}) =>
  override.applyOpenclawPackageAtBoot({
    installDir: install.installDir,
    managedDir: install.managedDir,
    openclawDir: install.openclawDir,
    env: { ...env, HOME: os.tmpdir(), TMPDIR: os.tmpdir() },
    gatewayRunning: () => false,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    ...extra,
  });

const launchCheck = (install, env) =>
  override.checkOpenclawPackageBeforeLaunch({ installDir: install.installDir, managedDir: install.managedDir, env });

const expectStockIntact = (install) => {
  expect(JSON.parse(fs.readFileSync(path.join(install.stock, "package.json"), "utf8")).version).toBe(kVersion);
  expect(fs.readFileSync(path.join(install.stock, "dist", "index.js"), "utf8")).toContain("stock");
  expect(fs.existsSync(path.join(install.stock, override.kPackageMarkerName))).toBe(false);
  expect(fs.existsSync(path.join(install.stock, "node_modules", "nested-dep", "package.json"))).toBe(true);
  expect(fs.existsSync(path.join(install.stock, "node_modules", "@scope", "nested", "package.json"))).toBe(true);
  const leftovers = fs.readdirSync(path.join(install.installDir, "node_modules")).filter((name) => name.startsWith(".openclaw-next-"));
  expect(leftovers).toEqual([]);
};

const expectRefused = (install, env, verdict, reason) => {
  expect(verdict).toMatchObject({ status: "refused", reason });
  expect(verdict.message).toBe(override.kRefusalCopy[reason]);
  expectStockIntact(install);
  let thrown = null;
  try {
    launchCheck(install, env);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(override.OpenclawPackageRefusal);
  expect(thrown.reason).toBe(reason);
};

describe("parseOpenclawPackagesSetting", () => {
  it("reads <version>:<absolute path>:<sha256> entries split by commas or newlines", () => {
    const sha = "A".repeat(64);
    expect(override.parseOpenclawPackagesSetting("")).toEqual({ set: false, entries: [], errors: [] });
    expect(override.parseOpenclawPackagesSetting(` 2026.11.4:/data/openclaw-packages/a b.tgz:${sha}\n2026.11.5:/data/p/c.tgz:${"b".repeat(64)} `)).toEqual({
      set: true,
      entries: [
        { name: "openclaw", version: "2026.11.4", file: "/data/openclaw-packages/a b.tgz", sha256: "a".repeat(64) },
        { name: "openclaw", version: "2026.11.5", file: "/data/p/c.tgz", sha256: "b".repeat(64) },
      ],
      errors: [],
    });
  });

  it("rejects relative paths, short shas, non-normal paths and a second entry for the same version", () => {
    const sha = "c".repeat(64);
    const parsed = override.parseOpenclawPackagesSetting(
      [`2026.11.4:data/a.tgz:${sha}`, `2026.11.4:/data/a.tgz:abc`, `2026.11.4:/data/../a.tgz:${sha}`, `2026.11.4:/data/a.tgz:${sha}`, `2026.11.4:/data/b.tgz:${sha}`].join(","),
    );
    expect(parsed.entries).toEqual([{ name: "openclaw", version: "2026.11.4", file: "/data/a.tgz", sha256: sha }]);
    expect(parsed.errors).toHaveLength(4);
  });

  it("reads an @openclaw/codex entry beside the OpenClaw entry for the same version, and only that plugin", () => {
    const sha = "d".repeat(64);
    const parsed = override.parseOpenclawPackagesSetting(
      [`2026.11.4:/data/a.tgz:${sha}`, `@openclaw/codex@2026.11.4:/data/c.tgz:${sha}`, `@openclaw/codex@2026.11.4:/data/d.tgz:${sha}`, `@openclaw/discord@2026.11.4:/data/e.tgz:${sha}`].join("\n"),
    );
    expect(parsed.entries).toEqual([
      { name: "openclaw", version: "2026.11.4", file: "/data/a.tgz", sha256: sha },
      { name: "@openclaw/codex", version: "2026.11.4", file: "/data/c.tgz", sha256: sha },
    ]);
    expect(parsed.errors).toHaveLength(2);
  });
});

describe("applyOpenclawPackageAtBoot", () => {
  it("applies the package: verified, unpacked, postinstall run, nested dependencies carried over, launch check passes", () => {
    const install = makeInstall();
    const pkgFile = makePackage();
    const env = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile) };
    const verdict = apply(install, env);
    expect(verdict).toMatchObject({ status: "applied", version: kVersion, file: "openclaw-patched.tgz", sha256: pkgFile.sha256, stockVersion: kVersion, bundledExtras: [] });
    const live = install.stock;
    expect(fs.readFileSync(path.join(live, "dist", "index.js"), "utf8")).toContain("patched");
    expect(fs.readFileSync(path.join(live, "dist", "postinstall-ran.txt"), "utf8")).toBe("yes\n");
    expect(fs.existsSync(path.join(live, ".openclaw-lifecycle-pending"))).toBe(false);
    expect(fs.existsSync(path.join(live, "node_modules", "nested-dep", "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(live, "node_modules", "@scope", "nested", "package.json"))).toBe(true);
    const marker = JSON.parse(fs.readFileSync(path.join(live, override.kPackageMarkerName), "utf8"));
    expect(marker).toMatchObject({ sha256: pkgFile.sha256, stockVersion: kVersion, movedNested: ["@scope/nested", "nested-dep"] });
    expect(launchCheck(install, env)).toMatchObject({ status: "applied", sha256: pkgFile.sha256 });
    expect(override.describeOpenclawPackage({ installDir: install.installDir, managedDir: install.managedDir, env })).toMatchObject({
      set: true,
      build: "pinned_package",
      packageSha256: pkgFile.sha256,
      packageFile: "openclaw-patched.tgz",
      stockVersion: kVersion,
      entries: [{ version: kVersion, file: "openclaw-patched.tgz", sha256: pkgFile.sha256 }],
    });
    const { describeExecutingBuild } = require("../../lib/server/openclaw-build");
    expect(describeExecutingBuild({ installDir: install.installDir })).toMatchObject({
      version: kVersion,
      build: "pinned_package",
      buildId: `${kVersion}+${pkgFile.sha256.slice(0, 12)}`,
      packageSha256: pkgFile.sha256,
    });
  });

  it("a second start in the same container reuses the applied tree after re-verifying the file and the manifest", () => {
    const install = makeInstall();
    const pkgFile = makePackage();
    const env = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile) };
    apply(install, env);
    const postinstall = vi.fn(() => ({ ok: true }));
    expect(apply(install, env, { runPostinstall: postinstall })).toMatchObject({ status: "applied", reused: true });
    expect(postinstall).not.toHaveBeenCalled();
  });

  it("accepts an extra bundled dependency only when it is declared and shipped in the package", () => {
    const install = makeInstall();
    const extra = makePackage({
      pkg: packageJson({ bundleDependencies: ["chrome-devtools-mcp", "@scope/lib"] }),
      extraBundled: { "@scope/lib": "1.2.3" },
    });
    expect(apply(install, { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(extra) })).toMatchObject({ status: "applied", bundledExtras: ["@scope/lib"] });

    const install2 = makeInstall();
    const undeclared = makePackage({
      pkg: packageJson({ bundleDependencies: ["chrome-devtools-mcp", "left-pad"] }),
      extraBundled: { "left-pad": "1.0.0" },
    });
    const env2 = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(undeclared) };
    expectRefused(install2, env2, apply(install2, env2), "dependencies_differ");

    const install3 = makeInstall();
    const absent = makePackage({ pkg: packageJson({ bundleDependencies: ["chrome-devtools-mcp", "@scope/lib"] }) });
    const env3 = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(absent) };
    expectRefused(install3, env3, apply(install3, env3), "dependencies_differ");
  });

  it("refuses with the stock tree untouched for every file, archive and package problem", () => {
    const cases = [
      ["missing", (install) => ({ file: path.join(install.rootDir, "openclaw-packages", "gone.tgz"), sha256: "d".repeat(64) })],
      ["sha_mismatch", () => ({ ...makePackage(), sha256: "e".repeat(64) })],
      ["unsafe_mode", () => makePackage({ mode: 0o666 })],
      ["unsafe_location", (install) => makePackage({ dir: fs.mkdirSync(path.join(install.openclawDir, "workspace"), { recursive: true }) || path.join(install.openclawDir, "workspace") })],
      ["not_regular_file", (install) => {
        const real = makePackage();
        const link = path.join(install.rootDir, "link.tgz");
        fs.symlinkSync(real.file, link);
        return { file: link, sha256: real.sha256 };
      }],
      ["unsafe_archive", () => makePackage({ symlink: true })],
      ["version_mismatch", () => makePackage({ pkg: packageJson({ version: "2026.11.3" }) })],
      ["dependencies_differ", () => makePackage({ pkg: packageJson({ dependencies: { ...kDeps, express: "^4.0.0" } }) })],
      ["schema_differs", () => makePackage({ pkg: packageJson({ openclaw: { schemaVersions: { state: 23, agent: 27 } } }) })],
      ["node_unsupported", () => makePackage({ pkg: packageJson({ engines: { node: ">=99.0.0" } }) })],
    ];
    for (const [reason, build] of cases) {
      const install = makeInstall();
      const entry = build(install);
      const env = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(entry) };
      const verdict = apply(install, env);
      expect({ reason, verdict: verdict.reason }).toEqual({ reason, verdict: reason });
      expectRefused(install, env, verdict, reason);
    }
  });

  it("refuses when the package's own postinstall fails or leaves its lifecycle marker", () => {
    const install = makeInstall();
    const pkgFile = makePackage();
    const env = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile), POSTINSTALL_MODE: "fail" };
    const failRun = (args) => {
      const result = require("child_process").spawnSync(process.execPath, [path.join(args.packageDir, "scripts", "postinstall-bundled-plugins.mjs")], {
        cwd: args.packageDir,
        env: { ...process.env, POSTINSTALL_MODE: env.POSTINSTALL_MODE },
        encoding: "utf8",
      });
      return result.status === 0 ? { ok: true } : { ok: false, detail: `exit ${result.status}: ${result.stderr.trim()}` };
    };
    const verdict = apply(install, env, { runPostinstall: failRun });
    expect(verdict.detail).toContain("exit 3: boom");
    expectRefused(install, env, verdict, "postinstall_failed");

    const install2 = makeInstall();
    const env2 = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile) };
    expectRefused(install2, env2, apply(install2, env2, { runPostinstall: () => ({ ok: true }) }), "lifecycle_pending");
  });

  it("refuses an invalid setting, a setting with no entry for the stock version, and a running gateway (deferred)", () => {
    const install = makeInstall();
    const pkgFile = makePackage();
    const invalid = { ALPHACLAW_OPENCLAW_PACKAGES: "2026.11.4:relative.tgz:abc" };
    expectRefused(install, invalid, apply(install, invalid), "invalid_setting");

    const otherPin = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf({ ...pkgFile, version: "2026.11.5" }) };
    const verdict = apply(install, otherPin);
    expect(verdict.detail).toBe("runs 2026.11.4; entries for 2026.11.5");
    expectRefused(install, otherPin, verdict, "no_entry_for_pin");

    const env = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile) };
    expectRefused(install, env, apply(install, env, { gatewayRunning: () => true }), "deferred");
  });

  it("ignores entries for other versions so the next build can be staged before the pin moves", () => {
    const install = makeInstall();
    const pkgFile = makePackage();
    const env = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile, { version: "2026.11.5", file: "/data/openclaw-packages/next.tgz", sha256: "f".repeat(64) }) };
    expect(apply(install, env)).toMatchObject({
      status: "applied",
      others: [{ version: "2026.11.5", file: "next.tgz", sha256: "f".repeat(64) }],
    });
  });

  it("removing the setting puts the stock build back, nested dependencies included", () => {
    const install = makeInstall();
    const pkgFile = makePackage();
    apply(install, { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile) });
    const verdict = apply(install, {});
    expect(verdict).toMatchObject({ status: "stock", restored: true, previous: { status: "applied", file: "openclaw-patched.tgz", sha256: pkgFile.sha256 } });
    expectStockIntact(install);
    expect(fs.readdirSync(path.join(install.installDir, "node_modules")).filter((name) => name.startsWith(".openclaw-stock-"))).toEqual([]);
    expect(launchCheck(install, {})).toBe(null);
  });

  it("recovers a start that died between the two renames: stock goes back and staging is discarded", () => {
    const install = makeInstall();
    const nodeModules = path.join(install.installDir, "node_modules");
    const aside = path.join(nodeModules, ".openclaw-stock-2026.11.4");
    const staging = path.join(nodeModules, ".openclaw-next-abc");
    fs.mkdirSync(path.join(staging, "node_modules"), { recursive: true });
    fs.renameSync(path.join(install.stock, "node_modules", "nested-dep"), path.join(staging, "node_modules", "nested-dep"));
    fs.renameSync(install.stock, aside);
    writeJson(path.join(nodeModules, ".openclaw-package-swap.json"), { stagingDir: staging, stockAsideDir: aside, movedNested: ["nested-dep"] });
    expect(apply(install, {})).toMatchObject({ status: "stock" });
    expectStockIntact(install);
    expect(fs.existsSync(path.join(nodeModules, ".openclaw-package-swap.json"))).toBe(false);
  });
});

const overlayFs = (install) => {
  const lower = new Set();
  const walk = (dir) => {
    const stat = fs.statSync(dir, { bigint: true });
    lower.add(`${stat.ino}:${stat.birthtimeNs}`);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) walk(path.join(dir, entry.name));
  };
  walk(install.stock);
  return Object.assign(Object.create(fs), {
    renameSync: (from, to) => {
      const stat = fs.lstatSync(from, { bigint: true });
      if (stat.isDirectory() && lower.has(`${stat.ino}:${stat.birthtimeNs}`)) throw Object.assign(new Error(`EXDEV: cross-device link not permitted, rename '${from}'`), { code: "EXDEV" });
      return fs.renameSync(from, to);
    },
  });
};

describe("on a filesystem that cannot rename the image's directories (Docker overlayfs, EXDEV)", () => {
  it("applies by copying the image's directories, and restores stock the same way", () => {
    const install = makeInstall();
    const pkgFile = makePackage();
    const env = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile) };
    const fsModule = overlayFs(install);
    const verdict = apply(install, env, { fsModule });
    expect(verdict, JSON.stringify(verdict)).toMatchObject({ status: "applied" });
    expect(fs.readFileSync(path.join(install.stock, "dist", "index.js"), "utf8")).toContain("patched");
    expect(fs.existsSync(path.join(install.stock, "node_modules", "@scope", "nested", "package.json"))).toBe(true);
    expect(launchCheck(install, env)).toMatchObject({ status: "applied" });
    expect(fs.readdirSync(path.join(install.installDir, "node_modules")).filter((name) => name.endsWith(".partial"))).toEqual([]);
    expect(apply(install, {}, { fsModule })).toMatchObject({ status: "stock", restored: true });
    expectStockIntact(install);
  });

  it("recovers a start that died while removing the stock tree after its copy was set aside", () => {
    const install = makeInstall();
    const nodeModules = path.join(install.installDir, "node_modules");
    const aside = path.join(nodeModules, ".openclaw-stock-2026.11.4");
    fs.cpSync(install.stock, aside, { recursive: true });
    fs.rmSync(path.join(install.stock, "dist"), { recursive: true });
    fs.mkdirSync(path.join(nodeModules, ".openclaw-next-abc"));
    fs.mkdirSync(path.join(nodeModules, ".openclaw-stock-2026.11.4x.partial"));
    writeJson(path.join(nodeModules, ".openclaw-package-swap.json"), { stagingDir: path.join(nodeModules, ".openclaw-next-abc"), stockAsideDir: aside, movedNested: [], sha256: "a".repeat(64) });
    expect(apply(install, {})).toMatchObject({ status: "stock" });
    expectStockIntact(install);
    expect(fs.readdirSync(nodeModules).filter((name) => name.startsWith(".openclaw-"))).toEqual([]);
  });
});

describe("a start killed in the middle of applying or restoring", () => {
  // The process dies at the chosen call: that call and every later one fail,
  // so no in-process cleanup runs. The next start uses the real filesystem.
  const crashable = (base, killAt = () => false) => {
    let dead = false;
    const fsModule = Object.create(base);
    for (const key of Object.keys(fs)) {
      if (typeof fs[key] !== "function" || !key.endsWith("Sync")) continue;
      fsModule[key] = (...args) => {
        if (!dead && killAt(key, args)) dead = true;
        if (dead) throw new Error("killed");
        return base[key](...args);
      };
    }
    return { fsModule, kill: () => { dead = true; } };
  };
  const startKilled = (install, env, extra) => {
    try {
      apply(install, env, extra);
    } catch {}
  };
  const asideOf = (install) => path.join(install.installDir, "node_modules", ".openclaw-stock-" + kVersion);

  it("during the postinstall, after the stock tree's nested dependencies moved to staging", () => {
    const install = makeInstall();
    const pkgFile = makePackage();
    const env = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile) };
    const crash = crashable(fs);
    startKilled(install, env, { fsModule: crash.fsModule, runPostinstall: () => { crash.kill(); throw new Error("killed"); } });
    expect(fs.existsSync(path.join(install.stock, "node_modules", "nested-dep"))).toBe(false);
    expect(apply(install, {})).toMatchObject({ status: "stock" });
    expectStockIntact(install);
    expect(apply(install, env)).toMatchObject({ status: "applied" });
  });

  it("while copying the stock tree aside on overlayfs, after its nested dependencies moved", () => {
    const install = makeInstall();
    const pkgFile = makePackage();
    const crash = crashable(overlayFs(install), (key, args) => key === "cpSync" && args[0] === install.stock);
    startKilled(install, { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile) }, { fsModule: crash.fsModule });
    expect(apply(install, {})).toMatchObject({ status: "stock" });
    expectStockIntact(install);
  });

  it("while removing a nested dependency from the stock tree after its copy reached staging on overlayfs", () => {
    const install = makeInstall();
    const pkgFile = makePackage();
    const nested = path.join(install.stock, "node_modules", "nested-dep");
    const crash = crashable(overlayFs(install), (key, args) => key === "rmSync" && args[0] === nested);
    startKilled(install, { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile) }, { fsModule: crash.fsModule });
    expect(apply(install, {})).toMatchObject({ status: "stock" });
    expectStockIntact(install);
    expect(fs.readdirSync(path.join(install.stock, "node_modules")).filter((name) => name.endsWith(".moved") || name.endsWith(".partial"))).toEqual([]);
  });

  it("while restoring, between moving the package out and moving stock back in", () => {
    const install = makeInstall();
    const pkgFile = makePackage();
    const env = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile) };
    expect(apply(install, env)).toMatchObject({ status: "applied" });
    const aside = asideOf(install);
    const crash = crashable(fs, (key, args) => key === "renameSync" && args[0] === aside);
    startKilled(install, {}, { fsModule: crash.fsModule });
    expect(fs.existsSync(install.stock)).toBe(false);
    expect(apply(install, {})).toMatchObject({ status: "stock" });
    expectStockIntact(install);
    expect(fs.existsSync(aside)).toBe(false);
    expect(apply(install, env)).toMatchObject({ status: "applied" });
  });

  it("while restoring on overlayfs, during the copy of stock back in and during the removal of its aside copy", () => {
    for (const killAt of [
      (aside) => (key, args) => key === "cpSync" && args[0] === aside,
      (aside) => (key, args) => key === "rmSync" && args[0] === aside,
    ]) {
      const install = makeInstall();
      const pkgFile = makePackage();
      expect(apply(install, { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile) })).toMatchObject({ status: "applied" });
      const aside = asideOf(install);
      const crash = crashable(overlayFs({ stock: aside }), killAt(aside));
      startKilled(install, {}, { fsModule: crash.fsModule });
      expect(apply(install, {})).toMatchObject({ status: "stock" });
      expectStockIntact(install);
      expect(fs.readdirSync(path.join(install.installDir, "node_modules")).filter((name) => name.startsWith(".openclaw-") || name.endsWith(".moved") || name.endsWith(".partial"))).toEqual([]);
    }
  });
});

describe("an error partway through applying or restoring is undone at once", () => {
  const failOnce = (base, when, code = "EIO") => {
    let fired = false;
    const fsModule = Object.create(base);
    for (const key of ["cpSync", "renameSync"]) {
      fsModule[key] = (...args) => {
        if (!fired && when(key, args)) {
          fired = true;
          throw Object.assign(new Error(code + ": injected"), { code });
        }
        return base[key](...args);
      };
    }
    return fsModule;
  };
  const journalOf = (install) => path.join(install.installDir, "node_modules", ".openclaw-package-swap.json");

  it("a nested dependency that fails to copy after another one moved puts both back", () => {
    const install = makeInstall();
    const pkgFile = makePackage();
    const nested = path.join(install.stock, "node_modules", "nested-dep");
    const fsModule = failOnce(overlayFs(install), (key, args) => key === "cpSync" && args[0] === nested, "ENOSPC");
    const verdict = apply(install, { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile) }, { fsModule });
    expect(verdict).toMatchObject({ status: "refused" });
    expectStockIntact(install);
    expect(fs.existsSync(journalOf(install))).toBe(false);
  });

  it("a swap that fails moving the package in puts stock back", () => {
    const install = makeInstall();
    const pkgFile = makePackage();
    const fsModule = failOnce(fs, (key, args) => key === "renameSync" && path.basename(args[0]).startsWith(".openclaw-next-"));
    const verdict = apply(install, { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile) }, { fsModule });
    expect(verdict).toMatchObject({ status: "refused", reason: "swap_failed" });
    expectStockIntact(install);
    expect(fs.existsSync(journalOf(install))).toBe(false);
  });

  it("a restore that fails moving stock back in still ends on the complete stock tree", () => {
    const install = makeInstall();
    const pkgFile = makePackage();
    expect(apply(install, { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile) })).toMatchObject({ status: "applied" });
    const aside = path.join(install.installDir, "node_modules", ".openclaw-stock-" + kVersion);
    const verdict = apply(install, {}, { fsModule: failOnce(fs, (key, args) => key === "renameSync" && args[0] === aside) });
    expect(verdict).toMatchObject({ status: "refused", reason: "restore_failed" });
    expectStockIntact(install);
    expect(apply(install, {})).toMatchObject({ status: "stock" });
  });

  it("a start that finds the applied files changed applies the package again", () => {
    const install = makeInstall();
    const pkgFile = makePackage();
    const env = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile) };
    expect(apply(install, env)).toMatchObject({ status: "applied" });
    write(path.join(install.stock, "dist", "index.js"), "export const build = 'changed';\n");
    expect(() => launchCheck(install, env)).toThrow(expect.objectContaining({ reason: "tree_changed" }));
    const verdict = apply(install, env);
    expect(verdict).toMatchObject({ status: "applied" });
    expect(verdict.reused).toBeUndefined();
    expect(fs.readFileSync(path.join(install.stock, "dist", "index.js"), "utf8")).toContain("patched");
    expect(launchCheck(install, env)).toMatchObject({ status: "applied" });
  });
});

describe("an OpenClaw update copied over an applied package (host installs)", () => {
  it("drops the old package's marker and keeps the new version instead of reverting to the old stock tree", () => {
    const install = makeInstall();
    const pkgFile = makePackage();
    const env = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile) };
    expect(apply(install, env)).toMatchObject({ status: "applied" });
    writeJson(path.join(install.stock, "package.json"), packageJson({ version: "2026.11.5" }));
    write(path.join(install.stock, "dist", "index.js"), "export const build = 'new stock';\n");
    expect(apply(install, env)).toMatchObject({ status: "refused", reason: "no_entry_for_pin" });
    expect(JSON.parse(fs.readFileSync(path.join(install.stock, "package.json"), "utf8")).version).toBe("2026.11.5");
    expect(fs.readFileSync(path.join(install.stock, "dist", "index.js"), "utf8")).toContain("new stock");
    expect(fs.existsSync(path.join(install.stock, override.kPackageMarkerName))).toBe(false);
    expect(apply(install, {})).toMatchObject({ status: "stock" });
    expect(JSON.parse(fs.readFileSync(path.join(install.stock, "package.json"), "utf8")).version).toBe("2026.11.5");
    expect(fs.readFileSync(path.join(install.stock, "dist", "index.js"), "utf8")).toContain("new stock");
  });
});

describe("a pinned @openclaw/codex next to the pinned OpenClaw", () => {
  const makeCodex = ({ name = "@openclaw/codex", version = kVersion } = {}) => {
    const src = tmp("codex-src-");
    writeJson(path.join(src, "package", "package.json"), { name, version, openclaw: { extensions: ["./dist/index.js"] } });
    write(path.join(src, "package", "dist", "index.js"), "export const harness = 'patched';\n");
    write(path.join(src, "package", "openclaw.plugin.json"), "{}\n");
    const file = path.join(tmp("codex-out-"), "openclaw-codex-patched.tgz");
    tar.c({ gzip: true, file, cwd: src, sync: true, portable: true }, ["package"]);
    fs.chmodSync(file, 0o600);
    return { file, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
  };
  const codexSetting = (core, codex) => ({ ALPHACLAW_OPENCLAW_PACKAGES: `${settingOf(core)}\n@openclaw/codex@${kVersion}:${codex.file}:${codex.sha256}` });
  const fakeInstaller = () =>
    vi.fn(({ archivePath, openclawDir }) => {
      const dir = path.join(openclawDir, "extensions", "codex");
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      tar.x({ file: archivePath, cwd: dir, sync: true, strip: 1 });
      write(path.join(dir, "node_modules", "ws", "index.js"), "runtime dependency\n");
      return { ok: true };
    });

  it("installs it when absent, then only verifies it at the next start, and the launch check covers its files", () => {
    const install = makeInstall();
    const env = codexSetting(makePackage(), makeCodex());
    const runPluginInstall = fakeInstaller();
    const verdict = apply(install, env, { runPluginInstall });
    expect(verdict).toMatchObject({ status: "applied", codex: { name: "@openclaw/codex", installed: true, files: 3, dir: path.join(install.openclawDir, "extensions", "codex") } });
    expect(runPluginInstall).toHaveBeenCalledTimes(1);
    expect(apply(install, env, { runPluginInstall })).toMatchObject({ status: "applied", reused: true, codex: { installed: false } });
    expect(runPluginInstall).toHaveBeenCalledTimes(1);
    expect(launchCheck(install, env)).toMatchObject({ status: "applied" });

    const shipped = path.join(install.openclawDir, "extensions", "codex", "dist", "index.js");
    const stat = fs.statSync(shipped);
    fs.writeFileSync(shipped, "export const harness = 'stock!!';\n");
    fs.utimesSync(shipped, stat.atime, new Date(stat.mtimeMs + 5000));
    expect(() => launchCheck(install, env)).toThrow(expect.objectContaining({ reason: "tree_changed", detail: "extensions/codex: 1 file(s), first dist/index.js (modified)" }));
    expect(apply(install, env, { runPluginInstall })).toMatchObject({ status: "applied", codex: { installed: true } });
    expect(launchCheck(install, env)).toMatchObject({ status: "applied" });
  });

  it("refuses the gateway when the plugin cannot be installed or is not @openclaw/codex", () => {
    const install = makeInstall();
    const env = codexSetting(makePackage(), makeCodex());
    const failed = apply(install, env, { runPluginInstall: () => ({ ok: false, detail: "exit 1: npm ERR! network" }) });
    expect(failed).toMatchObject({ status: "refused", reason: "plugin_install_failed", plugin: "@openclaw/codex", detail: "exit 1: npm ERR! network" });
    expect(() => launchCheck(install, env)).toThrow(expect.objectContaining({ reason: "plugin_install_failed" }));

    const install2 = makeInstall();
    const env2 = codexSetting(makePackage(), makeCodex({ name: "@openclaw/discord" }));
    expect(apply(install2, env2, { runPluginInstall: fakeInstaller() })).toMatchObject({ status: "refused", reason: "plugin_mismatch" });

    const install3 = makeInstall();
    const env3 = codexSetting(makePackage(), { file: "/nonexistent/codex.tgz", sha256: "e".repeat(64) });
    const missing = apply(install3, env3, { runPluginInstall: fakeInstaller() });
    expect(missing).toMatchObject({ status: "refused", reason: "missing", pluginFile: "codex.tgz" });
  });
  it("leaves no rollback record when OpenClaw cannot list its plugins", () => {
    const install = makeInstall();
    const core = makePackage();
    expect(apply(install, codexSetting(core, makeCodex()), { runPluginInstall: fakeInstaller(), readInstalledCodex: () => ({ ok: false, detail: "exit 1" }) })).toMatchObject({ status: "applied" });
    const restore = vi.fn(() => ({ ok: true }));
    expect(apply(install, {}, { runPluginRestore: restore })).toMatchObject({ status: "stock", restored: true });
    expect(restore).not.toHaveBeenCalled();
  });

  it("leaves the Codex plugin alone while a gateway runs, and that gateway's launch check still passes", () => {
    const install = makeInstall();
    const core = makePackage();
    const env = codexSetting(core, makeCodex());
    expect(apply(install, env, { runPluginInstall: fakeInstaller(), readInstalledCodex: () => ({ ok: true, version: kVersion }) })).toMatchObject({ status: "applied" });
    const restore = vi.fn(() => ({ ok: true }));
    expect(apply(install, { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(core) }, { runPluginRestore: restore, gatewayRunning: () => true })).toMatchObject({ status: "refused", reason: "deferred", inPlace: { status: "applied" } });
    expect(restore).not.toHaveBeenCalled();
    expect(launchCheck(install, env)).toMatchObject({ status: "applied" });

    const install2 = makeInstall();
    const runPluginInstall = fakeInstaller();
    expect(apply(install2, { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(core) })).toMatchObject({ status: "applied" });
    expect(apply(install2, env, { runPluginInstall, gatewayRunning: () => true })).toMatchObject({ status: "refused", reason: "deferred" });
    expect(runPluginInstall).not.toHaveBeenCalled();
  });

  it("asks the OpenClaw it runs for the installed plugin, and reinstalls that version with it", () => {
    const install = makeInstall();
    const fakeCli = [
      'import fs from "node:fs";',
      'fs.appendFileSync(process.env.OPENCLAW_STATE_DIR + "/calls.log", JSON.stringify(process.argv.slice(2)) + "\\n");',
      'if (process.argv[3] === "list") console.log("[plugins] loading\\n" + JSON.stringify({ plugins: [{ id: "codex", version: "2026.11.3" }] }));',
    ].join("\n");
    write(path.join(install.stock, "openclaw.mjs"), fakeCli);
    const env = codexSetting(makePackage({ files: { "openclaw.mjs": fakeCli } }), makeCodex());
    expect(apply(install, env, { runPluginInstall: fakeInstaller(), readInstalledCodex: undefined })).toMatchObject({ status: "applied" });
    expect(apply(install, {}, { runPluginRestore: undefined })).toMatchObject({ status: "stock", codexRollback: { ok: true, spec: "@openclaw/codex@2026.11.3" } });
    const calls = fs.readFileSync(path.join(install.openclawDir, "calls.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls).toEqual([
      ["plugins", "list", "--json"],
      ["plugins", "install", "@openclaw/codex@2026.11.3", "--force", "--accept-capabilities"],
    ]);
  });

  it("a refused Codex entry leaves the stock OpenClaw in place, not the freshly applied package", () => {
    const install = makeInstall();
    const env = codexSetting(makePackage(), makeCodex({ name: "@openclaw/discord" }));
    expect(apply(install, env, { runPluginInstall: fakeInstaller() })).toMatchObject({ status: "refused", reason: "plugin_mismatch" });
    expectStockIntact(install);
    expect(() => launchCheck(install, env)).toThrow(expect.objectContaining({ reason: "plugin_mismatch" }));
  });

  it("removing the setting puts back the Codex plugin that was there before the pinned one, and retries a failure", () => {
    const install = makeInstall();
    const env = codexSetting(makePackage(), makeCodex());
    const readInstalledCodex = vi.fn(() => ({ ok: true, version: kVersion }));
    expect(apply(install, env, { runPluginInstall: fakeInstaller(), readInstalledCodex })).toMatchObject({ status: "applied", codex: { installed: true } });
    expect(readInstalledCodex).toHaveBeenCalledTimes(1);

    const failing = vi.fn(() => ({ ok: false, detail: "exit 1: npm ERR! network" }));
    expect(apply(install, {}, { runPluginRestore: failing })).toMatchObject({ status: "stock", restored: true, codexRollback: { ok: false, spec: "@openclaw/codex@" + kVersion } });
    expectStockIntact(install);
    expect(launchCheck(install, {})).toBe(null);

    const restore = vi.fn(() => ({ ok: true }));
    expect(apply(install, {}, { runPluginRestore: restore })).toMatchObject({ status: "stock", codexRollback: { ok: true, spec: "@openclaw/codex@" + kVersion } });
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ spec: "@openclaw/codex@" + kVersion, openclawDir: install.openclawDir }));
    const again = vi.fn(() => ({ ok: true }));
    apply(install, {}, { runPluginRestore: again });
    expect(again).not.toHaveBeenCalled();
  });

  it("dropping only the Codex entry uninstalls a pinned plugin that had nothing before it", () => {
    const install = makeInstall();
    const core = makePackage();
    expect(apply(install, codexSetting(core, makeCodex()), { runPluginInstall: fakeInstaller(), readInstalledCodex: () => ({ ok: true, version: null }) })).toMatchObject({ status: "applied" });
    const restore = vi.fn(() => ({ ok: true }));
    expect(apply(install, { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(core) }, { runPluginRestore: restore })).toMatchObject({ status: "applied", codexRollback: { ok: true, spec: null } });
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ spec: null }));
  });
});

describe("a second start, a failed restore and an unreadable package.json", () => {
  it("a start without the setting leaves the tree alone while a gateway runs from it, and that gateway's launch check still passes", () => {
    const install = makeInstall();
    const pkgFile = makePackage();
    const env = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile) };
    expect(apply(install, env)).toMatchObject({ status: "applied" });
    expect(apply(install, {}, { gatewayRunning: () => true })).toMatchObject({ status: "refused", reason: "deferred", inPlace: { status: "applied", sha256: pkgFile.sha256 } });
    expect(fs.readFileSync(path.join(install.stock, "dist", "index.js"), "utf8")).toContain("patched");
    expect(launchCheck(install, env)).toMatchObject({ status: "applied", sha256: pkgFile.sha256 });
    expect(() => launchCheck(install, {})).toThrow(expect.objectContaining({ reason: "deferred" }));
    expect(apply(install, env)).toMatchObject({ status: "applied", reused: true });
  });

  it("with the setting unset, a launch refuses while the restore of stock has failed", () => {
    const install = makeInstall();
    const env = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(makePackage()) };
    expect(apply(install, env)).toMatchObject({ status: "applied" });
    fs.rmSync(path.join(install.installDir, "node_modules", ".openclaw-stock-" + kVersion), { recursive: true });
    expect(apply(install, {})).toMatchObject({ status: "refused", reason: "restore_failed" });
    expect(() => launchCheck(install, {})).toThrow(expect.objectContaining({ reason: "restore_failed" }));
  });

  it("an unreadable package.json does not make the package's marker stale", () => {
    const install = makeInstall();
    expect(apply(install, { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(makePackage()) })).toMatchObject({ status: "applied" });
    fs.writeFileSync(path.join(install.stock, "package.json"), "{");
    expect(apply(install, {})).toMatchObject({ status: "stock", restored: true });
    expectStockIntact(install);
  });

  it("a start that refuses an applied package's file puts the stock build back", () => {
    const install = makeInstall();
    const dir = tmp("pkg-file-");
    const pkgFile = makePackage({ dir });
    const env = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile) };
    expect(apply(install, env)).toMatchObject({ status: "applied" });
    fs.renameSync(pkgFile.file, pkgFile.file + ".gone");
    expect(apply(install, env)).toMatchObject({ status: "refused", reason: "missing" });
    expectStockIntact(install);
    fs.renameSync(pkgFile.file + ".gone", pkgFile.file);
    expect(apply(install, env)).toMatchObject({ status: "applied" });
  });
});

describe("checkOpenclawPackageBeforeLaunch", () => {
  it("refuses a modified or missing shipped file but not files OpenClaw adds at runtime", () => {
    const install = makeInstall();
    const pkgFile = makePackage();
    const env = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile) };
    apply(install, env);
    write(path.join(install.stock, "dist", "extensions", "telegram", "node_modules", "grammy", "index.js"), "x");
    write(path.join(install.stock, "dist", "extensions", "telegram", ".openclaw-install-stage-1", "a"), "y");
    expect(launchCheck(install, env)).toMatchObject({ status: "applied" });

    const target = path.join(install.stock, "dist", "index.js");
    const stat = fs.statSync(target);
    fs.writeFileSync(target, "export const build = 'stock';\n");
    fs.utimesSync(target, stat.atime, new Date(stat.mtimeMs + 5000));
    expect(() => launchCheck(install, env)).toThrow(expect.objectContaining({ reason: "tree_changed", detail: "1 file(s), first dist/index.js (modified)" }));

    fs.rmSync(target);
    expect(() => launchCheck(install, env)).toThrow(expect.objectContaining({ reason: "tree_changed", detail: "1 file(s), first dist/index.js (missing)" }));
  });

  it("is a no-op with the setting unset and refuses when the start did not apply the package", () => {
    const install = makeInstall();
    expect(launchCheck(install, {})).toBe(null);
    const pkgFile = makePackage();
    expect(() => launchCheck(install, { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile) })).toThrow(expect.objectContaining({ reason: "not_applied" }));
  });
});

describe("watchForPackageRestore", () => {
  it("after a file refusal, runs onRestorable once when the file at the path verifies again", () => {
    const install = makeInstall();
    const pkgFile = makePackage();
    const target = path.join(install.rootDir, "openclaw-packages", "patched.tgz");
    const env = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf({ file: target, sha256: pkgFile.sha256 }) };
    expect(apply(install, env)).toMatchObject({ status: "refused", reason: "missing" });
    let tick = null;
    const onRestorable = vi.fn();
    override.watchForPackageRestore({
      managedDir: install.managedDir,
      openclawDir: install.openclawDir,
      env,
      onRestorable,
      setIntervalFn: (fn) => {
        tick = fn;
        return { unref: () => {} };
      },
      clearIntervalFn: () => {},
      logger: { log: () => {} },
    });
    tick();
    expect(onRestorable).not.toHaveBeenCalled();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "not the package");
    tick();
    expect(onRestorable).not.toHaveBeenCalled();
    fs.copyFileSync(pkgFile.file, target);
    fs.chmodSync(target, 0o600);
    tick();
    tick();
    expect(onRestorable).toHaveBeenCalledTimes(1);
    expect(onRestorable).toHaveBeenCalledWith({ version: kVersion, file: "patched.tgz", sha256: pkgFile.sha256 });
  });

  it("does nothing for refusals a file cannot clear", () => {
    const install = makeInstall();
    const pkgFile = makePackage({ pkg: packageJson({ openclaw: { schemaVersions: { state: 1, agent: 1 } } }) });
    const env = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile) };
    apply(install, env);
    const setIntervalFn = vi.fn();
    override.watchForPackageRestore({ managedDir: install.managedDir, openclawDir: install.openclawDir, env, setIntervalFn });
    expect(setIntervalFn).not.toHaveBeenCalled();
  });
});

describe("checkOpenclawPackageSetting (alphaclaw openclaw-package check)", () => {
  it("verifies without touching the tree, and names the checks a not-yet-installed version cannot run", () => {
    const install = makeInstall();
    const pkgFile = makePackage();
    const env = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile) };
    expect(override.checkOpenclawPackageSetting({ installDir: install.installDir, openclawDir: install.openclawDir, env })).toMatchObject({
      ok: true,
      version: kVersion,
      notChecked: [],
    });
    expectStockIntact(install);
    const next = makePackage({ pkg: packageJson({ version: "2026.11.5", openclaw: { schemaVersions: { state: 36, agent: 38 } } }) });
    const nextEnv = { ALPHACLAW_OPENCLAW_PACKAGES: settingOf(pkgFile, { ...next, version: "2026.11.5" }) };
    expect(override.checkOpenclawPackageSetting({ installDir: install.installDir, openclawDir: install.openclawDir, env: nextEnv, pin: "2026.11.5" })).toMatchObject({
      ok: true,
      version: "2026.11.5",
      notChecked: ["dependencies", "schemas"],
    });
    expect(override.checkOpenclawPackageSetting({ installDir: install.installDir, openclawDir: install.openclawDir, env, pin: "2026.11.6" })).toMatchObject({
      ok: false,
      reason: "no_entry_for_pin",
    });
    expect(override.checkOpenclawPackageSetting({ installDir: install.installDir, openclawDir: install.openclawDir, env: {} })).toMatchObject({ ok: true, set: false });
    expect(override.checkOpenclawPackageSetting({ installDir: install.installDir, openclawDir: install.openclawDir, env, pin: "latest" })).toMatchObject({ ok: false, usage: true });
  });
});

describe("the launch, watchdog and notification paths", () => {
  const packageOutcome = (overrides = {}) => ({
    step: "openclaw_package",
    status: "refused",
    code: "openclaw_package_sha_mismatch",
    reason: "sha_mismatch",
    hookPath: null,
    message: "the package file's sha256 is not the one in the setting (expected 0f1e2d3c4b5a…, file 0123456789ab…)",
    site: "managed launch",
    packageFile: "openclaw-2026.11.4-patched.tgz",
    packageSha256: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
    durationMs: 4,
    exitCode: null,
    signal: null,
    ...overrides,
  });

  const makeWatchdog = () => {
    const insertWatchdogEvent = vi.fn();
    const watchdog = createWatchdog({
      clawCmd: vi.fn(async () => ({ ok: true })),
      launchGatewayProcess: vi.fn(async () => null),
      insertWatchdogEvent,
      notifier: { notify: vi.fn(async () => ({ ok: true })) },
      readEnvFile: vi.fn(() => ""),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      resolveSetupUrl: () => "http://localhost",
      resolveGatewayHealthUrl: () => "http://gateway/health",
      resolveGatewayReadyzUrl: () => "",
      sleepImpl: () => Promise.resolve(),
      supervisorModeActive: () => false,
    });
    return { watchdog, insertWatchdogEvent };
  };

  it("the watchdog narrates a refusal as openclaw_package_refused and a later passing check clears it", () => {
    const { watchdog, insertWatchdogEvent } = makeWatchdog();
    watchdog.onPrelaunchHook(packageOutcome());
    const status = watchdog.getStatus();
    expect(status.degradedReason).toBe("openclaw_package_refused");
    expect(status.prelaunchHook).toMatchObject({ step: "openclaw_package", status: "refused", packageFile: "openclaw-2026.11.4-patched.tgz", code: "openclaw_package_sha_mismatch" });
    const rows = insertWatchdogEvent.mock.calls.map(([row]) => row).filter((row) => row.eventType === "health_check" && row.status === "failed");
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("openclaw_package");
    watchdog.onPrelaunchHook(packageOutcome({ status: "ran", code: null, message: null }));
    expect(watchdog.getStatus()).toMatchObject({ degradedReason: null, prelaunchHook: null });
  });

  it("the handler sends one important notice per reason, sha and day, naming the two ways out", () => {
    const watchdog = { recordOperationEvent: vi.fn(), onPrelaunchHook: vi.fn() };
    const notify = vi.fn(async () => ({ ok: true }));
    const handler = createGatewayPrelaunchHookHandler({ watchdog, notify, nowFn: () => Date.parse("2026-11-17T20:00:00Z") });
    handler(packageOutcome());
    handler(packageOutcome({ status: "ran", code: null, message: null }));
    expect(watchdog.recordOperationEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "openclaw_package", status: "refused" }));
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, opts] = notify.mock.calls[0];
    expect(opts).toEqual({ eventType: "openclaw_package", id: "openclaw-package-sha_mismatch-0f1e2d3c4b5a-2026-11-17" });
    expect(message).toContain("Gateway not started: the pinned OpenClaw package was refused");
    expect(message).toContain("Package: openclaw-2026.11.4-patched.tgz (0f1e2d3c4b5a…)");
    expect(message).toContain("remove ALPHACLAW_OPENCLAW_PACKAGES");
    expect(watchdog.onPrelaunchHook).toHaveBeenCalledTimes(2);
  });

  it("a restart the package check refuses before the stop says nothing was stopped", () => {
    const { classifyRestartFailure } = require("../../lib/server/restart-failure-copy");
    const { GatewayOpenclawPackageError } = require("../../lib/server/gateway");
    const failure = classifyRestartFailure(new GatewayOpenclawPackageError("refused", { reason: "missing" }));
    expect(failure.code).toBe("openclaw_package_refused");
    expect(failure.error).toContain("nothing was stopped");
    expect(classifyRestartFailure({ code: "stop_refused" }).code).toBe("stop_refused");
  });

  it("requestGatewayLaunch aborts a launch the package check refuses, before anything is spawned", async () => {
    const gateway = require("../../lib/server/gateway");
    const original = process.env.ALPHACLAW_OPENCLAW_PACKAGES;
    process.env.ALPHACLAW_OPENCLAW_PACKAGES = `${kVersion}:/data/openclaw-packages/p.tgz:${"a".repeat(64)}`;
    const spawn = vi.spyOn(require("child_process"), "spawn");
    vi.spyOn(override, "checkOpenclawPackageBeforeLaunch").mockImplementation(() => {
      throw new override.OpenclawPackageRefusal("missing", "p.tgz");
    });
    const outcomes = [];
    gateway.setGatewayPrelaunchHookHandler((outcome) => outcomes.push(outcome));
    try {
      const result = await gateway.requestGatewayLaunch({ site: "managed launch", reconcileIncumbent: false });
      expect(result).toMatchObject({ outcome: "launch_aborted", detail: "openclaw_package" });
      expect(outcomes).toEqual([expect.objectContaining({ step: "openclaw_package", status: "refused", code: "openclaw_package_missing", reason: "missing", site: "managed launch" })]);
      expect(gateway.getLastGatewayPrelaunchHookOutcome()).toMatchObject({ step: "openclaw_package", status: "refused" });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      gateway.setGatewayPrelaunchHookHandler(null);
      if (original == null) delete process.env.ALPHACLAW_OPENCLAW_PACKAGES;
      else process.env.ALPHACLAW_OPENCLAW_PACKAGES = original;
    }
  });
});
